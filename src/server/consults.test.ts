// SPEC-PLANNER §2/§8 — the ConsultStore FSM + migrate + the per-mission prune. All PURE and
// synchronous, so this is a straight unit test of the most defect-prone surface of the wave (P7).
//
// The state machine is the point: an illegal transition MUST throw (a caller that races an expiry
// relies on that), and P3's escape hatch — `answered → expired` on a LIVE mission — must be allowed,
// because the boot reconcile and detach both need it. Each transition is driven through the real API,
// never by hand-setting a field, so a mutant that stops writing a status/stamp is actually caught.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanRevisionBundle } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-consults-test-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { ConsultStore } = await import('./consults.js');

const bundle = (): PlanRevisionBundle => ({ goal: 'g', landed: [], failing: ['a › b'], rounds: [] });
function fresh(): InstanceType<typeof ConsultStore> {
  rmSync(paths.consults, { force: true });
  return new ConsultStore();
}
const ask = (s: InstanceType<typeof ConsultStore>, missionId = 'm1', terminalId = 't1') =>
  s.create({ missionId, terminalId, kind: 'replan', question: 'plan it', payload: bundle() });

test('ConsultStore — the FSM, migrate, and the prune', async (t) => {
  await t.test('create stamps pending + askedAt and getById/openFor read it', () => {
    const s = fresh();
    const c = ask(s);
    assert.equal(c.status, 'pending');
    assert.ok(c.askedAt, 'askedAt is stamped');
    assert.equal(c.deliveredAt, undefined);
    assert.equal(s.getById(c.id)?.id, c.id);
    assert.equal(s.openFor('m1').length, 1);
    assert.equal(s.openFor('other').length, 0, 'scoped to the mission');
  });

  await t.test('markDelivered stamps deliveredAt once and is idempotent', () => {
    const s = fresh();
    const c = ask(s);
    const d = s.markDelivered(c.id)!;
    assert.equal(d.status, 'delivered');
    assert.ok(d.deliveredAt, 'deliveredAt is stamped on the pending→delivered move');
    const again = s.markDelivered(c.id)!;
    assert.equal(again.status, 'delivered');
    assert.equal(again.deliveredAt, d.deliveredAt, 'a second markDelivered does not re-stamp');
  });

  await t.test('recordAnswer moves to answered and back-stamps deliveredAt when absent', () => {
    const s = fresh();
    const c = ask(s);
    // answer straight from PENDING — the never-delivered-but-answered path (a raw curl reply)
    const a = s.recordAnswer(c.id, { phases: [] });
    assert.equal(a.status, 'answered');
    assert.ok(a.answeredAt, 'answeredAt stamped');
    assert.ok(a.deliveredAt, 'answering back-stamps deliveredAt (answering implies delivery)');
    assert.deepEqual(a.answer, { phases: [] });
  });

  await t.test('recordAnswer from delivered keeps the original deliveredAt', () => {
    const s = fresh();
    const c = ask(s);
    const d = s.markDelivered(c.id)!;
    const a = s.recordAnswer(c.id, { phases: [] });
    assert.equal(a.deliveredAt, d.deliveredAt, 'the delivery stamp is not overwritten at answer time');
  });

  await t.test('resolve applied/rejected come ONLY from answered', () => {
    const s = fresh();
    const c = ask(s);
    // cannot apply a pending consult
    assert.throws(() => s.resolve(c.id, 'applied'), /cannot mark applied from pending/);
    s.markDelivered(c.id);
    assert.throws(() => s.resolve(c.id, 'rejected'), /cannot mark rejected from delivered/);
    s.recordAnswer(c.id, { phases: [] });
    const applied = s.resolve(c.id, 'applied')!;
    assert.equal(applied.status, 'applied');
    // and a terminal consult cannot be answered again
    assert.throws(() => s.recordAnswer(c.id, {}), /cannot answer a applied consult/);
  });

  await t.test('P3 — expire is allowed from pending, delivered AND answered (live mission)', () => {
    const s = fresh();
    const p = ask(s, 'm1', 't1');
    const ex1 = s.resolve(p.id, 'expired', 'delivery-timeout')!;
    assert.equal(ex1.status, 'expired');
    assert.equal(ex1.expireReason, 'delivery-timeout');

    const d = ask(s, 'm1', 't1');
    s.markDelivered(d.id);
    assert.equal(s.resolve(d.id, 'expired', 'answer-timeout')!.status, 'expired');

    // THE P3 CASE: an answered consult expired by the boot reconcile / detach, NOT mission-ended-gated.
    const an = ask(s, 'm1', 't1');
    s.recordAnswer(an.id, { phases: [] });
    const ex3 = s.resolve(an.id, 'expired', 'superseded');
    assert.equal(ex3!.status, 'expired', 'answered→expired must NOT throw on a live mission');
    assert.equal(ex3!.expireReason, 'superseded');
  });

  await t.test('expiring an already-closed consult is illegal', () => {
    const s = fresh();
    const c = ask(s);
    s.resolve(c.id, 'expired', 'mission-ended');
    assert.throws(() => s.resolve(c.id, 'expired', 'mission-ended'), /cannot expire a expired consult/);
  });

  await t.test('bumpNudges counts attempts from zero', () => {
    const s = fresh();
    const c = ask(s);
    assert.equal(s.getById(c.id)!.nudges, undefined);
    s.bumpNudges(c.id);
    s.bumpNudges(c.id);
    assert.equal(s.getById(c.id)!.nudges, 2);
  });

  await t.test('migrate re-homes open consults, reverts delivered→pending, restates askedAt', async () => {
    const s = fresh();
    const pend = ask(s, 'm1', 'old');
    const deliv = ask(s, 'm1', 'old');
    s.markDelivered(deliv.id);
    s.bumpNudges(deliv.id);
    const answered = ask(s, 'm1', 'old');
    s.recordAnswer(answered.id, { phases: [] });
    const otherMission = ask(s, 'm2', 'old');   // must NOT migrate — different mission
    const beforeAsk = s.getById(pend.id)!.askedAt;
    await new Promise((r) => setTimeout(r, 5)); // so a restated askedAt is observably newer

    const moved = s.migrate('m1', 'old', 'new');
    assert.equal(moved, 3, 'all three open m1 consults moved');
    assert.equal(s.getById(pend.id)!.terminalId, 'new');
    assert.ok(s.getById(pend.id)!.askedAt > beforeAsk, 'askedAt is restated for the new pane');

    const dv = s.getById(deliv.id)!;
    assert.equal(dv.status, 'pending', 'delivered reverts to pending');
    assert.equal(dv.deliveredAt, undefined, 'deliveredAt is cleared on revert');
    assert.equal(dv.nudges, 0, 'nudges reset on revert');
    assert.equal(dv.terminalId, 'new');

    const an = s.getById(answered.id)!;
    assert.equal(an.status, 'answered', 'an answered consult keeps its stored reply');
    assert.equal(an.terminalId, 'new', 'but still re-homes so the new pane owns it');

    assert.equal(s.getById(otherMission.id)!.terminalId, 'old', "another mission's consult is untouched");
  });

  await t.test('migrate ignores CLOSED consults (only open re-home)', () => {
    const s = fresh();
    const c = ask(s, 'm1', 'old');
    s.resolve(c.id, 'expired', 'planner-detached');
    assert.equal(s.migrate('m1', 'old', 'new'), 0, 'a closed consult does not migrate');
    assert.equal(s.getById(c.id)!.terminalId, 'old');
  });

  await t.test('prune keeps the newest 40 CLOSED per mission, never an open one', () => {
    const s = fresh();
    // 45 closed consults for one mission, plus one still-open — the open must survive regardless.
    for (let i = 0; i < 45; i++) {
      const c = ask(s, 'big', 't1');
      s.resolve(c.id, 'expired', 'mission-ended');
    }
    const open = ask(s, 'big', 't1');
    const list = s.listFor('big');
    const closed = list.filter((c) => c.status === 'expired');
    assert.equal(closed.length, 40, 'closed trimmed to the bound');
    assert.ok(s.getById(open.id), 'the open consult is never pruned');
  });

  await t.test('records survive a reload through zod', () => {
    const s = fresh();
    const c = ask(s, 'm1', 't1');
    s.markDelivered(c.id);
    const reloaded = new ConsultStore().getById(c.id);
    assert.ok(reloaded, 'the record survives a restart');
    assert.equal(reloaded!.status, 'delivered');
    assert.equal(reloaded!.terminalId, 't1');
  });

  await t.test('a torn file is quarantined, never silently wiped', () => {
    writeFileSync(paths.consults, '{ not an array');
    const s = new ConsultStore();
    assert.equal(s.listOpen().length, 0);
    const live = existsSync(paths.consults) ? readFileSync(paths.consults, 'utf8') : '';
    assert.notEqual(live, '{ not an array', 'the corrupt bytes are not left in place as the live file');
  });

  await t.test('one invalid record is skipped without wiping the valid ones', () => {
    rmSync(paths.consults, { force: true });
    const good = ask(fresh(), 'm1', 't1'); // writes one valid record to disk
    const raw = JSON.parse(readFileSync(paths.consults, 'utf8')) as unknown[];
    raw.push({ id: 'bad', missionId: 'm1' }); // missing required fields → invalid
    writeFileSync(paths.consults, JSON.stringify(raw));
    const reloaded = new ConsultStore();
    assert.ok(reloaded.getById(good.id), 'the valid record survives');
    assert.equal(reloaded.getById('bad'), undefined, 'the invalid one is dropped');
  });
});
