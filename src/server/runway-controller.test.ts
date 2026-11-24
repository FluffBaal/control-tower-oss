// SPEC-RUNWAY W3 — the pure rotation decision logic: over-threshold detection (UNKNOWN never triggers),
// target selection (different subscription, signed in, not walled; known-under-threshold by most
// headroom, unknown last), and the exhausted → wait-for-soonest-reset fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOverThreshold, maxUsedPct, soonestResetMs, chooseRotation, type RotationCandidate } from './runway/controller.js';
import type { RunwayUsage } from '../shared/runway.js';

const usage = (windows: Record<string, { usedPct: number; resetsAt: number }>, wall?: RunwayUsage['wall']): RunwayUsage => ({
  windows: Object.fromEntries(Object.entries(windows).map(([k, w]) => [k, { ...w, observedAt: Date.now() }])),
  ...(wall ? { wall } : {}),
});

test('isOverThreshold: walled=yes, unknown=no, else compare', () => {
  assert.equal(isOverThreshold({ walled: true, thresholdPct: 96 }), true);
  assert.equal(isOverThreshold({ usedPct: undefined, walled: false, thresholdPct: 96 }), false); // UNKNOWN never
  assert.equal(isOverThreshold({ usedPct: 95, walled: false, thresholdPct: 96 }), false);
  assert.equal(isOverThreshold({ usedPct: 96, walled: false, thresholdPct: 96 }), true);
  assert.equal(isOverThreshold({ usedPct: 99, walled: false, thresholdPct: 96 }), true);
});

test('maxUsedPct / soonestResetMs across windows', () => {
  const u = usage({ five_hour: { usedPct: 40, resetsAt: 2000 }, seven_day: { usedPct: 97, resetsAt: 1000 } });
  assert.equal(maxUsedPct(u), 97);
  assert.equal(soonestResetMs(u), 1000 * 1000); // seconds → ms, soonest = 1000s
  assert.equal(maxUsedPct(undefined), undefined);
  assert.equal(maxUsedPct(usage({})), undefined); // no windows = unknown
});

const cand = (o: Partial<RotationCandidate> & { profileId: string; accountUuid: string; order: number }): RotationCandidate => ({
  walled: false, thresholdPct: 96, signedIn: true, ...o,
});

test('chooseRotation: current not over ⇒ none', () => {
  const plan = chooseRotation({ accountUuid: 'A', usedPct: 10, walled: false, thresholdPct: 96 }, [cand({ profileId: 'p', accountUuid: 'B', order: 0, usedPct: 5 })]);
  assert.equal(plan.kind, 'none');
});

test('chooseRotation: rotate to the known target with the most headroom (ties by order)', () => {
  const plan = chooseRotation(
    { accountUuid: 'A', usedPct: 98, walled: false, thresholdPct: 96 },
    [
      cand({ profileId: 'b', accountUuid: 'B', order: 1, usedPct: 30 }),
      cand({ profileId: 'c', accountUuid: 'C', order: 2, usedPct: 10 }), // most headroom
      cand({ profileId: 'a', accountUuid: 'A', order: 0, usedPct: 98 }), // same subscription — excluded
    ],
  );
  assert.deepEqual(plan, { kind: 'rotate', toProfileId: 'c', toAccountUuid: 'C', reason: 'threshold' });
});

test('chooseRotation: unknown target is a last resort after known-under-threshold', () => {
  const known = chooseRotation(
    { accountUuid: 'A', usedPct: 98, walled: false, thresholdPct: 96 },
    [cand({ profileId: 'u', accountUuid: 'U', order: 0, usedPct: undefined }), cand({ profileId: 'k', accountUuid: 'K', order: 1, usedPct: 50 })],
  );
  assert.equal((known as { toAccountUuid: string }).toAccountUuid, 'K', 'known beats unknown');
  const onlyUnknown = chooseRotation(
    { accountUuid: 'A', usedPct: 98, walled: false, thresholdPct: 96 },
    [cand({ profileId: 'u', accountUuid: 'U', order: 0, usedPct: undefined })],
  );
  assert.equal((onlyUnknown as { toAccountUuid: string }).toAccountUuid, 'U', 'unknown as fallback');
});

test('chooseRotation: never targets a walled / signed-out / same-uuid candidate', () => {
  const plan = chooseRotation(
    { accountUuid: 'A', usedPct: 98, walled: false, thresholdPct: 96 },
    [
      cand({ profileId: 'w', accountUuid: 'W', order: 0, usedPct: 10, walled: true }), // walled
      cand({ profileId: 's', accountUuid: 'S', order: 1, usedPct: 10, signedIn: false }), // signed out
      cand({ profileId: 'a2', accountUuid: 'A', order: 2, usedPct: 10 }), // same subscription
    ],
  );
  assert.equal(plan.kind, 'exhausted');
});

test('chooseRotation: exhausted returns the soonest reset for the wait', () => {
  const plan = chooseRotation(
    { accountUuid: 'A', usedPct: 98, walled: false, thresholdPct: 96, soonestResetMs: 5000 },
    [cand({ profileId: 'b', accountUuid: 'B', order: 0, usedPct: 99, soonestResetMs: 3000 })], // also over
  );
  assert.deepEqual(plan, { kind: 'exhausted', soonestResetMs: 3000 });
});

test('chooseRotation: a live wall on current triggers rotation even with unknown %', () => {
  const plan = chooseRotation(
    { accountUuid: 'A', usedPct: undefined, walled: true, thresholdPct: 96 },
    [cand({ profileId: 'b', accountUuid: 'B', order: 0, usedPct: 20 })],
    'wall',
  );
  assert.deepEqual(plan, { kind: 'rotate', toProfileId: 'b', toAccountUuid: 'B', reason: 'wall' });
});
