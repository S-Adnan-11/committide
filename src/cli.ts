#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command, CommanderError } from 'commander';
import { loadConfig } from './config.js';
import { OperationalError } from './errors.js';
import { lintMessage } from './message.js';
import { checkHistory } from './history.js';
import { localDependency, manageHook } from './hooks.js';
import { repository } from './git.js';

interface LintOptions { message?: string; file?: string }

async function readMessage(options: LintOptions): Promise<string> {
  const explicitCount = Number(options.message !== undefined) + Number(options.file !== undefined);
  // Explicit input may accompany an empty redirected stdin (e.g. CI), but not data.
  if (explicitCount > 1) throw new OperationalError('input-source', 'Choose exactly one source: --message, --file, or piped stdin.');
  let piped = '';
  if (!process.stdin.isTTY) {
    try {
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) piped += chunk;
    } catch {
      throw new OperationalError('input-read', 'Cannot read standard input.');
    }
  }
  if (explicitCount && piped.length) throw new OperationalError('input-source', 'Piped stdin conflicts with --message/--file. Choose exactly one source.');
  if (options.message !== undefined) return options.message;
  if (options.file !== undefined) {
    try {
      return await readFile(options.file, 'utf8');
    } catch {
      throw new OperationalError('input-file', `Cannot read message file ${options.file}. Check the path and permissions.`);
    }
  }
  if (!piped.length) throw new OperationalError('input-source', 'Provide --message TEXT, --file PATH, or pipe a commit message to stdin.');
  return piped;
}

const program = new Command()
  .name('committide')
  .description('Lint Conventional Commits messages locally')
  .version(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version as string)
  .option('--config <path>', 'read an explicit JSON configuration instead of discovery')
  .showHelpAfterError()
  .exitOverride();

program.command('lint')
  .description('Validate one message from --message, --file, or piped stdin')
  .option('-m, --message <text>', 'commit message text')
  .option('-f, --file <path>', 'UTF-8 commit message file')
  .action(async (options: LintOptions, command: Command) => {
    const message = await readMessage(options);
    const allowedTypes = await loadConfig(process.cwd(), command.optsWithGlobals<{ config?: string }>().config);
    const result = lintMessage(message, allowedTypes);
    if (result.diagnostics.length) {
      for (const diagnostic of result.diagnostics) {
        process.stderr.write(`error [${diagnostic.rule}] line ${diagnostic.line}: ${diagnostic.message}\n`);
      }
      process.exitCode = 1;
    } else {
      process.stdout.write('Message is valid.\n');
    }
  });

program.command('check')
  .description('Validate complete messages in the source-exclusive Git reachability range')
  .requiredOption('--from <ref>', 'exclude commits reachable from this commit')
  .requiredOption('--to <ref>', 'include commits reachable from this commit')
  .action(async (options: { from: string; to: string }, command: Command) => {
    const allowedTypes = await loadConfig(process.cwd(), command.optsWithGlobals<{ config?: string }>().config);
    const result = await checkHistory(process.cwd(), options.from, options.to, allowedTypes);
    for (const failure of result.failures) {
      for (const diagnostic of failure.diagnostics) {
        process.stderr.write(`error [${diagnostic.rule}] commit ${failure.oid} line ${diagnostic.line}: ${diagnostic.message}\n`);
      }
    }
    process.stdout.write(`${result.checked ? '' : 'Empty range. ' }Checked ${result.checked}; failed ${result.failed}; skipped ${result.skipped}.\n`);
    process.exitCode = result.failed ? 1 : 0;
  });

const hooks = program.command('hooks').description('Explicitly install or remove a repository-local commit-msg hook');
for (const action of ['install', 'uninstall'] as const) {
  hooks.command(action).action(async (_options: unknown, command: Command) => {
    if (command.optsWithGlobals<{ config?: string }>().config !== undefined) {
      throw new OperationalError('hook-config', 'Installed hooks discover configuration from the consuming repository root. Configure that file or integrate the hook manually with --config.');
    }
    process.stdout.write(`${await manageHook(process.cwd(), action)}\n`);
  });
}

program.command('hook', { hidden: true })
  .description('Validate a commit-msg hook input without changing it')
  .requiredOption('--file <path>', 'proposed UTF-8 message file')
  .action(async (options: { file: string }, command: Command) => {
    const repo = await repository(process.cwd());
    await localDependency(repo.root);
    const allowedTypes = await loadConfig(repo.root, command.optsWithGlobals<{ config?: string }>().config);
    let message: string;
    try { message = await readFile(options.file, 'utf8'); } catch {
      throw new OperationalError('input-file', 'Cannot read the proposed commit-message file. Check its path and permissions.');
    }
    const result = lintMessage(message, allowedTypes);
    for (const diagnostic of result.diagnostics) {
      process.stderr.write(`error [${diagnostic.rule}] line ${diagnostic.line}: ${diagnostic.message}\n`);
    }
    if (result.diagnostics.length) process.exitCode = 1;
  });

process.once('SIGINT', () => { process.exit(130); });
try {
  if (process.argv.length === 2) program.help();
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    const rule = error instanceof OperationalError ? error.rule : 'operation';
    const message = error instanceof OperationalError ? error.message : 'The operation failed unexpectedly.';
    process.stderr.write(`error [${rule}]: ${message}\n`);
    process.exitCode = 2;
  }
}
