import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { environment, init, change, git } from './git-helpers.mjs';
import { interact } from './terminal-helpers.mjs';
import { mockGroqPreload, outgoingPreview } from './commit-ai-helpers.mjs';

/** Reused against source and a fresh archive installation; all transport is mocked. */
export async function verifyCommitAI(entry, root) {
  const fixtures = [
    { name: 'offline-default', calls: 0, args: [], answers: ['continue', 'commit'] },
    { name: 'declined', calls: 0, answers: ['continue', 'metadata', '', 'local', 'cancel'], exit: 130 },
    { name: 'missing-key', calls: 0, absentKey: true, answers: ['continue', 'metadata', '', 'send', 'commit'] },
    { name: 'approved', answers: ['continue', 'metadata', 'Explain setup', 'send', '', 'edit', 'description', 'explain reviewed setup', 'commit'] },
    { name: 'selected-hunks', answers: ['continue', 'hunks', '', '1', 'send', 'cancel'], exit: 130 },
    { name: 'malformed', mode: 'malformed', answers: ['continue', 'metadata', '', 'send', 'commit'] },
    { name: 'provider-failure', mode: 'http', answers: ['continue', 'metadata', '', 'send', 'commit'] },
    { name: 'deadline', mode: 'timeout', answers: ['continue', 'metadata', '', 'send', 'commit'] },
    { name: 'cancel-waiting', mode: 'pending', answers: ['continue', 'metadata', '', 'send', '\x03'], exit: 130 },
    { name: 'stale-at-send', calls: 0, stale: true, answers: ['continue', 'metadata', '', 'send', 'cancel'], exit: 130 },
  ];
  const records = [];
  for (const fixture of fixtures) {
    const env = { ...environment(root), GROQ_API_KEY: 'synthetic-commit-ai' }; if (fixture.absentKey) delete env.GROQ_API_KEY;
    const cwd = init(root, fixture.name, env);
    change(cwd, env, 'README.md', 'staged guide\n'); writeFileSync(join(cwd, 'README.md'), 'unstaged marker\n');
    writeFileSync(join(cwd, 'scratch.txt'), 'untracked marker\n');
    const prompts = fixture.name === 'offline-default' ? ['Staged review:', 'Review: commit']
      : ['Staged review:', 'AI context:', 'AI intent hint', ...(fixture.name === 'selected-hunks' ? ['Entry numbers'] : []), 'Groq choice:',
        ...(fixture.name === 'approved' ? ['Review: commit', 'Review: commit', 'Field:', 'Description (required', 'Review: commit']
          : fixture.mode === 'pending' ? ['Mock Groq waiting:'] : ['Review: commit'])];
    assert.equal(prompts.length, fixture.answers.length, fixture.name);
    const steps = prompts.map((prompt, index) => ({ prompt, answer: () => {
      if (prompt.startsWith('Review:')) assert.equal(git(cwd, env, ['rev-parse', '--verify', '--quiet', 'HEAD'], null).status, 1, 'No commit before final confirmation');
      if (fixture.stale && prompt === 'Groq choice:') change(cwd, env, 'README.md', 'changed staged guide\n');
      return fixture.answers[index];
    } }));
    steps.command = 'commit'; steps.args = fixture.args ?? ['--ai']; steps.preload = mockGroqPreload({ mode: fixture.mode, calls: fixture.calls ?? 1 });
    const result = await interact(entry, cwd, env, steps, fixture.exit ?? 0);
    const committed = (fixture.exit ?? 0) === 0;
    assert.equal(readFileSync(join(cwd, 'scratch.txt'), 'utf8'), 'untracked marker\n');
    assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), fixture.stale ? 'changed staged guide\n' : 'unstaged marker\n');
    if (committed) {
      assert.equal(git(cwd, env, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
      assert.equal(git(cwd, env, ['ls-tree', '--name-only', 'HEAD']).stdout.trim(), 'README.md');
      assert.equal(git(cwd, env, ['log', '-1', '--format=%s']).stdout.trim(), fixture.name === 'approved' ? 'docs: explain reviewed setup' : 'docs: add README.md');
    } else {
      assert.equal(git(cwd, env, ['rev-parse', '--verify', '--quiet', 'HEAD'], null).status, 1);
      assert.equal(result.stdout, '');
    }
    if ((fixture.calls ?? 1) === 1) {
      const body = readFileSync(join(cwd, 'mock-request.json'), 'utf8'); assert.equal(body, outgoingPreview(result.stderr));
      const context = JSON.parse(JSON.parse(body).messages[1].content).untrusted_staged_context;
      if (fixture.name === 'selected-hunks') { assert.match(context.hunks[0].patch, /\+staged guide/); }
      else { assert.equal(context.hunks, undefined); assert.doesNotMatch(body, /staged guide/); }
      assert.doesNotMatch(body, /unstaged marker|untracked marker/);
    } else assert.equal(existsSync(join(cwd, 'mock-request.json')), false);
    if (fixture.name === 'deadline') assert.match(result.stderr, /request deadline/);
    if (fixture.name === 'stale-at-send') assert.match(result.stderr, /Previous draft and confirmation are discarded/);
    if (fixture.name === 'missing-key') assert.match(result.stderr, /credentials are unavailable/);
    assert.doesNotMatch(result.stderr, /Bearer synthetic-commit-ai|fictional failure/);
    records.push({ name: fixture.name, exit: fixture.exit ?? 0, committed, requests: fixture.calls ?? 1, pass: true });
  }
  return records;
}
