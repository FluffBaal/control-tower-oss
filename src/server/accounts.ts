// Provider accounts (AgentProfile) + GitHub identities (GitHubIdentity), stored as
// JSON config. Push credentials for identities live 0600 under secrets/ and are read
// ONLY by the credential broker (SPEC D13) — never handed to agents, never in config.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  rmSync,
  chmodSync,
  accessSync,
  statSync,
  lstatSync,
  realpathSync,
  constants,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { paths } from './paths.js';
import { shortId } from './ids.js';
import { providerIdSchema } from './store.js';
import type { AgentProfile, GitHubIdentity, ProviderId } from '../shared/types.js';

const profilesFile = join(paths.config, 'profiles.json');
const identitiesFile = join(paths.config, 'identities.json');

const ProfileSchema = z.object({
  id: z.string(),
  provider: providerIdSchema, // SPEC-PROVIDERS §1.2 — shared gate (built-ins + custom:<slug>)
  label: z.string(),
  configDir: z.string(),
  createdAt: z.string(),
});
const IdentitySchema = z.object({
  id: z.string(),
  label: z.string(),
  gitName: z.string(),
  gitEmail: z.string(),
  hasCredential: z.boolean(),
  createdAt: z.string(),
});

/**
 * Read a JSON array config, salvaging PER ENTRY: one malformed record drops only itself and every
 * good record still loads. Load-bearing beyond convenience — a whole-file `z.array().parse()` turns
 * a single bad profile into an EMPTY profile list, which would make the §1.3 orphan sweep believe no
 * account dir is referenced and shred every live credential.
 *
 * `dropped` is what makes the salvage safe: a dropped profile's dir is still referenced by a record
 * sitting in profiles.json, so the sweep must not treat the surviving list as the whole truth. The
 * unreadable/non-array cases report `dropped: 1` for the same reason — SOMETHING was there and did
 * not load. A clean read of `[]` reports `dropped: 0`, so a legitimately empty account list still
 * sweeps (deleting the last account must not disable the sweep forever).
 */
function readArr<T>(file: string, schema: z.ZodType<T>): { items: T[]; fileExists: boolean; dropped: number } {
  if (!existsSync(file)) return { items: [], fileExists: false, dropped: 0 };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[accounts] unreadable ${file} (${(err as Error).message}); starting empty`);
    return { items: [], fileExists: true, dropped: 1 };
  }
  if (!Array.isArray(raw)) {
    console.error(`[accounts] ${file} is not a JSON array; starting empty`);
    return { items: [], fileExists: true, dropped: 1 };
  }
  const items: T[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const res = schema.safeParse(entry);
    if (res.success) {
      items.push(res.data);
    } else {
      dropped++;
      console.error(`[accounts] dropping a malformed record in ${file}: ${res.error.issues[0]?.message ?? 'invalid'}`);
    }
  }
  return { items, fileExists: true, dropped };
}
function writeArr(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

function credFile(identityId: string): string {
  return join(paths.secrets, `ghcred-${identityId}`);
}

// Shared machine-login files (SPEC-ONBOARDING §2 ⟦DP-O3⟧). The subscription CLIs keep
// plaintext credential stores on Linux/WSL; honoring the machine's own config-home env
// means we detect/adopt from wherever the operator's real CLI actually logged in.
// SPEC-MODELS §2 — exported so codex model-catalog discovery can fall back to the machine login's
// auth.json when no profile holds one. Returns a PATH only (never a token).
export function machineLoginFile(provider: string): string | undefined {
  if (provider === 'claude-code') {
    return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json');
  }
  if (provider === 'codex') return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  return undefined;
}

/** Copy a credential file into place 0600 with no world-readable window: tighten a pre-existing
 *  looser dest BEFORE the copy (writeFileSync's {mode} only applies on create, so writing first would
 *  leave the credential briefly loose at its final path), then writeFileSync creates-or-overwrites it
 *  0600. A fresh dest: the chmod throws ENOENT (caught) and the write makes it 0600 from the first
 *  byte. Mirrors setCredential's push-credential store. */
export function copyPrivate(source: string, dest: string): void {
  try {
    chmodSync(dest, 0o600);
  } catch {
    /* not yet created — the writeFileSync below makes it 0600 */
  }
  writeFileSync(dest, readFileSync(source), { mode: 0o600 });
}

/** SPEC-TERMINAL-OPS §1 — the root every profile's isolated config dir lives under. Disjoint by
 *  construction from the shared per-provider dirs (`~/.ct/agents/<provider>`, terminal-manager's
 *  configDirFor), so nothing scoped under here can ever reach one. */
export function accountsRoot(): string {
  return join(paths.home, 'accounts');
}

/**
 * SPEC-TERMINAL-OPS §1.1 — remove a profile's isolated config dir (the copied 0600 credential lives
 * in it). Guarded: only a real directory (never a symlink) strictly inside ~/.ct/accounts, never the
 * root itself, is removed — a profiles.json hand-edited to point configDir at ~/.claude must be
 * refused, loudly.
 *
 * Containment is checked on the REALPATH of both sides, not on the textual path: resolve() collapses
 * '..' but does not follow symlinks, so a symlinked INTERMEDIATE component (say
 * ~/.ct/accounts/claude-code → $HOME, with configDir …/claude-code/.claude) would pass a textual
 * prefix test and let the rm escape the root entirely — bypassing this guard via exactly the
 * hand-edited config it exists to catch. Realpathing the root also makes the check correct under a
 * relative CT_HOME, where a raw join() would never match a resolved target and silently refuse every
 * shred. The final component is still lstat-ed so a symlink is never followed at the last step.
 *
 * Best-effort: a refusal or an rm failure logs and returns false, and the §1.3 boot sweep is the
 * backstop. ⟦DEC-1⟧ recursive rm, not an overwrite-shred: journaled filesystems and wear-levelling
 * defeat zeroing anyway, and the hole being closed is "a live, readable credential lingers forever",
 * not disk forensics.
 */
export function shredAccountDir(configDir: string): boolean {
  const target = resolve(configDir);
  if (!existsSync(target)) return true; // already gone (or a dangling link) — nothing to do
  try {
    // A root that cannot be realpathed does not exist, so nothing can legitimately live inside it.
    const root = realpathSync(accountsRoot());
    const real = realpathSync(target);
    if (!real.startsWith(root + sep) || real === root) {
      console.error(`[accounts] refusing to remove ${target}: outside ${root}`);
      return false;
    }
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      console.error(`[accounts] refusing to remove ${target}: not a plain directory`);
      return false;
    }
    rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error(`[accounts] could not remove ${target}: ${(err as Error).message}`);
    return false;
  }
}

/** The canonical, symlink-resolved form of a path, for comparing an enumerated account dir against a
 *  profile record's configDir (SPEC-TERMINAL-OPS §1.3). Falls back to resolve() when the path does
 *  not exist — a referenced-but-missing dir must still match its enumeration, never look unreferenced. */
export function canonicalAccountPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** True iff `p` is an executable regular file. The isFile guard stops a DIRECTORY named like
 *  the runner (e.g. a dir 'aider' on PATH) from counting as present. */
function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export class Accounts {
  private profiles = new Map<string, AgentProfile>();
  private identities = new Map<string, GitHubIdentity>();
  private profilesTrusted = true;

  constructor() {
    const loaded = readArr(profilesFile, ProfileSchema);
    for (const p of loaded.items) this.profiles.set(p.id, p);
    // SPEC-TERMINAL-OPS §1.3 interlock: the destructive orphan sweep may run only when this list is
    // the WHOLE truth. Any dropped record (a corrupt entry, an unreadable file, a future schema
    // tightening that invalidates old records) leaves a dir referenced by a record we can't see, so
    // the sweep must shred nothing. An absent file (fresh install) and a clean empty list are both
    // trustworthy — deleting the last account must not disable the sweep forever.
    this.profilesTrusted = !loaded.fileExists || loaded.dropped === 0;
    if (!this.profilesTrusted) {
      console.error(`[accounts] ${profilesFile} did not load completely (${loaded.dropped} record(s) dropped)`);
    }
    for (const i of readArr(identitiesFile, IdentitySchema).items) this.identities.set(i.id, i);
  }

  /** Whether the loaded profile list can be trusted as COMPLETE (SPEC-TERMINAL-OPS §1.3) — i.e. every
   *  record in profiles.json loaded. False when ANY record was dropped (a corrupt entry, an unreadable
   *  or non-array file): some dir is then still owned by a record we cannot see, so the orphan sweep
   *  must shred nothing. An absent file and a cleanly EMPTY list are both trustworthy and DO sweep. */
  profilesLoadedOk(): boolean {
    return this.profilesTrusted;
  }

  // ---- profiles ----
  listProfiles(): AgentProfile[] {
    return [...this.profiles.values()];
  }
  getProfile(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }
  createProfile(provider: ProviderId, label: string): AgentProfile {
    const id = shortId();
    const configDir = join(paths.home, 'accounts', provider, `${label.replace(/[^a-z0-9_-]/gi, '_')}-${id}`);
    mkdirSync(configDir, { recursive: true });
    const profile: AgentProfile = { id, provider, label, configDir, createdAt: new Date().toISOString() };
    this.profiles.set(id, profile);
    this.persistProfiles();
    return profile;
  }
  /** Rename a profile's display LABEL only (fix a mistyped account name). The configDir is deliberately
   *  NOT changed: it holds the credential and is baked into every live pane's CLAUDE_CONFIG_DIR env, so
   *  renaming stays a pure display edit that never orphans a login or moves a running pane. Returns the
   *  updated profile, or undefined for an unknown id. */
  renameProfile(id: string, label: string): AgentProfile | undefined {
    const profile = this.profiles.get(id);
    if (!profile) return undefined;
    const next = { ...profile, label };
    this.profiles.set(id, next);
    this.persistProfiles();
    return next;
  }
  /** SPEC-TERMINAL-OPS §1.1 — delete the record, THEN shred the isolated config dir. Record-first is
   *  deliberate: if the rm fails (EBUSY, permissions) the dir becomes an orphan the §1.3 boot sweep
   *  reaps, whereas dir-first would risk a live record whose credentials are gone. */
  deleteProfile(id: string): { existed: boolean; shredded: boolean } {
    const profile = this.profiles.get(id);
    this.profiles.delete(id);
    this.persistProfiles();
    if (!profile) return { existed: false, shredded: false };
    return { existed: true, shredded: shredAccountDir(profile.configDir) };
  }
  private persistProfiles(): void {
    writeArr(profilesFile, [...this.profiles.values()]);
  }

  // ---- shared machine login (SPEC-ONBOARDING §2 ⟦DP-O3⟧) ----
  /** Whether this machine has a login file for the provider (claude-code | codex only). */
  machineLoginPresent(provider: string): boolean {
    const file = machineLoginFile(provider);
    return file !== undefined && existsSync(file);
  }
  /** Copy the machine's own CLI login into the profile's isolated configDir (0600) —
   *  authenticated with no login terminal, personal ~/.claude / ~/.codex untouched.
   *  Throws 'unknown profile' (route → 404); every other failure maps to 409. */
  adoptMachineLogin(profileId: string): void {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error('unknown profile');
    const source = machineLoginFile(profile.provider);
    if (!source) throw new Error(`provider ${profile.provider} has no shared machine login`);
    if (!existsSync(source)) throw new Error(`no ${profile.provider} login found on this machine`);
    mkdirSync(profile.configDir, { recursive: true });
    const dest = join(profile.configDir, profile.provider === 'codex' ? 'auth.json' : '.credentials.json');
    copyPrivate(source, dest);
    if (profile.provider === 'claude-code') {
      // claude-code relocates its first-run state (.claude.json: hasCompletedOnboarding)
      // into CLAUDE_CONFIG_DIR — a freshly adopted dir has none, so the CLI's interactive
      // first-run wizard would wedge an unattended terminal. Seed it from the machine's own
      // .claude.json when present (carrying its settings), but ALWAYS force the onboarding
      // flag: a copied file that happens to lack it would still wedge the wizard (§2).
      //
      // Read-modify-write of the DESTINATION, never an overwrite: a re-adopt must not wipe the
      // state a prior adopt and every spawn's pre-launch seed build up in this profile's dir —
      // bypassPermissionsModeAccepted (the autonomy acceptance) and the per-folder trust map. So
      // the destination's own keys WIN over the machine source (which only fills what a fresh dir
      // lacks — a first adopt still imports the machine's settings), and hasCompletedOnboarding is
      // forced true on top. Unknown keys on both sides are preserved. (Fixing the stateSource path
      // itself is deferred: importing the operator's personal machine state is a behavior change,
      // not this bug fix — and the per-spawn seed re-plants the flag and trust pre-launch anyway.)
      const readJsonObject = (file: string): Record<string, unknown> => {
        if (!existsSync(file)) return {};
        try {
          const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
          return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        } catch {
          /* machine or dest .claude.json unreadable/corrupt — the forced flag alone skips the wizard */
          return {};
        }
      };
      const stateDest = join(profile.configDir, '.claude.json');
      const stateSource = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.claude.json');
      const state: Record<string, unknown> = {
        ...readJsonObject(stateSource),
        ...readJsonObject(stateDest),
        hasCompletedOnboarding: true,
      };
      writeFileSync(stateDest, JSON.stringify(state, null, 2), { mode: 0o600 });
      chmodSync(stateDest, 0o600);
    }
  }
  /** Is `cmd` an executable the Tower could spawn? Pure filesystem check — nothing is executed
   *  or handed to a shell, so caller input can't inject anything. A cmd carrying a path separator
   *  is a literal path (absolute or relative), checked directly; a bare name is charset-validated
   *  and resolved by walking PATH. (A path-based command[0] must NOT fail the bare-name charset
   *  gate, or its preflight would falsely report a valid runner as missing.) */
  runnerOnPath(cmd: string): boolean {
    if (!cmd) return false;
    if (cmd.includes('/')) return isExecutableFile(cmd);
    if (!/^[a-zA-Z0-9_.-]+$/.test(cmd)) return false;
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (!dir) continue;
      if (isExecutableFile(join(dir, cmd))) return true;
    }
    return false;
  }

  // ---- identities ----
  listIdentities(): GitHubIdentity[] {
    return [...this.identities.values()];
  }
  getIdentity(id: string): GitHubIdentity | undefined {
    return this.identities.get(id);
  }
  createIdentity(label: string, gitName: string, gitEmail: string): GitHubIdentity {
    const id = shortId();
    const identity: GitHubIdentity = {
      id,
      label,
      gitName,
      gitEmail,
      hasCredential: false,
      createdAt: new Date().toISOString(),
    };
    this.identities.set(id, identity);
    this.persistIdentities();
    return identity;
  }
  /** Store a push credential (PAT) for the broker to serve. 0600, never in config. */
  setCredential(id: string, token: string): void {
    const identity = this.identities.get(id);
    if (!identity) throw new Error('unknown identity');
    // Tighten a pre-existing looser credFile (bits from an earlier tool or a prior version) BEFORE the
    // PAT is written into it — writeFileSync's {mode} only applies on create, so writing first and
    // chmod-ing after would leave the token briefly world-readable at its final path. On a fresh path
    // the chmod throws ENOENT (caught) and the writeFileSync below creates it 0600 from the first byte.
    // Mirrors copyPrivate above.
    try {
      chmodSync(credFile(id), 0o600);
    } catch {
      /* not yet created — the writeFileSync below makes it 0600 */
    }
    writeFileSync(credFile(id), token, { mode: 0o600 });
    identity.hasCredential = true;
    this.persistIdentities();
  }
  readCredential(id: string): string | null {
    try {
      return existsSync(credFile(id)) ? readFileSync(credFile(id), 'utf8').trim() : null;
    } catch {
      return null;
    }
  }
  revokeCredential(id: string): void {
    const identity = this.identities.get(id);
    try {
      if (existsSync(credFile(id))) rmSync(credFile(id));
    } catch {
      /* ignore */
    }
    if (identity) {
      identity.hasCredential = false;
      this.persistIdentities();
    }
  }
  deleteIdentity(id: string): void {
    this.revokeCredential(id);
    this.identities.delete(id);
    this.persistIdentities();
  }
  private persistIdentities(): void {
    writeArr(identitiesFile, [...this.identities.values()]);
  }
}
