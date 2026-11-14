import { commitContext } from './commit-context.js';
import { commitStateCurrent } from './commit-state.js';
import type { CommitState } from './commit-state.js';
import { DraftContractError, runDraftProvider } from './provider.js';
import { prepareHostedRequest, validateHostedResponse, readHostedBody,
  HOSTED_REQUEST_LIMIT, HOSTED_RESPONSE_LIMIT, HOSTED_DEADLINE_MS } from './hosted-contract.js';
import { CommitCancelled } from './suggest-io.js';
import type { SuggestIO } from './suggest-io.js';
import type { AiChoice, CommitAiDependencies } from './commit-ai.js';
import { OperationalError } from './errors.js';

// Reserved destination: this source preview has no deployed service.
export const HOSTED_ENDPOINT = 'https://draft.committide.invalid/v1/draft';

export async function offerHostedDraft(cwd: string, state: CommitState, config: string | undefined,
  io: SuggestIO, dependencies: CommitAiDependencies = {}): Promise<AiChoice> {
  let hint = '';
  const ask = async (prompt: string) => {
    io.check(); const value = await io.ask(prompt); io.check();
    if (value === '/cancel') throw new CommitCancelled();
    if (value.length > 16_384) throw new OperationalError('commit-input', 'Use shorter input lines (up to 16384 characters).');
    return value;
  };
  try {
    io.review('Hosted drafting preview: anonymous metadata-only endpoint. No developer account, API key or model download.\n'
      + 'This offline proof has no deployed service; its reserved .invalid destination is used with fake inference in checks.\n');
    hint = await ask('Hosted intent hint (optional; up to 512 characters): ');
    const body = prepareHostedRequest(await commitContext(cwd, state, hint, [], config));
    io.review(`\nDestination: CommitTide hosted draft preview / Cloudflare Workers AI\nEndpoint: ${HOSTED_ENDPOINT}\n`
      + 'Version 1: staged metadata, type policy and optional intent only. No hunks, repository upload, account token or client-selected model.\n'
      + 'The service adds a fixed prompt and uses one server-configured allowlisted model (GLM-4.7-Flash or Granite 4.0 H Micro); it never switches automatically.\n'
      + 'Paths and intent may be sensitive. Screening is not proof of safety. Application payload logging is disabled; platform data handling still needs rollout verification.\n'
      + 'Cloudflare data handling: https://developers.cloudflare.com/workers-ai/platform/data-usage/\n'
      + `Exact outbound body: ${Buffer.byteLength(body)}/${HOSTED_REQUEST_LIMIT} UTF-8 bytes; no authorization or cookies.\n`
      + '--- outgoing JSON ---\n' + body + '\n--- end outgoing JSON ---\n');
    const action = (await ask('Hosted choice: send / local / cancel (Enter keeps drafting offline): ')).trim().toLowerCase();
    if (action === 'cancel') throw new CommitCancelled();
    if (action !== 'send') return { kind: 'local', hint };
    if (!await commitStateCurrent(cwd, state, config)) return { kind: 'stale' };
    io.check();
    io.review('Sending one hosted request. Ctrl+C cancels waiting, not necessarily remote processing. No retries or provider switch.\n');
    const result = await runDraftProvider(body, async (json, { signal }) => {
      if (json !== body) throw new DraftContractError('stale', 'Disclosed bytes changed.');
      const response = await (dependencies.transport ?? fetch)(HOSTED_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body, signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new DraftContractError('hosted-service', 'Hosted service unavailable.'); }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {}); throw new DraftContractError('hosted-response', 'Expected JSON.');
      }
      const raw = await readHostedBody(response.body, HOSTED_RESPONSE_LIMIT, signal);
      validateHostedResponse(raw, state.allowed);
      return raw;
    }, { signal: io.signal, isCurrent: () => commitStateCurrent(cwd, state, config),
      timeoutMs: dependencies.timeoutMs ?? HOSTED_DEADLINE_MS });
    io.check();
    if (!await commitStateCurrent(cwd, state, config)) return { kind: 'stale' };
    io.review('Hosted draft received. Review its accuracy, edit it and confirm the final commit separately.\n'
      + 'Uncertainty: ' + result.response.uncertainty + '\n');
    return { kind: 'draft', draft: result.response.draft };
  } catch (error) {
    io.check();
    if (error instanceof CommitCancelled || io.signal?.aborted || (error instanceof DraftContractError && error.code === 'cancelled')) throw new CommitCancelled();
    if (!await commitStateCurrent(cwd, state, config) || (error instanceof DraftContractError && error.code === 'stale')) return { kind: 'stale' };
    if (!(error instanceof DraftContractError)) throw error;
    if (error.code === 'sensitive' || error.code === 'hosted-input') hint = '';
    io.review(`Hosted drafting unavailable [${error.code}]. Continue offline; no draft accepted, retry or provider switch.\n`);
    return { kind: 'local', hint };
  }
}
