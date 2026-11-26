import { lintMessage } from './message.js';
import { validateConfig } from './config.js';
import { assembleDraft } from './draft.js';

import type { Draft } from './draft.js';

export interface DraftEntry {
  status: 'A' | 'M' | 'D' | 'R' | 'T'; path: string; previousPath?: string;
  kind: 'text' | 'binary' | 'submodule' | 'symlink'; additions: number | null; deletions: number | null;
}
export interface DraftRequest {
  version: 1; policy: { allowedTypes: string[] }; staged: { complete: boolean; entries: DraftEntry[] };
  intent: string; hunks?: { path: string; patch: string }[];
}
export interface DraftResponse { version: 1; draft: Draft; uncertainty: string }
export interface ProviderOptions {
  signal?: AbortSignal | undefined; isCurrent?: (() => boolean | Promise<boolean>) | undefined;
  allowHunks?: boolean; timeoutMs?: number;
}
export type DraftTransport = (json: string, options: { signal: AbortSignal }) => string | Promise<string>;

export const REQUEST_LIMIT = 16 * 1024;
export const RESPONSE_LIMIT = 32 * 1024;
export const DEADLINE_MS = 30_000;

export class DraftContractError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function fail(code: string, message: string): never { throw new DraftContractError(code, message); }
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function decode(json: unknown, limit: number, code: string): unknown {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > limit) fail(code, 'JSON exceeds its byte allowance or is not text.');
  try { return JSON.parse(json); }
  catch { fail(code, 'Expected one valid JSON value.'); }
}
function text(value: unknown, limit: number, multiline = false): value is string {
  if (typeof value !== 'string' || value.length > limit || Buffer.from(value).toString('utf8') !== value) return false;
  const checked = multiline ? value.replace(/[\n\t]/g, '') : value;
  return !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(checked.replace(/[\u200c\u200d]/g, ''));
}
function secretLike(value: string) {
  return /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_|github_pat_|gsk_|npm_|sk-)[a-z0-9_-]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/i.test(value)
    || /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"']{8,}/i.test(value);
}
function path(value: unknown): value is string {
  return text(value, 1024) && value.length > 0 && !value.includes('\ufffd')
    && !/^(?:\/|[a-z]:)|\\|(?:^|\/)\.{0,2}(?:\/|$)/i.test(value)
    && !secretLike(value);
}
function sensitivePath(value: string) {
  return /(?:^|\/)(?:\.git|\.ssh|\.aws|\.codex|\.agents|AGENTS(?:\.override)?\.md|\.env(?:\.[^/]*)?|\.npmrc|\.netrc|(?:credentials|secrets?)(?:\.[^/]*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key))(?:\/|$)/i.test(value);
}

/** Strict, bounded staged-only DTO. Callers must establish provenance and consent. */
export function validateDraftRequest(json: string, { allowHunks = false }: { allowHunks?: boolean } = {}): DraftRequest {
  const value = decode(json, REQUEST_LIMIT, 'request') as DraftRequest;
  if (!shape(value, ['version', 'policy', 'staged', 'intent'], ['hunks']) || value.version !== 1
    || !shape(value.policy, ['allowedTypes']) || !shape(value.staged, ['complete', 'entries'])
    || value.staged.complete !== true || !Array.isArray(value.staged.entries)
    || value.staged.entries.length < 1 || value.staged.entries.length > 100
    || !text(value.intent, 4096)) fail('request', 'Expected complete staged metadata, a type policy and bounded intent.');
  try { value.policy.allowedTypes = validateConfig(value.policy); }
  catch { fail('policy', 'Expected a nonempty allowed-type policy.'); }
  if ([value.intent, ...value.policy.allowedTypes].some(secretLike)) fail('sensitive', 'Credential-like input is blocked. Review the context locally.');
  const paths = new Set();
  for (const entry of value.staged.entries) {
    if (!shape(entry, ['status', 'path', 'kind', 'additions', 'deletions'], ['previousPath'])
      || !['A', 'M', 'D', 'R', 'T'].includes(entry.status) || !path(entry.path)
      || !['text', 'binary', 'submodule', 'symlink'].includes(entry.kind)
      || (entry.status === 'R' ? !path(entry.previousPath) || entry.previousPath === entry.path : Object.hasOwn(entry, 'previousPath'))
      || ![entry.additions, entry.deletions].every(count => entry.kind === 'text'
        ? typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 10_000_000 : count === null)
      || paths.has(entry.path)) fail('request', 'Invalid, duplicate or unsupported staged entry.');
    if ([entry.path, entry.previousPath].some(value => value !== undefined && sensitivePath(value))) fail('sensitive', 'Sensitive paths are blocked. Review the context locally.');
    paths.add(entry.path);
  }
  if (Object.hasOwn(value, 'hunks')) {
    if (allowHunks !== true) fail('consent', 'Selected patch hunks require a separate explicit choice.');
    if (!Array.isArray(value.hunks) || !value.hunks.length || value.hunks.length > 100) fail('request', 'Expected a bounded, nonempty selection of patch hunks.');
    for (const hunk of value.hunks) {
      const entry = value.staged.entries.find(entry => entry.path === hunk?.path);
      if (!shape(hunk, ['path', 'patch']) || !entry || entry.kind !== 'text' || !text(hunk.patch, REQUEST_LIMIT, true)
        || !hunk.patch.trim() || [entry.path, entry.previousPath].some(value => value !== undefined && /(?:^|\/)(?:node_modules|vendor|dist|build|coverage)(?:\/|$)/i.test(value))) {
        fail('request', 'Selected hunks must belong to staged text entries outside generated/vendor paths.');
      }
      if (secretLike(hunk.patch)) fail('sensitive', 'Credential-like input is blocked. Review the context locally.');
    }
  }
  return value;
}

const draftStrings = ['type', 'scope', 'description', 'body', 'breakingDetails', 'refs', 'footers'] as const;

/** Format validity is checked here; factual accuracy still needs evidence review. */
export function validateDraftResponse(json: string, allowedTypes: readonly string[]): DraftResponse & { message: string } {
  const value = decode(json, RESPONSE_LIMIT, 'response') as DraftResponse;
  if (!shape(value, ['version', 'draft', 'uncertainty']) || value.version !== 1
    || !shape(value.draft, [...draftStrings, 'breaking']) || typeof value.draft.breaking !== 'boolean'
    || !text(value.uncertainty, 4096, true) || secretLike(value.uncertainty)
    || !draftStrings.every(key => text(value.draft[key], 4096, !['type', 'scope', 'description'].includes(key)) && !secretLike(value.draft[key]))
    || (value.draft.breaking ? !value.draft.breakingDetails.trim() : value.draft.breakingDetails !== '')) {
    fail('response', 'Expected bounded draft fields, consistent breaking details and uncertainty.');
  }
  let allowed;
  try { allowed = validateConfig({ allowedTypes }); }
  catch { fail('policy', 'Expected a nonempty allowed-type policy.'); }
  const message = assembleDraft(value.draft);
  const result = lintMessage(message, allowed);
  if (result.diagnostics.length || result.parsed?.breaking !== value.draft.breaking) fail('response', 'Draft failed the shared message rules or breaking-change consistency.');
  return { ...value, message };
}

/** Canonical bytes for an eventual disclosure; validation never sends anything. */
export function prepareDraftRequest(json: string, options?: { allowHunks?: boolean }) {
  const prepared = JSON.stringify(validateDraftRequest(json, options));
  if (Buffer.byteLength(prepared) > REQUEST_LIMIT) fail('request', 'Normalized request exceeds its byte allowance.');
  return prepared;
}

/** Exercise one injected transport. No HTTP client, retry, fallback or Git action. */
export async function runDraftProvider(json: string, transport: DraftTransport, { signal, isCurrent, allowHunks = false, timeoutMs = DEADLINE_MS }: ProviderOptions = {}) {
  if (typeof transport !== 'function') fail('transport', 'Expected an explicit transport function.');
  if (typeof isCurrent !== 'function') fail('state', 'Expected a callback that checks the reviewed input and policy.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE_MS) fail('deadline', 'Use a positive deadline no longer than 30000 ms.');
  const request = prepareDraftRequest(json, { allowHunks });
  const allowedTypes = (JSON.parse(request) as DraftRequest).policy.allowedTypes;
  if (signal?.aborted) fail('cancelled', 'Draft waiting was cancelled. No retry was made.');
  const controller = new AbortController();
  let stopped: 'cancelled' | 'timeout' | undefined;
  let rejectInterrupted!: (error: DraftContractError) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const failure = () => new DraftContractError(stopped ?? 'cancelled', stopped === 'timeout'
    ? 'Draft deadline elapsed. Processing may have started; no retry was made.'
    : 'Draft waiting was cancelled. Processing may have started; no retry was made.');
  const stop = (code: 'cancelled' | 'timeout') => {
    if (stopped) return;
    stopped = code;
    controller.abort();
    rejectInterrupted(failure());
  };
  const cancel = () => stop('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const check = () => { if (stopped) throw failure(); };
  const current = async () => {
    let matches;
    try { matches = await isCurrent(); }
    catch { fail('state', 'Cannot verify the reviewed input and policy.'); }
    check();
    if (matches !== true) fail('stale', 'The draft no longer matches the reviewed input or policy. Review again.');
  };
  const started = performance.now();
  const work = (async () => {
    await current();
    check();
    let raw: string;
    try { raw = await transport(request, { signal: controller.signal }); }
    catch { check(); fail('transport', 'The transport failed. Processing may have started; no retry was made.'); }
    check();
    await current();
    const response = validateDraftResponse(raw, allowedTypes);
    check();
    return { response, measurements: { requestBytes: Buffer.byteLength(request), responseBytes: Buffer.byteLength(raw), elapsedMs: performance.now() - started } };
  })();
  try { return await Promise.race([work, interrupted]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
