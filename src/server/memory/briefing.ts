// SPEC-MEMORY — the bounded memory briefing composer. PURE: entries in, text out. No fs, no
// store, no zod — the loop runner (the caller) reads the store, hands the entries here, and types the
// result into the pane as context at task start (`full`) and as a "changes since last read" delta each
// iteration (`delta`). The caller owns the "context, not instructions" posture and the seq cursor; this
// module owns the byte budget and the honesty of what it claims to have delivered.
//
// Shape follows skills/brief.ts + skills/sections.ts: one-line clamped entries, Buffer.byteLength
// accounting against a hard budget that is NEVER exceeded, a compact pointer header so the agent can
// always reach the full list, and an honest overflow footer whenever a line was dropped. Two contracts
// the caller leans on:
//  · `delivered` names ONLY the entries whose line actually landed in `text` — never "what we meant to
//    send". Record-keeping about what the agent has seen must not drift from the pane bytes.
//  · `toSeq` is the max seq the composer EVALUATED — never wall-clock, never "now". The caller advances
//    its cursor to exactly what this call looked at, so an entry written between two reads is caught by
//    the next delta rather than skipped over, and an entry filtered out (superseded, retracted) is not
//    re-evaluated forever.

import type { MemoryEntry, MemoryKind } from '../../shared/memory.js';

/** Byte ceiling for a task-start briefing (the whole active set, ranked). */
export const FULL_BUDGET = 4096;
/** Byte ceiling for a per-iteration delta (changes since the cursor). */
export const DELTA_BUDGET = 1536;
/** Per-entry body clamp in code points — a briefing line points at a claim, it is not the claim's full
 *  prose (schema BODY_MAX is 2048; the full body is one `towerctl memory read` away). */
export const ENTRY_CLAMP = 300;
/** Excerpt clamp for a lifecycle note (an entry that became superseded/retracted since the cursor) —
 *  just enough for the agent to recognise which claim it may have relied on. */
const NOTE_CLAMP = 80;
/** How many open disputes jump the queue. The cap bounds the pinned PREFIX, not eligibility — the rest
 *  stay in the ranked pool on kind/recency like any other active entry. */
export const MAX_PINNED_DISPUTES = 5;
/** The always-present pointer: whatever the budget cuts, the agent knows where the rest lives. */
export const MEMORY_BRIEF_POINTER = 'full list: towerctl memory read · search: towerctl memory search';

export type MemoryBriefingMode = 'full' | 'delta';

export interface ComposeMemoryBriefingOptions {
  mode: MemoryBriefingMode;
  /** The delta cursor: only entries with `seq > sinceSeq` are considered (default 0). Not a filter in
   *  `full` mode, but still a floor for `toSeq` so a cursor never moves backwards. */
  sinceSeq?: number;
  /** Hard byte ceiling for `text`; defaults to FULL_BUDGET / DELTA_BUDGET by mode. Never exceeded. */
  budgetBytes?: number;
}

export interface MemoryBriefing {
  /** The rendered block, or undefined when there is nothing to say (empty input, nothing past the
   *  cursor, or a budget too small for even the header). */
  text?: string;
  /** The entries whose line is IN `text` — id + the rev the agent saw. */
  delivered: { id: string; rev: number }[];
  /** Max seq among the entries this call evaluated (floored at sinceSeq ?? 0). The caller's next cursor. */
  toSeq: number;
  /** Candidate lines that did not fit the budget. */
  omitted: number;
}

// Ranking inside the budget: pinned disputes, then lifecycle corrections (delta only — "what you knew
// is gone" outranks a fresh claim), then the active body; within a tier gotcha > decision > glossary,
// then most recent first. A gotcha is the thing that bites an agent that has not read it; a glossary
// term is the thing it can look up.
const KIND_WEIGHT: Record<MemoryKind, number> = { gotcha: 0, decision: 1, glossary: 2 };

type Tier = 0 | 1 | 2; // pinned dispute | lifecycle change | active body

interface Candidate {
  entry: MemoryEntry;
  tier: Tier;
  line: string;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Collapse to one line and clamp — the skills/brief.ts idiom, sliced by CODE POINT so a trailing
 *  surrogate pair is never torn into a lone half (which would render as U+FFFD in the pane). JS `\s` does
 *  NOT include U+0085 (NEL) even though many terminals/editors treat it as a line break — an uncollapsed
 *  NEL in a body would then render (to a downstream reader) as a second line that can be crafted to look
 *  like another briefing bullet (`- id [kind·verified] ...`), forging a fake verified claim. Fold it into
 *  the same class explicitly. */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/[\s\u0085]+/g, ' ').trim();
  const cps = [...flat];
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : flat;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** An open dispute is a dispute on an entry that is still live. A superseded or retracted entry's
 *  dispute has been resolved by the lifecycle change (the replacement carries the claim now). */
function isOpenDispute(e: MemoryEntry): boolean {
  return e.lifecycle === 'active' && e.verification === 'disputed';
}

/** A run-scoped discovery that has not landed is flagged so an agent on another baseline does not assume
 *  its own tree has the behaviour (the applicability rationale in shared/memory.ts). */
function scopeTag(e: MemoryEntry): string {
  if (e.applicability.scope !== 'run') return '';
  return e.applicability.integration === 'landed' ? '' : `·${e.applicability.integration}`;
}

/** `- <id> [<kind>·<verification>[·in-flight]] <body>` — the id so the agent can cite/dispute/update it,
 *  the verification tag so it can weigh operator-verified over agent-provisional. */
function entryLine(e: MemoryEntry): string {
  return `- ${e.id} [${e.kind}·${e.verification}${scopeTag(e)}] ${oneLine(e.body, ENTRY_CLAMP)}`.trimEnd();
}

/** Delta-only: an entry that left the active set since the cursor. Carries a short excerpt so the agent
 *  can recognise the claim it may have relied on. */
function lifecycleLine(e: MemoryEntry): string {
  const what =
    e.lifecycle === 'superseded' ? `superseded${e.supersededBy ? ` by ${e.supersededBy}` : ''}` : 'retracted';
  const was = oneLine(e.body, NOTE_CLAMP);
  return `- ${e.id} [${e.kind}·${what}]${was ? ` was: ${was}` : ''}`;
}

function rank(a: Candidate, b: Candidate): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const kw = KIND_WEIGHT[a.entry.kind] - KIND_WEIGHT[b.entry.kind];
  if (kw !== 0) return kw;
  if (a.entry.seq !== b.entry.seq) return b.entry.seq - a.entry.seq;
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
}

function bySeqDesc(a: MemoryEntry, b: MemoryEntry): number {
  if (a.seq !== b.seq) return b.seq - a.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function headerLine(mode: MemoryBriefingMode, total: number, disputes: number, sinceSeq: number, toSeq: number): string {
  const summary =
    mode === 'full'
      ? `${plural(total, 'active entry', 'active entries')}${disputes ? `, ${disputes} disputed` : ''}`
      : `${plural(total, 'change', 'changes')} since seq ${sinceSeq} (through seq ${toSeq})`;
  return `Project memory — ${summary} · ${MEMORY_BRIEF_POINTER}`;
}

/** The honest overflow line. "Newest" is within the ranking — the block is a prefix of the ranked list,
 *  and the ranking is stated so the agent does not read the cut as a pure recency window. */
function footerLine(shown: number, total: number): string {
  return `(newest ${shown} of ${total} shown; disputes and gotchas first)`;
}

function assemble(head: string, lines: string[], footer: string | undefined): string {
  const parts = [head, ...lines];
  if (footer !== undefined) parts.push(footer);
  return parts.join('\n');
}

function toDelivered(c: Candidate): { id: string; rev: number } {
  return { id: c.entry.id, rev: c.entry.rev };
}

/**
 * Compose a bounded memory briefing. `full`: every active entry is a candidate, pinned disputes first.
 * `delta`: only entries with `seq > sinceSeq` — active ones as body lines, superseded/retracted ones as a
 * one-line correction each. Lines are kept in rank order while the whole block (header + lines + footer
 * when anything is dropped) fits `budgetBytes`; the first line that does not fit ends the block, so the
 * shown set is always a prefix of the ranking and the footer's "newest N of M" is exactly true.
 * Deterministic for a given input.
 */
export function composeMemoryBriefing(entries: MemoryEntry[], opts: ComposeMemoryBriefingOptions): MemoryBriefing {
  const budget = opts.budgetBytes ?? (opts.mode === 'full' ? FULL_BUDGET : DELTA_BUDGET);
  const sinceSeq = opts.sinceSeq ?? 0;
  const considered = opts.mode === 'delta' ? entries.filter((e) => e.seq > sinceSeq) : entries;
  // Everything evaluated, shown or not — the cursor must not stall on an entry we filtered out.
  const toSeq = considered.reduce((m, e) => Math.max(m, e.seq), sinceSeq);

  const disputes = considered.filter(isOpenDispute).sort(bySeqDesc);
  const pinned = new Set<MemoryEntry>(disputes.slice(0, MAX_PINNED_DISPUTES));
  const candidates: Candidate[] = [];
  for (const e of considered) {
    if (e.lifecycle === 'active') {
      candidates.push({ entry: e, tier: pinned.has(e) ? 0 : 2, line: entryLine(e) });
    } else if (opts.mode === 'delta') {
      candidates.push({ entry: e, tier: 1, line: lifecycleLine(e) });
    }
    // full mode: a superseded/retracted entry is evaluated (it moved toSeq) but has no line — the
    // generated views and `towerctl memory read` carry history; the task-start briefing carries the live set.
  }
  if (candidates.length === 0) return { text: undefined, delivered: [], toSeq, omitted: 0 };
  candidates.sort(rank);

  const total = candidates.length;
  const head = headerLine(opts.mode, total, disputes.length, sinceSeq, toSeq);

  // Everything fits with no footer → say so by saying nothing about overflow.
  const whole = assemble(head, candidates.map((c) => c.line), undefined);
  if (byteLen(whole) <= budget) {
    return { text: whole, delivered: candidates.map(toDelivered), toSeq, omitted: 0 };
  }

  // Not everything fits, so the footer is present from here on. Greedy prefix: each trial is the EXACT
  // text that would be emitted if this candidate were the last kept (footer counted for kept+1), so the
  // last successful trial is byte-identical to the final block — the budget check is not an estimate.
  const kept: Candidate[] = [];
  for (const c of candidates) {
    const trial = assemble(head, [...kept, c].map((k) => k.line), footerLine(kept.length + 1, total));
    if (byteLen(trial) > budget) break;
    kept.push(c);
  }
  const text = assemble(head, kept.map((c) => c.line), footerLine(kept.length, total));
  if (byteLen(text) > budget) {
    // Even header + footer alone overflow (a budget smaller than the pointer). Deliver nothing rather than
    // a torn line — and report every candidate as omitted so the caller sees the starvation.
    return { text: undefined, delivered: [], toSeq, omitted: total };
  }
  return { text, delivered: kept.map(toDelivered), toSeq, omitted: total - kept.length };
}
