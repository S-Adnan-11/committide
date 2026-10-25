import { randomUUID } from 'node:crypto';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { repository } from './git.js';
import { OperationalError } from './errors.js';
import { SuggestCancelled } from './suggest-io.js';

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

/** Resolve a new destination once, refusing linked parents and Git metadata. */
export async function messageDestination(cwd: string, path: string): Promise<string> {
  const target = resolve(cwd, path);
  const repo = await repository(cwd);
  let parent = dirname(target);
  let canonical: string;
  try {
    while (true) {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe parent');
      const next = dirname(parent);
      if (parent === next) break;
      parent = next;
    }
    // Resolve once so later working-directory changes cannot redirect the destination.
    canonical = join(await realpath(dirname(target)), basename(target));
  } catch {
    throw new OperationalError('suggest-output', 'The output parent must be an accessible real directory without symlinks or junctions. No file was written.');
  }
  const protectedPaths = [await realpath(repo.gitDir), await realpath(repo.commonDir), join(await realpath(repo.root), '.git')];
  if (protectedPaths.some(path => inside(path, canonical))) {
    throw new OperationalError('suggest-output', 'Choose a new message file outside Git metadata directories.');
  }
  try { await lstat(canonical); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return canonical;
    throw new OperationalError('suggest-output', 'Cannot inspect the output path. Check permissions and choose a new filename.');
  }
  throw new OperationalError('suggest-output', 'The output path already exists. Choose a new message filename; existing files are never overwritten.');
}

/** Prepare complete bytes privately, then publish with an exclusive hard link. */
export async function saveMessage(target: string, message: string, current: () => Promise<boolean>, check: () => void): Promise<boolean> {
  const temporary = join(dirname(target), `.committide-message-${randomUUID()}.tmp`);
  let owned = false;
  try {
    check();
    const handle = await open(temporary, 'wx', 0o600);
    owned = true;
    try { await handle.writeFile(message, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    if (!await current()) return false;
    check();
    await link(temporary, target);
    return true;
  } catch (error) {
    // Preserve cancellation and Git diagnostics from the final snapshot check.
    if (error instanceof SuggestCancelled || error instanceof OperationalError) throw error;
    throw new OperationalError('suggest-output', 'Cannot create the new output file. A destination that appeared concurrently was preserved. Check the path, permissions, and hard-link support; choose a new filename if needed.');
  } finally {
    if (owned) await unlink(temporary);
  }
}
