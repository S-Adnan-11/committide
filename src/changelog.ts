import { OperationalError } from './errors.js';
import { git, readCommit, repository, requireCompleteHistory, resolveCommit } from './git.js';
import { parseMessage } from './message.js';
import type { ParsedMessage } from './message.js';

export const START_MARKER = '<!-- committide:unreleased:start -->';
export const END_MARKER = '<!-- committide:unreleased:end -->';
// Stable SemVer only: arbitrary-size decimal components, optional build metadata,
// no leading zeros, prerelease, or custom prefix other than a lowercase v.
export function isReleaseTag(name: string): boolean {
  return !/\s/.test(name) && /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(name);
}

export function terminalText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char =>
    char === '\u200c' || char === '\u200d' ? char : `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`);
}

/** Encode punctuation before Markdown parsing so commit text cannot add syntax/links. */
export function markdownText(text: string): string {
  return terminalText(text).replace(/[!-/:-@[-`{-~]/g, char => `&#${char.codePointAt(0)};`);
}

export interface ChangelogOptions { from?: string; to?: string; includeMaintenance?: boolean }
export interface ChangelogResult {
  root: string;
  to: string;
  from: string | null;
  tag: string | null;
  selected: number;
  included: number;
  filtered: number;
  skipped: { oid: string; rules: string[] }[];
  content: string;
  markdown: string;
}

async function releaseBoundary(root: string, target: string): Promise<{ oid: string; tag: string } | null> {
  const tags = new Map<string, string[]>();
  const listing = (await git(root, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/tags/'])).toString('utf8').trimEnd();
  for (const line of listing ? listing.split('\n') : []) {
    const [ref, object] = line.split('\0');
    if (!ref || !isReleaseTag(ref.slice('refs/tags/'.length))) continue;
    if (!object || !/^[a-f0-9]+$/.test(object)) throw new OperationalError('git-object', 'Git returned an invalid tag object ID.');
    // Peel the snapshot object, not a ref that could move during generation.
    const peeled = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${object}^{}`])).toString().trim();
    if (!/^[a-f0-9]+$/.test(peeled)) throw new OperationalError('git-object', 'Git returned an invalid peeled tag object ID.');
    if ((await git(root, ['cat-file', '-t', peeled])).toString().trim() !== 'commit') continue;
    const names = tags.get(peeled) ?? [];
    names.push(ref.slice('refs/tags/'.length));
    tags.set(peeled, names);
  }
  const chain = (await git(root, ['rev-list', '--first-parent', target, '--'])).toString().trim();
  for (const oid of chain.split('\n')) {
    const names = tags.get(oid);
    if (!names) continue;
    if (names.length > 1) {
      throw new OperationalError('changelog-tags', `Multiple stable release tags point at the nearest first-parent release commit ${oid}: ${names.sort().map(name => JSON.stringify(terminalText(name))).join(', ')}. Select an explicit --from REF.`);
    }
    return { oid, tag: names[0]! };
  }
  return null;
}

function entry(oid: string, message: ParsedMessage): string {
  const scope = message.scope ? `${markdownText(message.scope)}: ` : '';
  let text = `- ${scope}${markdownText(message.description)} (${oid})`;
  for (const detail of message.breakingDescriptions) {
    if (detail === message.description) continue;
    text += '\n' + detail.split('\n').map(line => line ? `  ${markdownText(line)}` : '').join('\n');
  }
  return text;
}

export async function generateChangelog(cwd: string, options: ChangelogOptions = {}): Promise<ChangelogResult> {
  const repo = await repository(cwd);
  await requireCompleteHistory(repo.root);
  const to = await resolveCommit(repo.root, options.to ?? 'HEAD');
  const boundary = options.from === undefined ? await releaseBoundary(repo.root, to) : null;
  const from = options.from === undefined ? boundary?.oid ?? null : await resolveCommit(repo.root, options.from);
  const ids = (await git(repo.root, ['rev-list', '--reverse', '--topo-order', to, ...(from ? [`^${from}`] : []), '--'])).toString().trim();
  const result: ChangelogResult = {
    root: repo.root, to, from, tag: boundary?.tag ?? null, selected: 0,
    included: 0, filtered: 0, skipped: [], content: '', markdown: '',
  };
  const groups = new Map<string, string[]>([
    ['Breaking Changes', []], ['Features', []], ['Fixes', []],
    ['Performance Improvements', []], ['Maintenance', []],
  ]);
  const typeGroups = new Map([['feat', 'Features'], ['fix', 'Fixes'], ['perf', 'Performance Improvements']]);
  for (const oid of ids ? ids.split('\n') : []) {
    if (!/^[a-f0-9]+$/.test(oid)) throw new OperationalError('git-object', 'Git returned an invalid commit object ID.');
    const commit = await readCommit(repo.root, oid);
    const parsed = parseMessage(commit.message);
    result.selected++;
    if (!parsed.parsed || parsed.diagnostics.length) {
      result.skipped.push({ oid, rules: parsed.diagnostics.map(diagnostic => `${diagnostic.rule}: ${diagnostic.message}`) });
      continue;
    }
    const message = parsed.parsed;
    const group = message.breaking ? 'Breaking Changes'
      : typeGroups.get(message.type.toLowerCase())
        ?? (options.includeMaintenance ? 'Maintenance' : null);
    if (!group) { result.filtered++; continue; }
    groups.get(group)!.push(entry(oid, message));
    result.included++;
  }
  result.content = [...groups].filter(([, entries]) => entries.length)
    .map(([title, entries]) => `### ${title}\n\n${entries.join('\n')}`).join('\n\n') || 'No qualifying changes.';
  result.markdown = `## Unreleased\n\n${START_MARKER}\n${result.content}\n${END_MARKER}\n`;
  return result;
}
