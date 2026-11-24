// SPEC-MEMORY — the per-project versioned memory store. One directory per project under ~/.ct/memory:
// `entries.json` (a v1 envelope `{version, seq, entries}`, atomic 0600) + `history.jsonl` (append-only
// provenance, 0600). A leaf modeled on RunwayStore (../runway/store.ts) for load discipline — a
// foreign/future-versioned envelope is backed up to .bak and NEVER written over — and on UsageStore
// (../runway/usage.ts) for the per-entity directory + torn-file skip. Entries are salvaged PER-RECORD
// through schema.ts's parseEntry, so one bad record drops alone (into entries.rejected-<ts>.json) and
// never takes the project's memory with it.
//
// Every mutation is ONE synchronous method — mutate in memory → append history → persist → onChange →
// audit — with no await anywhere on the path (the skills/selection.ts invariant), so two callers can
// never interleave between a CAS check and its write. Optimistic concurrency is per-entry `rev`
// (StaleRevError carries the current entry for a merge-and-resend), add idempotency is a per-principal
// requestId index rebuilt on load from each entry's INLINE rev-1 record (history.jsonl — retention-rotated
// to at most two generations, so never a full trail — is only a secondary source), and the authorization
// surface for status changes is schema.ts's static transition table — never a body-supplied field.
//
// A caller-supplied body is accepted WHOLE or refused: over BODY_MAX → FieldCapError, carrying reserved
// view syntax → ReservedSyntaxError (views.ts explains the forgery it prevents). Every mutation that fails
// to persist rolls its in-memory change back before rethrowing, so memory never diverges from disk.
//
// Imports nothing from terminal/loop/mission code (the integrator wires setIntegration at land time).

import { existsSync, readFileSync, appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths.js';
import { writeJsonAtomic } from '../store.js';
import { shortId, isSafeName } from '../ids.js';
import { audit } from '../audit.js';
import {
  parseEntry,
  canTransition,
  canonicalHash,
  applyEvidence,
  fitImportedBody,
  clampNote,
  BODY_MAX,
  NOTE_MAX,
  MAX_ENTRIES_PER_PROJECT,
} from './schema.js';
import { bodyHasReservedSyntax, RESERVED_SYNTAX_MESSAGE } from './views.js';
import type {
  MemoryEntry,
  MemoryKind,
  MemoryPrincipal,
  MemoryPrincipalKind,
  MemoryHistoryRecord,
  MemoryApplicability,
  MemoryEvidence,
  MemoryAddRequest,
  MemoryUpdateRequest,
  MemoryConsolidateRequest,
  MemorySearchQuery,
} from '../../shared/memory.js';

const ENVELOPE_VERSION = 1;
/** The inline provenance tail on an entry: rev 1 + the most recent INLINE_HISTORY_TAIL records (21
 *  total). The fuller trail lives in history.jsonl (rotated by retention to at most two generations), and
 *  the dedup-critical rev-1 record is always kept inline, so add-idempotency never depends on that log. */
export const INLINE_HISTORY_TAIL = 20;

/** One history.jsonl line: the entry's inline record plus which entry it belongs to. */
export interface MemoryHistoryLine extends MemoryHistoryRecord {
  entryId: string;
}

// ---- errors (routes map these to HTTP codes) --------------------------------------------------------

export class MemoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
/** The caller's expected rev is stale (→ 409). Carries the current entry so the caller can merge. */
export class StaleRevError extends MemoryStoreError {
  constructor(readonly current: MemoryEntry) {
    super(`stale rev for ${current.id}: current rev is ${current.rev}`);
  }
}
/** A retried add/consolidate reused a requestId with a DIFFERENT payload (→ 422). */
export class RequestConflictError extends MemoryStoreError {
  constructor(
    readonly requestId: string,
    readonly entryId: string,
  ) {
    super(`requestId ${requestId} was already used for ${entryId} with a different payload`);
  }
}
/** A cap was hit (→ 422). Bare: the project holds MAX_ENTRIES_PER_PROJECT active entries. The FieldCapError
 *  subclass covers the per-field size caps, so the HTTP mapper treats every cap alike. */
export class CapError extends MemoryStoreError {
  constructor(
    readonly max: number,
    detail?: string,
  ) {
    super(detail ?? `memory holds ${max} entries — retract or consolidate before adding more`);
  }
}
/** A caller-supplied field is over its cap (→ 422 via CapError): a body over BODY_MAX chars or an operator
 *  evidence note over NOTE_MAX chars. REFUSED rather than truncated — a silently clamped body would report
 *  success for text that was never stored (and dedup a retry to the truncated entry). */
export class FieldCapError extends CapError {
  constructor(readonly field: 'body' | 'note', max: number) {
    super(max, field === 'body' ? `body exceeds ${max} chars — split it into separate entries` : `operator note exceeds ${max} chars — shorten it`);
  }
}
/** A caller-supplied body carries reserved memory-view syntax (→ 422). Storing it would corrupt the next
 *  whole-file round trip — an embedded entry marker is re-parsed as a section boundary, which lets an agent
 *  write text INTO another (verified) entry under the saver's principal — or spoof the view's presentation
 *  (a `— verified` line makes an agent's own entry LOOK operator-verified). See views.ts bodyHasReservedSyntax. */
export class ReservedSyntaxError extends MemoryStoreError {
  constructor() {
    super(RESERVED_SYNTAX_MESSAGE);
  }
}
/** Unknown entry id, or an unsafe/unknown project id (→ 404). */
export class NotFoundError extends MemoryStoreError {
  constructor(
    readonly id: string,
    detail = 'entry not found',
  ) {
    super(`${detail}: ${id}`);
  }
}
/** A status change the caller's principal kind may not make (→ 422). */
export class TransitionError extends MemoryStoreError {
  constructor(
    readonly axis: 'verification' | 'lifecycle',
    readonly from: string,
    readonly to: string,
    readonly principal: MemoryPrincipalKind,
    detail?: string,
  ) {
    super(detail ?? `${principal} may not move ${axis} ${from}→${to}`);
  }
}
/** An agent tried to retract an entry it did not author (→ 422). */
export class OwnershipError extends MemoryStoreError {
  constructor(
    readonly entryId: string,
    readonly terminalId: string,
  ) {
    super(`terminal ${terminalId} is not the author of ${entryId}`);
  }
}
/** A non-operator tried to attach operator-attributed evidence (→ 422). The `operator` evidence type is
 *  the operator's own word; an agent supplying it would forge the one signal only the operator can give. */
export class EvidencePermissionError extends MemoryStoreError {
  constructor(readonly principal: MemoryPrincipalKind) {
    super(`${principal} may not attach operator evidence`);
  }
}
/** A consolidation source is disputed — resolve the dispute first (→ 409). */
export class DisputedSourceError extends MemoryStoreError {
  constructor(readonly sourceId: string) {
    super(`source ${sourceId} is disputed; resolve the dispute before consolidating it`);
  }
}
/** Consolidating would fork or loop the supersede graph (→ 422). */
export class CycleError extends MemoryStoreError {
  constructor(
    readonly sourceId: string,
    detail: string,
  ) {
    super(`source ${sourceId}: ${detail}`);
  }
}
/** The project's entries.json is foreign/future-versioned: it was backed up and this Tower refuses to
 *  write over it (→ 409). Reads serve empty; upgrade Tower or restore from the .bak. */
export class ForeignVersionError extends MemoryStoreError {
  constructor(
    readonly projectId: string,
    readonly file: string,
  ) {
    super(`memory for ${projectId} is foreign-versioned (${file}); refusing to write over it — see ${file}.bak`);
  }
}

// ---- helpers ---------------------------------------------------------------------------------------

interface ProjectState {
  seq: number;
  /** Insertion-ordered; persisted as the envelope's `entries` array in this order. */
  entries: Map<string, MemoryEntry>;
  /** `${principalKey}:${requestId}` → the entry that add/consolidate minted for it. */
  dedup: Map<string, { entryId: string; payloadHash: string }>;
  /** entries.json is foreign/future-versioned: serve empty, refuse mutations, never write over it. */
  frozen: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** The add-dedup principal key: agents are keyed per terminal, operator/tower are singletons. */
function principalKey(p: MemoryPrincipal): string {
  return p.kind === 'agent' ? p.terminalId : p.kind;
}

/** principalKey over an UNTRUSTED `by` (a history.jsonl line); undefined when malformed. */
function principalKeyOf(by: unknown): string | undefined {
  if (!by || typeof by !== 'object') return undefined;
  const kind = (by as { kind?: unknown }).kind;
  if (kind === 'operator' || kind === 'tower') return kind;
  if (kind === 'agent') {
    const t = (by as { terminalId?: unknown }).terminalId;
    return typeof t === 'string' && t.length > 0 ? t : undefined;
  }
  return undefined;
}

/** Keep rev 1 + the last INLINE_HISTORY_TAIL records. */
function boundHistory(h: MemoryHistoryRecord[]): MemoryHistoryRecord[] {
  if (h.length <= INLINE_HISTORY_TAIL + 1) return h;
  const [first] = h;
  if (!first) return h;
  return [first, ...h.slice(-INLINE_HISTORY_TAIL)];
}

/** Default 'run' for a loop-bound agent, 'project' otherwise; a requested 'run' with no loop to bind to
 *  falls back to 'project' (clamp, never reject). */
function resolveScope(p: MemoryPrincipal, requested: 'project' | 'run' | undefined): 'project' | 'run' {
  const loopBound = p.kind === 'agent' && !!p.loopId;
  if (requested === 'project') return 'project';
  return loopBound ? 'run' : 'project';
}

function applicabilityFor(p: MemoryPrincipal, scope: 'project' | 'run'): MemoryApplicability {
  if (scope === 'run' && p.kind === 'agent' && p.loopId) {
    return {
      scope: 'run',
      loopId: p.loopId,
      ...(p.missionId ? { missionId: p.missionId } : {}),
      ...(p.sortieId ? { sortieId: p.sortieId } : {}),
      integration: 'in-flight',
    };
  }
  return { scope: 'project' };
}

/** Normalize + bound a request's evidence list through the same path update uses. */
function normalizeEvidence(items: MemoryEvidence[]): MemoryEvidence[] {
  let out: MemoryEvidence[] = [];
  for (const item of items) out = applyEvidence(out, item);
  return out;
}

/** Refuse a caller-supplied body that is over BODY_MAX (FieldCapError — never truncated) or that carries
 *  reserved view syntax (ReservedSyntaxError), BEFORE anything is mutated. */
function assertBody(body: string): void {
  if (body.length > BODY_MAX) throw new FieldCapError('body', BODY_MAX);
  if (bodyHasReservedSyntax(body)) throw new ReservedSyntaxError();
}

/** Refuse operator-attributed evidence from anyone but the operator, and an operator note over NOTE_MAX
 *  (never truncated), BEFORE any of it is applied. */
function assertEvidence(principal: MemoryPrincipal, items: MemoryEvidence[] | undefined): void {
  for (const item of items ?? []) {
    if (item.type !== 'operator') continue;
    if (principal.kind !== 'operator') throw new EvidencePermissionError(principal.kind);
    if (item.note.length > NOTE_MAX) throw new FieldCapError('note', NOTE_MAX);
  }
}

/** What a mutation snapshots before it touches state, so a failed persist can put it all back. */
interface Snapshot {
  seq: number;
  /** id → the entry object as it was (undefined = did not exist, so rollback deletes it). */
  entries: Map<string, MemoryEntry | undefined>;
  /** dedup keys minted by this mutation (rollback drops them). */
  dedupKeys: string[];
}

// ---- store -----------------------------------------------------------------------------------------

export class MemoryStore {
  private readonly projects = new Map<string, ProjectState>();
  private hooks: { onChange?: (projectId: string) => void; ensureLoaded?: (projectId: string) => void } = {};
  /** Projects whose first-load `ensureLoaded` hook is currently running — so the migration it performs
   *  (which mutates this store → re-enters forProject) does not recurse into itself. */
  private readonly loadingHooked = new Set<string>();

  constructor(private readonly root: string = paths.memory) {}

  /** onChange fires once per successful mutation with the project id — the integrator forwards it as an
   *  SSE frame so open views refetch (the runway/skills setHooks precedent). ensureLoaded fires ONCE the
   *  first time a project is loaded, BEFORE any read/mutation observes its (possibly empty) state — the
   *  integrator wires it to legacy-markdown migration, so EVERY access path (the facade AND the direct
   *  entry routes) migrates a legacy project before it can be clobbered. */
  setHooks(hooks: { onChange?: (projectId: string) => void; ensureLoaded?: (projectId: string) => void }): void {
    this.hooks = hooks;
  }

  // ---- paths (projectId is charset-gated BEFORE any join) ----

  private dirFor(pid: string): string {
    return join(this.root, pid);
  }
  private entriesFile(pid: string): string {
    return join(this.dirFor(pid), 'entries.json');
  }
  private historyFile(pid: string): string {
    return join(this.dirFor(pid), 'history.jsonl');
  }

  /** Lazy per-project load, cached. Throws NotFoundError for an unsafe id (never joined into a path). On
   *  the FIRST load of a project it fires the ensureLoaded hook (legacy migration) exactly once — the
   *  state is cached BEFORE the hook so the hook's own store mutations re-enter forProject against the
   *  cached state (no recursion), and the loadingHooked guard stops a second hook mid-migration. */
  private forProject(pid: string): ProjectState {
    if (!isSafeName(pid)) throw new NotFoundError(pid, 'invalid projectId');
    let st = this.projects.get(pid);
    if (!st) {
      st = this.load(pid);
      this.projects.set(pid, st);
      if (this.hooks.ensureLoaded && !this.loadingHooked.has(pid)) {
        this.loadingHooked.add(pid);
        try {
          this.hooks.ensureLoaded(pid);
        } catch (err) {
          console.error(`[memory] ensureLoaded hook failed for ${pid}:`, err);
        } finally {
          this.loadingHooked.delete(pid);
        }
      }
    }
    return st;
  }

  /** forProject + the foreign-version refusal: a frozen project accepts no mutation. */
  private writable(pid: string): ProjectState {
    const st = this.forProject(pid);
    if (st.frozen) throw new ForeignVersionError(pid, this.entriesFile(pid));
    return st;
  }

  // ---- load / persist ----

  private backup(file: string): void {
    try {
      copyFileSync(file, `${file}.bak`);
    } catch (err) {
      console.error(`[memory] could not back up ${file}: ${(err as Error).message}`);
    }
  }

  private load(pid: string): ProjectState {
    const st: ProjectState = { seq: 0, entries: new Map(), dedup: new Map(), frozen: false };
    const file = this.entriesFile(pid);
    if (existsSync(file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        // Torn/corrupt — start empty (the next mutation persists over it); keep the bytes in .bak.
        console.error(`[memory] cannot read ${file}: ${(err as Error).message} — starting empty (saved to ${file}.bak)`);
        this.backup(file);
        return this.rebuildDedup(pid, st);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error(`[memory] ${file} is not an object — starting empty (saved to ${file}.bak)`);
        this.backup(file);
        return this.rebuildDedup(pid, st);
      }
      const obj = parsed as Record<string, unknown>;
      if (obj.version !== ENVELOPE_VERSION) {
        // A versioned envelope we don't understand (downgraded Tower, or FUTURE): back it up, serve
        // empty, and refuse every write — an older Tower must never clobber a newer format.
        this.backup(file);
        st.frozen = true;
        console.error(
          `[memory] ${file} is foreign-versioned (${String(obj.version)}) — serving empty and NOT persisting over it (saved to ${file}.bak)`,
        );
        return st;
      }
      // Salvage PER-RECORD: a bad entry drops alone; a duplicated id keeps its first occurrence.
      const raw = Array.isArray(obj.entries) ? obj.entries : [];
      const dropped: unknown[] = [];
      for (const el of raw) {
        const e = parseEntry(el);
        if (!e || st.entries.has(e.id)) {
          dropped.push(el);
          console.error(`[memory] skipping invalid record in ${file}`);
          continue;
        }
        st.entries.set(e.id, e);
      }
      if (dropped.length > 0) {
        const rejected = join(this.dirFor(pid), `entries.rejected-${Date.now()}.json`);
        try {
          writeJsonAtomic(rejected, dropped, 0o600);
          console.error(`[memory] ${dropped.length} record(s) dropped from ${file}; originals saved to ${rejected}`);
        } catch (err) {
          console.error(`[memory] could not save dropped records to ${rejected}: ${(err as Error).message}`);
        }
      }
      // The envelope seq is authoritative, but never let it lag an entry (a hand-edited file).
      let seq = typeof obj.seq === 'number' && Number.isFinite(obj.seq) ? Math.max(0, Math.floor(obj.seq)) : 0;
      for (const e of st.entries.values()) if (e.seq > seq) seq = e.seq;
      st.seq = seq;
    }
    return this.rebuildDedup(pid, st);
  }

  /** Rebuild the add-dedup index: from each loaded entry's inline rev-1 record (the durable source —
   *  boundHistory always keeps rev 1, so this alone makes dedup survive), then from whatever history.jsonl
   *  still holds (retention rotates it to at most two generations, current + .1, so it is a bounded recent
   *  window rather than a full trail — a secondary source that only matters for a hand-edited entry whose
   *  inline record lost its requestId). A record pointing at an entry that is no longer loaded is ignored,
   *  so a retried add after a rejected record simply creates a fresh entry. */
  private rebuildDedup(pid: string, st: ProjectState): ProjectState {
    for (const e of st.entries.values()) {
      for (const h of e.history) {
        if (h.requestId && h.payloadHash) st.dedup.set(`${principalKey(h.by)}:${h.requestId}`, { entryId: e.id, payloadHash: h.payloadHash });
      }
    }
    const hf = this.historyFile(pid);
    if (!existsSync(hf)) return st;
    let text: string;
    try {
      text = readFileSync(hf, 'utf8');
    } catch (err) {
      console.error(`[memory] cannot read ${hf}: ${(err as Error).message}`);
      return st;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a torn trailing line — skip it, never fail the load
      }
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as Partial<MemoryHistoryLine>;
      if (typeof r.entryId !== 'string' || typeof r.requestId !== 'string' || typeof r.payloadHash !== 'string') continue;
      if (!st.entries.has(r.entryId)) continue;
      const key = principalKeyOf(r.by);
      if (!key) continue;
      st.dedup.set(`${key}:${r.requestId}`, { entryId: r.entryId, payloadHash: r.payloadHash });
    }
    return st;
  }

  private appendHistory(pid: string, entryId: string, rec: MemoryHistoryRecord): void {
    mkdirSync(this.dirFor(pid), { recursive: true, mode: 0o700 });
    const line: MemoryHistoryLine = { entryId, ...rec };
    appendFileSync(this.historyFile(pid), JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  private persist(pid: string, st: ProjectState): void {
    if (st.frozen) throw new ForeignVersionError(pid, this.entriesFile(pid)); // writable() already refused; belt and braces
    mkdirSync(this.dirFor(pid), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.entriesFile(pid), { version: ENVELOPE_VERSION, seq: st.seq, entries: [...st.entries.values()] }, 0o600);
  }

  /** The tail of every mutation: persist → onChange → audit (ids/counts only, never bodies). */
  private commit(pid: string, st: ProjectState, op: string, detail: Record<string, unknown>): void {
    this.persist(pid, st);
    try {
      this.hooks.onChange?.(pid);
    } catch (err) {
      console.error('[memory] onChange hook failed:', err);
    }
    audit(`memory.${op}`, { projectId: pid, ...detail });
  }

  /** Start a rollback snapshot: seq now, no entries yet (record each with `remember` BEFORE replacing it). */
  private snapshot(st: ProjectState): Snapshot {
    return { seq: st.seq, entries: new Map(), dedupKeys: [] };
  }

  /** Remember an entry's pre-mutation object (or its absence) once — the first call wins, so a mutation
   *  that touches the same id twice still restores the ORIGINAL. */
  private remember(snap: Snapshot, st: ProjectState, id: string): void {
    if (!snap.entries.has(id)) snap.entries.set(id, st.entries.get(id));
  }

  /** Nothing durable landed (the persist threw): put every remembered entry back exactly as it was, drop
   *  any dedup key this mutation minted, and rewind seq — so memory matches disk and a retry is clean,
   *  instead of a later successful commit making the failed write durable. */
  private rollback(st: ProjectState, snap: Snapshot): void {
    for (const [id, original] of snap.entries) {
      if (original) st.entries.set(id, original);
      else st.entries.delete(id);
    }
    for (const key of snap.dedupKeys) st.dedup.delete(key);
    st.seq = snap.seq;
  }

  /** Only ACTIVE entries count toward the cap — retracting or consolidating frees capacity, exactly as
   *  CapError's message promises. */
  private assertCap(st: ProjectState): void {
    let live = 0;
    for (const e of st.entries.values()) if (e.lifecycle === 'active') live++;
    if (live >= MAX_ENTRIES_PER_PROJECT) throw new CapError(MAX_ENTRIES_PER_PROJECT);
  }

  // ---- reads ----

  list(pid: string): MemoryEntry[] {
    return [...this.forProject(pid).entries.values()].map(clone);
  }

  get(pid: string, id: string): MemoryEntry | undefined {
    const e = this.forProject(pid).entries.get(id);
    return e ? clone(e) : undefined;
  }

  /** The project's current sequence — the delta cursor a client passes back as `sinceSeq`. */
  seqOf(pid: string): number {
    return this.forProject(pid).seq;
  }

  search(pid: string, q: MemorySearchQuery): MemoryEntry[] {
    const needle = q.q?.trim().toLowerCase();
    const out: MemoryEntry[] = [];
    for (const e of this.forProject(pid).entries.values()) {
      if (q.kind && e.kind !== q.kind) continue;
      if (q.lifecycle && e.lifecycle !== q.lifecycle) continue;
      if (q.verification && e.verification !== q.verification) continue;
      if (q.sinceSeq !== undefined && !(e.seq > q.sinceSeq)) continue;
      if (needle && !e.body.toLowerCase().includes(needle)) continue;
      out.push(clone(e));
    }
    return out;
  }

  // ---- mutations (each ONE synchronous method) ----

  /**
   * Add an entry. Idempotent per (principal, requestId): the same payload returns the SAME entry with no
   * new history; a different payload is a RequestConflictError. Enforces the per-project cap over
   * active entries. A loop-bound agent's entry defaults to run scope (integration 'in-flight'). If the
   * persist fails, the in-memory mutation is rolled back so a same-requestId retry re-attempts cleanly
   * instead of dedup-returning an entry that never reached disk.
   */
  add(pid: string, principal: MemoryPrincipal, req: MemoryAddRequest): MemoryEntry {
    const st = this.writable(pid);
    assertBody(req.body); // before the dedup lookup, so a retry of a refused add is refused the same way
    assertEvidence(principal, req.evidence);
    const scope = resolveScope(principal, req.scope);
    const payloadHash = canonicalHash({ kind: req.kind, body: req.body, scope });
    const dedupKey = `${principalKey(principal)}:${req.requestId}`;
    const hit = st.dedup.get(dedupKey);
    if (hit) {
      const existing = st.entries.get(hit.entryId);
      if (existing) {
        if (hit.payloadHash === payloadHash) return clone(existing);
        throw new RequestConflictError(req.requestId, existing.id);
      }
    }
    this.assertCap(st);
    const now = nowIso();
    const by: MemoryPrincipal = { ...principal };
    const rec: MemoryHistoryRecord = { rev: 1, at: now, by, op: 'add', requestId: req.requestId, payloadHash };
    const snap = this.snapshot(st);
    const entry: MemoryEntry = {
      id: shortId(),
      rev: 1,
      seq: ++st.seq,
      kind: req.kind,
      body: req.body,
      author: { ...principal },
      createdAt: now,
      updatedAt: now,
      verification: 'provisional',
      lifecycle: 'active',
      evidence: normalizeEvidence(req.evidence ?? []),
      applicability: applicabilityFor(principal, scope),
      origin: principal.kind,
      history: [rec],
    };
    this.remember(snap, st, entry.id);
    st.entries.set(entry.id, entry);
    st.dedup.set(dedupKey, { entryId: entry.id, payloadHash });
    snap.dedupKeys.push(dedupKey);
    try {
      this.appendHistory(pid, entry.id, rec);
      this.commit(pid, st, 'add', { entryId: entry.id, kind: entry.kind, scope, by: principalKey(principal) });
    } catch (err) {
      this.rollback(st, snap);
      throw err;
    }
    return clone(entry);
  }

  /**
   * CAS-edit an entry (req.rev must equal the current rev, else StaleRevError with the current entry).
   * Applied in order: body, evidence (appended, never flips verification), verification (the static
   * transition table gates it by the CALLER's kind), lifecycle (an agent may retract only its own entry;
   * active↔superseded is reserved to consolidate). Always bumps rev/seq. `supersededBy` is NOT settable
   * here — it is an internal field owned by consolidate/unconsolidate; a body change by a non-operator
   * DOWNGRADES a 'verified' entry to 'provisional' (the verification was for the old content, so a
   * rewritten claim must not ride on it). A body change that actually changes the text also stamps the
   * history record's `prevBody` with the OLD text (a metadata-only update carries none), so an edit never
   * makes the prior claim unrecoverable. Restoring a retracted CONSOLIDATION SUMMARY to active is refused
   * while any of its superseded sources is still active (it would duplicate content) — a summary whose
   * sources are also retracted may still be restored.
   */
  update(pid: string, principal: MemoryPrincipal, req: MemoryUpdateRequest): MemoryEntry {
    const st = this.writable(pid);
    const cur = st.entries.get(req.id);
    if (!cur) throw new NotFoundError(req.id);
    if (req.rev !== cur.rev) throw new StaleRevError(clone(cur));
    if (req.body !== undefined) assertBody(req.body);
    assertEvidence(principal, req.evidence);

    const next: MemoryEntry = { ...cur, evidence: [...cur.evidence], history: [...cur.history] };
    const notes: string[] = [];
    const bodyChanged = req.body !== undefined && req.body !== cur.body;
    // Capture the OLD body before it is overwritten — a metadata-only update (body unchanged, or absent)
    // records no prevBody, so a same-body save never bloats history with a redundant copy.
    const prevBody = bodyChanged ? cur.body : undefined;
    if (req.body !== undefined) {
      next.body = req.body;
      if (bodyChanged) notes.push('body');
    }
    const evidenceAdded = (req.evidence?.length ?? 0) > 0;
    for (const item of req.evidence ?? []) next.evidence = applyEvidence(next.evidence, item);
    if (evidenceAdded) notes.push(`+${req.evidence!.length} evidence`);

    let verificationChanged = false;
    if (req.verification !== undefined && req.verification !== cur.verification) {
      if (!canTransition(principal.kind, 'verification', cur.verification, req.verification)) {
        throw new TransitionError('verification', cur.verification, req.verification, principal.kind);
      }
      next.verification = req.verification;
      verificationChanged = true;
      notes.push(`verification ${cur.verification}→${req.verification}`);
    } else if (bodyChanged && cur.verification === 'verified' && principal.kind !== 'operator') {
      // A non-operator rewrote the body of an operator-verified entry: the 'verified' badge was for the
      // OLD content and must not carry to the new text. Downgrade to provisional (an operator re-verifies).
      next.verification = 'provisional';
      verificationChanged = true;
      notes.push('verification verified→provisional (body changed by non-operator)');
    }

    let lifecycleChanged = false;
    if (req.lifecycle !== undefined && req.lifecycle !== cur.lifecycle) {
      if (req.lifecycle === 'retracted' && principal.kind === 'agent') {
        const owns = cur.author.kind === 'agent' && cur.author.terminalId === principal.terminalId;
        if (!owns) throw new OwnershipError(cur.id, principal.terminalId);
      }
      if (!canTransition(principal.kind, 'lifecycle', cur.lifecycle, req.lifecycle)) {
        throw new TransitionError('lifecycle', cur.lifecycle, req.lifecycle, principal.kind);
      }
      // Restoring a consolidation SUMMARY (non-empty `supersedes`) while any of its sources is currently
      // active would duplicate content — the summary and its sources both live in views/briefings at once.
      // Refuse; a summary whose sources are ALSO retracted may still be restored.
      if (cur.lifecycle === 'retracted' && req.lifecycle === 'active' && (cur.supersedes?.length ?? 0) > 0) {
        const activeSource = cur.supersedes!.find((id) => st.entries.get(id)?.lifecycle === 'active');
        if (activeSource) {
          throw new TransitionError(
            'lifecycle',
            cur.lifecycle,
            req.lifecycle,
            principal.kind,
            'cannot restore a consolidation summary while its sources are active; re-consolidate or retract them first',
          );
        }
      }
      next.lifecycle = req.lifecycle;
      lifecycleChanged = true;
      notes.push(`lifecycle ${cur.lifecycle}→${req.lifecycle}`);
    }

    const op: MemoryHistoryRecord['op'] =
      lifecycleChanged && next.lifecycle === 'retracted'
        ? 'retract'
        : verificationChanged && next.verification === 'disputed'
          ? 'dispute'
          : evidenceAdded && !bodyChanged && !verificationChanged && !lifecycleChanged
            ? 'evidence'
            : 'update';

    const now = nowIso();
    const snap = this.snapshot(st);
    next.rev = cur.rev + 1;
    next.seq = ++st.seq;
    next.updatedAt = now;
    const rec: MemoryHistoryRecord = {
      rev: next.rev,
      at: now,
      by: { ...principal },
      op,
      ...(notes.length ? { note: clampNote(notes.join('; ')) } : {}),
      ...(prevBody !== undefined ? { prevBody } : {}),
    };
    next.history = boundHistory([...cur.history, rec]);
    this.remember(snap, st, next.id);
    st.entries.set(next.id, next);
    try {
      this.appendHistory(pid, next.id, rec);
      this.commit(pid, st, op, { entryId: next.id, rev: next.rev, by: principalKey(principal) });
    } catch (err) {
      this.rollback(st, snap);
      throw err;
    }
    return clone(next);
  }

  /**
   * Fold sources into one summary entry. All-or-nothing: every source must exist at its given rev (CAS),
   * none may be disputed, and none may already sit in a supersede relation (already superseded, or
   * superseding another source in the same set) — that would fork or loop the supersede graph. Idempotent
   * per (principal, requestId) like add. Each source becomes lifecycle 'superseded' → summary.id.
   *
   * AUTHORIZATION: an agent may only consolidate entries it AUTHORED and that are not operator-'verified'
   * (superseding hides a source from active views, so an agent must not be able to bury another author's
   * work or an operator-blessed claim). operator/tower may consolidate anything not disputed.
   */
  consolidate(pid: string, principal: MemoryPrincipal, req: MemoryConsolidateRequest): MemoryEntry {
    const st = this.writable(pid);
    assertBody(req.body);
    const payloadHash = canonicalHash({ kind: req.kind, body: req.body, sources: req.sources });
    const dedupKey = `${principalKey(principal)}:${req.requestId}`;
    const hit = st.dedup.get(dedupKey);
    if (hit) {
      const existing = st.entries.get(hit.entryId);
      if (existing) {
        if (hit.payloadHash === payloadHash) return clone(existing);
        throw new RequestConflictError(req.requestId, existing.id);
      }
    }
    if (req.sources.length === 0) throw new CycleError('(none)', 'a consolidation needs at least one source');

    // Validate EVERYTHING before touching anything.
    const wanted = new Map<string, number>();
    for (const s of req.sources) if (!wanted.has(s.id)) wanted.set(s.id, s.rev);
    const sources: MemoryEntry[] = [];
    for (const [id, rev] of wanted) {
      const e = st.entries.get(id);
      if (!e) throw new NotFoundError(id);
      if (e.rev !== rev) throw new StaleRevError(clone(e));
      if (principal.kind === 'agent') {
        const owns = e.author.kind === 'agent' && e.author.terminalId === principal.terminalId;
        if (!owns || e.verification === 'verified') throw new OwnershipError(id, principal.terminalId);
      }
      // Only an ACTIVE entry can be folded: a retracted source would otherwise come back 'active' through
      // unconsolidate — an un-retract that is reserved to the operator.
      if (e.lifecycle !== 'active') throw new CycleError(id, `source is not active (${e.lifecycle})`);
      if (e.verification === 'disputed') throw new DisputedSourceError(id);
      // An active entry still carrying a supersede link is a dangling edge in the graph — never fold it.
      if (e.supersededBy) throw new CycleError(id, `already superseded by ${e.supersededBy}`);
      for (const other of e.supersedes ?? []) {
        if (wanted.has(other)) throw new CycleError(id, `already supersedes ${other}, which is also a source`);
      }
      sources.push(e);
    }

    const now = nowIso();
    const by: MemoryPrincipal = { ...principal };
    const summaryId = shortId();
    if (wanted.has(summaryId)) throw new CycleError(summaryId, 'a source may not be the summary'); // unreachable with a fresh id
    const sourceIds = sources.map((s) => s.id);
    const rec: MemoryHistoryRecord = { rev: 1, at: now, by, op: 'add', requestId: req.requestId, payloadHash, note: clampNote(`consolidates ${sourceIds.join(',')}`) };
    const snap = this.snapshot(st);
    const summary: MemoryEntry = {
      id: summaryId,
      rev: 1,
      seq: ++st.seq,
      kind: req.kind,
      body: req.body,
      author: { ...principal },
      createdAt: now,
      updatedAt: now,
      verification: 'provisional',
      lifecycle: 'active',
      supersedes: sourceIds,
      sources: sources.map((s) => ({ id: s.id, rev: s.rev })),
      evidence: [],
      applicability: { scope: 'project' },
      origin: principal.kind,
      history: [rec],
    };
    this.remember(snap, st, summary.id);
    st.entries.set(summary.id, summary);
    st.dedup.set(dedupKey, { entryId: summary.id, payloadHash });
    snap.dedupKeys.push(dedupKey);
    try {
      this.appendHistory(pid, summary.id, rec);
      for (const s of sources) {
        const sRec: MemoryHistoryRecord = { rev: s.rev + 1, at: now, by, op: 'supersede', note: `superseded by ${summary.id}` };
        this.remember(snap, st, s.id);
        st.entries.set(s.id, {
          ...s,
          lifecycle: 'superseded',
          supersededBy: summary.id,
          rev: s.rev + 1,
          seq: ++st.seq,
          updatedAt: now,
          history: boundHistory([...s.history, sRec]),
        });
        this.appendHistory(pid, s.id, sRec);
      }
      this.commit(pid, st, 'consolidate', { summaryId: summary.id, sourceIds, by: principalKey(principal) });
    } catch (err) {
      this.rollback(st, snap);
      throw err;
    }
    return clone(summary);
  }

  /**
   * Undo a consolidation: CAS the summary, retract it, and restore each source it superseded to 'active'
   * with supersededBy cleared. A source that has since been superseded by something else is left alone
   * (never clobbered). A summary that was itself consolidated must have its successor undone first.
   *
   * AUTHORIZATION: an agent may only undo a summary it AUTHORED (else it could revive another author's
   * superseded entries or undo the operator's consolidation); operator/tower may undo any summary.
   */
  unconsolidate(pid: string, principal: MemoryPrincipal, summaryId: string, rev: number): void {
    const st = this.writable(pid);
    const s = st.entries.get(summaryId);
    if (!s) throw new NotFoundError(summaryId);
    if (s.rev !== rev) throw new StaleRevError(clone(s));
    if (principal.kind === 'agent') {
      const owns = s.author.kind === 'agent' && s.author.terminalId === principal.terminalId;
      if (!owns) throw new OwnershipError(summaryId, principal.terminalId);
    }
    const sourceIds = s.supersedes ?? s.sources?.map((x) => x.id) ?? [];
    if (sourceIds.length === 0) {
      throw new TransitionError('lifecycle', s.lifecycle, 'retracted', principal.kind, `${summaryId} is not a consolidation summary`);
    }
    if (s.lifecycle === 'superseded') {
      throw new TransitionError('lifecycle', 'superseded', 'retracted', principal.kind, `${summaryId} was itself consolidated into ${s.supersededBy ?? '?'}; unconsolidate that first`);
    }

    const now = nowIso();
    const by: MemoryPrincipal = { ...principal };
    const snap = this.snapshot(st);
    const sRec: MemoryHistoryRecord = { rev: s.rev + 1, at: now, by, op: 'retract', note: 'unconsolidated' };
    this.remember(snap, st, s.id);
    st.entries.set(s.id, { ...s, lifecycle: 'retracted', rev: s.rev + 1, seq: ++st.seq, updatedAt: now, history: boundHistory([...s.history, sRec]) });
    const restored: string[] = [];
    try {
      this.appendHistory(pid, s.id, sRec);
      for (const id of sourceIds) {
        const src = st.entries.get(id);
        if (!src) {
          console.error(`[memory] unconsolidate ${summaryId}: source ${id} is missing`);
          continue;
        }
        if (src.supersededBy !== summaryId) continue; // re-superseded elsewhere or already restored
        const { supersededBy: _drop, ...rest } = src;
        const rec: MemoryHistoryRecord = { rev: src.rev + 1, at: now, by, op: 'unsupersede', note: `unconsolidated from ${summaryId}` };
        this.remember(snap, st, id);
        st.entries.set(id, { ...rest, lifecycle: 'active', rev: src.rev + 1, seq: ++st.seq, updatedAt: now, history: boundHistory([...src.history, rec]) });
        this.appendHistory(pid, id, rec);
        restored.push(id);
      }
      this.commit(pid, st, 'unconsolidate', { summaryId, restored: restored.length, by: principalKey(principal) });
    } catch (err) {
      this.rollback(st, snap);
      throw err;
    }
  }

  /**
   * Mark every run-scoped entry of `loopId` as landed/abandoned (a Tower-internal integration op — the
   * loop's land/abandon boundary calls it). Stamps landedAt on 'landed'. NEVER touches verification: a
   * landed discovery is still the operator's to verify. No-op (no write, no hook) when nothing matches or
   * everything already carries `state`; a frozen project holds no entries in memory and so no-ops too.
   */
  setIntegration(pid: string, loopId: string, state: 'landed' | 'abandoned'): void {
    const st = this.forProject(pid);
    const now = nowIso();
    const by: MemoryPrincipal = { kind: 'tower', reason: `loop ${loopId} ${state}` };
    const snap = this.snapshot(st);
    const touched: string[] = [];
    try {
      for (const e of st.entries.values()) {
        const a = e.applicability;
        if (a.scope !== 'run' || a.loopId !== loopId || a.integration === state) continue;
        const { landedAt: _drop, ...restA } = a;
        const nextA: MemoryApplicability = { ...restA, integration: state, ...(state === 'landed' ? { landedAt: now } : {}) };
        const rec: MemoryHistoryRecord = { rev: e.rev + 1, at: now, by, op: 'integration', note: `${a.integration}→${state}` };
        this.remember(snap, st, e.id);
        st.entries.set(e.id, { ...e, applicability: nextA, rev: e.rev + 1, seq: ++st.seq, updatedAt: now, history: boundHistory([...e.history, rec]) });
        this.appendHistory(pid, e.id, rec);
        touched.push(e.id);
      }
      if (touched.length === 0) return;
      this.commit(pid, st, 'integration', { loopId, state, count: touched.length });
    } catch (err) {
      this.rollback(st, snap);
      throw err;
    }
  }

  /**
   * Tower-managed keyed upsert (at most one entry per `key`, e.g. 'ct:e2e-test-kit'): none → add it with
   * the key; same kind+body → returned as-is (no rev bump, no write); changed → body/kind updated with a
   * rev/seq bump. Lifecycle is left alone, so an operator's retraction of a keyed note is not undone.
   */
  upsertKeyed(pid: string, key: string, input: { kind: MemoryKind; body: string; author: MemoryPrincipal }): MemoryEntry {
    const st = this.writable(pid);
    assertBody(input.body); // the Tower's own block, or a legacy keyed block migrate.ts has already made importable
    const { body } = input;
    let existing: MemoryEntry | undefined;
    for (const e of st.entries.values()) {
      if (e.key === key) {
        existing = e;
        break;
      }
    }
    const now = nowIso();
    const by: MemoryPrincipal = { ...input.author };
    if (!existing) {
      this.assertCap(st);
      const rec: MemoryHistoryRecord = { rev: 1, at: now, by, op: 'add', note: clampNote(`key ${key}`) };
      const snap = this.snapshot(st);
      const entry: MemoryEntry = {
        id: shortId(),
        rev: 1,
        seq: ++st.seq,
        kind: input.kind,
        body,
        author: { ...input.author },
        createdAt: now,
        updatedAt: now,
        verification: 'provisional',
        lifecycle: 'active',
        evidence: [],
        applicability: { scope: 'project' },
        key,
        origin: input.author.kind,
        history: [rec],
      };
      this.remember(snap, st, entry.id);
      st.entries.set(entry.id, entry);
      try {
        this.appendHistory(pid, entry.id, rec);
        this.commit(pid, st, 'upsert', { entryId: entry.id, key, created: true });
      } catch (err) {
        this.rollback(st, snap);
        throw err;
      }
      return clone(entry);
    }
    if (existing.body === body && existing.kind === input.kind) return clone(existing);
    const rec: MemoryHistoryRecord = { rev: existing.rev + 1, at: now, by, op: 'update', note: clampNote(`key ${key}`) };
    const snap = this.snapshot(st);
    const next: MemoryEntry = { ...existing, kind: input.kind, body, rev: existing.rev + 1, seq: ++st.seq, updatedAt: now, history: boundHistory([...existing.history, rec]) };
    this.remember(snap, st, next.id);
    st.entries.set(next.id, next);
    try {
      this.appendHistory(pid, next.id, rec);
      this.commit(pid, st, 'upsert', { entryId: next.id, key, created: false });
    } catch (err) {
      this.rollback(st, snap);
      throw err;
    }
    return clone(next);
  }

  /**
   * Tower-internal seed for a legacy/external IMPORT: a project-scoped entry with `origin` +
   * `importedFrom` (bytes provenance), a tower author, and a DETERMINISTIC dedup key (origin + file +
   * content sha), so re-importing identical bytes — after a failed rename, or a second boot — is a
   * no-op that returns the existing entry rather than duplicating. Never invents authorship or approval:
   * verification stays 'provisional'. Keyed content (the e2e test-kit block) goes through upsertKeyed
   * instead; this is for the free-form legacy notes.
   *
   * Unlike the caller-facing writes this KEEPS rather than refuses: legacy text is imported as it stands,
   * through schema.ts fitImportedBody — reserved view syntax neutralized (the note could not have known the
   * token was reserved, and refusing it would lose the note) and an over-BODY_MAX body cut on line
   * boundaries so the cut itself can never re-create a token (the original file is archived beside the
   * store, so nothing is lost for good).
   */
  seedImport(pid: string, input: { kind: MemoryKind; body: string; origin: 'imported' | 'external'; importedFrom: { file: string; sha256: string; mtime: number } }): MemoryEntry {
    const st = this.writable(pid);
    const body = fitImportedBody(input.body);
    const requestId = `${input.origin}:${input.importedFrom.file}:${input.importedFrom.sha256}`;
    const payloadHash = canonicalHash({ kind: input.kind, body, importedFrom: input.importedFrom });
    const dedupKey = `tower:${requestId}`;
    const hit = st.dedup.get(dedupKey);
    if (hit) {
      const existing = st.entries.get(hit.entryId);
      if (existing) return clone(existing);
    }
    this.assertCap(st);
    const now = nowIso();
    const by: MemoryPrincipal = { kind: 'tower', reason: `${input.origin}-import` };
    const rec: MemoryHistoryRecord = { rev: 1, at: now, by, op: 'import', requestId, payloadHash, note: clampNote(`imported from ${input.importedFrom.file}`) };
    const snap = this.snapshot(st);
    const entry: MemoryEntry = {
      id: shortId(),
      rev: 1,
      seq: ++st.seq,
      kind: input.kind,
      body,
      author: { ...by },
      createdAt: now,
      updatedAt: now,
      verification: 'provisional',
      lifecycle: 'active',
      evidence: [],
      applicability: { scope: 'project' },
      origin: input.origin,
      importedFrom: input.importedFrom,
      history: [rec],
    };
    this.remember(snap, st, entry.id);
    st.entries.set(entry.id, entry);
    st.dedup.set(dedupKey, { entryId: entry.id, payloadHash });
    snap.dedupKeys.push(dedupKey);
    try {
      this.appendHistory(pid, entry.id, rec);
      this.commit(pid, st, 'import', { entryId: entry.id, file: input.importedFrom.file, origin: input.origin });
    } catch (err) {
      this.rollback(st, snap);
      throw err;
    }
    return clone(entry);
  }

  /** True once the project has a persisted entries.json (used by the facade to decide whether a
   *  first-load legacy import is due). A frozen (foreign-version) project counts as present. */
  hasProject(pid: string): boolean {
    if (!isSafeName(pid)) return false;
    return existsSync(this.entriesFile(pid));
  }
}
