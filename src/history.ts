import { OperationalError } from './errors.js';
import { git, readCommit, repository, resolveCommit } from './git.js';
import { lintMessage } from './message.js';
import type { Diagnostic } from './message.js';

export interface HistoryResult {
  from: string;
  to: string;
  checked: number;
  failed: number;
  skipped: number;
  failures: { oid: string; diagnostics: Diagnostic[] }[];
}

export async function checkHistory(cwd: string, from: string, to: string, allowedTypes: readonly string[]): Promise<HistoryResult> {
  const repo = await repository(cwd);
  if ((await git(repo.root, ['rev-parse', '--is-shallow-repository'])).toString().trim() === 'true') {
    throw new OperationalError('git-shallow', 'History is shallow. Fetch complete history first (for example git fetch --unshallow, or checkout with fetch-depth: 0 in CI). No fetch was performed.');
  }
  // Resolve both boundaries once; all later Git arguments use validated object IDs.
  const fromOid = await resolveCommit(repo.root, from);
  const toOid = await resolveCommit(repo.root, to);
  const ids = (await git(repo.root, ['rev-list', '--reverse', '--topo-order', toOid, `^${fromOid}`, '--'])).toString().trim();
  const result: HistoryResult = { from: fromOid, to: toOid, checked: 0, failed: 0, skipped: 0, failures: [] };
  for (const oid of ids ? ids.split('\n') : []) {
    if (!/^[a-f0-9]+$/.test(oid)) throw new OperationalError('git-object', 'Git returned an invalid commit object ID.');
    const commit = await readCommit(repo.root, oid);
    // Strict final-history policy: merge/revert and temporary fixup/squash subjects
    // are checked by the same rules as ordinary commits. Nothing is exempted.
    const validation = lintMessage(commit.message, allowedTypes);
    result.checked++;
    if (validation.diagnostics.length) {
      result.failed++;
      result.failures.push({ oid, diagnostics: validation.diagnostics });
    }
  }
  return result;
}
