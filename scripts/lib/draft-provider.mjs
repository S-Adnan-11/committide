import { lintMessage } from '../../dist/message.js';
import { validateConfig } from '../../dist/config.js';
import { assembleDraft } from '../../dist/suggest.js';

export const REQUEST_LIMIT = 16 * 1024;
export const RESPONSE_LIMIT = 32 * 1024;
export const DEADLINE_MS = 30_000;

export class DraftContractError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fail(code, message) { throw new DraftContractError(code, message); }
function shape(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function decode(json, limit, code) {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > limit) fail(code, 'JSON exceeds its byte allowance or is not text.');
  try { return JSON.parse(json); }
  catch { fail(code, 'Expected one valid JSON value.'); }
}
function text(value, limit, multiline = false) {
  if (typeof value !== 'string' || value.length > limit || Buffer.from(value).toString('utf8') !== value) return false;
  const checked = multiline ? value.replace(/[\n\t]/g, '') : value;
  return !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(checked.replace(/[\u200c\u200d]/g, ''));
}
function secretLike(value) {
  return /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_|github_pat_|gsk_|npm_|sk-)[a-z0-9_-]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/i.test(value)
    || /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"']{8,}/i.test(value);
}
function path(value) {
  return text(value, 1024) && value.length > 0 && !value.includes('\ufffd')
    && !/^(?:\/|[a-z]:)|\\|(?:^|\/)\.{0,2}(?:\/|$)/i.test(value)
    && !secretLike(value);
}
function sensitivePath(value) {
  return /(?:^|\/)(?:\.git|\.ssh|\.aws|\.env(?:\.[^/]*)?|\.npmrc|\.netrc|(?:credentials|secrets?)(?:\.[^/]*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key))(?:\/|$)/i.test(value);
}

/** Strict, bounded staged-only DTO. Callers must establish provenance and consent. */
export function validateDraftRequest(json, { allowHunks = false } = {}) {
  const value = decode(json, REQUEST_LIMIT, 'request');
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
        ? Number.isSafeInteger(count) && count >= 0 && count <= 10_000_000 : count === null)
      || paths.has(entry.path)) fail('request', 'Invalid, duplicate or unsupported staged entry.');
    if ([entry.path, entry.previousPath].filter(Boolean).some(sensitivePath)) fail('sensitive', 'Sensitive paths are blocked. Review the context locally.');
    paths.add(entry.path);
  }
  if (Object.hasOwn(value, 'hunks')) {
    if (allowHunks !== true) fail('consent', 'Selected patch hunks require a separate explicit choice.');
    if (!Array.isArray(value.hunks) || !value.hunks.length || value.hunks.length > 100) fail('request', 'Expected a bounded, nonempty selection of patch hunks.');
    for (const hunk of value.hunks) {
      const entry = value.staged.entries.find(entry => entry.path === hunk?.path);
      if (!shape(hunk, ['path', 'patch']) || !entry || entry.kind !== 'text' || !text(hunk.patch, REQUEST_LIMIT, true)
        || !hunk.patch.trim() || /(?:^|\/)(?:node_modules|vendor|dist|build|coverage)(?:\/|$)/i.test(hunk.path)) {
        fail('request', 'Selected hunks must belong to staged text entries outside generated/vendor paths.');
      }
      if (secretLike(hunk.patch)) fail('sensitive', 'Credential-like input is blocked. Review the context locally.');
    }
  }
  return value;
}

const draftStrings = ['type', 'scope', 'description', 'body', 'breakingDetails', 'refs', 'footers'];

/** Format validity is checked here; factual accuracy still needs evidence review. */
export function validateDraftResponse(json, allowedTypes) {
  const value = decode(json, RESPONSE_LIMIT, 'response');
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
  if (result.diagnostics.length || result.parsed.breaking !== value.draft.breaking) fail('response', 'Draft failed the shared message rules or breaking-change consistency.');
  return { ...value, message };
}
