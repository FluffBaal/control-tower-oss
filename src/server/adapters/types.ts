// Agent adapter interface (SPEC D3/§6). One implementation per CLI. An "agent" to
// the Tower is: how to isolate its account (config-dir env), how to launch it, how
// to wire its hooks to the Tower, how to approve/deny its permission prompts, and —
// because Gemini has no idle event — how to read its state from the screen.

import type { HookSignal, ProviderId, Terminal, WireHookSignal } from '../../shared/types.js';

export interface LaunchContext {
  terminalId: string;
  projectId: string;
  cwd: string;
  /** The project's MAIN repo root. cwd may be a linked worktree; providers that key
   *  trust/config by repository root (codex) need the root, not the worktree path. */
  repoPath: string;
  /** Absolute path to the 0600 file holding this terminal's hook token. */
  hookTokenFile: string;
  /** Absolute path to the ct-hook script the CLI's hooks should invoke. */
  hookScript: string;
  /** Tower port, so the hook can reach /api/events. */
  towerPort: number;
  /** Absolute spool dir root for offline hook events. */
  spoolDir: string;
  /** Config dir isolating this terminal's provider account (M4 uses real accounts). */
  configDir: string;
  /**
   * SPEC-RUNWAY — when set, install a Claude Code `statusLine` pointing at ct-usage so the pane
   * forwards its rate_limits to the Tower (proactive usage detection). Set ONLY for a claude-code,
   * non-login spawn while Runway is enabled; absent otherwise (and writeHookConfig then REMOVES a
   * previously-Tower-written statusLine, leaving a foreign one alone).
   */
  usageLine?: { command: string; refreshInterval: number };
  /** SPEC-RUNWAY — when true, set Claude Code's autoContinueAtUsageLimit so a walled pane waits for the
   *  soonest reset in-session (the exhausted-pool fallback) rather than erroring. Rides usageLine. */
  autoContinueAtUsageLimit?: boolean;
  /**
   * Resolved model slug. For a custom provider it interpolates {{model}} in
   * buildCommand; for the built-in adapters (codex/claude/gemini) it rides the spawn as an
   * explicit model flag (codex `-m`, claude `--model`, gemini `-m`) — see each adapter's
   * buildCommand. Threaded from resolveRouting → CreateTerminalOpts → here. Undefined when the
   * route configures no model. Allowlist-gated by the isValidModelId hoist (routing.ts)
   * before it reaches argv.
   */
  model?: string;
  /**
   * SPEC-EFFORT §3 Resolved reasoning effort. For the built-in adapters it rides the spawn as a
   * separate argv token (codex `-c model_reasoning_effort=<v>`, claude `--effort <v>`) — see each
   * adapter's buildCommand. Threaded from resolveRouting → CreateTerminalOpts → here. Undefined when
   * the route sets none (the CLI's own default — no imposed value). Per-provider gated by the
   * isValidEffort hoist in routing.ts before it reaches argv; gemini/custom never resolve one.
   */
  effort?: string;
  /** Launch the CLI in its OWN skip-permissions mode. Resolved WORK-only in createTerminal
   *  (never login — with no loginCommand, buildCommand IS the login argv (server.ts built-in
   *  login route) — and never planner). Threading only, like model/effort. claude maps it to
   *  `--dangerously-skip-permissions` in buildCommand ONLY, never headlessCommand; codex
   *  (`--dangerously-bypass-approvals-and-sandbox`) and gemini (`--yolo`) can map the same
   *  signal later behind supportsAutoAccept. */
  skipPermissions?: boolean;
  /** Terminal purpose, threaded from createTerminal like model/effort (absent = 'work', the
   *  Terminal-record convention). claude keys its first-run onboarding seed on it in writeHookConfig:
   *  work AND planner spawns (both driven programmatically) are seeded past the CLI's interactive
   *  wizard; only a login pane keeps the fully interactive first-run flow. */
  purpose?: Terminal['purpose'];
  /**
   * SPEC-RESTART — threading-only: which claude-code session action this launch binds to, mint a
   * fresh conversation ('new', createTerminal) or resume an existing one ('resume', a restart onto
   * a transcript that still exists). claude's buildCommand maps this to `--session-id <id>` /
   * `--resume <id>`; every other adapter ignores it. Absent ⇒ no session flag (headlessCommand, and
   * every non-claude provider, never resolve one).
   */
  session?: { kind: 'new' | 'resume'; id: string };
}

/** A CLI hook registration: which provider event maps to which wire signal. The widened type
 *  exists for the built-in claude split of agent_needs_input ('agent-question') from idle_prompt
 *  ('needs-input'). Custom ProviderDef BINDING metadata stays canonical-only (its zod enum in
 *  store.ts) — but that pins only the metadata: a custom def's hookConfig.template is a free
 *  string, so an operator-authored template CAN put 'agent-question' on the wire and the route
 *  accepts it. Accepted as fail-safe: custom defs are operator-authored (trusted config), the
 *  route is per-terminal-token-gated, and the only reachable effect is a blocked-question hold —
 *  one card too many, the direction the veto already fails toward. The veto is a noise filter,
 *  never a security boundary. */
export interface HookBinding {
  /** The provider's own event/matcher name (for reference/logging). */
  providerEvent: string;
  signal: WireHookSignal;
}

export interface AgentAdapter {
  id: ProviderId;
  displayName: string;

  /** NON-SECRET env injected into the tmux session (config-dir isolation, hook wiring). */
  buildEnv(ctx: LaunchContext): Record<string, string>;

  /** argv to launch the CLI interactively inside tmux. */
  buildCommand(ctx: LaunchContext): string[];

  /** argv for a one-shot headless run (used by future automation). Receives ctx so it can
   *  bind ctx.model as a model flag, mirroring buildCommand. */
  headlessCommand?(ctx: LaunchContext, prompt: string): string[];

  /**
   * Write the CLI's hook config into its (per-profile) config dir so lifecycle
   * events invoke the ct-hook script with the mapped canonical signal. Idempotent,
   * merge-not-replace. Returns the bindings it installed (for logging/tests).
   */
  writeHookConfig(ctx: LaunchContext): Promise<HookBinding[]>;

  /**
   * Keystrokes to approve or deny a pending permission prompt, per this CLI's TUI.
   * Version-pinned; the queue renders the request before these are used.
   */
  approveKeys(): { approve: string[]; deny: string[] };

  /**
   * Fallback state detection from a capture-pane snapshot. REQUIRED for Gemini
   * (no idle hook) and used to self-heal lost hook events for all providers.
   * Returns null when the screen is inconclusive.
   */
  parseState(snapshot: string): HookSignal | null;

  /**
   * SPEC-SUBMIT §2.1 — composer classification from a VISIBLE-screen plain snapshot (no scrollback,
   * no escapes).
   *   true      = the input composer affirmatively holds un-submitted text.
   *   false     = the composer is affirmatively empty (or the CLI is visibly mid-turn — submitted).
   *   undefined = inconclusive (alt screen, dialog, unrecognized frame, a known ambiguity).
   * Consumed by tmux.sendTextVerified (⟦SB-2..4⟧), the loops NO_START belt, and maybeNudge's
   * non-empty-composer veto. Absent (custom defs, shell) ⇒ the send path DEGRADES to a blind send
   * with an audit flag — never a silent degradation (the pollsToIdle posture).
   *
   * Version-pinned like approveKeys, against the live-captured submit pins. A wrong `true` on an
   * idle composer is the one unacceptable error (⟦DEC-8⟧): it would refuse every send as
   * foreign-text and gate a healthy fleet, so prefer `undefined` under ANY doubt — a wrong
   * `undefined` only degrades to today's blind send. Implementations must be `this`-free
   * (object-literal adapters).
   */
  composerPending?(visibleSnapshot: string): boolean | undefined;

  /**
   * SPEC-SUBMIT §2.1 — the composer's TEXT BODY from the same visible snapshot, or undefined when
   * the region cannot be identified (alt screen, dialog, unrecognized frame, or an adapter that
   * cannot locate its composer at all).
   *
   * This exists so "is our text sitting un-submitted?" can be asked of the COMPOSER rather than of
   * the whole screen. A whole-screen search answers a different question — the visible screen also
   * carries the ECHO of prompts already submitted, so a loop re-sending an identical prompt would
   * match its own echo and read a swallowed send as delivered. Implementations must be `this`-free.
   */
  composerText?(visibleSnapshot: string): string | undefined;

  /**
   * SPEC-CLEARANCE §A — screen veto for a needs-input hook hold, tri-state like composerPending:
   *   false     = the screen is AFFIRMATIVELY idle — the composer is present AND empty, and no
   *               question affordance (selector/menu rows, a "Do you want" line, a dialog frame)
   *               is visible above it. The caller may suppress the hold.
   *   true      = a question/menu affordance IS visibly present — the hold is real.
   *   undefined = inconclusive (alt screen, welcome banner, mid-turn, capture failure, an
   *               unrecognized frame) → the caller HONORS the hook.
   * Only an affirmative `false` ever suppresses: the phantom-idle-hold fix must fail toward
   * SHOWING a card, never toward hiding a real question. Both terms of the false branch are
   * load-bearing — an empty composer alone also describes a dialog that keeps its composer
   * rendered. Implementations must be `this`-free (object-literal adapters).
   */
  questionPending?(visibleSnapshot: string): boolean | undefined;

  /**
   * SPEC-CLEARANCE §B — the operator-facing content of an attention card, extracted from a pane
   * snapshot: `message` = the agent's actual question / last transcript block (clipped ~200 chars),
   * `preview` = context lines with the CLI's own chrome (composer, status footer, input box)
   * stripped. Returns undefined — or an object with either field absent — when the frame isn't
   * recognized; the caller then keeps its raw-preview fallback. Consulted for kind==='question'
   * cards ONLY; the permission-card path never calls this. Implementations must be `this`-free.
   */
  describeAttention?(snapshot: string): { message?: string; preview?: string[] } | undefined;

  /**
   * SPEC-SUBMIT ⟦DEC-2⟧ — true when this CLI emits a real signal on prompt SUBMIT (claude's
   * UserPromptSubmit hook, verified firing for a tmux-injected submit — pins C1).
   *
   * Gates the went-working tie-break. For every other provider the poller promotes 'working' from a
   * screen CHANGE alone (poller.ts) — including the render of the text the Tower just typed — so a
   * 'working' state there is not evidence that anything was submitted, and using it as a tie-break
   * would manufacture a 'verified' out of our own keystrokes. Absent = no submit signal.
   */
  signalsSubmit?: boolean;

  /**
   * True when this adapter maps LaunchContext.skipPermissions to the CLI's own permission-bypass
   * flag. Gates BOTH the create route's 400 (an explicit autoAccept on an unsupporting provider is
   * refused, never silently dropped) and resolveAutoAccept (an inherited project default resolves
   * to OFF for unsupporting providers — the terminal keeps the hook-based Clearance gate). Wave 1:
   * claude-code only.
   */
  supportsAutoAccept?: boolean;

  /**
   * Strip volatile TUI chrome (cycling placeholder hints, status footers, spinners' frames)
   * from a pane snapshot BEFORE the poller hashes it for output-change detection. Without
   * this, an idle CLI that animates its own chrome (codex ≥0.14x cycles composer hints)
   * reads as "output changed" on every poll and is pinned to 'working' forever, clobbering
   * the hook-driven idle. Optional: providers whose idle screen is static omit it.
   */
  normalizeSnapshot?(snapshot: string): string;

  /**
   * How many descendant processes this CLI keeps ALIVE while idle. codex ≥0.14x: 1 — its
   * npm wrapper holds the vendored binary as a permanent child, so a bare "has children"
   * check reads an idle codex as forever-working (verified live 2026-07-06; it pinned the
   * poller AND the loop runner's idle dwell). Absent = 0-style legacy direct-child check.
   */
  persistentIdleChildren?: number;

  /**
   * When false, the poller must NOT promote 'working' from a screen-content change alone —
   * only from live pane children (a real tool running) or a parse/hook signal. For CLIs
   * whose TUI animates while idle (codex ≥0.14x re-paints even normalized content), the
   * change heuristic is structurally unreliable; their work truth is hooks + children.
   * Default (absent) = true, preserving the existing behavior for other providers.
   */
  screenChangeImpliesWork?: boolean;

  /**
   * ⟦DP-5⟧ When true, the poller may demote this provider to idle by output-quiescence even
   * without a hook or a 'turn-done' parse — the reliability hinge for custom providers with no
   * idle hook (synthesized true for tiers B and C, and by the tombstone adapter). Absent
   * (built-ins) = false: they idle only via their own Stop hook. The one adapter-surface
   * addition SPEC-PROVIDERS introduces.
   */
  pollsToIdle?: boolean;
}
