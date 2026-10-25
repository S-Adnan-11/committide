import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { captureStaged, stagedCurrent, stagedPatch, stagedOverview, stagedEntries, stagedSubmission } from '../dist/staged.js';
import { environment, init, git, commit, change } from './git-helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'committide-staged-'));
const env = environment(root);
after(() => rmSync(root, { recursive: true, force: true }));

test('initial, empty and partially staged sets use the index and preserve repository bytes', async () => {
  const cwd = init(root, 'partial staging', env);
  assert.match(stagedOverview(await captureStaged(cwd)), /Nothing staged/);
  change(cwd, env, 'file with spaces.txt', 'staged content\n');
  writeFileSync(join(cwd, 'file with spaces.txt'), 'unstaged secret\n');
  const index = readFileSync(join(cwd, '.git', 'index'));
  const config = readFileSync(join(cwd, '.git', 'config'));
  const snap = await captureStaged(cwd);
  assert.equal(snap.head, null);
  assert.match(snap.entries[0], /^A "file with spaces.txt"/);
  const patch = await stagedPatch(snap);
  assert.match(patch, /\+staged content/);
  assert.doesNotMatch(patch, /unstaged secret/);
  assert.match(await stagedSubmission(snap, 5500), /\+staged content/);
  assert.doesNotMatch(await stagedSubmission(snap, 5500), /unstaged secret/);
  await assert.rejects(stagedSubmission(snap, 8), /exceeds/);
  await assert.rejects(stagedSubmission({ ...snap, omitted: true }, 5500), /incomplete/);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'index')), index);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'config')), config);
  assert.equal(readFileSync(join(cwd, 'file with spaces.txt'), 'utf8'), 'unstaged secret\n');
  commit(cwd, env, 'feat: initial');
  assert.equal(await stagedCurrent(snap), false);
  assert.equal(await stagedSubmission(snap, 5500), null);
  assert.equal((await captureStaged(cwd)).entries.length, 0);
});

test('renames, deletions, binary, Unicode, modes, symlink and submodule entries are represented', async () => {
  const cwd = init(root, 'entry kinds', env);
  change(cwd, env, 'old.txt', 'rename contents\n');
  change(cwd, env, 'deleted.txt', 'gone\n');
  const oid = commit(cwd, env, 'chore: base');
  git(cwd, env, ['mv', 'old.txt', 'renamed.txt']);
  git(cwd, env, ['rm', 'deleted.txt']);
  change(cwd, env, 'Unicode 雪.txt', Buffer.from([0, 1, 2, 3]));
  const blob = git(cwd, env, ['hash-object', '-w', '--stdin'], 0, '../not-followed').stdout.trim();
  git(cwd, env, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  git(cwd, env, ['update-index', '--add', '--cacheinfo', `160000,${oid},module`]);
  git(cwd, env, ['update-index', '--chmod=+x', 'renamed.txt']);
  const snap = await captureStaged(cwd);
  const listing = snap.entries.join('\n');
  assert.match(listing, /R100 "old.txt" -> "renamed.txt"/);
  assert.match(listing, /D "deleted.txt"/);
  assert.match(listing, /100644 -> 100755/);
  assert.match(listing, /symlink object, target not followed/);
  assert.match(listing, /submodule object only/);
  assert.match(listing, /雪/);
  assert.match(await stagedPatch(snap), /Binary files/);
});

test('machine paths with tabs, newlines, quotes, non-UTF8 and terminal controls remain data', () => {
  const record = ':100644 100644 ' + 'a'.repeat(40) + ' ' + 'b'.repeat(40) + ' M\0';
  const path = 'space "quote"\ttab\nnewline\x1b[31m\u202e雪';
  const parsed = stagedEntries(Buffer.from(record + path + '\0'), false);
  assert.equal(parsed.entries.length, 1);
  assert.ok(parsed.entries[0].includes('\\t'));
  assert.ok(parsed.entries[0].includes('\\n'));
  assert.doesNotMatch(parsed.entries[0], /[\x1b\u202e\t\n]/);
  assert.match(stagedEntries(Buffer.concat([Buffer.from(record), Buffer.from([255, 0])]), false).entries[0], /non-UTF-8 path bytes: ff/);
});

test('large patches and many files have explicit bounded omissions', async () => {
  const cwd = init(root, 'large patch', env);
  change(cwd, env, 'large.txt', 'long line of content\n'.repeat(10000));
  for (let i = 0; i < 105; i++) writeFileSync(join(cwd, `small-${i}.txt`), 'small\n');
  git(cwd, env, ['add', '--all']);
  const snap = await captureStaged(cwd);
  assert.equal(snap.entries.length, 100);
  assert.equal(snap.omitted, true);
  const patch = await stagedPatch(snap);
  assert.match(patch, /Patch truncated at 65536 bytes/);
  assert.ok(patch.length < 67000);
});

test('unusual paths survive a real Git index without needing filesystem traversal', async () => {
  const cwd = init(root, 'unusual index paths', env);
  const blob = git(cwd, env, ['hash-object', '-w', '--stdin'], 0, 'index only\n').stdout.trim();
  for (const path of ['with\ttab', 'with\nnewline', 'with"quote', '雪 space']) {
    // Index-only fixture: Windows normally refuses filesystem-incompatible names.
    git(cwd, env, ['-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
  }
  const snap = await captureStaged(cwd);
  assert.equal(snap.entries.length, 4);
  assert.match(snap.entries.join('\n'), /\\t/);
  assert.match(snap.entries.join('\n'), /\\n/);
  assert.match(await stagedPatch(snap), /index only/);
});

test('staged objects, modes, paths and HEAD invalidate snapshots; unstaged edits do not', async () => {
  const cwd = init(root, 'stale snapshots', env);
  change(cwd, env, 'one', 'first\n');
  const snap = await captureStaged(cwd);
  writeFileSync(join(cwd, 'one'), 'second\n');
  assert.equal(await stagedCurrent(snap), true);
  git(cwd, env, ['add', 'one']);
  assert.equal(await stagedCurrent(snap), false);
  assert.equal(await stagedPatch(snap), null);
  const modes = await captureStaged(cwd);
  git(cwd, env, ['update-index', '--chmod=+x', 'one']);
  assert.equal(await stagedCurrent(modes), false);
  const base = await captureStaged(cwd);
  commit(cwd, env, 'feat: base change');
  assert.equal(await stagedCurrent(base), false);
});

test('diff helpers and text conversion cannot run during staged inspection', async () => {
  const cwd = init(root, 'external helpers', env);
  change(cwd, env, '.gitattributes', '*.txt diff=evil\n');
  change(cwd, env, 'one.txt', 'safe\x1b[31m\n');
  git(cwd, env, ['config', 'diff.evil.command', 'this-command-must-not-exist']);
  git(cwd, env, ['config', 'diff.evil.textconv', 'this-command-must-not-exist']);
  const patch = await stagedPatch(await captureStaged(cwd));
  assert.match(patch, /safe\[U\+001B\]/);
  assert.doesNotMatch(patch, /\x1b/);
});

test('missing repository, bare repository and conflicted index refuse review', async () => {
  await assert.rejects(captureStaged(root), /No accessible Git repository/);
  const bare = join(root, 'bare.git');
  git(root, env, ['init', '--bare', bare]);
  await assert.rejects(captureStaged(bare), /working repository/);
  const cwd = init(root, 'conflicts', env);
  change(cwd, env, 'file', 'base\n');
  commit(cwd, env, 'chore: base');
  git(cwd, env, ['checkout', '-b', 'side']);
  change(cwd, env, 'file', 'side\n');
  commit(cwd, env, 'fix: side');
  git(cwd, env, ['checkout', 'main']);
  change(cwd, env, 'file', 'main\n');
  commit(cwd, env, 'fix: main');
  git(cwd, env, ['-c', 'core.hooksPath=/dev/null', 'merge', 'side'], 1);
  await assert.rejects(captureStaged(cwd), /conflicts/);
});
