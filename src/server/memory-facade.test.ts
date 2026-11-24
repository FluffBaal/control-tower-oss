// SPEC-MEMORY — the Memory facade over MemoryStore: read/all render generated views, write is a
// revision-checked whole-file replace turned into entry ops, legacy .md is imported on first touch (via
// the store's ensureLoaded hook), and ensureTestKitMemory is a keyed upsert. Wires the SAME two store
// hooks server.ts does, so the view-regeneration-during-migration path is exercised here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-mem-facade-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { MemoryStore, ReservedSyntaxError } = await import('./memory/store.js');
const { BODY_MAX, MAX_ENTRIES_PER_PROJECT, memoryAddRequestSchema } = await import('./memory/schema.js');
const { renderView, parseView, entryMarker, bodyHasReservedSyntax, RESERVED_SYNTAX_MESSAGE } = await import('./memory/views.js');
const { Memory, StaleViewError } = await import('./coordination.js');

/** Construct the facade + store wired EXACTLY as server.ts does: ensureLoaded → first-load migration,
 *  onChange → view regeneration. This is what makes the migration-vs-writeViews interaction real. */
function freshFacade() {
  const store = new MemoryStore();
  const m = new Memory(store);
  store.setHooks({ ensureLoaded: (pid) => m.migrateProject(pid), onChange: (pid) => m.writeViews(pid) });
  return { m, store };
}

function seedLegacy(pid: string, files: Record<string, string>) {
  mkdirSync(join(paths.memory, pid), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(paths.memory, pid, f), body);
}

test('read of an empty project returns a header-only view for the kind', () => {
  const { m } = freshFacade();
  assert.match(m.read('proja', 'decisions.md'), /^<!-- ct:memory view=decisions hash=[0-9a-f]+ -->/);
});

test('legacy .md is imported to entries on first touch; originals archived, view regenerated', () => {
  const pid = 'projb';
  seedLegacy(pid, { 'gotchas.md': '## A gotcha\n\ntmux send-keys can be swallowed\n' });
  const { m } = freshFacade();
  assert.match(m.read(pid, 'gotchas.md'), /tmux send-keys can be swallowed/);
  assert.ok(existsSync(join(paths.memory, pid, 'entries.json')));
  assert.equal(readdirSync(join(paths.memory, pid)).filter((f) => f.startsWith('gotchas.md.imported-')).length, 1);
});

test('migration preserves all three legacy files even with the view-regeneration hook wired', () => {
  const pid = 'projc';
  seedLegacy(pid, {
    'decisions.md': '## D\n\nRotate by accountUuid, not profile name\n',
    'gotchas.md': '## G\n\nA restart rotates the session token\n',
    'glossary.md': '## Gl\n\nbelt = one account in the rotation ring\n',
  });
  const { m } = freshFacade();
  // First touch triggers migration; every file's content must survive.
  assert.match(m.read(pid, 'decisions.md'), /Rotate by accountUuid/);
  assert.match(m.read(pid, 'gotchas.md'), /rotates the session token/);
  assert.match(m.read(pid, 'glossary.md'), /rotation ring/);
  // The originals were archived (not deleted, not clobbered) — byte-identical.
  const dir = join(paths.memory, pid);
  const archived = readdirSync(dir).filter((f) => /\.imported-\d+$/.test(f));
  assert.equal(archived.length, 3, 'all three originals archived');
  const gotchasArchive = archived.find((f) => f.startsWith('gotchas.md.imported-'))!;
  assert.match(readFileSync(join(dir, gotchasArchive), 'utf8'), /rotates the session token/);
});

test('a direct store add on a legacy project migrates first', () => {
  // The entry-level routes hit the store directly, bypassing the facade, so migration must fire from the
  // store's ensureLoaded hook, not only from a facade method.
  const pid = 'projd';
  seedLegacy(pid, { 'gotchas.md': '## G\n\nprecious legacy gotcha\n' });
  const { m, store } = freshFacade();
  // First access is a DIRECT store mutation (as POST /api/agent/memory/entries would do), not a facade read.
  store.add(pid, { kind: 'agent', terminalId: 't1' }, { requestId: 'r1', kind: 'gotcha', body: 'a new note' });
  assert.match(m.read(pid, 'gotchas.md'), /precious legacy gotcha/, 'legacy content was migrated, not lost');
  assert.match(m.read(pid, 'gotchas.md'), /a new note/, 'the direct add also landed');
});

test('read()/meta() never write a view file, so a later first-load cannot re-import our own markup', () => {
  const pid = 'proji';
  const first = freshFacade();
  first.m.read(pid, 'decisions.md');
  first.m.all(pid);
  first.m.meta(pid);
  assert.equal(existsSync(join(paths.memory, pid, 'entries.json')), false, 'no mutation → no store file');
  for (const f of ['decisions.md', 'gotchas.md', 'glossary.md']) {
    assert.equal(existsSync(join(paths.memory, pid, f)), false, `${f} was not written by a read`);
  }
  // A fresh store over the same CT_HOME runs first-load migration again: nothing to import.
  const second = freshFacade();
  const entries = second.store.list(pid);
  assert.equal(entries.length, 0, 'no junk re-import');
  assert.ok(!entries.some((e) => e.body.includes('<!-- ct:memory')), 'no entry body is a view header');
  assert.deepEqual(second.m.meta(pid), {}, 'nothing to stat until a mutation writes the views');
  // Views appear (and meta stats them) only once a mutation has been persisted.
  second.store.add(pid, { kind: 'operator' }, { requestId: 'r1', kind: 'decision', body: 'first real note' });
  assert.deepEqual(Object.keys(second.m.meta(pid)).sort(), ['decisions.md', 'glossary.md', 'gotchas.md']);
});

test('a generated view left on disk without entries.json is neither imported nor archived', () => {
  const pid = 'projj';
  seedLegacy(pid, { 'gotchas.md': renderView('gotcha', []) }); // a header-only view, no store file beside it
  const { store } = freshFacade();
  assert.deepEqual(store.list(pid), []);
  const files = readdirSync(join(paths.memory, pid));
  assert.ok(files.includes('gotchas.md'), 'left in place');
  assert.ok(!files.some((f) => f.includes('.imported-')), 'not archived');
});

test('a revision-checked write adds an entry; a stale header is rejected', () => {
  const pid = 'proje';
  const { m } = freshFacade();
  const op = { kind: 'operator' } as const;
  const before = m.read(pid, 'decisions.md');
  m.write(pid, 'decisions.md', `${before}\n\nUse accountUuid, not profile name, for rotation.`, op);
  assert.match(m.read(pid, 'decisions.md'), /Use accountUuid, not profile name/);
  assert.throws(() => m.write(pid, 'decisions.md', `${before}\n\nA second different note`, op), (e: unknown) => e instanceof StaleViewError);
});

test('write() rejects an over-BODY_MAX single note instead of silently truncating it', () => {
  const pid = 'projh';
  const { m } = freshFacade();
  const view = m.read(pid, 'decisions.md');
  const huge = 'x'.repeat(BODY_MAX + 100);
  assert.throws(() => m.write(pid, 'decisions.md', `${view}\n\n${huge}`, { kind: 'operator' }), /exceeds \d+ chars/);
});

test('write() rejects a save whose adds would overflow the cap before applying any of it', () => {
  const pid = 'projk';
  const T = '2026-09-19T00:00:00.000Z';
  const entries = Array.from({ length: MAX_ENTRIES_PER_PROJECT - 1 }, (_, i) => ({
    id: `s${i}`,
    rev: 1,
    seq: i + 1,
    kind: 'gotcha',
    body: `n${i}`,
    author: { kind: 'operator' },
    createdAt: T,
    updatedAt: T,
    verification: 'provisional',
    lifecycle: 'active',
    evidence: [],
    applicability: { scope: 'project' },
    history: [{ rev: 1, at: T, by: { kind: 'operator' }, op: 'add' }],
  }));
  mkdirSync(join(paths.memory, pid), { recursive: true });
  writeFileSync(join(paths.memory, pid, 'entries.json'), JSON.stringify({ version: 1, seq: entries.length, entries }));
  const { m, store } = freshFacade();
  const view = m.read(pid, 'gotchas.md');
  // One slot left; a save carrying two adds is refused whole — neither add lands.
  assert.throws(() => m.write(pid, 'gotchas.md', `${view}\n## One\nfirst\n\n## Two\nsecond\n`, { kind: 'operator' }), /memory is full/);
  assert.equal(store.list(pid).length, MAX_ENTRIES_PER_PROJECT - 1, 'nothing was applied');
  // Retracting an active entry in the same save frees the slot the second add needs.
  const withoutFirst = view.replace(`${entryMarker('s0', 1)}\nn0\n\n`, '');
  m.write(pid, 'gotchas.md', `${withoutFirst}\n## One\nfirst\n\n## Two\nsecond\n`, { kind: 'operator' });
  assert.equal(store.list(pid).filter((e) => e.lifecycle === 'active').length, MAX_ENTRIES_PER_PROJECT);
  assert.equal(store.get(pid, 's0')!.lifecycle, 'retracted');
});

test('FORGERY: an agent cannot smuggle a marker-carrying body into the store, and a dispute-then-resolve round-trips a verified entry unchanged', () => {
  // X: an operator entry, verified. An agent's own add is refused up front if its body embeds another
  // entry's marker — at the edge (zod) and in the store (structural) — and the whole-file save path that
  // could otherwise re-parse such text into X's body is operator-only, so there is no surviving path for
  // agent-authored text to land inside X.
  const pid = 'projl';
  const { m, store } = freshFacade();
  const agent = { kind: 'agent', terminalId: 't1' } as const;
  const op = { kind: 'operator' } as const;
  const x0 = store.add(pid, op, { requestId: 'x', kind: 'gotcha', body: 'real' });
  const x = store.update(pid, op, { id: x0.id, rev: 1, verification: 'verified' }); // rev 2, verified
  const poisoned = `harmless\n${entryMarker(x.id, x.rev)}\ninjected`;

  // The agent's add is refused at the edge (the route's zod schema) AND in the store (structural).
  const parsed = memoryAddRequestSchema.safeParse({ requestId: 'a', kind: 'gotcha', body: poisoned });
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.equal(parsed.error.issues[0]!.message, RESERVED_SYNTAX_MESSAGE);
  assert.throws(() => store.add(pid, agent, { requestId: 'a', kind: 'gotcha', body: poisoned }), ReservedSyntaxError);

  // A dispute (an agent may dispute) followed by an operator resolve, then an unchanged operator save, is
  // a no-op: X's body/verification/rev survive untouched and nothing extra is created.
  const disputed = store.update(pid, agent, { id: x.id, rev: 2, verification: 'disputed' });
  store.update(pid, op, { id: x.id, rev: disputed.rev, verification: 'verified' });
  const view = m.read(pid, 'gotchas.md');
  const listBefore = store.list(pid);
  m.write(pid, 'gotchas.md', view, op); // the operator saves the file exactly as read
  assert.deepEqual(store.list(pid), listBefore, 'a no-change operator save is a no-op: X body/verification/rev unchanged, no junk provisional');
  assert.equal(store.get(pid, x.id)!.body, 'real');
  assert.equal(store.get(pid, x.id)!.verification, 'verified');
  assert.equal(parseView(view).sections.length, listBefore.length, 'every stored entry is exactly one section');
});

test('legacy import: reserved tokens in an old note are neutralized (imported, not lost) and the view round-trips cleanly', () => {
  const pid = 'projm';
  // Header token deliberately NOT on the first line (a file that STARTS with one is our own generated view)
  // and followed by prose (a comment line sitting directly above a `## ` heading rides with THAT heading —
  // parseLegacy's test-kit rule — which is fine, but would blur which section owns it here).
  const legacy = [
    '## Old gotcha',
    `mentions ${entryMarker('victim', 2)} inline and`,
    '<!-- ct:memory view=gotchas hash=00 -->',
    'then more prose',
    '',
    '## Superseded / retracted',
    'an operator heading that happens to be our reserved one',
    '',
    '## Third',
    'plain',
    '',
    '## Fourth',
    'the operator once annotated this by hand',
    '— verified',
    '',
  ].join('\n');
  seedLegacy(pid, { 'gotchas.md': legacy });
  const { m, store } = freshFacade();
  const view = m.read(pid, 'gotchas.md'); // first touch → import
  const entries = store.list(pid);
  assert.equal(entries.length, 4, 'all four legacy sections imported');
  assert.deepEqual(
    entries.map((e) => e.body),
    [
      '## Old gotcha\nmentions <!-- x-ct:e victim r2 --> inline and\n<!-- x-ct:memory view=gotchas hash=00 -->\nthen more prose',
      '## Superseded / retracted (legacy)\nan operator heading that happens to be our reserved one',
      '## Third\nplain',
      '## Fourth\nthe operator once annotated this by hand\n— verified (legacy)',
    ],
  );
  assert.ok(entries.every((e) => e.origin === 'imported' && e.verification === 'provisional'), 'an import never invents verification');
  // The generated view re-parses to exactly those four bodies, and shows no status badge for any of them…
  assert.deepEqual(parseView(view).sections.map((s) => s.body), entries.map((e) => e.body));
  assert.ok(!view.split('\n').some((l) => /^— (?:verified|disputed|run:\S+)(?: — run:\S+)?$/.test(l.trim())), 'the legacy "— verified" no longer renders as the badge');
  assert.ok(view.includes('\n— verified (legacy)\n'), 'the operator\'s words are still there, just not in the badge form');
  // …an unchanged whole-file save is a no-op, and an appended note is ONE add that touches nothing else.
  m.write(pid, 'gotchas.md', view, { kind: 'operator' });
  assert.deepEqual(store.list(pid), entries, 'no-change save changed nothing');
  m.write(pid, 'gotchas.md', `${view}\nA fresh note.\n`, { kind: 'operator' });
  const after = store.list(pid);
  assert.equal(after.length, 5);
  assert.deepEqual(after.slice(0, 4), entries, 'the imported entries are untouched (same rev, same body)');
  assert.equal(after[4]!.body, 'A fresh note.');
  // The archived original keeps the raw tokens byte-for-byte.
  const dir = join(paths.memory, pid);
  const archived = readdirSync(dir).find((f) => f.startsWith('gotchas.md.imported-'))!;
  assert.equal(readFileSync(join(dir, archived), 'utf8'), legacy);
});

test('write() pre-flight is LOAD-BEARING for a mid-body status line and a lone-CR badge: the whole-file save is refused', () => {
  // parseView only splits on markers, drops header/heading LINES and strips a TRAILING status line — so
  // these appended / edited sections reach diffReplace's ops intact, and only the pre-flight stops them.
  const pid = 'projn';
  const { m, store } = freshFacade();
  const op = { kind: 'operator' } as const;
  const x = store.add(pid, op, { requestId: 'x', kind: 'gotcha', body: 'real' });
  const before = store.list(pid);
  const view = m.read(pid, 'gotchas.md');
  const refused = (content: string) => {
    assert.throws(() => m.write(pid, 'gotchas.md', content, op), (e: unknown) => e instanceof Error && e.message === RESERVED_SYNTAX_MESSAGE, JSON.stringify(content.slice(view.length)));
    assert.deepEqual(store.list(pid), before, 'nothing was applied');
  };
  // An appended section carrying the badge MID-body (the trailing form is presentation and gets stripped).
  refused(`${view}\nharmless\n— verified\nmore\n`);
  // The reviewer probe through the operator's editor: a lone CR — the textarea shows a badge line, parseView
  // sees one line, and without the pre-flight the store would have kept it.
  refused(`${view}\nclaim\r— verified\n`);
  refused(`${view}\nclaim\r<!-- ct:memory view=gotchas hash=00 -->\n`);
  // …and the Unicode LINE / PARAGRAPH SEPARATORs, which Chrome's textarea breaks on the same way.
  refused(`${view}\nclaim\u2028— verified\n`);
  refused(`${view}\nclaim\u2029— verified\n`);
  // An EDIT of the existing entry that smuggles a mid-body badge line. (The body text itself changes —
  // text merely APPENDED under an intact body is diffReplace's "appended note" case: its leading status
  // line is presentation and is stripped, and the rest becomes an add.)
  refused(view.replace(`${entryMarker(x.id, 1)}\nreal`, `${entryMarker(x.id, 1)}\nreal, corrected\n— disputed\nsee?`));
  // Appended text whose SECOND line is the badge is an add carrying it mid-body → refused too.
  refused(`${view}\n— disputed\n— verified\nsee?\n`);
  // Whereas the same words as prose are fine and land as one add.
  m.write(pid, 'gotchas.md', `${view}\nharmless, verified by me — see the disputed part below\n`, op);
  assert.equal(store.list(pid).length, 2);
});

test('legacy import: an over-cap keyed test-kit block with a straddling status line imports (no throw), stores ≤ BODY_MAX and unreserved, and strands nothing', () => {
  const pid = 'projo';
  // The kit block (keyed → the STRICT upsertKeyed path) is padded so that neutralize→clamp would have left a
  // bare `— verified` at char 2048 — the old code threw ReservedSyntaxError here and stranded the sections
  // after it in the (already archived) file.
  const kitHead = '<!-- ct:e2e-test-kit -->\n## E2E test kit\n';
  const pad = 'k'.repeat(BODY_MAX - 1 - '— verified'.length - kitHead.length);
  const kit = `${kitHead}${pad}\n— verified`;
  const legacy = `## Sortie\nOne unit of loop work.\n\n${kit}\n\n## After the kit\nstill imported\n— disputed\n`;
  seedLegacy(pid, { 'glossary.md': legacy });
  const { m, store } = freshFacade();
  m.read(pid, 'glossary.md'); // first touch → import; must not throw
  const entries = store.list(pid);
  assert.equal(entries.length, 3, 'the section BEFORE the kit, the kit, and the section AFTER it all imported');
  const kitEntry = entries.find((e) => e.key === 'ct:e2e-test-kit')!;
  assert.ok(kitEntry, 'the keyed block landed through upsertKeyed');
  assert.ok(kitEntry.body.length <= BODY_MAX);
  assert.equal(bodyHasReservedSyntax(kitEntry.body), false);
  assert.equal(kitEntry.body, `${kitHead}${pad}`, 'the straddling status line was dropped whole, the block otherwise intact');
  assert.equal(entries.find((e) => e.body.startsWith('## After the kit'))!.body, '## After the kit\nstill imported\n— disputed (legacy)', 'the trailing section was not stranded');
  for (const e of entries) assert.equal(bodyHasReservedSyntax(e.body), false);
  // The view round-trips: an unchanged operator save is a no-op.
  const view = m.read(pid, 'glossary.md');
  m.write(pid, 'glossary.md', view, { kind: 'operator' });
  assert.deepEqual(store.list(pid), entries);
});

test('legacy import: a lone CR or a U+2028 / U+2029 hiding a badge line is normalized and neutralized', () => {
  const pid = 'projp';
  seedLegacy(pid, {
    'decisions.md': '## Rotation\nrotate by accountUuid\r— verified\r\n## Next\nplain\u2029still plain\n## Third\nlooks done\u2028— disputed\n',
  });
  const { m, store } = freshFacade();
  m.read(pid, 'decisions.md');
  assert.deepEqual(
    store.list(pid).map((e) => e.body),
    ['## Rotation\nrotate by accountUuid\n— verified (legacy)', '## Next\nplain\nstill plain', '## Third\nlooks done\n— disputed (legacy)'],
  );
  for (const e of store.list(pid)) assert.equal(bodyHasReservedSyntax(e.body), false);
});

test('writeViews only rewrites a view file whose rendered content actually changed', () => {
  const pid = 'projq';
  const { store } = freshFacade();
  store.add(pid, { kind: 'operator' }, { requestId: 'r1', kind: 'decision', body: 'first decision' });
  const dir = join(paths.memory, pid);
  const decisionsFile = join(dir, 'decisions.md');
  const gotchasFile = join(dir, 'gotchas.md');
  const glossaryFile = join(dir, 'glossary.md');
  const before = {
    decisions: { content: readFileSync(decisionsFile, 'utf8'), mtime: statSync(decisionsFile).mtimeMs },
    gotchas: { content: readFileSync(gotchasFile, 'utf8'), mtime: statSync(gotchasFile).mtimeMs },
    glossary: { content: readFileSync(glossaryFile, 'utf8'), mtime: statSync(glossaryFile).mtimeMs },
  };
  // A second mutation to the SAME kind (decision) must rewrite decisions.md, but gotchas.md/glossary.md
  // — whose rendered content is identical to before — must be byte- and mtime-unchanged.
  store.add(pid, { kind: 'operator' }, { requestId: 'r2', kind: 'decision', body: 'second decision' });
  assert.notEqual(readFileSync(decisionsFile, 'utf8'), before.decisions.content, 'decisions.md DID change');
  assert.equal(readFileSync(gotchasFile, 'utf8'), before.gotchas.content, 'gotchas.md content unchanged');
  assert.equal(readFileSync(glossaryFile, 'utf8'), before.glossary.content, 'glossary.md content unchanged');
  assert.equal(statSync(gotchasFile).mtimeMs, before.gotchas.mtime, 'gotchas.md was not rewritten (mtime unchanged)');
  assert.equal(statSync(glossaryFile).mtimeMs, before.glossary.mtime, 'glossary.md was not rewritten (mtime unchanged)');
});

test('ensureTestKitMemory is an idempotent keyed upsert', () => {
  const pid = 'projf';
  const { m } = freshFacade();
  m.ensureTestKitMemory(pid);
  m.ensureTestKitMemory(pid);
  const kit = new MemoryStore().list(pid).filter((e) => e.key === 'ct:e2e-test-kit');
  assert.equal(kit.length, 1);
  assert.match(m.read(pid, 'glossary.md'), /E2E test kit/);
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
