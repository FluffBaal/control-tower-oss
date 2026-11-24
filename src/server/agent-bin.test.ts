// The boot-time `towerctl` wiring (SPEC test-kit reach): the launcher provisioned into ~/.ct/bin,
// the idempotent PATH prepend that lets agent panes AND the daemon's own loop checks resolve it,
// and the common auth-env floor that gives EVERY provider (shell included) the TOWER_PORT /
// TOWER_HOOK_TOKEN_FILE pair the CLI needs. These are the parts a typecheck cannot vouch for:
// which tree the launcher targets, that the prepend never double-adds, and that no adapter (or a
// custom def's env) diverges the floor pair from its ctx-derived values.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time. The operator's ~/.ct
// is never touched. No server, no tmux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchContext } from './adapters/types.js';
import type { ProviderDef } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-agent-bin-'));
process.env.CT_HOME = home;

const { renderTowerctlLauncher, ensureTowerctlLauncher, ensureBinOnPath, BIN_DIR, TOWERCTL_SCRIPT } =
  await import('./hooks.js');
const { shellAdapter } = await import('./adapters/shell.js');
const { claudeAdapter } = await import('./adapters/claude.js');
const { geminiAdapter } = await import('./adapters/gemini.js');
const { codexAdapter } = await import('./adapters/codex.js');
const { synthesizeAdapter } = await import('./providers/synthesize.js');

// ---- 1. launcher targets the tree that is actually running ----

test('renderTowerctlLauncher targets prod (dist) from a .js module url', () => {
  const script = renderTowerctlLauncher('/opt/app/dist/server/hooks.js', '/usr/bin/node');
  assert.ok(script.startsWith('#!/bin/sh\n'), 'has a POSIX-sh shebang');
  assert.ok(script.includes('/opt/app/dist/cli/towerctl.js'), 'execs the built CLI');
  assert.ok(script.includes('/usr/bin/node'), 'uses the absolute interpreter path');
  assert.ok(script.trimEnd().endsWith('"$@"'), 'forwards all args');
  assert.ok(!script.includes('src/cli'), 'never references the source tree in prod');
  assert.ok(!script.includes('tsx'), 'prod does not shell through tsx');
});

test('renderTowerctlLauncher targets dev (tsx + src) from a .ts module url', () => {
  const script = renderTowerctlLauncher('/opt/app/src/server/hooks.ts', '/usr/bin/node');
  assert.ok(script.startsWith('#!/bin/sh\n'), 'has a POSIX-sh shebang');
  assert.ok(script.includes('/opt/app/node_modules/.bin/tsx'), 'runs through tsx');
  assert.ok(script.includes('/opt/app/src/cli/towerctl.ts'), 'execs the source CLI');
  assert.ok(script.trimEnd().endsWith('"$@"'), 'forwards all args');
  assert.ok(!script.includes('/dist/'), 'never references the built tree in dev');
});

// ---- 2. write semantics: rewrite-not-skip, 0755, on every boot ----

test('ensureTowerctlLauncher writes a 0755 rewritten-every-boot launcher', () => {
  ensureTowerctlLauncher();
  assert.equal(TOWERCTL_SCRIPT, join(BIN_DIR, 'towerctl'));
  const first = readFileSync(TOWERCTL_SCRIPT, 'utf8');
  assert.ok(first.startsWith('#!/bin/sh\n'), 'starts with the shebang');
  assert.ok(first.includes('"$@"'), 'forwards args');
  assert.equal(statSync(TOWERCTL_SCRIPT).mode & 0o777, 0o755, 'mode is 0755');

  // Corrupt it, then a second call must RESTORE it (an `if (existsSync) return` short-circuit
  // would leave the corruption in place).
  writeFileSync(TOWERCTL_SCRIPT, 'garbage', 'utf8');
  ensureTowerctlLauncher();
  assert.equal(readFileSync(TOWERCTL_SCRIPT, 'utf8'), first, 'rewritten, not skipped');
});

// ---- 3. PATH prepend idempotency (segment match, not substring) ----

test('ensureBinOnPath prepends once, is idempotent, and matches by segment', () => {
  const saved = process.env.PATH;
  const count = (dir: string) => (process.env.PATH ?? '').split(':').filter((p) => p === dir).length;
  try {
    // Absent → prepended at the front.
    process.env.PATH = '/usr/bin:/bin';
    ensureBinOnPath();
    assert.ok((process.env.PATH ?? '').startsWith(`${BIN_DIR}:`), 'prepended at the front');
    assert.equal(count(BIN_DIR), 1, 'exactly one occurrence');

    // Double-call → still exactly one (a naive unconditional prepend would double it).
    ensureBinOnPath();
    assert.equal(count(BIN_DIR), 1, 'no double-add on a second call');

    // A `…binx` decoy must NOT count as present (substring `includes` would skip the prepend).
    process.env.PATH = `${BIN_DIR}x:/usr/bin`;
    ensureBinOnPath();
    assert.equal(count(BIN_DIR), 1, 'real segment added despite the decoy');
    assert.ok((process.env.PATH ?? '').includes(`${BIN_DIR}x`), 'decoy left intact');

    // Already mid-PATH → untouched (no duplicate, no reorder).
    process.env.PATH = `/usr/bin:${BIN_DIR}:/bin`;
    ensureBinOnPath();
    assert.equal(process.env.PATH, `/usr/bin:${BIN_DIR}:/bin`, 'left exactly as-is when already present');
  } finally {
    process.env.PATH = saved;
  }
});

// ---- 4. common auth-env floor for every spawnable adapter ----

const ctx = (): LaunchContext =>
  ({
    terminalId: 't-floor',
    projectId: 'p-floor',
    cwd: '/tmp/wt',
    repoPath: '/tmp/repo',
    hookTokenFile: '/tmp/secrets/hooktok-t-floor',
    hookScript: '/tmp/bin/ct-hook',
    towerPort: 4870,
    spoolDir: '/tmp/spool',
    configDir: '/tmp/cfg',
  }) as LaunchContext;

// Mirror the terminal-manager env merge for the auth pair: floor FIRST, adapter buildEnv on top.
const withFloor = (
  adapter: { buildEnv(c: LaunchContext): Record<string, string> },
  c: LaunchContext,
): Record<string, string> => ({
  TOWER_PORT: String(c.towerPort),
  TOWER_HOOK_TOKEN_FILE: c.hookTokenFile,
  ...adapter.buildEnv(c),
});

test('every spawnable adapter ends up with the ctx-derived auth pair (floor present, no divergence)', () => {
  const c = ctx();
  for (const [name, adapter] of [
    ['shell', shellAdapter], // sets NEITHER on its own — the floor is what supplies them
    ['claude', claudeAdapter],
    ['gemini', geminiAdapter],
    ['codex', codexAdapter],
  ] as const) {
    const env = withFloor(adapter, c);
    assert.equal(env.TOWER_PORT, String(c.towerPort), `${name}: TOWER_PORT from ctx`);
    assert.equal(env.TOWER_HOOK_TOKEN_FILE, c.hookTokenFile, `${name}: token file from ctx`);
  }
});

test('a custom def cannot clobber the floor pair via def.env (synthesize forces TOWER_* after def.env)', () => {
  const c = ctx();
  // A hostile def tries to point the pair at bogus values through its plain env.
  const def = {
    id: 'custom:floor-test',
    displayName: 'Floor Test',
    command: ['run'],
    env: { TOWER_PORT: '9999', TOWER_HOOK_TOKEN_FILE: '/evil/token', KEEP_ME: 'yes' },
    model: {},
    turn: { mode: 'dwell-only' },
    approveKeys: { approve: ['y'], deny: ['n'] },
    auth: { mode: 'none' },
    createdAt: '',
    updatedAt: '',
  } as unknown as ProviderDef;
  const adapter = synthesizeAdapter(def, undefined as never);
  const env = withFloor(adapter, c);
  assert.equal(env.TOWER_PORT, String(c.towerPort), 'def.env TOWER_PORT is overridden by the ctx value');
  assert.equal(env.TOWER_HOOK_TOKEN_FILE, c.hookTokenFile, 'def.env token file is overridden by the ctx value');
  assert.equal(env.KEEP_ME, 'yes', 'a non-reserved def.env var still passes through');
});

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true });
});
