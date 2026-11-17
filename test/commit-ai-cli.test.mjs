import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cli } from './git-helpers.mjs';
import { verifyCommitAI } from './commit-ai-package.mjs';

test('executable AI consent, matching payload, failure, stale state, cancellation and final commit boundaries', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'committide-ai-cli-')));
  try { await verifyCommitAI(cli, root); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
