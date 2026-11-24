// SPEC-MEMORY — runtime validation + policy for memory entries. Holds the zod schema (M6 strip-trap:
// every persisted field listed, so a hand-edited or foreign entry is normalized, not silently widened),
// the caps (a CALLER-supplied body or note over its cap is REJECTED by the store — never silently
// truncated, so a write either lands whole or is refused with a reason; clampNote remains for
// Tower-generated history notes, and fitImportedBody is the one lossy path, for the legacy import, where a
// note must be kept rather than refused), the add-idempotency canonical hash, and the STATIC transition
// table that makes "only the operator may verify" and "a passing test never auto-promotes" structural
// rather than conventional. Pure — no fs, no store.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  MemoryEntry,
  MemoryEvidence,
  MemoryPrincipalKind,
  MemoryVerification,
  MemoryLifecycle,
} from '../../shared/memory.js';
import { MEMORY_KINDS } from '../../shared/memory.js';
import { bodyHasReservedSyntax, neutralizeReservedSyntax, LEGACY_SUFFIX, RESERVED_SYNTAX_MESSAGE } from './views.js';

// ---- caps ------------------------------------------------------------------------------------------
export const BODY_MAX = 2048; // per-entry body chars; replaces the old 64KB whole-file budget
export const NOTE_MAX = 500; // history note / operator evidence note chars
export const EVIDENCE_MAX = 8; // evidence items per entry PER CLASS (operator notes / everything else)
export const MAX_ENTRIES_PER_PROJECT = 500; // store-enforced count cap

/**
 * Make a LEGACY body storable: neutralized (views.ts neutralizeReservedSyntax) AND within BODY_MAX, with
 * both guaranteed on the result. Used ONLY by the legacy import — every caller-supplied body is rejected by
 * the store instead; here the note must be kept (its original is archived beside the store).
 *
 * Order matters. Truncating AFTER neutralizing can cut `— verified (legacy)` back to a bare `— verified`
 * at the boundary — a reserved body again; truncating mid-line can likewise turn an innocent `— verified
 * by me` into the badge. So an over-cap body is cut on LINE boundaries: whole trailing lines are dropped
 * (a whole-line cut cannot create a partial token, and every surviving line was already neutralized). Only
 * when the FIRST line alone is over the cap is it hard-cut — leaving LEGACY_SUFFIX's worth of room, because
 * a cut can expose a reserved line as the line's whole content and neutralizing it again grows it by at
 * most that suffix (the header's `x-` is shorter) — then neutralized once more. Deterministic, at most two
 * passes, idempotent: fitImportedBody(fitImportedBody(x)) === fitImportedBody(x).
 */
export function fitImportedBody(body: string): string {
  const safe = neutralizeReservedSyntax(body);
  if (safe.length <= BODY_MAX) return safe;
  const lines = safe.split('\n');
  let kept = lines[0]!;
  if (kept.length > BODY_MAX) return neutralizeReservedSyntax(kept.slice(0, BODY_MAX - LEGACY_SUFFIX.length));
  for (let i = 1; i < lines.length && kept.length + 1 + lines[i]!.length <= BODY_MAX; i++) kept += `\n${lines[i]}`;
  return kept;
}
/** Truncate to NOTE_MAX. Used ONLY for Tower-generated history notes — an operator's evidence note over
 *  the cap is rejected by the store instead. */
export function clampNote(s: string): string {
  return s.length > NOTE_MAX ? s.slice(0, NOTE_MAX) : s;
}
/**
 * Bound an evidence list PER CLASS: at most EVIDENCE_MAX operator notes and at most EVIDENCE_MAX items of
 * every other type, each class most-recent-wins among ITSELF (relative order preserved). Only the operator
 * can attach an operator note (the store refuses it from anyone else), so under this cap an agent flooding
 * test/link/code items can never push an operator's note out — the one signal only the operator can give
 * survives any non-operator volume; the list stays bounded at 2 × EVIDENCE_MAX.
 */
export function clampEvidence(items: MemoryEvidence[]): MemoryEvidence[] {
  const isOp = (e: MemoryEvidence) => e.type === 'operator';
  const opCount = items.filter(isOp).length;
  let dropOp = opCount - EVIDENCE_MAX;
  let dropOther = items.length - opCount - EVIDENCE_MAX;
  if (dropOp <= 0 && dropOther <= 0) return items;
  const out: MemoryEvidence[] = [];
  for (const e of items) {
    if (isOp(e) ? dropOp-- > 0 : dropOther-- > 0) continue; // the OLDEST of an over-cap class go first
    out.push(e);
  }
  return out;
}

// ---- zod schemas (every optional field listed — M6) ------------------------------------------------
const principalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), terminalId: z.string(), loopId: z.string().optional(), missionId: z.string().optional(), sortieId: z.string().optional() }),
  z.object({ kind: z.literal('operator') }),
  z.object({ kind: z.literal('tower'), reason: z.string() }),
]);

// Every free-text field is bounded: an unbounded string in a request body is a synchronous-parse stall
// on the single event loop (the store path is all-sync by design).
const evidenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('spec'), ref: z.string().max(512) }),
  z.object({ type: z.literal('code'), path: z.string().max(512), line: z.number().optional(), sha: z.string().max(512).optional() }),
  z.object({ type: z.literal('test'), runId: z.string().max(512).optional(), verdict: z.enum(['pass', 'fail']) }),
  z.object({ type: z.literal('operator'), note: z.string().max(2048) }),
  z.object({ type: z.literal('link'), url: z.string().max(512) }),
]);

const applicabilitySchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('project') }),
  z.object({
    scope: z.literal('run'),
    loopId: z.string(),
    missionId: z.string().optional(),
    sortieId: z.string().optional(),
    branch: z.string().optional(),
    baseBranch: z.string().optional(),
    integration: z.enum(['in-flight', 'landed', 'abandoned']),
    landedAt: z.string().optional(),
  }),
]);

const historyRecordSchema = z.object({
  rev: z.number(),
  at: z.string(),
  by: principalSchema,
  op: z.enum(['add', 'update', 'dispute', 'retract', 'evidence', 'supersede', 'unsupersede', 'integration', 'import']),
  requestId: z.string().optional(),
  payloadHash: z.string().optional(),
  note: z.string().optional(),
  prevBody: z.string().optional(),
});

export const memoryEntrySchema = z.object({
  id: z.string(),
  rev: z.number(),
  seq: z.number(),
  kind: z.enum(MEMORY_KINDS),
  body: z.string(),
  author: principalSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  verification: z.enum(['provisional', 'verified', 'disputed']),
  lifecycle: z.enum(['active', 'superseded', 'retracted']),
  supersededBy: z.string().optional(),
  supersedes: z.array(z.string()).optional(),
  evidence: z.array(evidenceSchema),
  applicability: applicabilitySchema,
  sources: z.array(z.object({ id: z.string(), rev: z.number() })).optional(),
  key: z.string().optional(),
  origin: z.enum(['agent', 'operator', 'tower', 'imported', 'external']).optional(),
  importedFrom: z.object({ file: z.string(), sha256: z.string(), mtime: z.number() }).optional(),
  history: z.array(historyRecordSchema),
});

// ---- request schemas -------------------------------------------------------------------------------
// Every request that carries a body refuses reserved view syntax at the edge (the store refuses it again,
// structurally): a body embedding an entry marker would be re-parsed as a section boundary on the next
// whole-file save, letting an agent write text INTO another (verified) entry — see views.ts.
function refuseReservedBody(req: { body?: string }, ctx: z.RefinementCtx): void {
  if (req.body !== undefined && bodyHasReservedSyntax(req.body)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: RESERVED_SYNTAX_MESSAGE });
  }
}

export const memoryAddRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    kind: z.enum(MEMORY_KINDS),
    body: z.string().min(1),
    scope: z.enum(['project', 'run']).optional(),
    evidence: z.array(evidenceSchema).optional(),
  })
  .superRefine(refuseReservedBody);
export const memoryUpdateRequestSchema = z
  .object({
    id: z.string().min(1),
    rev: z.number().int().nonnegative(),
    // An empty body is refused rather than blanking the entry — retract is the way to remove one.
    body: z.string().min(1).optional(),
    evidence: z.array(evidenceSchema).optional(),
    verification: z.enum(['provisional', 'verified', 'disputed']).optional(),
    // lifecycle here covers only active↔retracted; active↔superseded is reserved to consolidate. There is
    // deliberately NO `supersededBy` field — it is an internal link set only by consolidate/unconsolidate,
    // never by a caller (a bogus value would permanently block an entry from being consolidated).
    lifecycle: z.enum(['active', 'retracted']).optional(),
  })
  .superRefine(refuseReservedBody);
export const memoryConsolidateRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    kind: z.enum(MEMORY_KINDS),
    body: z.string().min(1),
    sources: z.array(z.object({ id: z.string(), rev: z.number() })).min(1),
  })
  .superRefine(refuseReservedBody);

// ---- add-idempotency canonical hash ----------------------------------------------------------------
/** Stable JSON with sorted keys, so a retried add with a semantically identical payload hashes the same
 *  regardless of key order, and any real content change hashes differently (→ a 422 conflict). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
export function canonicalHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

// ---- transition policy -----------------------------------------------------------------------------
type Axis = 'verification' | 'lifecycle';
interface Transition {
  axis: Axis;
  from: string;
  to: string;
  allowed: MemoryPrincipalKind[];
}

// The whole authorization surface for status changes, keyed on the CALLER's principal kind — never on a
// body-supplied field. Anything not listed is refused. Note: active↔superseded is NOT here — it happens
// only through the consolidate/unconsolidate store ops, never the generic update path.
const TRANSITIONS: readonly Transition[] = [
  // verification — ONLY the operator may verify; an agent may dispute; reopening is operator-only.
  { axis: 'verification', from: 'provisional', to: 'verified', allowed: ['operator'] },
  { axis: 'verification', from: 'disputed', to: 'verified', allowed: ['operator'] },
  { axis: 'verification', from: 'provisional', to: 'disputed', allowed: ['agent', 'operator'] },
  { axis: 'verification', from: 'verified', to: 'disputed', allowed: ['agent', 'operator'] },
  { axis: 'verification', from: 'verified', to: 'provisional', allowed: ['operator'] },
  { axis: 'verification', from: 'disputed', to: 'provisional', allowed: ['operator'] },
  // lifecycle — retract by the entry's own agent author (store also checks ownership) or the operator;
  // un-retract is operator-only.
  { axis: 'lifecycle', from: 'active', to: 'retracted', allowed: ['agent', 'operator'] },
  { axis: 'lifecycle', from: 'retracted', to: 'active', allowed: ['operator'] },
];

/** May `principal` move `axis` from→to? A same-state no-op is always allowed; tower may drive any listed
 *  transition (internal integrity ops). Anything unlisted is refused. */
export function canTransition(principal: MemoryPrincipalKind, axis: Axis, from: string, to: string): boolean {
  if (from === to) return true;
  const t = TRANSITIONS.find((x) => x.axis === axis && x.from === from && x.to === to);
  if (!t) return false;
  return principal === 'tower' || t.allowed.includes(principal);
}

/** Append an evidence item and bound the list per class (clampEvidence). The item is stored as given —
 *  an over-NOTE_MAX operator note is the store's to REJECT beforehand, never truncated here. NEVER touches
 *  verification — a `test` item does not promote a claim; only an operator verification transition can
 *  (the structural "no auto-promote" guarantee). */
export function applyEvidence(evidence: MemoryEvidence[], item: MemoryEvidence): MemoryEvidence[] {
  return clampEvidence([...evidence, item]);
}

/** Salvage a single stored entry (per-record, like readJsonArray): a bad entry drops alone. */
export function parseEntry(raw: unknown): MemoryEntry | undefined {
  const res = memoryEntrySchema.safeParse(raw);
  return res.success ? (res.data as MemoryEntry) : undefined;
}
