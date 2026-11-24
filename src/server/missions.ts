// Missions + Autopilot (SPEC-FACTORY §2): a planned campaign the Tower advances at phase
// boundaries. A Mission owns ordered Phases; each Phase owns Sorties; a Sortie's execution
// is exactly ONE Loop (the loop runner is the only execution engine — we never fork it).
//
// The runner mirrors `Loops`: a low-frequency tick that, per RUNNING mission, re-reads the
// mission fresh (never a stale snapshot), reconciles every active-phase sortie's status from
// its loop (derived truth), rolls that up to a mission status, and starts pending sorties up
// to `concurrency`. Landing is BATCHED at the phase boundary — never per-sortie-as-it-finishes
// — and happens only on an explicit `advance` (gate mode) or the tick's own advance (auto mode).
//
// Correctness invariants (inherited from the Loops review):
//  - Every mutation re-reads the mission first, so a completed reconcile survives a race.
//  - A per-mission busy-guard serializes a tick's drive against a route-driven advance, so two
//    concurrent lands into one mission never interleave. Different missions never block.
//  - After the long `loops.create` / `loops.land` awaits, the mission's status is re-read
//    before any status decision, so an operator pause/abort during that window always wins.
//  - A builder's loopId is recorded onto its sortie no matter the mission's state after create,
//    so a crash/abort mid-spawn can never orphan or duplicate a builder (the reconcile de-dup
//    then re-links it).

import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { Loops } from './loops.js';
import { shortId } from './ids.js';
import { audit } from './audit.js';
import { buildResearchDigest } from './research.js';
import * as git from './git.js';
import { resolveRouting, validateRoute, validateMissionRoutes } from './providers/routing.js';
import type { ProviderSecretLookup, ProfileLookup } from './providers/routing.js';
import { partitionBySpecFile, partitionByKey } from './gate.js';
import type { RegressionGate, GateResult } from './gate.js';
import { canonicalizeReviewPath, isConfirmed, isStaleReviewRecord } from './reviews.js';
import { ROLE_IDS } from '../shared/roles.js';
import { MEMORY_FILE_LIST } from './memory-instruction.js';
// The verify/review task strings are shared VERBATIM with the composer's phase templates (MissionsView).
// triageKey is a runtime VALUE (the assignFixerPhase suppression filter joins with it) — a value import.
import { LOOP_VERIFY_TASK, LOOP_REVIEW_TASK, REVIEW_CHECK_COMMAND, PHASE_STAGES, partitionByTriage } from '../shared/types.js';
import type {
  Loop,
  LoopStatus,
  Mission,
  MissionLoop,
  MissionPhase,
  MissionPlanReview,
  MissionRoundRecord,
  MissionSortie,
  MissionStatus,
  SortieStatus,
  CreateMissionRequest,
  LayeredRoleRouting,
  PipelineRole,
  ProviderId,
  PlanRevisionBundle,
  GateEvidenceRecord,
  ReviewRecord,
  ReviewFinding,
  TestFailure,
  TestTriageEntry, ResearchRecord,
  MissionPlanner, PlannerConsult, Terminal,
} from '../shared/types.js';

/**
 * SPEC-STORYLOOP §3.3 — the slice of a TestKit run the fixer-assignment join reads, adding
 * `results` to TestRun (`undefined` = no parseable report; `[]` = all green). Typed
 * structurally so missions.ts needn't import testkit.ts's evolving shape — the integrator injects
 * the real TestKit, whose `latestFor` (which already excludes kind:'gate' runs) satisfies it.
 */
interface RunnerRun {
  id: string;
  results?: TestFailure[];
  /** SPEC-TESTING §3 — pass/fail counts for the docs task's honest verification summary. */
  total?: number;
  failed?: number;
  /** SPEC-LOOP §2 — run start timestamp for the freshness guard (loops.ts:495): the completion
   *  evaluator ignores a run started before its verify runner's loop (never misattributes a stale
   *  run into the loop verdict). The real TestKit's TestRun carries it, so it injects structurally. */
  startedAt?: string;
  /** SPEC-LOOP W7 — the investigator's false-fail classifications; the assignFixerPhase suppression
   *  filter reads this to partition ONLY 'real' failures. Absent = no triage ⇒ every failure is real. */
  triage?: TestTriageEntry[];
}

const TICK_MS = 5000;
// SPEC-TERMINAL-OPS §3.3 — how long a sortie may wait for a free terminal slot before the wait becomes
// a fault. The ceiling is DERIVED from how long a slot can legitimately be held, not from the loop
// runner's per-TURN ceiling: a queued sortie waits behind a whole sibling SORTIE, which is up to
// maxIterationsPerSortie turns of wall clock (8 by default → ~4h; the composer allows 50).
// Using the per-turn 30 minutes would park a perfectly healthy busy fleet at a human gate — the queue
// is moving, each sortie simply takes longer than one turn. The anchor is still stamped ONCE and never
// re-stamped, so the wait stays BOUNDED (a starved sortie on a permanently oversubscribed fleet is a
// real condition the operator needs to see); the ceiling only sets how much patience is honest.
//
// Considered and rejected: re-stamping the anchor when the fleet CHANGES (a stall detector). Global
// churn is the wrong signal — other projects cycling terminals would re-stamp every tick and a starved
// mission would never fault at all, which is a silent stall (strictly worse than a false gate). Keying
// it on "the live count dropped" instead does not help either, for three reasons:
//   (a) a sortie can defer on the PROJECT cap while the global count moves freely, so a refinement
//       reading the global count re-stamps on essentially every tick of that deferral — the unbounded
//       silent stall in its purest form, and the reason the rejection holds even where (b) does not;
//   (b) on a global-cap deferral the live count sits at or above the cap (the moment it drops BELOW,
//       this sortie starts and the anchor is deleted — note `live > cap` is ordinary, since login
//       terminals are exempt from the check but still counted and the cap is re-read at call time), so
//       the refinement never fires in the very scenario a short ceiling gets wrong;
//   (c) above the cap, an oscillating count would re-stamp on every downtick, unbounded.
// A derived ceiling with a one-shot anchor is the simple mechanism that is right in both directions.
const CAP_WAIT_TURN_MS = 30 * 60_000; // one turn's wall clock — loops.ts TURN_WALL_CLOCK_MS
const CAP_WAIT_MIN_MS = 30 * 60_000;
const CAP_WAIT_MAX_MS = 12 * 3_600_000; // even a 50-iteration sortie must not defer a gate for a day
/** SPEC-TERMINAL-OPS §3.3 — the patience a queued sortie is owed, derived from how long a sibling
 *  sortie can legitimately hold its slot. Exported for the policy table test. */
export function capWaitCeilingMs(maxIterationsPerSortie: number): number {
  const n = Number.isFinite(maxIterationsPerSortie) ? Math.max(1, maxIterationsPerSortie) : 1;
  return Math.min(CAP_WAIT_MAX_MS, Math.max(CAP_WAIT_MIN_MS, n * CAP_WAIT_TURN_MS));
}
/** Human duration for the fault note ("45m", "4h") — the note must state the wait it actually measured. */
function humanMs(ms: number): string {
  const mins = Math.round(ms / 60_000);
  return mins < 90 ? `${mins}m` : `${Math.round(mins / 60)}h`;
}
// The prefix of that visible note, so a stale one can be recognized and cleared once a slot frees.
const CAP_WAIT_NOTE = 'waiting for a free terminal slot — ';
// SPEC-LOOP §2 W2 — the planner escalation attempt cap. A give-up path stamps the escalating record's
// `attempts` to this so a restart short-circuits instead of re-spending a paid re-planner turn.
const MAX_ESCALATE_ATTEMPTS = 2;

// The placeholder task a mechanical round's fixer carries until assignFixerPhase rewrites it from the
// previous verify runner's partitioned failures (mirrors the composer's fixer template, §3.3).
// A mechanical round's fixer is run-and-report (no whole-suite checkCommand). It owns only its
// partitioned spec files, but `towerctl test run` runs the WHOLE suite — which stays red on the OTHER
// fixers' still-unmerged buckets (each fixer works in its own worktree), so a whole-suite check could
// never pass → the fixer would iterate to attention and stall the loop. Instead each fixer fixes its
// bucket in its turn and lands; the round's verify phase re-runs the integrated suite, and the loop
// iterates at the ROUND level (evaluateCompletion) rather than the sortie level.
const LOOP_FIXER_TASK =
  'Fix the e2e failures assigned to you. The Tower rewrites this task at the start of the phase with '
  + 'your specific failing tests (partitioned by spec file from the previous verify run) — wait for '
  + 'that, then fix the code for those tests. You need not re-run the whole suite; the loop re-runs it '
  + 'and starts another fix round if anything is still red.';
// SPEC-TESTING §3 — a docs sortie finalized with NO parseable verify run keeps its never-gates
// identity via a sentinel docsFromRun (so isDocsSortie stays true), while docsSortie is cleared so
// assignDocsPhase does not re-finalize it. The sentinel is not a shortId, so getRun rejects it and
// it is excluded from the pinned-run lookup.
const DOCS_NO_RUN = 'no-run';
// The placeholder task a review-fix round's fixer carries until assignReviewFixPhase rewrites it from the
// reviewer's partitioned findings (mirrors LOOP_FIXER_TASK). Run-and-report, no whole-suite checkCommand.
const LOOP_REVIEW_FIX_TASK =
  'Fix the code-review findings assigned to you. The Tower rewrites this task at the start of the phase '
  + 'with the specific findings (partitioned by file from the reviewer’s report) — wait for that, then fix '
  + 'the code for those findings. You need not re-run the whole suite; the loop re-runs it and starts '
  + 'another round if anything is still wrong.';
// SPEC-LOOP W7 — the placeholder task a mechanical round's investigator carries until
// assignInvestigatePhase rewrites it from the previous verify run's failures (mirrors LOOP_FIXER_TASK).
const LOOP_INVESTIGATE_TASK =
  'Investigate the e2e failures from the previous verify run. The Tower rewrites this task at the start '
  + 'of the phase with the specific failing tests to classify — wait for that, then classify each as a '
  + 'real bug, a by-design expectation, or a false failure, and submit once with `towerctl test triage`. '
  + 'Do NOT modify code or tests; you only classify.';

export interface MissionsDeps {
  store: Store;
  loops: Loops;
  /** Push a mission-state SSE frame to dashboards. */
  onUpdate: (m: Mission) => void;
  /** ⟦DP-B5⟧ Optional backlog bridge. When a mission transitions INTO 'done' (prev !== 'done'),
   *  the patch() choke point fires onExecutionDone so a linked backlog task auto-archives. Absent →
   *  no backlog wiring. Fire-and-forget: a backlog failure never breaks a mission write. */
  backlog?: { onExecutionDone(ref: { missionId?: string; loopId?: string }): void };
  /** SPEC-LOOP W4 — the delivery-report bridge. When a mission transitions INTO 'done' OR 'failed' for
   *  the first time, the patch() choke point fires onMissionFinished so a deterministic report is
   *  written to ~/.ct/reports/<missionId>. Absent → no report. Fire-and-forget: report-never-blocks-done,
   *  a report failure must NEVER break a mission write (mirrors `backlog`). */
  report?: { onMissionFinished(mission: Mission): void };
  /** SPEC-LOOP W7 — the deferred-auto-file flush bridge. When an investigate loop mission SETTLES
   *  terminally (transition into 'failed', OR a cap-exhausted give-up that parks at 'attention'), the
   *  integrator files the real failures of every verify run whose auto-file was deferred and never
   *  completed by a triage submission — so a run no investigator ever triaged still reaches the backlog
   *  (never-silent-pass for the backlog). Idempotent (the run's autoFiled marker). Fire-and-forget. */
  onLoopSettle?(mission: Mission): void;
  /**
   * Draft phases via the assistant judge plumbing. Injected by the integrator: missions.ts
   * may NOT import validator.ts (B1 owns it and the dep direction is wrong), so planning is a
   * pluggable dep. Absent → plan() throws 'assistant planning unavailable' (route maps to 503).
   */
  planDraft?: (projectRepoPath: string, goal: string) => Promise<CreateMissionRequest['phases']>;
  /**
   * SPEC-LOOP W2 (G2) — the codex Brain re-planner, injected by the integrator (missions.ts may NOT
   * import validator.ts — same dep-direction rule as planDraft). Given the read-only project repo + a
   * PlanRevisionBundle (built from the mission), it proposes ONLY the remaining work as fresh phases.
   * Runs on a running loop mission's DETACHED tick drive under the busy-guard (a minutes-long await —
   * NEVER on a route path). THROWS on every failure kind; the boundary bounds the retry, then attentions.
   * Absent → an escalation routes to attention (no re-planner wired), never a silent stall.
   */
  planRevision?: (projectRepoPath: string, bundle: PlanRevisionBundle) => Promise<CreateMissionRequest['phases']>;
  /**
   * ⟦DP-7⟧ The custom-provider store — resolveRouting reads it for a def's defaultModel and
   * validateRoute checks each sortie's resolved route (def exists, model present, secrets, auth).
   * Absent → built-in-only routing (no def validation). Same instance the loops runner gets.
   */
  providerStore?: ProviderSecretLookup;
  /** ⟦§2.1⟧/SPEC-ROUTING §3 — the layered role routing for this mission's project (project
   *  overrides > selected workflow > global defaults), layered under per-sortie / mission overrides. */
  routing?: { layersFor(projectId?: string): LayeredRoleRouting };
  /**
   * SPEC-STORYLOOP §4 — the regression gate run at the top of runAdvance, before the first land.
   * Absent while a mission has `gateSuite` set → the advance routes to attention, never a
   * silent land past an unverified integrated tree. Unset gateSuite → the gate is never consulted.
   */
  gate?: RegressionGate;
  /**
   * SPEC-STORYLOOP §3.3 — the test kit, for the runner-terminal results join at fixer-phase-start
   * `latestFor` already excludes kind:'gate' runs; `getRun` pins a retried fixer's
   * partition to the run the phase was FIRST partitioned from. Absent → a verify-fixer
   * phase routes to attention (it can't read the runner's failures), never silent empty fixer work.
   * SPEC-TESTING §3 — `latestParsedForProject` (newest non-gate run WITH parsed results) feeds
   * the docs phase: a docs phase FOLLOWS the fix phase, so the newest parsed run is the honest
   * post-fix state — a concurrent in-flight run (results still unparsed) must never shadow it.
   * Docs assignment NEVER blocks, so an absent kit just clears the marker with a note.
   */
  testkit?: {
    latestFor(terminalId: string): RunnerRun | undefined;
    getRun(runId: string): RunnerRun | undefined;
    latestParsedForProject(projectId: string): RunnerRun | undefined;
  };
  /**
   * SPEC-TESTING §1.2 — the account lookup resolveRouting's provider-MATCH gate reads (Accounts
   * satisfies it structurally; same instance the loops runner gets). Absent → the most-specific
   * account attaches UNCHECKED and the terminal-manager spawn guard is the loud backstop.
   */
  accounts?: ProfileLookup;
  /**
   * SPEC-TESTING §1.4 — the assistant Brain's profile id(s), read AT RUNTIME (the id is machine-
   * local, never hardcoded). Routing a builder onto one is refused at the start gate and at
   * per-sortie spawn. Absent → no reserved-account check.
   */
  reservedProfileIds?: () => ReadonlySet<string>;
  /**
   * SPEC-LOOP W6 — the code-review store (structural slice). The completion evaluator reads it
   * SYNCHRONOUSLY on its green branch (getFor) to gate `requireReview` termination; the review-fix
   * assignment resolves its pin exclusively by id (getById — a replaced/pruned record must be loud);
   * the escalation bundle reads latestFor. Absent + requireReview → attention, never a silent green
   * (review is LOAD-BEARING — the docs never-gates posture does NOT extend to it).
   */
  reviews?: {
    getFor(missionId: string, sortieId: string): ReviewRecord | undefined;
    getById(recordId: string): ReviewRecord | undefined;
    latestFor(missionId: string): ReviewRecord | undefined;
  };
  /**
   * SPEC-SKILLS-GATE — the loop-green gate-evidence store (structural slice). The completion evaluator
   * reads it SYNCHRONOUSLY on its green branch (getFor) to enforce the create-frozen
   * loop.requiredGates; listFor serves the status/report consumers. Absent while requiredGates is
   * non-empty → attention, never a silent green (LOAD-BEARING — the reviews posture above, not the
   * docs never-gates one).
   */
  gates?: {
    getFor(missionId: string, gateId: string): GateEvidenceRecord | undefined;
    listFor(missionId: string): GateEvidenceRecord[];
  };
  /**
   * SPEC-RESEARCH W9 — the research-finding store (structural slice). `getFor` is the reconcile-time
   * gate's read (synchronous, in-memory — safe inside the reconcile, the same class as the evaluator's
   * ReviewStore reads); `listFor` feeds the spawn-time digest, the re-planner bundle and the report.
   * ABSENT on a research sortie ⇒ attention, never a skip: an unreadable store must not let a
   * finding-less researcher land (the W6 reviews-unavailable posture).
   */
  research?: {
    getFor(missionId: string, sortieId: string): ResearchRecord | undefined;
    listFor(missionId: string): ResearchRecord[];
  };
  /**
   * SPEC-PLANNER §4 — the consult bridge, injected by the integrator (missions.ts may NOT import mail /
   * MissionControl — the planDraft dep-direction rule). `getById` reads the escalating record's persisted
   * consult; `ask` writes the consult + sends the pointer mail + fires the send-time nudge (a server
   * closure); `resolve` closes one; `renudge` re-alerts the pane at the half-deadline / after a respawn;
   * `migrate` re-homes open consults AND unread mail onto a respawned pane and returns the count. Absent →
   * a planner-bound mission's escalation falls through to the codex Brain path (never a silent stall).
   */
  consults?: {
    getById(id: string): PlannerConsult | undefined;
    ask(input: { missionId: string; terminalId: string; kind: 'replan'; question: string; payload: PlanRevisionBundle }): PlannerConsult;
    resolve(id: string, status: 'applied' | 'rejected' | 'expired', reason?: PlannerConsult['expireReason']): void;
    renudge(consult: PlannerConsult): void;
    migrate(missionId: string, fromTid: string, toTid: string): number;
    /** Expire every OPEN consult for a mission (the terminal-transition settle); enumerates openFor. */
    settle(missionId: string, reason: PlannerConsult['expireReason']): void;
    /** Re-anchor every OPEN consult's active clock to now (resume), so a pause longer than a clock
     *  doesn't expire a consult the planner never got a live window for. Resets, never disables. */
    reanchor(missionId: string): void;
  };
  /** SPEC-PLANNER §5 (DEC-P2) — the two consult clocks, intEnv-wired by the integrator (CT_CONSULT_*).
   *  Absent alongside a wired `consults` → the clocks never fire (the consult would only ever advance on
   *  answer); present is the shipped path. */
  consultTimeouts?: { deliverMs: number; answerMs: number };
  /** SPEC-PLANNER §8 (DEC-P6) — the bounded respawn of a lost planner pane, a server.ts closure wrapping
   *  createTerminal (a seconds-long await, the startSortie loops.create class). Absent → a lost planner is
   *  unrecoverable (giveUpEscalation), never a silent stall. */
  plannerSpawn?: (mission: Mission) => Promise<Terminal>;
  /** SPEC-PLANNER §8 (P2) — best-effort kill of a freshly respawned pane orphaned when an abort landed
   *  during the respawn await. A server.ts closure over terminal-manager.killTerminal. Absent → the
   *  orphan is left for the reaper (harmless: it is purpose:'planner' on a now-terminal mission). */
  plannerKill?: (terminalId: string) => void;
  /**
   * SPEC-TERMINAL-OPS §3.3 — is there a free terminal slot for this project right now? Composed by the
   * integrator from the SAME exported counting helper the createTerminal funnel uses, so the two can
   * never disagree: if they did, the funnel's throw would land in startSortie's catch and park the
   * sortie + mission at attention, where the design promises a bounded wait instead. Absent → no cap
   * awareness (the funnel's throw remains the backstop).
   */
  terminalCapacity?: (projectId: string) => { ok: boolean; detail: string };
}

export class Missions {
  /** Missions whose reconcile/advance is running — serializes tick-drive vs route-advance. */
  private busy = new Set<string>();
  private timer?: NodeJS.Timeout;
  /** SPEC-TERMINAL-OPS §3.3 — when each cap-deferred sortie STARTED waiting, keyed `<missionId>:<sortieId>`.
   *  Stamped once and never re-stamped (re-stamping would reset the wait and restore a silent stall);
   *  cleared when the sortie starts, faults, or its mission is aborted. Transient by design: a Tower
   *  restart drops it and the wait re-anchors on the next tick — bounded again, the same accepted
   *  semantics as the loop runtime's deferSince. */
  private capWait = new Map<string, number>();

  constructor(private deps: MissionsDeps) {}

  /** Drop every cap-wait anchor belonging to one mission (SPEC-TERMINAL-OPS §3.3). Called wherever the
   *  mission leaves — or re-enters — the running state, so a wait is always measured from a moment the
   *  mission was actually trying to start sorties. */
  private clearCapWait(missionId: string): void {
    for (const key of [...this.capWait.keys()]) {
      if (key.startsWith(`${missionId}:`)) this.capWait.delete(key);
    }
  }

  // ---- reads ----
  list(): Mission[] {
    return this.deps.store.listMissions();
  }
  get(id: string): Mission | undefined {
    return this.deps.store.getMission(id);
  }

  /** Validate + mint a DRAFT mission (nothing runs until start()).
   *  SPEC-SKILLS-GATE — `derived` carries the route-derived loop-green gate set. It is the ONLY way a
   *  requiredGates/rerunGates can enter a mission: deliberately a SECOND ARGUMENT rather than a
   *  CreateMissionRequest field, so a raw-API body smuggling `loop.requiredGates` is structurally inert
   *  (nothing reads it — no strip-trap to miss). Only the POST /api/missions route supplies it. */
  create(req: CreateMissionRequest, derived?: { requiredGates?: string[]; rerunGates?: string[] }): Mission {
    const project = this.deps.store.getProject(req.projectId);
    if (!project) throw new Error('unknown projectId');
    const name = req.name?.trim();
    const goal = req.goal?.trim();
    if (!name) throw new Error('name is required');
    if (!goal) throw new Error('goal is required');
    const provider = req.provider ?? 'claude-code';
    if (provider === 'shell') throw new Error('a mission needs an agent provider, not a plain shell');
    if (!Array.isArray(req.phases) || req.phases.length === 0) {
      throw new Error('a mission needs at least one phase');
    }
    // Build the persisted phases/sorties (ids, registry checks, markers). Extracted so the W3 draft
    // redraft re-enters planner output through the exact same trusted builder (buildPhases: fresh ids + role/stage whitelists).
    const phases = buildPhases(req.phases);
    if (!phases.some((p) => p.sorties.length > 0)) {
      throw new Error('a mission needs at least one sortie');
    }
    const now = new Date().toISOString();
    // SPEC-SKILLS-GATE — freeze the loop-green gate set NOW, from the derived arg only (see the
    // signature note). rerunGates is clamped to a subset of requiredGates so the boundary can never
    // owe freshness to a gate it does not require.
    const frozenGates = derived?.requiredGates?.length ? [...derived.requiredGates] : undefined;
    const frozenRerun = frozenGates && derived?.rerunGates?.length
      ? derived.rerunGates.filter((g) => frozenGates.includes(g))
      : [];
    // SPEC-LOOP §1 — the iterate-until-green loop config. Caps clamped at create (the boundary reads
    // THIS, never live project config); round starts at 1 (the authored plan) and its RoundRecord
    // is the authored seed. Absent req.loop → a classic linear mission (evaluator never engages).
    const loop: MissionLoop | undefined = req.loop
      ? {
          maxRounds: clampInt(req.loop.maxRounds, 1, 8, 4),
          mechanicalRounds: clampInt(req.loop.mechanicalRounds, 0, 4, 2),
          sortieBudget: clampInt(req.loop.sortieBudget, 1, 64, 24),
          round: 1,
          ...(req.loop.requirePlanReview === true ? { requirePlanReview: true } : {}),
          ...(req.loop.requireReview === true ? { requireReview: true } : {}),
          ...(req.loop.investigate === true ? { investigate: true } : {}),
          ...(frozenGates ? { requiredGates: frozenGates } : {}),
          ...(frozenRerun.length ? { rerunGates: frozenRerun } : {}),
          rounds: [{ n: 1, kind: 'authored', appendedAt: now }],
        }
      : undefined;
    const mission: Mission = {
      id: shortId(),
      projectId: project.id,
      name,
      goal,
      provider,
      ...(typeof req.model === 'string' && req.model.trim() ? { model: req.model.trim() } : {}),
      // SPEC-EFFORT §1 — mission-tier reasoning-effort default (resolved at the MISSION rank).
      ...(typeof req.effort === 'string' && req.effort.trim() ? { effort: req.effort.trim() } : {}),
      profileId: req.profileId,
      // Stays the RAW request value ON PURPOSE: its only consumer passes it into loops.create (below),
      // where the loops.ts identity binding resolves it against the project default. Do not "resolve" it here.
      identityId: req.identityId,
      // SPEC-LOOP §1 — a loop mission is autonomous by definition: the completion evaluator runs on
      // the tick's auto-advance drive. Force 'auto' server-side (not just in the composer) so ANY
      // caller — a raw API create, a future proposal action — can't mint a gate-mode loop that would
      // stall at a phase-gate every round.
      advance: loop ? 'auto' : req.advance === 'auto' ? 'auto' : 'gate',
      maxIterationsPerSortie: clampInt(req.maxIterationsPerSortie, 1, 50, 8),
      concurrency: clampInt(req.concurrency, 1, 4, 1),
      // SPEC-STORYLOOP §4 — carry the regression-gate suite through create; unset = no gate.
      // SPEC-LOOP §2 — a loop mission NEVER carries a gateSuite: its regression check is the round's
      // own verify phase, and a separate per-advance gate is incompatible with incremental round
      // landing — it would either stall the loop on a partial-fix red suite or be skipped and
      // silently drop an orthogonal gate (e.g. a lint/unit suite) unguarded. The composer disables
      // the gate field in loop mode; enforce it server-side here so ANY caller — a raw API create
      // included — can't mint a gated loop.
      ...(!loop && typeof req.gateSuite === 'string' && req.gateSuite.trim() ? { gateSuite: req.gateSuite.trim() } : {}),
      phases,
      activePhase: -1,
      ...(loop ? { loop } : {}),
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.upsertMission(mission);
    audit('mission.create', { missionId: mission.id, projectId: project.id, provider, name, phases: phases.length });
    this.emit(mission);
    return mission;
  }

  // ---- operator control actions ----

  /** draft/paused/attention → running. First start enters phase 0. */
  async start(id: string): Promise<Mission> {
    const mission = this.mustMission(id);
    if (mission.status !== 'draft' && mission.status !== 'paused' && mission.status !== 'attention') {
      throw new Error(`mission cannot start from status '${mission.status}'`);
    }
    // Serialize start() against the detached completion drive (mirrors advance() :373). A start that
    // lands during the W2 planner await would otherwise re-arm phase 0 while the escalated append
    // re-drives, so it is guarded (retry() carries the same guard).
    if (this.busy.has(id)) throw new Error('mission is busy — retry in a moment');
    // Tail-shape: a loop mission's mechanical first round appends a [fix] phase whose predecessor
    // MUST be a single-sortie verify runner (assignFixerPhase :832). The authored plan therefore has to
    // END in a single-sortie stage:'verify' phase — the composer template guarantees it; enforce it here
    // (a draft is editable up to start, so this is the right gate) rather than dead-ending mid-loop.
    if (mission.loop) assertLoopTail(mission.phases);
    // SPEC-LOOP W3 (G4) — a `requirePlanReview` loop mission may not START without a passing plan grade
    // for the CURRENT plan. Scoped to the FIRST start only (activePhase < 0): start() also RESUMES a
    // paused/attention mission (activePhase >= 0), and gating a resume would brick every paused loop.
    if (mission.activePhase < 0 && mission.loop?.requirePlanReview) {
      const review = mission.planReview;
      if (!review || review.verdict !== 'pass' || review.phasesHash !== computePhasesHash(mission.phases)) {
        throw new Error(
          'this mission requires a passing plan review before it can start — run “Review plan” (and clear any blocking findings) first',
        );
      }
    }
    // Pre-start gate: resolve + validate EVERY sortie's route across EVERY phase before any
    // terminal spawns, so an unresolvable route in a later phase never launches an earlier one. A
    // draft is legitimately editable (a def may be added before start), so this hard gate lives at
    // start, not create. Missing secrets are warnings, not blocks (§2.3a).
    const report = validateMissionRoutes(
      mission,
      this.deps.routing?.layersFor(mission.projectId) ?? { global: {} },
      this.deps.providerStore,
      this.deps.accounts,
      this.deps.reservedProfileIds?.(),
    );
    if (report.hasErrors) {
      const detail = report.sorties
        .filter((s) => s.errors.length > 0)
        .map((s) => `${s.sortieName}: ${s.errors.join(', ')}`)
        .join('; ');
      throw new Error(`cannot start mission — unresolvable routes: ${detail}`);
    }
    // SPEC-LOOP W6 (DEC-LOOP-1) — a `requireReview` loop mission needs a routable 'review-judge' agent
    // that is NOT the codex Brain. The boundary mints review-judge sorties at RUNTIME (even when the
    // authored plan carries no review phase — the self-heal), so an unroutable or Brain-routed reviewer
    // would otherwise surface only AFTER the suite goes green (confusing), or route the review to the
    // Brain (the reviewer-is-never-the-Brain rule). Resolve + validate using the operator's AUTHORED
    // reviewer route (its per-sortie provider/model/account override, when a review phase was authored) —
    // NOT the bare role default, or a mission whose Review role defaults to the Brain but whose authored
    // reviewer has a valid non-Brain override would be false-rejected. Falls back to the bare role default
    // when no review phase is authored (a pure API/Jarvis requireReview mission), so a genuinely Brain-only
    // / unroutable review-judge role still fails fast. Runs on every start (like the route gate above).
    if (mission.loop?.requireReview) {
      const authored = authoredReviewerRoute(mission);
      const resolved = resolveRouting(
        {
          role: 'review-judge',
          ...(authored?.provider ? { provider: authored.provider } : {}),
          ...(authored?.model ? { model: authored.model } : {}),
          // SPEC-EFFORT §2 — carry the authored reviewer's effort so an inherited/self-heal reviewer keeps it.
          ...(authored?.effort ? { effort: authored.effort } : {}),
          ...(authored?.profileId ? { profileId: authored.profileId } : {}),
        },
        mission,
        this.deps.routing?.layersFor(mission.projectId) ?? { global: {} },
        this.deps.providerStore,
        [],
        this.deps.accounts,
      );
      const check = validateRoute(resolved.provider, resolved.model, this.deps.providerStore, {
        explicitProfileId: authored?.profileId,
        resolvedProfileId: resolved.profileId,
        profiles: this.deps.accounts,
        reservedProfileIds: this.deps.reservedProfileIds?.(),
      }, undefined, resolved.effort);
      if (check.errors.length > 0) {
        throw new Error(
          `cannot start mission — the required code review has no routable 'review-judge' agent (route it to a strong non-assistant model in Settings → Routing): ${check.errors.join('; ')}`,
        );
      }
    }
    // D3 ⟦J5⟧: WARNINGS (e.g. a declared secret not yet set) don't block the start, but they must
    // not vanish silently — write each into its sortie's `note` (visible on the mission card +
    // detail) and audit it, so a best-effort route concern is surfaced to the operator at launch.
    for (const s of report.sorties) {
      if (s.warnings.length === 0) continue;
      const note = `route warnings: ${s.warnings.join('; ')}`;
      this.mutateSortie(id, s.sortieId, (sortie) => ({ ...sortie, note }));
      audit('mission.route-warning', { missionId: id, sortieId: s.sortieId, warnings: s.warnings });
    }
    // SPEC-LOOP W6 — record the mission's base commit on FIRST start so the reviewer's diff range
    // (baseSha..HEAD) and the report's base metadata are grounded. AWAITED (not fire-and-forget) BEFORE
    // the running patch below: otherwise a requireReview mission whose review phase is at/near index 0
    // could reconcile assignReviewPhase before the async rev-parse resolved baseSha and route to attention
    // on a healthy repo. recordBaseSha handles a rev-parse failure internally (audits, leaves baseSha
    // unset) and never throws, so awaiting is safe. SPEC-TERMINAL-OPS §6 — for EVERY mission with no base
    // yet, not just a loop mission: an operator-authored review sortie can ride any mission's plan.
    if (mission.activePhase < 0 && !(mission.baseSha ?? mission.loop?.baseSha)) {
      await this.recordBaseSha(id);
    }
    // Re-read after the rev-parse await (the sole yield between the entry status guard and this patch).
    // A concurrent abort()/pause() landing in that window changed status; patching to 'running' off the
    // stale entry snapshot would resurrect it — spending against an aborted mission that already emitted
    // its delivery report, or overriding a just-issued pause. recordBaseSha itself never touches status,
    // so ANY difference from the entry status means a concurrent op won — bail (a membership check can't
    // tell an entry 'paused' resume from a mid-await pause; both read 'paused'). guard→patch below is
    // synchronous — Node's event loop is the only atomicity, exactly as appendRound relies on.
    const live = this.deps.store.getMission(id);
    if (!live || live.status !== mission.status) {
      throw new Error(
        `mission changed state during start (was '${mission.status}', now '${live?.status ?? 'gone'}') — not started`,
      );
    }
    audit('mission.start', { missionId: id }); // only after the guard: a bailed start must not log a phantom start
    // SPEC-TERMINAL-OPS §3.3 — drop this mission's cap-wait anchors on the way back to running. A
    // sortie that was waiting for a slot when the operator paused must not inherit the pre-pause
    // clock: resuming into a still-full fleet would then instantly "fault" claiming no slot freed in
    // 30 minutes, when the wait was really the pause. Same lesson the loop runtime records for its
    // own defer anchor (loops.ts, resume clears deferSince).
    this.clearCapWait(id);
    // SPEC-PLANNER §5 — re-anchor this mission's OPEN consults on the way back to running, for the SAME
    // reason clearCapWait exists above: the consult clocks are absolute wall-clock, so a pause longer than
    // deliverMs/answerMs would otherwise expire an open consult on the first post-resume tick and burn an
    // escalation attempt on a window the planner never got live. A no-op on a mission with no planner /
    // no open consults. It resets the clock, never disables it — the consult still gates if never answered.
    this.deps.consults?.reanchor(id);
    const patch: Partial<Mission> = { status: 'running' };
    if (live.activePhase < 0) patch.activePhase = 0;
    return this.patch(id, patch);
  }

  /**
   * SPEC-LOOP W6 / SPEC-TERMINAL-OPS §6 — record the mission's base commit (top-level `baseSha`, for
   * EVERY mission), AWAITED at first start (before the running patch) so a review phase never reconciles
   * before it is set. The `git rev-parse HEAD` is the only await; its re-read + patch is a SINGLE
   * synchronous block after it (no interior await). The write is a TOP-LEVEL scalar patch, so it cannot
   * clobber a concurrent loop-object write at all. Skips if a base is already recorded at either location
   * (the legacy `loop.baseSha` of a pre-§6 record counts) or the mission vanished. This is the SINGLE
   * writer — a second write location would be a drift bug. A rev-parse failure audits only and NEVER
   * throws, leaving baseSha unset: for a plain loop that is merely absent report metadata, but for a
   * mission carrying a review sortie the review phase then routes to attention rather than hand the
   * reviewer an unresolvable range (assignReviewPhase) — a required review never inspects an empty diff.
   */
  private async recordBaseSha(id: string): Promise<void> {
    const mission = this.deps.store.getMission(id);
    if (!mission || mission.baseSha || mission.loop?.baseSha) return;
    const project = this.deps.store.getProject(mission.projectId);
    if (!project) return;
    const res = await git.git(project.repoPath, ['rev-parse', 'HEAD']);
    const sha = res.ok ? res.stdout.trim() : '';
    if (!sha) {
      audit('mission.basesha.fail', { missionId: id, error: res.stderr.trim().slice(0, 200) });
      return;
    }
    // Re-read + patch in one synchronous block: skip if set concurrently / gone.
    const live = this.deps.store.getMission(id);
    if (!live || live.baseSha || live.loop?.baseSha) return;
    this.patch(id, { baseSha: sha });
    audit('mission.basesha', { missionId: id, baseSha: sha });
  }

  /**
   * SPEC-LOOP W3 (G4) — store the codex Brain's pre-execution plan grade. DRAFT-ONLY (activePhase < 0):
   * a review only ever authorizes a not-yet-started plan. Hash-CAS: refuse to store a review whose
   * phasesHash does not match the CURRENT plan (the plan changed under the grade — a stale pass must
   * never authorize new phases). Writes via the patch() choke point; audits.
   */
  setPlanReview(id: string, review: MissionPlanReview): Mission {
    const mission = this.mustMission(id);
    if (mission.activePhase >= 0) throw new Error('plan review applies only to a draft (not-yet-started) mission');
    if (review.phasesHash !== computePhasesHash(mission.phases)) {
      throw new Error('plan changed since it was graded — re-review the current plan');
    }
    audit('mission.plan-review.store', { missionId: id, verdict: review.verdict, findings: review.findings.length });
    return this.patch(id, { planReview: review });
  }

  /**
   * SPEC-PLANNER §3 — bind a planner terminal to a mission (the attach route, and the spawn-at-create
   * flow, both call this). Writes through patch() so the mission-state SSE frame fires. The route owns
   * ALL the refusals (unknown/killed pane, another mission's planner, a live loop's terminal, a reserved
   * profile, the idle preflight); this method just records the resolved binding. No status change.
   */
  attachPlanner(id: string, binding: MissionPlanner): Mission {
    this.mustMission(id);
    audit('mission.planner.attach', { missionId: id, terminalId: binding.terminalId, spawned: binding.spawned === true });
    return this.patch(id, { planner: binding });
  }

  /**
   * SPEC-PLANNER §3 — detach the planner (an EXPLICIT operator choice to fall back to the codex Brain,
   * never a silent fallback). Clears `mission.planner` (patchMission's spread carries the undefined over
   * and JSON.stringify drops the key). Open consults are expired by the caller (the route, which has the
   * consult store) — this method only clears the binding. Safe mid-escalation: it touches no CAS field.
   */
  detachPlanner(id: string): Mission {
    this.mustMission(id);
    audit('mission.planner.detach', { missionId: id });
    return this.patch(id, { planner: undefined });
  }

  /**
   * SPEC-PLANNER §8 — mark every mission whose live planner is this terminal as 'lost' (the reconciler's
   * onVanish fan-out). The tick's ask path owns recovery (lazy respawn, DEC-P6); open consults are left
   * in place. onVanish already forgot the pane's hook token, so its replies fail closed at 401 at once.
   */
  markPlannerLost(terminalId: string): void {
    for (const m of this.deps.store.listMissions()) {
      if (m.planner?.terminalId !== terminalId || m.planner.state !== 'live') continue;
      audit('mission.planner.lost', { missionId: m.id, terminalId });
      this.patch(m.id, { planner: { ...m.planner, state: 'lost' } });
    }
  }

  /** SPEC-PLANNER §8 — expire every OPEN consult for a mission on its FIRST terminal transition (the W7
   *  fireLoopSettle pattern). Guarded + fire-and-forget: a settle failure must never break the done/failed
   *  write. The dep's `settle` closure enumerates openFor(missionId) and resolves each (the store owns the
   *  enumeration; missions.ts holds only getById). No-op without a consults dep. */
  private fireConsultSettle(mission: Mission): void {
    try {
      this.deps.consults?.settle(mission.id, 'mission-ended');
    } catch (err) {
      console.error('[missions] consult settle failed:', err);
    }
  }

  /**
   * SPEC-LOOP W3 (G4) — replace a DRAFT mission's plan with a re-drafted one (the auto-redraft after a
   * blocked grade). DRAFT-ONLY (activePhase < 0). For a LOOP mission the trailing single-sortie verify
   * phase is the loop's regression evidence and is NOT the planner's to rewrite: preserve the CURRENT
   * verify tail VERBATIM (a fresh sortie id is fine) and replace ONLY the WORK phases from planner output
   * (buildPhases → fresh ids + the ROLE_IDS/PHASE_STAGES whitelists, so redrafted output re-enters through
   * the same trusted builder), then re-assert the loop tail so the plan stays loop-shaped. Any planner-
   * emitted verify phase is dropped (the authored tail wins). Clears the stale planReview (it was bound to
   * the OLD plan's hash). Writes via patch().
   */
  replaceDraftPhases(id: string, reqPhases: CreateMissionRequest['phases']): Mission {
    const mission = this.mustMission(id);
    if (mission.activePhase >= 0) throw new Error('cannot redraft a mission that has already started');
    const workPhases = buildPhases(reqPhases);
    let nextPhases: MissionPhase[];
    if (mission.loop) {
      const tail = mission.phases[mission.phases.length - 1];
      if (!tail || tail.stage !== 'verify' || tail.sorties.length !== 1) {
        throw new Error('loop mission draft is missing its verify tail — cannot redraft');
      }
      // Preserve the verify tail VERBATIM with a fresh sortie id, clean/pending (a draft's runner is
      // already pending with no loop; refresh defensively). Drop any verify phase the planner emitted.
      const runner = tail.sorties[0]!;
      const verifyTail: MissionPhase = {
        ...tail,
        id: shortId(),
        sorties: [{ ...runner, id: shortId(), status: 'pending', loopId: undefined, note: undefined }],
      };
      const work = workPhases.filter((p) => p.stage !== 'verify');
      nextPhases = [...work, verifyTail];
      assertLoopTail(nextPhases);
    } else {
      nextPhases = workPhases;
    }
    if (nextPhases.length === 0 || !nextPhases.some((p) => p.sorties.length > 0)) {
      throw new Error('a redrafted plan needs at least one phase with a sortie');
    }
    audit('mission.plan-redraft', { missionId: id, phases: nextPhases.length });
    return this.patch(id, { phases: nextPhases, planReview: undefined });
  }

  /** Stop starting/advancing; in-flight loops continue (honest — mirrors loop pause). */
  pause(id: string): Mission {
    const mission = this.mustMission(id);
    if (mission.status === 'done' || mission.status === 'failed') return mission;
    audit('mission.pause', { missionId: id });
    return this.patch(id, { status: 'paused' });
  }

  /** Mission → failed; stop every non-terminal sortie loop. A mid-flight advance batch
   *  re-reads the mission before each land and halts once it sees 'failed'. */
  abort(id: string): Mission {
    const mission = this.mustMission(id);
    if (mission.status === 'failed' || mission.status === 'done') return mission;
    for (const phase of mission.phases) {
      for (const sortie of phase.sorties) {
        if (!sortie.loopId) continue;
        const loop = this.deps.loops.get(sortie.loopId);
        if (loop && !isTerminalLoop(loop.status)) {
          // loops.land re-reads the loop after its merge and skips its final patch if we
          // stopped it mid-land, so a concurrent advance batch halts cleanly.
          try { this.deps.loops.stop(sortie.loopId, 'mission aborted'); } catch { /* already gone */ }
        }
      }
    }
    // SPEC-TERMINAL-OPS §3.3 — drop this mission's cap-wait anchors: nothing of it will start again,
    // and a retried sortie deserves a fresh wait rather than one inherited from before the abort.
    this.clearCapWait(id);
    audit('mission.abort', { missionId: id });
    return this.patch(id, { status: 'failed', stopReason: 'aborted by operator' });
  }

  /** ⟦DP-B6⟧ Archive a mission so the Board can be cleared without rewriting history. Allowed for a
   *  FINISHED mission (done|failed) OR a 'draft' — a never-started composition is manually archivable
   *  (drafts are NEVER bulk-swept by Clear finished; the route enforces that). Any other status is
   *  refused (the route maps it to a 409). Idempotent: an already-archived mission is returned
   *  unchanged. Sets archivedAt via patch(), which emits the mission-state SSE frame (§3). */
  archive(id: string): Mission {
    const mission = this.mustMission(id);
    if (mission.archivedAt) return mission; // already archived — a no-op
    if (mission.status !== 'done' && mission.status !== 'failed' && mission.status !== 'draft') {
      throw new Error(`mission "${mission.name}" is ${mission.status} — only a done, failed, or draft mission can be archived`);
    }
    audit('mission.archive', { missionId: id });
    return this.patch(id, { archivedAt: new Date().toISOString() });
  }

  /** Retry a failed sortie: clear its loop link, set pending, put the mission back to running
   *  so the tick reconciles and re-creates a builder. The old loop stays for inspection. */
  retry(missionId: string, sortieId: string): Mission {
    const mission = this.mustMission(missionId);
    // Serialize retry() against the detached completion drive (mirrors
    // advance() :373). Without this, a retry during the W2 planner await re-arms a sortie WITHOUT
    // changing the completion CAS tuple, so the escalated append advances past it and strands it
    // 'pending' forever.
    if (this.busy.has(missionId)) throw new Error('mission is busy — retry in a moment');
    const found = findSortie(mission, sortieId);
    if (!found) throw new Error('unknown sortie');
    // Retry re-arms the sortie AND drives the mission back to 'running'. An ABORTED (failed) or done
    // mission is terminal — the operator ended it — so a retry click must not resurrect it (a no-change
    // 'landed' sortie can outlive an abort in a multi-sortie phase, and before it became retryable only
    // an 'attention' sortie could reach here). A paused mission is NOT terminal: retry re-drives the
    // sortie and resumes, exactly as retrying an 'attention' sortie on a paused mission always has.
    if (mission.status === 'failed' || mission.status === 'done') {
      throw new Error(`cannot retry a sortie on a ${mission.status} mission`);
    }
    // A no-change 'landed' sortie (its builder produced zero commits) is retryable too, so an operator
    // can re-drive a builder that may have wrongly claimed nothing to do — but ONLY while the mission
    // is still on that sortie's phase. The tick reconciles only the active phase, so re-arming a
    // sortie in an already-advanced phase would strand it 'pending' forever. Every other 'landed'
    // sortie is a real merge and stays terminal. (An 'attention' sortie always blocks phase advance,
    // so it is inherently in the active phase — no extra guard needed there.)
    const inActivePhase = found.phase === mission.phases[mission.activePhase];
    // SPEC-TESTING §3 — a docs-marked (docsFromRun set) 'landed' sortie is retryable in place too:
    // the never-gates mapping resolves a failed/unmerged docs sortie to 'landed' rather than
    // attention, so the docs marker (NOT noChangeLanded — that means "zero commits", wrong for a
    // land-conflict docs sortie) is what keeps it re-drivable. Same active-phase rule as no-change.
    const docsRetryable = found.sortie.docsFromRun !== undefined && found.sortie.status === 'landed';
    // SPEC-LOOP W6 — a review sortie resolves to 'landed' either as a no-change stop OR via the
    // refuse-to-land guard (a committed reviewer, unmerged-branch note; NOT noChangeLanded). Its
    // reviewFromRange pin is what keeps it re-drivable in place (same active-phase rule as docs).
    const reviewRetryable = found.sortie.reviewFromRange !== undefined && found.sortie.status === 'landed';
    // SPEC-RESEARCH W9 — a LANDED research sortie is retryable in place: its resubmission REPLACES the
    // stored finding, so a retry is a real do-over rather than a no-op. (An attention'd one is already
    // covered by the status === 'attention' arm.) No re-arm branch is needed: the marker is never
    // cleared and there is no pin to reset, so the researcher simply re-runs its authored question.
    const researchRetryable = found.sortie.researchSortie === true && found.sortie.status === 'landed';
    // SPEC-LOOP W7 — an investigator lands either as a no-change stop OR via the refuse-to-land guard (a
    // committed investigator, NOT noChangeLanded). Its investigateFromRun pin keeps it re-drivable in place
    // (same active-phase rule); the triage route is idempotent, so a retry of an already-triaged run
    // completes cleanly instead of 409-looping.
    const investigateRetryable = found.sortie.investigateFromRun !== undefined && found.sortie.status === 'landed';
    const retryable =
      found.sortie.status === 'attention' ||
      ((found.sortie.noChangeLanded === true || docsRetryable || reviewRetryable || investigateRetryable || researchRetryable) && inActivePhase);
    if (!retryable) {
      throw new Error('only a sortie in attention (or a no-change landed / docs / review / investigate / research sortie in its active phase) can be retried');
    }
    // If the sortie's linked loop is still 'gated' (non-terminal), stop it before
    // clearing loopId. reconcileSortie re-links ANY non-terminal loop for this (mission, sortie), so a
    // live gated loop would be re-adopted on the next tick and the re-arm below would be a silent
    // no-op. Stopping it makes the loop terminal so the re-arm actually spawns a fresh builder.
    if (found.sortie.loopId) {
      const linked = this.deps.loops.get(found.sortie.loopId);
      if (linked && linked.status === 'gated') {
        try { this.deps.loops.stop(found.sortie.loopId, 'retried by operator'); } catch { /* already gone */ }
      }
    }
    this.mutateSortie(missionId, sortieId, (s) => {
      const next: MissionSortie = { ...s, status: 'pending', loopId: undefined, note: undefined, landDetail: undefined, noChangeLanded: undefined };
      // SPEC-STORYLOOP §3.3 — retrying an already-assigned verify-fixer re-arms its marker so
      // the next tick re-runs the deterministic partition and re-derives its (identical, or, if the
      // runner itself was re-run, fresh-run) bucket. `assignedFrom` set ⇒ this was a fixer.
      if (s.assignedFrom !== undefined) next.verifyFixer = true;
      // SPEC-TESTING §3 — retrying a docs sortie re-arms its marker the same way (assignDocsPhase
      // re-finalizes the task next tick); the pin is cleared so a re-run runner's fresher project
      // run can be picked up (a sibling's surviving pin still wins when the phase has one).
      if (s.docsFromRun !== undefined) {
        next.docsSortie = true;
        next.docsFromRun = undefined;
      }
      // SPEC-LOOP W6 — re-arm the review markers the same way. A review-fix sortie (assignedFromReview
      // set) re-derives its bucket next tick; a reviewer sortie (reviewFromRange set) re-finalizes its
      // range from the CURRENT baseSha (the pin is cleared so assignReviewPhase re-runs).
      if (s.assignedFromReview !== undefined) next.reviewFixer = true;
      if (s.reviewFromRange !== undefined) {
        next.reviewSortie = true;
        next.reviewFromRange = undefined;
      }
      // SPEC-LOOP — stamp the reviewer JUDGE retry so the PREVIOUS review stops counting at the
      // completion gate AND the agent-facing GET (the researchRetryAt precedent). Read `s` (the original)
      // so both marker forms are caught — reviewSortie (pending) or reviewFromRange (finalized). NOT a
      // review-FIX sortie (assignedFromReview): a fixer lands code and pins its record by id. Without
      // this a retried reviewer that never resubmits terminates the loop clean off the discarded review.
      if (s.reviewSortie === true || s.reviewFromRange !== undefined) next.reviewRetryAt = new Date().toISOString();
      // SPEC-LOOP W7 — re-arm a retried investigator's marker but KEEP its pin (the fixer pattern, NOT
      // docs): write-once triage on the pinned run makes determinism load-bearing, so the retry must
      // re-classify the SAME run — a fresh-run pin would let sibling fixers filter a different triage.
      if (s.investigateFromRun !== undefined) next.investigateSortie = true;
      // SPEC-RESEARCH W9 — stamp the retry so the PREVIOUS finding stops counting. The record is
      // deliberately kept (the operator may want to compare runs), so the stamp is what makes the
      // retry a real do-over: until the new researcher submits, both the gate and the agent's own
      // check read the old record as absent. Without this the check passes on iteration 1 and the
      // sortie re-lands the discarded finding.
      if (s.researchSortie === true) next.researchRetryAt = new Date().toISOString();
      return next;
    });
    audit('mission.sortie.retry', { missionId, sortieId });
    return this.patch(missionId, { status: 'running' });
  }

  /**
   * Land the active phase and advance. Route + auto path. Requires phase-gate (all sorties
   * done) or attention (a prior partial-advance remainder). Serialized per mission by the
   * busy-guard (and per repo by the land lease, wired at the worktree layer).
   */
  async advance(id: string): Promise<Mission> {
    const mission = this.mustMission(id);
    if (mission.status !== 'phase-gate' && mission.status !== 'attention') {
      throw new Error(`advance requires a mission at a phase gate or in attention (status '${mission.status}')`);
    }
    if (this.busy.has(id)) throw new Error('mission is busy — retry in a moment');
    this.busy.add(id);
    try {
      return await this.runAdvance(id);
    } finally {
      this.busy.delete(id);
    }
  }

  /** Draft phases for a goal via the assistant. Thin — the judge plumbing is an injected dep. */
  async plan(projectId: string, goal: string): Promise<CreateMissionRequest['phases']> {
    const project = this.deps.store.getProject(projectId);
    if (!project) throw new Error('unknown projectId');
    const g = goal?.trim();
    if (!g) throw new Error('goal is required');
    if (!this.deps.planDraft) throw new Error('assistant planning unavailable');
    return this.deps.planDraft(project.repoPath, g);
  }

  // ---- the runner ----

  start_(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[missions] tick failed:', err));
    }, TICK_MS);
    this.timer.unref?.();
  }
  stop_(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** How many missions have a drive/advance (possibly a long git worktree op) in flight right now.
   *  Read by the server's graceful shutdown so it can drain before exiting. */
  inFlight(): number {
    return this.busy.size;
  }

  private tick(): Promise<void> {
    // The scan itself is synchronous; each mission's drive runs DETACHED under its own
    // busy-guard (mirroring loops.ts:318-321). Awaiting drives inline would let ONE
    // hung/slow git operation (worktree add on a locked index, a long merge batch)
    // freeze reconciliation for every other mission — git() has no timeout.
    for (const mission of this.deps.store.listMissions()) {
      if (mission.status !== 'running') continue;
      if (this.busy.has(mission.id)) continue; // its previous drive (or an advance) is still in flight
      this.busy.add(mission.id);
      void this.reconcileAndStart(mission.id)
        .catch((err) => console.error(`[missions] drive ${mission.id} failed:`, err))
        .finally(() => this.busy.delete(mission.id));
    }
    return Promise.resolve();
  }

  private async reconcileAndStart(id: string): Promise<void> {
    const mission = this.deps.store.getMission(id);
    if (!mission || mission.status !== 'running') return;

    // A running mission is always inside a phase; enter phase 0 on the first drive.
    const activePhase = mission.activePhase;
    if (activePhase < 0) {
      this.patch(id, { activePhase: 0 });
      return; // reconcile on the next tick with the phase active
    }
    if (activePhase >= mission.phases.length) {
      // SPEC-LOOP §2 (done site a) — a loop mission does NOT finish at the last phase; the boundary
      // evaluator (running HERE, inside the detached tick drive under busy) decides green→done,
      // red+cap→attention, or red+budget→append the next round. finishMission stays the non-loop path.
      if (mission.loop) {
        await this.evaluateCompletion(id);
        return;
      }
      this.finishMission(id);
      return;
    }
    const phase = mission.phases[activePhase];
    if (!phase || phase.sorties.length === 0) {
      // Empty phase → skip with an audit note.
      audit('mission.phase.skip', { missionId: id, phase: activePhase });
      this.patch(id, { activePhase: activePhase + 1 });
      return;
    }

    // 1. Reconcile each active-phase sortie's status from its loop (derived truth + re-link).
    const newSorties = phase.sorties.map((s) => this.reconcileSortie(mission, s));

    // 2. Roll the sortie statuses up to a mission status.
    const roll = rollup(newSorties);
    const nextStatus: MissionStatus =
      roll === 'attention'
        ? 'attention'
        : roll === 'phase-complete' && mission.advance === 'gate'
          ? 'phase-gate'
          : 'running';

    // Single write: reconciled sorties + rolled-up status (only when something actually moved,
    // so an idle tick doesn't emit a redundant mission-state frame every 5s).
    if (nextStatus !== mission.status || newSorties.some((s, i) => sortieChanged(s, phase.sorties[i]!))) {
      this.patch(id, { phases: replacePhaseSorties(mission.phases, activePhase, newSorties), status: nextStatus });
    }

    if (roll === 'attention') {
      audit('mission.attention', { missionId: id, phase: activePhase });
      return; // operator resolves the gated/failed sortie, then start()/retry() re-reconciles
    }
    if (roll === 'phase-complete') {
      if (mission.advance === 'auto') {
        audit('mission.autopilot.advance', { missionId: id, phase: activePhase });
        await this.runAdvance(id); // busy already held
      } else {
        audit('mission.phase-gate', { missionId: id, phase: activePhase });
      }
      return;
    }

    // 2b. SPEC-STORYLOOP §3.3 — if this active phase is a verify-fixer phase awaiting assignment,
    //     partition the runner's e2e failures across its fixers (rewriting each fixer's task) BEFORE
    //     any fixer spawns. Self-guarding + idempotent: once every fixer's marker is cleared it's a
    //     no-op, so calling it each tick is cheap. A malformed template / no parseable runner results
    //     routes the mission to attention (returns a Mission) — never silent empty fixer work.
    const blocked = this.assignFixerPhase(id, activePhase);
    if (blocked) return;

    // 2b'. SPEC-LOOP W6 — if this active phase is a review-fix phase awaiting assignment, partition the
    //      reviewer's CONFIRMED findings across its fixers BEFORE any fixer spawns. Blocking + idempotent
    //      like assignFixerPhase: reviews store absent / no predecessor review phase / pinned record gone
    //      routes the mission to attention (review is LOAD-BEARING — never silent empty fixer work).
    const blockedReview = this.assignReviewFixPhase(id, activePhase);
    if (blockedReview) return;

    // 2c. SPEC-TESTING §3 — if this active phase carries docs-marked sorties, finalize each one's
    //     task from the verify run BEFORE any docs sortie spawns. Unlike the fixer hook it NEVER
    //     blocks (returns void): no kit / no parseable results just clears the marker with a note
    //     and lets the sortie run its authored task. Self-guarding + idempotent like the fixer hook.
    this.assignDocsPhase(id, activePhase);

    // 2c'. SPEC-LOOP W6 — if this active phase carries review-marked sorties, finalize each one's task
    //      from the mission's base commit BEFORE the reviewer spawns. Blocking + idempotent (reviewSortie
    //      is the cleared key): a review with no recorded base commit has no resolvable range, so it
    //      routes to attention rather than ever handing the reviewer an empty diff.
    const blockedReviewAssign = this.assignReviewPhase(id, activePhase);
    if (blockedReviewAssign) return;

    // 2d. SPEC-LOOP W7 — if this active phase carries investigate-marked sorties, finalize the
    //     investigator's task from the previous verify run BEFORE it spawns. Blocking + idempotent like
    //     the fixer hook (investigate is load-bearing — never the docs never-gates shape). The hooks are
    //     marker-disjoint (a sortie is at most one of fixer/docs/review/investigate), so ordering is inert.
    const blockedInv = this.assignInvestigatePhase(id, activePhase);
    if (blockedInv) return;

    // 3. Start pending sorties up to concurrency.
    //    SPEC-RESEARCH W9 — a research phase exists to fan out, but startPending launches only up to
    //    mission.concurrency, so an authored 4-researcher phase would serialize on a concurrency-1
    //    mission. Give THIS PHASE a bigger launch budget (bounded by the same [1,4] clamp the composer
    //    applies) — deliberately NOT a patch to mission.concurrency: a research phase is typically the
    //    mission's FIRST phase, so persisting the raise would silently override the operator's choice
    //    for every BUILD phase that follows, and concurrency 1 is a real decision on missions whose
    //    builders touch overlapping files (the batched land at each phase boundary is where it bites).
    //    The fixer raise persists because it sits on the last work of its round; this one does not.
    //    Under W10's terminal caps a wide fan-out may still WAIT for slots — bounded and visible via
    //    the cap-wait note, and able to reach attention at the ceiling. Expected for fan-out.
    const phaseForBudget = mission.phases[activePhase];
    const launchBudget = phaseForBudget && isResearchPhase(phaseForBudget)
      ? Math.min(4, phaseForBudget.sorties.length)
      : undefined;
    await this.startPending(id, activePhase, launchBudget);
  }

  /** Derive one sortie's status from its loop, re-linking a crash-orphaned builder. */
  private reconcileSortie(mission: Mission, sortie: MissionSortie): MissionSortie {
    if (sortie.status === 'landed') return sortie; // terminal within the mission

    let loopId = sortie.loopId;
    if (!loopId) {
      // A builder may already exist for this (missionId, sortieId) if a prior loops.create
      // succeeded but the mission write didn't land. Re-link the live one instead of dup'ing.
      const existing = this.deps.loops
        .list()
        .filter((l) => l.missionId === mission.id && l.sortieId === sortie.id && !isTerminalLoop(l.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (existing) loopId = existing.id;
      else return sortie.status === 'pending' ? sortie : { ...sortie, status: 'pending' };
    }

    const loop = this.deps.loops.get(loopId);
    if (!loop) return { ...sortie, loopId: undefined, status: 'pending' }; // loop record vanished

    const next = deriveSortieStatus(loop);
    // SPEC-TESTING §3 (never-gates, point 3) — a docs sortie's builder failing or stopping must
    // never block the mission: map what would be 'attention' to a noted 'landed' record instead.
    // NOT noChangeLanded (that means "zero commits"); the docs marker keeps it retryable in place.
    if (next.status === 'attention' && isDocsSortie(sortie)) {
      const out: MissionSortie = { ...sortie, loopId, status: 'landed', note: 'docs sortie failed — non-blocking' };
      delete out.noChangeLanded;
      return out;
    }
    // SPEC-RESEARCH W9 — a research sortie's success is a submitted FINDING, never commits. The
    // no-change path resolves such a loop 'landed' mechanically (it wrote nothing, which is exactly
    // what a well-behaved researcher does), so the check belt cannot be the guarantee — gate HERE, at
    // any would-be finished status: no record for this sortie ⇒ attention, never a silent pass. An
    // absent store is the same answer, not a skip. Re-derived every tick, so it is idempotent and
    // needs no marker mutation; a researcher that later submits and is retried simply passes.
    if (isResearchSortie(sortie) && (next.status === 'landed' || next.status === 'done')) {
      const rec = this.deps.research?.getFor(mission.id, sortie.id);
      // A record from BEFORE this sortie was retried is not this run's work — the sortie id is
      // unchanged by a retry, so the old finding would otherwise answer for the new run.
      // NOTE for anyone comparing this with the review path: the REVIEW equivalents now carry the SAME
      // freshness axis — resolveReviewState here reads reviewRetryAt via isStaleReviewRecord, and
      // resolveReviewContext in server.ts discards a pre-retry loop via isPreRetryReviewLoop. ⟦DEC-4⟧'s
      // post-land attestation flip is preserved: the discarded reviewer's loop is pre-stamp and loses the
      // route, while the replacement's loop is post-stamp and submits a fresh record that reads through.
      const stale = rec !== undefined && sortie.researchRetryAt !== undefined && rec.submittedAt < sortie.researchRetryAt;
      if (!rec || stale) {
        const why = !this.deps.research
          ? 'research store unavailable — the finding cannot be read'
          : stale
            ? 'the finding predates this retry — the retried research sortie submitted nothing (towerctl research submit)'
            // "…or could not be read" because a quarantined research.json (a torn file is renamed to
            // .corrupt-<ts> at boot, loudly) leaves a researcher that DID submit looking empty here.
            // The record still exists in the quarantine copy, so the note must not accuse the agent.
            : 'research sortie finished without a readable finding — it never submitted one, or the finding could not be read (towerctl research submit) — retry it';
        return { ...sortie, loopId, status: 'attention', note: why };
      }
    }
    const out: MissionSortie = { ...sortie, loopId, status: next.status };
    if (next.note !== undefined) out.note = next.note;
    else delete out.note; // clear a stale failure note once the sortie recovers
    if (next.noChangeLanded) out.noChangeLanded = true;
    else delete out.noChangeLanded; // clear once the sortie is re-driven out of the no-change state
    return out;
  }

  /** Start pending sorties, honoring concurrency, re-reading the mission each round.
   *  `minConcurrency` is a per-PHASE launch budget (SPEC-RESEARCH W9): it raises how many sorties this
   *  phase may run at once WITHOUT persisting anything, so a fan-out phase never redefines the
   *  mission's authored concurrency for the phases that follow it. */
  private async startPending(id: string, activePhase: number, minConcurrency?: number): Promise<void> {
    for (;;) {
      const mission = this.deps.store.getMission(id);
      if (!mission || mission.status !== 'running') return;
      const phase = mission.phases[activePhase];
      if (!phase) return;
      const budget = Math.max(mission.concurrency, minConcurrency ?? 0);
      const activeCount = phase.sorties.filter((s) => s.status === 'active').length;
      if (activeCount >= budget) return;
      const pending = phase.sorties.find((s) => s.status === 'pending');
      if (!pending) return;
      // SPEC-TERMINAL-OPS §3.3 — LOAD-BEARING: a cap-deferred sortie stays `pending`, so without this
      // guard the loop would re-pick the same sortie and spin forever. `false` means "stop this round;
      // nothing will free within this drive"; every other outcome changed a status (or exits via the
      // mission-status re-read above), so the loop makes progress.
      if (!(await this.startSortie(id, activePhase, pending.id))) return;
    }
  }

  /** Spawn one sortie's builder loop. A throw → sortie + mission attention (never retry-loop).
   *  Returns false ONLY when the terminal cap deferred this sortie (SPEC-TERMINAL-OPS §3.3), which is
   *  the signal startPending needs to stop the round instead of re-picking the same pending sortie. */
  private async startSortie(id: string, activePhase: number, sortieId: string): Promise<boolean> {
    const mission = this.deps.store.getMission(id);
    if (!mission) return true;
    const sortie = mission.phases[activePhase]?.sorties.find((s) => s.id === sortieId);
    if (!sortie || sortie.status !== 'pending') return true;

    // ⟦DP-7⟧ Resolve this sortie's (provider, model): per-sortie override → role default →
    // mission default → global, provider and model each falling through their OWN chain — plus the
    // ACCOUNT on its own match-gated chain (SPEC-TESTING §1.2). Then validate the resolved
    // route — a bad one routes the sortie to attention with a clean message rather than attempting
    // a spawn that fails opaquely. This is defense in depth behind the start() gate: it also
    // catches a def/secret/account change made AFTER the mission started.
    const { provider, model, effort, profileId } = resolveRouting(
      sortie,
      mission,
      this.deps.routing?.layersFor(mission.projectId) ?? { global: {} },
      this.deps.providerStore,
      [],
      this.deps.accounts,
    );
    // Error-check only at the sortie layer. The SPEC-MODELS §4 / SPEC-EFFORT §2 non-fatal catalog warnings
    // are left to loops.create() below, which re-validates with the knownModelIds/knownEfforts closures and
    // audits loop.start.warn — auditing here too would double the log noise, so no knownModelIds/knownEfforts.
    const routeCheck = validateRoute(provider, model, this.deps.providerStore, {
      explicitProfileId: sortie.profileId,
      resolvedProfileId: profileId,
      profiles: this.deps.accounts,
      reservedProfileIds: this.deps.reservedProfileIds?.(),
    }, undefined, effort);
    if (routeCheck.errors.length > 0) {
      const note = `unresolvable route: ${routeCheck.errors.join('; ')}`;
      this.mutateSortie(id, sortieId, (s) => ({ ...s, status: 'attention', note }));
      audit('mission.sortie.start.fail', { missionId: id, sortieId, error: note });
      this.patch(id, { status: 'attention' });
      return true;
    }

    // SPEC-TERMINAL-OPS §3.3 — a full terminal fleet is a BOUNDED WAIT, not a fault: leave the sortie
    // `pending` with a visible note and let the mission tick re-attempt it (the tick IS the retry loop).
    // The anchor is stamped ONCE and never re-stamped — re-stamping resets the wait and restores the
    // silent stall this shape exists to prevent. Past the ceiling the wait becomes an honest attention.
    // NOTHING may await between this check and loops.create below, or two drives could both pass it.
    const capKey = `${id}:${sortieId}`;
    const capacity = this.deps.terminalCapacity?.(mission.projectId);
    if (capacity && !capacity.ok) {
      const firstDeferral = !this.capWait.has(capKey);
      const since = this.capWait.get(capKey) ?? Date.now();
      this.capWait.set(capKey, since);
      const ceiling = capWaitCeilingMs(mission.maxIterationsPerSortie);
      const waited = Date.now() - since;
      if (waited > ceiling) {
        // The note states EXACTLY what was measured — that this sortie never got a slot in that span.
        // It deliberately does NOT claim no slot ever freed: on a busy fleet slots free and are reused
        // continuously, and a note claiming otherwise would send the operator hunting a phantom.
        const note = `no terminal slot came free for this sortie in ${humanMs(waited)} — ${capacity.detail}`;
        this.mutateSortie(id, sortieId, (s) => ({ ...s, status: 'attention', note }));
        audit('mission.sortie.cap-wait.fault', { missionId: id, sortieId, waitedMs: waited, detail: capacity.detail });
        this.patch(id, { status: 'attention' });
        this.capWait.delete(capKey);
        return true; // status changed — the drive's own mission re-read stops the round
      }
      // Write the note only when it CHANGED, so a long wait doesn't persist the mission every tick.
      const note = `${CAP_WAIT_NOTE}${capacity.detail}`;
      if (sortie.note !== note) this.mutateSortie(id, sortieId, (s) => ({ ...s, note }));
      if (firstDeferral) audit('mission.sortie.cap-wait', { missionId: id, sortieId, detail: capacity.detail });
      return false;
    }
    this.capWait.delete(capKey);
    // A slot freed: drop a stale wait note now, so the sortie never carries it into its active life
    // (the successful start below clears the note too, but the spawn between them can fail).
    if (sortie.note?.startsWith(CAP_WAIT_NOTE)) this.mutateSortie(id, sortieId, (s) => ({ ...s, note: undefined }));

    let loop: Loop;
    // SPEC-RESEARCH W9 §5.1 — thread the mission's research digest into WORK sorties at SPAWN. Same
    // trust class as the errorTails and review findings already fed to fixers: agent-authored text as
    // CONTEXT, never instructions to obey verbatim. Composed at spawn rather than written into the
    // stored task, so there is no marker/pin lifecycle, no phasesHash interaction, and a retry
    // re-derives it fresh.
    // EXCLUDED, deliberately: the four role-contract sorties (research/review/investigate/docs — their
    // tasks are role disciplines or Tower-finalized), fix/verify STAGE phases (finalized failure lists
    // and the frozen run-and-report task), and — because a hand-authored phase can carry those roles
    // with NO stage at all — any sortie carrying a fixer/assignment marker. Keying on stage alone would
    // feed the digest to a raw-API-authored fixer or verify runner, which §10 forbids outright.
    const phaseOfSortie = mission.phases[activePhase];
    const contractSortie = isResearchSortie(sortie) || isReviewSortie(sortie)
      || isInvestigateSortie(sortie) || isDocsSortie(sortie)
      || sortie.verifyFixer === true || sortie.assignedFrom !== undefined
      || sortie.reviewFixer === true || sortie.assignedFromReview !== undefined;
    const researchable = !contractSortie
      && phaseOfSortie?.stage !== 'fix' && phaseOfSortie?.stage !== 'verify';
    const findings = researchable ? this.deps.research?.listFor(mission.id) ?? [] : [];
    // Budgets are the PROMPT's, not the store's: the stored summary may be 8KB, but a spawn task is
    // already task + header and is the multiline shape the send boundary has to type into a composer.
    const digest = findings.length
      ? `\n\nResearch findings (submitted by this mission's research sorties):\n${
        buildResearchDigest(findings, { perFinding: 600, total: 4000 })}`
      : '';
    try {
      loop = await this.deps.loops.create({
        projectId: mission.projectId,
        name: sortie.name,
        task: `Mission "${mission.name}" — goal: ${mission.goal}\n\nYour sortie: ${sortie.task}${digest}`,
        provider,
        model,
        effort, // SPEC-EFFORT §1 — the resolved effort (rank 6 beats every role tier), threaded to the loop
        // Informational only: provider+model are already resolved above (rank 6 beats every role
        // tier), but the loop record should still say which pipeline role it is playing.
        role: sortie.role,
        // SPEC-TESTING §1.5 — the RESOLVED account, never the raw mission.profileId: a mission
        // account on a sortie routed to a different provider used to throw at spawn ("account X
        // is not a Y account"); the match-gated resolution already skipped any mismatched tier.
        profileId,
        // Pass the mission's raw identityId straight through: loops.create threads it into createTerminal,
        // which resolves it (opts.identityId ?? project.defaultIdentityId) and stamps the terminal — and the
        // loop record then takes term.identityId. So a project default is honored here without resolving early.
        identityId: mission.identityId,
        checkCommand: sortie.checkCommand,
        gatePolicy: 'never',
        maxIterations: mission.maxIterationsPerSortie,
        assertions: sortie.assertions,
        missionId: mission.id,
        sortieId: sortie.id,
      });
    } catch (e) {
      const msg = (e as Error).message;
      this.mutateSortie(id, sortieId, (s) => ({ ...s, status: 'attention', note: `could not start builder: ${msg}` }));
      audit('mission.sortie.start.fail', { missionId: id, sortieId, error: msg });
      this.patch(id, { status: 'attention' });
      return true;
    }

    // Record the backref no matter the mission's current state, so a pause/abort during the
    // spawn can never orphan or duplicate this builder.
    const live = this.deps.store.getMission(id);
    if (!live) {
      try { this.deps.loops.stop(loop.id, 'mission vanished'); } catch { /* ignore */ }
      return true;
    }
    this.mutateSortie(id, sortieId, (s) => ({ ...s, loopId: loop.id, status: 'active', note: undefined }));
    audit('mission.sortie.start', { missionId: id, sortieId, loopId: loop.id });
    if (live.status === 'failed') {
      // Aborted while this builder was spawning — abort couldn't stop it (loopId was unset yet).
      try { this.deps.loops.stop(loop.id, 'mission aborted'); } catch { /* ignore */ }
    }
    return true;
  }

  /**
   * Land the active phase's done sorties IN ORDER, then advance. The FIRST land failure stops
   * the batch → mission attention, with a note naming the sorties already landed (partial-phase
   * merges are possible and documented — there is no un-land). A pause/abort re-read
   * before each land wins mid-batch. Assumes the busy-guard is held by the caller.
   */
  private async runAdvance(id: string): Promise<Mission> {
    const first = this.deps.store.getMission(id);
    if (!first) throw new Error('unknown mission');
    const activePhase = first.activePhase;
    const phase = first.phases[activePhase];
    if (!phase) {
      // Past the end — nothing to land. SPEC-LOOP §2 (done site c): a loop mission must NOT finish from
      // this route path (evaluateCompletion runs ONLY in the tick drive) — park at past-the-end,
      // status running, and the next detached tick routes the boundary through the evaluator.
      if (first.loop) return this.patch(id, { status: 'running', activePhase: first.phases.length });
      return this.patch(id, { status: 'done', activePhase: first.phases.length });
    }

    // SPEC-STORYLOOP §4 — the regression gate runs BEFORE the first land. runAdvance is the SINGLE
    // land+advance path for both gate-mode and autopilot (§0.4), so wiring the gate here makes S4
    // enforced in code for every advance. A disposable trial-merge worktree integrates the phase's
    // done sorties and runs mission.gateSuite against that fully-integrated tree; a red suite, a
    // trial-merge conflict, kit capacity, or a suite error routes the mission to attention and lands
    // NOTHING — base stays exactly as clean as before the click (⟦DP-S4⟧).
    if (first.gateSuite) {
      const doneSorties = phase.sorties.filter((s) => s.status === 'done');
      if (doneSorties.length > 0) {
        // SPEC-TESTING §3 (never-gates, point 1) — a docs phase SKIPS the regression gate
        // entirely: docs change docs, not code, so there is nothing to regression-test, and a
        // mission gateSuite would otherwise trial-merge the docs branch and could send a docs
        // conflict to whole-mission attention.
        if (isDocsPhase(phase)) {
          audit('mission.gate.skip', { missionId: id, phase: activePhase, reason: 'docs phase never gates' });
        } else if (isResearchPhase(phase)) {
          // SPEC-RESEARCH W9 — a research phase produces findings in the research store, not code, and
          // its branches are never merged (refuse-to-land). There is nothing to regression-test, and
          // trial-merging a researcher's scratch branch would be actively wrong.
          audit('mission.gate.skip', {
            missionId: id, phase: activePhase,
            reason: 'research phase — findings live in the research store, nothing to regression-test',
          });
        } else if (isInvestigatePhase(phase)) {
          // SPEC-LOOP W7 — an investigate phase is read-only classification (marker-only, no stage), so
          // there is nothing to regression-test and its non-landing branch must not be trial-merged.
          audit('mission.gate.skip', { missionId: id, phase: activePhase, reason: 'investigate phase — read-only classification, nothing to regression-test' });
        } else if (first.loop && (phase.stage === 'fix' || phase.stage === 'verify' || phase.stage === 'review')) {
          // SPEC-LOOP §2/W6 — a loop mission's fix/verify/review phase carries NO per-advance regression
          // gate. For fix/verify the round's own verify phase IS the regression evidence; a review phase
          // never lands code (its verdict lives in the review store, so there is nothing to regression-
          // test) and its non-landing branch must not be trial-merged. A gate here would dead-end the
          // loop. Defensive: create() never carries a gateSuite onto a loop mission, so this only fires
          // for a pre-fix stored record.
          const reason = phase.stage === 'review'
            ? 'loop review phase — the verdict lives in the review store, nothing to regression-gate'
            : 'loop verify/fix phase — the round verify is the regression evidence';
          audit('mission.gate.skip', { missionId: id, phase: activePhase, reason });
        } else {
          const gateBlock = await this.runGate(id, first, phase, doneSorties);
          if (gateBlock) return gateBlock; // the gate did not pass — nothing lands
        }
      }
    }

    const landed: string[] = [];
    for (const s of phase.sorties) {
      const cur = this.deps.store.getMission(id);
      if (!cur) throw new Error('mission vanished mid-advance');
      if (cur.status === 'paused' || cur.status === 'failed') {
        audit('mission.advance.halt', { missionId: id, reason: cur.status, landed });
        return cur; // abort/pause wins mid-batch
      }
      const sortie = cur.phases[activePhase]?.sorties.find((x) => x.id === s.id);
      if (!sortie) continue;
      if (sortie.status === 'landed') {
        landed.push(sortie.name);
        continue;
      }
      if (sortie.status !== 'done') continue; // gated/attention/active/pending aren't landable

      // SPEC-LOOP W6/W7 — NEVER land a review OR investigate sortie's branch, even when mergeable.
      // finishIteration auto-commits `git add -A` every iteration, so a reviewer/investigator that
      // scratch-writes holds commits; but neither may merge code (a review verdict lives in the
      // ReviewStore, a triage on the run's meta.json — never the branch). Mark it landed with the
      // unmerged branch named (preserved for inspection) and CONTINUE the batch — the usual no-change
      // land already resolves the clean case; this catches the committed one.
      // SPEC-RESEARCH W9 extends the same rule to research: a finding lives in the research store, so
      // a researcher that scratch-wrote (and was auto-committed) must not merge that scratch either.
      // The finding gate above has already required a submitted record before 'done' could survive
      // reconcile, so this can never mask a finding-less pass.
      if (isReviewSortie(sortie) || isInvestigateSortie(sortie) || isResearchSortie(sortie)) {
        const branch = sortie.loopId ? this.deps.loops.get(sortie.loopId)?.branch : undefined;
        const kind = isResearchSortie(sortie) ? 'research' : isInvestigateSortie(sortie) ? 'investigate' : 'review';
        const note = `${kind} sortie — branch never merged (${branch ?? 'unknown'}); it does not land code`;
        this.mutateSortie(id, sortie.id, (x) => ({ ...x, status: 'landed', note }));
        landed.push(sortie.name);
        audit('mission.sortie.land.unmerged', { missionId: id, sortieId: sortie.id, branch, kind });
        continue;
      }

      if (!sortie.loopId) {
        const note = `sortie "${sortie.name}" is done but has no builder to land`;
        this.mutateSortie(id, sortie.id, (x) => ({ ...x, status: 'attention', note }));
        return this.patch(id, { status: 'attention', stopReason: note });
      }
      try {
        const landedLoop = await this.deps.loops.land(sortie.loopId, 'merge');
        const detail = landedLoop.landDetail ?? landedLoop.stopReason;
        this.mutateSortie(id, sortie.id, (x) => ({ ...x, status: 'landed', landDetail: detail, note: undefined }));
        landed.push(sortie.name);
        audit('mission.sortie.land', { missionId: id, sortieId: sortie.id });
      } catch (e) {
        const msg = (e as Error).message;
        // SPEC-TESTING §3 (never-gates, point 4) — a land failure on a docs sortie never blocks
        // the mission: mark it 'landed' with the unmerged branch named (preserved for a manual
        // merge) and CONTINUE the batch, so the mission still completes.
        if (isDocsSortie(sortie)) {
          const branch = this.deps.loops.get(sortie.loopId)?.branch;
          const note = `docs branch left unmerged: ${branch ?? '(unknown)'} — merge manually`;
          this.mutateSortie(id, sortie.id, (x) => ({ ...x, status: 'landed', note }));
          audit('mission.sortie.land.docs-unmerged', { missionId: id, sortieId: sortie.id, error: msg });
          continue;
        }
        const note = landed.length
          ? `land failed on "${sortie.name}": ${msg}. Already landed this phase: ${landed.join(', ')}.`
          : `land failed on "${sortie.name}": ${msg}.`;
        this.mutateSortie(id, sortie.id, (x) => ({ ...x, status: 'attention', note: msg }));
        audit('mission.advance.fail', { missionId: id, sortieId: sortie.id, error: msg, landed });
        return this.patch(id, { status: 'attention', stopReason: note });
      }
    }

    // All done sorties landed. Advance if the whole phase is now landed; else surface why not.
    const done = this.deps.store.getMission(id)!;
    const phaseNow = done.phases[activePhase]!;
    if (phaseNow.sorties.every((s) => s.status === 'landed')) {
      const nextPhase = activePhase + 1;
      if (nextPhase >= done.phases.length) {
        // SPEC-LOOP §2 (done site b) — a loop mission does NOT finish here: park at past-the-end,
        // status running, so the next detached tick routes the boundary through evaluateCompletion
        // (the evaluator never runs on a route path). Non-loop missions finish as before.
        if (done.loop) {
          audit('mission.loop.boundary', { missionId: id, round: done.loop.round });
          return this.patch(id, { status: 'running', activePhase: nextPhase });
        }
        audit('mission.done', { missionId: id });
        return this.patch(id, { status: 'done', activePhase: nextPhase });
      }
      audit('mission.advance', { missionId: id, from: activePhase, to: nextPhase });
      return this.patch(id, { status: 'running', activePhase: nextPhase });
    }
    // Some sorties remain un-landed (still gated/attention → operator; active/pending → runner).
    const blocked = phaseNow.sorties.some((s) => s.status === 'gated' || s.status === 'attention');
    return this.patch(id, { status: blocked ? 'attention' : 'running' });
  }

  /**
   * SPEC-STORYLOOP §4 — run the regression gate over the phase's integrated done sorties before any
   * land. Returns a Mission when the gate BLOCKS the advance (attention: gate unavailable, trial
   * merge conflict, red suite, capacity, or suite error) — the caller returns it, landing nothing.
   * Returns undefined only on a green gate, letting runAdvance's land loop proceed. Capacity/error
   * are NOT red-suite verdicts; an unwired gate is never a silent pass.
   */
  private async runGate(
    id: string,
    mission: Mission,
    phase: MissionPhase,
    doneSorties: MissionSortie[],
  ): Promise<Mission | undefined> {
    const gateSuite = mission.gateSuite;
    if (!gateSuite) return undefined; // defensive — the caller already checked

    // gateSuite set but the gate is unwired → attention, never a TypeError, never a land past
    // an unverified integrated tree (mirrors the loop judge's "never pass unverified" forced gate).
    if (!this.deps.gate) {
      audit('mission.gate.unavailable', { missionId: id });
      return this.patch(id, {
        status: 'attention',
        stopReason: 'gate suite is configured but the regression gate is unavailable — nothing landed',
      });
    }
    const project = this.deps.store.getProject(mission.projectId);
    if (!project) throw new Error('mission project vanished before the gate');

    let result: GateResult;
    try {
      result = await this.deps.gate.check(project, phase, doneSorties, gateSuite);
    } catch (e) {
      const msg = (e as Error).message;
      audit('mission.gate.error', { missionId: id, error: msg });
      return this.patch(id, { status: 'attention', stopReason: `regression gate failed to run: ${msg} — nothing landed` });
    }

    // Re-read AFTER the long suite await: an operator pause/abort during the gate wins, and we must
    // not override a now-terminal/paused mission's status (mirrors runAdvance's mid-batch re-read).
    const live = this.deps.store.getMission(id);
    if (!live) throw new Error('mission vanished during the gate');
    if (live.status === 'paused' || live.status === 'failed') {
      audit('mission.gate.halt', { missionId: id, reason: live.status });
      return live;
    }

    switch (result.status) {
      case 'pass':
        audit('mission.gate.pass', { missionId: id, phase: mission.activePhase });
        // §2 — stamp the green gate's run id onto the active phase (the report's gate-green proof).
        // Optional: the empty-branch trivial pass carries no runId. Only loop.rounds fields feed the
        // append CAS, so patching a phase's gateRunId here is invisible to the completion evaluator.
        if (result.runId) {
          const phases = live.phases.map((p, i) =>
            i === live.activePhase ? { ...p, gateRunId: result.runId } : p,
          );
          this.patch(id, { phases });
        }
        return undefined; // green — proceed to land
      case 'conflict':
        audit('mission.gate.conflict', { missionId: id, detail: result.detail });
        return this.patch(id, {
          status: 'attention',
          stopReason: `regression gate: trial merge conflicted — ${result.detail}. Nothing landed.`,
        });
      case 'failures':
        audit('mission.gate.red', { missionId: id, failures: result.failures.length });
        return this.patch(id, { status: 'attention', stopReason: gateFailureNote(result.failures) });
      case 'capacity':
        audit('mission.gate.capacity', { missionId: id });
        return this.patch(id, { status: 'attention', stopReason: result.detail });
      case 'error':
        audit('mission.gate.suite-error', { missionId: id, detail: result.detail });
        return this.patch(id, {
          status: 'attention',
          stopReason: `regression gate could not verify the integrated tree — ${result.detail}. Nothing landed.`,
        });
    }
  }

  /**
   * SPEC-STORYLOOP §3.3 — at fixer-phase-start, partition the runner's e2e failures BY SPEC FILE
   * across this phase's fixer sorties and finalize each fixer's task from its share. Idempotent
   *: a fixer still carrying `verifyFixer` is (re)assigned then has its marker CLEARED; an
   * already-cleared fixer is skipped, so a re-entrant tick never re-shuffles an assigned phase. The
   * partition runs over the FULL fixer set (marked OR already-assigned) so a retried fixer re-derives
   * its ORIGINAL bucket index. Returns a Mission when the phase is routed to attention (test kit
   * unavailable / malformed template / no parseable runner results), else undefined.
   */
  private assignFixerPhase(id: string, activePhase: number): Mission | undefined {
    const mission = this.deps.store.getMission(id);
    if (!mission) return undefined;
    const phase = mission.phases[activePhase];
    if (!phase) return undefined;

    // The STABLE fixer set: sorties still marked (to assign) OR already assigned once (assignedFrom
    // set). Partitioning over this full set — not the currently-unassigned count — is what makes a
    // retried single fixer re-derive its identical bucket.
    const fixers = phase.sorties.filter((s) => s.verifyFixer === true || s.assignedFrom !== undefined);
    const pendingAssign = fixers.filter((s) => s.verifyFixer === true);
    if (pendingAssign.length === 0) return undefined; // not a fixer phase, or already fully assigned

    const attention = (why: string): Mission => {
      audit('mission.verify.attention', { missionId: id, phase: activePhase, reason: why });
      return this.patch(id, { status: 'attention', stopReason: `verify phase — ${why}` });
    };

    if (!this.deps.testkit) {
      return attention("the test kit is unavailable, so the runner's e2e results cannot be read");
    }

    // Find the runner: the single-sortie verify phase preceding this fix phase. SPEC-LOOP W7 — a
    // mechanical round is [investigate, fix, verify], so the fix phase's immediate predecessor may be the
    // read-only investigate phase; findRunnerPredecessor walks back past investigate phases to the runner,
    // returning the FIRST skipped investigate phase's pin (invPin — the exact run the investigator
    // triaged). With no investigate phase it is the strict activePhase-1 predecessor.
    const { runner: runnerPhase, invPin } = findRunnerPredecessor(mission.phases, activePhase);
    if (!runnerPhase) {
      return attention('a fixer phase must follow a single-sortie runner phase');
    }
    const runner = runnerPhase.sorties[0]!;

    // PIN the partition to the run it was FIRST partitioned from, three tiers:
    //  1. a fixer's own `assignedFrom` (a retried fixer keeps its original run — re-reading latestFor
    //     could hand it a NEWER run and shift the partition out from under its siblings, a collision);
    //  2. else the investigator's pinned run (invPin) — the fixers MUST partition + filter the EXACT run
    //     the investigator triaged, or the suppression keys wouldn't match;
    //  3. else (no investigate phase, first assignment) latestFor the runner terminal — the ONLY tier
    //     needing the terminal lookup.
    // A gone pinned/investigate run is the loud attention, never a silent re-partition.
    const pinnedRunId = fixers.find((s) => s.assignedFrom !== undefined)?.assignedFrom;
    let run: RunnerRun | undefined;
    if (pinnedRunId !== undefined) {
      run = this.deps.testkit.getRun(pinnedRunId);
      if (!run) {
        return attention(
          'the e2e run this fixer phase was partitioned from is gone — re-run the verify runner to re-partition',
        );
      }
    } else if (invPin !== undefined) {
      run = this.deps.testkit.getRun(invPin);
      if (!run) {
        return attention('the e2e run the investigator triaged is gone — re-run the verify runner to re-partition');
      }
    } else {
      const runnerTerminalId = runner.loopId ? this.deps.loops.get(runner.loopId)?.terminalId : undefined;
      if (!runnerTerminalId) {
        return attention('the runner sortie has no terminal to read e2e results from');
      }
      run = this.deps.testkit.latestFor(runnerTerminalId);
    }
    // Guard on results !== undefined: no parseable report ⇒ attention (never silent empty
    // work); results === [] (all green) is a valid clean no-op — every bucket is empty below.
    if (!run || run.results === undefined) {
      return attention(
        'the runner produced no parseable e2e results — check the suite/reporter (towerctl test run must write results.json)',
      );
    }

    // ⟦§3.1⟧ — raise mission concurrency to the fixer count (bounded by the [1,4] clamp) so the
    // fix phase starts all its fixers at once. The composer sets this for hand-composed missions; a
    // Jarvis/API-created mission needs the runtime raise the preamble promises. Only lift, never lower
    // — re-read the mission before mutating (the runner's re-read-before-mutate discipline).
    const targetConcurrency = Math.min(4, fixers.length);
    const fresh = this.deps.store.getMission(id);
    if (fresh && fresh.concurrency < targetConcurrency) {
      this.patch(id, { concurrency: targetConcurrency });
    }

    // SPEC-LOOP W7 — suppress by-design/false triage'd failures BEFORE the partition (UNCLASSIFIED→real),
    // via the ONE shared partitionByTriage helper (occurrence granularity, the same the report/backlog
    // read). Triage NEVER enters the verdict — it only removes fixer work here; `failed`/`failed===0` at
    // the boundary are byte-untouched, so an all-suppressed RED round still burns to the cap → attention,
    // never done. Write-once triage over the SAME pinned run keeps this deterministic for a retry.
    const { real: realFailures, suppressedKeys } = partitionByTriage(run.results, run.triage);
    if (suppressedKeys.size > 0) {
      audit('mission.verify.triage-filter', { missionId: id, runId: run.id, suppressed: suppressedKeys.size });
    }

    // ⟦DP-S2d⟧ Deterministic partition over the full fixer count; assign only the pending ones so an
    // already-assigned fixer is never re-shuffled.
    const buckets = partitionBySpecFile(realFailures, fixers.length);
    fixers.forEach((fixer, i) => {
      if (fixer.verifyFixer !== true) return; // already assigned — leave it untouched
      const bucket = buckets[i] ?? [];
      if (bucket.length === 0) {
        // No failures for this fixer — drop it out as `landed` (marker cleared) so the phase can
        // complete via rollup→advance, NOT the empty-phase skip (the sortie record stays).
        this.mutateSortie(id, fixer.id, (s) => {
          const next: MissionSortie = { ...s, status: 'landed', assignedFrom: run.id, note: 'no e2e failures assigned' };
          delete next.verifyFixer;
          return next;
        });
        audit('mission.verify.assign', { missionId: id, sortieId: fixer.id, runId: run.id, failures: 0 });
      } else {
        const task = fixerTask(bucket);
        this.mutateSortie(id, fixer.id, (s) => {
          const next: MissionSortie = { ...s, task, assignedFrom: run.id, status: 'pending', note: undefined };
          delete next.verifyFixer; // the idempotency key — a cleared fixer is skipped next tick
          return next;
        });
        audit('mission.verify.assign', {
          missionId: id,
          sortieId: fixer.id,
          runId: run.id,
          failures: bucket.length,
          specFiles: [...new Set(bucket.map((f) => f.specFile))],
        });
      }
    });
    return undefined; // assigned — startPending spawns the non-empty fixers (their rewritten task rides injectPrompt)
  }

  /**
   * SPEC-TESTING §3 — at docs-phase-start, finalize each docs-marked sortie's task from the verify
   * run (goal + landed phases + pass/fail counts). Mirrors assignFixerPhase's marker discipline
   * (`docsSortie` is the idempotency key, cleared on assignment; `docsFromRun` pins the run so a
   * retried sibling stays coherent) but returns void and NEVER blocks (never-gates, point 2): no
   * kit / no run / no parseable results ⇒ clear the marker with a note and let the sortie run its
   * authored task — contrast the fixer hook's attention closure.
   */
  private assignDocsPhase(id: string, activePhase: number): void {
    const mission = this.deps.store.getMission(id);
    if (!mission) return;
    const phase = mission.phases[activePhase];
    if (!phase) return;
    const pending = phase.sorties.filter((s) => s.docsSortie === true);
    if (pending.length === 0) return; // not a docs phase, or already finalized

    // Pin to the run this phase was FIRST finalized from; a first assignment reads the project's
    // newest parsed run — the docs phase FOLLOWS the fix phase, so that is the honest post-fix state.
    const pinnedRunId = phase.sorties.find((s) => s.docsFromRun !== undefined && s.docsFromRun !== DOCS_NO_RUN)?.docsFromRun;
    const run =
      pinnedRunId !== undefined
        ? this.deps.testkit?.getRun(pinnedRunId)
        : this.deps.testkit?.latestParsedForProject(mission.projectId);

    if (!run || run.results === undefined) {
      for (const s of pending) {
        this.mutateSortie(id, s.id, (x) => {
          // Finalize with the authored task, but PRESERVE the never-gates identity: a sentinel
          // docsFromRun keeps isDocsSortie/isDocsPhase true (so the gate-skip, attention→landed remap,
          // and land-failure continue still protect the docs phase), while clearing docsSortie stops
          // re-finalization next tick. Without the sentinel a no-results docs phase would run the
          // regression gate and could escalate the whole mission to attention (⟦re-review⟧).
          const next: MissionSortie = { ...x, docsFromRun: DOCS_NO_RUN, note: 'no e2e results to document — running with the authored task' };
          delete next.docsSortie;
          return next;
        });
        audit('mission.docs.assign', { missionId: id, sortieId: s.id, results: false });
      }
      return;
    }

    const task = docsTask(run, mission);
    for (const s of pending) {
      this.mutateSortie(id, s.id, (x) => {
        const next: MissionSortie = { ...x, task, docsFromRun: run.id, note: undefined };
        delete next.docsSortie; // the idempotency key — a finalized docs sortie is skipped next tick
        return next;
      });
      audit('mission.docs.assign', { missionId: id, sortieId: s.id, runId: run.id, failures: run.results.length });
    }
  }

  /**
   * SPEC-LOOP W7 — at investigate-phase-start, finalize the investigator's task from the PREVIOUS verify
   * run's failures and pin investigateFromRun. Mirrors assignFixerPhase's marker discipline AND its
   * ATTENTION closure — investigate is LOAD-BEARING (§0: docs' never-gates does NOT extend to it): no
   * testkit / a predecessor that is not a single-sortie runner / no runner terminal / a gone pinned run /
   * no parseable results all route to attention (never a silent skip). `investigateSortie` is the cleared
   * idempotency key; the pin drives deterministic retry AND the triage route's ownership. A green
   * predecessor run (results === []) drops each investigator out 'landed' (nothing to classify).
   */
  private assignInvestigatePhase(id: string, activePhase: number): Mission | undefined {
    const mission = this.deps.store.getMission(id);
    if (!mission) return undefined;
    const phase = mission.phases[activePhase];
    if (!phase) return undefined;

    const pending = phase.sorties.filter((s) => s.investigateSortie === true);
    if (pending.length === 0) return undefined; // not an investigate phase, or already finalized

    const attention = (why: string): Mission => {
      audit('mission.investigate.attention', { missionId: id, phase: activePhase, reason: why });
      return this.patch(id, { status: 'attention', stopReason: `investigate phase — ${why}` });
    };

    if (!this.deps.testkit) {
      return attention("the test kit is unavailable, so the runner's e2e results cannot be read");
    }

    // The verify runner producing the failures to classify is the immediately-preceding single-sortie
    // phase (an investigate phase is the FIRST phase of its own [investigate, fix, verify] round, so its
    // predecessor is the PREVIOUS round's verify phase — no walk-back needed here).
    const prevPhase = activePhase > 0 ? mission.phases[activePhase - 1] : undefined;
    if (!prevPhase || prevPhase.sorties.length !== 1) {
      return attention('an investigate phase must follow a single-sortie runner phase');
    }
    const runner = prevPhase.sorties[0]!;

    // Pin-first (mirrors the fixer): a finalized phase carries investigateFromRun; a first assignment
    // reads latestFor the runner terminal (the only tier needing the terminal lookup).
    const pinnedRunId = phase.sorties.find((s) => s.investigateFromRun !== undefined)?.investigateFromRun;
    let run: RunnerRun | undefined;
    if (pinnedRunId !== undefined) {
      run = this.deps.testkit.getRun(pinnedRunId);
      if (!run) {
        return attention('the e2e run this investigate phase was pinned to is gone — re-run the verify runner');
      }
    } else {
      const runnerTerminalId = runner.loopId ? this.deps.loops.get(runner.loopId)?.terminalId : undefined;
      if (!runnerTerminalId) {
        return attention('the runner sortie has no terminal to read e2e results from');
      }
      run = this.deps.testkit.latestFor(runnerTerminalId);
    }
    if (!run || run.results === undefined) {
      return attention('the runner produced no parseable e2e results — cannot classify (check the suite/reporter)');
    }

    // A green predecessor run (results === []) → nothing to investigate; drop each investigator out
    // 'landed' with the pin kept (the zero-bucket fixer drop-out shape), the marker cleared.
    if (run.results.length === 0) {
      for (const s of pending) {
        this.mutateSortie(id, s.id, (x) => {
          const next: MissionSortie = { ...x, status: 'landed', investigateFromRun: run!.id, note: 'no failures to investigate' };
          delete next.investigateSortie;
          return next;
        });
        audit('mission.investigate.assign', { missionId: id, sortieId: s.id, runId: run.id, failures: 0 });
      }
      return undefined;
    }

    const task = investigateTask(run.results, run.id);
    for (const s of pending) {
      this.mutateSortie(id, s.id, (x) => {
        const next: MissionSortie = { ...x, task, investigateFromRun: run!.id, status: 'pending', note: undefined };
        delete next.investigateSortie; // the idempotency key — a finalized investigator is skipped next tick
        return next;
      });
      audit('mission.investigate.assign', { missionId: id, sortieId: s.id, runId: run.id, failures: run.results.length });
    }
    return undefined;
  }

  /**
   * SPEC-LOOP W6 — at review-phase-start, finalize each reviewSortie-marked sortie's task with the exact
   * commit range to review. Mirrors assignDocsPhase's marker discipline (`reviewSortie` is the cleared
   * idempotency key; `reviewFromRange` pins the range AND keeps isReviewSortie true so the review gate
   * stays load-bearing). The ONLY correct anchor is the recorded base commit (`<baseSha>..HEAD`): sorties
   * land by merging INTO the base branch (worktrees.land), so by review time the base branch already
   * CONTAINS the work and a `<baseBranch>...HEAD` diff is empty — the base branch is not a usable anchor.
   * Without a recorded baseSha the range is unrecoverable, so a required review ROUTES TO ATTENTION rather
   * than ever handing the reviewer an empty diff it could attest clean over. Returns a Mission on that
   * attention, else undefined. baseSha is recorded (awaited) at first start for ALL missions
   * (SPEC-TERMINAL-OPS §6), before the mission is running, so this fires only on a genuinely broken-git
   * mission (rev-parse failed) that should be recreated.
   */
  private assignReviewPhase(id: string, activePhase: number): Mission | undefined {
    const mission = this.deps.store.getMission(id);
    if (!mission) return undefined;
    const phase = mission.phases[activePhase];
    if (!phase) return undefined;
    const pending = phase.sorties.filter((s) => s.reviewSortie === true);
    if (pending.length === 0) return undefined; // not a review phase, or already finalized

    // SPEC-TERMINAL-OPS §6 — top-level first, the legacy loop location as the on-disk fallback.
    const baseSha = mission.baseSha ?? mission.loop?.baseSha;
    if (!baseSha) {
      audit('mission.review.attention', { missionId: id, phase: activePhase, reason: 'no-base-sha' });
      return this.patch(id, {
        status: 'attention',
        stopReason:
          "review phase — the mission's base commit was not recorded, so the review range cannot be resolved (a git problem at start). Recreate the mission.",
      });
    }
    const range = `${baseSha}..HEAD`;
    const task = reviewTask(mission, range);
    for (const s of pending) {
      this.mutateSortie(id, s.id, (x) => {
        // reviewFromRange carries the pin AND keeps isReviewSortie true so the review gate is load-bearing.
        const next: MissionSortie = { ...x, task, reviewFromRange: range, note: undefined };
        delete next.reviewSortie; // the idempotency key — a finalized reviewer is skipped next tick
        return next;
      });
      audit('mission.review.assign', { missionId: id, sortieId: s.id, range });
    }
    return undefined;
  }

  /**
   * SPEC-LOOP W6 — at review-fix-phase-start, partition the reviewer's CONFIRMED findings BY FILE across
   * this phase's review-fixers and finalize each fixer's task from its share. Mirrors assignFixerPhase's
   * marker discipline exactly (`reviewFixer` the idempotency key, `assignedFromReview` the pin), but the
   * pin is a ReviewRecord ID resolved EXCLUSIVELY by getById — a replaced (fresh-id) or pruned record is
   * loud (attention), never silently repartitioned against different findings. Returns a Mission when the
   * phase is routed to attention (review store absent / no predecessor review phase / pinned record gone —
   * review is LOAD-BEARING), else undefined.
   */
  private assignReviewFixPhase(id: string, activePhase: number): Mission | undefined {
    const mission = this.deps.store.getMission(id);
    if (!mission) return undefined;
    const phase = mission.phases[activePhase];
    if (!phase) return undefined;

    // The STABLE review-fixer set: still-marked (to assign) OR already assigned (assignedFromReview set).
    // Partitioning over the full set — not the currently-unassigned count — is what makes a retried fixer
    // re-derive its identical bucket index.
    const fixers = phase.sorties.filter((s) => s.reviewFixer === true || s.assignedFromReview !== undefined);
    const pendingAssign = fixers.filter((s) => s.reviewFixer === true);
    if (pendingAssign.length === 0) return undefined; // not a review-fix phase, or already fully assigned

    const attention = (why: string): Mission => {
      audit('mission.review-fix.attention', { missionId: id, phase: activePhase, reason: why });
      return this.patch(id, { status: 'attention', stopReason: `review-fix phase — ${why}` });
    };

    if (!this.deps.reviews) {
      return attention('the review store is unavailable, so the review findings cannot be read');
    }

    // Resolve the pinned ReviewRecord. On a retry re-entry a fixer already carries `assignedFromReview`
    // (a record id) — resolve it EXCLUSIVELY by id; a gone record (replaced or pruned) is loud. A first
    // assignment reads the record of the LAST review-marked phase before this one (getFor by that
    // reviewer sortie); its id then becomes the pin.
    let record: ReviewRecord | undefined;
    const pinnedId = fixers.find((s) => s.assignedFromReview !== undefined)?.assignedFromReview;
    if (pinnedId !== undefined) {
      record = this.deps.reviews.getById(pinnedId);
      if (!record) {
        return attention('the code review this fix phase was partitioned from is gone — re-run the review');
      }
    } else {
      const reviewSortie = lastReviewSortieBefore(mission.phases, activePhase);
      if (!reviewSortie) {
        return attention('no code-review phase precedes this review-fix phase to read findings from');
      }
      record = this.deps.reviews.getFor(mission.id, reviewSortie.id);
      // Defense-in-depth freshness (resolveReviewState carries the same axis): a record from BEFORE the
      // reviewer was retried is not this review's work, so never partition fixers off it — re-run instead.
      if (!record || isStaleReviewRecord(record, reviewSortie.reviewRetryAt)) {
        return attention('the code review this fix phase derives from is gone — re-run the review');
      }
    }

    // Raise mission concurrency to the fixer count (bounded by the [1,4] clamp) so the phase starts all
    // its fixers at once — mirrors assignFixerPhase. Only lift, never lower; re-read before mutating.
    const targetConcurrency = Math.min(4, fixers.length);
    const fresh = this.deps.store.getMission(id);
    if (fresh && fresh.concurrency < targetConcurrency) {
      this.patch(id, { concurrency: targetConcurrency });
    }

    // Partition CONFIRMED-only findings (isConfirmed: an absent verdict ⇒ CONFIRMED) by CANONICAL file
    // over the FULL fixer set; assign only the pending ones so an already-assigned fixer is never reshuffled.
    // The key is canonicalized as a safety net for a record loaded/hand-edited before ingest normalization.
    const confirmed = record.findings.filter(isConfirmed);
    const buckets = partitionByKey(confirmed, fixers.length, (f) => canonicalizeReviewPath(f.file));
    fixers.forEach((fixer, i) => {
      if (fixer.reviewFixer !== true) return; // already assigned — leave it untouched
      const bucket = buckets[i] ?? [];
      if (bucket.length === 0) {
        // No findings for this fixer — drop it out as `landed` (marker cleared) so the phase completes
        // via rollup→advance, NOT the empty-phase skip (the sortie record stays).
        this.mutateSortie(id, fixer.id, (s) => {
          const next: MissionSortie = { ...s, status: 'landed', assignedFromReview: record!.id, note: 'no review findings assigned' };
          delete next.reviewFixer;
          return next;
        });
        audit('mission.review-fix.assign', { missionId: id, sortieId: fixer.id, recordId: record!.id, findings: 0 });
      } else {
        const task = reviewFixTask(bucket);
        this.mutateSortie(id, fixer.id, (s) => {
          const next: MissionSortie = { ...s, task, assignedFromReview: record!.id, status: 'pending', note: undefined };
          delete next.reviewFixer; // the idempotency key — a cleared fixer is skipped next tick
          return next;
        });
        audit('mission.review-fix.assign', {
          missionId: id,
          sortieId: fixer.id,
          recordId: record!.id,
          findings: bucket.length,
          files: [...new Set(bucket.map((f) => f.file))],
        });
      }
    });
    return undefined; // assigned — startPending spawns the non-empty fixers
  }

  /**
   * SPEC-LOOP W6 — the SYNCHRONOUS review-state scan the green branch reads (in-memory ReviewStore +
   * a pure phases scan; no await). `reviewIdx` = the last phase holding a review-marked sortie; `codeIdx`
   * = the last non-verify phase whose sorties are NOT all review/docs (a real code change). No review
   * phase, or a code phase AFTER the last review (the review is stale), or a review phase whose record is
   * gone → 'needs-review' (append a fresh [review, verify] round). A fresh review with a
   * record → 'clean' (0 confirmed files; carries the plausible count) or 'findings' (≥1 confirmed file).
   */
  private resolveReviewState(mission: Mission, loop: MissionLoop): ReviewState {
    const reviewIdx = lastPhaseIndex(mission.phases, (p) => p.sorties.some(isReviewSortie));
    if (reviewIdx < 0) return { kind: 'needs-review' }; // none authored / appended yet
    const codeIdx = lastPhaseIndex(
      mission.phases,
      // SPEC-RESEARCH W9 — a research phase changes no code either, so it must not read as "code
      // changed since the review" and force a re-review. Matters once a later wave can append research
      // mid-loop; correct-and-harmless today.
      (p) => p.stage !== 'verify' && !p.sorties.every((s) => isReviewSortie(s) || isDocsSortie(s) || isResearchSortie(s)),
    );
    if (codeIdx > reviewIdx) return { kind: 'needs-review' }; // code changed since the review — stale
    const reviewSortie = mission.phases[reviewIdx]!.sorties.find(isReviewSortie);
    // This read — the site where the review verdict can TERMINATE a mission — has three invalidation axes:
    // `codeIdx > reviewIdx` above (code changed since the review), record absence, and the retry-freshness
    // axis. isStaleReviewRecord reads a record submitted BEFORE the reviewer was retried
    // (sortie.reviewRetryAt) as absent, so a retried reviewer that never resubmits keeps this at
    // 'needs-review' and the loop can NEVER terminate clean off the review the operator threw away.
    // ⟦DEC-4⟧'s post-land attestation flip still holds: the REPLACEMENT reviewer's loop is created after
    // the stamp, so its resubmit is fresh (submittedAt > stamp) and reads through here.
    const record = reviewSortie ? this.deps.reviews?.getFor(mission.id, reviewSortie.id) : undefined;
    if (!record || isStaleReviewRecord(record, reviewSortie?.reviewRetryAt)) return { kind: 'needs-review' }; // absent / pruned / stale-after-retry
    // Distinct CANONICAL confirmed files — matches the review-fix partition key so fixerCount aligns.
    const confirmedFiles = new Set(
      record.findings.filter(isConfirmed).map((f) => canonicalizeReviewPath(f.file)),
    ).size;
    // 0 confirmed files ⇒ clean-for-termination; any remaining findings are all PLAUSIBLE (surfaced in
    // the report, assigned no fixer work). attestedClean (findings.length===0) is decided by the renderers.
    if (confirmedFiles === 0) return { kind: 'clean', plausible: record.findings.length };
    return { kind: 'findings', confirmedFiles };
  }

  /**
   * SPEC-SKILLS-GATE — the SYNCHRONOUS loop-green gate scan the green branch reads FIRST (in-memory
   * GateEvidenceStore reads + pure phase scans; NO await — the green branch is a CAS critical section
   * and `expected` must stay the append CAS). Every id in loop.requiredGates (FROZEN at create) must
   * hold a 'pass' record whose submitting sortie exists in this mission's phases; a gate in
   * loop.rerunGates additionally demands the evidence be FRESH. Freshness is PHASE-STRUCTURE IDENTITY —
   * `codeIdx > evidenceIdx`, the phase index of the submitting sortie vs the last code-change phase —
   * NEVER a timestamp: phases are append-only in a loop (appendRound only appends at the tail), so
   * indices are monotonic and a backward clock cannot fake fresh evidence. A frozen id whose skill was
   * later deleted/disabled stays required (fail-closed, the freeze doctrine); the escape is a fresh
   * attestation via a retried sortie, or abort.
   */
  private resolveGateState(mission: Mission, loop: MissionLoop): GateState {
    const required = loop.requiredGates ?? [];
    if (required.length === 0) return { kind: 'satisfied' };
    // The store is LOAD-BEARING (the reviews-unavailable posture): absent + gates required → blocked.
    if (!this.deps.gates) {
      return {
        kind: 'blocked',
        gateIds: [...required],
        reason:
          `the e2e suite is GREEN but required gate(s) [${required.join(', ')}] cannot be verified — `
          + 'the gate-evidence store is unavailable; nothing landed',
      };
    }
    const codeIdx = lastPhaseIndex(mission.phases, isGateCodePhase);
    const blocked: { id: string; why: string }[] = [];
    for (const gateId of required) {
      const record = this.deps.gates.getFor(mission.id, gateId);
      if (!record) {
        blocked.push({ id: gateId, why: 'no evidence' });
        continue;
      }
      if (record.status !== 'pass') {
        const summary = record.summary ? ` — ${record.summary.slice(0, 200)}` : '';
        blocked.push({ id: gateId, why: `last run FAILED${summary}` });
        continue;
      }
      // Identity first (fail-closed for EVERY gate): evidence whose submitting sortie is in no phase
      // of this mission proves nothing about this mission's change.
      const evidenceIdx = mission.phases.findIndex((p) => p.sorties.some((s) => s.id === record.sortieId));
      if (evidenceIdx < 0) {
        blocked.push({ id: gateId, why: 'stale — its submitting sortie is not in this mission (cannot place the evidence)' });
        continue;
      }
      // Rerun axis: a rerunOnNewDiff gate's pass is void once a code phase landed after it; a gate
      // without the flag accepts older evidence.
      if (loop.rerunGates?.includes(gateId) && codeIdx > evidenceIdx) {
        blocked.push({ id: gateId, why: 'stale — code changed since it was recorded' });
      }
    }
    if (blocked.length === 0) return { kind: 'satisfied' };
    return {
      kind: 'blocked',
      gateIds: blocked.map((b) => b.id),
      reason:
        'the e2e suite is GREEN but required gate(s) are unsatisfied: '
        + blocked.map((b) => `${b.id} — ${b.why}`).join('; ')
        + '. Run each skill over the change and record the outcome with '
        + '`towerctl gate submit --gate <id> --result pass` (or fail), then resume the mission.',
    };
  }

  private finishMission(id: string): void {
    const m = this.deps.store.getMission(id);
    if (!m || m.status === 'done') return;
    audit('mission.done', { missionId: id });
    this.patch(id, { status: 'done' });
  }

  /**
   * SPEC-LOOP §2 — the ONE completion-boundary evaluator for a loop mission. Runs ONLY inside the
   * tick's detached per-mission drive (reconcileAndStart, done site a), under the existing busy-guard
   * — NEVER on a route path (a give-up that returned while still 'running' from a route would
   * fall through to a GREEN finishMission on a RED loop). Re-reads; bails unless the mission is a
   * running loop parked past its last phase. Reads the last verify phase's TestRun (never-silent-pass:
   * no parseable results → attention), records the round's result, then decides:
   *   GREEN (failed===0) → done;  RED + cap exhausted → attention (honest RED, a NON-running status);
   *   RED + budget remains → after `mechanicalRounds` mechanical [fix, verify] rounds, ESCALATE to the
   *   planner (W2) instead — but in TWO TICKS: this tick records a pending {kind:'escalating'} round and
   *   returns; the NEXT tick (finding that record) runs the long re-planner await in runEscalatedRound
   *   (so a thrown planner can't be retried on the route path or every 5s forever). Below that threshold,
   *   append a mechanical [fix, verify] round as before.
   */
  private async evaluateCompletion(id: string): Promise<void> {
    const mission = this.deps.store.getMission(id);
    if (!mission || mission.status !== 'running' || !mission.loop) return;
    if (mission.activePhase < mission.phases.length) return; // not at the completion boundary
    const loop = mission.loop;

    // Capture the CAS tuple NOW — before the long planner await inside runEscalatedRound. An append (or
    // an escalated re-plan) only fires if this exact tuple + the per-sortie snapshot are still live.
    const expected: AppendCas = {
      status: mission.status,
      round: loop.round,
      phasesLen: mission.phases.length,
      sorties: snapshotSorties(mission),
    };

    // 1. Find the last verify phase and resolve its run (pinned verifyRunId → deterministic
    //    re-evaluation; else runner sortie → loop → terminal → newest run with the freshness guard).
    const verifyIdx = lastVerifyPhaseIndex(mission.phases);
    if (verifyIdx < 0) {
      // A loop mission with no verify phase can never prove green — never a silent pass.
      audit('mission.loop.attention', { missionId: id, reason: 'no-verify-phase' });
      this.parkLoop(id, { status: 'attention', stopReason: 'loop mission has no verify phase to evaluate — cannot confirm green' });
      return;
    }
    const run = this.resolveVerifyRun(mission, mission.phases[verifyIdx]!, loop);
    // never-silent-pass: absent run / results===undefined (no parseable report) → attention.
    if (!run || run.results === undefined) {
      audit('mission.loop.attention', { missionId: id, reason: 'no-parseable-results' });
      this.parkLoop(id, {
        status: 'attention',
        stopReason: 'the loop verify phase produced no parseable e2e results — cannot confirm green (check the suite/reporter: `towerctl test run` must write results.json)',
      });
      return;
    }

    // 2. Record this round's result onto its RoundRecord (report/history honesty regardless of the
    //    decision below). failureKeys are specFile › testTitle ONLY (errorTail is unstable).
    const failed = run.failed ?? run.results.length;
    const total = run.total;
    const failureKeys = failureKeysOf(run.results);
    const stampedRounds = loop.rounds.map((r) =>
      r.n === loop.round
        ? {
            ...r,
            verifyRunId: run.id,
            failed,
            ...(total !== undefined ? { total } : {}),
            ...(failureKeys.length ? { failureKeys } : {}),
          }
        : r,
    );

    // 3. GREEN — every test passing (and any gate that ran is green; a zero-commit verify phase runs
    //    no gate, so gateRunId is OPTIONAL). Without a review gate: deliver + done as W1 did. With
    //    `requireReview` (read from mission.loop, never live config, per the frozen boundary rule): a code review must be
    //    fresh + clean before done. This ENTIRE branch is SYNCHRONOUS — the ReviewStore reads are
    //    in-memory and the phase scans are pure, so `expected` (captured above) stays the append CAS
    //    and appendRound's frozen sync block is the sole arbiter, exactly like the mechanical path.
    if (failed === 0) {
      // SPEC-SKILLS-GATE — the loop-green orchestrator gate, hoisted ABOVE the review machinery so
      // BOTH done sites in this branch (the no-review finish and the review-clean finish) flow through
      // it. Any future status:'done' write in this green branch MUST stay BELOW this check. Fully
      // synchronous + in-memory (resolveGateState) — `expected` stays the append CAS. Parking first is
      // budget-honest: an unsatisfied gate needs evidence from the operator/agent, not more rounds.
      const gateState = this.resolveGateState(mission, loop);
      if (gateState.kind === 'blocked') {
        audit('mission.loop.gate.blocked', { missionId: id, round: loop.round, gates: gateState.gateIds });
        this.parkLoop(id, {
          status: 'attention',
          stopReason: gateState.reason,
          loop: { ...loop, rounds: stampedRounds },
        });
        return;
      }
      if (!loop.requireReview) {
        audit('mission.loop.green', { missionId: id, round: loop.round, runId: run.id, total });
        this.patch(id, { status: 'done', activePhase: mission.phases.length, loop: { ...loop, rounds: stampedRounds } });
        return;
      }
      // Review is LOAD-BEARING: an unavailable store is attention, never a silent green.
      if (!this.deps.reviews) {
        audit('mission.loop.review.unavailable', { missionId: id, round: loop.round });
        this.parkLoop(id, {
          status: 'attention',
          stopReason: 'the e2e suite is GREEN but a code review is required and the review store is unavailable — nothing landed',
          loop: { ...loop, rounds: stampedRounds },
        });
        return;
      }
      const state = this.resolveReviewState(mission, loop);
      if (state.kind === 'clean') {
        // ATTESTED clean (the reviewer's judgement, not a machine proof) — carry the plausible count on
        // every clean-labeled surface so a review with only-PLAUSIBLE findings never reads as unqualified.
        audit('mission.loop.review.clean', { missionId: id, round: loop.round, runId: run.id, attested: true, plausible: state.plausible });
        this.patch(id, { status: 'done', activePhase: mission.phases.length, loop: { ...loop, rounds: stampedRounds } });
        return;
      }
      // 'findings' → a review-fix round; 'needs-review' (none/stale/missing-record) → a
      // fresh [review, verify] round. Both size + cap BEFORE any write; a cap-exhausted give-up writes a
      // NON-'running' status (honest attention) so reconcileAndStart can never fall through to a green
      // finish (the done-only-via-evaluator rule). The stamp-then-append two-patch mirrors the mechanical path exactly.
      const currentSorties = mission.phases.reduce((n, p) => n + p.sorties.length, 0);
      if (state.kind === 'findings') {
        const fixerCount = Math.min(4, Math.max(1, state.confirmedFiles));
        const why = capReason(loop, currentSorties, fixerCount + 1);
        if (why) {
          audit('mission.loop.review.giveup', { missionId: id, round: loop.round, reason: why, findings: state.confirmedFiles });
          this.parkLoop(id, { status: 'attention', stopReason: reviewGiveUpNote(loop, why), loop: { ...loop, rounds: stampedRounds } });
          return;
        }
        audit('mission.loop.review.fix', { missionId: id, round: loop.round, files: state.confirmedFiles });
        this.patch(id, { loop: { ...loop, rounds: stampedRounds } });
        const nextRec: MissionRoundRecord = { n: loop.round + 1, kind: 'review-fix', appendedAt: new Date().toISOString() };
        this.appendRound(id, reviewFixRoundPhases(loop.round + 1, fixerCount), nextRec, expected);
        return;
      }
      // needs-review — a [review, verify] round is 2 sorties (1 reviewer + 1 verify runner).
      const whyReview = capReason(loop, currentSorties, 2);
      if (whyReview) {
        audit('mission.loop.review.giveup', { missionId: id, round: loop.round, reason: whyReview });
        this.parkLoop(id, { status: 'attention', stopReason: reviewGiveUpNote(loop, whyReview), loop: { ...loop, rounds: stampedRounds } });
        return;
      }
      audit('mission.loop.review.append', { missionId: id, round: loop.round });
      this.patch(id, { loop: { ...loop, rounds: stampedRounds } });
      const nextRec: MissionRoundRecord = { n: loop.round + 1, kind: 'review', appendedAt: new Date().toISOString() };
      // Inherit the operator's authored reviewer route so the self-heal reviewer uses the same (valid)
      // provider/model/account, not the bare role default (which might resolve to the Brain).
      this.appendRound(id, reviewRoundPhases(loop.round + 1, authoredReviewerRoute(mission)), nextRec, expected);
      return;
    }

    // 4. RED. First: is a planner escalation already pending — a {kind:'escalating'} record this loop
    //    left in a PRIOR tick? If so, run the long re-planner await HERE, in the detached tick drive
    //    under busy (the two-tick design: the await never runs on this evaluate's own decision path
    //    either, only on the tick that FINDS the pending record). `expected` is the CAS captured before
    //    the await, exactly what W1 hardened appendRound against.
    const pendingEsc = loop.rounds.find((r) => r.n === loop.round + 1 && r.kind === 'escalating');
    if (pendingEsc) {
      await this.runEscalatedRound(id, mission, loop, stampedRounds, pendingEsc, expected);
      return;
    }

    // 5. No escalation pending — decide escalate vs mechanical, then size + cap BEFORE any write.
    //    Escalate after `mechanicalRounds` consecutive mechanical rounds at the TAIL (a re-plan resets
    //    the window; mechanicalRounds===0 escalates on the first red). F = distinct failing spec files,
    //    clamped [1,4]; a mechanical round is F fixers + 1 verify runner, an escalation is ≥2 (≥1 work
    //    sortie + 1 verify runner) — its ACTUAL size is re-checked against the budget once planned.
    const escalate = trailingMechanicalCount(loop.rounds) >= loop.mechanicalRounds;
    const specFiles = new Set(run.results.map((f) => f.specFile)).size;
    const fixerCount = Math.min(4, Math.max(1, specFiles));
    // SPEC-LOOP W7 — a mechanical round prepends an investigator (+1 sortie) when the mission opted in.
    // Read from mission.loop ONLY (captured at create), never live config. Triage NEVER enters the
    // verdict — it only sizes the round here and filters the fixer partition; `failed`/`failed===0` above
    // are byte-untouched, so a by-design-red loop still exhausts its cap and stops RED, never done.
    const investigate = loop.investigate === true;
    const minRoundSorties = escalate ? 2 : fixerCount + 1 + (investigate ? 1 : 0);
    const currentSorties = mission.phases.reduce((n, p) => n + p.sorties.length, 0);
    const why = capReason(loop, currentSorties, minRoundSorties);

    if (why) {
      // A cap-exhausted give-up MUST write a NON-'running' status (attention) with an honest RED note —
      // returning while 'running' would let reconcileAndStart short-circuit into a green finish. parkLoop
      // also flushes any deferred auto-file (this cap-exhausted round's untriaged run reaches the backlog).
      audit('mission.loop.giveup', { missionId: id, round: loop.round, failed, reason: why });
      this.parkLoop(id, {
        status: 'attention',
        stopReason: redGiveUpNote(failed, total, loop, why),
        loop: { ...loop, rounds: stampedRounds },
      });
      return;
    }

    if (escalate) {
      // Two-tick escalation: record a pending {kind:'escalating'} round (loop.round is NOT bumped — it
      // bumps only in appendRound, when the re-plan lands) and return. The NEXT detached tick finds it
      // and runs the planner await in runEscalatedRound. One patch: persist the stamp AND the pending
      // record together (no interior await, so `expected`'s CAS fields are untouched).
      audit('mission.loop.escalate', { missionId: id, round: loop.round, failed });
      this.patch(id, {
        loop: {
          ...loop,
          rounds: [...stampedRounds, { n: loop.round + 1, kind: 'escalating', appendedAt: new Date().toISOString() }],
        },
      });
      return;
    }

    // Mechanical round — persist the stamped round, then append the next [(investigate,) fix, verify]
    // round in the critical section (the stamp changes only loop.rounds, so `expected`'s CAS fields hold).
    this.patch(id, { loop: { ...loop, rounds: stampedRounds } });
    const nextRec: MissionRoundRecord = { n: loop.round + 1, kind: 'mechanical', appendedAt: new Date().toISOString() };
    this.appendRound(id, mechanicalRoundPhases(loop.round + 1, fixerCount, investigate), nextRec, expected);
  }

  /**
   * SPEC-LOOP W2 (G2) — run ONE escalated (re-planned) round for a loop mission whose mechanical rounds
   * could not turn it green. Called from evaluateCompletion ONLY when a pending {kind:'escalating'} record
   * is found (so this is the SECOND tick — the long planner await never runs on the tick that decided to
   * escalate, nor on any route path). Runs entirely inside the detached tick drive under the busy-guard.
   *
   * SUCCESS → the codex re-planner's remaining-work phases are sanitized through a strict copy-only
   * whitelist (§3 W2: never a docs/review/investigate marker), given the Tower-authored verify tail,
   * route-validated + budget-re-checked at their ACTUAL size, and appended as a `replanned` round (the
   * pending record is replaced by appendRound's upsert-by-n). FAILURE (the re-planner threw) → bounded
   * retry: bump the escalating record's `attempts` and stay running for ONE more tick, then attention.
   * A pause/abort during the minutes-long await always wins (re-read after the await, the W1 append-CAS rule).
   */
  /** Terminally give up on THIS escalation: re-read (an operator pause/abort must win), then attention +
   *  stamp the escalating record's `attempts` to the cap. That cap is what the top-of-runEscalatedRound
   *  guard reads, so after an operator restarts an attention'd mission the next tick short-circuits here
   *  instead of re-spending a paid re-planner turn on a deterministically-failing escalation. */
  private giveUpEscalation(id: string, pendingEsc: MissionRoundRecord, stopReason: string, auditEvent: string, detail: Record<string, unknown> = {}): void {
    const live = this.deps.store.getMission(id);
    if (!live || live.status !== 'running' || !live.loop) return; // pause()/abort() already won
    audit(auditEvent, { missionId: id, round: pendingEsc.n, ...detail });
    // parkLoop: terminal escalation give-up → attention + flush any deferred auto-file (the untriaged
    // run(s)) so their real failures still reach the backlog.
    this.parkLoop(id, {
      status: 'attention',
      stopReason,
      loop: { ...live.loop, rounds: [...live.loop.rounds.filter((r) => r.n !== pendingEsc.n), { ...pendingEsc, attempts: MAX_ESCALATE_ATTEMPTS }] },
    });
  }

  private async runEscalatedRound(
    id: string,
    mission: Mission,
    loop: MissionLoop,
    stampedRounds: MissionRoundRecord[],
    pendingEsc: MissionRoundRecord,
    expected: AppendCas,
  ): Promise<void> {
    // Persist the round's verify stamp first (the escalate tick already wrote it alongside the pending
    // record, so on the normal re-entry this deep-equals loop.rounds and the patch is skipped). All of
    // this runs BEFORE the await, so no resurrection risk here.
    if (JSON.stringify(loop.rounds) !== JSON.stringify(stampedRounds)) {
      this.patch(id, { loop: { ...loop, rounds: stampedRounds } });
    }
    // Bound across restarts: every give-up path stamps attempts=MAX on the escalating record. If the
    // operator restarts an attention'd mission it re-enters here — short-circuit to attention BEFORE any
    // paid re-planner turn, so a deterministically-failing escalation can't burn a Brain turn per restart.
    if ((pendingEsc.attempts ?? 0) >= MAX_ESCALATE_ATTEMPTS) {
      this.giveUpEscalation(id, pendingEsc, 'loop escalation already tried and gave up — recreate the mission (raise its caps / fix routing or the brain account first).', 'mission.loop.escalate.exhausted', { attempts: pendingEsc.attempts });
      return;
    }
    // SPEC-PLANNER §7 — a planner-bound mission routes its escalation to the planner terminal (a consult),
    // NOT the codex Brain. The whole consult lifecycle — lost→respawn, ask, consume, the two clocks — lives
    // in runPlannerConsult, which fully owns this tick. Placed BEFORE the !project||!planRevision guard so a
    // planner mission never 503s on a missing Brain (the planner IS its re-planner). A planner-less mission,
    // or one with no consults dep wired, falls straight through to the byte-untouched codex path below.
    if (mission.planner && this.deps.consults && this.deps.consultTimeouts) {
      await this.runPlannerConsult(id, mission, loop, stampedRounds, pendingEsc, expected);
      return;
    }
    const project = this.deps.store.getProject(mission.projectId);
    if (!project || !this.deps.planRevision) {
      // Unrecoverable — no repo to ground the re-plan / no re-planner wired. Honest attention, no retry.
      this.giveUpEscalation(
        id, pendingEsc,
        !project
          ? 'loop escalation cannot re-plan — the project repo is missing.'
          : 'loop escalation cannot re-plan — no assistant re-planner is configured. Add an assistant brain account (Settings → Assistant), then start a fresh loop mission.',
        'mission.loop.escalate.unavailable', { reason: !project ? 'no-project' : 'no-replanner' },
      );
      return;
    }

    // Context bundle from the MISSION ONLY (never live config): names / statuses / failureKeys — no task
    // bodies, no errorTails, no secrets. `failing` is THIS round's stamped failure keys. SPEC-LOOP W6 —
    // when a reviewer submitted, feed its CONFIRMED findings (file: summary) so the re-planner sees them;
    // undefined when no record (the validator prompt omits the section entirely).
    // NOT freshness-filtered by reviewRetryAt on purpose: this is bundle CONTEXT for a re-plan PROMPT, not
    // a gate and never a termination — a discarded review's findings only informing a re-plan is in scope.
    const reviewRec = this.deps.reviews?.latestFor(mission.id);
    const reviewFindings = reviewRec
      ? reviewRec.findings
          .filter(isConfirmed)
          .slice(0, 20)
          .map((f) => `${f.file}: ${f.summary}`.slice(0, 200))
      : undefined;
    // SPEC-RESEARCH W9 §5.2 — planning feedback that exists TODAY, without the consult wave: the
    // re-planner sees what the mission's researchers found. Same bounded, agent-authored-text stance as
    // reviewFindings; undefined when none, so the prompt section disappears entirely.
    const researchRecs = this.deps.research?.listFor(mission.id) ?? [];
    const research = researchRecs.length
      ? researchRecs.slice(0, 10).map((r) => `${r.topic || '(untitled)'}: ${r.summary}`.slice(0, 200))
      : undefined;
    const bundle = buildRevisionBundle(mission, loop, stampedRounds, reviewFindings, research);

    let newPhases: MissionPhase[];
    try {
      const reqPhases = await this.deps.planRevision(project.repoPath, bundle);
      const { sanitized, droppedMarker } = sanitizeRevisionPhases(reqPhases);
      if (droppedMarker) audit('mission.loop.replan.marker-drop', { missionId: id, round: loop.round + 1 });
      if (sanitized.length === 0) throw new Error('re-planner returned no usable work phases after sanitizing');
      // buildPhases mints fresh ids + registry whitelists (§3 W2); stamp the new round number on each work
      // phase; then close the round with the Tower-authored verify tail (never the planner's to emit).
      const work = buildPhases(sanitized).map((p) => ({ ...p, round: loop.round + 1 }));
      newPhases = [...work, loopVerifyPhase(loop.round + 1)];
      assertLoopTail(newPhases); // defense-in-depth: the tail must be the single-sortie verify phase.
    } catch (err) {
      // The re-planner (or sanitize/assert) failed. RE-READ — an operator pause/abort during the long
      // await must win; never resurrect a non-running mission.
      const live = this.deps.store.getMission(id);
      if (!live || live.status !== 'running' || !live.loop) return;
      const attempts = (pendingEsc.attempts ?? 0) + 1;
      const msg = (err as Error).message;
      if (attempts >= MAX_ESCALATE_ATTEMPTS) {
        // Second failure — give up honestly. giveUpEscalation STAMPS attempts=MAX so a restart's re-entry
        // short-circuits at the top guard (a bare attention would leave attempts=1 and re-plan each restart).
        this.giveUpEscalation(id, pendingEsc, `loop stopped — the re-planner failed ${attempts} times (${msg}). It won't retry on its own; check the assistant brain account (Settings → Assistant), or recreate the mission.`, 'mission.loop.replan.failed', { attempts, error: msg });
        return;
      }
      // First failure — bump the escalating record's attempts (rounds upsert-by-n) and stay running, so
      // the next detached tick retries the planner exactly once. This is why the design is two-tick.
      audit('mission.loop.escalate-failed', { missionId: id, round: loop.round + 1, attempts, error: msg });
      this.patch(id, {
        loop: { ...live.loop, rounds: [...live.loop.rounds.filter((r) => r.n !== pendingEsc.n), { ...pendingEsc, attempts }] },
      });
      return;
    }

    // SUCCESS — everything below is SYNCHRONOUS through appendRound (no further await). The await above
    // was long: an operator pause/abort during it must win, so re-read and bail before any status write
    // (the W1 re-read-after-await rule; only pause()/abort() can change a boundary-parked mission — both make it non-running).
    const afterPlan = this.deps.store.getMission(id);
    if (!afterPlan || afterPlan.status !== 'running' || !afterPlan.loop) return;

    // sortieBudget RE-CHECK at the ACTUAL re-plan size (never trim — an oversized re-plan is an honest
    // give-up). Counted against the snapshot the CAS also validates.
    const addedSorties = newPhases.reduce((n, p) => n + p.sorties.length, 0);
    const currentSorties = mission.phases.reduce((n, p) => n + p.sorties.length, 0);
    if (currentSorties + addedSorties > loop.sortieBudget) {
      // Deterministic give-up (the budget won't change on a restart) → stamp attempts=MAX so a restart's
      // re-entry short-circuits at the top guard rather than re-spending a re-planner turn.
      this.giveUpEscalation(id, pendingEsc, `loop stopped — the re-planned round needs ${addedSorties} sorties, which would exceed the sortie budget ${loop.sortieBudget} (${currentSorties} already used). Recreate the mission with a higher budget.`, 'mission.loop.giveup', { reason: 'replan-oversized', added: addedSorties });
      return;
    }

    // Route-validate the appended phases exactly as start() does (fresh ids from buildPhases; §3 W2).
    const routeReport = validateMissionRoutes(
      { ...mission, phases: newPhases },
      this.deps.routing?.layersFor(mission.projectId) ?? { global: {} },
      this.deps.providerStore,
      this.deps.accounts,
      this.deps.reservedProfileIds?.(),
    );
    if (routeReport.hasErrors) {
      const detail = routeReport.sorties
        .filter((s) => s.errors.length > 0)
        .map((s) => `${s.sortieName}: ${s.errors.join(', ')}`)
        .join('; ');
      // Deterministic give-up (routes won't resolve on a restart without operator action) → stamp
      // attempts=MAX so a restart short-circuits at the top guard, not another re-planner turn.
      this.giveUpEscalation(id, pendingEsc, `the re-planned round has unresolvable routes — ${detail}. Fix routing/accounts, then start a fresh loop mission.`, 'mission.loop.replan.route-error', { detail });
      return;
    }
    // Warnings don't block — bake each into its (not-yet-persisted) sortie's note + audit (mirrors start()).
    const warnById = new Map<string, string>();
    for (const s of routeReport.sorties) {
      if (s.warnings.length === 0) continue;
      warnById.set(s.sortieId, `route warnings: ${s.warnings.join('; ')}`);
      audit('mission.route-warning', { missionId: id, sortieId: s.sortieId, warnings: s.warnings });
    }
    if (warnById.size > 0) {
      newPhases = newPhases.map((p) => ({
        ...p,
        sorties: p.sorties.map((s) => (warnById.has(s.id) ? { ...s, note: warnById.get(s.id) } : s)),
      }));
    }

    // Append the re-planned round. appendRound's non-running/CAS guard is the final arbiter: if the
    // operator paused/aborted mid-plan it returns false and we do NOT audit success — the mission moved on.
    const appended = this.appendRound(
      id,
      newPhases,
      {
        n: loop.round + 1,
        kind: 'replanned',
        appendedAt: new Date().toISOString(),
        ...(pendingEsc.attempts !== undefined ? { attempts: pendingEsc.attempts } : {}),
      },
      expected,
    );
    if (!appended) return;
    audit('mission.loop.replan', { missionId: id, round: loop.round + 1, phases: newPhases.length, sorties: addedSorties });
  }

  // ==================== SPEC-PLANNER §7/§8 — the planner-consult escalation ====================

  /** The bound planner terminal's title for a gate note (best-effort; the mission doesn't store it). */
  private consultTitle(planner: MissionPlanner): string {
    return this.deps.store.getTerminal(planner.terminalId)?.title ?? planner.terminalId;
  }

  /** SPEC-PLANNER §7 — the read-only bundle a consult carries, assembled from the MISSION ONLY exactly as
   *  the codex path does (names/statuses/failureKeys; no task bodies of landed work, no errorTails, no
   *  secrets). Duplicated from the codex build (not shared) so the codex path stays byte-untouched (§10). */
  private escalationBundleForConsult(mission: Mission, loop: MissionLoop, stampedRounds: MissionRoundRecord[]): PlanRevisionBundle {
    // Not freshness-filtered by reviewRetryAt on purpose (see the codex-path bundle): re-plan PROMPT
    // context only — never a gate, never a termination — so a discarded review informing a re-plan is fine.
    const reviewRec = this.deps.reviews?.latestFor(mission.id);
    const reviewFindings = reviewRec
      ? reviewRec.findings.filter(isConfirmed).slice(0, 20).map((f) => `${f.file}: ${f.summary}`.slice(0, 200))
      : undefined;
    const researchRecs = this.deps.research?.listFor(mission.id) ?? [];
    const research = researchRecs.length
      ? researchRecs.slice(0, 10).map((r) => `${r.topic || '(untitled)'}: ${r.summary}`.slice(0, 200))
      : undefined;
    return buildRevisionBundle(mission, loop, stampedRounds, reviewFindings, research);
  }

  /** SPEC-PLANNER §7 — the bounded-retry flow shared by a thrown respawn and a thrown ask (mirrors the
   *  thrown-planRevision handling): re-read (never resurrect a non-running mission), bump the escalating
   *  record's attempts, and give up honestly at the cap. */
  private afterConsultThrow(id: string, pendingEsc: MissionRoundRecord, err: unknown, auditEvent: string): void {
    const live = this.deps.store.getMission(id);
    if (!live || live.status !== 'running' || !live.loop) return;
    const attempts = (pendingEsc.attempts ?? 0) + 1;
    const msg = (err as Error).message;
    if (attempts >= MAX_ESCALATE_ATTEMPTS) {
      // At the cap this path parks at the human gate; close any still-open consult so it doesn't linger
      // "waiting on planner" on the operator surface (the other give-up paths already close theirs). At the
      // RETRY below the consult is LEFT open — the next tick's lost-check may still migrate it.
      const open = pendingEsc.consultId ? this.deps.consults?.getById(pendingEsc.consultId) : undefined;
      if (open && isConsultOpen(open)) this.deps.consults?.resolve(open.id, 'expired', 'planner-unrecoverable');
      this.giveUpEscalation(id, pendingEsc, `loop stopped — the planner consult could not be issued (${msg}) after ${attempts} attempts. Recreate the mission once the planner pane can receive consults.`, auditEvent, { attempts, error: msg });
      return;
    }
    audit(auditEvent, { missionId: id, round: pendingEsc.n, attempts, error: msg });
    this.patch(id, { loop: { ...live.loop, rounds: [...live.loop.rounds.filter((r) => r.n !== pendingEsc.n), { ...pendingEsc, attempts }] } });
  }

  /**
   * SPEC-PLANNER §7/§8 — own ONE tick's re-entry for a planner-bound escalation. Synchronous throughout
   * EXCEPT the bounded respawn await (the startSortie loops.create class). Order (§5 answered-first, then
   * P1 lost-check): a STORED reply needs nothing from any pane, so it is consumed BEFORE the lost-check —
   * otherwise a lost planner would discard a completed valid reply to respawn or to expire it
   * 'planner-unrecoverable', throwing away good work. Only when there is no answer does the lost-check run
   * (a pane killed mid-pend recovers via respawn + migrate rather than waiting out a clock against a dead
   * terminal). Every terminal path lands at appendRound or a forced human gate (§11 L12).
   */
  private async runPlannerConsult(
    id: string, mission: Mission, loop: MissionLoop,
    stampedRounds: MissionRoundRecord[], pendingEsc: MissionRoundRecord, expected: AppendCas,
  ): Promise<void> {
    const consults = this.deps.consults!;
    const clocks = this.deps.consultTimeouts!;
    let planner = mission.planner!;

    // ---- 0. ANSWERED-FIRST (§5), before ANY pane logic ----
    // consumePlannerReply touches no terminal, so a stored reply is consumed even on a LOST planner —
    // discarding it to respawn or to 'planner-unrecoverable' would burn work and a lifetime respawn/gate.
    const answered = pendingEsc.consultId ? consults.getById(pendingEsc.consultId) : undefined;
    if (answered && answered.status === 'answered') {
      await this.consumePlannerReply(id, mission, loop, pendingEsc, expected, answered);
      return;
    }

    // ---- 1. LOST-CHECK (P1) ----
    if (planner.state === 'lost') {
      if ((planner.respawns ?? 0) >= 2 || !this.deps.plannerSpawn) {
        // Unrecoverable — expire the open consult (addressed to a dead pane) and park at the human gate;
        // NEVER fall through to the codex path (a planner mission's re-plan is the planner's, by choice).
        const open = pendingEsc.consultId ? consults.getById(pendingEsc.consultId) : undefined;
        if (open && isConsultOpen(open)) consults.resolve(open.id, 'expired', 'planner-unrecoverable');
        this.giveUpEscalation(
          id, pendingEsc,
          `the planner pane "${this.consultTitle(planner)}" is gone and could not be respawned (${planner.respawns ?? 0} of 2 respawns used). Recreate the mission — attach or spawn a fresh planner.`,
          'mission.planner.unrecoverable', { respawns: planner.respawns ?? 0 },
        );
        return;
      }
      let newTerm: Terminal;
      try {
        newTerm = await this.deps.plannerSpawn(mission);
      } catch (err) {
        this.afterConsultThrow(id, pendingEsc, err, 'mission.planner.respawn.failed');
        return;
      }
      // P2 — re-read after the await: an abort/pause during the spawn must win, and the escalating record
      // must still stand. Otherwise the fresh pane is an orphan and the consult a leak; kill it and bail.
      const live = this.deps.store.getMission(id);
      const stillEsc = live?.loop?.rounds.find((r) => r.n === pendingEsc.n && r.kind === 'escalating');
      // The operator can detachPlanner() — or attach a different one — DURING the spawn await: an
      // EXPLICIT choice to fall back to the codex Brain (§3). It leaves status 'running' with the loop
      // and escalating record intact, so the guards above miss it, and without this the fresh pane
      // would be patched straight back in below, silently overriding the detach. Re-attach only when
      // the live planner is STILL the same lost binding this respawn set out to replace.
      const stillSameLostPlanner =
        live?.planner?.terminalId === planner.terminalId && live?.planner?.state === 'lost';
      if (!live || live.status !== 'running' || !live.loop || !stillEsc || !stillSameLostPlanner) {
        try { this.deps.plannerKill?.(newTerm.id); } catch { /* best-effort */ }
        return;
      }
      const oldTid = planner.terminalId;
      const next: MissionPlanner = {
        ...planner, terminalId: newTerm.id, state: 'live', spawned: true,
        respawns: (planner.respawns ?? 0) + 1, respawnedAt: new Date().toISOString(),
      };
      this.patch(id, { planner: next });
      audit('mission.planner.respawn', { missionId: id, from: oldTid, to: newTerm.id, respawns: next.respawns });
      consults.migrate(id, oldTid, newTerm.id); // consult + unread mail → the new pane; delivered→pending
      planner = next;
      // A migrated open consult is now pending against the new pane — alert it once and hand the clock to
      // the next tick. If none survived (the prior consult was already closed), fall through and ASK fresh.
      const migrated = pendingEsc.consultId ? consults.getById(pendingEsc.consultId) : undefined;
      if (migrated && isConsultOpen(migrated)) {
        consults.renudge(migrated);
        return;
      }
    }

    // ---- 2/3/4. dispatch on the current consult ----
    const c = pendingEsc.consultId ? consults.getById(pendingEsc.consultId) : undefined;

    if (!c || isConsultClosed(c)) {
      // ASK / RE-ASK (a prior expiry or rejection is already in attempts). The bundle is built here — the
      // consult branch precedes the codex path's build — from the mission only.
      const bundle = this.escalationBundleForConsult(mission, loop, stampedRounds);
      let consult: PlannerConsult;
      try {
        consult = consults.ask({ missionId: id, terminalId: planner.terminalId, kind: 'replan', question: REPLAN_CONSULT(bundle, clocks), payload: bundle });
      } catch (err) {
        this.afterConsultThrow(id, pendingEsc, err, 'mission.planner.ask.failed');
        return;
      }
      // ONE patch: stamp the escalating record's consultId (upsert-by-n; no CAS field touched — rounds
      // content is outside AppendCas, the same reason the escalate tick could write it). ask() is sync, but
      // re-read for a terminal transition anyway (belt-and-braces).
      const live = this.deps.store.getMission(id);
      if (!live || live.status !== 'running' || !live.loop) return;
      this.patch(id, { loop: { ...live.loop, rounds: [...live.loop.rounds.filter((r) => r.n !== pendingEsc.n), { ...pendingEsc, consultId: consult.id }] } });
      audit('mission.planner.ask', { missionId: id, round: loop.round + 1, consultId: consult.id });
      return;
    }

    // Defensive re-check: step 0 already consumed an answer, and no reply can land during the lost branch's
    // await (the dead pane's token is forgotten → 401), so this is normally unreachable — kept so a future
    // edit that lets `c` be answered here still consumes rather than mis-routing it into the clocks.
    if (c.status === 'answered') {
      await this.consumePlannerReply(id, mission, loop, pendingEsc, expected, c);
      return;
    }

    // still open (pending|delivered) — the two clocks. answered-first ordering is STRUCTURAL (step 0
    // consumes an answer before this is ever reached), so a reply that arrived at minute 29 of a pause is
    // consumed on the resume tick, never expired.
    const now = Date.now();
    // Both clocks BELT a non-finite timestamp (a hand-edited/corrupt consults.json survives loading —
    // askedAt/deliveredAt are z.string() with no ISO check). Without the belt `now - NaN > x` is silently
    // false, so the clock never fires and the consult wedges pending/delivered forever. Treat an
    // unparseable active timestamp as immediately over-deadline so it still gates. The mint paths
    // (create / markDelivered) always stamp a valid ISO, so this is belt-only for a tampered store.
    const askedMs = Date.parse(c.askedAt);
    const overDeliver = c.status === 'pending' && (!Number.isFinite(askedMs) || now - askedMs > clocks.deliverMs);
    const deliveredMs = c.deliveredAt !== undefined ? Date.parse(c.deliveredAt) : NaN;
    const overAnswer = c.status === 'delivered' && (!Number.isFinite(deliveredMs) || now - deliveredMs > clocks.answerMs);
    if (overDeliver || overAnswer) {
      const reason: PlannerConsult['expireReason'] = overDeliver ? 'delivery-timeout' : 'answer-timeout';
      consults.resolve(c.id, 'expired', reason);
      const attempts = (pendingEsc.attempts ?? 0) + 1;
      if (attempts >= MAX_ESCALATE_ATTEMPTS) {
        this.giveUpEscalation(id, pendingEsc, plannerExpiryNote(this.consultTitle(planner), reason, attempts), 'mission.planner.consult.expired', { reason, attempts });
        return;
      }
      audit('mission.planner.consult.expired', { missionId: id, round: loop.round + 1, reason, attempts });
      // Clear the consultId so the NEXT tick re-asks a fresh consult (the resolved one is closed anyway;
      // this is explicit rather than relying on the isConsultClosed check).
      const live = this.deps.store.getMission(id);
      if (!live || live.status !== 'running' || !live.loop) return;
      this.patch(id, { loop: { ...live.loop, rounds: [...live.loop.rounds.filter((r) => r.n !== pendingEsc.n), { ...pendingEsc, attempts, consultId: undefined }] } });
      return;
    }

    // under deadline — a ONE-SHOT half-deadline renudge (P5). Gate on crossing the ACTIVE clock's half
    // SINCE the last nudge (persisted lastNudgeAt), capped at 3 total attempts. A pending consult that
    // simply re-satisfies the predicate every 5-10s tick is exactly what this prevents. A non-finite
    // lastNudgeAt (a tampered store) is belted the same as the clocks above: treat it as due, so the cap
    // (nudges < 3) bounds it rather than a NaN compare silently suppressing every renudge.
    const activeHalf = (c.status === 'delivered' ? clocks.answerMs : clocks.deliverMs) / 2;
    const lastNudge = c.lastNudgeAt ? Date.parse(c.lastNudgeAt) : askedMs;
    if ((c.nudges ?? 0) < 3 && (!Number.isFinite(lastNudge) || now - lastNudge > activeHalf)) {
      consults.renudge(c);
    }
  }

  /**
   * SPEC-PLANNER §7 — consume an answered consult: mirror the codex SUCCESS path (sanitize → buildPhases →
   * verify tail → assertLoopTail → sortieBudget re-check → validateMissionRoutes → appendRound) but source
   * the phases from the planner's reply. Kept SEPARATE from runEscalatedRound's codex block so that block
   * stays byte-untouched (§10). A pipeline rejection resolves the consult 'rejected' and bumps attempts
   * (re-ask next tick, or gate at the cap); success resolves it 'applied'.
   */
  private async consumePlannerReply(
    id: string, mission: Mission, loop: MissionLoop,
    pendingEsc: MissionRoundRecord, expected: AppendCas, c: PlannerConsult,
  ): Promise<void> {
    const consults = this.deps.consults!;
    const replyPhases = (c.answer as { phases?: CreateMissionRequest['phases'] } | undefined)?.phases ?? [];
    let newPhases: MissionPhase[];
    try {
      const { sanitized, droppedMarker } = sanitizeRevisionPhases(replyPhases);
      if (droppedMarker) audit('mission.loop.replan.marker-drop', { missionId: id, round: loop.round + 1, via: 'planner' });
      if (sanitized.length === 0) throw new Error('the planner reply had no usable work phases after sanitizing');
      const work = buildPhases(sanitized).map((p) => ({ ...p, round: loop.round + 1 }));
      newPhases = [...work, loopVerifyPhase(loop.round + 1)];
      assertLoopTail(newPhases);
    } catch (err) {
      // The reply failed the trusted pipeline. Reject the consult, then the bounded-attempt flow: re-read,
      // bump attempts, re-ask next tick (a FRESH consult) or gate at the cap.
      const live = this.deps.store.getMission(id);
      if (!live || live.status !== 'running' || !live.loop) return;
      consults.resolve(c.id, 'rejected');
      const attempts = (pendingEsc.attempts ?? 0) + 1;
      const msg = (err as Error).message;
      if (attempts >= MAX_ESCALATE_ATTEMPTS) {
        this.giveUpEscalation(id, pendingEsc, `loop stopped — the planner's re-plan was unusable (${msg}) after ${attempts} attempts. Recreate the mission or fix the planner's reply.`, 'mission.planner.reply.rejected', { attempts, error: msg });
        return;
      }
      audit('mission.planner.reply.rejected', { missionId: id, round: loop.round + 1, attempts, error: msg });
      // Clear consultId so the next tick asks a fresh consult (the rejected one is closed).
      this.patch(id, { loop: { ...live.loop, rounds: [...live.loop.rounds.filter((r) => r.n !== pendingEsc.n), { ...pendingEsc, attempts, consultId: undefined }] } });
      return;
    }

    // Re-read before any status write (the consume path had an await-free pipeline, but be consistent with
    // the codex path's afterPlan guard: only pause()/abort() can move a boundary-parked mission).
    const afterPlan = this.deps.store.getMission(id);
    if (!afterPlan || afterPlan.status !== 'running' || !afterPlan.loop) return;

    const addedSorties = newPhases.reduce((n, p) => n + p.sorties.length, 0);
    const currentSorties = mission.phases.reduce((n, p) => n + p.sorties.length, 0);
    if (currentSorties + addedSorties > loop.sortieBudget) {
      consults.resolve(c.id, 'rejected');
      this.giveUpEscalation(id, pendingEsc, `loop stopped — the planner's re-plan needs ${addedSorties} sorties, exceeding the sortie budget ${loop.sortieBudget} (${currentSorties} already used). Recreate the mission with a higher budget.`, 'mission.loop.giveup', { reason: 'replan-oversized', added: addedSorties, via: 'planner' });
      return;
    }

    const routeReport = validateMissionRoutes(
      { ...mission, phases: newPhases },
      this.deps.routing?.layersFor(mission.projectId) ?? { global: {} },
      this.deps.providerStore,
      this.deps.accounts,
      this.deps.reservedProfileIds?.(),
    );
    if (routeReport.hasErrors) {
      const detail = routeReport.sorties.filter((s) => s.errors.length > 0).map((s) => `${s.sortieName}: ${s.errors.join(', ')}`).join('; ');
      consults.resolve(c.id, 'rejected');
      this.giveUpEscalation(id, pendingEsc, `the planner's re-plan has unresolvable routes — ${detail}. Fix routing/accounts, then start a fresh loop mission.`, 'mission.loop.replan.route-error', { detail, via: 'planner' });
      return;
    }
    const warnById = new Map<string, string>();
    for (const s of routeReport.sorties) {
      if (s.warnings.length === 0) continue;
      warnById.set(s.sortieId, `route warnings: ${s.warnings.join('; ')}`);
      audit('mission.route-warning', { missionId: id, sortieId: s.sortieId, warnings: s.warnings });
    }
    if (warnById.size > 0) {
      newPhases = newPhases.map((p) => ({ ...p, sorties: p.sorties.map((s) => (warnById.has(s.id) ? { ...s, note: warnById.get(s.id) } : s)) }));
    }

    const appended = this.appendRound(
      id, newPhases,
      { n: loop.round + 1, kind: 'replanned', appendedAt: new Date().toISOString(), consultId: c.id, ...(pendingEsc.attempts !== undefined ? { attempts: pendingEsc.attempts } : {}) },
      expected,
    );
    if (!appended) return; // the mission moved on (paused/aborted/CAS) — leave the consult answered for a clean retry
    consults.resolve(c.id, 'applied');
    audit('mission.loop.replan', { missionId: id, round: loop.round + 1, phases: newPhases.length, sorties: addedSorties, via: 'planner' });
  }

  /**
   * SPEC-LOOP §2 — resolve the verify phase's TestRun. Prefers the round's pinned verifyRunId (so a
   * crash-recovery re-evaluation is deterministic), else the phase's single runner sortie → its loop →
   * terminal → newest non-gate run, guarded by the loops.ts:495 freshness rule (a run started before
   * the runner's loop is never misattributed into the verdict). Absent kit / runner / terminal → undefined
   * (the caller routes to attention — never a silent pass).
   */
  private resolveVerifyRun(mission: Mission, verifyPhase: MissionPhase, loop: MissionLoop): RunnerRun | undefined {
    const kit = this.deps.testkit;
    if (!kit) return undefined;
    const pinned = loop.rounds.find((r) => r.n === loop.round)?.verifyRunId;
    if (pinned) {
      const run = kit.getRun(pinned);
      if (run) return run;
    }
    const runner = verifyPhase.sorties[0];
    if (!runner || !runner.loopId) return undefined;
    const runnerLoop = this.deps.loops.get(runner.loopId);
    const terminalId = runnerLoop?.terminalId;
    if (!terminalId) return undefined;
    const run = kit.latestFor(terminalId);
    if (!run) return undefined;
    // Freshness guard (⟦loops.ts:495⟧): a run started before the runner's own loop is stale.
    if (runnerLoop && run.startedAt !== undefined && run.startedAt < runnerLoop.createdAt) return undefined;
    return run;
  }

  /**
   * SPEC-LOOP §2 — THE critical section. Re-read the mission, then in ONE synchronous block WITH NO
   * INTERIOR AWAIT (Node's single-threaded event loop is the only atomicity): refuse a non-running
   * mission (an abort/pause that landed during a prior await must NOT be resurrected) and a
   * widened CAS mismatch (status/round/phases.length AND the per-sortie snapshot must still match
   * what evaluateCompletion read), then a SINGLE patch appending the round's phases at the tail, bumping
   * the round counter, recording the round, and pointing activePhase at the FIRST appended phase (the
   * round's fix phase, or the W7 investigate phase when investigate is on) — which at the boundary
   * already equals the pre-append phases.length.
   *
   * Returns TRUE when the single patch fired, FALSE when it refused (non-running / CAS-mismatch) — a pure
   * additive signal the W2 escalated-round caller reads so it never audits a re-plan the mission moved
   * past. The frozen sync block (non-running refusal, widened CAS, single patch) is otherwise untouched.
   */
  private appendRound(id: string, newPhases: MissionPhase[], roundRec: MissionRoundRecord, expected: AppendCas): boolean {
    const live = this.deps.store.getMission(id);
    // The single most important line — the mission must never be resurrected once terminated/paused.
    if (!live || live.status !== 'running' || !live.loop) return false;
    // Widened CAS — a no-op unless everything evaluateCompletion read is still exactly live.
    if (
      live.status !== expected.status ||
      live.loop.round !== expected.round ||
      live.phases.length !== expected.phasesLen ||
      snapshotSorties(live) !== expected.sorties
    ) {
      audit('mission.loop.append.skip', { missionId: id, round: expected.round });
      return false;
    }
    // activePhase = the pre-append length: it now indexes the FIRST newly-appended phase (the round's
    // fix phase, or — with W7 investigate on — the investigate phase). At the boundary activePhase
    // already equals this, so this is a no-op in the normal flow AND a correction if the boundary was
    // ever reached with activePhase overshooting.
    // UPSERT-BY-N: a W2 escalation left a pending {n, kind:'escalating'} record; replacing it (rather
    // than appending) keeps one record per round number. A mechanical append has no same-n record, so
    // the filter is a no-op there.
    this.patch(id, {
      phases: [...live.phases, ...newPhases],
      loop: {
        ...live.loop,
        round: live.loop.round + 1,
        rounds: [...live.loop.rounds.filter((r) => r.n !== roundRec.n), roundRec],
      },
      status: 'running',
      activePhase: live.phases.length,
    });
    audit('mission.loop.round', { missionId: id, round: live.loop.round + 1, kind: roundRec.kind, newPhases: newPhases.length });
    return true;
  }

  // ---- state helpers (all re-read the mission; never rebuild from a stale snapshot) ----

  /** Apply a function to one sortie (matched by id across all phases) and persist. */
  private mutateSortie(missionId: string, sortieId: string, fn: (s: MissionSortie) => MissionSortie): void {
    const mission = this.deps.store.getMission(missionId);
    if (!mission) return;
    let touched = false;
    const phases = mission.phases.map((p) => ({
      ...p,
      sorties: p.sorties.map((s) => {
        if (s.id !== sortieId) return s;
        touched = true;
        return fn(s);
      }),
    }));
    if (touched) this.patch(missionId, { phases });
  }

  private patch(id: string, patch: Partial<Mission>): Mission {
    // ⟦DP-B5⟧ Execution-done detection at the SINGLE write choke point: mission 'done' is set at
    // MULTIPLE sites (finishMission + runAdvance), so hook the choke point, not each site. Fire
    // once on a transition INTO 'done' (prev !== 'done'). Read prev only when the patch actually
    // moves status to 'done', so ordinary reconcile writes pay nothing.
    const toDone = patch.status === 'done';
    // SPEC-LOOP W4 — the delivery report also fires on a transition INTO 'failed' (only abort() writes
    // 'failed'). Read prev whenever the patch moves status to done OR failed, so ordinary reconcile
    // writes still pay nothing.
    const toFailed = patch.status === 'failed';
    const prev = toDone || toFailed ? this.deps.store.getMission(id) : undefined;
    const next = this.deps.store.patchMission(id, patch);
    if (!next) throw new Error('unknown mission');
    this.emit(next);
    if (toDone && prev && prev.status !== 'done') {
      this.fireExecutionDone({ missionId: id });
    }
    // FIRST transition INTO 'done' OR 'failed' — a terminal event. Fire BOTH terminal hooks here off the
    // ONE guard so a future one-sided edit can never desync them: (W4) write the deterministic delivery
    // report; (W7) flush any deferred auto-file — a green finish reached via an escalated re-plan or a
    // review round (neither carries an investigate phase) leaves an earlier RED round's deferred run
    // untriaged-and-unfiled, and pre-W7 immediate-file put those real failures in the backlog, so the flush
    // restores that guarantee (idempotent via autoFiled: a fully triaged mission files nothing). Both are
    // independently guarded + side-effect-isolated, so order is behavior-neutral; report stays FIRST. The
    // evaluateCompletion / giveUpEscalation 'attention' give-ups flush via parkLoop instead (attention is
    // not terminal in general, so patch() cannot blanket-fire it without pre-filing runs a later
    // investigator would legitimately triage).
    if (prev && (toDone || toFailed) && prev.status !== 'done' && prev.status !== 'failed') {
      this.fireMissionFinished(next);
      this.fireLoopSettle(next);
      // SPEC-PLANNER §8 — expire any open planner consults for a mission that just ended, so a done/aborted
      // mission never leaves a consult "waiting on planner" forever. Guarded + fire-and-forget like the two
      // hooks above; fires on the FIRST transition into done|failed only (the same guard).
      this.fireConsultSettle(next);
      // SPEC-TERMINAL-OPS §3.3 — a finished mission starts nothing more, so drop any cap-wait anchor it
      // still holds. abort() clears its own, but a mission that reaches done/failed any other way (or a
      // re-plan that drops a deferred sortie id) would otherwise leave entries in the map for the life
      // of the process. Harmless today (the keys are one-shot shortIds and can never be hit again), but
      // an unbounded map with no clear owner is exactly how a leak starts.
      this.clearCapWait(id);
    }
    return next;
  }

  /** SPEC-LOOP W4 — fire the optional delivery-report hook, fully guarded — a report failure must NEVER
   *  break a mission write (report-never-blocks-done; mirrors fireExecutionDone). */
  private fireMissionFinished(mission: Mission): void {
    try {
      this.deps.report?.onMissionFinished(mission);
    } catch (err) {
      console.error('[missions] report.onMissionFinished failed:', err);
    }
  }

  /** SPEC-LOOP W7 — fire the optional deferred-auto-file flush hook, fully guarded (a flush failure must
   *  never break a mission write). Only meaningful for an investigate loop mission; the integrator no-ops
   *  otherwise. Called on a terminal 'failed' transition and at the cap-exhausted give-up paths. */
  private fireLoopSettle(mission: Mission): void {
    if (mission.loop?.investigate !== true) return; // only investigate loop missions defer auto-filing
    try {
      this.deps.onLoopSettle?.(mission);
    } catch (err) {
      console.error('[missions] onLoopSettle failed:', err);
    }
  }

  /**
   * SPEC-LOOP W7 — park a loop mission at a TERMINAL boundary decision (attention) AND flush any deferred
   * auto-file. evaluateCompletion / giveUpEscalation have decided to STOP iterating at the boundary
   * (activePhase >= phases.length — no pending phase, so no future investigator will auto-triage a deferred
   * run), so an untriaged deferred verify run from an earlier RED round must be flushed now or it is lost if
   * the operator abandons the mission. EVERY evaluateCompletion / giveUpEscalation give-up MUST go through
   * here (never a bare this.patch), so no site can miss the flush. fireLoopSettle is itself gated on
   * loop.investigate and idempotent (the run's autoFiled marker), so a non-investigate or fully-triaged
   * mission flushes nothing. NOT for the mid-flight attention parks (phase-assignment / routing / gate
   * failures) — those still have a pending phase a retry/resume will run, and flushing could pre-file a run
   * a later investigator would legitimately triage.
   */
  private parkLoop(id: string, patch: Partial<Mission>): Mission {
    const parked = this.patch(id, patch);
    this.fireLoopSettle(parked);
    return parked;
  }

  /** ⟦DP-B5⟧ Fire the optional backlog execution-done hook, fully guarded — a backlog failure must
   *  NEVER break a mission write. */
  private fireExecutionDone(ref: { missionId?: string; loopId?: string }): void {
    try {
      this.deps.backlog?.onExecutionDone(ref);
    } catch (err) {
      console.error('[missions] backlog.onExecutionDone failed:', err);
    }
  }

  private emit(mission: Mission): void {
    try {
      this.deps.onUpdate(mission);
    } catch {
      /* dropped subscriber */
    }
  }

  private mustMission(id: string): Mission {
    const mission = this.deps.store.getMission(id);
    if (!mission) throw new Error('unknown mission');
    return mission;
  }
}

// ---- pure helpers ----

/**
 * Build persisted MissionPhases from a create/plan request's phases: mint fresh ids, registry-check each
 * sortie role (ROLE_IDS) and phase stage (PHASE_STAGES) — a bad wire value is DROPPED, never bricks the
 * phase on load — carry the per-sortie routing overrides + the verify/docs markers. Shared VERBATIM by
 * create() and the W3 draft redraft, so planner output re-enters through exactly one trusted builder
 * (buildPhases: fresh ids, strict role/stage whitelists). `rationale` is draft-only (not on MissionSortie) and
 * intentionally dropped; the model allowlist is enforced later by validateRoute at the start gate, so a
 * bad model surfaces as an error, not silently. Throws on a missing phase name / sortie name+task.
 */
function buildPhases(reqPhases: CreateMissionRequest['phases']): MissionPhase[] {
  return reqPhases.map((p) => {
    const pname = p.name?.trim();
    if (!pname) throw new Error('every phase needs a name');
    const sorties: MissionSortie[] = (p.sorties ?? []).map((s) => {
      const sname = s.name?.trim();
      const stask = s.task?.trim();
      if (!sname || !stask) throw new Error('every sortie needs a name and a task');
      const smodel = typeof s.model === 'string' ? s.model.trim() : '';
      const seffort = typeof s.effort === 'string' ? s.effort.trim() : '';
      return {
        id: shortId(),
        name: sname,
        task: stask,
        assertions: cleanAssertions(s.assertions),
        checkCommand: s.checkCommand?.trim() || undefined,
        // Registry-derived (SPEC-ROUTING §1): a new registry role just works; an unheard-of role drops.
        ...(s.role && (ROLE_IDS as readonly string[]).includes(s.role) ? { role: s.role } : {}),
        ...(s.provider ? { provider: s.provider } : {}),
        ...(smodel ? { model: smodel } : {}),
        // SPEC-EFFORT §1 — carry the per-sortie effort; a bad value surfaces at the start gate, like model.
        ...(seffort ? { effort: seffort } : {}),
        // SPEC-TESTING §1.1 — the sortie-explicit account tier; validated at the start gate.
        ...(typeof s.profileId === 'string' && s.profileId.trim() ? { profileId: s.profileId.trim() } : {}),
        // ⟦§3.3⟧ The verify-fixer marker must survive — assignFixerPhase triggers on it.
        ...(s.verifyFixer === true ? { verifyFixer: true } : {}),
        // SPEC-TESTING §3 — the docs marker must survive; assignDocsPhase finalizes it at phase start.
        ...(s.docsSortie === true ? { docsSortie: true } : {}),
        // SPEC-LOOP W6 — the review marker must survive; assignReviewPhase finalizes it at phase start.
        ...(s.reviewSortie === true ? { reviewSortie: true } : {}),
        // SPEC-LOOP W7 — the investigate marker must survive; assignInvestigatePhase finalizes it at start.
        ...(s.investigateSortie === true ? { investigateSortie: true } : {}),
        ...(s.researchSortie === true ? { researchSortie: true } : {}),
        status: 'pending' as SortieStatus,
      };
    });
    // SPEC-LOOP §0 — the phase's loop stage (composer authors the loop tail as stage:'verify'; the
    // completion evaluator + the loop-round gate-skip key on it). Registry-checked; a bad value drops.
    const stage = p.stage && (PHASE_STAGES as readonly string[]).includes(p.stage) ? p.stage : undefined;
    return { id: shortId(), name: pname, sorties, ...(stage ? { stage } : {}) };
  });
}

/** SPEC-LOOP §2 — a loop mission's plan MUST end in a single-sortie stage:'verify' phase (the
 *  round's fixers partition from it; assignFixerPhase needs a single-sortie verify predecessor). Throws
 *  otherwise. Enforced at start() and after the W3 draft redraft so the plan stays loop-shaped. */
function assertLoopTail(phases: MissionPhase[]): void {
  const last = phases[phases.length - 1];
  if (!last || last.stage !== 'verify' || last.sorties.length !== 1) {
    throw new Error(
      'a loop mission must end in a single-sortie verify phase (the loop’s regression evidence) — add a verify phase',
    );
  }
  // The verify runner records the suite as the round's regression evidence, which the loop boundary
  // judges green/red. A checkCommand on it instead iterates the runner to attention on a RED suite, so
  // the mechanical fix round never appends — iterate-until-green silently degrades to attention-after-N.
  // The Tower-authored tail (loopVerifyPhase) never carries one, so this only rejects a raw-API or
  // drafted tail that was already silently broken.
  if (last.sorties[0]!.checkCommand !== undefined) {
    throw new Error(
      'the loop verify tail must not carry a checkCommand — the runner records the test run as the round’s evidence and the loop boundary judges it; a checkCommand would iterate the runner to attention on a red suite instead of appending the fix round',
    );
  }
}

/**
 * SPEC-LOOP W3 (G4) — a stable content hash of a mission's plan, binding a planReview to the EXACT plan
 * it graded. Hashes ONLY stable authored content — each phase's name + stage, and each sortie's
 * name/task/role/provider/model — and EXCLUDES volatile runtime fields (sortie status/note/ids/loopId,
 * phase id/round/gateRunId). start()'s recompute must match the graded hash: an edit to any hashed field
 * voids a prior pass; a runtime status change must NOT.
 */
export function computePhasesHash(phases: MissionPhase[]): string {
  const canonical = phases.map((p) => ({
    name: p.name,
    stage: p.stage ?? null,
    sorties: p.sorties.map((s) => ({
      name: s.name,
      task: s.task,
      role: s.role ?? null,
      provider: s.provider ?? null,
      model: s.model ?? null,
      // SPEC-EFFORT §1 — hash effort ONLY when set (spread, not `?? null`) so every existing effort-less
      // plan hashes byte-identically and no stored planReview pass is voided by this deploy; an effort
      // edit on a new plan still voids its grade, exactly like a model edit.
      ...(s.effort !== undefined ? { effort: s.effort } : {}),
    })),
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Loop-status → sortie-status mapping (SPEC §2 reconcile). */
function deriveSortieStatus(loop: Loop): { status: SortieStatus; note?: string; noChangeLanded?: boolean } {
  switch (loop.status) {
    case 'running':
    case 'paused':
      return { status: 'active' };
    case 'gated':
      return { status: 'gated' };
    case 'done':
      return loop.landedAt ? { status: 'landed' } : { status: 'done' };
    case 'failed':
      return { status: 'attention', note: loop.stopReason ?? 'builder failed' };
    case 'stopped':
      // A no-change stop (agent reported done, zero commits) is finished-in-fact, not an operator
      // problem: map it to 'landed' (nothing to merge) so rollup→advance carries the phase forward,
      // mirroring the zero-bucket fixer drop-out in assignFixerPhase. Read the STRUCTURED flag, never
      // stopReason prose. Every other stop (operator, budget cap, error) still routes to attention.
      return loop.noChangesToLand
        ? { status: 'landed', note: loop.stopReason ?? 'no changes to land', noChangeLanded: true }
        : { status: 'attention', note: loop.stopReason ?? 'builder stopped' };
  }
}

/** Roll a phase's sortie statuses up to a phase-level verdict. */
function rollup(sorties: MissionSortie[]): 'running' | 'attention' | 'phase-complete' {
  if (sorties.some((s) => s.status === 'gated' || s.status === 'attention')) return 'attention';
  if (sorties.every((s) => s.status === 'done' || s.status === 'landed')) return 'phase-complete';
  return 'running';
}

function replacePhaseSorties(phases: MissionPhase[], phaseIndex: number, sorties: MissionSortie[]): MissionPhase[] {
  return phases.map((p, i) => (i === phaseIndex ? { ...p, sorties } : p));
}

function findSortie(mission: Mission, sortieId: string): { phase: MissionPhase; sortie: MissionSortie } | undefined {
  for (const phase of mission.phases) {
    const sortie = phase.sorties.find((s) => s.id === sortieId);
    if (sortie) return { phase, sortie };
  }
  return undefined;
}

/** Whether two reconciled sorties differ in any field the runner mutates. */
function sortieChanged(a: MissionSortie, b: MissionSortie): boolean {
  return a.status !== b.status || a.loopId !== b.loopId || a.note !== b.note || a.landDetail !== b.landDetail;
}

export function isTerminalLoop(status: LoopStatus): boolean {
  return status === 'done' || status === 'stopped' || status === 'failed';
}

function cleanAssertions(raw?: string[]): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map((a) => (typeof a === 'string' ? a.trim() : '')).filter(Boolean);
  return out.length ? out : undefined;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---- SPEC-LOOP §2 — completion-loop helpers ----

/** The widened compare-and-set snapshot appendRound checks against what evaluateCompletion read:
 *  the append is a no-op unless every field is still exactly live at the append write. */
interface AppendCas {
  status: MissionStatus;
  round: number;
  phasesLen: number;
  /** Serialized (sortieId→status) across all phases — catches a raced retry re-arm. */
  sorties: string;
}

/** Index of the LAST stage:'verify' phase (the round's regression evidence), or -1. */
function lastVerifyPhaseIndex(phases: MissionPhase[]): number {
  return lastPhaseIndex(phases, (p) => p.stage === 'verify');
}

/** SPEC-LOOP W6 — index of the LAST phase matching a predicate, or -1 (the tail-scan the completion
 *  evaluator's verify lookup and the review-state resolver's newest-review / newest-code scans key on). */
function lastPhaseIndex(phases: MissionPhase[], pred: (p: MissionPhase) => boolean): number {
  for (let i = phases.length - 1; i >= 0; i--) if (pred(phases[i]!)) return i;
  return -1;
}

/** SPEC-LOOP W7 — the single-sortie verify runner phase preceding `activePhase`, walking back past any
 *  investigate phases (read-only classification, never a runner). Returns the runner phase (undefined when
 *  the first non-investigate predecessor is missing or not single-sortie — the caller attentions the same
 *  way) plus the FIRST skipped investigate phase's pinned run (invPin — the exact run its investigator
 *  triaged). With no investigate phase this is the strict activePhase-1 predecessor, so a fixer phase with
 *  no investigate phase behaves byte-identically to before. Extracted so the fixer/review paths share one
 *  predecessor walk. */
function findRunnerPredecessor(phases: MissionPhase[], activePhase: number): { runner?: MissionPhase; invPin?: string } {
  let idx = activePhase - 1;
  let invPin: string | undefined;
  while (idx >= 0 && isInvestigatePhase(phases[idx]!)) {
    if (invPin === undefined) {
      invPin = phases[idx]!.sorties.find((s) => s.investigateFromRun !== undefined)?.investigateFromRun;
    }
    idx--;
  }
  const runner = idx >= 0 ? phases[idx] : undefined;
  // SPEC-RESEARCH W9 — a research phase is NEVER a runner predecessor. A single-sortie research phase
  // hand-authored directly before a fix phase would otherwise satisfy the shape test, and the fixer
  // assignment's terminal-scoped fallback would then partition from whatever run that RESEARCHER
  // happened to leave behind (nothing stops a researcher running the suite while exploring) — a silent
  // misread rather than the loud "must follow a single-sortie runner phase" attention the plan deserves.
  if (runner && isResearchPhase(runner)) return { invPin };
  return { runner: runner && runner.sorties.length === 1 ? runner : undefined, invPin };
}

/** SPEC-LOOP W6 — the review sortie of the newest review-marked phase strictly before `beforeIdx` (the
 *  reviewer whose findings a review-fix phase partitions from), or undefined. */
function lastReviewSortieBefore(phases: MissionPhase[], beforeIdx: number): MissionSortie | undefined {
  for (let i = beforeIdx - 1; i >= 0; i--) {
    const s = phases[i]!.sorties.find(isReviewSortie);
    if (s) return s;
  }
  return undefined;
}

/** SPEC-LOOP W6 — the synchronous review-state verdict the green branch reads (see resolveReviewState). */
type ReviewState =
  | { kind: 'clean'; plausible: number }      // fresh review, 0 confirmed files → done (attested)
  | { kind: 'findings'; confirmedFiles: number } // fresh review, ≥1 confirmed file → review-fix round
  | { kind: 'needs-review' };                 // none / stale / missing-record → fresh [review, verify] round

/** SPEC-SKILLS-GATE — the synchronous gate verdict the green branch reads FIRST (see resolveGateState).
 *  `reason` is the ready-to-park stopReason enumerating every blocked gate id + why + the recovery hint. */
type GateState =
  | { kind: 'satisfied' }
  | { kind: 'blocked'; gateIds: string[]; reason: string };

/** SPEC-SKILLS-GATE — "did this phase change code?", the gate-staleness axis. A DELIBERATE DUPLICATE of
 *  resolveReviewState's inline codeIdx predicate (the arrow in its lastPhaseIndex scan): the review
 *  surface is frozen, so the predicate is copied out rather than refactored out of it — if the review
 *  copy ever changes, revisit this one by hand. A verify phase runs code, changes none; a phase of only
 *  review/docs/research sorties changes none either. */
function isGateCodePhase(p: MissionPhase): boolean {
  return p.stage !== 'verify' && !p.sorties.every((s) => isReviewSortie(s) || isDocsSortie(s) || isResearchSortie(s));
}

/** A compact (sortieId→status) fingerprint of every sortie, for the append CAS. */
function snapshotSorties(mission: Mission): string {
  return mission.phases.map((p) => p.sorties.map((s) => `${s.id}:${s.status}`).join(',')).join('|');
}

/** SPEC-LOOP §2 — a round's failure keys: `specFile › testTitle` ONLY (errorTail is unstable),
 *  each ≤200 chars, at most 100 keys. */
function failureKeysOf(results: TestFailure[]): string[] {
  const keys: string[] = [];
  for (const f of results) {
    keys.push(`${f.specFile} › ${f.testTitle}`.slice(0, 200));
    if (keys.length >= 100) break;
  }
  return keys;
}

/** SPEC-LOOP §2 — the ONE cap-exhaustion check shared by every give-up site (mechanical + both review
 *  green-branches), so they can never diverge. Returns the human `why` string when the next round of
 *  `delta` sorties would blow the round cap or the sortie budget, else undefined (room remains). */
function capReason(loop: MissionLoop, currentSorties: number, delta: number): string | undefined {
  if (loop.round >= loop.maxRounds) return `round cap ${loop.maxRounds}`;
  if (currentSorties + delta > loop.sortieBudget) return `sortie budget ${loop.sortieBudget}`;
  return undefined;
}

/** SPEC-LOOP §2 — the honest RED note written to a cap-exhausted loop mission's attention. */
function redGiveUpNote(failed: number, total: number | undefined, loop: MissionLoop, why: string): string {
  const count = total !== undefined ? `${failed}/${total}` : `${failed}`;
  // Honest recovery only: a cap-exhausted loop re-reads its PINNED verify run, so advancing/resuming
  // in place re-parks and bounces back to this same attention (no re-verify) — do NOT suggest it. The
  // paths that actually make progress: a fresh loop mission, or recreating this one with a higher cap.
  return `loop stopped RED — ${count} e2e test(s) still failing after ${loop.round} round(s) (hit the ${why}). The loop won't retry on its own; fix the remaining failures and start a fresh loop mission, or recreate this one with a higher round/budget cap.`;
}

/** SPEC-LOOP W6 — the honest note written when a GREEN loop can't complete its required code review within
 *  the cap. The suite passes but the review is incomplete — say so; a fresh verify won't change it (the
 *  pinned run re-parks), so point at the paths that make progress. */
function reviewGiveUpNote(loop: MissionLoop, why: string): string {
  return `loop stopped — the e2e suite is GREEN but the required code review is still incomplete after ${loop.round} round(s) (hit the ${why}). The loop won't retry on its own; review the change manually and land it, or recreate this mission with a higher round/budget cap.`;
}

/** SPEC-LOOP W2 — count consecutive kind:'mechanical' rounds from the TAIL of the history, stopping at
 *  the first other kind. Once this reaches `loop.mechanicalRounds` the boundary escalates to the planner;
 *  a re-plan ('replanned') at the tail resets the count to 0, so each escalation earns a fresh mechanical
 *  window. With mechanicalRounds===0 this is trivially >= 0 → the FIRST red escalates. */
function trailingMechanicalCount(rounds: MissionRoundRecord[]): number {
  let n = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i]!.kind === 'mechanical') n++;
    else break;
  }
  return n;
}

/**
 * SPEC-LOOP W2 — assemble the re-planner's context bundle from the MISSION ONLY (never live config).
 * SECRETS: names / statuses / failureKeys ONLY — NO task bodies from landed work, NO errorTails, NO
 * env/tokens. `landed` lists every landed/done sortie (do-not-re-plan); `failing` is THIS round's stamped
 * failure keys; `rounds` is the full stamped history (each with its per-round failure keys for the prompt).
 */
// ==================== SPEC-PLANNER — consult helpers (module-level, pure) ====================

/** open = a live continuation the tick still owns; closed = terminal (applied/rejected/expired). */
function isConsultOpen(c: PlannerConsult): boolean {
  return c.status === 'pending' || c.status === 'delivered' || c.status === 'answered';
}
function isConsultClosed(c: PlannerConsult): boolean {
  return !isConsultOpen(c);
}

/** SPEC-PLANNER §5 (P4) — the honest gate note when a consult expires at the attempt cap. The drafted
 *  "resume — or detach to use the built-in brain" advice is FALSE (giveUpEscalation stamps attempts=MAX,
 *  so the top-of-runEscalatedRound guard re-parks on resume; detach doesn't reset attempts either). The
 *  only true remedy is to recreate the mission. */
function plannerExpiryNote(title: string, reason: PlannerConsult['expireReason'], attempts: number): string {
  const why = reason === 'delivery-timeout'
    ? 'the planner pane never read it'
    : 'the planner pane read it but never replied';
  return `planner consult expired (${reason} — ${why}) after ${attempts} attempts. `
    + `The loop won't retry on its own; check the planner terminal "${title}", then recreate the mission `
    + `(a resume re-parks at this gate, and detaching does not reset the attempt count).`;
}

/** SPEC-PLANNER §4 — the 'replan' consult body: a SELF-CONTAINED question (reply protocol + payload
 *  rendered in) that rides HTTP only. The reply protocol comes BEFORE the bundle sections (§m2) so a
 *  16000-char truncation can never eat "how to reply". The bundle is rendered exactly as the codex
 *  REVISION_PREAMBLE consumes it. Bounded to CONSULT_CAPS.question at the store; the prose here stays well
 *  under it, and the payload rides `consult.payload` structurally (this text is the human-readable copy). */
function REPLAN_CONSULT(bundle: PlanRevisionBundle, clocks: { deliverMs: number; answerMs: number }): string {
  const mins = (ms: number): number => Math.round(ms / 60000);
  const lines: string[] = [];
  lines.push('You are this mission\'s PLANNER. Its iterate-until-green loop is stuck: the remaining work');
  lines.push('needs a fresh plan of ONLY the work that is left. Reply with that plan.');
  lines.push('');
  lines.push('HOW TO REPLY (do this first, before reading the context below):');
  lines.push('Run this as a SINGLE command (the heredoc keeps it one `towerctl` invocation, so a spawned');
  lines.push('planner with a standing towerctl grant answers WITHOUT a permission dialog — a piped');
  lines.push('`cat file | towerctl …` is a compound command and would still prompt):');
  lines.push('  towerctl planner reply --file - <<\'EOF\'');
  lines.push('  {"phases":[{"name":"...","stage":"fix",');
  lines.push('    "sorties":[{"name":"...","task":"...","role":"implement",');
  lines.push('      "provider":"...","model":"...","effort":"...","checkCommand":"...","assertions":["..."]}]}]}');
  lines.push('  EOF');
  lines.push('Only `name` and `task` are required per sortie; the rest are optional overrides.');
  lines.push('RULES (a violated rule wastes a re-plan attempt):');
  lines.push('  - Plan ONLY the remaining work. Do NOT re-plan anything already landed (listed below).');
  lines.push('  - Do NOT add a verify/test phase — the Tower appends its own verify tail.');
  lines.push('  - Do NOT use review/investigate/docs markers — plain work phases only.');
  lines.push(`  - You have ~${mins(clocks.deliverMs)} min to read this and ~${mins(clocks.answerMs)} min to reply, or the loop parks for a human.`);
  lines.push('');
  // SPEC-MEMADOPT — read-only for the planner: decisions/gotchas recorded by earlier sorties are
  // re-planning context. The reply protocol above stays first (the §m2 truncation rationale).
  lines.push(`Shared project memory (${MEMORY_FILE_LIST}) may hold decisions and gotchas from earlier work — worth a \`towerctl memory read\` (or \`towerctl memory search <text>\`) before planning. Read-only here: treat it as context, and do not add, update, or dispute entries from this consult.`);
  lines.push('');
  lines.push(`GOAL: ${bundle.goal}`);
  if (bundle.landed.length > 0) {
    lines.push('');
    lines.push('ALREADY LANDED (do NOT re-plan these):');
    for (const l of bundle.landed) lines.push(`  - ${l}`);
  }
  if (bundle.failing.length > 0) {
    lines.push('');
    lines.push('CURRENTLY FAILING (the remaining work must make these pass):');
    for (const f of bundle.failing) lines.push(`  - ${f}`);
  }
  if (bundle.rounds.length > 0) {
    lines.push('');
    lines.push('ROUND HISTORY (what earlier rounds tried):');
    for (const r of [...bundle.rounds].reverse()) {
      const bits = [`round ${r.n} (${r.kind})`];
      if (r.failed !== undefined && r.total !== undefined) bits.push(`${r.failed}/${r.total} failing`);
      if (r.tried) bits.push(`tried: ${r.tried}`);
      lines.push(`  - ${bits.join(' — ')}`);
    }
  }
  if (bundle.reviewFindings && bundle.reviewFindings.length > 0) {
    lines.push('');
    lines.push('CODE-REVIEW FINDINGS:');
    for (const f of bundle.reviewFindings) lines.push(`  - ${f}`);
  }
  if (bundle.research && bundle.research.length > 0) {
    lines.push('');
    lines.push('RESEARCH FINDINGS:');
    for (const r of bundle.research) lines.push(`  - ${r}`);
  }
  return lines.join('\n').slice(0, 16000);
}

/**
 * SPEC-PLANNER §6 — the self-brief served in EVERY `towerctl planner pending` response (DEC-P6), so a
 * fresh (respawned) pane self-briefs over HTTP with nothing typed. Derived on demand from the mission +
 * its consult ledger. SECRETS: the buildRevisionBundle field discipline EXACTLY — goal, per-phase
 * name/stage/round + per-sortie name/status, round history with failure keys, and a bounded Q/A ledger
 * (never full answers, never task bodies of landed work, never errorTails/env/tokens). Pure + exported so
 * the server route calls it without importing the store internals.
 */
export interface PlannerBrief {
  goal: string;
  phases: { name: string; stage?: string; round?: number; sorties: { name: string; status: string }[] }[];
  rounds: { n: number; kind: string; failed?: number; total?: number; failureKeys?: string[] }[];
  ledger: { id: string; kind: string; status: string; question: string; phases?: string[] }[];
}
export function buildPlannerBrief(mission: Mission, consults: PlannerConsult[]): PlannerBrief {
  return {
    goal: mission.goal,
    phases: mission.phases.map((p) => ({
      name: p.name,
      ...(p.stage ? { stage: p.stage } : {}),
      ...(p.round !== undefined ? { round: p.round } : {}),
      sorties: p.sorties.map((s) => ({ name: s.name, status: s.status })),
    })),
    rounds: (mission.loop?.rounds ?? [])
      .filter((r) => r.kind !== 'escalating')
      .map((r) => ({
        n: r.n,
        kind: r.kind,
        ...(r.failed !== undefined ? { failed: r.failed } : {}),
        ...(r.total !== undefined ? { total: r.total } : {}),
        ...(r.failureKeys && r.failureKeys.length > 0 ? { failureKeys: r.failureKeys } : {}),
      })),
    // The last 6 consults (newest first), question truncated; for an APPLIED replan the phase names only,
    // never the full answer body.
    ledger: consults.slice(0, 6).map((c) => ({
      id: c.id,
      kind: c.kind,
      status: c.status,
      question: c.question.slice(0, 300),
      ...(c.status === 'applied' && c.kind === 'replan'
        ? { phases: (((c.answer as { phases?: { name?: string }[] } | undefined)?.phases) ?? []).map((p) => p.name ?? '(unnamed)').slice(0, 20) }
        : {}),
    })),
  };
}

function buildRevisionBundle(mission: Mission, loop: MissionLoop, stampedRounds: MissionRoundRecord[], reviewFindings?: string[], research?: string[]): PlanRevisionBundle {
  const landed: string[] = [];
  for (const p of mission.phases) {
    const tag = [p.stage, p.round !== undefined ? `round ${p.round}` : undefined].filter(Boolean).join(' ');
    for (const s of p.sorties) {
      if (s.status === 'landed' || s.status === 'done') {
        landed.push(`${p.name}${tag ? ` [${tag}]` : ''}: ${s.name} (${s.status})`);
      }
    }
  }
  const failing = stampedRounds.find((r) => r.n === loop.round)?.failureKeys ?? [];
  // Precompute round → sortie names ONCE (was an O(phases) scan per round). Excludes the in-progress
  // 'escalating' placeholder record from the history — it's not a round the planner should reason about.
  const triedByRound = new Map<number, string[]>();
  for (const p of mission.phases) {
    if (p.round === undefined) continue;
    const arr = triedByRound.get(p.round) ?? [];
    for (const s of p.sorties) arr.push(s.name);
    triedByRound.set(p.round, arr);
  }
  const rounds = stampedRounds
    .filter((r) => r.kind !== 'escalating')
    .map((r) => {
      const tried = triedByRound.get(r.n);
      return {
        n: r.n,
        kind: r.kind,
        ...(r.failed !== undefined ? { failed: r.failed } : {}),
        ...(r.total !== undefined ? { total: r.total } : {}),
        ...(tried && tried.length > 0 ? { tried: tried.join(', ') } : {}),
        ...(r.failureKeys && r.failureKeys.length > 0 ? { failureKeys: r.failureKeys } : {}),
      };
    });
  return {
    goal: mission.goal, landed, failing, rounds,
    ...(reviewFindings !== undefined ? { reviewFindings } : {}),
    ...(research !== undefined ? { research } : {}),
  };
}

/**
 * SPEC-LOOP §3 W2 — the COPY-ONLY whitelist for an UNREVIEWED re-plan: fresh phase/sortie objects
 * carrying ONLY name/task/assertions/checkCommand/role/provider/model/effort/verifyFixer — NEVER a docs/review/
 * investigate marker (those enter the FSM only through the reviewed marker-phase discipline). Whole
 * 'verify' phases are dropped (the Tower appends its own verify tail); a 'build'/'fix' stage survives,
 * any other stage is coerced away to an ordinary work phase. `verifyFixer` survives ONLY on the FIRST
 * work phase's sorties (assignFixerPhase partitions those from the prior round's verify runner — a later
 * phase has no verify predecessor); a verifyFixer anywhere else is dropped and flagged. Returns the
 * sanitized phases + whether any marker was dropped (for the caller's audit).
 */
function sanitizeRevisionPhases(
  reqPhases: CreateMissionRequest['phases'],
): { sanitized: CreateMissionRequest['phases']; droppedMarker: boolean } {
  let droppedMarker = false;
  // parsePlan already drops empty-sortie phases, so the first surviving non-verify phase is the real
  // first work phase — its index carries the sole verifyFixer license.
  const kept = (reqPhases ?? []).filter((p) => p.stage !== 'verify');
  const sanitized = kept
    .map((p, phaseIdx) => ({
      name: p.name,
      ...(p.stage === 'build' || p.stage === 'fix' ? { stage: p.stage } : {}),
      sorties: (p.sorties ?? []).map((s) => {
        if (s.verifyFixer === true && phaseIdx !== 0) droppedMarker = true;
        return {
          name: s.name,
          task: s.task,
          ...(s.assertions ? { assertions: s.assertions } : {}),
          ...(s.checkCommand ? { checkCommand: s.checkCommand } : {}),
          ...(s.role ? { role: s.role } : {}),
          ...(s.provider ? { provider: s.provider } : {}),
          ...(s.model ? { model: s.model } : {}),
          // SPEC-EFFORT §1 — a re-planned phase's effort is as safe to copy as its model.
          ...(s.effort ? { effort: s.effort } : {}),
          ...(phaseIdx === 0 && s.verifyFixer === true ? { verifyFixer: true } : {}),
        };
      }),
    }))
    .filter((p) => p.sorties.length > 0);
  return { sanitized, droppedMarker };
}

/** SPEC-LOOP §2 — a mechanical round's phases: [fix(F fixers), verify(1 runner)]. Fresh shortIds; the
 *  fixers carry verifyFixer:true (assignFixerPhase partitions them from the PREVIOUS verify phase's
 *  runner failures); the verify runner re-runs the suite as the round's regression evidence. Both phases
 *  carry stage + round so the boundary evaluator, the gate-skip and the Board round strip see them.
 *  SPEC-LOOP W7 — with `investigate` on, an investigate phase is PREPENDED: [investigate(1), fix(F),
 *  verify(1)]; assignFixerPhase then partitions only the investigator's 'real' failures. */
function mechanicalRoundPhases(round: number, fixerCount: number, investigate = false): MissionPhase[] {
  const fixers: MissionSortie[] = Array.from({ length: fixerCount }, (_, i) => ({
    id: shortId(),
    name: `fixer ${i + 1}`,
    task: LOOP_FIXER_TASK,
    // No checkCommand — run-and-report (see LOOP_FIXER_TASK): a whole-suite check can't pass in a
    // single fixer's isolated worktree, so it would iterate to attention and stall the loop.
    role: 'implement' as PipelineRole,
    verifyFixer: true,
    status: 'pending' as SortieStatus,
  }));
  return [
    ...(investigate ? [investigatePhase(round)] : []),
    { id: shortId(), name: `fix (round ${round})`, stage: 'fix', round, sorties: fixers },
    loopVerifyPhase(round),
  ];
}

/** SPEC-LOOP §2 — the round's verify phase: a single tester runner that re-runs the suite as the round's
 *  regression evidence. Extracted so BOTH a mechanical round and a W2 escalated (re-planned) round end
 *  in the identical Tower-authored verify tail (the loop is never the planner's to close).
 *
 *  The verify runner carries NO checkCommand: with gatePolicy:'never' + no check, the agent runs the
 *  suite (recording the TestRun), self-reports pass, makes zero commits, and loops.ts's no-change path
 *  resolves it to 'landed' — so the phase reaches the boundary even when the suite is RED, and
 *  evaluateCompletion judges green/red off the recorded run (a checkCommand would instead iterate the
 *  sortie to attention on red, making the round append unreachable). */
function loopVerifyPhase(round: number): MissionPhase {
  const runner: MissionSortie = {
    id: shortId(),
    name: 'verify e2e suite',
    task: LOOP_VERIFY_TASK,
    role: 'tester' as PipelineRole,
    status: 'pending' as SortieStatus,
  };
  return { id: shortId(), name: `verify (round ${round})`, stage: 'verify', round, sorties: [runner] };
}

/** SPEC-LOOP W7 — a mechanical round's investigate phase: a single routed investigator that classifies the
 *  PREVIOUS verify run's failures (assignInvestigatePhase finalizes its task at phase start). Carries NO
 *  stage — identification is marker-only (isInvestigatePhase) — and NO checkCommand: with gatePolicy:'never'
 *  it runs, submits triage, makes zero commits, and the no-change path lands it (the verify-runner
 *  rationale). It never lands code — triage rides the ReviewStore-like meta.json, not the branch. */
function investigatePhase(round: number): MissionPhase {
  const investigator: MissionSortie = {
    id: shortId(),
    name: 'investigate failures',
    task: LOOP_INVESTIGATE_TASK,
    role: 'review-judge' as PipelineRole,
    investigateSortie: true,
    status: 'pending' as SortieStatus,
  };
  return { id: shortId(), name: `investigate (round ${round})`, round, sorties: [investigator] };
}

/** SPEC-LOOP W6 — a self-heal review round's phases: [review(1 reviewer), verify(1 runner)]. The reviewer
 *  carries reviewSortie:true (assignReviewPhase finalizes its task from the base commit at phase start) and
 *  the REVIEW_CHECK_COMMAND check (fails while it has not submitted or its branch holds commits — the belt
 *  that steers a scratch-writing reviewer back to a zero-commit branch); the verify runner re-runs the
 *  suite so every appended round still ends in a fresh verify (frozen §0). It INHERITS the operator's
 *  authored reviewer route (`route`, from authoredReviewerRoute) — so a valid per-sortie provider/model/
 *  account override is used instead of the bare 'review-judge' role default (which the start() gate might
 *  otherwise reject for resolving to the Brain); role stays 'review-judge' (a reviewer is always that role). */
function reviewRoundPhases(round: number, route?: { provider?: ProviderId; model?: string; effort?: string; profileId?: string }): MissionPhase[] {
  const reviewer: MissionSortie = {
    id: shortId(),
    name: 'code review',
    task: LOOP_REVIEW_TASK,
    role: 'review-judge' as PipelineRole,
    checkCommand: REVIEW_CHECK_COMMAND,
    reviewSortie: true,
    status: 'pending' as SortieStatus,
    ...(route?.provider ? { provider: route.provider } : {}),
    ...(route?.model ? { model: route.model } : {}),
    // SPEC-EFFORT §2 — the self-heal reviewer keeps the authored reviewer's effort.
    ...(route?.effort ? { effort: route.effort } : {}),
    ...(route?.profileId ? { profileId: route.profileId } : {}),
  };
  return [
    { id: shortId(), name: `review (round ${round})`, stage: 'review', round, sorties: [reviewer] },
    loopVerifyPhase(round),
  ];
}

/** SPEC-LOOP W6 — a review-fix round's phases: [fix(F review-fixers), verify(1 runner)]. The fixers carry
 *  reviewFixer:true (assignReviewFixPhase partitions the reviewer's CONFIRMED findings by file across
 *  them) and NO checkCommand (run-and-report, the LOOP_FIXER_TASK rationale); the verify runner re-runs
 *  the suite as the round's regression evidence. Mirrors mechanicalRoundPhases. */
function reviewFixRoundPhases(round: number, fixerCount: number): MissionPhase[] {
  const fixers: MissionSortie[] = Array.from({ length: fixerCount }, (_, i) => ({
    id: shortId(),
    name: `review-fixer ${i + 1}`,
    task: LOOP_REVIEW_FIX_TASK,
    role: 'implement' as PipelineRole,
    reviewFixer: true,
    status: 'pending' as SortieStatus,
  }));
  return [
    { id: shortId(), name: `review-fix (round ${round})`, stage: 'fix', round, sorties: fixers },
    loopVerifyPhase(round),
  ];
}

/** The first non-blank line of an error tail, bounded — for a compact one-line failure summary. */
function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim().length > 0) ?? '').trim().slice(0, 200);
}

/**
 * SPEC-STORYLOOP §3.3 — the task rewritten onto one fixer sortie from its partitioned bucket. Names
 * its spec files and the failing tests, and tells it to run `towerctl test run` to reproduce/confirm
 * (S5: the command rides injectPrompt into the agent unprompted). Bounded so a huge failure set can't
 * blow the prompt.
 */
function fixerTask(failures: TestFailure[]): string {
  const specFiles = [...new Set(failures.map((f) => f.specFile))];
  const body = failures.map((f) => `- ${f.specFile} › ${f.testTitle}\n  ${firstLine(f.errorTail)}`).join('\n');
  return [
    'Fix the e2e failures assigned to you, then run `towerctl test run` to reproduce and confirm they pass.',
    `Spec file(s) you own: ${specFiles.join(', ')}. Do not edit spec files outside this set — another agent may own them.`,
    '',
    'Failing tests:',
    body,
  ]
    .join('\n')
    .slice(0, 8000);
}

/**
 * SPEC-LOOP W7 — the task finalized onto the investigator sortie from the previous verify run's failures.
 * It CLASSIFIES (never fixes): read-only, and it must write NO files — any scratch file is auto-committed
 * (`git add -A` each iteration) and LANDED into the branch, so it mandates INLINE `--entries` submission
 * (or a --file under /tmp, never the worktree). Keys must be the specFile/testTitle VERBATIM (the filter
 * join). Unclassified ⇒ real (the fail-safe: triage can only remove work, never fabricate a green).
 * Bounded ≤8000 like fixerTask.
 */
function investigateTask(failures: TestFailure[], runId: string): string {
  const body = failures.map((f) => `- ${f.specFile} › ${f.testTitle}\n  ${firstLine(f.errorTail)}`).join('\n');
  return [
    `Classify EVERY failing e2e test from the previous verify run (run ${runId}). You are a triager, not a fixer: do NOT modify, create, or delete any file, and do NOT commit — anything left in the worktree is auto-committed and landed into the branch, so create no scratch files.`,
    '',
    'Decide one class for each failing test below:',
    '  - real       — a genuine bug the fixers should fix.',
    '  - by-design  — the test asserts behavior that is intentionally different now (the test/expectation is outdated).',
    '  - false      — a flaky or environmental failure unrelated to the code under test.',
    'When unsure, classify it real — an unclassified failure is treated as real, so fixers still see it.',
    '',
    'Submit ONCE, inline (write no files into the repo — pass the JSON on the command line, or use a --file path under /tmp, never the worktree):',
    '',
    `  towerctl test triage --entries '[{"specFile":"…","testTitle":"…","class":"real|by-design|false","reason":"…"}]'`,
    '',
    'Use the specFile and testTitle EXACTLY as listed below — they are the match keys. Failing tests:',
    body,
  ]
    .join('\n')
    .slice(0, 8000);
}

/**
 * SPEC-LOOP W6 — the task finalized onto a reviewer sortie. Names the exact commit RANGE (`<baseSha>..HEAD`,
 * the mission's base commit — recorded at first start for ALL missions, SPEC-TERMINAL-OPS §6 — → the branch
 * tip) so the reviewer never runs a bare `git diff HEAD`
 * (the work is already committed to the branch, so that shows an empty diff a required review could attest
 * clean over). assignReviewPhase routes to attention when no baseSha exists, so a range is always present
 * here. Forbids ANY code modification/commit (the per-iteration `git add -A` auto-commit would otherwise
 * land a reviewer's scratch-write, so it explains the `git reset --hard` recovery), asks for CONFIRMED-vs-
 * PLAUSIBLE classification, and shows the exact stdin submit call (so no findings file is written into the
 * repo and auto-committed) plus `--clean` for the attested-empty case. Bounded ≤8000.
 */
function reviewTask(mission: Mission, range: string): string {
  return [
    `You are the code reviewer for mission "${mission.name}". Review the commit range \`${range}\` for correctness bugs, regressions, and clear quality problems.`,
    '',
    `Read the diff with \`git diff ${range}\` and open the surrounding files for context. Do NOT modify any code, do NOT commit, do NOT stage anything — you are a reviewer, not a fixer. If you accidentally change a file, run \`git reset --hard\` to discard it before you finish: the Tower auto-commits any leftover change, and a reviewer whose branch holds a commit fails its own check.`,
    '',
    'Classify every finding you raise:',
    '  - CONFIRMED — a real bug or regression you are confident is wrong. These are handed to fixers.',
    '  - PLAUSIBLE — a concern worth an operator’s eye but not certainly wrong. Surfaced in the report, not auto-fixed.',
    'A finding with no verdict is treated as CONFIRMED.',
    '',
    'Submit your review as JSON on stdin (so nothing is written into the repo):',
    '',
    "  towerctl review submit --file - <<'JSON'",
    '  {"findings":[',
    '    {"file":"src/foo.ts","line":42,"summary":"off-by-one in the loop bound","detail":"…","category":"correctness","verdict":"CONFIRMED"}',
    '  ]}',
    '  JSON',
    '',
    'If the change is sound and you found nothing, attest it explicitly instead:',
    '',
    '  towerctl review submit --clean',
    '',
    'A clean review is YOUR attestation, not a machine proof. Submit exactly once, then stop.',
  ]
    .join('\n')
    .slice(0, 8000);
}

/**
 * SPEC-LOOP W6 — the task rewritten onto one review-fixer sortie from its partitioned findings. Mirrors
 * fixerTask: names the file(s) it owns and the confirmed findings to fix, warns against editing files
 * outside its set. Bounded so a huge finding set can't blow the prompt.
 */
function reviewFixTask(findings: ReviewFinding[]): string {
  const files = [...new Set(findings.map((f) => f.file))];
  const body = findings
    .map((f) => {
      const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
      const detail = f.detail ? `\n  ${firstLine(f.detail)}` : '';
      return `- ${loc} — ${f.summary}${detail}`;
    })
    .join('\n');
  return [
    'Fix the code-review findings assigned to you. A code reviewer flagged these as confirmed bugs — correct the code.',
    `File(s) you own: ${files.join(', ')}. Do not edit files outside this set — another agent may own them.`,
    '',
    'Findings:',
    body,
  ]
    .join('\n')
    .slice(0, 8000);
}

/** SPEC-TESTING §3 — a documentor-STAGE sortie: docs-marked (awaiting task finalization) or
 *  already finalized from a run (docsFromRun). Drives every never-gates enforcement point.
 *  Deliberately NOT the generic role:'docs' — a hand-authored docs-role sortie carries no stage
 *  marker and must gate/fail like any other sortie (never-gates would mask its failures). */
function isDocsSortie(s: MissionSortie): boolean {
  return s.docsSortie === true || s.docsFromRun !== undefined;
}

/** SPEC-LOOP W6 — a review (judge) sortie: review-marked (awaiting task finalization) or already
 *  finalized from the base commit (reviewFromRange). Drives the refuse-to-land guard, the review-state
 *  scan, and the retry re-arm. Distinct from a review-FIXER (reviewFixer/assignedFromReview) — a fixer
 *  lands its code normally; only the judge sortie is refused-to-land and never merges. */
function isReviewSortie(s: MissionSortie): boolean {
  return s.reviewSortie === true || s.reviewFromRange !== undefined;
}

/** SPEC-LOOP W6 — the route overrides of the mission's AUTHORED reviewer (the earliest review sortie),
 *  so a self-heal review round AND the start() pre-check use the SAME route the operator chose for their
 *  reviewer rather than the bare 'review-judge' role default (which might resolve to the codex Brain).
 *  undefined when no review sortie is authored (a pure API/Jarvis requireReview mission) → the role
 *  default is validated / used as-is. */
function authoredReviewerRoute(mission: Mission): { provider?: ProviderId; model?: string; effort?: string; profileId?: string } | undefined {
  for (const p of mission.phases) {
    const s = p.sorties.find(isReviewSortie);
    if (s) return { provider: s.provider, model: s.model, effort: s.effort, profileId: s.profileId };
  }
  return undefined;
}

/** SPEC-TESTING §3 — a docs phase (which never gates): every sortie in it is a docs sortie. */
function isDocsPhase(phase: MissionPhase): boolean {
  return phase.sorties.length > 0 && phase.sorties.every(isDocsSortie);
}

/** SPEC-LOOP W7 — a false-fail investigator sortie: marker set (awaiting task finalization) or already
 *  finalized from a run (investigateFromRun). Drives assignFixerPhase's predecessor walk-back, the
 *  runAdvance gate-skip, and the retry re-arm. Like isDocsSortie, survives assignment AND the drop-out. */
function isInvestigateSortie(s: MissionSortie): boolean {
  return s.investigateSortie === true || s.investigateFromRun !== undefined;
}

/** SPEC-LOOP W7 — an investigate phase (read-only classification; never gates): every sortie is one. */
function isInvestigatePhase(phase: MissionPhase): boolean {
  return phase.sorties.length > 0 && phase.sorties.every(isInvestigateSortie);
}

/** SPEC-RESEARCH W9 — a research sortie (role 'explore'): its success is a submitted finding, never
 *  commits. There is no assign-time finalization and no runtime pin, so unlike the other four markers
 *  this one is never cleared and the single boolean IS the identification. */
function isResearchSortie(s: MissionSortie): boolean {
  return s.researchSortie === true;
}

/** SPEC-RESEARCH W9 — a research phase (nothing to regression-test; never lands code): every sortie
 *  is one. A hand-MIXED phase (builder + researcher) is therefore not a research phase — it gates and
 *  trial-merges like any other, and the per-sortie refuse-to-land still blocks the researcher's own
 *  branch. Identical exposure to a hand-mixed reviewer today; same stance. */
function isResearchPhase(phase: MissionPhase): boolean {
  return phase.sorties.length > 0 && phase.sorties.every(isResearchSortie);
}

/**
 * SPEC-TESTING §3 — the task finalized onto a docs sortie from the verify run. Mirrors fixerTask:
 * names the mission goal, the phases that landed, and the run's pass/fail counts, then asks for
 * documentation updated to the VERIFIED behavior. Bounded so a huge mission can't blow the prompt.
 */
function docsTask(run: RunnerRun, mission: Mission): string {
  const landedPhases = mission.phases
    .filter((p) => p.sorties.length > 0 && p.sorties.every((s) => s.status === 'landed'))
    .map((p) => p.name);
  const failed = run.failed ?? run.results?.length ?? 0;
  const counts =
    run.total !== undefined
      ? `${Math.max(0, run.total - failed)}/${run.total} tests passing (${failed} failing)`
      : failed === 0
        ? 'suite green'
        : `${failed} test(s) failing`;
  return [
    'Update the project documentation (README and docs/) so it reflects the verified behavior that just landed.',
    '',
    `Mission goal: ${mission.goal}`,
    landedPhases.length > 0 ? `Landed phases: ${landedPhases.join(', ')}` : 'Landed phases: (none recorded)',
    `E2E verification (run ${run.id}): ${counts}.`,
    '',
    'Document what the e2e suite proves works — user-facing behavior, setup, and commands. Do not describe unverified or still-failing behavior as working.',
  ]
    .join('\n')
    .slice(0, 8000);
}

/** SPEC-STORYLOOP §4 — the attention note carrying a red gate's structured failures. Bounded to the
 *  same ≤2000-char budget the loop's feedback uses. */
function gateFailureNote(failures: TestFailure[]): string {
  const head = failures.slice(0, 20).map((f) => `- ${f.specFile} › ${f.testTitle}: ${firstLine(f.errorTail)}`);
  const more = failures.length > 20 ? `\n…and ${failures.length - 20} more` : '';
  return `regression gate: the integrated tree failed the e2e suite — nothing landed. Fix and re-advance:\n${head.join('\n')}${more}`.slice(
    0,
    2000,
  );
}
