import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, linkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { environment, init, git, invoke, commit, change, run } from './git-helpers.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'committide-hooks-')));
const env = environment(root);
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const npmPath = process.env.npm_execpath;
assert.ok(npmPath, 'Run hooks integration with npm test or npm exec');
const npm = (args, cwd) => run(process.execPath, [npmPath, ...args], cwd, env);
const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], source).stdout)[0];
const archive = join(root, packed.filename);
after(() => rmSync(root, { recursive: true, force: true }));
function install(cwd) {
  writeFileSync(join(cwd, 'package.json'), '{"name":"fixture","private":true}');
  npm(['install', '--save-dev', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', archive], cwd);
  return join(cwd, 'node_modules', 'committide', 'dist', 'cli.js');
}
const hookAt = cwd => join(cwd, '.git', 'hooks', 'commit-msg');

test('installed hook validates real commits, direct input, CRLF, and preserves rejected changes', () => {
  const cwd = init(root, 'ordinary repo with spaces', env);
  const entry = install(cwd);
  const config = readFileSync(join(cwd, '.git', 'config'));
  assert.match(invoke(cwd, env, ['hooks', 'install'], 0, entry).stdout, /Installed/);
  const hook = readFileSync(hookAt(cwd));
  const mtime = statSync(hookAt(cwd)).mtimeMs;
  assert.match(invoke(cwd, env, ['hooks', 'install'], 0, entry).stdout, /already installed/);
  assert.deepEqual(readFileSync(hookAt(cwd)), hook);
  assert.equal(statSync(hookAt(cwd)).mtimeMs, mtime);
  const initial = commit(cwd, env, 'chore: initial');
  change(cwd, env, 'file with spaces.txt', 'retained staged content\n');
  const staged = git(cwd, env, ['diff', '--cached', '--binary']).stdout;
  const result = git(cwd, env, ['commit', '-m', 'malformed'], 1);
  assert.match(result.stderr, /header-format/);
  assert.equal(git(cwd, env, ['rev-parse', 'HEAD']).stdout.trim(), initial);
  assert.equal(git(cwd, env, ['diff', '--cached', '--binary']).stdout, staged);
  assert.equal(readFileSync(join(cwd, 'file with spaces.txt'), 'utf8'), 'retained staged content\n');
  git(cwd, env, ['commit', '-m', 'feat: valid commit']);
  const message = join(cwd, 'message with spaces.txt');
  writeFileSync(message, 'FIX(scope)!: CRLF\r\n\r\nBody\r\n\r\nBREAKING CHANGE: Migrate\r\nRefs: #12\r\n');
  git(cwd, env, ['hook', 'run', 'commit-msg', '--', message]);
  assert.ok(readFileSync(message, 'utf8').includes('\r\n'));
  invoke(cwd, env, ['hook', '--file', message], 0, entry);
  writeFileSync(join(cwd, 'committide.config.json'), '{bad config');
  assert.match(invoke(cwd, env, ['hook', '--file', message], 2, entry).stderr, /config-json/);
  git(cwd, env, ['commit', '--allow-empty', '-m', 'fix: config failure'], 1);
  rmSync(join(cwd, 'committide.config.json'));
  writeFileSync(message, 'malformed');
  invoke(cwd, env, ['hook', '--file', message], 1, entry);
  git(cwd, env, ['hook', 'run', 'commit-msg', '--', message], 1);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'config')), config);
  writeFileSync(join(cwd, '.git', 'hooks', 'unrelated'), 'keep me');
  assert.match(invoke(cwd, env, ['hooks', 'uninstall'], 0, entry).stdout, /Removed/);
  assert.equal(existsSync(hookAt(cwd)), false);
  invoke(cwd, env, ['hooks', 'uninstall'], 0, entry);
  assert.equal(readFileSync(join(cwd, '.git', 'hooks', 'unrelated'), 'utf8'), 'keep me');
});

test('foreign and edited owned hooks remain byte-for-byte unchanged', () => {
  const cwd = init(root, 'preservation', env);
  const entry = install(cwd);
  change(cwd, env, 'staged.txt', 'preserve index\n');
  const index = readFileSync(join(cwd, '.git', 'index'));
  const config = readFileSync(join(cwd, '.git', 'config'));
  const foreign = Buffer.from('#!/bin/sh\r\n# CommitTide marker is not ownership\r\necho custom\r\n');
  writeFileSync(hookAt(cwd), foreign);
  for (const action of ['install', 'uninstall']) {
    const result = invoke(cwd, env, ['hooks', action], 2, entry);
    assert.match(result.stderr, /hook-ownership.*Manual integration/);
    assert.deepEqual(readFileSync(hookAt(cwd)), foreign);
  }
  rmSync(hookAt(cwd));
  invoke(cwd, env, ['hooks', 'install'], 0, entry);
  const edited = Buffer.concat([readFileSync(hookAt(cwd)), Buffer.from('# custom edit\n')]);
  writeFileSync(hookAt(cwd), edited);
  invoke(cwd, env, ['hooks', 'install'], 2, entry);
  invoke(cwd, env, ['hooks', 'uninstall'], 2, entry);
  assert.deepEqual(readFileSync(hookAt(cwd)), edited);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'index')), index);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'config')), config);
  rmSync(hookAt(cwd));
  const sharedFile = join(cwd, 'shared hook');
  writeFileSync(sharedFile, edited);
  linkSync(sharedFile, hookAt(cwd));
  invoke(cwd, env, ['hooks', 'uninstall'], 2, entry);
  assert.deepEqual(readFileSync(sharedFile), edited);
});

test('local relative/absolute hooks paths support nested invocation and preserve configuration', () => {
  for (const absolute of [false, true]) {
    const cwd = init(root, `custom-${absolute}`, env);
    const entry = install(cwd);
    const folder = join(cwd, 'custom hooks');
    git(cwd, env, ['config', 'core.hooksPath', absolute ? folder : 'custom hooks']);
    const config = readFileSync(join(cwd, '.git', 'config'));
    mkdirSync(join(cwd, 'nested'));
    invoke(join(cwd, 'nested'), env, ['hooks', 'install'], 0, entry);
    assert.ok(existsSync(join(folder, 'commit-msg')));
    git(join(cwd, 'nested'), env, ['commit', '--allow-empty', '-m', 'feat: custom hook']);
    invoke(join(cwd, 'nested'), env, ['hooks', 'uninstall'], 0, entry);
    assert.deepEqual(readFileSync(join(cwd, '.git', 'config')), config);
  }
});

test('external/inherited/managed and symlinked hooks paths refuse without outside mutations', () => {
  const cwd = init(root, 'unsafe', env);
  const entry = install(cwd);
  const outside = join(root, 'outside hooks');
  mkdirSync(outside);
  writeFileSync(join(outside, 'commit-msg'), 'outside sentinel');
  git(cwd, env, ['config', 'core.hooksPath', outside]);
  invoke(cwd, env, ['hooks', 'install'], 2, entry);
  invoke(cwd, env, ['hooks', 'uninstall'], 2, entry);
  assert.deepEqual(readdirSync(outside), ['commit-msg']);
  assert.equal(readFileSync(join(outside, 'commit-msg'), 'utf8'), 'outside sentinel');
  git(cwd, env, ['config', '--unset', 'core.hooksPath']);
  const global = join(root, 'fixture-global-config');
  writeFileSync(global, '[core]\n\thooksPath = inherited-hooks\n');
  invoke(cwd, { ...env, GIT_CONFIG_GLOBAL: global }, ['hooks', 'install'], 2, entry);
  assert.equal(existsSync(join(cwd, 'inherited-hooks')), false);
  git(cwd, env, ['config', 'core.hooksPath', '.husky/_']);
  invoke(cwd, env, ['hooks', 'install'], 2, entry);
  assert.equal(existsSync(join(cwd, '.husky')), false);
  symlinkSync(outside, join(cwd, 'linked hooks'), process.platform === 'win32' ? 'junction' : 'dir');
  git(cwd, env, ['config', 'core.hooksPath', 'linked hooks']);
  invoke(cwd, env, ['hooks', 'install'], 2, entry);
  assert.equal(readFileSync(join(outside, 'commit-msg'), 'utf8'), 'outside sentinel');
  const nested = init(cwd, 'nested repository', env);
  git(cwd, env, ['config', 'core.hooksPath', 'nested repository/.git/hooks']);
  const nestedBefore = readdirSync(join(nested, '.git', 'hooks'));
  invoke(cwd, env, ['hooks', 'install'], 2, entry);
  assert.deepEqual(readdirSync(join(nested, '.git', 'hooks')), nestedBefore);
});

test('concurrent installers publish one complete hook without overwriting', async () => {
  const cwd = init(root, 'concurrent', env);
  const entry = install(cwd);
  const launch = () => new Promise((accept, reject) => {
    const child = spawn(process.execPath, [entry, 'hooks', 'install'], { cwd, env, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => accept({ code, stderr }));
  });
  const results = await Promise.all([launch(), launch()]);
  assert.ok(results.some(result => result.code === 0));
  for (const result of results) {
    assert.ok(result.code === 0 || (result.code === 2 && result.stderr.includes('hook-busy')), JSON.stringify(result));
  }
  git(cwd, env, ['commit', '--allow-empty', '-m', 'fix: concurrent install']);
  invoke(cwd, env, ['hooks', 'uninstall'], 0, entry);
});

test('missing/changed dependency and lock setup fail closed; uninstall works after removal', () => {
  const cwd = init(root, 'prerequisites', env);
  invoke(cwd, env, ['hooks', 'install'], 2);
  assert.equal(existsSync(join(cwd, 'package.json')), false);
  const entry = install(cwd);
  invoke(cwd, env, ['hooks', 'install'], 0, entry);
  const packageRoot = join(cwd, 'node_modules', 'committide');
  renameSync(packageRoot, `${packageRoot}-missing`);
  const rejected = git(cwd, env, ['commit', '--allow-empty', '-m', 'fix: cannot bypass'], 1);
  assert.match(rejected.stderr, /local dependency is missing/);
  invoke(cwd, env, ['hooks', 'uninstall']);
  renameSync(`${packageRoot}-missing`, packageRoot);
  const lock = join(cwd, 'package-lock.json');
  const original = readFileSync(lock);
  const changed = JSON.parse(original);
  changed.packages['node_modules/committide'].version = '999.0.0';
  writeFileSync(lock, JSON.stringify(changed));
  invoke(cwd, env, ['hooks', 'install'], 2, entry);
  assert.equal(existsSync(hookAt(cwd)), false);
  writeFileSync(lock, original);
  invoke(cwd, env, ['hooks', 'install'], 0, entry);
  const gitBinary = process.platform === 'win32'
    ? run('where.exe', ['git'], cwd, env).stdout.trim().split(/\r?\n/)[0]
    : run('which', ['git'], cwd, env).stdout.trim();
  const emptyPath = join(cwd, 'empty runtime path');
  mkdirSync(emptyPath);
  const noNode = { ...env, PATH: emptyPath };
  assert.match(run(gitBinary, ['commit', '--allow-empty', '-m', 'fix: no runtime'], cwd, noNode, 1).stderr, /Node.js.*required/);
});

test('bare repositories refuse installation and locks prevent concurrent ownership changes', () => {
  const bare = join(root, 'bare.git');
  git(root, env, ['init', '--bare', bare]);
  assert.match(invoke(bare, env, ['hooks', 'install'], 2).stderr, /non-bare/);
  const cwd = init(root, 'busy', env);
  const entry = install(cwd);
  const guard = join(cwd, '.git', 'hooks', '.committide-lock');
  mkdirSync(guard);
  assert.match(invoke(cwd, env, ['hooks', 'install'], 2, entry).stderr, /hook-busy/);
  assert.equal(existsSync(hookAt(cwd)), false);
});

test('linked worktree gitfile uses shared common hooks and its own local dependency/config', () => {
  const cwd = init(root, 'worktree main', env);
  const base = commit(cwd, env, 'chore: base');
  const linked = join(root, 'linked worktree');
  git(cwd, env, ['worktree', 'add', '--detach', linked, base]);
  assert.ok(statSync(join(linked, '.git')).isFile());
  const entry = install(linked);
  mkdirSync(join(linked, 'nested'));
  invoke(join(linked, 'nested'), env, ['hooks', 'install'], 0, entry);
  assert.ok(existsSync(hookAt(cwd)));
  writeFileSync(join(linked, 'committide.config.json'), '{"extendTypes":["release"]}');
  git(linked, env, ['commit', '--allow-empty', '-m', 'release: linked worktree']);
  assert.equal(invoke(linked, env, ['check', '--from', base, '--to', 'HEAD'], 0, entry).stdout, 'Checked 1; failed 0; skipped 0.\n');
  invoke(linked, env, ['hooks', 'uninstall'], 0, entry);
  assert.equal(existsSync(hookAt(cwd)), false);
});

test('real merge and revert operations follow strict policy; bypassed history is rejected', () => {
  const cwd = init(root, 'merge revert', env);
  const entry = install(cwd);
  const base = commit(cwd, env, 'chore: base');
  invoke(cwd, env, ['hooks', 'install'], 0, entry);
  git(cwd, env, ['checkout', '-b', 'side']);
  git(cwd, env, ['commit', '--allow-empty', '-m', 'feat: side']);
  git(cwd, env, ['checkout', 'main']);
  git(cwd, env, ['commit', '--allow-empty', '-m', 'fix: main']);
  const merge = git(cwd, env, ['merge', '--no-ff', '--no-edit', 'side'], 1);
  assert.match(merge.stderr, /header-format/);
  git(cwd, env, ['commit', '-m', 'chore: merge side']);
  invoke(cwd, env, ['check', '--from', base, '--to', 'HEAD'], 0, entry);
  change(cwd, env, 'target.txt', 'revert this\n');
  git(cwd, env, ['commit', '-m', 'feat: target']);
  const beforeRevert = git(cwd, env, ['rev-parse', 'HEAD']).stdout.trim();
  // The observed Git sequencer bypasses commit-msg for its default revert.
  git(cwd, env, ['revert', '--no-edit', 'HEAD']);
  assert.match(git(cwd, env, ['log', '-1', '--format=%s']).stdout, /^Revert /);
  invoke(cwd, env, ['check', '--from', beforeRevert, '--to', 'HEAD'], 1, entry);
  git(cwd, env, ['revert', '--no-commit', 'HEAD']);
  git(cwd, env, ['commit', '-m', 'revert: restore target']);
  invoke(cwd, env, ['check', '--from', 'HEAD~1', '--to', 'HEAD'], 0, entry);
  git(cwd, env, ['commit', '--allow-empty', '--no-verify', '-m', 'Merge arbitrary malformed text']);
  invoke(cwd, env, ['check', '--from', 'HEAD~1', '--to', 'HEAD'], 1, entry);
});

test('fixup/squash commits require explicit bypass; actual autosquash produces checked final history', () => {
  const cwd = init(root, 'autosquash', env);
  const entry = install(cwd);
  const base = commit(cwd, env, 'chore: base');
  invoke(cwd, env, ['hooks', 'install'], 0, entry);
  change(cwd, env, 'feature.txt', 'one\n');
  git(cwd, env, ['commit', '-m', 'feat: feature']);
  const target = git(cwd, env, ['rev-parse', 'HEAD']).stdout.trim();
  change(cwd, env, 'feature.txt', 'two\n');
  assert.match(git(cwd, env, ['commit', '--fixup', target], 1).stderr, /header-format/);
  git(cwd, env, ['commit', '--no-verify', '--fixup', target]);
  invoke(cwd, env, ['check', '--from', base, '--to', 'HEAD'], 1, entry);
  git(cwd, env, ['rebase', '-i', '--autosquash', base]);
  invoke(cwd, env, ['check', '--from', base, '--to', 'HEAD'], 0, entry);
  const newTarget = git(cwd, env, ['rev-parse', 'HEAD']).stdout.trim();
  change(cwd, env, 'feature.txt', 'three\n');
  assert.match(git(cwd, env, ['commit', '--squash', newTarget], 1).stderr, /header-format/);
  git(cwd, env, ['commit', '--no-verify', '--squash', newTarget]);
  invoke(cwd, env, ['check', '--from', base, '--to', 'HEAD'], 1, entry);
  git(cwd, env, ['rebase', '-i', '--autosquash', base]);
  invoke(cwd, env, ['check', '--from', base, '--to', 'HEAD'], 0, entry);
  assert.equal(git(cwd, env, ['rev-list', '--count', `${base}..HEAD`]).stdout.trim(), '1');
});
