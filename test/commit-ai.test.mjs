import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { captureCommitState } from '../dist/commit-state.js';
import { commitContext } from '../dist/commit-context.js';
import { composeCommit } from '../dist/commit.js';
import { offerCommitDraft } from '../dist/commit-ai.js';
import { CommitCancelled } from '../dist/suggest-io.js';
import { environment, init, change, commit, git } from './git-helpers.mjs';
import { aiDraft, outgoingPreview } from './commit-ai-helpers.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'committide-commit-ai-'))), env = environment(root);
Object.assign(process.env, env);
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function fixture() {
  const cwd = init(root, `repo ${counter++}`, env);
  change(cwd, env, 'README.md', 'staged guide\n');
  writeFileSync(join(cwd, 'README.md'), 'unstaged marker\n');
  writeFileSync(join(cwd, 'scratch.txt'), 'untracked marker\n');
  return cwd;
}
const head = cwd => git(cwd, env, ['rev-parse', '--verify', '--quiet', 'HEAD'], null).stdout.trim();
function scripted(answers, before = () => {}) {
  const reviews = [], prompts = [];
  return { reviews, prompts, io: { review(text) { reviews.push(text); }, check() {}, async ask(prompt) {
    prompts.push(prompt); await before(prompt, prompts.length); assert.ok(answers.length, `No answer for ${prompt}\n${reviews.join('')}`);
    const next = answers.shift(); if (next instanceof Error) throw next; return next;
  } } };
}
function injected(onCall = () => {}, draft = aiDraft) {
  let calls = 0;
  const transport = async (url, options) => {
    calls++; assert.equal(calls, 1); assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-commit-ai'); await onCall(options.body, options);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }] });
  };
  return { transport, count: () => calls };
}
async function fakeKey(action, absent = false) {
  const previous = process.env.GROQ_API_KEY;
  if (absent) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = 'synthetic-commit-ai';
  try { return await action(); } finally { if (previous === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previous; }
}

test('context is index-only metadata by default; selected literal paths include complete staged hunks only', async () => {
  const cwd = fixture(); const state = await captureCommitState(cwd);
  const metadata = JSON.parse(await commitContext(cwd, state, 'Document setup'));
  assert.deepEqual(metadata.staged.entries, [{ status: 'A', path: 'README.md', kind: 'text', additions: 1, deletions: 0 }]);
  assert.equal(metadata.hunks, undefined);
  assert.doesNotMatch(JSON.stringify(metadata), /staged guide|unstaged marker|untracked marker|scratch|refs\/heads/);
  const selected = JSON.parse(await commitContext(cwd, state, '', [0]));
  assert.match(selected.hunks[0].patch, /\+staged guide/);
  assert.doesNotMatch(JSON.stringify(selected), /unstaged marker|untracked marker/);
  await assert.rejects(commitContext(cwd, state, '', [0, 0]), { code: 'request' });
  await assert.rejects(commitContext(cwd, state, '', [-1]), { code: 'request' });
});

test('rename, binary, symlink and gitlink metadata/counts are grounded in Git objects', async () => {
  const cwd = fixture(); const base = commit(cwd, env, 'docs: base');
  git(cwd, env, ['mv', 'README.md', 'guide.md']);
  // Keep the rename content identical to the committed staged object.
  git(cwd, env, ['restore', '--worktree', '--', 'guide.md']);
  change(cwd, env, 'picture.bin', Buffer.from([0, 1, 2]));
  const blob = git(cwd, env, ['hash-object', '-w', '--stdin'], 0, '../not-followed').stdout.trim();
  git(cwd, env, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  git(cwd, env, ['update-index', '--add', '--cacheinfo', `160000,${base},module`]);
  const state = await captureCommitState(cwd), data = JSON.parse(await commitContext(cwd, state, ''));
  assert.ok(data.staged.entries.some(entry => entry.status === 'R' && entry.previousPath === 'README.md' && entry.path === 'guide.md'));
  for (const kind of ['binary', 'symlink', 'submodule']) {
    const entry = data.staged.entries.find(entry => entry.kind === kind); assert.ok(entry); assert.equal(entry.additions, null); assert.equal(entry.deletions, null);
    const index = data.staged.entries.indexOf(entry); await assert.rejects(commitContext(cwd, state, '', [index]), { code: 'request' });
  }
});

test('declining disclosure leaves offline composition and never invokes the provider', async () => fakeKey(async () => {
  const cwd = fixture(); const session = scripted(['continue', 'metadata', '', 'local', 'commit']);
  const mock = injected(() => assert.fail('No request permitted'));
  const result = await composeCommit(cwd, { ai: true }, session.io, mock);
  assert.equal(mock.count(), 0); assert.equal(result.status, 'committed');
  assert.equal(git(cwd, env, ['log', '-1', '--format=%s']).stdout.trim(), 'docs: add README.md');
  assert.ok(outgoingPreview(session.reviews.join(''))); assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'unstaged marker\n');
}));

test('approved payload equals its whole preview; AI cannot commit before the ordinary final confirmation', async () => fakeKey(async () => {
  const cwd = fixture(); const session = scripted(['continue', 'metadata', 'Explain setup', 'send', '', 'edit', 'description', 'explain setup steps', 'commit'], prompt => {
    if (prompt.startsWith('Review:')) assert.equal(head(cwd), '');
  });
  const mock = injected(body => {
    assert.equal(body, outgoingPreview(session.reviews.join('')));
    const context = JSON.parse(JSON.parse(body).messages[1].content).untrusted_staged_context;
    assert.equal(context.hunks, undefined); assert.equal(context.intent, 'Explain setup');
    assert.doesNotMatch(body, /staged guide|unstaged marker|scratch|untracked marker/);
  });
  const result = await composeCommit(cwd, { ai: true }, session.io, mock);
  assert.equal(result.status, 'committed'); assert.equal(mock.count(), 1);
  assert.equal(git(cwd, env, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
  assert.equal(git(cwd, env, ['log', '-1', '--format=%s']).stdout.trim(), 'docs: explain setup steps');
  assert.deepEqual(git(cwd, env, ['ls-tree', '--name-only', 'HEAD']).stdout.trim().split('\n'), ['README.md']);
  assert.match(git(cwd, env, ['status', '--short']).stdout, /\?\? scratch.txt/);
  assert.doesNotMatch(session.reviews.join(''), /synthetic-commit-ai/);
}));

test('selected staged file hunks require a separate context choice and match the preview', async () => fakeKey(async () => {
  const cwd = fixture(); const state = await captureCommitState(cwd);
  const session = scripted(['hunks', '', '1', 'send']);
  const mock = injected(body => {
    assert.equal(body, outgoingPreview(session.reviews.join('')));
    const context = JSON.parse(JSON.parse(body).messages[1].content).untrusted_staged_context;
    assert.match(context.hunks[0].patch, /\+staged guide/); assert.doesNotMatch(body, /unstaged marker|untracked marker/);
  });
  const result = await offerCommitDraft(cwd, state, undefined, session.io, mock);
  assert.equal(result.kind, 'draft'); assert.equal(head(cwd), ''); assert.equal(mock.count(), 1);
}));

test('missing credentials keeps the developer offline without a fetch or retry', async () => fakeKey(async () => {
  const cwd = fixture(); const session = scripted(['continue', 'metadata', '', 'send', 'commit']); const mock = injected();
  assert.equal((await composeCommit(cwd, { ai: true }, session.io, mock)).status, 'committed');
  assert.equal(mock.count(), 0); assert.match(session.reviews.join(''), /credentials are unavailable/);
}, true));

for (const kind of ['index', 'head', 'branch', 'policy']) {
  test(`changed ${kind} at send invalidates disclosure without a request or automatic retry`, async () => fakeKey(async () => {
    const cwd = fixture(); let changed = false;
    const session = scripted(['continue', 'metadata', '', 'send', ...(kind === 'policy' ? ['release', '', 'describe changed staged set'] : []), 'cancel'], prompt => {
      if (!prompt.startsWith('Groq choice:') || changed) return; changed = true;
      if (kind === 'index') change(cwd, env, 'README.md', 'new staged set\n');
      if (kind === 'head') { commit(cwd, env, 'docs: concurrent change'); change(cwd, env, 'README.md', 'new staged set\n'); }
      if (kind === 'branch') git(cwd, env, ['symbolic-ref', 'HEAD', 'refs/heads/other']);
      if (kind === 'policy') writeFileSync(join(cwd, 'committide.config.json'), '{"allowedTypes":["release"]}');
    });
    const mock = injected(); await assert.rejects(composeCommit(cwd, { ai: true }, session.io, mock), CommitCancelled);
    assert.equal(mock.count(), 0); assert.match(session.reviews.join(''), /Previous draft and confirmation are discarded/);
  }));
}

test('a reply for a changed snapshot is discarded before reaching draft review', async () => fakeKey(async () => {
  const cwd = fixture(); const session = scripted(['continue', 'metadata', '', 'send', 'cancel']);
  const mock = injected(() => change(cwd, env, 'README.md', 'new staged content\n'), { ...aiDraft, description: 'stale model phrase' });
  await assert.rejects(composeCommit(cwd, { ai: true }, session.io, mock), CommitCancelled);
  assert.equal(mock.count(), 1); assert.doesNotMatch(session.reviews.join(''), /stale model phrase/); assert.equal(head(cwd), '');
}));

for (const mode of ['malformed', 'http', 'timeout']) {
  test(`${mode} reply offers offline continuation with no retry`, async () => fakeKey(async () => {
    const cwd = fixture(); const session = scripted(['continue', 'metadata', '', 'send', 'commit']); let calls = 0;
    const transport = async (_url, { signal }) => {
      calls++; if (mode === 'timeout') return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true }));
      return mode === 'http' ? Response.json({ error: 'not exposed' }, { status: 429 })
        : Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
    };
    const result = await composeCommit(cwd, { ai: true }, session.io, { transport, ...(mode === 'timeout' ? { timeoutMs: 3000 } : {}) });
    assert.equal(result.status, 'committed'); assert.equal(calls, 1); assert.match(session.reviews.join(''), /offline composition/);
    assert.doesNotMatch(session.reviews.join(''), /not exposed|synthetic abort/);
  }));
}

test('sensitive paths or intent refuse before transmission and do not echo blocked hint into an offline draft', async () => fakeKey(async () => {
  const cwd = fixture(); change(cwd, env, '.env', 'FICTIONAL=not-a-key\n');
  const state = await captureCommitState(cwd), session = scripted(['metadata', 'api_key=' + 'x'.repeat(30)]), mock = injected();
  const result = await offerCommitDraft(cwd, state, undefined, session.io, mock);
  assert.equal(result.kind, 'local'); assert.equal(result.hint, ''); assert.equal(mock.count(), 0);
  assert.doesNotMatch(session.reviews.join(''), /x{30}/);
}));

for (const kind of ['head', 'branch', 'policy']) {
  test(`returned draft for changed ${kind} is discarded, with no repeat request`, async () => fakeKey(async () => {
    const cwd = fixture(), state = await captureCommitState(cwd), session = scripted(['metadata', '', 'send']);
    const mock = injected(() => {
      if (kind === 'head') { commit(cwd, env, 'docs: concurrent change'); change(cwd, env, 'README.md', 'new staged set\n'); }
      if (kind === 'branch') git(cwd, env, ['symbolic-ref', 'HEAD', 'refs/heads/other']);
      if (kind === 'policy') writeFileSync(join(cwd, 'committide.config.json'), '{"allowedTypes":["release"]}');
    }, { ...aiDraft, description: 'discard this returned phrase' });
    assert.equal((await offerCommitDraft(cwd, state, undefined, session.io, mock)).kind, 'stale');
    assert.equal(mock.count(), 1); assert.doesNotMatch(session.reviews.join(''), /discard this returned phrase/);
  }));
}

test('a structurally shaped reply cannot bypass message lint or attach executable fields', async () => fakeKey(async () => {
  for (const draft of [{ ...aiDraft, scope: 'bad(scope' }, { ...aiDraft, command: 'git commit' }, { ...aiDraft, footers: 'BREAKING CHANGE: invented' }]) {
    const cwd = fixture(), state = await captureCommitState(cwd), session = scripted(['metadata', '', 'send']), mock = injected(() => {}, draft);
    assert.equal((await offerCommitDraft(cwd, state, undefined, session.io, mock)).kind, 'local');
    assert.equal(mock.count(), 1); assert.equal(head(cwd), '');
  }
}));
