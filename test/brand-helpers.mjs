import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

const tagline = 'Good commits. Clear history.';
const full = '#%%%%%%%%%%%%%%%%%%%%%%%%%%%%+    :%%%%%%%%%%%%%%%%#';
const compact = '+####################%#   -%###########+';
const clean = text => {
  assert.doesNotMatch(text, /CommitTide|Good commits|\*{5}|%{5}|#{5}|\x1b/);
};

// These deterministic executable checks simulate stream properties, not a PTY.
// Reused against the archive installation to catch missing compiled branding data.
export function verifyHelpBranding(entry, cwd) {
  function run(args, { out = true, err = false, columns = 80, env: additions = {} } = {}) {
    const setup = `Object.defineProperty(process.stdout,'isTTY',{value:${out}});Object.defineProperty(process.stderr,'isTTY',{value:${err}});Object.defineProperty(process.stdout,'columns',{value:${JSON.stringify(columns)}});`;
    const env = { ...process.env, TERM: 'xterm-256color' };
    for (const key of ['CI', 'NO_COLOR', 'FORCE_COLOR', 'NODE_DISABLE_COLORS']) delete env[key];
    Object.assign(env, additions);
    const r = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(setup), entry, ...args], {
      cwd, env, input: '', encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.ifError(r.error);
    return r;
  }
  for (const args of [['--help'], ['-h'], ['help']]) {
    const r = run(args);
    assert.equal(r.status, 0); assert.equal(r.stderr, '');
    assert.match(r.stdout, /\x1b\[36m/);
    const text = stripVTControlCharacters(r.stdout);
    assert.ok(text.includes('  ' + full)); assert.ok(text.includes(tagline));
    assert.match(text, /CommitTide\nGood commits\. Clear history\.\n\nUsage: committide/);
  }
  for (const columns of [44, 55, 56]) {
    const r = run(['--help'], { columns, env: { NO_COLOR: '1', FORCE_COLOR: '1' } });
    assert.equal(r.status, 0); assert.doesNotMatch(r.stdout, /\x1b/);
    assert.ok(r.stdout.includes(columns >= 56 ? full : compact));
    assert.ok(!r.stdout.includes(columns >= 56 ? compact : full));
  }
  for (const env of [{ NO_COLOR: '0', FORCE_COLOR: '3' }, { FORCE_COLOR: '0' }]) {
    const r = run(['--help'], { env });
    assert.ok(r.stdout.includes(full)); assert.doesNotMatch(r.stdout, /\x1b/);
  }
  for (const columns of [43, 27, null]) {
    const text = stripVTControlCharacters(run(['--help'], { columns }).stdout);
    assert.ok(text.startsWith('CommitTide\n')); assert.doesNotMatch(text, /\*{5}|%{5}|#{5}/);
    assert.equal(text.includes(tagline), columns === 43);
  }
  for (const options of [
    { out: false, err: true, env: { FORCE_COLOR: '3' } },
    { env: { TERM: 'dumb', FORCE_COLOR: '1' } },
    { env: { CI: 'true', FORCE_COLOR: '1' } },
  ]) {
    const r = run(['--help'], options);
    assert.equal(r.status, 0); clean(r.stdout); assert.equal(r.stderr, '');
    assert.match(r.stdout, /^Usage: committide/);
  }
  for (const args of [[], ['lint', '--help'], ['help', 'suggest'], ['hooks', '--help']]) {
    const r = run(args, { env: { NO_COLOR: '1' } });
    assert.equal(r.status, 0); clean(r.stdout); clean(r.stderr);
  }
  for (const args of [['--unknown'], ['unknown'], ['lint', '--unknown']]) {
    const r = run(args, { err: true, env: { NO_COLOR: '1' } });
    assert.equal(r.status, 2); assert.equal(r.stdout, ''); clean(r.stderr);
  }
  const version = run(['--version']);
  assert.equal(version.stdout, '0.1.0\n'); assert.equal(version.stderr, '');
  const valid = run(['lint', '--message', 'feat(forecast): add tide times']);
  assert.equal(valid.status, 0); assert.equal(valid.stdout, 'Message is valid.\n'); assert.equal(valid.stderr, '');
  const invalid = run(['lint', '--message', 'updated stuff']);
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); clean(invalid.stderr);
  assert.equal(invalid.stderr, 'error [header-format] line 1: Use type(scope)!: description; scope and ! are optional, and the description must be nonempty.\n');
  const suggest = run(['suggest']);
  assert.equal(suggest.status, 2); assert.equal(suggest.stdout, ''); clean(suggest.stderr);
}
