#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command, CommanderError } from 'commander';
import { loadConfig } from './config.js';
import { OperationalError } from './errors.js';
import { lintMessage } from './message.js';
import { checkHistory } from './history.js';
import { localDependency, manageHook } from './hooks.js';
import { repository } from './git.js';
import { generateChangelog, terminalText } from './changelog.js';
import type { ChangelogOptions } from './changelog.js';
import { join } from 'node:path';
import { prepareChangelogFile } from './changelog-file.js';
import { suggest } from './suggest.js';
import { SuggestCancelled, terminalIO } from './suggest-io.js';
import { helpBrand, terminalColors } from './brand.js';

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
  .description('Validate commit messages, compose drafts, and generate release notes')
  .version(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version as string)
  .option('--config <path>', 'read an explicit JSON configuration instead of discovery')
  .showHelpAfterError()
  .exitOverride();

// Normal root help has its own presentation boundary; error and child help do not.
program.configureOutput({
  getOutHasColors: () => terminalColors(process.stdout, process.env),
  getErrHasColors: () => terminalColors(process.stderr, process.env),
});
program.addHelpText('before', ({ error }) =>
  error || process.argv.length === 2 ? '' : helpBrand(process.stdout, process.env));

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

program.command('changelog')
  .description('Preview deterministic Unreleased notes from local Git history')
  .option('--from <ref>', 'exclude commits reachable from this explicit boundary')
  .option('--to <ref>', 'target commit (default HEAD)')
  .option('--include-maintenance', 'include other conforming types as maintenance')
  .option('--write', 'update only the managed block in repository-root CHANGELOG.md')
  .action(async (options: ChangelogOptions & { write?: boolean }, command: Command) => {
    await loadConfig(process.cwd(), command.optsWithGlobals<{ config?: string }>().config);
    const destination = options.write ? await repository(process.cwd()) : null;
    if (destination?.bare) throw new OperationalError('changelog-path', 'Writing a changelog requires a non-bare working repository. Preview is available without writing.');
    const writer = destination ? await prepareChangelogFile(join(destination.root, 'CHANGELOG.md')) : null;
    const result = await generateChangelog(process.cwd(), options);
    process.stderr.write(`Boundary: ${result.from ?? 'all reachable history'}${result.tag ? ` (tag ${terminalText(result.tag)})` : ''}; target ${result.to}.\n`);
    for (const skipped of result.skipped) {
      process.stderr.write(`Skipped commit ${skipped.oid}: ${skipped.rules.map(terminalText).join('; ')}\n`);
    }
    process.stderr.write(`${result.selected ? '' : 'Empty range. '}Selected ${result.selected}; included ${result.included}; filtered ${result.filtered}; skipped ${result.skipped.length}.\n`);
    if (writer) process.stderr.write(`Changelog ${await writer.write(result.content)}: ${writer.target}\n`);
    else process.stdout.write(result.markdown);
  });

program.command('suggest')
  .description('Review staged changes and compose a message locally in an interactive terminal')
  .option('--output <path>', 'also create a new UTF-8 message file, relative to the current directory')
  .option('--ai', 'offer an explicitly disclosed staged submission to Groq for an editable draft')
  .action(async (options: { output?: string; ai?: boolean }, command: Command) => {
    // Replace the default immediate signal exit with scoped terminal cleanup.
    process.off('SIGINT', interrupt);
    const io = terminalIO();
    try {
      const message = await suggest(process.cwd(), { ...options, ...command.optsWithGlobals<{ config?: string }>() }, io);
      if (message !== null) process.stdout.write(message);
    } finally { io.close(); }
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

const interrupt = () => { process.exit(130); };
process.once('SIGINT', interrupt);
try {
  if (process.argv.length === 2) program.help();
  await program.parseAsync();
} catch (error) {
  if (error instanceof SuggestCancelled) {
    process.stderr.write('Cancelled; no message emitted.\n');
    process.exitCode = 130;
  } else if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    const rule = error instanceof OperationalError ? error.rule : 'operation';
    const message = error instanceof OperationalError ? error.message : 'The operation failed unexpectedly.';
    process.stderr.write(`error [${rule}]: ${message}\n`);
    process.exitCode = 2;
  }
}
