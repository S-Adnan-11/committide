import { createHash } from 'node:crypto';
import { git, gitPrefix, repository } from './git.js';
import { OperationalError } from './errors.js';
import { terminalText } from './changelog.js';

export const OVERVIEW_LIMIT = 256 * 1024;
export const PATCH_LIMIT = 64 * 1024;
export interface StagedSnapshot {
  root: string;
  head: string | null;
  fingerprint: string;
  entries: string[];
  omitted: boolean;
}

async function head(root: string): Promise<string | null> {
  const value = (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1])).toString().trim();
  if (!value) {
    // A symbolic unborn branch is allowed; corrupt/detached missing HEAD is not.
    await git(root, ['symbolic-ref', '--quiet', 'HEAD']);
    return null;
  }
  if (!/^[a-f0-9]{40,64}$/.test(value)) throw new OperationalError('git-object', 'Git returned an invalid HEAD object ID.');
  await git(root, ['cat-file', '-e', `${value}^{commit}`]);
  return value;
}

async function identity(root: string): Promise<{ head: string | null; fingerprint: string }> {
  const base = await head(root);
  if ((await gitPrefix(root, ['ls-files', '--unmerged', '-z'], 1)).bytes.length) {
    throw new OperationalError('git-index', 'Resolve staged merge conflicts before composing a message.');
  }
  const index = await gitPrefix(root, ['ls-files', '--stage', '-z', '--full-name'], 0);
  return { head: base, fingerprint: createHash('sha256').update(base ?? 'unborn').update('\0').update(index.hash).digest('hex') };
}

const diffOptions = ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative',
  '--ignore-submodules=none', '--submodule=short', '--find-renames=50%', '-l1000'];

function safePath(bytes: Buffer): string {
  try { return terminalText(JSON.stringify(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { return `[non-UTF-8 path bytes: ${bytes.toString('hex')}]`; }
}

/** Parse only complete NUL-delimited raw records; paths are never line-split. */
export function stagedEntries(bytes: Buffer, truncated: boolean): { entries: string[]; omitted: boolean } {
  const fields: Buffer[] = [];
  let start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] === 0) { fields.push(bytes.subarray(start, end)); start = end + 1; }
  }
  const entries: string[] = [];
  let omitted = truncated;
  for (let index = 0; index < fields.length;) {
    const metadata = fields[index++]!.toString('ascii');
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z][0-9]*)$/.exec(metadata);
    if (!match) throw new OperationalError('git-index', 'Unsupported staged diff record. Resolve index conflicts before composing.');
    const status = match[3]!;
    if (status.startsWith('U')) throw new OperationalError('git-index', 'Resolve staged merge conflicts before composing a message.');
    const first = fields[index++];
    const second = /^[RC]/.test(status) ? fields[index++] : undefined;
    if (!first || (/^[RC]/.test(status) && !second)) { omitted = true; break; }
    if (entries.length === 100) { omitted = true; break; }
    const mode = `${match[1]} -> ${match[2]}`;
    const kind = [match[1], match[2]].includes('160000') ? '; submodule object only'
      : [match[1], match[2]].includes('120000') ? '; symlink object, target not followed' : '';
    entries.push(`${status} ${safePath(first)}${second ? ` -> ${safePath(second)}` : ''} (${mode}${kind})`);
  }
  return { entries, omitted };
}

export async function stagedCurrent(snapshot: StagedSnapshot): Promise<boolean> {
  return (await identity(snapshot.root)).fingerprint === snapshot.fingerprint;
}

export async function captureStaged(cwd: string): Promise<StagedSnapshot> {
  const repo = await repository(cwd);
  if (repo.bare) throw new OperationalError('git-repository', 'Staged review requires a working repository, not a bare repository.');
  const before = await identity(repo.root);
  const raw = await gitPrefix(repo.root, [...diffOptions, '--raw', '--no-abbrev', '-z', ...(before.head ? [before.head] : []), '--'], OVERVIEW_LIMIT);
  const snapshot = { root: repo.root, ...before, ...stagedEntries(raw.bytes, raw.truncated) };
  if (!await stagedCurrent(snapshot)) throw new OperationalError('suggest-stale', 'The index or HEAD changed during inspection. Retry suggest to review the current staged set.');
  return snapshot;
}

export function stagedOverview(snapshot: StagedSnapshot): string {
  return `Repository: ${terminalText(JSON.stringify(snapshot.root))}\nBase: ${snapshot.head ?? 'initial commit'}\n`
    + (snapshot.entries.length || snapshot.omitted
      ? `Staged entries (up to 100 shown):\n${snapshot.entries.join('\n')}\n${snapshot.omitted ? 'Overview truncated; additional entries omitted.\n' : ''}`
      : 'Nothing staged. Stage the changes you want to describe, then run suggest again.\n')
    + 'Only index changes are reviewed; additional unstaged edits are excluded.\n';
}

export async function stagedPatch(snapshot: StagedSnapshot): Promise<string | null> {
  if (!await stagedCurrent(snapshot)) return null;
  const result = await gitPrefix(snapshot.root, [...diffOptions, '--patch', '--full-index', '--unified=3',
    '--src-prefix=a/', '--dst-prefix=b/', ...(snapshot.head ? [snapshot.head] : []), '--'], PATCH_LIMIT);
  if (!await stagedCurrent(snapshot)) return null;
  const display = result.bytes.toString('utf8').split('\n').map(terminalText).join('\n');
  return `Staged patch (binary contents and submodule contents are not reviewed):\n${display}\n`
    + (result.truncated ? `Patch truncated at ${PATCH_LIMIT} bytes; omitted content has not been reviewed.\n` : 'End of staged patch.\n');
}
