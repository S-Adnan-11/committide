import { DraftContractError, validateDraftRequest, validateDraftResponse } from './provider.js';

export const HOSTED_REQUEST_LIMIT = 8192;
export const HOSTED_RESPONSE_LIMIT = 4096;
export const HOSTED_COMPLETION_LIMIT = 768;
export const HOSTED_DEADLINE_MS = 15_000;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const fail = (): never => { throw new DraftContractError('hosted-input', 'Use bounded staged metadata and optional intent only.'); };

/** Shared wire validation; no transport, account, prompt or model configuration. */
export function validateHostedRequest(json: string) {
  if (typeof json !== 'string' || bytes(json) > HOSTED_REQUEST_LIMIT) fail();
  let value;
  try { value = JSON.parse(json); } catch { fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['version', 'policy', 'staged', 'intent'].includes(key))) fail();
  if (Array.isArray(value.policy?.allowedTypes) && value.policy.allowedTypes.length > 16) fail();
  const request = validateDraftRequest(JSON.stringify({ ...value, intent: value.intent ?? '' }));
  if (Object.hasOwn(value, 'intent') && typeof value.intent !== 'string') fail();
  if (request.intent.length > 512 || request.staged.entries.length > 40
    || request.policy.allowedTypes.length > 16 || request.policy.allowedTypes.some(type => type.length > 32)
    || request.staged.entries.some(entry => entry.path.length > 256 || (entry.previousPath?.length ?? 0) > 256
      || [entry.additions, entry.deletions].some(count => count !== null && count > 100_000))) fail();
  return request;
}

export function prepareHostedRequest(json: string) {
  const body = JSON.stringify(validateHostedRequest(json));
  if (bytes(body) > HOSTED_REQUEST_LIMIT) fail();
  return body;
}

export function validateHostedResponse(json: string, allowed: readonly string[]) {
  if (typeof json !== 'string' || bytes(json) > HOSTED_RESPONSE_LIMIT) {
    throw new DraftContractError('hosted-response', 'Hosted reply exceeds its bound.');
  }
  return validateDraftResponse(json, allowed);
}

/** Bound streamed bytes, including absent or dishonest Content-Length headers. */
export async function readHostedBody(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal) {
  if (!body) throw new DraftContractError('hosted-body', 'Expected a bounded UTF-8 body.');
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw new Error('aborted');
    while (true) {
      const part = await reader.read();
      if (signal?.aborted) throw new Error('aborted');
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { cancel(); throw new Error('bound'); }
      chunks.push(part.value);
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch {
    throw new DraftContractError('hosted-body', 'Body unavailable, too large or not UTF-8.');
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}
