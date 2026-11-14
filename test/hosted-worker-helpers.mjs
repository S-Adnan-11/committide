import { Admission } from '../worker/index.mjs';
export const requestData = () => ({ version: 1, policy: { allowedTypes: ['docs', 'fix', 'feat'] },
  staged: { complete: true, entries: [{ status: 'A', path: 'README.md', kind: 'text', additions: 1, deletions: 0 }] }, intent: '' });
export const responseData = () => ({ version: 1, draft: { type: 'docs', scope: '', description: 'explain the staged guide',
  body: '', breaking: false, breakingDetails: '', refs: '', footers: '' }, uncertainty: 'Metadata does not establish behavior.' });

/** Serializable persistent storage fake; staged writes commit only on success. */
export function fakeStorage() {
  const values = new Map(); let tail = Promise.resolve();
  return { values, async transaction(fn) {
    const job = tail.then(async () => {
      const staged = new Map(values);
      const result = await fn({ async get(key) { await Promise.resolve(); return staged.get(key); },
        async put(key, value) { await Promise.resolve(); staged.set(key, value); } });
      values.clear(); for (const [key, value] of staged) values.set(key, value);
      return result;
    });
    tail = job.catch(() => {}); return job;
  } };
}
export function fakeEnvironment({ cap = '2', infer, storage = fakeStorage() } = {}) {
  const calls = [], names = [], burstKeys = [];
  const env = { HOSTED_ENABLED: 'true', ADMISSION_CAP: cap, MODEL: '@cf/zai-org/glm-4.7-flash',
    AI: { async run(model, input) { calls.push({ model, input }); return infer ? infer(model, input) : (model.includes('glm-') ? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(responseData()) } }] } : { response: JSON.stringify(responseData()) }); } },
    BURST: { async limit({ key }) { burstKeys.push(key); return { success: true }; } } };
  env.ADMISSION = { idFromName(name) { names.push(name); return name; },
    get() { const object = new Admission({ storage }, env); return { fetch: (url, options) => object.fetch(new Request(url, options)) }; } };
  return { env, storage, calls, names, burstKeys };
}
export function wireRequest(body = requestData(), options = {}) {
  return new Request('https://draft.committide.invalid/v1/draft', {
    method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
    body: typeof body === 'string' ? body : JSON.stringify(body), ...options,
  });
}
