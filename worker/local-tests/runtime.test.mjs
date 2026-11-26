import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse, Log, LogLevel } from 'miniflare';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const models = ['@cf/zai-org/glm-4.7-flash', '@cf/ibm-granite/granite-4.0-h-micro'];
const input = { version: 1, policy: { allowedTypes: ['docs'] }, staged: { complete: true,
  entries: [{ status: 'A', path: 'README.md', kind: 'text', additions: 1, deletions: 0 }] }, intent: '' };
const draft = { version: 1, draft: { type: 'docs', scope: '', description: 'describe the staged guide',
  body: '', breaking: false, breakingDetails: '', refs: '', footers: '' }, uncertainty: 'Only metadata is available.' };
const request = () => ({ method: 'POST', headers: { 'content-type': 'application/json',
  'CF-Connecting-IP': '192.0.2.1' }, body: JSON.stringify(input) });

// RPC stubs run inside workerd. Neither binding can reach a provider.
const fakeBindings = `import { WorkerEntrypoint } from 'cloudflare:workers';
export class FakeAI extends WorkerEntrypoint {
  async run(model, input) {
    await this.env.RECORD.fetch('http://record.invalid/', { method: 'POST', body: JSON.stringify({ model, input }) });
    if (this.env.MODE === 'egress') {
      const reply = await fetch('https://provider.invalid/inference');
      if (!reply.ok) throw new Error('Synthetic egress blocked');
    }
    if (this.env.MODE === 'fail') throw new Error('Synthetic inference failure');
    const content = JSON.stringify(${JSON.stringify(draft)});
    return model.includes('glm-') ? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }
      : { response: content };
  }
}
export class FakeBurst extends WorkerEntrypoint {
  async limit() { return { success: this.env.MODE !== 'burst-deny' }; }
}
export default { fetch() { return new Response('Local test binding', { status: 404 }); } };`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'committide-workerd-'));
  const withinTemporary = relative(resolve(tmpdir()), resolve(directory));
  assert.ok(withinTemporary && !withinTemporary.startsWith('..') && !isAbsolute(withinTemporary));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, 'worker.mjs');
  const configuration = JSON.parse(await readFile(join(root, 'worker/wrangler.jsonc'), 'utf8'));
  await build({ entryPoints: [join(root, 'worker', configuration.main)], bundle: true, format: 'esm',
    platform: 'neutral', external: ['node:*'], outfile: bundle, logLevel: 'silent' });
  await writeFile(join(directory, 'fake.mjs'), fakeBindings);
  return { directory, bundle };
}

async function start(f, { cap = '4', enabled = 'true', model = models[0], mode = 'success' } = {}) {
  const calls = [], blocked = [];
  const deny = async request => { blocked.push(new URL(request.url).hostname); return new LocalResponse('Outbound network blocked', { status: 503 }); };
  const shared = { rootPath: f.directory, modulesRoot: f.directory, modules: true, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], outboundService: deny };
  const front = name => ({ ...shared, name, scriptPath: f.bundle,
    bindings: { HOSTED_ENABLED: enabled, ADMISSION_CAP: cap, MODEL: model },
    durableObjects: { ADMISSION: { className: 'Admission', scriptName: 'draft-a', useSQLite: true } },
    serviceBindings: { AI: { name: 'fake-bindings', entrypoint: 'FakeAI' }, BURST: { name: 'fake-bindings', entrypoint: 'FakeBurst' } } });
  const mf = new Miniflare({ host: '127.0.0.1', port: 0, log: new Log(LogLevel.ERROR),
    durableObjectsPersist: join(f.directory, 'sqlite'),
    workers: [front('draft-a'), front('draft-b'), { ...shared, name: 'fake-bindings', scriptPath: join(f.directory, 'fake.mjs'),
      bindings: { MODE: mode }, serviceBindings: { RECORD: async request => {
        calls.push(await request.json()); return new LocalResponse('recorded');
      } } }] });
  try { await mf.ready; } catch (error) { await mf.dispose(); throw error; }
  const a = await mf.getWorker('draft-a'), b = await mf.getWorker('draft-b');
  return { mf, calls, blocked, send: (which = 0) => (which ? b : a).fetch('https://draft.invalid/v1/draft', request()) };
}
async function sqliteFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sqliteFiles(path));
    else if (entry.name.endsWith('.sqlite')) files.push(path);
  }
  return files;
}

test('real SQLite admission permits only four of forty concurrent requests across two Workers and survives runtime restart', async t => {
  const f = await fixture(t); let local = await start(f);
  try {
    const replies = await Promise.all(Array.from({ length: 40 }, (_, i) => local.send(i % 2)));
    assert.equal(replies.filter(r => r.status === 200).length, 4);
    assert.equal(replies.filter(r => r.status === 429).length, 36);
    assert.equal(local.calls.length, 4); assert.deepEqual(local.blocked, []);
    for (const call of local.calls) {
      assert.equal(call.model, models[0]); assert.equal(call.input.max_completion_tokens, 768);
      assert.equal(call.input.temperature, 0); assert.equal(call.input.stream, false);
      assert.equal(call.input.messages[1].content, JSON.stringify(input));
    }
  } finally { await local.mf.dispose(); }
  const files = await sqliteFiles(join(f.directory, 'sqlite')); assert.ok(files.length > 0);
  for (const path of files) assert.equal((await readFile(path)).subarray(0, 16).toString(), 'SQLite format 3\0');
  local = await start(f);
  try {
    assert.equal((await local.send()).status, 429); assert.equal(local.calls.length, 0);
    assert.deepEqual(local.blocked, []);
  } finally { await local.mf.dispose(); }
});

test('operator model changes preserve one SQLite lifetime counter across the four paired slots', async t => {
  const f = await fixture(t); const seen = [];
  for (const [model, count] of [[models[0], 1], [models[1], 2], [models[0], 1]]) {
    const local = await start(f, { model });
    try {
      for (let i = 0; i < count; i++) assert.equal((await local.send()).status, 200);
      assert.equal(local.calls.length, count); seen.push(...local.calls.map(c => c.model));
      for (const call of local.calls) assert.equal(model === models[0] ? call.input.max_completion_tokens : call.input.max_tokens, 768);
      assert.deepEqual(local.blocked, []);
    } finally { await local.mf.dispose(); }
  }
  assert.deepEqual(seen, [models[0], models[1], models[1], models[0]]);
  const local = await start(f, { model: models[1] });
  try { assert.equal((await local.send()).status, 429); assert.equal(local.calls.length, 0); }
  finally { await local.mf.dispose(); }
});

test('disabled Worker reserves nothing; enabling the same SQLite storage retains the full allowance', async t => {
  const f = await fixture(t); let local = await start(f, { cap: '1', enabled: 'false' });
  try { assert.equal((await local.send()).status, 503); assert.equal(local.calls.length, 0); assert.deepEqual(local.blocked, []); }
  finally { await local.mf.dispose(); }
  local = await start(f, { cap: '1' });
  try {
    assert.equal((await local.send()).status, 200); assert.equal((await local.send()).status, 429);
    assert.equal(local.calls.length, 1); assert.deepEqual(local.blocked, []);
  } finally { await local.mf.dispose(); }
});

test('failed inference consumes SQLite admission without refund after restart', async t => {
  const f = await fixture(t); let local = await start(f, { cap: '1', mode: 'fail' });
  try {
    const reply = await local.send(); assert.equal(reply.status, 503);
    assert.doesNotMatch(await reply.text(), /Synthetic/); assert.equal(local.calls.length, 1);
    assert.equal((await local.send()).status, 429); assert.equal(local.calls.length, 1);
  } finally { await local.mf.dispose(); }
  local = await start(f, { cap: '1' });
  try { assert.equal((await local.send()).status, 429); assert.equal(local.calls.length, 0); }
  finally { await local.mf.dispose(); }
});

test('all Worker outbound fetches are intercepted locally, including a fake provider attempt', async t => {
  const f = await fixture(t); const local = await start(f, { cap: '1', mode: 'egress' });
  try {
    assert.equal((await local.send()).status, 503); assert.deepEqual(local.blocked, ['provider.invalid']);
    assert.equal(local.calls.length, 1); assert.equal((await local.send()).status, 429);
  } finally { await local.mf.dispose(); }
});

test('fake burst refusal does not consume persistent admission', async t => {
  const f = await fixture(t); let local = await start(f, { cap: '1', mode: 'burst-deny' });
  try { assert.equal((await local.send()).status, 429); assert.equal(local.calls.length, 0); }
  finally { await local.mf.dispose(); }
  local = await start(f, { cap: '1' });
  try { assert.equal((await local.send()).status, 200); assert.equal(local.calls.length, 1); }
  finally { await local.mf.dispose(); }
});
