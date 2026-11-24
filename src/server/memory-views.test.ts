// SPEC-MEMORY — generated, hash-headed markdown views + the legacy/external-edit parsers.
// Pure functions: no temp dir. (Lives under src/server/ because test discovery is non-recursive.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderView,
  parseView,
  parseLegacy,
  diffReplace,
  viewHash,
  entryMarker,
  bodyHasReservedSyntax,
  neutralizeReservedSyntax,
  SUPERSEDED_HEADING,
  TEST_KIT_KEY,
} from './memory/views.js';
import type { MemoryEntry } from '../shared/memory.js';

type Over = Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'seq' | 'body'>;

function mk(over: Over): MemoryEntry {
  return {
    rev: 1,
    kind: 'gotcha',
    author: { kind: 'operator' },
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    verification: 'provisional',
    lifecycle: 'active',
    evidence: [],
    applicability: { scope: 'project' },
    history: [],
    ...over,
  };
}

const HEADER_RE = /^<!-- ct:memory view=(\w+) hash=([0-9a-f]{64}) -->$/;

// ---- renderView / parseView ------------------------------------------------------------------------

test('renderView → parseView round trip preserves ids, revs and bodies, active first then non-active', () => {
  const entries = [
    mk({ id: 'b', seq: 2, rev: 4, body: 'second active\nwith a second line', verification: 'verified' }),
    mk({ id: 'a', seq: 1, rev: 1, body: 'first active' }),
    mk({ id: 'old', seq: 3, rev: 2, body: 'superseded body', lifecycle: 'superseded', supersededBy: 'b' }),
    mk({ id: 'gone', seq: 4, rev: 7, body: 'retracted body', lifecycle: 'retracted' }),
    mk({ id: 'other-kind', seq: 0, rev: 1, body: 'a decision', kind: 'decision' }),
  ];
  const view = renderView('gotcha', entries);
  const parsed = parseView(view);

  assert.equal(parsed.hash, viewHash('gotcha', entries));
  assert.deepEqual(
    parsed.sections.map((s) => [s.marker?.id, s.marker?.rev, s.body]),
    [
      ['a', 1, 'first active'],
      ['b', 4, 'second active\nwith a second line'],
      ['old', 2, 'superseded body'],
      ['gone', 7, 'retracted body'],
    ],
  );
  assert.ok(!view.includes('a decision'), 'other kinds are filtered out');
  assert.ok(!parsed.sections.some((s) => !s.marker), 'no marker-less section in a generated view');
});

test('renderView layout: header first, status suffix line, trailing superseded section only when needed', () => {
  const active = mk({ id: 'v', seq: 1, rev: 2, body: 'verified run note', verification: 'verified',
    applicability: { scope: 'run', loopId: 'l1', branch: 'agent/x', integration: 'in-flight' } });
  const plain = mk({ id: 'p', seq: 2, body: 'plain provisional project note' });
  const disputed = mk({ id: 'd', seq: 3, body: 'disputed note', verification: 'disputed' });
  const runOnly = mk({ id: 'r', seq: 4, body: 'run note', applicability: { scope: 'run', loopId: 'l1', branch: 'feat/y', integration: 'landed' } });
  const noBranch = mk({ id: 'nb', seq: 5, body: 'run without branch', applicability: { scope: 'run', loopId: 'l1', integration: 'in-flight' } });

  const view = renderView('gotcha', [active, plain, disputed, runOnly, noBranch]);
  const first = view.split('\n')[0] ?? '';
  assert.match(first, HEADER_RE);
  assert.equal(first.match(HEADER_RE)?.[1], 'gotchas');
  assert.ok(view.includes(`${entryMarker('v', 2)}\nverified run note\n— verified — run:agent/x\n`));
  assert.ok(view.includes(`${entryMarker('p', 1)}\nplain provisional project note\n\n`), 'provisional+project → no status line');
  assert.ok(view.includes(`${entryMarker('d', 1)}\ndisputed note\n— disputed\n`));
  assert.ok(view.includes(`${entryMarker('r', 1)}\nrun note\n— run:feat/y\n`));
  assert.ok(view.includes(`${entryMarker('nb', 1)}\nrun without branch\n`) && !view.includes('run without branch\n— run'), 'run scope without a branch → no suffix');
  assert.ok(!view.includes(SUPERSEDED_HEADING), 'no trailing section when every entry is active');
  assert.ok(view.endsWith('\n'));

  // parseView strips the presentation-only suffix so the body round-trips clean.
  const bodies = parseView(view).sections.map((s) => s.body);
  assert.deepEqual(bodies, ['verified run note', 'plain provisional project note', 'disputed note', 'run note', 'run without branch']);
});

test('renderView uses the right view name per kind and an empty kind is the header line only', () => {
  for (const [kind, name] of [['decision', 'decisions'], ['gotcha', 'gotchas'], ['glossary', 'glossary']] as const) {
    const view = renderView(kind, []);
    assert.equal(view, `<!-- ct:memory view=${name} hash=${viewHash(kind, [])} -->\n`);
    assert.deepEqual(parseView(view), { hash: viewHash(kind, []), sections: [] });
  }
});

test('renderView orders by seq deterministically regardless of input order', () => {
  const a = mk({ id: 'a', seq: 10, body: 'ten' });
  const b = mk({ id: 'b', seq: 2, body: 'two' });
  const c = mk({ id: 'c', seq: 5, body: 'five' });
  const v1 = renderView('gotcha', [a, b, c]);
  const v2 = renderView('gotcha', [c, a, b]);
  assert.equal(v1, v2);
  assert.deepEqual(parseView(v1).sections.map((s) => s.marker?.id), ['b', 'c', 'a']);
});

// ---- header hash -----------------------------------------------------------------------------------

test('header hash changes iff an ACTIVE body changes', () => {
  const base = [
    mk({ id: 'a', seq: 1, body: 'alpha' }),
    mk({ id: 'b', seq: 2, rev: 3, body: 'beta', verification: 'verified' }),
    mk({ id: 's', seq: 3, body: 'old stuff', lifecycle: 'superseded' }),
    mk({ id: 'r', seq: 4, body: 'retracted stuff', lifecycle: 'retracted' }),
  ];
  const hash = (entries: MemoryEntry[]) => parseView(renderView('gotcha', entries)).hash;
  const h0 = hash(base);
  assert.equal(h0, viewHash('gotcha', base));

  // Same content → same hash (deterministic; input order irrelevant).
  assert.equal(hash([...base].reverse()), h0);

  // Non-body metadata on an active entry does not move the hash.
  const meta = base.map((e) => (e.id === 'b' ? { ...e, rev: 9, verification: 'disputed' as const, updatedAt: '2027-01-01T00:00:00.000Z' } : e));
  assert.equal(hash(meta), h0);

  // A superseded / retracted body change does not move the hash…
  const inactiveEdit = base.map((e) => (e.id === 's' ? { ...e, body: 'old stuff, reworded' } : e.id === 'r' ? { ...e, body: 'zzz' } : e));
  assert.equal(hash(inactiveEdit), h0);

  // …but an active body change does.
  const activeEdit = base.map((e) => (e.id === 'a' ? { ...e, body: 'alpha!' } : e));
  assert.notEqual(hash(activeEdit), h0);

  // Retiring an active entry changes the live content too.
  const retire = base.map((e) => (e.id === 'a' ? { ...e, lifecycle: 'retracted' as const } : e));
  assert.notEqual(hash(retire), h0);

  // Another kind's entries never participate.
  assert.equal(hash([...base, mk({ id: 'd', seq: 99, body: 'decision', kind: 'decision' })]), h0);

  // Concatenation is unambiguous: ["ab","c"] ≠ ["a","bc"].
  assert.notEqual(
    viewHash('gotcha', [mk({ id: 'x', seq: 1, body: 'ab' }), mk({ id: 'y', seq: 2, body: 'c' })]),
    viewHash('gotcha', [mk({ id: 'x', seq: 1, body: 'a' }), mk({ id: 'y', seq: 2, body: 'bc' })]),
  );
});

test('superseded/retracted entries render under the trailing section, after every active entry', () => {
  const summary = mk({ id: 'new', seq: 2, body: 'the consolidated summary', supersedes: ['old'] });
  const entries = [
    mk({ id: 'old', seq: 1, body: 'first written, now superseded', lifecycle: 'superseded', supersededBy: 'new' }),
    summary,
    mk({ id: 'x', seq: 3, body: 'retracted', lifecycle: 'retracted' }),
  ];
  const view = renderView('gotcha', entries);
  const headingAt = view.indexOf(SUPERSEDED_HEADING);
  assert.ok(headingAt > 0);
  assert.ok(view.indexOf(entryMarker('new', 1)) < headingAt, 'active entry precedes the heading');
  assert.ok(view.indexOf(entryMarker('old', 1)) > headingAt, 'superseded (lower seq) still lands after the heading');
  assert.ok(view.indexOf(entryMarker('x', 1)) > headingAt);
  assert.equal(view.split(SUPERSEDED_HEADING).length, 2, 'heading appears exactly once');

  // Only the one active body is hashed.
  assert.equal(parseView(view).hash, viewHash('gotcha', [summary]));
  // The heading line is dropped by the parser rather than attached to a body.
  assert.deepEqual(parseView(view).sections.map((s) => s.body), ['the consolidated summary', 'first written, now superseded', 'retracted']);
});

// ---- parseView on hand-edited text -----------------------------------------------------------------

test('parseView: text before the first marker is a marker-less section; header absent → hash undefined', () => {
  const text = `Some new note the operator typed at the top.\n\n${entryMarker('a', 2)}\nbody a\n\n${entryMarker('b', 5)}\nbody b\n`;
  const parsed = parseView(text);
  assert.equal(parsed.hash, undefined);
  assert.deepEqual(parsed.sections, [
    { body: 'Some new note the operator typed at the top.' },
    { marker: { id: 'a', rev: 2 }, body: 'body a' },
    { marker: { id: 'b', rev: 5 }, body: 'body b' },
  ]);
});

test('parseView: a kept marker with its text deleted yields an empty body (diffReplace reads it as a retract)', () => {
  const parsed = parseView(`${entryMarker('a', 1)}\n\n${entryMarker('b', 1)}\nkept\n`);
  assert.deepEqual(parsed.sections, [
    { marker: { id: 'a', rev: 1 }, body: '' },
    { marker: { id: 'b', rev: 1 }, body: 'kept' },
  ]);
});

// ---- reserved syntax -------------------------------------------------------------------------------

/** A PROVISIONAL, project-scoped entry — renderEntry emits NO status suffix for it, so anything in its
 *  rendering that reads as a status line came from the body. */
function renderAlone(body: string): string {
  return renderView('gotcha', [mk({ id: 'only', seq: 1, rev: 3, body })]);
}

/** True when a single entry with `body` survives renderView → parseView as exactly ONE section carrying
 *  that body — i.e. parseView did NOT treat anything inside it structurally. (renderEntry always trims the
 *  body's outer whitespace and parseView trims sections, so the comparison is against body.trim().) */
function roundTripsClean(body: string): boolean {
  const { sections } = parseView(renderAlone(body));
  return sections.length === 1 && sections[0]!.marker?.id === 'only' && sections[0]!.body === body.trim();
}

// renderEntry's status-suffix vocabulary, restated here (like HEADER_RE above) rather than borrowed from
// the implementation: `— verified`, `— disputed`, `— run:<branch>`, or a verification then ` — run:<branch>`.
const STATUS_LINE = /^— (?:verified|disputed|run:\S+)(?: — run:\S+)?$/;

// What a browser <textarea> (MemoryPanel, the operator's editor) renders as a line break — `\r\n`, a lone
// `\r`, `\n`, and (in Blink) the Unicode LINE / PARAGRAPH SEPARATORs — restated here like STATUS_LINE.
// parseView splits on `\n` only.
const TEXTAREA_BREAK = /\r\n|\r|\n|\u2028|\u2029/;
/** The same normalization the neutralizer applies — every textarea break → `\n`. */
const toLF = (s: string) => s.replace(/\r\n?|[\u2028\u2029]/g, '\n');

/** True when the rendering of a provisional entry with `body`, as the operator's textarea would show it,
 *  has a line a reader would take for the operator-only status badge — the presentation spoof, whether or
 *  not parseView also mis-parses it. */
function spoofsStatus(body: string): boolean {
  return renderAlone(body).split(TEXTAREA_BREAK).some((l) => STATUS_LINE.test(l.trim()));
}

// The header LINE as parseView recognises it (any hex hash) — HEADER_RE above is the stricter check for
// the real 64-hex header renderView emits.
const PARSE_HEADER_LINE = /^<!-- ct:memory view=\S+ hash=[0-9a-f]+ -->$/;

/** True when the rendering, as the textarea shows it, has a header or the reserved heading as a LINE. */
function showsHeaderOrHeading(body: string): boolean {
  return renderAlone(body)
    .split('\n')
    .slice(1) // drop the view's own header line
    .join('\n')
    .split(TEXTAREA_BREAK)
    .some((l) => PARSE_HEADER_LINE.test(l.trim()) || l.trim() === SUPERSEDED_HEADING);
}

// Structural tokens: parseView splits / drops them, so the round trip is corrupted.
const RESERVED_BODIES = [
  `a note ${entryMarker('x', 2)} with a marker mid-line`,
  `${entryMarker('victim', 7)}\ntext that would land in another entry`,
  'line one\n<!-- ct:memory view=gotchas hash=abc123 -->\nline three',
  'indented header\n   <!-- ct:memory view=decisions hash=0 -->   \nmore',
  `above\n${SUPERSEDED_HEADING}\nbelow`,
  `above\n  ${SUPERSEDED_HEADING}  \nbelow`,
  // CRLF variants: parseView splits on `\n`, and trim() drops the trailing `\r`, so these are corrupted too.
  'line one\r\n<!-- ct:memory view=gotchas hash=abc123 -->\r\nline three',
  `above\r\n${SUPERSEDED_HEADING}\r\nbelow`,
];
// A lone `\r` — or a U+2028 / U+2029 separator — is ONE line to parseView (a clean round trip) but two
// lines to the operator's textarea, which shows the header / heading on its own line (and normalizes the
// `\r` to `\n` on save).
const CR_HIDDEN_BODIES = [
  'line one\r<!-- ct:memory view=gotchas hash=abc123 -->\rline three',
  `above\r${SUPERSEDED_HEADING}\rbelow`,
  'line one\u2028<!-- ct:memory view=gotchas hash=abc123 -->\u2028line three',
  `above\u2029${SUPERSEDED_HEADING}\u2029below`,
  `above\u2028${SUPERSEDED_HEADING}\nbelow`,
];
// Status-suffix lines. TRAILING ones are also what parseView strips (a lossy round trip); the leading /
// mid-body / invisible-trailer / lone-CR ones round-trip through parseView untouched yet still RENDER as
// the badge.
const STATUS_TRAILING_BODIES = [
  'claim\n— verified',
  'claim\n— disputed',
  'claim\n   — verified   ',
  'claim\n— run:agent/x',
  'claim\n— verified — run:feat/y',
  'claim\n— disputed — run:release/2026.09',
  'claim\r\n— verified',
  'claim\r\n— disputed — run:feat/y',
];
const STATUS_ELSEWHERE_BODIES = [
  '— verified\nclaim',
  'claim\n— verified\nmore text after it',
  'claim\n— verified\n\u200b', // the invisible trailing line that would defeat a trailing-only rule
  'claim\n— disputed\n<!-- -->',
  'claim\r— verified', // the reviewer probe: a lone CR — one line to parseView, two to the textarea
  'claim\r— disputed\rmore',
  '— verified\rclaim',
  'claim\u2028— verified', // the U+2028 / U+2029 probes: Blink breaks the textarea line there too
  'claim\u2029— verified',
  'claim\u2028— disputed — run:feat/y\u2029more',
  '— run:agent/x\u2028claim',
];
const ALLOWED_BODIES = [
  'plain prose',
  'a generic <!-- html comment --> is fine',
  `<!-- ${TEST_KIT_KEY} -->\n## E2E test kit\n\n- Run the suite.`, // no space after ct:e → not a marker
  '<!-- ct:e2e-test-kit --> alone',
  '<!-- ct:e x --> (no rev) and <!-- ct:eX r1 --> (no space) and <!-- ct:e x r1--> (no space before -->)',
  '<!-- ct:memory view=gotchas --> (no hash → not the header)',
  'prose then <!-- ct:memory view=gotchas hash=ab --> mid-line is not a header LINE',
  `${SUPERSEDED_HEADING} with extra words`,
  '## Superseded',
  '### Superseded / retracted (h3)',
  '## A real heading\nwith — verified in the middle\nand more',
  'this claim was verified by the operator yesterday',
  'disputed: the reconciler does not clear the marker on WSL',
  '- verified', // a markdown bullet (hyphen), not the em-dash suffix
  '— verified by me',
  '—verified', // no space
  '— Verified', // case matters — renderEntry emits lowercase
  '— run: agent/x', // space after the colon → not the suffix form
  '— provisional\n— superseded\n— retracted', // never emitted by renderEntry → nothing to spoof
  'see run:agent/x for the branch',
  'a sentence\u2028with a line separator mid-sentence, verified in prod\u2029and a paragraph one', // no reserved token
  'claim\u2028— verified by me on the box', // a break, but the line is prose, not the suffix
  'claim — verified', // an em dash mid-sentence: no break, so one line of prose
];

test('bodyHasReservedSyntax flags EXACTLY the bodies parseView mis-parses OR the textarea would show as a reserved line', () => {
  const reserved = (b: string) => !roundTripsClean(b) || spoofsStatus(b) || showsHeaderOrHeading(b);
  for (const b of RESERVED_BODIES) {
    assert.equal(bodyHasReservedSyntax(b), true, `should be reserved: ${JSON.stringify(b)}`);
    assert.equal(roundTripsClean(b), false, `parseView should corrupt: ${JSON.stringify(b)}`);
  }
  for (const b of CR_HIDDEN_BODIES) {
    assert.equal(bodyHasReservedSyntax(b), true, `should be reserved: ${JSON.stringify(b)}`);
    assert.equal(roundTripsClean(b), true, `parseView itself is fine with it: ${JSON.stringify(b)}`);
    assert.equal(showsHeaderOrHeading(b), true, `…but the textarea shows the reserved line: ${JSON.stringify(b)}`);
  }
  for (const b of STATUS_TRAILING_BODIES) {
    assert.equal(bodyHasReservedSyntax(b), true, `should be reserved: ${JSON.stringify(b)}`);
    assert.equal(roundTripsClean(b), false, `parseView strips the trailing status line: ${JSON.stringify(b)}`);
    assert.equal(spoofsStatus(b), true);
  }
  for (const b of STATUS_ELSEWHERE_BODIES) {
    assert.equal(bodyHasReservedSyntax(b), true, `should be reserved: ${JSON.stringify(b)}`);
    assert.equal(roundTripsClean(b), true, `parseView itself is fine with it: ${JSON.stringify(b)}`);
    assert.equal(spoofsStatus(b), true, `…but it renders as the badge: ${JSON.stringify(b)}`);
  }
  for (const b of ALLOWED_BODIES) {
    assert.equal(bodyHasReservedSyntax(b), false, `should be allowed: ${JSON.stringify(b)}`);
    assert.equal(roundTripsClean(b), true, `parseView should round-trip: ${JSON.stringify(b)}`);
    assert.equal(spoofsStatus(b), false, `should not render as a badge: ${JSON.stringify(b)}`);
    assert.equal(showsHeaderOrHeading(b), false);
  }
  // The invariant, over every sample: reserved ⇔ (mis-parsed ∨ the textarea shows a reserved line).
  for (const b of [...RESERVED_BODIES, ...CR_HIDDEN_BODIES, ...STATUS_TRAILING_BODIES, ...STATUS_ELSEWHERE_BODIES, ...ALLOWED_BODIES]) {
    assert.equal(bodyHasReservedSyntax(b), reserved(b), JSON.stringify(b));
  }
  // Every reserved sample is detected identically to its `\n` form, and every allowed one stays allowed in it.
  for (const b of [...RESERVED_BODIES, ...CR_HIDDEN_BODIES, ...STATUS_TRAILING_BODIES, ...STATUS_ELSEWHERE_BODIES]) {
    assert.equal(bodyHasReservedSyntax(toLF(b)), true, `LF form of ${JSON.stringify(b)}`);
  }
  for (const b of ALLOWED_BODIES) assert.equal(bodyHasReservedSyntax(toLF(b)), false, `LF form of ${JSON.stringify(b)}`);
  // Stateless: the same reserved body tests true twice in a row (no /g lastIndex leak).
  const m = RESERVED_BODIES[0]!;
  assert.equal(bodyHasReservedSyntax(m) && bodyHasReservedSyntax(m), true);
});

test('a trailing status line in a PROVISIONAL body renders byte-identically to a real operator verification', () => {
  // The spoof, made concrete: the agent's provisional entry and the operator-verified entry render the same.
  const spoof = renderView('gotcha', [mk({ id: 'e', seq: 1, body: 'claim\n— verified' })]);
  const real = renderView('gotcha', [mk({ id: 'e', seq: 1, body: 'claim', verification: 'verified' })]);
  assert.equal(spoof.split('\n').slice(1).join('\n'), real.split('\n').slice(1).join('\n'), 'identical below the header line');
  assert.equal(bodyHasReservedSyntax('claim\n— verified'), true, 'which is why the body is refused');
});

test('an embedded marker is the forgery vector: the text after it re-parses as ANOTHER entry\'s edit', () => {
  // Why ingress must refuse it: a stored body carrying `<!-- ct:e victim rN -->` splits the view so the
  // injected tail becomes the LAST section for `victim`, and diffReplace's current map (last marker wins)
  // then reads the victim's real body as the CHANGE — an edit of `victim` under whoever saves the file.
  const victim = mk({ id: 'victim', seq: 1, rev: 2, body: 'real', verification: 'verified' });
  const poisoned = mk({ id: 'attacker', seq: 2, body: `harmless\n${entryMarker('victim', 2)}\ninjected` });
  const view = renderView('gotcha', [poisoned, victim].map((e, i) => ({ ...e, seq: i + 1 })));
  // (attacker at seq 1 renders first, so its embedded marker precedes the real victim marker)
  const ops = diffReplace(view, view);
  assert.deepEqual(ops.edits, [{ id: 'victim', rev: 2, body: 'injected' }], 'an UNCHANGED save edits the victim');
  assert.deepEqual(ops.adds, ['real'], 'and the victim\'s real body becomes a junk add');
  assert.equal(bodyHasReservedSyntax(poisoned.body), true, 'which is exactly what the validator refuses');
});

test('neutralizeReservedSyntax keeps legacy content, defuses every token, is idempotent, round-trips clean', () => {
  for (const b of [...RESERVED_BODIES, ...CR_HIDDEN_BODIES, ...STATUS_TRAILING_BODIES, ...STATUS_ELSEWHERE_BODIES]) {
    const safe = neutralizeReservedSyntax(b);
    assert.notEqual(safe, b, 'something changed');
    assert.equal(bodyHasReservedSyntax(safe), false, `still reserved after neutralize: ${JSON.stringify(safe)}`);
    assert.equal(neutralizeReservedSyntax(safe), safe, 'idempotent');
    assert.equal(roundTripsClean(safe), true, 'the neutralized body survives a view round trip');
    assert.equal(spoofsStatus(safe), false, 'and no longer renders as the badge');
    assert.equal(showsHeaderOrHeading(safe), false, 'nor as a header / heading line');
    assert.equal(safe.split('\n').length, b.split(TEXTAREA_BREAK).length, 'no line is dropped (line endings normalized to LF)');
    assert.equal(/[\r\u2028\u2029]/.test(safe), false, 'line endings are LF after neutralize');
    assert.equal(safe, neutralizeReservedSyntax(toLF(b)), 'neutralizes identically to its LF form');
  }
  // The transform is minimal and readable: comments stay comments, visible lines keep their words.
  assert.equal(neutralizeReservedSyntax(`see ${entryMarker('abc', 4)} here`), 'see <!-- x-ct:e abc r4 --> here');
  assert.equal(neutralizeReservedSyntax('  <!-- ct:memory view=gotchas hash=ff -->'), '  <!-- x-ct:memory view=gotchas hash=ff -->');
  assert.equal(neutralizeReservedSyntax(`x\n${SUPERSEDED_HEADING}\ny`), `x\n${SUPERSEDED_HEADING} (legacy)\ny`);
  assert.equal(neutralizeReservedSyntax('claim\n— verified'), 'claim\n— verified (legacy)');
  assert.equal(neutralizeReservedSyntax('claim\n  — disputed — run:feat/y  '), 'claim\n  — disputed — run:feat/y (legacy)  ');
  // The reviewer probes: a lone CR / U+2028 / U+2029 is normalized and the hidden badge line is neutralized
  // like its LF form.
  assert.equal(neutralizeReservedSyntax('claim\r— verified'), 'claim\n— verified (legacy)');
  assert.equal(neutralizeReservedSyntax('claim\r\n— verified\r\nmore'), 'claim\n— verified (legacy)\nmore');
  assert.equal(neutralizeReservedSyntax('claim\u2028— verified'), 'claim\n— verified (legacy)');
  assert.equal(neutralizeReservedSyntax('claim\u2029— verified'), 'claim\n— verified (legacy)');
  // Allowed text is untouched byte-for-byte (the test-kit marker included) — only line endings change.
  for (const b of ALLOWED_BODIES) assert.equal(neutralizeReservedSyntax(b), toLF(b));
  assert.equal(neutralizeReservedSyntax('a\r\nb\rc\nd\u2028e\u2029f'), 'a\nb\nc\nd\ne\nf');
});

test('neutralizeReservedSyntax preserves `$` sequences in the operator\'s line (no `$`-interpreting replacement)', () => {
  // String.prototype.replace(string, string) interprets `$'`, `$&`, `` $` `` and `$$` in the REPLACEMENT.
  // The operator's own text must come back byte-for-byte, with only the suffix spliced in.
  const probes: [string, string][] = [
    ["claim\n— run:$'  ", "claim\n— run:$' (legacy)  "], // the reviewer probe
    ['claim\n— run:$&', 'claim\n— run:$& (legacy)'],
    ['claim\n— run:$`x$$y$1', 'claim\n— run:$`x$$y$1 (legacy)'],
    ['claim\n  — verified — run:v$1.0  ', 'claim\n  — verified — run:v$1.0 (legacy)  '],
  ];
  for (const [input, expected] of probes) {
    const safe = neutralizeReservedSyntax(input);
    assert.equal(safe, expected, JSON.stringify(input));
    assert.equal(bodyHasReservedSyntax(safe), false);
    assert.equal(neutralizeReservedSyntax(safe), safe, 'idempotent');
  }
});

// ---- parseLegacy -----------------------------------------------------------------------------------

test('parseLegacy: a heading-split legacy file yields one candidate per top-level heading', () => {
  const legacy = [
    '## Use tmux -L per terminal',
    'Each terminal gets its own tmux server so a crash is contained.',
    '',
    '## Never re-adopt the machine login',
    'adoptMachineLogin clobbers .claude.json.',
    '### a sub-heading stays inside its parent',
    'more detail',
    '',
    '## Third',
    'third body',
  ].join('\n');
  const out = parseLegacy(legacy);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.key), [undefined, undefined, undefined]);
  assert.deepEqual(
    out.map((c) => c.body),
    [
      '## Use tmux -L per terminal\nEach terminal gets its own tmux server so a crash is contained.',
      '## Never re-adopt the machine login\nadoptMachineLogin clobbers .claude.json.\n### a sub-heading stays inside its parent\nmore detail',
      '## Third\nthird body',
    ],
  );
});

test('parseLegacy: a headingless file (or one with a substantial preamble) yields ONE candidate; blank → none', () => {
  const free = 'Line one about gotchas.\n\n- bullet a\n- bullet b\n';
  assert.deepEqual(parseLegacy(free), [{ body: free.trim() }]);

  const preamble = 'Intro paragraph that is real content.\n\n## A\nbody a\n\n## B\nbody b\n';
  assert.deepEqual(parseLegacy(preamble), [{ body: preamble.trim() }]);

  // A title line and blank lines are not a substantial preamble.
  const titled = '# Gotchas\n\n## A\nbody a\n\n## B\nbody b\n';
  assert.deepEqual(parseLegacy(titled).map((c) => c.body), ['## A\nbody a', '## B\nbody b']);

  assert.deepEqual(parseLegacy(''), []);
  assert.deepEqual(parseLegacy('  \n\n'), []);
});

test('parseLegacy: the e2e test-kit block yields a candidate carrying key ct:e2e-test-kit', () => {
  const kit = `<!-- ${TEST_KIT_KEY} -->\n## E2E test kit\n\n- Run the browser end-to-end suite with \`towerctl test run\`.\n- User stories live in the Stories section.`;

  // Appended after an operator's own heading-split content, the way ensureTestKitMemory did it.
  const glossary = `## Sortie\nOne unit of loop work.\n\n${kit}\n`;
  const out = parseLegacy(glossary);
  // The marker travels with its heading, and the keyed body is the full block.
  assert.deepEqual(out, [{ body: '## Sortie\nOne unit of loop work.' }, { key: TEST_KIT_KEY, body: kit }]);

  // Alone in the file → one keyed candidate, the marker line is not a "substantial preamble".
  assert.deepEqual(parseLegacy(`${kit}\n`), [{ key: TEST_KIT_KEY, body: kit }]);

  // In the whole-file fallback the key rides on the block alone, never on the prose above it.
  const freeform = `Just prose here.\n\n${kit}`;
  assert.deepEqual(parseLegacy(freeform), [{ body: 'Just prose here.' }, { key: TEST_KIT_KEY, body: kit }]);

  // Non-kit content stays keyless.
  assert.deepEqual(parseLegacy('## Foo\nbar'), [{ body: '## Foo\nbar' }]);
});

test('parseLegacy: the whole-file fallback splits prose and the test-kit block into separate candidates', () => {
  const kit = `<!-- ${TEST_KIT_KEY} -->\n## E2E test kit\n\n- Run the suite.`;

  // A substantial preamble forces the whole-file path: the operator's content above the block stays ONE
  // keyless candidate (headings and all); the block is its own keyed candidate.
  const preamble = `Intro that is real content.\n\n## Sortie\nOne unit of loop work.\n\n${kit}\n`;
  assert.deepEqual(parseLegacy(preamble), [
    { body: 'Intro that is real content.\n\n## Sortie\nOne unit of loop work.' },
    { key: TEST_KIT_KEY, body: kit },
  ]);

  // Content below the block's own section is not swallowed into the keyed candidate.
  const below = `Intro that is real content.\n\n${kit}\n\n## Glossary term\nafter the kit\n`;
  assert.deepEqual(parseLegacy(below), [
    { body: 'Intro that is real content.' },
    { key: TEST_KIT_KEY, body: kit },
    { body: '## Glossary term\nafter the kit' },
  ]);

  // Headingless prose around a bare marker: the block runs from the marker line to the end.
  const bare = `prose\n\nmore prose\n\n<!-- ${TEST_KIT_KEY} -->\nkit text without a heading\n`;
  assert.deepEqual(parseLegacy(bare), [
    { body: 'prose\n\nmore prose' },
    { key: TEST_KIT_KEY, body: `<!-- ${TEST_KIT_KEY} -->\nkit text without a heading` },
  ]);

  // A bare marker with nothing above it yields only the keyed block (no empty prose candidate).
  const bareOnly = `<!-- ${TEST_KIT_KEY} -->\nkit text without a heading`;
  assert.deepEqual(parseLegacy(`${bareOnly}\n`), [{ key: TEST_KIT_KEY, body: bareOnly }]);
});

// ---- diffReplace -----------------------------------------------------------------------------------

const CURRENT_ENTRIES = [
  mk({ id: 'a', seq: 1, rev: 2, body: 'alpha body' }),
  mk({ id: 'b', seq: 2, rev: 5, body: 'beta body', verification: 'verified' }),
  mk({ id: 'c', seq: 3, rev: 1, body: 'gamma body' }),
];
const CURRENT = renderView('gotcha', CURRENT_ENTRIES);

test('diffReplace: unchanged submission → no ops', () => {
  assert.deepEqual(diffReplace(CURRENT, CURRENT), { adds: [], edits: [], retracts: [] });
  // Dropping the presentation-only status line is not an edit either.
  assert.deepEqual(diffReplace(CURRENT, CURRENT.replace('\n— verified', '')), { adds: [], edits: [], retracts: [] });
});

test('diffReplace: a new unmarked paragraph is an add', () => {
  const top = CURRENT.replace('-->\n', '-->\n\nA brand-new gotcha typed at the top.\n');
  assert.deepEqual(diffReplace(CURRENT, top), { adds: ['A brand-new gotcha typed at the top.'], edits: [], retracts: [] });

  // The documented agent workflow — append below the last entry, write the whole file back.
  const bottom = `${CURRENT}\nAppended by an agent after reading the file.\n`;
  assert.deepEqual(diffReplace(CURRENT, bottom), { adds: ['Appended by an agent after reading the file.'], edits: [], retracts: [] });

  // Appending below an entry that carries a status suffix leaves the suffix out of the add.
  const afterVerified = CURRENT.replace('— verified\n', '— verified\n\nNew note under the verified one.\n');
  assert.deepEqual(diffReplace(CURRENT, afterVerified), { adds: ['New note under the verified one.'], edits: [], retracts: [] });

  // A multi-heading paste splits into one add per heading.
  const pasted = `${CURRENT}\n## One\nfirst\n\n## Two\nsecond\n`;
  assert.deepEqual(diffReplace(CURRENT, pasted).adds, ['## One\nfirst', '## Two\nsecond']);

  // Against an empty view (fresh project), a legacy whole-file write is all adds.
  const empty = renderView('gotcha', []);
  assert.deepEqual(diffReplace(empty, '## A\na\n\n## B\nb\n'), { adds: ['## A\na', '## B\nb'], edits: [], retracts: [] });
  assert.deepEqual(diffReplace(empty, 'free text only\n'), { adds: ['free text only'], edits: [], retracts: [] });
});

test('diffReplace: a kept marker with a changed body is an edit carrying the CURRENT rev', () => {
  const edited = CURRENT.replace('beta body', 'beta body, corrected');
  assert.deepEqual(diffReplace(CURRENT, edited), {
    adds: [],
    edits: [{ id: 'b', rev: 5, body: 'beta body, corrected' }],
    retracts: [],
  });

  // The rev comes from currentView even if the submitter's copy of the marker says otherwise.
  const staleMarker = edited.replace(entryMarker('b', 5), entryMarker('b', 4));
  assert.deepEqual(diffReplace(CURRENT, staleMarker).edits, [{ id: 'b', rev: 5, body: 'beta body, corrected' }]);

  // A rewrite that no longer starts with the old body is an edit, not an add.
  const rewritten = CURRENT.replace('alpha body', 'alpha body\nwith a continuation'.replace('alpha body', 'ALPHA body'));
  assert.deepEqual(diffReplace(CURRENT, rewritten).edits, [{ id: 'a', rev: 2, body: 'ALPHA body\nwith a continuation' }]);
});

test('diffReplace: a marker removed from the submission is a retract; so is a kept marker with its text deleted', () => {
  const withoutC = CURRENT.replace(`${entryMarker('c', 1)}\ngamma body\n`, '');
  assert.deepEqual(diffReplace(CURRENT, withoutC), { adds: [], edits: [], retracts: ['c'] });

  const blankedA = CURRENT.replace('alpha body\n', '');
  assert.deepEqual(diffReplace(CURRENT, blankedA), { adds: [], edits: [], retracts: ['a'] });

  // Everything gone → everything retracted, in view order.
  assert.deepEqual(diffReplace(CURRENT, renderView('gotcha', [])).retracts, ['a', 'b', 'c']);
});

test('diffReplace: add + edit + retract in one submission are all classified', () => {
  const submitted = [
    CURRENT.split('\n')[0], // header
    '',
    'Fresh note at the top.',
    '',
    entryMarker('a', 2),
    'alpha body',
    '',
    entryMarker('b', 5),
    'beta body, now sharper',
    '— verified',
    '',
    // c removed
  ].join('\n');
  assert.deepEqual(diffReplace(CURRENT, submitted), {
    adds: ['Fresh note at the top.'],
    edits: [{ id: 'b', rev: 5, body: 'beta body, now sharper' }],
    retracts: ['c'],
  });
});

test('diffReplace: a foreign or duplicated marker contributes its text as an add', () => {
  const foreign = `${CURRENT}\n${entryMarker('zz', 3)}\npasted from another project\n`;
  assert.deepEqual(diffReplace(CURRENT, foreign), { adds: ['pasted from another project'], edits: [], retracts: [] });

  const duplicated = `${CURRENT}\n${entryMarker('a', 2)}\na copy of alpha, edited into something new\n`;
  assert.deepEqual(diffReplace(CURRENT, duplicated), { adds: ['a copy of alpha, edited into something new'], edits: [], retracts: [] });
});

test('diffReplace: superseded entries are diffable too and dropping the trailing section retracts them', () => {
  const entries = [...CURRENT_ENTRIES, mk({ id: 'old', seq: 0, rev: 2, body: 'old body', lifecycle: 'superseded', supersededBy: 'a' })];
  const view = renderView('gotcha', entries);
  const dropped = view.slice(0, view.indexOf(SUPERSEDED_HEADING));
  assert.deepEqual(diffReplace(view, dropped), { adds: [], edits: [], retracts: ['old'] });

  // Appending below the LAST (superseded) entry is still an add, not an edit of the superseded entry.
  assert.deepEqual(diffReplace(view, `${view}\nappended at the very bottom\n`), { adds: ['appended at the very bottom'], edits: [], retracts: [] });
});
