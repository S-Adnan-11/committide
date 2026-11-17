import { commitContext } from './commit-context.js';
import { commitStateCurrent } from './commit-state.js';
import type { CommitState } from './commit-state.js';
import { prepareGroqContext, requestGroq, GROQ_MODEL, GROQ_ENDPOINT, REQUEST_LIMIT, COMPLETION_LIMIT } from './groq.js';
import { DraftContractError, runDraftProvider } from './provider.js';
import type { DraftRequest } from './provider.js';
import type { Draft } from './draft.js';
import { OperationalError } from './errors.js';
import { CommitCancelled } from './suggest-io.js';
import type { SuggestIO } from './suggest-io.js';
import { terminalText } from './changelog.js';

export interface CommitAiDependencies { transport?: typeof fetch; timeoutMs?: number }
export type AiChoice = { kind: 'draft'; draft: Draft } | { kind: 'local'; hint: string } | { kind: 'stale' };

export async function offerCommitDraft(cwd: string, state: CommitState, config: string | undefined, io: SuggestIO,
  dependencies: CommitAiDependencies = {}): Promise<AiChoice> {
  let hint = '';
  const local = (): AiChoice => ({ kind: 'local', hint });
  const ask = async (prompt: string) => {
    io.check();
    const value = await io.ask(prompt);
    io.check();
    if (value === '/cancel') throw new CommitCancelled();
    if (value.length > 16_384) throw new OperationalError('commit-input', 'Use shorter input lines (up to 16384 characters).');
    return value;
  };
  try {
    io.review(`Optional AI drafting: Groq / ${GROQ_MODEL}. No request is made without a separate send choice.\n`);
    let context: string;
    while (true) {
      context = (await ask('AI context: metadata (default) / hunks / local / cancel: ')).trim().toLowerCase() || 'metadata';
      if (context === 'cancel') throw new CommitCancelled();
      if (context === 'local') return local();
      if (context === 'metadata' || context === 'hunks') break;
      io.review('Choose metadata, hunks, local, or cancel. A local patch view does not select content for upload.\n');
    }
    hint = await ask('AI intent hint (optional; included in the disclosed input): ');
    let json = await commitContext(cwd, state, hint, [], config);
    if (context === 'hunks') {
      const request = JSON.parse(json) as DraftRequest;
      io.review('Choose staged text entries to include. Every hunk of each selected entry is included, with staged context lines.\n'
        + request.staged.entries.map((entry, index) => `  ${index + 1}: ${terminalText(JSON.stringify(entry.path))} (${entry.kind})`).join('\n') + '\n');
      const selection = await ask('Entry numbers (comma-separated; blank keeps drafting offline): ');
      if (!selection.trim()) return local();
      const selected = selection.split(',').map(value => /^\s*[1-9][0-9]*\s*$/.test(value) ? Number(value) - 1 : -1);
      json = await commitContext(cwd, state, hint, selected, config);
    }
    const body = prepareGroqContext(json);
    io.review(`\nDestination: Groq / ${GROQ_MODEL}\nEndpoint: ${GROQ_ENDPOINT}\n`
      + `Context: ${context === 'metadata' ? 'staged metadata and optional intent; no patch text' : 'staged metadata, optional intent and explicitly selected staged file patches'}.\n`
      + 'The JSON below includes all submitted context, configured types, instructions and response schema. It excludes unstaged/untracked content and adds no repository root, branch, author or remote. Paths and hints can still be sensitive.\n'
      + `Whole request: ${Buffer.byteLength(body)}/${REQUEST_LIMIT} UTF-8 bytes; completion allowance: ${COMPLETION_LIMIT} tokens including reasoning. Bytes are not billed token counts or a free quota guarantee.\n`
      + 'Review every field. Screening is defense in depth, not proof of safety. Groq data handling: https://console.groq.com/docs/your-data\n'
      + '--- outgoing JSON ---\n' + terminalText(body) + '\n--- end outgoing JSON ---\n');
    const action = (await ask('Groq choice: send / local / cancel (Enter keeps drafting offline): ')).trim().toLowerCase();
    if (action === 'cancel') throw new CommitCancelled();
    if (action !== 'send') return local();
    if (!await commitStateCurrent(cwd, state, config)) return { kind: 'stale' };
    io.check();
    io.review('Sending one Groq request. Ctrl+C cancels waiting; it cannot prove remote processing stopped. No retries or provider fallback.\n');
    let quota = '';
    let failureRule = '';
    const result = await runDraftProvider(json, async (contextJson, { signal }) => {
      if (contextJson !== json) throw new DraftContractError('stale', 'The disclosed context changed.');
      try {
        const response = await requestGroq(body, state.allowed, signal, dependencies.transport, dependencies.timeoutMs);
        quota = response.quota;
        return JSON.stringify({ version: 1, draft: response.draft, uncertainty: response.uncertainty });
      } catch (error) {
        if (error instanceof OperationalError) failureRule = error.rule;
        throw error;
      }
    }, { signal: io.signal, isCurrent: () => commitStateCurrent(cwd, state, config), allowHunks: context === 'hunks',
      ...(dependencies.timeoutMs !== undefined ? { timeoutMs: dependencies.timeoutMs } : {}) }).catch(error => {
      if (failureRule === 'ai-timeout') io.review('Groq reached its request deadline. No retry was made; offline drafting is available.\n');
      if (failureRule === 'ai-key') io.review('Groq credentials are unavailable. Supply GROQ_API_KEY securely in your process environment when needed; offline drafting is available.\n');
      throw error;
    });
    io.check();
    if (!await commitStateCurrent(cwd, state, config)) return { kind: 'stale' };
    io.review(`AI draft received for review. Accuracy and usefulness still need your judgement.\nUncertainty: ${result.response.uncertainty.split('\n').map(terminalText).join('\n')}\n`);
    if (quota) io.review(`Groq quota metadata: ${quota}\n`);
    return { kind: 'draft', draft: result.response.draft };
  } catch (error) {
    io.check();
    if (error instanceof CommitCancelled || io.signal?.aborted || (error instanceof DraftContractError && error.code === 'cancelled')) throw new CommitCancelled();
    if (!await commitStateCurrent(cwd, state, config)) return { kind: 'stale' };
    if (error instanceof DraftContractError && error.code === 'stale') return { kind: 'stale' };
    if (!(error instanceof DraftContractError) && !(error instanceof OperationalError && error.rule.startsWith('ai-'))) throw error;
    const code = error instanceof DraftContractError ? error.code : error.rule;
    if (code === 'sensitive') hint = '';
    io.review(`AI drafting unavailable [${code}]. No draft accepted and no automatic retry made. Continue with offline composition; another request needs a fresh AI/send choice.\n`);
    return local();
  }
}
