// Proposal store (SPEC-ASSISTANT-CONTROL §2): the human confirm gate's ledger. The brain's
// propose_action lands here as a Tower-validated, enriched, risk-rated record; NOTHING mutates
// until confirm() runs — normally the operator's click, or the Tower itself when the account
// opted into autonomous mode (routes.ts calls confirm with { auto: true }; the record carries
// autoConfirmed so no auto-run ever reads as a human decision). Either way the injected executor
// replays the action through the Tower's own public route (⟦DP-J3⟧). In-memory Map + atomic
// 0600 JSON mirror under
// ~/.ct/assistant/proposals.json (the house writer, not the 0644 assistant-accounts one),
// last 200 records retained, 30-minute TTL lazily applied on read and confirm.
//
// confirm() is the security-critical path and holds two invariants (§2):
//   - ONE-SHOT: pending → 'executing' is a SYNCHRONOUS compare-and-set completed before the
//     first await, so a concurrent double-confirm gets a 409 instead of a double execution;
//     an executor throw resolves the claim to 'failed' — 'executing' is never terminal.
//   - NO DRIFT: every denormalized value the card showed at propose time is re-derived from
//     live state first; any difference aborts "changed since proposed — re-review" WITHOUT
//     executing, so the operator never authorizes yesterday's card against today's Tower.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { paths } from '../paths.js';
import { writeJsonAtomic } from '../store.js';
import { shortId, isSafeName } from '../ids.js';
import {
  validateAction,
  enrich,
  riskOf,
  type ActionLookups,
  type ProposalExecutor,
} from './actions.js';
import type { AssistantStore } from './store.js';
import type { AssistantAction, AssistantProposal } from '../../shared/types.js';

const TTL_MS = 30 * 60_000;
const RETAIN = 200;
const PENDING_CAP = 5;
const RESULT_MAX = 2000;

/** A refused gate transition (not-pending, expired, drift): the routes map this to 409.
 *  Plain Errors out of create()/an Edit override are caller errors and map to 400. */
export class ProposalGuardError extends Error {}

export interface ProposalStoreDeps {
  /** Runs a confirmed action through the Tower's own route (makeProposalExecutor). */
  executor: ProposalExecutor;
  /** Transcript store: a decided proposal's outcome lands as a `system` turn (⟦DP-J6⟧) so the
   *  stateless brain sees it replayed as context on its next turn. */
  store: AssistantStore;
  /** Live-state reads for enrichment + the drift baseline. */
  lookups: ActionLookups;
}

/** What persists per proposal: the public record plus the denormalized live values its card
 *  showed at propose time — the private baseline confirm() compares for drift (§2). */
interface ProposalRecord {
  proposal: AssistantProposal;
  denorm: Record<string, string | number | null>;
}

// Per-record load validation (accounts-file rationale: one mangled record must not drop the
// rest). Actions are re-validated through the catalog zod, not trusted from disk.
const PersistedSchema = z.object({
  proposal: z.object({
    id: z.string(),
    conversationId: z.string(),
    action: z.unknown(),
    finalAction: z.unknown().optional(),
    summary: z.string(),
    risk: z.enum(['low', 'medium', 'high']),
    status: z.enum(['pending', 'executing', 'rejected', 'expired', 'executed', 'failed']),
    createdAt: z.string(),
    decidedAt: z.string().optional(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    autoConfirmed: z.boolean().optional(),
  }),
  denorm: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
});

/** Cap a route result for storage/transcripts — a big list response must not bloat either. */
function trimResult(body: unknown): unknown {
  let s: string | undefined;
  try {
    s = JSON.stringify(body);
  } catch {
    return { note: 'unserializable result' };
  }
  if (s === undefined || s.length <= RESULT_MAX) return body;
  return { truncated: true, preview: `${s.slice(0, RESULT_MAX)}…` };
}

/** The route's own error string when it gave one, else just the status. */
function routeErrorText(res: { status: number; body: unknown }): string {
  const err =
    typeof res.body === 'object' && res.body !== null && 'error' in res.body
      ? (res.body as { error?: unknown }).error
      : undefined;
  return typeof err === 'string' && err ? `HTTP ${res.status}: ${err}` : `HTTP ${res.status}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export class ProposalStore {
  private readonly file = paths.assistantProposals;
  private records = new Map<string, ProposalRecord>();
  private hooks: { onProposal?: (p: AssistantProposal) => void } = {};

  constructor(private readonly deps: ProposalStoreDeps) {
    mkdirSync(dirname(this.file), { recursive: true });
    this.load();
  }

  /** onProposal fires on create — the integrator forwards it as a `proposal` SSE frame into
   *  the open turn stream (§4). */
  setHooks(hooks: { onProposal?: (p: AssistantProposal) => void }): void {
    this.hooks = hooks;
  }

  /**
   * Validate + enrich + record a proposal, status 'pending'. Every throw here is a plain
   * Error the proposals route maps to 400 — model-visible and self-correctable (a bad arg
   * names the field; an unknown id says to list first; the cap says to stop proposing).
   */
  create(conversationId: string, kind: string, args: unknown): AssistantProposal {
    // The id flows into a transcript filename on confirm; never trust the caller with it.
    if (!isSafeName(conversationId)) throw new Error('invalid conversation id');
    const pending = this.listFor(conversationId).filter((p) => p.status === 'pending').length;
    if (pending >= PENDING_CAP) {
      throw new Error(
        `${PENDING_CAP} proposals are already pending for this conversation — wait for the operator to confirm or dismiss one before proposing more`,
      );
    }
    const action = validateAction({ ...(typeof args === 'object' && args !== null ? args : {}), kind });
    const { summary, denorm } = enrich(action, this.deps.lookups);
    const proposal: AssistantProposal = {
      id: shortId(),
      conversationId,
      action,
      summary,
      risk: riskOf(action),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.records.set(proposal.id, { proposal, denorm });
    this.persist();
    this.fireOnProposal(proposal);
    return proposal;
  }

  get(id: string): AssistantProposal | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    if (this.expireIfStale(rec)) this.persist();
    return rec.proposal;
  }

  listFor(conversationId: string): AssistantProposal[] {
    let changed = false;
    const out: AssistantProposal[] = [];
    for (const rec of this.records.values()) {
      if (rec.proposal.conversationId !== conversationId) continue;
      if (this.expireIfStale(rec)) changed = true;
      out.push(rec.proposal);
    }
    if (changed) this.persist();
    return out;
  }

  /**
   * The operator's Confirm click — and, with opts.auto, the Tower's own autonomous-mode
   * confirm (same guards, same executor; the ONLY differences are the autoConfirmed marker
   * and a hook re-fire so the dock's already-rendered pending card updates to the outcome —
   * a human confirm learns the outcome from its HTTP response and needs neither).
   * Guards run in a fixed order, ALL synchronous, then the one-shot claim is taken before
   * the first await (§2):
   *   pending? → override valid? → live state unchanged? → claim 'executing' → execute.
   * Guard refusals throw ProposalGuardError (route → 409); a bad Edit override throws a plain
   * Error (route → 400) and leaves the proposal pending. A route failure is NOT a throw — the
   * proposal resolves 'failed' and is returned (route → 200 with the error on the record).
   */
  async confirm(id: string, override?: unknown, opts?: { auto?: boolean }): Promise<AssistantProposal> {
    const rec = this.records.get(id);
    if (!rec) throw new ProposalGuardError('unknown proposal');
    if (this.expireIfStale(rec)) {
      this.persist();
      throw new ProposalGuardError('proposal expired (30 min old) — re-propose and re-review');
    }
    const p = rec.proposal;
    if (p.status !== 'pending') throw new ProposalGuardError(`proposal is ${p.status}, not pending`);
    // Marked before any outcome so even a drift-abort record says truthfully that no human
    // reviewed it; persisted by whichever persist() the paths below reach first.
    if (opts?.auto) p.autoConfirmed = true;

    // Edit override: same kind, re-run through the same zod + enrichment id checks as any
    // proposal — the edited args earn no trust for having passed through the operator's form.
    let finalAction: AssistantAction | undefined;
    if (override !== undefined) {
      const cand = validateAction(override);
      if (cand.kind !== p.action.kind) {
        throw new Error(`edited action must keep kind '${p.action.kind}' (got '${cand.kind}')`);
      }
      enrich(cand, this.deps.lookups);
      finalAction = cand;
    }

    // Drift guard applies ONLY to a non-edited confirm: what the operator reviewed on the card
    // must still be true. An Edit override is fresh, operator-authored intent with no propose-time
    // card to drift from — its referenced entities were already existence-checked by enrich(cand)
    // above, so re-checking the ORIGINAL action here would wrongly burn a valid edit that pointed
    // away from an entity that has since vanished.
    if (override === undefined) {
      let liveDenorm: Record<string, string | number | null>;
      try {
        liveDenorm = enrich(p.action, this.deps.lookups).denorm;
      } catch (err) {
        this.failWithoutExecuting(p, `changed since proposed — re-review (${(err as Error).message})`);
        if (opts?.auto) this.fireOnProposal(p);
        throw new ProposalGuardError(p.error ?? 'changed since proposed — re-review');
      }
      if (JSON.stringify(liveDenorm) !== JSON.stringify(rec.denorm)) {
        this.failWithoutExecuting(p, 'changed since proposed — re-review');
        if (opts?.auto) this.fireOnProposal(p);
        throw new ProposalGuardError(p.error ?? 'changed since proposed — re-review');
      }
    }

    // The one-shot claim: same tick as the pending check above — no await has happened since,
    // so of two racing confirms exactly one reaches this line with status still 'pending'.
    p.status = 'executing';
    if (finalAction) p.finalAction = finalAction;
    this.persist();

    const toRun = finalAction ?? p.action;
    try {
      const res = await this.deps.executor(toRun);
      if (res.ok) {
        p.status = 'executed';
        p.result = trimResult(res.body);
      } else {
        p.status = 'failed';
        p.error = routeErrorText(res);
      }
    } catch (err) {
      // An executor blowup must still resolve the claim — 'executing' is never left standing.
      p.status = 'failed';
      p.error = (err as Error).message;
    }
    p.decidedAt = new Date().toISOString();
    this.persist();
    this.appendOutcomeTurn(p, toRun);
    // An auto confirm has no operator click waiting on the HTTP response — push the decided
    // record back into the live turn stream so the dock's pending card flips to the outcome.
    if (opts?.auto) this.fireOnProposal(p);
    return p;
  }

  /** Dismiss = reject: only a pending proposal can be rejected; everything else is a 409. */
  reject(id: string): AssistantProposal {
    const rec = this.records.get(id);
    if (!rec) throw new ProposalGuardError('unknown proposal');
    if (this.expireIfStale(rec)) {
      this.persist();
      throw new ProposalGuardError('proposal already expired');
    }
    const p = rec.proposal;
    if (p.status !== 'pending') throw new ProposalGuardError(`proposal is ${p.status}, not pending`);
    p.status = 'rejected';
    p.decidedAt = new Date().toISOString();
    this.persist();
    return p;
  }

  // ---- internals ----

  /** A hook throw must never un-decide a proposal or fail its route — log and move on. */
  private fireOnProposal(p: AssistantProposal): void {
    try {
      this.hooks.onProposal?.(p);
    } catch (err) {
      console.error('[assistant] onProposal hook failed:', err);
    }
  }

  /** Lazy TTL: flip a stale pending record to 'expired'. Returns whether anything changed.
   *  An unparseable createdAt (hand-mangled file) counts as stale — fail safe, not open. */
  private expireIfStale(rec: ProposalRecord): boolean {
    const p = rec.proposal;
    if (p.status !== 'pending') return false;
    const created = Date.parse(p.createdAt);
    if (Number.isFinite(created) && Date.now() - created <= TTL_MS) return false;
    p.status = 'expired';
    p.decidedAt = new Date().toISOString();
    return true;
  }

  /** Drift abort: terminal 'failed' WITHOUT running the executor. */
  private failWithoutExecuting(p: AssistantProposal, error: string): void {
    p.status = 'failed';
    p.error = error;
    p.decidedAt = new Date().toISOString();
    this.persist();
  }

  /** ⟦DP-J6⟧ result → model: append the outcome as a `system` turn; the stateless brain
   *  replays it next turn. A transcript write failure must not un-decide the proposal. */
  private appendOutcomeTurn(p: AssistantProposal, ran: AssistantAction): void {
    const args = clip(JSON.stringify(ran), 600);
    const text =
      p.status === 'executed'
        ? `Action ${ran.kind} executed: ${args} → ok ${clip(JSON.stringify(p.result) ?? 'null', 400)}`
        : `Action ${ran.kind} failed: ${args} → ${p.error ?? 'unknown error'}`;
    try {
      this.deps.store.appendTurn(p.conversationId, { role: 'system', text, ts: new Date().toISOString() });
    } catch (err) {
      console.error('[assistant] failed to record proposal outcome in transcript:', err);
    }
  }

  private persist(): void {
    // Retain the newest RETAIN records, evicting oldest-first (Map order is insertion order) — but
    // NEVER a still-live proposal: a burst in one conversation must not silently drop another
    // conversation's confirmable pending/executing card (which would 409 as 'unknown proposal' on
    // its Confirm click). Only terminal records count toward the cap.
    let terminal = 0;
    for (const r of this.records.values()) {
      if (r.proposal.status !== 'pending' && r.proposal.status !== 'executing') terminal++;
    }
    for (const [id, r] of this.records) {
      if (terminal <= RETAIN) break;
      if (r.proposal.status === 'pending' || r.proposal.status === 'executing') continue;
      this.records.delete(id);
      terminal--;
    }
    writeJsonAtomic(this.file, [...this.records.values()], 0o600);
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      console.error(`[assistant] ${this.file} unreadable (${(err as Error).message}); starting with no proposals`);
      return;
    }
    if (!Array.isArray(parsed)) {
      console.error(`[assistant] ${this.file} is not a JSON array; starting with no proposals`);
      return;
    }
    for (const el of parsed) {
      const res = PersistedSchema.safeParse(el);
      if (!res.success) {
        console.error(`[assistant] skipping invalid proposal record: ${res.error.message}`);
        continue;
      }
      let action: AssistantAction;
      let finalAction: AssistantAction | undefined;
      try {
        action = validateAction(res.data.proposal.action);
        finalAction =
          res.data.proposal.finalAction === undefined
            ? undefined
            : validateAction(res.data.proposal.finalAction);
      } catch (err) {
        console.error(`[assistant] skipping proposal ${res.data.proposal.id}: ${(err as Error).message}`);
        continue;
      }
      const proposal: AssistantProposal = { ...res.data.proposal, action, finalAction };
      // A Tower killed mid-execute left a dangling claim; resolve it honestly rather than
      // leaving it confirmable — the route may or may not have run before the crash.
      if (proposal.status === 'executing') {
        proposal.status = 'failed';
        proposal.error = 'Tower restarted while executing — check in the UI whether the action landed';
        proposal.decidedAt = proposal.decidedAt ?? new Date().toISOString();
      }
      this.records.set(proposal.id, { proposal, denorm: res.data.denorm });
    }
  }
}
