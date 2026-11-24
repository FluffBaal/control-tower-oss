// SPEC-RUNWAY — the status composition + pool-write validation (pure functions behind the routes).
// Two profiles sharing one accountUuid must collapse to ONE subscription slot with one usage budget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunwayStore } from './runway/store.js';
import { UsageStore } from './runway/usage.js';
import { composeRunwayStatus, validatePoolForWrite, type RunwayProfileView } from './runway/routes.js';

const UUID_A = 'aaaa1111-1111-1111-1111-111111111111';
const UUID_B = 'bbbb2222-2222-2222-2222-222222222222';

function dirWith(uuid: string | null, email?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'runway-p-'));
  if (uuid) writeFileSync(join(d, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } }));
  return d;
}

test('composeRunwayStatus: groups by accountUuid, joins pool order + threshold override + usage', () => {
  const profiles: RunwayProfileView[] = [
    { id: 'a1', label: 'A one', configDir: dirWith(UUID_A, 'a@x.io'), signedIn: true },
    { id: 'a2', label: 'A two', configDir: dirWith(UUID_A, 'a@x.io'), signedIn: true }, // SAME subscription as a1
    { id: 'b', label: 'B', configDir: dirWith(UUID_B, 'b@x.io'), signedIn: false },
    { id: 'none', label: 'No login', configDir: dirWith(null), signedIn: false },
  ];
  const store = new RunwayStore(join(mkdtempSync(join(tmpdir(), 'runway-')), 'runway.json'));
  store.set({ enabled: true, thresholdPct: 96, pool: [{ profileId: 'a1' }, { profileId: 'b', thresholdPct: 80 }] });
  const usage = new UsageStore(mkdtempSync(join(tmpdir(), 'runway-u-')));
  const nowSec = Math.floor(Date.now() / 1000);
  usage.record(UUID_A, { windows: { five_hour: { usedPct: 97, resetsAt: nowSec + 3600 } } });

  const status = composeRunwayStatus(store, usage, profiles);
  assert.equal(status.enabled, true);
  assert.equal(status.subscriptions.length, 2);
  // Subscription A: two profiles, pooled at order 0, global threshold, 97% window.
  const a = status.subscriptions.find((s) => s.accountUuid === UUID_A)!;
  assert.equal(a.profiles.length, 2);
  assert.deepEqual(a.profiles.map((p) => p.id).sort(), ['a1', 'a2']);
  assert.equal(a.pooled, true);
  assert.equal(a.order, 0);
  assert.equal(a.thresholdPct, 96);
  assert.equal(a.windows.five_hour!.usedPct, 97);
  // Subscription B: pooled at order 1 with its per-entry threshold override; no usage (unknown → {}).
  const b = status.subscriptions.find((s) => s.accountUuid === UUID_B)!;
  assert.equal(b.order, 1);
  assert.equal(b.thresholdPct, 80);
  assert.deepEqual(b.windows, {});
  // The never-logged-in profile is surfaced separately, never as a subscription.
  assert.deepEqual(status.unidentified.map((u) => u.id), ['none']);
  // Pooled subscriptions sort first, by rotation order.
  assert.deepEqual(status.subscriptions.map((s) => s.accountUuid), [UUID_A, UUID_B]);
});

test('validatePoolForWrite: rejects unknown / reserved / malformed; accepts valid', () => {
  const profiles: RunwayProfileView[] = [{ id: 'ok', label: 'ok', configDir: '/x', signedIn: true }];
  const reserved = (id: string) => id === 'brain';
  assert.equal(validatePoolForWrite(undefined, profiles, reserved), null);
  assert.equal(validatePoolForWrite([{ profileId: 'ok' }], profiles, reserved), null);
  assert.match(validatePoolForWrite([{ profileId: 'nope' }], profiles, reserved)!, /unknown or non-claude-code/);
  assert.match(validatePoolForWrite([{ profileId: 'brain' }], profiles, reserved)!, /reserved/);
  assert.match(validatePoolForWrite('x', profiles, reserved)!, /must be an array/);
  assert.match(validatePoolForWrite([{ profileId: 'ok', thresholdPct: 'hi' }], profiles, reserved)!, /must be a number/);
});

test('PUT /api/runway/config forwards liveSwap and it round-trips through GET', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerRunwayRoutes } = await import('./runway/routes.js');
  const store = new RunwayStore(join(mkdtempSync(join(tmpdir(), 'runway-')), 'runway.json'));
  const app = Fastify();
  registerRunwayRoutes(app, {
    store,
    usage: new UsageStore(mkdtempSync(join(tmpdir(), 'runway-u-'))),
    claudeProfiles: () => [],
    isReserved: () => false,
    audit: () => {},
  });
  assert.equal((await app.inject({ method: 'GET', url: '/api/runway/config' })).json().liveSwap, true);
  const off = await app.inject({ method: 'PUT', url: '/api/runway/config', payload: { enabled: true, liveSwap: false, pool: [] } });
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().liveSwap, false);
  assert.equal((await app.inject({ method: 'GET', url: '/api/runway/config' })).json().liveSwap, false);
  const on = await app.inject({ method: 'PUT', url: '/api/runway/config', payload: { enabled: true, liveSwap: true, pool: [] } });
  assert.equal(on.json().liveSwap, true);
  await app.close();
});

test('POST/DELETE /api/runway/pool/:profileId add/remove pool membership and return the status', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerRunwayRoutes } = await import('./runway/routes.js');
  const store = new RunwayStore(join(mkdtempSync(join(tmpdir(), 'runway-')), 'runway.json'));
  const audits: string[] = [];
  const profiles: RunwayProfileView[] = [
    { id: 'a1', label: 'A', configDir: dirWith(UUID_A, 'a@x.io'), signedIn: true },
    { id: 'brain', label: 'Brain', configDir: dirWith(UUID_B, 'b@x.io'), signedIn: true },
  ];
  const app = Fastify();
  registerRunwayRoutes(app, {
    store,
    usage: new UsageStore(mkdtempSync(join(tmpdir(), 'runway-u-'))),
    claudeProfiles: () => profiles,
    isReserved: (id) => id === 'brain',
    audit: (e) => { audits.push(e); },
  });
  const add = await app.inject({ method: 'POST', url: '/api/runway/pool/a1' });
  assert.equal(add.statusCode, 200);
  assert.equal(add.json().subscriptions.find((s: { accountUuid: string }) => s.accountUuid === UUID_A).pooled, true);
  assert.deepEqual(store.get().pool, [{ profileId: 'a1' }]);
  assert.equal((await app.inject({ method: 'POST', url: '/api/runway/pool/a1' })).statusCode, 200, 'idempotent');
  assert.deepEqual(store.get().pool, [{ profileId: 'a1' }]);
  assert.equal((await app.inject({ method: 'POST', url: '/api/runway/pool/nope' })).statusCode, 400, 'unknown profile');
  assert.equal((await app.inject({ method: 'POST', url: '/api/runway/pool/brain' })).statusCode, 400, 'reserved profile');
  const rm = await app.inject({ method: 'DELETE', url: '/api/runway/pool/a1' });
  assert.equal(rm.statusCode, 200);
  assert.equal(rm.json().subscriptions.find((s: { accountUuid: string }) => s.accountUuid === UUID_A).pooled, false);
  assert.deepEqual(store.get().pool, []);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/runway/pool/a1' })).statusCode, 200, 'idempotent');
  assert.ok(audits.includes('runway.pool.add') && audits.includes('runway.pool.remove'));
  await app.close();
});
