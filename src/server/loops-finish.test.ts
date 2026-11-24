// SPEC-FACTORY §0.1/§1 + SPEC-STORYLOOP §2.3 — the loop's finishIteration decision, the part a typecheck
// cannot vouch for:
//   - gate-before-done ORDER: an inconclusive/unavailable acceptance judge forces a GATE even on a
//     gatePolicy:'never' loop — it must never reach 'done' and get landed unverified.
//   - done-only-when-committed: a committed pass is 'done'; a zero-commit branch is 'stopped' +
//     noChangesToLand (never a phantom land candidate); a branch already ahead stays 'done'.
//   - the e2e-run FRESHNESS guard: only a run started during THIS iteration is fed to the judge (5th
//     arg); a stale run is dropped, never misattributed.
//
// CT_HOME + git author env are set before the modules load: paths.ts freezes CT_HOME at import time, and
// the loop's auto-commit needs an author. The real ~/.ct is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Loop, TestFailure } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-loops-finish-'));
process.env.CT_HOME = home;
process.env.GIT_AUTHOR_NAME = 'Loop Bot';
process.env.GIT_AUTHOR_EMAIL = 'loop@example.com';
process.env.GIT_COMMITTER_NAME = 'Loop Bot';
process.env.GIT_COMMITTER_EMAIL = 'loop@example.com';

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { Loops } = await import('./loops.js');

const haveGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const repo = join(home, 'loop-src');
if (haveGit) {
  mkdirSync(repo, { recursive: true });
  const g = (args: string[], cwd = repo): string => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
  g(['init']);
  g(['config', 'user.name', 'Loop Bot']);
  g(['config', 'user.email', 'loop@example.com']);
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  g(['add', '-A']);
  g(['commit', '-m', 'initial']);
  g(['branch', '-M', 'main']);
}

const g = (args: string[], cwd = repo): string => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

/** A fresh worktree on `loop/<name>` off main. `commitAhead` adds one committed change (branch ahead of
 *  base); `dirtyFile` leaves an UNCOMMITTED change for finishIteration to commit. */
function worktree(name: string, opts: { commitAhead?: boolean; dirtyFile?: boolean } = {}): string {
  const path = join(home, `wt-${name}`);
  g(['worktree', 'add', path, '-b', `loop/${name}`, 'main']);
  if (opts.commitAhead) {
    writeFileSync(join(path, 'ahead.txt'), 'ahead\n');
    g(['add', '-A'], path);
    g(['commit', '-m', 'ahead'], path);
  }
  if (opts.dirtyFile) writeFileSync(join(path, 'work.txt'), 'work\n');
  return path;
}

const ITER_T = '2024-01-01T00:00:00.000Z';

/** Build + persist a running loop pinned at iteration 1, then return a driver for its private
 *  finishIteration. Deps are the minimal slice finishIteration touches. */
function loopFixture(over: Partial<Loop>, deps: { validator?: unknown; testRuns?: unknown; wasIdleInferred?: unknown } = {}) {
  const store = new Store();
  store.upsertProject({ id: 'p1', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  const now = new Date().toISOString();
  const loop: Loop = {
    id: `l-${over.id ?? Math.random().toString(36).slice(2, 8)}`,
    projectId: 'p1', name: 'loop', task: 'do it', provider: 'codex',
    gatePolicy: 'never', maxIterations: 8, status: 'running', iteration: 1,
    iterations: [{ n: 1, verdict: 'pending', startedAt: ITER_T }],
    baseBranch: 'main', createdAt: now, updatedAt: now,
    ...over,
  };
  store.upsertLoop(loop);
  const loops = new Loops({
    store,
    accounts: { getIdentity: () => undefined },
    onUpdate: () => {},
    ...deps,
  } as never);
  return {
    finish: () => (loops as unknown as { finishIteration(id: string): Promise<void> }).finishIteration(loop.id),
    read: () => store.getLoop(loop.id)!,
  };
}

test('finishIteration — an inconclusive/unavailable judge forces a GATE, never a done (gate-before-done)', { skip: !haveGit }, async () => {
  const wt = worktree('gate', { dirtyFile: true });
  // assertions present + NO validator dep → forcedGate, even though gatePolicy is 'never'.
  const f = loopFixture({ id: 'gate', worktreePath: wt, branch: 'loop/gate', assertions: [{ id: 'a1', text: 'must hold' }], gatePolicy: 'never' });
  await f.finish();
  const l = f.read();
  assert.equal(l.status, 'gated', 'a gatePolicy:never loop with an unverifiable judge gates, never done');
  const it = l.iterations.find((i) => i.n === 1)!;
  assert.equal(it.validator?.verdict, 'inconclusive');
  assert.match(it.validator?.inconclusiveReason ?? '', /no acceptance judge is configured/);
});

test('finishIteration — a committed pass is done (gatePolicy never)', { skip: !haveGit }, async () => {
  const wt = worktree('committed', { dirtyFile: true }); // an uncommitted change → the iteration commits it
  const f = loopFixture({ id: 'committed', worktreePath: wt, branch: 'loop/committed', gatePolicy: 'never' });
  await f.finish();
  const l = f.read();
  assert.equal(l.status, 'done');
  assert.equal(l.stopReason, 'check passed');
  assert.notEqual(l.noChangesToLand, true);
});

test('finishIteration — a zero-commit branch stops as noChangesToLand, never a phantom land candidate', { skip: !haveGit }, async () => {
  const wt = worktree('nochange'); // clean, tip == main → nothing to land
  const f = loopFixture({ id: 'nochange', worktreePath: wt, branch: 'loop/nochange', gatePolicy: 'never' });
  await f.finish();
  const l = f.read();
  assert.equal(l.status, 'stopped');
  assert.equal(l.noChangesToLand, true, 'a zero-commit branch is finished-in-fact, not a Gate card');
});

test('finishIteration — a branch already ahead stays done even when this iteration commits nothing', { skip: !haveGit }, async () => {
  const wt = worktree('ahead', { commitAhead: true }); // ahead of base, but no NEW change this iteration
  const f = loopFixture({ id: 'ahead', worktreePath: wt, branch: 'loop/ahead', gatePolicy: 'never' });
  await f.finish();
  const l = f.read();
  assert.equal(l.status, 'done');
  assert.match(l.stopReason ?? '', /no new changes this iteration/);
  assert.notEqual(l.noChangesToLand, true, 'commits still exist to land — not a no-change stop');
});

test('finishIteration — SPEC-LOOPWEDGE GUARD: an INFERRED idle may never be the sole basis of an autopilot done', { skip: !haveGit }, async (t) => {
  // The cardinal sin: an idle derived from screen evidence (F1's lost-hook harvest / F2's poller
  // affirmative-idle demote) rather than a real Stop hook must NEVER auto-pass. With no checkCommand to
  // independently confirm and gatePolicy 'never' (the only unattended-'done' path), completion is forced
  // to a GATE. A real Stop idle, or any inferred idle a passing check covers, still auto-passes.

  await t.test('inferred idle + no checkCommand + gatePolicy never → GATED, never done', async () => {
    const wt = worktree('guard-inferred', { dirtyFile: true }); // a real commit → without the GUARD this is 'done'
    const f = loopFixture(
      { id: 'guard-inferred', worktreePath: wt, branch: 'loop/guard-inferred', terminalId: 't-inf', gatePolicy: 'never' },
      { wasIdleInferred: () => true },
    );
    await f.finish();
    const l = f.read();
    assert.equal(l.status, 'gated', 'an inferred completion with no check is gated, not auto-passed (a GUARD revert makes this "done")');
    assert.match(l.stopReason ?? '', /inferred from screen evidence/, 'and the gate says why it was not auto-passed');
  });

  await t.test('a REAL Stop idle + no checkCommand + gatePolicy never → done (the GUARD does not over-fire)', async () => {
    const wt = worktree('guard-realstop', { dirtyFile: true });
    const f = loopFixture(
      { id: 'guard-realstop', worktreePath: wt, branch: 'loop/guard-realstop', terminalId: 't-real', gatePolicy: 'never' },
      { wasIdleInferred: () => false }, // a real Stop hook — not inferred
    );
    await f.finish();
    const l = f.read();
    assert.equal(l.status, 'done', 'a real-Stop idle still auto-passes on gatePolicy never');
    assert.equal(l.stopReason, 'check passed');
  });

  await t.test('an inferred idle WITH a passing checkCommand → done (an objective check rescues it)', async () => {
    const wt = worktree('guard-checked', { dirtyFile: true });
    const f = loopFixture(
      { id: 'guard-checked', worktreePath: wt, branch: 'loop/guard-checked', terminalId: 't-chk', gatePolicy: 'never', checkCommand: 'true' },
      { wasIdleInferred: () => true },
    );
    await f.finish();
    const l = f.read();
    assert.equal(l.status, 'done', 'the passing check is objective evidence — the GUARD only bites the NO-check path');
  });
});

test('finishIteration — the e2e-run freshness guard: only a run from THIS iteration reaches the judge', { skip: !haveGit }, async (t) => {
  const results: TestFailure[] = [{ specFile: 'x.spec.ts', testTitle: 't', errorTail: 'boom' } as TestFailure];

  /** capture the 5th arg (testFailures) the judge is handed, for a run started at `runStartedAt`. */
  function run5thArg(label: string, runStartedAt: string): Promise<unknown> {
    let captured: unknown = 'UNSET';
    const validator = {
      available: () => ({ ok: true }),
      run: async (_wt: string, _task: string, _crit: unknown, _sig: unknown, testFailures: unknown) => {
        captured = testFailures;
        return { verdict: 'pass', results: [], ms: 0, ranAt: new Date().toISOString() };
      },
    };
    const testRuns = { latestFor: () => ({ startedAt: runStartedAt, results }) };
    const wt = worktree(label);
    const f = loopFixture(
      { id: label, worktreePath: wt, branch: `loop/${label}`,
        terminalId: 't-loop', assertions: [{ id: 'a', text: 'x' }], gatePolicy: 'every' },
      { validator, testRuns },
    );
    return f.finish().then(() => captured);
  }

  await t.test('a run started BEFORE this iteration is dropped (5th arg undefined)', async () => {
    const captured = await run5thArg('stale', '2023-06-01T00:00:00.000Z'); // < ITER_T
    assert.equal(captured, undefined, 'a stale run is never misattributed into the judge context');
  });

  await t.test('a run started during this iteration is passed through (5th arg === its results)', async () => {
    const captured = await run5thArg('freshrun', '2024-06-01T00:00:00.000Z'); // >= ITER_T
    assert.deepEqual(captured, results, 'the fresh run’s failures reach the judge');
  });
});

process.on('exit', () => {
  try { g(['worktree', 'prune']); } catch { /* best effort */ }
  rmSync(home, { recursive: true, force: true });
});
