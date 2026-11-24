// Autonomy (skip-permissions) route gates, driven against a REAL Tower over a process boundary — the
// gates live inside the routes, so replicating them in-process would guard nothing:
//   - the create route refuses an explicit autoAccept on an unsupporting provider (400, pre-spawn),
//     a non-boolean autoAccept (400), and any autoAccept on a shell (400);
//   - POST /api/projects/:id/auto-accept sets/clears the per-project default (false drops the key);
//   - planner-attach refuses an autonomous pane (409) so a skip-permissions process never becomes a planner.
//
// A scratch CT_HOME on a scratch port; the operator's Tower and ~/.ct are untouched. A DEAD child
// Tower or one that binds without serving fails loudly (a stolen port lands as a dead child); an
// alive-but-slow boot skips. Every exercised request 400/404/409s BEFORE any tmux spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, spawnTower } from './tower-fixture.js';

const home = mkdtempSync(join(tmpdir(), 'ct-autoaccept-route-'));
const PORT = await freePort();
process.env.CT_HOME = home;
process.env.CT_PORT = String(PORT);

const now = new Date().toISOString();
mkdirSync(join(home, 'config'), { recursive: true });
const write = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));

// The seeded autonomous pane is 'starting' with a fresh createdAt so the startup reconcile leaves it
// live (a sessionless 'idle' record would be vanished→killed before readiness, and attach would then
// 409 on 'killed' instead of 'autonomous'). The autoAccept refusal precedes the idle/hook-token
// preflight, so 'starting' still reaches it and no token file is needed.
write('projects.json', [{ id: 'pa', name: 'pa', repoPath: home, scaffoldMode: 'zero-footprint', createdAt: now }]);
write('terminals.json', [
  { id: 'ta', projectId: 'pa', title: 'auto pane', provider: 'claude-code', tmuxSocket: 'ct-ta', cwd: home, command: [], state: 'starting', autoAccept: true, createdAt: now },
]);
write('missions.json', [
  { id: 'ma', projectId: 'pa', name: 'm', goal: 'g', provider: 'codex', advance: 'gate', maxIterationsPerSortie: 8, concurrency: 1, phases: [], activePhase: 0, status: 'draft', createdAt: now, updatedAt: now },
]);

const base = `http://127.0.0.1:${PORT}`;

// Spawn + identity-gated readiness live in tower-fixture.ts: "ready" means OUR Tower (the startup
// line carrying THIS file's CT_HOME) answered /api/session. A DEAD child (how a stolen port lands)
// or a bound-but-unresponsive Tower throws loudly; only an alive-but-slow boot yields a skip.
const tower = await spawnTower(home, PORT);
const token = tower.sessionToken;
const skip = tower.skip ?? false;

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'X-Tower-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function terminals(): Promise<Record<string, unknown>[]> {
  return (await (await fetch(`${base}/api/terminals`, { headers: { 'X-Tower-Token': token } })).json()) as Record<string, unknown>[];
}
async function projects(): Promise<Record<string, unknown>[]> {
  return (await (await fetch(`${base}/api/projects`, { headers: { 'X-Tower-Token': token } })).json()) as Record<string, unknown>[];
}
const errOf = async (r: Response): Promise<string> => ((await r.json().catch(() => ({}))) as { error?: string }).error ?? '';

test('create route — autonomy gates all 400 before any spawn', { skip }, async () => {
  // (a) explicit autoAccept on an unsupporting provider → 400, and NOTHING spawned (the gate is pre-spawn).
  const codex = await post('/api/terminals', { projectId: 'pa', provider: 'codex', autoAccept: true });
  assert.equal(codex.status, 400, 'codex + autoAccept → 400');
  assert.match(await errOf(codex), /does not support autonomous/);
  assert.equal((await terminals()).some((t) => t.provider === 'codex'), false, 'the refused create spawned no codex terminal');

  // (b) a non-boolean autoAccept must not read as truthy OR degrade to inherit → 400.
  const bad = await post('/api/terminals', { projectId: 'pa', provider: 'claude-code', autoAccept: 'yes' });
  assert.equal(bad.status, 400, "autoAccept:'yes' → 400");
  assert.match(await errOf(bad), /must be a boolean/);

  // (c) a shell terminal (no provider) takes no autonomy → 400.
  const shell = await post('/api/terminals', { projectId: 'pa', autoAccept: false });
  assert.equal(shell.status, 400, 'shell + autoAccept → 400');
  assert.match(await errOf(shell), /takes no model\/effort\/account\/autonomy/);
});

test('POST /api/projects/:id/auto-accept sets, clears (key dropped on false), and validates', { skip }, async () => {
  const on = await post('/api/projects/pa/auto-accept', { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(((await on.json()) as Record<string, unknown>).defaultAutoAccept, true, 'response reflects the armed default');
  assert.equal((await projects()).find((p) => p.id === 'pa')?.defaultAutoAccept, true, 'GET shows it (post-upsert reload path)');

  const off = await post('/api/projects/pa/auto-accept', { enabled: false });
  assert.equal(off.status, 200);
  const offBody = (await off.json()) as Record<string, unknown>;
  assert.ok(!('defaultAutoAccept' in offBody), 'false drops the key (undefined-drop, not a stored false)');
  assert.ok(!('defaultAutoAccept' in ((await projects()).find((p) => p.id === 'pa') ?? {})), 'the key is absent after reload too');

  assert.equal((await post('/api/projects/pa/auto-accept', { enabled: 'x' })).status, 400, 'non-boolean enabled → 400');
  assert.equal((await post('/api/projects/nope/auto-accept', { enabled: true })).status, 404, 'unknown project → 404');
});

test('planner-attach refuses an autonomous pane (409)', { skip }, async () => {
  const r = await post('/api/missions/ma/planner/attach', { terminalId: 'ta' });
  assert.equal(r.status, 409, 'an autonomous pane can never become a planner');
  assert.match(await errOf(r), /autonomous/);
});

test.after(() => {
  try {
    tower.server?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  rmSync(home, { recursive: true, force: true });
});
