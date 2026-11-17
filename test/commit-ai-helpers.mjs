export const aiDraft = { type: 'docs', scope: '', description: 'explain the staged guide', body: '', breaking: false,
  breakingDetails: '', refs: '', footers: '', uncertainty: 'Fictional response; review against the disclosed input.' };

export function outgoingPreview(review) {
  const match = /--- outgoing JSON ---\n([^\n]+)\n--- end outgoing JSON ---/.exec(review);
  if (!match) throw new Error('No complete outgoing JSON preview');
  return match[1];
}

// Test-only injection. It never delegates to fetch or uses a real credential.
export function mockGroqPreload({ mode = 'ok', draft = aiDraft, calls = 1 } = {}) {
  const code = String.raw`import assert from 'node:assert/strict';import{writeFileSync}from'node:fs';
const mode=${JSON.stringify(mode)},draft=${JSON.stringify(draft)};let count=0;
process.on('exit',()=>{assert.equal(count,${calls},'Unexpected mock request count')});
if(mode==='timeout'){const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===30000&&new Error().stack.split('\n').slice(2).some(line=>/\/groq\.js:\d+:\d+\)?$/.test(line))?20:ms,...args)}
globalThis.fetch=async(url,options)=>{count++;assert.equal(count,1);assert.equal(url,'https://api.groq.com/openai/v1/chat/completions');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-commit-ai');writeFileSync('mock-request.json',options.body);
if(mode==='pending')process.stderr.write('Mock Groq waiting:\n');
if(mode==='pending'||mode==='timeout')return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new DOMException('Synthetic cancellation','AbortError')),{once:true})});
if(mode==='http')return Response.json({error:'fictional failure'},{status:429});
return Response.json({choices:[{finish_reason:'stop',message:{content:mode==='malformed'?'{}':JSON.stringify(draft)}}]});};`;
  return 'data:text/javascript,' + encodeURIComponent(code);
}
