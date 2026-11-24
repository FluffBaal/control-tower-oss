// SPEC-LOOP W6 — the code-review store. A routed reviewer (role 'review-judge') submits structured
// findings through POST /api/agent/review; they persist here per (missionId, sortieId) in
// ~/.ct/config/reviews.json via an atomic 0600 write. Mirrors stories/store.ts: a self-contained load
// (PER-RECORD validation so one bad record can't wipe the file) but validating against the store.ts-
// exported ReviewRecordSchema, so the route and the loader share one shape.
//
// The completion evaluator reads this in-memory (getFor/getById) on its SYNCHRONOUS green branch — so
// there is no SSE hook and no async surface; the reads are pull (evaluator + fix-assignment + report).

import { paths } from './paths.js';
import { writeJsonAtomic, readJsonArray, ReviewRecordSchema } from './store.js';
import { shortId } from './ids.js';
import type { ReviewRecord, ReviewFinding } from '../shared/types.js';

// Per-mission record bound (SPEC-LOOP W6 — pruning is PER-MISSION, never a global blanket that could
// evict a live mission's record between rounds). Keep the newest N per mission on write.
const MAX_PER_MISSION = 20;

/** upsert input — the route supplies the ids/round/range (all server-derived from token→terminal→loop),
 *  never the reviewer's body, and the already-capped findings. */
export interface UpsertReviewInput {
  missionId: string;
  sortieId: string;
  round?: number;
  range?: string;
  findings: ReviewFinding[];
}

/**
 * Load reviews.json via the shared store.ts readJsonArray — the ONE per-record loader (a torn/non-array
 * file is quarantined `.corrupt-<ts>` then empty; a transient read error throws; invalid records are
 * skipped with the original bytes preserved in `.rejected-<ts>`, reported via `hadRejects`). This was a
 * verbatim copy of that loader; deduping keeps behavior byte-equivalent apart from the log prefix
 * (`[store]`) and a generic skip message.
 */
function readReviews(): { records: ReviewRecord[]; hadRejects: boolean } {
  const { records, hadRejects } = readJsonArray(paths.reviews, ReviewRecordSchema);
  return { records: records as ReviewRecord[], hadRejects };
}

/** newest-first submittedAt comparator (a lexical ISO-8601 compare is a chronological one). */
function byNewest(a: ReviewRecord, b: ReviewRecord): number {
  return a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0;
}

/**
 * SPEC-LOOP — the review-retry freshness predicates (the researchRetryAt precedent). A retry stamps
 * `sortie.reviewRetryAt` but deliberately KEEPS the prior ReviewRecord (⟦DEC-4⟧ — a post-land attestation
 * flip is a review feature, so the discarded reviewer may still submit), so freshness is decided on two
 * axes that together preserve the flip while never failing open:
 *   - a RECORD is stale iff it was submitted before the stamp — all gate readers treat a stale record as
 *     absent, so a retried reviewer that never resubmits keeps the completion gate at 'needs-review'.
 *   - a route CALLER's loop is pre-retry iff it was created before the stamp — the discarded reviewer's
 *     loop loses read+write on the sortie's review, while the REPLACEMENT loop (created after the stamp,
 *     so createdAt > stamp always) keeps them and its resubmit is fresh (submittedAt > stamp always).
 * Both use a strict `<`, so a same-millisecond record/loop reads as FRESH — a deliberate 1ms window that
 * mirrors the shipped research precedent (missions.ts researchRetryAt gate). Keep the strict `<`.
 */
export function isStaleReviewRecord(
  rec: ReviewRecord | undefined,
  reviewRetryAt: string | undefined,
): boolean {
  return rec !== undefined && reviewRetryAt !== undefined && rec.submittedAt < reviewRetryAt;
}
export function isPreRetryReviewLoop(loopCreatedAt: string, reviewRetryAt: string | undefined): boolean {
  return reviewRetryAt !== undefined && loopCreatedAt < reviewRetryAt;
}

/**
 * SPEC-LOOP W6 — canonicalize a reviewer's free-text file path so trivial spelling variants converge to
 * ONE partition key (two spellings of one physical file must not split across two fixers → a land
 * conflict). Applied BOTH at ingest (capFindings, so the STORED finding.file is canonical) and as the
 * partition key. It does NOT resolve `foo.ts` vs `src/foo.ts` — that unreconcilable case stays a reviewer
 * error, with the land-conflict→attention backstop.
 */
export function canonicalizeReviewPath(s: string): string {
  return s
    .trim()
    .replace(/\\/g, '/') // windows separators → posix
    .replace(/^\.\//, '') // strip a leading ./
    .replace(/\/{2,}/g, '/') // collapse repeated /
    .replace(/\/+$/, ''); // drop a trailing /
}

/** SPEC-LOOP W6 — the CONFIRMED test (an absent verdict ⇒ CONFIRMED, the fail-safe posture). The ONE
 *  place this predicate lives — the fixer partition, the green-branch decision, the re-planner bundle,
 *  the report counts, and the route's confirmed count all read it, so they can never diverge. */
export function isConfirmed(f: ReviewFinding): boolean {
  return f.verdict !== 'PLAUSIBLE';
}

export class ReviewStore {
  private reviews = new Map<string, ReviewRecord>(); // keyed by record id

  constructor() {
    const { records, hadRejects } = readReviews();
    for (const r of records) this.reviews.set(r.id, r);
    // Reach a clean steady state now: the live file becomes valid-records-only; the dropped records
    // are already preserved in the .rejected-<ts> copy above.
    if (hadRejects) this.persist();
  }

  // ---- reads ----
  /** The current record for a (missionId, sortieId), or undefined. Exactly one survives per pair
   *  (upsert removes the prior), but returns the newest defensively. */
  getFor(missionId: string, sortieId: string): ReviewRecord | undefined {
    let best: ReviewRecord | undefined;
    for (const r of this.reviews.values()) {
      if (r.missionId !== missionId || r.sortieId !== sortieId) continue;
      if (!best || byNewest(r, best) < 0) best = r;
    }
    return best;
  }

  /** A record by its exact id — the ONLY way a review-fix phase resolves its pin (assignedFromReview).
   *  A replaced (fresh id) or pruned record returns undefined so the fix phase is loud, never silently
   *  repartitioned against different findings. */
  getById(id: string): ReviewRecord | undefined {
    return this.reviews.get(id);
  }

  /** The mission's newest review (any sortie) — the escalation bundle's review-findings source. */
  latestFor(missionId: string): ReviewRecord | undefined {
    let best: ReviewRecord | undefined;
    for (const r of this.reviews.values()) {
      if (r.missionId !== missionId) continue;
      if (!best || byNewest(r, best) < 0) best = r;
    }
    return best;
  }

  /** Every review for a mission, newest first — the delivery report's Code-review section. */
  listFor(missionId: string): ReviewRecord[] {
    return [...this.reviews.values()].filter((r) => r.missionId === missionId).sort(byNewest);
  }

  // ---- mutation ----
  /**
   * Record a reviewer's submission. REPLACES any prior record for the same (missionId, sortieId) — a
   * retried reviewer's resubmit is the honest current attestation — with a FRESH id, so a by-id pin
   * (assignedFromReview) to the OLD record resolves to undefined and a review-fix retry is loud on a
   * replacement rather than silently repartitioned. Prunes to the newest MAX_PER_MISSION per mission.
   */
  upsert(input: UpsertReviewInput): ReviewRecord {
    for (const [rid, rec] of this.reviews) {
      if (rec.missionId === input.missionId && rec.sortieId === input.sortieId) this.reviews.delete(rid);
    }
    const candidate: ReviewRecord = {
      id: shortId(),
      missionId: input.missionId,
      sortieId: input.sortieId,
      ...(input.round !== undefined ? { round: input.round } : {}),
      ...(input.range !== undefined ? { range: input.range } : {}),
      findings: input.findings,
      submittedAt: new Date().toISOString(),
    };
    // Final guard (mirrors StoryStore.upsert): re-validate through the shared schema — the caps also
    // truncate here even though the route already capped, so the store shape is always sound.
    const record = ReviewRecordSchema.parse(candidate) as ReviewRecord;
    this.reviews.set(record.id, record);
    this.prune();
    this.persist();
    return record;
  }

  /** Keep only the newest MAX_PER_MISSION records per mission (SPEC-LOOP W6 — never a global blanket
   *  that could evict a live mission's record between rounds; the store never queries mission status). */
  private prune(): void {
    const byMission = new Map<string, ReviewRecord[]>();
    for (const r of this.reviews.values()) {
      const arr = byMission.get(r.missionId) ?? [];
      arr.push(r);
      byMission.set(r.missionId, arr);
    }
    for (const arr of byMission.values()) {
      if (arr.length <= MAX_PER_MISSION) continue;
      arr.sort(byNewest);
      for (const stale of arr.slice(MAX_PER_MISSION)) this.reviews.delete(stale.id);
    }
  }

  private persist(): void {
    writeJsonAtomic(paths.reviews, [...this.reviews.values()], 0o600);
  }
}
