// Claude first-run seed — writeHookConfig must leave a WORK or PLANNER terminal's .claude.json with
// hasCompletedOnboarding: true AND the spawn cwd registered trusted in the projects map (creating the
// file, or deep-merging into it without dropping keys), at 0600 — and must NOT seed a login pane,
// whose first-run flow stays interactive. The gaps this closes: a config dir holding a credential but
// no onboarding flag wedges a spawned claude at its theme-picker wizard, and an untrusted folder
// (every fresh worktree) wedges it at the per-folder trust prompt, which
// --dangerously-skip-permissions does not bypass.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time. writeHookConfig only
// touches the filesystem (mkdir + JSON writes) — no server, no tmux — so the real adapter method runs
// directly against a tmpdir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchContext } from './adapters/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-claude-onboarding-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { claudeAdapter } = await import('./adapters/claude.js');

let n = 0;
const freshCtx = (over: Partial<LaunchContext> = {}): { ctx: LaunchContext; configDir: string; cwd: string } => {
  const configDir = join(home, `cfg-${n}`);
  const cwd = over.cwd ?? join(home, `repo-${n}`);
  n++;
  return { configDir, cwd, ctx: { configDir, cwd, hookScript: 'ct-hook', ...over } as unknown as LaunchContext };
};
const stateFile = (configDir: string): string => join(configDir, '.claude.json');
const readState = (configDir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(stateFile(configDir), 'utf8'));
const readSettings = (configDir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));

test('a work spawn (purpose absent) creates .claude.json with the onboarding flag, cwd trust, mode 0600', async () => {
  const { ctx, configDir, cwd } = freshCtx();
  await claudeAdapter.writeHookConfig(ctx);
  const state = readState(configDir);
  assert.equal(state.hasCompletedOnboarding, true);
  assert.deepEqual(
    (state.projects as Record<string, unknown>)[cwd],
    { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    'the spawn folder is registered trusted, keyed by the exact cwd string',
  );
  assert.equal(statSync(stateFile(configDir)).mode & 0o777, 0o600, 'seed file matches the 0600 posture');
});

test('an explicit work purpose seeds too, and a re-run stays clean (idempotent)', async () => {
  const { ctx, configDir, cwd } = freshCtx({ purpose: 'work' });
  await claudeAdapter.writeHookConfig(ctx);
  await claudeAdapter.writeHookConfig(ctx);
  const state = readState(configDir);
  assert.equal(state.hasCompletedOnboarding, true);
  assert.deepEqual(
    state.projects,
    { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    'two spawns leave exactly one clean trusted entry',
  );
});

test('the seed merges: a pre-existing oauthAccount survives and a false flag is forced true', async () => {
  const { ctx, configDir } = freshCtx();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    stateFile(configDir),
    JSON.stringify({ oauthAccount: { emailAddress: 'op@example.com' }, hasCompletedOnboarding: false }),
  );
  await claudeAdapter.writeHookConfig(ctx);
  const state = readState(configDir);
  assert.deepEqual(state.oauthAccount, { emailAddress: 'op@example.com' }, 'existing keys must survive the merge');
  assert.equal(state.hasCompletedOnboarding, true, 'the flag is always forced true for work');
});

test("the trust seed DEEP-merges: other trusted folders, this folder's own keys, and top-level keys survive", async () => {
  const { ctx, configDir, cwd } = freshCtx();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    stateFile(configDir),
    JSON.stringify({
      oauthAccount: { emailAddress: 'op@example.com' },
      projects: {
        '/other/dir': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
        [cwd]: { exampleSetting: 'keep' },
      },
    }),
  );
  await claudeAdapter.writeHookConfig(ctx);
  const state = readState(configDir);
  const projects = state.projects as Record<string, Record<string, unknown>>;
  assert.deepEqual(
    projects['/other/dir'],
    { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    "another folder's trust survives — a shallow merge of the projects map would wipe it",
  );
  assert.deepEqual(
    projects[cwd],
    { exampleSetting: 'keep', hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    "this folder's existing entry keys survive the trust stamp",
  );
  assert.deepEqual(state.oauthAccount, { emailAddress: 'op@example.com' }, 'top-level keys survive');
  assert.equal(state.hasCompletedOnboarding, true);
});

test('a planner spawn IS seeded (driven programmatically, like work)', async () => {
  const { ctx, configDir, cwd } = freshCtx({ purpose: 'planner' });
  await claudeAdapter.writeHookConfig(ctx);
  const state = readState(configDir);
  assert.equal(state.hasCompletedOnboarding, true, 'a planner must skip the wizard too');
  assert.equal(
    (state.projects as Record<string, Record<string, unknown>>)[cwd]?.hasTrustDialogAccepted,
    true,
    'a planner gets the folder-trust seed too — the gate is shared, not work-only',
  );
});

test('a login spawn is never seeded — it keeps the interactive first-run flow — but still gets hooks', async () => {
  const { ctx, configDir } = freshCtx({ purpose: 'login' });
  await claudeAdapter.writeHookConfig(ctx);
  assert.equal(existsSync(stateFile(configDir)), false, 'login keeps the interactive first-run flow');
  assert.equal(existsSync(join(configDir, 'settings.json')), true, 'login still gets hook config');
});

test('an autonomy spawn (skipPermissions) seeds the bypass acceptance alongside the onboarding flag and cwd trust', async () => {
  const { ctx, configDir, cwd } = freshCtx({ skipPermissions: true });
  await claudeAdapter.writeHookConfig(ctx);
  const state = readState(configDir);
  assert.equal(state.bypassPermissionsModeAccepted, true, 'an armed spawn plants the one-time disclaimer acceptance');
  // claude 2.1.316 moved the disclaimer-skip to settings.json — an armed spawn must plant it there too, or the
  // pane (especially a live-slot whose seeded settings.json lacks the account copy) wedges at the bypass gate.
  assert.equal(
    readSettings(configDir).skipDangerousModePermissionPrompt,
    true,
    'an armed spawn plants the 2.1.316 settings.json disclaimer-skip (skipDangerousModePermissionPrompt)',
  );
  // The two existing seeds must still be there — the bypass flag rides the same write, it does not replace them.
  assert.equal(state.hasCompletedOnboarding, true);
  assert.deepEqual(
    (state.projects as Record<string, unknown>)[cwd],
    { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    'the folder trust seed still lands on an autonomy spawn',
  );
});

test('a NON-autonomy spawn leaves bypassPermissionsModeAccepted TRULY ABSENT — absent and explicit-false both', async () => {
  // The load-bearing negative: an unconditional seed would silently accept the disclaimer for every
  // account on every spawn, and every other test here would still pass under that mutation. Assert the
  // key is absent (via `in`), not merely falsy — a seeded `false` is still a change to the file.
  const absent = freshCtx(); // skipPermissions omitted
  await claudeAdapter.writeHookConfig(absent.ctx);
  assert.equal(
    'bypassPermissionsModeAccepted' in readState(absent.configDir),
    false,
    'an ordinary spawn must not plant the bypass acceptance at all',
  );
  assert.equal(
    'skipDangerousModePermissionPrompt' in readSettings(absent.configDir),
    false,
    'an ordinary spawn must not plant the settings.json disclaimer-skip either (settings.json exists for the hooks)',
  );
  const explicitFalse = freshCtx({ skipPermissions: false });
  await claudeAdapter.writeHookConfig(explicitFalse.ctx);
  assert.equal(
    'bypassPermissionsModeAccepted' in readState(explicitFalse.configDir),
    false,
    'skipPermissions:false is not truthy — the key stays absent, never a stored false',
  );
  assert.equal(
    'skipDangerousModePermissionPrompt' in readSettings(explicitFalse.configDir),
    false,
    'skipPermissions:false — the settings.json disclaimer-skip stays absent too',
  );
});

test('the bypass seed deep-merges: an armed re-run preserves other folders trust and this folder own keys', async () => {
  const { ctx, configDir, cwd } = freshCtx({ skipPermissions: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    stateFile(configDir),
    JSON.stringify({
      oauthAccount: { emailAddress: 'op@example.com' },
      projects: {
        '/other/dir': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
        [cwd]: { exampleSetting: 'keep' },
      },
    }),
  );
  await claudeAdapter.writeHookConfig(ctx);
  const state = readState(configDir);
  assert.equal(state.bypassPermissionsModeAccepted, true, 'the bypass flag is added');
  const projects = state.projects as Record<string, Record<string, unknown>>;
  assert.deepEqual(
    projects['/other/dir'],
    { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    "another folder's trust survives the bypass-seeding write",
  );
  assert.deepEqual(
    projects[cwd],
    { exampleSetting: 'keep', hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    "this folder's existing entry keys survive",
  );
  assert.deepEqual(state.oauthAccount, { emailAddress: 'op@example.com' }, 'top-level keys survive');
});

test('idempotency: two armed spawns leave the bypass flag exactly true, state otherwise clean', async () => {
  const { ctx, configDir, cwd } = freshCtx({ skipPermissions: true });
  await claudeAdapter.writeHookConfig(ctx);
  await claudeAdapter.writeHookConfig(ctx);
  const state = readState(configDir);
  assert.equal(state.bypassPermissionsModeAccepted, true);
  assert.equal(state.hasCompletedOnboarding, true);
  assert.deepEqual(
    state.projects,
    { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    'two armed spawns leave exactly one clean trusted entry',
  );
});

test('fail-safe: a login pane is never seeded even with skipPermissions set (the adapter belt to resolveAutoAccept)', async () => {
  // resolveAutoAccept upstream never resolves skipPermissions:true for a login pane; this tests the
  // adapter's OWN belt — the seed must stay inside the purpose allowlist, so a hand-built login ctx
  // writes no state file at all (the disclaimer, and the whole first-run flow, stay interactive).
  const { ctx, configDir } = freshCtx({ purpose: 'login', skipPermissions: true });
  await claudeAdapter.writeHookConfig(ctx);
  assert.equal(existsSync(stateFile(configDir)), false, 'a login pane keeps the interactive flow — no seed, bypass or otherwise');
  // The settings.json disclaimer-skip rides the SAME unattended belt — a login pane must not get it either,
  // even hand-built with skipPermissions (settings.json itself still exists, for the hooks).
  assert.equal(
    'skipDangerousModePermissionPrompt' in readSettings(configDir),
    false,
    'a login pane never gets the settings.json disclaimer-skip, even armed',
  );
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
