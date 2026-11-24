// writeJsonAtomic's permission contract: a `mode` passed for a secret-bearing store (reviews /
// gates / consults / research, all 0o600) must land on the target even when a stale `${file}.tmp`
// from a crash-interrupted prior write pre-exists with looser bits — because writeFileSync's {mode}
// only applies when the temp file is newly created, and the rename would otherwise carry the loose
// bits onto the target.
//
// CT_HOME is set before the module loads: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-atomic-test-'));
process.env.CT_HOME = home;

const { writeJsonAtomic } = await import('./store.js');

test('writeJsonAtomic re-tightens perms even when a loose temp file pre-exists', () => {
  const file = join(home, 'secret.json');
  // Simulate a crash between writeFileSync and renameSync on a prior write: a stale, world-readable
  // temp file left behind. writeFileSync({mode:0o600}) will NOT re-tighten it (mode applies on create
  // only), so without the explicit chmod the rename carries 0o644 onto the target.
  writeFileSync(`${file}.tmp`, 'stale', { mode: 0o644 });
  writeJsonAtomic(file, { k: 'v' }, 0o600);
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { k: 'v' }, 'content written correctly');
});

test('writeJsonAtomic without a mode still writes the file (default perms path)', () => {
  const file = join(home, 'plain.json');
  writeJsonAtomic(file, { a: 1 });
  assert.ok(statSync(file).isFile());
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1 });
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
