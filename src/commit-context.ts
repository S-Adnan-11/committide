import { gitPrefix } from './git.js';
import { diffOptions, OVERVIEW_LIMIT } from './staged.js';
import { commitStateCurrent } from './commit-state.js';
import type { CommitState } from './commit-state.js';
import { DraftContractError, prepareDraftRequest, REQUEST_LIMIT } from './provider.js';
import type { DraftEntry, DraftRequest } from './provider.js';

function stale(): never { throw new DraftContractError('stale', 'The reviewed input changed. Review the current staged set again.'); }

/** Parse Git's NUL-delimited numstat, including rename pairs and opaque counts. */
export function contextEntries(bytes: Buffer, state: CommitState): DraftEntry[] {
  const fields = bytes.toString('utf8').split('\0');
  if (fields.pop() !== '') throw new DraftContractError('request', 'Incomplete staged statistics.');
  const entries: DraftEntry[] = [];
  for (let i = 0; i < fields.length;) {
    const record = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i++]!);
    if (!record) throw new DraftContractError('request', 'Unsupported staged statistics.');
    const paths = record[3] ? [record[3]] : [fields[i++]!, fields[i++]!];
    const change = state.changes[entries.length];
    if (!change || JSON.stringify(paths) !== JSON.stringify(change.paths)) stale();
    const status = change.status.startsWith('R') ? 'R' : change.status;
    const kind = change.kind !== 'text' ? change.kind : record[1] === '-' ? 'binary' : 'text';
    entries.push({ status: status as DraftEntry['status'], path: paths.at(-1)!,
      ...(status === 'R' ? { previousPath: paths[0]! } : {}), kind,
      additions: kind === 'text' ? Number(record[1]) : null, deletions: kind === 'text' ? Number(record[2]) : null });
  }
  if (entries.length !== state.changes.length) stale();
  return entries;
}

export async function commitContext(cwd: string, state: CommitState, intent: string, selected: readonly number[] = [], config?: string): Promise<string> {
  if (!await commitStateCurrent(cwd, state, config)) stale();
  const base = state.snapshot.head ? [state.snapshot.head] : [];
  const counts = await gitPrefix(state.snapshot.root, [...diffOptions, '--numstat', '-z', ...base, '--'], OVERVIEW_LIMIT);
  if (counts.truncated) throw new DraftContractError('request', 'Complete staged statistics exceed the context bound.');
  const entries = contextEntries(counts.bytes, state);
  const request: DraftRequest = { version: 1, policy: { allowedTypes: [...state.allowed] }, staged: { complete: true, entries }, intent };
  // Validate metadata before reading any optional patch, including sensitive paths.
  prepareDraftRequest(JSON.stringify(request));
  if (selected.length) {
    if (new Set(selected).size !== selected.length) throw new DraftContractError('request', 'Select each staged entry only once.');
    request.hunks = [];
    for (const index of selected) {
      const entry = entries[index];
      if (!Number.isInteger(index) || !entry || entry.kind !== 'text') throw new DraftContractError('request', 'Select staged text entries by their displayed number.');
      if ([entry.path, entry.previousPath].some(path => path !== undefined && /(?:^|\/)(?:node_modules|vendor|dist|build|coverage)(?:\/|$)/i.test(path))) throw new DraftContractError('request', 'Generated/vendor patches are excluded. Use metadata or offline drafting.');
      const paths = entry.previousPath ? [entry.previousPath, entry.path] : [entry.path];
      const patch = await gitPrefix(state.snapshot.root, ['--literal-pathspecs', ...diffOptions, '--patch', '--full-index', '--unified=3',
        '--src-prefix=a/', '--dst-prefix=b/', ...base, '--', ...paths], REQUEST_LIMIT);
      if (patch.truncated) throw new DraftContractError('request', 'A complete selected patch exceeds the context bound. No partial patch is sent.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(patch.bytes); }
      catch { throw new DraftContractError('request', 'Selected staged patch is not UTF-8. Use offline drafting.'); }
      request.hunks.push({ path: entry.path, patch: text });
    }
  }
  if (!await commitStateCurrent(cwd, state, config)) stale();
  return prepareDraftRequest(JSON.stringify(request), { allowHunks: selected.length > 0 });
}
