// SPEC-RUNWAY live-swap stage A2 -- TerminalManager behavior:
//   - liveSwapTerminal: refusals (nothing mutated, nothing locked), success = record flip with NO respawn
//     fan-out, every LiveSwapResult passed through, and the mutex that is mutually exclusive with
//     rotate/restart (both directions).
//   - createTerminal's slot: seeded only under the gate (vault stays the config dir otherwise), a seed
//     failure falls back without breaking the spawn, and kill removes the slot.
// performLiveSwap is INJECTED (a fake); no real claude. The createTerminal block drives a real scratch tmux
// and self-skips when tmux is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Terminal } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-tm-liveswap-test-'));
process.env.CT_HOME = home;
const pexec = promisify(execFile);
const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { TerminalManager, sharedConfigDirFor } = await import('./terminal-manager.js');
const { SkillStore } = await import('./skills/store.js');
const { ProviderStore } = await import('./providers/store.js');
const { initProviderRegistry } = await import('./providers/registry.js');
initProviderRegistry(new ProviderStore());
const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);

type SwapFn = NonNullable<ConstructorParameters<typeof TerminalManager>[1]['liveSwap']>;

function harness(opts: { liveSwap?: SwapFn; runway?: { enabled: boolean; liveSwap: boolean; pool: string[] } } = {}) {
  const store = new Store();
  const profiles = new Map<string, any>();
  const addProfile = (id: string, extra: Record<string, unknown> = {}, files = true): any => {
    const configDir = mkdtempSync(join(home, `vault-${id}-`));
    if (files) {
      writeFileSync(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: `r-${id}` } }), { mode: 0o600 });
      writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: `u-${id}` } }), { mode: 0o600 });
    }
    const p = { id, provider: 'claude-code', configDir, label: id, createdAt: new Date().toISOString(), ...extra };
    profiles.set(id, p);
    return p;
  };
  const deps = {
    hookTokens: { tokenFile: (id: string) => join(home, `tok-${id}`), ensure: () => 'tok', forget: () => {} },
    hookScript: '/dev/null',
    towerPort: 0,
    worktrees: {},
    accounts: { getProfile: (id: string) => profiles.get(id), getIdentity: () => undefined },
    broker: { forget: () => {}, ensure: () => {} },
    credentialScript: '/dev/null',
    brokerSock: '/dev/null',
    leases: { releaseAllFor: () => {} },
    providers: { get: () => undefined, hasSecret: () => false },
    skills: new SkillStore(),
    maxTerminals: () => 50,
    ...(opts.runway ? { runway: () => opts.runway! } : {}),
    ...(opts.liveSwap ? { liveSwap: opts.liveSwap } : {}),
  } as unknown as ConstructorParameters<typeof TerminalManager>[1];
  const tm = new TerminalManager(store, deps);
  const repoPath = mkdtempSync(join(home, 'repo-'));
  const project = { id: `pr-${Math.random().toString(36).slice(2)}`, name: 'p', repoPath, scaffoldMode: 'zero-footprint' as const, createdAt: new Date().toISOString() };
  store.upsertProject(project);
  const seed = (over: Partial<Terminal> = {}): Terminal => {
    const t: Terminal = {
      id: `trm-${Math.random().toString(36).slice(2, 8)}`, projectId: project.id, title: 'b', provider: 'claude-code',
      tmuxSocket: 'tmls-unused', cwd: repoPath, command: ['sh'], state: 'idle', createdAt: new Date().toISOString(), ...over,
    };
    store.upsertTerminal(t);
    return t;
  };
  return { store, tm, addProfile, seed, project };
}

const OK = { ok: true as const, toAccountUuid: 'u-B' };

test('liveSwapTerminal: success flips profileId, passes slot->target dirs, and does NOT respawn', async () => {
  const calls: Array<{ liveConfigDir: string; targetConfigDir: string }> = [];
  const h = harness({ liveSwap: async (i) => { calls.push(i); return OK; } });
  const a = h.addProfile('A');
  const b = h.addProfile('B');
  const t = h.seed({ profileId: 'A', liveSlotDir: '/slots/x' });
  const res = await h.tm.liveSwapTerminal(t.id, 'B');
  assert.deepEqual(res, OK);
  assert.deepEqual(calls, [{ liveConfigDir: '/slots/x', targetConfigDir: b.configDir }]);
  const after = h.store.getTerminal(t.id)!;
  assert.equal(after.profileId, 'B');
  assert.equal(after.liveSlotDir, '/slots/x', 'slot kept');
  assert.equal(after.sessionId, t.sessionId, 'no new session minted (no respawn)');
  assert.equal(after.rotatingFrom, undefined);
  assert.equal(after.state, 'idle', 'state not re-latched (process untouched)');
  void a;
});

test('liveSwapTerminal: passes every non-ok LiveSwapResult through and leaves the record alone', async () => {
  const results = [
    { ok: false, reason: 'lock-busy' },
    { ok: false, reason: 'target-unhealthy' },
    { ok: false, reason: 'no-target-oauth' },
    { ok: false, reason: 'no-target-identity' },
    { ok: false, reason: 'write-failed', rolledBack: true },
    { ok: false, reason: 'write-failed', rolledBack: false },
  ] as const;
  for (const r of results) {
    const h = harness({ liveSwap: async () => r as any });
    h.addProfile('A');
    h.addProfile('B');
    const t = h.seed({ profileId: 'A', liveSlotDir: '/slots/x' });
    assert.deepEqual(await h.tm.liveSwapTerminal(t.id, 'B'), r);
    assert.equal(h.store.getTerminal(t.id)!.profileId, 'A', 'a failed swap never flips the record');
  }
});

test('liveSwapTerminal: refusals return before the primitive runs', async () => {
  let ran = 0;
  const h = harness({ liveSwap: async () => { ran++; return OK; } });
  h.addProfile('A');
  h.addProfile('B');
  h.addProfile('NOCRED', {}, false);
  const slotted = h.seed({ profileId: 'A', liveSlotDir: '/slots/x' });
  const plain = h.seed({ profileId: 'A' });
  const killed = h.seed({ profileId: 'A', liveSlotDir: '/slots/y', state: 'killed' });
  const reason = async (id: string, to: string, o?: { isReserved?: (x: string) => boolean }) => (await h.tm.liveSwapTerminal(id, to, o) as any).reason;
  assert.equal(await reason(plain.id, 'B'), 'not-slotted');
  assert.equal(await reason('nope', 'B'), 'gone');
  assert.equal(await reason(killed.id, 'B'), 'gone');
  assert.equal(await reason(slotted.id, 'ghost'), 'unknown-target');
  assert.equal(await reason(slotted.id, 'A'), 'same-account');
  assert.equal(await reason(slotted.id, 'B', { isReserved: () => true }), 'reserved-target');
  assert.equal(await reason(slotted.id, 'NOCRED'), 'unsigned-target');
  assert.equal(ran, 0, 'primitive never invoked');

  const bare = harness();
  bare.addProfile('A');
  bare.addProfile('B');
  const s = bare.seed({ profileId: 'A', liveSlotDir: '/slots/x' });
  assert.equal(((await bare.tm.liveSwapTerminal(s.id, 'B')) as any).reason, 'not-configured');
});

test('mutex: a live swap in flight blocks rotate (throws) and restart (no-op), and releases afterwards', async () => {
  let release!: () => void;
  const parked = new Promise<void>((r) => { release = r; });
  const h = harness({ liveSwap: async () => { await parked; return OK; } });
  h.addProfile('A');
  h.addProfile('B');
  h.addProfile('C');
  const t = h.seed({ profileId: 'A', liveSlotDir: '/slots/x' });
  const first = h.tm.liveSwapTerminal(t.id, 'B');
  // second swap: refused
  assert.equal(((await h.tm.liveSwapTerminal(t.id, 'C')) as any).reason, 'in-progress');
  await assert.rejects(h.tm.rotateTerminal(t.id, 'C'), /live credential swap is in progress/);
  const r = await h.tm.restartTerminal(t.id);
  assert.equal(r.alreadyRestarting, true);
  release();
  assert.deepEqual(await first, OK);
  assert.equal(((await h.tm.liveSwapTerminal(t.id, 'C')) as any).ok, true, 'mutex released');
});

test('mutex: an in-flight rotate or restart makes the live swap refuse in-progress (never interleave)', async () => {
  let ran = 0;
  const h = harness({ liveSwap: async () => { ran++; return OK; } });
  h.addProfile('A');
  h.addProfile('B');
  const t = h.seed({ profileId: 'A', liveSlotDir: '/slots/x' });
  const priv = h.tm as unknown as { rotating: Set<string>; restartInFlight: Set<string> };
  priv.rotating.add(t.id);
  assert.equal(((await h.tm.liveSwapTerminal(t.id, 'B')) as any).reason, 'in-progress');
  priv.rotating.delete(t.id);
  priv.restartInFlight.add(t.id);
  assert.equal(((await h.tm.liveSwapTerminal(t.id, 'B')) as any).reason, 'in-progress');
  priv.restartInFlight.delete(t.id);
  assert.equal(ran, 0);
});

// ---- createTerminal slot ----

// Keep the pane alive while the tests inspect its environment, even without Claude Code installed.
const fakeBin = join(home, 'bin');
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\nexec cat\n', { mode: 0o755 });
process.env.PATH = `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`;

const cleanSock = async (term: Terminal): Promise<void> => {
  await pexec('tmux', ['-L', term.tmuxSocket, 'kill-server']).catch(() => {});
};

test('createTerminal slot: seeded under the gate; vault stays untouched; kill removes the slot', { skip: haveTmux ? false : 'tmux is not installed' }, async () => {
  const h = harness({ runway: { enabled: true, liveSwap: true, pool: ['A'] } });
  const a = h.addProfile('A');
  const term = await h.tm.createTerminal(h.project, { provider: 'claude-code', profileId: 'A' });
  try {
    const slot = join(paths.slots, term.id);
    assert.equal(term.liveSlotDir, slot);
    assert.equal(h.store.getTerminal(term.id)!.liveSlotDir, slot);
    assert.equal(readFileSync(join(slot, '.credentials.json'), 'utf8'), readFileSync(join(a.configDir, '.credentials.json'), 'utf8'));
    assert.equal(JSON.parse(readFileSync(join(slot, '.claude.json'), 'utf8')).oauthAccount.accountUuid, 'u-A', 'identity seeded before hooks augment it');
    const { stdout } = await pexec('tmux', ['-L', term.tmuxSocket, 'show-environment', '-t', 'main']);
    assert.match(stdout, new RegExp(`CLAUDE_CONFIG_DIR=${slot}`), 'the pane runs under the slot');
    await h.tm.killTerminal(term.id);
    assert.equal(existsSync(slot), false, 'slot removed on kill');
    assert.equal(existsSync(join(a.configDir, '.credentials.json')), true, 'vault intact');
    assert.equal(h.store.getTerminal(term.id)!.liveSlotDir, undefined);
  } finally {
    await cleanSock(term);
  }
});

test('createTerminal slot: NOT created when flag off / runway off / not in pool / profile-less (vault is the config dir)', { skip: haveTmux ? false : 'tmux is not installed' }, async () => {
  const cases: Array<{ name: string; runway?: { enabled: boolean; liveSwap: boolean; pool: string[] }; extra?: Record<string, unknown>; profile: boolean }> = [
    { name: 'no runway dep', profile: true },
    { name: 'liveSwap off', runway: { enabled: true, liveSwap: false, pool: ['A'] }, profile: true },
    { name: 'runway disabled', runway: { enabled: false, liveSwap: true, pool: ['A'] }, profile: true },
    { name: 'account not in pool', runway: { enabled: true, liveSwap: true, pool: ['Z'] }, profile: true },
    { name: 'empty pool', runway: { enabled: true, liveSwap: true, pool: [] }, profile: true },
    { name: 'profile-less', runway: { enabled: true, liveSwap: true, pool: ['A'] }, profile: false },
  ];
  const shared = sharedConfigDirFor('claude-code');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'r-shared' } }), { mode: 0o600 });
  for (const c of cases) {
    const h = harness(c.runway ? { runway: c.runway } : {});
    const a = h.addProfile('A', c.extra ?? {});
    const term = await h.tm.createTerminal(h.project, { provider: 'claude-code', ...(c.profile ? { profileId: 'A' } : {}) });
    try {
      assert.equal(term.liveSlotDir, undefined, `${c.name}: no slot recorded`);
      assert.equal(existsSync(join(paths.slots, term.id)), false, `${c.name}: no slot dir`);
      if (c.profile) {
        const { stdout } = await pexec('tmux', ['-L', term.tmuxSocket, 'show-environment', '-t', 'main']);
        assert.match(stdout, new RegExp(`CLAUDE_CONFIG_DIR=${a.configDir}`), `${c.name}: runs under the vault`);
      }
    } finally {
      await cleanSock(term);
    }
  }
});

test('createTerminal slot: a seed failure falls back to the vault and the spawn still succeeds', { skip: haveTmux ? false : 'tmux is not installed' }, async () => {
  const h = harness({ runway: { enabled: true, liveSwap: true, pool: ['A'] } });
  const a = h.addProfile('A');
  rmSync(join(a.configDir, '.claude.json')); // credential probe still passes; the seed (needs both files) fails
  const origErr = console.error;
  console.error = () => {};
  let term: Terminal | undefined;
  try {
    term = await h.tm.createTerminal(h.project, { provider: 'claude-code', profileId: 'A' });
  } finally {
    console.error = origErr;
  }
  try {
    assert.equal(term.liveSlotDir, undefined);
    assert.equal(existsSync(join(paths.slots, term.id)), false, 'half-built slot cleaned up');
    const { stdout } = await pexec('tmux', ['-L', term.tmuxSocket, 'show-environment', '-t', 'main']);
    assert.match(stdout, new RegExp(`CLAUDE_CONFIG_DIR=${a.configDir}`));
  } finally {
    await cleanSock(term);
  }
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
