// SPEC-PLANNER §2 — the planner-consult store. A mission's escalation asks its bound planner terminal
// a structured question ('replan' in W8a); the request/reply record persists here per mission in
// ~/.ct/config/consults.json via an atomic 0600 write. Structural mirror of reviews.ts (the wave-
// contract store shape): a self-contained loader with PER-RECORD validation against the store.ts-
// exported PlannerConsultSchema, so the routes, the tick re-entry and the loader all share one shape.
//
// PURE persistence — it NEVER queries missions, mail or terminals (the reviews.ts self-contained rule).
// All sequencing (when to ask / deliver / expire / consume) lives in missions.ts + server.ts closures.
// The state machine IS enforced here (throw on an illegal transition), because the store is the single
// choke point every mutation passes through — a caller that races an expiry catches the throw (§m7).

import { paths } from './paths.js';
import { writeJsonAtomic, readJsonArray, PlannerConsultSchema } from './store.js';
import { shortId } from './ids.js';
import type { PlannerConsult, ConsultKind, ConsultStatus, PlanRevisionBundle } from '../shared/types.js';

// Per-mission bound on CLOSED consults (applied/rejected/expired). NEVER prunes an OPEN consult — the
// per-mission-never-global rule (reviews.ts): an open consult is a live continuation the tick still owns.
// Higher than reviews' 20 because a mission's consult history is its planner audit trail, and each
// escalation is bounded at MAX_ESCALATE_ATTEMPTS re-asks so the churn is small.
const MAX_CLOSED_PER_MISSION = 40;

/** create input — the server derives every id from token→terminal→(the unique live mission), never the
 *  agent's body; the question + payload are Tower-assembled. */
export interface CreateConsultInput {
  missionId: string;
  terminalId: string;
  kind: ConsultKind;
  question: string;
  payload?: PlanRevisionBundle;
  phasesHash?: string;
}

const OPEN_STATUSES: ConsultStatus[] = ['pending', 'delivered', 'answered'];
/** open = a live continuation the tick still owns; closed = terminal (applied/rejected/expired). */
function isOpen(c: PlannerConsult): boolean {
  return OPEN_STATUSES.includes(c.status);
}

/** newest-first askedAt comparator (a lexical ISO-8601 compare is a chronological one). */
function byNewest(a: PlannerConsult, b: PlannerConsult): number {
  return a.askedAt < b.askedAt ? 1 : a.askedAt > b.askedAt ? -1 : 0;
}

/**
 * Load consults.json via the shared store.ts readJsonArray — the ONE per-record loader (a torn/non-array
 * file is quarantined `.corrupt-<ts>` then empty; a transient read error throws; invalid records are
 * skipped with the original bytes preserved in `.rejected-<ts>`, reported via `hadRejects`). This was a
 * verbatim copy of that loader; deduping keeps behavior byte-equivalent apart from the log prefix
 * (`[store]`) and a generic skip message.
 */
function readConsults(): { records: PlannerConsult[]; hadRejects: boolean } {
  const { records, hadRejects } = readJsonArray(paths.consults, PlannerConsultSchema);
  return { records: records as PlannerConsult[], hadRejects };
}

export class ConsultStore {
  private consults = new Map<string, PlannerConsult>(); // keyed by record id

  constructor() {
    const { records, hadRejects } = readConsults();
    for (const c of records) this.consults.set(c.id, c);
    // Reach a clean steady state now: the live file becomes valid-records-only; the dropped records are
    // already preserved in the .rejected-<ts> copy above.
    if (hadRejects) this.persist();
  }

  // ---- reads ----
  getById(id: string): PlannerConsult | undefined {
    return this.consults.get(id);
  }

  /** Open consults for a mission (pending|delivered|answered), newest first — the reply-route selector
   *  set and the delivery-stamp scan. */
  openFor(missionId: string): PlannerConsult[] {
    return [...this.consults.values()]
      .filter((c) => c.missionId === missionId && isOpen(c))
      .sort(byNewest);
  }

  /** Every consult for a mission, newest first — the brief's Q/A ledger source and GET /api/consults. */
  listFor(missionId: string): PlannerConsult[] {
    return [...this.consults.values()].filter((c) => c.missionId === missionId).sort(byNewest);
  }

  /** Every open consult across all missions — the boot reconcile scan and the operator GET. */
  listOpen(): PlannerConsult[] {
    return [...this.consults.values()].filter(isOpen).sort(byNewest);
  }

  // ---- mutation ----
  create(input: CreateConsultInput): PlannerConsult {
    const candidate: PlannerConsult = {
      id: shortId(),
      missionId: input.missionId,
      terminalId: input.terminalId,
      kind: input.kind,
      question: input.question,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.phasesHash !== undefined ? { phasesHash: input.phasesHash } : {}),
      status: 'pending',
      askedAt: new Date().toISOString(),
    };
    // Final guard (mirrors ReviewStore.upsert): re-validate through the shared schema so the stored shape
    // is always sound (question truncates to the cap here even though the route already capped).
    const record = PlannerConsultSchema.parse(candidate) as PlannerConsult;
    this.consults.set(record.id, record);
    this.prune();
    this.persist();
    return record;
  }

  /** pending → delivered, stamping deliveredAt once (the answer clock switches on). Idempotent: an
   *  already delivered/answered/closed consult is left unchanged, so the two delivery-evidence sites
   *  (inbox route + pending route) can both fire without racing. */
  markDelivered(id: string): PlannerConsult | undefined {
    const rec = this.consults.get(id);
    if (!rec) return undefined;
    if (rec.status !== 'pending') return rec; // idempotent no-op
    const next: PlannerConsult = { ...rec, status: 'delivered', deliveredAt: new Date().toISOString() };
    this.consults.set(id, next);
    this.persist();
    return next;
  }

  /** pending|delivered → answered. Answering implies delivery, so deliveredAt is stamped too if absent.
   *  THROWS on any other source status — the reply route catches that (a tick may have expired the
   *  consult on an adjacent event-loop turn, §m7) and answers the caller 404/409. */
  recordAnswer(id: string, answer: unknown): PlannerConsult {
    const rec = this.consults.get(id);
    if (!rec) throw new Error('unknown consult');
    if (rec.status !== 'pending' && rec.status !== 'delivered') {
      throw new Error(`cannot answer a ${rec.status} consult`);
    }
    const now = new Date().toISOString();
    const next: PlannerConsult = {
      ...rec,
      status: 'answered',
      answeredAt: now,
      answer,
      ...(rec.deliveredAt === undefined ? { deliveredAt: now } : {}),
    };
    this.consults.set(id, next);
    this.persist();
    return next;
  }

  /**
   * Terminal transition. `applied`/`rejected` come ONLY from `answered` (the tick's consume path);
   * `expired` is the universal escape hatch — allowed from any OPEN status (pending|delivered|answered)
   * unconditionally (P3: the boot reconcile and detach must be able to expire an `answered` consult on a
   * live mission, and the store must not throw there). Expiring an already-closed consult is illegal.
   */
  resolve(id: string, status: 'applied' | 'rejected' | 'expired', expireReason?: PlannerConsult['expireReason']): PlannerConsult | undefined {
    const rec = this.consults.get(id);
    if (!rec) return undefined;
    if (status === 'expired') {
      if (!isOpen(rec)) throw new Error(`cannot expire a ${rec.status} consult`);
    } else if (rec.status !== 'answered') {
      throw new Error(`cannot mark ${status} from ${rec.status}`);
    }
    const next: PlannerConsult = {
      ...rec,
      status,
      ...(status === 'expired' && expireReason !== undefined ? { expireReason } : {}),
    };
    this.consults.set(id, next);
    this.prune();
    this.persist();
    return next;
  }

  /**
   * SPEC-PLANNER §5 — re-anchor an OPEN consult's ACTIVE clock to now. The clocks are absolute wall-clock,
   * so a pause or a Tower restart longer than a clock would otherwise expire a consult the planner never
   * got a live window for (and burn an escalation attempt on the first post-resume tick). RESETS, never
   * disables — a re-anchored consult STILL expires to a human gate on the FRESH clock if never answered:
   *   `pending`   → askedAt = now       (the delivery clock restarts)
   *   `delivered` → deliveredAt = now    (the answer clock restarts; the pane persists across a pause, so
   *                                       it is owed a fresh answer window)
   *   `answered`  → unchanged            (consumed next tick regardless of any clock)
   * lastNudgeAt is reset alongside so the one-shot renudge fires at the NEW half-deadline, not at once.
   */
  reanchor(id: string): PlannerConsult | undefined {
    const rec = this.consults.get(id);
    if (!rec) return undefined;
    const now = new Date().toISOString();
    let next: PlannerConsult;
    if (rec.status === 'pending') next = { ...rec, askedAt: now, lastNudgeAt: now };
    else if (rec.status === 'delivered') next = { ...rec, deliveredAt: now, lastNudgeAt: now };
    else return rec; // answered/closed — no live clock to reset
    this.consults.set(id, next);
    this.persist();
    return next;
  }

  /** Re-anchor every OPEN consult of a mission (the resume choke point). Returns the count touched. */
  reanchorOpen(missionId: string): number {
    let n = 0;
    for (const c of this.openFor(missionId)) if (this.reanchor(c.id)) n++;
    return n;
  }

  /** Count one nudge ATTEMPT (send-time + renudge) and stamp `lastNudgeAt` — the P5 one-shot renudge
   *  gate reads it to require crossing a half-deadline SINCE the previous nudge. The `nudges<3` cap is
   *  enforced by the caller. A no-op on an unknown/closed id (the caller only nudges open consults). */
  bumpNudges(id: string): void {
    const rec = this.consults.get(id);
    if (!rec) return;
    this.consults.set(id, { ...rec, nudges: (rec.nudges ?? 0) + 1, lastNudgeAt: new Date().toISOString() });
    this.persist();
  }

  /**
   * SPEC-PLANNER §8 — re-home a mission's OPEN consults onto a respawned planner pane. Each moves to
   * `toTid`; a `delivered` one reverts to `pending` (deliveredAt cleared, nudges 0) so the new pane is
   * re-nudged and the answer clock does not run against a pane that never saw it; and every
   * migrated consult restates `askedAt = now` so the DELIVERY clock is honest for the new pane rather
   * than inheriting the dead pane's elapsed time. Returns the count moved.
   */
  migrate(missionId: string, fromTid: string, toTid: string): number {
    let count = 0;
    const now = new Date().toISOString();
    for (const [id, rec] of this.consults) {
      if (rec.missionId !== missionId || rec.terminalId !== fromTid || !isOpen(rec)) continue;
      const reverted = rec.status === 'delivered';
      const next: PlannerConsult = {
        ...rec,
        terminalId: toTid,
        askedAt: now,
        ...(reverted ? { status: 'pending', nudges: 0 } : {}),
      };
      if (reverted) { delete next.deliveredAt; delete next.lastNudgeAt; }
      this.consults.set(id, next);
      count++;
    }
    if (count > 0) this.persist();
    return count;
  }

  /** Keep only the newest MAX_CLOSED_PER_MISSION CLOSED consults per mission (never a global blanket;
   *  never prunes an open consult — an open consult is a live continuation, reviews.ts:16-18). */
  private prune(): void {
    const closedByMission = new Map<string, PlannerConsult[]>();
    for (const c of this.consults.values()) {
      if (isOpen(c)) continue;
      const arr = closedByMission.get(c.missionId) ?? [];
      arr.push(c);
      closedByMission.set(c.missionId, arr);
    }
    for (const arr of closedByMission.values()) {
      if (arr.length <= MAX_CLOSED_PER_MISSION) continue;
      arr.sort(byNewest);
      for (const stale of arr.slice(MAX_CLOSED_PER_MISSION)) this.consults.delete(stale.id);
    }
  }

  private persist(): void {
    writeJsonAtomic(paths.consults, [...this.consults.values()], 0o600);
  }
}
