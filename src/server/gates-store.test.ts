// SPEC-SKILLS-GATE — the GateEvidenceStore CRUD/prune and the schema's FAIL-CLOSED posture. The store
// is the completion evaluator's only evidence source for the loop-green gate, so two properties are
// load-bearing: a resubmit REPLACES per (missionId, gateId) — a later 'fail' must overwrite an earlier
// 'pass', last attestation wins — and an unknown status can never load as anything but 'fail' (a
// mangled record must block, not pass, and must not be DROPPED either, or it would read as a different
// flavor of "no evidence" while hiding the fail from the operator).
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time. The real ~/.ct is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-gates-store-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { GateEvidenceStore } = await import('./gates.js');

test('GateEvidenceStore — upsert/getFor/listFor/prune', async (t) => {
  function fresh(): InstanceType<typeof GateEvidenceStore> {
    rmSync(paths.gates, { force: true });
    return new GateEvidenceStore();
  }

  await t.test('upsert stores a record readable by getFor', () => {
    const s = fresh();
    const rec = s.upsert({ missionId: 'm1', sortieId: 's1', gateId: 'g1', status: 'pass' });
    assert.equal(s.getFor('m1', 'g1')?.id, rec.id);
    assert.equal(s.getFor('m1', 'g1')?.status, 'pass');
    assert.ok(rec.submittedAt, 'submittedAt is stamped');
  });

  await t.test('upsert REPLACES the prior (missionId,gateId) record with a fresh id — the old one is gone', () => {
    const s = fresh();
    const first = s.upsert({ missionId: 'm1', sortieId: 's1', gateId: 'g1', status: 'pass' });
    const second = s.upsert({ missionId: 'm1', sortieId: 's2', gateId: 'g1', status: 'pass' });
    assert.notEqual(second.id, first.id, 'the resubmit gets a fresh id');
    assert.equal(s.listFor('m1').length, 1, 'exactly one record survives per (mission, gate)');
    assert.equal(s.getFor('m1', 'g1')?.id, second.id);
  });

  await t.test('a later FAIL overwrites an earlier PASS — last attestation wins', () => {
    const s = fresh();
    s.upsert({ missionId: 'm1', sortieId: 's1', gateId: 'g1', status: 'pass' });
    s.upsert({ missionId: 'm1', sortieId: 's1', gateId: 'g1', status: 'fail', summary: 'regressed' });
    const rec = s.getFor('m1', 'g1');
    assert.equal(rec?.status, 'fail', 'the honest current attestation is the fail');
    assert.equal(rec?.summary, 'regressed');
  });

  await t.test('records for different gateIds coexist under one mission', () => {
    const s = fresh();
    s.upsert({ missionId: 'm1', sortieId: 's1', gateId: 'g1', status: 'pass' });
    s.upsert({ missionId: 'm1', sortieId: 's1', gateId: 'g2', status: 'fail' });
    assert.equal(s.getFor('m1', 'g1')?.status, 'pass');
    assert.equal(s.getFor('m1', 'g2')?.status, 'fail');
    assert.equal(s.listFor('m1').length, 2);
  });

  await t.test('listFor is mission-scoped and newest first', async () => {
    const s = fresh();
    s.upsert({ missionId: 'm1', sortieId: 'a', gateId: 'g1', status: 'pass' });
    await new Promise((r) => setTimeout(r, 3));
    s.upsert({ missionId: 'm1', sortieId: 'b', gateId: 'g2', status: 'pass' });
    s.upsert({ missionId: 'm2', sortieId: 'c', gateId: 'g1', status: 'pass' });
    const list = s.listFor('m1');
    assert.equal(list.length, 2, 'only m1 records');
    assert.ok(list[0]!.submittedAt >= list[1]!.submittedAt, 'newest first');
  });

  await t.test('LIVELOCK REGRESSION — GC never prunes within a mission: >20 distinct gates ALL keep their evidence', () => {
    // upsert dedupes to one record per (missionId, gateId), so ANY within-mission record cap would
    // evict a live gate's only pass and park a fully-attested loop at attention forever.
    const s = fresh();
    s.upsert({ missionId: 'sibling', sortieId: 's', gateId: 'g0', status: 'pass' });
    for (let i = 0; i < 25; i++) s.upsert({ missionId: 'big', sortieId: 's', gateId: `g${i}`, status: 'pass' });
    assert.equal(s.listFor('big').length, 25, 'every distinct gate keeps its record');
    for (let i = 0; i < 25; i++) assert.equal(s.getFor('big', `g${i}`)?.status, 'pass', `g${i} evidence survives`);
    assert.equal(s.listFor('sibling').length, 1, 'the sibling mission is untouched');
  });

  await t.test('GC drops WHOLE oldest missions beyond the mission cap, never a record of a retained one', () => {
    const s = fresh();
    s.upsert({ missionId: 'oldest', sortieId: 's', gateId: 'g', status: 'pass' });
    for (let i = 0; i < 200; i++) s.upsert({ missionId: `m${i}`, sortieId: 's', gateId: 'g', status: 'pass' });
    // 201 missions → the cap (200) drops exactly the first-written one, entirely.
    assert.equal(s.listFor('oldest').length, 0, 'the oldest mission is dropped whole');
    assert.equal(s.listFor('m0').length, 1, 'the next-oldest retained mission keeps its record');
    assert.equal(s.listFor('m199').length, 1, 'the newest mission keeps its record');
  });

  await t.test('records survive a reload through zod — INCLUDING the staleness identity axis', () => {
    const s = fresh();
    const rec = s.upsert({ missionId: 'm1', sortieId: 's1', gateId: 'g1', status: 'pass', summary: 'ok', round: 2, range: 'a..b' });
    const reloaded = new GateEvidenceStore().getFor('m1', 'g1');
    assert.equal(reloaded?.id, rec.id);
    // sortieId is the axis resolveGateState places evidence by — a schema silently missing it would
    // strip it on load and fail-close every gate forever while this suite stayed green.
    assert.equal(reloaded?.sortieId, 's1', 'the staleness identity axis survives the reload');
    assert.equal(reloaded?.submittedAt, rec.submittedAt, 'the GC ordering stamp survives the reload');
    assert.equal(reloaded?.status, 'pass');
    assert.equal(reloaded?.summary, 'ok');
    assert.equal(reloaded?.round, 2);
    assert.equal(reloaded?.range, 'a..b');
  });

  await t.test('caps truncate on the way in (the final-guard reparse)', () => {
    const s = fresh();
    const rec = s.upsert({ missionId: 'm1', sortieId: 's1', gateId: 'G'.repeat(500), status: 'pass', summary: 'S'.repeat(5000) });
    assert.equal(rec.gateId.length, 100, 'gateId clipped to its cap');
    assert.equal(rec.summary?.length, 2000, 'summary clipped to its cap');
  });
});

// ---------------------------------------------------------------------------------------------------

test('schema FAIL-CLOSED — an unknown status loads as \'fail\', never a pass and never a drop', () => {
  rmSync(paths.gates, { force: true });
  const good = new GateEvidenceStore().upsert({ missionId: 'm1', sortieId: 's1', gateId: 'g1', status: 'pass' });
  const raw = JSON.parse(readFileSync(paths.gates, 'utf8')) as Record<string, unknown>[];
  raw.push({ ...good, id: 'mangled', gateId: 'g2', status: 'green' }); // an unrecognized verdict
  writeFileSync(paths.gates, JSON.stringify(raw));
  const reloaded = new GateEvidenceStore();
  assert.equal(reloaded.getFor('m1', 'g2')?.status, 'fail', 'the mangled verdict blocks, never passes');
  assert.equal(reloaded.getFor('m1', 'g1')?.status, 'pass', 'the sound sibling is untouched');
});

// ---------------------------------------------------------------------------------------------------
// The shared store.ts readJsonArray loader — the corruption-safety contract (mirrors reviews.test.ts).

test('gate-evidence.json — a torn file is quarantined, never silently wiped (shared loader)', () => {
  writeFileSync(paths.gates, '{ not an array');
  const s = new GateEvidenceStore();
  assert.equal(s.listFor('m1').length, 0);
  const live = existsSync(paths.gates) ? readFileSync(paths.gates, 'utf8') : '';
  assert.notEqual(live, '{ not an array', 'the corrupt bytes are not left in place as the live file');
});

test('gate-evidence.json — one invalid record is skipped without wiping the valid ones (shared loader)', () => {
  rmSync(paths.gates, { force: true });
  const good = new GateEvidenceStore().upsert({ missionId: 'm1', sortieId: 's1', gateId: 'g1', status: 'pass' });
  const raw = JSON.parse(readFileSync(paths.gates, 'utf8')) as unknown[];
  raw.push({ id: 'bad', missionId: 'm1' }); // missing sortieId/gateId/status/submittedAt → invalid
  writeFileSync(paths.gates, JSON.stringify(raw));
  const reloaded = new GateEvidenceStore();
  assert.equal(reloaded.getFor('m1', 'g1')?.id, good.id, 'the valid record survives');
  assert.equal(reloaded.listFor('m1').length, 1, 'the invalid one is dropped');
});

process.on('exit', () => {
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});
