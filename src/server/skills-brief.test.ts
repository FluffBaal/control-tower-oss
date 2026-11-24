// SPEC-SKILLS per-project delivery — the brief renderer (skills/brief.ts): the pure half of the
// sortie-brief channel. Each case names the mutation that kills it (the mutation-meaningful posture),
// and every negative-space assertion carries a positive control so an accidentally-empty brief can
// never masquerade as a working exclusion. Real Skill records minted through SkillStore + a real
// SkillSelectionStore resolution, so the filter runs against genuine resolved entries — no
// hand-rolled lookalike fixtures. No server, no tmux; CT_HOME is set before paths.js loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill, ProviderId } from '../shared/types.js';
import type { UpsertSkillInput } from './skills/store.js';

const home = mkdtempSync(join(tmpdir(), 'ct-skills-brief-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { SkillStore, centralBodyPath, centralAssetsDir } = await import('./skills/store.js');
const { SkillSelectionStore } = await import('./skills/selection.js');
const { renderSkillBrief, briefDeliverable } = await import('./skills/brief.js');
const { SECTION_BUDGET_BYTES, SECTION_HARD_CEILING } = await import('./skills/sections.js');

const library = new SkillStore();
let selSeq = 0;
/** A fresh selection store per test so overlays never bleed across cases. */
function freshSelection() {
  return new SkillSelectionStore(join(home, 'config', `sel-${selSeq++}.json`));
}
function seed(over: Partial<UpsertSkillInput> & { id: string }): Skill {
  return library.upsert({
    name: over.id.toUpperCase(),
    description: `does the ${over.id} thing`,
    body: `# ${over.id}\nbody of ${over.id}\n`,
    scope: 'project',
    origin: 'operator',
    ...over,
  });
}
/** Resolve a project's effective set the way production does, then render its brief. */
function briefFor(
  sel: InstanceType<typeof SkillSelectionStore>,
  projectId: string,
  provider: ProviderId = 'claude-code',
  excludeUncleared = false,
) {
  return renderSkillBrief(sel.resolveForProject(library.list(), projectId).entries, provider, excludeUncleared);
}
const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

test('1. a per-project skill reaches the brief and points at the CENTRAL body path', () => {
  // Kills: dropping the render, the header, or deriving the pointer from anything but the store's
  // own path site (a materialized-dir path or a literal `~` would both fail the exact-path check).
  seed({ id: 'brief-a1', trigger: 'when asked to a1' });
  const sel = freshSelection();
  sel.setProjectSkills('proj-1', { enable: { 'brief-a1': true } });
  const brief = briefFor(sel, 'proj-1');
  assert.ok(brief.text, 'a selected per-project skill renders a brief');
  assert.match(brief.text, /^Project skills for this task \(not preinstalled; read the body file before using one\):\n\n/);
  assert.ok(brief.text.includes('BRIEF-A1'), 'the display name is present');
  assert.ok(brief.text.includes(`Body: ${centralBodyPath('brief-a1')}`), 'the central body path is the pointer');
  assert.ok(centralBodyPath('brief-a1').startsWith('/'), 'the path is absolute and expanded, never a literal ~');
  assert.ok(brief.text.includes('Use when: when asked to a1'), 'the trigger rides as one clamped line');
  assert.equal(brief.counts.entries, 1);
  assert.equal(brief.hasUncleared, false);
});

test('2. a GLOBAL skill is NOT in the brief (it rides the configDir channel) — with positive control', () => {
  // Kills: filtering on the wrong predicate (e.g. resolution `source` instead of `scope` — the exact
  // trap the projectSkillsView comment documents: a global bundle member has source 'bundle').
  seed({ id: 'brief-g2', scope: 'global' });
  seed({ id: 'brief-p2' });
  const sel = freshSelection();
  sel.setProjectSkills('proj-2', { enable: { 'brief-p2': true } });
  const brief = briefFor(sel, 'proj-2');
  assert.ok(brief.text);
  assert.ok(brief.text.includes(centralBodyPath('brief-p2')));
  assert.ok(!brief.text.includes('brief-g2'), 'the global skill is not double-delivered');
  assert.equal(briefDeliverable(library.get('brief-g2')!, 'claude-code'), false);
  // Positive control: the SAME skill re-scoped to 'project' (and selected) appears — proving the
  // exclusion above keyed on scope, not on some accident of the fixture.
  seed({ id: 'brief-g2', scope: 'project' });
  sel.setProjectSkills('proj-2', { enable: { 'brief-p2': true, 'brief-g2': true } });
  const brief2 = briefFor(sel, 'proj-2');
  assert.ok(brief2.text?.includes(centralBodyPath('brief-g2')), 'the re-scoped control appears');
});

test('3. provider eligibility filters the brief — counted, with positive control', () => {
  // Kills: dropping the providerEligible leg (a claude-only skill would leak into a codex pane), or
  // skipping it silently (the no-silent-skips posture: every non-kept path lands in a counter).
  seed({ id: 'brief-cl3', supportedProviders: ['claude-code'] });
  const sel = freshSelection();
  sel.setProjectSkills('proj-3', { enable: { 'brief-cl3': true } });
  const codex = briefFor(sel, 'proj-3', 'codex');
  assert.equal(codex.text, undefined, 'a claude-only skill renders NO codex brief');
  assert.equal(codex.counts.skippedIneligible, 1, 'the ineligible skip is counted, never silent');
  const cl = briefFor(sel, 'proj-3', 'claude-code');
  assert.ok(cl.text?.includes(centralBodyPath('brief-cl3')), 'positive control: the declared provider gets it');
  assert.equal(cl.counts.skippedIneligible, 0);
});

test('4. a model:never per-project skill is excluded (no enforcement surface in pane text) — counted, with control', () => {
  // Kills: dropping the user-only rule (pane text cannot enforce "never self-invoke").
  seed({ id: 'brief-nv4', invocation: { user: true, model: 'never' } });
  seed({ id: 'brief-ok4' });
  const sel = freshSelection();
  sel.setProjectSkills('proj-4', { enable: { 'brief-nv4': true, 'brief-ok4': true } });
  const brief = briefFor(sel, 'proj-4');
  assert.ok(brief.text);
  assert.ok(!brief.text.includes('brief-nv4'), 'the user-only skill is not delivered');
  assert.equal(brief.counts.skippedUnsupported, 1, 'the skip is counted, never silent');
  // Positive control: flip the field and it appears.
  seed({ id: 'brief-nv4', invocation: { user: true, model: 'auto' } });
  const brief2 = briefFor(sel, 'proj-4');
  assert.ok(brief2.text, 'the control renders');
  assert.ok(brief2.text.includes(centralBodyPath('brief-nv4')));
  assert.equal(brief2.counts.skippedUnsupported, 0);
});

test('5. clearance: an uncleared assistant skill is excluded from a bypass brief, kept (and flagged) interactively', () => {
  // Kills: dropping excludeUncleared, wiring it backwards, or forgetting the hasUncleared belt flag.
  seed({ id: 'brief-as5', origin: 'assistant' });
  seed({ id: 'brief-op5' });
  const sel = freshSelection();
  sel.setProjectSkills('proj-5', { enable: { 'brief-as5': true, 'brief-op5': true } });

  const bypassBrief = briefFor(sel, 'proj-5', 'claude-code', true);
  assert.ok(bypassBrief.text, 'the operator skill still renders (the exclusion is per-skill, not all-or-nothing)');
  assert.ok(!bypassBrief.text.includes('brief-as5'), 'the uncleared assistant skill never reaches a bypass brief');
  assert.equal(bypassBrief.counts.skippedUncleared, 1);
  assert.equal(bypassBrief.hasUncleared, false);
  assert.deepEqual(bypassBrief.assistantIds, [], 'no assistant skill delivered ⇒ nothing for the live re-check');

  const interactive = briefFor(sel, 'proj-5', 'claude-code', false);
  assert.ok(interactive.text, 'the interactive brief renders');
  assert.ok(interactive.text.includes(centralBodyPath('brief-as5')), 'an interactive builder keeps it');
  assert.equal(interactive.hasUncleared, true, 'and the belt flag marks the brief');
  assert.deepEqual(interactive.assistantIds, ['brief-as5'], 'the delivered assistant skill is listed for the re-check');

  // Positive control: clearance flips the bypass outcome — proving the exclusion observed the flag.
  library.setAutonomyCleared('brief-as5', true);
  const cleared = briefFor(sel, 'proj-5', 'claude-code', true);
  assert.ok(cleared.text, 'the cleared bypass brief renders');
  assert.ok(cleared.text.includes(centralBodyPath('brief-as5')), 'a CLEARED assistant skill reaches a bypass brief');
  assert.equal(cleared.hasUncleared, false);
  assert.equal(cleared.counts.skippedUncleared, 0);
  assert.deepEqual(cleared.assistantIds, ['brief-as5'], 'a cleared bypass delivery lists the id for the inject-time re-check');
  library.setAutonomyCleared('brief-as5', false);
});

test('6. the {{skillDir}} asset remap line appears ONLY for asset-bearing skills', () => {
  // Kills: emitting the remap unconditionally (noise) or never (an asset-using body silently breaks).
  seed({ id: 'brief-at6', assets: [{ relPath: 'helper.sh', content: '#!/bin/sh\n' }] });
  seed({ id: 'brief-na6' });
  const sel = freshSelection();
  sel.setProjectSkills('proj-6', { enable: { 'brief-at6': true, 'brief-na6': true } });
  const brief = briefFor(sel, 'proj-6');
  assert.ok(brief.text);
  assert.ok(
    brief.text.includes(`Assets: ${centralAssetsDir('brief-at6')}/ — any {{skillDir}}/X in the body means that dir's X`),
    'the asset-bearing entry carries the exact central-assets remap',
  );
  assert.ok(brief.text.includes(centralBodyPath('brief-na6')), 'the asset-less entry is still delivered');
  assert.ok(!brief.text.includes(centralAssetsDir('brief-na6')), 'but carries no remap line');
});

test('7a. over-budget: entries fold WHOLE to pointer lines, the blocking gate line survives', () => {
  // Kills: naive truncation (a torn entry), or a fold that drops a gate line.
  const sel = freshSelection();
  const enable: Record<string, boolean> = {};
  for (let i = 0; i < 25; i++) {
    const id = `brief-fat7a-${i}`;
    seed({ id, description: `fat ${i} ${'d'.repeat(280)}` });
    enable[id] = true;
  }
  seed({ id: 'brief-gate7a', gate: { mode: 'blocking', blocks: ['commit'] } });
  enable['brief-gate7a'] = true;
  sel.setProjectSkills('proj-7a', { enable });
  const brief = briefFor(sel, 'proj-7a');
  assert.ok(brief.text);
  const header = brief.text.split('\n\n')[0]!;
  assert.ok(byteLen(brief.text) <= SECTION_BUDGET_BYTES + byteLen(header) + 2, 'the folded body honors the soft budget');
  assert.match(brief.text, /BLOCKING gate: before any commit, run the `brief-gate7a` skill/, 'the gate line survives the fold');
  // Every entry is present exactly once — whole (Body: <path>) or folded (see <path>) — never torn.
  for (let i = 0; i < 25; i++) {
    const p = centralBodyPath(`brief-fat7a-${i}`);
    assert.equal(brief.text.split(p).length - 1, 1, `entry ${i} appears exactly once, whole or as a pointer`);
  }
  assert.ok(brief.text.includes('see '), 'at least some entries folded to pointer lines (the fixture overflows)');
});

test('7b. a runaway roster is SUMMARIZED honestly under the hard ceiling — "…and N more" names the exact count', () => {
  // Kills: an unbounded brief, or a summary that miscounts what it dropped.
  const sel = freshSelection();
  const enable: Record<string, boolean> = {};
  const total = 120;
  for (let i = 0; i < total; i++) {
    const id = `brief-huge7b-${i}`;
    seed({ id, name: `HUGE-${i}-${'n'.repeat(80)}`, description: `huge ${i} ${'d'.repeat(280)}` });
    enable[id] = true;
  }
  seed({ id: 'brief-gate7b', gate: { mode: 'blocking', blocks: ['push'], rerunOnNewDiff: true } });
  enable['brief-gate7b'] = true;
  sel.setProjectSkills('proj-7b', { enable });
  const brief = briefFor(sel, 'proj-7b');
  assert.ok(brief.text);
  const header = brief.text.split('\n\n')[0]!;
  assert.ok(byteLen(brief.text) <= SECTION_HARD_CEILING + byteLen(header) + 2, 'the hard ceiling holds');
  assert.match(brief.text, /BLOCKING gate: before any push, run the `brief-gate7b` skill/, 'the gate line is never a fold casualty');
  const m = /…and (\d+) more/.exec(brief.text);
  assert.ok(m, 'the tail is an explicit summary, not a silent drop');
  let present = 0;
  for (let i = 0; i < total; i++) {
    if (brief.text.includes(centralBodyPath(`brief-huge7b-${i}`))) present++;
  }
  if (brief.text.includes(centralBodyPath('brief-gate7b'))) present++;
  assert.equal(present + Number(m![1]), total + 1, 'kept entries + the summarized count = the full roster');
});

test('8. a custom provider gets NO brief (fail-closed, matching both existing channels) — counted', () => {
  seed({ id: 'brief-cu8' });
  const sel = freshSelection();
  sel.setProjectSkills('proj-8', { enable: { 'brief-cu8': true } });
  const brief = briefFor(sel, 'proj-8', 'custom:mytool' as ProviderId);
  assert.equal(brief.text, undefined);
  assert.equal(brief.counts.skippedIneligible, 1, 'no channel ⇒ ineligible, and the skip is counted');
});

test('9. no per-project selection ⇒ NO brief text (the byte-zero default) — the counts still come back', () => {
  // Kills: accidental always-on header noise in every loop prompt, or an empty render that discards
  // its counts (the caller audits whenever it gets a brief, text or not — the all-filtered case is
  // exactly where skippedUncleared matters).
  const sel = freshSelection();
  const none = briefFor(sel, 'proj-none');
  assert.equal(none.text, undefined, 'an overlay-less project renders nothing');
  assert.deepEqual(none.assistantIds, []);
  assert.deepEqual(none.counts, {
    entries: 0, gated: 0, skippedUncleared: 0, skippedUnsupported: 0, skippedIneligible: 0, skippedProviderBody: 0,
  });
  // A selection that resolves to globals only is identical to none (globals ride the configDir).
  seed({ id: 'brief-gl9', scope: 'global' });
  sel.setProjectSkills('proj-9', { enable: { 'brief-gl9': true } });
  const globalsOnly = briefFor(sel, 'proj-9');
  assert.equal(globalsOnly.text, undefined, 'a globals-only selection renders nothing');
  assert.equal(globalsOnly.counts.skippedIneligible, 0, 'global is disjoint-by-design, never a counted skip');
});

test('10. a per-provider body override is NOT brief-delivered (the pointer names the BASE body) — counted, with controls', () => {
  // Kills: pointing an overridden provider at the base body.md — the configDir channel substitutes
  // the variant, but the brief has no on-disk file for it, so delivering the pointer would hand this
  // provider the WRONG content. Also kills a silent skip, and any drift from the single-source
  // predicate the server's `delivered` flag reads.
  seed({ id: 'brief-ov10', providerOverrides: { codex: { body: '# codex variant\n' } } });
  const sel = freshSelection();
  sel.setProjectSkills('proj-10', { enable: { 'brief-ov10': true } });
  const codex = briefFor(sel, 'proj-10', 'codex');
  assert.equal(codex.text, undefined, 'the overridden provider gets NO pointer to the wrong body');
  assert.equal(codex.counts.skippedProviderBody, 1, 'the fail-safe skip is counted, never silent');
  assert.equal(briefDeliverable(library.get('brief-ov10')!, 'codex'), false, 'the single-source predicate agrees');
  // Positive controls: the un-overridden provider still gets the base body; an omit-only override
  // stays on the eligibility leg (providerEligible already handles omit), not this counter.
  const cl = briefFor(sel, 'proj-10', 'claude-code');
  assert.ok(cl.text?.includes(centralBodyPath('brief-ov10')), 'an un-overridden provider is untouched');
  assert.equal(briefDeliverable(library.get('brief-ov10')!, 'claude-code'), true);
  seed({ id: 'brief-om10', providerOverrides: { codex: { omit: true } } });
  sel.setProjectSkills('proj-10', { enable: { 'brief-ov10': true, 'brief-om10': true } });
  const omitted = briefFor(sel, 'proj-10', 'codex');
  assert.equal(omitted.counts.skippedIneligible, 1, 'omit rides the eligibility counter');
  assert.equal(omitted.counts.skippedProviderBody, 1);
});

test('11. the per-reason counters stay EQUIVALENT to briefDeliverable (the single-source pin)', () => {
  // Kills: a drift where the render loop and the server's `delivered` flag disagree — a skill counted
  // as skipped here but reported delivered there (or kept here while shown undelivered). For every
  // non-global skill: kept ⟺ briefDeliverable, and a non-kept skill lands in exactly ONE counter.
  const variants = [
    seed({ id: 'brief-eq11-a' }),
    seed({ id: 'brief-eq11-b', supportedProviders: ['claude-code'] }),
    seed({ id: 'brief-eq11-c', invocation: { user: true, model: 'never' } }),
    seed({ id: 'brief-eq11-d', providerOverrides: { codex: { body: '# variant\n' } } }),
    seed({ id: 'brief-eq11-e', providerOverrides: { codex: { omit: true } } }),
  ];
  for (const provider of ['claude-code', 'codex'] as ProviderId[]) {
    for (const skill of variants) {
      const single = renderSkillBrief([{ skill }], provider, false);
      const kept = single.text !== undefined;
      assert.equal(kept, briefDeliverable(skill, provider), `${skill.id}/${provider}: the render agrees with the predicate`);
      const skips = single.counts.skippedIneligible + single.counts.skippedUnsupported + single.counts.skippedProviderBody;
      assert.equal(skips, kept ? 0 : 1, `${skill.id}/${provider}: exactly one counter per non-kept skill`);
    }
  }
});

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
});
