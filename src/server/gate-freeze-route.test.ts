// SPEC-SKILLS-GATE — freeze-at-create through the REAL route. The unit tests prove missions.create's
// derived-arg freeze; this proves the ROUTE half: POST /api/missions on a project whose resolved skill
// selection holds an enabled BLOCKING loop-green gate mints a loop mission carrying that frozen set,
// an advisory skill declaring the same block freezes NOTHING, and a wire body smuggling
// loop.requiredGates is inert (the derived second arg is the only way in). A scratch CT_HOME on a
// scratch port (no tmux needed — create mints a draft, nothing spawns); the operator's Tower and ~/.ct
// are untouched. A DEAD child Tower or one that binds without serving fails loudly (a stolen port
// lands as a dead child); an alive-but-slow boot skips the route tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, spawnTower } from './tower-fixture.js';

const home = mkdtempSync(join(tmpdir(), 'ct-gate-freeze-'));
process.env.CT_HOME = home;

const PORT = await freePort();
process.env.CT_PORT = String(PORT);
const base = `http://127.0.0.1:${PORT}`;

// Spawn + identity-gated readiness live in tower-fixture.ts: "ready" means OUR Tower (the startup
// line carrying THIS file's CT_HOME) answered /api/session. A DEAD child (how a stolen port lands)
// or a bound-but-unresponsive Tower throws loudly; only an alive-but-slow boot yields a skip.
const tower = await spawnTower(home, PORT);
const token = tower.sessionToken;
const skip = tower.skip ?? false;

type Res = { status: number; body: Record<string, unknown> };
async function call(method: string, path: string, payload?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'X-Tower-Token': token,
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, body };
}

/** A minimal loop-mission create body against the built-in sandbox project. */
function missionBody(name: string, loop: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    projectId: 'sandbox', name, goal: 'g',
    phases: [{ name: 'build', sorties: [{ name: 'b', task: 't' }] }],
    ...(loop !== undefined ? { loop } : {}),
  };
}

type CreatedLoop = { requiredGates?: string[]; rerunGates?: string[] } | undefined;
const loopOf = (r: Res): CreatedLoop => (r.body as { loop?: CreatedLoop }).loop;

// Ordered top-level tests: the advisory-only world is asserted BEFORE the blocking skill exists.

test('an advisory skill declaring loop-green freezes NOTHING', { skip }, async () => {
  const mk = await call('POST', '/api/skills', {
    id: 'advisory-note', name: 'Advisory Note', description: 'd', body: 'b',
    gate: { mode: 'advisory', blocks: ['loop-green'] },
  });
  assert.equal(mk.status, 200, JSON.stringify(mk.body));
  const created = await call('POST', '/api/missions', missionBody('advisory-only', {}));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(loopOf(created)?.requiredGates, undefined, 'advisory never gates the boundary');
});

test('a wire body smuggling loop.requiredGates is inert through the route', { skip }, async () => {
  // Still the advisory-only world: the derived set is empty, so ANY carried value must vanish.
  const created = await call('POST', '/api/missions', missionBody('smuggle', {
    maxRounds: 2, requiredGates: ['evil'], rerunGates: ['evil'],
  }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(loopOf(created)?.requiredGates, undefined, 'the wire field never reaches the mission');
  assert.equal(loopOf(created)?.rerunGates, undefined);
});

test('an enabled BLOCKING loop-green skill is frozen onto a new loop mission', { skip }, async () => {
  const mk = await call('POST', '/api/skills', {
    id: 'diff-audit', name: 'Diff Audit', description: 'd', body: 'b',
    gate: { mode: 'blocking', blocks: ['loop-green'], enforcedBy: ['orchestrator'], rerunOnNewDiff: true },
  });
  assert.equal(mk.status, 200, JSON.stringify(mk.body));
  const created = await call('POST', '/api/missions', missionBody('gated-loop', {}));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(loopOf(created)?.requiredGates, ['diff-audit'], 'the blocking gate is frozen at create');
  assert.deepEqual(loopOf(created)?.rerunGates, ['diff-audit'], 'rerunOnNewDiff lands in the rerun subset');
});

test('a DISABLED blocking loop-green skill freezes nothing (the master switch is honored)', { skip }, async () => {
  const mk = await call('POST', '/api/skills', {
    id: 'dormant-audit', name: 'Dormant Audit', description: 'd', body: 'b', enabled: false,
    gate: { mode: 'blocking', blocks: ['loop-green'] },
  });
  assert.equal(mk.status, 200, JSON.stringify(mk.body));
  const created = await call('POST', '/api/missions', missionBody('disabled-gate', {}));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(loopOf(created)?.requiredGates, ['diff-audit'],
    'only the ENABLED blocking gate freezes — a disabled one never reaches the resolved selection');
});

test('a NON-loop mission derives no gate set at all', { skip }, async () => {
  const created = await call('POST', '/api/missions', missionBody('linear', undefined));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((created.body as { loop?: unknown }).loop, undefined, 'no loop → no boundary → nothing to gate');
});

function cleanup(): void {
  try { tower.server?.kill('SIGKILL'); } catch { /* ignore */ }
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
}
process.on('exit', cleanup);
