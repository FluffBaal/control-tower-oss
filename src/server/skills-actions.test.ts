// set_skill_enabled / set_project_skills — the two proposable skill-selection actions (SPEC-SKILLS
// Phase 5a), a direct clone of set_project_autonomy. Two layers, mirroring set-project-autonomy.test.ts:
//   - in-process unit asserts on the action catalog (validateAction / the human-confirm carve-out /
//     enrich's protected refusal + drift baseline) plus the isProtectedSkill derivation — the security
//     gates are plain functions, so exercise them directly;
//   - route-level asserts against a REAL Tower: the autoConfirm carve-out (a skill toggle stays PENDING
//     with the target byte-unchanged even in autonomous mode), the protected refusal at propose (proven
//     by flipping protection OFF → then it is allowed), the narrow enabled route (flips only enabled +
//     fires the {t:'skills'} SSE frame), drift, and the scoped-token belt.
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

const home = mkdtempSync(join(tmpdir(), 'ct-skillsactions-'));
process.env.CT_HOME = home;

// ---- in-process unit asserts on the action catalog (no server; paths.ts is frozen by CT_HOME above) ----

const { validateAction, requiresHumanConfirm, reasonForHumanConfirm, enrich, riskOf } = await import(
  './assistant/actions.js'
);
const { isProtectedSkill } = await import('./skills/store.js');

interface SkillProjection {
  name: string;
  enabled: boolean;
  protected: boolean;
  contentHash: string;
}
const mkLookups = (opts: {
  skills?: Record<string, SkillProjection>;
  bundles?: Record<string, { name: string }>;
  projects?: Record<string, { name: string; repoPath: string }>;
  projectSkills?: Record<string, { bundleId?: string; enable?: Record<string, boolean> }>;
  replaceDelta?: (
    id: string,
    proposed: { bundleId?: string; enable?: Record<string, boolean> },
  ) => { dropped: string[]; droppedProtected: string[] };
}): ActionLookups =>
  ({
    getSkill: (id: string) => opts.skills?.[id],
    getBundle: (id: string) => opts.bundles?.[id],
    getProject: (id: string) => opts.projects?.[id],
    getProjectSkills: (id: string) => opts.projectSkills?.[id],
    projectSkillReplaceDelta: opts.replaceDelta ?? (() => ({ dropped: [], droppedProtected: [] })),
  } as unknown as ActionLookups);

test('isProtectedSkill: derives protection from the flag OR a blocking gate', () => {
  assert.equal(isProtectedSkill({ protected: true }), true);
  assert.equal(isProtectedSkill({ gate: { mode: 'blocking' } }), true);
  assert.equal(isProtectedSkill({ gate: { mode: 'advisory' } }), false);
  assert.equal(isProtectedSkill({}), false);
});

test('validateAction: both skill kinds parse strictly (wrong-type / missing / extra-key / over-cap throw)', () => {
  assert.deepEqual(validateAction({ kind: 'set_skill_enabled', skillId: 's1', enabled: true }), {
    kind: 'set_skill_enabled',
    skillId: 's1',
    enabled: true,
  });
  assert.throws(() => validateAction({ kind: 'set_skill_enabled', skillId: 's1', enabled: 'true' }), /invalid action/);
  assert.throws(() => validateAction({ kind: 'set_skill_enabled', skillId: 's1' }), /invalid action/);
  assert.throws(() => validateAction({ kind: 'set_skill_enabled', skillId: 's1', enabled: true, extra: 1 }), /invalid action/);

  // An EMPTY overlay is valid (clear-to-inherit — no ≥1-field superRefine); bundleId:null is a valid clear.
  assert.deepEqual(validateAction({ kind: 'set_project_skills', projectId: 'p1' }), { kind: 'set_project_skills', projectId: 'p1' });
  assert.deepEqual(validateAction({ kind: 'set_project_skills', projectId: 'p1', bundleId: null }), {
    kind: 'set_project_skills',
    projectId: 'p1',
    bundleId: null,
  });
  assert.deepEqual(
    validateAction({ kind: 'set_project_skills', projectId: 'p1', bundleId: 'b1', enable: { s1: true, s2: false } }),
    { kind: 'set_project_skills', projectId: 'p1', bundleId: 'b1', enable: { s1: true, s2: false } },
  );
  assert.throws(() => validateAction({ kind: 'set_project_skills', projectId: 'p1', enable: { s1: 'yes' } }), /invalid action/);
  assert.throws(() => validateAction({ kind: 'set_project_skills', projectId: 'p1', extra: 1 }), /invalid action/);
  const big: Record<string, boolean> = {};
  for (let i = 0; i < 65; i++) big[`s${i}`] = true;
  assert.throws(() => validateAction({ kind: 'set_project_skills', projectId: 'p1', enable: big }), /at most 64/);
});

test('the security carve-out: both skill kinds are HIGH risk and ALWAYS require a human confirm, both polarities', () => {
  for (const enabled of [true, false]) {
    const a = validateAction({ kind: 'set_skill_enabled', skillId: 's1', enabled });
    assert.equal(riskOf(a), 'high');
    assert.equal(requiresHumanConfirm(a), true, `enabled:${enabled} must always wait for a human`);
    assert.notEqual(reasonForHumanConfirm(a), '');
  }
  for (const enable of [{ s1: true }, { s1: false }, undefined] as (Record<string, boolean> | undefined)[]) {
    const a = validateAction({ kind: 'set_project_skills', projectId: 'p1', ...(enable ? { enable } : {}) });
    assert.equal(riskOf(a), 'high');
    assert.equal(requiresHumanConfirm(a), true);
    assert.notEqual(reasonForHumanConfirm(a), '');
  }
});

test('enrich set_skill_enabled: unknown id throws; a protected skill is refused (both polarities); denorm carries enabled + hash', () => {
  const known = mkLookups({ skills: { s1: { name: 'S1', enabled: true, protected: false, contentHash: 'h1' } } });
  assert.throws(() => enrich(validateAction({ kind: 'set_skill_enabled', skillId: 'nope', enabled: false }), known), /unknown skillId/);
  const e = enrich(validateAction({ kind: 'set_skill_enabled', skillId: 's1', enabled: false }), known);
  assert.match(e.summary, /Disable skill "S1"/);
  assert.equal(e.denorm.currentEnabled, 1, 'baselines the current enabled state (1 = on)');
  assert.equal(e.denorm.contentHash, 'h1', 'a body-edit between propose and confirm voids the card too');

  const prot = mkLookups({ skills: { s1: { name: 'S1', enabled: true, protected: true, contentHash: 'h1' } } });
  for (const enabled of [true, false]) {
    assert.throws(
      () => enrich(validateAction({ kind: 'set_skill_enabled', skillId: 's1', enabled }), prot),
      /protected gate/,
      `enabled:${enabled} against a protected skill is refused`,
    );
  }
});

test('enrich set_project_skills: resolves bundle + skills, refuses a protected skill in the enable map, baselines the overlay', () => {
  const lookups = mkLookups({
    projects: { p1: { name: 'Proj', repoPath: '/x' } },
    bundles: { b1: { name: 'Bundle One' } },
    skills: {
      s1: { name: 'S1', enabled: true, protected: false, contentHash: 'h1' },
      g: { name: 'Gate', enabled: true, protected: true, contentHash: 'hg' },
    },
    projectSkills: { p1: { bundleId: 'bcur', enable: { x: true, a: false } } },
  });
  assert.throws(() => enrich(validateAction({ kind: 'set_project_skills', projectId: 'nope' }), lookups), /unknown projectId/);
  assert.throws(() => enrich(validateAction({ kind: 'set_project_skills', projectId: 'p1', bundleId: 'zz' }), lookups), /unknown bundleId/);
  assert.throws(() => enrich(validateAction({ kind: 'set_project_skills', projectId: 'p1', enable: { nope: true } }), lookups), /unknown skill/);
  // Protected refusal in EITHER polarity — the selection-sabotage close.
  for (const on of [true, false]) {
    assert.throws(
      () => enrich(validateAction({ kind: 'set_project_skills', projectId: 'p1', enable: { g: on } }), lookups),
      /protected gate/,
    );
  }
  const e = enrich(validateAction({ kind: 'set_project_skills', projectId: 'p1', bundleId: 'b1', enable: { s1: true } }), lookups);
  assert.match(e.summary, /Proj/);
  assert.match(e.summary, /Bundle One/);
  assert.equal(e.denorm.projectName, 'Proj');
  assert.equal(e.denorm.currentBundleId, 'bcur');
  // Order-independent (sorted) so a same-content re-enrich never false-drifts.
  assert.equal(e.denorm.currentEnableJson, JSON.stringify({ a: false, x: true }));
});

test('enrich set_project_skills: refuses a REPLACE that would drop a protected skill by OMISSION (no explicit enable:false)', () => {
  const drops = mkLookups({
    projects: { p1: { name: 'Proj', repoPath: '/x' } },
    replaceDelta: () => ({ dropped: ['Scoped Prot'], droppedProtected: ['Scoped Prot'] }),
  });
  // The bare {projectId} reset names NOTHING, yet the effective-set diff sees the protected skill leaving.
  assert.throws(() => enrich(validateAction({ kind: 'set_project_skills', projectId: 'p1' }), drops), /remove protected skill/);
  const clean = mkLookups({
    projects: { p1: { name: 'Proj', repoPath: '/x' } },
    bundles: { b1: { name: 'B1' } },
    replaceDelta: () => ({ dropped: [], droppedProtected: [] }),
  });
  assert.doesNotThrow(() => enrich(validateAction({ kind: 'set_project_skills', projectId: 'p1', bundleId: 'b1' }), clean));
});

// ---- route-level asserts against a real Tower ----

const PORT = await freePort();
process.env.CT_PORT = String(PORT);

const now = new Date().toISOString();
mkdirSync(join(home, 'config'), { recursive: true });
const writeConfig = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));

writeConfig('projects.json', [{ id: 'pa', name: 'pa', repoPath: home, scaffoldMode: 'zero-footprint', createdAt: now }]);
// One assistant account, active, with autoConfirm ON — so the carve-out is what keeps a skill proposal
// pending, not the account being non-autonomous.
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
const postSkill = (body: unknown): Promise<Response> =>
  fetch(`${base}/api/skills`, { method: 'POST', headers: sessionHeaders, body: JSON.stringify(body) });
const putSkill = (id: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/skills/${id}`, { method: 'PUT', headers: sessionHeaders, body: JSON.stringify(body) });
const setEnabledRoute = (id: string, enabled: boolean): Promise<Response> =>
  fetch(`${base}/api/skills/${id}/enabled`, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ enabled }) });
async function getSkill(id: string): Promise<Record<string, unknown> | undefined> {
  const r = await fetch(`${base}/api/skills/${id}`, { headers: { 'X-Tower-Token': token } });
  return r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
}
async function paOverlay(): Promise<{ bundleId?: unknown; enable?: unknown }> {
  const r = (await (await fetch(`${base}/api/projects/pa/skills`, { headers: { 'X-Tower-Token': token } })).json()) as Record<string, unknown>;
  return { bundleId: r.bundleId, enable: r.enable };
}
const errOf = async (r: Response): Promise<string> => ((await r.json().catch(() => ({}))) as { error?: string }).error ?? '';

// Seed the library once the Tower is up — a skipped boot seeds nothing (its route tests skip too).
if (!skip) {
  await postSkill({ id: 'alpha', name: 'Alpha', description: 'd', body: 'b' });
  await postSkill({ id: 'beta', name: 'Beta', description: 'd', body: 'b' });
  await postSkill({ id: 'gamma', name: 'Gamma', description: 'd', body: 'b' });
  await postSkill({ id: 'delta', name: 'Delta', description: 'd', body: 'b' });
  await postSkill({ id: 'eps', name: 'Eps', description: 'd', body: 'b' });
  await postSkill({ id: 'guard', name: 'Guard', description: 'd', body: 'b', gate: { mode: 'blocking' } });
  await postSkill({ id: 'locked', name: 'Locked', description: 'd', body: 'b', protected: true });
}

test('autoConfirm consult: a set_skill_enabled proposal stays PENDING and the skill is byte-unchanged', { skip }, async () => {
  const before = await getSkill('alpha');
  assert.equal(before?.enabled, true);
  const r = await propose('convskill', { kind: 'set_skill_enabled', args: { skillId: 'alpha', enabled: false } });
  assert.equal(r.status, 200);
  const p = (await r.json()) as Record<string, unknown>;
  assert.equal(p.status, 'pending', 'the carve-out holds even under autoConfirm — no self-toggling');
  const after = await getSkill('alpha');
  assert.equal(after?.enabled, true, 'the skill is byte-unchanged (nothing executed)');
});

test('autoConfirm consult: a set_project_skills proposal stays PENDING and the overlay is byte-unchanged', { skip }, async () => {
  const before = JSON.stringify(await paOverlay());
  const r = await propose('convproj', { kind: 'set_project_skills', args: { projectId: 'pa', enable: { alpha: true } } });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as Record<string, unknown>).status, 'pending');
  assert.equal(JSON.stringify(await paOverlay()), before, 'the project overlay is byte-unchanged (nothing executed)');
});

test('cannot propose against a PROTECTED skill; flipping protection off makes the same proposal succeed', { skip }, async () => {
  // A blocking-gate skill and an operator-locked skill are both refused at propose (400 naming protection).
  const blocked = await propose('convprot', { kind: 'set_skill_enabled', args: { skillId: 'guard', enabled: false } });
  assert.equal(blocked.status, 400);
  assert.match(await errOf(blocked), /protected gate/);
  const blockedMap = await propose('convprot', { kind: 'set_project_skills', args: { projectId: 'pa', enable: { guard: false } } });
  assert.equal(blockedMap.status, 400);
  assert.match(await errOf(blockedMap), /protected gate/);
  const blockedFlag = await propose('convprot', { kind: 'set_skill_enabled', args: { skillId: 'locked', enabled: false } });
  assert.equal(blockedFlag.status, 400);
  assert.match(await errOf(blockedFlag), /protected gate/);

  // Mutation check — the guard keys on PROTECTION, not on the id/fixture. Flip the blocking gate to
  // advisory and clear the protected flag; the identical proposals now succeed (pending under autoConfirm).
  // Unprotecting rides the wave-2 retype gate: the operator PUT must carry the exact confirmName.
  assert.equal((await putSkill('guard', { name: 'Guard', description: 'd', body: 'b', gate: { mode: 'advisory' }, confirmName: 'Guard' })).status, 200);
  assert.equal((await putSkill('locked', { name: 'Locked', description: 'd', body: 'b', protected: false, confirmName: 'Locked' })).status, 200);
  const okGate = await propose('convprot2', { kind: 'set_skill_enabled', args: { skillId: 'guard', enabled: false } });
  assert.equal(okGate.status, 200);
  assert.equal(((await okGate.json()) as Record<string, unknown>).status, 'pending');
  const okFlag = await propose('convprot2', { kind: 'set_skill_enabled', args: { skillId: 'locked', enabled: false } });
  assert.equal(okFlag.status, 200);
  assert.equal(((await okFlag.json()) as Record<string, unknown>).status, 'pending');
});

test('confirm executes a set_skill_enabled toggle; version + contentHash are untouched by the flip', { skip }, async () => {
  const before = await getSkill('gamma');
  assert.equal(before?.enabled, true);
  const r = await propose('convrun', { kind: 'set_skill_enabled', args: { skillId: 'gamma', enabled: false } });
  const p = (await r.json()) as { id: string; status: string };
  assert.equal(p.status, 'pending');
  const done = await confirm(p.id);
  assert.equal(done.status, 200);
  assert.equal(((await done.json()) as Record<string, unknown>).status, 'executed');
  const after = await getSkill('gamma');
  assert.equal(after?.enabled, false, 'the toggle executed via the executor inject');
  assert.equal(after?.version, before?.version, 'enabled is selection — version is not bumped');
  assert.equal(after?.contentHash, before?.contentHash, 'enabled is excluded from the content hash');
});

test('the narrow POST /api/skills/:id/enabled flips only enabled and fires the {t:\'skills\'} SSE frame', { skip }, async () => {
  const before = await getSkill('eps');
  assert.equal(before?.enabled, true);
  // Subscribe to the event stream, then trigger the toggle and look for the skills frame.
  const controller = new AbortController();
  const streamRes = await fetch(`${base}/api/stream?token=${encodeURIComponent(token)}`, { signal: controller.signal });
  assert.ok(streamRes.body, 'the SSE stream opened');
  const reader = streamRes.body.getReader();
  const dec = new TextDecoder();
  const deadline = setTimeout(() => controller.abort(), 4000);
  await new Promise((r) => setTimeout(r, 150)); // let the subscription land before mutating

  const toggle = await setEnabledRoute('eps', false);
  assert.equal(toggle.status, 200);
  const rec = (await toggle.json()) as Record<string, unknown>;
  assert.equal(rec.enabled, false, 'the route returns the flipped record');
  assert.equal(rec.version, before?.version, 'version untouched');
  assert.equal(rec.contentHash, before?.contentHash, 'contentHash untouched');

  let seenFrame = false;
  let buf = '';
  try {
    while (!seenFrame) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('"t":"skills"')) seenFrame = true;
    }
  } catch {
    /* aborted on the deadline */
  }
  clearTimeout(deadline);
  controller.abort();
  assert.equal(seenFrame, true, 'the toggle broadcast a {t:\'skills\'} frame to open panels');
  assert.equal((await getSkill('eps'))?.enabled, false);
});

test('drift: a skill toggled behind the card voids the confirm (409), and executor never runs', { skip }, async () => {
  // Ensure beta starts enabled so the proposed enabled:false baselines currentEnabled = 1.
  await setEnabledRoute('beta', true);
  const r = await propose('convdrift', { kind: 'set_skill_enabled', args: { skillId: 'beta', enabled: false } });
  const p = (await r.json()) as { id: string };
  // Flip beta behind the card via the direct route — re-enrich now baselines 0, not 1.
  assert.equal((await setEnabledRoute('beta', false)).status, 200);
  const drifted = await confirm(p.id);
  assert.equal(drifted.status, 409, 'a drifted enabled baseline aborts the confirm');
  assert.match(await errOf(drifted), /changed since proposed/);
});

test('drift: an operator body-edit (contentHash) between propose and confirm voids the card', { skip }, async () => {
  const r = await propose('convdrift2', { kind: 'set_skill_enabled', args: { skillId: 'delta', enabled: false } });
  const p = (await r.json()) as { id: string };
  // Edit delta's body — contentHash changes, so the denorm baseline no longer matches.
  assert.equal((await putSkill('delta', { name: 'Delta', description: 'd', body: 'b-EDITED' })).status, 200);
  const drifted = await confirm(p.id);
  assert.equal(drifted.status, 409);
  assert.match(await errOf(drifted), /changed since proposed/);
});

test('scoped-token belt: the assistant token is 403 on every mutating skill route, 200 on the reads', { skip }, async () => {
  const assistantToken = readFileSync(join(home, 'secrets', 'mcptok-assistant'), 'utf8').trim();
  const asAssistant = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'X-Tower-Token': assistantToken, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  // Mutating routes: refused (deliberately absent from ASSISTANT_ACCEPT).
  assert.equal((await asAssistant('POST', '/api/skills', { name: 'x', description: 'd', body: 'b' })).status, 403);
  assert.equal((await asAssistant('PUT', '/api/skills/alpha', { name: 'x', description: 'd', body: 'b' })).status, 403);
  assert.equal((await asAssistant('DELETE', '/api/skills/alpha')).status, 403);
  assert.equal((await asAssistant('POST', '/api/skills/alpha/enabled', { enabled: false })).status, 403);
  assert.equal((await asAssistant('PUT', '/api/projects/pa/skills', { enable: { alpha: true } })).status, 403);
  // Read routes: permitted (the three list_skills GET lines).
  assert.equal((await asAssistant('GET', '/api/skills')).status, 200);
  assert.equal((await asAssistant('GET', '/api/skill-bundles')).status, 200);
  assert.equal((await asAssistant('GET', '/api/projects/pa/skills')).status, 200);
  // A non-control token (e.g. a terminal hook token) is 401 everywhere — the TOKEN_EXEMPT negative space.
  const bogus = fetch(`${base}/api/skills`, { method: 'GET', headers: { 'X-Tower-Token': 'not-a-real-token' } });
  assert.equal((await bogus).status, 401);
  // alpha survived every refused mutation above.
  assert.equal((await getSkill('alpha'))?.enabled, true);
});

test('set_project_skills: the protected refusal is COMPLETE against a REPLACE that drops a per-project protected skill by omission', { skip }, async () => {
  // A protected skill effective for a project ONLY via an override: scope:'project' keeps it OUT of the
  // global baseline (rule 1 needs scope:'global'), so it is effective solely because the overlay selects it.
  // enabled MUST be true — the library master-switch filter drops an enabled:false skill from EVERY tier, so
  // one could never be effective at all. This is the case the explicit enable:false refusal misses.
  await postSkill({ id: 'scopedprot', name: 'Scoped Prot', description: 'd', body: 'b', scope: 'project', enabled: true, protected: true });
  const bp = (
    (await (
      await fetch(`${base}/api/skill-bundles`, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ name: 'BP', skillIds: ['scopedprot'] }) })
    ).json()) as { id: string }
  ).id;
  // The operator's own session-token PUT makes scopedprot effective for pa via an explicit override.
  assert.equal(
    (await fetch(`${base}/api/projects/pa/skills`, { method: 'PUT', headers: sessionHeaders, body: JSON.stringify({ enable: { scopedprot: true } }) })).status,
    200,
  );

  // A REPLACE that OMITS scopedprot (names only alpha) would drop it from the effective set → refused at propose.
  const omit = await propose('convrepl', { kind: 'set_project_skills', args: { projectId: 'pa', enable: { alpha: true } } });
  assert.equal(omit.status, 400);
  assert.match(await errOf(omit), /remove protected skill/);
  // The bare {projectId} reset drops it too → refused (nothing named, still caught by the effective-set diff).
  const reset = await propose('convrepl', { kind: 'set_project_skills', args: { projectId: 'pa' } });
  assert.equal(reset.status, 400);
  assert.match(await errOf(reset), /remove protected skill/);

  // A proposal that KEEPS scopedprot effective (via a bundle that contains it) is allowed (pending).
  const keep = await propose('convrepl', { kind: 'set_project_skills', args: { projectId: 'pa', bundleId: bp } });
  assert.equal(keep.status, 200);
  assert.equal(((await keep.json()) as Record<string, unknown>).status, 'pending');

  // Hygiene: restore pa's overlay to empty (nothing above executed, but keep the scratch tree honest).
  await fetch(`${base}/api/projects/pa/skills`, { method: 'PUT', headers: sessionHeaders, body: JSON.stringify({}) });
});

test.after(() => {
  try {
    tower.server?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  rmSync(home, { recursive: true, force: true });
});
