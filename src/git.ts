import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { OperationalError } from './errors.js';

export async function git(cwd: string, args: readonly string[], allowed = [0]): Promise<Buffer> {
  return new Promise((accept, reject) => {
    execFile('git', ['--no-replace-objects', ...args], {
      cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && !allowed.includes(Number(error.code))) {
        const missing = error.code === 'ENOENT';
        reject(new OperationalError(missing ? 'git-missing' : 'git-operation', missing
          ? 'Git was not found. Install Git and make it available on PATH.'
          : `Git ${args[0]} failed. ${stderr.toString('utf8').trim() || 'Check repository access and available history.'}`));
      } else if (stderr.toString('utf8').includes('is ambiguous')) {
        reject(new OperationalError('git-ref', 'The revision name is ambiguous. Use a fully qualified ref or full object ID.'));
      } else accept(stdout);
    });
  });
}

export interface Repository { root: string; gitDir: string; commonDir: string; bare: boolean }

export async function repository(cwd: string): Promise<Repository> {
  let gitDir: string;
  try {
    gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).toString('utf8').trimEnd();
  } catch (error) {
    if (error instanceof OperationalError && error.rule === 'git-missing') throw error;
    throw new OperationalError('git-repository', 'No accessible Git repository here. Run from a repository or its subdirectory.');
  }
  const bare = (await git(cwd, ['rev-parse', '--is-bare-repository'])).toString().trim() === 'true';
  const root = bare ? gitDir : (await git(cwd, ['rev-parse', '--show-toplevel'])).toString('utf8').trimEnd();
  const commonDir = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString('utf8').trimEnd();
  return { root: resolve(root), gitDir: resolve(gitDir), commonDir: resolve(commonDir), bare };
}

export async function resolveCommit(cwd: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith('-') || /[\s\0]|\.\.|\^[@!]|\^-/.test(ref)) {
    throw new OperationalError('git-ref', 'Use one commit ref per boundary, without whitespace, ranges, option prefixes, or multi-revision operators.');
  }
  let oid: string;
  try {
    oid = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).toString().trim();
  } catch (error) {
    if (error instanceof OperationalError && error.rule === 'git-missing') throw error;
    throw new OperationalError('git-ref', `Cannot resolve ${JSON.stringify(ref)} to one unambiguous commit. Check the ref and local history.`);
  }
  if (!/^[a-f0-9]+$/.test(oid)) throw new OperationalError('git-ref', 'Git returned an invalid commit object ID.');
  return oid;
}

export interface HistoryCommit { oid: string; parents: string[]; message: string }

export async function readCommit(cwd: string, oid: string): Promise<HistoryCommit> {
  const raw = await git(cwd, ['cat-file', 'commit', oid]);
  const boundary = raw.indexOf('\n\n');
  if (boundary < 0) throw new OperationalError('git-object', `Malformed commit object ${oid}.`);
  const headers = raw.subarray(0, boundary).toString('utf8').split('\n');
  const encoding = headers.find(line => line.startsWith('encoding '))?.slice(9);
  if (encoding && !/^utf-?8$/i.test(encoding)) {
    throw new OperationalError('git-encoding', `Commit ${oid} uses ${JSON.stringify(encoding)}. Only UTF-8 commit messages are supported.`);
  }
  let message: string;
  try {
    message = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(boundary + 2));
  } catch {
    throw new OperationalError('git-encoding', `Commit ${oid} does not contain a valid UTF-8 message.`);
  }
  return { oid, parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)), message };
}
