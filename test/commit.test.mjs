import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { composeCommit } from '../dist/commit.js';
import { captureCommitState, commitStateCurrent, groundedDraft } from '../dist/commit-state.js';
import { executeCommit, temporaryMessage } from '../dist/commit-run.js';
import { assembleDraft } from '../dist/draft.js';
import { CommitCancelled } from '../dist/suggest-io.js';
import { environment, init, change, commit, git, invoke, run, cli } from './git-helpers.mjs';
import { interact } from './terminal-helpers.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'committide-composer-')));
const env = environment(root);
Object.assign(process.env, env);
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function fixture(file = 'README.md', content = 'staged documentation\n') {
  const cwd = init(root, `repo é & (${counter++})`, env);
  change(cwd, env, file, content);
  return cwd;
}
function scripted(answers, before = () => {}) {
  const reviews = [], prompts = [];
  const io = {
    review(text) { reviews.push(text); }, check() {},
    async ask(prompt) {
      prompts.push(prompt);
      await before(prompt, prompts.length);
      assert.ok(answers.length, `No answer for ${prompt}\n${reviews.join('')}`);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { io, reviews, prompts };
}
const head = cwd => git(cwd, env, ['rev-parse', '--verify', '--quiet', 'HEAD'], null).stdout.trim();
const message = cwd => git(cwd, env, ['log', '-1', '--format=%B']).stdout.trimEnd();
const status = cwd => git(cwd, env, ['status', '--porcelain=v1']).stdout;

test('explicit approval makes exactly one ordinary initial commit and preserves unstaged/untracked contents', async () => {
  const cwd = fixture();
  writeFileSync(join(cwd, 'README.md'), 'unstaged documentation\n');
  writeFileSync(join(cwd, 'untracked.txt'), 'private draft\n');
  const config = readFileSync(join(cwd, '.git', 'config'));
  const hooks = readdirSync(join(cwd, '.git', 'hooks'));
  const session = scripted(['patch', 'continue', '', 'yes', 'commit'], prompt => {
    if (prompt.startsWith('Review:')) assert.equal(head(cwd), '');
  });
  const result = await composeCommit(cwd, {}, session.io);
  assert.equal(result.status, 'committed');
  assert.equal(result.exitCode, 0);
  assert.equal(git(cwd, env, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
  assert.equal(message(cwd), 'docs: add README.md');
  assert.equal(git(cwd, env, ['show', 'HEAD:README.md']).stdout, 'staged documentation\n');
  assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'unstaged documentation\n');
  assert.equal(readFileSync(join(cwd, 'untracked.txt'), 'utf8'), 'private draft\n');
  assert.deepEqual(readFileSync(join(cwd, '.git', 'config')), config);
  assert.deepEqual(readdirSync(join(cwd, '.git', 'hooks')), hooks);
  assert.match(session.reviews.join(''), /Branch: "refs\/heads\/main"/);
  assert.match(session.reviews.join(''), /Staged: 1 entries, \+1\/-0/);
  assert.match(session.reviews.join(''), /\+staged documentation/);
  assert.doesNotMatch(session.reviews.join(''), /\+unstaged documentation/);
});

test('ambiguous logic asks for intent; edits retain multiline Unicode, breaking details, trailers and shell metacharacters as data', async () => {
  const cwd = fixture('logic.ts', 'export const answer = 42;\n');
  const session = scripted(['continue', 'fix', 'core', 'handle 雪 and "quotes"; $(echo nope) & <input>',
    'edit', 'body', 'Why: preserve café', '', 'A second paragraph with `literal` text.', '.done',
    'edit', 'breaking', 'yes', 'Use the new shape', '.done',
    'edit', 'refs', '#42', '.done',
    'edit', 'footers', 'Reviewed-by: Example', '.done', 'commit']);
  assert.equal((await composeCommit(cwd, {}, session.io)).status, 'committed');
  assert.equal(message(cwd), 'fix(core)!: handle 雪 and "quotes"; $(echo nope) & <input>\n\nWhy: preserve café\n\nA second paragraph with `literal` text.\n\nBREAKING CHANGE: Use the new shape\nRefs: #42\nReviewed-by: Example');
  assert.ok(session.prompts.some(prompt => prompt.startsWith('Intent')));
  assert.match(session.reviews.join(''), /does not establish intent/);
});

test('grounded suggestions are limited to docs, tests and unchanged-content renames; type policy wins', async () => {
  const cwd = fixture();
  assert.equal(groundedDraft(await captureCommitState(cwd)).type, 'docs');
  commit(cwd, env, 'docs: base');
  git(cwd, env, ['mv', 'README.md', 'GUIDE.md']);
  assert.match(groundedDraft(await captureCommitState(cwd)).description, /^rename README.md to GUIDE.md$/);
  const tests = fixture('example.test.mjs', 'test fixture\n');
  assert.equal(groundedDraft(await captureCommitState(tests)).type, 'test');
  writeFileSync(join(tests, 'committide.config.json'), '{"allowedTypes":["quality"]}');
  assert.equal(groundedDraft(await captureCommitState(tests)), null);
  const session = scripted(['continue', 'quality', '', 'check expected behavior', 'commit']);
  assert.equal((await composeCommit(tests, {}, session.io)).status, 'committed');
  assert.equal(message(tests), 'quality: check expected behavior');
});

test('mixed file kinds get a hint and user intent, never a fabricated feature or automatic split', async () => {
  const cwd = fixture();
  change(cwd, env, 'logic.ts', 'new behavior\n');
  const session = scripted(['continue', 'feat', '', 'show current tide', 'cancel']);
  await assert.rejects(composeCommit(cwd, {}, session.io), CommitCancelled);
  assert.match(session.reviews.join(''), /span different kinds of files/);
  assert.equal(head(cwd), '');
});

test('invalid drafts cannot commit; correction uses the common validator', async () => {
  const cwd = fixture();
  const session = scripted(['continue', 'edit', 'type', 'unknown', 'commit', 'edit', 'type', 'docs', 'commit']);
  assert.equal((await composeCommit(cwd, {}, session.io)).status, 'committed');
  assert.match(session.reviews.join(''), /type-allowed/);
  assert.match(session.reviews.join(''), /Correct the message/);
  assert.equal(git(cwd, env, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
});

for (const kind of ['index', 'head', 'ref', 'policy']) {
  test(`${kind} changes after draft discard approval and draft, requiring a fresh decision`, async () => {
    const cwd = fixture();
    const old = await captureCommitState(cwd);
    let changed = false;
    const session = scripted(['continue', 'commit', ...(kind === 'policy' ? ['release', '', 'describe current staged change'] : []), 'cancel'], prompt => {
      if (!prompt.startsWith('Review:') || changed) return;
      changed = true;
      if (kind === 'index') change(cwd, env, 'docs.md', 'second staged file\n');
      if (kind === 'head') {
        commit(cwd, env, 'docs: concurrent base');
        change(cwd, env, 'README.md', 'different staged content\n');
      }
      if (kind === 'ref') git(cwd, env, ['symbolic-ref', 'HEAD', 'refs/heads/other']);
      if (kind === 'policy') writeFileSync(join(cwd, 'committide.config.json'), '{"allowedTypes":["release"]}');
    });
    await assert.rejects(composeCommit(cwd, {}, session.io), CommitCancelled);
    assert.equal(await commitStateCurrent(cwd, old), false);
    assert.match(session.reviews.join(''), /Previous draft and confirmation are discarded/);
    assert.equal(git(cwd, env, ['rev-list', '--count', 'HEAD'], null).stdout.trim(), kind === 'head' ? '1' : '');
  });
}

test('effective policy stays stable across equivalent JSON formatting; explicit config is bound too', async () => {
  const cwd = fixture();
  writeFileSync(join(cwd, 'policy.json'), '{"allowedTypes":["docs"]}');
  const state = await captureCommitState(cwd, 'policy.json');
  writeFileSync(join(cwd, 'policy.json'), '{ "allowedTypes": ["DOCS"] }\n');
  assert.equal(await commitStateCurrent(cwd, state, 'policy.json'), true);
  writeFileSync(join(cwd, 'policy.json'), '{"allowedTypes":["fix"]}');
  assert.equal(await commitStateCurrent(cwd, state, 'policy.json'), false);
});

test('replacing a repository at the same path invalidates worktree identity even with matching staged contents', async () => {
  const cwd = fixture();
  const state = await captureCommitState(cwd);
  renameSync(cwd, cwd + ' moved');
  init(root, cwd.slice(root.length + 1), env);
  change(cwd, env, 'README.md', 'staged documentation\n');
  assert.equal((await captureCommitState(cwd)).snapshot.fingerprint, state.snapshot.fingerprint);
  assert.equal(await commitStateCurrent(cwd, state), false);
});

test('an operation starting after review refuses before any commit', async () => {
  const cwd = fixture();
  const session = scripted(['continue', 'commit'], prompt => {
    if (prompt.startsWith('Review:')) mkdirSync(join(cwd, '.git', 'sequencer'));
  });
  await assert.rejects(composeCommit(cwd, {}, session.io), /native --continue\/--abort/);
  assert.equal(head(cwd), '');
});

test('the handoff check invalidates a changed snapshot and never invokes Git or leaves a message file', async () => {
  const cwd = fixture();
  const state = await captureCommitState(cwd);
  change(cwd, env, 'README.md', 'arrived after confirmation\n');
  const session = scripted([]);
  session.io.handoff = () => assert.fail('Git terminal handoff must not occur');
  assert.equal((await executeCommit(cwd, state, assembleDraft(groundedDraft(state)), session.io)).status, 'stale');
  assert.equal(head(cwd), '');
});

test('empty staging is a no-op; malformed policy, intent-to-add and oversized overviews refuse without committing', async () => {
  const cwd = init(root, `empty ${counter++}`, env);
  const session = scripted([]);
  assert.deepEqual(await composeCommit(cwd, {}, session.io), { status: 'empty', exitCode: 0 });
  writeFileSync(join(cwd, 'committide.config.json'), '{"allowedTypes":[]}');
  await assert.rejects(composeCommit(cwd, {}, session.io), /at least one type/);
  rmSync(join(cwd, 'committide.config.json'));
  writeFileSync(join(cwd, 'intent.txt'), 'unstaged\n');
  git(cwd, env, ['add', '--intent-to-add', 'intent.txt']);
  await assert.rejects(composeCommit(cwd, {}, session.io), /Intent-to-add/);
  git(cwd, env, ['rm', '--cached', 'intent.txt']);
  for (let n = 0; n < 101; n++) change(cwd, env, `doc-${n}.md`, 'bounded\n');
  await assert.rejects(composeCommit(cwd, {}, session.io), /overview is incomplete/);
  assert.equal(head(cwd), '');
});

for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
  test(`refuses operation state ${marker} with native continuation guidance`, async () => {
    const cwd = fixture();
    if (marker.includes('-') || marker === 'sequencer') mkdirSync(join(cwd, '.git', marker));
    else writeFileSync(join(cwd, '.git', marker), 'fixture operation\n');
    await assert.rejects(composeCommit(cwd, {}, scripted([]).io), /native --continue\/--abort/);
    assert.equal(head(cwd), '');
  });
}

test('real merge conflict is refused and preserved', async () => {
  const cwd = fixture();
  commit(cwd, env, 'docs: base');
  git(cwd, env, ['switch', '-c', 'side']);
  change(cwd, env, 'README.md', 'side\n'); commit(cwd, env, 'docs: side');
  git(cwd, env, ['switch', 'main']);
  change(cwd, env, 'README.md', 'main\n'); commit(cwd, env, 'docs: main');
  git(cwd, env, ['merge', 'side'], 1);
  const before = status(cwd);
  await assert.rejects(composeCommit(cwd, {}, scripted([]).io), /native --continue\/--abort/);
  assert.equal(status(cwd), before);
  rmSync(join(cwd, '.git', 'MERGE_HEAD'));
  await assert.rejects(composeCommit(cwd, {}, scripted([]).io), /Resolve staged merge conflicts/);
});

test('linked worktree and detached HEAD commits use the reviewed worktree only', async () => {
  const cwd = fixture();
  const base = commit(cwd, env, 'docs: base');
  const linked = join(root, `linked worktree 雪 ${counter++}`);
  git(cwd, env, ['worktree', 'add', '-b', 'linked', linked]);
  change(linked, env, 'docs.md', 'linked content\n');
  const state = await captureCommitState(linked);
  assert.equal(state.branch, 'refs/heads/linked');
  assert.equal((await composeCommit(linked, {}, scripted(['continue', 'commit']).io)).status, 'committed');
  assert.equal(head(cwd), base);
  git(linked, env, ['switch', '--detach']);
  change(linked, env, 'docs.md', 'detached content\n');
  const session = scripted(['continue', 'commit']);
  assert.equal((await composeCommit(linked, {}, session.io)).status, 'committed');
  assert.match(session.reviews.join(''), /detached HEAD/);
});

test('subdirectory policy and repo paths containing spaces, Unicode and metacharacters remain data', async () => {
  const cwd = fixture();
  const subdir = join(cwd, 'sub dir'); mkdirSync(subdir);
  writeFileSync(join(subdir, 'committide.config.json'), '{"allowedTypes":["release"]}');
  const session = scripted(['continue', 'release', 'docs', 'describe local policy', 'commit']);
  assert.equal((await composeCommit(subdir, {}, session.io)).status, 'committed');
  assert.equal(message(cwd), 'release(docs): describe local policy');
});

test('normal hooks run; hook rejection and configured signing failure keep staged contents and propagate Git exit', async () => {
  for (const kind of ['accept', 'reject', 'signing']) {
    const cwd = fixture();
    const hook = join(cwd, '.git', 'hooks', 'commit-msg');
    writeFileSync(hook, '#!/bin/sh\nprintf "hook ran\\n" > hook-ran\n' + (kind === 'reject' ? 'echo fixture-hook-rejected >&2\nexit 1\n' : 'exit 0\n'), { mode: 0o755 });
    if (kind === 'signing') {
      git(cwd, env, ['config', 'commit.gpgsign', 'true']);
      git(cwd, env, ['config', 'gpg.program', 'nonexistent-fixture-signing-program']);
    }
    const before = status(cwd);
    const result = await composeCommit(cwd, {}, scripted(['continue', 'commit']).io);
    assert.ok(existsSync(join(cwd, 'hook-ran')));
    if (kind === 'accept') assert.equal(result.status, 'committed');
    else {
      assert.equal(result.status, 'failed'); assert.equal(result.exitCode, kind === 'reject' ? 1 : 128);
      assert.equal(head(cwd), '');
      assert.ok(status(cwd).includes(before.trim()));
    }
  }
});

test('message-changing hooks report what Git actually recorded', async () => {
  const cwd = fixture();
  writeFileSync(join(cwd, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nprintf "docs: message from hook\\n" > "$1"\n', { mode: 0o755 });
  const session = scripted(['continue', 'commit']);
  assert.equal((await composeCommit(cwd, {}, session.io)).status, 'committed');
  assert.equal(message(cwd), 'docs: message from hook');
  assert.match(session.reviews.join(''), /recorded a different message/);
});

test('hook-induced index changes report an unexpected result without rewriting or retrying', async () => {
  const cwd = fixture();
  writeFileSync(join(cwd, 'hook-file'), 'hook-created content\n');
  writeFileSync(join(cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ngit add -- hook-file\n', { mode: 0o755 });
  const session = scripted(['continue', 'commit']);
  const result = await composeCommit(cwd, {}, session.io);
  assert.equal(result.status, 'uncertain'); assert.equal(result.exitCode, 2);
  assert.match(session.reviews.join(''), /differs from the reviewed parent or staged tree/);
  assert.equal(git(cwd, env, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
  assert.equal(git(cwd, env, ['show', 'HEAD:hook-file']).stdout, 'hook-created content\n');
});

test('private temporary messages use restrictive permissions, exclusive names and complete cleanup', async () => {
  const temp = await temporaryMessage('docs: private message\n');
  assert.equal(readFileSync(temp.path, 'utf8'), 'docs: private message\n');
  if (process.platform === 'win32') {
    assert.ok(temp.path.startsWith(join(userInfo().homedir, 'AppData', 'Local', 'Temp')));
    const acl = run('icacls.exe', [temp.path], root, env).stdout;
    assert.doesNotMatch(acl, /Everyone|BUILTIN\\Users|Authenticated Users/);
  } else {
    assert.equal(statSync(temp.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(temp.path, '..')).mode & 0o777, 0o700);
  }
  await temp.cleanup();
  assert.equal(existsSync(temp.path), false);
  assert.equal(existsSync(join(temp.path, '..')), false);
});

test('an existing SSH signing setup produces a signed commit without changing its configuration', async t => {
  const available = spawnSync('ssh-keygen', ['-V'], { env, windowsHide: true, encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') { t.skip('ssh-keygen is unavailable'); return; }
  const cwd = fixture();
  const key = join(root, `signing-key-${counter++}`);
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], root, env);
  git(cwd, env, ['config', 'gpg.format', 'ssh']);
  git(cwd, env, ['config', 'user.signingkey', key]);
  git(cwd, env, ['config', 'commit.gpgsign', 'true']);
  const config = readFileSync(join(cwd, '.git', 'config'));
  const result = await composeCommit(cwd, {}, scripted(['continue', 'commit']).io);
  assert.equal(result.status, 'committed');
  assert.match(git(cwd, env, ['cat-file', 'commit', 'HEAD']).stdout, /gpgsig -----BEGIN SSH SIGNATURE-----/);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'config')), config);
});

test('a failed child report after an actual commit is uncertain and cannot trigger a duplicate commit', async () => {
  const cwd = fixture();
  const setup = "import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawn;cp.spawn=(file,args,options)=>{const child=spawn(file,args,options);if(file==='git'&&args[0]==='commit'){const once=child.once.bind(child);child.once=(event,listener)=>once(event,event==='close'?(_code,signal)=>listener(1,signal):listener);}return child;};syncBuiltinESMExports();";
  const steps = [{ prompt: 'Staged review:', answer: 'continue' }, { prompt: 'Review: commit', answer: 'commit' }];
  steps.command = 'commit'; steps.preload = 'data:text/javascript,' + encodeURIComponent(setup);
  const result = await interact(cli, cwd, env, steps, 1);
  assert.match(result.stderr, /matching new commit was observed despite Git's failure/);
  assert.match(result.stderr, /No retry was made/);
  assert.equal(git(cwd, env, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
});

test('alternate-index and repository environment overrides refuse before review', async () => {
  const cwd = fixture();
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) {
    const old = process.env[key];
    process.env[key] = join(cwd, 'override');
    try { await assert.rejects(captureCommitState(cwd), /Unset GIT_/); }
    finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
  }
});

test('cancellation during the last check cleans temporary content and invokes no commit', async () => {
  const cwd = fixture();
  const state = await captureCommitState(cwd);
  const session = scripted([]);
  session.io.check = () => { throw new CommitCancelled(); };
  await assert.rejects(executeCommit(cwd, state, assembleDraft(groundedDraft(state)), session.io), CommitCancelled);
  assert.equal(head(cwd), '');
});

test('CLI refuses headless input, unknown options, pathspecs and Git passthrough; help works anywhere', () => {
  assert.match(invoke(root, env, ['commit', '--help']).stdout, /Only|Enter does nothing/);
  for (const args of [[], ['--provider'], ['-m', 'docs: supplied'], ['--amend'], ['--no-verify'], ['file.txt'], ['--', 'file.txt']]) {
    const result = run(process.execPath, [cli, 'commit', ...args], root, env, 2, 'commit\n');
    assert.equal(result.stdout, '');
    assert.match(result.stderr, args.length ? /unknown option|too many arguments/ : /commit-terminal/);
  }
});

for (const answer of [null, '\x03', '/cancel', 'cancel']) {
  test(`terminal cancellation ${JSON.stringify(answer)} before approval returns 130 without a commit`, async () => {
    const cwd = fixture();
    const before = status(cwd);
    const steps = [{ prompt: 'Staged review:', answer: 'continue' }, { prompt: 'Review: commit', answer }];
    steps.command = 'commit';
    const result = await interact(cli, cwd, env, steps, 130);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Cancelled before Git commit/);
    assert.equal(head(cwd), ''); assert.equal(status(cwd), before);
  });
}

test('offline command makes no request even with provider credentials and unavailable fetch', async () => {
  const cwd = fixture();
  const steps = [{ prompt: 'Staged review:', answer: 'continue' }, { prompt: 'Review: commit', answer: 'commit' }];
  steps.command = 'commit';
  steps.preload = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch=()=>{throw Error('unexpected network')};");
  const result = await interact(cli, cwd, { ...env, GROQ_API_KEY: 'synthetic-not-used' }, steps);
  assert.match(result.stderr, /Commit recorded/);
  assert.equal(git(cwd, env, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
});
