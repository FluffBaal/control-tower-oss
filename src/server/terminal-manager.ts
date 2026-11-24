// Owns the lifecycle of tmux-backed terminals and bridges them to WebSocket
// viewers via node-pty. A terminal survives browser refresh (reconnect = new
// attach), Tower restart (tmux server keeps running; reconciler re-adopts), and
// is only truly gone when its tmux server dies (SPEC D6/§5).

import pty from 'node-pty';
import type { IPty } from 'node-pty';
import { mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Store } from './store.js';
import type { Project, Terminal, ProviderId, CustomProviderId, GitHubIdentity, ProviderDef, Loop, Mission } from '../shared/types.js';
import { shortId, uuid } from './ids.js';
import { audit } from './audit.js';
import { paths } from './paths.js';
import * as tmux from './tmux.js';
import * as git from './git.js';
// Registry-backed resolver (⟦DP-3⟧): a custom id resolves to its SYNTHESIZED adapter, or a
// throwing tombstone if the def was deleted — NEVER a silent login shell (the §0.2 hazard).
import { getAdapter } from './providers/registry.js';
import { claudeSessionArgv, findClaudeTranscript } from './adapters/claude.js';
import { materializeSkills } from './skills/materialize.js';
import type { SkillStore } from './skills/store.js';
import type { LaunchContext } from './adapters/types.js';
import type { HookTokens } from './hooks.js';
import type { WorktreeManager, CreatedWorktree } from './worktrees.js';
import type { Accounts } from './accounts.js';
import type { Broker } from './broker.js';
import type { Leases } from './leases.js';
import type { ProviderStore } from './providers/store.js';
import { isReservedEnvName } from './providers/store.js';
import { readSecretEnv } from './providers/secrets.js';
// SPEC-RUNWAY live-swap -- TYPE-ONLY (erased at compile): runway/live-swap.ts imports the cred refresher,
// which imports this module, so a value import here would be a cycle. performLiveSwap itself is INJECTED
// (deps.liveSwap), wired in server.ts.
import type { LiveSwapResult, LiveSwapDeps } from './runway/live-swap.js';
import { liveSlotGate, seedLiveSlot, removeLiveSlot } from './live-slot.js';

/**
 * SPEC-RESTART-RESUME — the resume-attempt's DETACHED health-check timing (watchClaudeResume).
 * Exported so a future regression to a too-short cap can be pinned with a plain STATIC assertion
 * (see terminal-manager-resume-probe.test.ts) instead of a flaky wall-clock race: MEASURED against a
 * real claude 2.1.278 on this machine, a refused `--resume` dies at ~1.5-2.8s under remain-on-exit
 * (finer 25ms sampling ~1.5s, a coarser review pass ~2.8s). 6s
 * gives real margin above the higher figure and stays comfortably under the
 * reconciler's own ~15s sweep, so the fall-forward wins that race. Do not lower this without new
 * measured evidence — a synchronous or too-short check is exactly the SEVERE bug this design fixes.
 */
export const RESUME_PROBE_CAP_MS = 6000;
export const RESUME_PROBE_INTERVAL_MS = 500;

/** A single attached viewer (one WebSocket). */
export interface Viewer {
  write(data: string): void;
  close(code: number | null): void;
}

interface Attachment {
  pty: IPty;
  viewer: Viewer;
}

export interface TerminalManagerDeps {
  hookTokens: HookTokens;
  hookScript: string;
  towerPort: number;
  worktrees: WorktreeManager;
  accounts: Accounts;
  broker: Broker;
  credentialScript: string;
  brokerSock: string;
  leases: Leases;
  /**
   * §4.2 The custom-provider registry store. Used ONLY to (a) snapshot a custom def
   * onto the terminal at launch (Terminal.providerDef, so a later edit/delete can't change a
   * live terminal's turn detection) and (b) resolve declared secretEnvKeys to their 0600
   * values for the single spawn-env merge. get(id) returns undefined for built-ins/shell
   * (they carry no def and no secrets), so they are unaffected. Integrator wires the singleton.
   */
  providers: ProviderStore;
  /** SPEC-SKILLS Phase 1 — the central skill library, a READ-ONLY consumer here: list/getBody/readAsset
   *  reads at spawn to materialize the eligible skills into the provider's config dir; never mutated. */
  skills: SkillStore;
  /** SPEC-TERMINAL-OPS §3.2 — the effective global cap on LIVE terminals, read at call time (the
   *  operator can change it in Settings while the Tower runs). Wired from Settings by the integrator. */
  maxTerminals: () => number;
  /** SPEC-RUNWAY — absolute path to the ct-usage statusLine forwarder. Installed on claude-code panes
   *  (as a statusLine) only while Runway is enabled, so the pane reports its rate_limits to the Tower.
   *  Optional: absent (e.g. in tests) ⇒ no usage statusLine is ever installed. */
  usageScript?: string;
  /** SPEC-RUNWAY — read at call time: is subscription rotation enabled? Gates the statusLine install
   *  (Runway defaults off, so no pane gets a usage statusLine until the operator turns it on). Optional. */
  runway?: () => { enabled: boolean; liveSwap: boolean; pool: readonly string[] };
  /**
   * SPEC-RESTART-RESUME — late-bound hook: fired from restartTerminal's detached fall-forward when a
   * `--resume` attempt's async health-check finds the pane dead AFTER the call already returned an
   * OPTIMISTIC resumed:true. Corrects the bound loop's memory mode (the fresh replacement session
   * carries no context — full, never delta) and refreshes the UI exactly as the restart route's own
   * post-respawn fan-out does (the integrator wires it to `loops.onTerminalRestarted(id,
   * {resumed:false})` + a poller/mission refresh). Optional: tests with no loop runtime and no UI to
   * refresh omit it — the terminal record itself is corrected either way, hook or not.
   */
  onResumeFallForward?: (terminalId: string) => void;
  /**
   * SPEC-RESTART-RESUME — TEST-ONLY override for watchClaudeResume's poll interval/cap. Production
   * always omits this (falls back to RESUME_PROBE_CAP_MS / RESUME_PROBE_INTERVAL_MS — the measured,
   * real-CLI-covering timing). Exists so tests can exercise the death/survives-the-cap BEHAVIOR
   * without a multi-second real wait — real timing is what makes the probe correct against a real
   * CLI, so this must never be set outside a test harness.
   */
  resumeProbe?: { capMs: number; intervalMs: number };
  /** SPEC-RUNWAY live-swap -- the INJECTED credential-swap primitive (server.ts passes performLiveSwap;
   *  injected rather than imported to avoid the live-swap -> cred-refresher -> terminal-manager import
   *  cycle, mirroring resumeProbe/ping). Absent => liveSwapTerminal reports `not-configured`. Tests inject
   *  a fake. */
  liveSwap?: (input: { liveConfigDir: string; targetConfigDir: string }, deps?: LiveSwapDeps) => Promise<LiveSwapResult>;
}

/** liveSwapTerminal's result: the primitive's own result, or a refusal raised before any lock is taken. */
export type TerminalLiveSwapResult =
  | LiveSwapResult
  | {
      ok: false;
      reason: 'not-slotted' | 'not-configured' | 'unknown-target' | 'reserved-target' | 'unsigned-target' | 'same-account' | 'in-progress' | 'gone';
    };

export interface CreateTerminalOpts {
  title?: string;
  provider?: ProviderId;
  /** Create the terminal inside a fresh git worktree (isolated branch). */
  worktree?: boolean;
  taskLabel?: string;
  /** Named provider account (isolated config dir) + GitHub identity to run as. */
  profileId?: string;
  identityId?: string;
  /** Resolved model slug threaded to LaunchContext.model → each adapter's buildCommand:
   *  a custom provider's {{model}} interpolation, or a built-in's model flag (codex -m / claude
   *  --model / gemini -m). Set by resolveRouting; allowlist-gated at the start gate before spawn. */
  model?: string;
  /** SPEC-EFFORT §3 Resolved reasoning effort threaded to LaunchContext.effort → each built-in
   *  adapter's buildCommand (codex `-c model_reasoning_effort=<v>`, claude `--effort <v>`). Set by
   *  resolveRouting; per-provider gated at the start gate. Synthesized custom adapters and gemini
   *  simply ignore it — validation guarantees it never resolves for them. */
  effort?: string;
  /** Per-terminal autonomy override (absent = inherit the project's defaultAutoAccept). Threaded
   *  ONLY by the POST /api/terminals route, which pre-gates provider support; resolveAutoAccept
   *  below re-enforces regardless of caller. Loop/mission builders never set it — they inherit. */
  autoAccept?: boolean;
  /** ⟦AR-1⟧ Login-only argv override (from auth.loginCommand): the profile-login path runs
   *  THIS instead of the def's main command. Consumed nowhere else; behavior wired by BP2. */
  loginCommand?: string[];
  /** SPEC-TERMINAL-OPS §4.1 — what the terminal is for; absent = 'work'. Set by the two LOGIN routes
   *  (to 'login') and by nothing else. Deliberately NOT threaded from any request body: a wire caller
   *  that could claim 'login' would bypass the auth probe, the cap and the reaper in one move. */
  purpose?: Terminal['purpose'];
}

/**
 * SPEC-TERMINAL-OPS §3.2 — the ONE live-terminal counting rule. The createTerminal funnel (which
 * throws) and the mission-side capacity check (which defers a sortie and waits) MUST compose from
 * this single helper: if the two counting rules drifted, the funnel's throw would land in
 * startSortie's catch and route the sortie + mission to permanent ATTENTION, where the design
 * promises a bounded wait. LIVE is every state but 'killed' — 'starting' drafts count, which is what
 * makes the check + draft upsert atomic; the reconciler flips vanished sessions to 'killed', so the
 * count self-heals. `detail` is the operator-facing sentence both callers surface verbatim.
 */
export function terminalCapacity(
  terminals: Terminal[],
  opts: { globalCap: number; projectId?: string; projectCap?: number },
): { ok: boolean; detail: string } {
  const live = terminals.filter((t) => t.state !== 'killed');
  if (live.length >= opts.globalCap) {
    return {
      ok: false,
      detail: `terminal cap reached (${live.length}/${opts.globalCap} live) — kill a terminal or raise the cap in Settings → System`,
    };
  }
  if (opts.projectId !== undefined && opts.projectCap !== undefined) {
    const inProject = live.filter((t) => t.projectId === opts.projectId);
    if (inProject.length >= opts.projectCap) {
      return {
        ok: false,
        detail: `project terminal cap reached (${inProject.length}/${opts.projectCap} live in this project) — kill one of its terminals or raise the project's limit`,
      };
    }
  }
  return { ok: true, detail: '' };
}

/**
 * The ONE autonomy resolution rule: effective = override ?? project default ?? false, and ONLY for
 * a WORK terminal (purpose absent = 'work'; login AND planner panes always keep the human
 * permission gate — a planner advises missions, and with no loginCommand buildCommand IS the login
 * argv) on an adapter that declares supportsAutoAccept. An EXPLICIT request that cannot be honored
 * is an error (fail loud, mapped to a 400 by the route) — never a silent drop; an INHERITED default
 * on an unsupporting provider or non-work purpose resolves to off, which is the honored meaning of
 * "default where possible" (surfaced in the Settings toggle copy).
 */
export function resolveAutoAccept(args: {
  requested?: boolean;
  projectDefault?: boolean;
  purpose?: Terminal['purpose'];
  supported: boolean;
}): { autoAccept: boolean; error?: string } {
  const isWork = args.purpose === undefined || args.purpose === 'work';
  if (args.requested !== undefined && !isWork) {
    return { autoAccept: false, error: `a ${args.purpose} terminal never takes an autonomy override — it keeps the permission gate` };
  }
  if (args.requested === true && !args.supported) {
    return { autoAccept: false, error: 'this provider does not support autonomous (skip permissions) mode — claude-code only for now' };
  }
  return { autoAccept: isWork && args.supported && (args.requested ?? args.projectDefault ?? false) === true };
}

/**
 * SPEC-TERMINAL-OPS §2 — an env var used as a BOOLEAN switch is a string, so a plain truthiness test
 * reads `FLAG=0` and `FLAG=false` as ON. That inversion matters here: an operator who explicitly
 * DISABLED a cloud backend would otherwise pass the probe and get the exact wedge it exists to remove.
 */
function envFlagOn(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
}

/** Whether a small config file exists and mentions `needle`. Presence only (never a value read), and
 *  never-throws: an unreadable or oversized file simply reports nothing. */
function fileMentions(file: string, needle: string): boolean {
  try {
    if (!existsSync(file) || statSync(file).size > 512 * 1024) return false;
    return readFileSync(file, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

/** The gcloud application-default-credentials well-known path the Google auth libraries fall back to
 *  (CLOUDSDK_CONFIG overrides the config home). Used as a Vertex/ADC presence signal for gemini. */
function gcloudAdcFile(): string {
  const cfg = process.env.CLOUDSDK_CONFIG ?? join(homedir(), '.config', 'gcloud');
  return join(cfg, 'application_default_credentials.json');
}

/**
 * SPEC-TERMINAL-OPS §2 — does any settings file in claude-code's HIERARCHY declare a credential
 * source? `apiKeyHelper` fetches a key at run time, and an `env` block can carry ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN or the Bedrock/Vertex switches. The CLI merges the account dir (the same file
 * the adapter writes hooks into), the repo's own `.claude/`, and the enterprise managed file — so
 * reading only the account dir would refuse a repo-level or org-level setup that works today.
 * Presence only, and never a VALUE read. Synchronous and never-throws (an unreadable or malformed
 * file simply reports nothing declared).
 */
function claudeSettingsCarryAuth(configDir: string, repoPath: string): boolean {
  const files = [
    join(configDir, 'settings.json'),
    join(repoPath, '.claude', 'settings.json'),
    join(repoPath, '.claude', 'settings.local.json'),
    '/etc/claude-code/managed-settings.json',
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const cfg = JSON.parse(readFileSync(file, 'utf8')) as { apiKeyHelper?: unknown; env?: Record<string, unknown> };
      if (typeof cfg.apiKeyHelper === 'string' && cfg.apiKeyHelper.trim()) return true;
      const env = cfg.env;
      if (env && typeof env === 'object') {
        for (const [k, v] of Object.entries(env)) {
          if (k.startsWith('ANTHROPIC_')) {
            if (v !== undefined && v !== null && String(v).trim() !== '') return true;
            continue;
          }
          // The cloud switches are booleans: an explicit "0"/"false" is OFF, not a credential.
          if ((k === 'CLAUDE_CODE_USE_BEDROCK' || k === 'CLAUDE_CODE_USE_VERTEX') && envFlagOn(String(v))) return true;
        }
      }
    } catch {
      /* unreadable / malformed — declares nothing */
    }
  }
  return false;
}

/**
 * SPEC-TERMINAL-OPS §2 — the pre-spawn credential probe's VERDICT, extracted PURE + exported so the
 * three-way policy can be table-tested directly (the terminalCapacity / shouldReapTerminal precedent).
 * `assertAuthenticated` is now a thin wrapper: it maps this verdict to spawn / warn+audit / throw, so
 * the decision itself is testable in isolation. The extraction is behavior-preserving byte-for-byte —
 * same env reads, same file checks, same skip cases; only the throw/warn message construction stays in
 * the wrapper (it needs the `who`/label string, which is not part of the verdict).
 *   - 'present'      → a credential source was positively found (spawn silently);
 *   - 'unverifiable' → the probe cannot see the credential at all (login-mode custom, gone def,
 *                      CT_SKIP_AUTH_PROBE) → spawn but WARN + audit;
 *   - 'missing'      → a real basis to refuse: a declared-but-unset env key (`missingKeys` names them,
 *                      and this NEVER honours CT_SKIP_AUTH_PROBE — the def positively disproves it), or a
 *                      Tower-managed dir with nothing in it and no external signal (`missingKeys` absent).
 * PRESENCE, never validity (the per-turn wall-clock ceiling backstops an expired credential). `hasSecret` is injected so the
 * function stays pure (the env-mode custom check needs the provider secret store). Reads process.env
 * directly, exactly as the inline code did — a test sets/restores the vars.
 */
export type CredentialProbe =
  | { verdict: 'present' }
  | { verdict: 'unverifiable'; reason: string }
  | { verdict: 'missing'; missingKeys?: string[] };

export function credentialVerdict(
  provider: ProviderId,
  configDir: string,
  repoPath: string,
  def: ProviderDef | undefined,
  purpose: Terminal['purpose'],
  hasSecret: (defId: CustomProviderId, key: string) => boolean,
): CredentialProbe {
  // ⟦DEC-2⟧ keyed off purpose 'login' (not opts.loginCommand): a built-in login terminal must pass its
  // own probe or credential creation deadlocks. A shell needs no credential.
  if (purpose === 'login' || provider === 'shell') return { verdict: 'present' };

  if (def) {
    // A custom provider DECLARES its own auth shape (§1.6) — the one place the probe has a closed world.
    if (def.auth.mode === 'none') return { verdict: 'present' }; // a local model needs no credential
    if (def.auth.mode === 'env') {
      // Positive disproof: the def names its keys and the Tower owns their store. Unset means unset — and
      // NOT overridable by CT_SKIP_AUTH_PROBE (unlike the built-in no-credential case below).
      const missing = (def.secretEnvKeys ?? []).filter((k) => !hasSecret(def.id, k) && !process.env[k]);
      if (missing.length > 0) return { verdict: 'missing', missingKeys: missing };
      return { verdict: 'present' };
    }
    return { verdict: 'unverifiable', reason: 'login-mode provider declares no credential path' }; // auth.mode 'login'
  }

  let found = false;
  if (provider === 'claude-code') {
    // Every credential FORM the CLI accepts that the probe can see: the subscription login in the
    // account's own dir, an API key or auth token in the env, a cloud backend, or an apiKeyHelper /
    // ANTHROPIC_* env block anywhere in the settings HIERARCHY (account dir, repo, enterprise).
    found = existsSync(join(configDir, '.credentials.json'))
      || !!process.env.ANTHROPIC_API_KEY
      || !!process.env.ANTHROPIC_AUTH_TOKEN
      || envFlagOn(process.env.CLAUDE_CODE_USE_BEDROCK)
      || envFlagOn(process.env.CLAUDE_CODE_USE_VERTEX)
      || claudeSettingsCarryAuth(configDir, repoPath);
  } else if (provider === 'codex') {
    found = existsSync(join(configDir, 'auth.json'))
      || !!process.env.OPENAI_API_KEY
      || !!process.env.CODEX_API_KEY
      // A config.toml declaring a custom [model_providers] entry carries its own env_key (the
      // Azure/self-hosted shape), so the credential lives outside auth.json entirely.
      || fileMentions(join(configDir, 'config.toml'), 'env_key');
  } else if (provider === 'gemini-cli') {
    // GEMINI_CLI_HOME is a *home* override, so gemini's OAuth state lands under <configDir>/.gemini.
    found = existsSync(join(configDir, '.gemini', 'oauth_creds.json'))
      || !!process.env.GEMINI_API_KEY
      || !!process.env.GOOGLE_API_KEY
      // Vertex / application-default credentials: an explicit key file, or the gcloud ADC well-known
      // path the Google auth libraries fall back to.
      || !!process.env.GOOGLE_APPLICATION_CREDENTIALS
      || envFlagOn(process.env.GOOGLE_GENAI_USE_VERTEXAI)
      || existsSync(gcloudAdcFile());
  } else if (provider === 'hermes') {
    // HERMES_HOME is a config-dir override, so Hermes keeps its provider API keys in <configDir>/.env
    // (written by `hermes setup`) — the analog of claude's .credentials.json. Hermes is provider-agnostic,
    // so any one of a broad set of keys in the environment also satisfies it; a present .env is the
    // signed-in signal, and CT_SKIP_AUTH_PROBE below still overrides for an exotic setup.
    found = existsSync(join(configDir, '.env'))
      || !!process.env.OPENROUTER_API_KEY
      || !!process.env.ANTHROPIC_API_KEY
      || !!process.env.OPENAI_API_KEY
      || !!process.env.GEMINI_API_KEY;
  } else {
    // A custom id whose def was deleted (the tombstone adapter): no declared credential path to check,
    // and buildCommand throws for it moments later anyway.
    return { verdict: 'unverifiable', reason: 'provider definition is gone' };
  }
  if (found) return { verdict: 'present' };
  // Nothing found anywhere the probe knows to look — but the operator can always override.
  if (envFlagOn(process.env.CT_SKIP_AUTH_PROBE)) return { verdict: 'unverifiable', reason: 'CT_SKIP_AUTH_PROBE is set' };
  return { verdict: 'missing' };
}

/** The shared per-provider login dir — the account-less fallback createTerminal spawns under.
 *  PURE path derivation (no mkdir), so read-only signed-in probes can use it; the spawn-path
 *  configDirFor below delegates here, so probe and spawn can never derive different dirs. */
export function sharedConfigDirFor(provider: ProviderId): string {
  return join(paths.home, 'agents', provider);
}

/**
 * SPEC-RUNWAY live-swap — the config dir a terminal's CLI actually runs under: its per-terminal slot
 * when one is assigned, else TODAY'S derivation (profile.configDir, or the shared per-provider dir).
 * PURE and injectable (getProfile passed in). `fallbackProvider` lets a claude-only call site keep its
 * literal 'claude-code' shared-dir fallback; it defaults to the terminal's own provider. For a NON-slotted
 * terminal (liveSlotDir unset) this returns exactly the inlined idiom's value.
 */
export function liveConfigDirFor(
  term: Pick<Terminal, 'liveSlotDir' | 'profileId' | 'provider'>,
  getProfile: (id: string) => { configDir: string } | undefined,
  fallbackProvider: ProviderId = term.provider,
): string | undefined {
  return term.liveSlotDir ?? (term.profileId ? getProfile(term.profileId)?.configDir : sharedConfigDirFor(fallbackProvider));
}

/**
 * SPEC-SKILLS Phase 5b wave 2 — is any not-killed skip-permissions terminal bound to this account
 * config dir? The materializer's autonomy-clearance belt: while one is live, no sync on the dir may
 * (re-)materialize an uncleared assistant-authored skill. Extracted PURE + exported so the truth table
 * is testable directly (the terminalCapacity / resolveAutoAccept precedent).
 *
 * Record-liveness is the truth (the profile-delete precedent above the /api/profiles/:id route):
 * 'killed' is the only excluded state — starting/working/blocked/idle all count (a blocked bypass agent
 * still holds a live CLI that can re-scan its skills dir). The dir resolves exactly as the spawn path
 * resolved it: profile.configDir when bound to an account, else the shared per-provider dir — plain
 * `===` is sound because both sides come from those same two sources and profile roots are disjoint
 * from the shared root. A dangling profileId (should not occur — profile delete refuses while bound
 * terminals live) matches CONSERVATIVELY: over-exclusion is the safe direction.
 */
export function liveBypassOnDir(
  terminals: Terminal[],
  configDir: string,
  getProfile: (id: string) => { configDir: string } | undefined,
): boolean {
  return terminals.some((t) => {
    if (t.state === 'killed' || t.autoAccept !== true) return false;
    const dir = liveConfigDirFor(t, getProfile);
    // SPEC-RUNWAY — `rotatingFrom` is the OLD dir a mid-rotation autonomy pane is moving off; its old
    // process is still live until the respawn, so count it here too (the liveTerminalOnDir sibling
    // clause) — else a concurrent same-dir spawn could materialize an uncleared skill under it.
    return dir === undefined || dir === configDir || t.rotatingFrom === configDir;
  });
}

/** The ONE account-scoped signed-in probe behind GET /api/profiles' `signedIn`,
 *  GET /api/profiles/shared-login, and the assistant's create_loop account gate. Delegates to
 *  credentialVerdict — the SAME function the pre-spawn probe (assertAuthenticated) runs — with
 *  purpose 'work'; configDir undefined ⇒ the shared per-provider dir. `repoPath` omitted ⇒ an
 *  ACCOUNT-scoped probe: an absolute never-created sentinel keeps claude's repo-settings layer
 *  inert (never a relative path — that would resolve against the daemon's cwd and read the
 *  Tower's own .claude/ as a credential). Callers derive: signedIn = verdict === 'present';
 *  spawn-would-refuse = verdict === 'missing'. */
export function accountCredentialProbe(
  provider: ProviderId,
  configDir: string | undefined,
  def: ProviderDef | undefined,
  hasSecret: (defId: CustomProviderId, key: string) => boolean,
  repoPath?: string,
): CredentialProbe {
  return credentialVerdict(provider, configDir ?? sharedConfigDirFor(provider), repoPath ?? join(paths.home, 'no-repo'), def, 'work', hasSecret);
}

/**
 * SPEC-TERMINAL-OPS §4.3 — is this terminal's pane reap-eligible? Pure, so the destructive policy can
 * be exercised directly. EVERY condition errs toward keeping the terminal (§0 fail-safe):
 *  - a killed pane is already gone; a 'working' one, or one still emitting events, is in use;
 *  - an attention-queue terminal (blocked-*) is kept for forensics, whatever its mission did;
 *  - only 'work' (or a pre-§4.1 record, which means work) is eligible — a login pane is never
 *    auto-reaped and a planner pane is blanket-exempt this wave;
 *  - provenance is DERIVED (⟦DEC-6⟧), never stored: the caller passes the owning loop only when a
 *    loop record binds this terminal to a mission, and loops.create is the ONLY mission spawn path.
 *    An operator terminal, a login pane and a standalone-loop builder therefore have no owner and
 *    are outside the predicate entirely;
 *  - a live loop never loses its pane, and only a TRULY terminal mission (done/failed/archived/gone)
 *    qualifies — attention/paused/phase-gate are resumable and are kept;
 *  - the age anchor is the mission's own updatedAt (the loop's, for a mission that vanished). Later
 *    operator actions bump it, which only DELAYS a reap — again the safe direction.
 */
export function shouldReapTerminal(
  t: Terminal,
  loop: Loop | undefined,
  mission: Mission | undefined,
  opts: { now: number; windowMs: number },
): boolean {
  if (t.state === 'killed' || t.state === 'working') return false;
  if (t.state === 'blocked-question' || t.state === 'blocked-permission') return false;
  if (t.purpose !== undefined && t.purpose !== 'work') return false;
  if (!loop || !loop.missionId) return false; // no proven mission provenance
  if (loop.status !== 'done' && loop.status !== 'stopped' && loop.status !== 'failed') return false;
  if (mission && !mission.archivedAt && mission.status !== 'done' && mission.status !== 'failed') return false;
  const anchor = Date.parse(mission ? mission.updatedAt : loop.updatedAt);
  if (!Number.isFinite(anchor) || opts.now - anchor <= opts.windowMs) return false;
  // A pane the operator re-attached to keeps emitting events; never close one under them. An
  // UNPARSEABLE lastEventAt keeps the terminal too: NaN comparisons are all false, so treating it as
  // "no recent event" would make a garbage timestamp the one clause that argues for killing.
  if (t.lastEventAt) {
    const last = Date.parse(t.lastEventAt);
    if (!Number.isFinite(last) || opts.now - last <= opts.windowMs) return false;
  }
  return true;
}

export class TerminalManager {
  private attachments = new Map<string, Set<Attachment>>();
  /** SPEC-RUNWAY — per-terminal rotation mutex: serializes rotateTerminal so a manual rotate racing an
   *  auto (or two manual rotates to different targets) can't interleave flip/respawn and leave the
   *  record naming an account the pane didn't respawn on. */
  private rotating = new Set<string>();
  /**
   * SPEC-RESTART-RESUME FIX A/B — terminal ids with an in-flight restartTerminal call: added at the
   * TOP of restartTerminal (before any respawn) and removed either when the call's SYNCHRONOUS
   * (non-resume) path returns, or — for a `--resume` attempt — only once watchClaudeResume's
   * detached health-check (and any fall-forward) finishes, so this spans the ENTIRE async watch
   * window, not just the initial respawn. Read for two purposes:
   *   (A) the reconciler defers to it entirely (ReconcilerDeps.restartInFlight) — its 15s sweep is
   *       not phase-locked to a restart, and a sweep landing in the gap between a refused resume's
   *       death and the watcher's own fall-forward respawn would otherwise vanish the terminal and
   *       force-fail its loop, defeating the fall-forward;
   *   (B) restartTerminal itself checks it FIRST, as a mutex: a second concurrent call (double-click,
   *       a client retry — now more likely since the call returns fast) is a no-op, never a second
   *       respawn+watcher pair racing unordered sessionId patches onto the store.
   */
  private restartInFlight = new Set<string>();
  /** SPEC-RUNWAY live-swap -- per-terminal live-swap mutex. MUTUALLY EXCLUSIVE with `rotating` and
   *  `restartInFlight`: rotateTerminal/restartTerminal refuse (or no-op) while it is held, and
   *  liveSwapTerminal refuses while either of those is held, so a swap never interleaves a respawn. */
  private liveSwapping = new Set<string>();

  constructor(
    private store: Store,
    private deps: TerminalManagerDeps,
  ) {}

  /** SPEC-RESTART-RESUME FIX A — the reconciler's dep hook reads this (never anything internal to
   *  `restartInFlight` directly) so a restart/resume-watch in progress on this terminal defers the
   *  reconciler's own destructive vanish for the sweep, rather than racing the fall-forward. */
  isRestartInFlight(terminalId: string): boolean {
    return this.restartInFlight.has(terminalId);
  }

  /** Per-provider config dir isolating the agent's account (M4 adds named accounts). */
  private configDirFor(provider: ProviderId): string {
    const dir = sharedConfigDirFor(provider);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The materializer's autonomy-clearance belt (liveBypassOnDir above), bound to the live registry.
   *  Uses sharedConfigDirFor via the pure helper, not configDirFor — no side-effect mkdir in a read. */
  private hasLiveBypassOn(configDir: string): boolean {
    return liveBypassOnDir(this.store.listTerminals(), configDir, (id) => this.deps.accounts.getProfile(id));
  }

  /**
   * SPEC-RUNWAY / SPEC-RESTART — the LaunchContext build shared by rotateTerminal and (W2)
   * restartTerminal's re-seed: everything a re-spawn onto a config dir needs to re-apply hooks +
   * per-worktree trust + the Runway statusLine, EXCEPT model/effort (those live only in the
   * terminal's recorded command — see the argv-rewrite comment on restartTerminal — never
   * re-resolved here) and session (each caller threads its own mint/resume decision). Extracted so
   * the two callers can never drift on env/hook wiring.
   */
  private launchContextFor(term: Terminal, project: Project, configDir: string): LaunchContext {
    return {
      terminalId: term.id,
      projectId: project.id,
      cwd: term.cwd,
      repoPath: project.repoPath,
      hookTokenFile: this.deps.hookTokens.tokenFile(term.id),
      hookScript: this.deps.hookScript,
      towerPort: this.deps.towerPort,
      spoolDir: paths.spool,
      configDir,
      ...(term.autoAccept ? { skipPermissions: true } : {}),
      ...(term.purpose ? { purpose: term.purpose } : {}),
      ...(this.deps.usageScript && this.deps.runway?.().enabled
        ? { usageLine: { command: this.deps.usageScript, refreshInterval: 60 }, autoContinueAtUsageLimit: true }
        : {}),
    };
  }

  /**
   * Env for the terminal's GitHub identity: authorship (GIT_AUTHOR / GIT_COMMITTER,
   * all non-secret) and the credential broker wiring. The PAT is NEVER injected — only
   * the broker socket + a per-terminal broker token file; git's credential.helper
   * fetches the real credential at push time (SPEC D13).
   */
  private identityEnv(terminalId: string, identity?: GitHubIdentity): Record<string, string> {
    if (!identity) return {};
    this.deps.broker.ensure(terminalId); // writes the 0600 broker-token file
    return {
      GIT_AUTHOR_NAME: identity.gitName,
      GIT_AUTHOR_EMAIL: identity.gitEmail,
      GIT_COMMITTER_NAME: identity.gitName,
      GIT_COMMITTER_EMAIL: identity.gitEmail,
      TOWER_BROKER_SOCK: this.deps.brokerSock,
      TOWER_BROKER_TOKEN_FILE: this.deps.broker.tokenFile(terminalId),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: this.deps.credentialScript,
    };
  }

  /**
   * SPEC-TERMINAL-OPS §2 — the pre-spawn credential probe, in milliseconds and BEFORE any side effect
   * (no draft record, no worktree — the same contract as the profile check above it).
   *
   * THREE verdicts, not two. The probe reasons about an OPEN world: an agent CLI can take its
   * credential from files the Tower does not own (a repo-level or enterprise settings file, a custom
   * provider block, cloud application-default credentials). So absence of every signal it knows how to
   * look for is evidence, not proof — and a hard refusal on an account that actually works would block
   * legitimate work with no way out but a code change. Therefore:
   *   - 'present'      → spawn silently. A credential source was positively found.
   *   - 'unverifiable' → spawn, but WARN + audit `terminal.auth.unverified`. Used where the probe has
   *                      no way to see the credential at all (a login-mode custom provider, a deleted
   *                      def's tombstone, or the operator's CT_SKIP_AUTH_PROBE escape). Matches what
   *                      the custom login-mode branch has always done, so built-in and custom agree.
   *   - 'missing'      → THROW. Reserved for the case with a real basis: a declared-but-unset API key,
   *                      or a Tower-managed account dir with nothing in it and no external signal
   *                      anywhere the probe looked. That IS the wave's motivating case (a profile
   *                      created and never logged into), and it is the one worth failing fast on.
   *
   * PRESENCE, never validity: an expired or revoked credential still reads as 'present' and
   * the per-turn wall-clock ceiling stays the backstop for it; what this removes is the deterministic no-credential wedge.
   * The env fallbacks are legitimate because the tmux server is spawned as a child of the Tower, so
   * every pane inherits the Tower's process.env. Every check is synchronous (§0 atomicity).
   * ⟦DEC-2⟧ the skip is keyed off `purpose === 'login'`, NOT off opts.loginCommand: only the
   * custom-provider login route sets loginCommand, so keying off it would make a built-in login
   * terminal fail its own probe and deadlock credential creation.
   */
  private assertAuthenticated(
    terminalId: string,
    provider: ProviderId,
    configDir: string,
    repoPath: string,
    def: ProviderDef | undefined,
    label: string | undefined,
    purpose: Terminal['purpose'],
  ): void {
    const probe = credentialVerdict(provider, configDir, repoPath, def, purpose, (defId, k) => this.deps.providers.hasSecret(defId, k));
    if (probe.verdict === 'present') return; // a credential source was found (or a login/shell/none skip)
    const who = `${provider} account "${label ?? 'shared'}"`;
    if (probe.verdict === 'unverifiable') {
      // The probe cannot see the credential at all — spawn, but say so (the per-turn wall-clock ceiling is the runtime backstop).
      console.warn(`[terminals] cannot verify credentials for ${who} (${probe.reason}); spawning unverified`);
      audit('terminal.auth.unverified', { terminalId, provider, reason: probe.reason });
      return;
    }
    // 'missing' — a real basis to refuse. Naming the escape IN the refusal keeps a probe that is wrong
    // about an exotic setup from being an unrecoverable block.
    if (probe.missingKeys) {
      throw new Error(
        `not signed in: ${who} is missing its API key(s) ${probe.missingKeys.join(', ')} — set them in Settings → Connections`,
      );
    }
    throw new Error(
      `not signed in: ${who} has no credential — open its login from Settings → Connections or Quick Connect`
      + ' (or set CT_SKIP_AUTH_PROBE=1 on the Tower if this account authenticates some other way)',
    );
  }

  async createTerminal(project: Project, opts: CreateTerminalOpts): Promise<Terminal> {
    const id = shortId();
    const provider = opts.provider ?? 'shell';
    const socket = tmux.socketFor(id);
    const adapter = getAdapter(provider);
    // SNAPSHOT-AT-LAUNCH: read the def in the SAME synchronous tick as the adapter
    // (getAdapter also resolves from this store) so the two can't diverge across the awaits
    // below, and freeze it onto the terminal (Terminal.providerDef). A later edit/delete/
    // rebuild then can't change THIS terminal's turn detection mid-turn — the poller/loop
    // runner read the snapshot via registry.forTerminal. undefined for built-ins/shell (no
    // def in the store) and for a deleted custom id (getAdapter returns the tombstone, whose
    // buildCommand throws below — fail loud, never a silent shell).
    const providerDef = this.deps.providers.get(provider);
    const now = new Date().toISOString();
    const purpose = opts.purpose;
    // SPEC-RESTART — mint a deterministic session id up front for every claude-code WORK/PLANNER
    // spawn (never login: buildCommand IS the login argv there, with no room for a session flag),
    // so a later restart can `--resume` this SAME conversation instead of starting a new one. Every
    // other provider keeps its command exactly as before (undefined ⇒ buildCommand never resolves
    // a session flag).
    const sessionId = provider === 'claude-code' && purpose !== 'login' ? uuid() : undefined;

    // SPEC-TERMINAL-OPS §3 — cap on LIVE terminals (every state but 'killed'; 'starting' drafts
    // count, which is what makes check + upsert atomic per §0). Cheapest check first, so a full fleet
    // costs nothing. purpose 'login' is exempt: a full fleet must never lock the operator out of
    // re-authenticating (⟦DEC-4⟧), and login panes are bounded operator actions.
    // Everything from here to the draft upsert below is ONE synchronous block — introducing an
    // `await` inside it reopens a double-admit race against a concurrent create.
    if (purpose !== 'login') {
      const capacity = terminalCapacity(this.store.listTerminals(), {
        globalCap: this.deps.maxTerminals(),
        projectId: project.id,
        projectCap: project.maxTerminals,
      });
      if (!capacity.ok) throw new Error(capacity.detail);
    }

    // Resolve + validate the account (config-dir isolation) and GitHub identity to run
    // as, BEFORE any external effect — so a bad profileId fails fast instead of first
    // creating a draft record and a worktree that would then be orphaned by the throw.
    const identityId = opts.identityId ?? project.defaultIdentityId;
    const identity = identityId ? this.deps.accounts.getIdentity(identityId) : undefined;
    // Symmetric with the profile check: a specified-but-unresolvable identity (a typo, or
    // a project default pointing at a since-deleted identity) must NOT silently launch the
    // agent with no author/broker credentials — that's the same silent-wrong-account trap.
    // A project's defaultIdentityId is settable (POST /api/projects and POST /api/projects/:id/github),
    // and DELETE /api/identities/:id clears any project default that referenced the deleted identity in
    // the same tick — so the dangling-ref window is closed at the source. A still-dangling reference here
    // (e.g. a hand-edited config) fails the create fast rather than silently launching with no identity.
    if (identityId && !identity) throw new Error(`unknown identity ${identityId}`);
    // An explicitly supplied profileId MUST resolve to a matching-provider account.
    // Silently falling back to the shared per-provider dir would launch the agent under
    // the wrong (or unauthenticated) account while the operator believes otherwise, so
    // reject instead. No profileId -> the shared per-provider dir is the intended default.
    const profile = opts.profileId ? this.deps.accounts.getProfile(opts.profileId) : undefined;
    if (opts.profileId) {
      if (!profile) throw new Error(`unknown profile ${opts.profileId}`);
      if (profile.provider !== provider) {
        throw new Error(`account ${opts.profileId} is not a ${provider} account`);
      }
    }
    const configDir = profile ? profile.configDir : this.configDirFor(provider);

    // Autonomy (skip-permissions) — resolved HERE, server-side, never trusted from the UI. adapter
    // is the launch authority (getAdapter at the top of this tick), so support is read from it.
    const auto = resolveAutoAccept({
      requested: opts.autoAccept,
      projectDefault: project.defaultAutoAccept,
      purpose,
      supported: adapter.supportsAutoAccept === true,
    });
    if (auto.error) throw new Error(auto.error);

    // SPEC-TERMINAL-OPS §2 — refuse a spawn that has no credential to spawn WITH, here, before any
    // side effect. Without this the agent starts, wedges at the vendor's login TUI, and burns the
    // full ceiling before faulting. All checks are synchronous, keeping this block atomic.
    this.assertAuthenticated(id, provider, configDir, project.repoPath, providerDef, profile?.label, purpose);

    // Persist a minimal intent record BEFORE any external effect, so a crash
    // mid-create leaves something the reconciler can clean up. The account/identity BINDING is
    // stamped here, not after the awaits below: a profile delete landing in that window would
    // otherwise see zero bound terminals, pass its live-binding refusal (§1.2) and shred the config
    // dir out from under a spawn already in flight. Both ids are resolved synchronously above, so
    // cap check → account resolution → probe → this upsert remain one event-loop-atomic block.
    const draft: Terminal = {
      id,
      projectId: project.id,
      title: opts.title ?? opts.taskLabel ?? `${adapter.displayName} · ${project.name}`,
      provider,
      tmuxSocket: socket,
      cwd: project.repoPath,
      command: [],
      state: 'starting',
      profileId: profile?.id,
      identityId: identity?.id,
      ...(purpose ? { purpose } : {}), // §4.1 absent = 'work'; never persist a redundant default
      ...(auto.autoAccept ? { autoAccept: true } : {}),
      ...(sessionId ? { sessionId } : {}), // SPEC-RESTART — minted above; absent for non-claude/login
      providerDef, // frozen def snapshot (custom providers only; undefined otherwise)
      createdAt: now,
    };
    this.store.upsertTerminal(draft);

    // Optionally isolate the work in a fresh worktree + branch. A throw from create()
    // means nothing was created (git worktree add is checked before we record anything),
    // so it needs no cleanup — createdWorktree stays undefined. Everything AFTER the
    // worktree exists is wrapped below so a later failure never orphans the tree.
    let cwd = project.repoPath;
    let createdWorktree: CreatedWorktree | undefined;
    if (opts.worktree) {
      createdWorktree = await this.deps.worktrees.create(project, provider, opts.taskLabel);
      cwd = createdWorktree.path;
    }

    try {
      if (createdWorktree) {
        this.store.patchTerminal(id, {
          worktreePath: createdWorktree.path,
          branch: createdWorktree.branch,
          baseBranch: createdWorktree.base,
          cwd,
        });
        // §3 Take the worktree lease the moment the path is born — this is the
        // single spawn path, so every builder tree is protected from reap the instant it
        // exists. kind:'terminal' is advisory; exclusion is by id (the terminal id).
        this.deps.leases.acquire(createdWorktree.path, { kind: 'terminal', id });
      }

      // SPEC-RUNWAY live-swap -- per-terminal config-dir slot. CONSERVATIVE: only under liveSlotGate
      // (claude-code, non-login, Runway + live-swap on, a real account that is in the Runway pool); otherwise
      // `launchConfigDir` stays the vault/shared dir and nothing below differs from a plain spawn. Seeded
      // BEFORE writeHookConfig so the hook/onboarding `.claude.json` read-modify-write augments the
      // seeded identity. seedLiveSlot never throws: ANY failure falls back to the vault (no slot). The
      // pre-spawn credential probe above stays on the VAULT.
      let launchConfigDir = configDir;
      if (liveSlotGate({ provider, purpose, runway: this.deps.runway?.(), profile })) {
        const slot = seedLiveSlot(id, configDir);
        if (slot) {
          this.store.patchTerminal(id, { liveSlotDir: slot });
          launchConfigDir = slot;
        }
      }

      // Mint the per-terminal hook token + build the launch context.
      const hookToken = this.deps.hookTokens.ensure(draft);
      const ctx: LaunchContext = {
        terminalId: id,
        projectId: project.id,
        cwd,
        repoPath: project.repoPath,
        hookTokenFile: this.deps.hookTokens.tokenFile(id),
        hookScript: this.deps.hookScript,
        towerPort: this.deps.towerPort,
        spoolDir: paths.spool,
        configDir: launchConfigDir,
        model: opts.model, // threading only; interpolation is the synthesized adapter's job
        effort: opts.effort, // SPEC-EFFORT §3 threading only; gemini/custom ignore it (never resolves for them)
        ...(auto.autoAccept ? { skipPermissions: true } : {}),
        ...(purpose ? { purpose } : {}), // absent = 'work' (§4.1) — claude's onboarding seed keys on it
        ...(sessionId ? { session: { kind: 'new' as const, id: sessionId } } : {}), // SPEC-RESTART threading only
        // SPEC-RUNWAY — install the ct-usage statusLine only for a claude-code, non-login spawn while
        // Runway is enabled (read at call time). autoContinueAtUsageLimit rides it so a walled pane
        // waits for the reset instead of erroring (the exhausted-pool fallback).
        ...(provider === 'claude-code' && purpose !== 'login' && this.deps.usageScript && this.deps.runway?.().enabled
          ? { usageLine: { command: this.deps.usageScript, refreshInterval: 60 }, autoContinueAtUsageLimit: true }
          : {}),
      };

      // §4.2 Secret injection: a SEPARATE server-side merge, never through adapter.buildEnv
      // (which stays NON-SECRET per §0.1:38 — the def declares only KEY NAMES in
      // secretEnvKeys). readSecretEnv resolves those names to 0600 values off-config. Only a
      // def carries secrets, so built-ins/shell get {} and are untouched. Merged LAST so a
      // provider's own key wins over any coincidental non-secret env of the same name.
      // Belt-and-braces (upsert already rejects such a def): drop any secret whose NAME is
      // control-plane-reserved — a TOWER_* var or the account-isolation configDirEnv — so a def
      // predating that upsert guard still can't shadow the hook wiring or the config dir. A
      // non-reserved secret survives and, merged LAST below, still wins over a def.env of the
      // same name (the provider's own key wins over its non-secret env).
      const secretEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(providerDef ? readSecretEnv(providerDef) : {})) {
        if (isReservedEnvName(k, providerDef?.configDirEnv)) {
          console.warn(`[providers] dropping secret env "${k}" for ${id}: reserved by the control plane`);
          continue;
        }
        secretEnv[k] = v;
      }
      const env = {
        // Common auth floor for EVERY provider, shell included: the pair towerctl (and ct-hook)
        // need to authenticate as this terminal. Merged FIRST so it's present even for adapters
        // that don't set it (shell). The built-in/synthesized adapters re-set identical,
        // ctx-derived values below — kept deliberately (synthesize forces TOWER_* after def.env,
        // so a def can't clobber this pair; deduping here would reopen that hole).
        TOWER_PORT: String(this.deps.towerPort),
        TOWER_HOOK_TOKEN_FILE: ctx.hookTokenFile,
        ...adapter.buildEnv(ctx),
        ...this.identityEnv(id, identity),
        ...secretEnv,
      };
      // ⟦AR-1⟧/§1.6 Login-only argv override: the profile-login path (server.ts:299) passes
      // auth.loginCommand so the terminal runs the harness's OWN auth subcommand (e.g.
      // `opencode auth login`) instead of its builder command — the operator completes the
      // CLI's login in the isolated configDir and the Tower never captures the token (§4.5).
      // Set nowhere else, so a normal builder spawn always uses buildCommand.
      const command = opts.loginCommand ?? adapter.buildCommand(ctx);
      if (provider !== 'shell') {
        // A writeHookConfig failure (unwritable configDir, disk full) is logged AND AUDITED, not
        // thrown, so the terminal still launches — but WITHOUT hooks, so its state changes fall back
        // to slower/less-reliable screen-scraped inference until the config is fixed. We do NOT throw
        // because writeHookConfig also runs on the account-login path, where a throw would lock the
        // user out of re-authenticating. The audit record (mirroring the skill.materialize.failed
        // sibling below) is what makes this degradation visible post-hoc — a hook-less terminal that
        // missed completions would otherwise leave no diagnostic trail anywhere in the product.
        await adapter.writeHookConfig(ctx).catch((err) => {
          console.error(`[hooks] writeHookConfig failed for ${id}; launching WITHOUT hooks:`, err);
          // `err instanceof Error` guards the contract this catch exists to keep: a `throw null` or a
          // non-Error rejection would make `(err as Error).message` itself throw, defeating the "never
          // throws — the login path depends on it" promise above.
          audit('terminal.hooks.failed', { terminalId: id, provider, error: err instanceof Error ? err.message : String(err) });
        });
      }

      // SPEC-SKILLS Phase 1 — materialize the central skill library into the provider's native skills
      // location. A SIBLING of writeHookConfig, not a rider: its error posture is its own (a failed
      // materialization DEGRADES the agent — it spawns WITHOUT central skills — and must never block the
      // spawn or mask a hook failure). It runs after the hook write so ctx.configDir exists on the common
      // path, but does not depend on that write succeeding (it mkdirs skills/ itself). It must complete
      // before tmux.newSession because claude scans skills at session start. A THROW here would route to
      // cleanupFailedCreate and kill the spawn, so it is caught: whole-sync failures degrade skill-less
      // and are AUDITED (a silently skill-less reviewer sortie is an attestation-adjacent degradation the
      // operator must be able to see post-hoc); the internal per-skill failures degrade softer still. The
      // provider/purpose gate lives in materializeSkills (shouldMaterialize), so this is one flat call.
      await materializeSkills(provider, ctx, this.deps.skills, {
        hasLiveBypass: (dir) => this.hasLiveBypassOn(dir),
      }).catch((err) => {
        console.error(`[skills] materialization failed for ${id}; launching WITHOUT central skills:`, err);
        audit('skill.materialize.failed', { terminalId: id, provider, error: String((err as Error).message) });
      });

      // profileId/identityId are NOT re-written here — the draft record above already carries the
      // binding (SPEC-TERMINAL-OPS §1.2), and one writer keeps the two from ever drifting.
      this.store.patchTerminal(id, { command, hookToken });

      await tmux.newSession({
        socket,
        cwd,
        cols: 80,
        rows: 24,
        env,
        command,
        logFile: this.store.logPathFor(id),
      });
      await tmux.resize(socket, 80, 24).catch(() => {});

      this.store.patchTerminal(id, { state: provider === 'shell' ? 'idle' : 'working' });
      audit('terminal.create', { terminalId: id, projectId: project.id, provider, autoAccept: auto.autoAccept });
      return this.store.getTerminal(id)!;
    } catch (err) {
      // Any failure after the worktree exists (tmux.newSession spawn failure,
      // a disk-full store write, mkdir) must not leave an orphan worktree/branch/lease or
      // a zombie 'starting' record — a mission retry would otherwise stack orphans.
      await this.cleanupFailedCreate(id, project, createdWorktree);
      throw err;
    }
  }

  /**
   * Best-effort teardown of a create that threw after the worktree was born. Each step is
   * independently guarded so a cleanup failure NEVER masks the original create error: we
   * log and press on. Uses git.js directly (force-remove) rather than WorktreeManager.remove
   * so a partially-written tree can't refuse-on-dirty and leak.
   */
  private async cleanupFailedCreate(
    terminalId: string,
    project: Project,
    wt: CreatedWorktree | undefined,
  ): Promise<void> {
    if (wt) {
      try {
        this.deps.leases.release(wt.path, terminalId);
      } catch (e) {
        console.error(`[create-cleanup] lease release failed for ${terminalId}:`, e);
      }
      try {
        const res = await git.worktreeRemove(project.repoPath, wt.path, true);
        if (!res.ok && !res.stderr.includes('is not a working tree')) {
          console.error(`[create-cleanup] worktree remove failed for ${terminalId}: ${res.stderr.trim()}`);
        }
      } catch (e) {
        console.error(`[create-cleanup] worktree remove threw for ${terminalId}:`, e);
      }
      try {
        // Only delete the branch if it holds no unmerged work (a post-spawn failure could
        // have let the agent commit); an unsafe branch is kept so the commits stay recoverable.
        if (await git.isBranchSafeToDelete(project.repoPath, wt.base, wt.branch)) {
          await git.git(project.repoPath, ['branch', '-D', wt.branch]);
        }
      } catch (e) {
        console.error(`[create-cleanup] branch delete failed for ${terminalId}:`, e);
      }
    }
    // Mark the draft dead (mirrors killTerminal) so the reconciler and board stop showing a
    // 'starting' terminal that never launched. Release the per-terminal token files too.
    try {
      const term = this.store.getTerminal(terminalId);
      this.store.patchTerminal(terminalId, { state: 'killed', closedAt: new Date().toISOString() });
      this.deps.hookTokens.forget(terminalId, term?.hookToken);
      this.deps.broker.forget(terminalId);
      // Also sweep the conventional slot path: a seed that landed on disk but whose record patch threw
      // would otherwise leak it. removeLiveSlot is a no-op for a path that does not exist.
      if (term?.liveSlotDir) this.store.patchTerminal(terminalId, { liveSlotDir: undefined });
      removeLiveSlot(term?.liveSlotDir ?? join(paths.slots, terminalId));
    } catch (e) {
      console.error(`[create-cleanup] draft record teardown failed for ${terminalId}:`, e);
    }
    audit('terminal.create.failed', { terminalId, projectId: project.id });
  }

  /** Attach a viewer. Returns a detach function.
   *  onReflow (optional): invoked AFTER each tmux window resize this attach issues actually completes
   *  (the initial re-pin and every viewer resize). The poller re-arms its resize quiet-window from THIS
   *  callback, not only from the pre-attach note: the resize is fire-and-forget and, on a slow socket,
   *  lands seconds after the note — so a pre-reflow snapshot could otherwise be blessed as a clean
   *  baseline and let the reflow read as work. Re-arming at reflow-completion time closes that gap. */
  async attach(
    terminalId: string,
    viewer: Viewer,
    size: { cols: number; rows: number },
    onReflow?: () => void,
  ): Promise<{ detach: () => void; write: (d: string) => void; resize: (c: number, r: number) => void }> {
    const term = this.store.getTerminal(terminalId);
    if (!term) throw new Error('unknown terminal');
    // Presume NOT-running on a hasSession THROW (a stalled socket) — the opposite of the probe sites,
    // and correct here: attach can't proceed against a wedged server anyway (spawning `tmux attach` into
    // one would hang the operator's client), so the clean domain error + retry beats the raw timeout
    // string. The throw is non-destructive (no state write), so false is safe here.
    if (!(await tmux.hasSession(term.tmuxSocket).catch(() => false))) {
      throw new Error('terminal session is not running');
    }

    const { file, args } = tmux.attachArgv(term.tmuxSocket);
    const p = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: term.cwd,
      env: process.env as Record<string, string>,
    });

    // Re-pin the tmux window to the attaching client's geometry (the browser fits its xterm to the
    // pane and sends that size, clamped to ≥80x24). window-size is manual, so this explicit resize is
    // the sole authority. Re-arm the poller's quiet-window when the reflow actually lands (see onReflow).
    void tmux.resize(term.tmuxSocket, size.cols, size.rows).finally(() => onReflow?.());

    const attachment: Attachment = { pty: p, viewer };
    let set = this.attachments.get(terminalId);
    if (!set) {
      set = new Set();
      this.attachments.set(terminalId, set);
    }
    set.add(attachment);

    p.onData((d) => viewer.write(d));
    p.onExit(({ exitCode }) => {
      set!.delete(attachment);
      viewer.close(exitCode);
    });

    const detach = () => {
      try {
        // Detach this client from tmux without killing the session.
        p.kill();
      } catch {
        /* already gone */
      }
      set!.delete(attachment);
    };

    return {
      detach,
      write: (d: string) => p.write(d),
      resize: (cols: number, rows: number) => {
        try {
          p.resize(cols, rows);
        } catch {
          /* client vanished */
        }
        void tmux.resize(term.tmuxSocket, cols, rows).finally(() => onReflow?.());
      },
    };
  }

  /**
   * SPEC-RESTART §2 — respawn the pane's CLI IN PLACE. The inverse posture of killTerminal: the
   * terminal id, tmux server/socket, session, hook token, broker registration, worktree lease and
   * every binding field on the record all SURVIVE — only the pane process is new (tmux relaunches
   * the recorded command with the session's env; pin F7). Built for the wedged-CLI case (e.g. a
   * stale in-memory auth token after an on-disk credential refresh): the fresh process re-reads its
   * config dir, token files and worktree, all of which are untouched here.
   *
   * NOTHING is released or forgotten — no hookTokens.forget, no broker.forget, no lease release,
   * and none of the kill fan-out (mission/poller/loop unbind): a loop bound to this terminal must
   * keep running, not fail. The only mutations are the viewer detach (so xterm clients re-attach to
   * the fresh pane — the killTerminal sweep, minus the record teardown), the respawn itself, and
   * the create-time state re-latch ('working' for an agent, 'idle' for a shell; hooks/poller then
   * take over exactly as after a create). A respawn that did not happen throws INSTEAD of stamping
   * state — reporting a restart that never occurred would be a silent pass.
   *
   * SPEC-RESTART-RESUME — for a claude-code WORK/PLANNER terminal carrying a minted sessionId
   * (createTerminal mints one for exactly this population), the respawn additionally tries to
   * RESUME the same conversation rather than just replaying the recorded argv verbatim: the base
   * command is rewritten with `--resume <id>` when a transcript for that id still exists on disk
   * (findClaudeTranscript, keyed by session id — not by re-deriving claude's own cwd-key, which
   * would silently stop matching if a future CLI version changes that format), else with a freshly
   * minted `--session-id <id>` (a resume onto a NEVER-CREATED transcript is a hard CLI error, not a
   * fallback).
   *
   * The `--resume` case reports OPTIMISTICALLY: `resumed:true` is returned as soon as the respawn is
   * ISSUED, without waiting to find out whether claude actually accepted it. This is deliberate, not
   * a shortcut — measured against a real claude 2.1.278 on this machine, a refused resume's exit
   * under remain-on-exit lands at ~1.5-2.8s, so a SYNCHRONOUS check wide enough to catch it would tax
   * every SUCCESSFUL restart (the common case, and the one the operator is actively waiting on) by
   * several seconds. Instead a DETACHED health-check (watchClaudeResume) keeps polling after this
   * method has already returned (~500ms polls, ~6s cap — comfortably above the measured 2.8s and
   * comfortably under the reconciler's own ~15s sweep, so this wins that race). If the pane is found
   * dead inside that window it falls forward: mints ANOTHER brand-new id (never a retry of the one
   * that just failed — that would either collide or repeat the same refusal), respawns with
   * `--session-id <new>`, audits `terminal.restart.resume-failed`, and — via
   * `deps.onResumeFallForward` — corrects the bound loop's memory mode (the replacement session
   * carries no context: full, never delta) and refreshes the UI. If the pane stays alive through the
   * cap, nothing further happens and the optimistic `resumed:true` simply stands — there is
   * deliberately no "confirmed" event on the happy path. The returned `settled` promise (present
   * ONLY on this path) resolves once that background check — and any fall-forward — completes;
   * production ignores it, it exists purely so a test can await the outcome instead of racing it.
   * The mint branch and every non-resume path (non-claude, a login pane, or a claude record with no
   * sessionId at all — e.g. one created before this wave) issue their respawn and return with NO
   * background work at all: a freshly minted id can never hit "No conversation found" (it was just
   * minted — no transcript could possibly be missing), so there is nothing for a health-check to
   * catch there, and paying for one anyway would be pure waste on the far more common non-resume path.
   *
   * SPEC-RESTART-RESUME FIX A/B/C — `restartInFlight` is added BEFORE anything else here and spans
   * the ENTIRE operation, including the detached resume health-check window: the reconciler defers
   * to it (a sweep must never vanish a pane this method — or its background watcher — is mid-way
   * through reviving) and a SECOND concurrent call on the same id (double-click, a client retry — now
   * more likely since this returns fast) is a NO-OP rather than a second respawn+watcher racing
   * unordered sessionId patches onto the store: it returns `{ terminal: <current record>, resumed:
   * false, alreadyRestarting: true }` with no `settled`, no respawn, no watcher, no fan-out — the
   * FIRST caller alone owns all of that. The same no-op applies when a rotation is already in flight
   * on this terminal (rotateTerminal's own `restartInFlight` guard is the mirror of this).
   */
  async restartTerminal(
    terminalId: string,
  ): Promise<{ terminal: Terminal; resumed: boolean; settled?: Promise<void>; alreadyRestarting?: boolean }> {
    const term = this.store.getTerminal(terminalId);
    if (!term) throw new Error('unknown terminal');
    if (this.restartInFlight.has(terminalId) || this.rotating.has(terminalId) || this.liveSwapping.has(terminalId)) {
      return { terminal: term, resumed: false, alreadyRestarting: true };
    }
    if (term.state === 'killed') {
      throw new Error('terminal is killed — its tmux server is gone; spawn a new terminal instead of restarting');
    }
    this.restartInFlight.add(terminalId);
    // Set true the instant a resume attempt hands ownership of the flag off to watchClaudeResume —
    // its own `finally` releases it once the detached health-check (and any fall-forward) completes.
    // Every other path releases it itself, synchronously, in THIS method's `finally` below.
    let watcherOwnsFlag = false;
    try {
    // Detach live pty viewers BEFORE the respawn (killTerminal's sweep): each pty kill fires its
    // onExit, which closes the viewer WebSocket, and the browser re-attaches to the fresh pane.
    const set = this.attachments.get(terminalId);
    if (set) for (const a of set) a.pty.kill();
    this.attachments.delete(terminalId);

    const claudeNonLogin = term.provider === 'claude-code' && term.purpose !== 'login';
    let resumed = false;
    let sessionId = term.sessionId;
    let settled: Promise<void> | undefined;

    if (claudeNonLogin) {
      // Same derivation rotateTerminal uses for the account's config dir.
      const configDir = liveConfigDirFor(term, (id) => this.deps.accounts.getProfile(id), 'claude-code');
      const project = configDir ? this.store.getProject(term.projectId) : undefined;
      if (project) {
        // SPEC-RESTART W2 — re-seed hooks + per-worktree trust + the Runway statusLine on every
        // claude restart, exactly as rotate does on the target dir before its respawn: the fresh
        // process re-reads its whole config dir, so a Runway toggle, a trust seed for a
        // since-added worktree, or hooks.json drift must all be re-applied here too. Degrade, never
        // throw — the SAME posture createTerminal uses — so a re-seed hiccup never blocks a restart.
        const ctx = this.launchContextFor(term, project, configDir!);
        const adapter = getAdapter('claude-code');
        await adapter.writeHookConfig(ctx).catch((err) => {
          console.error(`[hooks] writeHookConfig failed for ${terminalId} on restart; continuing:`, err);
          audit('terminal.hooks.failed', { terminalId, provider: term.provider, error: err instanceof Error ? err.message : String(err) });
        });
        await materializeSkills('claude-code', ctx, this.deps.skills, { hasLiveBypass: (dir) => this.hasLiveBypassOn(dir) }).catch((err) => {
          console.error(`[skills] materialization failed for ${terminalId} on restart; continuing:`, err);
          audit('skill.materialize.failed', { terminalId, provider: term.provider, error: String((err as Error).message) });
        });
      }

      if (term.sessionId) {
        const transcriptPath = configDir ? findClaudeTranscript(configDir, term.sessionId) : undefined;
        let argv: string[];
        if (transcriptPath) {
          argv = claudeSessionArgv(term.command, { kind: 'resume', id: term.sessionId });
          resumed = true;
        } else {
          sessionId = uuid();
          this.store.patchTerminal(terminalId, { sessionId });
          argv = claudeSessionArgv(term.command, { kind: 'new', id: sessionId });
          resumed = false;
        }
        if (!(await tmux.respawnPane(term.tmuxSocket, { argv, cwd: term.cwd }))) {
          throw new Error('could not respawn the pane — its tmux session is gone or unresponsive (the reconciler owns a vanished session)');
        }
        if (transcriptPath) {
          // FIRE-AND-FORGET — see the docstring for the full rationale. Deliberately NOT awaited:
          // neither this method nor the HTTP response it feeds may be held on this. Errors are
          // swallowed to a console log (the background task's own audit trail is what makes a real
          // failure visible); `settled` is the test-only escape hatch to observe the outcome.
          // watcherOwnsFlag=true BEFORE the call: watchClaudeResume now owns releasing
          // restartInFlight (in its own finally), so this method's finally must not double-release.
          watcherOwnsFlag = true;
          settled = this.watchClaudeResume(terminalId, term).catch((err) => {
            console.error(`[restart] resume health-check failed for ${terminalId}:`, err);
          });
        }
      } else if (!(await tmux.respawnPane(term.tmuxSocket))) {
        throw new Error('could not respawn the pane — its tmux session is gone or unresponsive (the reconciler owns a vanished session)');
      }
    } else if (!(await tmux.respawnPane(term.tmuxSocket))) {
      throw new Error('could not respawn the pane — its tmux session is gone or unresponsive (the reconciler owns a vanished session)');
    }

    // Mirror the create-time stamp (createTerminal, after newSession): a fresh CLI is born working
    // and demotes via its own hooks; a shell is immediately idle.
    this.store.patchTerminal(terminalId, { state: term.provider === 'shell' ? 'idle' : 'working' });
    audit('terminal.restart', { terminalId, provider: term.provider, resumed, sessionId });
    return { terminal: this.store.getTerminal(terminalId)!, resumed, ...(settled ? { settled } : {}) };
    } finally {
      // Released HERE for every synchronous (non-resume) path, including a throw anywhere above —
      // the resume path alone hands this off to watchClaudeResume's own finally instead.
      if (!watcherOwnsFlag) this.restartInFlight.delete(terminalId);
    }
  }

  /**
   * SPEC-RESTART-RESUME — the DETACHED half of a `--resume` attempt (full rationale on
   * restartTerminal's docstring). Polls at intervalMs up to capMs, breaking the INSTANT death is
   * observed rather than waiting out the rest of the cap — a healthy resume is never held past
   * whichever poll first lands after the pane would have died. `term` is the PRE-respawn snapshot
   * (`.sessionId` is the id that was just attempted); the live record is re-read before any
   * mutation, since another operator action (a second restart, a rotate, a kill) may have raced this
   * in the background and must win over a stale fall-forward.
   *
   * Timing is `deps.resumeProbe` when set, else the real, measured production constants
   * (RESUME_PROBE_CAP_MS / RESUME_PROBE_INTERVAL_MS) — see their doc comment for the measured
   * evidence. The override exists so a test can exercise "dies within the cap" / "survives the cap"
   * BEHAVIOR without a multi-second real wait; production never sets it.
   */
  private async watchClaudeResume(terminalId: string, term: Terminal): Promise<void> {
    try {
      const capMs = this.deps.resumeProbe?.capMs ?? RESUME_PROBE_CAP_MS;
      const intervalMs = this.deps.resumeProbe?.intervalMs ?? RESUME_PROBE_INTERVAL_MS;
      let diedEarly = false;
      for (let waited = 0; waited < capMs && !diedEarly; waited += intervalMs) {
        await new Promise((r) => setTimeout(r, intervalMs));
        if ((await tmux.paneInfo(term.tmuxSocket))?.dead) diedEarly = true;
      }
      if (!diedEarly) return; // the resume held for the whole window — resumed:true stands
      const current = this.store.getTerminal(terminalId);
      if (!current || current.state === 'killed' || current.sessionId !== term.sessionId) return;
      // Collision rule: ALWAYS mint a BRAND-NEW id — never re-send the one that just failed, which
      // would either hard-error "already in use" (a partial transcript) or repeat the same refusal.
      const freshId = uuid();
      this.store.patchTerminal(terminalId, { sessionId: freshId });
      const freshArgv = claudeSessionArgv(term.command, { kind: 'new', id: freshId });
      if (!(await tmux.respawnPane(term.tmuxSocket, { argv: freshArgv, cwd: term.cwd }))) {
        // Nothing more a background task can do — the pane is gone or unresponsive; the reconciler
        // owns a vanished session from here. Audited so the failure is never silent even in this case.
        audit('terminal.restart.resume-failed', { terminalId, provider: term.provider, fallbackRespawnFailed: true });
        return;
      }
      this.store.patchTerminal(terminalId, { state: 'working' });
      audit('terminal.restart.resume-failed', { terminalId, provider: term.provider, sessionId: freshId });
      // Correct the memory mode (the fresh session carries no context — full, never delta) and refresh
      // the UI, exactly as the restart route's own post-respawn fan-out does.
      this.deps.onResumeFallForward?.(terminalId);
    } finally {
      // SPEC-RESTART-RESUME FIX A/B — releases the mutex/reconciler-defer marker that restartTerminal
      // handed off when it kicked this watcher off: this is what makes the marker span the ENTIRE
      // async watch window (not just the initial respawn), whichever of the returns above was taken.
      this.restartInFlight.delete(terminalId);
    }
  }

  /**
   * SPEC-RUNWAY — rotate a live claude-code pane onto a DIFFERENT subscription (profile) IN PLACE:
   * re-point CLAUDE_CONFIG_DIR (tmux set-environment) + respawn, reusing the terminal id, socket, hook
   * token, broker registration, worktree lease and loop binding — everything restartTerminal preserves.
   * No re-login. The in-pane conversation is lost like any restart, but a loop re-composes its next
   * iteration, so at the iteration boundary this is zero lost work.
   *
   * Refusals throw with NOTHING mutated. The re-seed (hooks + per-worktree trust + skills) runs on the
   * TARGET dir while the record still points at the old one (so the old dir stays safe). Then the record
   * flips to the target in one tick, carrying `rotatingFrom` (the old dir) so the refresher idle gate +
   * profile-delete keep protecting the old dir under its still-live process until the respawn. A respawn
   * that fails rolls the record + env back and throws — never leaves the record on Y while X's process runs.
   */
  async rotateTerminal(terminalId: string, toProfileId: string, opts?: { isReserved?: (id: string) => boolean }): Promise<Terminal> {
    // Per-terminal mutex — a second rotate (manual racing the loop's auto, or two manual rotates to
    // different targets) must not interleave flip/respawn. Added before the refusals so a refusal-throw
    // releases it via the finally.
    if (this.rotating.has(terminalId)) throw new Error('a rotation is already in progress for this terminal');
    // SPEC-RESTART-RESUME FIX C — mutually exclusive with an in-flight restart/resume-watch too: a
    // rotate racing a resume-watch's own fall-forward respawn could double-respawn the same pane with
    // unordered sessionId/profileId patches. Mirrors the rotating guard above; restartTerminal's own
    // symmetric guard (a no-op there, not a throw — see its docstring) is the other half of this pair.
    if (this.restartInFlight.has(terminalId)) throw new Error('a restart is in progress for this terminal — try again once it settles');
    if (this.liveSwapping.has(terminalId)) throw new Error('a live credential swap is in progress for this terminal — try again once it settles');
    this.rotating.add(terminalId);
    try {
    const term = this.store.getTerminal(terminalId);
    if (!term) throw new Error('unknown terminal');
    if (term.state === 'killed') throw new Error('terminal is killed — spawn a new one instead of rotating');
    if (term.provider !== 'claude-code') throw new Error('only claude-code terminals rotate subscriptions');
    if (term.purpose === 'login') throw new Error('a login pane cannot be rotated');
    if (term.state.startsWith('blocked-')) throw new Error('the pane is waiting on a dialog that would die with the process — resolve it first');
    const to = this.deps.accounts.getProfile(toProfileId);
    if (!to || to.provider !== 'claude-code') throw new Error('unknown or non-claude-code target profile');
    if (opts?.isReserved?.(toProfileId)) throw new Error('the target profile is reserved (assistant Brain) and cannot be a rotation target');
    if (term.profileId === toProfileId) throw new Error('already running on that profile');
    const project = this.store.getProject(term.projectId);
    if (!project) throw new Error('the terminal’s project record is gone — cannot re-seed for a rotation');
    // Pre-flight the TARGET credential the same way a spawn does — never rotate onto a signed-out account.
    const probe = accountCredentialProbe('claude-code', to.configDir, this.deps.providers.get('claude-code'), (defId, k) => this.deps.providers.hasSecret(defId, k), project.repoPath);
    if (probe.verdict !== 'present') throw new Error(`target account "${to.label}" is not signed in (${probe.verdict}) — log it in first`);

    const oldDir = liveConfigDirFor(term, (id) => this.deps.accounts.getProfile(id), 'claude-code');
    const ctx = this.launchContextFor(term, project, to.configDir);
    const adapter = getAdapter('claude-code');
    // Re-seed the TARGET dir BEFORE flipping the record (record still says the old account, so the old
    // dir is untouched): hooks + per-worktree trust + skills, else the fresh CLI wedges on folder-trust.
    await adapter.writeHookConfig(ctx);
    await materializeSkills('claude-code', ctx, this.deps.skills, { hasLiveBypass: (dir) => this.hasLiveBypassOn(dir) }).catch((err) => {
      console.error(`[skills] rotate materialization failed for ${terminalId}; continuing:`, err);
    });
    // Detach live viewers (they re-attach to the fresh pane), then flip record + env + respawn.
    const set = this.attachments.get(terminalId);
    if (set) for (const a of set) a.pty.kill();
    this.attachments.delete(terminalId);
    // SPEC-RESTART-RESUME — a rotation moves the pane onto a DIFFERENT account's config dir, so its
    // old transcript (under the old account) is meaningless there: mint a brand-new session id and
    // start a fresh `--session-id` conversation, never a `--resume` — the old id is never valid
    // under a different CLAUDE_CONFIG_DIR anyway.
    const newSessionId = uuid();
    const argv = claudeSessionArgv(term.command, { kind: 'new', id: newSessionId });
    // One tick: the record points at the target, carrying the old dir so the liveness belts keep
    // protecting the old account until the respawn kills its process.
    this.store.patchTerminal(terminalId, { profileId: toProfileId, sessionId: newSessionId, ...(oldDir ? { rotatingFrom: oldDir } : {}) });
    try {
      await tmux.setSessionEnv(term.tmuxSocket, 'CLAUDE_CONFIG_DIR', to.configDir);
      if (!(await tmux.respawnPane(term.tmuxSocket, { argv, cwd: term.cwd }))) throw new Error('respawn failed');
    } catch (err) {
      // Roll back: the OLD process is still the live one, so restore the record + env — nothing lies.
      this.store.patchTerminal(terminalId, { profileId: term.profileId, sessionId: term.sessionId, rotatingFrom: undefined });
      if (oldDir) await tmux.setSessionEnv(term.tmuxSocket, 'CLAUDE_CONFIG_DIR', oldDir).catch(() => {});
      throw new Error(`rotation respawn failed; left running on the original account (${(err as Error).message})`);
    }
    // The respawn landed on the target — clear the transient marker + re-latch working (a fresh CLI is
    // born working and demotes via its own hooks, exactly like restartTerminal/create).
    // A respawn-rotation moves the pane OFF its slot (CLAUDE_CONFIG_DIR is now the target vault): drop the
    // slot record + dir so liveConfigDirFor stops resolving to a dir nothing runs under. Only when slotted.
    this.store.patchTerminal(terminalId, { state: 'working', rotatingFrom: undefined, ...(term.liveSlotDir ? { liveSlotDir: undefined } : {}) });
    if (term.liveSlotDir) removeLiveSlot(term.liveSlotDir);
    audit('terminal.rotate', { terminalId, fromProfileId: term.profileId, toProfileId, sessionId: newSessionId });
    return this.store.getTerminal(terminalId)!;
    } finally {
      this.rotating.delete(terminalId);
    }
  }

  /**
   * SPEC-RUNWAY live-swap -- move a RUNNING slotted claude-code pane onto another subscription WITHOUT a
   * respawn: atomically rewrite the credential + identity inside the terminal's own slot dir (performLiveSwap,
   * under claude's OAuth locks) so the live process picks the new account up on its next request. The
   * conversation and process are untouched, so there is deliberately NO restart/gone fan-out here; the
   * caller (server.ts) does the lightweight account fan-out. Holds `liveSwapping`, mutually exclusive
   * with rotate/restart. Every refusal returns (never throws) with nothing mutated.
   */
  async liveSwapTerminal(terminalId: string, toProfileId: string, opts?: { isReserved?: (id: string) => boolean }): Promise<TerminalLiveSwapResult> {
    if (this.liveSwapping.has(terminalId) || this.rotating.has(terminalId) || this.restartInFlight.has(terminalId)) {
      return { ok: false, reason: 'in-progress' };
    }
    this.liveSwapping.add(terminalId);
    try {
      const term = this.store.getTerminal(terminalId);
      if (!term || term.state === 'killed') return { ok: false, reason: 'gone' };
      const slot = term.liveSlotDir;
      if (term.provider !== 'claude-code' || !slot) return { ok: false, reason: 'not-slotted' };
      if (!this.deps.liveSwap) return { ok: false, reason: 'not-configured' };
      const to = this.deps.accounts.getProfile(toProfileId);
      if (!to || to.provider !== 'claude-code') return { ok: false, reason: 'unknown-target' };
      if (opts?.isReserved?.(toProfileId)) return { ok: false, reason: 'reserved-target' };
      if (term.profileId === toProfileId) return { ok: false, reason: 'same-account' };
      // Fail fast, before any lock: the target vault must be signed in (the primitive re-checks health).
      const project = this.store.getProject(term.projectId);
      const probe = accountCredentialProbe('claude-code', to.configDir, this.deps.providers.get('claude-code'), (defId, k) => this.deps.providers.hasSecret(defId, k), project?.repoPath);
      if (probe.verdict !== 'present') return { ok: false, reason: 'unsigned-target' };

      const result = await this.deps.liveSwap(
        { liveConfigDir: slot, targetConfigDir: to.configDir },
        { audit: (event, data) => audit(event, { terminalId, ...data }) },
      );
      if (!result.ok) return result;
      // The process lives on; only the attribution changes. The slot's own .claude.json/credential now name
      // the target, so usage/identity resolve (via liveConfigDirFor) to it from here on.
      const fromProfileId = term.profileId;
      this.store.patchTerminal(terminalId, { profileId: toProfileId });
      audit('terminal.live-swap', { terminalId, fromProfileId, toProfileId });
      return result;
    } finally {
      this.liveSwapping.delete(terminalId);
    }
  }

  async killTerminal(terminalId: string): Promise<void> {
    const term = this.store.getTerminal(terminalId);
    if (!term) return;
    const set = this.attachments.get(terminalId);
    if (set) for (const a of set) a.pty.kill();
    this.attachments.delete(terminalId);
    await tmux.killServer(term.tmuxSocket);
    this.store.patchTerminal(terminalId, { state: 'killed', closedAt: new Date().toISOString() });
    this.deps.hookTokens.forget(terminalId, term.hookToken);
    this.deps.broker.forget(terminalId);
    // §3 kill fan-out: drop every lease this terminal held (its worktree, plus any land
    // lease still open if a merge was interrupted). Idempotent — safe if already released.
    this.deps.leases.releaseAllFor(terminalId);
    // SPEC-RUNWAY live-swap -- drop the per-terminal config-dir slot (guarded to the slots root).
    if (term.liveSlotDir) {
      removeLiveSlot(term.liveSlotDir);
      this.store.patchTerminal(terminalId, { liveSlotDir: undefined });
    }
    audit('terminal.kill', { terminalId });
  }
}
