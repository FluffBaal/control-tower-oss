// SPEC-RUNWAY — a boot-stale `rotatingFrom` must be cleared when the Store loads. The field is an
// in-process-only rotation marker cleared when the respawn lands, so any value present on disk at load
// means the Tower died mid-rotation. If it survived, the usage-ingest, wall-scrape, cred-refresh and
// profile-delete belts would all treat the OLD config dir as perpetually live for that terminal —
// silently, forever. The Store constructor strips it (in memory AND on disk); this pins that.
//
// CT_HOME is set before the module loads: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-rotating-from-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');

function term(overrides: Record<string, unknown>) {
  return {
    id: 'x',
    projectId: 'p1',
    title: 't',
    provider: 'claude-code',
    tmuxSocket: 'ct-x',
    cwd: '/tmp',
    command: [],
    state: 'idle',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

test('a boot-stale rotatingFrom is stripped in-memory and dropped from disk on load', () => {
  const stale = term({ id: 'mid-rotation', profileId: 'newAcct', rotatingFrom: '/old/config/dir' });
  const clean = term({ id: 'normal', tmuxSocket: 'ct-normal' });
  writeFileSync(paths.terminals, JSON.stringify([stale, clean]));

  const store = new Store();
  const loaded = store.getTerminal('mid-rotation');
  assert.ok(loaded, 'the record still loads (only the field is cleared, not the record dropped)');
  assert.equal(loaded.rotatingFrom, undefined, 'rotatingFrom is cleared in memory');
  assert.equal(loaded.profileId, 'newAcct', 'the rotation-target profileId is left intact');

  // Persisted: the on-disk file was rewritten with the field gone (JSON omits the undefined key).
  const onDisk = JSON.parse(readFileSync(paths.terminals, 'utf8')) as Array<Record<string, unknown>>;
  const rec = onDisk.find((r) => r.id === 'mid-rotation');
  assert.ok(rec, 'the record persists');
  assert.equal('rotatingFrom' in rec, false, 'rotatingFrom is gone from the on-disk record');
  assert.equal(rec.profileId, 'newAcct', 'other fields survive the boot strip');
});

test('a record with no rotatingFrom is untouched', () => {
  const clean = term({ id: 'plain', tmuxSocket: 'ct-plain' });
  writeFileSync(paths.terminals, JSON.stringify([clean]));

  const store = new Store();
  const loaded = store.getTerminal('plain');
  assert.ok(loaded);
  assert.equal(loaded.rotatingFrom, undefined);
  assert.equal(loaded.state, 'idle', 'the record loads unchanged');
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
