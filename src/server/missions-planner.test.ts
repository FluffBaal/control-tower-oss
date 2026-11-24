// SPEC-PLANNER §7/§8 — the consult BRANCH inside runEscalatedRound (the clock/attempt arithmetic, the
// P1 lost-check-first respawn, the P5 one-shot renudge, the consume path). This is the most defect-prone
// PURE logic of the wave after the store itself (P7), so it is unit-tested by driving runPlannerConsult
// directly with a real ConsultStore wrapped in the deps shape the server wires.
//
// Every transition is driven through the real method (never by hand-poking mission state), so a mutant
// that drops an attempt bump, a clock comparison, or the lost-check is actually caught.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mission, MissionRoundRecord, MissionLoop, PlannerConsult, Terminal } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-planner-test-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { Missions } = await import('./missions.js');
const { ConsultStore } = await import('./consults.js');

// A local mirror of the private snapshotSorties, so a driven `expected` CAS matches the live mission and
// appendRound actually fires on the consume path (otherwise the CAS refuses and nothing appends).
const snap = (m: Mission): string =>
  m.phases.map((p) => p.sorties.map((s) => `${s.id}:${s.status}`).join(',')).join('|');

interface Opts {
  plannerState?: 'live' | 'lost';
  respawns?: number;
  deliverMs?: number;
  answerMs?: number;
  spawnThrows?: boolean;
  status?: Mission['status'];
}

function harness(opts: Opts = {}) {
  const store = new Store();
  const repo = join(home, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  const now = new Date().toISOString();
  store.upsertProject({ id: 'p1', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: now });
  const pendingEsc: MissionRoundRecord = { n: 2, kind: 'escalating', appendedAt: now };
  const loop: MissionLoop = { maxRounds: 4, mechanicalRounds: 2, sortieBudget: 24, round: 1, rounds: [pendingEsc] };
  const mission: Mission = {
    id: 'm1', projectId: 'p1', name: 'M', goal: 'ship it', provider: 'codex', advance: 'auto',
    maxIterationsPerSortie: 4, concurrency: 1,
    phases: [{ id: 'ph1', name: 'work', stage: 'fix', round: 1, sorties: [{ id: 'w1', name: 'fixer', task: 't', status: 'landed' }] },
      { id: 'phv', name: 'verify', stage: 'verify', round: 1, sorties: [{ id: 'v1', name: 'verify e2e suite', task: 't', status: 'landed' }] }],
    activePhase: 1, status: opts.status ?? 'running', createdAt: now, updatedAt: now, loop,
    baseSha: 'basecommit', // set so start()'s recordBaseSha no-ops (no git call in the harness repo)
    planner: { terminalId: 'pt', provider: 'codex', state: opts.plannerState ?? 'live', attachedAt: now, ...(opts.respawns !== undefined ? { respawns: opts.respawns } : {}) },
  };
  store.upsertMission(mission);
  // A live pane behind the planner terminal id, so consultTitle resolves.
  const pt: Terminal = { id: 'pt', projectId: 'p1', title: 'planner pane', provider: 'codex', tmuxSocket: 'ct-pt', cwd: repo, command: ['sleep', '600'], state: 'idle', createdAt: now };
  store.upsertTerminal(pt);

  rmSync(paths.consults, { force: true });
  const cstore = new ConsultStore();
  const asked: PlannerConsult[] = [];
  const nudged: string[] = [];
  const spawned: string[] = [];
  const consults = {
    getById: (id: string) => cstore.getById(id),
    ask: (input: { missionId: string; terminalId: string; kind: 'replan'; question: string; payload: unknown }) => {
      const c = cstore.create(input as never);
      cstore.bumpNudges(c.id); // the ask counts as attempt 1 (mirrors the server closure)
      asked.push(c);
      return c;
    },
    resolve: (id: string, status: 'applied' | 'rejected' | 'expired', reason?: PlannerConsult['expireReason']) => { cstore.resolve(id, status, reason); },
    renudge: (c: PlannerConsult) => { cstore.bumpNudges(c.id); nudged.push(c.id); },
    migrate: (mid: string, from: string, to: string) => cstore.migrate(mid, from, to),
    settle: (mid: string, reason: PlannerConsult['expireReason']) => { for (const c of cstore.openFor(mid)) { try { cstore.resolve(c.id, 'expired', reason); } catch { /* raced */ } } },
    reanchor: (mid: string) => { cstore.reanchorOpen(mid); },
  };
  const missions = new Missions({
    store,
    loops: { get: () => undefined, list: () => [], create: async () => ({ id: 'l' }), stop: () => {} },
    onUpdate: () => {},
    consults,
    consultTimeouts: { deliverMs: opts.deliverMs ?? 600_000, answerMs: opts.answerMs ?? 1_800_000 },
    plannerSpawn: async (): Promise<Terminal> => {
      if (opts.spawnThrows) throw new Error('spawn failed');
      const t: Terminal = { id: 'pt2', projectId: 'p1', title: 'planner pane 2', provider: 'codex', tmuxSocket: 'ct-pt2', cwd: repo, command: ['sleep', '600'], state: 'idle', createdAt: now };
      store.upsertTerminal(t);
      spawned.push(t.id);
      return t;
    },
    plannerKill: () => {},
    routing: { layersFor: () => ({ global: {} }) },
  } as never);
  const inner = missions as unknown as {
    runPlannerConsult(id: string, m: Mission, loop: MissionLoop, stamped: MissionRoundRecord[], pendingEsc: MissionRoundRecord, expected: unknown): Promise<void>;
  };
  const drive = async (): Promise<void> => {
    const m = store.getMission('m1')!;
    const lp = m.loop!;
    const esc = lp.rounds.find((r) => r.n === lp.round + 1 && r.kind === 'escalating')!;
    const expected = { status: m.status, round: lp.round, phasesLen: m.phases.length, sorties: snap(m) };
    await inner.runPlannerConsult('m1', m, lp, lp.rounds, esc, expected);
  };
  const start = (): Promise<Mission> => (missions as unknown as { start(id: string): Promise<Mission> }).start('m1');
  const setConsultId = (cid: string): void => {
    const m = store.getMission('m1')!;
    store.patchMission('m1', { loop: { ...m.loop!, rounds: [{ n: 2, kind: 'escalating', appendedAt: now, consultId: cid }] } });
  };
  const age = (cid: string, ms: number): void => {
    const rec = cstore.getById(cid)!;
    const at = new Date(Date.now() - ms).toISOString();
    cstore['consults'].set(cid, { ...rec, ...(rec.status === 'delivered' ? { deliveredAt: at } : { askedAt: at }) });
  };
  return { store, cstore, asked, nudged, spawned, drive, start, setConsultId, age };
}

const escOf = (store: InstanceType<typeof Store>): MissionRoundRecord | undefined =>
  store.getMission('m1')!.loop!.rounds.find((r) => r.n === 2 && r.kind === 'escalating');

test('runPlannerConsult — ask, clocks, expiry, respawn, consume', async (t) => {
  await t.test('first entry ASKS: a consult is created, its id stamped on the round, nudged once', async () => {
    const h = harness();
    await h.drive();
    assert.equal(h.asked.length, 1, 'one consult asked');
    const c = h.asked[0]!;
    assert.equal(c.status, 'pending');
    assert.equal(escOf(h.store)?.consultId, c.id, 'the escalating record carries the consult id');
    assert.equal(h.cstore.getById(c.id)?.nudges, 1, 'the ask counts as the first nudge attempt');
  });

  await t.test('a second entry with the SAME open consult does NOT re-ask', async () => {
    const h = harness();
    await h.drive();
    await h.drive();
    assert.equal(h.asked.length, 1, 'the pending consult is reused, never duplicated');
  });

  await t.test('under half-deadline: no renudge; past half-deadline: exactly one renudge', async () => {
    const h = harness({ deliverMs: 1000 });
    await h.drive(); // ask (nudges=1)
    await h.drive(); // still well under half — no renudge
    assert.equal(h.nudged.length, 0, 'no renudge before the half-deadline');
    // Push the consult past the half-deadline by ageing its lastNudgeAt + askedAt.
    const c = h.asked[0]!;
    const old = new Date(Date.now() - 900).toISOString();
    h.cstore['consults'].set(c.id, { ...h.cstore.getById(c.id)!, askedAt: old, lastNudgeAt: old });
    await h.drive();
    assert.equal(h.nudged.length, 1, 'one renudge past the half-deadline');
  });

  await t.test('DELIVERY timeout expires the consult, bumps attempts, clears the link for a fresh ask', async () => {
    const h = harness({ deliverMs: 500 });
    await h.drive(); // ask
    const c = h.asked[0]!;
    h.cstore['consults'].set(c.id, { ...h.cstore.getById(c.id)!, askedAt: new Date(Date.now() - 1000).toISOString() });
    await h.drive(); // past deliverMs → expire
    assert.equal(h.cstore.getById(c.id)?.status, 'expired');
    assert.equal(h.cstore.getById(c.id)?.expireReason, 'delivery-timeout');
    const esc = escOf(h.store);
    assert.equal(esc?.attempts, 1, 'attempts bumped');
    assert.equal(esc?.consultId, undefined, 'consultId cleared so the next tick re-asks');
    // The next drive re-asks a FRESH consult.
    await h.drive();
    assert.equal(h.asked.length, 2, 'a fresh consult is asked after the expiry');
  });

  await t.test('the SECOND expiry parks the mission at attention (P4 note names the pane, not resume/detach)', async () => {
    const h = harness({ deliverMs: 500 });
    // First expiry (attempts→1).
    await h.drive();
    let c = h.asked[0]!;
    h.cstore['consults'].set(c.id, { ...h.cstore.getById(c.id)!, askedAt: new Date(Date.now() - 1000).toISOString() });
    await h.drive();
    // Re-ask, then second expiry (attempts→2 = cap → giveUpEscalation).
    await h.drive();
    c = h.asked[1]!;
    h.cstore['consults'].set(c.id, { ...h.cstore.getById(c.id)!, askedAt: new Date(Date.now() - 1000).toISOString() });
    await h.drive();
    const m = h.store.getMission('m1')!;
    assert.equal(m.status, 'attention', 'the mission parks at the human gate');
    assert.match(m.stopReason ?? '', /planner consult expired/);
    assert.match(m.stopReason ?? '', /recreate the mission/, 'the honest P4 advice — never resume/detach');
    assert.doesNotMatch(m.stopReason ?? '', /detach the planner to use the built-in brain/);
  });

  await t.test('ANSWERED-first: a reply past the deadline is CONSUMED, never expired', async () => {
    const h = harness({ deliverMs: 500, answerMs: 500 });
    await h.drive(); // ask
    const c = h.asked[0]!;
    // Answer it, then age it well past both clocks: answered-first must win.
    h.cstore.recordAnswer(c.id, { phases: [{ name: 'more work', sorties: [{ name: 's', task: 'do it', provider: 'codex', role: 'implement' }] }] });
    h.cstore['consults'].set(c.id, { ...h.cstore.getById(c.id)!, askedAt: new Date(Date.now() - 5000).toISOString(), deliveredAt: new Date(Date.now() - 5000).toISOString() });
    await h.drive();
    assert.equal(h.cstore.getById(c.id)?.status, 'applied', 'the answer is consumed even past the deadline');
    const m = h.store.getMission('m1')!;
    assert.equal(m.loop!.round, 2, 'a new round was appended');
    assert.ok(m.phases.some((p) => p.name === 'more work'), 'the planned phase landed');
  });

  await t.test('a garbage reply is REJECTED and bumps attempts (no round appended)', async () => {
    const h = harness();
    await h.drive();
    const c = h.asked[0]!;
    h.cstore.recordAnswer(c.id, { phases: [] }); // sanitizes to zero usable phases
    await h.drive();
    assert.equal(h.cstore.getById(c.id)?.status, 'rejected');
    assert.equal(escOf(h.store)?.attempts, 1, 'a rejected reply costs an attempt');
    assert.equal(h.store.getMission('m1')!.loop!.round, 1, 'no round appended on a rejected reply');
  });

  await t.test('LOST planner (P1): respawns, migrates the open consult, renudges the new pane', async () => {
    const h = harness();
    await h.drive(); // ask against pt (planner live)
    const c = h.asked[0]!;
    // Now the pane vanishes mid-pend: mark lost. The lost-check must run FIRST (P1) — respawn + migrate.
    h.store.patchMission('m1', { planner: { ...h.store.getMission('m1')!.planner!, state: 'lost' } });
    await h.drive();
    assert.equal(h.spawned.length, 1, 'a replacement pane was spawned');
    const p = h.store.getMission('m1')!.planner!;
    assert.equal(p.state, 'live');
    assert.equal(p.terminalId, 'pt2', 'the binding moved to the new pane');
    assert.equal(p.respawns, 1);
    assert.equal(h.cstore.getById(c.id)?.terminalId, 'pt2', 'the open consult migrated to the new pane');
    assert.ok(h.nudged.includes(c.id), 'the new pane was renudged');
  });

  await t.test('ANSWERED-FIRST beats the lost-check: a lost planner with a stored reply CONSUMES it, never respawns', async () => {
    const h = harness(); // planner starts LIVE
    await h.drive(); // ask against pt
    const c = h.asked[0]!;
    // A valid reply lands, THEN the pane vanishes: the answer needs no pane, so it must be consumed —
    // not discarded to respawn (burning a lifetime respawn) or expired 'planner-unrecoverable'.
    h.cstore.recordAnswer(c.id, { phases: [{ name: 'more work', sorties: [{ name: 's', task: 'do it', provider: 'codex', role: 'implement' }] }] });
    h.store.patchMission('m1', { planner: { ...h.store.getMission('m1')!.planner!, state: 'lost' } });
    await h.drive();
    assert.equal(h.spawned.length, 0, 'a stored reply must NOT trigger a respawn');
    assert.equal(h.cstore.getById(c.id)?.status, 'applied', 'the reply is consumed, not expired');
    assert.equal(h.store.getMission('m1')!.loop!.round, 2, 'the planned round was appended');
    assert.equal(h.store.getMission('m1')!.status, 'running', 'the mission did not park at a gate');
  });

  await t.test('LOST planner past the respawn cap: expire the consult + park at the gate (never a codex fallthrough)', async () => {
    const h = harness({ plannerState: 'lost', respawns: 2 });
    await h.drive();
    assert.equal(h.spawned.length, 0, 'no respawn past the cap');
    const m = h.store.getMission('m1')!;
    assert.equal(m.status, 'attention');
    assert.match(m.stopReason ?? '', /could not be respawned/);
  });

  await t.test('a respawn that THROWS takes the bounded-attempt path (attempts+1, stays running)', async () => {
    const h = harness({ plannerState: 'lost', spawnThrows: true });
    await h.drive();
    assert.equal(h.store.getMission('m1')!.status, 'running', 'a thrown respawn stays running for one retry');
    assert.equal(escOf(h.store)?.attempts, 1);
  });

  await t.test('resume RE-ANCHORS an open consult so a pause longer than the clock does not burn the budget', async () => {
    const h = harness({ status: 'paused', deliverMs: 500 });
    // A pending consult that has been open longer than the delivery clock — exactly what a long pause
    // leaves. Seeded directly + linked to the escalating record (the tick can't run while paused).
    const c = h.cstore.create({ missionId: 'm1', terminalId: 'pt', kind: 'replan', question: 'q', payload: { goal: 'g', landed: [], failing: [], rounds: [] } });
    h.cstore.bumpNudges(c.id);
    h.setConsultId(c.id);
    h.age(c.id, 5000); // askedAt 5s ago, well past deliverMs=500
    const agedAt = h.cstore.getById(c.id)!.askedAt;

    await h.start(); // resume
    const reC = h.cstore.getById(c.id)!;
    assert.ok(Date.parse(reC.askedAt) > Date.parse(agedAt), 'resume re-anchored the delivery clock to now');
    assert.equal(reC.status, 'pending', 'the consult is not expired by the resume');

    // First post-resume tick: the re-anchored clock is fresh, so no expiry and NO attempt burned.
    await h.drive();
    assert.notEqual(h.cstore.getById(c.id)!.status, 'expired', 'the pause did not expire the consult');
    assert.equal(escOf(h.store)?.attempts, undefined, 'no escalation attempt was burned by the pause');

    // The clock still WORKS (reset, not disabled): let the FRESH clock elapse with no answer → it gates.
    h.age(c.id, 5000);
    await h.drive();
    assert.equal(h.cstore.getById(c.id)!.status, 'expired', 'a re-anchored consult still expires if never answered');
    assert.equal(escOf(h.store)?.attempts, 1, 'the fresh-clock expiry does bump attempts');
  });

  await t.test('a corrupt (non-parseable) askedAt still expires to a gate, never wedges pending forever', async () => {
    const h = harness();
    await h.drive(); // ask → a pending consult with a valid askedAt
    const c = h.asked[0]!;
    // Corrupt the timestamp — a hand-edited/tampered consults.json survives z.string(). Without the belt,
    // `now - Date.parse(garbage)` is NaN and `NaN > deliverMs` is false, so the clock would never fire.
    h.cstore['consults'].set(c.id, { ...h.cstore.getById(c.id)!, askedAt: 'not-a-timestamp' });
    await h.drive();
    assert.equal(h.cstore.getById(c.id)!.status, 'expired', 'a NaN active timestamp is treated as over-deadline');
    assert.equal(h.cstore.getById(c.id)!.expireReason, 'delivery-timeout');
  });
});
