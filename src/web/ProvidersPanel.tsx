// Control Tower — Providers surface (SPEC-PROVIDERS §1/§2/§3/§4, BP4).
//
// Two exports, mounted under two different Settings tabs:
//   1. ProvidersPanel — register/edit custom providers as DATA (ProviderDef): the whole §1.1
//      field set (command/env/baseUrl), an auth-mode selector (none / env / login), a
//      turn-detection TIER picker (webhook A / screen-regex B / dwell-only C) with the honest
//      amber "degraded" labelling for tier C (§U-J5), write-only secret rows (§4), model config
//      + live discovery (§3), and a Test action (discovery probe + dry spawn). Mounted under the
//      Settings → Connections tab (its custom-provider section).
//   2. RoutingSection — the five global PipelineRole role defaults (§2.1) plus the Workflows
//      editor, exported separately for the Settings → Routing tab.
//
// SELF-CONTAINED: every server interaction is a method on a props-injected `api` object
// (see `ProvidersApi` below — the integrator wires each method to a `tower.*` client call).
// The panel keeps the concrete client at arm's length so it stays testable in isolation; the
// api.ts import is the `AdapterInfo` roster TYPE (erased at compile). The ONE exception is the
// shared <ModelSelect> (SPEC-MODELS §3), which owns its own roster fetch through a module cache —
// the single-picker-everywhere mandate outweighs prop-drilling a roster into every grid, and a
// failed read degrades to an empty list rather than throwing.
//
// House style follows SettingsView.tsx / AccountsPanel.tsx: `.field`/`.settings-form`/
// `.settings-section`/`.seg-choice`/`.chip` idioms, new structure under `pv-` classes whose
// CSS is appended as a trailing /* CSS FOR INTEGRATOR */ block (this file must not touch
// styles.css). Secrets are WRITE-ONLY everywhere: the UI shows presence, never a value.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentProfile,
  CustomProviderId,
  HookSignal,
  PipelineRole,
  ProviderAuth,
  ProviderDef,
  ProviderId,
  ProviderModelConfig,
  ProviderTurnDetection,
  RoleAssignment,
  RoleRouting,
  TurnDetectionMode,
  WorkflowProfile,
} from '../shared/types.js';
import { PIPELINE_ROLES } from '../shared/roles.js';
import type { AdapterInfo } from './api.js';
// SPEC-MODELS §3 — the ONE shared model picker. It reads its own roster from GET /api/models/:provider
// through a module cache; this is the single deliberate runtime coupling to the client from this panel
// (see the isolation note in the header — a roster read failing degrades to an empty list, never throws).
import { ModelSelect } from './ModelSelect.js';
import { EffortSelect } from './EffortSelect.js';

// ============================================================================
//  INTEGRATOR CONTRACT — the props-injected api object + wire view types.
//  Every method maps to one server route the integrator adds to api.ts (`tower.*`).
//  Routes named per SPEC-PROVIDERS §1.1/§3/§4/§6; secret channel is write-only (§4.4).
// ============================================================================

/** Upsert payload: a full ProviderDef minus the server-managed timestamps (server stamps
 *  createdAt on first insert, updatedAt on every write). `id` is client-built `custom:<slug>`. */
export type ProviderDefInput = Omit<ProviderDef, 'createdAt' | 'updatedAt'>;

/** The `/api/providers` wire shape: a ProviderDef augmented with write-only secret PRESENCE
 *  (key → true/false), never values (§4.4). `hasSecret` also rides the `{t:'providers'}` SSE. */
export type ProviderDefView = ProviderDef & {
  /** Present-or-not per `secretEnvKeys` entry. The store's `hasSecret(id,key)` projected to the wire. */
  hasSecret?: Record<string, boolean>;
};

/** Result of `GET /api/providers/:id/models` (§3). On failure the server keeps the prior
 *  roster and returns a non-blocking `note` — discovery never blocks onboarding. */
export interface DiscoverResult {
  models: { id: string; verifiedAt?: string }[];
  note?: string;
}

/** PUT /api/workflows/:id payload — a WorkflowProfile minus the server-managed timestamps
 *  (the ProviderDefInput idiom). `id` is client-minted (crypto.randomUUID) on Add. */
export type WorkflowUpsert = Omit<WorkflowProfile, 'createdAt' | 'updatedAt'>;

/** Result of the Test action — a discovery probe plus a dry spawn (§6 verification / J1). */
export interface ProviderTestResult {
  ok: boolean;
  discovery?: { ok: boolean; count?: number; note?: string };
  drySpawn?: { ok: boolean; note?: string };
  /** SPEC-ONBOARDING §4 — real existence check of command[0] (the dry spawn only renders argv, it
   *  does not execute, so a missing runner otherwise passes). Absent on defs with no command[0]. */
  binaryPresent?: { ok: boolean; note?: string };
  error?: string;
}

export interface ProvidersApi {
  /** GET /api/providers → the custom defs (built-ins are NOT defs; use `adapters` for those). */
  listProviders(): Promise<ProviderDefView[]>;
  /** PUT /api/providers/:id (create or replace). Server validates §4.4 env secret-rejection +
   *  §1.6 auth rules, stamps timestamps, rebuilds the registry, emits `{t:'providers'}`. */
  upsertProvider(def: ProviderDefInput): Promise<ProviderDefView>;
  /** DELETE /api/providers/:id. A live terminal keeps its launch-time snapshot. */
  removeProvider(id: CustomProviderId): Promise<void>;
  /** PUT /api/providers/:id/secrets/:key — write-only; the value never comes back. */
  setProviderSecret(id: CustomProviderId, key: string, value: string): Promise<void>;
  /** DELETE /api/providers/:id/secrets/:key. */
  clearProviderSecret(id: CustomProviderId, key: string): Promise<void>;
  /** GET /api/providers/:id/models — hardened probe (id allowlist + fetch caps, §3). */
  discoverModels(id: CustomProviderId): Promise<DiscoverResult>;
  /** POST /api/providers/:id/login — ensures/uses a profile for this provider and opens its
   *  login terminal in the isolated configDir, honoring `def.auth.loginCommand` (§1.6/⟦AR-1⟧).
   *  Returns the Terminal to hop to on the flightline. The Tower never captures the token. */
  loginProvider(id: CustomProviderId): Promise<{ id: string }>;
  /** POST /api/providers/:id/test — discovery probe + a dry spawn of the argv (then kill). */
  testProvider(id: CustomProviderId): Promise<ProviderTestResult>;
  /** GET /api/routing → the five-role defaults (§2.1). */
  getRouting(): Promise<RoleRouting>;
  /** PUT /api/routing (full replace). */
  setRouting(routing: RoleRouting): Promise<RoleRouting>;
  /** GET /api/workflows — the named role→(provider,model) bundles projects can select
   *  (SPEC-ROUTING §2/§4). */
  listWorkflows(): Promise<WorkflowProfile[]>;
  /** PUT /api/workflows/:id (create or replace; server stamps timestamps + emits `providers`). */
  upsertWorkflow(w: WorkflowUpsert): Promise<WorkflowProfile>;
  /** DELETE /api/workflows/:id — the server refuses with 409 (naming the referencing projects)
   *  while any project selects it; the message surfaces via onError. */
  deleteWorkflow(id: string): Promise<void>;
}

// ============================================================================
//  Static tables + small pure helpers
// ============================================================================

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/; // ProviderDef.id = custom:<slug> (§1.1)

const HOOK_SIGNALS: HookSignal[] = ['turn-done', 'needs-input', 'needs-permission', 'session-start'];

/** Tier metadata, DERIVED from turn.mode (never stored — one source of truth, §1.1). */
const TIERS: { mode: TurnDetectionMode; tier: 'A' | 'B' | 'C'; label: string; blurb: string }[] = [
  {
    mode: 'webhook',
    tier: 'A',
    label: 'Webhook — signalled (recommended)',
    blurb:
      "The CLI’s own notify/hook program calls ct-hook — a real turn-done signal, full FSM parity with the built-ins. Preferred for any TUI and for hosted APIs.",
  },
  {
    mode: 'screen-regex',
    tier: 'B',
    label: 'Screen regex — polled',
    blurb:
      'The poller matches a done-pattern on the pane text (gemini-class). Reliable when the pattern is unambiguous and the idle screen is static.',
  },
  {
    mode: 'dwell-only',
    tier: 'C',
    label: 'Dwell-only — inferred (degraded)',
    blurb:
      'No completion signal at all. Turn end is inferred from output going quiet. It never silently hangs — a backstop demotes it — but completion is a guess, not a signal.',
  },
];
const tierOf = (m: TurnDetectionMode) => TIERS.find((t) => t.mode === m)!;

/** Harnesses that default to the OS keyring, which defeats configDir isolation + breaks
 *  headless/WSL (⟦AR-3⟧). Warn when one is added without its disable flag. */
const KEYRING_CLIS: { bin: string; name: string; disableEnv: string }[] = [
  { bin: 'goose', name: 'Goose', disableEnv: 'GOOSE_DISABLE_KEYRING' },
];

// A key name OR a value that smells like a credential → steer to secretEnvKeys, never `env`
// (client mirror of the §4.4 server-side upsert rejection, surfaced as a soft warning).
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|BEARER|AUTH)/i;
function looksSecret(key: string, value: string): boolean {
  if (SECRET_KEY_RE.test(key)) return true;
  const v = value.trim();
  if (v.includes('{{')) return false; // an interpolation template, not a literal secret
  return v.length >= 24 && /[A-Za-z]/.test(v) && /[0-9]/.test(v) && !/\s/.test(v);
}

/** A forgiving shell-ish tokenizer for the argv template inputs — honors single/double quotes
 *  so `--flag "two words"` survives; whitespace otherwise splits. Source of truth stays the
 *  string in form state; argv is produced only at save. */
function parseArgv(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}
function argvToString(a: string[]): string {
  return a.map((t) => (t === '' ? '""' : /\s|["']/.test(t) ? JSON.stringify(t) : t)).join(' ');
}
/** approve/deny key lists: comma-separated literals the adapter sends (e.g. `y`, `enter`). */
const parseList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function regexInvalid(pat: string): boolean {
  if (!pat.trim()) return false;
  try {
    void new RegExp(pat);
    return false;
  } catch {
    return true;
  }
}

function fmtVerified(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(+d) ? '' : `verified ${d.toLocaleDateString()}`;
}

// ============================================================================
//  Form state (a flat, editable mirror of ProviderDef; converted at save)
// ============================================================================

interface EnvRow {
  key: string;
  value: string;
}
interface HookBindingRow {
  providerEvent: string;
  signal: HookSignal;
}
interface FormState {
  slug: string;
  displayName: string;
  commandStr: string;
  configDirEnv: string;
  env: EnvRow[];
  secretEnvKeys: string[];
  baseUrl: string;
  modelFlag: string;
  modelEnv: string;
  defaultModel: string;
  modelsPath: string;
  models: { id: string; verifiedAt?: string }[];
  mode: TurnDetectionMode;
  hookRelPath: string;
  hookTemplate: string;
  hookBindings: HookBindingRow[];
  patNeedsPermission: string;
  patNeedsInput: string;
  patTurnDone: string;
  busyPattern: string;
  socketBusy: boolean;
  screenChangeImpliesWork: boolean;
  chromeStripStr: string;
  approveStr: string;
  denyStr: string;
  authMode: ProviderAuth['mode'];
  loginCommandStr: string;
}

function blankForm(): FormState {
  return {
    slug: '',
    displayName: '',
    commandStr: '',
    configDirEnv: '',
    env: [],
    secretEnvKeys: [],
    baseUrl: '',
    modelFlag: '',
    modelEnv: '',
    defaultModel: '',
    modelsPath: '',
    models: [],
    mode: 'screen-regex', // a workable default for a hookless CLI; the picker recommends A
    hookRelPath: 'tower-hooks.toml',
    hookTemplate: '',
    hookBindings: [{ providerEvent: '', signal: 'turn-done' }],
    patNeedsPermission: '',
    patNeedsInput: '',
    patTurnDone: '',
    busyPattern: '',
    socketBusy: false,
    screenChangeImpliesWork: true,
    chromeStripStr: '',
    approveStr: 'y',
    denyStr: 'n',
    authMode: 'none',
    loginCommandStr: '',
  };
}

function fromDef(d: ProviderDefView): FormState {
  const f = blankForm();
  f.slug = d.id.replace(/^custom:/, '');
  f.displayName = d.displayName;
  f.commandStr = argvToString(d.command);
  f.configDirEnv = d.configDirEnv ?? '';
  f.env = Object.entries(d.env ?? {}).map(([key, value]) => ({ key, value }));
  f.secretEnvKeys = [...(d.secretEnvKeys ?? [])];
  f.baseUrl = d.baseUrl ?? '';
  f.modelFlag = d.model.modelFlag ?? '';
  f.modelEnv = d.model.modelEnv ?? '';
  f.defaultModel = d.model.defaultModel ?? '';
  f.modelsPath = d.model.modelsPath ?? '';
  f.models = d.model.models ?? [];
  f.mode = d.turn.mode;
  if (d.turn.hookConfig) {
    f.hookRelPath = d.turn.hookConfig.relPath;
    f.hookTemplate = d.turn.hookConfig.template;
    f.hookBindings = d.turn.hookConfig.bindings.length
      ? d.turn.hookConfig.bindings.map((b) => ({ ...b }))
      : [{ providerEvent: '', signal: 'turn-done' }];
  }
  f.patNeedsPermission = d.turn.patterns?.needsPermission ?? '';
  f.patNeedsInput = d.turn.patterns?.needsInput ?? '';
  f.patTurnDone = d.turn.patterns?.turnDone ?? '';
  f.busyPattern = d.turn.busyPattern ?? '';
  f.socketBusy = !!d.turn.socketBusy;
  f.screenChangeImpliesWork = d.turn.screenChangeImpliesWork !== false; // absent = default true
  f.chromeStripStr = (d.turn.chromeStripPatterns ?? []).join('\n');
  f.approveStr = d.approveKeys.approve.join(', ');
  f.denyStr = d.approveKeys.deny.join(', ');
  f.authMode = d.auth.mode;
  f.loginCommandStr = d.auth.mode === 'login' && d.auth.loginCommand ? argvToString(d.auth.loginCommand) : '';
  return f;
}

function toDef(f: FormState): ProviderDefInput {
  const model: ProviderModelConfig = { models: f.models };
  if (f.modelFlag.trim()) model.modelFlag = f.modelFlag.trim();
  if (f.modelEnv.trim()) model.modelEnv = f.modelEnv.trim();
  if (f.defaultModel.trim()) model.defaultModel = f.defaultModel.trim();
  if (f.modelsPath.trim()) model.modelsPath = f.modelsPath.trim();

  const turn: ProviderTurnDetection = { mode: f.mode };
  if (f.mode === 'webhook') {
    turn.hookConfig = {
      relPath: f.hookRelPath.trim(),
      template: f.hookTemplate,
      bindings: f.hookBindings.filter((b) => b.providerEvent.trim()).map((b) => ({ ...b, providerEvent: b.providerEvent.trim() })),
    };
  } else if (f.mode === 'screen-regex') {
    const p: NonNullable<ProviderTurnDetection['patterns']> = {};
    if (f.patNeedsPermission.trim()) p.needsPermission = f.patNeedsPermission.trim();
    if (f.patNeedsInput.trim()) p.needsInput = f.patNeedsInput.trim();
    if (f.patTurnDone.trim()) p.turnDone = f.patTurnDone.trim();
    turn.patterns = p;
  } else {
    if (f.busyPattern.trim()) turn.busyPattern = f.busyPattern.trim();
    if (f.socketBusy) turn.socketBusy = true;
  }
  // Advanced poller hints apply to the polled tiers (screen-regex / dwell-only) — webhook idles
  // by its real hook, so they carry no meaning there. Store only the non-default values.
  if (f.mode !== 'webhook') {
    if (!f.screenChangeImpliesWork) turn.screenChangeImpliesWork = false;
    const strip = f.chromeStripStr.split('\n').map((s) => s.trim()).filter(Boolean);
    if (strip.length) turn.chromeStripPatterns = strip;
  }

  let auth: ProviderAuth;
  if (f.authMode === 'login') {
    const lc = parseArgv(f.loginCommandStr);
    auth = lc.length ? { mode: 'login', loginCommand: lc } : { mode: 'login' };
  } else if (f.authMode === 'env') {
    auth = { mode: 'env' };
  } else {
    auth = { mode: 'none' };
  }

  const env: Record<string, string> = {};
  for (const { key, value } of f.env) if (key.trim()) env[key.trim()] = value;

  const def: ProviderDefInput = {
    id: `custom:${f.slug.trim()}` as CustomProviderId,
    displayName: f.displayName.trim(),
    command: parseArgv(f.commandStr),
    model,
    turn,
    approveKeys: { approve: parseList(f.approveStr), deny: parseList(f.denyStr) },
    auth,
  };
  if (f.configDirEnv.trim()) def.configDirEnv = f.configDirEnv.trim();
  if (Object.keys(env).length) def.env = env;
  if (f.secretEnvKeys.length) def.secretEnvKeys = f.secretEnvKeys;
  if (f.baseUrl.trim()) def.baseUrl = f.baseUrl.trim();
  return def;
}

/** Blocking validation — mirrors the §1.6 auth rules + the tier's minimum viable config so the
 *  operator isn't surprised by a server upsert rejection. Returns human messages; [] = ok. */
function validate(f: FormState): string[] {
  const e: string[] = [];
  if (!SLUG_RE.test(f.slug.trim())) e.push('Slug must be lowercase letters/digits/hyphens, ≤39 chars, starting alphanumeric.');
  if (!f.displayName.trim()) e.push('Display name is required.');
  if (parseArgv(f.commandStr).length === 0) e.push('Command is required.');
  // §1.6 auth coordination
  const hasHomeEnv = f.env.some((kv) => kv.key.trim() === 'HOME');
  if (f.authMode === 'login' && !f.configDirEnv.trim() && !hasHomeEnv)
    e.push('Login auth needs a config-dir env (or a HOME env row) so the login stays isolated (§1.6).');
  if (f.authMode === 'env' && f.secretEnvKeys.length === 0)
    e.push('Env auth needs at least one secret env key — the API key the CLI reads (§1.6).');
  // Tier minimum viable config
  if (f.mode === 'webhook' && (!f.hookRelPath.trim() || !f.hookTemplate.trim() || f.hookBindings.every((b) => !b.providerEvent.trim())))
    e.push('Webhook tier needs a hook file path, a template, and at least one event → signal binding.');
  if (f.mode === 'screen-regex' && !f.patTurnDone.trim())
    e.push('Screen-regex tier needs a turn-done pattern — it is what the poller demotes on.');
  // Regex sanity
  for (const [name, pat] of [
    ['turn-done', f.patTurnDone],
    ['needs-permission', f.patNeedsPermission],
    ['needs-input', f.patNeedsInput],
    ['busy', f.busyPattern],
  ] as const)
    if (regexInvalid(pat)) e.push(`The ${name} pattern is not a valid regular expression.`);
  for (const pat of f.chromeStripStr.split('\n').map((s) => s.trim()).filter(Boolean))
    if (regexInvalid(pat)) e.push(`Chrome-strip pattern "${pat}" is not a valid regular expression.`);
  return e;
}

// ============================================================================
//  Main panel
// ============================================================================

export function ProvidersPanel({
  api,
  adapters,
  profiles,
  brainProfileIds,
  onError,
  onOpenTerminal,
  reloadSignal,
  onQuickConnect,
  openForm,
  onOpenFormHandled,
}: {
  api: ProvidersApi;
  /** Full live roster from /api/adapters (built-ins + synthesized custom) — for routing pickers. */
  adapters: AdapterInfo[];
  /** SPEC-TESTING §1.7 — the logged-in account roster (GET /api/profiles), for the routing grids'
   *  per-role account selects. Optional; absent = the grids render without the account column. */
  profiles?: AgentProfile[];
  /** Every assistant Brain account's profileId — excluded from account dropdowns (UX only; the
   *  server's reserved-profile refusal is the real guard, SPEC-TESTING §1.4). */
  brainProfileIds?: string[];
  onError: (m: string) => void;
  /** Hop to a login/test terminal on the flightline. */
  onOpenTerminal: (id: string) => void;
  /** Integrator bumps this when a `{t:'providers'}` SSE frame arrives, to live-refresh (§1.1). */
  reloadSignal?: number;
  /** Quick Connect entry (SPEC-ONBOARDING §1): when provided, "Add provider" + the empty state
   *  open the guided chooser instead of the raw form — which stays reachable via the chooser's
   *  Advanced tile, hopping back here with `openForm` set. */
  onQuickConnect?: () => void;
  /** True → open the blank ProviderForm on arrival (the chooser's Advanced tile). */
  openForm?: boolean;
  /** Acknowledge `openForm` so a later revisit to this section doesn't re-open the form. */
  onOpenFormHandled?: () => void;
}) {
  const [providers, setProviders] = useState<ProviderDefView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<ProviderDefView | 'new' | null>(null);

  useEffect(() => {
    if (openForm) {
      setEditing('new');
      onOpenFormHandled?.();
    }
  }, [openForm, onOpenFormHandled]);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setProviders(await api.listProviders());
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
  }, [api, onError]);
  useEffect(() => {
    void load();
  }, [load, reloadSignal]);

  const remove = async (id: CustomProviderId) => {
    try {
      await api.removeProvider(id);
      if (editing !== 'new' && editing?.id === id) setEditing(null);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="pv">
      <section className="settings-section">
        <h2>Providers</h2>
        <p className="muted small">
          Register a coding harness as data — no code, no restart. Fill the form, Test it against the live endpoint, Save.
          It appears in every composer immediately.
        </p>
        {failed ? (
          <div className="muted small">
            Couldn’t load providers. <button className="btn-sm" onClick={() => void load()}>retry</button>
          </div>
        ) : providers === null ? (
          <div className="muted small">Loading…</div>
        ) : (
          <>
            <div className="pv-list">
              {providers.map((p) => (
                <ProviderRow
                  key={p.id}
                  def={p}
                  onEdit={() => setEditing(p)}
                  onRemove={() => void remove(p.id)}
                  onLogin={async () => {
                    try {
                      const t = await api.loginProvider(p.id);
                      onOpenTerminal(t.id);
                    } catch (e) {
                      onError((e as Error).message);
                    }
                  }}
                />
              ))}
              {providers.length === 0 && (
                <div className="muted small">
                  No custom providers yet.
                  {onQuickConnect && (
                    <>
                      {' '}
                      <button className="btn-sm" onClick={onQuickConnect}>Quick Connect</button>
                    </>
                  )}
                </div>
              )}
            </div>
            {editing === null && (
              <div style={{ marginTop: 10 }}>
                <button className="btn ok" onClick={() => (onQuickConnect ? onQuickConnect() : setEditing('new'))}>
                  Add provider
                </button>
              </div>
            )}
          </>
        )}

        {editing !== null && (
          <ProviderForm
            key={editing === 'new' ? '__new__' : editing.id}
            api={api}
            existing={editing === 'new' ? null : editing}
            onError={onError}
            onOpenTerminal={onOpenTerminal}
            onSaved={async () => {
              await load();
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </section>
    </div>
  );
}

// ---- Provider list row ----
function ProviderRow({
  def,
  onEdit,
  onRemove,
  onLogin,
}: {
  def: ProviderDefView;
  onEdit: () => void;
  onRemove: () => void;
  onLogin: () => void;
}) {
  const t = tierOf(def.turn.mode);
  // B4 secret-chip honesty: GREEN only when EVERY declared secretEnvKey has a stored value;
  // a partial set (n of m) is amber "n/m secrets", never a falsely-reassuring "secret set".
  const secretKeys = def.secretEnvKeys ?? [];
  const secretsPresent = secretKeys.filter((k) => def.hasSecret?.[k]).length;
  const allSecrets = secretKeys.length > 0 && secretsPresent === secretKeys.length;
  return (
    <div className="acct-row pv-row">
      <span className={`pv-tier ${t.tier.toLowerCase()}`} title={t.blurb}>
        Tier {t.tier}
      </span>
      <span className="acct-label">{def.displayName}</span>
      <span className="muted small mono">{def.id}</span>
      <span className="spacer" />
      <span className="chip">{def.auth.mode}</span>
      {secretKeys.length > 0 && (
        <span
          className={`chip ${allSecrets ? 'question' : 'hold'}`}
          title={allSecrets ? 'every declared secret is set' : `${secretsPresent} of ${secretKeys.length} declared secrets set`}
        >
          {allSecrets ? 'secrets set' : `${secretsPresent}/${secretKeys.length} secrets`}
        </span>
      )}
      {def.auth.mode === 'login' && (
        <button className="btn-sm" onClick={onLogin}>
          log in
        </button>
      )}
      <button className="btn-sm" onClick={onEdit}>
        edit
      </button>
      <button className="btn-sm danger" onClick={onRemove}>
        remove
      </button>
    </div>
  );
}

// ============================================================================
//  The add/edit provider form
// ============================================================================

function ProviderForm({
  api,
  existing,
  onError,
  onOpenTerminal,
  onSaved,
  onCancel,
}: {
  api: ProvidersApi;
  existing: ProviderDefView | null;
  onError: (m: string) => void;
  onOpenTerminal: (id: string) => void;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [f, setF] = useState<FormState>(() => (existing ? fromDef(existing) : blankForm()));
  // hasSecret presence follows the saved def; it updates when we ensureSaved / set / clear.
  const [hasSecret, setHasSecret] = useState<Record<string, boolean>>(() => existing?.hasSecret ?? {});
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);
  // Once saved (or when editing an existing def) the provider exists server-side and its id is
  // frozen — probing routes are id-keyed, so the slug becomes read-only.
  const [savedId, setSavedId] = useState<CustomProviderId | null>(existing?.id ?? null);

  // B1 dirty-tracking: ANY form-field change invalidates a prior probe result — a stale green
  // "Test passed" or a discovery note must never survive an edit to the fields it was based on.
  // (doDiscover re-sets discoverNote AFTER its own set('models'), so its note is preserved.)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((s) => ({ ...s, [k]: v }));
    setTest(null);
    setDiscoverNote(null);
  };
  const errors = useMemo(() => validate(f), [f]);
  const t = tierOf(f.mode);

  // ⟦AR-3⟧ keyring-native warning: a keyring CLI added without its disable flag.
  const keyringWarn = useMemo(() => {
    const argv = parseArgv(f.commandStr);
    const bin = argv[0]?.split('/').pop();
    const hit = KEYRING_CLIS.find((k) => bin === k.bin || argv.includes(k.bin));
    if (!hit) return null;
    const disabled = f.env.some((kv) => kv.key.trim() === hit.disableEnv && kv.value.trim() === '1');
    return disabled ? null : hit;
  }, [f.commandStr, f.env]);

  /** Persist the current form (create or replace), refresh the frozen id + secret presence,
   *  and hand back the saved def so probe actions can key off its id. Every probe (Test,
   *  Discover, Log in, Set secret) ensures-saved first — the server routes are id-keyed, so a
   *  def must exist to be probed. This is why J1 can "Test, then Save": Test persists too. */
  const ensureSaved = async (): Promise<ProviderDefView> => {
    const saved = await api.upsertProvider(toDef(f));
    setSavedId(saved.id);
    setHasSecret(saved.hasSecret ?? {});
    return saved;
  };

  const guard = async (fn: () => Promise<void>) => {
    const first = errors[0];
    if (first) {
      onError(first);
      return;
    }
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doSave = () =>
    guard(async () => {
      await ensureSaved();
      await onSaved();
    });

  const doTest = () =>
    guard(async () => {
      const saved = await ensureSaved();
      setTest(await api.testProvider(saved.id));
    });

  const doDiscover = () =>
    guard(async () => {
      const saved = await ensureSaved();
      const r = await api.discoverModels(saved.id);
      set('models', r.models);
      setDiscoverNote(r.note ?? (r.models.length ? null : 'No models returned.'));
    });

  const doLogin = () =>
    guard(async () => {
      const saved = await ensureSaved();
      const term = await api.loginProvider(saved.id);
      onOpenTerminal(term.id);
    });

  const setSecret = async (key: string, value: string) => {
    await guard(async () => {
      const saved = await ensureSaved(); // the key must be declared in secretEnvKeys first
      await api.setProviderSecret(saved.id, key, value);
      setHasSecret((h) => ({ ...h, [key]: true }));
    });
  };
  // B2: clearSecret operates on the ALREADY-SAVED provider (frozen savedId), not the current form,
  // so it must NOT run the whole-form guard() — a half-edited form (a transient validation error)
  // must never block removing a stored secret. Own busy + try/catch instead of the form guard.
  const clearSecret = async (key: string) => {
    if (!savedId) return;
    setBusy(true);
    try {
      await api.clearProviderSecret(savedId, key);
      setHasSecret((h) => ({ ...h, [key]: false }));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pv-form settings-form">
      <div className="pv-form-head">
        <strong>{existing ? `Edit ${existing.displayName}` : 'New provider'}</strong>
        <span className="spacer" />
        <button className="btn-sm ghost" onClick={onCancel}>
          cancel
        </button>
      </div>

      {/* ---- identity ---- */}
      <div className="field-row">
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Slug</label>
          <input
            value={f.slug}
            disabled={!!savedId}
            placeholder="aider-ollama"
            onChange={(e) => set('slug', e.target.value)}
          />
          <span className="hint">id becomes <span className="mono">custom:{f.slug || '<slug>'}</span>{savedId ? ' · fixed once saved' : ''}</span>
        </div>
        <div className="field">
          <label>Display name</label>
          <input value={f.displayName} placeholder="Aider (Ollama)" onChange={(e) => set('displayName', e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label>Command</label>
        <input
          className="mono"
          value={f.commandStr}
          placeholder="aider --model ollama/{{model}} --no-auto-commits"
          onChange={(e) => set('commandStr', e.target.value)}
        />
        <span className="hint">
          argv template. Placeholders: <span className="mono">{'{{model}} {{cwd}} {{repoPath}} {{baseUrl}}'}</span>. The
          model flag (below) is appended as a separate token — never string-concatenated.
        </span>
      </div>

      {keyringWarn && (
        <span className="settings-warn">
          ⚠ {keyringWarn.name} stores credentials in the OS keyring by default — that is global per-user, so it defeats
          this account’s config-dir isolation and breaks headless/WSL. Add an env row{' '}
          <span className="mono">{keyringWarn.disableEnv}=1</span> (and point{' '}
          <span className="mono">XDG_CONFIG_HOME={'{{configDir}}'}</span> at the isolated dir) to use the file store instead.
        </span>
      )}

      <div className="field-row">
        <div className="field">
          <label>Base URL</label>
          <input className="mono" value={f.baseUrl} placeholder="http://localhost:11434" onChange={(e) => set('baseUrl', e.target.value)} />
        </div>
        <div className="field" style={{ maxWidth: 240 }}>
          <label>Config-dir env</label>
          <input className="mono" value={f.configDirEnv} placeholder="CLAUDE_CONFIG_DIR" onChange={(e) => set('configDirEnv', e.target.value)} />
          <span className="hint">isolates this account’s config dir</span>
        </div>
      </div>

      {/* ---- non-secret env ---- */}
      <EnvEditor rows={f.env} onChange={(env) => set('env', env)} />

      {/* ---- auth mode ---- */}
      <AuthModeFields
        f={f}
        set={set}
        savedId={savedId}
        busy={busy}
        canProbe={errors.length === 0}
        onLogin={doLogin}
      />

      {/* ---- write-only secrets (§4) ---- */}
      <SecretRows
        keys={f.secretEnvKeys}
        hasSecret={hasSecret}
        primary={f.authMode === 'env'}
        onAddKey={(k) => set('secretEnvKeys', [...f.secretEnvKeys, k])}
        onRemoveKey={(k) => set('secretEnvKeys', f.secretEnvKeys.filter((x) => x !== k))}
        onSet={setSecret}
        onClear={clearSecret}
        busy={busy}
      />

      {/* ---- model config + discovery (§3) ---- */}
      <ModelConfig
        f={f}
        set={set}
        onDiscover={doDiscover}
        canDiscover={errors.length === 0 && !!f.baseUrl.trim()}
        busy={busy}
        note={discoverNote}
      />

      {/* ---- turn detection tier (§1.4) ---- */}
      <TurnDetection f={f} set={set} />

      {/* ---- approve/deny keys ---- */}
      <div className="field-row">
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Approve keys</label>
          <input className="mono" value={f.approveStr} placeholder="y, enter" onChange={(e) => set('approveStr', e.target.value)} />
          <span className="hint">comma-separated keys the Tower sends to approve</span>
        </div>
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Deny keys</label>
          <input className="mono" value={f.denyStr} placeholder="n, esc" onChange={(e) => set('denyStr', e.target.value)} />
        </div>
      </div>

      {/* ---- validation + actions ---- */}
      {errors.length > 0 && (
        <ul className="pv-errors">
          {errors.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}

      {test && (
        <div className={`pv-test ${test.ok ? 'ok' : 'bad'}`}>
          <strong>{test.ok ? 'Test passed' : 'Test failed'}</strong>
          {test.discovery && (
            <div className="small">
              discovery: {test.discovery.ok ? `ok (${test.discovery.count ?? 0} models)` : `failed`}
              {test.discovery.note ? ` — ${test.discovery.note}` : ''}
            </div>
          )}
          {test.drySpawn && (
            <div className="small">
              dry spawn: {test.drySpawn.ok ? 'ok' : 'failed'}
              {test.drySpawn.note ? ` — ${test.drySpawn.note}` : ''}
            </div>
          )}
          {test.error && <div className="small">{test.error}</div>}
        </div>
      )}

      <div className="pv-actions">
        <button className="btn ok" disabled={busy || errors.length > 0} onClick={() => void doSave()}>
          {busy ? 'Working…' : existing ? 'Save changes' : 'Save provider'}
        </button>
        <button className="btn" disabled={busy || errors.length > 0} onClick={() => void doTest()} title="Saves the provider, then probes discovery + a dry spawn">
          Test
        </button>
        <button className="btn ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <span className="hint">Test and Discover save the provider first (their probes are keyed by its id).</span>
    </div>
  );
}

// ---- non-secret env rows ----
function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (r: EnvRow[]) => void }) {
  const setRow = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="pv-fieldset">
      <legend className="pv-legend">Environment (non-secret)</legend>
      <span className="hint">
        Interpolates <span className="mono">{'{{baseUrl}} {{cwd}} {{towerPort}} {{configDir}}'}</span>. Secret-looking
        values are rejected on save — put API keys in the Secrets section below.
      </span>
      {rows.map((r, i) => {
        const warn = looksSecret(r.key, r.value);
        return (
          <div key={i} className="pv-kv">
            <input className="mono" placeholder="OLLAMA_API_BASE" value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} />
            <span className="pv-eq">=</span>
            <input className="mono" placeholder="{{baseUrl}}" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
            <button className="btn-sm danger" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
            {warn && <span className="pv-inline-warn">looks like a secret → move to Secrets</span>}
          </div>
        );
      })}
      <button className="btn-sm" onClick={() => onChange([...rows, { key: '', value: '' }])}>
        + env var
      </button>
    </fieldset>
  );
}

// ---- auth mode selector ----
function AuthModeFields({
  f,
  set,
  savedId,
  busy,
  canProbe,
  onLogin,
}: {
  f: FormState;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  savedId: CustomProviderId | null;
  busy: boolean;
  canProbe: boolean;
  onLogin: () => void;
}) {
  return (
    <div className="field">
      <label>Authentication</label>
      <div className="seg-choice">
        {(['none', 'env', 'login'] as ProviderAuth['mode'][]).map((m) => (
          <button key={m} className={f.authMode === m ? 'sel' : ''} onClick={() => set('authMode', m)}>
            {m === 'none' ? 'None (local)' : m === 'env' ? 'API key (env)' : 'Login (subscription)'}
          </button>
        ))}
      </div>
      {f.authMode === 'none' && <span className="hint">A local model with no credentials (Ollama / vLLM / llama.cpp).</span>}
      {f.authMode === 'env' && (
        <span className="hint">The CLI reads an API key from its env — declare the key name(s) in Secrets below; the value is stored write-only.</span>
      )}
      {f.authMode === 'login' && (
        <div className="pv-login">
          <span className="hint">
            The harness runs its OWN login in an isolated config dir — the Tower never captures the token. Requires a
            config-dir env (or a HOME env row).
          </span>
          <div className="field" style={{ maxWidth: 420 }}>
            <label>Login command (optional)</label>
            <input
              className="mono"
              value={f.loginCommandStr}
              placeholder="opencode auth login   (blank = run the main command, e.g. pi’s in-REPL /login)"
              onChange={(e) => set('loginCommandStr', e.target.value)}
            />
          </div>
          <button className="btn" disabled={busy || !canProbe} onClick={onLogin} title={savedId ? 'Opens a login terminal on the flightline' : 'Saves the provider, then opens a login terminal'}>
            Log in{savedId ? '' : ' (saves first)'}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- write-only secret rows (§4) ----
function SecretRows({
  keys,
  hasSecret,
  primary,
  onAddKey,
  onRemoveKey,
  onSet,
  onClear,
  busy,
}: {
  keys: string[];
  hasSecret: Record<string, boolean>;
  primary: boolean;
  onAddKey: (k: string) => void;
  onRemoveKey: (k: string) => void;
  onSet: (k: string, v: string) => void;
  onClear: (k: string) => void;
  busy: boolean;
}) {
  const [newKey, setNewKey] = useState('');
  return (
    <fieldset className={`pv-fieldset ${primary ? 'pv-primary' : ''}`}>
      <legend className="pv-legend">Secrets{primary ? ' (required for API-key auth)' : ''}</legend>
      <span className="hint">
        Env var NAMES injected from the write-only store at spawn. Values are never shown or logged.{' '}
        <span className="pv-inline-warn">
          A key in the spawn env is agent-self-exfiltratable — worse than the git PAT (no host allowlist). This is a
          v1 residual you sign off on (§4.3).
        </span>
      </span>
      {keys.map((k) => (
        <SecretRow key={k} name={k} present={!!hasSecret[k]} busy={busy} onSet={(v) => onSet(k, v)} onClear={() => onClear(k)} onRemove={() => onRemoveKey(k)} />
      ))}
      <div className="pv-kv">
        <input className="mono" placeholder="OPENAI_API_KEY" value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())} />
        <button
          className="btn-sm"
          disabled={!newKey.trim() || keys.includes(newKey.trim())}
          onClick={() => {
            onAddKey(newKey.trim());
            setNewKey('');
          }}
        >
          + secret key
        </button>
      </div>
    </fieldset>
  );
}

function SecretRow({
  name,
  present,
  busy,
  onSet,
  onClear,
  onRemove,
}: {
  name: string;
  present: boolean;
  busy: boolean;
  onSet: (v: string) => void;
  onClear: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  return (
    <div className="acct-row pv-secret">
      <span className="mono small">{name}</span>
      <span className="spacer" />
      {editing ? (
        <>
          <input className="nt-label" type="password" placeholder="paste value" value={val} onChange={(e) => setVal(e.target.value)} />
          <button
            className="btn-sm ok"
            disabled={busy || !val.trim()}
            onClick={() => {
              onSet(val.trim());
              setVal('');
              setEditing(false);
            }}
          >
            save
          </button>
          <button className="btn-sm" onClick={() => { setVal(''); setEditing(false); }}>
            cancel
          </button>
        </>
      ) : (
        <>
          <span className={`chip ${present ? 'question' : ''}`}>{present ? 'set' : 'not set'}</span>
          <button className="btn-sm" disabled={busy} onClick={() => setEditing(true)}>
            {present ? 'replace' : 'set'}
          </button>
          {present && (
            <button className="btn-sm danger" disabled={busy} onClick={onClear}>
              clear
            </button>
          )}
          <button className="btn-sm danger" disabled={busy} onClick={onRemove} title="Remove this env var name from the def">
            ✕
          </button>
        </>
      )}
    </div>
  );
}

// ---- model config + discovery (§3) ----
function ModelConfig({
  f,
  set,
  onDiscover,
  canDiscover,
  busy,
  note,
}: {
  f: FormState;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  onDiscover: () => void;
  canDiscover: boolean;
  busy: boolean;
  note: string | null;
}) {
  return (
    <fieldset className="pv-fieldset">
      <legend className="pv-legend">Model</legend>
      <div className="field-row">
        <div className="field" style={{ maxWidth: 160 }}>
          <label>Model flag</label>
          <input className="mono" value={f.modelFlag} placeholder="--model" onChange={(e) => set('modelFlag', e.target.value)} />
          <span className="hint">appended before the model as a separate token</span>
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Model env</label>
          <input className="mono" value={f.modelEnv} placeholder="OLLAMA_MODEL" onChange={(e) => set('modelEnv', e.target.value)} />
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label>Default model</label>
          <input className="mono" value={f.defaultModel} placeholder="llama3.2" onChange={(e) => set('defaultModel', e.target.value)} />
          <span className="hint">final routing fallback</span>
        </div>
      </div>
      <div className="field-row">
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Discovery path</label>
          <input className="mono" value={f.modelsPath} placeholder="/v1/models  (Ollama native: /api/tags)" onChange={(e) => set('modelsPath', e.target.value)} />
        </div>
        <div className="field" style={{ justifyContent: 'flex-end' }}>
          <button className="btn-sm" disabled={busy || !canDiscover} onClick={onDiscover} title={canDiscover ? 'Probe the base URL for models (saves first)' : 'Set a base URL and fix validation to discover'}>
            Discover models
          </button>
        </div>
      </div>
      {note && <span className="pv-inline-warn">{note}</span>}
      {f.models.length > 0 && (
        <div className="pv-roster">
          {f.models.map((m) => (
            <span key={m.id} className="pv-model-chip mono" title={fmtVerified(m.verifiedAt)}>
              {m.id}
            </span>
          ))}
        </div>
      )}
    </fieldset>
  );
}

// ---- turn-detection tier (§1.4) ----
function TurnDetection({
  f,
  set,
}: {
  f: FormState;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  const t = tierOf(f.mode);
  const setBinding = (i: number, patch: Partial<HookBindingRow>) =>
    set('hookBindings', f.hookBindings.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <fieldset className="pv-fieldset">
      <legend className="pv-legend">
        Turn detection <span className={`pv-tier ${t.tier.toLowerCase()}`}>Tier {t.tier}</span>
      </legend>
      <div className="seg-choice">
        {TIERS.map((x) => (
          <button key={x.mode} className={f.mode === x.mode ? 'sel' : ''} onClick={() => set('mode', x.mode)}>
            {x.label}
          </button>
        ))}
      </div>
      <span className="hint">{t.blurb}</span>

      {f.mode === 'dwell-only' && (
        <span className="settings-warn">
          ⚠ Degraded tier — inferred completion. This provider will carry an amber “inferred completion — degraded”
          badge on the flightline and Board. A hosted API is the worst case here (a model thinking silently with no
          busy-text and no open socket can false-idle) — prefer webhook or screen-regex for those.
        </span>
      )}

      {f.mode === 'webhook' && (
        <>
          <div className="field">
            <label>Hook file (relative to config dir)</label>
            <input className="mono" value={f.hookRelPath} placeholder="tower-hooks.toml" onChange={(e) => set('hookRelPath', e.target.value)} />
            <span className="hint">a dedicated Tower-owned file — never the CLI’s primary config</span>
          </div>
          <div className="field">
            <label>Hook template</label>
            <textarea
              className="mono"
              value={f.hookTemplate}
              placeholder={'notify = "{{HOOK_SCRIPT}} {{SIGNAL:turn-done}}"'}
              onChange={(e) => set('hookTemplate', e.target.value)}
            />
            <span className="hint">
              Placeholders: <span className="mono">{'{{HOOK_SCRIPT}}'}</span>, <span className="mono">{'{{SIGNAL:<signal>}}'}</span>.
            </span>
          </div>
          <div className="field">
            <label>Event → signal bindings</label>
            {f.hookBindings.map((b, i) => (
              <div key={i} className="pv-kv">
                <input className="mono" placeholder="provider event (e.g. Stop)" value={b.providerEvent} onChange={(e) => setBinding(i, { providerEvent: e.target.value })} />
                <span className="pv-eq">→</span>
                <select value={b.signal} onChange={(e) => setBinding(i, { signal: e.target.value as HookSignal })}>
                  {HOOK_SIGNALS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <button className="btn-sm danger" onClick={() => set('hookBindings', f.hookBindings.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <button className="btn-sm" onClick={() => set('hookBindings', [...f.hookBindings, { providerEvent: '', signal: 'turn-done' }])}>
              + binding
            </button>
          </div>
        </>
      )}

      {f.mode === 'screen-regex' && (
        <div className="field-row">
          <div className="field">
            <label>Turn-done pattern</label>
            <input className="mono" value={f.patTurnDone} placeholder="^(> |\\? )" onChange={(e) => set('patTurnDone', e.target.value)} />
            <span className="hint">what the poller demotes to idle on (required)</span>
          </div>
          <div className="field">
            <label>Needs-permission pattern</label>
            <input className="mono" value={f.patNeedsPermission} placeholder="(y/n)" onChange={(e) => set('patNeedsPermission', e.target.value)} />
          </div>
          <div className="field">
            <label>Needs-input pattern</label>
            <input className="mono" value={f.patNeedsInput} onChange={(e) => set('patNeedsInput', e.target.value)} />
          </div>
        </div>
      )}

      {f.mode === 'dwell-only' && (
        <div className="field-row">
          <div className="field">
            <label>Busy pattern (optional)</label>
            <input className="mono" value={f.busyPattern} placeholder="Thinking…|Generating" onChange={(e) => set('busyPattern', e.target.value)} />
            <span className="hint">pane text meaning “still working” — blocks a false idle</span>
          </div>
          <label className="settings-toggle" style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>
            <input type="checkbox" checked={f.socketBusy} onChange={(e) => set('socketBusy', e.target.checked)} />
            <span>An open outbound socket counts as work</span>
          </label>
        </div>
      )}

      {f.mode !== 'webhook' && (
        <details className="pv-advanced">
          <summary>Advanced — animated idle TUI (optional)</summary>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={f.screenChangeImpliesWork}
              onChange={(e) => set('screenChangeImpliesWork', e.target.checked)}
            />
            <span>A screen-content change counts as work</span>
          </label>
          <span className="hint">
            uncheck for a TUI that animates while idle — then only live children or a parse/hook signal count as work
          </span>
          <div className="field">
            <label>Chrome-strip patterns (one regex per line)</label>
            <textarea
              className="mono"
              value={f.chromeStripStr}
              placeholder={'^\\s*›\n^\\s+\\S.* · ~?/'}
              onChange={(e) => set('chromeStripStr', e.target.value)}
            />
            <span className="hint">
              pane lines matching any pattern are stripped before the poller hashes, so animated idle chrome isn’t read as work
            </span>
          </div>
        </details>
      )}
    </fieldset>
  );
}

// ============================================================================
//  RoleRoutingGrid — the reusable role → (provider, model) grid (SPEC-ROUTING §5)
// ============================================================================

/**
 * One grid over any RoleRouting: the global defaults, a workflow's routes, or a project's
 * ad-hoc overrides. Overrides are per-role ATOMIC: the model input stays disabled
 * until the row has a provider, switching provider clears the model (a model id
 * belongs to a provider), and clearing the provider removes the WHOLE entry. In a project
 * context that empty option is an explicit "inherit" — never a half-filled override that
 * silently loses a typed model. `notes` renders the caller-computed per-row annotation
 * (the inherited effective value + source, or the "model not inherited" drop).
 *
 * SPEC-TESTING §1.7 — when `profiles` is provided each row grows a third control: an account
 * select over the row's provider's logged-in profiles (minus the reserved Brain profiles),
 * '' = the shared per-provider login dir. Like the model it clears on provider switch (an
 * account belongs to a provider) and stays disabled until the row has one.
 */
export function RoleRoutingGrid({
  routes,
  onChange,
  adapters,
  profiles,
  brainProfileIds,
  inheritLabel = '— unset —',
  notes,
}: {
  routes: RoleRouting;
  onChange: (next: RoleRouting) => void;
  /** Agent roster for the provider pickers — pass pre-filtered (no 'shell' sentinel, §2.1). */
  adapters: AdapterInfo[];
  /** Logged-in account roster for the per-role account selects (§1.7). Absent = no account column. */
  profiles?: AgentProfile[];
  /** Every assistant Brain account's profileId — filtered out of the account options (UX only). */
  brainProfileIds?: string[];
  /** Empty provider option label: '— unset —' (global/workflow) or 'Inherit' (project rows). */
  inheritLabel?: string;
  /** Muted per-row annotation under the pickers (inherited value / the RT-5 drop). */
  notes?: Partial<Record<PipelineRole, string>>;
}) {
  const withAccounts = profiles !== undefined;
  // Account options per row: this provider's logins, minus the Brains (§1.4 — cosmetic here; the
  // server refuses a reserved profileId on write regardless of what a client sends).
  const accountsFor = (provider?: ProviderId) =>
    (profiles ?? []).filter((p) => p.provider === provider && !brainProfileIds?.includes(p.id));

  const setRole = (
    role: PipelineRole,
    patch: { provider?: ProviderId; model?: string; effort?: string; profileId?: string } | null,
  ) => {
    const next: RoleRouting = { ...routes };
    if (patch === null || !patch.provider) {
      delete next[role]; // no provider = the row is unset/inherited — never a provider-less override
    } else {
      const a: RoleAssignment = { provider: patch.provider };
      if (patch.model?.trim()) a.model = patch.model.trim();
      if (patch.effort?.trim()) a.effort = patch.effort.trim(); // SPEC-EFFORT §4 — carry the row's effort
      if (patch.profileId) a.profileId = patch.profileId;
      next[role] = a;
    }
    onChange(next);
  };

  return (
    <>
      {PIPELINE_ROLES.map((role) => {
        const cur = routes[role.id];
        const accounts = accountsFor(cur?.provider);
        const note = notes?.[role.id];
        return (
          <div key={role.id} className={`pv-route${withAccounts ? ' with-acct' : ''}`}>
            <div className="pv-route-role">
              <span className="acct-label">{role.label}</span>
              <span className="hint">{role.hint}</span>
            </div>
            <select
              value={cur?.provider ?? ''}
              // Switching provider CLEARS the model, effort AND account: all belong to a provider,
              // and carrying any forward persists a cross-provider triple that only fails at
              // spawn (role-routing validation is format-only). Re-pick from the fresh lists.
              onChange={(e) => setRole(role.id, e.target.value ? { provider: e.target.value as ProviderId, model: undefined, effort: undefined, profileId: undefined } : null)}
            >
              <option value="">{inheritLabel}</option>
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
            {/* SPEC-MODELS §3 — the shared roster picker (built-in curated/live catalogs + custom
                def rosters) replaces the old per-provider datalist; disabled until a provider is set. */}
            <ModelSelect
              provider={cur?.provider}
              value={cur?.model ?? ''}
              // Carry effort forward on a model switch (SPEC-EFFORT §4 keep-on-model-switch): a per-model
              // set mismatch is warning-tier, so the effort must not be silently wiped.
              onChange={(v) => setRole(role.id, { provider: cur?.provider, model: v, effort: cur?.effort, profileId: cur?.profileId })}
              profileId={cur?.profileId}
              disabled={!cur?.provider}
              allowEmpty
              compact
              ariaLabel={`${role.label} model`}
            />
            {/* SPEC-EFFORT §4 — the effort picker between model and account; codex/claude only, disabled
                until a provider is set. Carries model + account forward so only effort changes here. */}
            <EffortSelect
              provider={cur?.provider}
              model={cur?.model}
              profileId={cur?.profileId}
              value={cur?.effort ?? ''}
              onChange={(v) => setRole(role.id, { provider: cur?.provider, model: cur?.model, effort: v || undefined, profileId: cur?.profileId })}
              disabled={!cur?.provider}
              compact
              ariaLabel={`${role.label} effort`}
            />
            {withAccounts && (
              <select
                className="pv-route-acct"
                disabled={!cur?.provider}
                value={cur?.profileId ?? ''}
                // Carry effort forward on an account switch (SPEC-EFFORT §4 keep-on-account-switch).
                onChange={(e) => setRole(role.id, { provider: cur?.provider, model: cur?.model, effort: cur?.effort, profileId: e.target.value || undefined })}
              >
                <option value="">shared login</option>
                {/* A stored account that no longer resolves (deleted profile / the Brain) keeps
                    its option so the select stays truthful; the server warns at the start gate. */}
                {cur?.profileId && !accounts.some((p) => p.id === cur.profileId) && (
                  <option value={cur.profileId}>(missing account {cur.profileId})</option>
                )}
                {accounts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
            {note && <span className="pv-route-note">{note}</span>}
          </div>
        );
      })}
      <span className="hint">
        {withAccounts
          ? 'Overriding a role replaces the whole row (provider, model, effort, account) — the model, effort and account controls unlock once the row has a provider. "Shared login" = the provider’s shared login dir.'
          : 'Overriding a role replaces its provider, model and effort — the model and effort inputs unlock once the row has a provider.'}
      </span>
    </>
  );
}

// ============================================================================
//  Routing: global role defaults (§2.1) + workflow profiles (SPEC-ROUTING §2/§5)
// ============================================================================

export function RoutingSection({
  api,
  adapters,
  profiles,
  brainProfileIds,
  onError,
}: {
  api: ProvidersApi;
  adapters: AdapterInfo[];
  profiles?: AgentProfile[];
  brainProfileIds?: string[];
  onError: (m: string) => void;
}) {
  const [routing, setRouting] = useState<RoleRouting | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      setRouting(await api.getRouting());
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
  }, [api, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  // The roster for the provider pickers: every agent provider (built-ins + synthesized custom),
  // never the 'shell' sentinel (§2.1). displayName comes from the live /api/adapters list.
  const agentAdapters = useMemo(() => adapters.filter((a) => a.id !== 'shell'), [adapters]);

  const save = async () => {
    if (!routing) return;
    setBusy(true);
    try {
      setRouting(await api.setRouting(routing));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Routing</h2>
      <p className="muted small">
        Per-role defaults resolve a sortie’s provider + model when it isn’t overridden per-sortie. Each row is optional;
        an unset role falls through to the mission/global default. Workflows bundle a set of rows a project can select
        (Settings → Projects).
      </p>
      <fieldset className="pv-fieldset">
        <legend className="pv-legend">Global defaults</legend>
        {failed ? (
          <div className="muted small">
            Couldn’t load routing. <button className="btn-sm" onClick={() => void load()}>retry</button>
          </div>
        ) : routing === null ? (
          <div className="muted small">Loading…</div>
        ) : (
          <div className="settings-form" style={{ maxWidth: 620 }}>
            <RoleRoutingGrid
              routes={routing}
              onChange={setRouting}
              adapters={agentAdapters}
              profiles={profiles}
              brainProfileIds={brainProfileIds}
            />
            <div>
              <button className="btn ok" disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save routing'}
              </button>
            </div>
          </div>
        )}
      </fieldset>
      <WorkflowsEditor
        api={api}
        adapters={agentAdapters}
        profiles={profiles}
        brainProfileIds={brainProfileIds}
        onError={onError}
      />
    </section>
  );
}

// ---- Workflow profiles: named, reusable role→(provider,model) bundles (§2) ----

function WorkflowsEditor({
  api,
  adapters,
  profiles,
  brainProfileIds,
  onError,
}: {
  api: ProvidersApi;
  adapters: AdapterInfo[];
  profiles?: AgentProfile[];
  brainProfileIds?: string[];
  onError: (m: string) => void;
}) {
  const [workflows, setWorkflows] = useState<WorkflowProfile[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Unsaved new workflows: local drafts with client-minted ids, saved on their card's Save
  // (never eagerly created server-side — an abandoned Add leaves no junk profile behind).
  const [drafts, setDrafts] = useState<WorkflowUpsert[]>([]);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setWorkflows(await api.listWorkflows());
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
  }, [api, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  const addDraft = () => setDrafts((d) => [...d, { id: crypto.randomUUID(), name: '', routes: {} }]);
  const dropDraft = (id: string) => setDrafts((d) => d.filter((w) => w.id !== id));

  return (
    <fieldset className="pv-fieldset" style={{ marginTop: 12 }}>
      <legend className="pv-legend">Workflows</legend>
      <span className="hint">
        A workflow is a named role→provider bundle a project can select in Settings → Projects. A project’s own
        per-role overrides beat it; its unset rows fall through to these, then to the global defaults.
      </span>
      {failed ? (
        <div className="muted small">
          Couldn’t load workflows. <button className="btn-sm" onClick={() => void load()}>retry</button>
        </div>
      ) : workflows === null ? (
        <div className="muted small">Loading…</div>
      ) : (
        <>
          {workflows.map((w) => (
            <WorkflowCard
              key={w.id}
              initial={w}
              saved
              api={api}
              adapters={adapters}
              profiles={profiles}
              brainProfileIds={brainProfileIds}
              onError={onError}
              onChanged={load}
            />
          ))}
          {drafts.map((w) => (
            <WorkflowCard
              key={w.id}
              initial={w}
              saved={false}
              api={api}
              adapters={adapters}
              profiles={profiles}
              brainProfileIds={brainProfileIds}
              onError={onError}
              onChanged={async () => {
                dropDraft(w.id);
                await load();
              }}
              onDiscard={() => dropDraft(w.id)}
            />
          ))}
          {workflows.length === 0 && drafts.length === 0 && (
            <div className="muted small">No workflows yet — add one to route a whole project in one pick.</div>
          )}
          <div>
            <button className="btn-sm" onClick={addDraft}>+ workflow</button>
          </div>
        </>
      )}
    </fieldset>
  );
}

function WorkflowCard({
  initial,
  saved,
  api,
  adapters,
  profiles,
  brainProfileIds,
  onError,
  onChanged,
  onDiscard,
}: {
  initial: WorkflowUpsert;
  /** false = a local draft (Save creates it; Discard drops it with no server call). */
  saved: boolean;
  api: ProvidersApi;
  adapters: AdapterInfo[];
  profiles?: AgentProfile[];
  brainProfileIds?: string[];
  onError: (m: string) => void;
  /** Fired after a successful save/delete so the parent reloads the list. */
  onChanged: () => void | Promise<void>;
  onDiscard?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [routes, setRoutes] = useState<RoleRouting>(initial.routes);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      onError('A workflow needs a name.');
      return;
    }
    setBusy(true);
    try {
      await api.upsertWorkflow({
        id: initial.id,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        routes,
      });
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Delete is server-refused (409, naming the referencing projects) while any project selects
  // this workflow — the message lands in onError, nothing is silently unassigned.
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteWorkflow(initial.id);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wf-card">
      <div className="wf-head">
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Name</label>
          <input placeholder="local-only" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Description (optional)</label>
          <input
            placeholder="what this bundle is for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <RoleRoutingGrid
        routes={routes}
        onChange={setRoutes}
        adapters={adapters}
        profiles={profiles}
        brainProfileIds={brainProfileIds}
      />
      <div className="pv-actions">
        <button className="btn ok" disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? 'Working…' : saved ? 'Save workflow' : 'Create workflow'}
        </button>
        {saved ? (
          <button className="btn-sm danger" disabled={busy} onClick={() => void remove()}>
            delete
          </button>
        ) : (
          <button className="btn-sm ghost" disabled={busy} onClick={onDiscard}>
            discard
          </button>
        )}
      </div>
    </div>
  );
}
