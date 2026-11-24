// SPEC-RUNWAY live credential swap -- what to DO with a live swap's outcome, and WHEN to attempt one.
// Pure orchestration over injected deps (no fs, no tmux, no timers of its own) so every branch is
// table-testable. server.ts wires the real swap / rotate / candidate lookup.
//
// Failure dispatch (per LiveSwapResult):
//   ok                                   -> swapped (the caller fans out WITHOUT a respawn)
//   lock-busy                            -> bounded retry with backoff, then DROP (the next usage sample re-fires)
//   target-unhealthy / no-target-oauth /
//   no-target-identity / unsigned-target -> fall back to the existing respawn-rotation, to the next candidate
//   write-failed, rolledBack:true        -> leave running (still on the original account), audit, next sample retries
//   write-failed, rolledBack:false       -> QUARANTINE: the slot may be cross-wired; force a clean respawn-rotation
//                                           (which discards the slot) rather than keep serving from it; if that
//                                           ALSO fails (no target / refusal / throw), KILL the terminal as a last
//                                           resort so a cross-wired slot is never left serving requests
//   not-slotted / not-configured         -> respawn-rotation (a non-slot terminal cannot live-swap)
//   in-progress / gone / same-account /
//   unknown-target / reserved-target     -> skipped (nothing to do or another mover owns the terminal)

import type { TerminalLiveSwapResult } from '../terminal-manager.js';

export type LiveSwapOutcome =
  | { kind: 'swapped'; toAccountUuid: string }
  | { kind: 'dropped'; reason: string }
  | { kind: 'rotated'; toProfileId: string; via: 'fallback' | 'quarantine' }
  | { kind: 'left-running'; reason: string }
  | { kind: 'killed'; reason: string }
  | { kind: 'failed'; reason: string };

export interface DispatchDeps {
  swap(terminalId: string, toProfileId: string): Promise<TerminalLiveSwapResult>;
  /** The existing respawn-rotation (rotateAndFanOut). Throws on refusal. */
  rotate(terminalId: string, toProfileId: string): Promise<void>;
  /** The next-best rotation target excluding these profile ids (chooseRotation over the eligible pool). */
  nextTarget(terminalId: string, exclude: readonly string[]): string | undefined;
  /** LAST RESORT for a quarantined (possibly cross-wired) slot whose clean rotation failed: kill the terminal
   *  (server.ts wires killAndForget). May throw; the dispatcher audits and reports 'failed'. */
  kill(terminalId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  audit(event: string, data: Record<string, unknown>): void;
  /** Extra attempts after the first on lock-busy. Default 2. */
  busyRetries?: number;
  /** Backoff base (ms), doubled per retry. Default 250. */
  busyBackoffMs?: number;
}

const ROTATE_ATTEMPTS = 3;

async function rotateToNext(
  terminalId: string,
  first: string | undefined,
  tried: string[],
  deps: DispatchDeps,
): Promise<string | undefined> {
  let target = first;
  for (let i = 0; i < ROTATE_ATTEMPTS && target; i++) {
    try {
      await deps.rotate(terminalId, target);
      return target;
    } catch (e) {
      deps.audit('runway.live-swap.rotate-failed', { terminalId, toProfileId: target, error: String((e as Error)?.message ?? e) });
      tried.push(target);
      target = deps.nextTarget(terminalId, tried);
    }
  }
  return undefined;
}

export async function dispatchLiveSwap(terminalId: string, toProfileId: string, deps: DispatchDeps): Promise<LiveSwapOutcome> {
  const retries = deps.busyRetries ?? 2;
  const backoff = deps.busyBackoffMs ?? 250;
  let res = await deps.swap(terminalId, toProfileId);
  for (let i = 0; i < retries && !res.ok && res.reason === 'lock-busy'; i++) {
    await deps.sleep(backoff * 2 ** i);
    res = await deps.swap(terminalId, toProfileId);
  }
  if (res.ok) return { kind: 'swapped', toAccountUuid: res.toAccountUuid };

  switch (res.reason) {
    case 'lock-busy':
      deps.audit('runway.live-swap.dropped', { terminalId, toProfileId, reason: 'lock-busy' });
      return { kind: 'dropped', reason: 'lock-busy' };

    case 'target-unhealthy':
    case 'no-target-oauth':
    case 'no-target-identity':
    case 'unsigned-target':
    case 'not-slotted':
    case 'not-configured': {
      const tried = [toProfileId];
      const next = res.reason === 'not-slotted' || res.reason === 'not-configured' ? toProfileId : deps.nextTarget(terminalId, tried);
      deps.audit('runway.live-swap.fallback', { terminalId, toProfileId, reason: res.reason, ...(next ? { next } : {}) });
      const to = await rotateToNext(terminalId, next, tried, deps);
      return to ? { kind: 'rotated', toProfileId: to, via: 'fallback' } : { kind: 'failed', reason: `${res.reason}: no rotation target` };
    }

    case 'write-failed': {
      if (res.rolledBack === true) {
        deps.audit('runway.live-swap.write-failed', { terminalId, toProfileId, rolledBack: true });
        return { kind: 'left-running', reason: 'write-failed (rolled back)' };
      }
      // rolledBack false/absent: the slot may be cross-wired. Never keep serving from it.
      deps.audit('runway.live-swap.quarantine', { terminalId, toProfileId });
      let to: string | undefined;
      try {
        to = await rotateToNext(terminalId, toProfileId, [], deps);
      } catch (e) {
        deps.audit('runway.live-swap.rotate-failed', { terminalId, toProfileId, error: String((e as Error)?.message ?? e) });
      }
      if (to) return { kind: 'rotated', toProfileId: to, via: 'quarantine' };
      deps.audit('runway.live-swap.quarantine-failed', { terminalId });
      try {
        await deps.kill(terminalId);
        deps.audit('runway.live-swap.quarantine-killed', { terminalId, toProfileId });
        return { kind: 'killed', reason: 'quarantine: no clean rotation available; terminal killed' };
      } catch (e) {
        deps.audit('runway.live-swap.quarantine-kill-failed', { terminalId, error: String((e as Error)?.message ?? e) });
        return { kind: 'failed', reason: 'quarantine: no clean rotation available and the kill failed' };
      }
    }

    default:
      return { kind: 'dropped', reason: res.reason };
  }
}

export interface TriggerDeps {
  /** runway enabled AND liveSwap on (read at call time). */
  enabled(): boolean;
  /** The terminal has a liveSlotDir. */
  isSlotted(terminalId: string): boolean;
  /** isOverThreshold for the terminal's current account. */
  overThreshold(terminalId: string): boolean;
  /** chooseRotation over the eligible candidates -> the target profile id, or undefined (none/exhausted). */
  pickTarget(terminalId: string): string | undefined;
  /** Run the swap + failure dispatch. */
  run(terminalId: string, toProfileId: string): Promise<unknown>;
  now(): number;
  /** Quiet period after a completed attempt. */
  cooldownMs: number;
  audit(event: string, data: Record<string, unknown>): void;
}

export type TriggerResult = 'fired' | 'disabled' | 'not-slotted' | 'under-threshold' | 'no-target' | 'in-flight' | 'cooldown' | 'error';

/** The reactive mid-turn trigger: debounced per terminal (one in flight; a cooldown after each attempt) and
 *  never throws. The usage-ingest handler calls `fire` un-awaited AFTER its 202; the returned promise exists
 *  for tests. */
export function createLiveSwapTrigger(deps: TriggerDeps): { fire(terminalId: string): Promise<TriggerResult> } {
  const inflight = new Set<string>();
  const lastDone = new Map<string, number>();
  return {
    async fire(terminalId) {
      try {
        if (!deps.enabled()) return 'disabled';
        if (!deps.isSlotted(terminalId)) return 'not-slotted';
        if (inflight.has(terminalId)) return 'in-flight';
        const last = lastDone.get(terminalId);
        if (last !== undefined && deps.now() - last < deps.cooldownMs) return 'cooldown';
        if (!deps.overThreshold(terminalId)) return 'under-threshold';
        const to = deps.pickTarget(terminalId);
        if (!to) return 'no-target';
        inflight.add(terminalId);
        try {
          await deps.run(terminalId, to);
        } finally {
          inflight.delete(terminalId);
          lastDone.set(terminalId, deps.now());
        }
        return 'fired';
      } catch (e) {
        deps.audit('runway.live-swap.trigger-error', { terminalId, error: String((e as Error)?.message ?? e) });
        return 'error';
      }
    },
  };
}
