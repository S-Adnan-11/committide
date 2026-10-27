import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyHelpBranding } from './brand-helpers.mjs';

test('explicit root help decorates only its terminal destination and preserves output contracts', () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'committide-brand-')));
  try { verifyHelpBranding(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), cwd); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});
