// SPEC-RUNWAY live swap -- performLiveSwap against tmp config dirs: graft + surgical .claude.json update,
// unhealthy-target refusal, rollback on a failed state write, lock-busy, runs-inside-the-lock, and the
// no-token-in-audit guarantee. CT_HOME is set before the module loads (claude-cred-refresher imports paths).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CT_HOME = mkdtempSync(join(tmpdir(), 'ct-liveswap-home-'));
const { performLiveSwap, targetIsHealthy, ACCOUNT_CACHE_KEYS } = await import('./runway/live-swap.js');
const { ClaudeLockBusyError } = await import('./runway/claude-lock.js');

const NOW = Date.now();
const HOUR = 3600_000;
const oauth = (tag: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  accessToken: `${tag}-ACCESS`,
  refreshToken: `${tag}-REFRESH`,
  expiresAt: NOW + 8 * HOUR,
  refreshTokenExpiresAt: NOW + 28 * 24 * HOUR,
  scopes: ['user:inference'],
  ...over,
});

const mk = (): string => mkdtempSync(join(tmpdir(), 'liveswap-'));
const writeJson = (file: string, o: unknown): void => writeFileSync(file, JSON.stringify(o, null, 2), { mode: 0o644 });
const readJson = (file: string): Record<string, any> => JSON.parse(readFileSync(file, 'utf8'));
const mode = (file: string): number => statSync(file).mode & 0o777;

function plant(over: { targetOauth?: Record<string, unknown> } = {}): { live: string; target: string } {
  const live = mk();
  const target = mk();
  writeJson(join(target, '.credentials.json'), { claudeAiOauth: over.targetOauth ?? oauth('TARGET-TOKEN') });
  writeJson(join(target, '.claude.json'), { oauthAccount: { accountUuid: 'uuid-B', emailAddress: 'b@x.test' } });
  writeJson(join(live, '.credentials.json'), {
    claudeAiOauth: oauth('LIVE-OLD'),
    mcpOAuth: { 'srv|live': { accessToken: 'MCP-SENTINEL' } },
  });
  writeJson(join(live, '.claude.json'), {
    oauthAccount: { accountUuid: 'uuid-A' },
    bypassPermissionsModeAccepted: true,
    hasTrustDialogAccepted: true,
    modelAccessCache: { stale: true },
    projects: { '/p': { x: 1 } },
  });
  return { live, target };
}

test('performLiveSwap: grafts target oauth, preserves mcpOAuth, swaps identity, drops account caches', async () => {
  const { live, target } = plant();
  const events: Array<[string, Record<string, unknown>]> = [];
  const r = await performLiveSwap(
    { liveConfigDir: live, targetConfigDir: target },
    { audit: (e, d) => events.push([e, d]), now: () => NOW },
  );
  assert.deepEqual(r, { ok: true, toAccountUuid: 'uuid-B' });
  const cred = readJson(join(live, '.credentials.json'));
  assert.equal(cred.claudeAiOauth.accessToken, 'TARGET-TOKEN-ACCESS');
  assert.equal(cred.mcpOAuth['srv|live'].accessToken, 'MCP-SENTINEL');
  const st = readJson(join(live, '.claude.json'));
  assert.equal(st.oauthAccount.accountUuid, 'uuid-B');
  assert.equal(st.bypassPermissionsModeAccepted, true);
  assert.equal(st.hasTrustDialogAccepted, true);
  assert.deepEqual(st.projects, { '/p': { x: 1 } });
  assert.ok(!('modelAccessCache' in st));
  assert.equal(mode(join(live, '.credentials.json')), 0o600);
  assert.equal(mode(join(live, '.claude.json')), 0o600);
  assert.equal(events.length, 1);
  assert.equal(events[0]![0], 'runway.live-swap');
  assert.equal(events[0]![1].toAccountUuid, 'uuid-B');
  assert.ok(!JSON.stringify(events).includes('TARGET-TOKEN'), 'no token value in the audit');
  assert.ok(!JSON.stringify(events).includes('LIVE-OLD'));
});

test('performLiveSwap: unhealthy target (no refreshToken) refuses and leaves the live dir unchanged', async () => {
  const { live, target } = plant({ targetOauth: oauth('TARGET-TOKEN', { refreshToken: '' }) });
  const beforeCred = readFileSync(join(live, '.credentials.json'));
  const beforeState = readFileSync(join(live, '.claude.json'));
  const r = await performLiveSwap({ liveConfigDir: live, targetConfigDir: target }, { now: () => NOW });
  assert.deepEqual(r, { ok: false, reason: 'target-unhealthy' });
  assert.deepEqual(readFileSync(join(live, '.credentials.json')), beforeCred);
  assert.deepEqual(readFileSync(join(live, '.claude.json')), beforeState);
});

test('performLiveSwap: missing target identity refuses with no write', async () => {
  const { live, target } = plant();
  writeJson(join(target, '.claude.json'), { oauthAccount: { accountUuid: '' } });
  const beforeCred = readFileSync(join(live, '.credentials.json'));
  const r = await performLiveSwap({ liveConfigDir: live, targetConfigDir: target }, { now: () => NOW });
  assert.deepEqual(r, { ok: false, reason: 'no-target-identity' });
  assert.deepEqual(readFileSync(join(live, '.credentials.json')), beforeCred);
});

test('performLiveSwap: a failing .claude.json write rolls the credential back to its original bytes', async () => {
  const { live, target } = plant();
  const beforeCred = readFileSync(join(live, '.credentials.json'));
  // Make the state-file's temp path a directory so writing it throws (EISDIR).
  mkdirSync(join(live, '.claude.json.tmp'));
  const r = await performLiveSwap({ liveConfigDir: live, targetConfigDir: target }, { now: () => NOW });
  assert.deepEqual(r, { ok: false, reason: 'write-failed', rolledBack: true });
  assert.deepEqual(readFileSync(join(live, '.credentials.json')), beforeCred);
});

test('performLiveSwap: rollback with NO prior credential removes the file the swap created', async () => {
  const live = mk();
  const target = mk();
  writeJson(join(target, '.credentials.json'), { claudeAiOauth: oauth('TARGET-TOKEN') });
  writeJson(join(target, '.claude.json'), { oauthAccount: { accountUuid: 'uuid-B' } });
  // The live dir has a .claude.json but NO .credentials.json -> the originalBytes === undefined branch.
  writeJson(join(live, '.claude.json'), { oauthAccount: { accountUuid: 'uuid-A' } });
  // Force the state write to throw so rollback fires on a credential that did not exist before.
  mkdirSync(join(live, '.claude.json.tmp'));
  const r = await performLiveSwap({ liveConfigDir: live, targetConfigDir: target }, { now: () => NOW });
  assert.deepEqual(r, { ok: false, reason: 'write-failed', rolledBack: true });
  assert.ok(!existsSync(join(live, '.credentials.json')), 'the credential the swap created was removed on rollback');
});

test('performLiveSwap: lock-busy maps ELOCKED, no write; and the swap runs INSIDE the lock', async () => {
  const { live, target } = plant();
  const beforeCred = readFileSync(join(live, '.credentials.json'));
  const busy = await performLiveSwap(
    { liveConfigDir: live, targetConfigDir: target },
    {
      now: () => NOW,
      withLocks: async () => {
        throw new ClaudeLockBusyError('x');
      },
    },
  );
  assert.deepEqual(busy, { ok: false, reason: 'lock-busy' });
  assert.deepEqual(readFileSync(join(live, '.credentials.json')), beforeCred);

  let inside = false;
  let writtenWhileInside = false;
  const r = await performLiveSwap(
    { liveConfigDir: live, targetConfigDir: target },
    {
      now: () => NOW,
      withLocks: (async (dir: string, fn: () => unknown) => {
        assert.equal(dir, live);
        inside = true;
        try {
          const out = await fn();
          writtenWhileInside = readJson(join(live, '.claude.json')).oauthAccount.accountUuid === 'uuid-B';
          return out;
        } finally {
          inside = false;
        }
      }) as never,
    },
  );
  assert.equal(r.ok, true);
  assert.equal(inside, false);
  assert.equal(writtenWhileInside, true);
});

test('targetIsHealthy + ACCOUNT_CACHE_KEYS', () => {
  assert.equal(targetIsHealthy({ claudeAiOauth: oauth('T') }, NOW), true);
  assert.equal(targetIsHealthy(undefined, NOW), false);
  assert.ok(ACCOUNT_CACHE_KEYS.includes('modelAccessCache'));
});
