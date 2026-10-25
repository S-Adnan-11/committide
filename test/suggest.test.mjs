import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { suggest } from '../dist/suggest.js';
import { SuggestCancelled } from '../dist/suggest-io.js';
import { messageDestination, saveMessage } from '../dist/suggest-file.js';
import { lintMessage } from '../dist/message.js';
import { environment, init, change, commit, git, invoke, run, cli } from './git-helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'committide-suggest-'));
const env = environment(root);
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function fixture() {
  const cwd = init(root, `writer ${counter++}`, env);
  change(cwd, env, 'file.txt', 'staged\n');
  writeFileSync(join(cwd, 'file.txt'), 'unstaged\n');
  return cwd;
}
function scripted(answers, before = () => {}) {
  const review = [];
  const prompts = [];
  return {
    review, prompts,
    io: {
      review(text) { review.push(text); }, check() {},
      async ask(prompt) {
        prompts.push(prompt);
        await before(prompt, prompts.length);
        assert.ok(answers.length, `No answer for ${prompt}`);
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

test('short draft is accepted through shared linting without repository mutations', async () => {
  const cwd = fixture();
  const files = ['index', 'config', 'HEAD'];
  const before = files.map(file => readFileSync(join(cwd, '.git', file)));
  const hooks = readdirSync(join(cwd, '.git', 'hooks'));
  const session = scripted(['patch', 'continue', 'FIX', 'api', 'handle empty results', 'accept']);
  const message = await suggest(cwd, {}, session.io);
  assert.equal(message, 'fix(api): handle empty results\n');
  assert.deepEqual(lintMessage(message).diagnostics, []);
  assert.match(session.review.join(''), /\+staged/);
  assert.doesNotMatch(session.review.join(''), /unstaged\n/);
  files.forEach((file, index) => assert.deepEqual(readFileSync(join(cwd, '.git', file)), before[index]));
  assert.deepEqual(readdirSync(join(cwd, '.git', 'hooks')), hooks);
  assert.equal(readFileSync(join(cwd, 'file.txt'), 'utf8'), 'unstaged\n');
});

test('custom type, multiline body, breaking details, neutral references and extra footers survive edits', async () => {
  const cwd = fixture();
  writeFileSync(join(cwd, 'committide.config.json'), '{"allowedTypes":["release"]}');
  const session = scripted(['continue', 'Release', '', 'prepare migration',
    'advanced', 'body', 'Reason', '', 'Second paragraph', '.done',
    'advanced', 'breaking', 'yes', 'Move settings', 'Use new names', '.done',
    'advanced', 'refs', '#123', '.done',
    'advanced', 'footers', 'Reviewed-by: Example', '.done',
    'edit', 'scope', 'config', 'accept']);
  const message = await suggest(cwd, {}, session.io);
  assert.equal(message, 'release(config)!: prepare migration\n\nReason\n\nSecond paragraph\n\nBREAKING CHANGE: Move settings\nUse new names\nRefs: #123\nReviewed-by: Example\n');
  assert.deepEqual(lintMessage(message, ['release']).diagnostics, []);
  assert.match(session.review.join(''), /custom configured type/);
  assert.doesNotMatch(session.review.join(''), /release: (?:new|maintenance)/);
});

test('invalid inputs retain the draft, show shared diagnostics and cannot be accepted until corrected', async () => {
  const cwd = fixture();
  const session = scripted(['continue', 'unknown', 'bad(scope', '', 'accept',
    'edit', 'type', 'feat', 'edit', 'scope', '', 'edit', 'description', 'valid text',
    'advanced', 'breaking', 'yes', '.done', 'accept',
    'advanced', 'breaking', 'yes', 'Migrate callers', '.done', 'accept']);
  const message = await suggest(cwd, {}, session.io);
  assert.equal(message, 'feat!: valid text\n\nBREAKING CHANGE: Migrate callers\n');
  const review = session.review.join('');
  assert.match(review, /unknown\(bad\(scope\):/);
  assert.match(review, /header-format/);
  assert.match(review, /footer-value/);
});

test('index changes during review retain fields, require refresh and a second explicit acceptance', async () => {
  const cwd = fixture();
  let changed = false;
  const session = scripted(['continue', 'feat', '', 'retained description', 'accept', 'refresh', 'patch', 'accept'], prompt => {
    if (prompt.startsWith('Review:') && !changed) {
      changed = true;
      change(cwd, env, 'second.txt', 'new staged change\n');
    }
  });
  assert.equal(await suggest(cwd, {}, session.io), 'feat: retained description\n');
  assert.match(session.review.join(''), /previous staged review is stale/);
  assert.match(session.review.join(''), /\+new staged change/);
  assert.equal(session.prompts.filter(p => p.startsWith('Description')).length, 1);
});

test('base changes and explicit refresh preserve draft; cancellation emits no accepted message', async () => {
  const cwd = fixture();
  let changed = false;
  const session = scripted(['continue', 'feat', '', 'retained', 'accept', 'cancel'], prompt => {
    if (prompt.startsWith('Review:') && !changed) {
      changed = true;
      commit(cwd, env, 'chore: new base');
      change(cwd, env, 'new.txt', 'new\n');
    }
  });
  await assert.rejects(suggest(cwd, {}, session.io), SuggestCancelled);
  assert.match(session.review.join(''), /stale/);
  assert.doesNotMatch(session.review.join(''), /Accepted\./);
});

test('configuration is revalidated after the final review and cannot bypass policy', async () => {
  const cwd = fixture();
  let changed = false;
  const session = scripted(['continue', 'feat', '', 'draft', 'accept', '/cancel'], prompt => {
    if (prompt.startsWith('Review:') && !changed) {
      changed = true;
      writeFileSync(join(cwd, 'committide.config.json'), '{"allowedTypes":["fix"]}');
    }
  });
  await assert.rejects(suggest(cwd, {}, session.io), SuggestCancelled);
  assert.match(session.review.join(''), /type-allowed/);
});

test('empty staging produces no message; malformed and explicit configuration fail usefully', async () => {
  const cwd = init(root, `empty ${counter++}`, env);
  const empty = scripted([]);
  assert.equal(await suggest(cwd, {}, empty.io), null);
  assert.match(empty.review.join(''), /Nothing staged/);
  writeFileSync(join(cwd, 'bad.json'), '{"unknown":true}');
  await assert.rejects(suggest(cwd, { config: 'bad.json' }, empty.io), /Unknown configuration keys/);
});

test('explicit new-file output matches stdout text, refuses existing files and protects Git metadata', async () => {
  const cwd = fixture();
  const session = scripted(['continue', 'docs', '', 'explain usage', 'accept']);
  const message = await suggest(cwd, { output: 'message.txt' }, session.io);
  assert.equal(readFileSync(join(cwd, 'message.txt'), 'utf8'), message);
  assert.deepEqual(readdirSync(cwd).filter(name => name.startsWith('.committide-message-')), []);
  await assert.rejects(suggest(cwd, { output: 'file.txt' }, scripted([]).io), /already exists/);
  await assert.rejects(messageDestination(cwd, '.git/COMMIT_EDITMSG'), /outside Git metadata/);
  await assert.rejects(messageDestination(cwd, 'missing-dir/message'), /output parent/);
  mkdirSync(join(cwd, 'directory'));
  await assert.rejects(messageDestination(cwd, 'directory'), /already exists/);
});

test('new destinations appearing during final review are preserved without partial stdout or temporary leftovers', async () => {
  const cwd = fixture();
  const session = scripted(['continue', 'fix', '', 'draft', 'accept'], prompt => {
    if (prompt.startsWith('Review:')) writeFileSync(join(cwd, 'message.txt'), 'concurrent contents');
  });
  await assert.rejects(suggest(cwd, { output: 'message.txt' }, session.io), /already exists|concurrently/);
  assert.equal(readFileSync(join(cwd, 'message.txt'), 'utf8'), 'concurrent contents');
  assert.deepEqual(readdirSync(cwd).filter(name => name.startsWith('.committide-message-')), []);
});

test('last snapshot check and cancellation before publication clean only owned temporaries', async () => {
  const cwd = fixture();
  const target = join(cwd, 'new-message');
  assert.equal(await saveMessage(target, 'fix: draft\n', async () => false, () => {}), false);
  await assert.rejects(saveMessage(target, 'fix: draft\n', async () => {
    writeFileSync(target, 'arrived at publication'); return true;
  }, () => {}), /concurrently/);
  assert.equal(readFileSync(target, 'utf8'), 'arrived at publication');
  rmSync(target);
  await assert.rejects(saveMessage(target, 'fix: draft\n', async () => true, () => { throw new SuggestCancelled(); }), SuggestCancelled);
  assert.deepEqual(readdirSync(cwd).filter(name => /committide-message|new-message/.test(name)), []);
});

test('EOF, cancellation and failed prompts preserve index, worktree and output', async () => {
  for (const error of [new SuggestCancelled(), new Error('failed prompt')]) {
    const cwd = fixture();
    const before = readFileSync(join(cwd, '.git', 'index'));
    const session = scripted(['continue', 'feat', '', error]);
    await assert.rejects(suggest(cwd, { output: 'no-message' }, session.io));
    assert.deepEqual(readFileSync(join(cwd, '.git', 'index')), before);
    assert.equal(readFileSync(join(cwd, 'file.txt'), 'utf8'), 'unstaged\n');
    assert.ok(!readdirSync(cwd).includes('no-message'));
  }
});

test('executable refuses piped/noninteractive input immediately; help works outside repositories', () => {
  assert.match(invoke(root, env, ['suggest', '--help']).stdout, /--output/);
  const piped = run(process.execPath, [cli, 'suggest'], root, env, 2, 'continue\nfeat\n\nexample\naccept\n');
  assert.equal(piped.stdout, '');
  assert.match(piped.stderr, /suggest-terminal/);
  assert.match(invoke(root, env, ['suggest'], 2).stderr, /suggest-terminal/);
});

test('no provider or fetch clients are called even with provider-like environment values', async () => {
  const cwd = fixture();
  const oldFetch = globalThis.fetch;
  const oldValue = process.env.OPENAI_API_KEY;
  globalThis.fetch = () => { throw new Error('unexpected network request'); };
  process.env.OPENAI_API_KEY = 'fixture-not-a-credential';
  try {
    assert.equal(await suggest(cwd, {}, scripted(['continue', 'fix', '', 'local only', 'accept']).io), 'fix: local only\n');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldValue === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldValue;
  }
});
