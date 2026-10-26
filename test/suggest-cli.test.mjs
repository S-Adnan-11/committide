import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { environment, init, change, cli, invoke } from './git-helpers.mjs';
import { interact } from './terminal-helpers.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'committide-suggest-cli-')));
const env = { ...environment(root), GROQ_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential', ANTHROPIC_API_KEY: 'fixture-not-a-credential' };
after(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
function fixture() {
  const cwd = init(root, `terminal ${count++}`, env);
  change(cwd, env, 'example.txt', 'staged\n');
  return cwd;
}
const short = [
  { prompt: 'Staged review:', answer: 'continue' },
  { prompt: 'Type (e.g.', answer: 'feat' },
  { prompt: 'Scope (optional', answer: '' },
  { prompt: 'Description (required', answer: 'add example' },
  { prompt: 'Review: accept', answer: 'accept' },
];

test('interactive executable separates review stderr from accepted stdout and saves only after acceptance', async () => {
  const cwd = fixture();
  const steps = [...short]; steps.args = ['--output', 'message.txt'];
  const result = await interact(cli, cwd, env, steps);
  assert.equal(result.stdout, 'feat: add example\n');
  assert.match(result.stderr, /Draft for the reviewed staged set/);
  assert.equal(readFileSync(join(cwd, 'message.txt'), 'utf8'), result.stdout);
  invoke(cwd, env, ['lint', '--file', 'message.txt']);
});

for (const answer of [null, '\x03', '/cancel']) {
  test(`interactive stream cancellation ${JSON.stringify(answer)} returns 130 without output or file`, async () => {
    const cwd = fixture();
    const before = readFileSync(join(cwd, '.git', 'index'));
    const steps = [{ prompt: 'Staged review:', answer }]; steps.args = ['--output', 'no-message'];
    const result = await interact(cli, cwd, env, steps, 130);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(join(cwd, 'no-message')), false);
    assert.deepEqual(readFileSync(join(cwd, '.git', 'index')), before);
    assert.match(result.stderr, /Cancelled/);
  });
}

test('interactive executable reports missing repository/Git/config without success output', async () => {
  const outside = await interact(cli, root, env, [], 2);
  assert.equal(outside.stdout, ''); assert.match(outside.stderr, /git-repository/);
  const missing = await interact(cli, root, { ...env, PATH: '' }, [], 2);
  assert.equal(missing.stdout, ''); assert.match(missing.stderr, /git-missing/);
  const cwd = fixture();
  writeFileSync(join(cwd, 'committide.config.json'), '{');
  const bad = await interact(cli, cwd, env, [], 2);
  assert.equal(bad.stdout, ''); assert.match(bad.stderr, /config-json/);
});
