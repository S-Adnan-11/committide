import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareGroq, requestGroq, parseGroq, GROQ_ENDPOINT, REQUEST_LIMIT, COMPLETION_LIMIT } from '../dist/groq.js';
import { SuggestCancelled } from '../dist/suggest-io.js';

const draft = { type: 'fix', scope: '', description: 'handle empty results', body: '', breaking: false, breakingDetails: '', refs: '', footers: '', uncertainty: 'Intent requires review.' };
const envelope = (data = draft) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data), reasoning: 'never display this' } }] });
const body = () => prepareGroq('+synthetic patch', ['fix']);
const withKey = async action => {
  const old = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'synthetic-test-only';
  try { await action(); } finally { if (old === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = old; }
};

test('whole-request budget includes schema, escaped patch, instructions and output allowance', () => {
  const text = body();
  const data = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) <= REQUEST_LIMIT);
  assert.equal(data.model, 'openai/gpt-oss-20b');
  assert.equal(data.max_completion_tokens, COMPLETION_LIMIT);
  assert.equal(data.include_reasoning, false);
  assert.equal(data.reasoning_effort, 'low');
  assert.equal(data.stream, false);
  assert.equal(data.n, 1);
  assert.equal(data.response_format.json_schema.strict, true);
  assert.equal(data.response_format.json_schema.schema.additionalProperties, false);
  assert.deepEqual(data.response_format.json_schema.schema.properties.type.enum, ['fix']);
  assert.deepEqual(data.response_format.json_schema.schema.required.sort(), Object.keys(draft).sort());
  assert.deepEqual(JSON.parse(data.messages[1].content), { untrusted_staged_patch: '+synthetic patch' });
  assert.equal(data.tools, undefined);
  assert.throws(() => prepareGroq('"'.repeat(3000), ['fix']), /whole serialized request/);
  assert.throws(() => prepareGroq('a', ['x'.repeat(6000)]), /whole serialized request/);
  let patch = '';
  while (Buffer.byteLength(prepareGroq(patch, ['fix'])) < REQUEST_LIMIT) patch += 'a';
  assert.equal(Buffer.byteLength(prepareGroq(patch, ['fix'])), REQUEST_LIMIT);
  assert.throws(() => prepareGroq(patch + 'a', ['fix']), /whole serialized request/);
});

test('one fixed HTTPS request, no redirect, strict schema and bounded final-only draft', async () => withKey(async () => {
  let calls = 0;
  const result = await requestGroq(body(), ['fix'], undefined, async (url, options) => {
    calls++;
    assert.equal(url, GROQ_ENDPOINT);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Authorization', 'Content-Type']);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-only');
    assert.equal(options.body, body());
    return Response.json(envelope(), { headers: { 'x-ratelimit-remaining-tokens': '7000' } });
  });
  assert.equal(calls, 1);
  assert.equal(result.draft.description, draft.description);
  assert.equal(result.draft.reasoning, undefined);
  assert.equal(result.uncertainty, draft.uncertainty);
  assert.match(result.quota, /7000/);
}));

for (const status of [400, 401, 403, 404, 429, 500, 503, 302]) {
  test(`HTTP ${status} reports safe actionable diagnostics without retry`, async () => withKey(async () => {
    let calls = 0;
    await assert.rejects(requestGroq(body(), ['fix'], undefined, async () => {
      calls++;
      return new Response('raw-response-with-sensitive-code', { status, headers: { 'retry-after': '23', 'x-ratelimit-reset-tokens': 'secret-header' } });
    }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /retry-after: 23/);
      assert.doesNotMatch(error.message, /raw-response|secret-header|synthetic-test-only/);
      return true;
    });
    assert.equal(calls, 1);
  }));
}

test('missing/malformed keys, oversized bodies and pre-cancellation make zero requests', async () => {
  const old = process.env.GROQ_API_KEY;
  let calls = 0;
  const transport = async () => { calls++; throw Error('unexpected'); };
  try {
    for (const value of [undefined, '', ' ', 'bad\nkey']) {
      if (value === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = value;
      await assert.rejects(requestGroq(body(), ['fix'], undefined, transport), /GROQ_API_KEY/);
    }
    await assert.rejects(requestGroq('a'.repeat(REQUEST_LIMIT + 1), ['fix'], undefined, transport), /budget/);
    await assert.rejects(requestGroq(body(), ['fix'], AbortSignal.abort(), transport), SuggestCancelled);
    assert.equal(calls, 0);
  } finally { if (old === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = old; }
});

test('connection errors redact raw error text and never retry', async () => withKey(async () => {
  let calls = 0;
  await assert.rejects(requestGroq(body(), ['fix'], undefined, async () => { calls++; throw Error('synthetic-test-only +private patch'); }), error => {
    assert.match(error.message, /no retry/);
    assert.doesNotMatch(error.message, /synthetic-test-only|private patch/);
    return true;
  });
  assert.equal(calls, 1);
}));

test('total deadline and explicit cancellation abort fetch with no retry', async () => withKey(async () => {
  for (const duringBody of [false, true]) {
    for (const cancel of [false, true]) {
      let calls = 0;
      let observed;
      const controller = new AbortController();
      const transport = async (_url, options) => {
        calls++; observed = options.signal;
        if (cancel) setTimeout(() => controller.abort(), 5);
        if (duringBody) return new Response(new ReadableStream({ start(stream) {
          options.signal.addEventListener('abort', () => stream.error(new Error('aborted')), { once: true });
        } }));
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      };
      await assert.rejects(requestGroq(body(), ['fix'], controller.signal, transport, 20), cancel ? SuggestCancelled : /deadline/);
      assert.equal(calls, 1);
      assert.equal(observed.aborted, true);
    }
  }
}));

test('oversized, malformed, empty, and non-UTF8 responses are refused', async () => withKey(async () => {
  for (const content of ['a'.repeat(32769), '{', '', new Uint8Array([255])]) {
    await assert.rejects(requestGroq(body(), ['fix'], undefined, async () => new Response(content)), /unusable|exceeded/);
  }
}));

test('defensive parsing rejects refusal, truncation, hidden-only output, tools and invalid fields', () => {
  const invalid = [null, {}, { choices: [null] }, { choices: [] }, { choices: [envelope().choices[0], envelope().choices[0]] },
    { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(draft) } }] },
    { choices: [{ finish_reason: 'stop', message: { refusal: 'no', content: JSON.stringify(draft) } }] },
    { choices: [{ finish_reason: 'stop', message: { tool_calls: [], content: JSON.stringify(draft) } }] },
    { choices: [{ finish_reason: 'stop', message: { reasoning: 'hidden', content: null } }] },
    envelope({ ...draft, type: 'unknown' }), envelope({ ...draft, breaking: 'false' }), envelope({ ...draft, extra: true }),
    envelope({ ...draft, description: '' }), envelope({ ...draft, description: 'a\nb' }), envelope({ ...draft, scope: '\x1b' }),
    envelope({ ...draft, body: 'a'.repeat(4097) }), envelope([]), envelope(null), envelope({ type: 'fix' })];
  for (const response of invalid) assert.throws(() => parseGroq(response, ['fix']), /unusable/);
});
