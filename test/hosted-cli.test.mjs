import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli } from './git-helpers.mjs';
import { verifyHosted } from './hosted-package.mjs';
test('hosted executable uses fake Worker without keys: consent, edit, cap, service failures, stale state and cancellation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'committide-hosted-cli-')));
  try { await verifyHosted(cli, root); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
