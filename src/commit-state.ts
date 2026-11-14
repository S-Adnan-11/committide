import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { repository, git, gitPrefix } from './git.js';
import type { Repository } from './git.js';
import { captureStaged, diffOptions, OVERVIEW_LIMIT } from './staged.js';
import type { StagedSnapshot } from './staged.js';
import { loadConfig } from './config.js';
import { OperationalError } from './errors.js';
import { terminalText } from './changelog.js';
import { emptyDraft } from './draft.js';
import type { Draft } from './draft.js';

interface Binding {
  snapshot: StagedSnapshot;
  worktree: string;
  branch: string | null;
  allowed: string[];
}
export interface StagedChange { status: string; paths: string[]; sameMode: boolean; kind: 'text' | 'symlink' | 'submodule' }
export interface CommitState extends Binding {
  changes: StagedChange[];
  additions: number;
  deletions: number;
  binary: number;
  tree: string;
}

const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];

export async function worktreeIdentity(repo: Repository): Promise<string> {
  const [root, gitDir, commonDir, rootStat, gitStat] = await Promise.all([
    realpath(repo.root), realpath(repo.gitDir), realpath(repo.commonDir), stat(repo.root), stat(repo.gitDir),
  ]);
  return JSON.stringify([root, gitDir, commonDir, rootStat.dev, rootStat.ino, gitStat.dev, gitStat.ino]);
}

async function binding(cwd: string, config?: string): Promise<Binding> {
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    if (process.env[name] !== undefined) throw new OperationalError('commit-environment', `Unset ${name} before using commit. Only an ordinary worktree and its own index are supported.`);
  }
  const repo = await repository(cwd);
  if (repo.bare) throw new OperationalError('commit-repository', 'commit requires a working repository.');
  const [root, gitDir] = await Promise.all([realpath(repo.root), realpath(repo.gitDir)]);
  for (const name of operations) {
    try { await lstat(join(gitDir, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new OperationalError('commit-state', 'Cannot inspect Git operation state. Check repository access.');
    }
    throw new OperationalError('commit-operation', `Git operation in progress (${name}). Use Git's native --continue/--abort workflow before starting an ordinary commit.`);
  }
  const [snapshot, branchBytes, allowed, worktree] = await Promise.all([
    captureStaged(cwd), git(root, ['symbolic-ref', '--quiet', 'HEAD'], [0, 1]), loadConfig(cwd, config), worktreeIdentity(repo),
  ]);
  const branch = branchBytes.toString('utf8').trimEnd() || null;
  return { snapshot, branch, allowed, worktree };
}

function sameBinding(a: Binding, b: Binding): boolean {
  return a.worktree === b.worktree && a.branch === b.branch && a.snapshot.fingerprint === b.snapshot.fingerprint
    && JSON.stringify(a.allowed) === JSON.stringify(b.allowed);
}

export async function commitStateCurrent(cwd: string, state: CommitState, config?: string): Promise<boolean> {
  return sameBinding(state, await binding(cwd, config));
}

/** Canonical mode/object/path digest, shared by a stage-zero index and a recorded tree. */
export function treeSignature(bytes: Buffer, index: boolean): string {
  const hash = createHash('sha256');
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start);
    const tab = bytes.indexOf(9, start);
    if (end < 0 || tab < start || tab >= end) throw new OperationalError('commit-index', 'Unsupported index or tree record. Use Git directly.');
    const metadata = bytes.subarray(start, tab).toString('ascii');
    const match = (index ? /^(100644|100755|120000|160000) ([a-f0-9]{40,64}) 0$/ : /^(100644|100755|120000|160000) (?:blob|commit) ([a-f0-9]{40,64})$/).exec(metadata);
    if (!match) throw new OperationalError('commit-index', 'Only resolved, fully expanded stage-zero index entries are supported. Use Git directly.');
    hash.update(`${match[1]} ${match[2]}\t`).update(bytes.subarray(tab + 1, end)).update('\0');
    start = end + 1;
  }
  return hash.digest('hex');
}

function changes(bytes: Buffer): StagedChange[] {
  const fields = bytes.toString('utf8').split('\0');
  fields.pop();
  const result: StagedChange[] = [];
  for (let i = 0; i < fields.length;) {
    const record = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z][0-9]*)$/.exec(fields[i++]!);
    if (!record) throw new OperationalError('commit-index', 'Unsupported staged diff. Use Git directly.');
    const paths = [fields[i++]!];
    if (/^[RC]/.test(record[3]!)) paths.push(fields[i++]!);
    if (paths.some(path => !path)) throw new OperationalError('commit-index', 'Incomplete staged diff. Use Git directly.');
    const modes = [record[1], record[2]];
    const kind = modes.includes('160000') ? 'submodule' : modes.includes('120000') ? 'symlink' : 'text';
    result.push({ status: record[3]!, paths, sameMode: record[1] === record[2], kind });
  }
  return result;
}

export async function captureCommitState(cwd: string, config?: string): Promise<CommitState> {
  const before = await binding(cwd, config);
  if (before.snapshot.omitted) throw new OperationalError('commit-size', 'Staged overview is incomplete. Stage a smaller logical change (up to 100 entries) or use Git directly.');
  const base = before.snapshot.head ? [before.snapshot.head] : [];
  const args = [...diffOptions, '--raw', '--no-abbrev', '-z', ...base];
  const [raw, visible, index, counts] = await Promise.all([
    gitPrefix(before.snapshot.root, [...args, '--ita-invisible-in-index', '--'], OVERVIEW_LIMIT),
    gitPrefix(before.snapshot.root, [...args, '--ita-visible-in-index', '--'], OVERVIEW_LIMIT),
    gitPrefix(before.snapshot.root, ['ls-files', '--stage', '-z', '--full-name'], 8 * 1024 * 1024),
    gitPrefix(before.snapshot.root, [...diffOptions, '--numstat', ...base, '--'], OVERVIEW_LIMIT),
  ]);
  if (raw.hash !== visible.hash) throw new OperationalError('commit-index', 'Intent-to-add entries are unsupported. Stage their contents or remove their intent-to-add marker with Git first.');
  if ([raw, visible, index, counts].some(value => value.truncated)) throw new OperationalError('commit-size', 'Staged inspection exceeds its bounds. Stage a smaller change or use Git directly.');
  const state: CommitState = { ...before, changes: changes(raw.bytes), additions: 0, deletions: 0, binary: 0, tree: treeSignature(index.bytes, true) };
  for (const line of counts.bytes.toString('utf8').trimEnd().split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match) continue;
    if (match[1] === '-') state.binary++;
    else { state.additions += Number(match[1]); state.deletions += Number(match[2]); }
  }
  if (!sameBinding(before, await binding(cwd, config))) throw new OperationalError('commit-stale', 'Review state changed during inspection. Run commit again to review the current state.');
  return state;
}

export function commitOverview(state: CommitState): string {
  return `Repository: ${terminalText(JSON.stringify(state.snapshot.root))}\nBranch: ${state.branch ? terminalText(JSON.stringify(state.branch)) : 'detached HEAD'}\n`
    + `Base: ${state.snapshot.head ?? 'initial commit'}\nStaged: ${state.changes.length} entries, +${state.additions}/-${state.deletions} text lines, ${state.binary} binary entries.\n`
    + state.snapshot.entries.join('\n') + '\nOnly staged contents are committed; unstaged and untracked contents are excluded.\n';
}

const docsPath = (path: string) => /^(?:docs?\/|readme(?:\.|$)|license(?:\.|$)|changelog(?:\.|$))/i.test(path) || /\.(?:md|mdx|rst)$/i.test(path);
const testPath = (path: string) => /(?:^|\/)(?:tests?|__tests__)\//.test(path) || /(?:\.test|\.spec)\.[^/]+$/.test(path);

/** Only narrow, observable changes get a default. Logic changes need user intent. */
export function groundedDraft(state: CommitState): Draft | null {
  const draft = emptyDraft();
  if (!state.changes.length) return null;
  if (state.changes.every(change => change.status === 'R100' && change.sameMode)) {
    draft.type = 'chore'; draft.description = 'rename staged files';
  } else if (state.changes.every(change => change.paths.every(docsPath))) {
    draft.type = 'docs'; draft.description = 'update documentation';
  } else if (state.changes.every(change => change.paths.every(testPath))) {
    draft.type = 'test'; draft.description = 'update tests';
  } else return null;
  if (!state.allowed.includes(draft.type)) return null;
  const target = state.changes.length === 1 ? state.changes[0]!.paths.at(-1)! : null;
  if (target && !/[\x00-\x1f\x7f-\x9f\ufffd\u202a-\u202e\u2066-\u2069]/u.test(target)) {
    const change = state.changes[0]!;
    draft.description = change.status === 'R100' && change.sameMode ? `rename ${change.paths[0]} to ${target}`
      : `${change.status === 'A' ? 'add' : change.status === 'D' ? 'remove' : 'update'} ${target}`;
  }
  return draft;
}

export function mixedIntentHint(state: CommitState): string {
  const groups = new Set(state.changes.flatMap(change => change.paths.map(path => docsPath(path) ? 'docs' : testPath(path) ? 'tests' : 'other')));
  return groups.size > 1 ? 'These paths span different kinds of files. Check whether they describe one intent; no split is required.\n' : '';
}

export async function recordedTree(root: string, oid: string): Promise<string> {
  const result = await gitPrefix(root, ['ls-tree', '-r', '-z', '--full-tree', oid], 8 * 1024 * 1024);
  if (result.truncated) throw new OperationalError('commit-result', 'Recorded tree exceeds inspection bounds.');
  return treeSignature(result.bytes, false);
}
