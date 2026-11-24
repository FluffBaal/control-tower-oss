// SPEC-STORYLOOP §4 — the regression gate. Two things are pinned: the pure partitioner (deterministic,
// never splits a key-group across buckets — a split is a guaranteed land conflict), and the gate's
// never-fabricate posture (an integrated tree with no parseable results.json is an ERROR, never a
// silent pass, and the run is released 'failed'). The empty-branch trivial pass must never even touch
// the kit.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time. The real ~/.ct is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MissionPhase, MissionSortie, Project, TestFailure } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-gate-test-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { RegressionGate, partitionByKey, partitionBySpecFile } = await import('./gate.js');

const haveGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// ---- partitionByKey (pure) ----

test('partitionByKey — determinism, never-split, trailing-empties, n=0, tie-break', async (t) => {
  const items = [
    { k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }, { k: 'c', v: 4 }, { k: 'b', v: 5 }, { k: 'a', v: 6 },
  ];
  const keyOf = (x: { k: string }) => x.k;

  await t.test('deterministic — the same input yields byte-identical partitions', () => {
    assert.deepEqual(partitionByKey(items, 2, keyOf), partitionByKey(items, 2, keyOf));
  });

  await t.test('never splits a key-group across buckets', () => {
    const buckets = partitionByKey(items, 3, keyOf);
    for (const key of ['a', 'b', 'c']) {
      const owning = buckets.filter((b) => b.some((x) => x.k === key));
      assert.equal(owning.length, 1, `key ${key} lives in exactly one bucket`);
    }
    // and every item is placed exactly once
    assert.equal(buckets.flat().length, items.length);
  });

  await t.test('trailing buckets are empty when n > distinct keys', () => {
    const buckets = partitionByKey(items, 5, keyOf); // 3 distinct keys, 5 buckets
    const nonEmpty = buckets.filter((b) => b.length > 0).length;
    assert.equal(nonEmpty, 3, 'only three buckets are used');
    assert.equal(buckets.length, 5, 'but n buckets are always returned');
  });

  await t.test('n = 0 yields no buckets', () => {
    assert.deepEqual(partitionByKey(items, 0, keyOf), []);
  });

  await t.test('equal-size groups break ties by key name (total, stable order)', () => {
    const singles = [{ k: 'c' }, { k: 'a' }, { k: 'b' }];
    const buckets = partitionByKey(singles, 3, (x) => x.k);
    assert.deepEqual(buckets, [[{ k: 'a' }], [{ k: 'b' }], [{ k: 'c' }]]);
  });
});

test('partitionBySpecFile delegates to partitionByKey on specFile', () => {
  const fails: TestFailure[] = [
    { specFile: 'x.spec.ts', testTitle: 't1' } as TestFailure,
    { specFile: 'y.spec.ts', testTitle: 't2' } as TestFailure,
    { specFile: 'x.spec.ts', testTitle: 't3' } as TestFailure,
  ];
  const buckets = partitionBySpecFile(fails, 2);
  // x.spec.ts (2) must not split.
  const xOwning = buckets.filter((b) => b.some((f) => f.specFile === 'x.spec.ts'));
  assert.equal(xOwning.length, 1);
  assert.equal(buckets.flat().length, 3);
});

// ---- gate.check (integration) ----

const phase: MissionPhase = { id: 'ph', name: 'phase', sorties: [] };
const doneSortie = (loopId: string | undefined): MissionSortie => ({ id: 's1', name: 's', task: 't', status: 'done', ...(loopId ? { loopId } : {}) });

test('gate.check — an empty branch set is a trivial pass and NEVER touches the kit', async () => {
  const kit = {
    acquireGate: () => { throw new Error('acquireGate must not be called for an empty branch set'); },
    release: () => {},
  };
  const gate = new RegressionGate({ testkit: kit, loops: { get: () => undefined } });
  const project = { id: 'p', name: 'p', repoPath: home, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() } as Project;
  // A done sortie whose loop resolves to no branch → nothing to integrate → pass, kit untouched.
  const res = await gate.check(project, phase, [doneSortie('l1')], 'true');
  assert.deepEqual(res, { status: 'pass' });
});

/** A real repo with a default branch plus a `feat` branch that is one commit ahead of it. */
function setupRepo(): { project: Project } {
  const src = join(home, `gate-src-${Math.random().toString(36).slice(2)}`);
  mkdirSync(src, { recursive: true });
  const g = (args: string[], cwd = src): string => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
  g(['init']);
  g(['config', 'user.name', 'Test User']);
  g(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(src, 'README.md'), 'hello\n');
  g(['add', '-A']);
  g(['commit', '-m', 'initial']);
  g(['branch', '-M', 'main']); // defaultBase → 'main'
  g(['checkout', '-b', 'feat']);
  writeFileSync(join(src, 'feat.txt'), 'work\n');
  g(['add', '-A']);
  g(['commit', '-m', 'feat change']);
  g(['checkout', 'main']);
  return { project: { id: `p${Math.random().toString(36).slice(2, 8)}`, name: 'p', repoPath: src, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() } as Project };
}

test('gate.check — kit at capacity is a DEFERRAL, not a regression verdict', { skip: !haveGit }, async () => {
  const { project } = setupRepo();
  const kit = { acquireGate: () => null, release: () => {} }; // always at capacity
  const gate = new RegressionGate({ testkit: kit, loops: { get: () => ({ branch: 'feat' }) } });
  // acquireGateRun retries with an UNREF'd backoff (a few seconds); a bare test process would otherwise
  // drain the loop and exit mid-wait, so hold it open until the verdict lands.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const res = await gate.check(project, phase, [doneSortie('l1')], 'true');
    assert.equal(res.status, 'capacity', 'a full kit is capacity, never failures/pass');
  } finally {
    clearInterval(keepAlive);
  }
});

test('gate.check — an integrated tree with no parseable results is an ERROR, never a fabricated pass', { skip: !haveGit }, async () => {
  const { project } = setupRepo();
  const runDir = mkdtempSync(join(home, 'gate-run-'));
  const released: { id: string; status: string }[] = [];
  const kit = {
    // gateSuite 'true' runs and exits 0 but writes NO results.json into runDir.
    acquireGate: () => ({ id: 'g1', runDir, port: 39117 }),
    release: (id: string, status: 'passed' | 'failed') => { released.push({ id, status }); },
  };
  const gate = new RegressionGate({ testkit: kit, loops: { get: () => ({ branch: 'feat' }) } });
  const res = await gate.check(project, phase, [doneSortie('l1')], 'true');
  assert.equal(res.status, 'error', 'never a pass off an unverifiable tree');
  if (res.status === 'error') assert.match(res.detail, /no parseable results\.json/);
  assert.deepEqual(released, [{ id: 'g1', status: 'failed' }], 'the run is released FAILED, never passed');
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
