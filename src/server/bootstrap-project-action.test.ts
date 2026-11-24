// bootstrap_project — the one-step proposable action that REGISTERS a bare folder AND runs the SAME
// SPEC-INITPUSH executeBootstrap init_project_repo uses, in one Confirm-gated action. Two layers:
//   - in-process unit asserts on the action catalog (validateAction strict parse + normalize / the
//     human-confirm carve-out / enrich's per-gate refusals + happy summary+denorm / the executor's
//     route mapping) — every gate is a plain function, exercised directly;
//   - route-level asserts against a REAL Tower over a process boundary: the front-door 400s, the
//     ATOMICITY contract (a refused/already-repo bootstrap registers NOTHING), the autoConfirm
//     carve-out staying pending, a confirm-time drift abort, and the scoped-token belt all live in
//     the routes, so replicating them in-process would guard nothing.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time, so the operator's real
// ~/.ct is never touched. OFFLINE-SAFE: anything that reaches executeBootstrap here uses only the
// hasCredential:false OR already-.git shapes (both refuse BEFORE the network ls-remote/push). The
// happy push + push-fail paths need a real empty remote and are covered in bootstrap.test.ts. By the
// same token the route's register-on-done upsert and the pre-upsert race re-check (server.ts) sit
// AFTER a network 'done' the route builds its own broker-backed deps for (no injection point), so they
// cannot be driven here without going online; the executeBootstrap 'done' outcome itself is proven in
// bootstrap.test.ts, and the route's thin done→upsert wrapper is a read-verified invariant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantAction } from '../shared/types.js';
import type { ActionLookups } from './assistant/actions.js';
import { freePort, spawnTower } from './tower-fixture.js';

const home = mkdtempSync(join(tmpdir(), 'ct-bootstrap-project-'));
process.env.CT_HOME = home;

// ---- in-process unit asserts on the action catalog (no server; paths.ts is frozen by CT_HOME above) ----

const { validateAction, requiresHumanConfirm, reasonForHumanConfirm, riskOf, enrich, makeProposalExecutor } =
  await import('./assistant/actions.js');

type BP = Extract<AssistantAction, { kind: 'bootstrap_project' }>;
const GH = 'https://github.com/o/r';

const stubLookups = (o: Partial<ActionLookups>): ActionLookups =>
  ({ getIdentity: () => undefined, projectPathConflict: () => undefined, ...o } as unknown as ActionLookups);

// One fixtures parent (a SIBLING of `home`, NOT under it — rooting fixtures under `home` would put them
// inside ~/.ct/paths.home, which the new zone gate now refuses). Removed wholesale in test.after so no
// fixture dir leaks into the OS tmpdir.
const fxRoot = mkdtempSync(join(tmpdir(), 'ct-bp-fxroot-'));
/** A fresh, existing, empty dir (no .git, not under a worktree, not under ~/.ct) — so enrich reaches its later gates. */
const realDir = (): string => mkdtempSync(join(fxRoot, 'd-'));
const bp = (over: Partial<BP> = {}): BP => ({ kind: 'bootstrap_project', name: 'demo', repoPath: '/abs', repoUrl: GH, defaultIdentityId: 'id1', ...over });

// T1 — validateAction: happy 4-field parse (normalize applied), reject each missing field, extra key, empty name.
test('bootstrap_project validateAction — strict 4-field parse, normalize, reject missing/extra/empty', () => {
  assert.deepEqual(
    validateAction({ kind: 'bootstrap_project', name: 'demo', repoPath: '/x//y/', repoUrl: GH, defaultIdentityId: 'id1' }),
    { kind: 'bootstrap_project', name: 'demo', repoPath: '/x/y', repoUrl: GH, defaultIdentityId: 'id1' },
  );
  assert.throws(() => validateAction({ kind: 'bootstrap_project', repoPath: '/x', repoUrl: GH, defaultIdentityId: 'id1' }), /invalid action/);
  assert.throws(() => validateAction({ kind: 'bootstrap_project', name: 'd', repoUrl: GH, defaultIdentityId: 'id1' }), /invalid action/);
  assert.throws(() => validateAction({ kind: 'bootstrap_project', name: 'd', repoPath: '/x', defaultIdentityId: 'id1' }), /invalid action/);
  assert.throws(() => validateAction({ kind: 'bootstrap_project', name: 'd', repoPath: '/x', repoUrl: GH }), /invalid action/);
  assert.throws(() => validateAction({ kind: 'bootstrap_project', name: 'd', repoPath: '/x', repoUrl: GH, defaultIdentityId: 'id1', extra: 1 }), /invalid action/);
  assert.throws(() => validateAction({ kind: 'bootstrap_project', name: '', repoPath: '/x', repoUrl: GH, defaultIdentityId: 'id1' }), /invalid action/);
});

// T2 — the always-human-confirm carve-out + high risk.
test('bootstrap_project — always-human-confirmed, non-empty reason, high risk', () => {
  const action = bp();
  assert.equal(requiresHumanConfirm(action), true);
  assert.notEqual(reasonForHumanConfirm(action), '');
  assert.equal(riskOf(action), 'high');
});

// T3 — enrich throws, one assert per gate.
test('bootstrap_project enrich — throws once per precondition gate', () => {
  // control-char name (rendersAsWritten runs first, before existsSync)
  assert.throws(() => enrich(bp({ name: 'de\u0000mo', repoPath: realDir() }), stubLookups({})), /render exactly as written/);
  // relative repoPath (normalizeRepoPath leaves it alone so it reaches the absolute-path gate)
  assert.throws(() => enrich(bp({ repoPath: 'relative/path' }), stubLookups({})), /must be an absolute path/);
  // nonexistent path
  assert.throws(() => enrich(bp({ repoPath: '/does/not/exist/ct-bp-xyz' }), stubLookups({})), /does not exist/);
  // inside a Tower-managed worktree (mkdir so realpath succeeds)
  const wt = join(realDir(), '.ct-worktrees', 'proj');
  mkdirSync(wt, { recursive: true });
  assert.throws(() => enrich(bp({ repoPath: wt }), stubLookups({})), /Tower-managed worktree/);
  // projectPathConflict: same / contains / inside
  assert.throws(
    () => enrich(bp({ repoPath: realDir() }), stubLookups({ projectPathConflict: () => ({ name: 'other', relation: 'same' }) })),
    /already registered/,
  );
  assert.throws(
    () => enrich(bp({ repoPath: realDir() }), stubLookups({ projectPathConflict: () => ({ name: 'other', relation: 'same' }) })),
    /init_project_repo/,
  );
  assert.throws(
    () => enrich(bp({ repoPath: realDir() }), stubLookups({ projectPathConflict: () => ({ name: 'other', relation: 'contains' }) })),
    /is inside project/,
  );
  assert.throws(
    () => enrich(bp({ repoPath: realDir() }), stubLookups({ projectPathConflict: () => ({ name: 'other', relation: 'inside' }) })),
    /contains project/,
  );
  // already a git repository (INVERTED from create_project)
  const withGit = realDir();
  mkdirSync(join(withGit, '.git'));
  assert.throws(() => enrich(bp({ repoPath: withGit }), stubLookups({})), /already a git repository/);
  assert.throws(() => enrich(bp({ repoPath: withGit }), stubLookups({})), /create_project/);
  // bad repoUrl
  assert.throws(() => enrich(bp({ repoPath: realDir(), repoUrl: 'notaurl' }), stubLookups({})), /valid URL/);
  // unknown identity
  assert.throws(() => enrich(bp({ repoPath: realDir() }), stubLookups({ getIdentity: () => undefined })), /unknown identity/);
  // identity has no push token
  assert.throws(
    () => enrich(bp({ repoPath: realDir() }), stubLookups({ getIdentity: () => ({ label: 'Bot', hasCredential: false }) })),
    /no push token/,
  );
});

// T3b — enrich refuses the Tower's own ~/.ct data directory (holds credential files the by-name secret
// scan misses). Uses a real dir under `home` (= CT_HOME = paths.home) so the zone gate fires.
test('bootstrap_project enrich — refuses a path inside the Tower data dir (~/.ct)', () => {
  const underHome = join(home, 'underct-enrich');
  mkdirSync(underHome, { recursive: true });
  assert.throws(() => enrich(bp({ repoPath: underHome }), stubLookups({})), /Tower's own data directory/);
});

// T4 — happy enrich: summary carries name+path+url+label; denorm is the exact drift baseline.
test('bootstrap_project enrich — happy summary + denorm', () => {
  const dir = realDir();
  const out = enrich(bp({ repoPath: dir }), stubLookups({ getIdentity: () => ({ label: 'Bot', hasCredential: true }) }));
  assert.ok(out.summary.includes('demo'));
  assert.ok(out.summary.includes(dir));
  assert.ok(out.summary.includes(GH));
  assert.ok(out.summary.includes('Bot'));
  assert.deepEqual(out.denorm, { identityLabel: 'Bot', identityHasCredential: 1 });
});

// T5 — executor route mapping: POST /api/projects/bootstrap with the 4-field payload; NO acceptWarnings.
test('bootstrap_project executor — POST /api/projects/bootstrap, 4-field payload, no acceptWarnings', async () => {
  let captured: Record<string, unknown> | undefined;
  const fakeApp = {
    inject: async (opts: Record<string, unknown>) => {
      captured = opts;
      return { statusCode: 200, json: () => ({ ok: true }), body: '' };
    },
  } as unknown as Parameters<typeof makeProposalExecutor>[0];
  const exec = makeProposalExecutor(fakeApp, 'sess-token', 4870);
  await exec(bp({ name: 'proj', repoPath: '/srv/thing' }));
  assert.equal(captured?.method, 'POST');
  assert.equal(captured?.url, '/api/projects/bootstrap');
  assert.deepEqual(captured?.payload, { name: 'proj', repoPath: '/srv/thing', repoUrl: GH, defaultIdentityId: 'id1' });
  assert.equal('acceptWarnings' in ((captured?.payload as Record<string, unknown>) ?? {}), false, 'the assistant path never pre-accepts warnings');
});

// ---- route-level asserts against a real Tower ----

const PORT = await freePort();
process.env.CT_PORT = String(PORT);

const now = new Date().toISOString();
mkdirSync(join(home, 'config'), { recursive: true });
mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
const writeConfig = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));

// No projects: every route assertion below relies on GET /api/projects staying [] (nothing registers).
writeConfig('projects.json', []);
// One credentialed identity + one with NO push token. The credentialed cred file makes hasCredential:true
// consistent with a real broker-servable file (no route test below ever reaches the network with it).
writeConfig('identities.json', [
  { id: 'idcred', label: 'Bot', gitName: 'Bot', gitEmail: 'bot@example.com', hasCredential: true, createdAt: now },
  { id: 'idnocred', label: 'NoTok', gitName: 'NoTok', gitEmail: 'notok@example.com', hasCredential: false, createdAt: now },
]);
writeFileSync(join(home, 'secrets', 'ghcred-idcred'), 'ghp_dummy_not_used_offline', { mode: 0o600 });
// One assistant account with autoConfirm ON — so the T9 carve-out (not the account) is what keeps a
// bootstrap_project proposal pending.
writeConfig('assistant-accounts.json', [
  { id: 'aa', mode: 'cli', provider: 'codex', profileId: 'brainx', autoConfirm: true, createdAt: now },
]);

const base = `http://127.0.0.1:${PORT}`;
const tower = await spawnTower(home, PORT);
const token = tower.sessionToken;
const skip = tower.skip ?? false;

const sessionHeaders = { 'X-Tower-Token': token, 'Content-Type': 'application/json' };
const postBootstrap = (body: unknown): Promise<Response> =>
  fetch(`${base}/api/projects/bootstrap`, { method: 'POST', headers: sessionHeaders, body: JSON.stringify(body) });
const propose = (conv: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/assistant/proposals`, {
    method: 'POST',
    headers: { ...sessionHeaders, 'X-Tower-Conversation': conv },
    body: JSON.stringify(body),
  });
const confirm = (proposalId: string): Promise<Response> =>
  fetch(`${base}/api/assistant/confirm`, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ proposalId }) });
const listProjects = async (): Promise<Record<string, unknown>[]> =>
  (await (await fetch(`${base}/api/projects`, { headers: { 'X-Tower-Token': token } })).json()) as Record<string, unknown>[];
// The Tower auto-registers a stable 'sandbox' project at boot — "nothing registered" means no project
// beyond it, so every atomicity assertion filters it out.
const registered = async (): Promise<Record<string, unknown>[]> => (await listProjects()).filter((p) => p.id !== 'sandbox');

// T6 — front-door 400s; GET /api/projects stays [].
test('bootstrap_project route — missing repoUrl and unknown identity both 400; projects stay []', { skip }, async () => {
  const dir = realDir();
  const noUrl = await postBootstrap({ name: 'x', repoPath: dir, defaultIdentityId: 'idcred' });
  assert.equal(noUrl.status, 400);
  const badId = await postBootstrap({ name: 'x', repoPath: dir, repoUrl: GH, defaultIdentityId: 'nope' });
  assert.equal(badId.status, 400);
  assert.deepEqual(await registered(), []);
});

// T6b — the ~/.ct zone gate mirrored into the route: a direct session-token POST at the Tower's own
// data dir is refused 400 (defense-in-depth for a caller that never went through enrich).
test('bootstrap_project route — a ~/.ct repoPath is refused 400; projects unchanged', { skip }, async () => {
  const r = await postBootstrap({ name: 'x', repoPath: home, repoUrl: GH, defaultIdentityId: 'idcred' });
  assert.equal(r.status, 400);
  assert.deepEqual(await registered(), []);
});

// T6c — the ~/.ct zone gate RESOLVES SYMLINKS: a repoPath whose literal location is outside ~/.ct but
// whose target resolves under it is refused 400 (a literal-only check would be fooled and let
// executeBootstrap commit+push the Tower's own credential files through the link). Mirrors enrich's
// realpath leg. The link lives under fxRoot (a sibling of ~/.ct) and points at ~/.ct/secrets.
test('bootstrap_project route — a symlink whose target is under ~/.ct is refused 400; projects unchanged', { skip }, async () => {
  const link = join(fxRoot, `linktoct-${Math.random().toString(36).slice(2)}`);
  symlinkSync(join(home, 'secrets'), link); // home === CT_HOME; secrets/ is under ~/.ct
  const r = await postBootstrap({ name: 'x', repoPath: link, repoUrl: GH, defaultIdentityId: 'idcred' });
  assert.equal(r.status, 400);
  assert.deepEqual(await registered(), []);
});

// T7 — ATOMICITY: a no-credential refusal registers NOTHING.
test('bootstrap_project route — no-credential empty folder 409s registered:false; no project registered', { skip }, async () => {
  const dir = realDir();
  const r = await postBootstrap({ name: 'x', repoPath: dir, repoUrl: GH, defaultIdentityId: 'idnocred' });
  assert.equal(r.status, 409);
  const b = (await r.json()) as { registered?: boolean; blocking?: { code: string }[] };
  assert.equal(b.registered, false);
  const codes = (b.blocking ?? []).map((x) => x.code);
  assert.ok(codes.includes('no-credential'), `expected a no-credential blocker, got ${codes.join(',')}`);
  assert.deepEqual(await registered(), []);
});

// T8 — ATOMICITY: an already-a-repo folder refuses (short-circuits before any network) and registers nothing.
test('bootstrap_project route — already-a-git-repo folder 409s; no project registered', { skip }, async () => {
  const dir = realDir();
  mkdirSync(join(dir, '.git'));
  const r = await postBootstrap({ name: 'x', repoPath: dir, repoUrl: GH, defaultIdentityId: 'idcred' });
  assert.equal(r.status, 409);
  assert.deepEqual(await registered(), []);
});

// T9 — the autoConfirm carve-out: a proposed bootstrap_project stays PENDING even in autonomous mode.
test('bootstrap_project route — autoConfirm proposal stays PENDING; projects unchanged', { skip }, async () => {
  const dir = realDir();
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  const r = await propose('convbp9', { kind: 'bootstrap_project', args: { name: 'x', repoPath: dir, repoUrl: GH, defaultIdentityId: 'idcred' } });
  assert.equal(r.status, 200);
  const p = (await r.json()) as Record<string, unknown>;
  assert.equal(p.status, 'pending', 'the carve-out holds even under autoConfirm — no self-registration');
  assert.deepEqual(await registered(), []);
});

// T10 — drift: a .git appearing between propose and confirm voids the card, and nothing is registered.
test('bootstrap_project route — .git appearing before confirm aborts (>=400); projects still []', { skip }, async () => {
  const dir = realDir();
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  const r = await propose('convbp10', { kind: 'bootstrap_project', args: { name: 'x', repoPath: dir, repoUrl: GH, defaultIdentityId: 'idcred' } });
  const p = (await r.json()) as { id: string };
  // Turn the folder into a repo behind the card — the confirm-time enrich re-run now refuses it.
  mkdirSync(join(dir, '.git'));
  const done = await confirm(p.id);
  assert.ok(done.status >= 400, `a drifted card must not execute (got ${done.status})`);
  assert.deepEqual(await registered(), []);
});

// T11 — scoped-token belt: the assistant token cannot call POST /api/projects/bootstrap (403).
test('bootstrap_project route — the scoped assistant token is refused (403)', { skip }, async () => {
  // The route is deliberately absent from ASSISTANT_ACCEPT — a confirmed proposal reaches it only via the
  // executor's SESSION-token inject, never the scoped token. This pins that non-widening.
  const assistantToken = readFileSync(join(home, 'secrets', 'mcptok-assistant'), 'utf8').trim();
  const r = await fetch(`${base}/api/projects/bootstrap`, {
    method: 'POST',
    headers: { 'X-Tower-Token': assistantToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', repoPath: realDir(), repoUrl: GH, defaultIdentityId: 'idcred' }),
  });
  assert.equal(r.status, 403);
});

test.after(() => {
  try {
    tower.server?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(fxRoot, { recursive: true, force: true });
});
