import handler, { Admission as DraftAdmission } from './index.mjs';

const response = (status, value) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

// The public handler never exposes the internal admission route or stored payloads.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/status') return handler.fetch(request, env);
    if (request.method !== 'GET' || url.search || request.headers.has('authorization') || request.headers.has('cookie')) {
      return response(404, { version: 1, error: 'route' });
    }
    if (!env.ADMISSION) return response(503, { version: 1, error: 'admission' });
    try {
      return await env.ADMISSION.get(env.ADMISSION.idFromName('hosted-draft-v1'))
        .fetch('https://admission.invalid/status');
    } catch { return response(503, { version: 1, error: 'admission' }); }
  },
};

// Readiness can inspect the existing KV counter without reserving a slot.
// Cloudflare Data Studio currently cannot read this KV API value.
export class Admission extends DraftAdmission {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/status' || url.search) return super.fetch(request);
    try {
      const stored = await this.storage.get('admitted');
      const admittedCount = stored === undefined ? 0 : stored;
      if (!Number.isSafeInteger(admittedCount) || admittedCount < 0) throw new Error('Invalid counter');
      return response(200, { version: 1, admittedCount });
    } catch { return response(503, { version: 1, error: 'admission' }); }
  }
}
