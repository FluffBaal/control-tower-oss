// SPEC-TERMINAL-OPS §1 — the credential shred's refusal matrix and the boot sweep's trust interlock.
// These two are the wave's DESTRUCTIVE surface: shredAccountDir removes a directory outright, and
// profilesLoadedOk decides whether the boot sweep is allowed to run at all. Both were written pure and
// exported so the policy could be exercised directly, so exercise it.
//
// CT_HOME is set before the module loads: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-accounts-test-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { Accounts, shredAccountDir, accountsRoot, canonicalAccountPath } = await import('./accounts.js');

const profilesFile = join(paths.config, 'profiles.json');
/** A directory under the accounts root holding a fake credential, as createProfile would leave it. */
function plantAccountDir(...segments: string[]): string {
  const dir = join(accountsRoot(), ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth.json'), 'CREDENTIAL', { mode: 0o600 });
  return dir;
}
/** A directory OUTSIDE the accounts root that no shred may ever reach. */
function plantOutside(name: string): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'precious'), 'DO NOT DELETE');
  return dir;
}

test('shredAccountDir refusal matrix', async (t) => {
  await t.test('removes a plain directory inside the accounts root', () => {
    const dir = plantAccountDir('codex', 'happy-path');
    assert.equal(shredAccountDir(dir), true);
    assert.equal(existsSync(dir), false);
  });

  await t.test('refuses a directory outside the accounts root', () => {
    const outside = plantOutside('outside-target');
    assert.equal(shredAccountDir(outside), false);
    assert.equal(existsSync(join(outside, 'precious')), true);
  });

  await t.test('refuses the accounts root itself', () => {
    const dir = plantAccountDir('codex', 'root-guard-survivor');
    assert.equal(shredAccountDir(accountsRoot()), false);
    assert.equal(existsSync(dir), true, 'the root refusal must not have taken its children');
  });

  await t.test('refuses a ".." escape that resolves outside the root', () => {
    const outside = plantOutside('dotdot-target');
    assert.equal(shredAccountDir(join(accountsRoot(), 'codex', '..', '..', 'dotdot-target')), false);
    assert.equal(existsSync(join(outside, 'precious')), true);
  });

  await t.test('refuses an empty path (which resolves to the process cwd)', () => {
    assert.equal(shredAccountDir(''), false);
  });

  await t.test('refuses a symlinked FINAL component even when it points inside the root', () => {
    const real = plantAccountDir('codex', 'link-target');
    const link = join(accountsRoot(), 'codex', 'final-link');
    symlinkSync(resolve(real), link);
    assert.equal(shredAccountDir(link), false);
    assert.equal(existsSync(join(real, 'auth.json')), true, 'the link must not be followed');
    rmSync(link);
  });

  await t.test('refuses a symlinked INTERMEDIATE component that escapes the root', () => {
    // The bypass a textual prefix test cannot see: resolve() collapses '..' but never follows links,
    // so `<root>/escape/.claude` would "start with" the root while living entirely outside it.
    const outside = plantOutside('escape-target');
    mkdirSync(join(outside, '.claude'), { recursive: true });
    writeFileSync(join(outside, '.claude', '.credentials.json'), 'CREDENTIAL');
    const hatch = join(accountsRoot(), 'escape-hatch');
    symlinkSync(outside, hatch);
    assert.equal(shredAccountDir(join(hatch, '.claude')), false);
    assert.equal(existsSync(join(outside, '.claude', '.credentials.json')), true);
    rmSync(hatch);
  });

  await t.test('reports success for a directory that is already gone', () => {
    assert.equal(shredAccountDir(join(accountsRoot(), 'codex', 'never-existed')), true);
  });

  await t.test('refuses a plain FILE inside the root', () => {
    const file = join(accountsRoot(), 'codex', 'stray.txt');
    mkdirSync(join(accountsRoot(), 'codex'), { recursive: true });
    writeFileSync(file, 'not a dir');
    assert.equal(shredAccountDir(file), false);
    assert.equal(existsSync(file), true);
  });
});

test('canonicalAccountPath', async (t) => {
  await t.test('resolves a symlinked path to its real location', () => {
    const real = plantAccountDir('codex', 'canon-real');
    const link = join(accountsRoot(), 'codex', 'canon-link');
    symlinkSync(resolve(real), link);
    assert.equal(canonicalAccountPath(link), canonicalAccountPath(real));
    rmSync(link);
  });
  await t.test('falls back to resolve() for a path that does not exist', () => {
    const missing = join(accountsRoot(), 'codex', 'not-here');
    assert.equal(canonicalAccountPath(missing), resolve(missing));
  });
});

test('deleteProfile shreds the account dir, and reports when it could not', async (t) => {
  await t.test('happy path: record gone, dir gone, shredded true', () => {
    rmSync(profilesFile, { force: true });
    const accounts = new Accounts();
    const p = accounts.createProfile('codex', 'to-delete');
    writeFileSync(join(p.configDir, 'auth.json'), 'CREDENTIAL', { mode: 0o600 });
    assert.deepEqual(accounts.deleteProfile(p.id), { existed: true, shredded: true });
    assert.equal(existsSync(p.configDir), false);
    assert.equal(accounts.getProfile(p.id), undefined);
  });

  await t.test('a configDir outside the root: record gone, dir untouched, shredded false', () => {
    rmSync(profilesFile, { force: true });
    const outside = plantOutside('tampered-target');
    const accounts = new Accounts();
    const p = accounts.createProfile('codex', 'tampered');
    // Hand-edit the record the way a tampered profiles.json would, then reload.
    const raw = [{ ...p, configDir: outside }];
    writeFileSync(profilesFile, JSON.stringify(raw, null, 2));
    const reloaded = new Accounts();
    assert.deepEqual(reloaded.deleteProfile(p.id), { existed: true, shredded: false });
    assert.equal(existsSync(join(outside, 'precious')), true);
  });

  await t.test('an unknown id is a no-op', () => {
    const accounts = new Accounts();
    assert.deepEqual(accounts.deleteProfile('no-such-id'), { existed: false, shredded: false });
  });
});

test('profilesLoadedOk — the boot sweep interlock', async (t) => {
  const good = {
    id: 'aaaaaaaa',
    provider: 'codex',
    label: 'good',
    configDir: join(accountsRoot(), 'codex', 'good-aaaaaaaa'),
    createdAt: new Date().toISOString(),
  };
  const cases: { name: string; write?: string; trusted: boolean; profiles: number }[] = [
    { name: 'absent file (fresh install)', trusted: true, profiles: 0 },
    { name: 'clean list', write: JSON.stringify([good]), trusted: true, profiles: 1 },
    { name: 'cleanly empty list (last account deleted)', write: '[]', trusted: true, profiles: 0 },
    { name: 'one malformed record among good ones', write: JSON.stringify([good, { id: 5 }]), trusted: false, profiles: 1 },
    { name: 'every record malformed', write: JSON.stringify([{ id: 5 }]), trusted: false, profiles: 0 },
    { name: 'unparseable file', write: '{ not json', trusted: false, profiles: 0 },
    { name: 'not an array', write: '{"a":1}', trusted: false, profiles: 0 },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      rmSync(profilesFile, { force: true });
      if (c.write !== undefined) writeFileSync(profilesFile, c.write);
      const accounts = new Accounts();
      assert.equal(accounts.profilesLoadedOk(), c.trusted);
      assert.equal(accounts.listProfiles().length, c.profiles, 'good records must survive a partial load');
    });
  }
});

test('adoptMachineLogin preserves a re-adopted profile\'s bypass acceptance and trust map (dest-preserving merge)', () => {
  rmSync(profilesFile, { force: true });
  // A scratch machine login: point CLAUDE_CONFIG_DIR at a controlled dir holding only a credential,
  // so the merge's SOURCE carries no state of its own to override the destination with.
  const machineDir = join(home, 'machine-claude');
  mkdirSync(machineDir, { recursive: true });
  writeFileSync(join(machineDir, '.credentials.json'), 'MACHINE-CREDENTIAL', { mode: 0o600 });
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = machineDir;
  try {
    const accounts = new Accounts();
    const p = accounts.createProfile('claude-code', 'reseed');
    // Pre-seed the destination the way the per-spawn onboarding seed and prior spawns leave it: the
    // durable autonomy acceptance, a repo's trust entry, and an unrelated key that must not be dropped.
    const stateDest = join(p.configDir, '.claude.json');
    writeFileSync(
      stateDest,
      JSON.stringify({
        bypassPermissionsModeAccepted: true,
        projects: { '/some/repo': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
        oauthAccount: { emailAddress: 'op@example.com' },
      }),
    );
    accounts.adoptMachineLogin(p.id);
    const state = JSON.parse(readFileSync(stateDest, 'utf8')) as Record<string, unknown>;
    assert.equal(state.bypassPermissionsModeAccepted, true, 're-adopt must not wipe the autonomy acceptance');
    assert.deepEqual(
      (state.projects as Record<string, unknown>)['/some/repo'],
      { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      're-adopt must not wipe the folder trust map',
    );
    assert.deepEqual(state.oauthAccount, { emailAddress: 'op@example.com' }, 'unrelated destination keys survive');
    assert.equal(state.hasCompletedOnboarding, true, 'the onboarding flag is always forced true');
    assert.equal(existsSync(join(p.configDir, '.credentials.json')), true, 'the machine credential was adopted into the isolated dir');
  } finally {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
  }
});

test('setCredential re-tightens a pre-existing world-readable credential file to 0600', () => {
  const accounts = new Accounts();
  const identity = accounts.createIdentity('acct', 'Name', 'e@example.com');
  const cred = join(paths.secrets, `ghcred-${identity.id}`);
  // Simulate a credential file that already exists with looser bits (an earlier tool / prior version).
  // writeFileSync's {mode} won't re-tighten it on overwrite, so without the pre-write chmod the PAT
  // would land in a world-readable file.
  writeFileSync(cred, 'OLD', { mode: 0o644 });
  chmodSync(cred, 0o644); // force loose regardless of umask
  accounts.setCredential(identity.id, 'ghp_secrettoken');
  assert.equal(statSync(cred).mode & 0o777, 0o600, 'the PAT file is tightened to 0600');
  assert.equal(readFileSync(cred, 'utf8'), 'ghp_secrettoken', 'and holds the new token');
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));

test('renameProfile: label-only, configDir unchanged, persists across reload; unknown id → undefined', () => {
  const a = new Accounts();
  const p = a.createProfile('claude-code', 'Wrong Name');
  const renamed = a.renameProfile(p.id, 'Right Name');
  assert.equal(renamed?.label, 'Right Name');
  assert.equal(renamed?.id, p.id);
  assert.equal(renamed?.configDir, p.configDir, 'configDir must NOT change on rename (holds the credential)');
  // Persisted: a fresh Accounts() reloads the new label + same dir.
  const reloaded = new Accounts().getProfile(p.id);
  assert.equal(reloaded?.label, 'Right Name');
  assert.equal(reloaded?.configDir, p.configDir);
  assert.equal(a.renameProfile('no-such-id', 'x'), undefined);
});
