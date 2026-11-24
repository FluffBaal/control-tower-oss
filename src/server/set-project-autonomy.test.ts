// set_project_autonomy — the proposable action that arms/disarms a project's "Autonomous (skip
// permissions)" default. Two layers:
//   - in-process unit asserts on the action catalog (validateAction / the human-confirm carve-out /
//     enrich's drift baseline) — the security gate is a plain function, so exercise it directly;
//   - route-level asserts against a REAL Tower over a process boundary: the autoConfirm consult, the
//     confirm→execute path, the drift abort, and the scoped-token belt all live inside the routes, so
//     replicating them in-process would guard nothing.
//
// A scratch CT_HOME on a scratch port; the operator's Tower and ~/.ct are untouched. A DEAD child
// Tower or one that binds without serving fails the route block loudly (a stolen port lands as a
// dead child); an alive-but-slow boot skips the route tests — the unit asserts above always run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionLookups } from './assistant/actions.js';
import { freePort, spawnTower } from './tower-fixture.js';

const home = mkdtempSync(join(tmpdir(), 'ct-setautonomy-'));
process.env.CT_HOME = home;

// ---- in-process unit asserts on the action catalog (no server; paths.ts is frozen by CT_HOME above) ----

const { validateAction, requiresHumanConfirm, reasonForHumanConfirm, enrich, riskOf } = await import(
  './assistant/actions.js'
);

const lookupsFor = (project?: { name: string; repoPath: string; defaultAutoAccept?: boolean }): ActionLookups =>
  ({ getProject: (id: string) => (id === 'pa' ? project : undefined) } as unknown as ActionLookups);

test('validateAction accepts both polarities and rejects a stringified/missing/extra enabled', () => {
  assert.deepEqual(validateAction({ kind: 'set_project_autonomy', projectId: 'pa', enabled: true }), {
    kind: 'set_project_autonomy',
    projectId: 'pa',
    enabled: true,
  });
  assert.deepEqual(validateAction({ kind: 'set_project_autonomy', projectId: 'pa', enabled: false }), {
    kind: 'set_project_autonomy',
    projectId: 'pa',
    enabled: false,
  });
  assert.throws(() => validateAction({ kind: 'set_project_autonomy', projectId: 'pa', enabled: 'true' }), /invalid action/);
  assert.throws(() => validateAction({ kind: 'set_project_autonomy', projectId: 'pa' }), /invalid action/);
  assert.throws(
    () => validateAction({ kind: 'set_project_autonomy', projectId: 'pa', enabled: true, extra: 1 }),
    /invalid action/,
  );
});

test('the security carve-out: BOTH polarities always require a human confirm, with a non-empty reason', () => {
  // Kills a polarity-limited carve-out and a forgotten one — the mutation that would let autonomous-mode
  // Jarvis arm autonomy with zero clicks.
  for (const enabled of [true, false]) {
    const action = validateAction({ kind: 'set_project_autonomy', projectId: 'pa', enabled });
    assert.equal(requiresHumanConfirm(action), true, `enabled:${enabled} must always wait for a human`);
    assert.notEqual(reasonForHumanConfirm(action), '', `enabled:${enabled} carries a skip-audit reason`);
  }
  assert.equal(riskOf(validateAction({ kind: 'set_project_autonomy', projectId: 'pa', enabled: true })), 'high');
});

test('enrich names the project + current state, and denorm.currentAutoAccept is 0 for absent AND explicit-false', () => {
  const armed = validateAction({ kind: 'set_project_autonomy', projectId: 'pa', enabled: true });
  assert.throws(() => enrich(armed, lookupsFor(undefined)), /unknown projectId/);

  const absent = enrich(armed, lookupsFor({ name: 'Scratch', repoPath: '/x' }));
  assert.match(absent.summary, /Scratch/);
  assert.match(absent.summary, /asks first/);
  assert.equal(absent.denorm.currentAutoAccept, 0, 'an absent flag reads as 0 (OFF)');

  const explicitFalse = enrich(armed, lookupsFor({ name: 'Scratch', repoPath: '/x', defaultAutoAccept: false }));
  assert.equal(explicitFalse.denorm.currentAutoAccept, 0, 'explicit false reads as 0 too — matches the route drop-on-false');

  const on = enrich(armed, lookupsFor({ name: 'Scratch', repoPath: '/x', defaultAutoAccept: true }));
  assert.equal(on.denorm.currentAutoAccept, 1);
  assert.match(on.summary, /autonomous/);
});

// ---- route-level asserts against a real Tower ----

const PORT = await freePort();
process.env.CT_PORT = String(PORT);

const now = new Date().toISOString();
mkdirSync(join(home, 'config'), { recursive: true });
const writeConfig = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));

writeConfig('projects.json', [{ id: 'pa', name: 'pa', repoPath: home, scaffoldMode: 'zero-footprint', createdAt: now }]);
// One assistant account, active (getActiveAccount = first), with autoConfirm ON — so the carve-out is
// what keeps a set_project_autonomy proposal pending rather than the account being non-autonomous.
writeConfig('assistant-accounts.json', [
  { id: 'aa', mode: 'cli', provider: 'codex', profileId: 'brainx', autoConfirm: true, createdAt: now },
]);

const base = `http://127.0.0.1:${PORT}`;

// Spawn + identity-gated readiness live in tower-fixture.ts: "ready" means OUR Tower (the startup
// line carrying THIS file's CT_HOME) answered /api/session. A DEAD child (how a stolen port lands)
// or a bound-but-unresponsive Tower throws loudly; only an alive-but-slow boot yields a skip.
const tower = await spawnTower(home, PORT);
const token = tower.sessionToken;
const skip = tower.skip ?? false;

const sessionHeaders = { 'X-Tower-Token': token, 'Content-Type': 'application/json' };
const propose = (conv: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/assistant/proposals`, {
    method: 'POST',
    headers: { ...sessionHeaders, 'X-Tower-Conversation': conv },
    body: JSON.stringify(body),
  });
const confirm = (proposalId: string): Promise<Response> =>
  fetch(`${base}/api/assistant/confirm`, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ proposalId }) });
const setAutoAccept = (enabled: boolean): Promise<Response> =>
  fetch(`${base}/api/projects/pa/auto-accept`, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ enabled }) });
async function projectPa(): Promise<Record<string, unknown> | undefined> {
  const rows = (await (await fetch(`${base}/api/projects`, { headers: { 'X-Tower-Token': token } })).json()) as Record<string, unknown>[];
  return rows.find((p) => p.id === 'pa');
}
const errOf = async (r: Response): Promise<string> => ((await r.json().catch(() => ({}))) as { error?: string }).error ?? '';

test('autoConfirm consult: a set_project_autonomy proposal stays PENDING even with autonomous mode on', { skip }, async () => {
  const r = await propose('convauto', { kind: 'set_project_autonomy', args: { projectId: 'pa', enabled: true } });
  assert.equal(r.status, 200);
  const p = (await r.json()) as Record<string, unknown>;
  assert.equal(p.status, 'pending', 'the carve-out holds even under autoConfirm — no self-arming');
  assert.ok(!('defaultAutoAccept' in (await projectPa() ?? {})), 'the project record is byte-unchanged (nothing executed)');
});

test('confirm executes: enabled:true arms the flag; a second card enabled:false drops the key', { skip }, async () => {
  const armR = await propose('convarm', { kind: 'set_project_autonomy', args: { projectId: 'pa', enabled: true } });
  const arm = (await armR.json()) as { id: string };
  const armDone = await confirm(arm.id);
  assert.equal(armDone.status, 200);
  assert.equal(((await armDone.json()) as Record<string, unknown>).status, 'executed', 'the confirm ran the action');
  assert.equal((await projectPa())?.defaultAutoAccept, true, 'the project is now autonomous');

  const disR = await propose('convdisarm', { kind: 'set_project_autonomy', args: { projectId: 'pa', enabled: false } });
  const dis = (await disR.json()) as { id: string };
  const disDone = await confirm(dis.id);
  assert.equal(disDone.status, 200);
  assert.equal(((await disDone.json()) as Record<string, unknown>).status, 'executed');
  // false persists as an ABSENT key (server.ts drops it), read from the store file directly.
  const stored = JSON.parse(readFileSync(join(home, 'config', 'projects.json'), 'utf8')) as Record<string, unknown>[];
  const pa = stored.find((p) => p.id === 'pa');
  assert.ok(pa && !('defaultAutoAccept' in pa), 'disarm drops the key entirely — never a stored false');
});

test('drift: the flag flipping between propose and confirm voids the card (409)', { skip }, async () => {
  // Ensure the project starts OFF so the proposed enabled:true baselines currentAutoAccept = 0.
  await setAutoAccept(false);
  const r = await propose('convdrift', { kind: 'set_project_autonomy', args: { projectId: 'pa', enabled: true } });
  const p = (await r.json()) as { id: string };
  // Flip the flag ON behind the card via the direct route — re-enrich now baselines 1, not 0.
  assert.equal((await setAutoAccept(true)).status, 200);
  const drifted = await confirm(p.id);
  assert.equal(drifted.status, 409, 'a drifted baseline aborts the confirm');
  assert.match(await errOf(drifted), /changed since proposed/);
});

test('scoped-token belt: the assistant token cannot call POST /api/projects/:id/auto-accept (403)', { skip }, async () => {
  // The route is deliberately absent from ASSISTANT_ACCEPT — a confirmed proposal reaches it only via the
  // executor's SESSION-token inject, never the scoped token. This pins that non-widening.
  const assistantToken = readFileSync(join(home, 'secrets', 'mcptok-assistant'), 'utf8').trim();
  const r = await fetch(`${base}/api/projects/pa/auto-accept`, {
    method: 'POST',
    headers: { 'X-Tower-Token': assistantToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(r.status, 403, 'the scoped assistant token is refused on the arm route');
});

test.after(() => {
  try {
    tower.server?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  rmSync(home, { recursive: true, force: true });
});
