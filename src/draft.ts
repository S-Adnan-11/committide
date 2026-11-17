import { terminalText } from './changelog.js';

export interface Draft {
  type: string; scope: string; description: string; body: string;
  breaking: boolean; breakingDetails: string; refs: string; footers: string;
}

export function emptyDraft(): Draft {
  return { type: '', scope: '', description: '', body: '', breaking: false, breakingDetails: '', refs: '', footers: '' };
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

/** Shared field editor; callers own cancellation, input bounds and approval. */
export function draftEditor(draft: Draft, allowed: () => readonly string[], ask: (prompt: string) => Promise<string>,
  review: (text: string) => void, multiline: (label: string) => Promise<string>) {
  const type = async () => {
    review('Choose a configured type:\n' + allowed().map(value => `  ${terminalText(value)}: ${Object.hasOwn(meanings, value) ? meanings[value] : 'custom configured type'}`).join('\n') + '\n');
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
        if (!['yes', 'no'].includes(answer)) { review('Enter yes or no; breaking selection unchanged.\n'); break; }
        draft.breaking = answer === 'yes';
        if (draft.breaking) draft.breakingDetails = await multiline('Breaking details (explain the required migration)');
        break;
      }
      case 'refs': draft.refs = await multiline('Issue references (optional, e.g. #123; emitted as neutral Refs, never automatic closing)'); break;
      case 'footers': draft.footers = await multiline('Other footers (optional, e.g. Reviewed-by: Name)'); break;
      default: review('Choose type, scope, description, body, breaking, refs, or footers.\n');
    }
  };
  return { type, edit };
}
