// The /api/skills routes (SPEC-SKILLS), driven against a REAL Tower over a process boundary the way a
// client is. What has to hold: the routes are SESSION-token-only (nothing was added to TOKEN_EXEMPT or
// ASSISTANT_ACCEPT), so no token ⇒ 401, the scoped assistant token ⇒ 403, and a garbage token ⇒ 401 on
// every shape (including POST /api/skills/import, whose guard fires before the handler); with the session
// token, GET list is META-only (no body), GET :id includes it, an unknown id is 404, an invalid POST is
// 400 {error}, DELETE is idempotent, and each mutation writes an audit line. A scratch CT_HOME on a
// scratch port; the operator's Tower and ~/.ct are untouched. A DEAD child Tower or one that binds
// without serving fails loudly (a stolen port lands as a dead child); an alive-but-slow boot skips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, spawnTower } from './tower-fixture.js';

const home = mkdtempSync(join(tmpdir(), 'ct-skills-routes-'));
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

const assistantToken = existsSync(join(home, 'secrets', 'mcptok-assistant'))
  ? readFileSync(join(home, 'secrets', 'mcptok-assistant'), 'utf8').trim()
  : '';

type Res = { status: number; body: Record<string, unknown> };
async function call(method: string, path: string, tok: string | undefined, payload?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(tok ? { 'X-Tower-Token': tok } : {}),
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, body };
}

// Every route shape, as (method, path). Import is included: its guard fires before the handler, so the
// auth assertions never actually run the importer against the operator's home.
const ROUTES: [string, string][] = [
  ['GET', '/api/skills'],
  ['GET', '/api/skills/anything'],
  ['POST', '/api/skills'],
  ['PUT', '/api/skills/anything'],
  ['DELETE', '/api/skills/anything'],
  ['POST', '/api/skills/import'],
  // SPEC-SKILLS Phase 5b wave 2 — the autonomy-clearance flip is session-token only, like every write,
  // and so are the history reads (they carry full prior bodies) + rollback (it re-publishes content).
  ['POST', '/api/skills/anything/autonomy-cleared'],
  ['GET', '/api/skills/anything/history'],
  ['GET', '/api/skills/anything/history/1'],
  ['POST', '/api/skills/anything/rollback'],
  // SPEC-SKILLS Phase 3 — bundles + per-project selection ride the SAME session-token gate.
  ['GET', '/api/skill-bundles'],
  ['POST', '/api/skill-bundles'],
  ['PUT', '/api/skill-bundles/anything'],
  ['DELETE', '/api/skill-bundles/anything'],
  ['GET', '/api/projects/anything/skills'],
  ['PUT', '/api/projects/anything/skills'],
];

test('every /api/skills route is session-token only', { skip }, async (t) => {
  await t.test('no token ⇒ 401 on every route', async () => {
    for (const [m, p] of ROUTES) {
      const r = await call(m, p, undefined, m === 'GET' || m === 'DELETE' ? undefined : {});
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  });
  await t.test('the scoped assistant token: 200/404 on the three list_skills reads, 403 on everything else', { skip: assistantToken ? false : 'no assistant token file' }, async () => {
    // SPEC-SKILLS Phase 5 — the read grounding for set_skill_enabled / set_project_skills is scoped-
    // readable; the MUTATING routes (and the body-carrying GET /api/skills/:id) stay refused. A 404 on the
    // fake-project read proves the guard PERMITTED the route and the handler ran (a 403 would mean refused).
    const ASSISTANT_EXPECTED = new Map<string, number>([
      ['GET /api/skills', 200],
      ['GET /api/skill-bundles', 200],
      ['GET /api/projects/anything/skills', 404],
    ]);
    for (const [m, p] of ROUTES) {
      const r = await call(m, p, assistantToken, m === 'GET' || m === 'DELETE' ? undefined : {});
      assert.equal(r.status, ASSISTANT_EXPECTED.get(`${m} ${p}`) ?? 403, `${m} ${p}`);
    }
  });
  await t.test('a garbage token ⇒ 401 on every route', async () => {
    for (const [m, p] of ROUTES) {
      const r = await call(m, p, 'not-a-real-token', m === 'GET' || m === 'DELETE' ? undefined : {});
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  });
});

test('CRUD with the session token: list is META-only, :id carries the body, guards return 4xx', { skip }, async () => {
  // Create.
  const created = await call('POST', '/api/skills', token, {
    name: 'Route Skill', description: 'created via the route', body: '# hi\nbody\n', tags: ['x'],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id as string;
  assert.ok(id, 'the created skill has an id');

  // GET list excludes the body (a bounded payload).
  const list = await call('GET', '/api/skills', token);
  assert.equal(list.status, 200);
  const rows = list.body as unknown as Record<string, unknown>[];
  const row = rows.find((r) => r.id === id)!;
  assert.ok(row, 'the skill is in the list');
  assert.ok(!('body' in row), 'the list row carries no body');

  // GET :id includes the body.
  const detail = await call('GET', `/api/skills/${id}`, token);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.body, '# hi\nbody\n', 'the detail carries the verbatim body');

  // Unknown id ⇒ 404.
  const missing = await call('GET', '/api/skills/does-not-exist', token);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'unknown skill');

  // Invalid POST (no name/description) ⇒ 400 {error}.
  const bad = await call('POST', '/api/skills', token, { body: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.body.error, 'string');

  // PUT patches at the path id (authoritative).
  const put = await call('PUT', `/api/skills/${id}`, token, { name: 'Route Skill', description: 'edited', body: 'v2\n' });
  assert.equal(put.status, 200);
  assert.equal(put.body.version, 2, 'the patch bumped the version');

  // DELETE is idempotent.
  assert.equal((await call('DELETE', `/api/skills/${id}`, token)).status, 200);
  const second = await call('DELETE', `/api/skills/${id}`, token);
  assert.equal(second.status, 200);
  assert.equal(second.body.ok, true, 'a repeat delete is a 200 no-op');
  assert.equal((await call('GET', `/api/skills/${id}`, token)).status, 404, 'the skill is gone');

  // Each mutation wrote an audit line.
  const auditLog = readFileSync(join(home, 'audit.log'), 'utf8');
  assert.ok(auditLog.includes('skill.upsert'), 'an upsert audit line was written');
  assert.ok(auditLog.includes('skill.delete'), 'a delete audit line was written');
});

test('SPEC-SKILLS Phase 3 — DELETE /api/skills/:id refuses while referenced, and prunes an enable:false leftover', { skip }, async () => {
  // A skill, a bundle that contains it, and a project that enables it — the two affirmative-reference kinds.
  const sk = (await call('POST', '/api/skills', token, { name: 'Ref Skill', description: 'referenced', body: 'x\n' })).body.id as string;
  const bid = (await call('POST', '/api/skill-bundles', token, { name: 'Ref Pack', skillIds: [sk] })).body.id as string;

  // 1. Bundled → 409 naming the bundle.
  const bundled = await call('DELETE', `/api/skills/${sk}`, token);
  assert.equal(bundled.status, 409, JSON.stringify(bundled.body));
  assert.ok(Array.isArray(bundled.body.referencedBy), 'referencedBy is a list');
  assert.ok((bundled.body.referencedBy as string[]).some((r) => r.includes('Ref Pack')), 'referencedBy names the bundle');
  assert.equal((await call('GET', `/api/skills/${sk}`, token)).status, 200, 'the refused delete left the skill in place');

  // 2. Unassign the bundle, then a project enable:true → still 409, now naming the project.
  assert.equal((await call('DELETE', `/api/skill-bundles/${bid}`, token)).status, 200);
  await call('PUT', '/api/projects/sandbox/skills', token, { enable: { [sk]: true } });
  const enabled = await call('DELETE', `/api/skills/${sk}`, token);
  assert.equal(enabled.status, 409, JSON.stringify(enabled.body));
  assert.ok((enabled.body.referencedBy as string[]).some((r) => r.includes('sandbox')), 'referencedBy names the project');

  // 3. enable:false is NOT an affirmative reference → the delete succeeds AND the leftover is pruned.
  await call('PUT', '/api/projects/sandbox/skills', token, { enable: { [sk]: false } });
  assert.equal((await call('DELETE', `/api/skills/${sk}`, token)).status, 200, 'enable:false does not block the delete');
  assert.equal((await call('GET', `/api/skills/${sk}`, token)).status, 404, 'the skill is really gone');
  const skillsJson = JSON.parse(readFileSync(join(home, 'config', 'skills.json'), 'utf8')) as { id: string }[];
  assert.ok(!skillsJson.some((s) => s.id === sk), 'the skill is gone from skills.json');
  const sel = JSON.parse(readFileSync(join(home, 'config', 'skill-selection.json'), 'utf8')) as { projects?: Record<string, { enable?: Record<string, boolean> }> };
  assert.ok(!(sel.projects?.sandbox?.enable && sk in sel.projects.sandbox.enable), 'the enable:false leftover was pruned from the selection file');
});

test('SPEC-SKILLS Phase 3 — PUT /api/projects/:id/skills round-trips the effective view with sources + delivered flags', { skip }, async () => {
  const gs = (await call('POST', '/api/skills', token, { name: 'Global One', description: 'g', body: 'g\n' })).body.id as string;
  const gs2 = (await call('POST', '/api/skills', token, { name: 'Global Two', description: 'g', body: 'g\n' })).body.id as string;
  const ps = (await call('POST', '/api/skills', token, { name: 'Project One', description: 'p', body: 'p\n', scope: 'project' })).body.id as string;
  // A user-only project skill has NO delivery surface at all: not the configDir (non-global), not the
  // sortie brief (pane text cannot enforce "never self-invoke") — the one still-undelivered class.
  const pn = (await call('POST', '/api/skills', token, {
    name: 'Project NeverInvoke', description: 'p', body: 'p\n', scope: 'project', invocation: { user: true, model: 'never' },
  })).body.id as string;
  const bid = (await call('POST', '/api/skill-bundles', token, { name: 'View Pack', skillIds: [gs, ps, pn] })).body.id as string;

  const put = await call('PUT', '/api/projects/sandbox/skills', token, { bundleId: bid });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const eff = put.body.effective as { id: string; source: string; delivered: boolean; scope: string; providers: string[] }[];
  const byId = new Map(eff.map((e) => [e.id, e]));

  // A project-scope bundle member: source 'bundle', scope 'project', and DELIVERED — via the
  // per-project sortie brief baked into a loop's task at create (SPEC-SKILLS per-project delivery).
  assert.equal(byId.get(ps)?.source, 'bundle', 'the project-scope skill is sourced from the bundle');
  assert.equal(byId.get(ps)?.scope, 'project');
  assert.equal(byId.get(ps)?.delivered, true, 'a provider-reachable project-scope selection is delivered via the sortie brief');
  // …but a user-only ('never') project skill stays undelivered: no enforcement surface anywhere.
  assert.equal(byId.get(pn)?.delivered, false, 'a user-only project skill has no delivery channel');
  // A global skill NOT in the bundle stays source 'global' and IS delivered.
  assert.equal(byId.get(gs2)?.source, 'global', 'a global baseline skill is source:global');
  assert.equal(byId.get(gs2)?.delivered, true, 'the global baseline is delivered today');
  // A global∩bundle member upgrades provenance to bundle (the most-specific-tier rule) BUT is still
  // delivered via the global baseline — `delivered` reflects delivery eligibility, not `source`.
  assert.equal(byId.get(gs)?.source, 'bundle', 'a global skill also in the bundle upgrades to source:bundle');
  assert.equal(byId.get(gs)?.delivered, true, 'a global skill in a bundle is still delivered today (delivered ≠ source)');

  // Unknown project ⇒ 404.
  assert.equal((await call('GET', '/api/projects/does-not-exist/skills', token)).status, 404);

  // Clean up the selection so it doesn't leak into other assertions.
  await call('PUT', '/api/projects/sandbox/skills', token, {});
});

// ---- SPEC-SKILLS Phase 5b wave 2 — the selection-side retype gate ----
// The record-mutating /api/skills routes already demand a retyped name to change a PROTECTED skill;
// these prove the SELECTION routes hold the same line: an overlay or bundle edit that would drop a
// protected skill from a project's EFFECTIVE set is 409 until the dropped name(s) — name-sorted,
// ', '-joined — are retyped, a change dropping nothing protected needs no retype, and confirmName
// never reaches the persisted selection bytes.

const selectionBytes = (): string => readFileSync(join(home, 'config', 'skill-selection.json'), 'utf8');

test('selection retype gate: a project overlay dropping protected skill(s) demands the retyped name(s)', { skip }, async () => {
  await call('POST', '/api/skills', token, { id: 'selprot', name: 'Sel Prot', description: 'd', body: 'x\n', gate: { mode: 'blocking' } });
  await call('POST', '/api/skills', token, { id: 'selprot2', name: 'Another Prot', description: 'd', body: 'x\n', protected: true });
  await call('POST', '/api/skills', token, { id: 'selplain', name: 'Sel Plain', description: 'd', body: 'x\n' });

  // 1. Dropping a protected global from the effective set without confirmName → 409, nothing written.
  const bare = await call('PUT', '/api/projects/sandbox/skills', token, { enable: { selprot: false } });
  assert.equal(bare.status, 409, JSON.stringify(bare.body));
  assert.match(String(bare.body.error), /exactly to confirm/);
  assert.deepEqual(bare.body.droppedProtected, ['Sel Prot']);
  const view0 = await call('GET', '/api/projects/sandbox/skills', token);
  assert.ok((view0.body.effective as { id: string }[]).some((e) => e.id === 'selprot'), 'the refusal left the skill effective');
  assert.equal('enable' in view0.body, false, 'no overlay landed');

  // 2. A coercible wire value cannot slip past: 'no' PERSISTS as false (a real drop), so it 409s too.
  const coerced = await call('PUT', '/api/projects/sandbox/skills', token, { enable: { selprot: 'no' } });
  assert.equal(coerced.status, 409, 'the gate diffs the SANITIZED overlay, not the raw wire value');

  // 3. A near-miss confirmName → 409; the EXACT name → 200; the confirmed drop is real and wire-only.
  assert.equal((await call('PUT', '/api/projects/sandbox/skills', token, { enable: { selprot: false }, confirmName: 'sel prot' })).status, 409);
  const ok = await call('PUT', '/api/projects/sandbox/skills', token, { enable: { selprot: false }, confirmName: 'Sel Prot' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(!(ok.body.effective as { id: string }[]).some((e) => e.id === 'selprot'), 'the confirmed drop took effect');
  assert.equal(selectionBytes().includes('confirmName'), false, 'confirmName never reaches the selection file');

  // 4. Dropping BOTH protected skills demands the name-sorted joined string — a single name is refused.
  assert.equal((await call('PUT', '/api/projects/sandbox/skills', token, {})).status, 200, 'clearing the overlay only ADDS back — ungated');
  const multi = await call('PUT', '/api/projects/sandbox/skills', token, { enable: { selprot: false, selprot2: false } });
  assert.equal(multi.status, 409);
  assert.deepEqual(multi.body.droppedProtected, ['Another Prot', 'Sel Prot'], 'both flavors listed, name-sorted');
  assert.equal(
    (await call('PUT', '/api/projects/sandbox/skills', token, { enable: { selprot: false, selprot2: false }, confirmName: 'Sel Prot' })).status,
    409,
    'one name cannot confirm a two-skill drop',
  );
  const multiOk = await call('PUT', '/api/projects/sandbox/skills', token, {
    enable: { selprot: false, selprot2: false },
    confirmName: 'Another Prot, Sel Prot',
  });
  assert.equal(multiOk.status, 200, JSON.stringify(multiOk.body));

  // 5. A change dropping only an UNPROTECTED skill needs no confirmName (the gate keys on protection).
  assert.equal((await call('PUT', '/api/projects/sandbox/skills', token, {})).status, 200);
  const plain = await call('PUT', '/api/projects/sandbox/skills', token, { enable: { selplain: false } });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));

  // Cleanup: inherit again (add-only), then delete the fixtures (protected deletes retype per W2b-style /api/skills gate).
  assert.equal((await call('PUT', '/api/projects/sandbox/skills', token, {})).status, 200);
  assert.equal((await call('DELETE', '/api/skills/selprot', token, { confirmName: 'Sel Prot' })).status, 200);
  assert.equal((await call('DELETE', '/api/skills/selprot2', token, { confirmName: 'Another Prot' })).status, 200);
  assert.equal((await call('DELETE', '/api/skills/selplain', token)).status, 200);
});

test('selection retype gate: a bundle edit dropping a protected skill from a selecting project 409s; membership alone does not gate', { skip }, async () => {
  await call('POST', '/api/skills', token, { id: 'bgprot', name: 'Bundle Gate Prot', description: 'd', body: 'x\n', scope: 'project', gate: { mode: 'blocking' } });
  await call('POST', '/api/skills', token, { id: 'bglobal', name: 'Bundle Global Prot', description: 'd', body: 'x\n', gate: { mode: 'blocking' } });
  const bid = (await call('POST', '/api/skill-bundles', token, { name: 'Gate Pack', skillIds: ['bgprot', 'bglobal'] })).body.id as string;

  // While NO project selects the bundle, removing the protected member changes no effective set — ungated.
  const unselected = await call('PUT', `/api/skill-bundles/${bid}`, token, { name: 'Gate Pack', skillIds: ['bglobal'] });
  assert.equal(unselected.status, 200, JSON.stringify(unselected.body));
  // Put it back and select the bundle from sandbox (an ADD — no retype needed on the project side).
  assert.equal((await call('PUT', `/api/skill-bundles/${bid}`, token, { name: 'Gate Pack', skillIds: ['bgprot', 'bglobal'] })).status, 200);
  assert.equal((await call('PUT', '/api/projects/sandbox/skills', token, { bundleId: bid })).status, 200);

  // Removing the project-scope protected member now drops it from sandbox's effective set → 409.
  const bare = await call('PUT', `/api/skill-bundles/${bid}`, token, { name: 'Gate Pack', skillIds: ['bglobal'] });
  assert.equal(bare.status, 409, JSON.stringify(bare.body));
  assert.match(String(bare.body.error), /exactly to confirm/);
  assert.deepEqual(bare.body.droppedProtected, ['Bundle Gate Prot']);
  assert.ok((bare.body.affectedProjects as string[]).some((p) => p.includes('sandbox')), 'the 409 names the affected project');
  const still = await call('GET', '/api/projects/sandbox/skills', token);
  assert.ok((still.body.effective as { id: string }[]).some((e) => e.id === 'bgprot'), 'the refused edit left the skill effective');

  // The retyped name unlocks it, and confirmName stays off the persisted bytes.
  const ok = await call('PUT', `/api/skill-bundles/${bid}`, token, { name: 'Gate Pack', skillIds: ['bglobal'], confirmName: 'Bundle Gate Prot' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(selectionBytes().includes('confirmName'), false, 'confirmName never reaches the selection file');

  // Removing the GLOBAL protected member is ungated — it stays effective via the global baseline
  // (the gate keys on the EFFECTIVE set, not on bundle membership).
  const globalDrop = await call('PUT', `/api/skill-bundles/${bid}`, token, { name: 'Gate Pack', skillIds: [] });
  assert.equal(globalDrop.status, 200, JSON.stringify(globalDrop.body));

  // Cleanup so later assertions never inherit this selection.
  assert.equal((await call('PUT', '/api/projects/sandbox/skills', token, {})).status, 200);
  assert.equal((await call('DELETE', `/api/skill-bundles/${bid}`, token)).status, 200);
  assert.equal((await call('DELETE', '/api/skills/bgprot', token, { confirmName: 'Bundle Gate Prot' })).status, 200);
  assert.equal((await call('DELETE', '/api/skills/bglobal', token, { confirmName: 'Bundle Global Prot' })).status, 200);
});

function cleanup(): void {
  try { tower.server?.kill('SIGKILL'); } catch { /* ignore */ }
  rmSync(home, { recursive: true, force: true });
}
process.on('exit', cleanup);
