// SPEC-MODELS §2 — the built-in provider model catalog (codex live-discovered via the ChatGPT
// backend, per ChatGPT account; claude-code / gemini-cli curated) + the ONE zero-egress roster
// composition every model picker reads through GET /api/models/:provider. No secrets are ever stored
// here; the ChatGPT token is read at discovery time from a profile's auth.json, used ONLY as a request
// header, and never logged, returned to the web, or written to this file.

import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../paths.js';
import { writeJsonAtomic, readJsonArray } from '../store.js';
import { isValidModelId, fetchCappedJson } from './routing.js';
import type { DiscoveryResult, ProviderDefLookup } from './routing.js';
import { machineLoginFile } from '../accounts.js';
import type { Accounts } from '../accounts.js';
import type { ProviderId, ProviderModelsView, ModelCatalogEntry } from '../../shared/types.js';
import { CODEX_EFFORT_RE } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const FETCH_TIMEOUT_MS = 5000;
const FETCH_MAX_BYTES = 1024 * 1024;

/** The built-in providers whose catalog this store tracks. Custom providers keep their own def.model.models. */
type BuiltinCatalogProvider = 'codex' | 'claude-code' | 'gemini-cli';
const BUILTIN_CATALOG_PROVIDERS: BuiltinCatalogProvider[] = ['codex', 'claude-code', 'gemini-cli'];

// Curated seeds — the fallback CHOICES shown when nothing is discovered (the operator still picks; the
// system never marks one "default" or "recommended"). codex is live-verified against the ChatGPT
// backend (2026-07, codex-cli 0.144.3, these five slugs). claude-code is hand-verified against the
// installed CLI (2026-07, claude-code 2.1.214 — no `claude models` subcommand exists, so the list is
// maintained by hand: the three aliases track each family's latest, the full ids pin a specific model);
// gemini-cli stays UNVERIFIED, pinned by hand. Both non-codex lists keep free-text entry.
// Labels are neutral display names only — no ranking. The codex `efforts` sets are spec-verification-time
// facts (codex-cli 0.144.3 — all five support low/medium/high/xhigh), display-info ONLY (never a Tower
// default) and superseded by the next per-account refresh; NO defaultEffort is seeded (no captured default).
const CURATED: Record<BuiltinCatalogProvider, { models: ModelCatalogEntry[] }> = {
  codex: {
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.4', label: 'GPT-5.4', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark (Pro)', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'codex-auto-review', label: 'Codex Auto Review', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ],
  },
  'claude-code': {
    models: [
      { id: 'opus', label: 'Opus (latest)' },
      { id: 'sonnet', label: 'Sonnet (latest)' },
      { id: 'haiku', label: 'Haiku (latest)' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      { id: 'claude-fable-5', label: 'Claude Fable 5' },
    ],
  },
  'gemini-cli': {
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
  },
};

const CatalogEntrySchema = z.object({
  provider: z.enum(['codex', 'claude-code', 'gemini-cli']),
  // Every stored id must pass the model-id allowlist, so a hand-edited file can never surface a bad id
  // into a picker (the start gate is the terminal backstop; this keeps the persisted roster clean).
  models: z.array(
    z.object({
      id: z.string().refine(isValidModelId, 'invalid model id'),
      verifiedAt: z.string().optional(),
      label: z.string().optional(),
      // SPEC-EFFORT §3.5 — captured display-info (never a Tower default). Filter through CODEX_EFFORT_RE
      // at LOAD (mirroring the discovery-time filter) so a hand-edited catalog can only ever surface
      // well-formed tokens into a picker; malformed entries drop, not reject. Empty-after-filter → undefined.
      efforts: z
        .array(z.string())
        .transform((a) => {
          // Filter to well-formed tokens AND dedup (a hand-edited/repeated level → duplicate <option> keys).
          const f = [...new Set(a.filter((s) => CODEX_EFFORT_RE.test(s)))];
          return f.length ? f : undefined;
        })
        .optional(),
      defaultEffort: z
        .string()
        .transform((s) => (CODEX_EFFORT_RE.test(s) ? s : undefined))
        .optional(),
    }),
  ),
  updatedAt: z.string(),
  // Which ChatGPT account this codex catalog was discovered under. Different subscription tiers expose
  // different catalogs, so the roster is keyed per account — an unset profileId is the account-less slot.
  profileId: z.string().optional(),
});
type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

/** Map key: a codex catalog is per ChatGPT account, so it is keyed by (provider, profileId). claude /
 *  gemini are curated and account-agnostic → they use the empty-profile slot. */
function catalogKey(provider: BuiltinCatalogProvider, profileId?: string): string {
  return `${provider}::${profileId ?? ''}`;
}

/** Persisted built-in catalog store — per-record salvage + quarantine on load (via the shared
 *  readJsonArray helper, so a corrupt/torn file is preserved, not silently overwritten); atomic 0600
 *  write; NO secrets. An optional onChange hook lets the server broadcast a refresh to open clients. */
export class ModelCatalogStore {
  private byKey = new Map<string, CatalogEntry>();
  private onChange?: () => void;

  constructor(private file: string = paths.modelCatalogs) {
    // readJsonArray throws on a transient read error (fail loud), quarantines a corrupt/torn file
    // before starting empty, and drops only the individual records that fail the schema.
    for (const rec of readJsonArray(this.file, CatalogEntrySchema).records) {
      // SPEC-EFFORT §3.5 — NEUTRALIZE (never drop) the stale ACCOUNT-LESS codex slot from before display-name/
      // effort capture: no profileId AND no model carrying `efforts` means it still serves pre-enrichment
      // ranking labels to any account-less codex picker. Re-derive each label from the neutral CURATED seed —
      // a no-op on legitimate data, scrubs stale ranking labels regardless of their exact text; every slug +
      // verifiedAt survives, and there is NO construction-time write (a read-only FS can't crash boot). The
      // next normal set() persists the clean labels.
      if (rec.provider === 'codex' && !rec.profileId && !rec.models.some((m) => m.efforts?.length)) {
        const seedLabel = (id: string) => CURATED.codex.models.find((s) => s.id === id)?.label;
        const models = rec.models.map((m) => ({ ...m, label: seedLabel(m.id) }));
        if (rec.models.some((m) => m.label !== seedLabel(m.id))) {
          console.log('[model-catalog] neutralized stale pre-enrichment labels on the account-less codex slot');
        }
        this.byKey.set(catalogKey(rec.provider, rec.profileId), { ...rec, models });
        continue;
      }
      this.byKey.set(catalogKey(rec.provider, rec.profileId), rec);
    }
  }

  /** Wire an after-write callback (SSE broadcast). Set once at boot, mirroring providerStore.setHooks. */
  setHooks(hooks: { onChange: () => void }): void {
    this.onChange = hooks.onChange;
  }

  private persist(): void {
    writeJsonAtomic(this.file, [...this.byKey.values()], 0o600);
  }

  get(provider: BuiltinCatalogProvider, profileId?: string): CatalogEntry | undefined {
    return this.byKey.get(catalogKey(provider, profileId));
  }

  set(provider: BuiltinCatalogProvider, models: ModelCatalogEntry[], profileId?: string): void {
    this.byKey.set(catalogKey(provider, profileId), {
      provider,
      models,
      updatedAt: new Date().toISOString(),
      ...(profileId ? { profileId } : {}),
    });
    this.persist();
    this.onChange?.();
  }
}

function isBuiltinCatalogProvider(p: ProviderId): p is BuiltinCatalogProvider {
  return (BUILTIN_CATALOG_PROVIDERS as string[]).includes(p);
}

/** SPEC-MODELS §1 — the ONE zero-egress roster read. Custom id → the def's discovered/manual roster;
 *  built-in → this account's stored catalog else the curated seed; shell/unknown → none. NEVER calls
 *  chatgpt.com. `profileId` scopes the codex read to the account whose picker is asking. */
export function buildModelsView(
  provider: ProviderId,
  catalog: ModelCatalogStore,
  providerStore?: ProviderDefLookup,
  profileId?: string,
): ProviderModelsView {
  if (isBuiltinCatalogProvider(provider)) {
    const stored = catalog.get(provider, profileId);
    const seed = CURATED[provider];
    if (stored && stored.models.length > 0) {
      return {
        provider,
        models: stored.models,
        source: 'discovered',
        lastVerifiedAt: stored.updatedAt,
        discoverable: provider === 'codex', // only codex has a live catalog endpoint
      };
    }
    return {
      provider,
      models: seed.models,
      source: 'curated',
      discoverable: provider === 'codex',
      note: provider === 'codex' ? undefined : 'no discoverable catalog — curated list + free text',
    };
  }
  // Custom provider: its discovered/manual roster lives on the def.
  const def = providerStore?.get(provider);
  const models: ModelCatalogEntry[] = (def?.model.models ?? []).map((m) => ({ id: m.id, verifiedAt: m.verifiedAt }));
  if (def) {
    return {
      provider,
      models,
      source: models.length > 0 ? 'discovered' : 'curated',
      discoverable: !!def.baseUrl, // a custom def with a baseUrl can hit its /v1/models
    };
  }
  return { provider, models: [], source: 'none', discoverable: false };
}

/** The stripped semver of the installed codex CLI (`codex-cli 0.142.5` → `0.142.5`); required as the
 *  `client_version` query param the backend gates the catalog on. Async so the refresh handler never
 *  blocks the event loop on a slow/hung CLI. */
async function codexClientVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('codex', ['--version'], { timeout: 8000 });
    const m = stdout.toString().match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** Read a ChatGPT access token + account id from a codex auth.json. `auth_mode` is OPTIONAL — the
 *  machine ~/.codex/auth.json lacks it, so requiring it would silently disable the machine-login
 *  fallback. Returns undefined (never throws) if no usable token. The token is never logged. */
function readCodexToken(authFile: string | undefined): { accessToken: string; accountId?: string } | undefined {
  if (!authFile || !existsSync(authFile)) return undefined;
  try {
    const d = JSON.parse(readFileSync(authFile, 'utf8')) as { tokens?: { access_token?: unknown; account_id?: unknown } };
    const at = d.tokens?.access_token;
    if (typeof at !== 'string' || at.length === 0) return undefined;
    const acct = d.tokens?.account_id;
    return { accessToken: at, accountId: typeof acct === 'string' ? acct : undefined };
  } catch {
    return undefined;
  }
}

/** The account-less fallback token: the newest codex profile that has a token, else the machine login.
 *  READ-ONLY, one parse per candidate. Only used when the caller gave no explicit profileId — an
 *  explicit id is resolved and validated by discoverCodexModels itself so it NEVER silently falls
 *  through to another account. */
function fallbackCodexToken(accounts: Accounts): { accessToken: string; accountId?: string } | undefined {
  const codexProfiles = accounts
    .listProfiles()
    .filter((p) => p.provider === 'codex')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const p of codexProfiles) {
    const tok = readCodexToken(join(p.configDir, 'auth.json'));
    if (tok) return tok;
  }
  return readCodexToken(machineLoginFile('codex'));
}

/**
 * SPEC-EFFORT §3.5 — parse ONE raw codex catalog entry into a ModelCatalogEntry, defensively. Pure +
 * exported for the runtime test. `slug` gates on isValidModelId; `display_name` (a non-empty string) →
 * label, else the CURATED back-fill via `seedLabelFor(slug)` (a NAME is neutral — never description/
 * availability_nux, which is the ranking language §0 excludes); `supported_reasoning_levels[].effort`
 * filtered by CODEX_EFFORT_RE → efforts (kept only when non-empty); `default_reasoning_level` passing the
 * same regex → defaultEffort. Duplicate-slug dedupe stays in the discoverCodexModels caller's `seen` set.
 */
export function parseCodexModelEntry(
  e: unknown,
  now: string,
  seedLabelFor: (slug: string) => string | undefined,
): ModelCatalogEntry | undefined {
  const o = e && typeof e === 'object' ? (e as Record<string, unknown>) : undefined;
  const slug = o ? o.slug : e;
  if (typeof slug !== 'string' || !isValidModelId(slug)) return undefined;
  const displayName = o && typeof o.display_name === 'string' && o.display_name.trim() ? o.display_name : undefined;
  const label = displayName ?? seedLabelFor(slug);
  const levels = o && Array.isArray(o.supported_reasoning_levels) ? o.supported_reasoning_levels : [];
  const efforts = [
    ...new Set(
      levels
        .map((l) => (l && typeof l === 'object' ? (l as { effort?: unknown }).effort : undefined))
        .filter((v): v is string => typeof v === 'string' && CODEX_EFFORT_RE.test(v)),
    ),
  ]; // dedup — a repeated backend level would otherwise make duplicate <option> keys in EffortSelect
  const dflt =
    o && typeof o.default_reasoning_level === 'string' && CODEX_EFFORT_RE.test(o.default_reasoning_level)
      ? o.default_reasoning_level
      : undefined;
  return {
    id: slug,
    verifiedAt: now,
    ...(label ? { label } : {}),
    ...(efforts.length ? { efforts } : {}),
    ...(dflt ? { defaultEffort: dflt } : {}),
  };
}

/** SPEC-MODELS §2 — the ONLY egress. Query the ChatGPT backend for the codex catalog with the
 *  account's own token (header only) and store the discovered slugs under that account. Non-blocking:
 *  every failure keeps the prior roster and returns an honest, token-free status note. */
export async function discoverCodexModels(
  deps: { accounts: Accounts; catalog: ModelCatalogStore },
  profileId?: string,
): Promise<DiscoveryResult> {
  const prior = deps.catalog.get('codex', profileId)?.models ?? CURATED.codex.models;

  // Resolve the token (one credential-file parse). An EXPLICIT profileId that isn't a live codex login
  // is surfaced as an error — we never silently fall through to a different account (that would refresh
  // the wrong catalog).
  let tok: { accessToken: string; accountId?: string } | undefined;
  if (profileId) {
    const p = deps.accounts.getProfile(profileId);
    if (!p || p.provider !== 'codex') return { ok: false, models: prior, note: 'that account is not a Codex login' };
    tok = readCodexToken(join(p.configDir, 'auth.json'));
    if (!tok) return { ok: false, models: prior, note: 'that Codex account has no active login — log in again' };
  } else {
    tok = fallbackCodexToken(deps.accounts);
  }
  if (!tok) return { ok: false, models: prior, note: 'no ChatGPT login found — log in first' };

  const version = await codexClientVersion();
  if (!version) return { ok: false, models: prior, note: 'codex CLI not found — cannot determine client_version' };

  const url = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(version)}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${tok.accessToken}` };
  if (tok.accountId) headers['chatgpt-account-id'] = tok.accountId;

  let body: unknown;
  try {
    body = await fetchCappedJson(url, FETCH_TIMEOUT_MS, FETCH_MAX_BYTES, headers);
  } catch (e) {
    // The message is a status/timeout only (fetchCappedJson never includes headers/body) — safe to surface.
    const msg = (e as Error).message;
    const note = msg.includes('401') ? 'ChatGPT login expired — run a Codex turn or log in again' : `couldn't reach the codex catalog: ${msg}`;
    return { ok: false, models: prior, note };
  }

  // Verified shape: { models: [ { slug: "gpt-5.5", ... }, ... ] }. Parse defensively.
  const rawList =
    body && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
      ? ((body as { models: unknown[] }).models)
      : undefined;
  if (!rawList) return { ok: false, models: prior, note: 'codex catalog response had an unexpected shape' };

  const seen = new Set<string>();
  const models: ModelCatalogEntry[] = [];
  const now = new Date().toISOString();
  const seedLabelFor = (slug: string): string | undefined => CURATED.codex.models.find((m) => m.id === slug)?.label;
  for (const e of rawList) {
    const entry = parseCodexModelEntry(e, now, seedLabelFor);
    if (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      models.push(entry);
    }
  }
  if (models.length === 0) return { ok: false, models: prior, note: 'codex catalog returned no usable models' };

  deps.catalog.set('codex', models, profileId);
  return { ok: true, models };
}
