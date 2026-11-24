// SPEC-RESTART §3 — the loop re-arm after an IN-PLACE pane respawn (restartTerminal), and its
// interplay with the spawn-latch / first-inject belt. The correctness contract under test:
//
//   - onTerminalRestarted re-arms the CURRENT iteration: the loop stays 'running', is never failed
//     (the kill path's onTerminalGone contrast), never double-injects, and never falsely completes.
//   - a runtime describing an in-flight turn is DROPPED so driveOne's runtime-lost restore branch
//     re-arms — and, because the pane is marked fresh, the restore RE-ARMS instead of observing the
//     re-stamped 'working' latch (observing would wait on a turn-done hook the never-driven fresh
//     process can never fire, until the wall-clock ceiling gated the loop).
//   - a never-injected 'launching' runtime is KEPT (queued feedback preserved — the pause() posture),
//     with the dead process's pane evidence voided.
//   - the spawn-latch belt then opens at ANY iteration for the fresh pane — still gated on the same
//     positive two-tick idle evidence — where an un-restarted mid-loop 'working' pane must keep
//     deferring unconditionally (the flag, not the iteration number, is what extends eligibility).
//   - the freshness mark is consumed by the next successful injection and cleared by onTerminalGone.
//
// Driven against a real scratch tmux pane (non-`ct-` socket) painted with the provider's real idle
// frame, exactly as loops-firstinject.test.ts drives the iteration-1 belt — a painted static pane
// cannot truly submit, so belt-opened cases assert the `loop.inject.firstturn` audit + the no-appear
// send failure, not a completed turn. Self-skips when tmux is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Loop, LoopIteration, Terminal, ProviderId, TerminalState } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-loops-restart-test-'));
process.env.CT_HOME = home;

const pexec = promisify(execFile);
const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { Loops } = await import('./loops.js');
const { auditTail } = await import('./audit.js');
const tmux = await import('./tmux.js');
const { ProviderStore } = await import('./providers/store.js');
const { initProviderRegistry } = await import('./providers/registry.js');
initProviderRegistry(new ProviderStore());

const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);
const SOCK = `looprestart-${process.pid}`; // NOT ct-* : the reconciler must never see it
const RULE = '─'.repeat(78);
const NBSP = ' '; // the non-breaking space claude renders after the composer marker (an escape, not a literal)
const CLAUDE_IDLE = [RULE, `❯${NBSP}`, RULE, '  ⏸ manual mode on'];

const killScratch = async (): Promise<void> => {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Paint arbitrary visible lines into a scratch pane (loops-firstinject's fixture): `exec sleep 600`
 *  keeps the pane childless so a lingering child can't mask the belt; polls for the painted frame.
 *  30 rows, not a terminal-default 12: the injected prompt ECHOES into the pane (tty echo, no CLI to
 *  consume it) and now always carries the standing memory footer (SPEC-MEMADOPT) — a short pane would
 *  scroll the painted composer frame off-screen mid-send, turning the classifier's affirmative
 *  "empty composer" into inconclusive and dissolving the no-appear rejections these cases pin. */
async function paint(lines: string[], ready: string): Promise<void> {
  const screen = lines.join('\\n');
  // STAGED retry, bounded and loud: under full-suite load the kill-server → new-session pair on
  // the same socket can race the dying server ("server exited unexpectedly" — the fresh server
  // binds the socket, then exits with the old one). This is pure fixture staging, before any
  // product interaction, so re-staging here can never mask a product regression — a mid-drive
  // server death surfaces as different messages ("no server running", "error connecting") and any
  // other spawn failure still throws at once.
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      await pexec('tmux', ['-L', SOCK, 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '30',
        `sh -c 'printf "${screen}\\n"; exec sleep 600'`], { timeout: 10_000 });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] paint attempt ${attempt} lost the fresh tmux server to the kill-server race; re-staging`);
    }
  }
  for (let i = 0; i < 50; i++) {
    if ((await tmux.captureVisible(SOCK)).includes(ready)) return;
    await wait(100);
  }
}

let seq = 0;
/** A mid-loop harness: iteration N with a completed history, the builder re-stamped 'working' (the
 *  restart re-latch) — the exact post-restart shape. `rt` is parked by each subtest.
 *  `checkCommand: null` = a loop with NO check (the finishIteration cases need to steer verdicts). */
function harness(opts: {
  provider?: ProviderId; iteration?: number; state?: TerminalState; status?: Loop['status'];
  gatePolicy?: Loop['gatePolicy']; checkCommand?: string | null;
} = {}) {
  const provider = opts.provider ?? 'claude-code';
  const iteration = opts.iteration ?? 3;
  const store = new Store();
  const repo = join(home, `repo-${seq++}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  const projectId = 'p1';
  store.upsertProject({ id: projectId, name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  const now = new Date().toISOString();
  const termId = `t-${seq}`;
  const loopId = `l-${seq}`;
  const command = provider === 'codex' ? ['codex'] : provider === 'gemini-cli' ? ['gemini'] : ['claude'];
  const term: Terminal = {
    id: termId, projectId, title: 'builder', provider, tmuxSocket: SOCK,
    cwd: repo, command, state: opts.state ?? 'working', createdAt: now,
  };
  store.upsertTerminal(term);
  // History: n-2 passed, n-1 FAILED with a check tail (the feedback the restore must rebuild),
  // n pending — the loop was mid-iteration-N when its pane wedged and was restarted.
  const iterations: LoopIteration[] = [];
  for (let n = 1; n <= iteration - 2; n++) iterations.push({ n, verdict: 'pass', startedAt: now, endedAt: now });
  if (iteration >= 2) iterations.push({ n: iteration - 1, verdict: 'fail', checkTail: 'boom: 1 test failed', startedAt: now, endedAt: now });
  iterations.push({ n: iteration, verdict: 'pending', startedAt: now });
  const loop: Loop = {
    id: loopId, projectId, name: 'l', task: 'do the thing', provider,
    checkCommand: opts.checkCommand === null ? undefined : (opts.checkCommand ?? 'run-checks'),
    gatePolicy: opts.gatePolicy ?? 'never', maxIterations: 8, status: opts.status ?? 'running', iteration,
    iterations, terminalId: termId, createdAt: now, updatedAt: now,
  };
  store.upsertLoop(loop);
  const loops = new Loops({ store, tm: {} as never, worktrees: {} as never, accounts: {} as never, onUpdate: () => {} });
  const inner = loops as unknown as {
    rt: Map<string, Record<string, unknown>>;
    freshPanes: Set<string>;
    restartPreservedControl: Map<string, { pauseRequested?: boolean; stepOnce?: boolean }>;
    driveOne(l: Loop): Promise<void>;
    finishIteration(id: string): Promise<void>;
  };
  return {
    store, loops, loopId, termId, repo,
    drive: (): Promise<void> => inner.driveOne(store.getLoop(loopId)!),
    finish: (): Promise<void> => inner.finishIteration(loopId),
    rt: (): Record<string, unknown> | undefined => inner.rt.get(loopId),
    setRt: (v: Record<string, unknown>): void => { inner.rt.set(loopId, v); },
    fresh: (): boolean => inner.freshPanes.has(termId),
    preserved: (): { pauseRequested?: boolean; stepOnce?: boolean } | undefined => inner.restartPreservedControl.get(loopId),
    setPreserved: (v: { pauseRequested?: boolean; stepOnce?: boolean }): void => { inner.restartPreservedControl.set(loopId, v); },
    loop: (): Loop => store.getLoop(loopId)!,
    firstturnFired: (): boolean =>
      auditTail(500).some((e) => e.action === 'loop.inject.firstturn' && e.loopId === loopId),
    rearmFired: (): boolean =>
      auditTail(500).some((e) => e.action === 'loop.rearm' && e.loopId === loopId),
  };
}

/** Freeze Date.now for deterministic probe-pair aging (the loops-firstinject idiom): frozen, a
 *  too-young pair reads 0ms however slow tmux is, and the verify budget can never expire a
 *  no-appear into 'unverified'. Restores in finally. */
async function withFrozenClock(fn: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    await fn((ms) => { clock += ms; });
  } finally {
    Date.now = realNow;
  }
}

/** Bounded, LOUD, attempt-level retry for the subtests that pin a hard no-appear rejection. That
 *  rejection requires every `capture-pane` across the drive's verify window to SUCCEED: under
 *  full-suite load a capture occasionally fails outright, captureVisible maps any failure to ''
 *  (an inconclusive read), and the product — correctly, the ⟦DEC-4⟧ posture — degrades to an
 *  audited 'unverified' send, or the belt holds no probe, instead of throwing. So the drive
 *  resolves and the pinned rejection goes missing without anything being wrong. The frozen clock
 *  already immunizes these cases against pure latency; capture FAILURE is the one residual, and
 *  it cannot be retried mid-subtest (an 'unverified' send still consumes the injection), so the
 *  retry re-stages the WHOLE body — repaint + fresh harness — and re-runs the SAME assertions.
 *  Gated to the two capture-hiccup signatures: any OTHER failure is a genuine regression and
 *  rethrows on the FIRST attempt, and the last attempt always rethrows, so a regression that
 *  truly removes the rejection still surfaces. */
async function withInfraRetry(name: string, body: () => Promise<void>, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await body();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const captureHiccup = /Missing expected rejection|the first clean observation is held/.test(msg);
      if (!captureHiccup || attempt >= attempts) throw err;
      console.error(`[infra-retry] ${name} attempt ${attempt} failed: ${msg}; re-attempting`);
    }
  }
}

test('the restart re-arm + spawn-latch interplay', { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {
  await t.test('A — a mid-turn restart re-arms the CURRENT iteration, then the belt injects it', async () => {
    await withInfraRetry('A', async () => {
      await paint(CLAUDE_IDLE, '❯');
      await withFrozenClock(async (advance) => {
        const h = harness(); // iteration 3, pane re-stamped 'working'
        // The turn for iteration 3 was in flight when the pane was respawned.
        h.setRt({ phase: 'await-done', injectAt: 0, injectedAt: Date.now() - 5000, sawWorking: true, idleTicks: 0 });

        h.loops.onTerminalRestarted(h.termId);
        assert.equal(h.rt(), undefined, 'an in-flight runtime is dropped for the restore branch');
        assert.equal(h.fresh(), true, 'the pane is marked fresh');
        assert.ok(h.rearmFired(), 'the re-arm is audited');
        assert.equal(h.loop().status, 'running', 'the loop was NEVER failed (the kill-path contrast)');

        // Tick 1 — the runtime-lost restore. The pane reads 'working' (the respawn re-latch), but the
        // fresh mark must route to RE-ARM, not observe: nothing in the new process is running.
        await h.drive();
        const r1 = h.rt();
        assert.equal(r1?.phase, 'launching', 'the restore RE-ARMED instead of observing the spawn latch');
        assert.equal(r1?.injectedAt, 0);
        assert.match(String(r1?.feedback), /boom: 1 test failed/, 'the failed-check feedback was rebuilt from the record');
        assert.equal(h.loop().iteration, 3, 'the CURRENT iteration is re-armed — never skipped');

        // Tick 2 — past the settle window: the belt takes its first clean observation and defers.
        advance(1300);
        await h.drive();
        assert.equal(h.firstturnFired(), false, 'one observation must not open the belt');
        assert.equal(h.rt()?.injectedAt, 0);
        assert.equal(typeof h.rt()?.firstProbe, 'string', 'the first clean observation is held for the pair');

        // Tick 3 — the aged matching pair opens the belt AT ITERATION 3 (the fresh mark, not the
        // iteration number, is the eligibility). The painted static pane cannot fill its composer, so
        // the send fails no-appear — but the belt DID open and the injection was attempted exactly once.
        advance(1700);
        await assert.rejects(
          () => h.drive(),
          (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'no-appear',
          'a painted static pane cannot fill its composer',
        );
        assert.equal(h.firstturnFired(), true, 'the belt opened past iteration 1 for the fresh pane');
        assert.equal(h.loop().status, 'running', 'still running — never failed, never gated below the ceiling');
        assert.equal(h.loop().iteration, 3, 'iteration unchanged');
        assert.equal(h.loop().iterations.length, 3, 'no phantom iteration was opened — no double-inject');
        assert.equal(h.loop().iterations[2]!.verdict, 'pending', 'and never falsely completed');
        assert.equal(h.fresh(), true, 'an unconfirmed send does not spend the freshness mark');
      });
    });
  });

  await t.test('B — WITHOUT the restart mark, the same shape observes / defers (the flag is load-bearing)', async () => {
    // B guards the driveOne RESTORE-branch discrimination (fresh → re-arm vs non-fresh → observe): a
    // lost runtime with no fresh mark OBSERVES the working pane (it could be a real in-flight turn) and
    // so never reaches injectPrompt's belt at all. (Since SPEC-LOOPWEDGE F3 the injectPrompt belt runs
    // for ANY launching inject regardless of iteration/freshness — see loops-firstinject.test.ts case C
    // for that heal + its mid-turn defer; here the point is that the restore OBSERVES rather than
    // injecting, so no belt fires down this path.)
    await paint(CLAUDE_IDLE, '❯');
    await withFrozenClock(async (advance) => {
      const h = harness(); // iteration 3, 'working' — but NOT restarted
      // A lost runtime with no fresh mark is the plain Tower-restart shape: state 'working' must be
      // OBSERVED (it could be a real in-flight turn — typing over it would corrupt it).
      await h.drive();
      assert.equal(h.rt()?.phase, 'await-done', 'un-restarted: the restore observes the working pane');
      // And even across the full stability window, no belt and no injection at iteration 3.
      advance(1700);
      await h.drive();
      assert.equal(h.firstturnFired(), false, 'a mid-loop working pane never opens the belt un-restarted');
      assert.equal(h.loop().status, 'running');
    });
  });

  await t.test('C — a never-injected launching runtime is KEPT: queued feedback survives, pane evidence is voided', async () => {
    await withInfraRetry('C', async () => {
      await paint(CLAUDE_IDLE, '❯');
      await withFrozenClock(async (advance) => {
        const h = harness({ iteration: 2 });
        h.setRt({
          phase: 'launching', injectAt: Date.now() - 1000, injectedAt: 0, sawWorking: false, idleTicks: 0,
          feedback: 'steer left', deferSince: Date.now() - 9000, firstProbe: 'stale-screen', firstProbeAt: Date.now() - 9000,
          reEnter: 1, sentTail: 'stale-tail',
        });
        h.loops.onTerminalRestarted(h.termId);
        const r = h.rt();
        assert.ok(r, 'the runtime survives — the queued iteration plan is still right');
        assert.equal(r?.feedback, 'steer left', 'queued feedback is preserved (never rebuilt lossily)');
        assert.equal(r?.deferSince, undefined, 'the dead process’s defer anchor is voided');
        assert.equal(r?.firstProbe, undefined, 'stale probe evidence is voided');
        assert.equal(r?.firstProbeAt, undefined);
        assert.equal(r?.reEnter, undefined);
        assert.equal(r?.sentTail, undefined);
        assert.equal(h.fresh(), true);

        // The kept runtime then belt-injects at iteration 2: observation, aged pair, open, send.
        await h.drive();
        assert.equal(typeof h.rt()?.firstProbe, 'string', 'the first clean observation is held for the pair');
        advance(1700);
        await assert.rejects(
          () => h.drive(),
          (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'no-appear',
        );
        assert.equal(h.firstturnFired(), true, 'the belt opened off the kept runtime');
        assert.equal(h.loop().iteration, 2);
      });
    });
  });

  await t.test('D — a paused loop keeps its runtime; resume re-arms the SAME iteration onto the fresh pane', async () => {
    await withInfraRetry('D', async () => {
      await paint(CLAUDE_IDLE, '❯');
      await withFrozenClock(async (advance) => {
        const h = harness({ iteration: 2, status: 'paused' });
        h.setRt({ phase: 'launching', injectAt: 0, injectedAt: 0, sawWorking: false, idleTicks: 0, feedback: 'keep going' });
        h.loops.onTerminalRestarted(h.termId);
        assert.ok(h.rt(), 'a paused-mid-launch runtime is kept');
        assert.equal(h.rt()?.feedback, 'keep going');
        assert.equal(h.fresh(), true);

        h.loops.resume(h.loopId);
        assert.equal(h.loop().status, 'running');
        assert.equal(h.loop().iteration, 2, 'resume re-armed the SAME iteration, not the next');
        advance(1300); // past the resume settle
        await h.drive();
        assert.equal(typeof h.rt()?.firstProbe, 'string', 'the first clean observation is held for the pair');
        advance(1700);
        await assert.rejects(
          () => h.drive(),
          (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'no-appear',
        );
        assert.equal(h.firstturnFired(), true, 'the resumed inject opened the belt on the fresh pane');
      });
    });
  });

  await t.test('E — a successful injection SPENDS the freshness mark', async () => {
    // gemini's classifier reads an unrecognized frame as inconclusive (never affirmatively empty),
    // so the verified-send primitive degrades and RETURNS instead of throwing — the injection
    // completes against the painted pane and the consume point is reached.
    await paint(['just some output', 'nothing like a composer'], 'output');
    const h = harness({ provider: 'gemini-cli', iteration: 2, state: 'idle' });
    h.setRt({ phase: 'launching', injectAt: Date.now() - 1000, injectedAt: 0, sawWorking: false, idleTicks: 0 });
    h.loops.onTerminalRestarted(h.termId);
    assert.equal(h.fresh(), true);
    await h.drive(); // idle pane → plain send path → completes (unverified)
    assert.equal(h.rt()?.phase, 'await-start', 'the injection completed');
    assert.ok((h.rt()?.injectedAt as number) > 0);
    assert.equal(h.fresh(), false, 'the driven pane is no longer fresh — the latch exception is spent');
  });

  await t.test('F — scope: unbound terminals are a no-op; finished loops are untouched; gone clears the mark', async () => {
    const h = harness(); // one bound running loop
    h.loops.onTerminalRestarted('t-unbound');
    assert.equal(h.rearmFired(), false, 'a restart of a non-loop terminal fires no loop hook');
    assert.equal((h.loops as unknown as { freshPanes: Set<string> }).freshPanes.size, 0);

    h.store.patchLoop(h.loopId, { status: 'done' });
    h.loops.onTerminalRestarted(h.termId);
    assert.equal(h.rearmFired(), false, 'a finished loop is not re-armed');
    assert.equal(h.fresh(), false, 'and marks no pane fresh');

    h.store.patchLoop(h.loopId, { status: 'running' });
    h.loops.onTerminalRestarted(h.termId);
    assert.equal(h.fresh(), true);
    h.loops.onTerminalGone(h.termId);
    assert.equal(h.fresh(), false, 'a killed pane is not a fresh pane');
    assert.equal(h.loop().status, 'failed', 'kill semantics are untouched — gone still fails the loop');
  });

  await t.test('G — a restart during a pending Pause / Step-once preserves the operator intent to finishIteration', async () => {
    // pause() mid-turn parks pauseRequested on the RUNTIME and leaves the loop 'running' until
    // finishIteration honors it. The restart's delete branch drops that runtime — without the
    // capture/re-apply, the operator's click silently evaporates and the loop keeps iterating.
    // finishIteration is driven directly (the re-run turn "completed"): the discrimination is
    // paused-with-iteration-unchanged (intent honored) vs gated/next-iteration (intent dropped).
    const gitInit = async (repo: string): Promise<void> => {
      await pexec('git', ['init', '-q', '-b', 'main', repo]);
    };

    // Pause: gatePolicy 'every' + no check ⇒ a dropped intent lands 'gated'; an honored one 'paused'.
    {
      const h = harness({ gatePolicy: 'every', checkCommand: null });
      await gitInit(h.repo);
      h.store.patchLoop(h.loopId, { worktreePath: h.repo, baseBranch: 'main', branch: 'ct/x' });
      h.setRt({ phase: 'await-done', injectAt: 0, injectedAt: Date.now() - 5000, sawWorking: true, idleTicks: 0, pauseRequested: true });
      h.loops.onTerminalRestarted(h.termId);
      assert.equal(h.rt(), undefined, 'the in-flight runtime was dropped');
      assert.deepEqual(h.preserved(), { pauseRequested: true }, 'the pending Pause was captured');
      await h.drive(); // restore re-arms
      assert.equal(h.rt()?.phase, 'launching');
      assert.equal(h.rt()?.pauseRequested, true, 'the restored runtime carries the Pause intent');
      assert.equal(h.preserved(), undefined, 'the capture is consumed exactly once');
      await h.finish(); // the re-run iteration completes
      assert.equal(h.loop().status, 'paused', 'the operator Pause is honored — not gated, not iterating on');
      assert.equal(h.loop().iteration, 3, 'and no next iteration was opened');
    }

    // Step once: gatePolicy 'never' + a failing check ⇒ a dropped intent begins iteration 4; an
    // honored one pauses at iteration 3.
    {
      const h = harness({ checkCommand: 'false' });
      await gitInit(h.repo);
      h.store.patchLoop(h.loopId, { worktreePath: h.repo, baseBranch: 'main', branch: 'ct/x' });
      h.setRt({ phase: 'await-done', injectAt: 0, injectedAt: Date.now() - 5000, sawWorking: true, idleTicks: 0, stepOnce: true });
      h.loops.onTerminalRestarted(h.termId);
      assert.deepEqual(h.preserved(), { stepOnce: true }, 'the pending Step-once was captured');
      await h.drive();
      assert.equal(h.rt()?.stepOnce, true, 'the restored runtime carries the Step-once intent');
      await h.finish();
      assert.equal(h.loop().status, 'paused', 'Step-once pauses after the re-run iteration');
      assert.equal(h.loop().iteration, 3, 'instead of beginning the next one');
    }

    // Hygiene: a later restart whose runtime carries NO intent clears a stale capture (it was
    // already honored by a finishIteration that raced the restore), and gone drops an unrestored one.
    {
      const h = harness();
      h.setPreserved({ pauseRequested: true }); // a stale earlier capture
      h.setRt({ phase: 'await-done', injectAt: 0, injectedAt: Date.now() - 5000, sawWorking: true, idleTicks: 0 });
      h.loops.onTerminalRestarted(h.termId);
      assert.equal(h.preserved(), undefined, 'a flagless restart clears the stale capture — never a ghost re-pause');
      h.setRt({ phase: 'await-done', injectAt: 0, injectedAt: Date.now() - 5000, sawWorking: true, idleTicks: 0, pauseRequested: true });
      h.loops.onTerminalRestarted(h.termId);
      assert.deepEqual(h.preserved(), { pauseRequested: true });
      h.loops.onTerminalGone(h.termId);
      assert.equal(h.preserved(), undefined, 'an unrestored capture dies with the pane');
    }
  });
});

test('SPEC-LOOPWEDGE F4 — a blocked-question interval is excluded from the RT-1 wall-clock', { skip: haveTmux ? false : 'tmux is not installed' }, async () => {
  // A round-1 replay: an operator took ~17 min to answer a builder's question, and that human latency
  // ate the 30-min per-turn ceiling — the loop gated mid-work. F4 credits the blocked interval back to
  // injectedAt on the first non-blocked tick, so the ceiling excludes it. The discriminator: a turn
  // already 20 min in, blocked for 15 more, would (WITHOUT the credit) cross the 30-min ceiling and be
  // faulted to a gate; WITH the credit it stays 20 min in and keeps running.
  await paint(CLAUDE_IDLE, '❯');
  await withFrozenClock(async (advance) => {
    const h = harness({ state: 'blocked-question' });
    const T0 = Date.now(); // frozen
    h.setRt({ phase: 'await-done', injectAt: 0, injectedAt: T0 - 20 * 60_000, sawWorking: true, idleTicks: 0 });

    // 1st tick — blocked: the block start is anchored, injectedAt untouched, and the state is audited
    // once (D3: a long human stall is visible, never a silent stall).
    await h.drive();
    assert.equal(h.rt()?.blockedSince, T0, 'the block start is anchored');
    assert.equal(h.rt()?.injectedAt, T0 - 20 * 60_000, 'injectedAt is not touched while blocked');
    assert.ok(auditTail(200).some((e) => e.action === 'loop.blocked' && e.loopId === h.loopId), 'the block is audited (D3 visibility)');
    assert.equal(h.loop().status, 'running', 'a blocked turn is never faulted below the ceiling — it waits on the human');

    // The operator takes 15 minutes to answer, then the turn resumes (state → idle).
    advance(15 * 60_000);
    h.store.patchTerminal(h.termId, { state: 'idle' });

    // 2nd tick — first non-blocked tick: credit the 15-min block back to injectedAt so the RT-1 elapsed
    // is 20 min (< the 30-min ceiling), not 35 min. Without the credit the ceiling would fault it.
    await h.drive();
    assert.equal(h.rt()?.blockedSince, undefined, 'the block anchor is cleared once credited');
    assert.equal(h.rt()?.injectedAt, T0 - 20 * 60_000 + 15 * 60_000, 'the blocked interval is credited back to injectedAt');
    assert.equal(h.loop().status, 'running', 'the turn is NOT gated — the human latency was excluded (a revert of F4 gates it here)');
  });
});

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`) : `/tmp/tmux-${uid}`;
  rmSync(join(dir, SOCK), { force: true });
});

test.after(async () => {
  await killScratch();
});
