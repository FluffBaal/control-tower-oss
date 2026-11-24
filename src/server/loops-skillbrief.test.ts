// SPEC-SKILLS per-project delivery — the loop-side half of the sortie-brief channel: the create-time
// compute (keyed on the terminal's server-resolved autoAccept), the frozen record + M6 strip-trap
// round-trip, the composeIterationPrompt assembly order, the inject-time clearance belt, the
// mission-sortie funnel, and the create-failure containment (a brief compute throw must never leak
// the already-spawned builder terminal). Real Store + real Loops with a stubbed terminal-manager and
// the REAL production closure shape (resolveForProject → renderSkillBrief) — the
// missions-capwait/firstinject harness pattern. No tmux needed: prompts are asserted through the
// extracted pure composeIterationPrompt; the one injectPrompt call tolerates its send failing against
// a nonexistent socket (the belt audit fires before the send).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Loop, Mission, Terminal } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-loops-skillbrief-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { Loops, composeIterationPrompt } = await import('./loops.js');
const { Missions } = await import('./missions.js');
const { auditTail } = await import('./audit.js');
const { SkillStore, centralBodyPath } = await import('./skills/store.js');
const { MEMORY_LOOP_FOOTER } = await import('./memory-instruction.js');
const { SkillSelectionStore } = await import('./skills/selection.js');
const { renderSkillBrief } = await import('./skills/brief.js');
const { ProviderStore } = await import('./providers/store.js');
const { initProviderRegistry } = await import('./providers/registry.js');
initProviderRegistry(new ProviderStore());

// ---- The skill library + selection, shared by every case (per-project overlays keep them apart). ----
const library = new SkillStore();
const selection = new SkillSelectionStore(join(home, 'config', 'sel-loops.json'));
library.upsert({
  id: 'wproj', name: 'Widget Reports', description: 'formats the widget report', body: '# wproj\n',
  scope: 'project', origin: 'operator',
});
library.upsert({
  id: 'wdraft', name: 'Draft Helper', description: 'assistant-authored helper', body: '# wdraft\n',
  scope: 'project', origin: 'assistant',
});

let seq = 0;
/** Store + real Loops with a stubbed tm whose spawned terminal carries (or omits) autoAccept, wired
 *  to the REAL brief closure (or a throwing one). Mirrors the production server.ts wiring shape. */
function harness(opts: { projectId: string; autoAccept?: boolean; briefThrows?: boolean } ) {
  const store = new Store();
  const repo = join(home, `repo-${seq++}`);
  mkdirSync(repo, { recursive: true });
  store.upsertProject({ id: opts.projectId, name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  const tm = {
    createTerminal: async () => ({
      id: `bt-${seq}-${++seq}`,
      branch: 'loop-branch',
      baseBranch: 'main',
      worktreePath: join(repo, 'wt'),
      ...(opts.autoAccept ? { autoAccept: true } : {}),
    }),
  };
  const loops = new Loops({
    store,
    tm: tm as never,
    worktrees: {} as never,
    accounts: { getProfile: () => undefined, listProfiles: () => [] } as never,
    skillBrief: opts.briefThrows
      ? () => { throw new Error('brief compute exploded'); }
      : ({ projectId, provider, excludeUncleared }) =>
          renderSkillBrief(selection.resolveForProject(library.list(), projectId).entries, provider, excludeUncleared),
    onUpdate: () => {},
  });
  return { store, loops };
}
const fired = (action: string, key: string, value: string): boolean =>
  auditTail(500).some((e) => e.action === action && e[key] === value);

test('1. a per-project skill reaches an INTERACTIVE loop: baked at create, sent after task, before feedback', async () => {
  // Kills: dropping the create-time compute, the record bake, the prompt append, or the ordering.
  selection.setProjectSkills('lp1', { enable: { wproj: true } });
  const { store, loops } = harness({ projectId: 'lp1' });
  const loop = await loops.create({ projectId: 'lp1', name: 'n1', task: 'build the widget', provider: 'claude-code' });
  const stored = store.getLoop(loop.id)!;
  assert.ok(stored.skillBrief, 'the brief is persisted on the record');
  assert.ok(stored.skillBrief.includes('Widget Reports'), 'it names the skill');
  assert.ok(stored.skillBrief.includes(centralBodyPath('wproj')), 'and points at the CENTRAL body path');
  assert.equal(stored.skillBriefUncleared, undefined, 'no uncleared skill in this selection — no belt flag');
  assert.ok(fired('loop.skillbrief', 'loopId', loop.id), 'the counts-only audit fired');

  const { prompt, briefSuppressed } = composeIterationPrompt(stored, 'tighten the header');
  assert.equal(briefSuppressed, false);
  const iTask = prompt.indexOf('build the widget');
  const iBrief = prompt.indexOf('Project skills for this task');
  const iFooter = prompt.indexOf(MEMORY_LOOP_FOOTER);
  const iFeedback = prompt.indexOf('[Control Tower · loop "n1" · iteration 1] tighten the header');
  assert.ok(iTask === 0, 'the task leads');
  assert.ok(iBrief > iTask, 'the brief follows the task');
  assert.ok(iFooter > iBrief, 'the memory footer follows the brief (SPEC-MEMADOPT)');
  assert.ok(iFeedback > iFooter, 'feedback stays LAST (freshest steering)');
});

test('2. an UNCLEARED assistant skill never reaches a SKIP-PERMISSIONS loop — a cleared one does (control)', async () => {
  // Kills: dropping excludeUncleared at create, or keying it on anything but the spawned terminal's
  // server-resolved autoAccept.
  selection.setProjectSkills('lp2', { enable: { wproj: true, wdraft: true } });
  const { store, loops } = harness({ projectId: 'lp2', autoAccept: true });
  const loop = await loops.create({ projectId: 'lp2', name: 'n2', task: 't', provider: 'claude-code' });
  const stored = store.getLoop(loop.id)!;
  assert.ok(stored.skillBrief, 'the bypass loop still gets a brief');
  assert.ok(stored.skillBrief.includes(centralBodyPath('wproj')), 'the operator skill is delivered');
  assert.ok(!stored.skillBrief.includes('wdraft'), 'the uncleared assistant skill is NOT');
  assert.equal(stored.skillBriefUncleared, undefined, 'an excluded skill never marks the brief uncleared');
  assert.equal(stored.skillBriefAssistantIds, undefined, 'no assistant skill delivered ⇒ no re-check ids');

  // Positive control: clearance flips the outcome for an identical bypass create.
  library.setAutonomyCleared('wdraft', true);
  const loop2 = await loops.create({ projectId: 'lp2', name: 'n2b', task: 't', provider: 'claude-code' });
  const stored2 = store.getLoop(loop2.id)!;
  assert.ok(stored2.skillBrief?.includes(centralBodyPath('wdraft')), 'the CLEARED skill reaches the bypass loop');
  assert.equal(stored2.skillBriefUncleared, undefined, 'cleared ⇒ nothing to flag');
  assert.deepEqual(stored2.skillBriefAssistantIds, ['wdraft'], 'the delivered assistant id is persisted for the live re-check');
  library.setAutonomyCleared('wdraft', false);
});

test('3. an INTERACTIVE loop keeps the uncleared skill AND carries the belt flag', async () => {
  // Kills: over-excluding (interactive agents losing assistant skills), or forgetting the flag.
  selection.setProjectSkills('lp3', { enable: { wdraft: true } });
  const { store, loops } = harness({ projectId: 'lp3' });
  const loop = await loops.create({ projectId: 'lp3', name: 'n3', task: 't', provider: 'claude-code' });
  const stored = store.getLoop(loop.id)!;
  assert.ok(stored.skillBrief?.includes(centralBodyPath('wdraft')), 'interactive delivery keeps it');
  assert.equal(stored.skillBriefUncleared, true, 'and the persisted belt flag marks the brief');
});

test('4. the inject belt: an uncleared brief meeting a skip-permissions pane is SUPPRESSED and audited', async () => {
  // Kills: removing the inject-time guard (unreachable today — autoAccept and the binding are both
  // immutable — but load-bearing against a future toggle/re-bind/hand-edit).
  const store = new Store();
  const now = new Date().toISOString();
  const repo = join(home, `repo-belt-${seq++}`);
  mkdirSync(repo, { recursive: true });
  store.upsertProject({ id: 'lp4', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: now });
  const term: Terminal = {
    id: 'bt-belt', projectId: 'lp4', title: 'builder', provider: 'claude-code',
    tmuxSocket: `skillbrief-none-${process.pid}`, cwd: repo, command: ['claude'], state: 'idle',
    autoAccept: true, createdAt: now,
  };
  store.upsertTerminal(term);
  const loop: Loop = {
    id: 'lb4', projectId: 'lp4', name: 'belted', task: 'do it', provider: 'claude-code',
    terminalId: term.id, gatePolicy: 'never', maxIterations: 8, status: 'running', iteration: 1,
    iterations: [{ n: 1, verdict: 'pending', startedAt: now }],
    skillBrief: 'Project skills for this task (not preinstalled; read the body file before using one):\n\nX',
    skillBriefUncleared: true, createdAt: now, updatedAt: now,
  };
  store.upsertLoop(loop);
  const loops = new Loops({ store, tm: {} as never, worktrees: {} as never, accounts: {} as never, onUpdate: () => {} });
  const inner = loops as unknown as { injectPrompt(l: Loop, rt: Record<string, unknown>): Promise<void> };
  const rt: Record<string, unknown> = { phase: 'launching', injectAt: Date.now() - 1000, injectedAt: 0, sawWorking: false, idleTicks: 0 };
  // The send itself fails against a nonexistent socket (rethrown for the tick log) — irrelevant here:
  // the suppression decision + audit land BEFORE any keystroke.
  await inner.injectPrompt(store.getLoop('lb4')!, rt).catch(() => {});
  assert.ok(fired('loop.skillbrief.suppressed', 'loopId', 'lb4'), 'the suppression is audited, never silent');
  // Pin the leg label too: a frozen-flag suppression must be reported as 'frozen-flag', so a
  // regression that mislabels it (or hardcodes 'clearance-drift') can't slip past a green suite.
  assert.ok(fired('loop.skillbrief.suppressed', 'reason', 'frozen-flag'), 'the frozen-flag leg is labeled');

  const suppressed = composeIterationPrompt(store.getLoop('lb4')!, undefined, term);
  assert.equal(suppressed.briefSuppressed, true);
  // SPEC-MEMADOPT — suppression drops the BRIEF only; the standing memory footer is platform text,
  // not skill content, so it survives the clearance belt (byte-pinned: task + footer, nothing else).
  assert.equal(suppressed.prompt, `do it\n\n${MEMORY_LOOP_FOOTER}`, 'the brief never reaches the bypass pane text — the footer still does');
  // Positive controls: an interactive pane keeps the brief; a CLEAN brief may reach a bypass pane.
  const interactive = composeIterationPrompt(store.getLoop('lb4')!, undefined, { });
  assert.equal(interactive.briefSuppressed, false);
  assert.ok(interactive.prompt.includes('Project skills for this task'));
  const cleanOnBypass = composeIterationPrompt({ ...store.getLoop('lb4')!, skillBriefUncleared: undefined }, undefined, term);
  assert.equal(cleanOnBypass.briefSuppressed, false);
  assert.ok(cleanOnBypass.prompt.includes('Project skills for this task'), 'a brief with no uncleared skills is never suppressed');
});

test('5. M6 strip-trap: all three fields survive a fresh Store load, and the restore path re-sends the brief', async () => {
  // Kills: forgetting any LoopSchema line — the exact failure the strip-trap comments warn about; a
  // restarted loop would silently lose its skills mid-flight (or, for the id list, silently disarm
  // the inject-time clearance re-check).
  selection.setProjectSkills('lp5', { enable: { wproj: true, wdraft: true } });
  const { store, loops } = harness({ projectId: 'lp5' });
  const loop = await loops.create({ projectId: 'lp5', name: 'n5', task: 'restartable', provider: 'claude-code' });
  assert.ok(store.getLoop(loop.id)!.skillBrief);
  assert.equal(store.getLoop(loop.id)!.skillBriefUncleared, true);
  assert.deepEqual(store.getLoop(loop.id)!.skillBriefAssistantIds, ['wdraft'], 'the interactive delivery lists its assistant id');

  const reloaded = new Store().getLoop(loop.id)!; // a fresh Store = the restart load path
  assert.ok(reloaded.skillBrief?.includes(centralBodyPath('wproj')), 'skillBrief survives the zod round-trip');
  assert.equal(reloaded.skillBriefUncleared, true, 'skillBriefUncleared survives the zod round-trip');
  assert.deepEqual(reloaded.skillBriefAssistantIds, ['wdraft'], 'skillBriefAssistantIds survives the zod round-trip');
  // The real restart path (driveOne → re-arm 'launching' → injectPrompt) funnels through this same
  // pure seam, so composing from the reloaded record here proves the brief survives to re-send.
  const { prompt } = composeIterationPrompt(reloaded, undefined);
  assert.ok(prompt.includes(centralBodyPath('wproj')), 'the reloaded record composes the brief through the shared inject seam');
});

test('6. mission-sortie parity: startSortie funnels through loops.create, so a sortie loop gets the brief', async () => {
  // Kills: any future "optimization" that spawns sorties off the loops.create funnel.
  selection.setProjectSkills('lp6', { enable: { wproj: true } });
  const { store, loops } = harness({ projectId: 'lp6' });
  const now = new Date().toISOString();
  const mission: Mission = {
    id: 'm6', projectId: 'lp6', name: 'm', goal: 'g', provider: 'claude-code', advance: 'gate',
    maxIterationsPerSortie: 2, concurrency: 1,
    phases: [{ id: 'ph1', name: 'ph', sorties: [{ id: 's1', name: 's1', task: 'sortie work', status: 'pending' }] }],
    activePhase: 0, status: 'running', createdAt: now, updatedAt: now,
  };
  store.upsertMission(mission);
  const missions = new Missions({
    store, loops, onUpdate: () => {}, terminalCapacity: () => ({ ok: true, detail: '' }),
  } as never);
  await (missions as unknown as { startPending(id: string, phase: number): Promise<void> }).startPending('m6', 0);
  const sortie = store.getMission('m6')!.phases[0]!.sorties[0]!;
  assert.equal(sortie.status, 'active', 'the sortie started');
  assert.ok(sortie.loopId, 'and holds its loop backref');
  const loop = store.getLoop(sortie.loopId!)!;
  assert.ok(loop.skillBrief, 'the sortie loop carries a brief');
  assert.ok(loop.skillBrief.includes(centralBodyPath('wproj')), 'the same brief a standalone loop would get');
  assert.ok(loop.skillBrief.includes('Widget Reports'));
});

test('7. a brief compute THROW is contained: the loop still exists, running, brief-less — audited', async () => {
  // Kills: the terminal-leak regression — an uncaught throw between createTerminal and upsertLoop
  // would leave a live builder terminal + worktree with no loop record.
  selection.setProjectSkills('lp7', { enable: { wproj: true } });
  const { store, loops } = harness({ projectId: 'lp7', briefThrows: true });
  const loop = await loops.create({ projectId: 'lp7', name: 'n7', task: 't', provider: 'claude-code' });
  const stored = store.getLoop(loop.id)!;
  assert.equal(stored.status, 'running', 'the create survived the compute failure');
  assert.equal(stored.skillBrief, undefined, 'degraded brief-less, never half-baked');
  assert.ok(fired('loop.skillbrief.failed', 'projectId', 'lp7'), 'the degradation is audited, never silent');
});

test('8. empty-selection shape: no overlay ⇒ no brief; the prompt is task + the standing memory footer, nothing else', async () => {
  // Kills: accidental extra header noise in every loop prompt, AND dropping the unconditional footer
  // append (SPEC-MEMADOPT). The pre-footer byte-identity is deliberately gone: the ONE standing
  // addition every loop prompt now carries is the memory footer — byte-pinned here so any second
  // always-on addition (or a lost footer) fails this test.
  const { store, loops } = harness({ projectId: 'lp8' });
  const loop = await loops.create({ projectId: 'lp8', name: 'n8', task: 'plain task', provider: 'claude-code' });
  const stored = store.getLoop(loop.id)!;
  assert.equal(stored.skillBrief, undefined);
  assert.equal(stored.skillBriefUncleared, undefined);
  assert.equal(composeIterationPrompt(stored, undefined).prompt, `plain task\n\n${MEMORY_LOOP_FOOTER}`);
  assert.equal(
    composeIterationPrompt(stored, 'redo the header').prompt,
    `plain task\n\n${MEMORY_LOOP_FOOTER}\n\n[Control Tower · loop "n8" · iteration 1] redo the header`,
    'the footer sits between task and feedback — feedback stays LAST',
  );
});

test('9. the live drift re-check: a mid-loop clearance drop suppresses a bypass brief — a still-cleared one flows', async () => {
  // Kills: dropping the drift leg. The create-time flag was frozen FALSE (the skill was cleared
  // then), so only a live store read can see a later edit/promote/rollback drop clearance out from
  // under the brief's by-id pointer — the frozen-flag belt in composeIterationPrompt cannot fire.
  library.upsert({
    id: 'wlive', name: 'Live Draft', description: 'assistant helper', body: '# v1\n',
    scope: 'project', origin: 'assistant',
  });
  library.setAutonomyCleared('wlive', true);
  const store = new Store();
  const now = new Date().toISOString();
  const repo = join(home, `repo-drift-${seq++}`);
  mkdirSync(repo, { recursive: true });
  store.upsertProject({ id: 'lp9', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: now });
  const term: Terminal = {
    id: 'bt-drift', projectId: 'lp9', title: 'builder', provider: 'claude-code',
    tmuxSocket: `skillbrief-drift-${process.pid}`, cwd: repo, command: ['claude'], state: 'idle',
    autoAccept: true, createdAt: now,
  };
  store.upsertTerminal(term);
  const loop: Loop = {
    id: 'ld9', projectId: 'lp9', name: 'drifting', task: 'do it', provider: 'claude-code',
    terminalId: term.id, gatePolicy: 'never', maxIterations: 8, status: 'running', iteration: 1,
    iterations: [{ n: 1, verdict: 'pending', startedAt: now }],
    skillBrief: 'Project skills for this task (not preinstalled; read the body file before using one):\n\nX',
    skillBriefAssistantIds: ['wlive'], createdAt: now, updatedAt: now,
  };
  store.upsertLoop(loop);
  const loops = new Loops({
    store, tm: {} as never, worktrees: {} as never, accounts: {} as never, onUpdate: () => {},
    // The production closure shape (server.ts): every id must be a live assistant skill, cleared.
    briefAssistantSkillsCleared: (ids) =>
      ids.every((id) => {
        const s = library.get(id);
        return !!s && s.origin === 'assistant' && s.autonomyCleared === true;
      }),
  });
  const inner = loops as unknown as { injectPrompt(l: Loop, rt: Record<string, unknown>): Promise<void> };
  const mkRt = (): Record<string, unknown> =>
    ({ phase: 'launching', injectAt: Date.now() - 1000, injectedAt: 0, sawWorking: false, idleTicks: 0 });
  // Still cleared: the re-check passes and the brief flows (the send fails against the nonexistent
  // socket, which is after the decision point — same tolerance as test 4).
  await inner.injectPrompt(store.getLoop('ld9')!, mkRt()).catch(() => {});
  assert.ok(!fired('loop.skillbrief.suppressed', 'loopId', 'ld9'), 'a still-cleared brief is never suppressed');
  // A content edit drops clearance via the hash-keyed reset; the SAME frozen record now suppresses.
  library.upsert({
    id: 'wlive', name: 'Live Draft', description: 'assistant helper', body: '# v2 - edited mid-loop\n',
    scope: 'project', origin: 'assistant',
  });
  await inner.injectPrompt(store.getLoop('ld9')!, mkRt()).catch(() => {});
  assert.ok(
    auditTail(500).some((e) => e.action === 'loop.skillbrief.suppressed' && e.loopId === 'ld9' && e.reason === 'clearance-drift'),
    'the drift suppression is audited with its leg named',
  );
  // The composed prompt drops the whole brief once the caller passes the drift verdict — the
  // standing memory footer stays (SPEC-MEMADOPT: platform text, never gated by the belts).
  const suppressed = composeIterationPrompt(store.getLoop('ld9')!, undefined, term, true);
  assert.equal(suppressed.briefSuppressed, true);
  assert.equal(suppressed.prompt, `do it\n\n${MEMORY_LOOP_FOOTER}`, 'the drifted brief never reaches the pane text');
});

test('10. drift re-check fail-closed: assistant ids present but NO re-check dep wired ⇒ suppressed on a bypass pane', async () => {
  // Kills: an absent-dep-means-open regression — a Loops constructed without the closure must refuse
  // to keep feeding assistant-skill pointers to a skip-permissions pane rather than assume clearance
  // still holds. An interactive pane is the control: the drift leg gates bypass delivery only.
  const store = new Store();
  const now = new Date().toISOString();
  const repo = join(home, `repo-nodeps-${seq++}`);
  mkdirSync(repo, { recursive: true });
  store.upsertProject({ id: 'lp10', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: now });
  const mkTerm = (id: string, autoAccept: boolean): Terminal => ({
    id, projectId: 'lp10', title: 'builder', provider: 'claude-code',
    tmuxSocket: `skillbrief-nodeps-${id}-${process.pid}`, cwd: repo, command: ['claude'], state: 'idle',
    ...(autoAccept ? { autoAccept: true } : {}), createdAt: now,
  });
  const mkLoop = (id: string, terminalId: string): Loop => ({
    id, projectId: 'lp10', name: 'no-dep', task: 'do it', provider: 'claude-code',
    terminalId, gatePolicy: 'never', maxIterations: 8, status: 'running', iteration: 1,
    iterations: [{ n: 1, verdict: 'pending', startedAt: now }],
    skillBrief: 'Project skills for this task (not preinstalled; read the body file before using one):\n\nX',
    skillBriefAssistantIds: ['wdraft'], createdAt: now, updatedAt: now,
  });
  store.upsertTerminal(mkTerm('bt-nd-a', true));
  store.upsertLoop(mkLoop('lf10', 'bt-nd-a'));
  store.upsertTerminal(mkTerm('bt-nd-i', false));
  store.upsertLoop(mkLoop('lf10b', 'bt-nd-i'));
  const loops = new Loops({ store, tm: {} as never, worktrees: {} as never, accounts: {} as never, onUpdate: () => {} });
  const inner = loops as unknown as { injectPrompt(l: Loop, rt: Record<string, unknown>): Promise<void> };
  const mkRt = (): Record<string, unknown> =>
    ({ phase: 'launching', injectAt: Date.now() - 1000, injectedAt: 0, sawWorking: false, idleTicks: 0 });
  await inner.injectPrompt(store.getLoop('lf10')!, mkRt()).catch(() => {});
  assert.ok(
    auditTail(500).some((e) => e.action === 'loop.skillbrief.suppressed' && e.loopId === 'lf10' && e.reason === 'clearance-drift'),
    'no dep ⇒ the re-check fails CLOSED on a bypass pane',
  );
  await inner.injectPrompt(store.getLoop('lf10b')!, mkRt()).catch(() => {});
  assert.ok(!fired('loop.skillbrief.suppressed', 'loopId', 'lf10b'), 'an interactive pane keeps its brief — the drift leg is bypass-only');
});

test('11. an all-filtered brief still AUDITS its counts: bypass create + only an uncleared assistant skill', async () => {
  // Kills: the empty-render-discards-counts hole — a bypass loop whose whole selection was excluded
  // for clearance used to produce NO loop.skillbrief line, exactly where skippedUncleared matters.
  selection.setProjectSkills('lp11', { enable: { wdraft: true } });
  const { store, loops } = harness({ projectId: 'lp11', autoAccept: true });
  const loop = await loops.create({ projectId: 'lp11', name: 'n11', task: 't', provider: 'claude-code' });
  const stored = store.getLoop(loop.id)!;
  assert.equal(stored.skillBrief, undefined, 'nothing deliverable ⇒ no brief on the record');
  assert.equal(stored.skillBriefUncleared, undefined);
  assert.equal(stored.skillBriefAssistantIds, undefined);
  const entry = auditTail(500).find((e) => e.action === 'loop.skillbrief' && e.loopId === loop.id);
  assert.ok(entry, 'the counts-only audit fires even for an empty brief');
  assert.equal(entry.skippedUncleared, 1, 'and carries the exclusion count');
});

test('12. SPEC-SKILLS-GATE — a project-scoped loop-green gate skill delivers its evidence line in the brief', async () => {
  // Kills: brief.ts dropping the gate lines, or sectionGateText suppressing loop-green from the
  // sortie-brief channel — the brief is exactly where a mission sortie learns how to attest.
  library.upsert({
    id: 'wgate', name: 'Widget Gate', description: 'audits the widget diff', body: '# wgate\n',
    scope: 'project', origin: 'operator',
    gate: { mode: 'blocking', blocks: ['loop-green'], enforcedBy: ['orchestrator'], rerunOnNewDiff: true },
  });
  selection.setProjectSkills('lp12', { enable: { wgate: true } });
  const { store, loops } = harness({ projectId: 'lp12' });
  const loop = await loops.create({ projectId: 'lp12', name: 'n12', task: 't', provider: 'claude-code' });
  const stored = store.getLoop(loop.id)!;
  assert.ok(stored.skillBrief, 'the brief exists');
  assert.ok(stored.skillBrief.includes('towerctl gate submit --gate wgate --result pass'), 'the brief carries the submit instruction with the skill id');
  assert.ok(stored.skillBrief.includes('when working a Tower mission sortie'), 'the conditional phrasing rides the brief channel');
});

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
});
