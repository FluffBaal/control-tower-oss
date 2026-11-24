// SPEC-SKILLS-GATE — the loop-green gate-evidence store. A mission sortie attests a required skill
// gate's outcome; records persist per (missionId, gateId) in ~/.ct/config/gate-evidence.json via an
// atomic 0600 write. Structural mirror of reviews.ts: the shared store.ts loader (PER-RECORD validation
// so one bad record can't wipe the file) against the store.ts-exported GateEvidenceRecordSchema, so the
// agent submit route and this loader share one shape.
//
// The completion evaluator reads this in-memory (getFor) on its SYNCHRONOUS green branch — so there is
// no SSE hook and no async surface; every read is a pull (evaluator + report/status consumers).

import { paths } from './paths.js';
import { writeJsonAtomic, readJsonArray, GateEvidenceRecordSchema } from './store.js';
import { shortId } from './ids.js';
import type { GateEvidenceRecord } from '../shared/types.js';

// Growth bound — MISSION granularity, NEVER a record cap within a mission. upsert already dedupes to
// ONE record per (missionId, gateId), so a per-mission record cap (the ReviewStore shape) would evict
// a live gate's ONLY record on a mission with more distinct loop-green gates than the cap and park a
// fully-attested loop at attention forever. Instead: keep EVERY record of every retained mission, and
// once more than MAX_MISSIONS missions hold records, drop WHOLE missions oldest-first (by their latest
// submittedAt). Retention MAY consult the clock — this is garbage collection, not the verdict; the
// completion evaluator's freshness stays identity/phase-structure based and never reads submittedAt.
const MAX_MISSIONS = 200;

/** upsert input — the submit route supplies the ids/round/range (all server-derived from
 *  token→terminal→loop), never the submitter's body; gateId is validated against the mission's frozen
 *  requiredGates before it reaches here. */
export interface UpsertGateEvidenceInput {
  missionId: string;
  sortieId: string;
  gateId: string;
  round?: number;
  range?: string;
  status: 'pass' | 'fail';
  summary?: string;
}

/** newest-first submittedAt comparator (a lexical ISO-8601 compare is a chronological one). */
function byNewest(a: GateEvidenceRecord, b: GateEvidenceRecord): number {
  return a.submittedAt < b.submittedAt ? 1 : a.submittedAt > b.submittedAt ? -1 : 0;
}

export class GateEvidenceStore {
  private records = new Map<string, GateEvidenceRecord>(); // keyed by record id

  constructor() {
    const { records, hadRejects } = readJsonArray(paths.gates, GateEvidenceRecordSchema);
    for (const r of records as GateEvidenceRecord[]) this.records.set(r.id, r);
    // Reach a clean steady state now: the live file becomes valid-records-only; the dropped records
    // are already preserved in the .rejected-<ts> copy the loader wrote.
    if (hadRejects) this.persist();
  }

  // ---- reads ----
  /** The current record for a (missionId, gateId), or undefined. Exactly one exists per pair (upsert
   *  removes the prior); should a hand-edited file carry duplicates anyway, the LAST in file/write
   *  order wins (the Map preserves insertion order) — deterministic WITHOUT consulting a clock, the
   *  one place a submittedAt compare could have crept into an identity-not-clock verdict path. */
  getFor(missionId: string, gateId: string): GateEvidenceRecord | undefined {
    let found: GateEvidenceRecord | undefined;
    for (const r of this.records.values()) {
      if (r.missionId === missionId && r.gateId === gateId) found = r;
    }
    return found;
  }

  /** Every gate record for a mission, newest first — the status/report consumers' read. */
  listFor(missionId: string): GateEvidenceRecord[] {
    return [...this.records.values()].filter((r) => r.missionId === missionId).sort(byNewest);
  }

  // ---- mutation ----
  /**
   * Record an attestation. REPLACES any prior record for the same (missionId, gateId) with a FRESH id —
   * the newest attestation is the honest current one, so a later 'fail' overwrites an earlier 'pass'
   * (last attestation wins; the ReviewStore.upsert semantics). GC drops whole OLDEST missions past
   * MAX_MISSIONS — never a record within a retained mission (see the constant's note).
   */
  upsert(input: UpsertGateEvidenceInput): GateEvidenceRecord {
    for (const [rid, rec] of this.records) {
      if (rec.missionId === input.missionId && rec.gateId === input.gateId) this.records.delete(rid);
    }
    const candidate: GateEvidenceRecord = {
      id: shortId(),
      missionId: input.missionId,
      sortieId: input.sortieId,
      gateId: input.gateId,
      ...(input.round !== undefined ? { round: input.round } : {}),
      ...(input.range !== undefined ? { range: input.range } : {}),
      status: input.status,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      submittedAt: new Date().toISOString(),
    };
    // Final guard (mirrors ReviewStore.upsert): re-validate through the shared schema — the caps also
    // truncate here even when a route already capped, so the store shape is always sound.
    const record = GateEvidenceRecordSchema.parse(candidate) as GateEvidenceRecord;
    this.records.set(record.id, record);
    this.prune();
    this.persist();
    return record;
  }

  /** Drop WHOLE oldest missions beyond MAX_MISSIONS — never a record within a retained mission (a
   *  within-mission cap is the livelock: it could evict a live gate's only evidence; see the constant's
   *  note). "Oldest" = the mission's LATEST submittedAt (clock use is fine here — GC, not the verdict);
   *  a same-timestamp tie breaks on write order (later-written reads as fresher), so the drop set is
   *  deterministic even when many records share one millisecond. */
  private prune(): void {
    const latestByMission = new Map<string, string>(); // missionId → its newest submittedAt (insertion-ordered)
    for (const r of this.records.values()) {
      const prev = latestByMission.get(r.missionId);
      if (prev === undefined || r.submittedAt > prev) latestByMission.set(r.missionId, r.submittedAt);
    }
    if (latestByMission.size <= MAX_MISSIONS) return;
    const mids = [...latestByMission.keys()];
    const pos = new Map(mids.map((m, i) => [m, i]));
    mids.sort((a, b) => {
      const ta = latestByMission.get(a)!;
      const tb = latestByMission.get(b)!;
      if (ta !== tb) return ta < tb ? 1 : -1; // newest-first
      return pos.get(b)! - pos.get(a)!; // tie → later-written first
    });
    const drop = new Set(mids.slice(MAX_MISSIONS));
    for (const [rid, rec] of this.records) {
      if (drop.has(rec.missionId)) this.records.delete(rid);
    }
  }

  private persist(): void {
    writeJsonAtomic(paths.gates, [...this.records.values()], 0o600);
  }
}
