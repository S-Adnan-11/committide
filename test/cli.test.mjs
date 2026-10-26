import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'committide-cli-')));
after(() => rmSync(root, { recursive: true, force: true }));
const run = (args, options = {}) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, input: '', encoding: 'utf8', timeout: 5000, ...options,
  });
  assert.ifError(result.error);
  return result;
};

for (const args of [[], ['--help'], ['lint', '--help'], ['--version']]) {
  test(`help/version ${args.join(' ')} exits cleanly`, () => {
    const result = run(args);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.length);
    assert.equal(result.stderr, '');
  });
}

test('version matches package metadata', () => assert.equal(run(['--version']).stdout, '0.1.0\n'));

for (const [name, args, input] of [
  ['message', ['lint', '--message', 'FEAT(scope)!: Add café'], ''],
  ['stdin', ['lint'], 'fix: Correct error\n\nRefs: #12\n'],
  ['stdin CRLF', ['lint'], 'fix: Correct error\r\n\r\nBody\r\n'],
]) {
  test(`valid ${name} works outside Git`, () => {
    const result = run(args, { input });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'Message is valid.\n');
    assert.equal(result.stderr, '');
  });
}

test('UTF-8 file paths containing spaces work', () => {
  const path = join(root, 'commit message.txt');
  writeFileSync(path, 'fix(日本語): 修正\r\n\r\nDetails\r\nRefs: #1\r\n');
  const result = run(['lint', '--file', path]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

for (const [args, input] of [
  [['lint', '--message', 'wrong'], ''],
  [['lint', '--message', ''], ''],
  [['lint'], '\n'],
  [['lint', '--message', 'custom: not configured'], ''],
  [['lint', '--message', 'fix: x\nbody'], ''],
  [['lint', '--message', 'fix: x\n\nBREAKING CHANGE:x'], ''],
]) {
  test(`lint rejection exits 1: ${JSON.stringify(args)}, ${JSON.stringify(input)}`, () => {
    const result = run(args, { input });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /error \[[a-z-]+\].*(?:line 1|line 2|line 3)/);
  });
}

for (const [args, input] of [
  [['lint'], ''],
  [['lint', '--message', 'fix: x', '--file', 'any'], ''],
  [['lint', '--message', 'fix: x'], 'fix: piped'],
  [['lint', '--file', 'any'], 'fix: piped'],
  [['lint', '--file', 'does-not-exist'], ''],
  [['lint', '--file', root], ''],
  [['lint', '--message'], ''],
  [['lint', '--unknown'], ''],
  [['unknown'], ''],
  [['lint', 'extra'], ''],
]) {
  test(`usage/input error exits 2: ${JSON.stringify(args)}`, () => {
    const result = run(args, { input });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.length);
  });
}

test('interactive input-source guard does not read stdin', () => {
  // Simulate the terminal flag inside the real executable process without a PTY dependency.
  const bootstrap = 'data:text/javascript,Object.defineProperty(process.stdin,"isTTY",{value:true})';
  const result = spawnSync(process.execPath, ['--import', bootstrap, cli, 'lint'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /input-source/);
});

test('explicit config overrides discovery; malformed and unknown config fail', () => {
  const project = join(root, 'configured');
  mkdirSync(project);
  writeFileSync(join(project, 'committide.config.json'), '{"extendTypes":["release"]}');
  assert.equal(run(['lint', '--message', 'release: prepare'], { cwd: project }).status, 0);
  const explicit = join(project, 'custom config.json');
  writeFileSync(explicit, '{"allowedTypes":["CUSTOM"],"extendTypes":["修正"]}');
  for (const args of [
    ['--config', explicit, 'lint', '--message', 'custom: pass'],
    ['lint', '--config', explicit, '--message', '修正: pass'],
  ]) assert.equal(run(args).status, 0);
  assert.equal(run(['lint', '--config', explicit, '--message', 'feat: rejected']).status, 1);
  for (const content of ['{', '{"typo":true}', '{"allowedTypes":[]}', 'null', '{"extendTypes":"release"}']) {
    writeFileSync(explicit, content);
    const result = run(['lint', '--config', explicit, '--message', 'fix: valid']);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /error \[config-/);
    assert.ok(result.stderr.includes(explicit));
  }
  assert.equal(run(['lint', '--config', 'missing.json', '--message', 'fix: valid']).status, 2);
});

test('discovery uses nearest config and stops at package or Git/worktree boundaries', () => {
  const parent = join(root, 'discovery');
  const project = join(parent, 'project');
  const child = join(project, 'src', 'nested');
  mkdirSync(child, { recursive: true });
  writeFileSync(join(parent, 'committide.config.json'), '{"allowedTypes":["parent"]}');
  for (const marker of ['package.json', '.git']) {
    writeFileSync(join(project, marker), marker === '.git' ? 'gitdir: elsewhere' : '{}');
    assert.equal(run(['lint', '--message', 'feat: defaults'], { cwd: child }).status, 0);
    assert.equal(run(['lint', '--message', 'parent: unrelated'], { cwd: child }).status, 1);
    rmSync(join(project, marker));
  }
  mkdirSync(join(project, '.git'));
  writeFileSync(join(project, 'committide.config.json'), '{"extendTypes":["release"]}');
  assert.equal(run(['lint', '--message', 'release: inherited'], { cwd: child }).status, 0);
  writeFileSync(join(child, 'committide.config.json'), '{"allowedTypes":["nested"]}');
  assert.equal(run(['lint', '--message', 'nested: nearest'], { cwd: child }).status, 0);
  assert.equal(run(['lint', '--message', 'release: shadowed'], { cwd: child }).status, 1);
});
