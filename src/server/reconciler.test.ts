// Reconciler dead-pane detection — the vanish path for a pane whose command EXITED under
// `remain-on-exit on` while its session stayed alive (hasSession is blind to it: the incident was
// terminals reading 'working' forever off a dead login pane). Driven against a REAL scratch tmux
// server on a non-`ct-` socket, with a stub store recording every patch/event/onVanish, so each
// case asserts the exact destructive (or non-) outcome. Self-skips when tmux is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { Terminal } from '../shared/types.js';

process.env.CT_HOME = mkdtempSync(join(tmpdir(), 'ct-reconciler-'));

const pexec = promisify(execFile);
const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);

const { Reconciler } = await import('./reconciler.js');
const { isPaneDead, allPanesDead } = await import('./tmux.js');

const SOCK = `recdead-${process.pid}`; // NOT ct-* : listTowerSockets must never see it
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const killScratch = async (): Promise<void> => {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
};

/** A live scratch session mirroring production: remain-on-exit set while the pane process
 *  (a plain `sleep`) is definitely alive — same sequence as tmux.newSession (tmux.ts:88-105). */
async function spawnLive(): Promise<void> {
  // STAGED retry, bounded and loud: under full-suite load the kill-server → new-session pair on
  // the same socket can race the dying server ("server exited unexpectedly" — the fresh server
  // binds the socket, then exits with the old one). This is pure fixture staging, before any
  // product interaction, so re-staging here can never mask a product regression — a mid-drive
  // server death surfaces as different messages ("no server running", "error connecting") and any
  // other spawn failure still throws at once.
  // The retried unit includes set-option: the fresh server can still lose the race between
  // new-session and the option landing, and that death wears the same message. The retry lives
  // ONLY here — the killed-server subtests (T3, T7, T8, T10) stage their own state on purpose.
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      await pexec('tmux', ['-L', SOCK, 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '24', 'sleep', '600'], { timeout: 10_000 });
      await pexec('tmux', ['-L', SOCK, 'set-option', '-t', 'main', 'remain-on-exit', 'on'], { timeout: 10_000 });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] paint attempt ${attempt} lost the fresh tmux server to the kill-server race; re-staging`);
    }
  }
}

/** Kill the pane's process and wait for tmux to latch pane_dead=1. Deterministic: remain-on-exit
 *  was set while the process was alive, so there is no race against the option landing. */
async function makePaneDead(): Promise<void> {
  const { stdout } = await pexec('tmux', ['-L', SOCK, 'display-message', '-p', '-t', 'main', '#{pane_pid}'], { timeout: 10_000 });
  process.kill(Number(stdout.trim()), 'SIGKILL');
  for (let i = 0; i < 100; i++) {
    const { stdout: d } = await pexec('tmux', ['-L', SOCK, 'display-message', '-p', '-t', 'main', '#{pane_dead}'], { timeout: 10_000 });
    if (d.trim() === '1') return;
    await wait(50);
  }
  throw new Error('pane never reported dead (tmux infra failure under load)');
}

/** A live CLI pane PLUS a dead FOCUSED split — the D1 false-positive shape. `spawnLive` sets
 *  remain-on-exit while pane 0 (`sleep 600`) is alive; the split's `true` then exits and latches
 *  pane_dead=1 while pane 0 lives on. `display-message -t main` reads the dead active split, but the
 *  terminal is alive — the exact case the all-panes probe must call NOT-dead. */
async function spawnLiveWithDeadSplit(): Promise<void> {
  await spawnLive();
  await pexec('tmux', ['-L', SOCK, 'split-window', '-t', 'main', 'true'], { timeout: 10_000 });
  for (let i = 0; i < 100; i++) {
    const { stdout } = await pexec('tmux', ['-L', SOCK, 'list-panes', '-s', '-t', 'main', '-F', '#{pane_dead}'], { timeout: 10_000 });
    const panes = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (panes.includes('1') && panes.includes('0')) return; // one dead split beside one live pane
    await wait(50);
  }
  throw new Error('split never reached the mixed live/dead pane state (tmux infra failure under load)');
}

const serverAlive = (): Promise<boolean> =>
  pexec('tmux', ['-L', SOCK, 'has-session', '-t', 'main']).then(() => true).catch(() => false);

function stubTerm(over: Partial<Terminal>): Terminal {
  return {
    id: 't-rec', projectId: 'p1', title: 'x', provider: 'shell', tmuxSocket: SOCK,
    cwd: '/tmp', command: ['bash'], state: 'working', sessionId: 'sess-1',
    createdAt: new Date().toISOString(),
    ...over,
  } as Terminal;
}

/** Stub store that RECORDS and APPLIES patches (so a second reconcile sees the flipped state),
 *  plus an onVanish spy. `restartInFlight` (SPEC-RESTART-RESUME FIX A) lets a test simulate
 *  TerminalManager reporting an in-flight restart/resume-watch for a terminal id. */
function harness(terms: Terminal[], restartInFlight?: (id: string) => boolean) {
  const patches: Array<{ id: string; patch: Partial<Terminal> }> = [];
  const events: Array<{ terminalId: string; type: string; payload?: Record<string, unknown> }> = [];
  const vanishedTerms: Terminal[] = [];
  const store = {
    listTerminals: () => terms,
    patchTerminal: (id: string, patch: Partial<Terminal>) => {
      patches.push({ id, patch });
      const t = terms.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
      return t;
    },
    appendEvent: (ev: { terminalId: string; type: string; payload?: Record<string, unknown> }) => {
      events.push(ev);
      return ev;
    },
    droppedTerminalSockets: () => new Set<string>(),
  } as unknown as Store;
  const rec = new Reconciler(store, { onVanish: (t) => vanishedTerms.push(t), restartInFlight });
  return { rec, patches, events, vanishedTerms };
}

// Pure predicate behind isPaneDead — the load-bearing guard against a destructive vanish on an
// EMPTY read. Empty output happens on a tmux build without `#{pane_dead}` AND when a stalled probe
// RESOLVES empty (this platform's timed-out client exits 0 instead of being killed), so an empty
// listing must read NOT-dead. No tmux needed — runs everywhere.
test('allPanesDead — dead only when >=1 pane and all dead; empty reads not-dead', () => {
  assert.equal(allPanesDead(''), false);            // stall/unsupported → must never vanish
  assert.equal(allPanesDead('   \n  \n'), false);   // whitespace-only lines filtered → empty → false
  assert.equal(allPanesDead('0'), false);           // single live pane
  assert.equal(allPanesDead('1'), true);            // single dead pane
  assert.equal(allPanesDead('0\n1'), false);        // the D1 shape: one live pane spares the terminal
  assert.equal(allPanesDead('1\n0\n1'), false);     // one live pane among many dead still spares it
  assert.equal(allPanesDead('1\n1'), true);         // every pane dead (multi-pane) → dead
  assert.equal(allPanesDead('1\n\n1'), true);       // blank line filtered, both real panes dead
  assert.equal(allPanesDead('1\n'), true);          // trailing newline tolerated
});

test('reconciler dead-pane detection + vanish convergence',
  { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {
  try {
    // T1 — isPaneDead on a live remain-on-exit pane → false.
    await t.test('T1 — isPaneDead is false on a live remain-on-exit pane', async () => {
      await spawnLive();
      assert.equal(await isPaneDead(SOCK), false);
    });

    // T2 — isPaneDead on a dead pane → true (continues off T1's live pane).
    await t.test('T2 — isPaneDead is true once the pane command has exited', async () => {
      await makePaneDead();
      assert.equal(await isPaneDead(SOCK), true);
    });

    // T3 — isPaneDead on a socket with no server → false, no throw.
    await t.test('T3 — isPaneDead answers false (no throw) on a socket with no server', async () => {
      await killScratch();
      assert.equal(await isPaneDead(SOCK), false);
    });

    // T4 — reconciler: alive session + dead pane → vanished with reason 'pane-dead'.
    await t.test('T4 — alive session + dead pane vanishes with reason pane-dead', async () => {
      await spawnLive();
      await makePaneDead();
      const { rec, patches, events, vanishedTerms } = harness([stubTerm({ state: 'working' })]);
      const res = await rec.reconcile();
      assert.deepEqual(res.vanished, ['t-rec']);
      assert.deepEqual(res.adopted, []);
      const killPatch = patches.find((p) => p.id === 't-rec' && p.patch.state === 'killed');
      assert.ok(killPatch, 'expected a killed patch for t-rec');
      assert.equal(typeof killPatch!.patch.closedAt, 'string');
      assert.equal(vanishedTerms.length, 1);
      assert.equal(vanishedTerms[0]!.id, 't-rec');
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'reconcile');
      assert.deepEqual(events[0]!.payload, { reason: 'pane-dead', resumable: true, sessionId: 'sess-1' });
    });

    // T5 — reconciler: alive HEALTHY pane → byte-untouched.
    await t.test('T5 — an alive healthy pane is byte-untouched', async () => {
      await spawnLive();
      const { rec, patches, events, vanishedTerms } = harness([stubTerm({ state: 'working' })]);
      const res = await rec.reconcile();
      assert.deepEqual(res.vanished, []);
      assert.equal(patches.length, 0);
      assert.equal(events.length, 0);
      assert.equal(vanishedTerms.length, 0);
    });

    // T6 — reconciler: 'starting' + dead pane → ADOPTED this sweep, vanished the NEXT.
    await t.test('T6 — a starting terminal with a dead pane is adopted this sweep, vanished the next', async () => {
      await spawnLive();
      await makePaneDead();
      const { rec, patches, events, vanishedTerms } = harness([stubTerm({ state: 'starting' })]);
      const res = await rec.reconcile();
      assert.deepEqual(res.adopted, ['t-rec']);
      assert.deepEqual(res.vanished, []);
      assert.equal(vanishedTerms.length, 0);
      assert.equal(patches.length, 1);
      assert.deepEqual(patches[0]!.patch, { state: 'idle' });
      // The stub APPLIES patches, so the second sweep sees state 'idle' and now runs the dead-check:
      // detection latency is exactly one extra sweep, not never.
      const res2 = await rec.reconcile();
      assert.deepEqual(res2.vanished, ['t-rec']);
      const vanishEvent = events.find((e) => e.payload?.reason === 'pane-dead');
      assert.ok(vanishEvent, 'expected a pane-dead vanish event on the second sweep');
    });

    // T7 — reconciler: missing session still vanishes as 'session-vanished' (unregressed).
    await t.test('T7 — a missing session still vanishes as session-vanished', async () => {
      await killScratch();
      const { rec, patches, events, vanishedTerms } = harness([stubTerm({ state: 'idle' })]);
      const res = await rec.reconcile();
      assert.deepEqual(res.vanished, ['t-rec']);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]!.payload, { reason: 'session-vanished', resumable: true, sessionId: 'sess-1' });
      assert.equal(vanishedTerms.length, 1);
      const killPatch = patches.find((p) => p.patch.state === 'killed');
      assert.ok(killPatch, 'expected a killed patch for t-rec');
      assert.equal(typeof killPatch!.patch.closedAt, 'string');
    });

    // T8 — reconciler: fresh 'starting' with NO session is left alone (grace unregressed).
    await t.test('T8 — a fresh starting terminal with no session is left alone', async () => {
      await killScratch();
      const { rec, patches, events, vanishedTerms } = harness([stubTerm({ state: 'starting', createdAt: new Date().toISOString() })]);
      const res = await rec.reconcile();
      assert.deepEqual(res.vanished, []);
      assert.equal(patches.length, 0);
      assert.equal(events.length, 0);
      assert.equal(vanishedTerms.length, 0);
    });

    // T9 — D1 regression: a live CLI pane beside a dead FOCUSED split must NOT read dead, and the
    // terminal must NOT be vanished. The old active-pane probe (display-message -t main) read the
    // dead split and would have destroyed a live terminal (tokens deleted, loop failed).
    await t.test('T9 — a live pane beside a dead focused split is not dead, and is not vanished', async () => {
      await spawnLiveWithDeadSplit();
      assert.equal(await isPaneDead(SOCK), false);
      const { rec, patches, events, vanishedTerms } = harness([stubTerm({ state: 'working' })]);
      const res = await rec.reconcile();
      assert.deepEqual(res.vanished, []);
      assert.equal(patches.length, 0);
      assert.equal(events.length, 0);
      assert.equal(vanishedTerms.length, 0);
    });

    // T10 — D2: a pane-dead vanish must reap the still-live tmux server, or the corpse leaks forever
    // (the killed record is skipped every sweep and its orphan socket is only logged, never killed).
    await t.test('T10 — a pane-dead vanish reaps the corpse tmux server', async () => {
      await spawnLive();
      await makePaneDead();
      assert.equal(await serverAlive(), true, 'the corpse server is alive before the vanish (that is what made hasSession lie)');
      const { rec } = harness([stubTerm({ state: 'working' })]);
      const res = await rec.reconcile();
      assert.deepEqual(res.vanished, ['t-rec']);
      // Poll for the reap: `kill-server` returns before the server process has fully exited, so a
      // single has-session immediately after can race it under load. The reap itself is what we
      // assert; a short bounded poll removes the exit-timing flake without weakening it.
      let reaped = false;
      for (let i = 0; i < 40; i++) { if (!(await serverAlive())) { reaped = true; break; } await wait(50); }
      assert.ok(reaped, 'the corpse tmux server must be reaped by the pane-dead vanish');
    });

    // T11 — SPEC-RESTART-RESUME FIX A: a pane-dead terminal reported in-flight (TerminalManager mid
    // restart, or mid its detached resume health-check) must NOT be vanished this sweep — the
    // reconciler's 15s timer is not phase-locked to a restart, so this is exactly the window a
    // refused --resume's watcher needs to fall forward without the reconciler force-failing the
    // loop underneath it. The socket must still be accounted for (never misreported as an orphan),
    // and the SAME terminal, no longer in flight, vanishes exactly as T4 did (the contrast proving
    // the deferral — not a broken probe — is what suppressed the vanish).
    await t.test('T11 — a pane-dead terminal reported restartInFlight is skipped entirely this sweep; the same terminal not-in-flight vanishes as before', async () => {
      await spawnLive();
      await makePaneDead();
      const inFlight = harness([stubTerm({ state: 'working' })], (id) => id === 't-rec');
      const res1 = await inFlight.rec.reconcile();
      assert.deepEqual(res1.vanished, [], 'deferred — never vanished while in flight');
      assert.equal(inFlight.patches.length, 0);
      assert.equal(inFlight.events.length, 0);
      assert.equal(inFlight.vanishedTerms.length, 0);

      // Contrast: the identical dead pane, same store shape, WITHOUT the in-flight report — vanishes.
      const notInFlight = harness([stubTerm({ state: 'working' })]);
      const res2 = await notInFlight.rec.reconcile();
      assert.deepEqual(res2.vanished, ['t-rec']);
      assert.equal(notInFlight.vanishedTerms.length, 1);
    });
  } finally {
    await killScratch();
  }
});
