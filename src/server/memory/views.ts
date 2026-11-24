// SPEC-MEMORY — the three markdown files (decisions.md / gotchas.md / glossary.md) as GENERATED,
// hash-headed VIEWS of the versioned entries, plus the parsers that turn legacy or externally-edited
// markdown back into entry candidates / entry ops.
//
// Pure functions only: no fs, no store, no zod. The store owns I/O, the CAS on `rev`, and the staleness
// check on the header hash; this module only renders and parses text.
//
// View format (what `towerctl memory read` and the MemoryBar see):
//
//   <!-- ct:memory view=gotchas hash=<sha256> -->        header — hash covers ACTIVE bodies only
//
//   <!-- ct:e <id> r<rev> -->                            per-entry marker (id + rev = the CAS token)
//   <body>
//   — verified — run:agent/x                             optional one-line status suffix
//
//   ## Superseded / retracted                            trailing section, only when non-empty
//
//   <!-- ct:e <id> r<rev> -->
//   <body>
//
// The markers and header are HTML comments — invisible in rendered markdown, stable across operator
// edits of the visible text — the same convention as coordination.ts's `<!-- ct:e2e-test-kit -->`.

import { createHash } from 'node:crypto';
import type { MemoryEntry, MemoryKind } from '../../shared/memory.js';
import { viewFileFor } from '../../shared/memory.js';

/** The heading of the trailing non-active section. Presentation only — parseView drops it. */
export const SUPERSEDED_HEADING = '## Superseded / retracted';

/** The Tower-managed upsert key of the e2e test-kit block (coordination.ts's TEST_KIT_MARKER). */
export const TEST_KIT_KEY = 'ct:e2e-test-kit';
const TEST_KIT_MARKER = `<!-- ${TEST_KIT_KEY} -->`;

const HEADER_RE = /^<!-- ct:memory view=(\S+) hash=([0-9a-f]+) -->[ \t]*$/;
// The header's stable prefix — enough to recognise a generated view even with a truncated hash.
const HEADER_PREFIX_RE = /^<!-- ct:memory view=/;
const MARKER_RE = /<!-- ct:e (\S+) r(\d+) -->/g;
// The same marker pattern without /g: a stateless `.test` for bodyHasReservedSyntax (a /g regex's
// lastIndex would make back-to-back tests flaky).
const MARKER_ANYWHERE_RE = new RegExp(MARKER_RE.source);
// The status suffix renderView emits: `— verified`, `— disputed`, `— run:<branch>`, or a verification
// followed by the run scope. Git refnames cannot contain whitespace, so `\S+` covers every branch.
const STATUS_LINE_RE = /^— (?:verified|disputed|run:\S+)(?: — run:\S+)?$/;
const COMMENT_LINE_RE = /^\s*<!--.*-->\s*$/;
const H2_RE = /^## /;
// Every line-ending form a browser <textarea> — the operator's editor, where the real badges show — renders
// as a line break: CRLF, a lone CR, LF, and the Unicode LINE / PARAGRAPH SEPARATORs (U+2028 / U+2029, which
// Blink breaks on). parseView itself splits on `\n` only, so the others are invisible to IT; but the
// operator SEES the break, which is the spoof, so the validator and the neutralizer scan on all of them.
// Deliberately nothing else: lookalike dashes or invisible homoglyphs render inline, so parseView is
// lossless on them and renderEntry never emits them — the validator stays consistent with the parser.
const LINE_BREAK_RE = /\r\n|\r|\n|\u2028|\u2029/;
/** The suffix neutralizeReservedSyntax appends to a visible reserved line (the heading, a status suffix). */
export const LEGACY_SUFFIX = ' (legacy)';

export interface ViewSection {
  marker?: { id: string; rev: number };
  body: string;
}

export interface ParsedView {
  hash?: string;
  sections: ViewSection[];
}

export interface LegacyCandidate {
  key?: string;
  body: string;
}

export interface ReplaceOps {
  adds: string[];
  edits: { id: string; rev: number; body: string }[];
  retracts: string[];
}

/** `decisions` / `gotchas` / `glossary` — the view name in the header, derived from the filename. */
export function viewNameFor(kind: MemoryKind): string {
  return viewFileFor(kind).replace(/\.md$/, '');
}

export function entryMarker(id: string, rev: number): string {
  return `<!-- ct:e ${id} r${rev} -->`;
}

/** The error text every write path uses when a body carries reserved view syntax (see below). */
export const RESERVED_SYNTAX_MESSAGE =
  'body may not contain reserved memory-view syntax (a `<!-- ct:e … -->` entry marker, a `<!-- ct:memory view=… -->` header, the `## Superseded / retracted` heading, or a `— verified` / `— disputed` / `— run:…` status line)';

/**
 * True when `body` contains any token the view layer treats as ITS OWN — so storing it would either corrupt
 * the next whole-file round trip or spoof the view's presentation. The four tokens, matched EXACTLY as
 * parseView / renderEntry use them:
 *   - the entry marker `<!-- ct:e <id> r<rev> -->` — anywhere in the text (parseView's MARKER_RE is not
 *     line-anchored). The text after an embedded marker re-parses as ANOTHER entry's body, letting a
 *     low-privilege writer forge content into a verified entry;
 *   - the view header `<!-- ct:memory view=… hash=… -->` — as a whole (trimmed) line (parseView drops it);
 *   - the `## Superseded / retracted` heading — as a whole (trimmed) line (parseView drops it);
 *   - a status suffix line — `— verified`, `— disputed`, `— run:<branch>`, or a verification followed by
 *     ` — run:<branch>` (STATUS_LINE_RE, exactly what renderEntry emits) — as a whole (trimmed) line, ANY
 *     line, not just the last: a trailing one is what parseView strips (a lossy round trip), but every one
 *     renders as the operator-only verification badge, and a trailing-only rule would be defeated by an
 *     invisible trailing line (`…\n— verified\n\u200b`). Only the operator may verify; an agent must not be
 *     able to make its entry LOOK verified.
 * Lines are delimited by `\r\n`, `\r`, `\n`, U+2028 or U+2029 (LINE_BREAK_RE): `claim\r— verified` is one
 * line to parseView but two to the operator's <textarea>, which renders the badge — and normalizes the `\r`
 * to `\n` on save; Chrome renders a U+2028 the same way.
 * Nothing else is reserved: a generic `<!-- comment -->`, the test-kit key `<!-- ct:e2e-test-kit -->`
 * (no space after `ct:e`), a `## Superseded` heading with other words, a sentence that merely contains
 * "verified" / "disputed", a `- verified` bullet (hyphen, not em dash), `— verified by me`, or
 * `— provisional` / `— retracted` (never emitted, so nothing to spoof) all stay allowed.
 */
export function bodyHasReservedSyntax(body: string): boolean {
  if (MARKER_ANYWHERE_RE.test(body)) return true;
  for (const line of body.split(LINE_BREAK_RE)) {
    const t = line.trim();
    if (HEADER_RE.test(t) || t === SUPERSEDED_HEADING || STATUS_LINE_RE.test(t)) return true;
  }
  return false;
}

/**
 * Neutralize reserved syntax in LEGACY content so it can be imported instead of refused (a free-form
 * note an operator wrote years ago must not be lost over a token it could not have known was reserved).
 * Line endings (every LINE_BREAK_RE form, U+2028/U+2029 included) are normalized to `\n` first — the view
 * layer's only separator, and what a browser textarea does on save anyway — so a lone `\r` or a Unicode
 * line separator cannot hide a reserved line from the scan, and an imported CRLF file does not spawn a
 * spurious whole-entry edit the first time the operator saves it. Then, minimal and
 * readable: the two HTML-comment tokens get an `x-` on their namespace (`<!-- x-ct:e … -->`,
 * `<!-- x-ct:memory … -->`), so they stay comments — still invisible in rendered markdown, still legible
 * in the source — but no longer match parseView; the two VISIBLE reserved lines (the heading, a status
 * suffix) get LEGACY_SUFFIX, so the operator's words stay but the line is no longer the exact
 * presentation form. Every other byte of the operator's text is preserved (the suffix is spliced in by
 * slicing — never a `$`-interpreting string replacement, so `$'`, `$&`, `$$` in the line survive). Line
 * count is preserved. Idempotent: the neutralized forms match nothing here, so a second pass is a no-op,
 * and bodyHasReservedSyntax(neutralizeReservedSyntax(x)) is always false.
 */
export function neutralizeReservedSyntax(body: string): string {
  const re = new RegExp(MARKER_RE.source, 'g');
  return body
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(re, '<!-- x-ct:e $1 r$2 -->')
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (HEADER_RE.test(t)) return line.replace('<!-- ct:memory', '<!-- x-ct:memory'); // constant replacement: no `$` to interpret
      if (t === SUPERSEDED_HEADING || STATUS_LINE_RE.test(t)) {
        const at = line.indexOf(t); // the trimmed content, at its position inside the untrimmed line
        return line.slice(0, at) + t + LEGACY_SUFFIX + line.slice(at + t.length);
      }
      return line;
    })
    .join('\n');
}

/** True when `text` is a generated view — its first non-blank line is the `<!-- ct:memory view=… -->`
 *  header. Such a file is never legacy content: importing it would mint entries out of our own markup. */
export function isGeneratedView(text: string): boolean {
  const first = text.split('\n').find((l) => l.trim());
  return first !== undefined && HEADER_PREFIX_RE.test(first.trim());
}

function bySeq(a: MemoryEntry, b: MemoryEntry): number {
  return a.seq - b.seq || a.id.localeCompare(b.id);
}

function ofKind(kind: MemoryKind, entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => e.kind === kind).sort(bySeq);
}

/**
 * sha256 over the ACTIVE entries' bodies of one kind, in seq order. Bodies are NUL-separated so the hash
 * is unambiguous ("ab"+"c" ≠ "a"+"bc"). Superseded / retracted bodies, revs, verification and timestamps
 * do not participate — the hash answers "has the live content of this view changed?".
 */
export function viewHash(kind: MemoryKind, entries: MemoryEntry[]): string {
  const h = createHash('sha256');
  for (const e of ofKind(kind, entries)) {
    if (e.lifecycle !== 'active') continue;
    h.update(e.body);
    h.update('\0');
  }
  return h.digest('hex');
}

function statusSuffix(e: MemoryEntry): string | undefined {
  const parts: string[] = [];
  if (e.verification !== 'provisional') parts.push(`— ${e.verification}`);
  if (e.applicability.scope === 'run' && e.applicability.branch) parts.push(`— run:${e.applicability.branch}`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function renderEntry(e: MemoryEntry, withStatus: boolean): string {
  const lines = [entryMarker(e.id, e.rev), e.body.trim()];
  const status = withStatus ? statusSuffix(e) : undefined;
  if (status) lines.push(status);
  return lines.join('\n');
}

/**
 * Render one kind's view: header, active entries (seq order, each marker + body + status suffix), then —
 * only when there are any — the `## Superseded / retracted` section with the non-active entries (marker +
 * body). An empty kind renders the header line only.
 */
export function renderView(kind: MemoryKind, entries: MemoryEntry[]): string {
  const mine = ofKind(kind, entries);
  const header = `<!-- ct:memory view=${viewNameFor(kind)} hash=${viewHash(kind, entries)} -->`;
  const blocks: string[] = [header];
  for (const e of mine) if (e.lifecycle === 'active') blocks.push(renderEntry(e, true));
  const inactive = mine.filter((e) => e.lifecycle !== 'active');
  if (inactive.length > 0) {
    blocks.push(SUPERSEDED_HEADING);
    for (const e of inactive) blocks.push(renderEntry(e, false));
  }
  return `${blocks.join('\n\n')}\n`;
}

function stripTrailingStatus(body: string): string {
  const lines = body.split('\n');
  const last = lines[lines.length - 1];
  if (last !== undefined && STATUS_LINE_RE.test(last.trim())) lines.pop();
  return lines.join('\n').trim();
}

function stripLeadingStatus(text: string): string {
  const lines = text.trim().split('\n');
  const first = lines[0];
  if (first !== undefined && STATUS_LINE_RE.test(first.trim())) lines.shift();
  return lines.join('\n').trim();
}

/**
 * Parse a view (rendered by us, or edited by an operator / agent). Extracts the header hash when present
 * and splits the text into sections on the `<!-- ct:e <id> r<rev> -->` markers. Text before the first
 * marker (excluding the header) is a marker-less section (dropped if empty); each marked section's body
 * is the text up to the next marker, trimmed, minus the presentation-only status suffix line renderView
 * appended — so a round trip returns the entry body itself, not body + "— verified". The trailing
 * section's heading line is presentation too and is dropped wherever it appears.
 */
export function parseView(text: string): ParsedView {
  let hash: string | undefined;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const h = HEADER_RE.exec(line.trim());
    if (h) {
      hash ??= h[2];
      continue;
    }
    if (line.trim() === SUPERSEDED_HEADING) continue;
    kept.push(line);
  }
  const cleaned = kept.join('\n');

  const sections: ViewSection[] = [];
  let marker: ViewSection['marker'];
  let start = 0;
  const flush = (end: number) => {
    const raw = cleaned.slice(start, end).trim();
    if (marker) sections.push({ marker, body: stripTrailingStatus(raw) });
    else if (raw) sections.push({ body: raw });
  };
  const re = new RegExp(MARKER_RE.source, 'g');
  for (let m = re.exec(cleaned); m; m = re.exec(cleaned)) {
    flush(m.index);
    const [whole, id = '', rev = '0'] = m;
    marker = { id, rev: Number(rev) };
    start = m.index + whole.length;
  }
  flush(cleaned.length);
  return { hash, sections };
}

function withKey(body: string): LegacyCandidate {
  return body.includes(TEST_KIT_MARKER) ? { key: TEST_KIT_KEY, body } : { body };
}

/**
 * The whole-file fallback. Without the test-kit marker the file is ONE keyless candidate. With it, the
 * file splits: the text above the marker line (keyless, if any), the kit block itself (keyed — from the
 * marker line through its own `## ` section, or to the end of the file when no heading directly follows
 * the marker), and any text below that section (keyless, if any). LIMIT: prose the operator inserted
 * BETWEEN the marker line and the following heading is captured into the keyed block (the split is anchored
 * on the marker line, not the heading) — the auto-appender always put the heading directly under the
 * marker, so this only bites a hand-edited file, and at worst that inserted prose rides the keyed entry.
 */
function wholeFile(lines: string[]): LegacyCandidate[] {
  const mi = lines.findIndex((l) => l.includes(TEST_KIT_MARKER));
  if (mi < 0) return [{ body: lines.join('\n').trim() }];
  let end = lines.length;
  let heading = -1;
  for (let i = mi + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (!l.trim()) continue;
    if (H2_RE.test(l)) heading = i;
    break;
  }
  if (heading >= 0) {
    const next = lines.findIndex((l, i) => i > heading && H2_RE.test(l));
    if (next >= 0) end = next;
  }
  const out: LegacyCandidate[] = [];
  const above = lines.slice(0, mi).join('\n').trim();
  if (above) out.push({ body: above });
  out.push({ key: TEST_KIT_KEY, body: lines.slice(mi, end).join('\n').trim() });
  const below = lines.slice(end).join('\n').trim();
  if (below) out.push({ body: below });
  return out;
}

/**
 * Import an OLD free-form memory file. With at least one top-level `## ` heading and no substantial
 * preamble before the first one (blank lines, HTML comments and a `# Title` line are not substantial),
 * yield one candidate per heading (body = heading + its content); an HTML-comment line sitting directly
 * above a heading belongs to that heading's candidate — that is how `<!-- ct:e2e-test-kit -->` travels
 * with its "## E2E test kit" block. Otherwise fall back to the whole file (see wholeFile: one candidate,
 * or the prose and the kit block split apart). A candidate that carries the test-kit marker gets
 * `key: 'ct:e2e-test-kit'` so the store upserts it instead of duplicating; the split keeps prose ABOVE
 * the marker out of the keyed candidate (see wholeFile for the one hand-edited-file limit). Whitespace-only
 * input yields nothing.
 */
export function parseLegacy(text: string): LegacyCandidate[] {
  const whole = text.trim();
  if (!whole) return [];
  const lines = whole.split('\n');
  const headings: number[] = [];
  lines.forEach((l, i) => {
    if (H2_RE.test(l)) headings.push(i);
  });
  if (headings.length === 0) return wholeFile(lines);

  // Each section starts at its heading, pulled back over comment lines (across blank lines) directly above.
  const starts = headings.map((i) => {
    let s = i;
    for (let j = i - 1; j >= 0; j--) {
      const l = lines[j] ?? '';
      if (COMMENT_LINE_RE.test(l)) s = j;
      else if (l.trim()) break;
    }
    return s;
  });
  const preamble = lines
    .slice(0, starts[0])
    .filter((l) => l.trim() && !COMMENT_LINE_RE.test(l) && !/^# /.test(l));
  if (preamble.length > 0) return wholeFile(lines);

  return starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    return withKey(lines.slice(s, end).join('\n').trim());
  });
}

/**
 * Turn a legacy whole-file `write` into entry ops by diffing the submitted text against the current view.
 *   - a marker in both with a CHANGED body → an edit, carrying currentView's rev so the caller can CAS
 *   - a marker in currentView but gone from submitted → a retract (its id); so is a kept marker whose
 *     text was deleted (an empty body could only be rejected as an edit — deletion is what was meant)
 *   - unmarked text → add(s), split by parseLegacy so a multi-heading paste yields one add per heading
 *   - a marked entry whose body is intact but has text appended BELOW it → the entry is unchanged and
 *     the appended text is an add. This is the documented agent workflow ("read the file, add your entry
 *     to what is there, write the full content back") — without it a bottom-appended note would silently
 *     merge into the last entry (or into a superseded one).
 *   - a marker unknown to currentView, or a duplicated marker (a block copied to make a new one) → its
 *     text is new to this view → an add
 * Header-hash staleness is the caller's check (compare parseView(submitted).hash to the live viewHash).
 */
export function diffReplace(currentView: string, submitted: string): ReplaceOps {
  const cur = parseView(currentView);
  const sub = parseView(submitted);
  const current = new Map<string, { rev: number; body: string }>();
  for (const s of cur.sections) if (s.marker) current.set(s.marker.id, { rev: s.marker.rev, body: s.body });

  const ops: ReplaceOps = { adds: [], edits: [], retracts: [] };
  const seen = new Set<string>();
  const addText = (text: string) => {
    for (const c of parseLegacy(text)) ops.adds.push(c.body);
  };

  for (const s of sub.sections) {
    if (!s.marker) {
      addText(s.body);
      continue;
    }
    const { id } = s.marker;
    const known = current.get(id);
    if (!known || seen.has(id)) {
      addText(s.body);
      continue;
    }
    seen.add(id);
    if (!s.body) {
      ops.retracts.push(id);
      continue;
    }
    if (s.body === known.body) continue;
    if (known.body && s.body.startsWith(`${known.body}\n`)) {
      addText(stripLeadingStatus(s.body.slice(known.body.length)));
      continue;
    }
    ops.edits.push({ id, rev: known.rev, body: s.body });
  }
  for (const s of cur.sections) if (s.marker && !seen.has(s.marker.id)) ops.retracts.push(s.marker.id);
  return ops;
}
