// SPEC-RESEARCH W9 — the research-finding store. A research sortie (role 'explore', marked
// `researchSortie`) submits a typed finding through POST /api/agent/research; it persists here per
// (missionId, sortieId) in ~/.ct/config/research.json via an atomic 0600 write. Structural mirror of
// reviews.ts: a self-contained load with PER-RECORD validation (one bad record can never wipe the
// file), validating against the store.ts-exported ResearchRecordSchema so the route and the loader
// share one shape.
//
// The reconcile-time finding gate reads this SYNCHRONOUSLY in-memory (getFor) — so, like the review
// store, there is no SSE hook and no async surface; every read is a pull (the gate, the spawn-time
// digest, the re-planner bundle, the report).

import { paths } from './paths.js';
import { writeJsonAtomic, readJsonArray, ResearchRecordSchema } from './store.js';
import { shortId } from './ids.js';
import type { ResearchRecord, ResearchCitation } from '../shared/types.js';

/**
 * Per-mission record bound (pruning is PER-MISSION, never a global blanket that could evict a live
 * mission's record).
 *
 * 100, not the review store's 20, and the difference is deliberate: `upsert` keeps at most ONE record
 * per sortie, so the real bound is the mission's research-sortie count. Reviewers are ~1 per round, so
 * 20 is unreachable for them — but fan-out is the whole point of this wave and nothing clamps authored
 * sortie counts, so a 21-researcher mission would evict sortie #1's finding. If that sortie had not yet
 * reconciled, the finding gate would then attention it with "finished without submitting a finding" —
 * a FALSE statement about an agent that did submit — and retrying it would evict the next oldest in
 * turn. The gate's note has to stay true, so the bound is raised above any plausible authored fan-out
 * rather than made mission-status-aware (the store never queries missions).
 */
const MAX_PER_MISSION = 100;

/** upsert input — the route supplies the ids and round (all server-derived from token→terminal→loop),
 *  never the agent's body, and the already-capped text. */
export interface UpsertResearchInput {
  missionId: string;
  sortieId: string;
  round?: number;
  topic: string;
  summary: string;
  citations?: ResearchCitation[];
}

/**
 * Load research.json via the shared store.ts readJsonArray — the ONE per-record loader (a torn/non-array
 * file is quarantined `.corrupt-<ts>` then empty; a transient read error throws; invalid records are
 * skipped with the original bytes preserved in `.rejected-<ts>`, reported via `hadRejects`). This was a
 * verbatim copy of that loader; deduping keeps behavior byte-equivalent apart from the log prefix
 * (`[store]`) and a generic skip message.
 */
function readResearch(): { records: ResearchRecord[]; hadRejects: boolean } {
  const { records, hadRejects } = readJsonArray(paths.research, ResearchRecordSchema);
  return { records: records as ResearchRecord[], hadRejects };
}

/** newest-first submittedAt comparator (a lexical ISO-8601 compare is a chronological one). */
function byNewest(a: ResearchRecord, b: ResearchRecord): number {
  return a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0;
}

/**
 * SPEC-RESEARCH W9 §5 — a bounded prose digest of a mission's findings, newest first: one block per
 * record, `topic — summary` with the summary sliced to `perFinding` and the whole text sliced to
 * `total`. Citations render as trailing `[ref]` markers — refs only, and never fetched.
 *
 * Exported because every merge-back surface composes it fresh at the point of use (nothing downstream
 * depends on a finding's exact bytes, which is why the store is upsert-replace rather than write-once),
 * and because it is the payload a later consult wave hands to a planner unchanged.
 */
export function buildResearchDigest(
  records: ResearchRecord[],
  caps: { perFinding: number; total: number },
): string {
  const blocks = records.map((r) => {
    const head = r.topic.trim() || '(untitled)';
    const body = r.summary.slice(0, caps.perFinding);
    // The citation line is capped too. `perFinding` bounds the SUMMARY, but a record may carry 20
    // refs of 500 chars — ~10KB of pointers that would crowd the summaries out of the total budget
    // (the total cap keeps it safe, but the digest would be mostly URLs). A quarter of the per-finding
    // budget is enough to carry the refs that matter and keeps the prose the point of the digest.
    const cites = (r.citations ?? []).map((c) => `[${c.ref}]`).join(' ').slice(0, Math.ceil(caps.perFinding / 4));
    return `- ${head} — ${body}${cites ? `\n  ${cites}` : ''}`;
  });
  return blocks.join('\n').slice(0, caps.total);
}

export class ResearchStore {
  private records = new Map<string, ResearchRecord>(); // keyed by record id

  constructor() {
    const { records, hadRejects } = readResearch();
    for (const r of records) this.records.set(r.id, r);
    // Reach a clean steady state now: the live file becomes valid-records-only; the dropped records are
    // already preserved in the .rejected-<ts> copy above.
    if (hadRejects) this.persist();
  }

  // ---- reads ----
  /** The current finding for a (missionId, sortieId), or undefined. Exactly one survives per pair
   *  (upsert removes the prior), but returns the newest defensively. THIS is the read the reconcile
   *  finding gate makes — synchronous and in-memory, safe inside the reconcile. */
  getFor(missionId: string, sortieId: string): ResearchRecord | undefined {
    let best: ResearchRecord | undefined;
    for (const r of this.records.values()) {
      if (r.missionId !== missionId || r.sortieId !== sortieId) continue;
      if (!best || byNewest(r, best) < 0) best = r;
    }
    return best;
  }

  /** Every finding for a mission, newest first — the digest, the re-planner bundle and the report. */
  listFor(missionId: string): ResearchRecord[] {
    return [...this.records.values()].filter((r) => r.missionId === missionId).sort(byNewest);
  }

  // ---- mutation ----
  /**
   * Record a research submission. REPLACES any prior record for the same (missionId, sortieId) with a
   * FRESH id: a retried researcher's resubmit is the honest current finding, and an in-place retry
   * would otherwise be a no-op that re-lands the stale one. Nothing downstream pins a finding by id
   * (unlike a review-fix phase), so a fresh id costs nothing here.
   */
  upsert(input: UpsertResearchInput): ResearchRecord {
    for (const [rid, rec] of this.records) {
      if (rec.missionId === input.missionId && rec.sortieId === input.sortieId) this.records.delete(rid);
    }
    const candidate: ResearchRecord = {
      id: shortId(),
      missionId: input.missionId,
      sortieId: input.sortieId,
      ...(input.round !== undefined ? { round: input.round } : {}),
      topic: input.topic,
      summary: input.summary,
      ...(input.citations !== undefined ? { citations: input.citations } : {}),
      submittedAt: new Date().toISOString(),
    };
    // Final guard (the ReviewStore.upsert idiom): re-validate through the shared schema — the caps also
    // truncate here even though the route already capped, so the stored shape is always sound.
    const record = ResearchRecordSchema.parse(candidate) as ResearchRecord;
    this.records.set(record.id, record);
    this.prune();
    this.persist();
    return record;
  }

  /** Keep only the newest MAX_PER_MISSION records per mission — never a global blanket, and never
   *  mission-status-aware (the store does not query missions). See the constant's own note for why the
   *  bound is what it is. */
  private prune(): void {
    const byMission = new Map<string, ResearchRecord[]>();
    for (const r of this.records.values()) {
      const arr = byMission.get(r.missionId) ?? [];
      arr.push(r);
      byMission.set(r.missionId, arr);
    }
    for (const arr of byMission.values()) {
      if (arr.length <= MAX_PER_MISSION) continue;
      arr.sort(byNewest);
      for (const stale of arr.slice(MAX_PER_MISSION)) this.records.delete(stale.id);
    }
  }

  private persist(): void {
    writeJsonAtomic(paths.research, [...this.records.values()], 0o600);
  }
}
