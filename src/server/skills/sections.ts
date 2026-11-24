// SPEC-SKILLS Phase 2 — the shared-file managed-span logic + the command-wrapper text mechanics. These
// are PURE text units (no fs); the materializer owns every write, under its per-configDir lock.
//
// Two ownership models meet here (SPEC-SKILLS §4.1):
//  · Model B — a managed SPAN inside a file the Tower does NOT own (codex `$CODEX_HOME/AGENTS.md`,
//    gemini `<configDir>/.gemini/GEMINI.md`). The fence IS the marker; only the bytes between the two
//    markers are ours, and a torn fence is hands-off (a deletion is never driven by a guess).
//  · Model A — an OWNED artifact (a gemini `commands/<id>.toml` wrapper) whose first-line TOML comment
//    carries the ownership marker (legal TOML, stripped by the loader's zod, invisible to the model).

import { createHash } from 'node:crypto';

// HTML comments: inert in markdown for both CLIs' context readers, and unambiguous to scan for.
export const FENCE_BEGIN = '<!-- ct-skills:begin -->';
export const FENCE_END = '<!-- ct-skills:end -->';

/** ~4KB budget for a managed section body — a shared instructions file we don't own must stay small. */
export const SECTION_BUDGET_BYTES = 4096;
/** The absolute upper bound on a rendered body: a runaway gate/note roster is summarized past this so the
 *  fence never wraps an unbounded blob (droppable note content yields first; gate lines are summarized,
 *  never silently dropped). */
export const SECTION_HARD_CEILING = 2 * SECTION_BUDGET_BYTES;

export function sectionHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j === -1) break;
    n++;
    i = j + needle.length;
  }
  return n;
}

// A zero-width space breaks either sentinel so authored content that ITSELF documents the fence
// convention (this project does) can never be mistaken for our markers on the next scan — a self-collision
// would otherwise wedge the section at a permanent conflict. The break is invisible in the rendered file,
// countOccurrences no longer matches it, and re-applying it is idempotent (the broken form contains
// neither sentinel).
const FENCE_BREAK = '\u200b';
function neutralizeFences(text: string): string {
  return text
    .split(FENCE_BEGIN)
    .join(`<!--${FENCE_BREAK} ct-skills:begin -->`)
    .split(FENCE_END)
    .join(`<!--${FENCE_BREAK} ct-skills:end -->`);
}

/** Wrap a body in the managed fence. INVARIANT: the output always re-parses well-formed (exactly one
 *  begin + one end) because the inner body is neutralized first — so a skill whose body embeds the literal
 *  fence string round-trips clean on the next sync instead of self-torning. */
function buildSpan(body: string): string {
  return `${FENCE_BEGIN}\n${neutralizeFences(body)}\n${FENCE_END}`;
}

/** Remove the fenced span and collapse the single blank-line separator that surrounded it, leaving every
 *  other byte untouched. Only called on a well-formed single fence. */
function stripSpan(current: string): string {
  const idxB = current.indexOf(FENCE_BEGIN);
  const idxE = current.indexOf(FENCE_END) + FENCE_END.length;
  const before = current.slice(0, idxB).replace(/\n+$/, '');
  const after = current.slice(idxE).replace(/^\n+/, '');
  if (before && after) return `${before}\n${after}`;
  return before || after;
}

export type SectionAction =
  | { kind: 'noop' }
  | { kind: 'write'; content: string }
  | { kind: 'conflict' };

/**
 * Reconcile the Tower's managed span inside a file it does NOT own — the MERGE-not-replace core.
 *  · Well-formed single fence → its span is REPLACED, surrounding bytes preserved byte-for-byte (slice,
 *    not re-serialize). An empty body REMOVES the span (never the file).
 *  · No fence, non-empty body → the span is INSERTED at EOF after a blank-line separator (or the whole
 *    content when the file is absent/empty).
 *  · No fence, empty body → noop; an absent file is never created.
 *  · A torn fence (missing/duplicated marker, or end-before-begin) → hands off the WHOLE file as a
 *    conflict; a deletion is never driven by a guess (the Phase-1 unparsable-marker posture).
 * An unchanged result is a noop, so a second sync leaves the file's mtime untouched.
 */
export function applyManagedSection(current: string | undefined, body: string): SectionAction {
  const src = current ?? '';
  const begins = countOccurrences(src, FENCE_BEGIN);
  const ends = countOccurrences(src, FENCE_END);
  const wellFormed = begins === 1 && ends === 1 && src.indexOf(FENCE_BEGIN) < src.indexOf(FENCE_END);
  if ((begins > 0 || ends > 0) && !wellFormed) return { kind: 'conflict' };

  let content: string;
  if (body === '') {
    if (!wellFormed) return { kind: 'noop' }; // nothing to remove; never create an empty file
    content = stripSpan(src);
  } else if (wellFormed) {
    const idxB = src.indexOf(FENCE_BEGIN);
    const idxE = src.indexOf(FENCE_END) + FENCE_END.length;
    content = src.slice(0, idxB) + buildSpan(body) + src.slice(idxE);
  } else if (current === undefined || src === '') {
    content = `${buildSpan(body)}\n`;
  } else {
    content = `${src.replace(/\s*$/, '')}\n\n${buildSpan(body)}\n`;
  }
  if (current !== undefined && content === current) return { kind: 'noop' };
  return { kind: 'write', content };
}

/** A managed-section note block (an authored `instructions-file` skill's inline body). */
export interface SectionNote {
  name: string;
  body: string;
  pointer: string; // where the full body lives, for the over-budget pointer line
}

// Headroom reserved for the "…and N more" summary line so a bounded block (kept lines + summary) never
// exceeds its byte budget.
const SUMMARY_RESERVE = 80;

/** Keep whole lines while they fit the byte budget, then fold the remainder into ONE bounded summary line
 *  — so a block is never an unbounded blob and never a partial (fence-hostile) line. The kept lines plus
 *  the summary stay within `byteBudget`. */
function boundLines(lines: string[], byteBudget: number, moreLabel: string): string {
  if (lines.length === 0) return '';
  const effective = Math.max(0, byteBudget - SUMMARY_RESERVE);
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const add = (kept.length ? 1 : 0) + byteLen(lines[i]!);
    if (kept.length > 0 && used + add > effective) {
      kept.push(`- …and ${lines.length - i} more ${moreLabel}.`);
      return kept.join('\n');
    }
    kept.push(lines[i]!);
    used += add;
  }
  return kept.join('\n');
}

/**
 * Assemble the managed-section body: the blocking-gate policy lines FIRST (never dropped), then each
 * instructions-file note under a bold lead-in. Over the soft budget ⇒ drop note BODIES largest-first, each
 * replaced by a one-line pointer, until it fits. Gate lines are always included but a runaway roster is
 * SUMMARIZED (never silently dropped) so the block stays bounded; once every note is a pointer and it
 * still overflows, the pointer block is summarized too, keeping the whole body within SECTION_HARD_CEILING.
 * Deterministic, and the fence is never left torn. An empty gate + note set yields '' (⇒ no fence written).
 */
export function renderSectionBody(
  gateLines: string[],
  notes: SectionNote[],
  budget = SECTION_BUDGET_BYTES,
): string {
  const gateBlock = boundLines(gateLines, budget, 'gated skills');
  const assemble = (noteTexts: string[]): string => [gateBlock, ...noteTexts].filter((s) => s !== '').join('\n\n');
  const noteTexts = notes.map((n) => `**${n.name}**\n${n.body}`);
  let body = assemble(noteTexts);
  if (byteLen(body) <= budget) return body;

  const bySize = noteTexts.map((t, i) => ({ i, size: byteLen(t) })).sort((a, b) => b.size - a.size);
  for (const { i } of bySize) {
    noteTexts[i] = `- ${notes[i]!.name}: see ${notes[i]!.pointer}`;
    body = assemble(noteTexts);
    if (byteLen(body) <= budget) return body;
  }

  // Every note is already a pointer and it still doesn't fit (a huge roster): bound the pointer block too
  // and re-assemble under the hard ceiling. Gate lines stay; the fence is never torn.
  const boundedNotes = boundLines(noteTexts, Math.max(0, SECTION_HARD_CEILING - byteLen(gateBlock)), 'more skills');
  return [gateBlock, boundedNotes].filter((s) => s !== '').join('\n\n');
}

// ---- Model A: gemini command-wrapper TOML (marker-owned) ----

/** A JSON string literal is almost a valid TOML basic string (same escapes for `\"`, `\\`, `\n`, the C0
 *  controls, …), EXCEPT JSON leaves U+007F (DEL) and the C1 controls (U+0080–U+009F) literal while TOML
 *  requires every control char escaped — so those are escaped explicitly on top. */
export function tomlBasicString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Truncate to at most `max` CODE POINTS (spread iterates by code point) so a trailing surrogate pair is
 *  never split into a lone half. */
function truncateCodePoints(s: string, max: number): string {
  return [...s].slice(0, max).join('');
}

export function commandMarkerLine(id: string, contentHash: string): string {
  return `# ct-skill ${id} ${contentHash}`;
}

export function parseCommandMarker(firstLine: string): { id: string; contentHash: string } | undefined {
  const m = /^# ct-skill ([A-Za-z0-9._-]+) ([a-f0-9]+)$/.exec(firstLine.trim());
  return m ? { id: m[1]!, contentHash: m[2]! } : undefined;
}

/** Emit a flat command wrapper. `{{args}}` is ALWAYS present so the loader never auto-appends the raw
 *  invocation; the description is truncated to the loader's display ceiling. */
export function emitCommandToml(opts: {
  id: string;
  contentHash: string;
  description: string;
  prompt: string;
}): string {
  return [
    commandMarkerLine(opts.id, opts.contentHash),
    `description = ${tomlBasicString(truncateCodePoints(opts.description, 100))}`,
    `prompt = ${tomlBasicString(opts.prompt)}`,
    '',
  ].join('\n');
}
