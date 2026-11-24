// SPEC-RUNWAY W3 — the rotation DECISION logic. PURE: given the current subscription's usage and the
// pool's candidates, decide whether to rotate, to which subscription, or that the pool is exhausted
// (→ the loop waits for the soonest reset). The impure resolution (profile→accountUuid, usage lookup,
// credential probe) happens in the caller (server/loops wiring); this module only decides, so it is
// exhaustively table-testable.
//
// Invariants baked in here (in this pure function):
//   - UNKNOWN usage (no sample yet) NEVER counts as over-threshold and NEVER is preferred as a target
//     over a known-under-threshold one — absent ≠ 0%, and absent ≠ exhausted.
//   - a target must be a DIFFERENT subscription (accountUuid), signed in, and not walled.
//   - known-under-threshold targets first (most headroom = lowest max-window %), unknown ones only as a
//     last resort — paired with the caller's per-iteration rotation budget to bound any ping-pong.
// NOT enforced here: "not reserved" (the assistant-Brain account must never be a rotation target). That
// is the CALLER's job — candidatesOf() drops reservedProfileIds() before building candidates, so a
// reserved account never reaches this function. There is no `reserved` field on RotationCandidate; keep
// the reserved-filter in the caller if you add a new call site.

import type { RunwayUsage } from '../../shared/runway.js';

/** Max used-percentage across a subscription's EFFECTIVE windows (already expiry-filtered by the
 *  UsageStore), or undefined when there are no windows (UNKNOWN). The threshold compares against this. */
export function maxUsedPct(usage: RunwayUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const vals = Object.values(usage.windows).map((w) => w.usedPct);
  return vals.length ? Math.max(...vals) : undefined;
}

/** The soonest window reset (epoch MS) across a subscription's windows, or undefined. resetsAt is
 *  stored in SECONDS (the CLI's unit); converted to MS here for the loop's wait math. */
export function soonestResetMs(usage: RunwayUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const vals = Object.values(usage.windows).map((w) => w.resetsAt * 1000);
  const wall = usage.wall?.until;
  const all = wall !== undefined ? [...vals, wall] : vals;
  return all.length ? Math.min(...all) : undefined;
}

/** A pool candidate resolved to the fields the decision needs. */
export interface RotationCandidate {
  profileId: string;
  accountUuid: string;
  /** Max effective window used%, or undefined = UNKNOWN (no sample yet). */
  usedPct?: number;
  /** A live usage wall (reactive) — treat as fully consumed. */
  walled: boolean;
  /** The effective threshold for this candidate (its per-entry override or the global). */
  thresholdPct: number;
  /** Credential probe verdict is 'present'. */
  signedIn: boolean;
  /** Pool order index (rotation order; the tie-break). */
  order: number;
  /** Soonest reset (epoch ms) for the exhausted-wait math, if known. */
  soonestResetMs?: number;
}

export type RotationPlan =
  | { kind: 'rotate'; toProfileId: string; toAccountUuid: string; reason: 'threshold' | 'wall' }
  | { kind: 'exhausted'; soonestResetMs?: number }
  | { kind: 'none' };

/** Is a subscription over its rotate-at threshold? A live wall = yes; UNKNOWN usage = no (never rotate
 *  away on unknown); otherwise max-window% ≥ threshold. */
export function isOverThreshold(c: { usedPct?: number; walled: boolean; thresholdPct: number }): boolean {
  if (c.walled) return true;
  if (c.usedPct === undefined) return false;
  return c.usedPct >= c.thresholdPct;
}

/**
 * Decide a rotation. `current` is the subscription the pane runs on now; `candidates` is the pool
 * (may include `current`). Returns:
 *   - {none} when current is NOT over threshold (nothing to do), or when current isn't even pooled.
 *   - {rotate,...} to the best target: a different, signed-in, not-walled subscription that is
 *     known-under-threshold (lowest max-window% wins, pool order breaks ties); failing that, a
 *     signed-in unknown-usage subscription (pool order) as a last resort.
 *   - {exhausted, soonestResetMs} when current is over threshold but no eligible target exists — the
 *     loop then waits in-session for the soonest reset (Claude Code's autoContinueAtUsageLimit).
 */
export function chooseRotation(
  current: { accountUuid: string; usedPct?: number; walled: boolean; thresholdPct: number; soonestResetMs?: number } | undefined,
  candidates: RotationCandidate[],
  reason: 'threshold' | 'wall' = 'threshold',
): RotationPlan {
  if (!current || !isOverThreshold(current)) return { kind: 'none' };

  const eligible = candidates.filter(
    (c) => c.accountUuid !== current.accountUuid && c.signedIn && !c.walled,
  );
  const known = eligible
    .filter((c) => c.usedPct !== undefined && c.usedPct < c.thresholdPct)
    .sort((a, b) => a.usedPct! - b.usedPct! || a.order - b.order);
  const unknown = eligible.filter((c) => c.usedPct === undefined).sort((a, b) => a.order - b.order);

  const target = known[0] ?? unknown[0];
  if (target) return { kind: 'rotate', toProfileId: target.profileId, toAccountUuid: target.accountUuid, reason };

  // No eligible target — the whole pool is at/over threshold or signed out. Wait for the soonest reset
  // among the current + all candidates (the loop honors this via autoContinueAtUsageLimit).
  const resets = [current.soonestResetMs, ...candidates.map((c) => c.soonestResetMs)].filter(
    (v): v is number => typeof v === 'number',
  );
  return { kind: 'exhausted', ...(resets.length ? { soonestResetMs: Math.min(...resets) } : {}) };
}
