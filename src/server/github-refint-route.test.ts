// Referential integrity: DELETE /api/identities/:id clears any project defaultIdentityId that referenced
// the deleted identity, in the same request — so a project can never be left pointing at a ghost identity
// (which would 400 every createTerminal in it). Driven against a REAL Tower over a process boundary: the
// cleanup lives inside the route, so replicating it in-process would guard nothing.
//
// No tmux/terminals needed — the invariant is over projects + identities only. A scratch CT_HOME on a
// scratch port; the operator's Tower and ~/.ct are untouched. A DEAD child Tower or one that binds
// without serving fails loudly (a stolen port lands as a dead child); an alive-but-slow boot skips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, spawnTower } from './tower-fixture.js';

const home = mkdtempSync(join(tmpdir(), 'ct-github-refint-'));
const PORT = await freePort();
process.env.CT_HOME = home;
process.env.CT_PORT = String(PORT);

const now = new Date().toISOString();
mkdirSync(join(home, 'config'), { recursive: true });
const write = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));
const identity = (id: string) => ({ id, label: id, gitName: 'N', gitEmail: `${id}@example.com`, hasCredential: false, createdAt: now });
const project = (id: string, defaultIdentityId?: string) => ({
  id, name: id, repoPath: home, scaffoldMode: 'zero-footprint', ...(defaultIdentityId ? { defaultIdentityId } : {}), createdAt: now,
});

// pa, pb → idX ; pc → idY. Deleting idX must clear pa+pb and leave pc alone.
// pd is a spare with no default, exercised by the POST /api/projects/:id/github route test below
// (kept off pa/pb/pc so it can't disturb the delete test's invariants).
write('identities.json', [identity('idX'), identity('idY')]);
write('projects.json', [project('pa', 'idX'), project('pb', 'idX'), project('pc', 'idY'), project('pd')]);

const base = `http://127.0.0.1:${PORT}`;

// Spawn + identity-gated readiness live in tower-fixture.ts: "ready" means OUR Tower (the startup
// line carrying THIS file's CT_HOME) answered /api/session. A DEAD child (how a stolen port lands)
// or a bound-but-unresponsive Tower throws loudly; only an alive-but-slow boot yields a skip.
const tower = await spawnTower(home, PORT);
const token = tower.sessionToken;
const skip = tower.skip ?? false;

async function projects(): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${base}/api/projects`, { headers: { 'X-Tower-Token': token } });
  return (await r.json()) as Record<string, unknown>[];
}
const defaultOf = (list: Record<string, unknown>[], id: string): unknown => list.find((p) => p.id === id)?.defaultIdentityId;

test('DELETE /api/identities/:id clears referencing project defaults and leaves others alone', { skip }, async () => {
  // Before: pa+pb → idX, pc → idY.
  const before = await projects();
  assert.equal(defaultOf(before, 'pa'), 'idX');
  assert.equal(defaultOf(before, 'pb'), 'idX');
  assert.equal(defaultOf(before, 'pc'), 'idY');

  const del = await fetch(`${base}/api/identities/idX`, { method: 'DELETE', headers: { 'X-Tower-Token': token } });
  assert.equal(del.status, 200);

  // After: pa+pb cleared (the key is gone, not null), pc untouched.
  const after = await projects();
  assert.equal(defaultOf(after, 'pa'), undefined, 'pa default cleared');
  assert.equal(defaultOf(after, 'pb'), undefined, 'pb default cleared');
  assert.ok(!('defaultIdentityId' in (after.find((p) => p.id === 'pa') ?? {})), 'the key is dropped, not left as null');
  assert.equal(defaultOf(after, 'pc'), 'idY', 'pc (referencing a different identity) is untouched');

  // The identity itself is gone; idY remains.
  const ids = (await (await fetch(`${base}/api/identities`, { headers: { 'X-Tower-Token': token } })).json()) as Record<string, unknown>[];
  assert.equal(ids.some((i) => i.id === 'idX'), false);
  assert.equal(ids.some((i) => i.id === 'idY'), true);

  // Idempotent: deleting an unknown id still returns ok.
  const again = await fetch(`${base}/api/identities/idX`, { method: 'DELETE', headers: { 'X-Tower-Token': token } });
  assert.equal(again.status, 200);
});

// The feature's headline mutation endpoint: set/clear a project's repo URL + default identity, and the
// create route's new fields. Field-present partial semantics; null clears; validation errors surface.
const github = (id: string, body: unknown) =>
  fetch(`${base}/api/projects/${id}/github`, {
    method: 'POST',
    headers: { 'X-Tower-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('POST /api/projects/:id/github sets, clears, and validates', { skip }, async () => {
  // Set both fields on the spare project (idY still exists — the delete test only removes idX).
  const set = await github('pd', { repoUrl: 'https://github.com/example-owner/example-project.git', defaultIdentityId: 'idY' });
  assert.equal(set.status, 200);
  let pd = (await projects()).find((p) => p.id === 'pd') ?? {};
  assert.equal(pd.repoUrl, 'https://github.com/example-owner/example-project.git', 'repoUrl persisted verbatim');
  assert.equal(pd.defaultIdentityId, 'idY', 'identity bound');

  // Field-present partial: clear repoUrl via null, leave the identity untouched (key dropped, not null).
  assert.equal((await github('pd', { repoUrl: null })).status, 200);
  pd = (await projects()).find((p) => p.id === 'pd') ?? {};
  assert.ok(!('repoUrl' in pd), 'repoUrl key dropped on clear');
  assert.equal(pd.defaultIdentityId, 'idY', 'identity retained when only repoUrl was sent');

  // Validation: unknown identity, malformed URL → 400; unknown project → 404; junk bodies → 400.
  assert.equal((await github('pd', { defaultIdentityId: 'ghost' })).status, 400, 'unknown identity → 400');
  assert.equal((await github('pd', { repoUrl: 'http://github.com/o/r' })).status, 400, 'non-https repo URL → 400');
  assert.equal((await github('pd', { repoUrl: 'https://gitlab.com/o/r' })).status, 400, 'non-GitHub host → 400');
  assert.equal((await github('nope', { repoUrl: null })).status, 404, 'unknown project → 404');
  assert.equal((await github('pd', {})).status, 400, 'neither key → 400');
  assert.equal(
    (await fetch(`${base}/api/projects/pd/github`, { method: 'POST', headers: { 'X-Tower-Token': token, 'Content-Type': 'application/json' }, body: '"not-an-object"' })).status,
    400,
    'non-object body → 400',
  );
});

test('POST /api/projects accepts repoUrl + defaultIdentityId and persists them', { skip }, async () => {
  const res = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'X-Tower-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'created-with-gh', repoPath: home, repoUrl: 'https://github.com/example-owner/example-project', defaultIdentityId: 'idY' }),
  });
  assert.equal(res.status, 200, 'create with GitHub fields succeeds');
  const created = (await res.json()) as Record<string, unknown>;
  assert.equal(created.repoUrl, 'https://github.com/example-owner/example-project', 'repoUrl on the created record');
  assert.equal(created.defaultIdentityId, 'idY', 'identity on the created record');
  // Re-GET proves it round-trips through the store (the strip-trap is honored on a real load path).
  const persisted = (await projects()).find((p) => p.id === created.id) ?? {};
  assert.equal(persisted.repoUrl, 'https://github.com/example-owner/example-project', 'repoUrl survives reload');
  assert.equal(persisted.defaultIdentityId, 'idY', 'identity survives reload');

  // An unknown identity at create time is rejected, not silently dropped.
  const bad = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'X-Tower-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'created-bad-id', repoPath: home, defaultIdentityId: 'ghost' }),
  });
  assert.equal(bad.status, 400, 'unknown identity at create → 400');
});

test.after(() => {
  try {
    tower.server?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  rmSync(home, { recursive: true, force: true });
});
