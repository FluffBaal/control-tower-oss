// SkillStore (SPEC-SKILLS): the parts a typecheck cannot vouch for — the M6 strip-trap round-trip (an
// optional field missing from the zod mirror is stripped on load, and a value-spot-check would miss it),
// the quarantine/reject lifecycle, the upsert guards (id safety, derived-slug collision, reject-don't-
// truncate on body/assets, keep-vs-clear assets), the frozen contentHash contract, and the onChange
// frame count. No server, no tmux — CT_HOME is set before paths.js loads (it freezes at import).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// A type-only import is erased at compile, so it never triggers a runtime paths.js load before CT_HOME.
import type { UpsertSkillInput } from './skills/store.js';

const home = mkdtempSync(join(tmpdir(), 'ct-skills-store-'));
process.env.CT_HOME = home;

const { paths, ensureDirs } = await import('./paths.js');
ensureDirs(); // the config dir must exist before the store persists its index
const { SkillStore } = await import('./skills/store.js');
type UpsertInput = UpsertSkillInput;

// A skill input with EVERY optional field populated — the strip-trap fixture.
function fullInput(over: Partial<UpsertInput> = {}): UpsertInput {
  return {
    id: 'full-skill',
    name: 'Full Skill',
    description: 'exercises every optional field',
    body: '# body\n\n```js\nconst x = 1;\n```\n',
    trigger: 'when the operator asks for everything',
    scope: 'global',
    enabled: true,
    origin: 'operator',
    invocation: { user: true, model: 'suggest', triggerPhrases: ['do the thing', 'go'], argumentHint: 'what?' },
    gate: { mode: 'blocking', blocks: ['commit', 'push'], enforcedBy: ['policy-text'], rerunOnNewDiff: true },
    requires: { capabilities: ['subagents', 'worktree-isolation'], models: ['opus'] },
    supportedProviders: ['claude-code', 'custom:acme'],
    providerOverrides: { 'claude-code': { omit: false, body: 'variant', channel: 'skill-dir', allowedTools: ['Bash'] } },
    toolHints: { allowedTools: ['Bash(git diff:*)'] },
    tags: ['alpha', 'beta'],
    assets: [{ relPath: 'scripts/run.sh', content: 'echo hi\n', mode: 0o755 }],
    ...over,
  };
}

function keysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(keysDeep);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) o[k] = keysDeep((v as Record<string, unknown>)[k]);
    return o;
  }
  return typeof v; // leaf → its type, so the shape (key set) is compared, not just values
}

test('round-trip survives a fresh store load with EVERY key intact (M6 strip-trap)', () => {
  const store = new SkillStore();
  const created = store.upsert(fullInput());

  const reloaded = new SkillStore();
  const got = reloaded.get('full-skill');
  assert.ok(got, 'the skill loaded from disk');
  assert.deepEqual(got, created, 'values round-trip exactly');
  // The stricter guard: the KEY SETS match at every level (a forgotten zod field would strip on load,
  // and a value-equal spot-check would still pass — this would not).
  assert.deepEqual(keysDeep(got), keysDeep(created), 'the key set is identical at every level');
  // Body is byte-equal via getBody (lazy disk read).
  assert.equal(reloaded.getBody('full-skill'), fullInput().body);
  // The stored asset file is 0600 on disk even though its recorded mode metadata is 0o755.
  const st = readFileSync(join(paths.skillsData, 'full-skill', 'assets', 'scripts', 'run.sh'), 'utf8');
  assert.equal(st, 'echo hi\n');
  assert.equal(got.assets?.[0]?.mode, 0o755, 'the exec bit is preserved as METADATA');
});

test('quarantine: a torn index quarantines the bytes and starts empty', () => {
  writeFileSync(paths.skills, '{ not json'); // torn
  const store = new SkillStore();
  assert.equal(store.list().length, 0, 'a torn index loads empty');
  assert.ok(readdirSync(paths.config).some((f) => f.startsWith('skills.json.corrupt-')), 'the torn bytes are quarantined');
});

test('one invalid record among valid → survivors kept, rejected backup written, file re-persisted', () => {
  // Seed a valid skill through the store so its body.md exists, then hand-mangle the index to add a junk
  // record beside it.
  const store = new SkillStore();
  store.upsert({ id: 'keeper', name: 'Keeper', description: 'ok', body: 'hi\n' });
  const arr = JSON.parse(readFileSync(paths.skills, 'utf8')) as unknown[];
  arr.push({ id: 'junk', name: '', version: 'nope' }); // fails the schema
  writeFileSync(paths.skills, JSON.stringify(arr, null, 2));

  const reloaded = new SkillStore();
  assert.ok(reloaded.get('keeper'), 'the valid survivor is kept');
  assert.equal(reloaded.get('junk'), undefined, 'the invalid record is dropped');
  assert.ok(readdirSync(paths.config).some((f) => f.startsWith('skills.json.rejected-')), 'the original bytes are backed up');
  const persisted = JSON.parse(readFileSync(paths.skills, 'utf8')) as { id: string }[];
  assert.ok(!persisted.some((r) => r.id === 'junk'), 'the index is re-persisted to survivors-only');
});

test('a record whose body.md is missing is dropped on load', () => {
  const store = new SkillStore();
  store.upsert({ id: 'bodyless', name: 'Bodyless', description: 'ok', body: 'x\n' });
  rmSync(join(paths.skillsData, 'bodyless', 'body.md'), { force: true });
  const reloaded = new SkillStore();
  assert.equal(reloaded.get('bodyless'), undefined, 'a listed skill with no body is inert');
});

test('upsert guards: bad ids, reserved id, and derived-slug collision all throw', () => {
  const store = new SkillStore();
  for (const id of ['..', 'Upper', '-lead', 'has space']) {
    assert.throws(() => store.upsert({ id, name: 'x', description: 'x', body: 'x' }), new RegExp('invalid skill id'));
  }
  assert.throws(() => store.upsert({ id: 'import', name: 'x', description: 'x', body: 'x' }), /reserved skill id/);
  store.upsert({ name: 'Collide Me', description: 'x', body: 'x' }); // mints slug 'collide-me'
  assert.throws(() => store.upsert({ name: 'Collide Me', description: 'x', body: 'x' }), /skill id exists/);
});

test('body over 512 KB REJECTS and is not truncated', () => {
  const store = new SkillStore();
  const big = 'x'.repeat(512 * 1024 + 1);
  assert.throws(() => store.upsert({ id: 'toobig', name: 'Too Big', description: 'x', body: big }), /body exceeds/);
  assert.equal(store.get('toobig'), undefined, 'a rejected skill never lands');
  assert.equal(existsSync(join(paths.skillsData, 'toobig')), false, 'and never touches disk');
});

test('asset path guard: traversing/absolute/hidden-root paths throw', () => {
  const store = new SkillStore();
  for (const relPath of ['../x', '/abs', '.hidden', 'a/../b']) {
    assert.throws(
      () => store.upsert({ id: 'ap', name: 'AP', description: 'x', body: 'x', assets: [{ relPath, content: 'y' }] }),
      /unsafe asset path/,
    );
  }
});

test('assets: undefined KEEPS, [] CLEARS; version bumps; createdAt stable; origin immutable', () => {
  const store = new SkillStore();
  const a = store.upsert({ id: 'life', name: 'Life', description: 'x', body: 'v1\n', origin: 'operator', assets: [{ relPath: 'a.txt', content: 'A' }] });
  assert.equal(a.version, 1);
  assert.equal(a.origin, 'operator');

  // Patch with assets OMITTED → prior asset intact on disk + in the index; body replaced.
  const b = store.upsert({ id: 'life', name: 'Life', description: 'x', body: 'v2\n' });
  assert.equal(b.version, 2, 'version increments on patch');
  assert.equal(b.createdAt, a.createdAt, 'createdAt survives');
  assert.equal(store.getBody('life'), 'v2\n', 'body was replaced');
  assert.equal(b.assets?.[0]?.relPath, 'a.txt', 'omitted assets are kept');
  assert.equal(readFileSync(join(paths.skillsData, 'life', 'assets', 'a.txt'), 'utf8'), 'A', 'kept asset file survives the stage-swap');

  // A patch cannot change origin (provenance is immutable after create).
  const c = store.upsert({ id: 'life', name: 'Life', description: 'x', body: 'v3\n', origin: 'assistant' });
  assert.equal(c.origin, 'operator', 'origin is immutable');

  // assets: [] clears them.
  const d = store.upsert({ id: 'life', name: 'Life', description: 'x', body: 'v4\n', assets: [] });
  assert.equal(d.assets, undefined, 'an empty array clears assets');
  assert.equal(existsSync(join(paths.skillsData, 'life', 'assets', 'a.txt')), false, 'the cleared asset file is gone');
});

test('contentHash pins exactly the materialization-affecting fields', () => {
  const store = new SkillStore();
  const base = store.upsert({ id: 'h', name: 'H', description: 'd', body: 'b\n', tags: ['t1'], enabled: true, scope: 'global' });
  const h0 = base.contentHash;

  // Pure selection/provenance flips (enabled/scope, tags held) must NOT change the hash.
  const selFlip = store.upsert({ id: 'h', name: 'H', description: 'd', body: 'b\n', tags: ['t1'], enabled: false, scope: 'project' });
  assert.equal(selFlip.contentHash, h0, 'enabled/scope are excluded from the hash');

  // tags ARE emitted content (they land in the materialized frontmatter), so a tags-only edit MUST move it.
  const tagsChanged = store.upsert({ id: 'h', name: 'H', description: 'd', body: 'b\n', tags: ['t2'] });
  assert.notEqual(tagsChanged.contentHash, h0, 'tags are in the hash');

  // Content flips MUST change it.
  const bodyChanged = store.upsert({ id: 'h', name: 'H', description: 'd', body: 'CHANGED\n' });
  assert.notEqual(bodyChanged.contentHash, h0, 'body is in the hash');
  const descChanged = store.upsert({ id: 'h', name: 'H', description: 'NEW', body: 'CHANGED\n' });
  assert.notEqual(descChanged.contentHash, bodyChanged.contentHash, 'description is in the hash');
  const modelChanged = store.upsert({ id: 'h', name: 'H', description: 'NEW', body: 'CHANGED\n', invocation: { model: 'never' } });
  assert.notEqual(modelChanged.contentHash, descChanged.contentHash, 'invocation.model is in the hash');

  // An asset byte and an asset mode each move the hash.
  const withAsset = store.upsert({ id: 'ha', name: 'HA', description: 'd', body: 'b\n', assets: [{ relPath: 'x', content: '1', mode: 0o644 }] });
  const assetByte = store.upsert({ id: 'ha', name: 'HA', description: 'd', body: 'b\n', assets: [{ relPath: 'x', content: '2', mode: 0o644 }] });
  assert.notEqual(assetByte.contentHash, withAsset.contentHash, 'an asset byte is in the hash');
  const assetMode = store.upsert({ id: 'ha', name: 'HA', description: 'd', body: 'b\n', assets: [{ relPath: 'x', content: '2', mode: 0o755 }] });
  assert.notEqual(assetMode.contentHash, assetByte.contentHash, 'an asset mode is in the hash');
});

test('contentHash is order-independent for set-like fields and provider-override keys', () => {
  const store = new SkillStore();
  // The SAME logical overrides in different KEY order must hash identically (the stored order can differ).
  const a = store.upsert({
    id: 'ord', name: 'Ord', description: 'd', body: 'b\n',
    providerOverrides: { 'claude-code': { body: 'x' }, codex: { body: 'y' } },
  });
  const b = store.upsert({
    id: 'ord', name: 'Ord', description: 'd', body: 'b\n',
    providerOverrides: { codex: { body: 'y' }, 'claude-code': { body: 'x' } },
  });
  assert.equal(b.contentHash, a.contentHash, 'provider-override key order does not move the hash');

  // Set-like arrays (gate.blocks, supportedProviders) in different order also hash the same.
  const g1 = store.upsert({
    id: 'ord2', name: 'O2', description: 'd', body: 'b\n',
    gate: { mode: 'blocking', blocks: ['commit', 'push'] }, supportedProviders: ['claude-code', 'codex'],
  });
  const g2 = store.upsert({
    id: 'ord2', name: 'O2', description: 'd', body: 'b\n',
    gate: { mode: 'blocking', blocks: ['push', 'commit'] }, supportedProviders: ['codex', 'claude-code'],
  });
  assert.equal(g2.contentHash, g1.contentHash, 'set-like array order does not move the hash');
});

test('boot recovers an interrupted swap instead of dropping the body', () => {
  const store = new SkillStore();
  store.upsert({ id: 'crash', name: 'Crash', description: 'x', body: 'ORIGINAL\n' });
  // Simulate a kill right after `renameSync(live, .old)` and BEFORE `.stage → live`: the live dir is gone
  // and the only copy is under `.old.crash.<stamp>` — while the index still lists the record.
  const live = join(paths.skillsData, 'crash');
  const old = join(paths.skillsData, `.old.crash.${Date.now()}-zzzz`);
  renameSync(live, old);
  assert.equal(existsSync(live), false, 'the live dir is gone (the crash window)');

  const reloaded = new SkillStore(); // recoverAndSweep promotes .old → live BEFORE the load validates it
  assert.ok(reloaded.get('crash'), 'the record survived the reload');
  assert.equal(reloaded.getBody('crash'), 'ORIGINAL\n', 'the body was recovered, not dropped');
  assert.equal(existsSync(old), false, 'the .old copy was consumed by the promotion');
});

test('a completed-swap leftover (.old with live present) is discarded, live intact', () => {
  const store = new SkillStore();
  store.upsert({ id: 'done', name: 'Done', description: 'x', body: 'LIVE\n' });
  // A .old left behind by a COMPLETED swap (live still exists): boot must delete it and keep live.
  const stale = join(paths.skillsData, `.old.done.${Date.now()}-yyyy`);
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'body.md'), 'STALE\n');
  const reloaded = new SkillStore();
  assert.equal(reloaded.getBody('done'), 'LIVE\n', 'the live body is untouched');
  assert.equal(existsSync(stale), false, 'the completed-swap leftover was cleared');
});

// ---- SPEC-SKILLS Phase 5b wave 2 — autonomy clearance: operator-only structurally, hash-keyed reset ----

function rawRecord(id: string): Record<string, unknown> {
  const arr = JSON.parse(readFileSync(paths.skills, 'utf8')) as Record<string, unknown>[];
  const rec = arr.find((r) => r.id === id);
  assert.ok(rec, `persisted record '${id}' exists`);
  return rec!;
}

test('autonomyCleared is operator-only: a smuggled upsert key never lands (persisted-bytes proof)', () => {
  const store = new SkillStore();
  // The field is structurally absent from UpsertSkillInput; a caller smuggling it past the type is the
  // exact wire shape a hostile POST/PUT/promote body would take.
  store.upsert({
    id: 'smuggle-clear', name: 'Smuggle Clear', description: 'd', body: 'b\n', origin: 'assistant',
    autonomyCleared: true,
  } as unknown as UpsertInput);
  assert.equal(store.get('smuggle-clear')?.autonomyCleared, undefined, 'the in-memory record never gained the flag');
  assert.ok(!('autonomyCleared' in rawRecord('smuggle-clear')), 'the persisted bytes lack the key entirely');
  // Same on a patch of an existing record.
  store.upsert({
    id: 'smuggle-clear', name: 'Smuggle Clear', description: 'd', body: 'b2\n', autonomyCleared: true,
  } as unknown as UpsertInput);
  assert.ok(!('autonomyCleared' in rawRecord('smuggle-clear')), 'a smuggled patch key never lands either');
});

test('setAutonomyCleared: assistant-origin only, survives a reload, moves neither version nor hash', () => {
  const store = new SkillStore();
  const a = store.upsert({ id: 'clear-me', name: 'Clear Me', description: 'd', body: 'B\n', origin: 'assistant' });
  const rec = store.setAutonomyCleared('clear-me', true);
  assert.equal(rec.autonomyCleared, true);
  assert.equal(rec.version, a.version, 'a flag flip never bumps the version');
  assert.equal(rec.contentHash, a.contentHash, 'clearance is governance — excluded from the hash');
  // The M6 strip-trap round-trip: a fresh store over the same CT_HOME must keep the key (the schema
  // line is load-bearing; unlisted ⇒ silently stripped on load).
  const reloaded = new SkillStore();
  assert.equal(reloaded.get('clear-me')?.autonomyCleared, true, 'the flag survives a fresh load');
  // Refusals: non-assistant origin (bytes untouched) and unknown id.
  store.upsert({ id: 'op-owned', name: 'Op Owned', description: 'd', body: 'b\n', origin: 'operator' });
  const before = readFileSync(paths.skills, 'utf8');
  assert.throws(() => store.setAutonomyCleared('op-owned', true), /only assistant-authored/);
  assert.equal(readFileSync(paths.skills, 'utf8'), before, 'a refused flip writes nothing');
  assert.throws(() => store.setAutonomyCleared('no-such-skill', true), /unknown skill/);
  // cleared:false DELETES the key — absent is the one canonical uncleared form.
  store.setAutonomyCleared('clear-me', false);
  assert.ok(!('autonomyCleared' in rawRecord('clear-me')), 'clearing to false removes the key from the bytes');
});

test('clearance reset is hash-keyed: a content change drops it; identical content and setEnabled keep it', () => {
  const store = new SkillStore();
  store.upsert({ id: 'reset-me', name: 'Reset Me', description: 'd', body: 'V1\n', origin: 'assistant', tags: ['t'] });
  store.setAutonomyCleared('reset-me', true);
  // A byte-identical re-put keeps the attestation — it was cleared for exactly these bytes.
  const same = store.upsert({ id: 'reset-me', name: 'Reset Me', description: 'd', body: 'V1\n', tags: ['t'] });
  assert.equal(same.autonomyCleared, true, 'identical content keeps clearance');
  // setEnabled is a governance flip, not content — clearance survives.
  assert.equal(store.setEnabled('reset-me', false).autonomyCleared, true, 'setEnabled never churns clearance');
  // ANY content change (a promote-update included — it rides this same upsert) drops it.
  const changed = store.upsert({ id: 'reset-me', name: 'Reset Me', description: 'd', body: 'V2\n', tags: ['t'] });
  assert.equal(changed.autonomyCleared, undefined, 'a content change resets to interactive-only');
  assert.ok(!('autonomyCleared' in rawRecord('reset-me')), 'the reset reaches the persisted bytes');
});

// ---- SPEC-SKILLS Phase 5b wave 2 — version history: swap-riding snapshots, retention, rollback ----

test('history: a content change snapshots the SUPERSEDED version; flag flips and identical re-puts add nothing', () => {
  const store = new SkillStore();
  store.upsert({ id: 'hist', name: 'Hist', description: 'd', body: 'v1\n', origin: 'assistant' });
  const hdir = join(paths.skillsData, 'hist', 'history');
  assert.equal(existsSync(hdir), false, 'a create has no prior — no history dir');
  store.upsert({ id: 'hist', name: 'Hist', description: 'd', body: 'v2\n' });
  const v1 = JSON.parse(readFileSync(join(hdir, 'v1.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(v1.version, 1);
  assert.equal(v1.body, 'v1\n', 'the snapshot carries the PRIOR body, not the new one');
  assert.equal(v1.origin, 'assistant');
  store.upsert({ id: 'hist', name: 'Hist', description: 'd', body: 'v3\n' });
  assert.deepEqual(readdirSync(hdir).sort(), ['v1.json', 'v2.json']);
  // Flag flips never reach buildAndStage; a content-identical re-put changes no hash — none may spam
  // an entry (and the identical re-put still bumps version, so later snapshot names stay unique).
  store.setEnabled('hist', false);
  store.setAutonomyCleared('hist', true);
  store.upsert({ id: 'hist', name: 'Hist', description: 'd', body: 'v3\n' });
  assert.deepEqual(readdirSync(hdir).sort(), ['v1.json', 'v2.json'], 'no entry without a content change');
  // listHistory: newest first, META only (bodyBytes, never the body).
  const metas = store.listHistory('hist');
  assert.deepEqual(metas.map((m) => m.version), [2, 1]);
  assert.equal('body' in metas[0]!, false, 'the META list carries no body');
  assert.equal(metas[1]!.bodyBytes, 3);
  assert.equal(store.getHistoryEntry('hist', 2)?.body, 'v2\n', 'the full entry round-trips the body');
  // A torn entry is skipped alone — the rest of the history still lists.
  writeFileSync(join(hdir, 'v1.json'), '{ torn');
  assert.deepEqual(store.listHistory('hist').map((m) => m.version), [2], 'an unreadable entry drops alone');
});

test('history retention: the newest 20 snapshots are kept, the oldest pruned inside the swap', () => {
  const store = new SkillStore();
  store.upsert({ id: 'ret', name: 'Ret', description: 'd', body: 'b0\n' });
  for (let i = 1; i <= 21; i++) store.upsert({ id: 'ret', name: 'Ret', description: 'd', body: `b${i}\n` });
  const names = readdirSync(join(paths.skillsData, 'ret', 'history'));
  assert.equal(names.length, 20, 'retention holds at 20');
  assert.equal(names.includes('v1.json'), false, 'the oldest snapshot was pruned');
  assert.equal(names.includes('v2.json'), true);
  assert.equal(names.includes('v21.json'), true, 'the newest snapshot is present');
});

test('rollback restores prose+body as a FORWARD upsert: governance preserved, clearance dropped, history append-only', () => {
  const store = new SkillStore();
  store.upsert({
    id: 'rb', name: 'RB One', description: 'first', body: 'B1\n', trigger: 'when one', tags: ['one'],
    origin: 'assistant', invocation: { user: true, model: 'suggest' }, gate: { mode: 'advisory' },
  });
  store.upsert({ id: 'rb', name: 'RB Two', description: 'second', body: 'B2\n', trigger: 'when two', tags: ['two'] });
  store.setAutonomyCleared('rb', true);
  const rolled = store.rollback('rb', 1);
  assert.equal(rolled.version, 3, 'rollback is a forward upsert, never a rewrite');
  assert.equal(store.getBody('rb'), 'B1\n');
  assert.equal(rolled.name, 'RB One');
  assert.equal(rolled.description, 'first');
  assert.equal(rolled.trigger, 'when one', 'prose is fully replaced from the snapshot');
  assert.deepEqual(rolled.tags, ['one']);
  assert.deepEqual(rolled.invocation, { user: true, model: 'suggest' }, 'invocation is patch-preserved');
  assert.deepEqual(rolled.gate, { mode: 'advisory' }, 'gate is patch-preserved');
  assert.equal(rolled.origin, 'assistant', 'origin stays immutable');
  assert.equal(rolled.autonomyCleared, undefined, 'the content change dropped clearance');
  assert.equal(rolled.contentHash, store.getHistoryEntry('rb', 1)?.contentHash, 'same content, same frozen hash');
  assert.equal(store.getHistoryEntry('rb', 2)?.body, 'B2\n', 'the pre-rollback state became a history entry itself');
  // Unknown version/id throw and move nothing.
  assert.throws(() => store.rollback('rb', 99), /unknown history version/);
  assert.throws(() => store.rollback('no-such', 1), /unknown skill/);
  assert.equal(store.get('rb')!.version, 3, 'a refused rollback moved nothing');
});

test('history rides every asset mode and survives boot recovery; a crash-shaped stage leftover is swept', () => {
  const store = new SkillStore();
  store.upsert({ id: 'hm', name: 'HM', description: 'd', body: 'a1\n', assets: [{ relPath: 'f.txt', content: 'x' }] });
  store.upsert({ id: 'hm', name: 'HM', description: 'd', body: 'a2\n' });                                      // keep
  store.upsert({ id: 'hm', name: 'HM', description: 'd', body: 'a3\n', assets: [] });                          // clear
  store.upsert({ id: 'hm', name: 'HM', description: 'd', body: 'a4\n', assets: [{ relPath: 'g.txt', content: 'y' }] }); // replace
  assert.deepEqual(
    readdirSync(join(paths.skillsData, 'hm', 'history')).sort(),
    ['v1.json', 'v2.json', 'v3.json'],
    'the carry never depends on asset semantics',
  );
  // A crash-shaped `.stage` leftover carrying a history dir is swept on boot; live history intact.
  const stray = join(paths.skillsData, '.stage.hm.999-zzzz');
  mkdirSync(join(stray, 'history'), { recursive: true });
  writeFileSync(join(stray, 'history', 'v9.json'), '{}');
  const reloaded = new SkillStore();
  assert.equal(existsSync(stray), false, 'the stage leftover is swept');
  assert.deepEqual(reloaded.listHistory('hm').map((m) => m.version), [3, 2, 1], 'live history intact after recovery');
});

test('a recreated id never inherits a dead incarnation\'s history (a leftover dir is discarded on create)', () => {
  const store = new SkillStore();
  // A skill dir that outlived its record (a quarantined index, or remove()'s rmSync failing): body
  // plus stale snapshots, with NO entry in skills.json.
  const leftover = join(paths.skillsData, 'ghost');
  mkdirSync(join(leftover, 'history'), { recursive: true });
  writeFileSync(join(leftover, 'body.md'), 'DEAD\n');
  writeFileSync(join(leftover, 'history', 'v5.json'), JSON.stringify({
    version: 5, contentHash: 'x'.repeat(64), name: 'Ghost', description: 'd',
    origin: 'operator', body: 'DEAD v5\n', ts: new Date().toISOString(),
  }));
  const made = store.upsert({ id: 'ghost', name: 'Ghost', description: 'd', body: 'NEW\n' });
  assert.equal(made.version, 1, 'a fresh create, not a patch of the dead incarnation');
  assert.deepEqual(store.listHistory('ghost'), [], 'no inherited snapshots');
  assert.equal(existsSync(join(paths.skillsData, 'ghost', 'history')), false, 'the stale history dir did not ride the swap');
  // The first real edit starts history at THIS incarnation's v1 — filenames can never collide with
  // the dead incarnation's.
  store.upsert({ id: 'ghost', name: 'Ghost', description: 'd', body: 'NEW2\n' });
  assert.deepEqual(store.listHistory('ghost').map((m) => m.version), [1]);
  assert.equal(store.getHistoryEntry('ghost', 1)?.body, 'NEW\n');
});

// Root ignores file modes, so the permission simulation below proves nothing there.
const skipAsRoot = typeof process.getuid === 'function' && process.getuid() === 0
  ? 'permission simulation needs a non-root user'
  : false;

test('an unreadable live history dir never blocks a content edit (history is forensic, not load-bearing)', { skip: skipAsRoot }, () => {
  const store = new SkillStore();
  store.upsert({ id: 'hblock', name: 'HB', description: 'd', body: 'x1\n' });
  store.upsert({ id: 'hblock', name: 'HB', description: 'd', body: 'x2\n' }); // snapshot v1 exists
  const hdir = join(paths.skillsData, 'hblock', 'history');
  chmodSync(hdir, 0o000); // the carry's cpSync now fails EACCES
  try {
    const rec = store.upsert({ id: 'hblock', name: 'HB', description: 'd', body: 'x3\n' });
    assert.equal(rec.version, 3, 'the content edit landed despite the unreadable history dir');
    assert.equal(store.getBody('hblock'), 'x3\n', 'the new body is live');
    assert.deepEqual(store.listHistory('hblock'), [], 'the snapshot was lost, tolerantly — never the edit');
  } finally {
    // Unwedge the 000-mode dir wherever the swap left it (the .old removal is best-effort and will
    // have failed on it) so the temp-home cleanup can proceed.
    for (const n of readdirSync(paths.skillsData)) {
      if (!n.startsWith('.old.hblock.')) continue;
      try {
        chmodSync(join(paths.skillsData, n, 'history'), 0o700);
      } catch {
        /* already gone */
      }
    }
    try {
      chmodSync(hdir, 0o700);
    } catch {
      /* replaced by the swap — the live dir has no history now */
    }
  }
});

test('onChange fires exactly once per real mutation and never on a no-op remove', () => {
  let frames = 0;
  const store = new SkillStore({ onChange: () => { frames++; } });
  store.upsert({ id: 'f', name: 'F', description: 'x', body: 'x' });
  assert.equal(frames, 1);
  store.upsert({ id: 'f', name: 'F', description: 'x', body: 'y' });
  assert.equal(frames, 2);
  store.remove('f');
  assert.equal(frames, 3);
  store.remove('f'); // unknown now — no write, no frame
  assert.equal(frames, 3, 'a no-op remove emits nothing');
});

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});
