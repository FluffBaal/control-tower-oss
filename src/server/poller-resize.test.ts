// The resize quiet-window in the poller — the load-bearing half of terminal fit-to-pane.
//
// A viewer fitting its xterm to the pane reflows the tmux window, and the reflow changes the
// snapshot. Without the guard the poller's change-heuristic reads that churn as output -> promotes
// an IDLE agent to 'working' (a prior revision hardcoded 80x24 to dodge exactly this), which then
// wedges busy-aware loop starts. These cases prove the guard:
//   1. a snapshot change WITHIN the quiet window does NOT promote (clause 1: the deadline);
//   2. even AFTER the deadline, a first sweep whose baseline predates the resize is STILL
//      suppressed (clause 2: change-detection resumes only off a >=1s-post-resize baseline — the
//      delayed-sweep leak that a pure-deadline guard would let through);
//   3. a genuine change once the window has closed promotes normally (the guard isn't permanent).
//
// Driven against a REAL scratch tmux pane (non-`ct-` socket the reconciler never sees) painted with
// `exec sleep 600` so the pane process is childless — paneHasActiveWork stays false, isolating the
// screen-change path. Date.now is frozen so the timing is deterministic, never a wall-clock race;
// and every scripted tick is SWEEP-VERIFIED (tickSwept) so the poller's deliberate stalled-probe
// skip-and-retry can never silently drop a load-bearing tick from the script.
// Self-skips when tmux is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { MissionControl } from './mission.js';
import type { ProviderStore } from './providers/store.js';
import type { Terminal } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-poller-resize-'));
process.env.CT_HOME = home;

const pexec = promisify(execFile);
const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);

const { Poller } = await import('./poller.js');
const { ProviderRegistry } = await import('./providers/registry.js');
const { capturePlain } = await import('./tmux.js');

const SOCK = `pollerresize-${process.pid}`; // NOT ct-* : the reconciler must never adopt it
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const killScratch = async (): Promise<void> => {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
};

/** (Re)paint the pane with `content` and wait for it to actually render. `exec sleep 600` replaces
 *  the shell with a childless sleep, so the pane text stays while paneHasActiveWork reads false. */
async function paint(content: string): Promise<void> {
  // STAGED retry, bounded and loud: under full-suite load the kill-server → new-session pair on
  // the same socket can race the dying server ("server exited unexpectedly" — the fresh server
  // binds the socket, then exits with the old one). This is pure fixture staging, before any
  // product interaction, so re-staging here can never mask a product regression — a mid-drive
  // server death surfaces as different messages ("no server running", "error connecting") and any
  // other spawn failure still throws at once.
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      // Same loud-triage framing as the render throw below: a new-session that never came back is a
      // tmux infra failure under load, not a product verdict — name it so a red run triages itself.
      await pexec('tmux', ['-L', SOCK, 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '24',
        `sh -c 'printf "%s\\n" "${content}"; exec sleep 600'`], { timeout: 10_000 }).catch((e) => {
        throw new Error(`paint: new-session failed (tmux infra error under load): ${(e as Error).message}`);
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] paint attempt ${attempt} lost the fresh tmux server to the kill-server race; re-staging`);
    }
  }
  for (let i = 0; i < 100; i++) {
    if ((await capturePlain(SOCK, 60)).includes(content)) return;
    await wait(50);
  }
  // Never give up SILENTLY: an unpainted pane makes a positive control (must-promote) flake red and,
  // worse, lets a suppression assert pass trivially against stale bytes. Throw — this is a tmux infra
  // failure under load, not a product verdict.
  throw new Error(`paint: pane never rendered ${JSON.stringify(content)} (tmux infra error under load)`);
}

/**
 * Drive ONE sweep of `termId` to completion. tick() deliberately skips a terminal whose has-session
 * probe stalls (production skip-and-retry: the interval just retries next tick), but this file's
 * scripts are fixed-tick — EVERY scripted tick is load-bearing (baseline / suppress / settle /
 * promote), so a silently skipped sweep either breaks the script a tick later (a skipped settle
 * leaves baselineAt stale, so clause 2 CONSUMES the change) or lets a suppression assert pass
 * vacuously against untouched state. Re-tick until THIS terminal's sweep actually ran: a skipped
 * sweep touches none of its state and Date.now is frozen, so each retry is a pure re-attempt at the
 * same instant. The retry is PER tick, never trailing — the first post-stall sweep consumes a
 * pending change under clause-2 suppression, after which no amount of re-ticking can promote.
 * Bounded and LOUD, like paint(): exhausting the tries is a tmux infra failure under load.
 */
async function tickSwept(poller: InstanceType<typeof Poller>, termId: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const { swept } = await poller.tick();
    if (swept.includes(termId)) return;
  }
  throw new Error(`tickSwept: ${termId} never swept in 8 ticks (tmux infra error under load)`);
}

/** A poller wired to a single stub terminal + a spy mission that records every ingest signal. */
function harness() {
  const registry = new ProviderRegistry({ list: () => [] } as unknown as ProviderStore);
  const ingested: string[] = [];
  const mission = {
    ingest: async (_id: string, signal: string): Promise<boolean> => {
      ingested.push(signal);
      return true;
    },
  } as unknown as MissionControl;
  const term: Terminal = {
    id: 't-resize', projectId: 'p1', title: 'builder', provider: 'claude-code',
    tmuxSocket: SOCK, cwd: home, command: ['claude'], state: 'idle',
    createdAt: new Date().toISOString(),
    // lastEventAt intentionally absent -> the terminal reads STALE -> the poller acts on it.
  };
  const store = {
    listTerminals: () => [term],
    getTerminal: (id: string) => (id === term.id ? term : undefined),
  } as unknown as Store;
  const poller = new Poller(store, mission, registry, 10, 20_000, 300_000); // quietMs = 10 + 5000
  return { poller, ingested, termId: term.id };
}

// ---- SPEC-LOOPWEDGE F2: the built-in affirmative-idle backstop (the ROOT heal for a lost Stop) ----

const RULE = '─'.repeat(40);
const NBSP = ' '; // the marker separator claude renders after the composer prompt

/** Paint MULTI-LINE content (the poller-resize `paint` only takes one line). */
async function paintLines(lines: string[], ready: string): Promise<void> {
  const screen = lines.join('\\n');
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      await pexec('tmux', ['-L', SOCK, 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '24',
        `sh -c 'printf "${screen}\\n"; exec sleep 600'`], { timeout: 10_000 }).catch((e) => {
        throw new Error(`paintLines: new-session failed (tmux infra error under load): ${(e as Error).message}`);
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] paintLines attempt ${attempt} lost the fresh tmux server to the kill-server race; re-staging`);
    }
  }
  for (let i = 0; i < 100; i++) {
    if ((await capturePlain(SOCK, 60)).includes(ready)) return;
    await wait(50);
  }
  throw new Error(`paintLines: pane never rendered ${JSON.stringify(ready)} (tmux infra error under load)`);
}

/** A poller over a single WORKING built-in claude terminal + a spy mission recording each ingest,
 *  including the 4th (inferred) arg — the F2 demote must ingest turn-done with inferred true. */
function workingHarness() {
  const registry = new ProviderRegistry({ list: () => [] } as unknown as ProviderStore);
  const ingested: { signal: string; inferred: boolean }[] = [];
  const mission = {
    ingest: async (_id: string, signal: string, _emitTs?: string, inferred = false): Promise<boolean> => {
      ingested.push({ signal, inferred });
      return true; // report a state change so flagInferred runs; the stub does not flip term.state
    },
  } as unknown as MissionControl;
  const term: Terminal = {
    id: 't-wedged', projectId: 'p1', title: 'builder', provider: 'claude-code',
    tmuxSocket: SOCK, cwd: home, command: ['claude'], state: 'working', // the wedged record a lost Stop leaves
    createdAt: new Date().toISOString(),
    // lastEventAt absent → STALE → the poller acts on it.
  };
  const store = {
    listTerminals: () => [term],
    getTerminal: (id: string) => (id === term.id ? term : undefined),
  } as unknown as Store;
  const poller = new Poller(store, mission, registry, 10, 20_000, 300_000);
  return { poller, ingested, termId: term.id, term };
}

test('SPEC-LOOPWEDGE F2 — a built-in working record heals to idle on affirmative-idle evidence; a busy footer never demotes',
  { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {

  await t.test('a wedged working claude with an empty composer + no busy footer demotes to an INFERRED idle', async () => {
    const { poller, ingested, termId } = workingHarness();
    try {
      await paintLines([RULE, `❯${NBSP}`, RULE, '  ⏸ manual mode on'], '❯');
      // BUILTIN_AFFIRM_DWELL is 3 stable polls; a couple extra ticks absorb any load hiccup.
      for (let i = 0; i < 6; i++) await tickSwept(poller, termId);
      const demote = ingested.find((e) => e.signal === 'turn-done');
      assert.ok(demote, 'the affirmative-idle evidence healed the lost Stop (working → idle)');
      assert.equal(demote?.inferred, true, 'and the demote is marked INFERRED so the loop GUARD can never auto-pass it');
      // It must never PROMOTE the idle-looking screen to working.
      assert.ok(!ingested.some((e) => e.signal === 'session-start'), 'an idle composer is never read as work');
    } finally {
      await killScratch();
    }
  });

  await t.test('a mid-turn claude (empty composer BUT the pinned busy footer) is NEVER demoted', async () => {
    const { poller, ingested, termId } = workingHarness();
    try {
      // The critical exclusion: claude's composer renders EMPTY mid-turn, so composerPending reads
      // false and a frozen mid-turn pane is childless + byte-stable — every other check passes. Only
      // the pinned `esc to interrupt` footer marks it busy. Removing that footer check (a mutation)
      // would let this demote, so this pins it shut across well past the dwell.
      await paintLines([RULE, `❯${NBSP}`, RULE, '  esc to interrupt · press to stop'], 'esc to interrupt');
      for (let i = 0; i < 6; i++) await tickSwept(poller, termId);
      assert.ok(!ingested.some((e) => e.signal === 'turn-done'), 'a mid-turn pane must never be force-idled by the backstop');
    } finally {
      await killScratch();
    }
  });

  await t.test('H2 — a fresh-window tick resets the dwell so a post-turn stale poll cannot shortcut it', async () => {
    const { poller, ingested, termId, term } = workingHarness();
    try {
      await paintLines([RULE, `❯${NBSP}`, RULE, '  ⏸ manual mode on'], '❯');
      // Phase 1: STALE idle polls build stableCount well past the dwell (the stub never flips state, so
      // it keeps demoting — we only care about the carried count).
      for (let i = 0; i < 5; i++) await tickSwept(poller, termId);
      // Phase 2: a FRESH event lands (a new turn started) — one !mustPoll tick must reset the count.
      term.lastEventAt = new Date().toISOString();
      await tickSwept(poller, termId);
      // Phase 3: the (short) turn ended; the record is stale again with the SAME idle screen. With H2
      // the dwell restarts from zero, so a SINGLE stale poll (count → 1) must NOT reach the dwell.
      // Reverting H2 carries the phase-1 count through the fresh tick, so this one poll demotes.
      term.lastEventAt = new Date(Date.now() - 30_000).toISOString();
      const before = ingested.filter((e) => e.signal === 'turn-done').length;
      await tickSwept(poller, termId);
      const after = ingested.filter((e) => e.signal === 'turn-done').length;
      assert.equal(after, before, 'one stale poll after a fresh-window reset must not reach the dwell (no demote)');
    } finally {
      await killScratch();
    }
  });
});

test('the resize quiet-window suppresses a change but resumes off a post-resize baseline',
  { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {

  await t.test('a snapshot change inside the window does not promote to working', async () => {
    const { poller, ingested, termId } = harness();
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      await paint('AAAAA');
      await tickSwept(poller, termId); // baseline: no prev hash -> no promotion
      assert.deepEqual(ingested, [], 'the baseline sweep must not promote');

      poller.noteViewerResize(termId); // resizeAt = clock
      await paint('BBBBB');            // the reflow changes the snapshot
      clock += 100;                    // still far inside quietMs (5010)
      await tickSwept(poller, termId);
      assert.deepEqual(ingested, [], 'a change during the quiet window must be suppressed');

      // Once the window has closed AND a fresh post-resize baseline exists, a real change promotes.
      clock += 20_000;
      await tickSwept(poller, termId); // screen still BBBBB -> settles the post-resize baseline
      await paint('CCCCC');
      clock += 100;
      await tickSwept(poller, termId);
      assert.deepEqual(ingested, ['session-start'], 'a change after the window must promote');
    } finally {
      Date.now = realNow;
      await killScratch();
    }
  });

  await t.test('clause 1 (the deadline) suppresses a change even off a fresh post-resize baseline', async () => {
    // Isolates the deadline clause: establish a baseline that POSTDATES the resize (so clause 2 is
    // false), then change the screen while still inside quietMs — only clause 1 can catch it. Deleting
    // the deadline clause turns this red.
    const { poller, ingested, termId } = harness();
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      await paint('AAAAA');
      await tickSwept(poller, termId);
      poller.noteViewerResize(termId);        // resizeAt = T0
      clock += 1500;                          // past the +1000 clause-2 margin, still << quietMs (5010)
      await tickSwept(poller, termId);        // UNCHANGED screen -> rebaselines baselineAt to T0+1500 (clause 2 now false)
      assert.deepEqual(ingested, [], 'the post-resize rebaseline sweep must not promote');
      await paint('DDDDD');                   // a change still INSIDE the deadline window
      clock += 100;                           // T0+1600, < T0+quietMs
      await tickSwept(poller, termId);
      assert.deepEqual(ingested, [], 'a change inside the deadline must be suppressed by clause 1');
    } finally {
      Date.now = realNow;
      await killScratch();
    }
  });

  await t.test('re-arming at reflow-completion suppresses a change a single early note would leak', async () => {
    // The HIGH fix: the pre-attach note (resizeAt=T0) can expire before a slow socket's reflow lands;
    // onReflow re-arms resizeAt at reflow-completion time. Simulate that second note and prove the
    // post-reflow change is suppressed — where, with only the early note, the deadline would be blown.
    const { poller, ingested, termId } = harness();
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      await paint('AAAAA');
      await tickSwept(poller, termId);         // baseline T0
      poller.noteViewerResize(termId);         // early (pre-attach) note: resizeAt = T0
      clock += 1500;                           // inside the early window, past the +1000 clause-2 margin
      await tickSwept(poller, termId);         // unchanged screen → rebaselines baselineAt=T0+1500 (clause 2 now false off T0)
      clock += 18_500;                         // slow-socket delay: T0's window (T0+quietMs) has expired
      poller.noteViewerResize(termId);         // onReflow re-arm at reflow-completion — now the ONLY thing suppressing
      await paint('BBBBB');                    // the reflow content lands now
      clock += 100;
      await tickSwept(poller, termId);         // inside the RE-ARMED window
      // Discriminates: WITHOUT the re-arm note, resizeAt stays T0, both clauses are false at this tick,
      // and the change promotes → this assert goes red. The re-arm is what keeps it suppressed.
      assert.deepEqual(ingested, [], 're-armed quiet-window must suppress the reflow read as work');
    } finally {
      Date.now = realNow;
      await killScratch();
    }
  });

  await t.test('a late first sweep whose baseline predates the resize is still suppressed', async () => {
    const { poller, ingested, termId } = harness();
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      await paint('AAAAA');
      await tickSwept(poller, termId);  // baselineAt = clock (T0)
      assert.deepEqual(ingested, [], 'the baseline sweep must not promote');

      poller.noteViewerResize(termId);  // resizeAt = T0
      await paint('BBBBB');             // the reflow changes the snapshot
      // No tick runs during the window, so the baseline still predates the resize. Jump 20s PAST the
      // ~5s deadline: clause 1 has expired, only the baseline-aware clause 2 can still catch this.
      clock += 20_000;
      await tickSwept(poller, termId);
      assert.deepEqual(ingested, [], 'a late first sweep off a pre-resize baseline must be suppressed');
    } finally {
      Date.now = realNow;
      await killScratch();
    }
  });
});
