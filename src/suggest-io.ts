import { createInterface } from 'node:readline';
import { OperationalError } from './errors.js';

export class SuggestCancelled extends Error {
  constructor() { super('Cancelled; no message emitted.'); }
}

export class CommitCancelled extends Error {
  constructor() { super('Cancelled before Git commit.'); }
}

export interface SuggestIO {
  signal?: AbortSignal;
  ask(prompt: string): Promise<string>;
  review(text: string): void;
  check(): void;
}

/** The terminal is opened only for this explicit interactive command. */
export function terminalIO(command: 'suggest' | 'commit' = 'suggest'): SuggestIO & { close(): void; handoff(): void } {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new OperationalError(`${command}-terminal`, command === 'suggest'
      ? 'suggest requires interactive stdin and stderr terminals. Run it in a terminal; use --output PATH to save an accepted message. Piped answers are not supported.'
      : 'commit requires interactive stdin and stderr terminals. Run in a terminal to review and explicitly confirm. Piped answers are not supported.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true, historySize: 0 });
  const queue: string[] = [];
  const controller = new AbortController();
  let failure: Error | undefined;
  let handedOff = false;
  let waiting: { resolve(value: string): void; reject(error: Error): void } | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    controller.abort();
    waiting?.reject(failure);
    waiting = undefined;
    rl.close();
  };
  const cancelled = () => command === 'suggest' ? new SuggestCancelled() : new CommitCancelled();
  const cancel = () => stop(cancelled());
  const inputError = () => stop(new OperationalError(`${command}-input`, 'Terminal input failed. Retry in a working interactive terminal.'));
  rl.on('SIGINT', cancel);
  process.on('SIGINT', cancel);
  process.stdin.on('error', inputError);
  rl.on('close', () => {
    if (handedOff) return;
    failure ??= cancelled();
    controller.abort();
    waiting?.reject(failure);
    waiting = undefined;
  });
  rl.on('line', (line: string) => {
    if (line.length > 16_384 || queue.length >= 64) {
      stop(new OperationalError(`${command}-input`, 'Terminal input is too large. Use shorter fields (up to 16384 characters per line).'));
    } else if (waiting) {
      const pending = waiting;
      waiting = undefined;
      pending.resolve(line);
    } else queue.push(line);
  });
  return {
    signal: controller.signal,
    check() { if (failure) throw failure; },
    review(text) { process.stderr.write(text); },
    async ask(prompt) {
      if (failure) throw failure;
      process.stderr.write(prompt);
      const line = queue.shift();
      if (line !== undefined) return line;
      return new Promise<string>((resolve, reject) => { waiting = { resolve, reject }; });
    },
    handoff() {
      if (failure) throw failure;
      handedOff = true;
      process.off('SIGINT', cancel);
      process.stdin.off('error', inputError);
      rl.close();
      process.stdin.pause();
      // Keep fd 0 available to Git, hooks and signing prompts.
    },
    close() {
      process.off('SIGINT', cancel);
      process.stdin.off('error', inputError);
      rl.close();
      process.stdin.pause();
      // This CLI owns the session. Release the input handle after restoring raw
      // mode, including when a SIGINT arrives inside readline's keypress handler.
      process.stdin.destroy();
    },
  };
}
