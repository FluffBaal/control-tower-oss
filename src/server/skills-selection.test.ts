// SPEC-SKILLS Phase 3 — SkillSelectionStore + resolveSkillSelection: the parts a typecheck cannot vouch
// for. Store side: the M6 strip-trap round-trip (an optional field missing from the zod mirror strips on
// load), per-entry salvage, foreign-version refusal + .bak, deletion refusal (referencedBy names the
// project, not merely "throws"), PUT-replace/empty-drops, enable-map fail-closed reject-over-cap, and
// pruneSkill idempotence. Resolver side: the five §2 rules, each row naming the mutant it kills. No
// server, no tmux; CT_HOME is set before paths.js loads (it freezes at import).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill, SkillBundle, ProjectSkills } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-skills-sel-'));
process.env.CT_HOME = home;

const { paths, ensureDirs } = await import('./paths.js');
ensureDirs();
const { SkillStore } = await import('./skills/store.js');
const { SkillSelectionStore, BundleReferencedError, resolveSkillSelection, selectionReplaceDelta } = await import('./skills/selection.js');

// A dedicated selection file per test keeps the hand-written / reload cases isolated.
let seq = 0;
function freshSelPath(): string {
  return join(home, 'config', `sel-${seq++}.json`);
}

// ---- A real skill library, minted through SkillStore so the resolver sees genuine Skill records. ----
const library = new SkillStore();
function seed(over: { id: string; scope?: 'global' | 'project'; enabled?: boolean }): Skill {
  return library.upsert({
    id: over.id,
    name: over.id.toUpperCase(),
    description: `skill ${over.id}`,
    body: `# ${over.id}\n`,
    scope: over.scope ?? 'global',
    enabled: over.enabled ?? true,
    origin: 'operator',
  });
}
seed({ id: 'g1' });
seed({ id: 'g2' });
seed({ id: 'goff', enabled: false });
seed({ id: 'p1', scope: 'project' });
seed({ id: 'p2', scope: 'project' });
const skills = () => library.list();
const idsOf = (entries: { skill: Skill }[]) => entries.map((e) => e.skill.id).sort();

// =====================================================================================
// Store
// =====================================================================================

test('1. bundle + overlay round-trip survives a fresh load with every optional field intact', () => {
  const file = freshSelPath();
  const store = new SkillSelectionStore(file);
  const bundle = store.upsertBundle({ name: 'Docs pack', description: 'docs', skillIds: ['g1', 'p1'] });
  store.setProjectSkills('proj', { bundleId: bundle.id, enable: { g2: true, goff: false } });

  const reloaded = new SkillSelectionStore(file);
  const gotBundle = reloaded.getBundle(bundle.id);
  assert.ok(gotBundle, 'the bundle loaded from disk');
  assert.equal(gotBundle.description, 'docs', 'description round-trips (a stripped optional field would drop it)');
  assert.deepEqual(gotBundle.skillIds, ['g1', 'p1'], 'skillIds round-trip');
  const gotProj = reloaded.getProjectSkills('proj');
  assert.ok(gotProj, 'the project overlay loaded');
  assert.equal(gotProj.bundleId, bundle.id, 'bundleId round-trips');
  assert.deepEqual(gotProj.enable, { g2: true, goff: false }, 'the enable map round-trips both true and false');
});

test('2. per-entry salvage — one bad bundle + one bad project drop alone; the file is NOT rewritten on load', () => {
  const file = freshSelPath();
  const raw = JSON.stringify({
    version: 1,
    bundles: [
      { id: 'good', name: 'Good', skillIds: ['g1'], createdAt: 't', updatedAt: 't' },
      { id: 'bad', name: 42, skillIds: ['g1'], createdAt: 't', updatedAt: 't' }, // name not a string
    ],
    projects: {
      okp: { bundleId: 'good' },
      badp: { enable: 'not-an-object' }, // enable must be a record
    },
  });
  writeFileSync(file, raw);
  const store = new SkillSelectionStore(file);
  assert.deepEqual(store.listBundles().map((b) => b.id), ['good'], 'the valid bundle survives, the bad one drops');
  assert.ok(store.getProjectSkills('okp'), 'the valid project overlay survives');
  assert.equal(store.getProjectSkills('badp'), undefined, 'the bad project overlay dropped');
  assert.equal(readFileSync(file, 'utf8'), raw, 'load did NOT rewrite the file (salvaged-good stays in memory)');
});

test('3. foreign/future version refusal — kept empty, backed up to .bak, never persisted over', () => {
  const file = freshSelPath();
  writeFileSync(file, JSON.stringify({ version: 7, bundles: [{ id: 'x', name: 'X', skillIds: [], createdAt: 't', updatedAt: 't' }] }));
  const store = new SkillSelectionStore(file);
  assert.deepEqual(store.listBundles(), [], 'a future-versioned file loads EMPTY');
  assert.ok(existsSync(`${file}.bak`), 'the original was backed up to .bak');
});

test('4. deleteBundle refuses while referenced (referencedBy NAMES the project), then succeeds once unassigned', () => {
  const file = freshSelPath();
  const store = new SkillSelectionStore(file);
  const bundle = store.upsertBundle({ name: 'Pack', skillIds: ['g1'] });
  store.setProjectSkills('control-tower', { bundleId: bundle.id });

  assert.throws(
    () => store.deleteBundle(bundle.id, (pid) => (pid === 'control-tower' ? 'Control Tower' : undefined)),
    (err: unknown) => {
      assert.ok(err instanceof BundleReferencedError, 'a BundleReferencedError is thrown');
      // A stub error would fail THIS — the message/list must actually name the referencing project.
      assert.ok(err.referencedBy.includes('Control Tower'), 'referencedBy names the project');
      return true;
    },
  );
  assert.ok(store.getBundle(bundle.id), 'the refused delete left the bundle in place');

  // The positive twin (the fixture-lies lesson): once unassigned, the delete really removes it from disk.
  store.setProjectSkills('control-tower', {});
  assert.equal(store.deleteBundle(bundle.id), true, 'the delete succeeds once unreferenced');
  assert.equal(store.getBundle(bundle.id), undefined, 'the bundle is gone in memory');
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { bundles: SkillBundle[] };
  assert.ok(!onDisk.bundles.some((b) => b.id === bundle.id), 'the bundle is gone from the persisted file');
});

test('5. setProjectSkills is a REPLACE — an empty overlay drops the project key from the file (not a patch)', () => {
  const file = freshSelPath();
  const store = new SkillSelectionStore(file);
  store.setProjectSkills('proj', { enable: { g1: false } });
  assert.ok(store.getProjectSkills('proj'), 'the overlay is present after save');

  store.setProjectSkills('proj', {}); // empty = inherit
  assert.equal(store.getProjectSkills('proj'), undefined, 'an empty overlay drops the entry in memory');
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { projects: Record<string, unknown> };
  assert.ok(!('proj' in onDisk.projects), 'the project key is GONE from the persisted file (replace, not patch)');
});

test('6. enable-map hygiene — an unsafe key is dropped; an over-cap map REJECTS (fail-closed, not a clamp)', () => {
  const file = freshSelPath();
  const store = new SkillSelectionStore(file);
  store.setProjectSkills('proj', { enable: { g1: true, '../evil': true, 'Bad Key': false } });
  assert.deepEqual(store.getProjectSkills('proj')?.enable, { g1: true }, 'unsafe keys are filtered, the safe one kept');

  const tooMany: Record<string, boolean> = {};
  for (let i = 0; i < 513; i++) tooMany[`s${i}`] = false;
  // A dropped `false` would silently re-enable a skill — this MUST throw, never clamp.
  assert.throws(() => store.setProjectSkills('proj2', { enable: tooMany }), /too many skill overrides/);
});

test('7. pruneSkill strips enable entries + bundle membership, persists once, and is idempotent', () => {
  const file = freshSelPath();
  const store = new SkillSelectionStore(file);
  const bundle = store.upsertBundle({ name: 'Pack', skillIds: ['g1', 'g2'] });
  store.setProjectSkills('proj', { enable: { g1: false, g2: true } });

  assert.equal(store.pruneSkill('g1'), true, 'the first prune reports a change');
  assert.ok(!store.getBundle(bundle.id)!.skillIds.includes('g1'), 'g1 is stripped from the bundle');
  assert.deepEqual(store.getProjectSkills('proj')?.enable, { g2: true }, "g1's enable entry (a false) is swept");
  assert.equal(store.pruneSkill('g1'), false, 'a second prune of the same id reports no change (idempotent)');
});

// =====================================================================================
// Resolver (resolveSkillSelection) — one test per §2 rule
// =====================================================================================

function bundle(skillIds: string[], name = 'B', id = 'b'): SkillBundle {
  return { id, name, skillIds, createdAt: 't', updatedAt: 't' };
}

test('8. baseline identity — global-enabled in (source global), disabled + project-scope out; matches the pre-Phase-3 filter', () => {
  const { entries, warnings } = resolveSkillSelection(skills());
  assert.deepEqual(idsOf(entries), ['g1', 'g2'], 'exactly the enabled global skills');
  assert.ok(entries.every((e) => e.source === 'global'), 'every baseline entry is source:global');
  assert.deepEqual(warnings, [], 'no warnings for the clean baseline');
  // The identity the §5 refactor keys on: this set equals the old inline filter.
  const preFilter = skills().filter((s) => s.enabled && s.scope === 'global').map((s) => s.id).sort();
  assert.deepEqual(idsOf(entries), preFilter, 'the resolved set equals enabled ∧ scope-global');
});

test('9. a bundle adds a project-scope skill (source bundle); a global member upgrades provenance, set unchanged', () => {
  const sel = { bundle: bundle(['p1', 'g1']) as SkillBundle, project: { bundleId: 'b' } as ProjectSkills };
  const { entries } = resolveSkillSelection(skills(), sel);
  assert.deepEqual(idsOf(entries), ['g1', 'g2', 'p1'], 'the set gains p1; g1/g2 unchanged');
  const byId = new Map(entries.map((e) => [e.skill.id, e.source]));
  assert.equal(byId.get('p1'), 'bundle', 'p1 is source:bundle (a set mutant fails the set assert above)');
  assert.equal(byId.get('g1'), 'bundle', "g1's provenance UPGRADED to bundle (a provenance-only mutant fails here)");
  assert.equal(byId.get('g2'), 'global', 'g2 stays source:global');
});

test('10. enable:false removes a global; enable:true adds a project-scope; enable:true on a disabled skill does NOT add', () => {
  const project = { enable: { g1: false, p2: true, goff: true } } as ProjectSkills;
  const { entries } = resolveSkillSelection(skills(), { project });
  const set = idsOf(entries);
  assert.ok(!set.includes('g1'), 'enable:false removed the global g1');
  assert.ok(set.includes('p2'), 'enable:true added the project-scope p2');
  const byId = new Map(entries.map((e) => [e.skill.id, e.source]));
  assert.equal(byId.get('p2'), 'project', 'the added project-scope skill is source:project');
  // The fail-closed mutant killer: flip §2 rule 4 and goff would appear.
  assert.ok(!set.includes('goff'), 'enable:true on a library-DISABLED skill does not resurrect it (master switch wins)');
});

test('11. dangling bundle member + dangling bundleId + unknown enable:true all warn (ids in the message), entries absent', () => {
  const danglingBundle = resolveSkillSelection(skills(), { bundle: bundle(['nope'], 'Pack') as SkillBundle, project: { bundleId: 'b' } as ProjectSkills });
  assert.ok(danglingBundle.warnings.some((w) => w.includes('nope') && w.includes('Pack')), 'a dangling member warns with its id + bundle name');
  assert.ok(!idsOf(danglingBundle.entries).includes('nope'), 'the dangling member is not an entry');

  const danglingBundleId = resolveSkillSelection(skills(), { project: { bundleId: 'ghost' } as ProjectSkills });
  assert.ok(danglingBundleId.warnings.some((w) => w.includes('ghost')), 'a selected-but-missing bundle warns with its id');
  assert.deepEqual(idsOf(danglingBundleId.entries), ['g1', 'g2'], 'a missing bundle falls back to the global set');

  const unknownEnable = resolveSkillSelection(skills(), { project: { enable: { phantom: true } } as ProjectSkills });
  assert.ok(unknownEnable.warnings.some((w) => w.includes('phantom')), 'enable:true on an unknown id warns with the id');
  assert.ok(!idsOf(unknownEnable.entries).includes('phantom'), 'no entry for the unknown id');
});

// =====================================================================================
// Replace-delta views (SPEC-SKILLS Phase 5b wave 2 — the selection-side retype gate)
// =====================================================================================
// The protected fixtures are seeded INSIDE test 12 (not at module top level) so the baseline
// assertions in tests 8-11 — which run first and pin the exact global set — never see them.

test('12. selectionReplaceDelta: dropped vs droppedProtected split, name-sorted; an add-only replace yields empty lists', () => {
  library.upsert({ id: 'lock1', name: 'B LOCK', description: 'd', body: 'x\n', protected: true });
  library.upsert({ id: 'gate1', name: 'A GATE', description: 'd', body: 'x\n', gate: { mode: 'blocking' } });
  const delta = selectionReplaceDelta(skills(), {}, { project: { enable: { lock1: false, gate1: false, g1: false } } });
  assert.deepEqual(delta.droppedProtected, ['A GATE', 'B LOCK'], 'both protection flavors (lock + blocking gate), name-sorted');
  assert.deepEqual(delta.dropped, ['A GATE', 'B LOCK', 'G1'], 'dropped names ALL leavers, the unprotected one included');
  const addOnly = selectionReplaceDelta(skills(), {}, { project: { enable: { p1: true } } });
  assert.deepEqual(addOnly, { dropped: [], droppedProtected: [] }, 'an add-only replace drops nothing');
});

test('13. projectReplaceDelta diffs the SANITIZED overlay — a coercible enable value cannot slip a protected drop past the gate', () => {
  const store = new SkillSelectionStore(freshSelPath());
  // A truthy non-boolean like 'no' resolves as ON over the raw overlay (no drop seen) but PERSISTS as
  // false (a real drop, sanitizeEnable's `=== true`) — the delta must see the persisted form, or the
  // gate and the write disagree and the retype is bypassable.
  const coerced = store.projectReplaceDelta(skills(), 'proj', { enable: { gate1: 'no' as unknown as boolean } });
  assert.deepEqual(coerced.droppedProtected, ['A GATE'], 'the falsy-persisting wire value gates');
  // The honest-boolean twin and the enable:true negative pin the rule to the persisted polarity.
  assert.deepEqual(store.projectReplaceDelta(skills(), 'proj', { enable: { gate1: false } }).droppedProtected, ['A GATE']);
  assert.deepEqual(store.projectReplaceDelta(skills(), 'proj', { enable: { gate1: true } }).droppedProtected, []);
  // It throws exactly where the write would (fail-closed parity with setProjectSkills).
  assert.throws(() => store.projectReplaceDelta(skills(), 'proj', { bundleId: 5 as unknown as string }), /bundleId must be a string/);
});

test('14. bundleReplaceDelta + projectsSelectingBundle: a member removal gates only where the skill actually leaves an effective set', () => {
  library.upsert({ id: 'pp1', name: 'PP GATE', description: 'd', body: 'x\n', scope: 'project', gate: { mode: 'blocking' } });
  const store = new SkillSelectionStore(freshSelPath());
  const b = store.upsertBundle({ name: 'Gate Pack', skillIds: ['pp1', 'gate1'] });
  store.setProjectSkills('alpha', { bundleId: b.id });
  store.setProjectSkills('beta', { bundleId: b.id });
  store.setProjectSkills('gamma', { enable: { g1: false } }); // a non-selecting overlay stays out of the blast radius
  assert.deepEqual(store.projectsSelectingBundle(b.id).sort(), ['alpha', 'beta']);
  // Removing the project-scope protected member drops it from BOTH selecting projects.
  const gated = store.bundleReplaceDelta(skills(), b.id, ['gate1'], (pid) => pid.toUpperCase());
  assert.deepEqual(gated.droppedProtected, ['PP GATE']);
  assert.deepEqual(gated.affectedProjects.sort(), ['ALPHA', 'BETA'], 'affected projects are name-resolved');
  // Removing the GLOBAL protected member gates nothing — it stays effective via the baseline
  // (the gate keys on the EFFECTIVE set, not on bundle membership).
  assert.deepEqual(store.bundleReplaceDelta(skills(), b.id, ['pp1']), { droppedProtected: [], affectedProjects: [] });
  // An omitted member list IS the empty-the-bundle replace upsertBundle would persist — it gates too.
  assert.deepEqual(store.bundleReplaceDelta(skills(), b.id, undefined).droppedProtected, ['PP GATE']);
  // A bundle no project selects never gates.
  const lonely = store.upsertBundle({ name: 'Lonely', skillIds: ['pp1'] });
  assert.deepEqual(store.bundleReplaceDelta(skills(), lonely.id, []), { droppedProtected: [], affectedProjects: [] });
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
