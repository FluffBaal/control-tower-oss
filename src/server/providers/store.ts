// The ProviderDef store (SPEC-PROVIDERS §1.1 / §4.1). A registered custom provider is a
// ProviderDef record, validated with the SAME zod schema the Terminal snapshot uses (no
// drift) and persisted via an atomic 0600 write to ~/.ct/providers.json (names
// only, never secret values, but owner-only anyway). Mirrors accounts.ts / store.ts.
//
// Secrets ride the write-only file pattern already blessed by §13: setSecret writes
// `secrets/provider-<slug>-<KEY>` at 0600; there is NO getter that returns a value to any API
// route — presence is reported via hasSecret only. The spawn-env READER (readSecretEnv, §4.2)
// lives in BP2's secrets.ts and reuses `providerSecretFile` below so both agree on the layout.

import { readFileSync, writeFileSync, renameSync, existsSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths.js';
import { ProviderDefSchema } from '../store.js';
import type { ProviderDef, ProviderId, CustomProviderId } from '../../shared/types.js';

// Hoisted into paths.ts (integrator, §8) — a config-dir sibling of
// projects/terminals/loops/missions.json. Re-exported here so existing importers are unchanged.
export const providersFile = paths.providers;

/** Valid secret env-var NAME. Also the path-traversal guard for provider-<slug>-<KEY> files. */
const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Env-var NAMES the Tower control plane owns on the spawn env: any TOWER_* var (the hook wiring,
 * broker, memory dir, and port) and the def's own configDirEnv (the account-isolation dir). A
 * secret injected under one of these would shadow the control plane at the spawn-env merge, so a
 * def naming one is rejected here and, belt-and-braces, filtered again spawn-side. Case-sensitive,
 * matching real env semantics.
 */
export function isReservedEnvName(key: string, configDirEnv: string | undefined): boolean {
  return key.startsWith('TOWER_') || key === configDirEnv;
}

/**
 * Absolute path of a provider secret file: `secrets/provider-<slug>-<KEY>` (§4.1), written
 * 0600. Exported so BP2's readSecretEnv (§4.2) reads the SAME convention — one source of
 * truth, no drift. Throws on a key that isn't a valid env-var name (path-traversal guard);
 * the slug is already regex-validated by the custom-id schema, so it is filename-safe.
 */
export function providerSecretFile(id: CustomProviderId, key: string): string {
  if (!SECRET_KEY_RE.test(key)) throw new Error(`invalid secret env key: ${key}`);
  const slug = id.slice('custom:'.length);
  return join(paths.secrets, `provider-${slug}-${key}`);
}

// ---- def.env secret-value guard ----
// def.env is NON-SECRET and lands in plaintext providers.json, so a key pasted there is a
// footgun. Reject secret-LOOKING values and steer the operator to secretEnvKeys.
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const SECRET_PREFIX_RE = /^(sk-|sk_|pk-|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{4}|Bearer\s+\S|eyJ[A-Za-z0-9_-]{10,}\.)/;

/** Shannon entropy in bits per character (a random token trends high, a URL/path low). */
function shannonBits(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksSecret(key: string, value: string): boolean {
  // A4: the var-NAME leg runs FIRST — a secret-named key (API_KEY, …) is a footgun in NON-secret
  // def.env regardless of its value, and must NOT be exempted by a '{{' interpolation template.
  if (SECRET_NAME_RE.test(key)) return true; // the var NAME implies a secret
  // The empty/'{{…}}' exemption applies ONLY to the value-pattern legs below (a template or empty
  // value carries no literal secret to leak); it may never short-circuit the name leg above.
  if (value === '' || value.includes('{{')) return false;
  if (SECRET_PREFIX_RE.test(value)) return true; // a known secret shape
  // A long, opaque, mixed-alnum token with no URL/path punctuation (which would fail the
  // charset test) and high entropy — the shape of an API key, not a base URL or model slug.
  if (value.length >= 32 && /^[A-Za-z0-9_-]+$/.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value)) {
    return shannonBits(value) >= 3.5;
  }
  return false;
}

/**
 * Load providers.json with PER-RECORD validation (mirrors store.ts readJsonArray): one bad
 * record must never wipe the onboarded roster. Valid records are kept, invalid ones skipped
 * with a loud log, and the original bytes preserved in a `.rejected-<ts>` copy before any
 * re-persist. A read failure on an existing file is a TRANSIENT I/O error → throw (fail loud,
 * recoverable by restart) rather than quarantine a file the next persist would then wipe. A
 * torn / non-array file IS corruption → quarantine `.corrupt-<ts>` then start empty.
 */
function readDefs(): { defs: ProviderDef[]; hadRejects: boolean } {
  if (!existsSync(providersFile)) return { defs: [], hadRejects: false };

  let text: string;
  try {
    text = readFileSync(providersFile, 'utf8');
  } catch (err) {
    throw new Error(
      `[providers] cannot read ${providersFile} (transient I/O — not corruption): ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
  } catch (err) {
    const quarantine = `${providersFile}.corrupt-${Date.now()}`;
    console.error(`[providers] ${providersFile} corrupt (${(err as Error).message}); quarantining as ${quarantine}`);
    renameSync(providersFile, quarantine); // throws on failure -> boot fails (no silent wipe)
    return { defs: [], hadRejects: false };
  }

  const defs: ProviderDef[] = [];
  let rejects = 0;
  for (const el of parsed) {
    const res = ProviderDefSchema.safeParse(el);
    if (res.success) defs.push(res.data);
    else {
      rejects++;
      console.error(`[providers] skipping invalid provider record: ${res.error.message}`);
    }
  }
  let hadRejects = false;
  if (rejects > 0) {
    try {
      copyFileSync(providersFile, `${providersFile}.rejected-${Date.now()}`);
      hadRejects = true; // backup ok -> safe to re-persist survivors
    } catch (e) {
      console.error(`[providers] could not back up ${providersFile}; NOT re-persisting (keeping original):`, e);
    }
  }
  return { defs, hadRejects };
}

/** Atomic write at 0600: temp file + rename, so a crash mid-write can't corrupt. */
function writeJsonAtomic0600(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Wired after construction (boot order: store → registry → wire), so a mutation recomposes
 * the synthesized adapters and pushes an SSE `{ t: 'providers' }` frame — open composers
 * refresh their roster without a restart (⟦DP-3⟧, J1.4).
 */
export interface ProviderStoreHooks {
  /** Recompose synthesized adapters — integrator wires this to providerRegistry.rebuild(). */
  onRebuild?: () => void;
  /** Push an SSE `{ t: 'providers' }` frame so open composers refresh their roster live. */
  onChange?: () => void;
}

export class ProviderStore {
  private defs = new Map<CustomProviderId, ProviderDef>();
  private hooks: ProviderStoreHooks;

  constructor(hooks: ProviderStoreHooks = {}) {
    this.hooks = hooks;
    const { defs, hadRejects } = readDefs();
    for (const d of defs) this.defs.set(d.id, d);
    // Reach a clean steady state now: the live file becomes valid-records-only; the dropped
    // records are already preserved in the .rejected-<ts> copy above.
    if (hadRejects) this.persist();
  }

  /** Wire the rebuild + SSE hooks after the registry exists (resolves the store↔registry cycle). */
  setHooks(hooks: ProviderStoreHooks): void {
    this.hooks = hooks;
  }

  // ---- reads ----
  list(): ProviderDef[] {
    return [...this.defs.values()];
  }
  /** The def for a provider id, or undefined for a built-in / unregistered id (no def). */
  get(id: ProviderId): ProviderDef | undefined {
    return this.defs.get(id as CustomProviderId);
  }

  // ---- mutations (each recomposes the registry + emits the SSE frame) ----
  upsert(input: ProviderDef): ProviderDef {
    // Validate + strip unknown fields against the SAME schema the Terminal snapshot uses (the
    // M6 lesson): an unlisted field is dropped, a malformed slug / auth shape rejected here.
    const parsed = ProviderDefSchema.parse(input) as ProviderDef;
    this.validateEnvNonSecret(parsed); // no secret-looking values in def.env
    this.validateSecretEnvKeys(parsed); // no secretEnvKey may shadow a control-plane var
    this.validateAuth(parsed); // ⟦AR-1⟧ login ⇒ configDirEnv|HOME, env ⇒ secretEnvKeys
    const now = new Date().toISOString();
    const existing = this.defs.get(parsed.id);
    const def: ProviderDef = {
      ...parsed,
      // Store-owned timestamps: preserve the original createdAt across edits, always bump updatedAt.
      createdAt: existing?.createdAt ?? parsed.createdAt ?? now,
      updatedAt: now,
    };
    this.defs.set(def.id, def);
    this.persist();
    this.afterMutate();
    return def;
  }

  remove(id: ProviderId): void {
    const cid = id as CustomProviderId;
    const def = this.defs.get(cid);
    if (!def) return;
    // Hygiene: drop this provider's 0600 secret files so a deleted def doesn't leak them
    // (mirrors accounts.deleteIdentity → revokeCredential). Best-effort. A5: unlink EVERY
    // provider-<slug>-* file, not just the DECLARED secretEnvKeys — setSecret accepts undeclared
    // keys, so a key set then later un-declared would otherwise leave an orphaned secret file.
    this.rmAllSecretFiles(cid);
    this.defs.delete(cid);
    this.persist();
    this.afterMutate();
  }

  // ---- write-only secret store (§4.1) — provider-<slug>-<KEY>, 0600, NO value getter ----
  setSecret(id: CustomProviderId, key: string, value: string): void {
    if (!this.defs.has(id)) throw new Error('unknown provider');
    writeFileSync(providerSecretFile(id, key), value, { mode: 0o600 }); // throws on unsafe key
    this.afterMutate();
  }
  hasSecret(id: CustomProviderId, key: string): boolean {
    try {
      return existsSync(providerSecretFile(id, key));
    } catch {
      return false; // unsafe key name -> treat as absent
    }
  }
  clearSecret(id: CustomProviderId, key: string): void {
    this.rmSecretFile(id, key);
    this.afterMutate();
  }

  private rmSecretFile(id: CustomProviderId, key: string): void {
    try {
      const f = providerSecretFile(id, key);
      if (existsSync(f)) rmSync(f);
    } catch {
      /* unsafe key / already gone — ignore */
    }
  }

  /** A5: remove ALL of this provider's secret files (provider-<slug>-<KEY>), including keys never
   *  declared in secretEnvKeys — setSecret accepts undeclared keys, so declared-only cleanup
   *  leaks orphans. A KEY is a valid env-var name (SECRET_KEY_RE, no dash), so requiring a
   *  dash-free tail after `provider-<slug>-` avoids clobbering a sibling whose slug EXTENDS this
   *  one (e.g. custom:foo must not delete custom:foo-bar's provider-foo-bar-<KEY> files). */
  private rmAllSecretFiles(id: CustomProviderId): void {
    const prefix = `provider-${id.slice('custom:'.length)}-`;
    let names: string[];
    try {
      names = readdirSync(paths.secrets);
    } catch {
      return; // secrets dir missing / unreadable — nothing to clean
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      if (!SECRET_KEY_RE.test(name.slice(prefix.length))) continue; // a longer sibling slug's file
      try {
        rmSync(join(paths.secrets, name));
      } catch {
        /* already gone / race — ignore */
      }
    }
  }

  private validateEnvNonSecret(def: ProviderDef): void {
    if (!def.env) return;
    for (const [k, v] of Object.entries(def.env)) {
      if (looksSecret(k, v)) {
        throw new Error(
          `env "${k}" looks like a secret; put its NAME in secretEnvKeys and set the value via ` +
            `the write-only secret store (§4). def.env is NON-SECRET (plaintext in providers.json).`,
        );
      }
    }
  }

  private validateSecretEnvKeys(def: ProviderDef): void {
    for (const key of def.secretEnvKeys ?? []) {
      if (isReservedEnvName(key, def.configDirEnv)) {
        throw new Error(
          `secretEnvKeys "${key}" is reserved by the Tower control plane (a TOWER_* var or the ` +
            `configDirEnv) and would shadow it in the spawn env; name the API-key var the CLI reads instead.`,
        );
      }
    }
  }

  private validateAuth(def: ProviderDef): void {
    // auth.mode picks the primary form + check, not a hard XOR — env + login may coexist (§1.6).
    if (def.auth.mode === 'login') {
      const isolated = !!def.configDirEnv || !!(def.env && 'HOME' in def.env);
      if (!isolated) {
        throw new Error(
          "auth.mode 'login' requires configDirEnv (or a HOME entry in env) to isolate the CLI's own credential store (§1.6).",
        );
      }
    }
    if (def.auth.mode === 'env') {
      if (!def.secretEnvKeys || def.secretEnvKeys.length === 0) {
        throw new Error("auth.mode 'env' requires at least one secretEnvKeys entry naming the API-key env var (§1.6).");
      }
    }
  }

  private afterMutate(): void {
    this.hooks.onRebuild?.();
    this.hooks.onChange?.();
  }

  private persist(): void {
    writeJsonAtomic0600(providersFile, [...this.defs.values()]);
  }
}
