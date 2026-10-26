import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { interact } from '../test/terminal-helpers.mjs';

// Run via npm so the same npm installation is available across Windows and POSIX.
assert.ok(process.env.npm_execpath, 'Run npm run verify:package');
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'committide-package-')));
function execute(binary, args, cwd, expected = 0, input = '') {
  const result = spawnSync(binary, args, {
    cwd, input, encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'absent-global-config'),
    },
    // These cmd arguments below are fixed strings, with their quoting already supplied.
    windowsVerbatimArguments: process.platform === 'win32' && /(?:^|[\\/])cmd\.exe$/i.test(binary),
  });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${binary} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const npm = (args, cwd) => execute(process.execPath, [process.env.npm_execpath, ...args], cwd);

try {
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], source).stdout)[0];
  const archive = join(scratch, packed.filename);
  const data = gunzipSync(readFileSync(archive));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = string(0, 100);
    const size = Number.parseInt(string(124, 12).trim(), 8);
    assert.ok(Number.isSafeInteger(size));
    assert.equal(String.fromCharCode(header[156]), '0', `Unexpected tar entry ${name}`);
    assert.ok(!entries.has(name), `Duplicate tar entry ${name}`);
    entries.set(name, data.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const expected = ['package/README.md', 'package/package.json', ...readdirSync(join(source, 'dist')).filter(name => name.endsWith('.js')).map(name => `package/dist/${name}`)].sort();
  assert.deepEqual([...entries.keys()].sort(), expected);
  for (const [name, bytes] of entries) {
    // Compare every byte independently of npm's manifest, including automatic metadata.
    assert.deepEqual(bytes, readFileSync(join(source, name.slice('package/'.length))), `Archive mismatch: ${name}`);
    assert.doesNotMatch(bytes.toString('utf8'), /[A-Z]:\\Users\\|sourceMappingURL|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
  }
  assert.ok(entries.get('package/dist/cli.js').toString('utf8').startsWith('#!/usr/bin/env node\n'));
  const destination = join(scratch, 'fresh consumer with spaces');
  mkdirSync(destination);
  writeFileSync(join(destination, 'package.json'), '{"name":"package-smoke-test","private":true}');
  npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', archive], destination);
  const manifest = JSON.parse(readFileSync(join(destination, 'node_modules', 'committide', 'package.json'), 'utf8'));
  assert.equal(manifest.bin.committide, 'dist/cli.js');
  const installedCli = join(destination, 'node_modules', 'committide', manifest.bin.committide);
  assert.match(execute(process.execPath, [installedCli, 'suggest', '--help'], destination).stdout, /--output/);
  assert.match(execute(process.execPath, [installedCli, 'suggest', '--help'], destination).stdout, /--ai/);
  assert.match(execute(process.execPath, [installedCli, 'suggest'], destination, 2).stderr, /suggest-terminal/);
  assert.match(execute(process.execPath, [installedCli, '--help'], destination).stdout, /lint/);
  assert.equal(execute(process.execPath, [installedCli, '--version'], destination).stdout.trim(), manifest.version);
  assert.equal(execute(process.execPath, [installedCli, 'lint', '--message', 'feat: installed'], destination).stdout, 'Message is valid.\n');
  assert.equal(execute(process.execPath, [installedCli, 'lint', '--message', 'invalid'], destination, 1).stdout, '');
  assert.equal(execute(process.execPath, [installedCli, 'lint'], destination, 0, 'FIX: piped\n').stderr, '');
  execute('git', ['init', '--initial-branch=main'], destination);
  writeFileSync(join(destination, 'staged.txt'), 'staged example\n');
  execute('git', ['add', '--', 'staged.txt'], destination);
  writeFileSync(join(destination, 'staged.txt'), 'additional unstaged example\n');
  const aiSteps = [
    { prompt: 'Staged review:', answer: 'continue' },
    { prompt: 'Remote choice:', answer: 'local' },
    { prompt: 'Type (e.g.', answer: 'docs' },
    { prompt: 'Scope (optional', answer: '' },
    { prompt: 'Description (required', answer: 'describe installed flow' },
    { prompt: 'Review: accept', answer: 'accept' },
  ];
  aiSteps.args = ['--ai'];
  const aiLocal = await interact(installedCli, destination, { ...process.env, GROQ_API_KEY: 'synthetic-not-used' }, aiSteps);
  assert.equal(aiLocal.stdout, 'docs: describe installed flow\n');
  assert.match(aiLocal.stderr, /Groq \/ openai\/gpt-oss-20b/);
  assert.doesNotMatch(aiLocal.stderr, /Sending one request/);
  const aiDraft = { type: 'docs', scope: '', description: 'describe staged example', body: '', breaking: false, breakingDetails: '', refs: '', footers: '', uncertainty: 'Synthetic transport fixture; check semantics.' };
  const generatedSteps = [
    { prompt: 'Staged review:', answer: 'continue' },
    { prompt: 'Remote choice:', answer: 'send' },
    { prompt: 'Review: accept', answer: 'accept' },
  ];
  generatedSteps.args = ['--ai', '--output', 'ai-message.txt'];
  generatedSteps.preload = 'data:text/javascript,' + encodeURIComponent(`let count=0;globalThis.fetch=async(url,options)=>{if(++count!==1||url!=='https://api.groq.com/openai/v1/chat/completions'||options.redirect!=='error')throw Error('unexpected request');return Response.json(${JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(aiDraft) } }] })})};`);
  const generatedAI = await interact(installedCli, destination, { ...process.env, GROQ_API_KEY: 'synthetic-not-used' }, generatedSteps);
  assert.equal(generatedAI.stdout, 'docs: describe staged example\n');
  assert.equal(readFileSync(join(destination, 'ai-message.txt'), 'utf8'), generatedAI.stdout);
  assert.match(generatedAI.stderr, /AI draft received/);
  const indexBefore = readFileSync(join(destination, '.git', 'index'));
  const steps = [
    { prompt: 'Staged review:', answer: 'patch' },
    { prompt: 'Staged review:', answer: 'continue' },
    { prompt: 'Type (e.g.', answer: 'feat' },
    { prompt: 'Scope (optional', answer: '' },
    { prompt: 'Description (required', answer: 'installed writer' },
    { prompt: 'Review: accept', answer: 'accept' },
  ];
  steps.args = ['--output', 'installed-message.txt'];
  const suggestion = await interact(installedCli, destination, {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'absent-global-config'),
    OPENAI_API_KEY: 'fixture-not-a-credential', ANTHROPIC_API_KEY: 'fixture-not-a-credential',
  }, steps);
  assert.equal(suggestion.stdout, 'feat: installed writer\n');
  assert.match(suggestion.stderr, /\+staged example/);
  assert.doesNotMatch(suggestion.stderr, /\+additional unstaged/);
  assert.equal(readFileSync(join(destination, 'installed-message.txt'), 'utf8'), suggestion.stdout);
  assert.deepEqual(readFileSync(join(destination, '.git', 'index')), indexBefore);
  execute(process.execPath, [installedCli, 'lint', '--file', 'installed-message.txt'], destination);
  const makeCommit = message => execute('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', message,
  ], destination);
  makeCommit('chore: base');
  makeCommit('fix: installed history');
  assert.equal(execute(process.execPath, [installedCli, 'check', '--from', 'HEAD~1', '--to', 'HEAD'], destination).stdout, 'Checked 1; failed 0; skipped 0.\n');
  makeCommit('malformed history');
  assert.match(execute(process.execPath, [installedCli, 'check', '--from', 'HEAD~1', '--to', 'HEAD'], destination, 1).stderr, /header-format/);
  const notes = execute(process.execPath, [installedCli, 'changelog'], destination);
  assert.match(notes.stdout, /### Fixes/);
  assert.match(notes.stderr, /skipped 1/);
  assert.equal(execute(process.execPath, [installedCli, 'changelog'], destination).stdout, notes.stdout);
  assert.equal(execute(process.execPath, [installedCli, 'changelog', '--write'], destination).stdout, '');
  const changelogPath = join(destination, 'CHANGELOG.md');
  const generated = readFileSync(changelogPath, 'utf8');
  writeFileSync(changelogPath, generated + '\n## 1.0.0\n\nHandwritten release text.\n');
  execute(process.execPath, [installedCli, 'changelog', '--write'], destination);
  assert.ok(readFileSync(changelogPath, 'utf8').endsWith('Handwritten release text.\n'));
  execute(process.execPath, [installedCli, 'hooks', 'install'], destination);
  const head = execute('git', ['rev-parse', 'HEAD'], destination).stdout;
  const actualCommit = message => [
    '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', message,
  ];
  execute('git', actualCommit('malformed hook message'), destination, 1);
  assert.equal(execute('git', ['rev-parse', 'HEAD'], destination).stdout, head);
  execute('git', actualCommit('feat: installed hook'), destination);
  execute(process.execPath, [installedCli, 'hooks', 'uninstall'], destination);
  // Exercise npm's actual platform executable shim with fixed commands.
  if (process.platform === 'win32') {
    for (const [command, code] of [
      ['node_modules\\.bin\\committide.cmd --help', 0],
      ['node_modules\\.bin\\committide.cmd --version', 0],
      ['node_modules\\.bin\\committide.cmd suggest --help', 0],
      ['node_modules\\.bin\\committide.cmd suggest', 2],
      ['node_modules\\.bin\\committide.cmd lint --message "feat: installed shim"', 0],
      ['node_modules\\.bin\\committide.cmd lint --message invalid', 1],
    ]) execute(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], destination, code);
  } else {
    const shim = join(destination, 'node_modules', '.bin', 'committide');
    execute(shim, ['--help'], destination);
    execute(shim, ['--version'], destination);
    execute(shim, ['suggest', '--help'], destination);
    execute(shim, ['suggest'], destination, 2);
    execute(shim, ['lint', '--message', 'feat: installed shim'], destination);
    execute(shim, ['lint', '--message', 'invalid'], destination, 1);
  }
  console.log(`PASS: inspected ${entries.size} archive entries, installed outside source, verified lint/history/hooks/changelog/suggest/exit codes and npm executable shim on ${process.platform} ${process.version}.`);
  console.log(`Archive: ${packed.filename}; integrity: ${packed.integrity}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
