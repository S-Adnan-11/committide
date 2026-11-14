import { captureCommitState, commitStateCurrent, commitOverview, groundedDraft, mixedIntentHint } from './commit-state.js';
import { stagedPatch } from './staged.js';
import { assembleDraft, draftEditor, emptyDraft } from './draft.js';
import { lintMessage } from './message.js';
import { terminalText } from './changelog.js';
import { CommitCancelled } from './suggest-io.js';
import { OperationalError } from './errors.js';
import { executeCommit } from './commit-run.js';
import type { CommitIO, CommitResult } from './commit-run.js';

export async function composeCommit(cwd: string, options: { config?: string }, io: CommitIO): Promise<CommitResult> {
  let state = await captureCommitState(cwd, options.config);
  io.review(commitOverview(state));
  if (!state.changes.length) {
    io.review('Nothing staged. Stage the changes you want to commit, then run commit again.\n');
    return { status: 'empty', exitCode: 0 };
  }
  io.review('Offline composition. Git and existing hooks/signing retain normal behavior. Type /cancel at any prompt to stop.\n');
  const ask = async (prompt: string) => {
    io.check();
    const value = await io.ask(prompt);
    io.check();
    if (value === '/cancel') throw new CommitCancelled();
    if (value.length > 16_384) throw new OperationalError('commit-input', 'Use shorter input lines (up to 16384 characters).');
    return value;
  };
  const multiline = async (label: string) => {
    io.review(`${label}: enter lines, then .done alone to finish; an empty entry clears it.\n`);
    const lines: string[] = [];
    let length = 0;
    while (true) {
      const line = await ask('> ');
      if (line === '.done') return lines.join('\n');
      length += line.length + 1;
      if (length > 65_536) throw new OperationalError('commit-input', 'This field exceeds 65536 characters. Retry with a shorter message.');
      lines.push(line);
    }
  };
  let draft = emptyDraft();
  const editor = () => draftEditor(draft, () => state.allowed, ask, text => io.review(text), multiline);
  const compose = async () => {
    draft = groundedDraft(state) ?? emptyDraft();
    io.review(mixedIntentHint(state));
    if (draft.type) {
      io.review('A simple draft follows from the staged paths/status. Check its meaning and edit for specificity.\n');
    } else {
      io.review('The staged evidence does not establish intent. Choose a type and describe why you made this change.\n');
      await editor().type();
      await editor().edit('scope');
      draft.description = await ask('Intent (required; describe the change in your own words): ');
    }
  };
  const refresh = async () => {
    io.review('Review state changed or was refreshed. Previous draft and confirmation are discarded.\n');
    state = await captureCommitState(cwd, options.config);
    io.review(commitOverview(state));
    if (!state.changes.length) throw new CommitCancelled();
    await compose();
  };
  while (true) {
    const action = (await ask('Staged review: patch / continue / cancel: ')).trim().toLowerCase();
    if (action === 'cancel') throw new CommitCancelled();
    if (action === 'continue') {
      if (!await commitStateCurrent(cwd, state, options.config)) { await refresh(); break; }
      await compose(); break;
    }
    if (action === 'patch') {
      const patch = await stagedPatch(state.snapshot);
      if (patch === null || !await commitStateCurrent(cwd, state, options.config)) {
        await refresh(); break;
      }
      io.review(patch);
    } else io.review('Choose patch, continue, or cancel.\n');
  }
  while (true) {
    io.check();
    if (!await commitStateCurrent(cwd, state, options.config)) { await refresh(); continue; }
    const message = assembleDraft(draft);
    const result = lintMessage(message, state.allowed);
    io.review(`\nDraft for this repository, branch, HEAD, index and type policy:\n---\n${message.split('\n').map(terminalText).join('\n')}---\n`);
    for (const diagnostic of result.diagnostics) io.review(`error [${diagnostic.rule}] line ${diagnostic.line}: ${terminalText(diagnostic.message)}\n`);
    io.review('Check the full message and staged changes. Only the word commit below approves invoking Git; Enter alone does nothing.\n');
    const action = (await ask('Review: commit / edit / patch / refresh / cancel: ')).trim().toLowerCase();
    if (action === 'cancel') throw new CommitCancelled();
    if (action === 'edit') {
      await editor().edit((await ask('Field: type / scope / description / body / breaking / refs / footers: ')).trim().toLowerCase());
    } else if (action === 'patch') {
      const patch = await stagedPatch(state.snapshot);
      if (patch === null || !await commitStateCurrent(cwd, state, options.config)) await refresh(); else io.review(patch);
    } else if (action === 'refresh') {
      await refresh();
    } else if (action === 'commit') {
      if (!await commitStateCurrent(cwd, state, options.config)) { await refresh(); continue; }
      if (result.diagnostics.length) { io.review('Correct the message before committing.\n'); continue; }
      io.check();
      const recorded = await executeCommit(cwd, state, message, io, options.config);
      if (recorded.status === 'stale') { await refresh(); continue; }
      return recorded;
    } else io.review('Choose commit, edit, patch, refresh, or cancel.\n');
  }
}
