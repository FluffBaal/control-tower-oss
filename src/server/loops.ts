// Loop engineering (the headline capability): an iterate-until-done cycle. A loop owns
// ONE builder terminal (an agent CLI in a fresh worktree) and drives it across N
// iterations. Each iteration: inject the task prompt (+ prior feedback) → wait for the
// agent to finish its turn → run an optional check command → auto-commit the iteration →
// decide (gate to the human, iterate again, or stop).
//
// Turn-completion is NOT re-derived here: the builder is a normal terminal, so the
// existing Mission FSM + poller already maintain its state (working / idle / blocked).
// The runner observes store.getTerminal(id).state — reusing every hook/idle signal the
// rest of the Tower already earns — but with a dwell + active-children check so a
// briefly-quiet agent (e.g. gemini mid-thought) isn't mistaken for done. A blocked
// iteration (agent asks a question / needs permission) surfaces in the normal attention
// queue; the loop waits, and never injects into an open dialog.
//
// Correctness invariants that the review of the first cut established:
//  - Every store mutation re-reads the loop first (never rebuilds `iterations` from a
//    stale in-memory snapshot) so a completed iteration's verdict/diff/note survives.
//  - After the long commit+check awaits, the loop's status is re-read before any status
//    decision, so a human stop/pause during that window is never clobbered.
//  - A long check for one loop runs detached (busy-guarded), so it can't freeze others.
//  - Auto-commits carry the loop's GitHub identity, not the daemon's.

import { execFile } from 'node:child_process';
import type { Store } from './store.js';
import type { TerminalManager } from './terminal-manager.js';
import type { WorktreeManager } from './worktrees.js';
import type { Accounts } from './accounts.js';
import { shortId } from './ids.js';
import { audit } from './audit.js';
import { claudeBusyFooterOrSpinner } from './busy-markers.js';
import type { RotationPlan } from './runway/controller.js';
import * as git from './git.js';
import * as tmux from './tmux.js';
import { providerRegistry } from './providers/registry.js';
import type { Validator } from './validator.js';
import { resolveRouting, validateRoute } from './providers/routing.js';
import type { ProviderSecretLookup } from './providers/routing.js';
import type { TestRun } from './testkit.js';
import { ROLE_IDS } from '../shared/roles.js';
import { MEMORY_LOOP_FOOTER } from './memory-instruction.js';
import { paneAffirmativelyIdle } from './idle-evidence.js';
import type { Loop, LoopIteration, CreateLoopRequest, ContractAssertion, ValidatorRun, LayeredRoleRouting, TestFailure, ProviderId, Terminal } from '../shared/types.js';

/** Per-loop in-memory runner state (NOT persisted — reconstructed as 'launching' on load). */
interface Runtime {
  phase: 'launching' | 'await-start' | 'await-done';
  /** Epoch ms at/after which to inject the next prompt (launch/inter-iteration settle). */
  injectAt: number;
  /** Epoch ms the prompt was injected (0 = not yet). */
  injectedAt: number;
  sawWorking: boolean;
  /** Consecutive idle observations while awaiting turn completion (a stability dwell). */
  idleTicks: number;
  /** Feedback appended to the next prompt (check failure tail or a gate note). */
  feedback?: string;
  /** Epoch ms of the FIRST 'launching' deferral, whatever its cause — a pane still mid-turn ('working')
   *  OR a session too unresponsive to accept the send. BOTH causes share this one anchor deliberately:
   *  the bound belongs on "iteration n could not be injected", so a wait that changes cause is still
   *  bounded exactly once (never re-stamp it per-cause — that would reset the wait every retry and
   *  restore the silent stall). deferOrFault owns the stamp and the ceiling; 'launching' is RT-1-exempt
   *  (injectedAt 0), so without it a pane that never frees stalls the loop silently. Cleared on a
   *  successful injection and on the resume re-arm. */
  deferSince?: number;
  /** SPEC-SUBMIT §4.2 — how many times the NO_START belt has re-pressed Enter for THIS injection.
   *  In-memory like the rest of Runtime (reconstructed on restart by design), and bounded by
   *  NO_START_REENTER_MAX so a composer that never submits reaches a human gate instead of being
   *  re-Entered forever. */
  reEnter?: number;
  /** SPEC-SUBMIT §4.2 — the normalized tail of the prompt THIS injection sent, so the belt can tell
   *  our un-submitted prompt from a human's draft before re-pressing Enter. In-memory with the rest
   *  of Runtime; a restart simply means the belt has nothing to prove ownership with and stands down. */
  sentTail?: string;
  /** First-turn spawn-latch belt (injectPrompt): the previous tick's normalized visible capture while
   *  idle evidence is gathered against a builder born 'working' that has never been injected (a freshly
   *  spawned built-in only demotes via its turn-done hook, which a never-driven builder can never fire).
   *  Bypassing the state latch requires the SAME normalized screen on two observations at least
   *  FIRST_INJECT_PROBE_GAP_MS apart, with every other check passing on the later one. Cleared on any
   *  failed check, on the decision itself, and on resume. */
  firstProbe?: string;
  /** Epoch ms firstProbe was captured — the stability pair must span FIRST_INJECT_PROBE_GAP_MS. */
  firstProbeAt?: number;
  /** SPEC-LOOPWEDGE F4 — epoch ms the CURRENT block (blocked-question / blocked-permission) began, so
   *  the human's answer latency can be credited back to injectedAt and excluded from the RT-1 ceiling.
   *  In-memory like the rest of Runtime; a restart re-derives it on the next blocked tick. */
  blockedSince?: number;
  /** SPEC-LOOPWEDGE F4 — the blocked state has been audited once for THIS block (dedup), so a long
   *  human stall is visible (D3) without one audit line per tick. Cleared when the block ends. */
  blockedAudited?: boolean;
  /** When set, run exactly one iteration then return to 'paused' (Step once). */
  stepOnce?: boolean;
  /** Operator asked to pause; honored after the in-flight iteration finishes. */
  pauseRequested?: boolean;
  /** SPEC-RUNWAY W3 — rotations performed at THIS iteration's launching boundary. A boundary rotate
   *  re-arms the SAME runtime (onTerminalRotated), so this accumulates within one iteration; a fresh
   *  runtime per iteration resets it. Capped (MAX_ROTATIONS_PER_ITER) so a pool where every account is
   *  over threshold can't ping-pong forever — past the cap the loop waits instead. */
  rotations?: number;
  /** SPEC-RUNWAY W3 — epoch ms the loop first found the pool exhausted (nothing to rotate to). Audited
   *  once, and the marker so the exhausted-wait isn't re-announced each tick. Cleared when a rotation
   *  becomes possible again or the iteration advances. */
  walledSince?: number;
  /** SPEC-SKILLS per-project delivery — the suppressed-brief belt already audited for this runtime
   *  (audit once, not once per re-sent iteration). In-memory like the rest of Runtime; a restart
   *  re-audits, which is correct — the condition would still hold. */
  briefSuppressedAudited?: boolean;
}

export interface LoopsDeps {
  store: Store;
  tm: TerminalManager;
  worktrees: WorktreeManager;
  accounts: Accounts;
  /** The acceptance judge (SPEC-FACTORY §1). Absent/unavailable + assertions → forced gate. */
  validator?: Validator;
  /** ⟦DP-7⟧ The custom-provider store — resolveRouting reads it for the def's defaultModel
   *  fallback, and validateRoute checks the resolved route (def exists, model present, auth) before
   *  the loop spawns. Absent → built-in-only routing (no defaultModel/def validation). */
  providerStore?: ProviderSecretLookup;
  /** SPEC-MODELS §4 — the account's live-discovered model ids for (provider, profileId), or undefined
   *  when no live catalog exists (curated aliases aren't ground truth). validateRoute uses it for a
   *  non-fatal "not in the discovered catalog" warning on the resolved built-in model. */
  knownModelIds?: (provider: ProviderId, profileId?: string) => string[] | undefined;
  /** SPEC-EFFORT §2 — the resolved codex MODEL's captured effort set for (provider, profileId, model),
   *  feeding validateRoute's non-fatal "not in this model's set" warning. Undefined for claude-code (the
   *  pinned enum is the hard gate) and for codex with no model (§0: the syntactic gate is all there is). */
  knownEfforts?: (provider: ProviderId, profileId?: string, model?: string) => string[] | undefined;
  /** ⟦§2.1⟧/SPEC-ROUTING §3 — the layered role routing (project overrides > selected workflow >
   *  global defaults), layered under a per-loop provider/model override. */
  routing?: { layersFor(projectId?: string): LayeredRoleRouting };
  /** SPEC-TESTING §1.4 — the assistant Brain's profile id(s), read AT RUNTIME. A loop request
   *  naming (or a role tier resolving to) one is refused at create. Absent → no reserved check. */
  reservedProfileIds?: () => ReadonlySet<string>;
  /** SPEC-RUNWAY W3 — usage-aware subscription rotation for the loop's builder. Optional (absent →
   *  rotation off, the default). `plan` decides at the iteration boundary; `rotate` performs it (the
   *  shared rotateAndFanOut); `overThreshold` gates a no-check pass so a usage wall can't bank a fake
   *  green. All keyed by the loop's builder terminalId. */
  runway?: {
    plan(terminalId: string): RotationPlan;
    rotate(terminalId: string, toProfileId: string): Promise<void>;
    overThreshold(terminalId: string): boolean;
    /** SPEC-RUNWAY live-swap -- true when the live-swap path is on AND this terminal has a slot, so the
     *  boundary rotation prefers `liveSwap` over the respawning `rotate`. Read at call time. */
    liveSwapReady?(terminalId: string): boolean;
    /** Swap the terminal's account IN PLACE (no respawn); the implementation owns retry / respawn-fallback /
     *  quarantine and rejects if the terminal was not moved. */
    liveSwap?(terminalId: string, toProfileId: string): Promise<void>;
  };
  /** Per-turn wall-clock ceiling (ms). Absent → TURN_WALL_CLOCK_MS. */
  turnTimeoutMs?: number;
  /**
   * SPEC-LOOPWEDGE — the cardinal-sin GUARD: whether the terminal's CURRENT idle was reached by
   * INFERENCE (F1's lost-hook harvest / F2's poller affirmative-idle backstop) rather than a real
   * completion hook. When completion was inferred AND the loop has no checkCommand AND gatePolicy is
   * 'never', finishIteration forces a gate instead of an autopilot 'done' — an inferred idle may NEVER
   * be the sole basis of an autopilot pass. Absent (unwired) → treated as a real idle (production
   * always wires it to the durable terminal.idleInferred flag).
   */
  wasIdleInferred?: (terminalId: string) => boolean;
  /**
   * SPEC-LOOP §2 — the per-terminal hook-token file path for a loop's builder terminal.
   * runCheck execs `bash -lc <checkCommand>` DAEMON-side, which inherits the daemon's env — with NO
   * per-terminal token, so every `towerctl` checkCommand (e.g. `towerctl test run`) exits 2 for lack
   * of auth. Injecting this file's path (via TOWER_HOOK_TOKEN_FILE) + towerPort lets the check
   * authenticate as its own terminal. Absent → the check runs with the daemon env (legacy behavior).
   */
  hookTokenFile?: (terminalId: string) => string;
  /** SPEC-LOOP §2 — the Tower's HTTP port, injected as TOWER_PORT so a `towerctl` check
   *  reaches the control-plane API. Absent → the hook script's built-in default is used. */
  towerPort?: number;
  /** ⟦STORYLOOP §2.3a⟧ Feed (a)/(b): the shared test kit (the Integrator injects the TestKit).
   *  After each iteration's check runs, the builder terminal's latest run supplies the structured
   *  e2e failure list threaded into the next-iteration feedback and the judge's grading context.
   *  `latestFor` already excludes gate runs (§0.1). Absent → the existing 12-line checkTail path
   *  is unchanged — both feeds are strictly additive. */
  testRuns?: { latestFor(terminalId: string): TestRun | undefined };
  /** SPEC-SKILLS per-project delivery: render the pointer-block brief for this project+provider —
   *  the per-project resolved skills that can NEVER ride the shared per-account configDir (a
   *  project-dependent sync there would shred another project's live skills). Injected from server.ts
   *  so this module stays skills-free. excludeUncleared MUST be true for a skip-permissions builder —
   *  the autonomy-clearance invariant's brief-channel leg. Absent → loops run brief-less (tests
   *  unaffected). counts ride the audit line only, never contents. */
  skillBrief?: (args: { projectId: string; provider: ProviderId; excludeUncleared: boolean }) =>
    { text: string | undefined; hasUncleared: boolean; counts?: Record<string, number>; assistantIds?: string[] } | undefined;
  /** SPEC-SKILLS per-project delivery — live clearance re-check for a bypass loop's brief. The brief
   *  is a by-id LIVE pointer, so a mid-loop content edit / promote / rollback that DROPS a cleared
   *  assistant skill's clearance (the hash-keyed reset) would otherwise keep pointing a
   *  skip-permissions agent at now-uncleared content, and the frozen create-time flag can't catch it.
   *  Returns true iff EVERY id is still a current store skill with origin 'assistant' AND
   *  autonomyCleared === true; a missing (deleted/recreated) or drifted id returns false. Absent → the
   *  inject-time re-check fails CLOSED (suppresses). */
  briefAssistantSkillsCleared?: (ids: string[]) => boolean;
  /** Push a loop-state SSE frame to dashboards. */
  onUpdate: (loop: Loop) => void;
  /** ⟦DP-B5⟧ Optional backlog bridge. When a loop's landedAt is NEWLY set (a successful land),
   *  the patch() choke point fires onExecutionDone so a linked backlog task auto-archives.
   *  NEVER fired on bare status 'done' — a done-unlanded loop is a live Gate card, not success.
   *  Absent → no backlog wiring. Fire-and-forget: a backlog failure never breaks a land. */
  backlog?: { onExecutionDone(ref: { missionId?: string; loopId?: string }): void };
  /** SPEC-MEMORY — the project-memory briefing channel + the run-scoped integration boundary. Injected
   *  from server.ts (the skillBrief seam's shape) so this module stays memory-store-free. `briefing`
   *  renders the bounded block for one injection: `full` = the ranked active set (first briefing, or a
   *  respawned pane whose context is gone), `delta` = changes since the loop's persisted cursor. Its
   *  `toSeq` is what the composer EVALUATED — the caller's next cursor — and `delivered` names only
   *  the entries whose line is IN `text`. `onIntegration` fires once from the patch() choke point when
   *  a loop lands (its run-scoped entries become 'landed') or ends stopped/failed unlanded
   *  ('abandoned'). Absent → loops compose byte-identical to a memory-less Tower and no cursor is
   *  ever written; counts only ride the audit line, never entry contents. */
  memory?: {
    briefing(a: { projectId: string; loopId: string; mode: 'full' | 'delta'; sinceSeq?: number }):
      { text?: string; delivered: { id: string; rev: number }[]; toSeq: number } | undefined;
    onIntegration(ref: { loopId: string; missionId?: string; sortieId?: string }, state: 'landed' | 'abandoned'): void;
  };
  /** Test seam for the verified send primitive — the ONE keystroke path out of injectPrompt. Absent →
   *  the real tmux.sendTextVerified (production never sets this). Lets a suite drive injectPrompt end to
   *  end with no pane and steer the outcome ('verified' / 'unverified' / a throw). */
  send?: typeof tmux.sendTextVerified;
}

const LAUNCH_SETTLE_MS = 2500; // let a freshly-spawned agent CLI reach its input prompt
const ITER_SETTLE_MS = 1200; // brief pause between iterations
// SPEC-RUNWAY W3 — cap boundary rotations per iteration so a pool where every account is over threshold
// can't ping-pong forever; past the cap the loop waits for the soonest reset instead.
const MAX_ROTATIONS_PER_ITER = 3;
const NO_START_FALLBACK_MS = 12_000; // if we never observe 'working', proceed once idle
// SPEC-SUBMIT §4.2 — how many times the belt may re-press Enter on a composer that still holds our
// prompt before the turn is faulted to a human gate. Bounded: an Enter that never takes is a real
// fault, not something to retry forever.
const NO_START_REENTER_MAX = 2;
const IDLE_DWELL = 2; // idle observations required before declaring the turn done
// The first-turn spawn-latch belt's stability window: the two matching captures must be at least
// this far apart. Below TICK_MS so consecutive runner ticks satisfy it, but enforced in code (not
// left to tick cadence) so no future caller can collapse the pair into a single instant.
const FIRST_INJECT_PROBE_GAP_MS = 1500;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const TICK_MS = 4000;
const TURN_WALL_CLOCK_MS = 30 * 60_000; // absolute per-turn ceiling BEHIND the quiescence floors
// SPEC-MEMORY — the agent progress note's byte ceiling (an operator-facing status line, not a report).
const PROGRESS_MAX_BYTES = 1024;

/**
 * SPEC-SKILLS per-project delivery — the ONE iteration-prompt assembly, extracted pure so tests
 * assert exact prompt bytes without a pane. Order: the task, then the frozen per-project skill brief
 * (re-sent every iteration deliberately — it survives a long session's context compaction, and the
 * send path stays branch-free), then the optional pre-composed project-memory BRIEFING block
 * (SPEC-MEMORY — the caller composes it from the store and the loop's cursor; this fn just places it,
 * and an absent block composes byte-identical to a memory-less Tower), then the standing
 * project-memory footer (SPEC-MEMADOPT), then the feedback line LAST (freshest steering, most
 * salient). The briefing sits BEFORE the footer on purpose: the last non-empty line of the prompt —
 * `tmux.ourTextTail`, the resubmit belt's ownership marker — is the footer or the feedback line either
 * way, so a briefing's presence never changes what the belt looks for. The footer is UNCONDITIONAL — a brief-less
 * loop no longer composes byte-identical to the pre-brief shape (a deliberate change, pinned in the
 * tests): it is a platform-standing instruction, not skill content, so the clearance belts below
 * never gate it and a suppressed brief still leaves the footer in place; per-iteration re-send is
 * the same compaction-survival rationale as the brief.
 *
 * The belt, two legs: (1) frozen-flag — a brief that carries uncleared assistant skills
 * (skillBriefUncleared) must never reach a skip-permissions pane. Unreachable today — a terminal's
 * autoAccept is resolved server-side at spawn and never patched, and a loop is never re-bound to
 * another terminal (onTerminalGone fails it) — but load-bearing the day anyone adds an autoAccept
 * toggle, a terminal re-bind, or hand-edits loops.json. (2) live drift — `forceSuppress`, computed by
 * the CALLER (injectPrompt, which has store access; this fn stays pure with no store read): the
 * brief's entries are by-id LIVE pointers, so a mid-loop edit/promote/rollback can drop a delivered
 * assistant skill's clearance after create froze the flag false. Either leg suppresses; the caller
 * audits a suppression rather than passing silently.
 */
export function composeIterationPrompt(
  loop: Loop,
  feedback: string | undefined,
  term?: Pick<Terminal, 'autoAccept'>,
  forceSuppress = false,
  memoryBlock?: string,
): { prompt: string; briefSuppressed: boolean } {
  const briefSuppressed =
    Boolean(loop.skillBrief) && (forceSuppress || (loop.skillBriefUncleared === true && term?.autoAccept === true));
  let prompt = loop.task;
  if (loop.skillBrief && !briefSuppressed) prompt += `\n\n${loop.skillBrief}`;
  if (memoryBlock) prompt += `\n\n${memoryBlock}`;
  prompt += `\n\n${MEMORY_LOOP_FOOTER}`;
  if (feedback) prompt += `\n\n[Control Tower · loop "${loop.name}" · iteration ${loop.iteration}] ${feedback}`;
  return { prompt, briefSuppressed };
}

export class Loops {
  private rt = new Map<string, Runtime>();
  /** Loops with a serialized long operation in flight: a detached finishIteration (incl. a possibly-long
   *  check) OR an in-progress land() merge. The tick skips a busy loop and land() refuses to start on
   *  one, so the two can't act on the same loop at once. */
  private busy = new Set<string>();
  /** SPEC-RESTART §3 — terminal ids whose pane was respawned IN PLACE and not yet driven since.
   *  A respawned built-in is BORN 'working' again (restartTerminal re-stamps the create-time
   *  latch) and only demotes via a turn-done hook a never-driven process can never fire — the
   *  exact spawn-latch shape the first-inject belt exists for, except the loop may now be at ANY
   *  iteration. While a terminal is in this set: (a) driveOne's runtime-lost restore branch
   *  re-arms rather than observing (there is no in-flight turn to observe — the respawn killed
   *  it), and (b) injectPrompt's spawn-latch belt may open past iteration 1, still gated on the
   *  same positive two-tick idle evidence. Consumed on the next successful injection into the
   *  pane; cleared by onTerminalGone. In-memory like rt — a Tower restart loses it, correctly:
   *  the panes it described were not respawned across THAT boundary. */
  private freshPanes = new Set<string>();
  /** SPEC-RESTART-RESUME — terminal ids whose most recent in-place respawn RESUMED the same claude-code
   *  conversation (onTerminalRestarted's `resumed: true`), rather than starting a fresh one. A member
   *  of freshPanes too (a resumed pane is still a brand-new process the belts must treat as fresh —
   *  see the class comment there), but its memory context did NOT die with the old process, so the
   *  memory-mode decision below must NOT force a full re-brief for it the way an ordinary respawn
   *  does. Consumed alongside freshPanes (the same successful-injection / onTerminalGone points);
   *  in-memory only, like freshPanes — a Tower restart between the respawn and the next injection
   *  loses this mark too, but by then the persisted cursor (kept, not cleared, for a resumed pane)
   *  already carries the truth, so the delta-vs-full decision stays correct either way. */
  private resumedPanes = new Set<string>();
  /** SPEC-RESTART §3 / SPEC-MEMORY — per-terminal count of in-place respawns seen by onTerminalRestarted.
   *  injectPrompt snapshots it BEFORE the awaited send and compares AFTER: a respawn that lands during
   *  the send has already cleared the persisted memoryCursor and set the fresh mark for a pane whose
   *  context just died, and the resolving send must not undo either — stamping the delta cursor it
   *  composed and spending the mark would leave the context-less builder on delta-only briefings until
   *  the NEXT respawn. Bumped once per respawn (not per bound loop), read only by an inject in flight on
   *  that terminal. In-memory like freshPanes (a Tower restart drops every in-flight send with it);
   *  cleared by onTerminalGone. */
  private restartGen = new Map<string, number>();
  /** SPEC-RESTART §3 — operator control intent (Pause / Step once) captured off an in-flight
   *  runtime the restart hook drops. pause() mid-turn parks pauseRequested on the RUNTIME (the
   *  loop stays 'running' until finishIteration honors it), so onTerminalRestarted's delete
   *  branch would otherwise discard the operator's click and the loop would keep iterating.
   *  Captured there, re-applied onto the restored runtime by driveOne's restore branch (then
   *  consumed), so the re-run iteration still honors it at finishIteration. Bounded: an entry
   *  exists only for a loop restarted mid-flight with intent pending, is consumed on restore, and
   *  is cleared with the loop by onTerminalGone; in-memory like rt. */
  private restartPreservedControl = new Map<string, { pauseRequested?: boolean; stepOnce?: boolean }>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private deps: LoopsDeps) {}

  /** SPEC-RUNWAY W3 — late-bind the rotation dep after construction: its plan/rotate/overThreshold
   *  reference server-scope helpers (signedInProbe, the shared rotateAndFanOut) that are defined after
   *  the Loops constructor. Absent until set ⇒ rotation off (the default, and every test's default). */
  setRunway(runway: LoopsDeps['runway']): void {
    this.deps.runway = runway;
  }

  // ---- reads ----
  list(): Loop[] {
    return this.deps.store.listLoops();
  }
  get(id: string): Loop | undefined {
    return this.deps.store.getLoop(id);
  }

  /** Create a loop, spawn its builder terminal in a worktree, and begin iteration 1. */
  async create(req: CreateLoopRequest): Promise<Loop> {
    const project = this.deps.store.getProject(req.projectId);
    if (!project) throw new Error('unknown projectId');
    const name = req.name.trim();
    const task = req.task.trim();
    if (!name || !task) throw new Error('name and task are required');
    // ⟦DP-7⟧ Resolve (provider, model) through the single precedence function — an optional
    // role (SPEC-ROUTING §3) lets the project/workflow/global role tiers apply when no explicit
    // provider is given; the provider's own defaultModel still fills a missing model. The role is
    // registry-filtered (never trusted from the wire) — an unknown role would brick the stored
    // record on reload. Then validate the resolved route BEFORE the spawn below (a loop
    // spawns its builder immediately), so a broken route fails loudly here, not as a dead terminal.
    const role = req.role && (ROLE_IDS as readonly string[]).includes(req.role) ? req.role : undefined;
    // SPEC-TESTING §1.2 — the ACCOUNT resolves alongside provider/model on its own match-gated
    // chain (loop-explicit > project[role] > workflow[role] > global[role]); Accounts satisfies
    // the ProfileLookup slice structurally. The RESOLVED account (not the raw request field) is
    // what spawns below, mirroring the mission path (§1.5).
    const { provider, model, effort, profileId } = resolveRouting(
      { role, provider: req.provider, model: req.model, effort: req.effort, profileId: req.profileId },
      {},
      this.deps.routing?.layersFor(project.id) ?? { global: {} },
      this.deps.providerStore,
      [],
      this.deps.accounts,
    );
    if (provider === 'shell') throw new Error('a loop needs an agent provider, not a plain shell');
    const routeCheck = validateRoute(
      provider,
      model,
      this.deps.providerStore,
      {
        explicitProfileId: req.profileId,
        resolvedProfileId: profileId,
        profiles: this.deps.accounts,
        reservedProfileIds: this.deps.reservedProfileIds?.(),
      },
      this.deps.knownModelIds?.(provider, profileId),
      effort, // SPEC-EFFORT §2 — the resolved effort (per-provider hard gate)
      this.deps.knownEfforts?.(provider, profileId, model), // codex per-model set → warning-tier only
    );
    if (routeCheck.errors.length) throw new Error(`cannot start loop: ${routeCheck.errors.join('; ')}`);
    // SPEC-MODELS §4 / SPEC-EFFORT §2 — non-fatal catalog warnings (the resolved model/effort isn't in the
    // account's discovered roster/set): record so a legacy slug or novel effort that used to be ignored
    // can't break a run silently.
    if (routeCheck.warnings.length) audit('loop.start.warn', { projectId: project.id, provider, model, effort, warnings: routeCheck.warnings });
    const maxIterations = clampInt(req.maxIterations, 1, 50, 8);
    const assertions = mapAssertions(req.assertions);
    const now = new Date().toISOString();

    // Spawn the builder in a fresh worktree. createTerminal throws BEFORE we persist any
    // loop record (e.g. project is not a git repo), so a failed spawn leaves no dangling loop.
    const term = await this.deps.tm.createTerminal(project, {
      provider,
      worktree: true,
      taskLabel: name,
      profileId, // SPEC-TESTING §1 — the RESOLVED account (match-gated), not the raw request field
      identityId: req.identityId,
      model, // resolved model → LaunchContext.model → a custom provider's {{model}}
      effort, // SPEC-EFFORT §3 resolved effort → LaunchContext.effort → the built-in adapter's argv token
    });

    // SPEC-SKILLS per-project delivery — bake the project's per-project skill brief into the record
    // NOW, keyed on the terminal's server-resolved autoAccept (stamped at spawn and never patched
    // after, and a loop is never re-bound to another terminal — so a create-time exclusion holds for
    // the loop's whole life; the inject-time belt in composeIterationPrompt guards the residual).
    // Compute failures are CAUGHT, not thrown: a skill-brief compute failure is non-fatal, and tearing
    // down a healthy builder spawn over it would be wrong — degrade brief-less and audit instead (the
    // materializeSkills degradation posture). The one genuinely-fatal throw in this spawn→persist window,
    // the loop-record write, is handled separately by the upsertLoop teardown below.
    let brief: { text: string | undefined; hasUncleared: boolean; counts?: Record<string, number>; assistantIds?: string[] } | undefined;
    try {
      brief = this.deps.skillBrief?.({ projectId: project.id, provider, excludeUncleared: term.autoAccept === true });
    } catch (e) {
      brief = undefined;
      audit('loop.skillbrief.failed', { projectId: project.id, provider, error: (e as Error).message });
    }

    const loop: Loop = {
      id: shortId(),
      projectId: project.id,
      name,
      task,
      provider,
      model,
      effort,
      role,
      profileId, // the resolved account the builder actually spawned under
      // The RESOLVED identity binding (opts.identityId ?? project.defaultIdentityId, stamped on the
      // terminal by createTerminal) — NOT the raw req.identityId — so a per-iteration auto-commit's
      // authorship and land()'s brokered push honor the project default when the request omitted one.
      identityId: term.identityId,
      terminalId: term.id,
      branch: term.branch,
      baseBranch: term.baseBranch,
      worktreePath: term.worktreePath,
      checkCommand: req.checkCommand?.trim() || undefined,
      gatePolicy: req.gatePolicy ?? 'on-pass',
      maxIterations,
      status: 'running',
      iteration: 1,
      iterations: [{ n: 1, verdict: 'pending', startedAt: now }],
      assertions,
      missionId: req.missionId,
      sortieId: req.sortieId,
      // The frozen brief (+ the belt flag only when it actually carries an uncleared skill, + the
      // delivered assistant-skill ids only when there are any — absent is the one canonical
      // false/empty, matching the store's flag conventions). An all-filtered brief (text undefined)
      // persists nothing but still reaches the audit below.
      ...(brief?.text
        ? {
            skillBrief: brief.text,
            ...(brief.hasUncleared ? { skillBriefUncleared: true } : {}),
            ...(brief.assistantIds?.length ? { skillBriefAssistantIds: brief.assistantIds } : {}),
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    // createTerminal already succeeded, so the builder pane is LIVE but no loop record yet points at
    // it. A failed record write here (the store's atomic temp+rename can throw on a full/again disk)
    // would strand a running builder + worktree + capacity slot with no owning loop — invisible to the
    // loop lane and never reconciled. Tear the terminal down on that throw so a write failure can't
    // leak a runaway builder, then surface the original error. (The pure object literal above cannot
    // throw; the skillBrief compute keeps its own degrade-not-throw catch, so upsertLoop is the sole
    // uncaught throw in the spawn→persist window.)
    try {
      this.deps.store.upsertLoop(loop);
    } catch (e) {
      try { await this.deps.tm.killTerminal(term.id); } catch { /* best-effort teardown */ }
      throw e;
    }
    this.rt.set(loop.id, { phase: 'launching', injectAt: Date.now() + LAUNCH_SETTLE_MS, injectedAt: 0, sawWorking: false, idleTicks: 0 });
    audit('loop.create', { loopId: loop.id, projectId: project.id, provider, name });
    // Counts only, never contents (the no-secrets-in-audit posture). Fires even when everything
    // filtered out (text undefined) — an all-uncleared bypass selection is exactly where the
    // skippedUncleared count matters most, and it must never vanish with the brief.
    if (brief) audit('loop.skillbrief', { loopId: loop.id, ...(brief.counts ?? {}) });
    this.emit(loop);
    return loop;
  }

  // ---- human gate / control actions ----

  /** Continue iterating (optionally with a steering note fed into the next prompt). */
  continue(id: string, note?: string): Loop {
    const loop = this.mustLoop(id);
    if (loop.status !== 'gated' && loop.status !== 'paused') throw new Error('loop is not waiting at a gate');
    const trimmed = note?.trim();
    if (trimmed) this.annotate(id, trimmed);
    return this.beginNextOrStop(id, trimmed);
  }

  /** Accept the work and land it (guarded local merge). */
  async land(id: string, mode: 'merge' | 'pr' = 'merge', title?: string): Promise<Loop> {
    const loop = this.mustLoop(id);
    // A land is only legitimate from a state an operator reviews from: a human gate ('gated') or a
    // done-unlanded Review & Land candidate ('done'). Landing a running/paused loop would merge
    // whatever the in-flight iteration has committed — possibly a failing, half-finished turn — and
    // then stamp it permanently done/landed, the exact false green a mission then treats as a
    // successful sortie. stopped/failed are deliberately excluded: SPEC-FACTORY (the
    // post-merge re-read below) forbids resurrecting one into 'done', so starting a land on it would
    // only merge the branch while leaving the record stopped — a confusing half-land. Every sibling
    // gate action guards its status; this one never did (worktrees.land's empty-branch throw was the
    // only, incidental, backstop).
    if (loop.status !== 'gated' && loop.status !== 'done') {
      throw new Error(`loop is ${loop.status} — only a gated or done loop can be landed`);
    }
    // Serialize the land against the runtime tick's finishIteration AND any concurrent land (a
    // double-POST): hold the busy latch across the whole merge await so neither can act on the loop
    // mid-merge or start a second merge of the same branch. (mustLoop → status read → busy check are
    // all synchronous, so the guarded state cannot change before the latch is taken.)
    if (this.busy.has(id)) throw new Error('loop is busy — a check or land is already in flight');
    this.busy.add(id);
    try {
      const project = this.deps.store.getProject(loop.projectId);
      const term = loop.terminalId ? this.deps.store.getTerminal(loop.terminalId) : undefined;
      if (!project || !term) throw new Error('loop has no builder to land');
      const res = await this.deps.worktrees.land(project, term, mode, title ?? `Land loop: ${loop.name}`);
      this.rt.delete(id);
      audit('loop.land', { loopId: id, mode });
      // The loop is terminal now and its work is merged/PR'd, so tear the builder down — unlike stop(),
      // which deliberately keeps the pane + worktree for inspection. Without this a landed loop leaks a
      // dangling 'working' pane AND its worktree, which accumulate across a long build (the operator hit
      // exactly this). Both best-effort and AFTER the land result is in hand: a cleanup failure (e.g. a
      // still-dirty worktree, which remove() refuses rather than destroys) must never fail the done land.
      try { await this.deps.worktrees.remove(project, term); } catch { /* dirty/held tree — leave it in place */ }
      try { await this.deps.tm.killTerminal(term.id); } catch { /* best-effort pane teardown */ }
      // Re-read after the merge await: if the loop went terminal (an operator abort raced the
      // land) skip the final patch — the merge already happened, but we must not resurrect a
      // stopped/failed loop into 'done' (SPEC-FACTORY).
      const live = this.deps.store.getLoop(id);
      if (live && (live.status === 'stopped' || live.status === 'failed')) return live;
      return this.patch(id, {
        status: 'done',
        stopReason: `landed — ${res.detail}`,
        landedAt: new Date().toISOString(),
        landDetail: res.detail,
      });
    } finally {
      this.busy.delete(id);
    }
  }

  /** Stop the loop (leaves the builder terminal + worktree intact for inspection). */
  stop(id: string, reason = 'stopped by operator'): Loop {
    const loop = this.mustLoop(id);
    // A landed loop (done + landedAt) is a finished SUCCESS — flipping it to 'stopped' would mask the
    // land in the board/outcomes. Already-stopped/failed loops are terminal too. But a done-UNLANDED
    // loop (a live Review & Land candidate) MUST stay stoppable: archive() refuses it until it is
    // landed OR stopped, so stop() is the operator's way to dismiss a candidate. Guard only the
    // truly-finished states; leave running/gated/paused/done-unlanded stoppable (idempotent).
    if (loop.landedAt || loop.status === 'stopped' || loop.status === 'failed') return loop;
    this.rt.delete(id);
    audit('loop.stop', { loopId: id, reason });
    return this.patch(id, { status: 'stopped', stopReason: reason });
  }

  /** Pause: prompt if idle between iterations, else after the in-flight turn finishes. */
  pause(id: string): Loop {
    const loop = this.mustLoop(id);
    if (loop.status === 'done' || loop.status === 'stopped' || loop.status === 'failed') return loop;
    const r = this.rt.get(id);
    // If the current iteration hasn't been injected yet, pause immediately — but KEEP its
    // runtime (phase + queued feedback) so resume/step re-arm the SAME iteration rather than
    // orphaning it and skipping to the next one (which would burn a maxIterations slot and
    // drop the check-failure feedback queued for this iteration).
    if (r && r.phase === 'launching' && r.injectedAt === 0) {
      return this.patch(id, { status: 'paused' });
    }
    // Otherwise let the in-flight iteration finish, then finishIteration honors the flag.
    if (r) r.pauseRequested = true;
    else return this.patch(id, { status: 'paused' });
    return loop;
  }

  resume(id: string): Loop {
    const loop = this.mustLoop(id);
    if (loop.status !== 'paused') throw new Error('loop is not paused');
    return this.resumeCurrentOrNext(id);
  }

  /** Run exactly one more iteration, then pause again. */
  step(id: string): Loop {
    const loop = this.mustLoop(id);
    if (loop.status !== 'paused' && loop.status !== 'gated') throw new Error('loop must be paused to step');
    const next = this.resumeCurrentOrNext(id);
    const r = this.rt.get(id);
    if (r) r.stepOnce = true;
    return next;
  }

  /** Resume: re-arm the CURRENT iteration if it never ran (paused mid-launch), else open the
   *  next one. This keeps loop.iteration aligned with an actually-run iteration. */
  private resumeCurrentOrNext(id: string): Loop {
    const r = this.rt.get(id);
    if (r && r.phase === 'launching' && r.injectedAt === 0) {
      r.injectAt = Date.now() + ITER_SETTLE_MS; // re-arm this iteration (feedback preserved)
      r.deferSince = undefined; // a pre-pause busy-defer anchor must not survive a resume (would instant-fault)
      r.firstProbe = undefined; // idle evidence must be re-proven post-resume, never off a pre-pause screen
      r.firstProbeAt = undefined;
      return this.patch(id, { status: 'running' });
    }
    return this.beginNextOrStop(id);
  }

  /**
   * SPEC-RESTART §3 — a builder pane was respawned IN PLACE (restartTerminal: same terminal id,
   * socket, hook token, lease; only the process is new, and NO turn survived the respawn). The
   * anti-kill: where onTerminalGone FAILS a bound loop, this keeps it 'running' and re-arms its
   * CURRENT iteration. loop.terminalId is never touched (the "never re-bound" invariant — the
   * SAME pane respawned).
   *
   * Runtime treatment splits on whether anything was in flight, mirroring pause():
   *  - 'launching' with nothing injected: the runtime — queued feedback included — is still the
   *    right plan for the current iteration. Keep it; void only the pre-restart pane evidence
   *    (defer anchor, spawn-latch probe pair, resubmit-belt ownership), all of which describe the
   *    dead process's screen. Keeping it also shrinks the inject-race window: a send that was in
   *    flight during the respawn either lands in the fresh pane (the turn simply proceeds) or dies
   *    with the old one (the belts re-drive it) — never a double-inject off a deleted runtime.
   *  - anything else (a turn injected / in flight / finishing): the turn died with the process.
   *    Drop the runtime so driveOne's runtime-lost restore branch re-arms the CURRENT iteration
   *    next tick (feedback rebuilt from the iteration records — the Tower-restart shape, reused).
   *  - no runtime (gated / paused-after-turn): the status transitions own the re-arm; the
   *    freshPanes mark is all the eventual injection needs.
   */
  /**
   * SPEC-RUNWAY — a subscription rotation re-pointed the SAME terminal onto a new account (the pane was
   * respawned in place). Update the cosmetic loop.profileId — nothing in the runner reads it per
   * iteration; it is truth/attribution only, so the Board/audit don't misreport which account did the
   * work — then delegate to onTerminalRestarted: the pane respawn IS a restart, so the runtime handling
   * (keep at the launching boundary, re-arm otherwise) is identical.
   */
  onTerminalRotated(terminalId: string, toProfileId: string): void {
    for (const loop of this.deps.store.listLoops()) {
      if (loop.terminalId !== terminalId) continue;
      if (loop.status === 'done' || loop.status === 'stopped' || loop.status === 'failed') continue;
      if (loop.profileId !== toProfileId) this.patch(loop.id, { profileId: toProfileId });
    }
    // A rotation always mints a brand-new session on the target account (terminal-manager.ts) — never
    // a resume — so its memory context died with the old process exactly like an ordinary restart.
    this.onTerminalRestarted(terminalId, { resumed: false });
  }

  /** SPEC-RUNWAY live-swap -- the lightweight sibling of onTerminalRotated: the pane's process and
   *  conversation SURVIVED (the credential was swapped in place), so only the loop's cosmetic account
   *  moves; NO restart bookkeeping (no cursor wipe, no fresh-pane mark, no restartGen bump). */
  onTerminalAccountSwapped(terminalId: string, toProfileId: string): void {
    for (const loop of this.deps.store.listLoops()) {
      if (loop.terminalId !== terminalId) continue;
      if (loop.status === 'done' || loop.status === 'stopped' || loop.status === 'failed') continue;
      if (loop.profileId !== toProfileId) this.patch(loop.id, { profileId: toProfileId });
    }
  }

  onTerminalRestarted(terminalId: string, opts?: { resumed?: boolean }): void {
    // SPEC-MEMORY — advance the pane's respawn generation FIRST, so an injectPrompt whose send is mid-await
    // on this terminal sees the change when it resumes and leaves the cursor clear + fresh mark below alone.
    this.restartGen.set(terminalId, (this.restartGen.get(terminalId) ?? 0) + 1);
    for (const loop of this.deps.store.listLoops()) {
      if (loop.terminalId !== terminalId) continue;
      if (loop.status === 'done' || loop.status === 'stopped' || loop.status === 'failed') continue;
      this.freshPanes.add(terminalId);
      // SPEC-RESTART-RESUME — a claude-code restart that RESUMED the same conversation keeps its
      // context: mark it so the memory-mode decision below skips the forced full re-brief, but leave
      // the PERSISTED cursor exactly as it was — nothing died, so nothing needs clearing. Anything
      // else (an ordinary respawn, a rotation, no opts at all) is the historical shape: the mark is
      // cleared and the cursor is wiped so the next injection re-briefs the context-less pane in full.
      if (opts?.resumed === true) {
        this.resumedPanes.add(terminalId);
      } else {
        this.resumedPanes.delete(terminalId);
        // SPEC-MEMORY — the respawn killed the agent's context along with its turn, so whatever memory
        // briefing it had been shown died with the process. Clear the PERSISTED cursor so the next
        // injection sends a full briefing. Persisted deliberately, not derived from the freshPanes mark
        // just set: that set is in-memory, and a Tower restart between this respawn and the injection
        // would lose it — and with it the full re-brief — while the cleared cursor survives in the record.
        if (loop.memoryCursor) this.patch(loop.id, { memoryCursor: undefined });
      }
      const r = this.rt.get(loop.id);
      if (r && r.phase === 'launching' && r.injectedAt === 0) {
        r.deferSince = undefined;
        r.firstProbe = undefined;
        r.firstProbeAt = undefined;
        r.reEnter = undefined;
        r.sentTail = undefined;
      } else if (r) {
        // The operator's Pause / Step-once intent lives on the runtime being dropped (pause()
        // mid-turn parks pauseRequested there and leaves the loop 'running'), so a plain delete
        // would turn a clicked Pause into a loop that keeps iterating. Capture it for the restore
        // branch. Overwrite-or-clear: THIS restart's runtime is authoritative — a stale capture
        // from an earlier restart (already honored by a finishIteration that raced the restore)
        // must never re-pause a later one.
        if (r.pauseRequested || r.stepOnce) {
          this.restartPreservedControl.set(loop.id, {
            ...(r.pauseRequested ? { pauseRequested: true } : {}),
            ...(r.stepOnce ? { stepOnce: true } : {}),
          });
        } else {
          this.restartPreservedControl.delete(loop.id);
        }
        this.rt.delete(loop.id);
      }
      audit('loop.rearm', { loopId: loop.id, terminalId, n: loop.iteration });
    }
  }

  /** A builder terminal was killed or vanished — fail any loop still bound to it. */
  onTerminalGone(terminalId: string): void {
    this.freshPanes.delete(terminalId); // a killed pane is not a fresh pane
    this.resumedPanes.delete(terminalId); // nor a resumed one
    this.restartGen.delete(terminalId); // and has no respawn generation left to race
    for (const loop of this.deps.store.listLoops()) {
      if (loop.terminalId !== terminalId) continue;
      // Captured-but-unrestored control intent dies with the pane (the freshPanes mirror) — for
      // ANY bound loop, terminal-status included, so a loop that dies before its restore never
      // leaves a lingering entry.
      this.restartPreservedControl.delete(loop.id);
      if (loop.status === 'done' || loop.status === 'stopped' || loop.status === 'failed') continue;
      this.rt.delete(loop.id);
      this.patch(loop.id, { status: 'failed', stopReason: 'builder terminal is gone' });
    }
  }

  /** ⟦DP-B6⟧ Archive a FINISHED loop so the Board can be cleared without rewriting history.
   *  FINISHED = landedAt set OR status ∈ {stopped, failed}. A 'done' loop with NO landedAt is a
   *  LIVE Review & Land candidate, not a finished record — refused (the route maps it to a 409).
   *  Idempotent: an already-archived loop is returned unchanged. Sets archivedAt via patch(), which
   *  emits the loop-state SSE frame so open boards update immediately (§3). */
  archive(id: string): Loop {
    const loop = this.mustLoop(id);
    if (loop.archivedAt) return loop; // already archived — a no-op
    const finished = Boolean(loop.landedAt) || loop.status === 'stopped' || loop.status === 'failed';
    if (!finished) {
      if (loop.status === 'done') {
        throw new Error(
          `loop "${loop.name}" is done but not landed — a live Review & Land candidate, not a finished record; land or stop it before archiving`,
        );
      }
      throw new Error(`loop "${loop.name}" is still ${loop.status} — only a landed, stopped, or failed loop can be archived`);
    }
    audit('loop.archive', { loopId: id });
    return this.patch(id, { archivedAt: new Date().toISOString() });
  }

  // ---- the runner ----

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[loops] tick failed:', err));
    }, TICK_MS);
    this.timer.unref?.();
  }
  stop_(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** How many loops have a serialized long operation (a finishIteration — possibly a long check command
   *  or a git commit — or a land() merge/push) in flight right now. Read by the server's graceful
   *  shutdown so it can drain before exiting rather than orphaning a child process or leaving a worktree
   *  half-committed. Note the drain budget (SHUTDOWN_DRAIN_MS/FORCE_MS in server.ts) was sized around a
   *  check/commit; a land(pr) network push can run longer and may hit the force-exit backstop. */
  inFlight(): number {
    return this.busy.size;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const loop of this.deps.store.listLoops()) {
        if (loop.status !== 'running') continue;
        await this.driveOne(loop).catch((err) => console.error(`[loops] drive ${loop.id} failed:`, err));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async driveOne(loop: Loop): Promise<void> {
    if (this.busy.has(loop.id)) return; // its finishIteration (possibly a long check) is in flight
    const rt = this.rt.get(loop.id);
    if (!rt) {
      // Runtime is lost on every Tower restart (it is not persisted). If the builder is STILL mid-turn,
      // observe that turn to completion — re-injecting the task on top of a working agent corrupts its
      // turn and drops the queued feedback. Only re-arm a fresh injection when the pane is free, and in
      // that case rebuild the check-failure feedback that lived only in the lost runtime.
      const restoreTerm = loop.terminalId ? this.deps.store.getTerminal(loop.terminalId) : undefined;
      // SPEC-RESTART §3 — a freshly-respawned pane's 'working' is the create-time spawn latch, not
      // an in-flight turn: nothing in the new process has run, so observing it to completion would
      // wait on a turn-done hook that can never fire (until the per-turn wall-clock ceiling faulted the loop to a gate).
      // Take the re-arm path instead; the injection then goes through the spawn-latch belt below.
      const freshPane = loop.terminalId !== undefined && this.freshPanes.has(loop.terminalId);
      if (restoreTerm?.state === 'working' && !freshPane) {
        // injectedAt = now arms the wall-clock from restart (a fresh full ceiling, never an
        // instant fault); the in-flight turn keeps its own prompt, so no feedback is set here.
        this.rt.set(loop.id, { phase: 'await-done', injectAt: 0, injectedAt: Date.now(), sawWorking: true, idleTicks: 0 });
      } else {
        // Rebuild the feedback that lived only in the lost runtime, from the prior record (the one before
        // the current pending one). prev.note is the operator's steering note from continue() (or a fault
        // note) and WAS rt.feedback verbatim, so it wins for ANY verdict — including a gate-on-pass
        // continue. Failing that, a failed iteration rebuilds its check/judge feedback (the transient
        // e2e list degrades to the raw tail — undefined 5th arg).
        const prev = loop.iterations[loop.iterations.length - 2];
        const feedback = prev?.note ?? (prev?.verdict === 'fail' ? nextFeedback(loop, prev.verdict, prev.checkTail, prev.validator, undefined) : undefined);
        this.rt.set(loop.id, { phase: 'launching', injectAt: Date.now() + ITER_SETTLE_MS, injectedAt: 0, sawWorking: false, idleTicks: 0, feedback });
      }
      // SPEC-RESTART §3 — re-apply the operator control intent captured when the restart dropped
      // an in-flight runtime, so a Pause / Step-once clicked before the restart is honored at the
      // re-run iteration's finishIteration instead of silently discarded. Consumed exactly once;
      // applied on whichever branch built the runtime (only a restart populates the map, and a
      // restarted pane takes the re-arm path, so the observe application is defensive).
      const preserved = this.restartPreservedControl.get(loop.id);
      if (preserved) {
        this.restartPreservedControl.delete(loop.id);
        const restored = this.rt.get(loop.id)!;
        if (preserved.pauseRequested) restored.pauseRequested = true;
        if (preserved.stepOnce) restored.stepOnce = true;
      }
      return;
    }
    const id = loop.terminalId;
    const before = id ? this.deps.store.getTerminal(id) : undefined;
    // Presume alive on a hasSession THROW (a stalled socket): a genuinely-gone session answers false fast
    // without throwing, so only a timeout reaches the catch. Proceeding lets the wall-clock ceiling
    // (below) make a permanently-wedged turn visible — without it the probe throws every tick, tick's
    // .catch swallows it, and the loop sits 'running' forever, never reaching the ceiling and never gating.
    if (!before || before.state === 'killed' || !(await tmux.hasSession(before.tmuxSocket).catch(() => true))) {
      this.rt.delete(loop.id);
      this.patch(loop.id, { status: 'failed', stopReason: 'builder terminal is gone' });
      return;
    }
    // Re-read state AFTER the hasSession await — it may have flipped during it.
    const term = this.deps.store.getTerminal(id!);
    if (!term || term.state === 'killed') return;
    // Agent is asking the human — the attention queue handles it; we wait.
    if (term.state === 'blocked-question' || term.state === 'blocked-permission') {
      // SPEC-LOOPWEDGE F4 — the human's answer latency must NOT consume the turn's RT-1 wall-clock
      // (a round was once gated mid-work because 17 min of operator reply latency ate the ceiling).
      // Anchor when the block began; the credit is applied on the first non-blocked tick below.
      rt.blockedSince ??= Date.now();
      // D3 visibility — a blocked-question / blocked-permission that waits on a human is EXPECTED to
      // wait unbounded (the attention queue owns it), but it must never do so SILENTLY. Audit once
      // per block (dedup) so a multi-hour human stall is visible without faulting a genuine ask.
      if (!rt.blockedAudited) {
        rt.blockedAudited = true;
        audit('loop.blocked', { loopId: loop.id, n: loop.iteration, state: term.state });
      }
      return;
    }
    // SPEC-LOOPWEDGE F4 — first non-blocked tick after a block: credit the blocked interval back to
    // injectedAt so `now - injectedAt` (the RT-1 elapsed) excludes the human-answer latency, then
    // clear the anchor + audit dedup. Skip the credit while 'launching' (injectedAt 0 is RT-1-exempt;
    // bumping it would wrongly subject the pre-inject wait to the ceiling).
    if (rt.blockedSince !== undefined) {
      if (rt.injectedAt > 0) rt.injectedAt += Date.now() - rt.blockedSince;
      rt.blockedSince = undefined;
      rt.blockedAudited = false;
    }

    // Per-turn wall-clock ceiling — the hard stop BEHIND the poller's quiescence floors.
    // Even if every floor fails to trip (a mis-wired tier-A hook, or a provider that flaps
    // working/idle), a turn that never completes must not wedge the loop forever. Past the deadline
    // we FAULT the turn to a human gate — honest: never a fabricated pass. `blocked-*` turns are
    // exempt (returned above — they wait on the operator, not stuck); 'launching' has injectedAt 0.
    if (
      (rt.phase === 'await-start' || rt.phase === 'await-done') &&
      rt.injectedAt > 0 &&
      Date.now() - rt.injectedAt > this.turnWallClockMs()
    ) {
      await this.faultStuckTurn(loop.id, Date.now() - rt.injectedAt);
      return;
    }

    if (rt.phase === 'launching') {
      // SPEC-RUNWAY W3 — rotate at the iteration boundary (injectedAt 0, pane idle), BEFORE injecting,
      // so the next iteration begins on a fresh subscription with zero lost work. UNSAFE windows are
      // excluded by construction: this only runs while 'launching' with injectedAt 0 (never mid-turn,
      // never blocked-*, never during finishIteration which holds `busy`). The rotate awaits a respawn,
      // so it runs DETACHED under `busy` (the tick won't re-enter); onTerminalRotated re-arms this
      // launching runtime. Capped per iteration so an all-over pool can't ping-pong. On plan.exhausted
      // we DON'T rotate — inject on the current account and let the CLI's autoContinueAtUsageLimit wait
      // for the reset in-session (the operator's exhausted-pool choice).
      if (this.deps.runway && rt.injectedAt === 0 && term.state !== 'working') {
        const plan = this.deps.runway.plan(id!);
        if (plan.kind === 'rotate' && (rt.rotations ?? 0) < MAX_ROTATIONS_PER_ITER) {
          rt.rotations = (rt.rotations ?? 0) + 1;
          rt.walledSince = undefined;
          this.busy.add(loop.id);
          const runway = this.deps.runway;
          // Prefer the in-place live swap for a slotted terminal (zero respawn); `rotate` stays the path
          // for everything else. Both are arbitrated by the terminal manager's per-terminal mutexes.
          const move = runway.liveSwap && runway.liveSwapReady?.(id!) ? runway.liveSwap : runway.rotate;
          void move
            .call(runway, id!, plan.toProfileId)
            .then(() => {
              const r = this.rt.get(loop.id);
              if (r) r.injectAt = Date.now() + ITER_SETTLE_MS; // let the respawned pane settle before inject
            })
            .catch((err) => audit('loop.rotate.failed', { loopId: loop.id, error: String((err as Error).message) }))
            .finally(() => this.busy.delete(loop.id));
          return;
        }
        if (plan.kind === 'exhausted' || plan.kind === 'rotate') {
          // Pool exhausted (or over the per-iteration rotation cap): audit once, then HOLD in the
          // launching phase — which is exempt from the per-turn wall-clock ceiling (injectedAt 0) — until the soonest reset, rather
          // than injecting on a walled account. Injecting would drive the pane into the wall where
          // autoContinueAtUsageLimit waits for a reset that routinely exceeds the 30-min RT-1 ceiling,
          // and RT-1 would then fault the (legitimately-waiting) turn as "stuck". Holding re-polls each
          // tick, so the moment ANY pooled account resets the next plan returns {rotate} and we move.
          const soonest = plan.kind === 'exhausted' ? plan.soonestResetMs : undefined;
          if (rt.walledSince === undefined) {
            rt.walledSince = Date.now();
            audit('loop.walled', { loopId: loop.id, n: loop.iteration, ...(soonest ? { soonestResetMs: soonest } : {}) });
          }
          if (soonest !== undefined && Date.now() < soonest) {
            // Clear any pre-wall inject-defer anchor so the deferOrFault ceiling can't fault the hold.
            rt.deferSince = undefined;
            return; // stay launching, RT-1-exempt, until the reset (bounded by `soonest`)
          }
          // Reset time reached (or over the cap with no known reset) — fall through to inject on the
          // current account; the CLI's autoContinueAtUsageLimit covers any small residual wait.
        }
      }
      if (Date.now() < rt.injectAt) return;
      await this.injectPrompt(loop, rt);
      return;
    }
    if (rt.phase === 'await-start') {
      if (term.state === 'working') {
        rt.sawWorking = true;
        rt.phase = 'await-done';
        rt.idleTicks = 0;
      } else if (!rt.sawWorking && Date.now() - rt.injectedAt > NO_START_FALLBACK_MS && term.state === 'idle') {
        // ⟦SB-belt⟧ SPEC-SUBMIT §4.2 — before conceding a fast no-op turn, look for an UN-SUBMITTED
        // prompt. A swallowed Enter leaves the terminal idle, so the per-turn wall-clock ceiling never trips and this branch is
        // the last chance to catch it: the primitive's own confirmation may legitimately have degraded
        // (a custom def, or a classifier that read undefined), and without this the iteration would be
        // recorded as a completed turn that simply did nothing.
        const adapter = providerRegistry().forTerminal(term);
        if (adapter.composerPending) {
          const snap = await tmux.captureVisible(term.tmuxSocket);
          // Fresh-state re-read after the await (the poller's guard idiom): a state flip during the
          // capture voids the evidence — never press Enter into a now-working pane.
          const cur = this.deps.store.getTerminal(term.id);
          if (!cur || cur.state !== 'idle') return;
          if (adapter.composerPending(snap) === true) {
            // ⟦SB-2⟧'s discipline applies here too: a pending composer is only OURS if it holds the
            // prompt we sent. An operator who typed a half-instruction into a builder pane and
            // stepped away must never have it submitted for them — defer instead, and let the
            // bounded wait gate if it never clears.
            if (!rt.sentTail || !tmux.snapshotHoldsOurText(snap, rt.sentTail, adapter.composerText)) {
              if (await this.deferOrFault(loop.id, rt, 'the builder pane holds text that is not ours')) return;
              return;
            }
            rt.reEnter = (rt.reEnter ?? 0) + 1;
            if (rt.reEnter > NO_START_REENTER_MAX) {
              // The note is true BY CONSTRUCTION here: this branch is reached only after the
              // ownership check above proved the composer holds the prompt WE sent. Before that
              // check it could have been asserted over a human's draft — a confident false statement
              // in a gate the operator is being asked to act on.
              await this.faultStuckTurn(loop.id, Date.now() - rt.injectedAt,
                'the injected prompt never submitted — the composer still holds text', 'await-start-nosubmit');
              return;
            }
            audit('loop.resubmit', { loopId: loop.id, n: loop.iteration, attempt: rt.reEnter });
            await tmux.sendKeys(term.tmuxSocket, ['C-m']);
            return; // stay in await-start; the next tick re-evaluates (working, or another pass here)
          }
        }
        // Never observed 'working' (a fast no-op turn). Proceed via the dwell in await-done.
        rt.phase = 'await-done';
        rt.idleTicks = 0;
      }
      return;
    }
    if (rt.phase === 'await-done') {
      if (term.state === 'working') {
        rt.idleTicks = 0; // went back to work — not done
        return;
      }
      if (term.state !== 'idle') return;
      rt.idleTicks++;
      // Require a stable idle dwell AND no live tool process before declaring the turn done,
      // so a briefly-quiet agent (gemini mid-thought) isn't committed/advanced prematurely.
      // Descendant-aware: codex ≥0.14x keeps a permanent idle child (its vendored binary),
      // which the adapter declares via persistentIdleChildren — only work BEYOND it counts.
      // Resolve off the terminal's FROZEN def snapshot (forTerminal), not the live store,
      // so an edit/delete can't change a running loop's idle-dwell rule mid-turn.
      if (rt.idleTicks < IDLE_DWELL) return;
      if (await tmux.paneHasActiveWork(term.tmuxSocket, providerRegistry().forTerminal(term).persistentIdleChildren)) {
        rt.idleTicks = 0;
        return;
      }
      // Kick the finish (which may run a long check) DETACHED so it can't freeze other loops.
      // MUST .catch — an unhandled rejection here (this path is not inside tick's try/catch)
      // would otherwise become an unhandledRejection and can take the daemon down.
      this.busy.add(loop.id);
      void this.finishIteration(loop.id)
        .catch((err) => console.error(`[loops] finishIteration ${loop.id} failed:`, err))
        .finally(() => this.busy.delete(loop.id));
    }
  }

  /** The effective per-turn wall-clock ceiling (config override, else the default). */
  private turnWallClockMs(): number {
    return this.deps.turnTimeoutMs ?? TURN_WALL_CLOCK_MS;
  }

  /**
   * A turn blew past the wall-clock ceiling without completing. Record the timeout onto the
   * current iteration and GATE the loop for the operator — never loop on, never fabricate a pass.
   * Re-reads before writing so a stop/pause that raced the ceiling still wins.
   */
  private async faultStuckTurn(id: string, elapsedMs: number, reason?: string, phase?: string): Promise<void> {
    this.rt.delete(id);
    const loop = this.deps.store.getLoop(id);
    if (!loop || loop.status !== 'running') return;
    const elapsedSec = Math.round(elapsedMs / 1000);
    // SPEC-LOOPWEDGE F6 — for the DEFAULT wall-clock timeout, capture the pane ONCE and name which
    // world we are in, so a turn that actually FINISHED (its completion signal was lost) reads as an
    // actionable "signal was lost", not a misleading "turn exceeded". The explicit-reason faults
    // (no-submit, could-not-inject) already say what happened, so they skip this probe.
    let worldNote = '';
    if (!reason) {
      const term = loop.terminalId ? this.deps.store.getTerminal(loop.terminalId) : undefined;
      if (term && term.state !== 'killed') {
        const snap = await tmux.captureVisible(term.tmuxSocket); // resolves '' on any tmux failure
        if (!snap) worldNote = ' — the pane capture was unavailable';
        else if (claudeBusyFooterOrSpinner(snap)) worldNote = ' — the pane still shows an active turn';
        else {
          const adapter = providerRegistry().forTerminal(term);
          worldNote =
            adapter.composerPending?.(snap) === false
              ? ' — the pane shows an idle composer; the completion signal was lost'
              : ' — the pane frame is unrecognized';
        }
      }
      // Re-read after the capture await: a stop/pause/kill that raced the probe must still win —
      // never resurrect a now-terminal loop with a fault write (mirrors finishIteration's guards).
      const live = this.deps.store.getLoop(id);
      if (!live || live.status !== 'running') return;
    }
    // `reason` distinguishes the 'launching' pane-busy fault (a prompt was never injected) from the
    // default await-start/await-done wall-clock timeout — the default note would be a lie for a turn
    // that never ran. The default note is preserved (plus F6's world note) for the RT-1 path.
    const note = reason
      ? `${reason} (after ${elapsedSec}s) — gated for the operator`
      : `turn exceeded the ${Math.round(this.turnWallClockMs() / 1000)}s wall-clock ceiling (no completion signal after ${elapsedSec}s)${worldNote} — gated for the operator`;
    this.updateIteration(id, loop.iteration, { verdict: 'fail', endedAt: new Date().toISOString(), note });
    // SPEC-SUBMIT §4.2 — `phase` is explicit for callers whose condition is neither of the two the
    // reason-flag can express: the un-submitted-prompt belt faults from AWAIT-START, and logging that
    // as 'launching' (the old derivation) would file it under "the prompt was never injected", which
    // is the opposite of what happened — it was injected, it just never submitted.
    audit('loop.turn.timeout', { loopId: id, elapsedMs, phase: phase ?? (reason ? 'launching' : 'await') });
    this.patch(id, { status: 'gated', stopReason: note });
  }

  /**
   * Anchor the FIRST deferral of this injection and fault past the ceiling. Returns true once it has
   * faulted — meaning the caller must stop, NOT that the loop is necessarily gated: faultStuckTurn
   * deliberately no-ops when a stop/pause raced the ceiling, and that race still wins.
   * Both 'launching' stall causes — a busy pane and an unreachable session — share ONE anchor on
   * purpose: the bound belongs on "iteration n could not be injected", not on either cause alone, so a
   * wait that CHANGES cause is still bounded exactly once.
   * `cause` is only ever the condition observed on this very tick, hence "most recently" in the note —
   * the elapsed itself is attributed to the span claim, which holds whichever cause was in play.
   */
  private async deferOrFault(id: string, rt: Runtime, cause: string): Promise<boolean> {
    rt.deferSince ??= Date.now();
    const waited = Date.now() - rt.deferSince;
    if (waited <= this.turnWallClockMs()) return false;
    await this.faultStuckTurn(id, waited, `the iteration prompt could not be injected (most recently: ${cause}); the wait crossed the ceiling`);
    return true;
  }

  /**
   * POSITIVE evidence that a never-driven builder pane is idle and ready for its FIRST prompt, despite a
   * 'working' state record (the spawn latch). "Never-driven" is a property of the PROCESS, not the loop:
   * an in-place respawn (SPEC-RESTART) re-creates the same shape mid-loop, and the freshPanes mark makes
   * that pane eligible here too. Called ONLY from injectPrompt's first-turn branch. Every
   * check must pass on the SAME tick, and the visible screen must be IDENTICAL across two observations at
   * least FIRST_INJECT_PROBE_GAP_MS apart (consecutive runner ticks in production), before the latch may
   * be bypassed:
   *   (1) the adapter has a composer classifier (built-ins; a custom def stays on today's defer, healed
   *       by the poller backstop);
   *   (2) no live tool process beyond the CLI's structural children (paneHasActiveWork — the same
   *       instrument await-done trusts before committing a turn);
   *   (3) a non-empty visible capture;
   *   (4) NOT a mid-turn pane: the RAW capture must not carry a built-in's pinned busy footer
   *       (/esc to (interrupt|cancel)/i). This is the load-bearing guard for a FROZEN mid-turn pane
   *       (childless AND byte-stable), which passes every other check; matched before normalization so
   *       it cannot be stripped;
   *   (5) not a permission dialog (parseState);
   *   (6) the composer classified affirmatively EMPTY (false — never undefined: a booting CLI, alt
   *       screen, login wall, or unrecognized frame all read inconclusive and defer);
   *   (7) stability: the normalized capture equals the previous clean observation (normalizeSnapshot
   *       strips codex's idle animation, exactly as the poller hashes it).
   * A CHURNING mid-turn CLI (spinner/timer repaint ~1/s) is excluded by (7); a FROZEN mid-turn pane by
   * (4) — together they exclude every mid-turn pane. Any failed check clears the stored observation.
   * Inconclusive NEVER advances: the caller defers.
   */
  private async firstInjectPaneIdle(term: Terminal, rt: Runtime): Promise<boolean> {
    const inconclusive = (): false => {
      rt.firstProbe = undefined;
      rt.firstProbeAt = undefined;
      return false;
    };
    const adapter = providerRegistry().forTerminal(term);
    // Short-circuit BEFORE any tmux probe for a provider with no composer classifier (custom def).
    if (!adapter.composerPending) return inconclusive();
    // The single-snapshot evidence (checks 2–6) is the SHARED affirmative-idle core, so this belt and
    // the poller's F2 built-in backstop judge idleness identically. The stability dwell (check 7)
    // stays here — the belt dwells on a timestamped pair, the poller on a poll count.
    const hasWork = await tmux.paneHasActiveWork(term.tmuxSocket, adapter.persistentIdleChildren);
    const snap = await tmux.captureVisible(term.tmuxSocket);
    const { evidenceOk, norm } = paneAffirmativelyIdle(snap, adapter, hasWork);
    if (!evidenceOk) return inconclusive();
    if (rt.firstProbe !== norm) {
      rt.firstProbe = norm; // first clean observation, or the screen moved — hold for the pair
      rt.firstProbeAt = Date.now();
      return false;
    }
    // Fail CLOSED if the pair timestamp ever desynced (unreachable today — set/cleared together): a
    // missing anchor must never satisfy the gap and open the belt.
    if (rt.firstProbeAt === undefined || Date.now() - rt.firstProbeAt < FIRST_INJECT_PROBE_GAP_MS) return false;
    rt.firstProbe = undefined;
    rt.firstProbeAt = undefined;
    return true;
  }

  private async injectPrompt(loop: Loop, rt: Runtime): Promise<void> {
    const term = loop.terminalId ? this.deps.store.getTerminal(loop.terminalId) : undefined;
    // Final state gate immediately before the send — never type into a dialog or a dead pane.
    if (!term || term.state === 'killed' || term.state === 'blocked-permission' || term.state === 'blocked-question') return;
    if (term.state === 'working') {
      // Mid-turn (a restart race, poller lag, a human at the pane, OR a WEDGED record whose completion
      // hook was lost): don't type over a genuine turn; retry next tick once it frees ('launching' is
      // RT-1-exempt at injectedAt 0, so deferOrFault is what keeps a pane that never frees from stalling
      // the loop silently). We never OBSERVE this turn (unlike the restore branch): the inject is
      // pre-injection of this iteration by construction, so it could be a foreign/stale turn — committing
      // it would falsely complete. Deferring is the safe below-ceiling action whenever the pane is truly
      // mid-turn; a just-freed pane takes the send path on the same tick and never faults.
      //
      // SPEC-LOOPWEDGE F3 — the POSITIVE-EVIDENCE inject belt runs for ANY 'launching' injection into a
      // 'working' pane, not only iteration 1 / a freshly-respawned pane. The wedge this heals is exactly
      // a mid-loop 'working' record left behind by a lost Stop hook: the belt injects ONLY on the same
      // two-tick affirmative-idle evidence (empty composer, no pinned busy footer, no live children,
      // byte-stable — firstInjectPaneIdle), so a pane genuinely mid-turn (or one the operator is typing
      // in) still defers unconditionally. This also closes the freshPanes-erased-by-Tower-restart gap
      // (D2): eligibility no longer depends on the in-memory freshness mark. The spawn-latch case
      // (iteration 1 born 'working'; SPEC-RESTART's in-place respawn re-latch) is subsumed — it is just
      // one instance of "a 'working' record with no in-flight turn". The short-circuit order is
      // load-bearing: a non-launching inject reaches deferOrFault without a single tmux probe.
      const beltEligible = rt.phase === 'launching' && rt.injectedAt === 0;
      if (!beltEligible || !(await this.firstInjectPaneIdle(term, rt))) {
        await this.deferOrFault(loop.id, rt, 'the builder pane stayed busy');
        return;
      }
      // The evidence gathering awaited; a state flip during those awaits voids the decision (the poller's
      // fresh-state guard idiom). 'working' itself is expected — it is the latch — but a blocked/killed
      // flip must return exactly like the pre-send gate.
      const cur = this.deps.store.getTerminal(term.id);
      if (!cur || cur.state === 'killed' || cur.state === 'blocked-permission' || cur.state === 'blocked-question') return;
      audit('loop.inject.firstturn', { loopId: loop.id, n: loop.iteration, provider: loop.provider });
      // Fall through to the send: sendTextVerified's own belts (dead pane, open dialog, foreign text,
      // appear/submit confirmation) remain the last line of defence before any keystroke.
    }
    const n = loop.iteration;
    // Task + frozen per-project skill brief + feedback, assembled in the ONE pure seam (shared with
    // the restart-restore path, which re-sends from the stored record, and with the tests). A tripped
    // clearance belt is audited ONCE per runtime — never a silent suppression.
    //
    // The live drift leg: the brief's entries are by-id LIVE pointers, so a mid-loop edit / promote /
    // rollback that DROPS a delivered assistant skill's clearance (the hash-keyed reset) would keep
    // feeding now-uncleared content to a bypass pane — the create-time exclusion and the frozen flag
    // both predate the drop and can't see it. Computed HERE (store access via deps) so
    // composeIterationPrompt stays pure. Whole-brief suppression on any drifted id is conservative —
    // it drops the still-clear and non-assistant entries too — matching the frozen-flag leg's
    // all-or-nothing behavior; a missing dep also fails CLOSED.
    const driftSuppress =
      term.autoAccept === true &&
      Boolean(loop.skillBrief) &&
      (loop.skillBriefAssistantIds?.length ?? 0) > 0 &&
      !(this.deps.briefAssistantSkillsCleared?.(loop.skillBriefAssistantIds!) ?? false);
    // SPEC-MEMORY — the project-memory briefing for THIS injection, composed here (store access via the
    // dep) so composeIterationPrompt stays pure. `full` when no briefing has ever reached this builder OR
    // the pane was respawned in place since the last one (its context died with the process — the
    // persisted cursor was cleared by onTerminalRestarted, and the in-memory mark covers a respawn that
    // raced the belt awaits above); `delta` otherwise, from the persisted cursor. The cursor is re-read
    // from the store rather than off the tick's `loop` snapshot for the same race. Computed AFTER every
    // defer/return above so a deferred inject never spends a briefing, and a compute failure degrades to
    // no block + an audit line (the skillBrief posture) — memory must never block an iteration.
    const memoryCursor = this.deps.store.getLoop(loop.id)?.memoryCursor;
    // SPEC-RESTART-RESUME — a fresh pane forces 'full' UNLESS it is also a RESUMED one: a resume kept
    // its context (and its persisted cursor), so it is exactly the ordinary-delta case despite the
    // fresh mark. `!memoryCursor` still forces full on its own (never-briefed, or a cleared cursor).
    const memoryMode: 'full' | 'delta' =
      !memoryCursor || (this.freshPanes.has(term.id) && !this.resumedPanes.has(term.id)) ? 'full' : 'delta';
    let brief: { text?: string; delivered: { id: string; rev: number }[]; toSeq: number } | undefined;
    try {
      brief = this.deps.memory?.briefing({ projectId: loop.projectId, loopId: loop.id, mode: memoryMode, sinceSeq: memoryCursor?.seq });
    } catch (e) {
      brief = undefined;
      audit('loop.memory.failed', { loopId: loop.id, n, error: (e as Error).message });
    }
    const composed = composeIterationPrompt(loop, rt.feedback, term, driftSuppress, brief?.text);
    if (composed.briefSuppressed && !rt.briefSuppressedAudited) {
      rt.briefSuppressedAudited = true;
      audit('loop.skillbrief.suppressed', { loopId: loop.id, n, reason: driftSuppress ? 'clearance-drift' : 'frozen-flag' });
    }
    const prompt = composed.prompt;
    // SPEC-SUBMIT §4.1 — the classifier comes off the terminal's FROZEN def snapshot, and the
    // tie-break closure reads live store state at poll time. A free win from ⟦SB-2⟧: an operator's
    // half-typed note in a builder pane now DEFERS this injection (bounded by deferOrFault) instead of
    // being typed over and submitted along with our prompt.
    const adapter = providerRegistry().forTerminal(term);
    const classify = adapter.composerPending;
    const composerText = adapter.composerText;
    // ⟦DEC-2⟧ the went-working tie-break is offered ONLY by a provider that actually signals a
    // submit. For everyone else the poller promotes 'working' off any screen change — including the
    // render of the text we just typed — so passing it would let our own keystrokes certify the
    // send. Freshness (a state change AFTER this send began) narrows it further; it is not
    // provenance, because a hook event and a poller promotion take the same ingest path.
    const beforeEvent = this.deps.store.getTerminal(term.id)?.lastEventAt;
    const sendOpts: tmux.VerifiedSendOpts = {
      composerPending: classify ? (snap: string) => classify(snap) : undefined,
      composerText: composerText ? (snap: string) => composerText(snap) : undefined,
      ...(adapter.signalsSubmit
        ? {
            wentWorking: () => {
              const t = this.deps.store.getTerminal(term.id);
              return t?.state === 'working' && t.lastEventAt !== beforeEvent;
            },
          }
        : {}),
      // A bare Enter into a permission dialog CONFIRMS the highlighted option; the retry loop must
      // stop rather than answer a permission request on the operator's behalf.
      permissionPending: (snap: string) => adapter.parseState(snap) === 'needs-permission',
    };
    // SPEC-MEMORY / SPEC-RESTART §3 — snapshot the pane's respawn generation BEFORE the awaited send. The
    // send can take seconds; an operator Restart landing inside it runs onTerminalRestarted (cursor
    // cleared, pane marked fresh) and then THIS frame resumes. Compared after the await, the snapshot is
    // how the resume knows the pane it briefed is not the pane the loop now drives.
    const restartGen = this.restartGen.get(term.id) ?? 0;
    let outcome: tmux.SendOutcome;
    try {
      outcome = await (this.deps.send ?? tmux.sendTextVerified)(term.tmuxSocket, prompt, sendOpts);
    } catch (e) {
      // The send itself failed — a wedged tmux socket rejects after the timeout. This is the 'launching'
      // twin of the working-defer above, sharing its anchor: a socket we can never reach would otherwise
      // retry forever and never gate. Unlike that branch, the below-ceiling action RETHROWS rather than
      // returns — a send failure must reach tick's catch to be logged and retried, never swallowed, since
      // a silent send failure is the exact mode this hardening exists to surface.
      // SPEC-SUBMIT §1.2/⟦DEC-1⟧ — carry the primitive's own diagnosis into the gate note. The four
      // failure kinds are not interchangeable: refusing a human's draft, a prompt that never
      // submitted, and a pane that could not be reached each call for a different operator action,
      // and one generic cause would misdiagnose three of them.
      // Only a SendVerifyError's message is used: it is a static, payload-free sentence. Node's
      // message for a failed exec is "Command failed: tmux … send-keys -l <THE ENTIRE PROMPT>", so
      // interpolating it would spill the whole prompt — task plus check-failure feedback — into
      // stopReason and onto the board.
      const cause = e instanceof tmux.SendVerifyError ? e.message : 'the builder pane could not be reached';
      if (await this.deferOrFault(loop.id, rt, cause)) return;
      throw e;
    }
    // ⟦DEC-4⟧ a degraded (unverified) send is never silent. Loops never run shell (create() refuses
    // it), so the provider check is defensive only.
    if (outcome === 'unverified' && loop.provider !== 'shell') {
      audit('loop.inject.unverified', { loopId: loop.id, n, provider: loop.provider });
    }
    // SPEC-MEMORY / SPEC-RESTART §3 — did a respawn land while the send was in flight? If so the pane
    // that received (or swallowed) these bytes is NOT the process the loop now drives: its context died,
    // onTerminalRestarted already cleared the persisted cursor and set the fresh mark, and this resume must
    // leave both alone or the respawned builder runs delta-only until the NEXT respawn. The runtime still
    // advances exactly as before (the send either landed in the fresh pane and the turn proceeds, or died
    // with the old one and the belts re-drive it — the documented in-flight-send contract).
    const restartedDuringSend = (this.restartGen.get(term.id) ?? 0) !== restartGen;
    // SPEC-RESTART §3 — the pane has now been driven: its next 'working' is a real turn, so the
    // spawn-latch eligibility is spent (whichever path injected — belt-opened or plainly idle). Unless a
    // respawn raced the send: then the mark describes the NEW process, which nothing has driven yet.
    if (!restartedDuringSend) {
      this.freshPanes.delete(term.id);
      this.resumedPanes.delete(term.id); // spent alongside the fresh mark it rides
    }
    rt.phase = 'await-start';
    rt.injectedAt = Date.now();
    rt.sawWorking = false;
    rt.idleTicks = 0;
    rt.feedback = undefined;
    rt.deferSince = undefined;
    rt.reEnter = undefined;
    // SPEC-SUBMIT §4.2 — remember what WE sent, so the belt can prove the composer still holds OUR
    // prompt before it presses Enter. Without this the belt would submit whatever is sitting there,
    // including an operator's half-typed instruction.
    rt.sentTail = tmux.ourTextTail(prompt);
    // SPEC-MEMORY — the briefing reached the pane (verified OR unverified — an unverified send is still
    // a send; only the throw path above, which never typed, leaves the cursor alone). The cursor advances
    // to the composer's toSeq — what this briefing EVALUATED — never to the store's seq now: the send
    // awaited for seconds, and an entry written meanwhile has seq > toSeq, so it lands in the next delta
    // instead of being skipped as already briefed. A briefing with nothing to say still moves the cursor
    // (it evaluated through toSeq). The delivered annotation is a union with anything this iteration was
    // already shown (a restore re-send with an unchanged pane keeps the agent's context, so the earlier
    // lines are still in front of it); written only when non-empty — absent is the canonical empty.
    //
    // The ONE exception to the advance: a respawn that raced the send (restartedDuringSend). The cursor
    // stays as onTerminalRestarted left it — cleared — so the next inject re-briefs the context-less pane in
    // full. Audited, never silent. The delivered annotation is still written (the bytes were typed; the next
    // full briefing merges by id, so a superset here costs nothing and an omission would lose the trace).
    if (brief) {
      if (restartedDuringSend) {
        audit('loop.memory.cursor-held', { loopId: loop.id, n, terminalId: term.id, reason: 'restarted-during-send' });
      } else {
        this.patch(loop.id, { memoryCursor: { seq: brief.toSeq, briefedAt: new Date().toISOString() } });
      }
      if (brief.delivered.length > 0) {
        const shown = this.deps.store.getLoop(loop.id)?.iterations.find((it) => it.n === n)?.memoryDelivered;
        this.updateIteration(loop.id, n, { memoryDelivered: mergeDelivered(shown, brief.delivered) });
      }
      // Counts only, never entry contents (the no-secrets-in-audit posture).
      audit('loop.memory.briefed', {
        loopId: loop.id, n, mode: memoryMode, count: brief.delivered.length,
        bytes: brief.text ? Buffer.byteLength(brief.text, 'utf8') : 0,
      });
    }
  }

  /** The agent finished its turn: commit, run the check, record the verdict, decide next. */
  private async finishIteration(id: string): Promise<void> {
    // Guard: the loop may have been stopped/paused between the driveOne decision and here.
    const start = this.deps.store.getLoop(id);
    if (!start || start.status !== 'running') { this.rt.delete(id); return; }
    const rt = this.rt.get(id);
    const project = this.deps.store.getProject(start.projectId);
    if (!project || !start.worktreePath || !start.baseBranch) {
      this.rt.delete(id);
      this.patch(id, { status: 'failed', stopReason: 'loop lost its worktree' });
      return;
    }
    const n = start.iteration;

    // SPEC-LOOPWEDGE GUARD — capture whether the COMPLETING idle was INFERRED (F1's lost-hook harvest
    // or F2's poller affirmative-idle demote) rather than a real Stop hook, BEFORE the long commit /
    // check awaits, so a later state flip can't change the completion verdict. The cardinal rule: an
    // inferred idle may never be the sole basis of an autopilot 'done' (enforced at the decision below).
    const inferredCompletion =
      start.terminalId !== undefined && this.deps.wasIdleInferred?.(start.terminalId) === true;

    // 1. Auto-commit this iteration (authored by the loop's GitHub identity, not the daemon).
    await git.git(start.worktreePath, ['add', '-A']);
    const commit = await git.git(start.worktreePath, ['commit', '--no-verify', '-m', `ct-loop: ${start.name} iter ${n}`], this.identityEnv(start));
    const committed = commit.ok;

    // 2. Run the check (if any). Exit 0 = pass; no check = agent self-report (pass).
    let verdict: LoopIteration['verdict'] = 'pass';
    let checkTail: string | undefined;
    if (start.checkCommand) {
      const r = await this.runCheck(start.checkCommand, start.worktreePath, start.terminalId);
      verdict = r.pass ? 'pass' : 'fail';
      checkTail = r.tail;
    }

    // ⟦STORYLOOP §2.3a/§2.3b⟧ Feed (a)+(b): after the check, read the builder terminal's latest
    // e2e run (the check is typically `towerctl test run`, which produced it) and thread its
    // structured failures into BOTH the judge context (feed b — evidence to weigh) and the
    // next-iteration feedback (feed a). `latestFor` excludes gate runs (§0.1). `undefined` = no
    // JSON reporter wired → both feeds fall back to their existing behavior; `[]` = ran green
    // (distinct from unwired). Strictly additive — nothing here changes the verdict.
    // FRESHNESS GUARD: only a run started during THIS iteration counts. A stale run (an earlier
    // iteration's, or one the agent ran unprompted) would be misattributed into feedback and
    // judge evidence — where a fail verdict overrides the iteration verdict.
    const iterStartedAt = start.iterations[start.iterations.length - 1]?.startedAt;
    const latestRun = start.terminalId ? this.deps.testRuns?.latestFor(start.terminalId) : undefined;
    const testFailures =
      latestRun && (!iterStartedAt || latestRun.startedAt >= iterStartedAt)
        ? latestRun.results
        : undefined;

    // 3. Per-iteration diff stat — only if a commit was actually created (else it's a no-op
    //    iteration and HEAD~1..HEAD would misattribute the previous commit's numbers).
    const stat = committed ? await this.iterationDiff(start.worktreePath) : { added: 0, removed: 0, files: 0 };

    // 2b. Contract judge (SPEC-FACTORY §1). Only when this loop carries acceptance criteria and
    //     the check did not already fail (a red check is feedback enough — don't spend a judge
    //     turn to re-confirm it). The judge is a LONG await (up to the account's turn timeout);
    //     it runs HERE, before the re-read guard below (§0.1), so a stop/pause/kill during it is
    //     caught by that guard and nothing is recorded onto a now-terminal loop.
    let validator: ValidatorRun | undefined;
    let forcedGate = false;
    let gateReason: string | undefined;
    const criteria = start.assertions;
    if (criteria?.length && verdict !== 'fail') {
      const avail = this.deps.validator?.available();
      if (!this.deps.validator || !avail?.ok) {
        // No judge wired, or it can't run right now (no account / missing profile). Never pass
        // unverified work silently — route to a forced gate carrying the availability reason.
        forcedGate = true;
        validator = {
          verdict: 'inconclusive',
          results: [],
          inconclusiveReason: avail?.reason ?? 'no acceptance judge is configured',
          ms: 0,
          ranAt: new Date().toISOString(),
        };
      } else {
        // Fill the abort-signal slot EXPLICITLY with `undefined` (the finish path is
        // fire-and-forget; the judge's own watchdog bounds it, and a mid-judge stop/pause is
        // caught by the re-read guard below), and pass the looked-up e2e failures as the 5th
        // arg (feed b) — evidence the judge weighs, never instructions.
        validator = await this.deps.validator.run(start.worktreePath, start.task, criteria, undefined, testFailures);
        if (validator.verdict === 'fail') verdict = 'fail';
        else if (validator.verdict === 'inconclusive') forcedGate = true; // verdict keeps the check result
      }
    }

    // SPEC-LOOPWEDGE GUARD — the cardinal sin: an INFERRED idle (F1 harvest / F2 poller demote, never
    // a real Stop hook) may NEVER be the sole basis of an autopilot pass. gatePolicy 'never' is the
    // ONLY unattended-'done' path (on-pass/every already gate for a human), so with NO checkCommand to
    // independently confirm the work, an inferred completion is forced to a gate — exactly the
    // judge-inconclusive posture. A real Stop-hook idle, or any inferred idle a checkCommand's passing
    // run covers, still auto-passes (the check is objective evidence). Worst case here is a premature
    // commit + a red check on continue = one wasted iteration; a false GREEN is catastrophic. Ordered
    // before the re-read so the forcedGate branch below owns the gate write.
    if (!forcedGate && inferredCompletion && verdict === 'pass' && !start.checkCommand && start.gatePolicy === 'never') {
      forcedGate = true;
      gateReason =
        'completion was inferred from screen evidence, not a completion signal — gated for review rather than auto-passed (no check to confirm the turn actually finished)';
    }

    // SPEC-RUNWAY W3 — never let a usage WALL bank a fake green. Same posture as the inferred-completion
    // gate, on the only unattended-'done' path (no checkCommand, gatePolicy 'never', verdict pass): if the
    // builder's subscription is at/over its limit right now, the "pass" may be a turn the limit cut short,
    // so force a human gate instead of an autopilot done. A checkCommand's objective pass is exempt (it
    // independently confirmed the work). Never touches `verdict` — failed===0 stays untouched.
    if (
      !forcedGate &&
      verdict === 'pass' &&
      !start.checkCommand &&
      start.gatePolicy === 'never' &&
      start.terminalId &&
      this.deps.runway?.overThreshold(start.terminalId)
    ) {
      forcedGate = true;
      gateReason =
        'the builder’s subscription hit its usage limit around this turn — gated for review rather than auto-passed (no check to confirm the turn finished before the limit reset)';
    }

    // Re-read status AFTER the long commit+check awaits, BEFORE recording anything: a human
    // stop/pause (or a vanished builder) during the check must win — and we must not write a
    // verdict onto, or emit a loop-state frame for, a now-terminal loop.
    const live = this.deps.store.getLoop(id);
    if (!live || live.status !== 'running') { this.rt.delete(id); return; }

    // 4. Record the iteration onto the CURRENT loop (re-read; never a stale snapshot).
    // SPEC-SUBMIT §4.3 — annotate the shape a swallowed prompt leaves behind: the runner never saw
    // 'working' AND nothing was committed. `rt === undefined` is the restart-restore race, NOT
    // evidence — flagging it would be a false accusation, so it is excluded. This changes no verdict;
    // it is recorded so a "pass" that did nothing stops reading as clean. Deliberately NOT surfaced
    // through iterations[].note: the restore branch feeds prev.note back into the next prompt
    // verbatim, which would leak Tower bookkeeping into an agent's instructions.
    const suspect = rt !== undefined && !rt.sawWorking && !committed;
    this.updateIteration(id, n, { verdict, endedAt: new Date().toISOString(), checkTail, added: stat.added, removed: stat.removed, files: stat.files, validator, ...(suspect ? { suspectNoWork: true } : {}) });
    audit('loop.iteration', { loopId: id, n, verdict, committed, validator: validator?.verdict, suspect });

    // 5. Honor a pause requested during the turn (contract: in-flight iteration finishes first).
    if (rt?.pauseRequested) {
      this.rt.delete(id);
      this.patch(id, { status: 'paused' });
      return;
    }

    // 6. Decide the next move. ORDER IS PART OF THE CONTRACT (SPEC-FACTORY §0.1/§1): a forced
    //    gate (the judge was inconclusive / unavailable) MUST be evaluated before ANY done
    //    branch, or an inconclusive judge on an autopilot (gatePolicy 'never') loop would reach
    //    'done' and get landed unverified. The gate card reads the inconclusive reason off the
    //    iteration's validator field (recorded in step 4 above).
    if (forcedGate) {
      this.rt.delete(id);
      // The judge-inconclusive gate reads its reason off the iteration's validator field (step 4). The
      // SPEC-LOOPWEDGE inferred-completion gate has no validator, so it carries its reason as the loop's
      // stopReason (the RT-1-fault pattern) — the board's gate card shows why it was not auto-passed.
      this.patch(id, { status: 'gated', ...(gateReason ? { stopReason: gateReason } : {}) });
      return;
    }

    const atCap = n >= live.maxIterations;
    const wantGate = live.gatePolicy === 'every' || (live.gatePolicy === 'on-pass' && verdict === 'pass');

    if (verdict === 'pass' && live.gatePolicy === 'never') {
      this.rt.delete(id);
      if (committed) {
        this.patch(id, { status: 'done', stopReason: 'check passed' });
        return;
      }
      // The final iteration committed nothing. A branch with ZERO commits vs its base can never
      // land (worktrees.land throws 'no commits on this branch to land'), so it is finished-in-fact,
      // not a live Review & Land candidate — resolve it to 'stopped' so it leaves the Gate lane and
      // archive()/clear-finished/countFinished (all of which treat stopped as finished) can clear
      // it. A branch that still holds commits from an EARLIER iteration stays 'done' (a real Land
      // candidate) with an honest reason. git.log reads the main repo, so it works even if the
      // worktree was already removed; a missing branch/base yields [] → nothing to land, correct.
      const commits =
        live.branch && live.baseBranch ? await git.log(project.repoPath, live.baseBranch, live.branch) : [];
      // Re-read after the git.log await — its subprocess is the only yield between the guard above
      // and this write, and patch() does not guard terminal states. A human stop/pause/kill landing
      // during it must win; writing here would resurrect a now-terminal loop (mirrors the guard at
      // :527 and land()'s pre-patch re-read).
      const after = this.deps.store.getLoop(id);
      if (!after || after.status !== 'running') return;
      this.patch(
        id,
        commits.length === 0
          ? { status: 'stopped', stopReason: 'agent reported done — no changes to land', noChangesToLand: true }
          : { status: 'done', stopReason: 'agent reported done (no new changes this iteration)' },
      );
      return;
    }
    if (wantGate) {
      this.rt.delete(id);
      this.patch(id, { status: 'gated' });
      return;
    }
    if (atCap) {
      this.rt.delete(id);
      this.patch(id, { status: 'stopped', stopReason: `reached max ${live.maxIterations} iterations` });
      return;
    }
    if (rt?.stepOnce) {
      this.rt.delete(id);
      this.patch(id, { status: 'paused' });
      return;
    }
    this.beginIteration(id, nextFeedback(live, verdict, checkTail, validator, testFailures));
  }

  private async runCheck(cmd: string, cwd: string, terminalId?: string): Promise<{ pass: boolean; tail: string }> {
    // The check inherits the DAEMON's env, which carries no per-terminal token — so a `towerctl`
    // checkCommand exits 2 for lack of auth. Inject the builder terminal's token file + the tower port
    // (the same TOWER_HOOK_TOKEN_FILE / TOWER_PORT the hook forwarder reads) so the check authenticates
    // as its own terminal. Kept behind the dep presence so an unwired Loops falls back to the daemon env.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.deps.towerPort !== undefined) env.TOWER_PORT = String(this.deps.towerPort);
    if (terminalId && this.deps.hookTokenFile) env.TOWER_HOOK_TOKEN_FILE = this.deps.hookTokenFile(terminalId);
    return new Promise((resolve) => {
      execFile('bash', ['-lc', cmd], { cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`;
        const tail = out.split('\n').filter(Boolean).slice(-12).join('\n').slice(0, 2000);
        resolve({ pass: !err, tail });
      });
    });
  }

  private async iterationDiff(worktreePath: string): Promise<{ added: number; removed: number; files: number }> {
    const hasParent = (await git.git(worktreePath, ['rev-parse', '--verify', '--quiet', 'HEAD~1'])).ok;
    const res = hasParent
      ? await git.git(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD~1..HEAD'])
      : await git.git(worktreePath, ['show', '--no-ext-diff', '--no-textconv', '--numstat', '--format=', 'HEAD']);
    let added = 0, removed = 0, files = 0;
    for (const line of res.stdout.split('\n').filter(Boolean)) {
      const [a, r] = line.split('\t');
      if (a === undefined) continue;
      files++;
      added += a === '-' ? 0 : Number(a) || 0;
      removed += r === '-' ? 0 : Number(r) || 0;
    }
    return { added, removed, files };
  }

  // ---- state helpers (all re-read the loop; never rebuild from a stale snapshot) ----

  /** Move a gated/paused loop into its next iteration, or stop it if at the cap. */
  private beginNextOrStop(id: string, feedback?: string): Loop {
    const loop = this.mustLoop(id);
    if (loop.iteration >= loop.maxIterations) {
      this.rt.delete(id);
      return this.patch(id, { status: 'stopped', stopReason: `reached max ${loop.maxIterations} iterations` });
    }
    return this.beginIteration(id, feedback ?? 'Continue improving the work.');
  }

  /** Open a new iteration record and arm the runner to inject after a short settle. */
  private beginIteration(id: string, feedback: string): Loop {
    const loop = this.mustLoop(id);
    const n = loop.iteration + 1;
    const iterations = [...loop.iterations, { n, verdict: 'pending' as const, startedAt: new Date().toISOString() }];
    const prevStep = this.rt.get(id)?.stepOnce;
    const next = this.patch(id, { status: 'running', iteration: n, iterations });
    this.rt.set(id, { phase: 'launching', injectAt: Date.now() + ITER_SETTLE_MS, injectedAt: 0, sawWorking: false, idleTicks: 0, feedback, stepOnce: prevStep });
    return next;
  }

  /** Merge a patch onto one iteration of the CURRENT (re-read) loop. */
  private updateIteration(id: string, n: number, patch: Partial<LoopIteration>): void {
    const loop = this.deps.store.getLoop(id);
    if (!loop) return;
    const iterations = loop.iterations.map((it) => (it.n === n ? { ...it, ...patch } : it));
    this.patch(id, { iterations });
  }

  private annotate(id: string, note: string): void {
    const loop = this.deps.store.getLoop(id);
    if (!loop) return;
    this.updateIteration(id, loop.iteration, { note });
  }

  /** SPEC-MEMORY — record the agent's own progress note (`towerctl note`) onto the CURRENT iteration.
   *  Latest write wins; clamped to 1 KB of UTF-8 on a code-point boundary (never a torn character). An
   *  operator-facing annotation ONLY, deliberately kept OFF iterations[].note: the restore branch feeds
   *  prev.note back into the next prompt verbatim, and nothing may ever carry an agent's status line into
   *  a prompt, into nextFeedback, or into any verdict/gate — an agent must not steer a turn (its own or
   *  another's) through its notes. Returns the iteration it annotated. */
  progress(id: string, text: string): { n: number } {
    const loop = this.mustLoop(id);
    const trimmed = text.trim();
    if (!trimmed) throw new Error('note is empty');
    this.updateIteration(id, loop.iteration, { progress: clampUtf8(trimmed, PROGRESS_MAX_BYTES) });
    return { n: loop.iteration };
  }

  private identityEnv(loop: Loop): Record<string, string> | undefined {
    const idn = loop.identityId ? this.deps.accounts.getIdentity(loop.identityId) : undefined;
    if (!idn) return undefined;
    return {
      GIT_AUTHOR_NAME: idn.gitName,
      GIT_AUTHOR_EMAIL: idn.gitEmail,
      GIT_COMMITTER_NAME: idn.gitName,
      GIT_COMMITTER_EMAIL: idn.gitEmail,
    };
  }

  private patch(id: string, patch: Partial<Loop>): Loop {
    // ⟦DP-B5⟧ Execution-done detection at the SINGLE write choke point: fire once when landedAt is
    // NEWLY set (prev unset → set), never on bare status 'done' (a done-unlanded loop is a live Gate
    // card, not success — §3s's finished set). Read prev only when the patch actually carries landedAt, so the
    // per-iteration write path pays nothing.
    // SPEC-MEMORY — the run-scoped memory integration boundary rides the same choke point: a NEWLY set
    // landedAt flips the loop's in-flight entries to 'landed'; a status that NEWLY becomes stopped /
    // failed on a loop that never landed flips them to 'abandoned'. The prev read is widened only for
    // a patch that carries a terminal status, so the per-iteration path still pays nothing.
    const settingLanded = patch.landedAt !== undefined;
    const settingTerminal = patch.status === 'stopped' || patch.status === 'failed';
    const prev = settingLanded || settingTerminal ? this.deps.store.getLoop(id) : undefined;
    const next = this.deps.store.patchLoop(id, patch);
    if (!next) throw new Error('unknown loop');
    this.emit(next);
    if (settingLanded && prev && !prev.landedAt && next.landedAt) {
      this.fireExecutionDone({ loopId: id });
      this.fireIntegration(next, 'landed');
    } else if (settingTerminal && prev && prev.status !== 'stopped' && prev.status !== 'failed' && !next.landedAt) {
      this.fireIntegration(next, 'abandoned');
    }
    return next;
  }

  /** ⟦DP-B5⟧ Fire the optional backlog execution-done hook, fully guarded — a backlog failure must
   *  NEVER break a land or any other loop write. */
  private fireExecutionDone(ref: { missionId?: string; loopId?: string }): void {
    try {
      this.deps.backlog?.onExecutionDone(ref);
    } catch (err) {
      console.error('[loops] backlog.onExecutionDone failed:', err);
    }
  }

  /** SPEC-MEMORY — flip the loop's run-scoped memory entries at its integration boundary, fully guarded
   *  (the fireExecutionDone posture): a memory-store failure must NEVER break a land or a stop. */
  private fireIntegration(loop: Loop, state: 'landed' | 'abandoned'): void {
    try {
      this.deps.memory?.onIntegration({ loopId: loop.id, missionId: loop.missionId, sortieId: loop.sortieId }, state);
    } catch (err) {
      console.error('[loops] memory.onIntegration failed:', err);
    }
  }

  private emit(loop: Loop): void {
    try {
      this.deps.onUpdate(loop);
    } catch {
      /* dropped subscriber */
    }
  }

  private mustLoop(id: string): Loop {
    const loop = this.deps.store.getLoop(id);
    if (!loop) throw new Error('unknown loop');
    return loop;
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Clamp to at most `max` UTF-8 bytes on a CODE-POINT boundary — a byte-sliced Buffer would tear a
 *  multibyte character into a lone half that renders as U+FFFD on the board. */
function clampUtf8(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let bytes = 0;
  let out = '';
  for (const cp of s) {
    const len = Buffer.byteLength(cp, 'utf8');
    if (bytes + len > max) break;
    bytes += len;
    out += cp;
  }
  return out;
}

/** SPEC-MEMORY — union of the memory entries an iteration has been shown, by id, newest rev winning
 *  (a re-briefed entry's later rev replaces the earlier one; order is first-seen). */
function mergeDelivered(
  prev: { id: string; rev: number }[] | undefined,
  next: { id: string; rev: number }[],
): { id: string; rev: number }[] {
  const byId = new Map<string, number>();
  for (const d of prev ?? []) byId.set(d.id, d.rev);
  for (const d of next) byId.set(d.id, Math.max(d.rev, byId.get(d.id) ?? d.rev));
  return [...byId].map(([id, rev]) => ({ id, rev }));
}

/** Trim, drop empties, cap at 12 × 500 chars, and mint an id per criterion (SPEC-FACTORY §1). */
function mapAssertions(raw: string[] | undefined): ContractAssertion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ContractAssertion[] = [];
  for (const s of raw) {
    if (typeof s !== 'string') continue;
    const text = s.trim();
    if (!text) continue;
    out.push({ id: shortId(), text: text.slice(0, 500) });
    if (out.length >= 12) break;
  }
  return out.length ? out : undefined;
}

/** The feedback appended to the next iteration's prompt. Precedence (⟦STORYLOOP §2.3a⟧): failed
 *  judge criteria win first, then the structured e2e failure list (feed a), then the raw check
 *  tail — so a wired JSON reporter upgrades the tail to a named failure list, and everything
 *  falls back cleanly when it isn't. */
function nextFeedback(
  loop: Loop,
  verdict: LoopIteration['verdict'],
  checkTail: string | undefined,
  validator: ValidatorRun | undefined,
  testFailures?: TestFailure[],
): string {
  if (validator?.verdict === 'fail') {
    const byId = new Map((loop.assertions ?? []).map((a) => [a.id, a.text]));
    const body = validator.results
      .filter((r) => !r.pass)
      .map((r) => `- ${byId.get(r.assertionId) ?? r.assertionId}: ${r.reason}`)
      .join('\n');
    return `These acceptance criteria are not yet met — fix them:\n${body}`.slice(0, 2000);
  }
  // ⟦STORYLOOP §2.3a⟧ Feed (a): a structured e2e failure list beats the raw 12-line tail when the
  // check failed and the run carried parseable failures — each line names `specFile › testTitle`
  // and the first line of that test's errorTail. `[]`/undefined (all-green or no reporter wired)
  // falls through to the checkTail path below, so this is strictly additive.
  if (verdict === 'fail' && testFailures?.length) {
    const body = testFailures
      .map((f) => `- ${f.specFile} › ${f.testTitle}: ${firstLine(f.errorTail)}`)
      .join('\n');
    return `These e2e tests are failing — fix them:\n${body}`.slice(0, 2000);
  }
  if (verdict === 'fail' && checkTail) {
    return `The check \`${loop.checkCommand}\` failed. Fix it. Output tail:\n${checkTail}`;
  }
  return 'Continue improving the work.';
}

/** The first non-empty, trimmed line of a (possibly multi-line) error tail — for the compact
 *  one-line-per-failure list in nextFeedback's e2e branch. */
function firstLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}
