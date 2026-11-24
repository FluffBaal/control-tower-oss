// PTY-state poller (SPEC D7 / Sys-C2). On a low-frequency timer it re-derives state
// from a capture-pane snapshot for terminals whose hook state may be stale — and
// unconditionally for Gemini and pollsToIdle custom providers, which emit no idle event.
// This is the fallback that keeps Mission Control honest when a hook POST is lost or a
// provider can't report idle. It never fights a fresh hook: it only polls stale terminals
// (or Gemini / pollsToIdle providers).
//
// Detection combines three signals (the last two borrowed from herdr's approach):
//   1. permission parse   — regex for a permission prompt (from the adapter)
//   2. output-change      — the pane snapshot changed since last poll  → working
//   3. process signal     — the pane has an active child (a running tool) → working
// Idle is declared only after the screen has been STABLE for two consecutive polls
// (and there are no busy children), so a briefly-quiet agent isn't flipped to idle.
//
// SPEC-PROVIDERS adapters are resolved via registry.forTerminal(term) — the def
// SNAPSHOT frozen onto the terminal at launch — never the live store, so an edit/delete
// can't change a live terminal's turn detection mid-turn. a CUSTOM-DEF-ONLY
// quiescence backstop (much longer than the tier-B/C dwell) demotes a custom provider
// (term.providerDef present) whose hook was mis-wired/lost, so nothing hangs forever; such
// an inferred idle is marked (never silent). Built-ins are NEVER force-idled by the poller
// (A2/C1) — they idle ONLY via their Stop hook, their hang protection being the loop
// runner's per-turn wall-clock fault. a tier-C def's busyPattern/socketBusy count
// as active work.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from './store.js';
import type { MissionControl } from './mission.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { AgentAdapter } from './adapters/types.js';
import type { Terminal } from '../shared/types.js';
import { audit } from './audit.js';
import * as tmux from './tmux.js';
import { paneAffirmativelyIdle } from './idle-evidence.js';
import { classifyUsageWall } from './runway/scrape.js';

const pexec = promisify(execFile);

/** Consecutive socket-only polls a keep-alive may SUSTAIN 'working' before the socket stops
 *  counting — a keep-alive pool holds an ESTABLISHED connection idle for minutes between turns,
 *  so the socket alone must not pin the terminal past the normal quiescence demote / backstop. */
const SOCKET_ONLY_MAX_POLLS = 3;

/** SPEC-LOOPWEDGE F2 — the dedicated dwell (consecutive byte-stable polls ≈ 30s) a BUILT-IN must hold
 *  affirmative-idle evidence before the poller demotes its working record. STRICTER than the tier-B
 *  signalled demote's 2: a built-in has no idle hook to corroborate, so the affirmative evidence
 *  (empty composer, no busy footer, no live children) must be doubly-settled before it can heal. */
const BUILTIN_AFFIRM_DWELL = 3;

/** Cheap deterministic hash of a snapshot (djb2). */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

export class Poller {
  private timer?: NodeJS.Timeout;
  private lastHash = new Map<string, number>();
  private stableCount = new Map<string, number>();
  /** Epoch ms when each terminal's baseline hash was captured — see the rebaseline guard. */
  private baselineAt = new Map<string, number>();
  /** Epoch ms of the last viewer-driven resize per terminal (set by noteViewerResize). A resize
   *  reflows the tmux window, and the reflow changes the snapshot — which the change-heuristic below
   *  would read as work. This drives the resize quiet-window guard in tick() that swallows that churn. */
  private resizeAt = new Map<string, number>();
  // SPEC-LOOPWEDGE — whether a terminal's CURRENT idle was reached by INFERENCE (quiescence,
  // or the F2 affirmative-idle backstop) rather than a completion signal now lives ON THE TERMINAL
  // RECORD (terminal.idleInferred), written by mission.ingest so F1's harvest and F2's demote share
  // ONE durable source of truth the loop GUARD and the amber badge both read. No in-memory mirror.
  /** Compiled tier-C busyPattern per terminal (the def snapshot is immutable per
   *  terminal, so caching by id is safe). null = absent or malformed (never matches). */
  private busyRe = new Map<string, RegExp | null>();
  /** Consecutive polls where a tier-C socket was the ONLY evidence of work — the streak that,
   *  past SOCKET_ONLY_MAX_POLLS, releases the socket so a keep-alive can't pin the terminal. */
  private socketOnlyPolls = new Map<string, number>();
  /** The all-tier backstop dwell, in consecutive stable polls (derived in the ctor). */
  private backstopStablePolls: number;
  /** Resize quiet-window length: one full poll interval past the last resize, plus a 5s margin for
   *  the client's debounce + the tmux reflow to settle (derived in the ctor). See the tick() guard. */
  private quietMs: number;

  constructor(
    private store: Store,
    private mission: MissionControl,
    private registry: ProviderRegistry,
    private intervalMs = 10_000,
    private staleMs = 20_000,
    backstopMs = 300_000,
  ) {
    // MUCH longer than the 2-poll tier-B/C demote — it should almost never fire; it is
    // the last-resort floor so a mis-wired / lost hook can't wedge a loop forever. The loop
    // runner's per-turn wall-clock fault (BP3, loops await-done) is the ceiling above it.
    this.backstopStablePolls = Math.max(3, Math.ceil(backstopMs / this.intervalMs));
    this.quietMs = this.intervalMs + 5000;
  }

  /** A viewer fitted its terminal to the pane, resizing the tmux window. Opens a quiet-window
   *  (see the tick() guard) so the reflow's snapshot churn is not misread as the agent working. */
  noteViewerResize(terminalId: string): void {
    this.resizeAt.set(terminalId, Date.now());
  }

  /** SPEC-RUNWAY W5 — the reactive usage-wall backstop. When a polled claude-code pane shows a
   *  limit-reached banner (classifyUsageWall), the poller reports it here so Runway can mark the
   *  subscription walled — a net for the case the proactive statusLine missed the approach. Absent
   *  (the default) ⇒ no wall reporting. Set by the integrator after construction. */
  private onUsageWall?: (terminalId: string, kind: 'wall' | 'auto-continue') => void;
  setUsageWallHook(fn: (terminalId: string, kind: 'wall' | 'auto-continue') => void): void {
    this.onUsageWall = fn;
  }

  /** One full sweep. The RETURN is an additive summary no production caller reads (start()'s interval
   *  fires tick() and ignores it): `swept` — terminals whose per-terminal sweep actually ran this tick
   *  (probe succeeded, session alive; every later `continue` is a completed sweep decision, and a
   *  thrown await aborts the whole call so the summary never escapes stale). Killed/shell exclusions,
   *  dead sessions, and stalled-probe skips are simply absent from `swept` (the skip leaves state
   *  untouched and the next tick retries). Lets a fixed-tick test re-tick after an infra stall instead
   *  of misreading the deliberate skip-and-retry as a product failure. */
  async tick(): Promise<{ swept: string[] }> {
    const swept: string[] = [];
    for (const term of this.store.listTerminals()) {
      if (term.state === 'killed' || term.provider === 'shell') continue;
      // hasSession re-throws on a tmux timeout (a stalled socket). Skip just this terminal this sweep
      // rather than let the throw abort the poll of every other terminal; its lastHash/baselineAt stay
      // untouched and the next tick retries.
      let alive = false;
      try {
        alive = await tmux.hasSession(term.tmuxSocket);
      } catch (e) {
        // Log for parity with the reconciler — a wedged socket is exactly when the operator needs the
        // signal; a silent skip would hide the failure mode this hardening exists to surface. Bounded
        // to one line per wedged terminal per sweep.
        console.error(`[poller] probe failed for ${term.id}; skipping this sweep:`, (e as Error).message);
        continue;
      }
      if (!alive) continue;
      swept.push(term.id);
      // NaN-safe: an unparseable lastEventAt must count as STALE (poll it), not as
      // fresh — otherwise Date.parse -> NaN makes the `> staleMs` comparison false and
      // a claude/codex terminal with a bad timestamp is never polled.
      const lastTs = term.lastEventAt ? Date.parse(term.lastEventAt) : NaN;
      const stale = !Number.isFinite(lastTs) || Date.now() - lastTs > this.staleMs;
      // resolve the adapter from the terminal's frozen def snapshot, not the live store.
      const adapter = this.registry.forTerminal(term);
      // ⟦DP-5⟧ Poll tier-B/C custom providers (pollsToIdle) like gemini — they have no idle
      // hook. Hook providers (built-ins) are polled only when stale, but the backstop
      // below can still demote them from that stale-poll path.
      const mustPoll = term.provider === 'gemini-cli' || adapter.pollsToIdle === true || stale;
      if (!mustPoll) {
        // Keep the output baseline fresh even when we don't act, so the first real
        // poll after a terminal goes stale has something to compare against. Uses the
        // SAME normalization as the acting path — mixed baselines would fake a change.
        const raw = await tmux.capturePlain(term.tmuxSocket, 60);
        this.lastHash.set(term.id, hash(adapter.normalizeSnapshot?.(raw) ?? raw));
        this.baselineAt.set(term.id, Date.now());
        // SPEC-LOOPWEDGE H2 — a fresh (recently-active) terminal is NOT in a stable-idle run, so its
        // dwell must start from zero. Without this, a turn that completes entirely inside the fresh
        // window carries a pre-turn idle count (≥ BUILTIN_AFFIRM_DWELL) into the first post-turn stale
        // poll and demotes on tick one, shortcutting the 3-poll stability dwell F2 relies on.
        this.stableCount.set(term.id, 0);
        continue;
      }

      const snapshot = await tmux.capturePlain(term.tmuxSocket, 60);
      // SPEC-RUNWAY W5 — reactive backstop: a claude-code pane showing a usage-limit banner marks its
      // subscription walled (the banner persists on screen, so a stale poll catches it). Read-only here;
      // the hook does the store write + audit. Never affects parseState/state classification below.
      if (term.provider === 'claude-code' && this.onUsageWall) {
        const w = classifyUsageWall(snapshot);
        if (w) this.onUsageWall(term.id, w);
      }
      const parsed = adapter.parseState(snapshot);

      // Hash the NORMALIZED snapshot: ambient TUI animation (codex ≥0.14x cycles its
      // composer placeholder hints) must not read as work, or this change-heuristic pins
      // a hook-idled terminal back to 'working' forever. parseState sees the RAW snapshot.
      const h = hash(adapter.normalizeSnapshot?.(snapshot) ?? snapshot);

      // REBASELINE GUARD: if a hook/human event landed AFTER our baseline was captured,
      // the comparison is void — the delta we'd see may be the turn's own trailing render
      // (codex paints its final answer AFTER firing notify). Verified live 2026-07-06:
      // without this, that render promoted a hook-idled builder back to 'working', and
      // hook-driven providers have no idle heuristic to ever demote it again. Rebaseline
      // on the fresher screen and compare from the NEXT poll instead.
      if (Number.isFinite(lastTs) && lastTs > (this.baselineAt.get(term.id) ?? 0)) {
        this.lastHash.set(term.id, h);
        this.baselineAt.set(term.id, Date.now());
        this.stableCount.set(term.id, 0);
        continue;
      }

      // RESIZE QUIET-WINDOW: a viewer fitting its terminal to the pane reflows the tmux window, and
      // the reflow changes the snapshot — which the `changed` compare below would read as output ->
      // 'working' for every adapter that doesn't set screenChangeImpliesWork:false, pinning an idle
      // agent 'working' off a mere resize and wedging busy-aware loop starts (the reason a prior
      // revision hardcoded 80x24). While a resize is recent, rebaseline and skip the compare. The
      // 2nd clause holds suppression open until a baseline is captured >=1s AFTER the last resize, so
      // a late/overlapping tick can't resume the compare off a mid-reflow snapshot (the delayed-sweep
      // leak). This continues before the needs-permission promotion below, so — like the rebaseline
      // guard above — a lost-hook permission dialog can surface up to ~quietMs later during a resize.
      // Cost: idle detection for this terminal can lag by up to the quiet window; never a missed turn.
      // resizeAt is re-armed at reflow-COMPLETION (attach()'s onReflow), not just at the pre-reflow note,
      // so a slow-socket reflow that lands seconds later can't be blessed against a pre-reflow baseline.
      // Residual (accepted): if a single resize command takes > quietMs to return, a tick in the few-ms
      // gap before onReflow fires could compare post-reflow content to a pre-reflow baseline — negligible.
      const ra = this.resizeAt.get(term.id);
      if (ra !== undefined && (Date.now() < ra + this.quietMs || (this.baselineAt.get(term.id) ?? 0) < ra + 1000)) {
        this.lastHash.set(term.id, h);
        this.baselineAt.set(term.id, Date.now());
        this.stableCount.set(term.id, 0);
        continue;
      }

      const prev = this.lastHash.get(term.id);
      const changed = prev !== undefined && prev !== h;
      this.lastHash.set(term.id, h);
      this.baselineAt.set(term.id, Date.now());
      // KNOWN LIMITATION (deferred, gemini-only, low-severity): stableCount is reset by
      // output change, not by a hook/human state flip, so a carried-over count could let
      // a gemini terminal re-demote to idle right after a human action with no new output.
      const stable = changed ? 0 : (this.stableCount.get(term.id) ?? 0) + 1;
      this.stableCount.set(term.id, stable);

      // Active-work evidence, split so the socket can be rate-limited on its own. `hardWork` —
      // live pane descendants or a tier-C busyPattern match — promotes 'working' and sustains it
      // with no time limit. The socket is a SOFT signal: a keep-alive pool holds an ESTABLISHED
      // outbound connection idle for minutes between turns, so it must only SUSTAIN a working
      // terminal, and only while it is not the SOLE evidence for too long. After a few consecutive
      // polls where the socket is all we have (no screen change, no live child, no busyPattern) it
      // stops counting, so the quiescence demote and the backstop proceed. It never promotes
      // an idle terminal on its own — the sustain path requires the terminal to already be working.
      const hardWork = await this.hasActiveWork(term, adapter, snapshot);
      let socketSustains = false;
      const turn = term.providerDef?.turn;
      if (hardWork || changed || !turn?.socketBusy || term.state !== 'working') {
        this.socketOnlyPolls.delete(term.id); // real evidence present, or the socket can't sustain here — reset the streak
      } else if (await this.hasEstablishedOutboundSocket(term.tmuxSocket)) {
        const streak = (this.socketOnlyPolls.get(term.id) ?? 0) + 1;
        this.socketOnlyPolls.set(term.id, streak);
        socketSustains = streak <= SOCKET_ONLY_MAX_POLLS;
      } else {
        this.socketOnlyPolls.delete(term.id); // socketBusy declared but nothing ESTABLISHED right now
      }
      const running = hardWork || socketSustains;

      // SINGLE fresh-state guard for EVERY emission below (permission promotion AND the
      // working/idle emissions). All of them carry NO emitTs, so they bypass ingest's
      // ordering guard and could clobber a state a hook OR a human action set DURING this
      // tick's awaits (capturePlain / paneHasActiveWork). `term` is the pre-await
      // snapshot; all our evidence (parsed / changed / running) was derived from it. If the
      // live state differs now, that evidence is stale — skip entirely. Race-free: nothing
      // awaits between this read and the ingest() call, and ingest persists synchronously
      // before its own first await. This closes: re-blocking a just-approved terminal
      // (human decide() -> working during the await), re-promoting a mid-tick Stop-hook
      // idle to working, and clobbering a mid-tick needs-input blocked state (F1).
      const cur = this.store.getTerminal(term.id);
      if (!cur || cur.state !== term.state) continue;

      // Permission promotion is highest priority: a visible dialog -> blocked-permission
      // (a no-op re-affirm if already blocked). Safe here because cur === term, so we are
      // not overriding a concurrent human/hook action.
      if (parsed === 'needs-permission') {
        await this.mission.ingest(term.id, 'needs-permission');
        this.stableCount.set(term.id, 0);
        continue;
      }
      // Working/idle emissions must NEVER downgrade an already-blocked terminal via screen
      // heuristics (an animated dialog reads as 'changed').
      if (cur.state === 'blocked-question' || cur.state === 'blocked-permission') continue;

      // Screen-change promotion is adapter-gated: a CLI whose TUI animates while idle
      // (codex ≥0.14x) declares screenChangeImpliesWork=false, so only live children or
      // a parse/hook signal count as work for it (see adapters/types.ts).
      if (running || (changed && adapter.screenChangeImpliesWork !== false)) {
        await this.mission.ingest(term.id, 'session-start'); // -> working (clears idleInferred)
        continue;
      }

      // Demotion to idle. `running` is false here, so both paths are quiescence-gated:
      //   signalled — a real done-signal: gemini poll-idle, a tier-B screen turnDone match,
      //               or a pollsToIdle provider hitting the short (2-poll) tier-B/C dwell.
      //   backstop  — the CUSTOM-DEF-ONLY floor (term.providerDef present): a custom
      //               provider quiescent for the long backstop dwell is demoted so a
      //               mis-wired / lost custom hook can't wedge the loop forever. BUILT-INS
      //               ARE EXCLUDED (A2/C1): they idle ONLY via their Stop hook — a
      //               long-thinking claude or a silent codex tool-wait with a static screen
      //               must never be force-idled into a premature loop advance; their hang
      //               protection is the loop runner's per-turn wall-clock fault instead.
      const signalled =
        stable >= 2 &&
        (term.provider === 'gemini-cli' || parsed === 'turn-done' || adapter.pollsToIdle === true);
      // A2/C1: custom-def-only — a built-in is never force-idled by the QUIESCENCE backstop.
      const backstop =
        !signalled && term.providerDef !== undefined && stable >= this.backstopStablePolls;
      // SPEC-LOOPWEDGE F2 — the affirmative-idle backstop for BUILT-INS (the root heal for a lost
      // Stop hook). This is NOT the quiescence-only demote the built-in exclusion forbids: it fires
      // only on POSITIVE screen evidence that the pane is genuinely idle — an empty composer, no
      // pinned busy footer, no live tool children, byte-stable across a dedicated dwell — the same
      // instrument the loop's first-inject belt trusts. A long-thinking claude/codex pins its busy
      // footer, and a silent tool-wait keeps children or the footer, so neither passes; only a truly
      // finished-but-unsignalled turn does. Gated to a working record with a composer classifier.
      const builtinAffirm =
        !signalled &&
        !backstop &&
        term.state === 'working' &&
        term.providerDef === undefined &&
        adapter.composerPending !== undefined &&
        stable >= BUILTIN_AFFIRM_DWELL &&
        paneAffirmativelyIdle(snapshot, adapter, hardWork).evidenceOk;
      if (signalled || backstop || builtinAffirm) {
        // INFERRED = reached idle without a positive done-signal, and via a degraded path: the
        // tier-A quiescence backstop (no completion hook fired — else the terminal would already be
        // idle), a pollsToIdle (tier C, and tier B that fell through to dwell) quiescence demote, or
        // the F2 built-in affirmative-idle heal (a lost hook, healed from screen evidence). A
        // tier-B/gemini turnDone parse is a real signal, so it is NOT inferred; and a built-in
        // gemini's routine dwell is not flagged either (not the case). Threaded into ingest so
        // it persists to terminal.idleInferred (a signalled demote clears it via the false write).
        const inferred = builtinAffirm || (parsed !== 'turn-done' && (backstop || adapter.pollsToIdle === true));
        const demoted = await this.mission.ingest(term.id, 'turn-done', undefined, inferred); // -> idle
        if (demoted && inferred) this.flagInferred(term, backstop, builtinAffirm);
      }
    }
    return { swept };
  }

  /**
   * The HARD active-work signals — those that may both promote 'working' and sustain it
   * with no time limit: pane descendants (adapter-aware via persistentIdleChildren) and, for a
   * tier-C def, busyPattern (pane text = "still working"). Read off the terminal's frozen def
   * snapshot, so a live edit can't change the rule. The tier-C socketBusy signal is handled
   * separately in tick — a keep-alive holds ESTABLISHED for minutes, so it may only SUSTAIN a
   * working terminal briefly, not join this unbounded "is it working?" set.
   */
  private async hasActiveWork(term: Terminal, adapter: AgentAdapter, snapshot: string): Promise<boolean> {
    if (await tmux.paneHasActiveWork(term.tmuxSocket, adapter.persistentIdleChildren)) return true;
    const turn = term.providerDef?.turn;
    if (!turn) return false;
    if (turn.busyPattern && this.busyPatternMatches(term.id, turn.busyPattern, snapshot)) return true;
    return false;
  }

  /** Cached compile of a tier-C busyPattern; a malformed pattern never throws in the
   *  tick — it just never matches (so it can't wedge a terminal in 'working' forever). */
  private busyPatternMatches(terminalId: string, pattern: string, snapshot: string): boolean {
    let re = this.busyRe.get(terminalId);
    if (re === undefined) {
      try {
        re = new RegExp(pattern);
      } catch {
        re = null;
      }
      this.busyRe.set(terminalId, re);
    }
    return re !== null && re.test(snapshot);
  }

  /** True if any process in the pane's tree holds an ESTABLISHED outbound TCP conn —
   *  a hosted-API turn in flight with no child process and no output. Best-effort: on any
   *  ss/pgrep failure it FAILS OPEN (returns false → allows demotion), degrading to the
   *  documented tier-C false-idle residual (§5.1) rather than wedging the terminal. */
  private async hasEstablishedOutboundSocket(tmuxSocket: string): Promise<boolean> {
    try {
      const pids = await this.paneTreePids(tmuxSocket);
      if (pids.size === 0) return false;
      const { stdout } = await pexec('ss', ['-tnp', 'state', 'established'], { timeout: 1500 });
      for (const m of stdout.matchAll(/pid=(\d+)/g)) {
        if (pids.has(Number(m[1]))) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Pane process id + its live descendants (bounded pgrep walk), as a Set for membership. */
  private async paneTreePids(tmuxSocket: string): Promise<Set<number>> {
    const info = await tmux.paneInfo(tmuxSocket);
    const pids = new Set<number>();
    if (!info) return pids;
    pids.add(info.pid);
    let frontier = [String(info.pid)];
    for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const pid of frontier) {
        try {
          const { stdout } = await pexec('pgrep', ['-P', pid], { timeout: 1000 });
          for (const kid of stdout.trim().split('\n').filter(Boolean)) {
            pids.add(Number(kid));
            next.push(kid);
          }
        } catch {
          /* leaf or pgrep miss — continue with the rest */
        }
      }
      frontier = next;
    }
    return pids;
  }

  /** SPEC-LOOPWEDGE — surface an inferred idle (the persist to terminal.idleInferred is done
   *  by mission.ingest; this is the loud, never-silent audit + warn half). Three degraded paths: a
   *  custom-def quiescence backstop (a hook that SHOULD have signalled did not — the loud case), a
   *  dwell-only (tier C) demotion (the expected inferred path for that already-degraded tier), or the
   *  F2 built-in affirmative-idle heal (a lost built-in Stop hook, healed from screen evidence). */
  private flagInferred(term: Terminal, backstop: boolean, builtinAffirm = false): void {
    const why = builtinAffirm
      ? 'affirmative-idle screen evidence, no completion hook this turn — Stop hook may be lost (built-in backstop)'
      : backstop
        ? 'no completion hook seen this turn — custom hook may be broken (backstop)'
        : 'output-quiescence, dwell-only tier — no completion signal';
    console.warn(`[poller] ${term.id} idled by INFERENCE: ${why}`);
    audit('terminal.inferred-idle', { terminalId: term.id, provider: term.provider, backstop, builtinAffirm });
  }

  /** SPEC-LOOPWEDGE — whether the terminal's CURRENT idle was reached by inference (no
   *  completion signal) rather than a hook/screen signal — the data behind the amber "inferred
   *  completion — degraded" badge AND the loop runner's completion GUARD. Reads the durable record
   *  flag (written by mission.ingest for BOTH F1's harvest and F2's demote); cleared when the
   *  terminal next goes working. */
  wasIdleInferred(terminalId: string): boolean {
    return this.store.getTerminal(terminalId)?.idleInferred === true;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[poller] tick failed:', err));
    }, this.intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Drop tracking for a dead terminal. */
  forget(terminalId: string): void {
    this.lastHash.delete(terminalId);
    this.stableCount.delete(terminalId);
    this.baselineAt.delete(terminalId);
    this.resizeAt.delete(terminalId);
    this.busyRe.delete(terminalId);
    this.socketOnlyPolls.delete(terminalId);
    this.registry.release(terminalId); // drop the terminal's memoized forTerminal adapter
  }
}
