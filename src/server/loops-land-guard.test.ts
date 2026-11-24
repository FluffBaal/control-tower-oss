// The land/stop GATE guards — the part a typecheck cannot vouch for:
//   - land() refuses any status but gated/done/stopped, so an operator (or a stale UI button, or a
//     mis-driven mission) can NEVER merge a RUNNING loop's in-flight, possibly-failing iteration and
//     have it stamped permanently done/landed — the false green a mission would treat as a success.
//   - land() holds the busy latch across the merge await, so a double-POST can't start a second merge
//     of the same branch.
//   - stop() never flips a LANDED loop (done + landedAt) to 'stopped' — that would mask a finished
//     success — while a done-UNLANDED candidate stays stoppable (archive() needs it landed or stopped).
//
// worktrees.land is STUBBED (a deferred promise where the concurrency test needs one), so no git is
// required. CT_HOME is set before the modules load — paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Loop } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-loops-land-guard-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { Loops } = await import('./loops.js');

/** A persisted loop + a matching project/terminal, wired to a controllable worktrees.land stub. */
function fixture(over: Partial<Loop>, land?: (...args: unknown[]) => Promise<{ detail: string }>) {
  const store = new Store();
  store.upsertProject({ id: 'p1', name: 'p', repoPath: join(home, 'repo'), scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  store.upsertTerminal({
    id: 't1', projectId: 'p1', title: 'builder', provider: 'codex', tmuxSocket: 'ct-t1',
    cwd: join(home, 'repo'), command: [], state: 'idle', createdAt: new Date().toISOString(),
  });
  const now = new Date().toISOString();
  const loop: Loop = {
    id: 'l1', projectId: 'p1', name: 'loop', task: 'do it', provider: 'codex',
    gatePolicy: 'never', maxIterations: 8, status: 'running', iteration: 1,
    iterations: [{ n: 1, verdict: 'pending', startedAt: now }],
    terminalId: 't1', baseBranch: 'main', branch: 'loop/l1', createdAt: now, updatedAt: now,
    ...over,
  };
  store.upsertLoop(loop);
  let landCalls = 0, removeCalls = 0, killCalls = 0;
  const worktrees = {
    land: async (...args: unknown[]) => {
      landCalls++;
      return land ? await land(...args) : { detail: 'merged loop/l1 into main' };
    },
    // After a successful merge, land() tears the builder down (a landed loop must not leak its worktree
    // or its 'working' pane). Spies so the teardown test can assert both ran; both succeed here.
    remove: async () => { removeCalls++; return { removed: true, dirty: false }; },
  };
  const tm = { killTerminal: async () => { killCalls++; } };
  const loops = new Loops({ store, accounts: { getIdentity: () => undefined }, worktrees, tm, onUpdate: () => {} } as never);
  return { loops, read: () => store.getLoop('l1')!, landCalls: () => landCalls, removeCalls: () => removeCalls, killCalls: () => killCalls };
}

test('land() refuses a RUNNING loop and never touches the merge (the false-green guard)', async () => {
  const f = fixture({ status: 'running' });
  await assert.rejects(f.loops.land('l1'), /only a gated or done loop can be landed/);
  assert.equal(f.landCalls(), 0, 'the merge must not run for a running loop');
  assert.equal(f.read().status, 'running', 'the loop is left untouched — not stamped done/landed');
});

test('land() refuses paused/stopped/failed too; accepts only gated/done', async () => {
  // stopped/failed are refused up front: SPEC-FACTORY forbids resurrecting them into 'done',
  // so a land on one would merge the branch yet leave the record stopped — a half-land, not allowed.
  for (const status of ['paused', 'stopped', 'failed'] as const) {
    const f = fixture({ status });
    await assert.rejects(f.loops.land('l1'), /only a gated or done loop can be landed/, `${status} is refused`);
    assert.equal(f.landCalls(), 0, `${status}: the merge must not run`);
  }
  for (const status of ['gated', 'done'] as const) {
    const f = fixture({ status });
    const l = await f.loops.land('l1');
    assert.equal(f.landCalls(), 1, `${status} lands`);
    assert.equal(l.status, 'done', `${status} → done after a land`);
    assert.ok(l.landedAt, 'landedAt stamped');
    assert.match(l.stopReason ?? '', /landed —/);
  }
});

test('land() holds the busy latch across the merge — a concurrent double-land rejects', async () => {
  let release: (v: { detail: string }) => void = () => {};
  const gate = new Promise<{ detail: string }>((res) => { release = res; });
  const f = fixture({ status: 'gated' }, () => gate);

  const first = f.loops.land('l1'); // enters the merge and parks on the deferred, holding busy
  await Promise.resolve(); // let first() run up to the await
  await assert.rejects(f.loops.land('l1'), /busy — a check or land is already in flight/, 'second land is refused while the first merges');
  assert.equal(f.landCalls(), 1, 'only ONE merge ran');

  release({ detail: 'merged loop/l1 into main' });
  const l = await first;
  assert.equal(l.status, 'done');
  // The latch is released after the merge — a later land is allowed again (now from status done).
  await f.loops.land('l1');
  assert.equal(f.landCalls(), 2);
});

test('a successful land tears the builder down — removes the merged worktree AND closes the pane (gap: a landed loop must not leak dangling terminals/worktrees)', async () => {
  const f = fixture({ status: 'done' });
  const l = await f.loops.land('l1');
  assert.equal(l.status, 'done');
  assert.ok(l.landedAt, 'landed');
  assert.equal(f.removeCalls(), 1, 'the merged worktree is removed after the land');
  assert.equal(f.killCalls(), 1, 'the builder pane is closed after the land');
});

test('stop() is a no-op on a LANDED loop (never masks a finished success)', () => {
  const f = fixture({ status: 'done', landedAt: new Date().toISOString(), stopReason: 'landed — merged' });
  const l = f.loops.stop('l1');
  assert.equal(l.status, 'done', 'a landed loop stays done, not stopped');
  assert.ok(l.landedAt);
  assert.match(l.stopReason ?? '', /landed —/, 'the land reason is preserved');
});

test('stop() is a no-op on an already-stopped/failed loop (idempotent)', () => {
  for (const status of ['stopped', 'failed'] as const) {
    const f = fixture({ status, stopReason: 'prior reason' });
    const l = f.loops.stop('l1', 'new reason');
    assert.equal(l.status, status, `${status} is left as-is`);
    assert.equal(l.stopReason, 'prior reason', 'the original reason is not overwritten');
  }
});

test('stop() still stops a done-UNLANDED candidate and a running loop (the archive-prep + normal paths)', () => {
  const cand = fixture({ status: 'done', stopReason: 'check passed' }); // done but NO landedAt
  assert.equal(cand.loops.stop('l1').status, 'stopped', 'a done-unlanded Review & Land candidate stays stoppable');

  const run = fixture({ status: 'running' });
  const l = run.loops.stop('l1', 'stopped by operator');
  assert.equal(l.status, 'stopped');
  assert.equal(l.stopReason, 'stopped by operator');
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
