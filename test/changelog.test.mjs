import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { environment, init, git, invoke, commit, change } from './git-helpers.mjs';
import { isReleaseTag, START_MARKER, END_MARKER } from '../dist/changelog.js';

const root = mkdtempSync(join(tmpdir(), 'committide-changelog-'));
const env = environment(root);
after(() => rmSync(root, { recursive: true, force: true }));

test('strict stable SemVer allows build metadata but excludes prereleases and malformed components', () => {
  for (const name of ['0.0.0', 'v1.2.3', '999999999999999999999.2.3', '1.2.3+build.007']) assert.ok(isReleaseTag(name), name);
  for (const name of ['01.2.3', '1.02.3', '1.2.03', 'v1.2', 'V1.2.3', 'release-1.2.3', '1.2.3-rc.1', '1.2.3+', '1.2.3+bad..value', '1.2.3\n']) assert.equal(isReleaseTag(name), false, name);
});

test('no tags includes root and all reachable history; preview never creates a file', () => {
  const cwd = init(root, 'no tags with spaces', env);
  commit(cwd, env, 'feat: root feature');
  commit(cwd, env, 'fix: second');
  const result = invoke(cwd, env, ['changelog']);
  assert.match(result.stdout, /^## Unreleased/);
  assert.match(result.stdout, /root feature/);
  assert.match(result.stderr, /all reachable history/);
  assert.match(result.stderr, /Selected 2; included 2; filtered 0; skipped 0/);
  assert.equal(existsSync(join(cwd, 'CHANGELOG.md')), false);
  assert.equal(invoke(cwd, env, ['changelog']).stdout, result.stdout);
});

test('nearest first-parent release excludes its history while retaining merged side commits', () => {
  const cwd = init(root, 'tagged merges', env);
  const base = commit(cwd, env, 'feat: root');
  git(cwd, env, ['tag', 'v0.1.0']);
  git(cwd, env, ['checkout', '-b', 'side']);
  commit(cwd, env, 'feat: side feature');
  git(cwd, env, ['tag', 'v9.9.9']);
  git(cwd, env, ['checkout', 'main']);
  const release = commit(cwd, env, 'feat: release contents');
  git(cwd, env, ['tag', '-a', 'v1.0.0', '-m', 'release']);
  commit(cwd, env, 'fix: main correction');
  git(cwd, env, ['merge', '--no-ff', 'side', '-m', 'chore: integrate side']);
  git(cwd, env, ['checkout', '-b', 'unrelated', base]);
  commit(cwd, env, 'feat: unrelated');
  git(cwd, env, ['tag', 'v99.0.0']);
  git(cwd, env, ['checkout', 'main']);
  const result = invoke(cwd, env, ['changelog']);
  assert.ok(result.stderr.includes(release));
  assert.match(result.stderr, /tag v1.0.0/);
  assert.match(result.stdout, /side feature/);
  assert.match(result.stdout, /main correction/);
  assert.doesNotMatch(result.stdout, /release contents|unrelated|root/);
  assert.match(result.stderr, /Selected 3; included 2; filtered 1; skipped 0/);
  git(cwd, env, ['tag', '2.0.0']);
  const empty = invoke(cwd, env, ['changelog']);
  assert.match(empty.stderr, /Empty range/);
  assert.match(empty.stdout, /No qualifying changes/);
  assert.doesNotMatch(empty.stdout, /###/);
});

test('merged-branch tags alone never hide root or first-parent changes', () => {
  const cwd = init(root, 'side tags only', env);
  commit(cwd, env, 'feat: root included');
  git(cwd, env, ['checkout', '-b', 'side']);
  commit(cwd, env, 'feat: side included');
  git(cwd, env, ['tag', 'v1.0.0']);
  git(cwd, env, ['checkout', 'main']);
  commit(cwd, env, 'fix: main included');
  git(cwd, env, ['merge', '--no-ff', 'side', '-m', 'chore: merge']);
  const result = invoke(cwd, env, ['changelog']);
  assert.match(result.stderr, /all reachable history/);
  assert.match(result.stdout, /root included/);
  assert.match(result.stdout, /side included/);
});

test('ignores prerelease/custom/noncommit tags; peels nested annotated tags and diagnoses release ties', () => {
  const cwd = init(root, 'tag policies', env);
  const first = commit(cwd, env, 'feat: first');
  for (const tag of ['v1.0.0-rc.1', 'release-1.0.0', '01.0.0']) git(cwd, env, ['tag', tag]);
  const blob = git(cwd, env, ['hash-object', '-w', '--stdin'], 0, 'blob').stdout.trim();
  git(cwd, env, ['tag', '9.0.0', blob]);
  assert.match(invoke(cwd, env, ['changelog']).stdout, /first/);
  git(cwd, env, ['tag', '-a', 'inner', '-m', 'inner', first]);
  git(cwd, env, ['tag', '-a', 'v1.0.0+build.007', '-m', 'outer', 'inner']);
  commit(cwd, env, 'fix: after release');
  assert.match(invoke(cwd, env, ['changelog']).stderr, /tag v1.0.0\+build.007/);
  git(cwd, env, ['tag', '1.0.0', first]);
  const conflict = invoke(cwd, env, ['changelog'], 2);
  assert.match(conflict.stderr, /changelog-tags.*explicit --from/);
  assert.equal(conflict.stdout, '');
  assert.match(invoke(cwd, env, ['changelog', '--from', '1.0.0']).stdout, /after release/);
});

test('explicit ranges honor nonancestor reachability and explicit to overrides HEAD', () => {
  const cwd = init(root, 'explicit ranges', env);
  const base = commit(cwd, env, 'feat: excluded');
  git(cwd, env, ['checkout', '-b', 'side']);
  commit(cwd, env, 'feat: selected branch');
  git(cwd, env, ['checkout', 'main']);
  commit(cwd, env, 'fix: main only');
  const result = invoke(cwd, env, ['changelog', '--from', 'main', '--to', 'side']);
  assert.match(result.stdout, /selected branch/);
  assert.doesNotMatch(result.stdout, /excluded|main only/);
  const historical = invoke(cwd, env, ['changelog', '--to', base]);
  assert.match(historical.stdout, /excluded/);
  assert.doesNotMatch(historical.stdout, /main only/);
});

test('groups scoped Unicode/multiline/custom breaking messages once and reports invalid history skips', () => {
  const cwd = init(root, 'rendering', env);
  commit(cwd, env, 'chore: maintenance');
  commit(cwd, env, 'FEAT(日本語): readable feature');
  const breakingFix = commit(cwd, env, 'fix(api): change API\n\nBody\n\nBREAKING CHANGE: Migrate to new API\nSecond line\nRefs: #1');
  const custom = commit(cwd, env, 'custom: historical breaking\n\nBREAKING-CHANGE: Move settings\nMore detail');
  const bang = commit(cwd, env, 'perf!: faster engine');
  commit(cwd, env, 'perf: cache data');
  commit(cwd, env, 'legacy: maintenance custom');
  commit(cwd, env, 'constructor: maintenance prototype name');
  const lastConforming = commit(cwd, env, '__proto__: maintenance prototype token');
  for (const message of ['Merge branch side', 'Revert "old"', 'fixup! feat: temporary', 'squash! feat: temporary']) commit(cwd, env, message);
  const result = invoke(cwd, env, ['changelog']);
  for (const oid of [breakingFix, custom, bang]) assert.equal(result.stdout.split(oid).length - 1, 1);
  assert.match(result.stdout, /### Breaking Changes/);
  assert.match(result.stdout, /日本語: readable feature/);
  assert.match(result.stdout, /  Migrate to new API\n  Second line/);
  assert.match(result.stdout, /  Move settings\n  More detail/);
  assert.doesNotMatch(result.stdout, /maintenance|Skipped|Boundary/);
  assert.match(result.stderr, /skipped 4/);
  assert.equal((result.stderr.match(/Skipped commit/g) ?? []).length, 4);
  const all = invoke(cwd, env, ['changelog', '--include-maintenance']);
  assert.match(all.stdout, /### Maintenance/);
  assert.match(all.stdout, /maintenance custom/);
  assert.ok(all.stdout.indexOf('### Breaking Changes') < all.stdout.indexOf('### Features'));
  assert.ok(all.stdout.indexOf('### Features') < all.stdout.indexOf('### Performance Improvements'));
  const onlySkipped = invoke(cwd, env, ['changelog', '--from', lastConforming]);
  assert.match(onlySkipped.stdout, /No qualifying changes/);
  assert.match(onlySkipped.stderr, /Selected 4; included 0; filtered 0; skipped 4/);
});

test('escapes commit Markdown, HTML, markers, links, and terminal controls while retaining Unicode', () => {
  const cwd = init(root, 'escaping', env);
  commit(cwd, env, 'feat!: [link](https://bad.example) <script> \u001b[31m \u202e café 👩‍💻\n\nBREAKING CHANGE: # injected heading\n<!-- committide:unreleased:end -->\n![image](bad)');
  const { stdout, stderr } = invoke(cwd, env, ['changelog']);
  assert.equal(stdout.split(START_MARKER).length - 1, 1);
  assert.equal(stdout.split(END_MARKER).length - 1, 1);
  assert.doesNotMatch(stdout, /<script>|https:|\[link\]|\u001b|\u202e/);
  assert.match(stdout, /&#35; injected heading/);
  assert.match(stdout, /café 👩‍💻/);
  assert.doesNotMatch(stderr, /\u001b|\u202e/);
});

test('preview preserves dirty repository bytes and validates current/explicit configuration', () => {
  const cwd = init(root, 'preserve', env);
  commit(cwd, env, 'custom: old type\n\nBREAKING CHANGE: Keep this');
  change(cwd, env, 'dirty.txt', 'staged');
  writeFileSync(join(cwd, 'dirty.txt'), 'working');
  const index = readFileSync(join(cwd, '.git', 'index'));
  const config = readFileSync(join(cwd, '.git', 'config'));
  const branch = git(cwd, env, ['symbolic-ref', 'HEAD']).stdout;
  const settings = join(cwd, 'committide.config.json');
  writeFileSync(settings, '{"allowedTypes":["feat"]}');
  mkdirSync(join(cwd, 'nested'));
  assert.match(invoke(join(cwd, 'nested'), env, ['changelog']).stdout, /Keep this/);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'index')), index);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'config')), config);
  assert.equal(git(cwd, env, ['symbolic-ref', 'HEAD']).stdout, branch);
  assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'working');
  writeFileSync(settings, '{"typo":true}');
  assert.match(invoke(cwd, env, ['changelog'], 2).stderr, /config-unknown/);
  const explicit = join(cwd, 'valid.json');
  writeFileSync(explicit, '{}');
  invoke(cwd, env, ['changelog', '--config', explicit]);
});

test('operational errors never produce apparently complete Markdown', () => {
  const empty = init(root, 'unborn', env);
  assert.equal(invoke(empty, env, ['changelog'], 2).stdout, '');
  assert.match(invoke(root, env, ['changelog'], 2).stderr, /git-repository/);
  assert.match(invoke(root, { ...env, PATH: '' }, ['changelog'], 2).stderr, /git-missing/);
  const cwd = init(root, 'invalid refs', env);
  const base = commit(cwd, env, 'feat: base');
  commit(cwd, env, 'fix: later');
  for (const ref of ['missing', '--all', 'HEAD..HEAD']) assert.equal(invoke(cwd, env, ['changelog', `--to=${ref}`], 2).stdout, '');
  const shallow = join(root, 'shallow');
  git(root, env, ['clone', '--depth=1', `file://${cwd.replace(/\\/g, '/')}`, shallow]);
  assert.match(invoke(shallow, env, ['changelog'], 2).stderr, /git-shallow/);
  rmSync(join(cwd, '.git', 'objects', base.slice(0, 2), base.slice(2)));
  const missing = invoke(cwd, env, ['changelog', '--write'], 2);
  assert.match(missing.stderr, /git-operation/);
  assert.equal(missing.stdout, '');
  assert.equal(existsSync(join(cwd, 'CHANGELOG.md')), false);
});
