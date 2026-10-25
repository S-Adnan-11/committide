import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_TYPES, TYPE_TOKEN } from './message.js';
import { OperationalError } from './errors.js';

const CONFIG_NAME = 'committide.config.json';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw new OperationalError('config-read', `Cannot inspect configuration location ${path}. Check permissions.`);
  }
}

function typeList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !TYPE_TOKEN.test(item))) {
    throw new OperationalError('config-types', `${key} must be an array of nonempty type tokens (letters, numbers, underscores, or hyphens).`);
  }
  if (key === 'allowedTypes' && !value.length) {
    throw new OperationalError('config-types', 'allowedTypes must contain at least one type.');
  }
  return value as string[];
}

export function validateConfig(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationalError('config-shape', 'Configuration must be a JSON object.');
  }
  const config = value as Record<string, unknown>;
  const unknown = Object.keys(config).filter(key => !['allowedTypes', 'extendTypes'].includes(key));
  if (unknown.length) throw new OperationalError('config-unknown', `Unknown configuration keys: ${unknown.join(', ')}. Use allowedTypes or extendTypes.`);
  const base = Object.hasOwn(config, 'allowedTypes') ? typeList(config.allowedTypes, 'allowedTypes') : [...DEFAULT_TYPES];
  const extension = Object.hasOwn(config, 'extendTypes') ? typeList(config.extendTypes, 'extendTypes') : [];
  return [...new Set([...base, ...extension].map(type => type.toLowerCase()))];
}

/** Nearest config wins, bounded by repository/package markers; no Git process is required. */
export async function loadConfig(cwd: string, explicitPath?: string): Promise<string[]> {
  let selected: string | undefined;
  if (explicitPath !== undefined) {
    selected = resolve(cwd, explicitPath);
  } else {
    let directory = resolve(cwd);
    while (true) {
      const candidate = join(directory, CONFIG_NAME);
      if (await exists(candidate)) {
        selected = candidate;
        break;
      }
      // Both a Git directory and a worktree's .git file bound discovery.
      if (await exists(join(directory, '.git')) || await exists(join(directory, 'package.json'))) break;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (!selected) return [...DEFAULT_TYPES];
  let content: string;
  try {
    content = await readFile(selected, 'utf8');
  } catch {
    throw new OperationalError('config-read', `Cannot read configuration ${selected}. Check the path and permissions.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new OperationalError('config-json', `Invalid JSON in ${selected}. Use a JSON object without comments or trailing commas.`);
  }
  try {
    return validateConfig(value);
  } catch (error) {
    if (error instanceof OperationalError) throw new OperationalError(error.rule, `${selected}: ${error.message}`);
    throw error;
  }
}
