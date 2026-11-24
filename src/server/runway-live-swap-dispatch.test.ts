// SPEC-RUNWAY live-swap stage A2 -- the failure-dispatch table over every LiveSwapResult, and the debounced
// reactive trigger. All deps injected; no timers, no fs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CT_HOME ??= '/tmp/ct-live-swap-dispatch-unused';
const { dispatchLiveSwap, createLiveSwapTrigger } = await import('./runway/live-swap-dispatch.js');
const { chooseRotation } = await import('./runway/controller.js');
type Res = Awaited<ReturnType<Parameters<typeof dispatchLiveSwap>[2]['swap']>>;

function rig(results: Res[], opts: { rotateFailsFor?: string[]; next?: string[]; killThrows?: boolean } = {}) {
  const calls = { killed: [] as string[], swap: 0, rotate: [] as string[], sleeps: [] as number[], audits: [] as string[] };
  const queue = [...results];
  const nextQ = [...(opts.next ?? [])];
  const deps = {
    swap: async () => {
      calls.swap++;
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
    rotate: async (_t: string, to: string) => {
      calls.rotate.push(to);
      if (opts.rotateFailsFor?.includes(to)) throw new Error('nope');
    },
    nextTarget: (_t: string, exclude: readonly string[]) => nextQ.find((n) => !exclude.includes(n)),
    kill: async (t: string) => { calls.killed.push(t); if (opts.killThrows) throw new Error('kill failed'); },
    sleep: async (ms: number) => { calls.sleeps.push(ms); },
    audit: (e: string) => { calls.audits.push(e); },
  };
  return { calls, deps };
}

test('ok -> swapped, no rotate (fan-out without respawn)', async () => {
  const { calls, deps } = rig([{ ok: true, toAccountUuid: 'u-B' }]);
  assert.deepEqual(await dispatchLiveSwap('t', 'B', deps), { kind: 'swapped', toAccountUuid: 'u-B' });
  assert.deepEqual(calls.rotate, []);
});

test('lock-busy -> bounded retry with backoff, success on a later try', async () => {
  const { calls, deps } = rig([{ ok: false, reason: 'lock-busy' }, { ok: true, toAccountUuid: 'u' }]);
  const out = await dispatchLiveSwap('t', 'B', deps);
  assert.equal(out.kind, 'swapped');
  assert.equal(calls.swap, 2);
  assert.deepEqual(calls.sleeps, [250]);
});

test('lock-busy forever -> dropped after 1+2 tries, no rotate', async () => {
  const { calls, deps } = rig([{ ok: false, reason: 'lock-busy' }]);
  const out = await dispatchLiveSwap('t', 'B', deps);
  assert.deepEqual(out, { kind: 'dropped', reason: 'lock-busy' });
  assert.equal(calls.swap, 3);
  assert.deepEqual(calls.sleeps, [250, 500]);
  assert.deepEqual(calls.rotate, []);
});

for (const reason of ['target-unhealthy', 'no-target-oauth', 'no-target-identity', 'unsigned-target'] as const) {
  test(`${reason} -> respawn-rotation to the NEXT candidate (not the failed one)`, async () => {
    const { calls, deps } = rig([{ ok: false, reason }], { next: ['B', 'C'] });
    const out = await dispatchLiveSwap('t', 'B', deps);
    assert.deepEqual(out, { kind: 'rotated', toProfileId: 'C', via: 'fallback' });
    assert.deepEqual(calls.rotate, ['C']);
  });
}

test('unhealthy target and no other candidate -> failed, nothing rotated', async () => {
  const { calls, deps } = rig([{ ok: false, reason: 'target-unhealthy' }], { next: ['B'] });
  assert.equal((await dispatchLiveSwap('t', 'B', deps)).kind, 'failed');
  assert.deepEqual(calls.rotate, []);
});

test('fallback rotate refusal moves on to the following candidate', async () => {
  const { calls, deps } = rig([{ ok: false, reason: 'target-unhealthy' }], { next: ['C', 'D'], rotateFailsFor: ['C'] });
  const out = await dispatchLiveSwap('t', 'B', deps);
  assert.deepEqual(out, { kind: 'rotated', toProfileId: 'D', via: 'fallback' });
  assert.deepEqual(calls.rotate, ['C', 'D']);
});

test('write-failed rolledBack:true -> left running, NO rotate, audited', async () => {
  const { calls, deps } = rig([{ ok: false, reason: 'write-failed', rolledBack: true }]);
  assert.equal((await dispatchLiveSwap('t', 'B', deps)).kind, 'left-running');
  assert.deepEqual(calls.rotate, []);
  assert.ok(calls.audits.includes('runway.live-swap.write-failed'));
});

test('write-failed rolledBack:false -> QUARANTINE: forced respawn-rotation to the intended target', async () => {
  const { calls, deps } = rig([{ ok: false, reason: 'write-failed', rolledBack: false }], { next: ['C'] });
  const out = await dispatchLiveSwap('t', 'B', deps);
  assert.deepEqual(out, { kind: 'rotated', toProfileId: 'B', via: 'quarantine' });
  assert.deepEqual(calls.rotate, ['B']);
  assert.ok(calls.audits.includes('runway.live-swap.quarantine'));
});

test('quarantine whose rotations all fail -> failed + audited (slot is NOT silently trusted)', async () => {
  const { calls, deps } = rig([{ ok: false, reason: 'write-failed', rolledBack: false }], { next: ['C'], rotateFailsFor: ['B', 'C'] });
  assert.equal((await dispatchLiveSwap('t', 'B', deps)).kind, 'killed');
  assert.ok(calls.audits.includes('runway.live-swap.quarantine-failed'));
  assert.ok(calls.audits.includes('runway.live-swap.quarantine-killed'));
  assert.deepEqual(calls.killed, ['t'], 'last resort: the poisoned terminal is killed');
});

test('poisoned + no rotation target -> terminal killed (never left serving)', async () => {
  const { calls, deps } = rig([{ ok: false, reason: 'write-failed', rolledBack: false }]);
  deps.rotate = async () => { throw new Error('no rotation target'); };
  deps.nextTarget = () => undefined;
  const out = await dispatchLiveSwap('t', 'B', deps);
  assert.equal(out.kind, 'killed');
  assert.deepEqual(calls.killed, ['t']);
  assert.ok(calls.audits.includes('runway.live-swap.quarantine-killed'));
});

test('poisoned + rotateToNext throws + kill throws -> failed, audited, never throws', async () => {
  const { calls, deps } = rig([{ ok: false, reason: 'write-failed', rolledBack: false }], { killThrows: true });
  deps.nextTarget = () => { throw new Error('boom'); };
  deps.rotate = async () => { throw new Error('nope'); };
  assert.equal((await dispatchLiveSwap('t', 'B', deps)).kind, 'failed');
  assert.ok(calls.audits.includes('runway.live-swap.quarantine-kill-failed'));
});

test('rolled-back write-failed and clean rotations never kill', async () => {
  const a = rig([{ ok: false, reason: 'write-failed', rolledBack: true }]);
  await dispatchLiveSwap('t', 'B', a.deps);
  const b = rig([{ ok: false, reason: 'write-failed', rolledBack: false }]);
  await dispatchLiveSwap('t', 'B', b.deps);
  assert.deepEqual([...a.calls.killed, ...b.calls.killed], []);
});

test('not-slotted -> plain respawn-rotation to the requested target', async () => {
  const { calls, deps } = rig([{ ok: false, reason: 'not-slotted' }]);
  assert.deepEqual(await dispatchLiveSwap('t', 'B', deps), { kind: 'rotated', toProfileId: 'B', via: 'fallback' });
  assert.deepEqual(calls.rotate, ['B']);
});

for (const reason of ['in-progress', 'gone', 'same-account', 'unknown-target', 'reserved-target'] as const) {
  test(`${reason} -> dropped, no rotate`, async () => {
    const { calls, deps } = rig([{ ok: false, reason }]);
    assert.equal((await dispatchLiveSwap('t', 'B', deps)).kind, 'dropped');
    assert.deepEqual(calls.rotate, []);
  });
}

// ---- the reactive trigger ----

function trig(over: Partial<Parameters<typeof createLiveSwapTrigger>[0]> = {}) {
  const ran: string[][] = [];
  let t = 1_000_000;
  const deps = {
    enabled: () => true,
    isSlotted: () => true,
    overThreshold: () => true,
    pickTarget: () => 'B',
    run: async (tid: string, to: string) => { ran.push([tid, to]); },
    now: () => t,
    cooldownMs: 1000,
    audit: () => {},
    ...over,
  };
  return { trigger: createLiveSwapTrigger(deps), ran, advance: (ms: number) => { t += ms; } };
}

test('trigger fires only when enabled + slotted + over-threshold + a target exists', async () => {
  const a = trig();
  assert.equal(await a.trigger.fire('t'), 'fired');
  assert.deepEqual(a.ran, [['t', 'B']]);
  assert.equal(await trig({ enabled: () => false }).trigger.fire('t'), 'disabled');
  assert.equal(await trig({ isSlotted: () => false }).trigger.fire('t'), 'not-slotted');
  assert.equal(await trig({ overThreshold: () => false }).trigger.fire('t'), 'under-threshold');
  assert.equal(await trig({ pickTarget: () => undefined }).trigger.fire('t'), 'no-target');
  for (const x of [trig({ enabled: () => false }), trig({ isSlotted: () => false }), trig({ overThreshold: () => false }), trig({ pickTarget: () => undefined })]) {
    await x.trigger.fire('t');
    assert.deepEqual(x.ran, [], 'run never called');
  }
});

test('trigger debounces: one in flight per terminal, then a cooldown after completion', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const x = trig({ run: async (tid, to) => { x.ran.push([tid, to]); await gate; } });
  const first = x.trigger.fire('t');
  assert.equal(await x.trigger.fire('t'), 'in-flight');
  const other = x.trigger.fire('other'); // a different terminal is independent (also parks on the gate)
  assert.deepEqual(x.ran.map((r) => r[0]), ['t', 'other']);
  release();
  assert.equal(await first, 'fired');
  assert.equal(await other, 'fired');
  assert.equal(await x.trigger.fire('t'), 'cooldown');
  x.advance(1001);
  assert.equal(await x.trigger.fire('t'), 'fired');
});

test('trigger never throws: a failing run resolves "error" and audits', async () => {
  const audits: string[] = [];
  const x = trig({ run: async () => { throw new Error('boom'); }, audit: (e) => { audits.push(e); } });
  assert.equal(await x.trigger.fire('t'), 'error');
  assert.deepEqual(audits, ['runway.live-swap.trigger-error']);
});

test('trigger target selection: same target as chooseRotation over the pool', async () => {
  const cand = (profileId: string, usedPct: number) => ({
    profileId, accountUuid: `u-${profileId}`, usedPct, walled: false, thresholdPct: 90, signedIn: true, order: 0,
  });
  const current = { accountUuid: 'u-A', usedPct: 95, walled: false, thresholdPct: 90 };
  const pool = [cand('B', 10), cand('C', 40), cand('D', 20)];
  const plan = chooseRotation(current, pool);
  assert.equal(plan.kind === 'rotate' ? plan.toProfileId : undefined, 'B', 'lowest used% wins');
  const x = trig({ pickTarget: () => (plan.kind === 'rotate' ? plan.toProfileId : undefined) });
  await x.trigger.fire('t');
  assert.deepEqual(x.ran, [['t', 'B']]);
});
