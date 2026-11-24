// The first-turn spawn-latch inject belt (loops.ts injectPrompt): a freshly-spawned builder is BORN
// 'working' (terminal-manager stamps it after tmux.newSession) and a built-in only demotes via its
// turn-done hook — which a builder that has never run a turn can never fire. Without the belt the
// loop's very first inject deadlocks on the 'working' state until the 30-minute injection ceiling
// gates it. The belt lets the FIRST inject bypass the latch ONLY when it is provably the loop's
// first-ever inject AND positive evidence shows the pane is genuinely idle (no active children, not a
// mid-turn footer, empty composer, byte-stable across two ticks at least FIRST_INJECT_PROBE_GAP_MS
// apart). Anything inconclusive keeps today's defer.
//
// Driven against a real scratch tmux pane (non-`ct-` socket) whose screen is PAINTED with each
// provider's real idle / mid-turn frame, so the real classifiers and the real capture path run. The
// terminal record is seeded state:'working' — the actual spawn latch the existing loop tests (which
// seed 'idle') never exercise. A painted static pane cannot truly submit a prompt (the typed text
// echoes below the frame, so the composer never fills), so a heal case asserts the belt OPENED — the
// `loop.inject.firstturn` audit fired and the drive then reached the send — not a completed turn.
//
// Self-skips when tmux is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Loop, Terminal, ProviderId } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-firstinject-test-'));
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
const SOCK = `firstinject-${process.pid}`; // NOT ct-* : the reconciler must never see it
const RULE = '─'.repeat(78);
const NBSP = ' '; // the non-breaking space claude renders after the composer prompt marker (an escape, not a literal)

const killScratch = async (): Promise<void> => {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Paint arbitrary visible lines into a scratch pane and wait until they have actually rendered.
 * `childful` false uses `exec sleep 600` so the pane process has NO child — a lingering child would
 * read as active work and mask the belt; `childful` true keeps a real backgrounded child, to
 * exercise the live-work exclusion. Polls for `ready` rather than guessing a settle time: these run
 * on a machine doing other work, where a fixed budget is a coin flip under load.
 */
async function paint(lines: string[], ready: string, childful = false): Promise<void> {
  const screen = lines.join('\\n');
  const tailProc = childful ? 'sleep 600 & wait' : 'exec sleep 600';
  // 30 rows: the injected prompt echoes into the pane and always carries the standing memory footer
  // (SPEC-MEMADOPT) — a 12-row pane leaves ONE row of headroom before the echo scrolls the painted
  // composer frame off-screen, which would flip the classifier's conclusive readings (and the
  // no-appear rejections pinned here) into inconclusive drift on the next wording change.
  // STAGED retry, bounded and loud: under full-suite load the kill-server → new-session pair on
  // the same socket can race the dying server ("server exited unexpectedly"). Pure fixture
  // staging, before any product interaction, so re-staging can never mask a product regression;
  // any other spawn failure still throws at once.
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      await pexec('tmux', ['-L', SOCK, 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '30',
        `sh -c 'printf "${screen}\\n"; ${tailProc}'`], { timeout: 10_000 });
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
function harness(opts: { provider?: ProviderId; iteration?: number } = {}) {
  const provider = opts.provider ?? 'claude-code';
  const iteration = opts.iteration ?? 1;
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
    // BORN 'working' — the real spawn latch a never-driven built-in cannot clear on its own.
    cwd: repo, command, state: 'working', createdAt: now,
  };
  store.upsertTerminal(term);
  const iterations =
    iteration === 1
      ? [{ n: 1, verdict: 'pending' as const, startedAt: now }]
      : [
          { n: 1, verdict: 'pass' as const, startedAt: now, endedAt: now },
          { n: 2, verdict: 'pending' as const, startedAt: now },
        ];
  const loop: Loop = {
    id: loopId, projectId, name: 'l', task: 'do the thing', provider,
    gatePolicy: 'never', maxIterations: 8, status: 'running', iteration,
    iterations, terminalId: termId, createdAt: now, updatedAt: now,
  };
  store.upsertLoop(loop);
  const loops = new Loops({ store, tm: {} as never, worktrees: {} as never, accounts: {} as never, onUpdate: () => {} });
  const inner = loops as unknown as {
    rt: Map<string, Record<string, unknown>>;
    driveOne(l: Loop): Promise<void>;
  };
  // Park the runtime EXACTLY where the first inject lives: a never-injected 'launching' turn whose
  // settle window has already passed (injectAt in the past), so driveOne calls injectPrompt at once.
  inner.rt.set(loopId, {
    phase: 'launching', injectAt: Date.now() - 1000, injectedAt: 0, sawWorking: false, idleTicks: 0,
  });
  return {
    store,
    loopId,
    termId,
    drive: (): Promise<void> => inner.driveOne(store.getLoop(loopId)!),
    rt: (): Record<string, unknown> | undefined => inner.rt.get(loopId),
    loop: (): Loop => store.getLoop(loopId)!,
    firstturnFired: (): boolean =>
      auditTail(500).some((e) => e.action === 'loop.inject.firstturn' && e.loopId === loopId),
  };
}

const CLAUDE_IDLE = [RULE, `❯${NBSP}`, RULE, '  ⏸ manual mode on'];

/**
 * Freeze Date.now for a subtest's ASSERTION-relevant windows and hand back `advance` to age them
 * deterministically (the idiom poller-resize.test.ts drives its quiet-window with). Both clocks the
 * belt reads run through Date.now — the FIRST_INJECT_PROBE_GAP_MS pair age and sendTextVerified's
 * VERIFY_BUDGET_MS — so under a loaded machine real waits leave BOTH spec-legal outcomes reachable:
 * a drive's own tmux execs can age a pair past the gap (the belt CORRECTLY opens where `gap` expects
 * shut), and a slow no-appear can cross the verify budget (CORRECTLY degrading to 'unverified' where
 * A/D pin the throw). Freezing pins the one outcome each subtest asserts: a frozen pair reads 0ms at
 * the gap check, and outOfBudget() can never trip, so the no-appear throw is reached. Internal
 * sleeps / exec timeouts run on real timers and are untouched; repaints keep a short REAL wait so
 * tmux actually rerenders. Restores in finally so a rejecting subtest can't leak the fake clock.
 */
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

/** Bounded, LOUD, attempt-level retry for the subtests that pin a hard no-appear rejection (the
 *  loops-restart.test.ts helper, same rationale in full there). The frozen clock immunizes those
 *  cases against latency, but the rejection also requires every `capture-pane` in the drive's
 *  verify window to SUCCEED — under full-suite load a capture occasionally fails outright,
 *  captureVisible maps the failure to '' (inconclusive), and the product correctly degrades to an
 *  audited 'unverified' send (or the belt holds no probe) instead of throwing, so the drive
 *  resolves and the pinned rejection goes missing. An 'unverified' send consumes the injection,
 *  so no mid-subtest rewind exists: each attempt re-stages the WHOLE body (repaint + fresh
 *  harness) and re-runs the SAME assertions. Gated to the two capture-hiccup signatures — any
 *  other failure rethrows on the FIRST attempt, and the last attempt always rethrows. */
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

test('the first-turn spawn-latch inject belt', { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {
  await t.test('A — a genuinely-idle claude builder heals: probe once, then OPEN the belt', async () => {
    await withInfraRetry('A', async () => {
      await paint(CLAUDE_IDLE, '❯');
      await withFrozenClock(async (advance) => {
        const h = harness();
        // First tick: one clean observation is recorded, but a single sighting is never enough — defer,
        // no audit, nothing injected.
        await h.drive();
        assert.equal(h.firstturnFired(), false, 'one observation must not open the belt');
        assert.equal(h.rt()?.injectedAt, 0, 'and nothing was injected');
        assert.equal(typeof h.rt()?.firstProbe, 'string', 'the first clean observation is held for the pair');
        assert.equal(h.loop().status, 'running');
        // A second matching observation past the stability window opens the belt: age the pair on the
        // frozen clock, deterministically past the gap however slow the machine is. The painted static
        // pane cannot truly submit (the typed prompt echoes below the frame, so the composer never
        // fills), so sendTextVerified throws no-appear and the drive rejects — but the belt DID open
        // first (and with the clock frozen the verify budget can never expire this into 'unverified').
        advance(1_700);
        await assert.rejects(
          () => h.drive(),
          (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'no-appear',
          'a painted static pane cannot fill its composer, so the send fails no-appear',
        );
        assert.equal(h.firstturnFired(), true, 'the belt opened — loop.inject.firstturn fired');
        assert.equal(h.rt()?.injectedAt, 0, 'the send never confirmed, so injectedAt stays 0');
      });
    });
  });

  await t.test('B1 — a CHURNING pane never opens the belt (the two observations must match)', async () => {
    await paint(['output alpha', ...CLAUDE_IDLE], '❯');
    const h = harness();
    await h.drive(); // records observation of frame A
    assert.equal(h.firstturnFired(), false);
    // The screen moved between the two ticks: a mid-turn CLI re-renders its spinner every second, so
    // its capture is never byte-stable. Repaint a different (still idle-looking) frame.
    await paint(['output beta', ...CLAUDE_IDLE], '❯');
    await wait(1_700);
    await h.drive();
    assert.equal(h.firstturnFired(), false, 'a changed screen resets the pair — the belt stays shut');
    assert.equal(h.rt()?.injectedAt, 0, 'nothing was injected into a churning pane');
    assert.equal(h.loop().status, 'running');
  });

  await t.test('B2 — a pane with a live child process never opens the belt', async () => {
    await paint(CLAUDE_IDLE, '❯', true); // childful: a real backgrounded process
    assert.ok(await tmux.paneHasActiveChildren(SOCK), 'the fixture must actually have a live child');
    assert.ok((await tmux.paneDescendantCount(SOCK)) >= 1, 'and at least one descendant');
    const h = harness();
    await h.drive();
    await wait(1_700);
    await h.drive();
    assert.equal(h.firstturnFired(), false, 'active work is not idleness — the belt stays shut');
    assert.equal(h.rt()?.injectedAt, 0);
    assert.equal(h.rt()?.firstProbe, undefined, 'active work is inconclusive and clears any held probe');
    assert.equal(h.loop().status, 'running');
  });

  await t.test('C — SPEC-LOOPWEDGE F3: iteration 2 into a wedged-working pane heals off idle evidence; a busy footer still defers', async (tc) => {
    // F3 DROPS the iteration-1 / fresh-pane eligibility gate: the positive-evidence belt now runs for
    // ANY launching inject into a 'working' pane. The wedge it heals is a mid-loop 'working' record
    // left behind by a LOST Stop hook — it must inject on the SAME two-tick affirmative-idle evidence
    // the first turn uses, while a genuinely mid-turn pane keeps deferring unconditionally. (Before F3
    // this exact case — a paint that satisfies every idle check at iteration 2 — took ZERO probes and
    // never opened the belt; F3 makes it heal. This replaces that older no-probe assertion.)
    await tc.test('idle evidence at iteration 2 → probe once, then OPEN the belt (the heal)', async () => {
      await withInfraRetry('C-idle', async () => {
        await paint(CLAUDE_IDLE, '❯');
        await withFrozenClock(async (advance) => {
          const h = harness({ iteration: 2 });
          await h.drive();
          assert.equal(h.firstturnFired(), false, 'one observation must not open the belt');
          assert.equal(typeof h.rt()?.firstProbe, 'string', 'iteration 2 now PROBES — F3 dropped the iteration gate (a revert leaves this undefined)');
          assert.equal(h.rt()?.injectedAt, 0, 'and nothing injected on the first observation');
          advance(1_700);
          await assert.rejects(
            () => h.drive(),
            (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'no-appear',
            'the painted static pane cannot fill its composer, so the belt-opened send fails no-appear',
          );
          assert.equal(h.firstturnFired(), true, 'the belt opened at iteration 2 off idle evidence (F3)');
        });
      });
    });

    await tc.test('a busy footer at iteration 2 → defers, never opens the belt (mid-turn is excluded at ANY iteration)', async () => {
      await paint([RULE, `❯${NBSP}`, RULE, '  esc to interrupt · press to stop'], 'esc to interrupt');
      const h = harness({ iteration: 2 });
      await h.drive();
      await wait(1_700);
      await h.drive(); // no throw: the belt never opened, so no send was attempted into the running turn
      assert.equal(h.firstturnFired(), false, 'a mid-turn pane must never open the belt at any iteration');
      assert.equal(h.rt()?.injectedAt, 0, 'nothing was typed into the running turn');
      assert.equal(h.rt()?.firstProbe, undefined, 'the mid-turn marker is inconclusive — no probe held');
      assert.equal(h.loop().status, 'running');
    });
  });

  await t.test('D — a genuinely-idle codex builder heals; normalizeSnapshot makes the cycling hint stable', async () => {
    // A real idle codex cycles its composer hint every few seconds, so the RAW capture is never byte
    // stable; the belt only holds across that churn because normalizeSnapshot strips the `›` hint line.
    // Paint two DIFFERENT hints (both COMPOSER_HINTS ⇒ composerPending false) that normalize identical:
    // if normalize were dropped (norm = raw), the pair would never match and the belt would never open.
    await withInfraRetry('D', async () => {
      await paint(['codex session ready', '› Explain this codebase'], '›');
      await withFrozenClock(async (advance) => {
        const h = harness({ provider: 'codex' });
        await h.drive();
        assert.equal(h.firstturnFired(), false, 'one observation must not open the belt');
        assert.equal(h.rt()?.injectedAt, 0);
        assert.equal(typeof h.rt()?.firstProbe, 'string', 'the first clean observation is held for the pair');
        // A different idle hint: raw changes, normalized (with the `›` line stripped) does not ⇒ the pair
        // matches and the belt opens. This asserts normalizeSnapshot ran — a raw compare would stay shut.
        await paint(['codex session ready', '› Summarize recent commits'], '›');
        await wait(150); // REAL: paint polled for the frame, a beat more lets tmux finish the rerender
        advance(1_700);  // then age the pair on the frozen clock — the gap is deterministic, not waited
        await assert.rejects(
          () => h.drive(),
          (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'no-appear',
        );
        assert.equal(h.firstturnFired(), true, 'the belt opened for codex across a cycling hint (normalize is load-bearing)');
        assert.equal(h.rt()?.injectedAt, 0);
      });
    });
  });

  await t.test('gap — two matching observations closer than the window keep the belt shut', async () => {
    // The stability gap is enforced in code, not left to tick cadence: a second matching observation
    // arriving before FIRST_INJECT_PROBE_GAP_MS must NOT open the belt (else a fast double-tick could
    // inject off a single instant's screen). The clock is FROZEN across both drives: back-to-back
    // drives still pay real tmux exec time (paneHasActiveWork + captureVisible), and under load that
    // alone can age the pair past the window — the belt would CORRECTLY open, which is exactly the
    // outcome this subtest exists to rule out for a too-young pair. Frozen, the pair's age reads 0ms
    // at the gap check no matter how slow tmux is.
    await withInfraRetry('gap', async () => {
      await paint(CLAUDE_IDLE, '❯');
      await withFrozenClock(async () => {
        const h = harness();
        await h.drive(); // records the first clean observation
        assert.equal(typeof h.rt()?.firstProbe, 'string', 'the first clean observation is held for the pair');
        await h.drive(); // matches, but the pair is too young — defer, no send, no throw
        assert.equal(h.firstturnFired(), false, 'a sub-window matching pair must not open the belt');
        assert.equal(h.rt()?.injectedAt, 0, 'nothing was injected');
        assert.equal(typeof h.rt()?.firstProbe, 'string', 'the first clean observation is held for a later, aged pair');
        assert.equal(h.loop().status, 'running');
      });
    });
  });

  await t.test('E — an inconclusive screen (no classifiable composer) always defers', async () => {
    await paint(['a full-screen dialog', 'with no composer', 'just text'], 'full-screen');
    const h = harness();
    await h.drive();
    await wait(1_700);
    await h.drive();
    assert.equal(h.firstturnFired(), false, 'an unreadable composer never opens the belt');
    assert.equal(h.rt()?.injectedAt, 0);
    assert.equal(h.rt()?.firstProbe, undefined, 'inconclusive readings hold no probe');
    assert.equal(h.loop().status, 'running');
  });

  await t.test('safety — a STATIC mid-turn claude frame (empty composer + esc-to-interrupt) NEVER opens the belt', async () => {
    // The critical exclusion: claude's composer stays rendered-empty mid-turn (composerPending reads
    // false), and a frozen mid-turn pane is childless and byte-stable — so without the mid-turn footer
    // marker it would pass every other check and inject into a FOREIGN turn. The pinned `esc to
    // interrupt` footer is what excludes it. Even across the full stability window, the belt must not
    // open and nothing may be typed into the running turn.
    await paint([RULE, `❯${NBSP}`, RULE, '  esc to interrupt · press to stop'], 'esc to interrupt');
    const h = harness();
    await h.drive();
    await wait(1_700);
    await h.drive(); // no throw: the belt never opened, so no send was ever attempted
    assert.equal(h.firstturnFired(), false, 'a mid-turn pane must never open the belt');
    assert.equal(h.rt()?.injectedAt, 0, 'and nothing was typed into the foreign turn');
    assert.equal(h.rt()?.firstProbe, undefined, 'the mid-turn marker is inconclusive — no probe held');
    assert.equal(h.loop().status, 'running');
  });
});

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
  // tmux leaves the socket FILE behind after kill-server, so remove ours too.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`) : `/tmp/tmux-${uid}`;
  rmSync(join(dir, SOCK), { force: true });
});
