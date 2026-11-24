// SPEC-CRED-REFRESH — the background credential refresher's decision surface: the fire-condition
// truth table, the idle gate (every live CLI counts, not just bypass agents), the machine-mirror
// arm's accountUuid/freshness/atomicity contract, the opt-in ping arm, the overlap latch, and the
// no-token-in-output guarantee. All against a CT_HOME tempdir; the "machine login" is a scratch dir
// addressed via CLAUDE_CONFIG_DIR (the accounts.test.ts adopt-fixture trick) so no real credential
// is ever read or written.
//
// CT_HOME is set before the module loads: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile, Terminal, TerminalState } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-credref-test-'));
process.env.CT_HOME = home;
// The scratch "machine login": machineLoginFile/machineClaudeStateFiles read this at call time.
const machineDir = join(home, 'machine-claude');
mkdirSync(machineDir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = machineDir;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { ClaudeCredRefresher, refreshDecision, liveTerminalOnDir, machineClaudeStateFiles, accountUuidAt } =
  await import('./claude-cred-refresher.js');
const { sharedConfigDirFor } = await import('./terminal-manager.js');

const NOW = Date.now();
const HOUR = 3600_000;
const FRESH_EXP = NOW + 8 * HOUR; // the machine's healthy token
const STALE_EXP = NOW + 5 * 60_000; // inside the 60-minute fire window
const FAR_EXP = NOW + 3 * HOUR; // outside the window — no fire
const REFRESH_OK = NOW + 28 * 24 * HOUR;
const MACHINE_UUID = 'uuid-machine-account';

// Every fixture token carries the sentinel: the leak test greps ALL output for it.
const machineCred = (expiresAt: number = FRESH_EXP): Record<string, unknown> => ({
  claudeAiOauth: {
    accessToken: 'MACHINE-ACCESS-TOKENVALUE',
    refreshToken: 'MACHINE-REFRESH-TOKENVALUE',
    expiresAt,
    refreshTokenExpiresAt: REFRESH_OK,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
  mcpOAuth: { 'srv|machine': { serverName: 'srv', accessToken: 'MACHINE-MCP-TOKENVALUE' } },
});
const accountCred = (expiresAt: number | null, refreshTokenExpiresAt: number = REFRESH_OK): Record<string, unknown> => ({
  claudeAiOauth: {
    accessToken: 'ACCT-ACCESS-TOKENVALUE',
    refreshToken: 'ACCT-REFRESH-TOKENVALUE',
    expiresAt,
    refreshTokenExpiresAt,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
  mcpOAuth: { 'srv|acct': { serverName: 'srv', accessToken: 'ACCT-MCP-TOKENVALUE' } },
});
// The clobbered-concurrent-write shape the CLI leaves on the SHARED dir: BOTH token strings blanked
// and expiresAt zeroed, metadata retained. This is the live bug — refreshDecision reads it as
// 'needs-login', and the mirror (matched account) must repair it rather than give up.
const blankedCred = (): Record<string, unknown> => ({
  claudeAiOauth: {
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    refreshTokenExpiresAt: REFRESH_OK,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
  mcpOAuth: { 'srv|acct': { serverName: 'srv', accessToken: 'ACCT-MCP-TOKENVALUE' } },
});

function plantMachine(cred: Record<string, unknown> = machineCred(), uuid: string = MACHINE_UUID): void {
  writeFileSync(join(machineDir, '.credentials.json'), JSON.stringify(cred, null, 2), { mode: 0o600 });
  writeFileSync(join(machineDir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid } }));
}

let seq = 0;
/** An account dir + its profile record, as createProfile + a spawn's seed would leave them. */
function plantAccount(o: {
  cred?: Record<string, unknown> | string;
  uuid?: string;
}): { dir: string; profile: AgentProfile } {
  const id = `acct${++seq}`;
  const dir = join(home, 'accounts', 'claude-code', id);
  mkdirSync(dir, { recursive: true });
  if (o.cred !== undefined) {
    writeFileSync(join(dir, '.credentials.json'), typeof o.cred === 'string' ? o.cred : JSON.stringify(o.cred, null, 2), { mode: 0o600 });
  }
  if (o.uuid !== undefined) {
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: o.uuid }, bypassPermissionsModeAccepted: true }));
  }
  const profile: AgentProfile = { id, provider: 'claude-code', label: `label-${id}`, configDir: dir, createdAt: new Date().toISOString() };
  return { dir, profile };
}

const term = (o: Partial<Terminal> = {}): Terminal => ({
  id: 't1',
  projectId: 'p1',
  title: 't',
  provider: 'claude-code',
  tmuxSocket: 'ct-t1',
  cwd: '/tmp',
  command: ['claude'],
  state: 'working',
  createdAt: new Date().toISOString(),
  ...o,
});

function makeRefresher(o: {
  profiles?: AgentProfile[];
  terminals?: Terminal[];
  ping?: (configDir: string) => Promise<boolean>;
}): InstanceType<typeof ClaudeCredRefresher> {
  const profiles = o.profiles ?? [];
  return new ClaudeCredRefresher({
    listProfiles: () => profiles,
    getProfile: (id) => profiles.find((p) => p.id === id),
    listTerminals: () => o.terminals ?? [],
    ...(o.ping ? { ping: o.ping } : {}),
  });
}

function auditEntries(action: string, configDir: string): Record<string, unknown>[] {
  if (!existsSync(paths.audit)) return [];
  return readFileSync(paths.audit, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.action === action && e.configDir === configDir);
}

test('refreshDecision — the fire-condition truth table', async (t) => {
  const oauth = (over: Record<string, unknown>): Record<string, unknown> => ({
    claudeAiOauth: { accessToken: 'A-TOKENVALUE', refreshToken: 'R-TOKENVALUE', expiresAt: FAR_EXP, refreshTokenExpiresAt: REFRESH_OK, ...over },
  });
  const cases: { name: string; cred: Record<string, unknown> | undefined; want: string }[] = [
    { name: 'no credential file', cred: undefined, want: 'not-logged-in' },
    { name: 'file without claudeAiOauth', cred: { mcpOAuth: {} }, want: 'not-logged-in' },
    { name: 'claudeAiOauth is not an object', cred: { claudeAiOauth: 'nope' }, want: 'not-logged-in' },
    { name: 'no refresh token', cred: oauth({ refreshToken: undefined }), want: 'needs-login' },
    { name: 'empty refresh token', cred: oauth({ refreshToken: '' }), want: 'needs-login' },
    { name: 'refresh token itself expired', cred: oauth({ refreshTokenExpiresAt: NOW - 1 }), want: 'needs-login' },
    { name: 'expiresAt nulled (the concurrent-spawn race)', cred: oauth({ expiresAt: null }), want: 'fire' },
    { name: 'expiresAt absent', cred: oauth({ expiresAt: undefined }), want: 'fire' },
    { name: 'expiresAt already past', cred: oauth({ expiresAt: NOW - HOUR }), want: 'fire' },
    { name: 'expiresAt inside the 60-minute window', cred: oauth({ expiresAt: STALE_EXP }), want: 'fire' },
    { name: 'expiresAt far in the future', cred: oauth({ expiresAt: FAR_EXP }), want: 'fresh' },
    { name: 'near expiry with UNKNOWN refresh expiry still fires (unknown must not brick)', cred: oauth({ expiresAt: STALE_EXP, refreshTokenExpiresAt: undefined }), want: 'fire' },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      assert.equal(refreshDecision(c.cred, NOW), c.want);
    });
  }
});

test('liveTerminalOnDir — the idle gate counts EVERY live CLI, not just bypass agents', async (t) => {
  const profiles: Record<string, { configDir: string }> = { p1: { configDir: '/accounts/p1' } };
  const getProfile = (id: string): { configDir: string } | undefined => profiles[id];
  const shared = sharedConfigDirFor('claude-code');

  await t.test('no terminals → false', () => {
    assert.equal(liveTerminalOnDir([], '/accounts/p1', getProfile), false);
  });
  await t.test('a live terminal WITHOUT autoAccept counts (the delta from liveBypassOnDir)', () => {
    assert.equal(liveTerminalOnDir([term({ state: 'working', profileId: 'p1' })], '/accounts/p1', getProfile), true);
    assert.equal(liveTerminalOnDir([term({ autoAccept: false, state: 'working', profileId: 'p1' })], '/accounts/p1', getProfile), true);
  });
  await t.test("'killed' is the only excluded state", () => {
    assert.equal(liveTerminalOnDir([term({ state: 'killed', profileId: 'p1' })], '/accounts/p1', getProfile), false);
    for (const state of ['starting', 'working', 'blocked-question', 'blocked-permission', 'idle'] as TerminalState[]) {
      assert.equal(liveTerminalOnDir([term({ state, profileId: 'p1' })], '/accounts/p1', getProfile), true, state);
    }
  });
  await t.test('a different dir does not match', () => {
    assert.equal(liveTerminalOnDir([term({ state: 'working', profileId: 'p1' })], '/accounts/other', getProfile), false);
  });
  await t.test('no profileId resolves to the shared per-provider dir (the spawn-path resolution)', () => {
    const fleet = [term({ state: 'working' })];
    assert.equal(liveTerminalOnDir(fleet, shared, getProfile), true);
    assert.equal(liveTerminalOnDir(fleet, '/accounts/p1', getProfile), false);
  });
  await t.test('a dangling profileId matches CONSERVATIVELY', () => {
    assert.equal(liveTerminalOnDir([term({ state: 'working', profileId: 'gone' })], '/anywhere', getProfile), true);
  });
});

test('machine state-file derivation honors CLAUDE_CONFIG_DIR and reads accountUuid', () => {
  plantMachine();
  assert.deepEqual(machineClaudeStateFiles(), [join(machineDir, '.claude.json')]);
  assert.equal(accountUuidAt(join(machineDir, '.claude.json')), MACHINE_UUID);
  assert.equal(accountUuidAt(join(machineDir, 'no-such-file.json')), undefined);
});

test('(c) machine-mirror', async (t) => {
  await t.test('accountUuid match + machine fresher → merge-preserve 0600 write; .claude.json untouched; no ping even when enabled', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: MACHINE_UUID });
    const stateBefore = readFileSync(join(dir, '.claude.json'), 'utf8');
    const pinged: string[] = [];
    const r = makeRefresher({ profiles: [profile], ping: async (d) => { pinged.push(d); return true; } });
    process.env.CT_CRED_REFRESH_PING = '1';
    try {
      await r.runOnce();
    } finally {
      delete process.env.CT_CRED_REFRESH_PING;
    }
    const dest = join(dir, '.credentials.json');
    const parsed = JSON.parse(readFileSync(dest, 'utf8')) as Record<string, unknown>;
    const machine = JSON.parse(readFileSync(join(machineDir, '.credentials.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(parsed.claudeAiOauth, machine.claudeAiOauth, 'claudeAiOauth is the machine one');
    assert.deepEqual(parsed.mcpOAuth, accountCred(STALE_EXP).mcpOAuth, "the account's OWN mcpOAuth map survives — not clobbered by the machine's");
    assert.equal(statSync(dest).mode & 0o777, 0o600, 'write is 0600');
    assert.equal(readFileSync(join(dir, '.claude.json'), 'utf8'), stateBefore, '.claude.json is NEVER written');
    assert.deepEqual(pinged, [], 'the mirror arm satisfied the dir — no ping');
    const audits = auditEntries('profile.cred-refresh.mirrored', dir);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.expiresAt, FRESH_EXP, 'audit carries the new expiry timestamp, never a token');
  });

  await t.test('accountUuid MISMATCH → no copy', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: 'uuid-somebody-else' });
    const before = readFileSync(join(dir, '.credentials.json'), 'utf8');
    await makeRefresher({ profiles: [profile] }).runOnce();
    assert.equal(readFileSync(join(dir, '.credentials.json'), 'utf8'), before, 'credential untouched');
    assert.equal(auditEntries('profile.cred-refresh.mirrored', dir).length, 0);
  });

  await t.test('account has NO accountUuid stamp → UNCLASSIFIED: no copy AND no ping (it may BE the machine account)', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP) }); // no .claude.json at all
    const before = readFileSync(join(dir, '.credentials.json'), 'utf8');
    const pinged: string[] = [];
    const r = makeRefresher({ profiles: [profile], ping: async (d) => { pinged.push(d); return true; } });
    process.env.CT_CRED_REFRESH_PING = '1';
    try {
      await r.runOnce();
      await r.runOnce();
    } finally {
      delete process.env.CT_CRED_REFRESH_PING;
    }
    assert.equal(readFileSync(join(dir, '.credentials.json'), 'utf8'), before, 'no copy');
    assert.deepEqual(pinged, [], 'an unclassifiable account is never pinged, even opted in');
    assert.equal(auditEntries('profile.cred-refresh.unclassified-skip', dir).length, 1, 'surfaced once, not every tick');
  });

  await t.test('machine state file unreadable (its uuid unknown) → likewise UNCLASSIFIED, never pinged', async () => {
    plantMachine();
    rmSync(join(machineDir, '.claude.json'), { force: true }); // credential present, uuid gone
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: MACHINE_UUID });
    const before = readFileSync(join(dir, '.credentials.json'), 'utf8');
    const pinged: string[] = [];
    const r = makeRefresher({ profiles: [profile], ping: async (d) => { pinged.push(d); return true; } });
    process.env.CT_CRED_REFRESH_PING = '1';
    try {
      await r.runOnce();
    } finally {
      delete process.env.CT_CRED_REFRESH_PING;
      plantMachine(); // restore for later tests
    }
    assert.equal(readFileSync(join(dir, '.credentials.json'), 'utf8'), before);
    assert.deepEqual(pinged, []);
    assert.equal(auditEntries('profile.cred-refresh.unclassified-skip', dir).length, 1);
  });

  await t.test('machine NOT newer → no copy, no churn', async () => {
    plantMachine(machineCred(STALE_EXP - 60_000)); // older than the account's own expiry
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: MACHINE_UUID });
    const before = readFileSync(join(dir, '.credentials.json'), 'utf8');
    await makeRefresher({ profiles: [profile] }).runOnce();
    assert.equal(readFileSync(join(dir, '.credentials.json'), 'utf8'), before);
    assert.equal(auditEntries('profile.cred-refresh.mirrored', dir).length, 0);
  });

  await t.test('nulled account expiresAt is repaired by ANY readable machine credential (the raced state)', async () => {
    plantMachine(machineCred(NOW - HOUR)); // even a stale machine token carries a usable refresh token
    const { dir, profile } = plantAccount({ cred: accountCred(null), uuid: MACHINE_UUID });
    await makeRefresher({ profiles: [profile] }).runOnce();
    const parsed = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as Record<string, unknown>;
    const machine = JSON.parse(readFileSync(join(machineDir, '.credentials.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(parsed.claudeAiOauth, machine.claudeAiOauth, 'the nulled claudeAiOauth was replaced');
    assert.deepEqual(parsed.mcpOAuth, accountCred(null).mcpOAuth, "the account's mcpOAuth survives the repair");
  });

  await t.test('the pre-rename idle re-check guard is preserved: when the two gate reads differ, the rename is aborted', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: MACHINE_UUID });
    const before = readFileSync(join(dir, '.credentials.json'), 'utf8');
    let gateCalls = 0;
    const live = term({ state: 'working', profileId: profile.id });
    const r = new ClaudeCredRefresher({
      listProfiles: () => [profile],
      getProfile: (id) => (id === profile.id ? profile : undefined),
      // The production mirror path is synchronous, so the first gate and the pre-rename re-check see
      // the SAME snapshot — this interleave cannot occur naturally. The stub forces the two reads to
      // differ purely to PIN that the re-check guard still exists (defense-in-depth that only becomes
      // load-bearing if a future edit adds an await into tryMirror). Delete the re-check and this fails.
      listTerminals: () => (++gateCalls === 1 ? [] : [live]),
    });
    await r.runOnce();
    assert.ok(gateCalls >= 2, 'the pre-rename re-check consulted the terminal list again');
    assert.equal(readFileSync(join(dir, '.credentials.json'), 'utf8'), before, 'the rename was aborted — the re-check guard fired');
    assert.ok(!existsSync(join(dir, '.credentials.json.tmp')), 'the temp file was cleaned up');
    assert.equal(auditEntries('profile.cred-refresh.mirrored', dir).length, 0);
  });

  await t.test('matched account with an UNREADABLE machine credential: no copy AND no ping fallback', async () => {
    plantMachine();
    writeFileSync(join(machineDir, '.credentials.json'), '{ not json', { mode: 0o600 });
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: MACHINE_UUID });
    const before = readFileSync(join(dir, '.credentials.json'), 'utf8');
    const pinged: string[] = [];
    const r = makeRefresher({ profiles: [profile], ping: async (d) => { pinged.push(d); return true; } });
    process.env.CT_CRED_REFRESH_PING = '1';
    try {
      await r.runOnce();
    } finally {
      delete process.env.CT_CRED_REFRESH_PING;
    }
    assert.equal(readFileSync(join(dir, '.credentials.json'), 'utf8'), before);
    assert.deepEqual(pinged, [], 'a machine-login account is never pinged');
    plantMachine(); // restore for later tests
  });

  await t.test('idle gate: a live terminal on the dir (even non-bypass) → nothing happens', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: MACHINE_UUID });
    const before = readFileSync(join(dir, '.credentials.json'), 'utf8');
    const pinged: string[] = [];
    const r = makeRefresher({
      profiles: [profile],
      terminals: [term({ state: 'idle', profileId: profile.id })], // autoAccept ABSENT — still gates
      ping: async (d) => { pinged.push(d); return true; },
    });
    process.env.CT_CRED_REFRESH_PING = '1';
    try {
      await r.runOnce();
    } finally {
      delete process.env.CT_CRED_REFRESH_PING;
    }
    assert.equal(readFileSync(join(dir, '.credentials.json'), 'utf8'), before, 'no copy under a live CLI');
    assert.deepEqual(pinged, [], 'no ping under a live CLI');
    assert.equal(auditEntries('profile.cred-refresh.mirrored', dir).length, 0);
  });

  await t.test('the shared per-provider dir is swept too (profileless spawns live there)', async () => {
    plantMachine();
    const shared = sharedConfigDirFor('claude-code');
    mkdirSync(shared, { recursive: true });
    try {
      writeFileSync(join(shared, '.credentials.json'), JSON.stringify(accountCred(STALE_EXP)), { mode: 0o600 });
      writeFileSync(join(shared, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: MACHINE_UUID } }));
      await makeRefresher({}).runOnce();
      const parsed = JSON.parse(readFileSync(join(shared, '.credentials.json'), 'utf8')) as Record<string, unknown>;
      const machine = JSON.parse(readFileSync(join(machineDir, '.credentials.json'), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(parsed.claudeAiOauth, machine.claudeAiOauth);
      assert.deepEqual(parsed.mcpOAuth, accountCred(STALE_EXP).mcpOAuth, 'the shared dir keeps its own mcpOAuth too');
      const audits = auditEntries('profile.cred-refresh.mirrored', shared);
      assert.equal(audits.length, 1);
      assert.equal(audits[0]?.label, 'shared');
    } finally {
      rmSync(shared, { recursive: true, force: true }); // keep later sweeps of the shared dir inert
    }
  });
});

test('needs-login repair via the machine mirror (the blanked shared-dir bug)', async (t) => {
  await t.test('a BLANKED cred whose uuid matches the machine is repaired: mcpOAuth preserved, audited as mirror not needs-login, never pinged', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: blankedCred(), uuid: MACHINE_UUID });
    const pinged: string[] = [];
    const r = makeRefresher({ profiles: [profile], ping: async (d) => { pinged.push(d); return true; } });
    process.env.CT_CRED_REFRESH_PING = '1';
    try {
      await r.runOnce();
    } finally {
      delete process.env.CT_CRED_REFRESH_PING;
    }
    const parsed = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as Record<string, unknown>;
    const machine = JSON.parse(readFileSync(join(machineDir, '.credentials.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(parsed.claudeAiOauth, machine.claudeAiOauth, 'the blanked claudeAiOauth was replaced with the machine live token');
    assert.deepEqual(parsed.mcpOAuth, blankedCred().mcpOAuth, "the blanked dir's own mcpOAuth survives the repair");
    assert.equal(auditEntries('profile.cred-refresh.mirrored', dir).length, 1, 'the repair is audited as a mirror');
    assert.equal(auditEntries('profile.cred-refresh.needs-login', dir).length, 0, 'a repairable dir is NEVER reported needs-login');
    assert.deepEqual(pinged, [], 'a matched account is never pinged, even opted in');
  });

  await t.test('a matched DEAD-REFRESH dir (refresh token expired, not just blanked) is also repaired', async () => {
    plantMachine();
    // The account IS the machine login, so the machine holds a live token — mirror repairs rather
    // than declaring the account unrenewable.
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP, NOW - 1), uuid: MACHINE_UUID });
    const r = makeRefresher({ profiles: [profile] });
    await r.runOnce();
    const parsed = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as Record<string, unknown>;
    const machine = JSON.parse(readFileSync(join(machineDir, '.credentials.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(parsed.claudeAiOauth, machine.claudeAiOauth, 'the dead-refresh claudeAiOauth was replaced');
    assert.equal(auditEntries('profile.cred-refresh.mirrored', dir).length, 1);
    assert.equal(auditEntries('profile.cred-refresh.needs-login', dir).length, 0);
  });

  await t.test('repair clears the needs-login memo so a later re-blank re-audits', async () => {
    plantMachine();
    // Start distinct + dead-refresh → needs-login audited; then the operator re-stamps the dir to the
    // machine account → next sweep repairs it (clearing the memo); then it re-blanks as a distinct
    // account again → the recurrence must re-audit, not be swallowed by a stale memo.
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP, NOW - 1), uuid: 'uuid-other-sub' });
    const r = makeRefresher({ profiles: [profile] });
    await r.runOnce();
    assert.equal(auditEntries('profile.cred-refresh.needs-login', dir).length, 1, 'distinct dead-refresh → needs-login');
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: MACHINE_UUID } }));
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(blankedCred()), { mode: 0o600 });
    await r.runOnce();
    assert.equal(auditEntries('profile.cred-refresh.mirrored', dir).length, 1, 'now matched + blanked → repaired');
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-other-sub' } }));
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(accountCred(STALE_EXP, NOW - 1)), { mode: 0o600 });
    await r.runOnce();
    assert.equal(auditEntries('profile.cred-refresh.needs-login', dir).length, 2, 'the recurrence re-audited — the memo was cleared on repair');
  });

  await t.test('a gated needs-login dir is STILL surfaced once (the wedged-pane case) and not written under the live CLI', async () => {
    plantMachine();
    // A matched blanked dir with a live terminal on it: the write must defer to the live CLI, but the
    // needs-login signal must not go silent in exactly the state the operator needs it.
    const { dir, profile } = plantAccount({ cred: blankedCred(), uuid: MACHINE_UUID });
    const before = readFileSync(join(dir, '.credentials.json'), 'utf8');
    const r = makeRefresher({
      profiles: [profile],
      terminals: [term({ state: 'working', profileId: profile.id })],
    });
    await r.runOnce();
    await r.runOnce();
    assert.equal(readFileSync(join(dir, '.credentials.json'), 'utf8'), before, 'no write while a live CLI holds the dir');
    assert.equal(auditEntries('profile.cred-refresh.needs-login', dir).length, 1, 'surfaced once even while gated');
    assert.equal(auditEntries('profile.cred-refresh.mirrored', dir).length, 0);
  });

  await t.test('F1: a BLANKED machine login never clobbers a dir that still holds a live refresh token', async () => {
    // Machine itself is logged-out/blanked; the account is in the raced state (expiresAt nulled) but
    // still carries a LIVE refresh token. Grafting the dead machine oauth would destroy it.
    plantMachine(blankedCred());
    const { dir, profile } = plantAccount({ cred: accountCred(null), uuid: MACHINE_UUID });
    const before = readFileSync(join(dir, '.credentials.json'), 'utf8');
    await makeRefresher({ profiles: [profile] }).runOnce();
    assert.equal(readFileSync(join(dir, '.credentials.json'), 'utf8'), before, 'the live refresh token was NOT overwritten by a blanked machine');
    assert.equal(auditEntries('profile.cred-refresh.mirrored', dir).length, 0);
    plantMachine(); // restore for later tests
  });
});

test('needs-login on a DISTINCT account: audited once, never mirrored, never pinged', async () => {
  plantMachine();
  // A dead refresh token on an account that is NOT the machine login: no healthy machine credential
  // can stand in, and a headless ping cannot revive a dead refresh token — hands off, report once.
  const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP, NOW - 1), uuid: 'uuid-other-sub' });
  const before = readFileSync(join(dir, '.credentials.json'), 'utf8');
  const pinged: string[] = [];
  const r = makeRefresher({ profiles: [profile], ping: async (d) => { pinged.push(d); return true; } });
  process.env.CT_CRED_REFRESH_PING = '1';
  try {
    await r.runOnce();
    await r.runOnce();
  } finally {
    delete process.env.CT_CRED_REFRESH_PING;
  }
  assert.equal(readFileSync(join(dir, '.credentials.json'), 'utf8'), before, 'a dead refresh token means hands off');
  assert.deepEqual(pinged, [], 'no spend on an unrenewable distinct account, even opted in');
  assert.equal(auditEntries('profile.cred-refresh.needs-login', dir).length, 1, 'audited once, not every tick');
});

test('dedup memos clear on recovery, so a RECURRENCE re-audits', async (t) => {
  await t.test('needs-login re-fires after the account recovers and dies again', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP, NOW - 1), uuid: 'uuid-other-sub' });
    const r = makeRefresher({ profiles: [profile] });
    await r.runOnce();
    assert.equal(auditEntries('profile.cred-refresh.needs-login', dir).length, 1);
    // The operator re-logs-in: a healthy credential appears...
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(accountCred(FAR_EXP)), { mode: 0o600 });
    await r.runOnce(); // 'fresh' — clears the memo
    // ...and much later the refresh token dies AGAIN. Same instance must re-report.
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(accountCred(STALE_EXP, NOW - 1)), { mode: 0o600 });
    await r.runOnce();
    assert.equal(auditEntries('profile.cred-refresh.needs-login', dir).length, 2, 'the recurrence was reported');
  });

  await t.test('ping-skipped re-fires after recovery', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: 'uuid-other-sub' });
    const r = makeRefresher({ profiles: [profile] }); // flag unset — the skip path
    await r.runOnce();
    assert.equal(auditEntries('profile.cred-refresh.ping-skipped', dir).length, 1);
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(accountCred(FAR_EXP)), { mode: 0o600 });
    await r.runOnce(); // 'fresh' — clears the memo
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify(accountCred(STALE_EXP)), { mode: 0o600 });
    await r.runOnce();
    assert.equal(auditEntries('profile.cred-refresh.ping-skipped', dir).length, 2, 'the recurrence was reported');
  });
});

test('(b) vendor ping', async (t) => {
  await t.test('default OFF: a non-machine account is reported once, never spawned', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: 'uuid-other-sub' });
    const pinged: string[] = [];
    const r = makeRefresher({ profiles: [profile], ping: async (d) => { pinged.push(d); return true; } });
    assert.equal(process.env.CT_CRED_REFRESH_PING, undefined, 'the flag must be unset for this test');
    await r.runOnce();
    await r.runOnce();
    assert.deepEqual(pinged, [], 'opt-in means NO spawn by default');
    assert.equal(auditEntries('profile.cred-refresh.ping-skipped', dir).length, 1, 'the skip is surfaced once');
  });

  await t.test('opted in: the ping fires for a uuid-mismatch account and the outcome is audited', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: 'uuid-other-sub' });
    const PINGED_EXP = NOW + 10 * HOUR;
    const pinged: string[] = [];
    const r = makeRefresher({
      profiles: [profile],
      ping: async (d) => {
        pinged.push(d);
        // The CLI writes its own refreshed credential; the sweeper only re-reads the expiry.
        writeFileSync(join(d, '.credentials.json'), JSON.stringify(accountCred(PINGED_EXP)), { mode: 0o600 });
        return true;
      },
    });
    process.env.CT_CRED_REFRESH_PING = '1';
    try {
      await r.runOnce();
    } finally {
      delete process.env.CT_CRED_REFRESH_PING;
    }
    assert.deepEqual(pinged, [dir]);
    const audits = auditEntries('profile.cred-refresh.pinged', dir);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.ok, true);
    assert.equal(audits[0]?.expiresAt, PINGED_EXP, 'the audit reflects the credential the CLI wrote');
  });

  await t.test('a failed ping is audited ok:false', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: 'uuid-other-sub' });
    const r = makeRefresher({ profiles: [profile], ping: async () => false });
    process.env.CT_CRED_REFRESH_PING = '1';
    try {
      await r.runOnce();
    } finally {
      delete process.env.CT_CRED_REFRESH_PING;
    }
    const audits = auditEntries('profile.cred-refresh.pinged', dir);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.ok, false);
    assert.equal(audits[0]?.expiresAt, STALE_EXP, 'expiry re-read from the unchanged file');
  });

  await t.test('a futile ping is NOT repeated next sweep; recovery re-arms one retry per expiry cycle', async () => {
    plantMachine();
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: 'uuid-other-sub' });
    const pinged: string[] = [];
    // The ping "succeeds" as a process but never moves the credential — the unresolvable dir.
    const r = makeRefresher({ profiles: [profile], ping: async (d) => { pinged.push(d); return true; } });
    process.env.CT_CRED_REFRESH_PING = '1';
    try {
      await r.runOnce();
      await r.runOnce();
      assert.equal(pinged.length, 1, 'no repeated spend on a dir the ping did not move');
      // A live CLI (or re-login) later refreshes the dir: the back-off memo must clear...
      writeFileSync(join(dir, '.credentials.json'), JSON.stringify(accountCred(FAR_EXP)), { mode: 0o600 });
      await r.runOnce(); // 'fresh'
      // ...so the NEXT expiry cycle gets exactly one fresh attempt.
      writeFileSync(join(dir, '.credentials.json'), JSON.stringify(accountCred(STALE_EXP)), { mode: 0o600 });
      await r.runOnce();
      await r.runOnce();
      assert.equal(pinged.length, 2, 'one retry after recovery, then muted again');
    } finally {
      delete process.env.CT_CRED_REFRESH_PING;
    }
    assert.equal(auditEntries('profile.cred-refresh.pinged', dir).length, 2, 'each SPEND is audited, the mutes are not');
  });

  await t.test('no machine login at all → the ping path stays reachable (nothing to collide with)', async () => {
    rmSync(join(machineDir, '.credentials.json'), { force: true });
    const { dir, profile } = plantAccount({ cred: accountCred(STALE_EXP), uuid: 'uuid-other-sub' });
    const pinged: string[] = [];
    const r = makeRefresher({ profiles: [profile], ping: async (d) => { pinged.push(d); return true; } });
    process.env.CT_CRED_REFRESH_PING = '1';
    try {
      await r.runOnce();
    } finally {
      delete process.env.CT_CRED_REFRESH_PING;
      plantMachine(); // restore for later tests
    }
    assert.deepEqual(pinged, [dir], 'the unclassified guard must not over-block the legitimate no-machine-login ping');
  });
});

test('latch: a tick during an in-flight sweep is a no-op, and the latch releases', async () => {
  let enumerations = 0;
  const r = new ClaudeCredRefresher({
    listProfiles: () => {
      enumerations++;
      r.sweep(); // re-entrant tick while this sweep is mid-flight
      return [];
    },
    getProfile: () => undefined,
    listTerminals: () => [],
  });
  r.sweep();
  await new Promise((res) => setImmediate(res)); // let the void-launched pass settle
  assert.equal(enumerations, 1, 'the overlapping tick was swallowed by the latch');
  r.sweep();
  await new Promise((res) => setImmediate(res));
  assert.equal(enumerations, 2, 'the latch released after the first pass');
});

test('no token value ever reaches console or audit output', async () => {
  plantMachine();
  const scenarios = [
    plantAccount({ cred: accountCred(STALE_EXP), uuid: MACHINE_UUID }), // mirror copy
    plantAccount({ cred: accountCred(STALE_EXP, NOW - 1), uuid: 'uuid-other-sub' }), // needs-login audit (distinct account, dead refresh)
    plantAccount({ cred: accountCred(STALE_EXP), uuid: 'uuid-other-sub' }), // pinged audit
    plantAccount({ cred: '{ corrupt', uuid: MACHINE_UUID }), // unreadable account file
    plantAccount({ cred: accountCred(STALE_EXP) }), // no uuid stamp — unclassified-skip audit
  ];
  const captured: string[] = [];
  const asText = (x: unknown): string => {
    if (typeof x === 'string') return x;
    try {
      return JSON.stringify(x) ?? String(x);
    } catch {
      return String(x);
    }
  };
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => captured.push(a.map(asText).join(' '));
  console.error = (...a: unknown[]) => captured.push(a.map(asText).join(' '));
  process.env.CT_CRED_REFRESH_PING = '1';
  try {
    const r = makeRefresher({ profiles: scenarios.map((s) => s.profile), ping: async () => true });
    await r.runOnce();
  } finally {
    console.log = origLog;
    console.error = origErr;
    delete process.env.CT_CRED_REFRESH_PING;
  }
  const consoleText = captured.join('\n');
  assert.ok(!consoleText.includes('TOKENVALUE'), 'no token value on the console');
  // The WHOLE accumulated audit log — every scenario in this file used sentinel-bearing tokens.
  const auditText = existsSync(paths.audit) ? readFileSync(paths.audit, 'utf8') : '';
  assert.ok(auditText.length > 0, 'the audit log has entries to scan');
  assert.ok(!auditText.includes('TOKENVALUE'), 'no token value in the audit log');
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
