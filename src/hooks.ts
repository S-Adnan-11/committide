import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, link, unlink, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OperationalError } from './errors.js';
import { git, repository } from './git.js';
import type { Repository } from './git.js';

export const HOOK_TEXT = `#!/bin/sh
# CommitTide commit-msg integration v1. Managed as an exact file.
if [ "$#" -ne 1 ]; then
  echo 'CommitTide: expected one commit-message file argument.' >&2
  exit 2
fi
runtime=node
# npm can place a POSIX node shim beside a Windows node.exe; prefer the real exe.
if command -v node.exe >/dev/null 2>&1; then runtime=node.exe; fi
if ! command -v "$runtime" >/dev/null 2>&1; then
  echo 'CommitTide: Node.js >=22.12.0 is required on PATH.' >&2
  exit 2
fi
"$runtime" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<12)){console.error("CommitTide: Node.js >=22.12.0 is required.");process.exit(2)}' || exit $?
root=$(git rev-parse --show-toplevel) || exit 2
if [ ! -f "$root/node_modules/committide/dist/cli.js" ]; then
  echo 'CommitTide: local dependency is missing. Restore the locked dependency with npm ci.' >&2
  exit 2
fi
exec "$runtime" "$root/node_modules/committide/dist/cli.js" hook --file "$1"
`;

function failure(rule: string, message: string): OperationalError {
  return new OperationalError(rule, `${message} No integration was overwritten. Manual integration: from the repository root, invoke node node_modules/committide/dist/cli.js lint --file "$1" from your existing commit-msg hook and propagate its exit status. See the README for prerequisites.`);
}

function inside(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return !!part && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part);
}

async function status(path: string) {
  try { return await lstat(path, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw failure('hook-path', `Cannot inspect ${JSON.stringify(path)}. Check access permissions.`);
  }
}

/** Inspect each existing component, including junctions, before touching a hook. */
async function noSymlinks(path: string): Promise<void> {
  let current = parse(resolve(path)).root;
  for (const part of relative(current, resolve(path)).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if ((await status(current))?.isSymbolicLink()) throw failure('hook-layout', `Symlinked paths are unsupported: ${JSON.stringify(current)}.`);
  }
}

// Resolve existing ancestors too: Git and Node can return different long/8.3
// spellings of the same Windows directory, including a not-yet-created child.
async function canonicalPath(path: string): Promise<string> {
  const suffix: string[] = [];
  let parent = path;
  while (!(await status(parent))) {
    suffix.unshift(relative(dirname(parent), parent));
    const next = dirname(parent);
    if (next === parent) throw failure('hook-path', 'Cannot resolve the hook path.');
    parent = next;
  }
  return join(await realpath(parent), ...suffix);
}

async function hookLocation(cwd: string): Promise<{ repo: Repository; target: string }> {
  const repo = await repository(cwd);
  if (repo.bare) throw failure('hook-layout', 'Automatic hooks require a non-bare working repository.');
  const effective = (await git(repo.root, ['config', '--show-scope', '--get', 'core.hooksPath'], [0, 1])).toString().trimEnd();
  const rawTarget = resolve((await git(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/commit-msg'])).toString().trimEnd());
  await noSymlinks(rawTarget);
  const target = await canonicalPath(rawTarget);
  repo.root = await realpath(repo.root);
  repo.commonDir = await realpath(repo.commonDir);
  const defaultTarget = join(repo.commonDir, 'hooks', 'commit-msg');
  if (effective) {
    const scope = effective.split(/\s/, 1)[0];
    if (!['local', 'worktree'].includes(scope ?? '') || !inside(repo.root, target)) {
      throw failure('hook-layout', 'The effective hooks path is inherited, external, or shared outside this working tree. Automatic changes are refused.');
    }
    if (/(?:^|[\\/])(?:\.husky|_)(?:[\\/]|$)/i.test(relative(repo.root, target))) {
      throw failure('hook-layout', 'This hooks path appears managed by another tool.');
    }
    if (target !== defaultTarget && (dirname(dirname(target)) !== repo.root || await status(join(dirname(target), '.git')))) {
      throw failure('hook-layout', 'Automatic custom hooks must use a direct child directory of this repository root, outside any nested repository.');
    }
  } else if (target !== defaultTarget) {
    throw failure('hook-layout', 'Git returned an unsupported hooks layout.');
  }
  await noSymlinks(target);
  return { repo, target };
}

/** Require the consuming root's declared, locked, real installed npm dependency. */
export async function localDependency(root: string): Promise<void> {
  const packageRoot = join(root, 'node_modules', 'committide');
  try {
    await noSymlinks(packageRoot);
    const [project, lock, installed] = await Promise.all([
      readFile(join(root, 'package.json'), 'utf8').then(JSON.parse),
      readFile(join(root, 'package-lock.json'), 'utf8').then(JSON.parse),
      readFile(join(packageRoot, 'package.json'), 'utf8').then(JSON.parse),
    ]);
    const declared = project.devDependencies?.committide ?? project.dependencies?.committide;
    const lockedDeclaration = lock.packages?.['']?.devDependencies?.committide ?? lock.packages?.['']?.dependencies?.committide;
    if (typeof declared !== 'string' || lockedDeclaration !== declared || installed.name !== 'committide'
      || installed.version !== lock.packages?.['node_modules/committide']?.version
      || installed.bin?.committide !== 'dist/cli.js') throw new Error('Unsupported dependency setup');
    const entry = join(packageRoot, 'dist', 'cli.js');
    await noSymlinks(entry);
    if (!(await lstat(entry)).isFile() || !inside(await realpath(root), await realpath(entry))) throw new Error('Invalid executable');
  } catch {
    throw failure('hook-dependency', 'Use a declared committide dependency installed in this repository root with an npm package-lock.json matching package.json and the installed version. Install a reviewed package with npm install --save-dev --save-exact <committide-tarball-or-version>, or restore it with npm ci. Workspaces, linked dependencies, and other lockfile formats require manual integration.');
  }
}

async function snapshot(target: string) {
  const before = await status(target);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw failure('hook-ownership', 'The existing hook is not a regular, unshared file.');
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat({ bigint: true });
    const bytes = await file.readFile();
    const after = await status(target);
    // Windows Node 22 reports lstat.dev=0 while fstat returns the actual device.
    // Compare path devices to each other; use handle identity across the move.
    const deviceMatches = after && after.dev === before.dev
      && (after.dev === stat.dev || (process.platform === 'win32' && after.dev === 0n));
    if (!after || !deviceMatches || after.ino !== stat.ino || before.ino !== stat.ino
      || after.nlink !== 1n || stat.nlink !== 1n
      || bytes.toString('utf8') !== HOOK_TEXT || !bytes.equals(Buffer.from(HOOK_TEXT))
      || (process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o755n)) {
      throw failure('hook-ownership', 'The existing hook is foreign, modified, or changed during inspection; preserve and integrate it manually.');
    }
    return { ino: stat.ino, dev: stat.dev, bytes };
  } finally { await file.close(); }
}

export async function manageHook(cwd: string, action: 'install' | 'uninstall'): Promise<string> {
  const { repo, target } = await hookLocation(cwd);
  if (action === 'install') await localDependency(repo.root);
  if (action === 'uninstall' && !(await status(target))) return 'No CommitTide hook to remove.';
  const folder = dirname(target);
  await mkdir(folder, { recursive: true });
  await noSymlinks(target);
  const guard = join(folder, '.committide-lock');
  try { await mkdir(guard); } catch {
    throw failure('hook-busy', 'Hook integration is locked or inaccessible. Retry after other installers finish; inspect a stale .committide-lock manually.');
  }
  try {
    const existing = await snapshot(target);
    if (action === 'install') {
      if (existing) return `CommitTide hook already installed at ${target}.`;
      // Prepare completely before an atomic, non-overwriting hard-link publish.
      const prepared = join(folder, `.committide-install-${randomUUID()}`);
      const file = await open(prepared, 'wx', 0o755);
      try {
        try { await file.writeFile(HOOK_TEXT); await file.chmod(0o755); await file.sync(); }
        finally { await file.close(); }
        await noSymlinks(target);
        await link(prepared, target);
      } finally { await unlink(prepared); }
      return `Installed CommitTide hook at ${target}. Default common hooks apply to linked worktrees too.`;
    }
    if (!existing) return 'No CommitTide hook to remove.';
    // Quarantine first, then compare the actual moved file. Restore without
    // overwriting if an external edit raced the snapshot. Other installers lock.
    const quarantine = join(folder, `.committide-remove-${randomUUID()}`);
    await rename(target, quarantine);
    try {
      const moved = await snapshot(quarantine);
      if (!moved || moved.ino !== existing.ino || moved.dev !== existing.dev) throw new Error('Hook identity changed');
    } catch {
      try { await link(quarantine, target); await unlink(quarantine); } catch {
        throw new OperationalError('hook-race', `Hook changed concurrently. Its content is preserved at ${quarantine}; inspect and restore manually. No existing destination was overwritten.`);
      }
      throw failure('hook-race', 'Hook changed concurrently and was restored; removal was refused.');
    }
    await unlink(quarantine);
    return `Removed CommitTide hook from ${target}.`;
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw failure('hook-operation', 'Hook operation failed. Check access permissions and inspect the hook before retrying.');
  } finally { await rmdir(guard); }
}
