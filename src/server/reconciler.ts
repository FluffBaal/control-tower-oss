// Reconciler — the subsystem that keeps config intent and real tmux state in
// agreement (SPEC §11, the largest consistency gap). tmux is the
// source of truth for what is *running*; config records intent. On startup and on
// a timer we diff the two and converge:
//
//   - config terminal alive in tmux but marked 'starting' -> adopt as 'idle'
//   - config terminal (not killed) with no tmux session    -> mark 'killed'
//     (reason: vanished) and flag resumable, so the UI can offer a relaunch
//   - live ct-* socket with no config record                -> report as orphan
//
// This makes `kill -9` mid-operation and `wsl --shutdown` (which takes every tmux
// server with it) recoverable rather than leaving the UI showing fiction.

import type { Store } from './store.js';
import type { Terminal } from '../shared/types.js';
import * as tmux from './tmux.js';
import { audit } from './audit.js';

export interface ReconcileResult {
  adopted: string[];
  vanished: string[];
  /** Live ct-* sockets with no owning store record this sweep (reaped or not — see orphansReaped). */
  orphanSockets: string[];
  /** The subset of orphanSockets this sweep actually killed: those whose terminal record THIS store
   *  dropped on load, so they are provably this Tower's leaked servers (never another Tower's socket). */
  orphansReaped: string[];
}

/** Grace window during which a 'starting' terminal (persisted before its tmux session
 *  exists) is not treated as vanished — covers a slow `git worktree add` during create. */
const STARTING_GRACE_MS = 2 * 60 * 1000;

/** True if createdAt parses AND is within the grace window. An unparseable timestamp
 *  returns false (beyond grace) so a malformed record isn't shielded from cleanup forever. */
function withinStartingGrace(createdAt: string): boolean {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && Date.now() - t <= STARTING_GRACE_MS;
}

/** Cleanup hook run when a terminal is found to have vanished, so it can release ALL
 *  the same per-terminal resources killTerminal releases on a user kill (token files
 *  AND in-memory maps). */
export interface ReconcilerDeps {
  onVanish?: (term: Terminal) => void;
  /**
   * SPEC-RESTART-RESUME FIX A — true while TerminalManager has an in-flight restart (including a
   * claude `--resume` attempt's detached health-check/fall-forward window) on this terminal. This
   * sweep's own 15s timer is free-running from boot — NOT phase-locked to any restart — so without
   * this a sweep landing in the ~500ms-to-a-few-second gap between a refused resume's death and the
   * background watcher's own fall-forward respawn would see a genuinely dead pane, vanish the
   * terminal (state: killed + onTerminalGone force-failing its bound loop + killing its tmux server),
   * and defeat the fall-forward entirely — the SEVERE bug this dep exists to close. Optional: a
   * reconciler under test with no TerminalManager wired simply never defers.
   */
  restartInFlight?: (terminalId: string) => boolean;
}

export class Reconciler {
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  /** Sockets we already reaped, so a socket file that lingers past `kill-server` isn't re-killed and
   *  re-audited on every subsequent 15s sweep (unbounded audit spam for one stubborn socket). */
  private reaped = new Set<string>();

  constructor(
    private store: Store,
    private deps: ReconcilerDeps = {},
    private intervalMs = 15_000,
  ) {}

  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = { adopted: [], vanished: [], orphanSockets: [], orphansReaped: [] };
    const liveSockets = new Set(await tmux.listTowerSockets());
    const known = new Set<string>();

    for (const term of this.store.listTerminals()) {
      if (term.state === 'killed') continue;
      known.add(term.tmuxSocket); // its socket is accounted for either way — never a false orphan
      // SPEC-RESTART-RESUME FIX A — an in-flight restart/resume-watch owns this terminal's pane right
      // now (it may be legitimately, transiently dead between a refused resume's exit and the
      // watcher's own fall-forward respawn a poll-interval later): defer to it entirely this sweep
      // rather than risk vanishing a pane the watcher is about to revive.
      if (this.deps.restartInFlight?.(term.id)) continue;
      // hasSession and isPaneDead re-throw on a tmux timeout, which surfaces as `killed` because the
      // tmux() wrapper kills a stalled client with SIGKILL (a SIGTERM-trapping client would otherwise
      // exit 0 and mask the stall). That must NOT drive the DESTRUCTIVE vanish path below — deleting a
      // merely-stalled terminal's token files would wedge it once the socket recovers. On any probe
      // throw, skip this terminal entirely and let the next sweep retry; known.add above already keeps
      // a stalled socket from being reported as an orphan.
      try {
        const alive = await tmux.hasSession(term.tmuxSocket);
        if (alive) {
          if (term.state === 'starting') {
            this.store.patchTerminal(term.id, { state: 'idle' });
            this.store.appendEvent({ terminalId: term.id, type: 'reconcile', payload: { adopted: true } });
            result.adopted.push(term.id);
          } else if ((await tmux.isPaneDead(term.tmuxSocket)) && (await tmux.isPaneDead(term.tmuxSocket))) {
            // Every pane's command has EXITED while the session lives on: `remain-on-exit on` leaves
            // the corpses, so hasSession stays true forever and the record would read 'working' for
            // good. A confirming second read before the destructive vanish, symmetric with the
            // missing-session path below — pane_dead is latched, so the reads agree unless the session
            // was torn down between them, in which case the vanish safely aborts and next sweep's
            // missing-session path takes over. A 'starting' terminal never reaches this check (adopted
            // above first): its create flow may still be handing over token files, and one extra sweep
            // of latency is cheaper than racing it.
            await this.vanish(term, 'pane-dead', result);
          }
        } else if (
          // A 'starting' terminal younger than the grace period is almost certainly still
          // mid-create — createTerminal persists the draft BEFORE it runs a possibly-slow
          // `git worktree add` and then tmux.newSession, so its session legitimately doesn't
          // exist yet. Vanishing it here would delete the hook/broker token files the create
          // is about to hand the agent, wedging the terminal it's launching. Leave it for a
          // later tick, which will adopt it once its session is up. NaN-safe: an unparseable
          // createdAt is treated as BEYOND grace (Number.isFinite guard), so a malformed
          // record can still be cleaned rather than lingering as a permanent ghost.
          (term.state !== 'starting' || !withinStartingGrace(term.createdAt)) &&
          !(await tmux.hasSession(term.tmuxSocket))
        ) {
          // Confirm the session is really gone with a second check — a single
          // `has-session` can transiently fail under load (the OOM pressure the test kit
          // guards against), and the vanish path is DESTRUCTIVE (deletes the terminal's
          // credential/hook token files). Only proceed once two consecutive checks agree.
          await this.vanish(term, 'session-vanished', result);
        }
      } catch (e) {
        console.error(`[reconciler] probe failed for ${term.id}; skipping this sweep:`, (e as Error).message);
      }
    }

    const droppedSockets = this.store.droppedTerminalSockets();
    for (const sock of liveSockets) {
      if (known.has(sock)) continue;
      result.orphanSockets.push(sock);
      // Reap ONLY an orphan whose terminal record THIS store dropped on load: that socket is provably
      // ours (it was in our own store file) yet has no live record, so its tmux server leaks a runaway
      // agent CLI forever, invisible to every dashboard/API/audit. A machine-global ct-* socket owned by
      // ANOTHER Tower (or a parallel test process) is never in our dropped set, so this can never
      // cross-Tower kill — the footgun that reverted the earlier blanket reap. killServer swallows its
      // own errors, so a socket that already died between detection and here is a harmless no-op.
      if (droppedSockets.has(sock) && !this.reaped.has(sock)) {
        this.reaped.add(sock); // mark before the kill so a lingering socket file can't re-trigger it
        await tmux.killServer(sock);
        result.orphansReaped.push(sock);
        audit('reconcile.orphan.reaped', { socket: sock });
      }
    }
    return result;
  }

  /** The DESTRUCTIVE convergence shared by both vanish cases (session gone / pane dead). Callers
   *  must have confirmed the condition with two consecutive agreeing probe reads BEFORE calling:
   *  this releases the terminal's credential/hook token files via onVanish. `reason` is the audit
   *  distinction; the record-convergence contract (state flip, onVanish fan-out, resumable event) is
   *  identical — a 'pane-dead' terminal additionally has its still-live tmux server reaped. */
  private async vanish(term: Terminal, reason: 'session-vanished' | 'pane-dead', result: ReconcileResult): Promise<void> {
    this.store.patchTerminal(term.id, {
      state: 'killed',
      closedAt: new Date().toISOString(),
    });
    // Release ALL per-terminal resources, exactly as killTerminal does — token
    // files AND in-memory maps — or they leak unbounded across VM teardowns.
    this.deps.onVanish?.(term);
    this.store.appendEvent({
      terminalId: term.id,
      type: 'reconcile',
      payload: { reason, resumable: true, sessionId: term.sessionId },
    });
    result.vanished.push(term.id);
    // 'session-vanished' means the tmux server is already gone; a 'pane-dead' terminal's server is
    // still ALIVE (that live-but-corpse session is exactly what made hasSession lie), so reap it here
    // or it leaks forever — the killed record is skipped every sweep and its orphan socket is only
    // logged, never killed. killServer swallows its own errors, so a race that already ended the
    // server is harmless.
    if (reason === 'pane-dead') await tmux.killServer(term.tmuxSocket);
  }

  start(): void {
    this.timer = setInterval(() => {
      // Single-flight: a sweep that overruns the interval (a stalled socket can burn up to
      // TMUX_CMD_TIMEOUT_MS per probe, and the dead-pane check adds one more) must not overlap the
      // next tick — two concurrent destructive sweeps would re-probe an already-vanishing terminal
      // and duplicate its teardown/audit. The flag is always cleared in finally, so a throwing sweep
      // can't wedge reconciliation off.
      if (this.sweeping) return;
      this.sweeping = true;
      this.reconcile()
        .catch((err) => console.error('[reconciler] tick failed:', err))
        .finally(() => { this.sweeping = false; });
    }, this.intervalMs);
    // Don't keep the process alive solely for reconciliation.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
