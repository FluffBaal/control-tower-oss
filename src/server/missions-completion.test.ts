// SPEC-LOOP §2 — the completion evaluator (evaluateCompletion, reached via reconcileAndStart at the
// past-the-end boundary). This is the never-silent-pass heart of the loop: a green run finishes done, a
// red run appends a mechanical round or (at the cap) stops RED at attention, and an unverifiable run —
// no parseable results, no verify phase, or a required-but-unavailable review — is ALWAYS attention,
// never a silent done.
//
// The fixture injects a real testkit ({getRun, latestFor}) and pins loop.rounds[{n: round, verifyRunId}]
// — without both, resolveVerifyRun would return undefined and every case would collapse to the single
// "no parseable results" branch, proving nothing. The distinct outcomes below are the proof the pin works.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time. The real ~/.ct is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateEvidenceRecord, Mission, MissionLoop, MissionPhase, MissionSortie, ReviewRecord, TestFailure } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-missions-completion-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { Missions } = await import('./missions.js');

const RUN_ID = 'run-pinned';

interface Run { id: string; results?: TestFailure[]; failed?: number; total?: number; startedAt?: string }

interface Opts {
  run?: Run;               // what testkit.getRun returns for the pinned id
  loop?: Partial<MissionLoop>;
  requireReview?: boolean;
  withReviews?: boolean;   // inject a reviews store dep (default: absent)
  reviewRecord?: Omit<ReviewRecord, 'missionId'>; // what the injected reviews store returns (default: none)
  noVerifyPhase?: boolean; // build a mission with no stage:'verify' phase
  phases?: MissionPhase[]; // override the phase plan (the SPEC-SKILLS-GATE staleness shapes)
  withGates?: boolean;     // inject a gates store dep (default: absent)
  // SPEC-SKILLS-GATE — what the injected gates store holds (mission-scoped by construction).
  gates?: { gateId: string; sortieId: string; status: 'pass' | 'fail'; summary?: string }[];
}

function fixture(opts: Opts) {
  const store = new Store();
  const repo = join(home, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  const projectId = `p${Math.random().toString(36).slice(2, 8)}`;
  const missionId = `m${Math.random().toString(36).slice(2, 8)}`;
  store.upsertProject({ id: projectId, name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  const now = new Date().toISOString();

  const runner: MissionSortie = { id: 'r1', name: 'verify', task: 't', status: 'done', loopId: 'lr' };
  const phases: MissionPhase[] = opts.phases
    ?? (opts.noVerifyPhase
      ? [{ id: 'b', name: 'build', stage: 'build', sorties: [{ id: 'b1', name: 'build', task: 't', status: 'done' }] }]
      : [{ id: 'v', name: 'verify', stage: 'verify', round: 1, sorties: [runner] }]);

  const loop: MissionLoop = {
    maxRounds: 8, mechanicalRounds: 2, sortieBudget: 16, round: 1,
    // The pinned run resolves via loop.rounds.find(n === round).verifyRunId — so this record must carry it.
    rounds: [{ n: 1, kind: 'authored', appendedAt: now, verifyRunId: RUN_ID }],
    ...(opts.requireReview ? { requireReview: true } : {}),
    ...opts.loop,
  };

  const mission: Mission = {
    id: missionId, projectId, name: 'm', goal: 'g', provider: 'codex', advance: 'auto',
    maxIterationsPerSortie: 8, concurrency: 4,
    phases, activePhase: phases.length /* the past-the-end completion boundary */, loop,
    status: 'running', createdAt: now, updatedAt: now,
  };
  store.upsertMission(mission);

  // Inject the testkit so resolveVerifyRun can resolve the pinned run (getRun), NOT collapse to the
  // no-parseable branch. latestFor is present too (the real kit's shape), though the pin path wins.
  const testkit = {
    getRun: (rid: string) => (rid === RUN_ID ? opts.run : undefined),
    latestFor: () => undefined,
    latestParsedForProject: () => undefined,
  };
  const deps: Record<string, unknown> = {
    store,
    loops: { create: async () => ({ id: 'l', status: 'running' }), list: () => [], get: () => undefined, stop: () => {} },
    onUpdate: () => {},
    terminalCapacity: () => ({ ok: true, detail: '' }),
    testkit,
  };
  if (opts.withReviews) {
    const record: ReviewRecord | undefined = opts.reviewRecord ? { ...opts.reviewRecord, missionId } : undefined;
    deps.reviews = { getFor: () => record, getById: () => record, latestFor: () => record };
  }
  // SPEC-SKILLS-GATE — an injected gates store, synthesizing full records for THIS mission. getFor
  // matches BOTH keys, so an evaluator passing a wrong/constant missionId would read no evidence and
  // fail the green-path tests (the lookup is honest, not a fixture shortcut).
  if (opts.withGates) {
    const records: GateEvidenceRecord[] = (opts.gates ?? []).map((g, i) => ({
      id: `ge${i}`, missionId, sortieId: g.sortieId, gateId: g.gateId, status: g.status,
      ...(g.summary !== undefined ? { summary: g.summary } : {}), submittedAt: now,
    }));
    deps.gates = {
      getFor: (mid: string, gateId: string) => records.find((r) => r.missionId === mid && r.gateId === gateId),
      listFor: (mid: string) => records.filter((r) => r.missionId === mid),
    };
  }
  const missions = new Missions(deps as never);

  return {
    drive: () => (missions as unknown as { reconcileAndStart(id: string): Promise<void> }).reconcileAndStart(missionId),
    read: () => store.getMission(missionId)!,
    missions,
    store,
    projectId,
  };
}

const failure = (specFile: string, testTitle = 't'): TestFailure => ({ specFile, testTitle } as TestFailure);

test('evaluateCompletion — GREEN (failed 0, no review) finishes done', async () => {
  const f = fixture({ run: { id: RUN_ID, results: [], failed: 0, total: 3 } });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'done');
  assert.equal(m.activePhase, m.phases.length);
});

test('evaluateCompletion — RED with budget appends a mechanical round and stays running', async () => {
  const f = fixture({ run: { id: RUN_ID, results: [failure('a.spec.ts')], failed: 1, total: 3 } });
  const before = f.read().phases.length;
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'running', 'a red-with-budget round keeps iterating, never done');
  assert.equal(m.loop?.round, 2, 'the round counter advanced');
  assert.ok(m.phases.length > before, 'a new round’s phases were appended');
  assert.ok(m.loop?.rounds.some((r) => r.n === 2 && r.kind === 'mechanical'), 'a mechanical round record was added');
});

test('evaluateCompletion — RED at the round cap stops at attention, never done', async () => {
  const f = fixture({ run: { id: RUN_ID, results: [failure('a.spec.ts')], failed: 1 }, loop: { maxRounds: 1 } });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'attention', 'a cap-exhausted RED loop parks at a human gate');
  assert.notEqual(m.status, 'done');
  assert.equal(m.loop?.round, 1, 'no round was appended past the cap');
});

test('evaluateCompletion — no parseable results is attention, never a silent pass', async () => {
  const f = fixture({ run: { id: RUN_ID, results: undefined } });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'attention');
  assert.match(m.stopReason ?? '', /no parseable e2e results/);
});

test('evaluateCompletion — a loop mission with no verify phase is attention', async () => {
  const f = fixture({ noVerifyPhase: true, run: { id: RUN_ID, results: [], failed: 0 } });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'attention');
  assert.match(m.stopReason ?? '', /no verify phase/);
});

test('evaluateCompletion — GREEN but requireReview with NO review store is attention, never green', async () => {
  const f = fixture({ run: { id: RUN_ID, results: [], failed: 0 }, requireReview: true, withReviews: false });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'attention', 'review is load-bearing — an unavailable store never finishes green');
  assert.notEqual(m.status, 'done');
  assert.match(m.stopReason ?? '', /review store is unavailable/);
});

// ---------------------------------------------------------------------------------------------------
// SPEC-SKILLS-GATE — the loop-green orchestrator gate at the completion boundary. The hoisted check sits
// at the TOP of the green branch, so BOTH done sites (the no-review finish and the review-clean finish)
// must flow through it; a red loop is untouched (the gate blocks TERMINATION only, never iteration).

const GREEN: Run = { id: RUN_ID, results: [], failed: 0, total: 3 };

test('gate — GREEN with requiredGates but NO gate store is attention, never green', async () => {
  const f = fixture({ run: GREEN, loop: { requiredGates: ['g1'] } });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'attention', 'the gate store is load-bearing — absent + required never finishes green');
  assert.match(m.stopReason ?? '', /gate-evidence store is unavailable/);
});

test('gate — GREEN with a required gate and NO evidence is attention naming the gate', async () => {
  const f = fixture({ run: GREEN, loop: { requiredGates: ['g1'] }, withGates: true });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'attention');
  assert.match(m.stopReason ?? '', /g1 — no evidence/);
  assert.match(m.stopReason ?? '', /towerctl gate submit/, 'the recovery hint names the submit command');
});

test('gate — GREEN with a fresh pass finishes done (the no-review done site)', async () => {
  const f = fixture({
    run: GREEN,
    loop: { requiredGates: ['g1'] },
    withGates: true,
    gates: [{ gateId: 'g1', sortieId: 'r1', status: 'pass' }],
  });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'done', 'a satisfied gate lets the green finish through');
});

test('gate — DONE SITE B: a clean review with MISSING gate evidence is attention; with a pass it is done', async () => {
  // A review-clean green would finish at the SECOND done site — the hoisted gate check must catch it too.
  const sitePhases = (): MissionPhase[] => [
    { id: 'b', name: 'build', stage: 'build', sorties: [{ id: 'b1', name: 'build', task: 't', status: 'landed' }] },
    { id: 'rv', name: 'review', stage: 'review', sorties: [{ id: 'rev1', name: 'review', task: 't', status: 'landed', reviewFromRange: 'base..head' }] },
    { id: 'v', name: 'verify', stage: 'verify', round: 1, sorties: [{ id: 'r1', name: 'verify', task: 't', status: 'done', loopId: 'lr' }] },
  ];
  const clean = { id: 'rr', sortieId: 'rev1', findings: [], submittedAt: new Date().toISOString() };

  const blocked = fixture({
    run: GREEN, requireReview: true, phases: sitePhases(),
    withReviews: true, reviewRecord: clean,
    loop: { requiredGates: ['g1'] }, withGates: true,
  });
  await blocked.drive();
  const mb = blocked.read();
  assert.equal(mb.status, 'attention', 'the review-clean done site flows through the gate check too');
  assert.match(mb.stopReason ?? '', /g1 — no evidence/);

  const passed = fixture({
    run: GREEN, requireReview: true, phases: sitePhases(),
    withReviews: true, reviewRecord: clean,
    loop: { requiredGates: ['g1'] }, withGates: true,
    gates: [{ gateId: 'g1', sortieId: 'r1', status: 'pass' }],
  });
  await passed.drive();
  assert.equal(passed.read().status, 'done', 'gate pass + clean review finishes done');
});

test('gate — rerun staleness is PHASE-STRUCTURE identity: a pre-code-phase pass is stale for a rerun gate, accepted otherwise', async () => {
  // Round 2 shape: build(b1) → verify → fix(code) → verify(pinned). The pass evidence came from b1
  // (phase 0); the fix phase (2) changed code AFTER it, so codeIdx(2) > evidenceIdx(0).
  const roundTwoPhases = (): MissionPhase[] => [
    { id: 'b', name: 'build', stage: 'build', round: 1, sorties: [{ id: 'b1', name: 'build', task: 't', status: 'landed' }] },
    { id: 'v1', name: 'verify 1', stage: 'verify', round: 1, sorties: [{ id: 'r1v', name: 'verify', task: 't', status: 'done' }] },
    { id: 'fx', name: 'fix', stage: 'fix', round: 2, sorties: [{ id: 'f1', name: 'fix', task: 't', status: 'landed' }] },
    { id: 'v2', name: 'verify 2', stage: 'verify', round: 2, sorties: [{ id: 'r2v', name: 'verify', task: 't', status: 'done', loopId: 'lr' }] },
  ];
  const now = new Date().toISOString();
  const roundTwoLoop = (rerun: boolean): Partial<MissionLoop> => ({
    round: 2,
    rounds: [
      { n: 1, kind: 'authored', appendedAt: now },
      { n: 2, kind: 'mechanical', appendedAt: now, verifyRunId: RUN_ID },
    ],
    requiredGates: ['g1'],
    ...(rerun ? { rerunGates: ['g1'] } : {}),
  });

  const stale = fixture({
    run: GREEN, phases: roundTwoPhases(), loop: roundTwoLoop(true),
    withGates: true, gates: [{ gateId: 'g1', sortieId: 'b1', status: 'pass' }],
  });
  await stale.drive();
  const ms = stale.read();
  assert.equal(ms.status, 'attention', 'a rerun gate demands evidence AFTER the last code phase');
  assert.match(ms.stopReason ?? '', /stale — code changed/);

  const accepted = fixture({
    run: GREEN, phases: roundTwoPhases(), loop: roundTwoLoop(false),
    withGates: true, gates: [{ gateId: 'g1', sortieId: 'b1', status: 'pass' }],
  });
  await accepted.drive();
  assert.equal(accepted.read().status, 'done', 'a non-rerun gate accepts older evidence');
});

test('gate — a FAILED attestation is attention surfacing the summary', async () => {
  const f = fixture({
    run: GREEN, loop: { requiredGates: ['g1'] }, withGates: true,
    gates: [{ gateId: 'g1', sortieId: 'r1', status: 'fail', summary: 'two findings unresolved' }],
  });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'attention');
  assert.match(m.stopReason ?? '', /last run FAILED — two findings unresolved/);
});

test('gate — a pass whose submitting sortie is in NO phase is attention (fail-closed identity)', async () => {
  const f = fixture({
    run: GREEN, loop: { requiredGates: ['g1'] }, withGates: true,
    gates: [{ gateId: 'g1', sortieId: 'ghost', status: 'pass' }],
  });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'attention', 'unplaceable evidence proves nothing about this mission');
  assert.match(m.stopReason ?? '', /stale/);
});

test('gate — RED with required gates still appends a mechanical round (the gate blocks termination only)', async () => {
  const f = fixture({
    run: { id: RUN_ID, results: [failure('a.spec.ts')], failed: 1, total: 3 },
    loop: { requiredGates: ['g1'] }, withGates: true,
  });
  await f.drive();
  const m = f.read();
  assert.equal(m.status, 'running', 'a red loop iterates as before — the gate never touches the red path');
  assert.equal(m.loop?.round, 2);
  assert.ok(m.loop?.rounds.some((r) => r.n === 2 && r.kind === 'mechanical'));
});

// ---------------------------------------------------------------------------------------------------
// SPEC-SKILLS-GATE — freeze-at-create: the derived second arg is the ONLY way in; the M6 strip-trap
// regression; and wire spoof-inertness (a body smuggling loop.requiredGates mints a mission WITHOUT it).

test('gate freeze — create(req, derived) freezes requiredGates/rerunGates onto the loop', () => {
  const f = fixture({});
  const created = f.missions.create(
    {
      projectId: f.projectId, name: 'frozen', goal: 'g',
      phases: [{ name: 'build', sorties: [{ name: 'b', task: 't' }] }],
      loop: {},
    },
    { requiredGates: ['a', 'b'], rerunGates: ['b'] },
  );
  assert.deepEqual(created.loop?.requiredGates, ['a', 'b']);
  assert.deepEqual(created.loop?.rerunGates, ['b']);
});

test('gate freeze — rerunGates is clamped to a subset of requiredGates', () => {
  const f = fixture({});
  const created = f.missions.create(
    {
      projectId: f.projectId, name: 'clamped', goal: 'g',
      phases: [{ name: 'build', sorties: [{ name: 'b', task: 't' }] }],
      loop: {},
    },
    { requiredGates: ['a'], rerunGates: ['a', 'not-required'] },
  );
  assert.deepEqual(created.loop?.rerunGates, ['a'], 'an id outside requiredGates can never owe freshness');
});

test('gate freeze — M6 strip-trap: both fields survive a Store reload', async () => {
  const f = fixture({});
  const created = f.missions.create(
    {
      projectId: f.projectId, name: 'reload', goal: 'g',
      phases: [{ name: 'build', sorties: [{ name: 'b', task: 't' }] }],
      loop: {},
    },
    { requiredGates: ['a', 'b'], rerunGates: ['b'] },
  );
  const reloaded = new Store().getMission(created.id);
  assert.deepEqual(reloaded?.loop?.requiredGates, ['a', 'b'], 'requiredGates is not zod-stripped on load');
  assert.deepEqual(reloaded?.loop?.rerunGates, ['b'], 'rerunGates is not zod-stripped on load');
});

test('gate freeze — a wire body smuggling loop.requiredGates is structurally inert', () => {
  const f = fixture({});
  const created = f.missions.create({
    projectId: f.projectId, name: 'spoof', goal: 'g',
    phases: [{ name: 'build', sorties: [{ name: 'b', task: 't' }] }],
    loop: { maxRounds: 2, requiredGates: ['evil'], rerunGates: ['evil'] } as never,
  });
  assert.equal(created.loop?.requiredGates, undefined, 'no derived arg → no gates, whatever the body carries');
  assert.equal(created.loop?.rerunGates, undefined);
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
