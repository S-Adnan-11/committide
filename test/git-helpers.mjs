import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
export function environment(root) {
  return {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'absent-global-config'),
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
    GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true',
    GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}
export function run(binary, args, cwd, env, status = 0, input = '') {
  const result = spawnSync(binary, args, { cwd, env, input, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.ifError(result.error);
  if (status !== null) assert.equal(result.status, status, `${binary} ${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`);
  return result;
}
export const git = (cwd, env, args, status = 0, input = '') => run('git', args, cwd, env, status, input);
export const invoke = (cwd, env, args, status = 0, entry = cli) => run(process.execPath, [entry, ...args], cwd, env, status);
export function init(root, name, env) {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, env, ['init', '--initial-branch=main']);
  git(cwd, env, ['config', 'core.autocrlf', 'false']);
  git(cwd, env, ['config', 'commit.gpgsign', 'false']);
  return cwd;
}
export function commit(cwd, env, message) {
  git(cwd, env, ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-F', '-'], 0, message);
  return git(cwd, env, ['rev-parse', 'HEAD']).stdout.trim();
}
export function change(cwd, env, name, content) {
  writeFileSync(join(cwd, name), content);
  git(cwd, env, ['add', '--', name]);
}
