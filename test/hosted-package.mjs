import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { environment, init, change, git } from './git-helpers.mjs';
import { interact } from './terminal-helpers.mjs';
import { outgoingPreview } from './commit-ai-helpers.mjs';

function preload({ mode = 'ok', requests = 1, inference = 1 } = {}) {
  const code = String.raw`import assert from 'node:assert/strict';import{writeFileSync}from'node:fs';import{spawnSync}from'node:child_process';
import worker from ${JSON.stringify(new URL('../worker/index.mjs', import.meta.url).href)};
import{fakeEnvironment,responseData}from ${JSON.stringify(new URL('./hosted-worker-helpers.mjs', import.meta.url).href)};
const mode=${JSON.stringify(mode)},f=fakeEnvironment();let count=0;
process.on('exit',()=>{writeFileSync('mock-observation.json',JSON.stringify({requests:count,inference:f.calls.length,admitted:f.storage.values.get('admitted')??0}));assert.equal(count,${requests});assert.equal(f.calls.length,${inference})});
if(mode==='quota')f.storage.values.set('admitted',2);
if(mode==='disabled')f.env.HOSTED_ENABLED='false';
if(mode==='malformed')f.env.AI.run=async(model,input)=>{f.calls.push({model,input});return{choices:[{finish_reason:'stop',message:{role:'assistant',content:'{}'}}]}};
if(mode==='service')f.env.AI.run=async(model,input)=>{f.calls.push({model,input});throw Error('synthetic private service detail')};
if(mode==='pending'||mode==='timeout'){
 const original=globalThis.setTimeout;let expire;globalThis.setTimeout=(fn,ms,...args)=>{
 const stack=new Error().stack.split('\n').slice(2);
 if(mode==='timeout'&&ms===15000&&stack.some(line=>/\/provider\.js:\d+:\d+\)?$/.test(line)))expire=fn;
 const timer=original(fn,ms,...args);
 if(stack.some(line=>/\/worker\/index\.mjs:\d+:\d+\)?$/.test(line)))timer.unref();return timer};
 f.env.AI.run=async(model,input)=>{f.calls.push({model,input});if(mode==='timeout')original(expire,20);process.stderr.write('Fake inference waiting:\n');return new Promise(()=>{})};
}
globalThis.fetch=async(url,options)=>{
 assert.equal(++count,1);assert.equal(url,'https://draft.committide.invalid/v1/draft');
 assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');
 assert.deepEqual(options.headers,{'Content-Type':'application/json'});
 writeFileSync('mock-request.json',options.body);
 if(mode==='stale-reply'){writeFileSync('README.md','changed staged guide\n');assert.equal(spawnSync('git',['add','--','README.md'],{encoding:'utf8'}).status,0)}
 if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://other.invalid'}});
 if(mode==='wrong-media')return new Response(JSON.stringify(responseData()),{headers:{'content-type':'text/html'}});
 if(mode==='oversized')return new Response('x'.repeat(4097),{headers:{'content-type':'application/json'}});
 const request=new Request(url,{...options,headers:{...options.headers,'CF-Connecting-IP':'192.0.2.1'}});
 return worker.fetch(request,f.env);
};`;
  return 'data:text/javascript,' + encodeURIComponent(code);
}

/** Same executable scenarios against built source and a fresh npm archive. No real inference. */
export async function verifyHosted(entry, root) {
  const fixtures = [
    { name: 'hosted-offline-default', args: [], requests: 0, inference: 0, answers: ['continue', 'commit'] },
    { name: 'hosted-declined', requests: 0, inference: 0, answers: ['continue', '', 'local', 'commit'] },
    { name: 'hosted-empty-choice', requests: 0, inference: 0, answers: ['continue', '', '', 'commit'] },
    { name: 'hosted-approved', answers: ['continue', 'Explain setup', 'send', '', 'edit', 'description', 'explain reviewed setup', 'commit'] },
    ...['quota', 'disabled', 'service', 'malformed', 'redirect', 'wrong-media', 'oversized', 'timeout'].map(mode => ({
      name: 'hosted-' + mode, mode, inference: ['quota', 'disabled', 'redirect', 'wrong-media', 'oversized'].includes(mode) ? 0 : 1,
      answers: ['continue', '', 'send', 'commit'],
    })),
    { name: 'hosted-cancel-waiting', mode: 'pending', answers: ['continue', '', 'send', '\x03'], exit: 130 },
    { name: 'hosted-stale-at-send', stale: true, requests: 0, inference: 0, answers: ['continue', '', 'send', 'cancel'], exit: 130 },
    { name: 'hosted-stale-reply', mode: 'stale-reply', answers: ['continue', '', 'send', 'cancel'], exit: 130 },
    { name: 'hosted-sensitive', sensitive: true, requests: 0, inference: 0, answers: ['continue', 'password=fictional-only-secret', 'commit'] },
  ];
  const records = [];
  for (const fixture of fixtures) {
    const env = { ...environment(root) }; delete env.GROQ_API_KEY; delete env.OPENAI_API_KEY; delete env.CLOUDFLARE_API_TOKEN;
    const cwd = init(root, fixture.name, env);
    change(cwd, env, 'README.md', 'staged guide\n'); writeFileSync(join(cwd, 'README.md'), 'unstaged marker\n');
    writeFileSync(join(cwd, 'scratch.txt'), 'untracked marker\n');
    const prompts = fixture.args ? ['Staged review:', 'Review: commit']
      : ['Staged review:', 'Hosted intent hint', ...(fixture.sensitive ? [] : ['Hosted choice:']),
        ...(fixture.name === 'hosted-approved' ? ['Review: commit', 'Review: commit', 'Field:', 'Description (required', 'Review: commit']
          : fixture.mode === 'pending' ? ['Fake inference waiting:'] : ['Review: commit'])];
    assert.equal(prompts.length, fixture.answers.length, fixture.name);
    const steps = prompts.map((prompt, i) => ({ prompt, answer: () => {
      if (prompt.startsWith('Review:')) assert.equal(git(cwd, env, ['rev-parse', '--verify', '--quiet', 'HEAD'], null).status, 1, 'No commit before final confirmation');
      if (prompt === 'Hosted choice:') {
        assert.equal(existsSync(join(cwd, 'mock-request.json')), false, 'No send before explicit consent');
        if (fixture.stale) change(cwd, env, 'README.md', 'changed staged guide\n');
      }
      return fixture.answers[i];
    } }));
    steps.command = 'commit'; steps.args = fixture.args ?? ['--hosted']; steps.preload = preload(fixture);
    const result = await interact(entry, cwd, env, steps, fixture.exit ?? 0);
    const committed = (fixture.exit ?? 0) === 0;
    assert.equal(readFileSync(join(cwd, 'scratch.txt'), 'utf8'), 'untracked marker\n');
    assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'),
      fixture.stale || fixture.mode === 'stale-reply' ? 'changed staged guide\n' : 'unstaged marker\n');
    if (committed) {
      assert.equal(git(cwd, env, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
      assert.equal(git(cwd, env, ['ls-tree', '--name-only', 'HEAD']).stdout.trim(), 'README.md');
      assert.equal(git(cwd, env, ['log', '-1', '--format=%s']).stdout.trim(),
        fixture.name === 'hosted-approved' ? 'docs: explain reviewed setup' : 'docs: add README.md');
    } else assert.equal(git(cwd, env, ['rev-parse', '--verify', '--quiet', 'HEAD'], null).status, 1);
    const observation = JSON.parse(readFileSync(join(cwd, 'mock-observation.json'), 'utf8'));
    assert.equal(observation.requests, fixture.requests ?? 1, fixture.name + ' request count'); assert.equal(observation.inference, fixture.inference ?? 1, fixture.name + ' inference count');
    if ((fixture.requests ?? 1) === 1) {
      const body = readFileSync(join(cwd, 'mock-request.json'), 'utf8');
      assert.equal(body, outgoingPreview(result.stderr));
      assert.deepEqual(readFileSync(join(cwd, 'mock-request.json')), Buffer.from(outgoingPreview(result.stderr), 'utf8'));
      const context = JSON.parse(body);
      assert.equal(context.hunks, undefined); assert.equal(context.model, undefined); assert.equal(context.prompt, undefined);
      assert.doesNotMatch(body, /staged guide|unstaged marker|untracked marker|scratch.txt|Authorization|api.key/i);
    } else assert.equal(existsSync(join(cwd, 'mock-request.json')), false);
    if (fixture.mode && !['pending', 'stale-reply'].includes(fixture.mode)) assert.match(result.stderr, /Hosted drafting unavailable/);
    if (fixture.stale || fixture.mode === 'stale-reply') assert.match(result.stderr, /Previous draft and confirmation are discarded/);
    assert.doesNotMatch(result.stderr, /synthetic private service detail/);
    if (fixture.sensitive) assert.doesNotMatch(result.stderr.split('Hosted drafting unavailable')[1], /password=fictional-only-secret/);
    records.push({ name: fixture.name, committed, ...observation, exit: fixture.exit ?? 0, pass: true });
  }
  return records;
}
