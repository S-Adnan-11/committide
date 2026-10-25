import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync, rmdirSync, symlinkSync, linkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { prepareChangelogFile, replaceManagedContent } from '../dist/changelog-file.js';
import { START_MARKER as start, END_MARKER as end } from '../dist/changelog.js';
import { environment, init, git, invoke, commit, change } from './git-helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'committide-write-'));
const env = environment(root);
after(() => rmSync(root, { recursive: true, force: true }));
const document = content => `# Changelog\n\n## Unreleased\n\nHandwritten notes.\n\n${start}\n${content}\n${end}\n\n## 1.0.0\n\nHistorical notes.\n`;
function target(name, content) {
  const folder = join(root, name);
  mkdirSync(folder);
  const path = join(folder, 'CHANGELOG.md');
  if (content !== undefined) writeFileSync(path, content);
  return { folder, path };
}
const rejectsRule = (operation, rule) => assert.rejects(operation, error => error.rule === rule);

test('creates a complete scaffold and repeat writes do not rewrite the file', async () => {
  const { path, folder } = target('new');
  assert.equal(await (await prepareChangelogFile(path)).write('### Features\n\n- Hello'), 'created');
  const bytes = readFileSync(path);
  assert.ok(bytes.toString().startsWith('# Changelog\n\n## Unreleased'));
  const before = statSync(path, { bigint: true });
  assert.equal(await (await prepareChangelogFile(path)).write('### Features\n\n- Hello'), 'unchanged');
  assert.deepEqual(readFileSync(path), bytes);
  const after = statSync(path, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(readdirSync(folder), ['CHANGELOG.md']);
});

test('preserves BOM, CRLF, all outside bytes, and previous release sections', async () => {
  const original = Buffer.from('\uFEFF' + document('old generated text').replace(/\n/g, '\r\n'));
  const { path } = target('crlf', original);
  const content = '### Breaking Changes\n\n- New café\n  Multiline detail';
  assert.equal(await (await prepareChangelogFile(path)).write(content), 'updated');
  const actual = readFileSync(path);
  const beginning = original.indexOf(Buffer.from(start)) + Buffer.byteLength(start + '\r\n');
  const ending = original.indexOf(Buffer.from(end));
  assert.deepEqual(actual, Buffer.concat([original.subarray(0, beginning), Buffer.from(content.replace(/\n/g, '\r\n') + '\r\n'), original.subarray(ending)]));
});

test('fenced, indented, and HTML-comment marker examples do not establish ownership', () => {
  const examples = `# Changelog\n\n~~~md\n## Unreleased\n${start}\n${end}\n~~~\n\n    ## Unreleased\n    ${start}\n    ${end}\n\n<!-- example\n## Unreleased\n${start}\n\n`;
  const original = Buffer.from(examples + document('old'));
  const changed = replaceManagedContent(original, 'new');
  assert.ok(changed.toString().startsWith(examples));
  assert.ok(changed.toString().includes(`${start}\nnew\n${end}`));
  assert.throws(() => replaceManagedContent(Buffer.from(examples), 'new'), /Existing file was not changed/);
});

test('supports an unambiguous linked Unreleased heading with standalone markers', () => {
  const original = Buffer.from(document('old').replace('## Unreleased', '## [Unreleased](https://example.invalid/compare)'));
  assert.match(replaceManagedContent(original, 'new').toString(), /\nnew\n/);
});

for (const [name, content] of [
  ['missing markers', '# Changelog\n\n## Unreleased\nKeep notes\n'],
  ['empty existing file', ''],
  ['missing end', document('old').replace(end, '')],
  ['reversed', `## Unreleased\n${end}\nold\n${start}\n`],
  ['duplicate start', document('old').replace(start, `${start}\n${start}`)],
  ['duplicate Unreleased', document('old') + '\n## [Unreleased]\n'],
  ['setext heading', `Unreleased\n----------\n${start}\nold\n${end}\n`],
  ['markers before section', `${start}\nold\n${end}\n\n## Unreleased\n`],
  ['markers under release', `## Unreleased\n\n## 1.0.0\n${start}\nold\n${end}\n`],
  ['inline example', `## Unreleased\nExample ${start}\nold\n${end}\n`],
  ['fenced ownership', `## Unreleased\n\n\x60\x60\x60\n${start}\nold\n${end}\n\x60\x60\x60\n`],
  ['HTML ownership', `## Unreleased\n\n<div>\n${start}\nold\n${end}\n</div>\n`],
  ['HTML section heading', `<div>\n<h2>Unreleased</h2>\n</div>\n\n${document('old')}`],
  ['heading with inline comment', `${document('old')}\n## Unreleased <!-- alternate -->\n`],
]) {
  test(`refuses unsafe initialization: ${name}`, async () => {
    const { path, folder } = target(name, content);
    const before = readFileSync(path);
    await rejectsRule((await prepareChangelogFile(path)).write('replacement'), 'changelog-layout');
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(readdirSync(folder), ['CHANGELOG.md']);
  });
}

test('invalid UTF-8 is refused without recoding outside content', async () => {
  const { path } = target('invalid UTF8', Buffer.concat([Buffer.from(document('old')), Buffer.from([0xff])]));
  const bytes = readFileSync(path);
  await rejectsRule((await prepareChangelogFile(path)).write('new'), 'changelog-encoding');
  assert.deepEqual(readFileSync(path), bytes);
});

test('changed original snapshots are detected before publication', async () => {
  const { path, folder } = target('changed snapshot', document('old'));
  const pending = await prepareChangelogFile(path);
  writeFileSync(path, document('external handwritten change'));
  const external = readFileSync(path);
  await rejectsRule(pending.write('generated'), 'changelog-changed');
  assert.deepEqual(readFileSync(path), external);
  assert.deepEqual(readdirSync(folder), ['CHANGELOG.md']);
});

test('an edit while the candidate is prepared is detected by the final snapshot check', async () => {
  const { path, folder } = target('edit while writing', document('old'));
  const external = Buffer.from(document('external edit'));
  const io = { ...fs, open: async (...args) => {
    const file = await fs.open(...args);
    if (String(args[0]).endsWith('.tmp')) {
      const originalWrite = file.writeFile.bind(file);
      file.writeFile = async (...values) => { await originalWrite(...values); await fs.writeFile(path, external); };
    }
    return file;
  } };
  await rejectsRule((await prepareChangelogFile(path, io)).write('generated'), 'changelog-changed');
  assert.deepEqual(readFileSync(path), external);
  assert.deepEqual(readdirSync(folder), ['CHANGELOG.md']);
});

test('a destination appearing at new-file publication is never overwritten', async () => {
  const { path, folder } = target('creation race');
  const io = { ...fs, link: async (prepared, destination) => {
    await fs.writeFile(destination, 'external creation', { flag: 'wx' });
    return fs.link(prepared, destination);
  } };
  await rejectsRule((await prepareChangelogFile(path, io)).write('generated'), 'changelog-write');
  assert.equal(readFileSync(path, 'utf8'), 'external creation');
  assert.deepEqual(readdirSync(folder), ['CHANGELOG.md']);
});

test('concurrent cooperative writers cannot overwrite each other', async () => {
  const { path, folder } = target('concurrent writers', document('old'));
  const first = await prepareChangelogFile(path);
  const second = await prepareChangelogFile(path);
  const results = await Promise.allSettled([first.write('first writer'), second.write('second writer')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected').reason;
  assert.ok(['changelog-busy', 'changelog-changed'].includes(failure.rule));
  assert.match(readFileSync(path, 'utf8'), /first writer|second writer/);
  assert.deepEqual(readdirSync(folder), ['CHANGELOG.md']);
});

for (const action of ['write', 'replace', 'create']) {
  test(`simulated ${action} failure preserves original bytes and cleans owned temporary files`, async () => {
    const { path, folder } = target(`failure-${action}`, action === 'create' ? undefined : document('old'));
    const before = existsSync(path) ? readFileSync(path) : null;
    const io = { ...fs };
    if (action === 'replace') io.rename = async () => { throw new Error('simulated replacement failure'); };
    if (action === 'create') io.link = async () => { throw new Error('simulated publication failure'); };
    if (action === 'write') io.open = async (...args) => {
      const file = await fs.open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const partialWrite = file.writeFile.bind(file);
        file.writeFile = async () => { await partialWrite('partial candidate'); throw new Error('simulated write failure'); };
      }
      return file;
    };
    await rejectsRule((await prepareChangelogFile(path, io)).write('new'), 'changelog-write');
    if (before) assert.deepEqual(readFileSync(path), before);
    else assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(folder), before ? ['CHANGELOG.md'] : []);
  });
}

test('unsafe directories, parent junctions, and hard-linked targets are refused', async () => {
  const { path } = target('unsafe paths');
  mkdirSync(path);
  await rejectsRule(prepareChangelogFile(path), 'changelog-path');
  rmdirSync(path);
  const outside = join(root, 'outside.md');
  writeFileSync(outside, document('outside'));
  linkSync(outside, path);
  await rejectsRule(prepareChangelogFile(path), 'changelog-path');
  const parent = join(root, 'linked parent');
  symlinkSync(join(root, 'unsafe paths'), parent, process.platform === 'win32' ? 'junction' : 'dir');
  await rejectsRule(prepareChangelogFile(join(parent, 'CHANGELOG.md')), 'changelog-path');
  assert.equal(readFileSync(outside, 'utf8'), document('outside'));
});

test('file symlink targets are refused when the host permits creating the fixture', async context => {
  const { path } = target('file symlink');
  const outside = join(root, 'symlink original.md');
  writeFileSync(outside, document('outside'));
  try { symlinkSync(outside, path, 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      context.skip('Windows file-symlink fixture needs Developer Mode or symlink creation privilege.');
      return;
    }
    throw error;
  }
  await rejectsRule(prepareChangelogFile(path), 'changelog-path');
  assert.equal(readFileSync(outside, 'utf8'), document('outside'));
});

test('CLI writes at repository root from a subdirectory and preserves unrelated Git state', () => {
  const cwd = init(root, 'CLI write', env);
  commit(cwd, env, 'feat: feature');
  commit(cwd, env, 'fix: correction');
  commit(cwd, env, 'chore: maintenance');
  commit(cwd, env, 'custom: API change\n\nBREAKING CHANGE: Migrate settings');
  change(cwd, env, 'dirty.txt', 'staged');
  writeFileSync(join(cwd, 'dirty.txt'), 'working');
  const index = readFileSync(join(cwd, '.git', 'index'));
  const config = readFileSync(join(cwd, '.git', 'config'));
  const branch = git(cwd, env, ['symbolic-ref', 'HEAD']).stdout;
  const hooks = readdirSync(join(cwd, '.git', 'hooks'));
  const nested = join(cwd, 'nested');
  mkdirSync(nested);
  const first = invoke(nested, env, ['changelog', '--write']);
  assert.equal(first.stdout, '');
  assert.match(first.stderr, /Changelog created/);
  const path = join(cwd, 'CHANGELOG.md');
  assert.equal(existsSync(join(nested, 'CHANGELOG.md')), false);
  let text = readFileSync(path, 'utf8');
  assert.match(text, /### Breaking Changes/);
  text = text.replace('## Unreleased\n', '## Unreleased\n\nManual roadmap note.\n') + '\n## 1.0.0\n\nPrevious release prose.\n';
  writeFileSync(path, text);
  invoke(nested, env, ['changelog', '--write', '--include-maintenance']);
  const updated = readFileSync(path);
  assert.match(updated.toString(), /Manual roadmap note/);
  assert.match(updated.toString(), /Previous release prose/);
  assert.match(updated.toString(), /### Maintenance/);
  const mtime = statSync(path, { bigint: true }).mtimeNs;
  assert.match(invoke(nested, env, ['changelog', '--write', '--include-maintenance']).stderr, /Changelog unchanged/);
  assert.equal(statSync(path, { bigint: true }).mtimeNs, mtime);
  assert.equal(invoke(nested, env, ['changelog', '--write', '--to', 'missing'], 2).stdout, '');
  assert.deepEqual(readFileSync(path), updated);
  writeFileSync(path, '# Existing unowned document\n');
  assert.match(invoke(nested, env, ['changelog', '--write'], 2).stderr, /changelog-layout/);
  assert.equal(readFileSync(path, 'utf8'), '# Existing unowned document\n');
  assert.deepEqual(readFileSync(join(cwd, '.git', 'index')), index);
  assert.deepEqual(readFileSync(join(cwd, '.git', 'config')), config);
  assert.equal(git(cwd, env, ['symbolic-ref', 'HEAD']).stdout, branch);
  assert.deepEqual(readdirSync(join(cwd, '.git', 'hooks')), hooks);
  assert.equal(readFileSync(join(cwd, 'dirty.txt'), 'utf8'), 'working');
  mkdirSync(`${path}.committide-lock`);
  writeFileSync(path, document('old'));
  assert.match(invoke(nested, env, ['changelog', '--write'], 2).stderr, /changelog-busy/);
  const bare = join(root, 'write-bare.git');
  git(root, env, ['init', '--bare', bare]);
  assert.match(invoke(bare, env, ['changelog', '--write'], 2).stderr, /non-bare/);
  assert.equal(existsSync(join(bare, 'CHANGELOG.md')), false);
});
