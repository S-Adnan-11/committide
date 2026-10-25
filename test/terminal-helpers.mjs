import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Deterministic stream tests simulate the terminal flags; they are not a real PTY.
export async function interact(entry, cwd, env, steps, expected = 0) {
  const bootstrap = 'data:text/javascript,' + encodeURIComponent("Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stderr,'isTTY',{value:true});");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', bootstrap, entry, 'suggest', ...(steps.args ?? [])], {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', pending = '';
    let index = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out at step ${index}: ${stderr}`)); }, 45_000);
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => {
      const text = data.toString();
      stderr += text; pending += text;
      const step = steps[index];
      if (step && pending.includes(step.prompt)) {
        index++; pending = '';
        try {
          const answer = typeof step.answer === 'function' ? step.answer(child) : step.answer;
          if (answer === null) child.stdin.end();
          else child.stdin.write(answer + (answer === '\x03' ? '' : '\n'));
        } catch (error) { child.kill(); reject(error); }
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(code, expected, `${stdout}\n${stderr}\nsignal=${signal}`);
        assert.equal(index, steps.length, `Unvisited steps: ${stderr}`);
        resolve({ stdout, stderr });
      } catch (error) { reject(error); }
    });
  });
}
