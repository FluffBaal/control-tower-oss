// SPEC-MEMORY — shared wire types for the versioned shared-memory system. One source of truth for the
// entry model, principals, transitions, and the HTTP request/response shapes, so server, CLI, and web
// build against the same contract (the src/shared/runway.ts precedent — type-only, no zod here; the
// server's runtime validation + transition policy live in src/server/memory/schema.ts).
//
// The three practical categories — Decisions, Gotchas, Glossary — are KEPT as a per-entry `kind`, and
// the three markdown files remain as GENERATED views. This augments the old free-form-file memory with
// individually versioned, provenance-carrying, concurrency-safe entries; it does not change the mental
// model the operator and agents already use.

/** The three practical note categories, kept from the original memory UX. */
export const MEMORY_KINDS = ['decision', 'gotcha', 'glossary'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** The generated markdown view filename for a kind — the same three files the old memory used, so
 *  `towerctl memory read` and the MemoryBar keep working unchanged. */
export function viewFileFor(kind: MemoryKind): string {
  return kind === 'decision' ? 'decisions.md' : kind === 'gotcha' ? 'gotchas.md' : 'glossary.md';
}

/** The three generated view files, derived from MEMORY_KINDS so the two never drift. Mirrors (and
 *  replaces) coordination.ts's old MEMORY_FILES literal. */
export const MEMORY_FILES: readonly string[] = MEMORY_KINDS.map(viewFileFor);

/** Who made a change. Tower supplies this from the caller's credential (agent terminal token → agent;
 *  session token → operator; internal → tower); it is NEVER taken from a request body — an agent that
 *  puts `{kind:'operator'}` in its payload does not become the operator (see schema.ts authorization). */
export type MemoryPrincipalKind = 'agent' | 'operator' | 'tower';
export type MemoryPrincipal =
  | { kind: 'agent'; terminalId: string; loopId?: string; missionId?: string; sortieId?: string }
  | { kind: 'operator' }
  | { kind: 'tower'; reason: string };

/** Two ORTHOGONAL status axes. A single enum could not express "was verified, then superseded", a
 *  dispute coexisting with a supersede, or "landed" (which lives on applicability, not here). */
export type MemoryVerification = 'provisional' | 'verified' | 'disputed';
export type MemoryLifecycle = 'active' | 'superseded' | 'retracted';

/** What supports an entry. A `test` item may be appended by an agent but NEVER flips verification —
 *  a passing test does not auto-promote a claim to operator-verified. */
export type MemoryEvidence =
  | { type: 'spec'; ref: string }
  | { type: 'code'; path: string; line?: number; sha?: string }
  | { type: 'test'; runId?: string; verdict: 'pass' | 'fail' }
  | { type: 'operator'; note: string }
  | { type: 'link'; url: string };

/** Where a claim applies. Project-wide knowledge vs a discovery made on a particular run/branch — a
 *  run-scoped entry carries its integration state so an agent on an older baseline can see the discovery
 *  without assuming its own code has that behavior. */
export type MemoryApplicability =
  | { scope: 'project' }
  | {
      scope: 'run';
      loopId: string;
      missionId?: string;
      sortieId?: string;
      branch?: string;
      baseBranch?: string;
      integration: 'in-flight' | 'landed' | 'abandoned';
      landedAt?: string;
    };

/** One revision's provenance record. The bounded inline tail (rev 1 + last N) lives on the entry; each
 *  record is also appended to history.jsonl (retention-rotated to at most two generations, so a bounded
 *  recent window rather than a full trail) and audited. */
export interface MemoryHistoryRecord {
  rev: number;
  at: string;
  by: MemoryPrincipal;
  op: 'add' | 'update' | 'dispute' | 'retract' | 'evidence' | 'supersede' | 'unsupersede' | 'integration' | 'import';
  /** The add's idempotency key (present on the rev-1 record for an added entry). */
  requestId?: string;
  /** Canonical hash of the add payload, so a retried add with a DIFFERENT payload is a conflict. */
  payloadHash?: string;
  /** A short, already-sanitized summary of what changed at this rev. */
  note?: string;
  /** The body text as it was BEFORE this revision, present only when this revision actually changed the
   *  body (a metadata-only update carries none). The one place the prior text of an edited entry survives —
   *  without it, an agent's body edit (allowed by design) permanently erases the previous claim. */
  prevBody?: string;
}

/** A single versioned memory entry. */
export interface MemoryEntry {
  id: string;
  /** Monotonic per-entry revision; the CAS token for edits. */
  rev: number;
  /** Monotonic per-project sequence; bumped on every mutation, drives the "since last read" delta. */
  seq: number;
  kind: MemoryKind;
  body: string;
  author: MemoryPrincipal;
  createdAt: string;
  updatedAt: string;
  verification: MemoryVerification;
  lifecycle: MemoryLifecycle;
  /** For a superseded entry, the summary/replacement that superseded it. */
  supersededBy?: string;
  /** For a consolidation summary, the entries it consolidated (also mirrored in `sources`). */
  supersedes?: string[];
  evidence: MemoryEvidence[];
  applicability: MemoryApplicability;
  /** For a consolidation summary: the sources + the rev each was at when consolidated. */
  sources?: { id: string; rev: number }[];
  /** Stable key for a Tower-managed upsert (e.g. 'ct:e2e-test-kit'); at most one entry per key. */
  key?: string;
  /** Provenance of the entry's origin (an imported/external entry never invents authorship/approval). */
  origin?: 'agent' | 'operator' | 'tower' | 'imported' | 'external';
  /** For a legacy/external import: where the bytes came from. */
  importedFrom?: { file: string; sha256: string; mtime: number };
  /** Bounded inline provenance tail (rev 1 + most recent revisions). Rev 1 — the add-idempotency record —
   *  is always kept here; history.jsonl holds only a retention-rotated recent window, not a full trail. */
  history: MemoryHistoryRecord[];
}

// ---- HTTP wire shapes ------------------------------------------------------------------------------

export interface MemoryAddRequest {
  /** Idempotency key — a retried add with the SAME key returns the SAME entry (never a duplicate). */
  requestId: string;
  kind: MemoryKind;
  body: string;
  /** Applicability scope; defaults to 'run' for a loop-bound agent, 'project' for the operator. */
  scope?: 'project' | 'run';
  evidence?: MemoryEvidence[];
}

export interface MemoryUpdateRequest {
  id: string;
  /** Expected current revision — a stale value is rejected (409) with the current entry. */
  rev: number;
  body?: string;
  evidence?: MemoryEvidence[];
  verification?: MemoryVerification;
  /** Only active↔retracted; active↔superseded is reserved to consolidate/unconsolidate. `supersededBy`
   *  is deliberately NOT a caller-settable field (it is an internal consolidation link). */
  lifecycle?: 'active' | 'retracted';
}

export interface MemoryConsolidateRequest {
  requestId: string;
  kind: MemoryKind;
  body: string;
  sources: { id: string; rev: number }[];
}

export interface MemorySearchQuery {
  q?: string;
  kind?: MemoryKind;
  lifecycle?: MemoryLifecycle;
  verification?: MemoryVerification;
  /** Return only entries with seq greater than this (the delta cursor). */
  sinceSeq?: number;
}

/** The 409 body when an edit's expected rev is stale — carries the current entry so the caller can
 *  merge and resend rather than clobber. */
export interface MemoryStaleResponse {
  error: 'stale';
  current: MemoryEntry;
}
