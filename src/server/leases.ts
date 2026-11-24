// Worktree session leases — in-memory, Tower-scoped exclusion + liveness (SPEC-FACTORY
// §3). A lease answers one question: "may I mutate this path right now, or is
// another Tower-initiated operation already using it?" Two jobs:
//
//   EXCLUSION — serialize operations that share a path. A `terminal` holds its worktree
//   for its whole life; a `land` holds the BASE REPO for the merge duration,
//   so two concurrent lands into one repo collide as a clean 409 instead of an
//   index.lock race. Exclusion compares owner.id ONLY — `kind` is advisory display
//   metadata for the 409 message, never part of the identity. That is deliberate: the
//   same terminal id may re-assert its lease under a different kind (e.g. a loop tick
//   re-acquiring a terminal's tree) and that MUST be an idempotent no-op, not a self-
//   collision. A DIFFERENT id on a held path throws LeaseHeldError carrying the holder.
//
//   LIVENESS — a held worktree cannot be reaped. WorktreeManager.remove refuses a path
//   whose holder id differs from the terminal being removed, so an adopted, actively-
//   driven builder's tree survives reconciler cleanup. On restart the leases map is
//   empty; the single-instance lock (lock.ts) guarantees no foreign holder exists, and
//   startup re-acquires a lease for every live terminal with a worktreePath.
//
// HONEST LIMIT (SPEC-FACTORY §6.2): leases guard Tower-initiated operations only. A human
// shell cd'd into the worktree is invisible to them — this is collision-avoidance between
// the Tower's own operations, not a security boundary.

export type LeaseOwner = { kind: 'terminal' | 'loop' | 'land' | 'bootstrap'; id: string };

/**
 * Thrown by acquire() when a DIFFERENT owner id already holds the path (and by
 * WorktreeManager.remove for a held tree). Carries the current `holder` so routes can
 * surface who is blocking; callers map it to HTTP 409.
 *
 * `since` is an additive, optional constructor arg (surface-compatible with the frozen
 * `constructor(holder)`): when the record's acquire timestamp is passed it enriches the
 * message, otherwise the message is built from the holder alone.
 */
export class LeaseHeldError extends Error {
  constructor(
    readonly holder: LeaseOwner,
    since?: string,
  ) {
    super(
      `worktree lease held by ${holder.kind} ${holder.id}` + (since ? ` since ${since}` : ''),
    );
    this.name = 'LeaseHeldError';
  }
}

/** Internal record: the owning lease plus when it was taken (for the 409 message). */
interface LeaseRecord {
  owner: LeaseOwner;
  since: string;
}

export class Leases {
  private held = new Map<string, LeaseRecord>();

  /**
   * Take the lease on `path` for `owner`. Same-id re-acquire (under ANY kind) is an
   * idempotent no-op that KEEPS the original registration (kind + since unchanged) —
   * exclusion is by id only. A different id → LeaseHeldError(currentHolder).
   */
  acquire(path: string, owner: LeaseOwner): void {
    const cur = this.held.get(path);
    if (cur) {
      if (cur.owner.id === owner.id) return; // idempotent — keep the ORIGINAL record
      throw new LeaseHeldError(cur.owner, cur.since);
    }
    this.held.set(path, { owner: { kind: owner.kind, id: owner.id }, since: new Date().toISOString() });
  }

  /** Release `path` only if `ownerId` is the current holder; any other id is a no-op. */
  release(path: string, ownerId: string): void {
    const cur = this.held.get(path);
    if (cur && cur.owner.id === ownerId) this.held.delete(path);
  }

  /** The current holder of `path` (a copy), or undefined if free. */
  holder(path: string): LeaseOwner | undefined {
    const cur = this.held.get(path);
    return cur ? { kind: cur.owner.kind, id: cur.owner.id } : undefined;
  }

  /**
   * Drop this owner's long-lived leases — used by the kill/vanish fan-outs. `land` leases
   * are deliberately EXEMPT: a land lease's lifetime is the merge call itself (acquired and
   * released inside worktrees.land's try/finally). If a kill/vanish fires mid-merge, the
   * fan-out must not free the base repo while `git merge` is still running — that would
   * let a concurrent land re-enter and recreate the index.lock race the lease exists to
   * prevent. The merge's own finally releases it moments later regardless.
   */
  releaseAllFor(ownerId: string): void {
    for (const [path, rec] of this.held) {
      if (rec.owner.id === ownerId && rec.owner.kind !== 'land') this.held.delete(path);
    }
  }
}
