import { lintMessage } from './message.js';
import { loadConfig } from './config.js';
import { captureStaged, stagedCurrent, stagedOverview, stagedPatch } from './staged.js';
import { terminalText } from './changelog.js';
import { messageDestination, saveMessage } from './suggest-file.js';
import { SuggestCancelled } from './suggest-io.js';
import type { SuggestIO } from './suggest-io.js';
import { OperationalError } from './errors.js';

export interface Draft {
  type: string; scope: string; description: string; body: string;
  breaking: boolean; breakingDetails: string; refs: string; footers: string;
}

export function assembleDraft(draft: Draft): string {
  const header = `${draft.type.toLowerCase()}${draft.scope ? `(${draft.scope})` : ''}${draft.breaking ? '!' : ''}: ${draft.description}`;
  const footers = [draft.breaking ? `BREAKING CHANGE: ${draft.breakingDetails}` : '', draft.refs ? `Refs: ${draft.refs}` : '', draft.footers].filter(Boolean).join('\n');
  return [header, draft.body, footers].filter(Boolean).join('\n\n') + '\n';
}

const meanings: Readonly<Record<string, string>> = {
  feat: 'new functionality, e.g. add search', fix: 'correct a bug, e.g. handle empty results',
  docs: 'documentation', style: 'formatting without behavior changes', refactor: 'restructure without changing behavior',
  perf: 'performance improvement', test: 'tests', build: 'build system or dependencies', ci: 'continuous integration',
  chore: 'maintenance', revert: 'reverse an earlier change',
};
const shown = (text: string) => text.split('\n').map(terminalText).join('\n');

export async function suggest(cwd: string, options: { config?: string; output?: string }, io: SuggestIO): Promise<string | null> {
  let allowed = await loadConfig(cwd, options.config);
  let snapshot = await captureStaged(cwd);
  io.review(stagedOverview(snapshot));
  if (!snapshot.entries.length && !snapshot.omitted) return null;
  const target = options.output !== undefined ? await messageDestination(cwd, options.output) : undefined;
  io.review('Describe one logical change in your own words. File count alone does not determine whether changes belong together.\nNo intent is inferred and no code is sent to a service. Type /cancel at any prompt to stop.\n');
  const ask = async (prompt: string): Promise<string> => {
    io.check();
    const value = await io.ask(prompt);
    io.check();
    if (value === '/cancel') throw new SuggestCancelled();
    if (value.length > 16_384) throw new OperationalError('suggest-input', 'Use shorter input lines (up to 16384 characters).');
    return value;
  };
  const multiline = async (label: string): Promise<string> => {
    io.review(`${label}: enter lines, then .done alone to finish; an empty entry clears it.\n`);
    const lines: string[] = [];
    let length = 0;
    while (true) {
      const line = await ask('> ');
      if (line === '.done') return lines.join('\n');
      length += line.length + 1;
      if (length > 65_536) throw new OperationalError('suggest-input', 'This field exceeds 65536 characters. Retry with a shorter message.');
      lines.push(line);
    }
  };
  const draft: Draft = { type: '', scope: '', description: '', body: '', breaking: false, breakingDetails: '', refs: '', footers: '' };
  const type = async () => {
    io.review('Choose a configured type:\n' + allowed.map(value => `  ${terminalText(value)}: ${Object.hasOwn(meanings, value) ? meanings[value] : 'custom configured type'}`).join('\n') + '\n');
    draft.type = (await ask('Type (e.g. feat): ')).trim().toLowerCase();
  };
  const edit = async (field: string) => {
    switch (field) {
      case 'type': await type(); break;
      case 'scope': draft.scope = await ask('Scope (optional, e.g. api; blank clears): '); break;
      case 'description': draft.description = await ask('Description (required, e.g. handle empty search results): '); break;
      case 'body': draft.body = await multiline('Body (optional context and reasoning)'); break;
      case 'breaking': {
        const answer = (await ask('Deliberately mark a breaking change? yes/no: ')).trim().toLowerCase();
        if (!['yes', 'no'].includes(answer)) { io.review('Enter yes or no; breaking selection unchanged.\n'); break; }
        draft.breaking = answer === 'yes';
        if (draft.breaking) draft.breakingDetails = await multiline('Breaking details (explain the required migration)');
        break;
      }
      case 'refs': draft.refs = await multiline('Issue references (optional, e.g. #123; emitted as neutral Refs, never automatic closing)'); break;
      case 'footers': draft.footers = await multiline('Other footers (optional, e.g. Reviewed-by: Name)'); break;
      default: io.review('Choose type, scope, description, body, breaking, refs, or footers.\n');
    }
  };
  const refresh = async () => {
    io.review('The index or HEAD changed. Your draft is retained; the previous staged review is stale.\n');
    const answer = await ask('Refresh the staged review, or cancel? refresh/cancel: ');
    if (answer.trim().toLowerCase() !== 'refresh') throw new SuggestCancelled();
    snapshot = await captureStaged(cwd);
    io.review(stagedOverview(snapshot));
    if (!snapshot.entries.length && !snapshot.omitted) throw new SuggestCancelled();
  };
  // A deliberate review action precedes composition; patch is optional and bounded.
  while (true) {
    const action = (await ask('Staged review: patch / continue / cancel: ')).trim().toLowerCase();
    if (action === 'cancel') throw new SuggestCancelled();
    if (action === 'patch') {
      const patch = await stagedPatch(snapshot);
      if (patch === null) await refresh(); else io.review(patch);
    } else if (action === 'continue') break;
    else io.review('Choose patch, continue, or cancel.\n');
  }
  await type(); await edit('scope'); await edit('description');
  while (true) {
    io.check();
    if (!await stagedCurrent(snapshot)) { await refresh(); continue; }
    allowed = await loadConfig(cwd, options.config);
    const message = assembleDraft(draft);
    const result = lintMessage(message, allowed);
    io.review(`\nDraft for the reviewed staged set:\n---\n${shown(message)}---\n`);
    for (const diagnostic of result.diagnostics) io.review(`error [${diagnostic.rule}] line ${diagnostic.line}: ${terminalText(diagnostic.message)}\n`);
    io.review('Format validation cannot establish semantic accuracy. Review the complete message and staged changes.\n');
    if (target) io.review(`Accept will also create ${terminalText(JSON.stringify(target))}.\n`);
    const action = (await ask('Review: accept / edit / advanced / patch / refresh / cancel: ')).trim().toLowerCase();
    if (action === 'cancel') throw new SuggestCancelled();
    if (action === 'edit' || action === 'advanced') {
      await edit((await ask('Field: type / scope / description / body / breaking / refs / footers: ')).trim().toLowerCase());
    } else if (action === 'patch') {
      const patch = await stagedPatch(snapshot);
      if (patch === null) await refresh(); else io.review(patch);
    } else if (action === 'refresh') {
      snapshot = await captureStaged(cwd);
      io.review(stagedOverview(snapshot));
      if (!snapshot.entries.length && !snapshot.omitted) throw new SuggestCancelled();
    } else if (action === 'accept') {
      // Reload policy and recheck the index after the user spent time reviewing.
      const final = lintMessage(message, await loadConfig(cwd, options.config));
      if (final.diagnostics.length) { io.review('The draft must pass current validation before acceptance. Correct the fields shown below.\n'); continue; }
      if (!await stagedCurrent(snapshot)) { await refresh(); continue; }
      io.check();
      if (target) await messageDestination(cwd, target);
      if (target && !await saveMessage(target, message, () => stagedCurrent(snapshot), () => io.check())) { await refresh(); continue; }
      io.review(target ? 'Accepted and saved. You remain in control of committing.\n' : 'Accepted. You remain in control of committing.\n');
      return message;
    } else io.review('Choose accept, edit, advanced, patch, refresh, or cancel.\n');
  }
}
