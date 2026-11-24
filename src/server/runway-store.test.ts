// SPEC-RUNWAY — the config store + usage store + identity helper (pure, offline). Covers the load
// salvage / foreign-version .bak / M6 strip-trap / clamp+dedupe disciplines cloned from
// SkillSelectionStore, the per-accountUuid usage expiry + traversal gate, and identity grouping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunwayStore, DEFAULT_THRESHOLD_PCT } from './runway/store.js';
import { UsageStore, isAccountUuid } from './runway/usage.js';
import { accountIdentityFor } from './runway/identity.js';
import { parseStatusLinePayload } from './runway/parse.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'runway-'));
const UUID = '3e7891b9-1111-2222-3333-4444445ac26e';

// ---- RunwayStore ----

test('RunwayStore: addToPool is idempotent and refuses at the 32-entry cap', () => {
  const s = new RunwayStore(join(tmp(), 'runway.json'));
  for (let i = 0; i < 32; i++) assert.equal(s.addToPool(`p${i}`), true);
  assert.equal(s.get().pool.length, 32);
  assert.equal(s.addToPool('p0'), false, 'already present -> no-op');
  assert.equal(s.addToPool('p99'), false, 'full pool -> refused');
  assert.equal(s.get().pool.length, 32);
  assert.equal(s.removeFromPool('p0'), true);
  assert.equal(s.addToPool('p99'), true, 'room again after a removal');
});

test('RunwayStore: defaults empty; set() coerces/clamps/dedupes and round-trips (strip-trap)', () => {
  const file = join(tmp(), 'runway.json');
  const s = new RunwayStore(file);
  assert.deepEqual(s.get(), { enabled: true, liveSwap: true, thresholdPct: DEFAULT_THRESHOLD_PCT, pool: [] });

  const out = s.set({
    enabled: 'yes', // non-boolean → coerced to false (only true is true)
    thresholdPct: 250, // out of range → clamped to 100
    pool: [
      { profileId: 'aaa', thresholdPct: 0 }, // 0 → clamped to 1
      { profileId: 'aaa' }, // duplicate → dropped
      { profileId: 'b/../c' }, // unsafe id → dropped
      { profileId: 'bbb' },
    ],
  });
  assert.equal(out.enabled, false);
  assert.equal(out.thresholdPct, 100);
  assert.deepEqual(out.pool, [{ profileId: 'aaa', thresholdPct: 1 }, { profileId: 'bbb' }]);

  // File is 0600 and reloads identically (the per-entry thresholdPct survives → strip-trap covered).
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const reloaded = new RunwayStore(file).get();
  assert.deepEqual(reloaded.pool, [{ profileId: 'aaa', thresholdPct: 1 }, { profileId: 'bbb' }]);
});

test('RunwayStore: pruneProfile strips a pool entry, idempotent', () => {
  const s = new RunwayStore(join(tmp(), 'runway.json'));
  s.set({ enabled: true, thresholdPct: 96, pool: [{ profileId: 'x' }, { profileId: 'y' }] });
  assert.equal(s.pruneProfile('x'), true);
  assert.deepEqual(s.get().pool, [{ profileId: 'y' }]);
  assert.equal(s.pruneProfile('x'), false); // already gone → no-op
});

test('RunwayStore: onChange fires on set + prune', () => {
  const s = new RunwayStore(join(tmp(), 'runway.json'));
  let n = 0;
  s.setHooks({ onChange: () => { n++; } });
  s.set({ enabled: true, thresholdPct: 96, pool: [{ profileId: 'x' }] });
  s.pruneProfile('x');
  assert.equal(n, 2);
});

test('RunwayStore: a foreign/future-versioned file is backed up and never persisted over', () => {
  const file = join(tmp(), 'runway.json');
  const foreign = JSON.stringify({ version: 2, enabled: true, thresholdPct: 50, pool: [{ profileId: 'z' }] });
  writeFileSync(file, foreign);
  const s = new RunwayStore(file);
  assert.deepEqual(s.get(), { enabled: true, liveSwap: true, thresholdPct: DEFAULT_THRESHOLD_PCT, pool: [] }); // defaults, not the v2 body
  assert.ok(existsSync(`${file}.bak`), 'a .bak was written');
  assert.equal(readFileSync(file, 'utf8'), foreign, 'the original file was NOT overwritten on load');
});

test('RunwayStore: a v1 file with a bad pool entry salvages the rest', () => {
  const file = join(tmp(), 'runway.json');
  // pool with one malformed entry (profileId missing) — sanitizePool drops it, keeps the good one.
  writeFileSync(file, JSON.stringify({ version: 1, enabled: true, thresholdPct: 90, pool: [{ nope: 1 }, { profileId: 'good' }] }));
  const s = new RunwayStore(file);
  assert.equal(s.get().enabled, true);
  assert.equal(s.get().thresholdPct, 90);
  assert.deepEqual(s.get().pool, [{ profileId: 'good' }]);
});

// ---- UsageStore ----

test('UsageStore: record + effective drops windows past their reset', () => {
  const dir = tmp();
  const s = new UsageStore(dir);
  const nowSec = Math.floor(Date.now() / 1000);
  s.record(UUID, { windows: { five_hour: { usedPct: 97, resetsAt: nowSec + 3600 }, seven_day: { usedPct: 40, resetsAt: nowSec - 10 } }, terminalId: 't1', model: 'opus' });
  const eff = s.effective(UUID);
  assert.ok(eff, 'effective present');
  assert.deepEqual(Object.keys(eff!.windows), ['five_hour'], 'expired seven_day dropped');
  assert.equal(eff!.windows.five_hour!.usedPct, 97);
  assert.equal(eff!.lastTerminalId, 't1');
  // File is 0600 and reloads.
  assert.equal(statSync(join(dir, `${UUID}.json`)).mode & 0o777, 0o600);
  assert.ok(new UsageStore(dir).get(UUID), 'reloads from disk');
});

test('UsageStore: all-expired windows → effective undefined (UNKNOWN, never 0%)', () => {
  const s = new UsageStore(tmp());
  const nowSec = Math.floor(Date.now() / 1000);
  s.record(UUID, { windows: { five_hour: { usedPct: 50, resetsAt: nowSec - 100 } } });
  assert.equal(s.effective(UUID), undefined);
  assert.equal(s.effective('never-reported-uuid-0000-0000-000000000000'), undefined);
});

test('UsageStore: markWall/clearWall; wall lifts past its until', () => {
  const s = new UsageStore(tmp());
  const now = Date.now();
  s.markWall(UUID, { until: now + 60_000, source: 'hook' });
  assert.ok(s.effective(UUID, now)?.wall, 'wall live before until');
  assert.equal(s.effective(UUID, now + 120_000), undefined, 'wall lifted after until (no windows left)');
  s.clearWall(UUID);
  assert.equal(s.get(UUID)?.wall, undefined);
});

test('UsageStore: accountUuid gate rejects traversal; record on a bad uuid is a no-op', () => {
  assert.equal(isAccountUuid('../../etc/passwd'), false);
  assert.equal(isAccountUuid('a.b'), false);
  assert.equal(isAccountUuid(UUID), true);
  const dir = tmp();
  const s = new UsageStore(dir);
  s.record('../evil', { windows: { five_hour: { usedPct: 1, resetsAt: 9999999999 } } });
  assert.equal(existsSync(join(dir, '..', 'evil.json')), false);
});

// ---- statusLine parse ----

test('parseStatusLinePayload: extracts windows/model/session; absent available-flag ⇒ available', () => {
  const p = parseStatusLinePayload({
    rate_limits: {
      five_hour: { used_percentage: 15, resets_at: 1789709400 },
      seven_day: { used_percentage: 36, resets_at: 1789970400 },
      seven_day_opus: { used_percentage: null }, // malformed window → dropped
    },
    model: { id: 'claude-opus-5' },
    session_id: 'sess-1',
  });
  assert.ok(p);
  assert.deepEqual(Object.keys(p!.windows).sort(), ['five_hour', 'seven_day']);
  assert.equal(p!.windows.five_hour!.usedPct, 15);
  assert.equal(p!.windows.five_hour!.resetsAt, 1789709400);
  assert.equal(p!.model, 'claude-opus-5');
  assert.equal(p!.sessionId, 'sess-1');
  assert.equal(p!.available, true);
});

test('parseStatusLinePayload: rate_limits_available:false ⇒ not a subscription, no windows', () => {
  const p = parseStatusLinePayload({ rate_limits_available: false, rate_limits: { five_hour: { used_percentage: 5, resets_at: 1789709400 } } });
  assert.equal(p!.available, false);
  assert.deepEqual(p!.windows, {});
});

test('parseStatusLinePayload: no rate_limits ⇒ empty windows; non-object ⇒ null', () => {
  assert.deepEqual(parseStatusLinePayload({ model: { id: 'x' } })!.windows, {});
  assert.equal(parseStatusLinePayload('nope'), null);
  assert.equal(parseStatusLinePayload(null), null);
});

// ---- identity ----

test('accountIdentityFor: reads accountUuid + email/org from .claude.json; undefined when absent', () => {
  const dir = tmp();
  assert.equal(accountIdentityFor(dir), undefined); // no .claude.json
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: UUID, emailAddress: 'x@y.z', organizationUuid: 'org-1', organizationName: 'Acme' } }));
  assert.deepEqual(accountIdentityFor(dir), { accountUuid: UUID, email: 'x@y.z', orgUuid: 'org-1', orgName: 'Acme' });
  // a state file with no oauthAccount → undefined
  const dir2 = tmp();
  writeFileSync(join(dir2, '.claude.json'), JSON.stringify({ projects: {} }));
  assert.equal(accountIdentityFor(dir2), undefined);
});

test('RunwayStore: liveSwap defaults ON, round-trips false, and an omitted/legacy value loads as ON', () => {
  const file = join(tmp(), 'runway.json');
  const s = new RunwayStore(file);
  assert.equal(s.get().liveSwap, true);
  assert.equal(s.set({ enabled: true, liveSwap: false, pool: [] }).liveSwap, false);
  assert.equal(new RunwayStore(file).get().liveSwap, false, 'explicit false survives reload');
  assert.equal(s.set({ enabled: true, pool: [] }).liveSwap, true, 'omitted -> default ON');
  const legacy = join(tmp(), 'legacy.json');
  writeFileSync(legacy, JSON.stringify({ version: 1, enabled: true, thresholdPct: 90, pool: [] }));
  assert.equal(new RunwayStore(legacy).get().liveSwap, true, 'pre-liveSwap file loads as ON');
});

test('RunwayStore: addToPool appends idempotently, removeFromPool drops, both persist; order/thresholds preserved', () => {
  const file = join(tmp(), 'runway.json');
  const s = new RunwayStore(file);
  s.set({ enabled: true, pool: [{ profileId: 'a', thresholdPct: 80 }] });
  assert.equal(s.addToPool('b'), true);
  assert.equal(s.addToPool('b'), false, 'already pooled -> no-op');
  assert.equal(s.addToPool('a'), false);
  assert.equal(s.addToPool('../bad'), false, 'unsafe id refused');
  assert.deepEqual(s.get().pool, [{ profileId: 'a', thresholdPct: 80 }, { profileId: 'b' }]);
  assert.deepEqual(new RunwayStore(file).get().pool.map((e) => e.profileId), ['a', 'b'], 'persisted');
  assert.equal(s.get().enabled, true, 'other fields untouched');
  assert.equal(s.removeFromPool('a'), true);
  assert.equal(s.removeFromPool('a'), false);
  assert.deepEqual(new RunwayStore(file).get().pool, [{ profileId: 'b' }]);
});
