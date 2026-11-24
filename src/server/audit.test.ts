// #2 — the audit log must not stall the event loop (auditTail reads only a bounded tail window, never
// the whole file), must not grow unbounded (rotateAudit renames past the cap, keeping one generation),
// and must not sit world-readable (0600 on create + a re-tighten sweep).
//
// CT_HOME is set before the module loads: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-audit-test-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { audit, auditTail } = await import('./audit.js');
const { rotateAudit } = await import('./retention.js');

function reset(): void {
  for (const f of [paths.audit, `${paths.audit}.1`]) if (existsSync(f)) rmSync(f);
}

test('auditTail returns the most recent entries newest-first; audit() creates the log 0600', () => {
  reset();
  audit('a.one', { n: 1 });
  audit('a.two', { n: 2 });
  audit('a.three', { n: 3 });
  const tail = auditTail(2);
  assert.equal(tail.length, 2);
  assert.equal(tail[0]!.action, 'a.three', 'newest first');
  assert.equal(tail[1]!.action, 'a.two');
  assert.equal(statSync(paths.audit).mode & 0o777, 0o600, 'audit log created 0600');
});

test('auditTail reads only the TAIL window (bounded), not the whole file', () => {
  reset();
  const N = 6000;
  for (let i = 0; i < N; i++) audit('bulk', { i });
  assert.ok(statSync(paths.audit).size > 256 * 1024, 'log exceeds the 256KB tail window');
  // Ask for more entries than the whole file holds: a bounded tail read returns only what fits in the
  // window — strictly fewer than N. A whole-file read (the bug this fixes) would return all N.
  const all = auditTail(1_000_000);
  assert.ok(all.length < N, `tail-bounded (${all.length} < ${N})`);
  assert.ok(all.length > 1000, 'but still a healthy window of recent entries');
  // The newest entries are present and fully parsed.
  const newest = auditTail(3);
  assert.deepEqual(
    newest.map((e) => e.i),
    [5999, 5998, 5997],
  );
  // Drop-safeguard, mutation-sensitive over the WHOLE window (not just the newest, which can never BE
  // the truncated head line): every returned entry parsed cleanly — the partial leading fragment was
  // dropped, never surfaced as a { raw } record buried mid-list.
  assert.ok(
    all.every((e) => typeof e.i === 'number'),
    'no garbled/partial head line surfaced anywhere in the tail',
  );
});

test('rotateAudit renames past the cap (keeping one 0600 generation); the panel tops up from .1', () => {
  reset();
  audit('before.rotate', {});
  const sizeBefore = statSync(paths.audit).size;
  rotateAudit(sizeBefore - 1); // trip the cap deterministically without writing 5MB
  assert.equal(existsSync(paths.audit), false, 'current log rotated away');
  assert.equal(existsSync(`${paths.audit}.1`), true, 'previous generation kept as .1');
  assert.equal(statSync(`${paths.audit}.1`).mode & 0o777, 0o600, 'the rotated generation stays 0600');
  audit('after.rotate', {});
  assert.equal(existsSync(paths.audit), true, 'next write recreates the log');
  assert.equal(statSync(paths.audit).mode & 0o777, 0o600, 'recreated 0600');
  // The panel doesn't appear to wipe history at the rotation boundary — it tops up from .1.
  const shown = auditTail(10);
  const actions = shown.map((e) => e.action);
  assert.ok(actions.includes('after.rotate') && actions.includes('before.rotate'), 'both the new and the rotated-out entry are visible');
});

test('rotateAudit tightens a LOOSE over-cap log BEFORE renaming, so .1 is never world-readable', () => {
  reset();
  // The real upgrade case: a pre-existing loose audit.log (from before 0600 enforcement) that is ALSO
  // already over the cap. chmod-after-rename (or under-cap-only) would ship the loose bits into .1.
  writeFileSync(paths.audit, '{"ts":"x","action":"legacy"}\n', { mode: 0o644 });
  chmodSync(paths.audit, 0o644); // force loose regardless of umask
  const size = statSync(paths.audit).size;
  rotateAudit(size - 1); // over cap → rotate
  assert.equal(existsSync(paths.audit), false, 'rotated away');
  assert.equal(statSync(`${paths.audit}.1`).mode & 0o777, 0o600, '.1 inherits 0600, not the loose source bits');
});

test('rotateAudit tightens a pre-existing world-readable log when under the cap', () => {
  reset();
  writeFileSync(paths.audit, '{"ts":"x","action":"legacy"}\n', { mode: 0o644 });
  chmodSync(paths.audit, 0o644); // force loose regardless of umask
  rotateAudit(); // under the default 5MB cap → the tighten path, no rotation
  assert.equal(statSync(paths.audit).mode & 0o777, 0o600);
  assert.equal(existsSync(`${paths.audit}.1`), false, 'no rotation when under cap');
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
