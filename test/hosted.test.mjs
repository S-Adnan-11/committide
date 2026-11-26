import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCommitState } from '../dist/commit-state.js';
import { offerHostedDraft } from '../dist/hosted.js';
import { composeCommit } from '../dist/commit.js';
import { environment, init, change, commit, git } from './git-helpers.mjs';
import { responseData } from './hosted-worker-helpers.mjs';
import { outgoingPreview } from './commit-ai-helpers.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'committide-hosted-'))), env = environment(root);
Object.assign(process.env, env);
after(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
function fixture() { const cwd = init(root, 'repo-' + serial++, env); change(cwd, env, 'README.md', 'staged\n'); return cwd; }
function session(answers, before = () => {}) {
  const review = [];
  return { review, io: { check() {}, review: text => review.push(text), async ask(prompt) {
    await before(prompt); assert.ok(answers.length, prompt); return answers.shift();
  } } };
}
const reply = () => Response.json(responseData());

test('conflicting provider flags refuse before repository access or transport', async () => {
  await assert.rejects(composeCommit('not-a-repository', { ai: true, hosted: true }, {}, { transport() { assert.fail(); } }), { rule: 'commit-provider' });
});
test('hosted consent previews exactly the bytes passed to one anonymous transport', async () => {
  const cwd = fixture(), state = await captureCommitState(cwd), s = session(['Document setup', 'send']);
  let calls = 0;
  const result = await offerHostedDraft(cwd, state, undefined, s.io, { transport: async (url, options) => {
    calls++; assert.equal(options.body, outgoingPreview(s.review.join('')));
    assert.equal(url, 'https://draft.committide.invalid/v1/draft');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' }); assert.equal(options.credentials, 'omit');
    return reply();
  } });
  assert.equal(result.kind, 'draft'); assert.equal(calls, 1);
  assert.equal(git(cwd, env, ['rev-parse', '--verify', '--quiet', 'HEAD'], null).status, 1);
});
test('each new hosted request requires a fresh send; blank/unknown/local declines', async () => {
  for (const answer of ['', 'yes', 'local']) {
    const cwd = fixture(), state = await captureCommitState(cwd), s = session(['', answer]);
    assert.equal((await offerHostedDraft(cwd, state, undefined, s.io, { transport() { assert.fail(); } })).kind, 'local');
  }
});
for (const boundary of ['send', 'reply']) for (const mutation of ['index', 'head', 'branch', 'policy']) {
  test('hosted discards stale ' + mutation + ' at ' + boundary, async () => {
    const cwd = fixture(), state = await captureCommitState(cwd);
    const mutate = () => {
      if (mutation === 'index') change(cwd, env, 'README.md', 'new staged\n');
      if (mutation === 'head') commit(cwd, env, 'docs: another writer');
      if (mutation === 'branch') git(cwd, env, ['symbolic-ref', 'HEAD', 'refs/heads/other']);
      if (mutation === 'policy') writeFileSync(join(cwd, 'committide.config.json'), '{"allowedTypes":["custom"]}');
    };
    const s = session(['', 'send'], prompt => { if (boundary === 'send' && prompt.startsWith('Hosted choice:')) mutate(); });
    let calls = 0;
    const result = await offerHostedDraft(cwd, state, undefined, s.io, { transport: async () => { calls++; mutate(); return reply(); } });
    assert.equal(result.kind, 'stale'); assert.equal(calls, boundary === 'send' ? 0 : 1);
  });
}
test('hosted failure during a later offer retains the existing edited draft', async () => {
  const cwd = fixture();
  const s = session(['continue', '', 'local', 'edit', 'description', 'keep my words', 'hosted', '', 'send', 'commit']);
  const result = await composeCommit(cwd, { hosted: true }, s.io, { transport: async () => Response.json({}, { status: 503 }) });
  assert.equal(result.status, 'committed');
  assert.equal(git(cwd, env, ['log', '-1', '--format=%s']).stdout.trim(), 'docs: keep my words');
});
test('unsupported provider reply, oversized streamed body and media mismatch return to offline drafting', async () => {
  for (const transport of [async () => Response.json({}), async () => new Response('x'.repeat(4097), { headers: { 'content-type': 'application/json' } }),
    async () => new Response('private raw detail', { headers: { 'content-type': 'text/html' } })]) {
    const cwd = fixture(), state = await captureCommitState(cwd), s = session(['', 'send']);
    assert.equal((await offerHostedDraft(cwd, state, undefined, s.io, { transport })).kind, 'local');
    assert.doesNotMatch(s.review.join(''), /private raw detail/);
  }
});
