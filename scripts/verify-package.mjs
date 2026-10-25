import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// Run via npm so the same npm installation is available across Windows and POSIX.
assert.ok(process.env.npm_execpath, 'Run npm run verify:package');
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'committide-package-'));
function execute(binary, args, cwd, expected = 0, input = '') {
  const result = spawnSync(binary, args, {
    cwd, input, encoding: 'utf8', timeout: 120_000,
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
  npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive], destination);
  const manifest = JSON.parse(readFileSync(join(destination, 'node_modules', 'committide', 'package.json'), 'utf8'));
  assert.equal(manifest.bin.committide, 'dist/cli.js');
  const installedCli = join(destination, 'node_modules', 'committide', manifest.bin.committide);
  assert.match(execute(process.execPath, [installedCli, '--help'], destination).stdout, /lint/);
  assert.equal(execute(process.execPath, [installedCli, '--version'], destination).stdout.trim(), manifest.version);
  assert.equal(execute(process.execPath, [installedCli, 'lint', '--message', 'feat: installed'], destination).stdout, 'Message is valid.\n');
  assert.equal(execute(process.execPath, [installedCli, 'lint', '--message', 'invalid'], destination, 1).stdout, '');
  assert.equal(execute(process.execPath, [installedCli, 'lint'], destination, 0, 'FIX: piped\n').stderr, '');
  execute('git', ['init', '--initial-branch=main'], destination);
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
  // Exercise npm's actual platform executable shim with fixed commands.
  if (process.platform === 'win32') {
    for (const [command, code] of [
      ['node_modules\\.bin\\committide.cmd --help', 0],
      ['node_modules\\.bin\\committide.cmd --version', 0],
      ['node_modules\\.bin\\committide.cmd lint --message "feat: installed shim"', 0],
      ['node_modules\\.bin\\committide.cmd lint --message invalid', 1],
    ]) execute(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], destination, code);
  } else {
    const shim = join(destination, 'node_modules', '.bin', 'committide');
    execute(shim, ['--help'], destination);
    execute(shim, ['--version'], destination);
    execute(shim, ['lint', '--message', 'feat: installed shim'], destination);
    execute(shim, ['lint', '--message', 'invalid'], destination, 1);
  }
  console.log(`PASS: inspected ${entries.size} archive entries, installed outside source, verified lint/history/exit codes and npm executable shim on ${process.platform} ${process.version}.`);
  console.log(`Archive: ${packed.filename}; integrity: ${packed.integrity}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
