// SPEC-LOOP — the ReviewStore CRUD/prune, the review-retry freshness predicates, and the two places the
// freshness axis is load-bearing: resolveReviewState (the completion gate) and retry() (the stamp). The
// axis must NEVER fail open — a retried reviewer that never resubmits must not let the loop terminate
// clean off the review the operator threw away — so the LOCK cases drive the real code, not a hand-set
// verdict, and a mutant that drops the stale check is caught here.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mission, MissionLoop, MissionSortie, ReviewFinding, ReviewRecord } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-reviews-test-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { Missions } = await import('./missions.js');
const { ReviewStore, isStaleReviewRecord, isPreRetryReviewLoop } = await import('./reviews.js');

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return { file: 'src/a.ts', summary: 's', ...over };
}

// ---------------------------------------------------------------------------------------------------

test('ReviewStore — upsert/getFor/getById/listFor/prune', async (t) => {
  function fresh(): InstanceType<typeof ReviewStore> {
    rmSync(paths.reviews, { force: true });
    return new ReviewStore();
  }

  await t.test('upsert stores a record readable by getFor and getById', () => {
    const s = fresh();
    const rec = s.upsert({ missionId: 'm1', sortieId: 'r1', findings: [finding()] });
    assert.equal(s.getFor('m1', 'r1')?.id, rec.id);
    assert.equal(s.getById(rec.id)?.id, rec.id);
    assert.ok(rec.submittedAt, 'submittedAt is stamped');
  });

  await t.test('upsert REPLACES the prior (missionId,sortieId) record with a fresh id — old id is loud', () => {
    const s = fresh();
    const first = s.upsert({ missionId: 'm1', sortieId: 'r1', findings: [finding()] });
    const second = s.upsert({ missionId: 'm1', sortieId: 'r1', findings: [finding({ summary: 'again' })] });
    assert.notEqual(second.id, first.id, 'the resubmit gets a fresh id');
    assert.equal(s.getById(first.id), undefined, 'the old id resolves to undefined (a stale by-id pin is loud)');
    assert.equal(s.getFor('m1', 'r1')?.id, second.id);
  });

  await t.test('listFor is mission-scoped and newest first', async () => {
    const s = fresh();
    s.upsert({ missionId: 'm1', sortieId: 'a', findings: [] });
    await new Promise((r) => setTimeout(r, 3));
    s.upsert({ missionId: 'm1', sortieId: 'b', findings: [] });
    s.upsert({ missionId: 'm2', sortieId: 'c', findings: [] });
    const list = s.listFor('m1');
    assert.equal(list.length, 2, 'only m1 records');
    assert.ok(list[0]!.submittedAt >= list[1]!.submittedAt, 'newest first');
  });

  await t.test('prune keeps only the newest 20 per mission', () => {
    const s = fresh();
    for (let i = 0; i < 25; i++) s.upsert({ missionId: 'big', sortieId: `s${i}`, findings: [] });
    assert.equal(s.listFor('big').length, 20, 'trimmed to the per-mission bound');
  });

  await t.test('records survive a reload through zod', () => {
    const s = fresh();
    const rec = s.upsert({ missionId: 'm1', sortieId: 'r1', findings: [finding({ verdict: 'CONFIRMED' })] });
    const reloaded = new ReviewStore().getById(rec.id);
    assert.equal(reloaded?.findings[0]?.verdict, 'CONFIRMED');
  });
});

// ---------------------------------------------------------------------------------------------------

test('review-retry freshness predicates — truth tables', async (t) => {
  const rec = (submittedAt: string): ReviewRecord => ({ id: 'x', missionId: 'm', sortieId: 's', findings: [], submittedAt });

  await t.test('isStaleReviewRecord: stale ONLY when a record predates the stamp', () => {
    // no stamp → never stale (the pre-retry world; every record is current)
    assert.equal(isStaleReviewRecord(rec('2020-06-01T00:00:00.000Z'), undefined), false);
    // no record → never stale (absence is handled by the caller's `!record`)
    assert.equal(isStaleReviewRecord(undefined, '2020-06-01T00:00:00.000Z'), false);
    // submitted BEFORE the stamp → stale
    assert.equal(isStaleReviewRecord(rec('2020-01-01T00:00:00.000Z'), '2020-06-01T00:00:00.000Z'), true);
    // submitted AFTER the stamp → fresh
    assert.equal(isStaleReviewRecord(rec('2020-12-01T00:00:00.000Z'), '2020-06-01T00:00:00.000Z'), false);
    // strict `<` — a same-millisecond record reads as FRESH (the deliberate 1ms window)
    assert.equal(isStaleReviewRecord(rec('2020-06-01T00:00:00.000Z'), '2020-06-01T00:00:00.000Z'), false);
  });

  await t.test('isPreRetryReviewLoop: a loop is discarded ONLY when created before the stamp', () => {
    assert.equal(isPreRetryReviewLoop('2020-06-01T00:00:00.000Z', undefined), false, 'no stamp → nothing discarded');
    assert.equal(isPreRetryReviewLoop('2020-01-01T00:00:00.000Z', '2020-06-01T00:00:00.000Z'), true, 'created before → discarded');
    assert.equal(isPreRetryReviewLoop('2020-12-01T00:00:00.000Z', '2020-06-01T00:00:00.000Z'), false, 'created after (the replacement) → kept');
    assert.equal(isPreRetryReviewLoop('2020-06-01T00:00:00.000Z', '2020-06-01T00:00:00.000Z'), false, 'strict `<` — same ms is kept');
  });
});

// ---------------------------------------------------------------------------------------------------

const OLD = '2020-01-01T00:00:00.000Z';
const STAMP = '2020-06-01T00:00:00.000Z';
const NEW = '2020-12-01T00:00:00.000Z';

/** A Missions instance whose reviews dep always returns `record` for the reviewer sortie. */
function missionsWith(record: ReviewRecord | undefined) {
  const store = new Store();
  const reviews = {
    getFor: () => record,
    getById: () => record,
    latestFor: () => record,
  };
  const missions = new Missions({
    store,
    loops: { create: async () => ({ id: 'l', status: 'running' }), list: () => [], get: () => undefined, stop: () => {} },
    onUpdate: () => {},
    terminalCapacity: () => ({ ok: true, detail: '' }),
    reviews,
  } as never);
  return missions as unknown as { resolveReviewState(m: Mission, l: MissionLoop): { kind: string; plausible?: number; confirmedFiles?: number } };
}

/** A loop mission: a build phase (code) then a review phase whose reviewer carries `reviewRetryAt`. */
function loopMission(reviewRetryAt?: string): Mission {
  const now = new Date().toISOString();
  const reviewer: MissionSortie = { id: 'r1', name: 'review', task: 't', status: 'landed', reviewFromRange: 'base..head' };
  if (reviewRetryAt !== undefined) reviewer.reviewRetryAt = reviewRetryAt;
  const loop: MissionLoop = { maxRounds: 8, mechanicalRounds: 2, sortieBudget: 16, round: 2, rounds: [] };
  return {
    id: 'm1', projectId: 'p1', name: 'm', goal: 'g', provider: 'codex', advance: 'auto',
    maxIterationsPerSortie: 8, concurrency: 4,
    phases: [
      { id: 'ph0', name: 'build', stage: 'build', sorties: [{ id: 'b1', name: 'build', task: 't', status: 'landed' }] },
      { id: 'ph1', name: 'review', stage: 'review', round: 2, sorties: [reviewer] },
    ],
    activePhase: 1, loop, status: 'running', createdAt: now, updatedAt: now,
  };
}

const rec = (submittedAt: string, findings: ReviewFinding[] = []): ReviewRecord => ({
  id: 'rec', missionId: 'm1', sortieId: 'r1', findings, submittedAt,
});

test('resolveReviewState — the branches and THE LOCK', async (t) => {
  await t.test('a fresh review with 0 confirmed findings is clean', () => {
    const m = missionsWith(rec(NEW));
    assert.deepEqual(m.resolveReviewState(loopMission(), loopMission().loop!), { kind: 'clean', plausible: 0 });
  });

  await t.test('a fresh review with a confirmed finding needs a fix round', () => {
    const m = missionsWith(rec(NEW, [finding({ verdict: 'CONFIRMED' })]));
    const out = m.resolveReviewState(loopMission(), loopMission().loop!);
    assert.equal(out.kind, 'findings');
    assert.equal(out.confirmedFiles, 1);
  });

  await t.test('an absent record needs a review', () => {
    const m = missionsWith(undefined);
    assert.equal(m.resolveReviewState(loopMission(), loopMission().loop!).kind, 'needs-review');
  });

  await t.test('THE LOCK — a pre-stamp record after a retry is NEVER clean (needs-review)', () => {
    // The record has 0 confirmed findings, so without the freshness axis this would return {kind:'clean'}
    // and the loop would terminate attested-clean off the review the operator threw away.
    const m = missionsWith(rec(OLD)); // submitted before the retry stamp
    const mission = loopMission(STAMP); // reviewer retried at STAMP > OLD
    assert.equal(m.resolveReviewState(mission, mission.loop!).kind, 'needs-review');
  });

  await t.test('THE LOCK — a post-stamp resubmit reads through as clean (the replacement reviewer)', () => {
    const m = missionsWith(rec(NEW)); // the replacement resubmitted after the stamp
    const mission = loopMission(STAMP);
    assert.deepEqual(m.resolveReviewState(mission, mission.loop!), { kind: 'clean', plausible: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------

/** A running mission with one phase holding the given attention'd sortie, plus a retry() driver. */
function retryFixture(sortie: MissionSortie) {
  const store = new Store();
  const repo = join(home, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  store.upsertProject({ id: 'p1', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  const now = new Date().toISOString();
  const mission: Mission = {
    id: 'm1', projectId: 'p1', name: 'm', goal: 'g', provider: 'codex', advance: 'gate',
    maxIterationsPerSortie: 8, concurrency: 4,
    phases: [{ id: 'ph0', name: 'ph', sorties: [sortie] }],
    activePhase: 0, status: 'running', createdAt: now, updatedAt: now,
  };
  store.upsertMission(mission);
  const missions = new Missions({
    store,
    loops: { create: async () => ({ id: 'l', status: 'running' }), list: () => [], get: () => undefined, stop: () => {} },
    onUpdate: () => {},
    terminalCapacity: () => ({ ok: true, detail: '' }),
  } as never);
  return {
    retry: () => (missions as unknown as { retry(m: string, s: string): unknown }).retry('m1', sortie.id),
    read: () => store.getMission('m1')!.phases[0]!.sorties[0]!,
  };
}

test('retry() stamps reviewRetryAt for a reviewer JUDGE, never a builder or a review-fixer', async (t) => {
  await t.test('a pending reviewer (reviewSortie) gets stamped', () => {
    const f = retryFixture({ id: 'r1', name: 'rev', task: 't', status: 'attention', reviewSortie: true });
    f.retry();
    assert.ok(f.read().reviewRetryAt, 'reviewRetryAt stamped for a reviewSortie=true judge');
  });

  await t.test('a finalized reviewer (reviewFromRange) gets stamped AND re-armed', () => {
    const f = retryFixture({ id: 'r1', name: 'rev', task: 't', status: 'attention', reviewFromRange: 'base..head' });
    f.retry();
    const s = f.read();
    assert.ok(s.reviewRetryAt, 'reviewRetryAt stamped for a finalized reviewer');
    assert.equal(s.reviewSortie, true, 're-armed to re-finalize its range');
    assert.equal(s.reviewFromRange, undefined, 'the pin is cleared');
  });

  await t.test('a plain builder is NOT stamped', () => {
    const f = retryFixture({ id: 'b1', name: 'build', task: 't', status: 'attention' });
    f.retry();
    assert.equal(f.read().reviewRetryAt, undefined, 'no review markers → no stamp');
  });

  await t.test('a review-FIX sortie is NOT stamped (a fixer lands code and pins by id)', () => {
    const f = retryFixture({ id: 'f1', name: 'fix', task: 't', status: 'attention', assignedFromReview: 'recX' });
    f.retry();
    const s = f.read();
    assert.equal(s.reviewRetryAt, undefined, 'a fixer never carries the reviewer freshness stamp');
    assert.equal(s.reviewFixer, true, 'but its own fixer marker is re-armed');
  });
});

// ---------------------------------------------------------------------------------------------------

test('M6 strip-trap — reviewRetryAt survives a Store reload', () => {
  const s1 = new Store();
  const repo = join(home, `repo-m6-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  s1.upsertProject({ id: 'pm6', name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  const now = new Date().toISOString();
  s1.upsertMission({
    id: 'mm6', projectId: 'pm6', name: 'm', goal: 'g', provider: 'codex', advance: 'gate',
    maxIterationsPerSortie: 8, concurrency: 4,
    phases: [{ id: 'ph0', name: 'ph', sorties: [{ id: 'r1', name: 'rev', task: 't', status: 'attention', reviewSortie: true, reviewRetryAt: STAMP }] }],
    activePhase: 0, status: 'running', createdAt: now, updatedAt: now,
  });
  const reloaded = new Store().getMission('mm6');
  assert.equal(reloaded?.phases[0]?.sorties[0]?.reviewRetryAt, STAMP, 'the stamp is not zod-stripped on load');
});

// ---------------------------------------------------------------------------------------------------
// The shared store.ts readJsonArray loader (reviews.ts now delegates to it) — the corruption-safety
// contract must still hold (mirrors consults.test.ts).

test('reviews.json — a torn file is quarantined, never silently wiped (shared loader)', () => {
  writeFileSync(paths.reviews, '{ not an array');
  const s = new ReviewStore();
  assert.equal(s.listFor('m1').length, 0);
  const live = existsSync(paths.reviews) ? readFileSync(paths.reviews, 'utf8') : '';
  assert.notEqual(live, '{ not an array', 'the corrupt bytes are not left in place as the live file');
});

test('reviews.json — one invalid record is skipped without wiping the valid ones (shared loader)', () => {
  rmSync(paths.reviews, { force: true });
  const good = new ReviewStore().upsert({ missionId: 'm1', sortieId: 'r1', findings: [finding()] });
  const raw = JSON.parse(readFileSync(paths.reviews, 'utf8')) as unknown[];
  raw.push({ id: 'bad', missionId: 'm1' }); // missing sortieId/findings/submittedAt → invalid
  writeFileSync(paths.reviews, JSON.stringify(raw));
  const reloaded = new ReviewStore();
  assert.ok(reloaded.getById(good.id), 'the valid record survives');
  assert.equal(reloaded.getById('bad'), undefined, 'the invalid one is dropped');
});

process.on('exit', () => {
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});
