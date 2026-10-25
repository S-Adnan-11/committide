import { createInterface } from 'node:readline';
import { OperationalError } from './errors.js';

export class SuggestCancelled extends Error {
  constructor() { super('Cancelled; no message emitted.'); }
}

export interface SuggestIO {
  ask(prompt: string): Promise<string>;
  review(text: string): void;
  check(): void;
}

/** The terminal is opened only for this explicit interactive command. */
export function terminalIO(): SuggestIO & { close(): void } {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new OperationalError('suggest-terminal', 'suggest requires interactive stdin and stderr terminals. Run it in a terminal; use --output PATH to save an accepted message. Piped answers are not supported.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true, historySize: 0 });
  const queue: string[] = [];
  let failure: Error | undefined;
  let waiting: { resolve(value: string): void; reject(error: Error): void } | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    waiting?.reject(failure);
    waiting = undefined;
    rl.close();
  };
  const cancel = () => stop(new SuggestCancelled());
  const inputError = () => stop(new OperationalError('suggest-input', 'Terminal input failed. Retry in a working interactive terminal.'));
  rl.on('SIGINT', cancel);
  process.on('SIGINT', cancel);
  process.stdin.on('error', inputError);
  rl.on('close', () => {
    failure ??= new SuggestCancelled();
    waiting?.reject(failure);
    waiting = undefined;
  });
  rl.on('line', (line: string) => {
    if (line.length > 16_384 || queue.length >= 64) {
      stop(new OperationalError('suggest-input', 'Terminal input is too large. Use shorter fields (up to 16384 characters per line).'));
    } else if (waiting) {
      const pending = waiting;
      waiting = undefined;
      pending.resolve(line);
    } else queue.push(line);
  });
  return {
    check() { if (failure) throw failure; },
    review(text) { process.stderr.write(text); },
    async ask(prompt) {
      if (failure) throw failure;
      process.stderr.write(prompt);
      const line = queue.shift();
      if (line !== undefined) return line;
      return new Promise<string>((resolve, reject) => { waiting = { resolve, reject }; });
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
