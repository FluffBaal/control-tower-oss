// SPEC-RESEARCH W9 — the research artifact's load-bearing pieces.
//
// Three things carry the wave and each is asserted here:
//  1. the reconcile-time FINDING GATE — a research sortie that finished without submitting must reach
//     attention, never land. That is the never-silent-pass rule for this wave, and it is the only
//     guarantee (the check belt merely steers: a well-behaved researcher writes nothing, so its loop
//     resolves 'landed' mechanically whether or not a finding exists);
//  2. the STORE's upsert-replace + per-mission bound — the bound has to be high enough that pruning
//     can never make the gate's note ("finished without submitting") false about a sortie that did;
//  3. the M6 strip-trap — the marker surviving a store round-trip, without which every research
//     mission loses its markers on the first restart and the gate silently stops firing.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mission, MissionSortie, ResearchRecord } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-research-test-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { ResearchStore, buildResearchDigest } = await import('./research.js');
const { Store } = await import('./store.js');
const { Missions } = await import('./missions.js');

const iso = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

test('ResearchStore — upsert-replace, reads, and the per-mission bound', async (t) => {
  await t.test('upsert stores a finding and getFor reads it back', () => {
    rmSync(paths.research, { force: true });
    const store = new ResearchStore();
    const rec = store.upsert({ missionId: 'm1', sortieId: 's1', topic: 'auth', summary: 'it uses JWTs' });
    assert.equal(store.getFor('m1', 's1')?.id, rec.id);
    assert.equal(store.getFor('m1', 's1')?.summary, 'it uses JWTs');
    assert.equal(store.getFor('m1', 'other'), undefined, 'scoped to the sortie');
    assert.equal(store.getFor('other', 's1'), undefined, 'scoped to the mission');
  });

  await t.test('a resubmit REPLACES the prior record with a fresh id', () => {
    // The in-place retry of a landed research sortie depends on this: write-once would make the retry
    // a no-op that re-lands the stale finding.
    rmSync(paths.research, { force: true });
    const store = new ResearchStore();
    const first = store.upsert({ missionId: 'm1', sortieId: 's1', topic: 'a', summary: 'first' });
    const second = store.upsert({ missionId: 'm1', sortieId: 's1', topic: 'a', summary: 'second' });
    assert.notEqual(second.id, first.id, 'a fresh id, not an in-place edit');
    assert.equal(store.listFor('m1').length, 1, 'the prior record is gone, not merely shadowed');
    assert.equal(store.getFor('m1', 's1')?.summary, 'second');
  });

  await t.test('listFor is newest-first and mission-scoped', () => {
    rmSync(paths.research, { force: true });
    const store = new ResearchStore();
    store.upsert({ missionId: 'm1', sortieId: 's1', topic: 'a', summary: 'one' });
    store.upsert({ missionId: 'm1', sortieId: 's2', topic: 'b', summary: 'two' });
    store.upsert({ missionId: 'm2', sortieId: 's3', topic: 'c', summary: 'three' });
    const list = store.listFor('m1');
    assert.equal(list.length, 2);
    assert.ok(list[0]!.submittedAt >= list[1]!.submittedAt, 'newest first');
    assert.equal(store.listFor('m2').length, 1);
  });

  await t.test('the per-mission bound survives a plausible fan-out', () => {
    // The bound must not be reachable by authoring: a pruned record would make the finding gate's
    // note (that no finding was submitted) FALSE about a sortie that did submit, and
    // retrying it would evict the next oldest in turn.
    rmSync(paths.research, { force: true });
    const store = new ResearchStore();
    for (let i = 0; i < 40; i++) {
      store.upsert({ missionId: 'm1', sortieId: `s${i}`, topic: `t${i}`, summary: 'x' });
    }
    assert.equal(store.listFor('m1').length, 40, 'a 40-researcher mission keeps every finding');
    assert.ok(store.getFor('m1', 's0'), 'including the first one submitted');
  });

  await t.test('pruning is per-mission, never a global blanket', () => {
    rmSync(paths.research, { force: true });
    const store = new ResearchStore();
    for (let i = 0; i < 120; i++) store.upsert({ missionId: 'big', sortieId: `s${i}`, topic: 't', summary: 'x' });
    store.upsert({ missionId: 'small', sortieId: 'only', topic: 't', summary: 'kept' });
    assert.equal(store.listFor('big').length, 100, 'the over-bound mission is trimmed');
    assert.equal(store.listFor('small').length, 1, "…and another mission's record is untouched");
  });

  await t.test('records survive a reload, and caps truncate rather than reject', () => {
    rmSync(paths.research, { force: true });
    const store = new ResearchStore();
    store.upsert({
      missionId: 'm1', sortieId: 's1',
      topic: 'T'.repeat(500), summary: 'S'.repeat(20_000),
      citations: Array.from({ length: 50 }, (_, i) => ({ ref: `r${i}` })),
    });
    const reloaded = new ResearchStore().getFor('m1', 's1');
    assert.ok(reloaded, 'the record survives a restart');
    assert.equal(reloaded!.topic.length, 200);
    assert.equal(reloaded!.summary.length, 8192);
    assert.equal(reloaded!.citations!.length, 20);
  });

  await t.test('a torn file is quarantined, never silently wiped', () => {
    writeFileSync(paths.research, '{ not an array');
    const store = new ResearchStore();
    assert.equal(store.listFor('m1').length, 0);
    const quarantined = existsSync(paths.research)
      ? readFileSync(paths.research, 'utf8')
      : '';
    assert.notEqual(quarantined, '{ not an array', 'the corrupt bytes are not left in place as the live file');
  });
});

test('buildResearchDigest', async (t) => {
  const rec = (o: Partial<ResearchRecord>): ResearchRecord => ({
    id: 'r', missionId: 'm', sortieId: 's', topic: 'topic', summary: 'summary', submittedAt: iso(0), ...o,
  });

  await t.test('renders one block per finding, newest-first order preserved', () => {
    const out = buildResearchDigest([rec({ topic: 'A', summary: 'first' }), rec({ topic: 'B', summary: 'second' })],
      { perFinding: 100, total: 1000 });
    assert.match(out, /A — first/);
    assert.match(out, /B — second/);
    assert.ok(out.indexOf('A — first') < out.indexOf('B — second'));
  });

  await t.test('slices per finding AND overall', () => {
    const out = buildResearchDigest([rec({ topic: 'A', summary: 'x'.repeat(500) })], { perFinding: 20, total: 1000 });
    assert.ok(out.length < 60, `per-finding slice applied: ${out.length}`);
    const many = buildResearchDigest(Array.from({ length: 50 }, () => rec({ summary: 'y'.repeat(100) })),
      { perFinding: 100, total: 200 });
    assert.equal(many.length, 200, 'the total cap is exact');
  });

  await t.test('an untitled finding still renders, and citations become ref markers', () => {
    const out = buildResearchDigest([rec({ topic: '  ', summary: 'body', citations: [{ ref: 'src/a.ts' }, { ref: 'https://x' }] })],
      { perFinding: 100, total: 1000 });
    assert.match(out, /\(untitled\) — body/);
    assert.match(out, /\[src\/a\.ts\] \[https:\/\/x\]/);
  });

  await t.test('no findings ⇒ empty string (the callers omit the section entirely)', () => {
    assert.equal(buildResearchDigest([], { perFinding: 100, total: 1000 }), '');
  });
});

/** A mission with one research sortie whose loop has resolved the way a well-behaved researcher's does:
 *  stopped with nothing to land. That is the shape the gate has to catch. */
function gateFixture(opts: { withStore: boolean; submitted: boolean }) {
  const store = new Store();
  const repo = join(home, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  const now = new Date().toISOString();
  store.upsertProject({ id: 'p1', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: now });
  const sortie: MissionSortie = { id: 's1', name: 'research', task: 'find out', status: 'active', loopId: 'l1', researchSortie: true };
  const mission: Mission = {
    id: 'm1', projectId: 'p1', name: 'm', goal: 'g', provider: 'codex', advance: 'gate',
    maxIterationsPerSortie: 4, concurrency: 1,
    phases: [{ id: 'ph1', name: 'research', sorties: [sortie] }],
    activePhase: 0, status: 'running', createdAt: now, updatedAt: now,
  };
  store.upsertMission(mission);

  rmSync(paths.research, { force: true });
  const research = new ResearchStore();
  if (opts.submitted) research.upsert({ missionId: 'm1', sortieId: 's1', topic: 't', summary: 'what I found' });

  const missions = new Missions({
    store,
    // The loop resolved the no-change way: stopped, nothing to land.
    loops: {
      get: () => ({ id: 'l1', status: 'stopped', noChangesToLand: true, branch: 'agent/research' }),
      list: () => [],
      create: async () => ({ id: 'l1', status: 'running' }),
      stop: () => {},
    },
    onUpdate: () => {},
    ...(opts.withStore ? { research } : {}),
  } as never);

  const inner = missions as unknown as {
    reconcileSortie(m: Mission, s: MissionSortie): MissionSortie;
  };
  return { reconcile: () => inner.reconcileSortie(store.getMission('m1')!, sortie) };
}

test('the finding gate — a research sortie never lands without a submitted finding', async (t) => {
  await t.test('no finding ⇒ attention with an actionable note, NOT landed', () => {
    // Without this gate the sortie lands: its loop stopped with zero commits, which for a researcher
    // is the CORRECT mechanical outcome — the loop cannot tell "researched and reported" from
    // "produced nothing at all". Only the store can.
    const out = gateFixture({ withStore: true, submitted: false }).reconcile();
    assert.equal(out.status, 'attention');
    assert.match(out.note ?? '', /never submitted one, or the finding could not be read/);
    assert.match(out.note ?? '', /towerctl research submit/, 'the note says how to fix it');
  });

  await t.test('a submitted finding ⇒ the sortie resolves normally', () => {
    const out = gateFixture({ withStore: true, submitted: true }).reconcile();
    assert.notEqual(out.status, 'attention');
    assert.equal(out.status, 'landed');
  });

  await t.test('an UNWIRED store ⇒ attention, never a skip', () => {
    // The W6 reviews-unavailable posture: an unreadable store must not let a finding-less researcher
    // through. Failing open here would be a silent pass on the exact artifact the wave exists for.
    const out = gateFixture({ withStore: false, submitted: false }).reconcile();
    assert.equal(out.status, 'attention');
    assert.match(out.note ?? '', /research store unavailable/);
  });
});

test('a retried research sortie does not inherit the discarded finding', async (t) => {
  // The silent pass this closes: retry() re-arms the sortie but keeps the record (the operator may
  // want to compare runs), and the sortie id is unchanged — so without a freshness test the PREVIOUS
  // run's finding answers for the new one. The sortie then lands on work the operator explicitly
  // rejected, and the report, the spawn digest and the re-planner bundle all present it as the
  // retry's output.
  const fixture = (retryAt: string | undefined, submittedAt: string) => {
    const store = new Store();
    const repo = join(home, `repo-retry-${Math.random().toString(36).slice(2)}`);
    mkdirSync(repo, { recursive: true });
    const now = new Date().toISOString();
    store.upsertProject({ id: 'pr', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: now });
    const sortie: MissionSortie = {
      id: 's1', name: 'research', task: 'q', status: 'active', loopId: 'l1', researchSortie: true,
      ...(retryAt !== undefined ? { researchRetryAt: retryAt } : {}),
    };
    const m: Mission = {
      id: 'mr', projectId: 'pr', name: 'm', goal: 'g', provider: 'codex', advance: 'gate',
      maxIterationsPerSortie: 4, concurrency: 1,
      phases: [{ id: 'ph', name: 'research', sorties: [sortie] }],
      activePhase: 0, status: 'running', createdAt: now, updatedAt: now,
    };
    store.upsertMission(m);
    rmSync(paths.research, { force: true });
    const research = new ResearchStore();
    // A record whose submittedAt we control, written directly so the timing is exact.
    const rec = research.upsert({ missionId: 'mr', sortieId: 's1', topic: 'old', summary: 'the first run' });
    const all = JSON.parse(readFileSync(paths.research, 'utf8')) as ResearchRecord[];
    writeFileSync(paths.research, JSON.stringify(all.map((r) => (r.id === rec.id ? { ...r, submittedAt } : r))));
    const fresh = new ResearchStore();
    const missions = new Missions({
      store,
      loops: {
        get: () => ({ id: 'l1', status: 'stopped', noChangesToLand: true, branch: 'agent/research' }),
        list: () => [], create: async () => ({ id: 'l1', status: 'running' }), stop: () => {},
      },
      onUpdate: () => {}, research: fresh,
    } as never);
    const inner = missions as unknown as { reconcileSortie(m1: Mission, s: MissionSortie): MissionSortie };
    return { out: () => inner.reconcileSortie(store.getMission('mr')!, sortie), store: fresh };
  };

  await t.test('GATE: a finding submitted BEFORE the retry reads as absent ⇒ attention', () => {
    const f = fixture(iso(30), iso(10)); // retried at :30, the finding is from :10
    const out = f.out();
    assert.equal(out.status, 'attention');
    assert.match(out.note ?? '', /predates this retry/);
  });

  await t.test('GATE: a finding submitted AFTER the retry resolves the sortie', () => {
    const f = fixture(iso(10), iso(30)); // retried at :10, the new run submitted at :30
    assert.equal(f.out().status, 'landed');
  });

  await t.test('GATE: an un-retried sortie is unaffected (back-compat)', () => {
    const f = fixture(undefined, iso(10));
    assert.equal(f.out().status, 'landed');
  });

  await t.test('retry() actually WRITES the stamp (the fixtures above set it by hand)', () => {
    // Without this the freshness checks are only as good as their fixtures: retry() could stop
    // stamping and every other test here would still pass while the hole silently reopened.
    const store = new Store();
    const repo = join(home, `repo-stamp-${Math.random().toString(36).slice(2)}`);
    mkdirSync(repo, { recursive: true });
    const now = new Date().toISOString();
    store.upsertProject({ id: 'ps', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: now });
    store.upsertMission({
      id: 'ms', projectId: 'ps', name: 'm', goal: 'g', provider: 'codex', advance: 'gate',
      maxIterationsPerSortie: 4, concurrency: 1,
      phases: [{ id: 'ph', name: 'research', sorties: [
        { id: 's1', name: 'research', task: 'q', status: 'landed', loopId: 'l1', researchSortie: true },
        { id: 's2', name: 'build', task: 'b', status: 'landed', loopId: 'l2', noChangeLanded: true },
      ] }],
      activePhase: 0, status: 'attention', createdAt: now, updatedAt: now,
    } as never);
    const missions = new Missions({
      store,
      loops: { get: () => ({ id: 'l1', status: 'stopped' }), list: () => [], create: async () => ({ id: 'l1', status: 'running' }), stop: () => {} },
      onUpdate: () => {},
    } as never);
    (missions as unknown as { retry(m: string, s: string): unknown }).retry('ms', 's1');
    const after = store.getMission('ms')!.phases[0]!.sorties;
    const researched = after.find((x) => x.id === 's1')!;
    assert.equal(researched.status, 'pending', 're-armed');
    assert.ok(researched.researchRetryAt, 'retry() must stamp a research sortie');
    assert.ok(Date.parse(researched.researchRetryAt!) > 0, 'and the stamp must be a real timestamp');
    // A non-research sortie must not gain the stamp.
    (missions as unknown as { retry(m: string, s: string): unknown }).retry('ms', 's2');
    assert.equal(store.getMission('ms')!.phases[0]!.sorties.find((x) => x.id === 's2')!.researchRetryAt, undefined);
  });

  await t.test('the record itself is KEPT, so the operator can still compare runs', () => {
    const f = fixture(iso(30), iso(10));
    f.out();
    assert.ok(f.store.getFor('mr', 's1'), 'the stale finding is hidden from the readers, not deleted');
  });
});

test('a research phase fans out WITHOUT redefining the mission\'s concurrency', async (t) => {
  // A research phase is typically the mission's FIRST phase. Persisting a concurrency raise here
  // would silently override the operator's choice for every BUILD phase that follows — and
  // concurrency 1 is a real decision on missions whose builders touch overlapping files, where the
  // batched land at each phase boundary is exactly where it bites.
  const fixture = () => {
    const store = new Store();
    const repo = join(home, `repo-fan-${Math.random().toString(36).slice(2)}`);
    mkdirSync(repo, { recursive: true });
    const now = new Date().toISOString();
    store.upsertProject({ id: 'pf', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: now });
    store.upsertMission({
      id: 'mf', projectId: 'pf', name: 'm', goal: 'g', provider: 'codex', advance: 'gate',
      maxIterationsPerSortie: 4, concurrency: 1, // the operator's explicit choice
      phases: [{ id: 'ph', name: 'research', sorties: [
        { id: 'r1', name: 'q1', task: 'a', status: 'pending', researchSortie: true },
        { id: 'r2', name: 'q2', task: 'b', status: 'pending', researchSortie: true },
        { id: 'r3', name: 'q3', task: 'c', status: 'pending', researchSortie: true },
      ] }],
      activePhase: 0, status: 'running', createdAt: now, updatedAt: now,
    } as never);
    let created = 0;
    const missions = new Missions({
      store,
      loops: {
        create: async () => { created++; return { id: `l${created}`, status: 'running' }; },
        list: () => [], get: () => undefined, stop: () => {},
      },
      onUpdate: () => {},
    } as never);
    return {
      drive: () => (missions as unknown as { reconcileAndStart(id: string): Promise<void> }).reconcileAndStart('mf'),
      created: () => created,
      concurrency: () => store.getMission('mf')!.concurrency,
    };
  };

  await t.test('all three researchers launch despite concurrency 1', async () => {
    const f = fixture();
    await f.drive();
    assert.equal(f.created(), 3, 'the phase fans out');
  });

  await t.test('…and the mission\'s authored concurrency is UNCHANGED afterwards', async () => {
    const f = fixture();
    await f.drive();
    assert.equal(f.concurrency(), 1, 'the raise must not persist into the mission record');
  });
});

test('the marker survives a store round-trip (the M6 strip-trap)', async () => {
  // Without the zod line every research mission loses its markers on the first restart: the gate stops
  // firing, the submit route 404s, and a finding-less researcher lands silently.
  const store = new Store();
  const now = new Date().toISOString();
  store.upsertProject({ id: 'p9', name: 'p', repoPath: join(home, 'r9'), scaffoldMode: 'zero-footprint', createdAt: now });
  store.upsertMission({
    id: 'm9', projectId: 'p9', name: 'm', goal: 'g', provider: 'codex', advance: 'gate',
    maxIterationsPerSortie: 4, concurrency: 1,
    phases: [{ id: 'ph', name: 'research', sorties: [
      { id: 's1', name: 'r', task: 't', status: 'pending', researchSortie: true },
      { id: 's2', name: 'b', task: 't', status: 'pending' },
    ] }],
    activePhase: 0, status: 'draft', createdAt: now, updatedAt: now,
  } as never);
  const reloaded = new Store().getMission('m9');
  assert.equal(reloaded?.phases[0]?.sorties[0]?.researchSortie, true, 'the marker must not be stripped on load');
  assert.equal(reloaded?.phases[0]?.sorties[1]?.researchSortie, undefined, 'an unmarked sortie stays unmarked');
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
