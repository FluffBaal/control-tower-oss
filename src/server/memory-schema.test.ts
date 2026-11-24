// SPEC-MEMORY — the entry schema, caps, transition policy, and add-idempotency hash.
// (Lives under src/server/ because test discovery is non-recursive: `src/server/*.test.ts`.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  memoryEntrySchema,
  memoryAddRequestSchema,
  memoryUpdateRequestSchema,
  memoryConsolidateRequestSchema,
  canTransition,
  canonicalHash,
  applyEvidence,
  fitImportedBody,
  clampEvidence,
  BODY_MAX,
  NOTE_MAX,
  EVIDENCE_MAX,
} from './memory/schema.js';
import { RESERVED_SYNTAX_MESSAGE, SUPERSEDED_HEADING, LEGACY_SUFFIX, bodyHasReservedSyntax, entryMarker } from './memory/views.js';
import type { MemoryEntry, MemoryEvidence } from '../shared/memory.js';

function fullEntry(): MemoryEntry {
  return {
    id: 'e1',
    rev: 3,
    seq: 9,
    kind: 'gotcha',
    body: 'the reconciler clears a stale marker on load',
    author: { kind: 'agent', terminalId: 't1', loopId: 'l1', missionId: 'm1', sortieId: 's1' },
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T01:00:00.000Z',
    verification: 'verified',
    lifecycle: 'active',
    supersededBy: undefined,
    supersedes: ['old1'],
    evidence: [
      { type: 'code', path: 'src/server/store.ts', line: 640, sha: 'abc' },
      { type: 'test', runId: 'r9', verdict: 'pass' },
      { type: 'operator', note: 'confirmed by me' },
    ],
    applicability: { scope: 'run', loopId: 'l1', missionId: 'm1', branch: 'agent/x', baseBranch: 'main', integration: 'landed', landedAt: '2026-09-19T02:00:00.000Z' },
    sources: [{ id: 'old1', rev: 2 }],
    key: 'ct:e2e-test-kit',
    origin: 'agent',
    importedFrom: { file: 'gotchas.md', sha256: 'deadbeef', mtime: 1 },
    history: [
      { rev: 1, at: '2026-09-19T00:00:00.000Z', by: { kind: 'agent', terminalId: 't1' }, op: 'add', requestId: 'req-1', payloadHash: 'h1' },
      { rev: 3, at: '2026-09-19T01:00:00.000Z', by: { kind: 'operator' }, op: 'update', note: 'verified' },
    ],
  };
}

test('strip-trap: an entry with every optional field set round-trips through the schema', () => {
  const e = fullEntry();
  const parsed = memoryEntrySchema.parse(e);
  assert.deepEqual(parsed, e);
});

test('schema strips an unknown field rather than widening the type', () => {
  const withJunk = { ...fullEntry(), sneaky: 'x' } as Record<string, unknown>;
  const parsed = memoryEntrySchema.parse(withJunk) as Record<string, unknown>;
  assert.equal('sneaky' in parsed, false);
});

/** The two guarantees fitImportedBody makes, plus idempotence. */
function assertFits(input: string, label = JSON.stringify(input.slice(0, 40))): string {
  const out = fitImportedBody(input);
  assert.ok(out.length <= BODY_MAX, `${label}: ${out.length} > BODY_MAX`);
  assert.equal(bodyHasReservedSyntax(out), false, `${label}: still reserved: ${JSON.stringify(out.slice(-60))}`);
  assert.equal(fitImportedBody(out), out, `${label}: not idempotent`);
  return out;
}

test('fitImportedBody: under the cap it is just neutralize; over the cap it drops whole trailing lines', () => {
  assert.equal(fitImportedBody('claim\n— verified'), 'claim\n— verified (legacy)');
  assert.equal(fitImportedBody('a\r\nb'), 'a\nb');
  const fits = 'x'.repeat(BODY_MAX);
  assert.equal(fitImportedBody(fits), fits, 'exactly at the cap is kept whole');
  // Over the cap by whole lines: the trailing lines go, the leading ones are byte-identical.
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i} `.padEnd(100, '.'));
  const out = assertFits(lines.join('\n'));
  const keptN = out.split('\n').length;
  assert.deepEqual(out.split('\n'), lines.slice(0, keptN), 'a prefix of whole lines');
  assert.ok(out.length + 1 + lines[keptN]!.length > BODY_MAX, 'and the next line would not have fit');
});

test('fitImportedBody: the reviewer probe — a neutralized reserved line straddling BODY_MAX never comes back reserved', () => {
  // clampBody(neutralize(x)) used to cut `— verified (legacy)` back to a bare `— verified` at char 2048.
  // Sweep every prefix length around the boundary for each visible reserved line and the header.
  const tails = ['— verified', '— disputed', '— run:feat/x', `— verified — run:agent/y`, SUPERSEDED_HEADING, '<!-- ct:memory view=gotchas hash=00 -->', '— verified by me', `${SUPERSEDED_HEADING} and more`];
  for (const tail of tails) {
    for (let n = BODY_MAX - tail.length - LEGACY_SUFFIX.length - 4; n <= BODY_MAX + 4; n++) {
      const body = `${'x'.repeat(n)}\n${tail}`;
      const out = assertFits(body, `n=${n} tail=${JSON.stringify(tail)}`);
      // The first line is kept WHOLE while it fits; only when it alone is over the cap is it hard-cut.
      assert.equal(out.split('\n')[0], 'x'.repeat(n <= BODY_MAX ? n : BODY_MAX - LEGACY_SUFFIX.length), `n=${n}`);
    }
  }
  // The exact straddle: prefix 2037 + "\n— verified" → neutralized is 2057 chars; a char-2048 cut left "— verified".
  const straddle = `${'x'.repeat(BODY_MAX - 1 - '— verified'.length)}\n— verified`;
  assert.equal(fitImportedBody(straddle), 'x'.repeat(BODY_MAX - 1 - '— verified'.length), 'the status line is dropped whole, never cut');
});

test('fitImportedBody: a single over-cap line is hard-cut with room for the one suffix the cut can provoke', () => {
  // Plain long line: cut to BODY_MAX - LEGACY_SUFFIX.length, nothing to neutralize.
  const plain = assertFits('p'.repeat(BODY_MAX + 100));
  assert.equal(plain, 'p'.repeat(BODY_MAX - LEGACY_SUFFIX.length));
  // A cut can expose a reserved line as the line's whole (trimmed) content — here `— verified` followed by
  // padding out to the cut point and then more text. The re-neutralize adds the suffix and stays ≤ cap.
  const exposed = `— verified${' '.repeat(BODY_MAX - LEGACY_SUFFIX.length - '— verified'.length)}then more text well past the cap ${'m'.repeat(200)}`;
  const out = assertFits(exposed);
  assert.equal(out.trim(), `— verified${LEGACY_SUFFIX}`);
  assert.equal(out.length, BODY_MAX, 'exactly at the cap: the cut left room for the suffix');
  // Same for the heading and a header exposed by the cut (the line must itself be over the cap).
  const past = `then more text well past the cap ${'z'.repeat(200)}`;
  const heading = `${SUPERSEDED_HEADING}${' '.repeat(BODY_MAX - LEGACY_SUFFIX.length - SUPERSEDED_HEADING.length)}${past}`;
  assert.ok(heading.length > BODY_MAX);
  assert.equal(assertFits(heading).trim(), `${SUPERSEDED_HEADING}${LEGACY_SUFFIX}`);
  const hdr = '<!-- ct:memory view=gotchas hash=00 -->';
  const header = `${hdr}${' '.repeat(BODY_MAX - LEGACY_SUFFIX.length - hdr.length)}${past}`;
  assert.ok(header.length > BODY_MAX);
  assert.equal(assertFits(header).trim(), '<!-- x-ct:memory view=gotchas hash=00 -->');
});

test('clampEvidence bounds each class most-recent-wins', () => {
  const many: MemoryEvidence[] = Array.from({ length: EVIDENCE_MAX + 4 }, (_, i) => ({ type: 'link', url: `u${i}` }));
  const clamped = clampEvidence(many);
  assert.equal(clamped.length, EVIDENCE_MAX);
  // most-recent-wins within the class: the last item survives, the first is dropped
  assert.deepEqual(clamped[clamped.length - 1], { type: 'link', url: `u${EVIDENCE_MAX + 3}` });
  assert.deepEqual(clamped[0], { type: 'link', url: 'u4' });
  // under the cap → the very same array back
  const under = many.slice(0, EVIDENCE_MAX);
  assert.equal(clampEvidence(under), under);
});

test('clampEvidence: a non-operator flood can never evict an operator note (and vice versa)', () => {
  const op = (i: number): MemoryEvidence => ({ type: 'operator', note: `op${i}` });
  const link = (i: number): MemoryEvidence => ({ type: 'link', url: `u${i}` });
  // 3 operator notes buried under 20 agent links, interleaved: every note survives, links keep the newest 8.
  const mixed: MemoryEvidence[] = [];
  for (let i = 0; i < 20; i++) {
    if (i === 0 || i === 5 || i === 9) mixed.push(op(i));
    mixed.push(link(i));
  }
  const out = clampEvidence(mixed);
  assert.deepEqual(out.filter((e) => e.type === 'operator'), [op(0), op(5), op(9)], 'all operator notes kept, in order');
  assert.deepEqual(out.filter((e) => e.type !== 'operator'), Array.from({ length: EVIDENCE_MAX }, (_, k) => link(20 - EVIDENCE_MAX + k)), 'links: newest 8');
  assert.equal(out.length, 3 + EVIDENCE_MAX);
  // Relative order of the survivors is the input order.
  assert.deepEqual(out, mixed.filter((e) => out.includes(e)));
  // The operator's own notes are bounded too (only the operator can push out the operator's oldest).
  const ops = Array.from({ length: EVIDENCE_MAX + 2 }, (_, i) => op(i));
  assert.deepEqual(clampEvidence([...ops, link(1)]), [...ops.slice(2), link(1)]);
  // Total stays bounded at 2 × EVIDENCE_MAX.
  assert.equal(clampEvidence([...ops, ...Array.from({ length: 30 }, (_, i) => link(i))]).length, 2 * EVIDENCE_MAX);
});

test('applyEvidence stores an operator note as given — length is the store\'s to refuse, never truncated here', () => {
  const note = 'n'.repeat(NOTE_MAX + 100);
  const out = applyEvidence([], { type: 'operator', note });
  assert.deepEqual(out, [{ type: 'operator', note }]);
});

test('request schemas refuse a body carrying reserved view syntax, with the clear message on `body`', () => {
  const marker = entryMarker('victim', 3);
  const cases: [string, unknown][] = [
    ['add', { requestId: 'r1', kind: 'gotcha', body: `note\n${marker}\ninjected` }],
    ['update', { id: 'e1', rev: 1, body: `<!-- ct:memory view=gotchas hash=00 -->\nx` }],
    ['consolidate', { requestId: 'c1', kind: 'gotcha', body: `## Superseded / retracted\nx`, sources: [{ id: 'a', rev: 1 }] }],
    ['add', { requestId: 'r2', kind: 'gotcha', body: 'my claim\n— verified' }], // the status-badge spoof
    ['update', { id: 'e1', rev: 1, body: '— disputed\nx' }],
  ];
  const schemas = { add: memoryAddRequestSchema, update: memoryUpdateRequestSchema, consolidate: memoryConsolidateRequestSchema } as const;
  for (const [name, req] of cases) {
    const res = schemas[name as keyof typeof schemas].safeParse(req);
    assert.equal(res.success, false, `${name} should be refused`);
    if (!res.success) {
      assert.equal(res.error.issues.length, 1);
      assert.deepEqual(res.error.issues[0]!.path, ['body']);
      assert.equal(res.error.issues[0]!.message, RESERVED_SYNTAX_MESSAGE);
    }
  }
  // A generic HTML comment, prose containing the words, the test-kit key, and an update without a body are all fine.
  assert.equal(memoryAddRequestSchema.safeParse({ requestId: 'r1', kind: 'gotcha', body: 'see <!-- a note to self --> here' }).success, true);
  assert.equal(memoryAddRequestSchema.safeParse({ requestId: 'r1', kind: 'gotcha', body: 'verified in prod, disputed by nobody — verified by me' }).success, true);
  assert.equal(memoryAddRequestSchema.safeParse({ requestId: 'r1', kind: 'gotcha', body: '<!-- ct:e2e-test-kit -->\n## E2E test kit' }).success, true);
  assert.equal(memoryUpdateRequestSchema.safeParse({ id: 'e1', rev: 1, verification: 'disputed' }).success, true);
});

test('transition matrix: only the operator may verify', () => {
  assert.equal(canTransition('operator', 'verification', 'provisional', 'verified'), true);
  assert.equal(canTransition('operator', 'verification', 'disputed', 'verified'), true);
  assert.equal(canTransition('agent', 'verification', 'provisional', 'verified'), false);
  assert.equal(canTransition('agent', 'verification', 'disputed', 'verified'), false);
});

test('transition matrix: an agent may dispute but not reopen', () => {
  assert.equal(canTransition('agent', 'verification', 'provisional', 'disputed'), true);
  assert.equal(canTransition('agent', 'verification', 'verified', 'disputed'), true);
  assert.equal(canTransition('agent', 'verification', 'verified', 'provisional'), false); // reopen = operator only
  assert.equal(canTransition('operator', 'verification', 'verified', 'provisional'), true);
});

test('transition matrix: retract by agent/operator, un-retract operator-only; supersede not a direct transition', () => {
  assert.equal(canTransition('agent', 'lifecycle', 'active', 'retracted'), true);
  assert.equal(canTransition('operator', 'lifecycle', 'active', 'retracted'), true);
  assert.equal(canTransition('agent', 'lifecycle', 'retracted', 'active'), false);
  assert.equal(canTransition('operator', 'lifecycle', 'retracted', 'active'), true);
  // active↔superseded is reserved to consolidate/unconsolidate, never the generic update path
  assert.equal(canTransition('operator', 'lifecycle', 'active', 'superseded'), false);
  assert.equal(canTransition('agent', 'lifecycle', 'superseded', 'active'), false);
});

test('a same-state transition is always a no-op-allowed', () => {
  assert.equal(canTransition('agent', 'verification', 'provisional', 'provisional'), true);
});

test('appending a passing test as an agent adds evidence but cannot promote verification', () => {
  const e = fullEntry();
  const snapshot = structuredClone(e);
  const item: MemoryEvidence = { type: 'test', runId: 'r10', verdict: 'pass' };
  const nextEvidence = applyEvidence(e.evidence, item);
  // applyEvidence yields ONLY an evidence list with the item appended last…
  assert.equal(nextEvidence.length, e.evidence.length + 1);
  assert.deepEqual(nextEvidence.at(-1), item);
  assert.deepEqual(nextEvidence.slice(0, -1), e.evidence, 'earlier items are kept in order');
  // …and is pure: the entry handed in (its evidence array AND its verification) is untouched.
  assert.deepEqual(e, snapshot);
  // The structural guard: an agent cannot make the verify transition regardless of evidence.
  assert.equal(canTransition('agent', 'verification', 'provisional', 'verified'), false);
});

test('canonicalHash is key-order independent and changes on any content change', () => {
  const a = canonicalHash({ kind: 'gotcha', body: 'x', scope: 'run' });
  const b = canonicalHash({ scope: 'run', body: 'x', kind: 'gotcha' });
  assert.equal(a, b, 'key order must not affect the hash');
  const c = canonicalHash({ kind: 'gotcha', body: 'x2', scope: 'run' });
  assert.notEqual(a, c, 'a body change must change the hash');
});
