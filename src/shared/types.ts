// Shared domain + wire types used by both the Tower server and the web client.

export type TerminalState =
  | 'starting'
  | 'working'
  | 'blocked-question'
  | 'blocked-permission'
  | 'idle'
  | 'killed';

export type BuiltinProviderId = 'claude-code' | 'gemini-cli' | 'codex' | 'shell' | 'hermes';
export type CustomProviderId = `custom:${string}`;
/**
 * ⟦DP-1⟧ Open the provider union. The five built-ins stay LITERAL so every `switch`,
 * ternary badge map, and `=== 'shell'` sentinel keeps narrowing/compiling; custom providers
 * are a `custom:<slug>` namespace registered as data (SPEC-PROVIDERS §1.1/§1.2). Using a
 * template literal rather than a bare `string` preserves the built-in literals' meaning.
 */
export type ProviderId = BuiltinProviderId | CustomProviderId;

// ---- Custom provider definitions (SPEC-PROVIDERS §1.1) — FROZEN ----
// A registered provider is a ProviderDef record (zod + writeJsonAtomic at 0600), from which
// the server SYNTHESIZES an AgentAdapter at load and on every mutation. No code, no restart.

/**
 * The completion-signal mode the def author chooses. The reliability tier is DERIVED from
 * this (A=webhook, B=screen-regex, C=dwell-only), never stored separately — one source of truth.
 */
export type TurnDetectionMode = 'webhook' | 'screen-regex' | 'dwell-only';

export interface ProviderTurnDetection {
  mode: TurnDetectionMode;
  /**
   * webhook (tier A): a template materialized into a DEDICATED Tower-owned file under the
   * configDir — NEVER the CLI's primary config; arbitrary in-place merge is unsupported
   * The CLI's own notify/hook program is pointed at that file, which invokes ct-hook.
   */
  hookConfig?: {
    relPath: string; // a dedicated tower file, e.g. 'tower-hooks.toml' (not config.toml)
    template: string; // {{HOOK_SCRIPT}} {{SIGNAL:turn-done}} placeholders
    bindings: { providerEvent: string; signal: HookSignal }[];
  };
  /** screen-regex (tier B): parseState-as-DATA. Poller demotes on turnDone (gemini-class). */
  patterns?: { needsPermission?: string; needsInput?: string; turnDone?: string };
  /**
   * dwell-only (tier C): no signal; poller output-quiescence is the completion proxy. To cut
   * false-idle on network-bound childless waits (reasoning / cold-hosted APIs), set a busyPattern.
   */
  busyPattern?: string; // pane text meaning "still working" — blocks demotion while present
  socketBusy?: boolean; // an ESTABLISHED outbound socket on the pane's process tree counts as work
  /**
   * Optional poller hints for a polled tier (screen-regex / dwell-only) whose idle TUI animates
   * (a spinner, cycling placeholder hints) so its own chrome isn't misread as ongoing work and
   * the terminal pinned 'working'. Both are absent for a static-idle CLI.
   */
  screenChangeImpliesWork?: boolean; // false ⇒ only live children or a parse/hook signal count as work, not a bare screen change
  chromeStripPatterns?: string[]; // regex sources; a pane line matching any is stripped before the poller hashes (invalid patterns dropped)
}

export interface ProviderModelConfig {
  modelFlag?: string; // a FIXED flag token appended before the model, e.g. '--model'
  modelEnv?: string; // OR an env var name, e.g. 'OLLAMA_MODEL'
  defaultModel?: string; // final resolveRouting fallback
  modelsPath?: string; // discovery path; default '/v1/models' (§3)
  models?: { id: string; verifiedAt?: string }[]; // discovered+manual roster, last-verified
}

// ---- SPEC-MODELS: unified model roster (custom defs + built-in subscription catalogs) ----

/** One selectable model for a provider. `id` is the slug (allowlist-checked); `label` is display-only. */
export interface ModelCatalogEntry {
  id: string;
  verifiedAt?: string;
  label?: string;
  /** SPEC-EFFORT §3.5 — the model's captured `supported_reasoning_levels` (codex), display-info that
   *  feeds EffortSelect's options + the resolve-time warning set; never a Tower-applied default. */
  efforts?: string[];
  /** SPEC-EFFORT §3.5 — the model's captured `default_reasoning_level`, shown as a hint ONLY (the CLI's
   *  own default), never pre-selected or applied (§0 no-imposed-defaults). */
  defaultEffort?: string;
}

/** SPEC-MODELS §1 — the ONE roster read surface (`GET /api/models/:provider`), zero-egress: composed from a
 *  custom def's discovered models OR a built-in provider's stored/curated catalog. Every model picker reads
 *  this; the ChatGPT token is NEVER in it — ids only. `discoverable:false` ⇒ hide the refresh affordance. */
export interface ProviderModelsView {
  provider: ProviderId;
  models: ModelCatalogEntry[];
  source: 'discovered' | 'curated' | 'none';
  lastVerifiedAt?: string;
  discoverable: boolean;
  note?: string;
}

// ---- SPEC-EFFORT: reasoning-effort tokens (mirror the model-id discipline; pure + importable) ----

/** claude-code's PINNED effort enum (from `claude --help`): clap hard-rejects anything else at launch,
 *  so an out-of-set value must be a start-gate ERROR (a loud pre-check beats a dead spawn), never a drop. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** codex's syntactic HARD gate: a lowercase effort token (same injection-safety class as the model-id
 *  allowlist — excludes '=', whitespace, quotes and a leading dash, so a composed `key=value` argv token
 *  cannot splice). The PER-MODEL supported set is a warning-tier check that lives in validateRoute, NOT
 *  here — codex itself is lenient (`-c model_reasoning_effort=banana` deserializes and runs). */
export const CODEX_EFFORT_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** SPEC-EFFORT §0 — per-provider HARD gate for a reasoning-effort token. claude-code → membership in the
 *  pinned enum; codex → the syntactic regex only (the model's captured effort set feeds ONLY the
 *  resolve-time WARNING in validateRoute, never this boolean); gemini/shell/custom → no effort surface. */
export function isValidEffort(provider: ProviderId, value: string): boolean {
  if (provider === 'claude-code') return (CLAUDE_EFFORTS as readonly string[]).includes(value);
  if (provider === 'codex') return CODEX_EFFORT_RE.test(value);
  return false;
}

/**
 * ⟦AR-1⟧ How a def's credentials enter. Coordinates fields already on the def; adds NO new
 * secret channel. `env` rides the §4 write-only store → the single spawn-env merge; `login`
 * rides the EXISTING profile-login terminal in the isolated configDir. `env` + `login` may
 * coexist — `auth.mode` picks the primary form + validation, not a hard XOR (§1.6).
 */
export type ProviderAuth =
  | { mode: 'none' } // local model, no creds (Ollama / vLLM / llama.cpp)
  | { mode: 'env' } // API key via secretEnvKeys → §4 store → spawn env
  | { mode: 'login'; loginCommand?: string[] }; // subscription/OAuth via the CLI's OWN login

/** v1 MINIMAL field set (advanced poller/trust knobs are named v2 seams, §6). */
export interface ProviderDef {
  id: CustomProviderId; // 'custom:<slug>', slug ^[a-z0-9][a-z0-9-]{0,38}$
  displayName: string;
  command: string[]; // argv template: {{model}} {{cwd}} {{repoPath}} {{baseUrl}}
  configDirEnv?: string; // env var that isolates the account dir (like CLAUDE_CONFIG_DIR)
  /**
   * NON-SECRET; interpolates {{baseUrl}} {{cwd}} {{towerPort}} {{configDir}} (⟦AR-2⟧).
   * Secret-LOOKING values are REJECTED at upsert and steered to secretEnvKeys.
   */
  env?: Record<string, string>;
  secretEnvKeys?: string[]; // env var NAMES injected from the secret store (§4); values off-config
  baseUrl?: string;
  model: ProviderModelConfig;
  turn: ProviderTurnDetection; // carries the A/B/C tier
  approveKeys: { approve: string[]; deny: string[] };
  auth: ProviderAuth; // ⟦AR-1⟧ 'none' | 'env' | 'login'; env + login may coexist (§1.6)
  createdAt: string;
  updatedAt: string;
}

export type ScaffoldMode = 'zero-footprint' | 'local-only' | 'committed';

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  scaffoldMode: ScaffoldMode;
  /** Default GitHub identity for terminals in this project. */
  defaultIdentityId?: string;
  /**
   * Per-project isolation INTENT. 'per-agent-uid' is only honored when the host has been
   * provisioned (scripts/setup-isolation.sh); until then the effective mode is 'single-uid'
   * regardless. Absent = 'single-uid'. See ProjectSecurity for the resolved, honest status.
   */
  isolation?: 'per-agent-uid' | 'single-uid';
  /** Set when the operator hides the project from the Flightline. Data (terminals, loops,
   *  missions, memory, history) is untouched — this is presentation only; unset = visible. */
  archivedAt?: string;
  /** SPEC-TERMINAL-OPS §3.1 — per-project ceiling on LIVE terminals, under the global one. Absent =
   *  only the global cap applies. Clamped [1,128] at the setter route. */
  maxTerminals?: number;
  /** Per-project GitHub repository URL (https://github.com/owner/repo[.git]). Display/wiring metadata
   *  ONLY — the credential broker's host allowlist remains the authorization boundary; this field never
   *  widens what a push may reach. Absent = none set. */
  repoUrl?: string;
  /** "Autonomous (skip permissions)" default. When true, WORK terminals in this project launch with
   *  the provider's OWN skip-permissions mode (claude `--dangerously-skip-permissions`) unless the
   *  create request forces it off. Never login or planner terminals, and only providers whose adapter
   *  declares supportsAutoAccept (claude-code today) — resolved and enforced server-side in
   *  createTerminal. Absent = off; there is deliberately no global default. */
  defaultAutoAccept?: boolean;
  createdAt: string;
}

/** A named provider account (a distinct login), isolated by its own config dir. */
export interface AgentProfile {
  id: string;
  provider: ProviderId;
  label: string;
  /** Tower-managed config dir isolating this account's credentials. */
  configDir: string;
  createdAt: string;
  /** WIRE-ONLY (GET /api/profiles): whether this account currently holds a credential, derived
   *  per request from the spawn probe's own verdict. Never persisted — accounts.ts ProfileSchema
   *  deliberately omits it, and the route maps with a spread so store records never carry it. */
  signedIn?: boolean;
}

/** A GitHub identity used for commits + pushes. The credential is broker-only. */
export interface GitHubIdentity {
  id: string;
  label: string;
  gitName: string;
  gitEmail: string;
  /** Whether a push credential (PAT) is stored for the broker to serve. */
  hasCredential: boolean;
  createdAt: string;
}

/** Whether real per-agent OS isolation is active, or we're in the M1–M3 residual-risk mode. */
export interface SecurityStatus {
  isolationMode: 'per-agent-uid' | 'single-uid';
  egressControl: boolean;
  brokerActive: boolean;
  residualRisk: string | null;
}

/** One refuse/warn item from the repo-bootstrap preflight (SPEC-INITPUSH). `paths` capped at 20. */
export interface RepoBootstrapIssue {
  code: string;
  detail: string;
  paths?: string[];
}

/** The structured plan GET /api/projects/:id/bootstrap/preflight returns. Wire-only — never persisted. */
export interface RepoBootstrapPlan {
  projectId: string;
  branch: 'main';
  repoUrl?: string;
  identity?: { id: string; label: string; hasCredential: boolean };
  detectedStacks: string[]; // 'node' | 'python' | 'rust' | 'go' (empty = generic)
  gitignoreExists: boolean;
  gitignoreAppend: string[]; // pattern lines that would be appended (all of them when no file exists)
  filesToCommit: { path: string; size: number }[]; // capped at 200 entries for the wire
  fileTotal: number;
  truncated: boolean; // fileTotal exceeded the enumeration cap
  remote: { state: 'empty' | 'has-refs' | 'unreachable' | 'unchecked'; detail?: string };
  blocking: RepoBootstrapIssue[];
  warnings: RepoBootstrapIssue[];
}

/** Outcome of POST /api/projects/:id/bootstrap. Push failure is NON-FATAL: initialized/committed stay true. */
export interface RepoBootstrapResult {
  initialized: boolean;
  committed: boolean;
  pushed: boolean;
  branch: string;
  commit?: string;
  fileCount?: number;
  detail: string; // honest one-line outcome incl. how to finish after a push failure
  pushError?: string;
}

/** Non-secret launch config for a terminal. Secrets never live here. */
export interface Terminal {
  id: string;
  projectId: string;
  title: string;
  provider: ProviderId;
  /** tmux socket name: ct-<id>. The session inside it is always "main". */
  tmuxSocket: string;
  cwd: string;
  /** Command run inside tmux (argv). For a plain shell this is the login shell. */
  command: string[];
  state: TerminalState;
  /** SPEC-RESTART — deterministically MINTED at create time (never captured off a hook) for a
   *  claude-code work/planner terminal: a fresh crypto.randomUUID() threaded as `--session-id` on
   *  first spawn. A later restart resumes THIS SAME id with `--resume` when its transcript still
   *  exists on disk, or replaces it with a newly minted one when it does not (a fresh conversation,
   *  never a re-sent stale id). Absent for every other provider, and for a login pane. */
  sessionId?: string;
  /** Per-terminal capability token used by the hook pipeline (control-plane only). */
  hookToken?: string;
  /** RESOLVED at create (request override ?? project defaultAutoAccept; work terminals only): this
   *  terminal was launched in the provider's own skip-permissions mode. Drives the badge + audit. */
  autoAccept?: boolean;
  /** If this terminal works in an isolated git worktree, its path + branch. */
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  /** The provider account + GitHub identity this terminal runs as. Stamped on the record BEFORE any
   *  external effect of the spawn, so an account delete racing a spawn always sees the binding. */
  profileId?: string;
  identityId?: string;
  /** SPEC-RUNWAY — during a subscription rotation, the OLD config dir this pane is moving OFF, set for
   *  the brief window between the record flipping to the new account and the pane respawning. The
   *  liveness belts (cred-refresher idle gate, profile-delete) treat it as still-live so nothing writes
   *  or shreds the old dir under the still-running old process. Cleared once the respawn lands; a value
   *  that survives a mid-rotation Tower death is boot-stale and the Store constructor strips it at load. */
  rotatingFrom?: string;
  /** SPEC-RUNWAY live-swap — the per-terminal slot config dir this pane runs under, when one is assigned.
   *  When set, liveConfigDirFor() resolves to it instead of the profile/shared dir. Set by createTerminal
   *  when the slot gate passes; cleared on swap/rotate/kill/vanish. */
  liveSlotDir?: string;
  /**
   * SPEC-TERMINAL-OPS §4.1 — what this terminal is FOR. Absent means 'work' (every record written
   * before this wave is a work terminal, so no migration is needed). 'login' terminals exist to create
   * a credential, so they skip the pre-spawn auth probe (§2.3), are exempt from the terminal cap
   * (§3.2 ⟦DEC-4⟧ — a full fleet must never lock the operator out of re-authenticating), and are never
   * auto-reaped (§4.3). 'planner' is defined here so the on-disk schema is ready for it; nothing in
   * this wave produces one.
   */
  purpose?: 'work' | 'planner' | 'login';
  /**
   * SNAPSHOT-AT-LAUNCH of a custom provider's ProviderDef (custom: ids only). A running
   * terminal resolves its adapter from THIS frozen copy, not the live store, so an edit / delete
   * / registry rebuild can never change a live terminal's turn detection mid-turn (the hot-reload
   * race). Absent for built-ins (they have static coded adapters).
   */
  providerDef?: ProviderDef;
  /**
   * SPEC-LOOPWEDGE — this terminal's CURRENT idle was reached by INFERENCE (a screen-evidence
   * harvest of a lost hook — F1 — or the poller's affirmative-idle backstop — F2), NOT a real
   * completion hook. Written on the working→idle transition by mission.ingest and cleared on the
   * next working transition. The loop runner's completion GUARD reads it: an inferred idle may
   * never be the sole basis of an autopilot 'done'. Also drives the amber "~inferred" honesty chip.
   */
  idleInferred?: boolean;
  createdAt: string;
  closedAt?: string;
  lastEventAt?: string;
}

export interface DiffSummary {
  base: string;
  branch: string;
  dirty: boolean;
  uncommitted: { status: string; path: string }[];
  files: { path: string; added: number; removed: number; status: string }[];
  commits: { sha: string; subject: string }[];
}

/** Canonical lifecycle signal a hook reports, normalized across providers. */
export type HookSignal = 'needs-input' | 'needs-permission' | 'turn-done' | 'session-start';

/**
 * SPEC-CLEARANCE §A — what a hook actually sends over the wire: the canonical signals plus
 * 'agent-question', claude's agent_needs_input matcher (its explicit ask-the-user path). It is kept
 * distinct from the noisy idle_prompt (which claude fires after ~60s at ANY bare prompt, phantom
 * question holds included) so MissionControl.ingestSignal can screen-veto the latter while the
 * former stays a strong signal. Normalized to 'needs-input' before it reaches ingest — it is never
 * a TowerEvent type or a terminal state. Custom ProviderDef BINDING metadata stays canonical-only,
 * though a custom def's free-form hook template can still emit it on the wire — accepted as
 * fail-safe; see HookBinding (adapters/types.ts).
 */
export type WireHookSignal = HookSignal | 'agent-question';

/** One entry in the attention queue — an agent waiting on the human. */
export interface AttentionItem {
  terminalId: string;
  projectId: string;
  title: string;
  provider: ProviderId;
  kind: 'question' | 'permission';
  /** SPEC-CLEARANCE §B — the agent's actual question, extracted from the pane snapshot by the
   *  adapter's describeAttention (question cards only). Absent when the frame isn't recognized;
   *  the card body then falls back to an honest "waiting on your input", never a chrome row. */
  message?: string;
  /** The requested tool/command for a permission request, if parseable. */
  requested?: string;
  /** Last N terminal lines for context (from capture-pane). */
  preview: string[];
  since: string;
}

export interface TowerEvent {
  terminalId: string;
  /** Per-terminal monotonic sequence assigned at emit time. */
  seq: number;
  type:
    | 'needs-input'
    | 'needs-permission'
    | 'turn-done'
    | 'session-start'
    | 'state'
    | 'reconcile';
  payload?: Record<string, unknown>;
  ts: string;
}

// ---- WebSocket terminal protocol (client <-> server) ----

/** Server -> client frames. */
export type ServerFrame =
  | { t: 'attached'; terminalId: string; cols: number; rows: number }
  | { t: 'data'; d: string }
  | { t: 'exit'; code: number | null }
  | { t: 'error'; message: string };

/** Client -> server frames. */
export type ClientFrame =
  | { t: 'attach'; terminalId: string; token: string; cols: number; rows: number }
  | { t: 'data'; d: string }
  | { t: 'resize'; cols: number; rows: number };

// ---- HTTP API DTOs ----

export interface SessionInfo {
  /** Per-session control-plane token, sent in the X-Tower-Token header. */
  token: string;
  version: string;
}

export interface CreateTerminalRequest {
  projectId: string;
  title?: string;
  provider?: ProviderId;
  /** Isolate the work in a fresh git worktree + branch. */
  worktree?: boolean;
  taskLabel?: string;
  /** SPEC-TERMINAL-OPS §5 — the account + identity to run as (the route already threaded these; they
   *  are listed here so the request shape is the whole contract, not an inline intersection). */
  profileId?: string;
  identityId?: string;
  /** SPEC-TERMINAL-OPS §5 — model + reasoning effort, resolved and gated exactly like the loop path.
   *  A shell terminal takes neither: sending one is a 400, never a silent drop.
   *  There is deliberately NO `purpose` here — a wire caller that could claim 'login' would bypass
   *  the auth probe, the terminal cap and the reaper in one request. */
  model?: string;
  effort?: string;
  /** Per-terminal autonomy override: true = launch with the provider's own skip-permissions mode,
   *  false = keep the permission gate even when the project defaults autonomous, ABSENT = inherit
   *  the project default. Tri-state rides key-absence (the /github partial-field idiom). Work
   *  terminals only — purpose is not wire-settable — and enforced server-side in createTerminal. */
  autoAccept?: boolean;
}

export interface HealthReport {
  ok: boolean;
  version: string;
  terminals: number;
  projects: number;
  uptimeSec: number;
}

/** Server-Sent-Events pushed to the dashboard for live Mission Control updates. */
export type StreamEvent =
  | { t: 'terminal-state'; terminalId: string; state: TerminalState }
  | { t: 'attention'; items: AttentionItem[] }
  | { t: 'terminals-changed' }
  /** A loop's lifecycle advanced (new iteration, gate opened, paused, landed, …). */
  | { t: 'loop-state'; loop: Loop }
  /** A mission changed (status/phase/sortie) — drives the missions view + dock cards. */
  | { t: 'mission-state'; mission: Mission }
  /** Tower-mediated mail was delivered — drives the collaboration "wire" pulse. */
  | { t: 'mail-sent'; from: string; to: string; toTitle?: string }
  /** A ProviderDef store mutation — open composers refresh their roster without a restart (⟦DP-3⟧). */
  | { t: 'providers' }
  /** SPEC-BACKLOG ⟦DP-B7⟧ — the task corpus changed; dashboards refetch tasks (the providers
   *  refetch pattern, not the stories reloadSignal pattern). */
  | { t: 'backlog' }
  /** A Story corpus mutation — open Stories views refresh live (SPEC-STORYLOOP §1.1). */
  | { t: 'stories' }
  /** SPEC-SKILLS — a skill-library mutation (upsert/delete/import); the open Skills panel refetches
   *  its list (the providers refetch precedent). */
  | { t: 'skills' }
  /** SPEC-RUNWAY — a Runway config mutation (pool/threshold/enable); the open Runway tab refetches
   *  GET /api/runway/config (the skills refetch precedent). */
  | { t: 'runway' }
  /** SPEC-MEMORY — a memory entry mutation for `projectId`; an open MemoryPanel for that project refetches
   *  (the runway/backlog refetch pattern). */
  | { t: 'memory'; projectId: string }
  /** SPEC-PLANNER §9 — a planner-consult mutation; dashboards refetch GET /api/consults (the backlog
   *  refetch pattern, not the stories reloadSignal). */
  | { t: 'consults' };

// ---- Loop engineering (iterate-until-done) ----

/** When the human is asked to gate an iteration before the loop continues or lands. */
export type GatePolicy = 'every' | 'on-pass' | 'never';

export type LoopStatus =
  | 'running'   // an iteration is in flight (agent working, or check running)
  | 'gated'     // paused at a human gate — awaits approve / reject / land
  | 'paused'    // paused by the operator between iterations
  | 'done'      // stop condition satisfied (check passed / landed)
  | 'stopped'   // stopped by the operator or a budget cap
  | 'failed';   // the loop could not proceed (e.g. run terminal died)

export type IterationVerdict = 'pending' | 'pass' | 'fail';

// ---- Contract assertions + validator (SPEC-FACTORY §1) ----

/** A checkable acceptance criterion the judge grades an iteration against. */
export interface ContractAssertion {
  id: string;
  text: string;
}

export type ValidatorVerdict = 'pass' | 'fail' | 'inconclusive';

/** One read-only judge run over one iteration's work product. */
export interface ValidatorRun {
  verdict: ValidatorVerdict;
  /** Per-assertion grading; matches loop.assertions at run time. */
  results: { assertionId: string; pass: boolean; reason: string }[];
  /** Why the run is inconclusive (judge error kind / parse failure), when it is. */
  inconclusiveReason?: string;
  model?: string;
  /** SPEC-EFFORT §5 — the reasoning effort this run actually executed at (report truth); undefined = the CLI default. */
  effort?: string;
  ms: number;
  ranAt: string;
}

/** One pass of a loop: the agent works, then an optional check runs, then a gate. */
export interface LoopIteration {
  n: number;
  verdict: IterationVerdict;
  startedAt: string;
  endedAt?: string;
  /** Diff of this iteration vs the previous (from the per-iteration auto-commit). */
  added?: number;
  removed?: number;
  files?: number;
  /** Tail of the check command's output, if a check ran. */
  checkTail?: string;
  /** A human note at the gate (rejection reason) — fed into the next iteration's prompt. */
  note?: string;
  /** The judge's grading of this iteration against loop.assertions, when they exist. */
  validator?: ValidatorRun;
  /**
   * SPEC-SUBMIT §4.3 — this turn produced NO observed work and NO commit: the runner never saw the
   * terminal go 'working' and the iteration committed nothing. Read it as "if this iteration also
   * recorded a pass, treat that pass with suspicion" — the shape a swallowed prompt leaves behind.
   * Annotation ONLY: it never enters a verdict, never changes the gate policy, and never affects the
   * no-change resolution. A genuine agent no-op stays a no-op; the record just stops calling it clean.
   */
  suspectNoWork?: boolean;
  /**
   * SPEC-MEMORY — the project-memory entries (id + the rev the agent saw) whose briefing line was
   * typed into the pane with THIS iteration's prompt. Record-keeping about what the builder has been
   * shown, so a dispute/supersede can be traced to the rev an agent relied on. Annotation ONLY, the
   * suspectNoWork posture: it NEVER enters a verdict, a gate decision, or the next prompt's feedback.
   */
  memoryDelivered?: { id: string; rev: number }[];
  /**
   * SPEC-MEMORY — the agent's own free-text progress note for this iteration (`towerctl note`), so an
   * operator sees what the builder believes it is doing: the LATEST iteration's note renders as one
   * clamped line on the Flightline loop strip, the Gate card, and the Board card, and every iteration's
   * note renders in full in the loop detail's iteration tape. Latest write wins; clamped to 1 KB. NEVER
   * fed back into a prompt, into feedback, or into any decision — an agent must not be able to steer its
   * own next turn (or another agent's) through a status note.
   */
  progress?: string;
}

/** An iterate-until-done cycle: one builder terminal driven across N iterations. */
export interface Loop {
  id: string;
  projectId: string;
  name: string;
  /** The task prompt injected each iteration (with prior check/gate feedback appended). */
  task: string;
  provider: ProviderId;
  /** Resolved model slug threaded to buildCommand's {{model}}; the resolveRouting
   *  mission/loop fallback reads it. Undefined for built-ins with no model config. */
  model?: string;
  /** SPEC-EFFORT §1 — resolved reasoning effort bound to the run's argv; undefined = no flag (CLI default). */
  effort?: string;
  /** SPEC-ROUTING §3 — the pipeline role this loop plays, so a standalone loop participates in
   *  role routing (its resolved provider/model come from the project/workflow/global role tier
   *  when no explicit provider override is given). */
  role?: PipelineRole;
  profileId?: string;
  identityId?: string;
  /** The builder terminal this loop drives (created on start; runs in a worktree). */
  terminalId?: string;
  branch?: string;
  baseBranch?: string;
  worktreePath?: string;
  /** Shell command run in the worktree after each iteration; exit 0 = pass. Empty = agent self-reports. */
  checkCommand?: string;
  gatePolicy: GatePolicy;
  maxIterations: number;
  status: LoopStatus;
  /** 1-based number of the current / most recent iteration. */
  iteration: number;
  iterations: LoopIteration[];
  stopReason?: string;
  /** Acceptance criteria the judge grades each iteration against (SPEC-FACTORY §1). */
  assertions?: ContractAssertion[];
  /** Backrefs when this loop is a mission sortie's execution — load-bearing for
   *  crash-recovery de-dup (SPEC-FACTORY §2 reconcile), not just UI. */
  missionId?: string;
  sortieId?: string;
  /** Structured land record (set by land()); the board/missions derive from these,
   *  never from stopReason prose. */
  landedAt?: string;
  landDetail?: string;
  /** Structured no-change resolution: set true when a loop stops because the agent reported done
   *  but the branch has ZERO commits to land. A benign, finished-in-fact outcome — a mission sortie
   *  derives its benign-vs-attention verdict from THIS flag, never from stopReason prose (the same
   *  structured-over-prose convention as landedAt). (The standalone Board lanes the loop as finished
   *  off status:'stopped' alone and does not consume this flag.) */
  noChangesToLand?: boolean;
  /** SPEC-BACKLOG §3 — set when the operator (or Clear finished) archives a FINISHED loop
   *  (landedAt set, or stopped/failed; a done-unlanded loop is a live Gate card, not
   *  finished). Archived records stay served — the Board filters, Outcomes keeps history. */
  archivedAt?: string;
  /** SPEC-SKILLS per-project delivery — the bounded pointer block naming this project's per-project
   *  (non-global) resolved skills, computed at create from the project's skill selection and FROZEN
   *  like `task`; injectPrompt re-sends it with the task every iteration (so it survives a long
   *  session's context compaction). Absent = no per-project selection. Never wire-settable. */
  skillBrief?: string;
  /** True iff the baked brief names ≥1 skill still needing autonomy clearance — possible only for an
   *  interactive builder (a skip-permissions create excludes them). The inject-time belt suppresses
   *  the brief if such a loop ever meets a skip-permissions pane: unreachable today (a terminal's
   *  autoAccept and the loop→terminal binding are both create-time-immutable), load-bearing the day
   *  either stops being so. */
  skillBriefUncleared?: boolean;
  /** Ids of the assistant-origin skills the baked brief DELIVERS. The brief's entries are by-id LIVE
   *  pointers, so a mid-loop edit/promote/rollback can drop a skill's clearance (the hash-keyed
   *  reset) after the create-time exclusion passed — at every inject into a skip-permissions pane
   *  these ids are re-checked against the live store, and a drifted or missing id suppresses the
   *  whole brief (fail closed). Absent = the brief delivers no assistant skills. */
  skillBriefAssistantIds?: string[];
  /** SPEC-MEMORY — the project-memory briefing cursor: `seq` is the max entry seq the LAST briefing
   *  EVALUATED (the composer's toSeq — never wall-clock, never the store's current seq at write time,
   *  so an entry written during the awaited send is caught by the next delta rather than skipped).
   *  Absent = no briefing has reached this builder yet → the next inject sends the full active set.
   *  PERSISTED (not derived from in-memory pane freshness) so a Tower restart keeps the delta chain
   *  and an in-place pane respawn — which loses the agent's context — clears it for a fresh full (a
   *  respawn that lands DURING an awaited send holds that clear: the resolving send does not re-stamp it). */
  memoryCursor?: { seq: number; briefedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface CreateLoopRequest {
  projectId: string;
  name: string;
  task: string;
  provider?: ProviderId;
  /** Optional model override; threads through resolveRouting → LaunchContext. */
  model?: string;
  /** SPEC-EFFORT §1 — optional reasoning-effort override; threads through resolveRouting → LaunchContext. */
  effort?: string;
  /** SPEC-ROUTING §3 — optional pipeline role; when set (and no explicit provider), routing
   *  resolves the loop's provider/model from the project/workflow/global role tier. */
  role?: PipelineRole;
  profileId?: string;
  identityId?: string;
  checkCommand?: string;
  gatePolicy?: GatePolicy;
  maxIterations?: number;
  /** Acceptance criteria, one per entry (trimmed; max 12 × 500 chars). */
  assertions?: string[];
  missionId?: string;
  sortieId?: string;
  /** SPEC-BACKLOG ⟦DP-B4⟧ — the backlog task this loop instantiates. Stamped ROUTE-side after a
   *  successful create (link refuses overwrite); never read by the loop runner itself. */
  backlogTaskId?: string;
}

// ---- Backlog — stored pre-execution kanban lanes (SPEC-BACKLOG §1) — FROZEN ----

/** ⟦DP-B1⟧ ONLY pre-execution states are stored (+ archived). Execution state is always derived
 *  from the linked mission/loop — there is deliberately no stored running/blocked/done. */
export type TaskStatus = 'triage' | 'todo' | 'ready' | 'archived';

export interface Task {
  id: string;
  projectId: string;
  /** Non-empty (post-trim min 1 — the store rejects blanks). */
  title: string;
  body?: string;
  /** P0 highest; absent = unranked (sorts after P3 within a lane). */
  priority?: 0 | 1 | 2 | 3;
  status: TaskStatus;
  /** Provenance link once instantiated (⟦DP-B4⟧). Display follows ⟦DP-B8⟧: hidden while the
   *  execution is active, resurfaced on draft/failed/stopped, auto-archived on success. */
  missionId?: string;
  loopId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CreateTaskRequest {
  projectId: string;
  title: string;
  body?: string;
  priority?: 0 | 1 | 2 | 3;
  /** Default 'triage'. 'archived' is never a creation state. */
  status?: Exclude<TaskStatus, 'archived'>;
}

// ---- Routing by cognitive shape (SPEC-PROVIDERS §2) — FROZEN ----

/**
 * The pipeline role a sortie plays; role defaults + per-sortie override resolve (provider, model).
 * Deliberately NOT 1:1 with the north-star phases: Integration is the Tower itself (a
 * deterministic controller — missions/worktrees/land — not a routed LLM role), and `docs` is an
 * additional routed role from the brief's own list.
 */
// The role set lives in one place now (SPEC-ROUTING §1). Re-exported here so the ~13 existing
// `import { PipelineRole } from '../shared/types'` sites keep working unchanged.
export type { PipelineRole } from './roles.js';
import type { PipelineRole } from './roles.js';

export interface RoleAssignment {
  provider: ProviderId;
  model?: string;
  /** SPEC-EFFORT §1 — optional reasoning effort for this role (all three routing layers). */
  effort?: string;
  /** SPEC-TESTING §1 — a logged-in AgentProfile of THIS provider that this role routes to. Resolved
   *  via the account chain with a provider-MATCH gate (never rank-gated); unset ⇒ shared login dir. */
  profileId?: string;
}

/** Settings → Routing role defaults (config: zod + writeJsonAtomic). Any role may be unset. */
export type RoleRouting = Partial<Record<PipelineRole, RoleAssignment>>;

/** A named, reusable role→(provider,model) bundle a project can select (SPEC-ROUTING §2). */
export interface WorkflowProfile {
  id: string;
  name: string;
  description?: string;
  routes: RoleRouting;
  createdAt: string;
  updatedAt: string;
}

/** A project's routing overlay: an optional selected workflow plus ad-hoc per-role overrides.
 *  Overrides are per-role ATOMIC — an entry replaces the whole assignment for that role, never
 *  a field-level merge onto the workflow's (SPEC-ROUTING §2/§3). */
export interface ProjectRouting {
  workflowId?: string;
  routes?: RoleRouting;
}

/** The layered view resolveRouting consumes (a resolution VIEW, never persisted): project
 *  overrides over the selected workflow over the global defaults (SPEC-ROUTING §3). */
export interface LayeredRoleRouting {
  project?: RoleRouting;
  workflow?: RoleRouting;
  global: RoleRouting;
}

// ---- Missions + Autopilot (SPEC-FACTORY §2) ----

export type SortieStatus = 'pending' | 'active' | 'gated' | 'done' | 'landed' | 'attention';

/** One flight of one agent: a plan slot whose execution is exactly one Loop. */
export interface MissionSortie {
  id: string;
  name: string;
  task: string;
  assertions?: string[];
  checkCommand?: string;
  /** ⟦§2.2⟧ Per-sortie routing overrides (all optional; resolveRouting layers them over the
   *  role default → mission default → global). Each falls through its OWN chain. */
  role?: PipelineRole;
  provider?: ProviderId;
  model?: string;
  /** SPEC-EFFORT §1 — per-sortie reasoning-effort override (falls through its OWN chain). */
  effort?: string;
  /** SPEC-TESTING §1 — the logged-in account (AgentProfile of the resolved provider) this sortie's role
   *  routes to. Resolved via the account chain; unset ⇒ the shared per-provider login dir. */
  profileId?: string;
  loopId?: string;
  status: SortieStatus;
  landDetail?: string;
  /** Set when this sortie resolved to 'landed' because its builder produced ZERO commits (a benign
   *  no-change stop), NOT a real merge. Lets the operator still retry it in place (retry() otherwise
   *  accepts only 'attention') to re-run a builder that may have wrongly claimed nothing to do. */
  noChangeLanded?: boolean;
  /** Last failure/attention context, for the mission card. */
  note?: string;
  /**
   * SPEC-STORYLOOP §3.3 — the SINGLE verify-fixer marker. A fixer sortie carries this
   * from draft until the Tower assigns it its partitioned failures at fixer-phase-start, then
   * CLEARS it — the idempotency key, so an already-assigned phase is never re-shuffled.
   */
  verifyFixer?: boolean;
  /**
   * SPEC-STORYLOOP §3.3 — the runner TestRun id this fixer's failures were derived from.
   * Runtime-assigned (never in a create request); a new run id ≠ this makes a retry re-derive.
   */
  assignedFrom?: string;
  /**
   * SPEC-TESTING §3 — documentor-phase markers (mirror verifyFixer/assignedFrom). `docsSortie` marks a
   * sortie whose task is finalized from the verify run at phase start (then cleared, the idempotency key);
   * `docsFromRun` pins the TestRun id it derived from (runtime-only). A docs phase NEVER gates.
   */
  docsSortie?: boolean;
  docsFromRun?: string;
  /**
   * SPEC-LOOP W6 — code-review markers (mirror docsSortie/docsFromRun). `reviewSortie` marks the
   * routed reviewer sortie whose task is finalized from the mission's base commit at phase start
   * (then cleared, the idempotency key); `reviewFromRange` pins the commit range it reviewed
   * (runtime-only; the retry pin, and what keeps the never-silent review gate load-bearing).
   * `reviewFixer` marks a review-fix sortie (mirror verifyFixer) whose task is finalized from the
   * reviewer's findings; `assignedFromReview` pins the ReviewRecord id it was partitioned from
   * (runtime-only; a replaced/pruned record makes the retry loud, never a silent repartition).
   */
  reviewSortie?: boolean;
  reviewFromRange?: string;
  reviewFixer?: boolean;
  assignedFromReview?: string;
  /**
   * SPEC-LOOP — when this reviewer JUDGE sortie was last RETRIED (mirrors researchRetryAt). A retry
   * re-arms the marker but deliberately KEEPS the previous ReviewRecord — ⟦DEC-4⟧'s post-land attestation
   * flip is a review feature, so the discarded reviewer may legitimately submit after any stamp. This
   * stamp is the freshness axis that resolves that collision: a record submitted BEFORE it reads as absent
   * to the completion gate and the agent-facing GET, and a loop created before it loses read+write on the
   * sortie's review at the route. Without it a retried reviewer that never resubmits terminates the loop
   * clean off the review the operator threw away. Never set for a review-FIX sortie (assignedFromReview).
   */
  reviewRetryAt?: string;
  /**
   * SPEC-LOOP W7 — false-fail investigator markers (mirror docsSortie/docsFromRun). `investigateSortie`
   * marks the routed investigator sortie whose task is finalized from the previous verify run's failures
   * at phase start (then cleared, the idempotency key); `investigateFromRun` pins the TestRun id it
   * classified (runtime-only). The pin drives deterministic retry AND is the triage route's ownership
   * anchor (token→terminal→loop→sortie.investigateFromRun). An investigate phase carries NO stage —
   * identification is marker-only.
   */
  investigateSortie?: boolean;
  investigateFromRun?: string;
  /** SPEC-RESEARCH W9 — marks a research sortie (role 'explore'): its success is a submitted
   *  ResearchRecord, never commits. Unlike docs/review/investigate there is NO assign-time task
   *  finalization and NO runtime pin — the authored task IS the research question, so the marker is
   *  never cleared and is the single identification bit. Drives the reconcile-time finding gate, the
   *  refuse-to-land guard, the gate-skip, the digest exclusion, and the retry re-arm. */
  researchSortie?: boolean;
  /** SPEC-RESEARCH W9 — when this research sortie was last RETRIED. A retry re-runs the question but
   *  deliberately does NOT delete the previous finding (the operator may still want to compare), so
   *  both readers of the store — the reconcile gate and the agent-facing check — treat a record
   *  submitted BEFORE this stamp as absent. Without it a retried researcher inherits the discarded
   *  run's finding: its check command passes on iteration 1, which actively steers it away from
   *  resubmitting, and the sortie then lands on work the operator explicitly rejected. */
  researchRetryAt?: string;
}

/** SPEC-LOOP §0 — the ONE list of MissionPhase.stage values (mirrors PIPELINE_ROLES→ROLE_IDS).
 *  Every stage list — this type, CreateMissionRequest, the store's zod enum, the create-time
 *  registry check, the composer's DraftPhase — derives from this tuple, so a new stage lands in
 *  exactly one place instead of five hand-copied literals drifting apart. */
export const PHASE_STAGES = ['build', 'fix', 'verify', 'review', 'docs'] as const;
export type PhaseStage = (typeof PHASE_STAGES)[number];

export interface MissionPhase {
  id: string;
  name: string;
  sorties: MissionSortie[];
  /** SPEC-LOOP §0 — the phase's role in the loop. The evaluator finds the last `'verify'` phase to read
   *  the round's result; appended round phases carry `'fix'`/`'verify'`/`'docs'`. Optional → old records
   *  load; a phase without a stage is an ordinary (non-loop) phase. */
  stage?: PhaseStage;
  /** SPEC-LOOP §2 — the loop round (1-based) that appended this phase; absent on the authored plan's
   *  own phases. Purely informational (the Board round strip); never drives control flow. */
  round?: number;
  /** SPEC-LOOP §2 — the kind:'gate' TestRun id when a regression gate ran green before this phase's
   *  land (the report's gate-green proof). Absent when no gate ran (the normal case for a zero-commit
   *  verify/review phase — the terminating condition treats gateRunId as OPTIONAL). */
  gateRunId?: string;
}

/** SPEC-LOOP §2 — one iterate-until-green round's outcome, appended to `Mission.loop.rounds`. The evaluator
 *  reads the newest to decide green/red/escalate; the report renders the history. */
export interface MissionRoundRecord {
  n: number;                 // 1 = the authored plan
  kind: 'authored' | 'mechanical' | 'replanned' | 'review' | 'review-fix' | 'delivery' | 'escalating';
  appendedAt: string;
  verifyRunId?: string;      // the round's verify TestRun (pins deterministic re-evaluation)
  failed?: number;
  total?: number;
  /** `specFile › testTitle` keys of this round's failures (NOT errorTail — unstable). ≤100 × ≤200ch. */
  failureKeys?: string[];
  /** SPEC-LOOP W2 — transient planner-attempt counter while `kind==='escalating'` (bounded at 2): the
   *  two-tick escalation records the escalation in one tick and runs the LONG planner await in the next,
   *  so a thrown re-planner retries ONCE before giving up. Carried onto the replanned record on success. */
  attempts?: number;
  /** SPEC-PLANNER §7 — the escalating record's persisted consult link (the event-driven continuation,
   *  DEC-P4): while `kind==='escalating'` and a planner is bound, this points at the open PlannerConsult
   *  the tick re-entry consumes/expires/re-nudges. Carried onto the replanned record for provenance. A
   *  mid-escalation restart must not lose it (the `attempts` precedent). */
  consultId?: string;
}

/**
 * SPEC-LOOP W2 — the read-only context the codex re-planner (validator.planRevision) gets when a running
 * loop mission escalates: the goal, what has LANDED, the tests CURRENTLY failing, and what each prior
 * round tried. Assembled from the MISSION ONLY (never live config). SECRETS: carries names / statuses /
 * failureKeys ONLY — NO task bodies from landed work, NO errorTails, NO env/tokens. Lives here (not in
 * validator.ts) because missions.ts builds it and may NOT import validator.ts (the dep-direction rule).
 */
export interface PlanRevisionBundle {
  goal: string;
  /** `phaseName [stage round N]: sortieName (status)` for each landed/done sortie — never re-plan these. */
  landed: string[];
  /** `specFile › testTitle` keys of the tests the remaining work must make pass. */
  failing: string[];
  /** The round-by-round history the planner reasons over (newest-first in the prompt). */
  rounds: { n: number; kind: string; failed?: number; total?: number; tried?: string; failureKeys?: string[] }[];
  /** W6 — code-review findings; the prompt OMITS the section entirely when this is undefined. */
  reviewFindings?: string[];
  /** SPEC-RESEARCH W9 — the mission's research findings as bounded prose lines (agent-authored, same
   *  trust class as reviewFindings). Omitted entirely when the mission recorded none, so the prompt
   *  section disappears rather than rendering an empty heading. */
  research?: string[];
}

/**
 * SPEC-LOOP W4 — the deterministic, ZERO-LLM delivery report a mission emits the first time it
 * transitions INTO 'done' OR 'failed'. FROZEN INVARIANTS (do not weaken):
 *  - report-never-blocks-done: generation is fire-and-forget off the patch() choke point and NEVER
 *    throws — a report failure must not break the done/failed write.
 *  - report.json is the SOURCE OF TRUTH: it is written LAST + atomically (tmp+rename) and its
 *    existence is the completion marker; the web keys off it (absent ⇒ "report pending").
 *  - the web renders React FROM this JSON — never server-side HTML at the app origin, never an
 *    iframe/dangerouslySetInnerHTML of REPORT.html (§3 W4). REPORT.html is a self-contained,
 *    download-only artifact (attachment + nosniff + octet-stream), never served at the app origin.
 *  - SECRETS: this carries ONLY metadata (names/goals/statuses/branches/provider-model ids/run
 *    counts). NO env, NO tokens, NO log contents.
 */
export interface MissionReport {
  missionId: string;
  name: string;
  goal: string;
  /** The terminal status at generation — 'done' or 'failed' (the only two transitions that fire it). */
  status: MissionStatus;
  /** The mission's recorded base commit (mission.baseSha, or the legacy mission.loop.baseSha),
   *  recorded at first start for ALL missions (SPEC-TERMINAL-OPS §6). */
  baseSha?: string;
  finishedAt: string;
  /** A summary of `mission.loop.rounds` (the round-by-round pass/fail history); [] for a non-loop mission. */
  rounds: MissionRoundRecord[];
  phases: MissionReportPhase[];
  /** The proof files copied under `~/.ct/reports/<missionId>/proof/` (run metas + artifacts). */
  proof: MissionReportProofEntry[];
  /** The final regression gate's TestRun id (the newest phase.gateRunId), when a gate ran green. */
  gateRunId?: string;
  /** SPEC-LOOP W6 — the code reviews recorded for this mission (newest first), when any reviewer
   *  submitted. Absent on an old report or a mission that ran no review — the section then hides. */
  reviews?: MissionReportReview[];
  /** SPEC-LOOP W7 — per-round false-fail investigations (the investigator's classifications), when the
   *  mission ran with loop.investigate. The operator-audit surface: triage NEVER enters the verdict, so
   *  every by-design/false suppression is surfaced here. Absent ⇒ the section hides. */
  investigations?: MissionReportInvestigation[];
  /** SPEC-RESEARCH W9 — the research findings this mission's research sorties submitted, newest first.
   *  Absent ⇒ the section hides (the reviews/investigations back-compat rule: a pre-W9 report renders
   *  unchanged). */
  research?: MissionReportResearchFinding[];
}

/** SPEC-RESEARCH W9 — one research finding in a MissionReport. Unlike the review projection this keeps
 *  the FULL summary: report.json is the source of truth for the finding, and a survey truncated in the
 *  only durable place it is written would defeat the artifact. Metadata + agent-authored text only. */
export interface MissionReportResearchFinding {
  sortieId: string;
  round?: number;
  topic: string;
  summary: string;
  citations?: { ref: string; note?: string }[];
  submittedAt: string;
}

/** SPEC-LOOP W7 — one round's false-fail investigation in a MissionReport. `real` = the round's failure
 *  count minus the matched by-design/false suppressions (UNCLASSIFIED counts as real, matching what the
 *  fixers actually partitioned). `suppressed` lists each suppressed failure with the investigator's
 *  reason — classification metadata + agent-authored text only, never log contents. */
export interface MissionReportInvestigation {
  round: number;
  runId: string;
  real: number;
  byDesign: number;
  falseFails: number;
  suppressed: { class: 'by-design' | 'false'; specFile: string; testTitle: string; reason?: string }[];
}

/** SPEC-LOOP W6 — one code review in a MissionReport (a projection of a ReviewRecord: which sortie,
 *  the counts, and the finding metadata — file/line/summary/verdict only, detail excluded to stay
 *  compact). `attestedClean` is true ONLY when findings.length===0 — the one case the renderers show
 *  the verbatim 'clean — attested by the reviewer, not machine-verified' line. */
export interface MissionReportReview {
  sortie: string;
  round?: number;
  submittedAt: string;
  confirmed: number;
  plausible: number;
  findings: { file: string; line?: number; summary: string; verdict?: 'CONFIRMED' | 'PLAUSIBLE' }[];
  attestedClean: boolean;
}

/** SPEC-LOOP W4 — one phase in a MissionReport (a projection of MissionPhase: title/stage/round + sorties). */
export interface MissionReportPhase {
  title: string;
  stage?: PhaseStage;
  round?: number;
  sorties: MissionReportSortie[];
}

/** SPEC-LOOP W4 — one sortie in a MissionReport. provider/model are resolved from the sortie's loop
 *  (never re-derived from routing); branch is the loop's branch. Metadata only — no task text. */
export interface MissionReportSortie {
  name: string;
  provider?: ProviderId;
  model?: string;
  /** SPEC-EFFORT §5 — the reasoning effort this sortie's loop ran at (report truth). */
  effort?: string;
  status: SortieStatus;
  loopId?: string;
  branch?: string;
}

/** SPEC-LOOP W4 — one file copied into the report's `proof/` dir. `run-meta` is a run's copied
 *  meta.json (`run-<runId>.json`); `artifact` is a copied test artifact. `bytes` is the copied size. */
export interface MissionReportProofEntry {
  name: string;
  kind: 'run-meta' | 'artifact';
  bytes: number;
}

/** SPEC-LOOP §1 — a mission's iterate-until-green loop config + running state. Present ⇒ the completion
 *  evaluator drives this mission (append-only rounds until green or a cap); absent ⇒ the classic linear
 *  phase walk. Caps clamped at create; the boundary reads THIS, never live project config, so a
 *  mid-flight mission's condition can never change under it. */
export interface MissionLoop {
  maxRounds: number;         // [1,8] — the ONE monotonic round counter across all round kinds
  mechanicalRounds: number;  // [0,4] — mechanical fix rounds before planner escalation (W2)
  sortieBudget: number;      // [1,64] — checked before every append
  round: number;             // 1 = the authored plan
  deliveryAppended?: boolean;
  baseSha?: string;          // LEGACY LOCATION — see Mission.baseSha (SPEC-TERMINAL-OPS §6); kept for on-disk reads
  requirePlanReview?: boolean; // W3 — captured per-mission so a mid-flight mission never changes condition
  requireReview?: boolean;     // W6
  investigate?: boolean;       // W7 — prepend a false-fail investigator to each mechanical round; read at the boundary, never live config
  /** SPEC-SKILLS-GATE — skill ids (plain strings, sorted) FROZEN at create whose blocking loop-green
   *  gate must hold a 'pass' evidence record before the loop may finish green. Derived route-side from
   *  the project's resolved skill selection and threaded through create()'s SECOND arg — deliberately
   *  never a wire field, so a raw-API body cannot smuggle one in. The boundary reads THIS, never live
   *  skill config (the requireReview freeze doctrine). An OLDER Tower's zod strips it and simply does
   *  not enforce (the downgrade posture above); this Tower lists both fields in the store schema (M6). */
  requiredGates?: string[];
  /** SPEC-SKILLS-GATE — the subset of requiredGates that declared rerunOnNewDiff: their evidence goes
   *  stale when a code-change phase lands AFTER the phase of the submitting sortie. Freshness is
   *  phase-structure identity (append-only phase indices), never a clock. */
  rerunGates?: string[];
  rounds: MissionRoundRecord[];
}

/** SPEC-LOOP W3 (G4) — one finding from the pre-execution plan grade. `lens` names which of the two
 *  read-only lenses raised it (fact-check anchors against the repo; red-team plan soundness). A `block`
 *  finding means the plan cannot be authorized as-is; a `warn` is advisory. `target` optionally names
 *  the phase / sortie (or file / anchor) the finding concerns. Findings are operator plan text — never
 *  secrets; the Brain caps their lengths defensively. */
export interface PlanFinding {
  lens: 'fact-check' | 'red-team';
  severity: 'block' | 'warn';
  detail: string;
  target?: string;
}

/** SPEC-LOOP W3 (G4) — the codex Brain's pre-execution grade of a mission's DRAFTED plan. It is
 *  READ-ONLY and OFF the fixer path: the Brain grades the plan through two sequential lenses before any
 *  agent runs, never editing code or feeding a fixer. The grade BINDS to `phasesHash`: a `pass`
 *  authorizes ONLY that exact plan — an edit changes the hash, and start() on a `requirePlanReview`
 *  mission refuses until the CURRENT plan is re-graded green. A `pass` is the Brain's judgement, never
 *  a fabricated verdict (gradePlan throws rather than invent one, so a stored review is always real). */
export interface MissionPlanReview {
  verdict: 'pass' | 'block';
  findings: PlanFinding[];
  gradedAt: string;
  /** computePhasesHash() of the plan this grade authorizes; a pass is void once the plan changes. */
  phasesHash: string;
}

/** SPEC-LOOP §2 — the task a loop's verify runner carries, shared VERBATIM by the server's mechanical
 *  rounds and the composer's verify-phase template. It is load-bearing: the runner must run-and-report
 *  (no code changes, no fixing) so the zero-commit path lands the sortie and the completion evaluator
 *  is the sole green/red judge off the recorded run. */
export const LOOP_VERIFY_TASK =
  'Run the project e2e suite with `towerctl test run` and nothing else — do NOT modify code, do NOT '
  + 'try to fix failures; just run the suite so the loop can read the results.';

/** SPEC-LOOP W6 — the PLACEHOLDER task the routed reviewer sortie carries, shared VERBATIM by the
 *  server's review rounds (reviewRoundPhases) and the composer's review-phase template. The Tower
 *  rewrites it at phase start (assignReviewPhase) with the exact commit range to review. */
export const LOOP_REVIEW_TASK =
  'Review the code changes on this branch. The Tower rewrites this task at the start of the phase '
  + 'with the exact commit range to review and how to submit your findings.';

/** SPEC-LOOP W6 — the reviewer sortie's checkCommand: it authenticates as its own terminal (the W1
 *  runCheck token-env fix) and fails while no review is submitted OR the branch holds commits (a
 *  reviewer must not commit code). Shared by the server and the composer template. */
export const REVIEW_CHECK_COMMAND = 'towerctl review check';

/** SPEC-RESEARCH W9 — the checkCommand a research sortie carries: it fails until a finding has been
 *  submitted, so the loop keeps iterating instead of resolving a researcher that produced nothing.
 *  Shared by the composer template and any doc, so the two can never drift. */
export const RESEARCH_CHECK_COMMAND = 'towerctl research check';

export type MissionStatus =
  | 'draft' | 'running' | 'phase-gate' | 'paused' | 'attention' | 'done' | 'failed';

// ---- SPEC-PLANNER W8a: the planner terminal + consults ----

/** SPEC-PLANNER §1 — the mission's bound planner terminal (an interactive agent pane the Tower asks
 *  structured questions). Optional → old mission records load unchanged. */
export interface MissionPlanner {
  terminalId: string;
  provider: ProviderId;          // captured at bind; the respawn routing key
  model?: string;                // spawn path only (adopted panes don't record their argv model)
  effort?: string;
  profileId?: string;
  state: 'live' | 'lost';        // 'lost' = the pane vanished; the tick's ask path lazily respawns
  attachedAt: string;
  spawned?: boolean;             // true = Tower-spawned (incl. respawns); false/absent = adopted
  respawns?: number;             // lifetime respawn count, capped at 2 (DEC-P6)
  respawnedAt?: string;
}

/** SPEC-PLANNER §1 — the consult-kind union ships in full so W8b needs no schema migration; W8a asks,
 *  validates and consumes ONLY 'replan' (DEC-P9). Any other kind on the wire → 400. */
export const CONSULT_KINDS = ['replan', 'grade', 'stories', 'authorize', 'judge'] as const;
export type ConsultKind = (typeof CONSULT_KINDS)[number];

export type ConsultStatus =
  | 'pending'     // asked; pointer mail enqueued; not yet seen by the planner
  | 'delivered'   // the planner read its inbox or hit planner/pending — the answer clock switches on
  | 'answered'    // a reply is stored; the next tick re-entry consumes it
  | 'applied'     // the answer passed the trusted pipeline and took effect (terminal)
  | 'rejected'    // the answer failed the trusted pipeline (terminal; a fresh consult re-asks)
  | 'expired';    // a clock ran out, the planner was unrecoverable, or the mission ended (terminal)

/** SPEC-PLANNER §2 — one structured question to a mission's planner terminal. The question text is
 *  SELF-CONTAINED (reply protocol + payload rendered in) and rides HTTP only — the ONLY
 *  thing typed into the pane is the one-line mail nudge. SECRETS: the payload obeys the
 *  PlanRevisionBundle discipline — names/statuses/failureKeys, never task bodies of landed work, never
 *  errorTails, never env/tokens. */
export interface PlannerConsult {
  id: string;
  missionId: string;
  terminalId: string;            // the planner pane it is addressed to; MIGRATES on respawn (§8)
  kind: ConsultKind;             // W8a asks only 'replan' (DEC-P9)
  question: string;              // ≤16000 chars, the full self-contained body
  payload?: PlanRevisionBundle;  // 'replan': the same bundle the codex re-planner path gets
  phasesHash?: string;           // W8b 'grade' slot: captured at ASK time, passed
                                 // VERBATIM to setPlanReview at reply time. Unused by 'replan'.
  status: ConsultStatus;
  askedAt: string;
  deliveredAt?: string;
  answeredAt?: string;
  answer?: unknown;              // raw validated reply body (per-kind zod at the route)
  nudges?: number;               // consult-driven nudge ATTEMPTS (send-time + renudge), cap 3 total
  lastNudgeAt?: string;          // when the last nudge attempt fired — the P5 one-shot renudge gate
                                 // (renudge only after crossing the active clock's half-deadline SINCE
                                 // the previous nudge, so a pending consult can't renudge every tick)
  expireReason?: 'delivery-timeout' | 'answer-timeout' | 'planner-unrecoverable'
    | 'planner-detached' | 'mission-ended' | 'superseded';
}

/** A planned multi-phase campaign the autopilot advances at phase boundaries. */
export interface Mission {
  id: string;
  projectId: string;
  name: string;
  goal: string;
  provider: ProviderId;
  /** Mission-level model default; a resolveRouting fallback under per-sortie/role. */
  model?: string;
  /** SPEC-EFFORT §1 — mission-tier reasoning-effort default; resolved at the MISSION rank of resolveRouting. */
  effort?: string;
  profileId?: string;
  identityId?: string;
  /** 'gate' (default): stop at each completed phase for an operator Land & advance.
   *  'auto': strictly-opt-in unattended landing + advancing. */
  advance: 'gate' | 'auto';
  maxIterationsPerSortie: number;
  concurrency: number;
  /**
   * SPEC-STORYLOOP §4 — the e2e suite the regression gate runs against the integrated
   * trial-merge tree before the first land (e.g. `towerctl test run`). Unset = no gate.
   */
  gateSuite?: string;
  phases: MissionPhase[];
  /** Index into phases; -1 = not started. */
  activePhase: number;
  /** SPEC-TERMINAL-OPS §6 — the repo HEAD at first start, for ALL missions; loop missions before this
   *  wave stored it at loop.baseSha (kept as a read fallback). Grounds a review sortie's diff range and
   *  the delivery report's base metadata, both of which any mission (not just a loop) can carry. */
  baseSha?: string;
  /** SPEC-LOOP §1 — when set, the completion evaluator iterates this mission until green (append-only
   *  rounds at the tail) or a cap, instead of finishing at the last phase. Absent = classic linear walk. */
  loop?: MissionLoop;
  /** SPEC-LOOP W3 (G4) — the codex Brain's pre-execution grade of the CURRENT draft plan, bound to its
   *  phasesHash. Present only on a draft that was reviewed; start() on a `loop.requirePlanReview` mission
   *  refuses unless this is a `pass` for the current plan. Read-only, off the fixer path. */
  planReview?: MissionPlanReview;
  /** SPEC-PLANNER §1 — the mission's bound planner terminal, when the operator attached (or the Tower
   *  spawned) one. Absent → the mission's escalations use the codex Brain re-planner, byte-identically
   *  to today. Optional in both this interface and its zod mirror, so old records load unchanged. */
  planner?: MissionPlanner;
  status: MissionStatus;
  stopReason?: string;
  /** SPEC-BACKLOG §3 — set when the operator (or Clear finished) archives a FINISHED mission
   *  (done|failed; drafts are manually archivable, never bulk-swept). Archived records stay
   *  served — the Board filters, Outcomes keeps history. */
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMissionRequest {
  projectId: string;
  name: string;
  goal: string;
  provider?: ProviderId;
  model?: string;
  /** SPEC-EFFORT §1 — mission-tier reasoning-effort default (the operator's per-mission default). */
  effort?: string;
  profileId?: string;
  identityId?: string;
  advance?: 'gate' | 'auto';
  maxIterationsPerSortie?: number;
  concurrency?: number;
  /** SPEC-BACKLOG ⟦DP-B4⟧ — the backlog task this mission instantiates. Stamped ROUTE-side after
   *  a successful create (link refuses overwrite); the mission runner never reads it. */
  backlogTaskId?: string;
  /**
   * SPEC-STORYLOOP §4 — the e2e suite the regression gate runs against the integrated trial-merge
   * tree before the first land (mirrors `Mission.gateSuite`). Passed through create.
   * SPEC-TESTING-V2 §2 wire contract: ABSENT (undefined) = INHERIT the project's testing-config
   * gateSuite (stamped route-side at create); '' = EXPLICIT no gate; a value = use it. The route keys
   * on `=== undefined`, so an explicit '' opt-out is never converted back to inherit.
   */
  gateSuite?: string;
  /** SPEC-LOOP §1 — request the iterate-until-green loop for this mission (the composer "Loop until green"
   *  toggle). Caps clamped at create; absent = a classic linear mission. */
  loop?: {
    maxRounds?: number;
    mechanicalRounds?: number;
    sortieBudget?: number;
    requirePlanReview?: boolean;
    requireReview?: boolean;
    investigate?: boolean; // W7 — prepend a false-fail investigator to each mechanical round
  };
  /** SPEC-PLANNER §3 (DEC-P8) — request a Tower-spawned planner terminal bound to this mission. The
   *  route (POST /api/missions) CONSUMES and strips this before missions.create (like backlogTaskId),
   *  spawning the pane BEFORE the mission and failing closed (spawn failure → 400, no mission). The
   *  mission runner never sees the field. */
  planner?: { spawn: { provider?: ProviderId; model?: string; effort?: string; profileId?: string } };
  phases: {
    name: string;
    /** SPEC-LOOP §0 — the phase's loop stage (composer-authored: a loop mission ends in a 'verify' phase). */
    stage?: PhaseStage;
    /**
     * The draft-sortie shape (also what planPhases returns, §0.7/§2.5): the per-sortie routing
     * overrides (role/provider/model) mirror MissionSortie, plus a Jarvis proposal `rationale`
     * (⟦§2.5⟧, draft-only — the one field beyond MissionSortie; not persisted on the sortie).
     */
    sorties: {
      name: string;
      task: string;
      assertions?: string[];
      checkCommand?: string;
      role?: PipelineRole;
      provider?: ProviderId;
      model?: string;
      /** SPEC-EFFORT §1 — per-sortie reasoning-effort override (mirrors MissionSortie.effort). */
      effort?: string;
      profileId?: string;
      rationale?: string;
      /**
       * SPEC-STORYLOOP §3.2 — carried through planPhases/composer so a drafted verify-phase
       * fixer is marked. `assignedFrom` is runtime-only and is NOT part of a create request.
       */
      verifyFixer?: boolean;
      /** SPEC-TESTING §3 — carried through planPhases/composer so a drafted docs-phase sortie is marked
       *  (docsFromRun is runtime-only, NOT part of a create request). */
      docsSortie?: boolean;
      /** SPEC-LOOP W6 — carried through the composer so a drafted review-phase sortie is marked; the
       *  Tower finalizes its task from the base commit at review-phase-start (assignReviewPhase). The
       *  reviewFromRange/reviewFixer/assignedFromReview runtime pins are NEVER part of a create request. */
      reviewSortie?: boolean;
      /** SPEC-LOOP W7 — carried through the composer so a drafted investigate-phase sortie is marked; the
       *  Tower finalizes its task from the previous verify run at phase start (assignInvestigatePhase).
       *  The investigateFromRun runtime pin is NEVER part of a create request. */
      investigateSortie?: boolean;
      /** SPEC-RESEARCH W9 — authored research marker (composer / Jarvis / raw API). */
      researchSortie?: boolean;
    }[];
  }[];
}

// ---- Story corpus + structured e2e results (SPEC-STORYLOOP §1/§2) — FROZEN ----

/** AUTHORING lifecycle only — never a computed coverage verdict (coverage is derived, §1.4). */
export type StoryStatus = 'draft' | 'active' | 'retired';

/** A user story as first-class data the Tower checks work against (SPEC-STORYLOOP §1.1). */
export interface Story {
  id: string;                 // shortId
  projectId: string;          // per-project data
  title: string;
  story: string;              // "As a … I want … so that …"
  routes?: string[];          // app routes this story exercises (free-text, for the UI)
  specFiles?: string[];       // the Playwright spec files that cover it — the COVERAGE JOIN KEY
  status: StoryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStoryRequest {
  projectId: string;
  title: string;
  story: string;
  routes?: string[];
  specFiles?: string[];
  status?: StoryStatus;
}

// ---- SPEC-SKILLS — canonical, provider-agnostic skills (the shared reusable-capability library) ----
// The store persists EVERY field below from day one, so the later materialization / provider-
// translation / gating / assistant-editing work needs no migration. Many fields are declared here but
// stay inert until those consumers land — noted per field. The store zod mirror MUST list every
// optional field or it is stripped on load (the M6 strip-trap); several enum-ish arrays are stored as
// plain strings so a newer Tower's new value is never dropped by an older one — consumers treat an
// unknown value fail-closed.

export type SkillScope = 'global' | 'project';
export type SkillOrigin = 'imported' | 'operator' | 'assistant';
/** 'auto' may self-invoke on its trigger; 'suggest' may propose but never run un-asked; 'never' is
 *  user-only, by exact name. */
export type SkillModelInvocation = 'auto' | 'suggest' | 'never';
export type SkillGateBlock = 'commit' | 'push' | 'forge-write' | 'loop-green' | 'mission-land';
export type SkillGateEnforcer = 'orchestrator' | 'provider-hook' | 'policy-text';
export type SkillCapability =
  | 'subagents' | 'workflow-tool' | 'worktree-isolation' | 'shell' | 'network' | 'interactive-questions';
export type SkillChannel = 'skill-dir' | 'instructions-file' | 'invocable-prompt' | 'sortie-brief';

export interface SkillInvocation {
  user: boolean;
  model: SkillModelInvocation;
  triggerPhrases?: string[];
  /** claude `argument-hint` frontmatter passthrough (the teach skill uses it). */
  argumentHint?: string;
}

/** Absent gate = advisory (the default). A blocking gate is enforced today on two planes: the
 *  materialized policy text every agent receives (sectionGateText — the agent-actionable blocks), and
 *  the orchestrator's completion evaluator for 'loop-green' (missions.ts resolveGateState, on the
 *  create-frozen loop.requiredGates; SPEC-SKILLS-GATE). 'mission-land' enforcement is still pending. */
export interface SkillGate {
  mode: 'advisory' | 'blocking';
  blocks?: SkillGateBlock[];
  enforcedBy?: SkillGateEnforcer[];
  rerunOnNewDiff?: boolean;
}

/** Capability preconditions — the honest translation gate. Declared now; consumed by the translator. */
export interface SkillRequires {
  capabilities?: SkillCapability[];
  models?: string[];
}

/** An explicitly AUTHORED per-provider variant — never auto-generated. Consumed by the translator. */
export interface SkillProviderOverride {
  omit?: boolean;
  body?: string;
  channel?: SkillChannel;
  allowedTools?: string[];
}

/** Asset metadata; content lives on disk under ~/.ct/skills/<id>/assets/<relPath>. */
export interface SkillAsset {
  relPath: string;   // charset-guarded, no '..', no leading '/' or '.'
  mode?: number;     // original mode & 0o777 (the exec bit is METADATA; store files are written 0600)
  sha256: string;
  size: number;
}

/** Skill METADATA — the body is on disk; GET /api/skills/:id returns SkillWithBody. */
export interface Skill {
  id: string;              // isSafeName slug; becomes a dirname/filename when materialized
  name: string;            // display name (may differ from id — the emil-design-engineering case)
  version: number;         // 1 on create, ++ on every upsert
  contentHash: string;     // sha256 over the materialization-affecting fields (a frozen contract)
  description: string;     // WHAT it does
  trigger?: string;        // WHEN to use (re-packed with description at materialization)
  assets?: SkillAsset[];
  scope: SkillScope;       // always 'global' today; 'project' resolved by a later per-project consumer
  enabled: boolean;
  /** Operator lock (SPEC-SKILLS Phase 5): the assistant can never PROPOSE toggling this skill off or
   *  deselecting it — the reserved-account refusal, keyed on protection instead of the Brain id. A
   *  blocking-gate skill (code-review) is protected too, DERIVED — see isProtectedSkill (skills/store).
   *  Excluded from contentHash (governance, not emitted content — the enabled/scope/origin rationale). */
  protected?: boolean;
  /** Operator attestation (SPEC-SKILLS Phase 5b wave 2) that this assistant-authored body may reach
   *  skip-permissions agents; absent = interactive-only. Excluded from contentHash (governance, not
   *  emitted content), and DROPPED automatically whenever content changes — the attestation is of
   *  EXACT bytes. DELIBERATELY absent from UpsertSkillRequest: only the operator's
   *  POST /api/skills/:id/autonomy-cleared can set it, never an upsert/promote payload. */
  autonomyCleared?: boolean;
  invocation: SkillInvocation;
  gate?: SkillGate;
  requires?: SkillRequires;
  supportedProviders?: ProviderId[];  // absent = any provider satisfying `requires`; never 'shell'
  providerOverrides?: Partial<Record<ProviderId, SkillProviderOverride>>;
  toolHints?: { allowedTools?: string[] };  // canonical form of code-review's allowlist
  tags?: string[];
  origin: SkillOrigin;     // provenance — where it CAME from; immutable after create
  createdAt: string;
  updatedAt: string;
}

export interface SkillWithBody extends Skill {
  body: string;            // VERBATIM markdown; may contain the reserved {{skillDir}} token
}

export interface UpsertSkillRequest {
  id?: string;             // present = patch/create at that id; absent = mint a slug from name
  name: string;
  description: string;
  body: string;
  trigger?: string;
  scope?: SkillScope;
  enabled?: boolean;
  protected?: boolean;     // patch-preserving lock (SPEC-SKILLS Phase 5); absent = keep, false = clear
  invocation?: Partial<SkillInvocation>;
  gate?: SkillGate;
  requires?: SkillRequires;
  supportedProviders?: ProviderId[];
  providerOverrides?: Partial<Record<ProviderId, SkillProviderOverride>>;
  toolHints?: { allowedTools?: string[] };
  tags?: string[];
  origin?: SkillOrigin;    // honored at CREATE only; ignored on patch (provenance is immutable)
  /** undefined = KEEP existing assets; [] = clear. Over HTTP content is utf8 text. */
  assets?: { relPath: string; content: string; mode?: number }[];
  /** SPEC-SKILLS Phase 5b wave 2 — the retype-the-name gate. When the TARGET record is protected
   *  (operator lock or blocking gate), every mutating skills route demands this equal the current
   *  record's exact name, else 409. Wire-only: routes read it off the raw body and it never becomes
   *  store input (UpsertSkillInput deliberately lacks it). */
  confirmName?: string;
}

/** SPEC-SKILLS Phase 5b wave 2 — one per-skill version-history snapshot, written inside the store's
 *  stage-swap on every REAL content change (never on flag flips), retention-bounded at 20. Carries
 *  the SUPERSEDED version's promote-relevant prose + verbatim body; assets are not snapshotted
 *  (rollback keeps current assets — a documented limitation, bounded cost). */
export interface SkillHistoryEntry {
  version: number;         // the superseded record's version — also the v<N>.json filename
  contentHash: string;     // that version's frozen content hash
  name: string;
  description: string;
  trigger?: string;
  tags?: string[];
  origin: SkillOrigin;
  body: string;            // verbatim (JSON string round-trips bytes exactly)
  ts: string;              // when the snapshot was written (the moment it was superseded)
}

/** META view for GET /api/skills/:id/history (no body — bounded payload). */
export type SkillHistoryMeta = Omit<SkillHistoryEntry, 'body'> & { bodyBytes: number };

/** The result of the one-time importer (POST /api/skills/import) — surfaced inline in the panel. */
export interface SkillImportReport {
  imported: string[];
  skipped: { id: string; reason: string }[];
  errors: { id: string; reason: string }[];
  warnings: string[];
}

// ---- SPEC-SKILLS Phase 3 — per-project skill selection (bundles + overlay + a resolution VIEW).
//      These mirror the SPEC-ROUTING trio (WorkflowProfile / ProjectRouting / LayeredRoleRouting)
//      structurally; they live in their OWN config file (skill-selection.json), never on the Skill
//      or Project record. Phase 3 ships selection + resolution; per-project filesystem DELIVERY to a
//      terminal is a later sub-phase (a non-global entry carries delivered:false until then). ----

/** A named, reusable set of skills a project can select (the WorkflowProfile mirror). Ids are minted
 *  by the server (shortId), never dirnames. `skillIds` is isSafeName-filtered + deduped on write;
 *  a dangling id (its skill was deleted) is tolerated and surfaced as a resolution warning. */
export interface SkillBundle {
  id: string;
  name: string;
  description?: string;
  skillIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** A project's skill overlay: an optional selected bundle plus ATOMIC per-skill on/off overrides
 *  (the ProjectRouting mirror). `enable[id]=true` adds (even a scope:'project' skill outside the
 *  bundle); `enable[id]=false` removes (even a default-on global). An empty overlay is not stored. */
export interface ProjectSkills {
  bundleId?: string;
  enable?: Record<string, boolean>;
}

/** One resolved entry of a project's effective skill set — a VIEW, never persisted (the
 *  EffectiveRoleRoute mirror). `source` is the most specific tier that selected it; `providers`
 *  are the channel-having providers that would materialize it; `delivered` is false for entries
 *  only reachable via the per-project delivery sub-phase (Phase 3 only delivers the global set). */
export interface EffectiveSkillEntry {
  id: string;
  name: string;
  source: 'project' | 'bundle' | 'global';
  providers: ProviderId[];
  scope: SkillScope;
  delivered: boolean;
}

// ---- SPEC-SKILLS Phase 5b — the assistant's INERT skill-draft pad. A draft lives in its OWN store,
//      file, and type (never a status flag on Skill): the materializer imports only the skill store +
//      selection, so no draft can reach an agent except through the session-only promote route. The
//      field set IS the whitelist — gate / providerOverrides / toolHints / assets / scope /
//      supportedProviders / protected / enabled / origin / invocation are DELIBERATELY absent (a
//      promoted draft can never create a blocking gate, plant an executable asset, smuggle a second
//      body via an override, or widen provider reach; those fields stay operator-only). `invocation`
//      is out too — wave 1's whitelist; a promoted NEW skill gets the store's base
//      { user:true, model:'auto' }, and the operator tunes invocation in Settings. Do not add fields
//      here without re-reviewing the promote path's containment argument. ----

/** One assistant-authored skill draft (body INLINE — one atomic 0600 JSON holds the whole pad). */
export interface SkillDraft {
  id: string;              // shortId(), isSafeName-guarded
  conversationId: string;  // ownership — from the x-tower-conversation header, never the body
  name: string;
  description: string;
  trigger?: string;
  body: string;            // ≤ 64 KB (REJECT over-cap — the store's truncated-skill-is-broken posture)
  tags?: string[];
  targetSkillId?: string;  // absent = promote creates a NEW skill from the slugified name
  status: 'open' | 'promoted';
  /** sha256 over the canonical whitelisted fields (incl. targetSkillId — retargeting a proposed
   *  draft must void its card). The promote pin. */
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

/** META view for the draft list route (no body — bounded payload). */
export type SkillDraftMeta = Omit<SkillDraft, 'body'> & { bodyBytes: number };

/** One failing test parsed from Playwright's JSON reporter (SPEC-STORYLOOP §2.1). */
export interface TestFailure {
  specFile: string;   // repo-relative (relative to the JSON's config.rootDir; repoPath fallback)
  testTitle: string;  // the spec's full title path joined ' › '
  storyId?: string;   // derived by the corpus join in the read-models (§2.2) — never from an annotation
  errorTail: string;  // last ~12 lines of the first result error message, ANSI-stripped, ≤2000 chars
  /** SPEC-TESTING §6 — run-dir-relative names of artifacts copied at release (screenshots, traces, etc.),
   *  under <runDir>/artifacts/. Empty/absent when the failure had none or copy was skipped. */
  artifacts?: string[];
}

// ---- SPEC-LOOP W7 — false-fail triage (the investigator's classification of a verify run's failures) ----

/** The three classes the routed investigator assigns each failing test. Only 'real' failures are handed
 *  to fixers; 'by-design' / 'false' are suppressed from the partition and surfaced in the report. An
 *  UNCLASSIFIED failure (no entry, or an unrecognized class) is treated as 'real' (the fail-safe posture:
 *  triage can only ever REMOVE work, never fabricate a green — the terminating condition stays strict). */
export const TRIAGE_CLASSES = ['real', 'by-design', 'false'] as const;
export type TriageClass = (typeof TRIAGE_CLASSES)[number];

/** The char cap applied to a triage entry's join keys AND to what setTriage stores for those keys, so the
 *  fixer filter, feedback.ts, and the stored clamp can never disagree. Raised well ABOVE any realistic
 *  (specFile, testTitle) so the key never truncates two DISTINCT pairs to the same value (a data-driven
 *  test's long shared describe-prefix would collide at 300). Display truncation (in the report) is a
 *  SEPARATE concern — it never feeds the key. */
export const TRIAGE_KEY_CAP = 2000;
/** The separate cap for a triage entry's free-text reason (bounds the stored record; not a join key). */
export const TRIAGE_REASON_CAP = 300;

/** One investigator classification, keyed by specFile+testTitle (the same join the fixer filter uses). */
export interface TestTriageEntry {
  specFile: string;
  testTitle: string;
  class: TriageClass;
  reason?: string;
}

/** The ONE join key for a triage entry / a failure — specFile + testTitle, each sliced to TRIAGE_KEY_CAP,
 *  joined by U+001F (unit separator: a control char that cannot appear in a file path or a test title, so
 *  the two components can never merge ambiguously — a plain space let `("a b","c")` collide with
 *  `("a","b c")`). Shared by the assignFixerPhase suppression filter, feedback.ts, and setTriage so the
 *  joins can never drift; the store clamps stored keys to this SAME cap so a stored entry and a run
 *  failure always produce the same key. */
export function triageKey(x: { specFile: string; testTitle: string }): string {
  return `${x.specFile.slice(0, TRIAGE_KEY_CAP)}\u001f${x.testTitle.slice(0, TRIAGE_KEY_CAP)}`;
}

/**
 * SPEC-LOOP W7 — the ONE triage partition: split a run's failures into REAL (handed to fixers / the
 * backlog) vs suppressed (by-design / false), at OCCURRENCE granularity over `results`. This is the
 * source of truth for every surface — the fixer partition, the backlog filing, the report counts, and the
 * triage route/CLI — so they can never disagree. `real` is every failure whose key is NOT classed
 * by-design/false (UNCLASSIFIED and 'real' both count as real); `byDesign`/`falseFails` count the
 * OCCURRENCES (one Playwright project/browser = one TestFailure with the same key, so a test suppressed
 * across 3 browsers counts 3 here — matching what the fixer/backlog actually saw). `suppressedKeys` is
 * the DEDUPED set of by-design/false keys (the filter membership). Invariant:
 * `real.length + byDesign + falseFails === results.length`.
 */
export function partitionByTriage(
  results: TestFailure[],
  triage: TestTriageEntry[] | undefined,
): { real: TestFailure[]; byDesign: number; falseFails: number; suppressedKeys: Set<string> } {
  // Class per key (triage is already deduped at storage; first-wins if not).
  const classByKey = new Map<string, TriageClass>();
  for (const t of triage ?? []) {
    const k = triageKey(t);
    if (!classByKey.has(k)) classByKey.set(k, t.class);
  }
  const suppressedKeys = new Set<string>();
  for (const [k, c] of classByKey) if (c === 'by-design' || c === 'false') suppressedKeys.add(k);
  const real: TestFailure[] = [];
  let byDesign = 0;
  let falseFails = 0;
  for (const f of results) {
    const c = classByKey.get(triageKey(f));
    if (c === 'by-design') byDesign++;
    else if (c === 'false') falseFails++;
    else real.push(f); // 'real', UNCLASSIFIED, or unrecognized → real
  }
  return { real, byDesign, falseFails, suppressedKeys };
}

/** SPEC-LOOP W7 — the COUNT projection of partitionByTriage (occurrence granularity): the ONE source of
 *  truth for the real / by-design / false numbers shown by the report, the triage route/CLI, and the Test
 *  Runs panel, so they can never drift. `real + byDesign + falseFails === results.length`. */
export function triageCounts(
  results: TestFailure[],
  triage: TestTriageEntry[] | undefined,
): { real: number; byDesign: number; falseFails: number } {
  const part = partitionByTriage(results, triage);
  return { real: part.real.length, byDesign: part.byDesign, falseFails: part.falseFails };
}

/** SPEC-LOOP W6 — one structured finding from the routed code reviewer (role 'review-judge'). Same
 *  trust class as a TestFailure errorTail (agent-authored, fed to fixers) — the store caps every
 *  string defensively. An ABSENT verdict is treated as CONFIRMED (fail-safe: the reviewer must
 *  explicitly downgrade a finding to PLAUSIBLE for it to be excluded from fixer partitioning). */
export interface ReviewFinding {
  file: string;
  line?: number;
  summary: string;
  detail?: string;
  category?: string;
  verdict?: 'CONFIRMED' | 'PLAUSIBLE';
}

/** SPEC-LOOP W6 — one reviewer submission, persisted per (missionId, sortieId) in ~/.ct/config/reviews.json.
 *  A resubmit REPLACES the prior record with a fresh id (the honest current attestation). `{findings:[]}`
 *  is an ATTESTED-clean review — the reviewer's judgement that the change is sound, NOT a machine proof;
 *  every clean-labeled surface says so. The evaluator terminates a green loop only on a fresh clean
 *  review; CONFIRMED findings append a review-fix round; PLAUSIBLE-only findings terminate as clean
 *  (they still render in the report for the operator, but assign no fixer work). */
export interface ReviewRecord {
  id: string;
  missionId: string;
  sortieId: string;
  /** The loop round of the review phase this record came from (informational; report/history). */
  round?: number;
  /** The commit range the reviewer was asked to review — always `<baseSha>..HEAD` when present (the
   *  review phase routes to attention rather than finalize when no base commit was recorded, so no
   *  sentinel range is ever stored). Absent on an old record or one submitted before a range was set. */
  range?: string;
  findings: ReviewFinding[];
  submittedAt: string;
}

/** SPEC-SKILLS-GATE — one loop-green gate attestation, persisted per (missionId, gateId) in
 *  ~/.ct/config/gate-evidence.json. A resubmit REPLACES the prior record with a fresh id (the
 *  ReviewRecord semantics): the newest attestation is the honest current one, so a later 'fail'
 *  overwrites an earlier 'pass'. The completion evaluator judges freshness on PHASE-STRUCTURE IDENTITY
 *  (the submitting sortie's phase index vs the last code-change phase), NEVER on submittedAt — a
 *  backward clock must not fake fresh evidence. Same trust class as a ReviewFinding (agent-authored
 *  text surfaced to the operator), so the store caps every string. */
export interface GateEvidenceRecord {
  id: string;
  /** Server-derived from token→terminal→loop→sortie; NEVER read from a request body. */
  missionId: string;
  /** The SUBMITTING sortie — the identity axis the staleness check keys on. */
  sortieId: string;
  /** Which frozen loop.requiredGates entry this attests (a plain skill id). */
  gateId: string;
  /** The sortie's phase round, server-derived — informational (report/history). */
  round?: number;
  /** `<baseSha>..HEAD` at submit when the mission had a base commit — informational. */
  range?: string;
  status: 'pass' | 'fail';
  /** Bounded attestation text, surfaced (truncated) in a blocked loop's stopReason. */
  summary?: string;
  submittedAt: string;
}

/** SPEC-RESEARCH W9 — one opaque citation on a research finding. `ref` is a URL, a file path, or a
 *  free-text pointer; the Tower NEVER fetches or resolves it (⟦DEC-2⟧). Fetching agent-authored URLs
 *  from the control plane would be an SSRF surface, and the Tower makes no outbound request on any
 *  agent-submitted data today — that property is kept. */
export interface ResearchCitation {
  ref: string;
  note?: string;
}

/**
 * SPEC-RESEARCH W9 — one research sortie's submitted finding, persisted per (missionId, sortieId).
 * A resubmit REPLACES the prior record with a fresh id (⟦DEC-1⟧, the ReviewRecord semantics): the
 * newest submission is the honest current finding, and the in-place retry of a landed research sortie
 * depends on resubmission meaning something. Same trust class as a ReviewFinding — agent-authored text
 * fed (bounded) into other agents' prompts — so the store caps every string.
 */
export interface ResearchRecord {
  id: string;
  /** Server-derived from token→terminal→loop→sortie; NEVER read from the request body. */
  missionId: string;
  sortieId: string;
  /** The sortie's phase round, server-derived; absent on authored (non-round) phases. */
  round?: number;
  topic: string;
  /** The finding body — the payload. */
  summary: string;
  citations?: ResearchCitation[];
  submittedAt: string;
}

/** SPEC-TESTING §4 — a project's per-codebase e2e testing config (~/.ct/config/testing.json). NOT
 *  provider/model (that is routing) — the deterministic suite invocation + gate + phase toggles. */
export interface ProjectTestingConfig {
  /** The project's e2e invocation — the `towerctl test run` default and the runner-sortie checkCommand
   *  prefill. Executed by the agent's own shell (same trust class as checkCommand); never sanitized. */
  suiteCommand?: string;
  /** The regression-gate suite (Mission.gateSuite) composer prefill. */
  gateSuite?: string;
  /** When on, the verify template appends a documentor phase (SPEC-TESTING §3). */
  docsPhase?: boolean;
  /** When on, a non-gate run's failures auto-file to the backlog at release (SPEC-TESTING §5). Default off. */
  autoFileFailures?: boolean;
  /** SPEC-LOOP W5 — release-time server/docker log sources captured (bounded, tail-only) when a run
   *  produces parsed results. Each entry is a repo-relative FILE or a one-level DIR (its files are
   *  scanned, no recursion), trimmed to 1..300 chars; at most 12 entries. Opt-in per project; the
   *  captured file names land on `TestRun.logs`, downloadable through the guarded logs route. */
  logSources?: string[];
  /** SPEC-LOOP W5 — also capture `docker compose logs` (tail) from the project's worktree at release.
   *  Opt-in; the partial output is salvaged on a maxBuffer/timeout overrun. */
  captureDocker?: boolean;
}

/** What parsePlaywrightResults returns over one run's results.json (SPEC-STORYLOOP §2.1). */
export interface ParsedRun {
  failures: TestFailure[];
  ran: string[];   // every non-skipped spec's normalized repo-relative path (deduped)
  total: number;
  failed: number;
}

// ---- Global admin settings (Settings view) ----

/** Operator-level Tower settings, persisted in ~/.ct/config/settings.json. */
export interface GlobalSettings {
  /** Max concurrent test-kit slots. Absent = env CT_TEST_MAX_SLOTS, else 8. Clamped [1,64]. */
  testMaxSlots?: number;
  /** SPEC-TERMINAL-OPS §3.1 — max LIVE terminals across the Tower. Absent = 12. Clamped [1,128]. */
  maxTerminals?: number;
  /** SPEC-TERMINAL-OPS §4.3 — how long a mission-spawned terminal of a truly-finished mission is kept
   *  before its pane is reaped. Absent = 24. Clamped [1,720]. */
  terminalReapHours?: number;
}

/** GET/PATCH /api/settings response: the stored settings plus the resolved effective caps. */
export interface GlobalSettingsView extends GlobalSettings {
  effectiveTestMaxSlots: number;
  effectiveMaxTerminals: number;
  effectiveTerminalReapHours: number;
}

// ---- Onboard assistant ("Jarvis") — FROZEN CONTRACT ----
// v1: the brain is the Codex CLI on the operator's ChatGPT subscription (mode 'cli',
// provider 'codex'). The interface is provider-agnostic so an API-key path can slot in later.

/** An assistant "brain" account: which provider/mode + the underlying logged-in profile. */
export interface AssistantAccount {
  id: string;
  mode: 'cli'; // v1: run the vendor's official CLI headlessly
  provider: 'codex'; // v1: Codex only
  /** The AgentProfile (isolated config dir) that holds the CLI's subscription login. */
  profileId: string;
  /** Pinned model slug (e.g. "gpt-5.5"); undefined = provider default. */
  model?: string;
  /** SPEC-EFFORT §5 — the Brain's reasoning effort (codex-only), pinned into the profile's config.toml
   *  per turn; undefined = codex's own default (no line written). */
  effort?: string;
  /** Operator override: run even when the OS sandbox can't be verified (accepts real risk). */
  allowNoSandbox?: boolean;
  /** Per-turn deadline in seconds before the codex run is killed; undefined = default (300). */
  turnTimeoutSec?: number;
  /** Operator opt-in: the Tower auto-confirms this account's proposals server-side, skipping
   *  the human Confirm click. undefined/false = the confirm gate is live (the default). */
  autoConfirm?: boolean;
  createdAt: string;
}

/** One turn in a conversation transcript (persisted JSONL). `system` is a Tower-authored note —
 *  e.g. the outcome of a confirmed proposal (SPEC-ASSISTANT-CONTROL ⟦DP-J6⟧) — that the stateless
 *  codex brain replays as context on its next turn (rendered "System: …" by buildPrompt). */
export interface AssistantTurn {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: string;
  /** Reasoning summary shown in the bubble's thinking block. NEVER replayed to the brain —
   *  buildPrompt (codex-provider.ts) renders only `.text`, so this is excluded automatically.
   *  A turn may carry thinking with an empty `text` (a trailing thinking-only bubble). */
  thinking?: string;
  /** Names of the tool calls that COMPLETED before this bubble's message — enough to
   *  re-render the "· consulted X" chips on reload. Args/results are deliberately not stored. */
  tools?: string[];
}

// ---- Jarvis control surface (SPEC-ASSISTANT-CONTROL, M-A3) — FROZEN ----

/** A typed, Tower-VALIDATED mutation the assistant PROPOSES; the operator confirms the exact
 *  resolved args before it runs (§3). The discriminated union IS the whole write surface — a
 *  capability absent here cannot be proposed (⟦DP-J5⟧ hard-never). */
export type AssistantAction =
  | { kind: 'create_profile'; provider: 'codex' | 'claude-code' | 'gemini-cli' | 'hermes'; label: string }
  | { kind: 'open_login'; profileId: string }
  // set_routing with projectId targets that project's routing overlay (SPEC-ROUTING §5)
  // instead of the global defaults; set_project_workflow selects a named WorkflowProfile
  // as a project's routing bundle.
  // SPEC-TESTING-V2 §4 — `profileId` routes the role to a specific logged-in account of `provider`.
  // Validated at enrich time (exists / provider-matches / NOT the assistant Brain) so a bad or reserved
  // account fails at propose with a self-correctable 400; omitting it clears the role's account.
  | { kind: 'set_routing'; role: PipelineRole; provider: ProviderId; model?: string; effort?: string; profileId?: string; projectId?: string }
  | { kind: 'set_project_workflow'; projectId: string; workflowId: string }
  | { kind: 'create_task'; projectId: string; title: string; body?: string; priority?: 0 | 1 | 2 | 3; status?: 'triage' | 'todo' | 'ready' }
  | { kind: 'update_task'; taskId: string; title?: string; body?: string; priority?: 0 | 1 | 2 | 3 | null; status?: TaskStatus }
  | { kind: 'clear_finished' }
  // `profileId` pins the loop to a specific signed-in account (validated at enrich: exists /
  // provider-matches / not the Brain / actually signed in — a loop that would resolve to a
  // credential-less account is refused at propose with the signed-in alternatives named).
  | { kind: 'create_loop'; projectId: string; name: string; task: string; provider?: ProviderId; model?: string; effort?: string; maxIterations?: number; gatePolicy?: GatePolicy; checkCommand?: string; profileId?: string }
  // Registers an EXISTING git repo as a project. Carries no scaffoldMode (vestigial — no reader in
  // src/server, and an invalid value fails the whole ProjectSchema parse, dropping the record on
  // reload) and no isolation (⟦DP-J5⟧ hard-never). A project decides WHERE agents may ever run, so it
  // always waits for a human confirm — see requiresHumanConfirm (assistant/actions.ts). repoUrl (metadata)
  // and defaultIdentityId (the push/authorship identity) are optional per-project GitHub config.
  | { kind: 'create_project'; name: string; repoPath: string; repoUrl?: string; defaultIdentityId?: string }
  // Sets an EXISTING project's GitHub config: repoUrl and/or defaultIdentityId (null/'' clears one). Does
  // NOT widen where agents run (⟦DP-J5⟧) — it only repoints which stored identity a project pushes as, all
  // enrich-validated; risk 'low'.
  | { kind: 'set_project_github'; projectId: string; repoUrl?: string | null; defaultIdentityId?: string | null }
  // Initialize-and-push a registered project directory that is NOT yet a git repo (SPEC-INITPUSH):
  // inspect the tree, generate/merge a stack .gitignore, create .local-context/ (kept local), commit,
  // and push the first commit to the project's stored repoUrl as its default identity. Outward push +
  // filesystem write — like create_project it ALWAYS waits for a human confirm (reasonForHumanConfirm).
  | { kind: 'init_project_repo'; projectId: string }
  // One-step bootstrap (create_project + init_project_repo composed): register a BARE folder (no .git)
  // as a project AND run the SAME SPEC-INITPUSH bootstrap init_project_repo uses. Registration happens
  // ONLY if the bootstrap reaches its commit — a refusal/failure registers no project. Outward push +
  // filesystem write + widens where agents run: ALWAYS waits for a human confirm.
  | { kind: 'bootstrap_project'; name: string; repoPath: string; repoUrl: string; defaultIdentityId: string }
  // Arm/disarm a project's "Autonomous (skip permissions)" default (defaultAutoAccept) — the same
  // flag as POST /api/projects/:id/auto-accept. Removes/restores the per-command permission gate for
  // future claude-code WORK spawns in the project, so like create_project it ALWAYS waits for a human
  // confirm (reasonForHumanConfirm) — the assistant may PROPOSE autonomy, but only the operator enacts it.
  | { kind: 'set_project_autonomy'; projectId: string; enabled: boolean }
  // Enable/disable a skill in the shared library (POST /api/skills/:id/enabled). A skill's instructions
  // materialize into EVERY future agent, so like set_project_autonomy this ALWAYS waits for a human
  // confirm (reasonForHumanConfirm). A protected skill (protected===true or a blocking gate) can never be
  // proposed here — enrich refuses it, the reserved-account clone keyed on protection.
  | { kind: 'set_skill_enabled'; skillId: string; enabled: boolean }
  // REPLACE a project's skill overlay (PUT /api/projects/:id/skills): a selected bundle and/or ATOMIC
  // per-skill on/off overrides (the whole overlay, not a patch). Changes which skill instructions reach
  // this project's future agents, so it too ALWAYS waits for a human confirm. bundleId null/absent + empty
  // enable clears back to the global set; turning OFF a protected skill via the enable map is refused.
  | { kind: 'set_project_skills'; projectId: string; bundleId?: string | null; enable?: Record<string, boolean> }
  // Publish an assistant DRAFT (the inert SkillDraft pad) into the shared library: create a new skill,
  // or update an assistant-origin one (the draft's targetSkillId). ALWAYS waits for a human confirm
  // (reasonForHumanConfirm) — the body is LLM-authored instructions reaching every future agent. The
  // contentHash arg pins the exact reviewed draft: it rides the ACTION (not just the denorm), so even
  // an Edit override re-validates against the live draft, and the promote route re-verifies it
  // synchronously. Every promote — create AND update — lands enabled:false (SPEC-SKILLS Phase 5b).
  | { kind: 'promote_skill'; draftId: string; contentHash: string }
  // SPEC-RESTART Wave 1 (SPEC-ASSISTANT-CONTROL §3.2 addendum — the create_project precedent): close
  // (kill) or restart a terminal. A DELIBERATE amendment to the ⟦DP-J5⟧ hard-never list: terminal KILL
  // moves from hard-never into the catalog as close_terminal, and restart targets Wave 0's in-place
  // respawn route; terminal SPAWN and land stay hard-never. Both kinds ALWAYS wait for a human confirm
  // (reasonForHumanConfirm — even in autonomous mode): one destroys a live agent pane and FAILS any
  // loop bound to it, the other discards an in-flight turn. Enrich refuses a login pane (possibly
  // mid-auth), a mission planner pane (the mission tick owns that lifecycle), and any terminal on a
  // reserved Brain account; a loop-bound builder is allowed with the consequence stated on the card.
  | { kind: 'close_terminal'; terminalId: string }
  | { kind: 'update_provider_cli'; provider: 'claude-code' | 'codex' | 'gemini-cli' }
  | { kind: 'restart_terminal'; terminalId: string };

/** 'executing' is the synchronous compare-and-set claim taken BEFORE the executor's await so a
 *  double-confirm can't run twice; 'failed' also covers a drift-abort at confirm. */
export type ProposalStatus = 'pending' | 'executing' | 'rejected' | 'expired' | 'executed' | 'failed';

/** A recorded proposal awaiting the operator's Confirm. `action` is the Tower-validated typed
 *  action (never the model's prose); `summary` is a Tower-templated, control/bidi-sanitized
 *  one-liner; the card renders `action`'s exact args, not `summary`. */
export interface AssistantProposal {
  id: string;
  conversationId: string;
  action: AssistantAction;
  /** What actually ran if the operator Edited the args before confirming (same kind, re-validated). */
  finalAction?: AssistantAction;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
  /** Trimmed route response on success. */
  result?: unknown;
  /** Validation / route / drift error on failure. */
  error?: string;
  /** True when the Tower confirmed this proposal itself (autonomous mode) — the dock and the
   *  audit trail must never pass an auto-run off as a human Confirm click. */
  autoConfirmed?: boolean;
}

export interface AssistantConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Normalized streaming event from a turn — the ONE shape the routes SSE-frame and the web
 * dock consumes, regardless of provider. Each event is sent as one `data: <json>\n\n` line
 * on the POST /api/assistant/message event-stream response.
 *  - text:     assistant answer text (may arrive whole on completion for `codex exec --json`).
 *  - thinking: reasoning/progress text (optional to render).
 *  - tool:     an MCP/tower-control tool call the brain made (read-only in M-A1).
 *  - done:     the turn finished; carries token usage if known.
 *  - error:    the turn failed; `kind` classifies it for a first-class dock state.
 */
export type AssistantEvent =
  | { t: 'text'; delta: string }
  | { t: 'thinking'; delta: string }
  | { t: 'tool'; id: string; name: string; args: unknown; status: 'started' | 'completed'; result?: unknown }
  // A proposed mutation awaiting the operator's Confirm (SPEC-ASSISTANT-CONTROL §4); forwarded
  // live into the open turn stream when the brain calls propose_action.
  | { t: 'proposal'; proposal: AssistantProposal }
  | { t: 'done'; stopReason: 'end' | 'error'; usage?: { inputTokens?: number; outputTokens?: number } }
  | { t: 'error'; error: string; kind: 'quota' | 'auth' | 'sandbox' | 'other' };

/** Resolved, honest per-project isolation status (intent reconciled with host capability). */
export interface ProjectSecurity {
  projectId: string;
  /** The operator's intent for this project. */
  intent: 'per-agent-uid' | 'single-uid';
  /** What is actually in force right now (never claims a boundary that isn't enforced). */
  effective: 'per-agent-uid' | 'single-uid';
  /** Whether per-agent execution is actually enforced (agents spawned under a separate UID). */
  enforced: boolean;
  /** Whether the host has been provisioned so per-agent isolation CAN be turned on. */
  available: boolean;
  egressControl: boolean;
  brokerActive: boolean;
  /** Plain-language residual risk when effective mode is single-uid; null when isolated. */
  residualRisk: string | null;
  /** The one-time privileged command that unlocks per-agent isolation, when unavailable. */
  setupCommand?: string;
}

// ---- Project files (SPEC-FILES §6) — browse/view/preview a project repo or a loop worktree ----
export interface FileEntry {
  name: string;
  type: 'dir' | 'file' | 'symlink' | 'other';
  size?: number;
  mtime?: string;
  /** A symlink whose target is missing. */
  broken?: true;
  /** node_modules/dist/coverage etc. — the web de-emphasizes these. */
  heavy?: boolean;
}
/** One directory listing (lazy — no recursion). `root` says whether it's the repo or a worktree. */
export interface FileListing {
  root: 'repo' | 'worktree';
  rootLabel: string;
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}
/** One file's contents. Text inline (utf8, truncated at the cap); small image base64; other/oversized
 *  binary → encoding:'none' + empty content (client offers download via the raw route). */
export interface FileContent {
  path: string;
  size: number;
  mtime: string;
  binary: boolean;
  truncated: boolean;
  encoding: 'utf8' | 'base64' | 'none';
  content: string;
  mime?: string;
}
/** POST /api/projects/:id/preview → a short-lived capability URL for the sandboxed artifact preview. */
export interface PreviewMintResponse {
  previewId: string;
  url: string;
  expiresAt: string;
}
