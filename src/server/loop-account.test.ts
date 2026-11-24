// SPEC-LOOPACCT — the loop-account resolver + the create_loop propose-time account gate. The
// load-bearing invariant: the enrich refusal fires on EXACTLY the spawn probe's refuse condition
// (verdict === 'missing'), and every signed-in reader bottoms out in the same credentialVerdict.
// Each case is mutation-meaningful (a '!== present' refusal mutant, a forced-account mutant, and a
// dropped-profileId mutant each fail a test below).
//
// The account/credential probes read process.env + the filesystem directly (credentialVerdict is
// reused verbatim), so CT_HOME is pointed at a scratch dir BEFORE the dynamic imports, and every
// probe runs under a SCRUBBED env — otherwise the host's ANTHROPIC_API_KEY / gcloud ADC would leak
// a false 'present'. This mirrors credential-verdict.test.ts exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentProfile, ProviderId } from '../shared/types.js';
import type { LoopAccountView } from './loop-account.js';
import type { ActionLookups } from './assistant/actions.js';

const home = mkdtempSync(join(tmpdir(), 'ct-loopacct-test-'));
process.env.CT_HOME = home;
const { sharedConfigDirFor, accountCredentialProbe } = await import('./terminal-manager.js');
const { makeLoopAccountResolver } = await import('./loop-account.js');
const { validateAction, enrich, makeProposalExecutor, requiresHumanConfirm } = await import('./assistant/actions.js');

// Every env var the probe reads — scrubbed around each case (CLOUDSDK_CONFIG points at an empty
// scratch dir so gcloud's ADC well-known file can't be found).
const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI', 'CT_SKIP_AUTH_PROBE', 'CLOUDSDK_CONFIG', 'MY_KEY',
];
function withEnv<T>(patch: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.CLOUDSDK_CONFIG = mkdtempSync(join(tmpdir(), 'ct-gcloud-')); // empty ⇒ no ADC well-known file
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  try { return fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const noSecret = (): boolean => false;
const tmp = (): string => mkdtempSync(join(tmpdir(), 'ct-la-cfg-'));
const cfgWith = (file: string): string => { const d = tmp(); writeFileSync(join(d, file), '{}'); return d; };

// ---- helper probe: accountCredentialProbe / sharedConfigDirFor (the C1 refactor) ----

test('sharedConfigDirFor pins the ONE shared per-provider derivation', () => {
  assert.equal(sharedConfigDirFor('codex'), join(home, 'agents', 'codex'));
});

test('accountCredentialProbe: shared codex dir present ⇒ present, absent ⇒ missing', () => {
  withEnv({}, () => {
    // absent first (the shared dir does not exist yet)
    assert.equal(accountCredentialProbe('codex', undefined, undefined, noSecret).verdict, 'missing');
    const dir = sharedConfigDirFor('codex');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), '{}');
    assert.equal(accountCredentialProbe('codex', undefined, undefined, noSecret).verdict, 'present');
  });
});

test('accountCredentialProbe: repoPath omitted keeps the repo-settings layer inert', () => {
  const repo = tmp();
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'x' }));
  const cfg = tmp(); // empty account dir
  withEnv({}, () => {
    // with the repo passed, claude's repo-settings layer sees the apiKeyHelper ⇒ present
    assert.equal(accountCredentialProbe('claude-code', cfg, undefined, noSecret, repo).verdict, 'present');
    // account-scoped default (repoPath omitted ⇒ the never-created sentinel) ⇒ missing
    assert.equal(accountCredentialProbe('claude-code', cfg, undefined, noSecret).verdict, 'missing');
  });
});

test('accountCredentialProbe: CT_SKIP_AUTH_PROBE ⇒ unverifiable (not missing) — refusal-parity input', () => {
  withEnv({ CT_SKIP_AUTH_PROBE: '1' }, () => {
    assert.equal(accountCredentialProbe('codex', tmp(), undefined, noSecret).verdict, 'unverifiable');
  });
});

// ---- resolver: makeLoopAccountResolver (stub deps, real probe) ----

const prof = (id: string, provider: ProviderId, configDir: string, label: string): AgentProfile =>
  ({ id, provider, label, configDir, createdAt: '' });
const c1cfg = cfgWith('.credentials.json'); // claude, signed in
const c2cfg = tmp();                         // claude, empty
const x1cfg = cfgWith('auth.json');          // codex, signed in
const b1cfg = cfgWith('.credentials.json'); // claude, signed in but reserved
const stubProfiles: AgentProfile[] = [
  prof('c1', 'claude-code', c1cfg, 'main'),
  prof('c2', 'claude-code', c2cfg, 'empty'),
  prof('x1', 'codex', x1cfg, 'cx'),
  prof('b1', 'claude-code', b1cfg, 'brain'),
];
const stubAccounts = {
  getProfile: (id: string) => stubProfiles.find((p) => p.id === id),
  listProfiles: () => stubProfiles,
};
const stubProviderStore = { get: () => undefined, hasSecret: () => false };
const resolveAcct = makeLoopAccountResolver({
  layersFor: () => ({ global: {} }),
  getProject: () => undefined,
  accounts: stubAccounts,
  providerStore: stubProviderStore,
  reservedProfileIds: () => new Set<string>(['b1']),
});

test('resolver: explicit signed-in account ⇒ present; signedInProfiles excludes reserved/unsigned/mismatch', () => {
  const v = withEnv({}, () => resolveAcct({ projectId: 'p', profileId: 'c1' }));
  assert.equal(v.provider, 'claude-code');
  assert.equal(v.profileId, 'c1');
  assert.equal(v.verdict, 'present');
  assert.deepEqual(v.signedInProfiles, [{ id: 'c1', label: 'main' }]);
});

test('resolver: no profileId, no provider ⇒ shared claude-code login, missing', () => {
  const v = withEnv({}, () => resolveAcct({ projectId: 'p' }));
  assert.equal(v.provider, 'claude-code');
  assert.equal(v.profileId, undefined);
  assert.equal(v.label, 'shared claude-code login');
  assert.equal(v.verdict, 'missing');
});

test('resolver: explicit provider codex + claude account ⇒ provider codex, account falls away', () => {
  const v = withEnv({}, () => resolveAcct({ projectId: 'p', provider: 'codex', profileId: 'c1' }));
  assert.equal(v.provider, 'codex');
  assert.equal(v.profileId, undefined); // the match-gate drop enrich turns into a throw
});

test('resolver: shared codex signed in ⇒ present without forcing an account', () => {
  const dir = sharedConfigDirFor('codex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth.json'), '{}');
  const v = withEnv({}, () => resolveAcct({ projectId: 'p', provider: 'codex' }));
  assert.equal(v.provider, 'codex');
  assert.equal(v.profileId, undefined);
  assert.equal(v.verdict, 'present');
});

// ---- enrich: the create_loop propose-time account gate (scripted lookups, no Fastify) ----

const baseLookups = (): ActionLookups => ({
  getProject: () => ({ name: 'Proj', repoPath: '/x' }),
  getProfile: () => undefined,
  getIdentity: () => undefined,
  isReservedProfile: () => false,
  resolveLoopAccount: () => { throw new Error('resolveLoopAccount not scripted'); },
  getTask: () => undefined,
  getRouting: () => ({ global: {} }),
  getWorkflow: () => undefined,
  hasProvider: () => true,
  finishedCounts: () => ({ loops: 0, missions: 0 }),
  projectPathConflict: () => undefined,
  getSkill: () => undefined,
  getSkillDraft: () => undefined,
  getBundle: () => undefined,
  getProjectSkills: () => undefined,
  projectSkillReplaceDelta: () => ({ dropped: [], droppedProtected: [] }),
  getTerminal: () => undefined,
});
const lookupsWith = (over: Partial<ActionLookups>): ActionLookups => ({ ...baseLookups(), ...over });
const view = (over: Partial<LoopAccountView>): LoopAccountView =>
  ({ provider: 'claude-code', label: 'shared claude-code login', verdict: 'present', signedInProfiles: [], ...over });
const loopAction = (extra: Record<string, unknown> = {}) =>
  validateAction({ kind: 'create_loop', projectId: 'p1', name: 'L', task: 't', ...extra });
const enrichErr = (action: ReturnType<typeof loopAction>, lookups: ActionLookups): string => {
  try { enrich(action, lookups); assert.fail('enrich should have thrown'); return ''; }
  catch (e) { return (e as Error).message; }
};

test('enrich: resolver missing + signed-in alternatives ⇒ throws, names the account and "not signed in"', () => {
  const lookups = lookupsWith({ resolveLoopAccount: () => view({ profileId: undefined, verdict: 'missing', signedInProfiles: [{ id: 'c1', label: 'main' }] }) });
  const msg = enrichErr(loopAction(), lookups);
  assert.match(msg, /c1/);
  assert.match(msg, /not signed in/);
});

test('enrich: resolver present explicit ⇒ passes; summary + drift denorm carry the account', () => {
  const lookups = lookupsWith({
    resolveLoopAccount: () => view({ profileId: 'c1', label: 'main', verdict: 'present' }),
    getProfile: () => ({ label: 'main', provider: 'claude-code' }),
  });
  const en = enrich(loopAction({ profileId: 'c1' }), lookups);
  assert.match(en.summary, /runs as account "main"/);
  assert.equal(en.denorm.runsAsProfileId, 'c1');
  assert.equal(en.denorm.runsAsLabel, 'main');
});

test('enrich: explicit reserved account ⇒ throws mentioning the assistant brain', () => {
  const lookups = lookupsWith({
    resolveLoopAccount: () => view({ profileId: 'b1', label: 'brain', verdict: 'present' }),
    getProfile: () => ({ label: 'brain', provider: 'claude-code' }),
    isReservedProfile: (id) => id === 'b1',
  });
  const msg = enrichErr(loopAction({ profileId: 'b1' }), lookups);
  assert.match(msg, /assistant brain/);
});

test('enrich: explicit unknown profileId ⇒ throws "unknown profileId"', () => {
  const lookups = lookupsWith({ resolveLoopAccount: () => view({}), getProfile: () => undefined });
  const msg = enrichErr(loopAction({ profileId: 'zzz' }), lookups);
  assert.match(msg, /unknown profileId/);
});

test('enrich: explicit provider mismatch ⇒ throws naming both providers', () => {
  const lookups = lookupsWith({
    resolveLoopAccount: () => view({ provider: 'claude-code', profileId: undefined, verdict: 'present' }),
    getProfile: () => ({ label: 'cx', provider: 'codex' }),
  });
  const msg = enrichErr(loopAction({ profileId: 'x1' }), lookups);
  assert.match(msg, /codex/);
  assert.match(msg, /claude-code/);
});

test('enrich: resolver unverifiable ⇒ NO throw; summary flags "(credentials unverified)"', () => {
  const lookups = lookupsWith({ resolveLoopAccount: () => view({ profileId: undefined, verdict: 'unverifiable' }) });
  const en = enrich(loopAction(), lookups);
  assert.match(en.summary, /\(credentials unverified\)/);
});

test('enrich: shared login signed in ⇒ passes WITHOUT forcing an account', () => {
  const lookups = lookupsWith({ resolveLoopAccount: () => view({ profileId: undefined, verdict: 'present' }) });
  const en = enrich(loopAction(), lookups);
  assert.match(en.summary, /runs as the shared claude-code login/);
  assert.equal(en.denorm.runsAsProfileId, null);
});

test('enrich: resolver missing + no signed-in alternatives ⇒ points at create_profile/open_login/Settings', () => {
  const lookups = lookupsWith({ resolveLoopAccount: () => view({ profileId: undefined, verdict: 'missing', signedInProfiles: [] }) });
  const msg = enrichErr(loopAction(), lookups);
  assert.match(msg, /create_profile/);
  assert.match(msg, /Settings/);
});

// ---- union / zod / executor / carve-out (do NOT export CATALOG) ----

test('validateAction: create_loop.profileId parses and round-trips; strict + type rejections', () => {
  const a = validateAction({ kind: 'create_loop', projectId: 'p1', name: 'L', task: 't', profileId: 'c1' });
  assert.equal((a as { profileId?: string }).profileId, 'c1');
  assert.throws(() => validateAction({ kind: 'create_loop', projectId: 'p1', name: 'L', task: 't', bogus: 1 }));
  assert.throws(() => validateAction({ kind: 'create_loop', projectId: 'p1', name: 'L', task: 't', profileId: 5 }));
  // Parity guard: propose-time account resolution omits `role` because this surface has none — the
  // strict schema rejects one. If `role` is ever added here, this assertion fails, forcing the author
  // to also thread it into makeLoopAccountResolver (loop-account.ts) or propose/spawn parity breaks.
  assert.throws(() => validateAction({ kind: 'create_loop', projectId: 'p1', name: 'L', task: 't', role: 'implement' }));
});

test('executor: create_loop threads profileId onto the POST body, drops kind', async () => {
  let captured: { method?: string; url?: string; payload?: Record<string, unknown> } = {};
  const fakeApp = {
    inject: async (opts: { method: string; url: string; payload?: Record<string, unknown> }) => {
      captured = opts;
      return { statusCode: 200, json: () => ({}) };
    },
  } as unknown as FastifyInstance;
  const exec = makeProposalExecutor(fakeApp, 'tok', 4870);
  await exec(validateAction({ kind: 'create_loop', projectId: 'p1', name: 'L', task: 't', profileId: 'c1' }));
  assert.equal(captured.url, '/api/loops');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.payload?.profileId, 'c1');
  assert.equal(captured.payload?.kind, undefined);
});

test('requiresHumanConfirm: checkCommand carve-out survives profileId; profileId alone does not gate', () => {
  assert.equal(requiresHumanConfirm(validateAction({ kind: 'create_loop', projectId: 'p1', name: 'L', task: 't', profileId: 'c1', checkCommand: 'make test' })), true);
  assert.equal(requiresHumanConfirm(validateAction({ kind: 'create_loop', projectId: 'p1', name: 'L', task: 't', profileId: 'c1' })), false);
});

process.on('exit', () => { rmSync(home, { recursive: true, force: true }); });
