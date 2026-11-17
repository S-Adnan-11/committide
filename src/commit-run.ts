import { execFile, spawn } from 'node:child_process';
import { mkdtemp, chmod, open, unlink, rmdir } from 'node:fs/promises';
import { tmpdir, userInfo, constants } from 'node:os';
import { join } from 'node:path';
import { OperationalError } from './errors.js';
import { git, repository, readCommit } from './git.js';
import { lintMessage } from './message.js';
import { terminalText } from './changelog.js';
import { commitStateCurrent, recordedTree, worktreeIdentity } from './commit-state.js';
import type { CommitState } from './commit-state.js';
import type { SuggestIO } from './suggest-io.js';

export interface CommitIO extends SuggestIO { handoff?(): void }
export interface CommitResult {
  status: 'committed' | 'failed' | 'uncertain' | 'stale' | 'empty';
  exitCode: number;
  oid?: string;
}

async function systemFile(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(new OperationalError('commit-temp', 'Cannot restrict the temporary message directory. No Git commit was started.'));
      else resolve(stdout);
    });
  });
}

/** Random private directory, then exclusive file creation; no caller-selected output. */
export async function temporaryMessage(message: string): Promise<{ path: string; cleanup(): Promise<void> }> {
  let folder: string | undefined;
  let path: string | undefined;
  const cleanup = async () => {
    if (path) { await unlink(path); path = undefined; }
    if (folder) { await rmdir(folder); folder = undefined; }
  };
  try {
    // Windows ignores POSIX modes. Use the OS user's profile temp and a protected
    // DACL before writing content; TMP/TEMP cannot redirect it into a repository.
    const base = process.platform === 'win32' ? join(userInfo().homedir, 'AppData', 'Local', 'Temp') : tmpdir();
    folder = await mkdtemp(join(base, 'committide-commit-'));
    if (process.platform === 'win32') {
      const identity = await systemFile('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
      const sid = /"(S-1-[0-9-]+)"/.exec(identity)?.[1];
      if (!sid) throw new OperationalError('commit-temp', 'Cannot identify the current Windows user for temporary message permissions.');
      await systemFile('icacls.exe', [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
    } else await chmod(folder, 0o700);
    const target = join(folder, 'message');
    const handle = await open(target, 'wx', 0o600);
    path = target;
    try { await handle.writeFile(message, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    return { path: target, cleanup };
  } catch (error) {
    try { await cleanup(); } catch { /* Never recursively delete an unexpected file. */ }
    if (error instanceof OperationalError) throw error;
    throw new OperationalError('commit-temp', 'Cannot create a private temporary message. No Git commit was started.');
  }
}

interface ChildResult { code: number | null; signal: NodeJS.Signals | null; started: boolean; interrupted: boolean }

function normalGitCommit(root: string, path: string, io: CommitIO): Promise<ChildResult> {
  return new Promise(resolve => {
    // The terminal driver delivers Ctrl+C to the foreground processes. Keep the
    // parent alive for result inspection and cleanup; never retry the child.
    let interrupted = false;
    const interrupt = () => { interrupted = true; };
    io.check();
    io.handoff?.();
    process.on('SIGINT', interrupt);
    const child = spawn('git', ['commit', '--file', path], { cwd: root, stdio: 'inherit', shell: false });
    let started = false;
    child.once('spawn', () => { started = true; });
    child.once('error', () => {});
    child.once('close', (code, signal) => {
      process.off('SIGINT', interrupt);
      resolve({ code, signal, started, interrupted });
    });
  });
}

function childExit(child: ChildResult): number {
  if (!child.started) return 2;
  if (child.code !== null) return child.code;
  return child.signal ? 128 + (constants.signals[child.signal] ?? 1) : child.interrupted ? 130 : 2;
}

async function inspectResult(state: CommitState, message: string, child: ChildResult, io: CommitIO): Promise<CommitResult> {
  const exitCode = childExit(child);
  const uncertain = (detail: string, oid?: string): CommitResult => {
    io.review(`Commit result needs inspection: ${detail}\nGit exit: ${exitCode}. No retry was made. Inspect git status and git log before running another commit.\n`);
    return { status: 'uncertain', exitCode: exitCode || 2, ...(oid ? { oid } : {}) };
  };
  try {
    const repo = await repository(state.snapshot.root);
    const branch = (await git(repo.root, ['symbolic-ref', '--quiet', 'HEAD'], [0, 1])).toString('utf8').trimEnd() || null;
    const oid = (await git(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1])).toString().trim();
    if (branch !== state.branch || await worktreeIdentity(repo) !== state.worktree) return uncertain('The worktree or branch changed while Git ran.', oid);
    if (!oid || oid === state.snapshot.head) {
      if (child.started && exitCode === 0) return uncertain('Git reported success but no new HEAD was observed.');
      io.review(child.started ? `Git did not record a new HEAD (exit ${exitCode}). No retry was made.\n` : 'Could not start Git. No retry was made.\n');
      return { status: 'failed', exitCode };
    }
    const recorded = await readCommit(repo.root, oid);
    const expectedParents = state.snapshot.head ? [state.snapshot.head] : [];
    if (JSON.stringify(recorded.parents) !== JSON.stringify(expectedParents) || await recordedTree(repo.root, oid) !== state.tree) {
      return uncertain(`Observed HEAD ${oid} differs from the reviewed parent or staged tree. The repository was left as Git recorded it.`, oid);
    }
    io.review(`Recorded HEAD: ${oid}\nRecorded message:\n---\n${recorded.message.split('\n').map(terminalText).join('\n')}---\n`);
    if (recorded.message !== message) io.review('Git recorded a different message, for example from hook or cleanup behavior. Review the recorded text above.\n');
    if (exitCode !== 0) return uncertain(`A matching new commit was observed despite Git's failure or cancellation.`, oid);
    io.review('Commit recorded. Pushing is a separate action.\n');
    return { status: 'committed', exitCode: 0, oid };
  } catch {
    return uncertain('The recorded result could not be fully inspected.');
  }
}

export async function executeCommit(cwd: string, state: CommitState, message: string, io: CommitIO, config?: string): Promise<CommitResult> {
  if (lintMessage(message, state.allowed).diagnostics.length) throw new OperationalError('commit-message', 'Correct the message before committing.');
  // Keep the parent alive through post-child inspection and cleanup too. Before
  // handoff the terminal's own handler still cancels the composer as usual.
  const holdInterrupt = () => {};
  process.on('SIGINT', holdInterrupt);
  let temporary: Awaited<ReturnType<typeof temporaryMessage>> | undefined;
  try {
    temporary = await temporaryMessage(message);
    // Last read at the handoff. Git and other processes remain independent
    // writers; there is no atomic approval across the check-to-spawn interval.
    if (!await commitStateCurrent(cwd, state, config)) return { status: 'stale', exitCode: 2 };
    io.check();
    return await inspectResult(state, message, await normalGitCommit(state.snapshot.root, temporary.path, io), io);
  } finally {
    try { await temporary?.cleanup(); }
    catch { throw new OperationalError('commit-cleanup', 'Temporary message cleanup failed. Inspect your user temp directory and Git history before another commit; no retry was made.'); }
    finally { process.off('SIGINT', holdInterrupt); }
  }
}
