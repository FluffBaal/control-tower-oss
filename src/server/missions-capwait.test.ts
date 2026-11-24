// SPEC-TERMINAL-OPS §3.3 — the terminal-cap deferral: a queued sortie waits with a visible note, the
// mission drive terminates instead of spinning, and the wait is BOUNDED so a starved sortie always
// reaches a human gate. Both directions are load-bearing and both are pinned here:
//   - a healthy busy fleet must NOT fault (the queue is moving; a sibling sortie legitimately holds a
//     slot for many turns), and
//   - a genuinely frozen fleet MUST still fault, with a note that is true (never-silent).
// The second is the one that matters: it is the guarantee that a full fleet can never stall a mission
// silently forever.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mission, MissionSortie } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-capwait-test-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { Missions, capWaitCeilingMs } = await import('./missions.js');

const MIN = 60_000;
const HOUR = 3_600_000;

test('capWaitCeilingMs — patience derived from how long a slot can legitimately be held', async (t) => {
  const cases: { iterations: number; expected: number; why: string }[] = [
    { iterations: 1, expected: 30 * MIN, why: 'one turn — the floor' },
    { iterations: 3, expected: 90 * MIN, why: 'three turns' },
    { iterations: 8, expected: 4 * HOUR, why: 'the composer default' },
    { iterations: 50, expected: 12 * HOUR, why: 'the composer maximum, clamped' },
    { iterations: 0, expected: 30 * MIN, why: 'a nonsense budget still gets the floor' },
    { iterations: Number.NaN, expected: 30 * MIN, why: 'NaN still gets the floor' },
  ];
  for (const c of cases) {
    await t.test(`${c.iterations} → ${c.expected / MIN}m (${c.why})`, () => {
      assert.equal(capWaitCeilingMs(c.iterations), c.expected);
    });
  }
  await t.test('never shorter than one turn, never longer than half a day', () => {
    for (const n of [-5, 0, 1, 2, 8, 24, 50, 1000]) {
      const ms = capWaitCeilingMs(n);
      assert.ok(ms >= 30 * MIN && ms <= 12 * HOUR, `${n} → ${ms}`);
    }
  });
});

/** A running mission with one phase of `n` pending sorties, plus the drive handles the tests poke. */
function fixture(opts: { sorties: string[]; maxIterationsPerSortie?: number }) {
  const store = new Store();
  const repo = join(home, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  const projectId = `p${Math.random().toString(36).slice(2, 8)}`;
  const missionId = `m${Math.random().toString(36).slice(2, 8)}`;
  store.upsertProject({ id: projectId, name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  const now = new Date().toISOString();
  const sorties: MissionSortie[] = opts.sorties.map((id) => ({ id, name: id, task: 't', status: 'pending' }));
  const mission: Mission = {
    id: missionId,
    projectId,
    name: 'm',
    goal: 'g',
    provider: 'codex',
    advance: 'gate',
    maxIterationsPerSortie: opts.maxIterationsPerSortie ?? 8,
    concurrency: 4,
    phases: [{ id: 'ph1', name: 'ph', sorties }],
    activePhase: 0,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
  store.upsertMission(mission);

  let created = 0;
  let capacityOk = false;
  const missions = new Missions({
    store,
    loops: {
      create: async () => { created++; return { id: `l${created}`, status: 'running' }; },
      list: () => [],
      get: () => undefined,
      stop: () => {},
    },
    onUpdate: () => {},
    terminalCapacity: () => (capacityOk
      ? { ok: true, detail: '' }
      : { ok: false, detail: 'terminal cap reached (12/12 live) — kill a terminal or raise the cap in Settings → System' }),
  } as never);

  const drive = missions as unknown as { startPending(id: string, phase: number): Promise<void>; capWait: Map<string, number> };
  return {
    missionId,
    drive,
    setCapacity: (ok: boolean) => { capacityOk = ok; },
    spawned: () => created,
    status: () => store.getMission(missionId)!.status,
    sortie: (sid: string) => store.getMission(missionId)!.phases[0]!.sorties.find((s) => s.id === sid)!,
    /** Pretend the sortie has been waiting this long — the anchor is stamped once and never re-stamped. */
    backdate: (sid: string, ms: number) => drive.capWait.set(`${missionId}:${sid}`, Date.now() - ms),
  };
}

test('an over-cap sortie waits instead of failing, and the drive terminates', async (t) => {
  const f = fixture({ sorties: ['s1', 's2'] });

  await t.test('startPending returns rather than spinning on a still-pending sortie', async () => {
    // The load-bearing guard: a cap-deferred sortie stays `pending`, so without the return-value
    // contract the drive would re-pick it forever and burn the tick.
    await Promise.race([
      f.drive.startPending(f.missionId, 0),
      new Promise((_, rej) => setTimeout(() => rej(new Error('startPending did not terminate')), 3000)),
    ]);
  });

  await t.test('nothing was spawned and the sortie is still pending', () => {
    assert.equal(f.spawned(), 0);
    assert.equal(f.sortie('s1').status, 'pending');
  });

  await t.test('the wait is VISIBLE on the sortie and the mission keeps running', () => {
    assert.match(f.sortie('s1').note ?? '', /^waiting for a free terminal slot — /);
    assert.equal(f.status(), 'running');
  });

  await t.test('a second drive does not re-stamp the anchor (that would reset the wait)', async () => {
    const anchor = f.drive.capWait.get(`${f.missionId}:s1`);
    await f.drive.startPending(f.missionId, 0);
    assert.equal(f.drive.capWait.get(`${f.missionId}:s1`), anchor);
  });

  await t.test('a freed slot starts the sortie and clears the note and the anchor', async () => {
    f.setCapacity(true);
    await f.drive.startPending(f.missionId, 0);
    assert.equal(f.spawned(), 2);
    assert.equal(f.sortie('s1').status, 'active');
    assert.equal(f.sortie('s1').note, undefined);
    assert.equal(f.drive.capWait.size, 0);
  });
});

test('a HEALTHY busy fleet must not fault', async (t) => {
  // The bug this pins: a queued sortie waits behind a whole sibling SORTIE, which can legitimately run
  // for many turns. A ceiling of one turn's wall clock would park a mission whose queue is simply busy.
  await t.test('31 minutes is a normal wait for a 3-iteration mission (ceiling 90m)', async () => {
    const f = fixture({ sorties: ['s1'], maxIterationsPerSortie: 3 });
    await f.drive.startPending(f.missionId, 0);
    f.backdate('s1', 31 * MIN);
    await f.drive.startPending(f.missionId, 0);
    assert.equal(f.sortie('s1').status, 'pending');
    assert.equal(f.status(), 'running');
  });

  await t.test('100 minutes is a normal wait for an 8-iteration mission (ceiling 4h)', async () => {
    const f = fixture({ sorties: ['s1'], maxIterationsPerSortie: 8 });
    await f.drive.startPending(f.missionId, 0);
    f.backdate('s1', 100 * MIN);
    await f.drive.startPending(f.missionId, 0);
    assert.equal(f.sortie('s1').status, 'pending');
    assert.equal(f.status(), 'running');
  });

  await t.test('a bigger per-sortie budget buys proportionally more patience', async () => {
    const small = fixture({ sorties: ['s1'], maxIterationsPerSortie: 2 });
    await small.drive.startPending(small.missionId, 0);
    small.backdate('s1', 3 * HOUR);
    await small.drive.startPending(small.missionId, 0);
    assert.equal(small.sortie('s1').status, 'attention', '3h exceeds a 2-iteration mission’s 1h ceiling');

    const big = fixture({ sorties: ['s1'], maxIterationsPerSortie: 8 });
    await big.drive.startPending(big.missionId, 0);
    big.backdate('s1', 3 * HOUR);
    await big.drive.startPending(big.missionId, 0);
    assert.equal(big.sortie('s1').status, 'pending', '3h is inside an 8-iteration mission’s 4h ceiling');
  });
});

test('a STARVED fleet must still fault — the never-silent guarantee', async (t) => {
  const f = fixture({ sorties: ['s1'], maxIterationsPerSortie: 8 });
  await f.drive.startPending(f.missionId, 0);

  await t.test('past the ceiling the sortie AND the mission reach a human gate', async () => {
    f.backdate('s1', 5 * HOUR); // ceiling is 4h
    await f.drive.startPending(f.missionId, 0);
    assert.equal(f.sortie('s1').status, 'attention');
    assert.equal(f.status(), 'attention');
  });

  await t.test('the note states the wait it MEASURED, and carries the reason', () => {
    const note = f.sortie('s1').note ?? '';
    // Deliberately NOT "no slot freed in N minutes": on a busy fleet slots free and are reused
    // constantly, and claiming otherwise sends the operator hunting a phantom.
    assert.match(note, /^no terminal slot came free for this sortie in 5h — /);
    assert.match(note, /terminal cap reached/);
  });

  await t.test('the anchor is cleared and no builder was ever spawned', () => {
    assert.equal(f.drive.capWait.size, 0);
    assert.equal(f.spawned(), 0);
  });

  await t.test('even at the 12h clamp a starved sortie still faults (the wait can never be unbounded)', async () => {
    const g = fixture({ sorties: ['s1'], maxIterationsPerSortie: 50 });
    await g.drive.startPending(g.missionId, 0);
    g.backdate('s1', 13 * HOUR);
    await g.drive.startPending(g.missionId, 0);
    assert.equal(g.sortie('s1').status, 'attention');
    assert.equal(g.status(), 'attention');
  });
});

test('the wait clock never survives an interruption', async (t) => {
  await t.test('pause → resume re-anchors, so a resumed sortie does not instantly fault', async () => {
    const f = fixture({ sorties: ['s1'], maxIterationsPerSortie: 8 });
    const missions = f.drive as unknown as { pause(id: string): unknown; start(id: string): Promise<unknown> };
    await f.drive.startPending(f.missionId, 0);
    f.backdate('s1', 6 * HOUR); // a long pause would leave the anchor looking like this
    missions.pause(f.missionId);
    await missions.start(f.missionId);
    assert.equal(f.drive.capWait.size, 0, 'the stale anchor is dropped on the way back to running');
    await f.drive.startPending(f.missionId, 0);
    assert.equal(f.sortie('s1').status, 'pending');
    assert.match(f.sortie('s1').note ?? '', /^waiting for a free terminal slot — /);
  });

  await t.test('abort drops the mission’s anchors', async () => {
    const f = fixture({ sorties: ['s1'] });
    const missions = f.drive as unknown as { abort(id: string): unknown };
    await f.drive.startPending(f.missionId, 0);
    assert.equal(f.drive.capWait.size, 1);
    missions.abort(f.missionId);
    assert.equal(f.drive.capWait.size, 0);
  });

  await t.test('a mission reaching done drops its anchors (no unbounded map)', async () => {
    const f = fixture({ sorties: ['s1'] });
    const missions = f.drive as unknown as { patch(id: string, p: Record<string, unknown>): unknown };
    await f.drive.startPending(f.missionId, 0);
    assert.equal(f.drive.capWait.size, 1);
    missions.patch(f.missionId, { status: 'done' }); // the choke point every done/failed write lands on
    assert.equal(f.drive.capWait.size, 0);
  });
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
