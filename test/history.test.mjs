import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { environment, init, git, invoke, commit, change, run, cli } from './git-helpers.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'committide-history-')));
const env = environment(root);
after(() => rmSync(root, { recursive: true, force: true }));

test('two-dot reachability excludes source and includes full multiline destination messages', () => {
  const cwd = init(root, 'history with spaces', env);
  const base = commit(cwd, env, 'bad source excluded');
  commit(cwd, env, 'feat(API)!: First\n\nBody\nsecond line\n\nReviewed-by: A\nBREAKING-CHANGE: Migrate\nDetails');
  const to = commit(cwd, env, 'FIX: Second');
  const args = ['check', '--from', base, '--to', to];
  assert.equal(invoke(cwd, env, args).stdout, 'Checked 2; failed 0; skipped 0.\n');
  assert.equal(invoke(cwd, env, ['check', '--from', to, '--to', to]).stdout, 'Empty range. Checked 0; failed 0; skipped 0.\n');
  git(cwd, env, ['tag', '-a', 'release', '-m', 'release', to]);
  mkdirSync(join(cwd, 'nested'));
  assert.equal(invoke(join(cwd, 'nested'), env, ['check', '--from', 'HEAD~2', '--to', 'release']).stdout, 'Checked 2; failed 0; skipped 0.\n');
  git(cwd, env, ['checkout', '--detach', to]);
  assert.equal(invoke(cwd, env, args).status, 0);
});

test('reports every rule failure and fails complete malformed bodies, without exposing messages', () => {
  const cwd = init(root, 'failures', env);
  const base = commit(cwd, env, 'chore: root');
  const first = commit(cwd, env, 'secret malformed subject');
  const second = commit(cwd, env, 'fix: valid header\nmissing blank');
  const result = invoke(cwd, env, ['check', '--from', base, '--to', 'HEAD'], 1);
  assert.equal(result.stdout, 'Checked 2; failed 2; skipped 0.\n');
  assert.ok(result.stderr.includes(first));
  assert.ok(result.stderr.includes(second));
  assert.match(result.stderr, /header-format/);
  assert.match(result.stderr, /header-blank-line/);
  assert.ok(!result.stderr.includes('secret malformed subject'));
});

test('nonancestor branches and merged side history use reachability, with strict merge policy', () => {
  const cwd = init(root, 'branches', env);
  const base = commit(cwd, env, 'chore: base');
  git(cwd, env, ['checkout', '-b', 'side']);
  commit(cwd, env, 'feat: side');
  git(cwd, env, ['checkout', 'main']);
  commit(cwd, env, 'fix: main');
  assert.equal(invoke(cwd, env, ['check', '--from', 'side', '--to', 'main']).stdout, 'Checked 1; failed 0; skipped 0.\n');
  git(cwd, env, ['merge', '--no-ff', 'side', '-m', 'Merge branch side']);
  assert.equal(invoke(cwd, env, ['check', '--from', base, '--to', 'HEAD'], 1).stdout, 'Checked 3; failed 1; skipped 0.\n');
});

test('configuration is current and explicit; check preserves dirty index/worktree/config', () => {
  const cwd = init(root, 'configuration', env);
  const base = commit(cwd, env, 'chore: base');
  commit(cwd, env, 'release: prepare\n\nBREAKING CHANGE: Migrate');
  invoke(cwd, env, ['check', '--from', base, '--to', 'HEAD'], 1);
  writeFileSync(join(cwd, 'committide.config.json'), '{"extendTypes":["release"]}');
  change(cwd, env, 'staged.txt', 'staged\n');
  writeFileSync(join(cwd, 'staged.txt'), 'unstaged\n');
  const before = git(cwd, env, ['status', '--porcelain=v1', '-z']).stdout;
  const index = readFileSync(join(cwd, '.git', 'index'));
  const config = readFileSync(join(cwd, '.git', 'config'));
  invoke(cwd, env, ['check', '--from', base, '--to', 'HEAD']);
  assert.equal(git(cwd, env, ['status', '--porcelain=v1', '-z']).stdout, before);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'index')), index);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'config')), config);
  assert.equal(readFileSync(join(cwd, 'staged.txt'), 'utf8'), 'unstaged\n');
  const explicit = join(cwd, 'custom config.json');
  writeFileSync(explicit, '{"allowedTypes":["fix"]}');
  invoke(cwd, env, ['--config', explicit, 'check', '--from', base, '--to', 'HEAD'], 1);
  writeFileSync(explicit, '{"unknown":true}');
  assert.match(invoke(cwd, env, ['check', '--config', explicit, '--from', base, '--to', 'HEAD'], 2).stderr, /config-unknown/);
});

test('single ref validation rejects invalid, option-like, range, ambiguous, and noncommit boundaries', () => {
  const cwd = init(root, 'references', env);
  commit(cwd, env, 'fix: root');
  const blob = git(cwd, env, ['hash-object', '-w', '--stdin'], 0, 'blob').stdout.trim();
  for (const ref of ['missing', '--all', 'HEAD..HEAD', 'HEAD^@', 'HEAD^!', 'HEAD^-', 'HEAD HEAD', blob]) {
    const result = invoke(cwd, env, ['check', `--from=${ref}`, '--to', 'HEAD'], 2);
    assert.match(result.stderr, /git-ref/);
    assert.equal(result.stdout, '');
  }
  git(cwd, env, ['branch', 'ambiguous']);
  git(cwd, env, ['tag', 'ambiguous']);
  assert.match(invoke(cwd, env, ['check', '--from', 'ambiguous', '--to', 'HEAD'], 2).stderr, /git-ref/);
});

test('unborn/outside/missing Git and shallow history are operational errors', () => {
  const empty = init(root, 'empty', env);
  invoke(empty, env, ['check', '--from', 'HEAD', '--to', 'HEAD'], 2);
  assert.match(invoke(root, env, ['check', '--from', 'HEAD', '--to', 'HEAD'], 2).stderr, /git-repository/);
  assert.match(run(process.execPath, [cli, 'check', '--from', 'HEAD', '--to', 'HEAD'], root, { ...env, PATH: '' }, 2).stderr, /git-missing/);
  const source = init(root, 'shallow source', env);
  commit(source, env, 'chore: first');
  commit(source, env, 'fix: second');
  const clone = join(root, 'shallow clone');
  git(root, env, ['clone', '--depth=1', `file://${source.replace(/\\/g, '/')}`, clone]);
  assert.match(invoke(clone, env, ['check', '--from', 'HEAD', '--to', 'HEAD'], 2).stderr, /git-shallow.*fetch-depth/);
});

test('missing reachable objects fail instead of reporting complete history', () => {
  const cwd = init(root, 'missing object', env);
  const base = commit(cwd, env, 'chore: base');
  const missing = commit(cwd, env, 'fix: middle');
  commit(cwd, env, 'fix: top');
  rmSync(join(cwd, '.git', 'objects', missing.slice(0, 2), missing.slice(2)));
  assert.match(invoke(cwd, env, ['check', '--from', base, '--to', 'HEAD'], 2).stderr, /git-operation/);
});
