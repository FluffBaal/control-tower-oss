// Tower server entrypoint. Fastify for HTTP + a ws server for terminal streaming +
// SSE for live Mission Control updates. Binds 127.0.0.1 only. Every /api route and
// the WS upgrade go through control-plane auth (Auth). Runtime terminal liveness is
// derived from tmux via the reconciler, not trusted from config.

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync, constants as fsConstants } from 'node:fs';
import { open as fsOpen } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { ensureDirs, paths, CT_WORKTREES_DIRNAME } from './paths.js';
import { Store, REVIEW_CAPS, RESEARCH_CAPS, GATE_CAPS, CONSULT_CAPS, writeJsonAtomic } from './store.js';
import { Auth, authRoutePath } from './auth.js';
import { attachTerminalSocket, MAX_TERMINAL_FRAME_BYTES } from './ws-protocol.js';
import { TerminalManager, terminalCapacity, shouldReapTerminal, accountCredentialProbe, liveConfigDirFor } from './terminal-manager.js';
import { makeLoopAccountResolver } from './loop-account.js';
import { Reconciler } from './reconciler.js';
import { MissionControl } from './mission.js';
import { Poller } from './poller.js';
import { WorktreeManager } from './worktrees.js';
import { Accounts, accountsRoot, shredAccountDir, canonicalAccountPath } from './accounts.js';
import { Broker, ensureCredentialScript, CREDENTIAL_SCRIPT, BROKER_SOCK, validateRepoUrl, createGitHubPr } from './broker.js';
import { securityStatus, projectSecurity, hostIsolationAvailable, sandboxToolAvailable, SETUP_COMMAND } from './isolation.js';
import { Settings } from './settings.js';
import { Loops } from './loops.js';
import { Missions, computePhasesHash, isTerminalLoop, buildPlannerBrief } from './missions.js';
import { RegressionGate } from './gate.js';
import { Reports } from './report.js';
import { ReviewStore, isConfirmed, canonicalizeReviewPath, isStaleReviewRecord, isPreRetryReviewLoop } from './reviews.js';
import { GateEvidenceStore } from './gates.js';
import { ResearchStore } from './research.js';
import { ConsultStore } from './consults.js';
import { StoryStore } from './stories/store.js';
import { SkillStore, isProtectedSkill, slugifySkillName, isReservedSkillId } from './skills/store.js';
import { SkillDraftStore, draftContentHash } from './skills/drafts.js';
import { scanSecrets, skillDraftScanText } from './skills/lint.js';
import { lintGateSabotage } from '../shared/skill-lint.js';
import { importSkillsFromDir } from './skills/import.js';
import { SkillSelectionStore, BundleReferencedError } from './skills/selection.js';
import { providerEligible, CHANNEL_PROVIDER_IDS } from './skills/materialize.js';
import { renderSkillBrief, briefDeliverable } from './skills/brief.js';
import { BacklogStore, TaskGuardError } from './backlog/store.js';
import { ProposalStore } from './assistant/proposals.js';
import { makeProposalExecutor, countFinished, normalizeRepoPath } from './assistant/actions.js';
import { coverage } from './stories/coverage.js';
import type { StoryCoverage } from './stories/coverage.js';
import { Leases, LeaseHeldError } from './leases.js';
import { preflightBootstrap, executeBootstrap } from './bootstrap.js';
import { Validator } from './validator.js';
import type { PlanRosterEntry } from './validator.js';
import { ProviderStore } from './providers/store.js';
import { ModelCatalogStore, buildModelsView, discoverCodexModels } from './providers/model-catalog.js';
import { initProviderRegistry } from './providers/registry.js';
import { RoutingStore, WorkflowReferencedError, discoverModels, validateRoute, resolveRouting } from './providers/routing.js';
import type { LaunchContext } from './adapters/types.js';
import { AssistantStore } from './assistant/store.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { registerFileRoutes, resolveContained } from './files.js';
import { TestingConfigStore } from './testing/config.js';
import { fileFailuresAsTasks } from './testing/feedback.js';
import { captureRunLogs } from './testing/logs.js';
import { Mail, Memory, searchLogs, MEMORY_FILES, INVALID_PROJECT_ID, StaleViewError } from './coordination.js';
import {
  MemoryStore,
  StaleRevError,
  RequestConflictError,
  CapError,
  NotFoundError as MemNotFoundError,
  TransitionError,
  OwnershipError,
  EvidencePermissionError,
  DisputedSourceError,
  CycleError,
  ForeignVersionError,
  ReservedSyntaxError,
} from './memory/store.js';
import type { MemoryPrincipal, MemorySearchQuery, MemoryKind, MemoryLifecycle, MemoryVerification } from '../shared/memory.js';
import { memoryAddRequestSchema, memoryUpdateRequestSchema, memoryConsolidateRequestSchema } from './memory/schema.js';
import { composeMemoryBriefing } from './memory/briefing.js';
import { TestKit, cleanTriageEntries } from './testkit.js';
import type { TestRun } from './testkit.js';
import { Retention, diskInfo } from './retention.js';
import { ClaudeCredRefresher } from './claude-cred-refresher.js';
import { readdirSync, rmSync, lstatSync } from 'node:fs';
import {
  ensureHookScript,
  ensureUsageScript,
  ensureTowerctlLauncher,
  ensureBinOnPath,
  HookTokens,
  drainSpool,
  spoolEvent,
  isOrderedEmitTs,
  HOOK_SCRIPT,
  USAGE_SCRIPT,
  type SpooledEvent,
} from './hooks.js';
import { registerRunwayRoutes } from './runway/routes.js';
import { detectAllVersions, updateProvider, updatableProviders } from './cli-updates.js';
import { RunwayStore } from './runway/store.js';
import { UsageStore } from './runway/usage.js';
import { parseStatusLinePayload } from './runway/parse.js';
import { accountIdentityFor } from './runway/identity.js';
import { performLiveSwap } from './runway/live-swap.js';
import { dispatchLiveSwap, createLiveSwapTrigger } from './runway/live-swap-dispatch.js';
import { removeLiveSlot, sweepOrphanSlots } from './live-slot.js';
import { chooseRotation, maxUsedPct, soonestResetMs, isOverThreshold, type RotationCandidate } from './runway/controller.js';
import { acquireInstanceLock } from './lock.js';
import { getAdapter, listAdapters } from './adapters/index.js';
import { shortId, isSafeName } from './ids.js';
import { audit, auditTail } from './audit.js';
import * as tmux from './tmux.js';
import type {
  Project,
  Loop,
  CreateTerminalRequest,
  CreateLoopRequest,
  CreateMissionRequest,
  CreateStoryRequest,
  UpsertSkillRequest,
  EffectiveSkillEntry,
  CreateTaskRequest,
  MissionPlanReview,
  TaskStatus,
  HealthReport,
  WireHookSignal,
  StreamEvent,
  Terminal,
  ProviderDef,
  ProviderId,
  CustomProviderId,
  PipelineRole,
  RoleAssignment,
  RoleRouting,
  ReviewFinding,
  ResearchCitation,
  GlobalSettingsView,
  Mission,
  MissionPlanner,
  PlannerConsult,
} from '../shared/types.js';
// triageKey / triageCounts are runtime VALUES (the triage route derives a run's failure-key set and the
// shared occurrence-granularity counts with them) — value imports.
import { triageKey, triageCounts } from '../shared/types.js';

const VERSION = '0.7.0';

/** Parse a positive-integer env override, falling back on missing/non-numeric input so
 *  a typo (e.g. CT_PORT=foo) can't silently produce NaN and disable a limit or port. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * SPEC-PLANNER §6 — the LIGHT shape gate for a planner 'replan' reply (the trusted pipeline stays at the
 * tick, DEC-P4). Hand-rolled to match server.ts's `capResearch` idiom (this file uses no zod). Accepts a
 * bare `{ phases: [...] }` object, coerces + caps each field, and returns undefined on anything that
 * cannot be a plan (so the route 400s WITHOUT burning the escalation attempt or the consult). Markers are
 * never accepted here — the tick's sanitizeRevisionPhases is the sole marker gate.
 */
function parseReplyPhases(raw: unknown): { phases: CreateMissionRequest['phases'] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const phasesRaw = (raw as { phases?: unknown }).phases;
  if (!Array.isArray(phasesRaw) || phasesRaw.length === 0) return undefined;
  const phases: NonNullable<CreateMissionRequest['phases']> = [];
  for (const p of phasesRaw.slice(0, 12)) {
    if (!p || typeof p !== 'object') return undefined;
    const po = p as Record<string, unknown>;
    const name = typeof po.name === 'string' ? po.name.trim().slice(0, 200) : '';
    if (!name) return undefined;
    const sortiesRaw = po.sorties;
    if (!Array.isArray(sortiesRaw) || sortiesRaw.length === 0) return undefined;
    const sorties: NonNullable<CreateMissionRequest['phases']>[number]['sorties'] = [];
    for (const s of sortiesRaw.slice(0, 8)) {
      if (!s || typeof s !== 'object') return undefined;
      const so = s as Record<string, unknown>;
      const sName = typeof so.name === 'string' ? so.name.trim().slice(0, 200) : '';
      const task = typeof so.task === 'string' ? so.task.trim().slice(0, 8000) : '';
      if (!sName || !task) return undefined; // name + task are the only required fields
      const entry: NonNullable<CreateMissionRequest['phases']>[number]['sorties'][number] = { name: sName, task };
      if (typeof so.role === 'string') entry.role = so.role as PipelineRole; // validated at the tick's route check
      if (typeof so.provider === 'string') entry.provider = so.provider as ProviderId;
      if (typeof so.model === 'string') entry.model = so.model.slice(0, 200);
      if (typeof so.effort === 'string') entry.effort = so.effort.slice(0, 40);
      if (typeof so.checkCommand === 'string') entry.checkCommand = so.checkCommand.slice(0, 500);
      if (Array.isArray(so.assertions)) {
        const asserts = so.assertions.filter((a): a is string => typeof a === 'string').map((a) => a.slice(0, 500)).slice(0, 20);
        if (asserts.length) entry.assertions = asserts;
      }
      sorties.push(entry);
    }
    // Only 'build'/'fix' survive sanitizeRevisionPhases anyway; keep those, drop any other stage here.
    const stage = po.stage === 'build' || po.stage === 'fix' ? po.stage : undefined;
    phases.push({ name, ...(stage ? { stage } : {}), sorties });
  }
  return { phases };
}

const PORT = intEnv('CT_PORT', 4870);
const HOST = '127.0.0.1';
// Graceful shutdown: how long to let in-flight loop/mission work (a running check command or git
// commit) finish before closing, and the hard backstop after which the process force-exits even if the
// drain or app.close() hangs. FORCE must exceed DRAIN so the drain gets its full window first.
const SHUTDOWN_DRAIN_MS = 8000;
const SHUTDOWN_FORCE_MS = 12000;
const startedAt = Date.now();

const TOKEN_EXEMPT = new Set([
  '/api/session',
  '/api/events',
  '/api/stream',
  '/api/agent/mail/send',
  '/api/agent/mail/inbox',
  '/api/agent/memory',
  '/api/agent/test/acquire',
  '/api/agent/test/release',
  '/api/agent/test/latest',
  // SPEC-LOOP W7 — the routed investigator's triage route. Exempts ONLY the session-token check (the
  // acquire/release/latest precedent); the route then demands the per-terminal token and spends ZERO
  // LLM/network (pure store ops). Operator-only LLM routes (summarize, review-plan) stay NON-exempt.
  // Deliberately NOT in ASSISTANT_ACCEPT (Jarvis must not submit triage).
  '/api/agent/test/triage',
  // SPEC-LOOP W6 — the routed reviewer's structured-findings route. Self-authenticates via
  // agentTerminal() (the per-terminal token), spends ZERO LLM/network (pure store ops), and derives
  // its (missionId,sortieId) exclusively token→terminal→loop — so it is REQUIRED here (the onRequest
  // hook 401s any /api path not in this set for a terminal-token caller) yet keeps the operator-only-
  // LLM rule intact. NOT in ASSISTANT_ACCEPT (Jarvis must not submit reviews).
  '/api/agent/review',
  // SPEC-SKILLS-GATE — the loop-green gate attestation route. Same posture as the review route above:
  // self-authenticates via agentTerminal() (the per-terminal token), spends ZERO LLM/network (pure
  // store ops), and derives its (missionId,sortieId) exclusively token→terminal→loop→sortie. One entry
  // covers both verbs (this set is path-keyed). NOT in ASSISTANT_ACCEPT — Jarvis must not attest gates.
  '/api/agent/gate',
  // SPEC-RESEARCH W9 — the research sortie's finding-submit route. Same posture as the review route
  // above: self-authenticates via the per-terminal token, spends ZERO LLM/network (pure store ops), and
  // derives its (missionId,sortieId) exclusively token→terminal→loop→sortie. One entry covers both
  // verbs (this set is path-keyed). NOT in ASSISTANT_ACCEPT — Jarvis must not submit findings.
  '/api/agent/research',
  // SPEC-PLANNER §6 — the planner terminal's consult routes. Same posture as review/research: self-
  // authenticate via the per-terminal token, spend ZERO LLM/network (pure store ops), and derive the
  // mission via the loop-LESS ownership chain (token→terminal→the unique live mission whose planner is
  // this terminal). NOT in ASSISTANT_ACCEPT — Jarvis must not answer consults.
  '/api/agent/planner/pending',
  '/api/agent/planner/reply',
  // SPEC-RUNWAY — the statusLine usage forwarder (ct-usage). Same posture as the review/gate routes:
  // self-authenticates via the per-terminal token, spends ZERO LLM/network (a pure UsageStore write),
  // and derives its account exclusively token→terminal→configDir→accountUuid. NOT in ASSISTANT_ACCEPT —
  // Jarvis never posts usage.
  '/api/agent/usage',
  // SPEC-MEMORY — entry-level agent memory routes. Each self-authenticates via the per-terminal token
  // (resolveAgentMem), derives project + principal token→terminal server-side, and spends ZERO
  // LLM/network (pure MemoryStore ops). Each STATIC path needs its own entry (this set is path-keyed,
  // matched on req.url minus query). NOT in ASSISTANT_ACCEPT — Jarvis proposes memory changes, it does
  // not write them directly. '/api/agent/memory' is already above — GET reads the views (the legacy
  // whole-file PUT is retired and removed; the path stays exempt because this set is path-keyed and
  // shared with GET).
  '/api/agent/memory/entries',
  '/api/agent/memory/update',
  '/api/agent/memory/consolidate',
  '/api/agent/memory/unconsolidate',
  // SPEC-MEMORY — the agent's progress-note sink (`towerctl note`). Same posture: per-terminal token,
  // ZERO LLM/network (one loop-record annotation), loop derived token→terminal server-side. NOT in
  // ASSISTANT_ACCEPT — Jarvis has its own surfaces; a builder's note is the builder's.
  '/api/agent/note',
]);

/** SPEC-LOOP W4 — charset gate for a missionId BEFORE it joins into paths.reports on the report
 *  routes (path-traversal guard; the RUN_ID_RE precedent). Mission ids are shortId() = [a-z0-9]. */
const MISSION_ID_RE = /^[a-z0-9]{1,64}$/;

async function main() {
  ensureDirs();
  // Acquire the single-instance lock BEFORE constructing anything that touches CT_HOME
  // (Store, broker, retention, reconcile) — a second accidental process must refuse to
  // start and mutate nothing, rather than damage the live Tower's shared state.
  const releaseLock = acquireInstanceLock();
  ensureHookScript();
  ensureUsageScript(); // SPEC-RUNWAY — the ct-usage statusLine forwarder (inert until a statusLine points at it)
  ensureCredentialScript();
  // Provision the `towerctl` launcher and put ~/.ct/bin on this process's PATH so every agent
  // pane (which inherits the Tower's PATH via its tmux client/server) and the daemon's own loop
  // checks can resolve `towerctl`.
  ensureTowerctlLauncher();
  ensureBinOnPath();
  const store = new Store();
  const auth = new Auth(PORT);
  const accounts = new Accounts();
  // Onboard assistant: the tower-control MCP server (spawned by the assistant's Codex process)
  // authenticates back to the Tower with the SCOPED assistant token — read-only routes + POST
  // /api/assistant/proposals only, never a mutating route or the confirm gate (auth.ts accept-
  // list, SPEC-ASSISTANT-CONTROL §5). Read fresh from this 0600 file so it stays correct across
  // Tower restarts. This token grants only the scoped routes. The assistant's OS sandbox must
  // still block direct loopback access: native local callers can bootstrap a full session token.
  const mcpTokenFile = join(paths.secrets, 'mcptok-assistant');
  writeFileSync(mcpTokenFile, auth.assistantToken, { mode: 0o600 });
  const assistantStore = new AssistantStore();
  const hookTokens = new HookTokens();
  hookTokens.load(store.listTerminals());
  // Worktree session leases (SPEC-FACTORY §3): exclusion + liveness for every path the
  // Tower operates on. Constructed first — both managers below take it.
  const leases = new Leases();
  // Broker is constructed BEFORE the worktree manager: land()'s PR push brokers an ephemeral
  // identity-scoped credential through broker.acquireDaemonPush (fail-open when it returns undefined).
  // Broker's own deps are only store/accounts, so this reorder is safe.
  const broker = new Broker(store, accounts);
  // Re-register per-terminal broker tokens from disk so agents whose sessions survived
  // a Tower restart can still fetch credentials on push (the map is otherwise empty).
  broker.load(store.listTerminals());
  broker.start();
  const worktrees = new WorktreeManager(
    leases,
    (id) => broker.acquireDaemonPush(id),
    // land 'pr' PR creation. The PAT lives ONLY in this request-scoped closure — read fresh per land,
    // handed straight into the one-shot GitHub REST call, and NEVER stored, logged, put in an env var /
    // argv / child process, or passed to worktrees (which only receives this function, not the token).
    async (identityId, args) => {
      const pat = accounts.readCredential(identityId);
      if (!pat) return { ok: false, reason: 'no push credential stored for the project identity' };
      return createGitHubPr(pat, args);
    },
  );
  const mail = new Mail();
  const memoryStore = new MemoryStore();
  const memory = new Memory(memoryStore);
  const settings = new Settings();
  const testkit = new TestKit(() => settings.testMaxSlots());
  // SPEC-STORYLOOP §1 — the user-story corpus (per-project, atomic 0600). The `{t:'stories'}` SSE
  // hook is wired below, once MissionControl exists (mirrors providerStore's onChange).
  const storyStore = new StoryStore();
  // SPEC-SKILLS — the canonical skill library (META index + bodies/assets on disk). Same deferred-hook
  // pattern as storyStore; the `{t:'skills'}` frame is wired below once MissionControl exists.
  const skillStore = new SkillStore();
  // SPEC-SKILLS Phase 3 — per-project skill selection (bundles + overlays), a leaf config store like
  // RoutingStore. No SSE hook: the bundle/selection routes below emit `{t:'skills'}` explicitly (the
  // routing-route precedent), and skillStore.remove already fires that frame for the delete guard.
  const skillSelection = new SkillSelectionStore();
  // SPEC-SKILLS Phase 5b — the assistant's INERT skill-draft pad (one atomic 0600 JSON, bodies
  // inline). Deliberately a SEPARATE store/file/type from SkillStore: the materializer imports only
  // skills/store.js + skills/selection.js, so no draft can reach an agent config dir except through
  // the session-only promote route below. Same deferred-hook pattern as skillStore.
  const skillDrafts = new SkillDraftStore();
  // SPEC-BACKLOG §1 — the stored pre-execution task lanes. Same deferred-hook pattern; the
  // `{t:'backlog'}` frame is wired below. Link stamping is ROUTE-side (only server.ts holds this store); the loops/missions
  // modules see only the onExecutionDone slice of this store.
  const backlogStore = new BacklogStore();
  // SPEC-LOOP W6 — the routed reviewers' structured submissions (atomic 0600, per-mission bounded). No
  // SSE hook: the completion evaluator reads it in-memory on its synchronous green branch; the report
  // and the review routes pull from it. Self-contained (never queries the mission store).
  const reviews = new ReviewStore();
  // SPEC-SKILLS-GATE — loop-green gate attestations (atomic 0600, per-mission bounded). No SSE hook:
  // the completion evaluator reads it in-memory on its synchronous green branch; every read is a pull
  // (the ReviewStore posture). Self-contained (never queries the mission store).
  const gateEvidence = new GateEvidenceStore();
  // SPEC-RESEARCH W9 — the research findings store (atomic 0600, per-mission bounded). No SSE hook:
  // like ReviewStore, every read is a pull — the reconcile finding gate, the spawn-time digest, the
  // re-planner bundle and the delivery report.
  const researchStore = new ResearchStore();
  // SPEC-PLANNER §2 — the planner-consult store (atomic 0600, per-mission bounded on CLOSED consults).
  // No SSE hook of its own: the tick re-entry reads it in-memory, and the server closures that mutate it
  // fire emitConsults() explicitly. Self-contained (never queries missions/mail/terminals).
  const consultStore = new ConsultStore();
  // A built-in scratch project so a terminal can exist without a real repo (SPEC P16).
  if (!store.getProject('sandbox')) {
    const dir = join(paths.home, 'sandbox');
    mkdirSync(dir, { recursive: true });
    store.upsertProject({ id: 'sandbox', name: 'sandbox', repoPath: dir, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  }
  // Custom providers (SPEC-PROVIDERS §1.3): boot order MUST be store → registry → managers.
  // The registry ctor rebuilds off the loaded store; its hooks (rebuild + the `providers` SSE
  // frame) are wired below once MissionControl exists. RoutingStore owns ~/.ct/config/routing.json.
  const providerStore = new ProviderStore();
  const registry = initProviderRegistry(providerStore);
  const routingStore = new RoutingStore();
  // SPEC-TESTING §4 — per-project e2e testing config (~/.ct/config/testing.json).
  const testingStore = new TestingConfigStore();
  // SPEC-RUNWAY — usage-aware claude-code subscription rotation: the pool/threshold config plus the
  // per-accountUuid usage samples (both 0600; ~/.ct/config/runway.json + ~/.ct/usage/). Inert until
  // the operator enables it AND the statusLine write ships (gated on the W0.5 busy-matcher).
  const runwayStore = new RunwayStore();
  const usageStore = new UsageStore();
  // SPEC-MODELS §2 — the built-in provider model catalog (codex live-discovered from the ChatGPT
  // backend; claude/gemini curated). No secrets on disk; the ChatGPT token is read only at refresh.
  const modelCatalog = new ModelCatalogStore();
  // SPEC-TESTING §1.4 — the assistant Brain profile ids, read AT RUNTIME (the id is machine-local,
  // never hardcoded). Routing a builder onto one is refused at routing-write and at the start gate.
  const reservedProfileIds = (): ReadonlySet<string> =>
    new Set(assistantStore.listAccounts().map((a) => a.profileId).filter(Boolean));
  // SPEC-LOOP W7 — the ONE automatic-file path: guard (non-gate, has failures, project opted in, not
  // already filed), file REAL-only (triage-aware; UNCLASSIFIED→real), mark autoFiled (the idempotency the
  // mission-end flush reads), audit. Shared by onParsed (immediate, non-investigate), the triage route
  // (deferred completion), AND the mission-end flush — so the gate/kind/condition/audit can never diverge
  // across the three. The manual operator "file-failures" route stays SEPARATE (triage-blind, files all).
  const autoFileReal = (run: TestRun, event = 'test.autofile'): void => {
    const cfg = testingStore.get(run.projectId);
    if (run.kind === 'gate' || !run.failed || !cfg?.autoFileFailures || run.autoFiled === true) return;
    try {
      const out = fileFailuresAsTasks(run, backlogStore, { realOnly: true });
      testkit.setAutoFiled(run.id);
      audit(event, { runId: run.id, ...out });
    } catch (e) {
      console.error('[testing] auto-file failed:', (e as Error).message);
    }
  };
  // SPEC-TESTING §5 — at release, a NON-GATE run's failures auto-file to the backlog when the project
  // opted in. release() fires this AFTER writeMeta and only when results parsed; fileFailuresAsTasks is
  // synchronous, so a try/catch contains a bad backlog write — a hook crash must never lose the run.
  testkit.setHooks({
    onParsed: (run) => {
      const cfg = testingStore.get(run.projectId);
      // SPEC-LOOP W5 — capture the project's opted-in server/docker logs FIRST (release/onParsed is
      // the last synchronous instant the worktree + compose stack is guaranteed alive). captureRunLogs
      // is synchronous, never-throws, and bounded; its OWN try/catch keeps a capture failure from ever
      // losing the parsed-results write. Only the COUNT is audited — the captured contents routinely
      // carry secrets and are NEVER logged/audited (they're reachable only via the guarded logs route).
      try {
        const names = captureRunLogs(run, cfg);
        if (names.length) {
          testkit.setLogs(run.id, names);
          audit('testrun.logs', { runId: run.id, count: names.length });
        }
      } catch (e) {
        // setLogs threw (e.g. writeMeta ENOSPC) AFTER the files were written → they'd be orphaned on
        // disk (secret-bearing, unreferenced by meta). Best-effort remove the whole logs dir so no
        // unlisted secret file lingers reachable-by-guessed-name until retention prunes the run.
        try {
          rmSync(join(run.runDir, 'logs'), { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        console.error('[testing] log capture failed:', (e as Error).message);
      }
      // SPEC-LOOP W7 — defer auto-filing for a run a loop investigator will triage: the loop owns failure
      // routing, and filing everything now would surface by-design/false failures the investigator is about
      // to suppress. Resolve the run's OWNING loop (its runner terminal → newest LIVE loop → mission) with
      // the shared liveLoopForTerminal helper; a miss fails safe to the immediate filing below. The triage
      // route files real-only when the investigator submits; the mission-end flush files any deferred run
      // that is NEVER triaged (never-silent-pass for the backlog). `loops`/`store`/liveLoopForTerminal are
      // declared later, but this closure runs only at release, long after boot.
      // ACCEPTED LIMITATION: a mission killed/orphaned/abandoned mid-flight before it EVER reaches a
      // settling transition (done/failed/give-up park) never runs its flush, so a deferred run stays
      // unfiled and GC-pinned. This is bounded (per-mission, at most its rounds' runs — the settle-flush
      // covers every normal terminal path) and matches the non-investigate reality that a crash mid-run
      // never files that run either; a future boot-time reconcile of deferred runs for non-live missions
      // would close it. Not a silent green — only a backlog best-effort gap.
      if (run.kind !== 'gate' && run.failed && cfg?.autoFileFailures) {
        const ownerLoop = liveLoopForTerminal(run.terminalId);
        const ownerMission = ownerLoop?.missionId ? store.getMission(ownerLoop.missionId) : undefined;
        if (ownerMission?.loop?.investigate === true) {
          // Mark the run as deferred-to-THIS-mission (persisted) so the mission-end flush can find it even
          // if the mission aborts before evaluateCompletion ever stamps the round — the flush enumerates by
          // this marker, not the loop's round stamps.
          testkit.setDeferredForMission(run.id, ownerMission.id);
          audit('test.autofile.deferred', { runId: run.id, missionId: ownerMission.id });
          return;
        }
      }
      autoFileReal(run); // immediate (non-investigate); its own guard handles kind/failed/autoFile/already-filed
    },
  });
  const tm = new TerminalManager(store, {
    hookTokens,
    hookScript: HOOK_SCRIPT,
    towerPort: PORT,
    worktrees,
    accounts,
    broker,
    credentialScript: CREDENTIAL_SCRIPT,
    brokerSock: BROKER_SOCK,
    leases,
    providers: providerStore,
    // SPEC-SKILLS Phase 1 — read-only consumer: materializes the eligible skills into a spawn's config dir.
    skills: skillStore,
    // SPEC-TERMINAL-OPS §3.2 — read at call time so a Settings change takes effect immediately.
    maxTerminals: () => settings.maxTerminals(),
    // SPEC-RUNWAY — the ct-usage statusLine forwarder, installed on claude-code panes only while
    // Runway is enabled (read at call time; defaults off, so the fleet is untouched until turned on).
    usageScript: USAGE_SCRIPT,
    runway: () => {
      const cfg = runwayStore.get();
      return { enabled: cfg.enabled, liveSwap: cfg.liveSwap !== false, pool: cfg.pool.map((e) => e.profileId) };
    },
    // SPEC-RUNWAY live-swap -- injected here (not imported by terminal-manager) to keep the import graph acyclic.
    liveSwap: performLiveSwap,
    // SPEC-RESTART-RESUME — late-bound (loops/poller/mission are all declared further down this
    // function; safe because this closure only ever RUNS well after boot, from restartTerminal's
    // detached fall-forward — never during construction). Mirrors the restart route's own
    // post-respawn fan-out below: re-arm the bound loop with resumed:false (the replacement session
    // has no context — briefs full, not delta), drop the poller's stale baseline for the fresh pid,
    // and push the same broadcast + attention refresh a foreground restart does, so the UI reflects
    // the fresh session even though nothing there is awaiting this.
    onResumeFallForward: (terminalId: string) => {
      loops.onTerminalRestarted(terminalId, { resumed: false });
      poller.forget(terminalId);
      mission.broadcastChange();
      void mission.pushAttention();
    },
  });
  const mission = new MissionControl(store, mail);
  // Wire the store's mutation hooks now that MissionControl exists: recompose synthesized
  // adapters + broadcast a `{t:'providers'}` frame so open composers refresh their roster live.
  providerStore.setHooks({ onRebuild: () => registry.rebuild(), onChange: () => mission.emitProviders() });
  // SPEC-MODELS §2 — a codex catalog refresh persists per-account; broadcast the same `{t:'providers'}`
  // frame so every open picker (any tab) drops its cached roster and re-reads GET /api/models/:provider.
  modelCatalog.setHooks({ onChange: () => mission.emitProviders() });
  // Push a `{t:'stories'}` frame on every corpus mutation so open Stories views refresh live.
  storyStore.setHooks({ onChange: () => mission.emitStories() });
  // Push a `{t:'skills'}` frame on every skill-library mutation so the open Skills panel refetches.
  skillStore.setHooks({ onChange: () => mission.emitSkills() });
  // The draft pad rides the SAME frame: the SkillsPanel's "Assistant drafts" strip refreshes live
  // on a brain save / operator discard / promote (SPEC-SKILLS Phase 5b).
  skillDrafts.setHooks({ onChange: () => mission.emitSkills() });
  // Push a `{t:'backlog'}` frame on every task mutation so open Boards refetch (⟦DP-B7⟧).
  backlogStore.setHooks({ onChange: () => mission.emitBacklog() });
  // SPEC-RUNWAY — push a `{t:'runway'}` frame on every Runway config mutation so the open Runway tab
  // refetches GET /api/runway/config (the skills/backlog refetch precedent). Live usage is polled.
  runwayStore.setHooks({ onChange: () => mission.emitRunway() });
  // SPEC-MEMORY — on every entry mutation, regenerate the three markdown views on disk (so meta() and
  // `towerctl memory read` stay current) and push a `{t:'memory'}` frame so an open MemoryPanel refetches.
  memoryStore.setHooks({
    // First-load migration of a legacy project's markdown into entries — fires on the FIRST access via ANY
    // path (facade or a direct entry route), so a legacy KB is never clobbered by an empty store state.
    ensureLoaded: (pid) => memory.migrateProject(pid),
    onChange: (pid) => {
      try {
        memory.writeViews(pid);
      } catch (err) {
        console.error('[memory] view regenerate failed:', err);
      }
      mission.emitMemory(pid);
    },
  });
  // The acceptance judge + mission planner share the assistant brain's plumbing
  // (SPEC-FACTORY §0.2); repoRoot matches what registerAssistantRoutes receives below.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const validator = new Validator({ assistantStore, accounts, towerPort: PORT, mcpTokenFile, repoRoot });
  // SPEC-MODELS §4 — the known-good model ids for a route, feeding validateRoute's non-fatal warning.
  // Ground truth is (a) any LIVE-discovered roster (a codex refresh / a custom def's /v1/models), or
  // (b) codex's curated seed — which is verified against the narrow ChatGPT backend catalog, so even an
  // un-refreshed codex account can flag a legacy slug that would 400 at spawn. claude-code/gemini-cli
  // 'curated' entries are display aliases (the CLIs also accept full model slugs), so they are NOT
  // ground truth → undefined → no warning (there is no queryable catalog to validate them against).
  const knownModelIds = (provider: ProviderId, profileId?: string): string[] | undefined => {
    const view = buildModelsView(provider, modelCatalog, providerStore, profileId);
    if (view.source === 'discovered') return view.models.map((m) => m.id);
    if (provider === 'codex') return view.models.map((m) => m.id); // curated codex = verified known-set
    return undefined;
  };
  // SPEC-EFFORT §2 — the resolved codex MODEL's captured effort set (from the same cached roster
  // buildModelsView composes), feeding validateRoute's warning-tier "not in this model's set" check.
  // Undefined for claude-code (pinned enum is the hard gate) and codex-with-no-model (syntactic gate only).
  const knownEfforts = (provider: ProviderId, profileId?: string, model?: string): string[] | undefined => {
    if (provider !== 'codex' || !model) return undefined;
    const view = buildModelsView(provider, modelCatalog, providerStore, profileId);
    const e = view.models.find((m) => m.id === model);
    return e?.efforts?.length ? e.efforts : undefined;
  };
  const loops = new Loops({
    store,
    tm,
    worktrees,
    accounts,
    validator,
    providerStore,
    knownModelIds,
    knownEfforts,
    routing: routingStore,
    // SPEC-TESTING §1.4 — refuse a loop whose request/role resolves to the assistant Brain account.
    reservedProfileIds,
    // SPEC-LOOP §2 — a daemon-run checkCommand (`towerctl …`) inherits the daemon's env, which
    // lacks the per-terminal token → towerctl exits 2. Inject the loop terminal's token file + port so
    // `towerctl test run`/`review status` authenticate (repairs the shipped verify-runner check too).
    hookTokenFile: (terminalId) => hookTokens.tokenFile(terminalId),
    towerPort: PORT,
    // SPEC-LOOPWEDGE GUARD — the durable inferred-idle flag (written by mission.ingest for both F1's
    // lost-hook harvest and F2's poller affirmative-idle demote). finishIteration forces a gate
    // instead of an autopilot 'done' when the completing idle was inferred and there is no check to
    // confirm it — an inferred idle may never be the sole basis of an autopilot pass.
    wasIdleInferred: (terminalId) => store.getTerminal(terminalId)?.idleInferred === true,
    onUpdate: (loop) => mission.emitLoop(loop),
    // SPEC-STORYLOOP §2.3a — the shared kit feeds structured e2e failures into loop feedback + the
    // judge. `latestFor` already excludes kind:'gate' runs. TestKit satisfies LoopsDeps.testRuns.
    testRuns: testkit,
    // SPEC-BACKLOG ⟦DP-B5⟧ — success-only auto-archive of the provenance task (newly-set landedAt;
    // fired from the patch choke point; archiveByExecution is idempotent, no-match = logged no-op).
    backlog: { onExecutionDone: (ref) => backlogStore.archiveByExecution(ref) },
    // SPEC-SKILLS per-project delivery — the project's per-project (non-global) resolved skills as a
    // bounded pointer block, baked into the loop record at create. ONE resolution site
    // (resolveForProject) + one renderer (skills/brief.ts); loops.ts stays skills-free — this closure
    // is the seam. Covers every mission sortie too: startSortie funnels through loops.create.
    skillBrief: ({ projectId, provider, excludeUncleared }) =>
      renderSkillBrief(skillSelection.resolveForProject(skillStore.list(), projectId).entries, provider, excludeUncleared),
    // The live clearance re-check behind the drift leg of the inject-time belt: the brief's entries
    // are by-id LIVE pointers, so a mid-loop edit/promote/rollback that drops a cleared assistant
    // skill's clearance (the hash-keyed reset) must suppress the brief on a skip-permissions loop.
    // True iff EVERY id is still a current assistant-origin skill with autonomyCleared === true —
    // a deleted (or deleted-and-recreated-uncleared) id fails the check too.
    briefAssistantSkillsCleared: (ids) =>
      ids.every((id) => {
        const s = skillStore.get(id);
        return !!s && s.origin === 'assistant' && s.autonomyCleared === true;
      }),
    // SPEC-MEMORY — the project-memory briefing channel (the skillBrief seam's shape; loops.ts stays
    // memory-store-free). `briefing` composes the bounded block from the project's live entries and the
    // loop's persisted cursor; the composer's `toSeq`/`delivered` contracts are what the runner records.
    // `onIntegration` flips the loop's run-scoped entries at its land/abandon boundary — the project id
    // comes off the loop record, never the caller.
    memory: {
      briefing: (a) => composeMemoryBriefing(memoryStore.list(a.projectId), { mode: a.mode, sinceSeq: a.sinceSeq }),
      onIntegration: (ref, state) => {
        const l = store.getLoop(ref.loopId);
        if (l) memoryStore.setIntegration(l.projectId, ref.loopId, state);
      },
    },
  });
  // SPEC-STORYLOOP §4 — the regression gate runs the mission's e2e suite against a disposable
  // trial-merge tree before the first land. Terminal-less runs via testkit.acquireGate;
  // branches resolved via loops.get. Constructed after loops, before missions (its consumer).
  const gate = new RegressionGate({ testkit, loops });
  // SPEC-LOOP W4 — the deterministic, ZERO-LLM delivery report, written the first time a mission
  // transitions INTO 'done' OR 'failed' (fire-and-forget off the missions patch() choke point). Reads
  // each sortie's loop for provider/model/branch and each pinned run for proof. Constructed after
  // gate/loops, before missions (its consumer).
  const reports = new Reports({ loops, testkit, reviews, research: researchStore });
  // The planner's provider roster (§2.5): every launchable agent (built-ins + synthesized
  // custom, never 'shell') with its known model ids, so Jarvis proposes provider+model FROM
  // this list only. Built-ins carry no def, so no models.
  const buildRoster = (): PlanRosterEntry[] =>
    registry
      .list()
      .filter((a) => a.id !== 'shell')
      .map((a) => {
        const models = providerStore.get(a.id)?.model.models?.map((m) => m.id);
        return { id: a.id, displayName: a.displayName, ...(models && models.length ? { models } : {}) };
      });
  // SPEC-PLANNER §3/§8 (DEC-P7) — give a SPAWNED claude-code planner standing permission to run towerctl,
  // so it isn't stuck at a first-use permission dialog when it replies. Best-effort + logged-not-thrown:
  // the attention-card + answer-clock backstop holds if this fails, and the matcher string
  // `Bash(towerctl:*)` must be re-pinned against the installed CLI (Residual #4 — a wrong matcher is
  // harmless). Only for a planner with an isolated configDir (a profileId); a machine-login planner is
  // skipped. A shallow-but-set-merged permissions.allow (never clobbering an existing entry).
  // SPEC-PLANNER §5 (DEC-P2) — the two consult clocks, defined ONCE so the tick (missions deps) and the
  // pending/consults routes (deadline display) can never disagree. CT_CONSULT_* overridable (intEnv
  // precedent), which is what makes §12's clock acceptance checks runnable at 5s.
  const consultClocks = {
    deliverMs: intEnv('CT_CONSULT_DELIVER_MS', 10 * 60_000),
    answerMs: intEnv('CT_CONSULT_ANSWER_MS', 30 * 60_000),
  };
  const CONSULT_OPEN = new Set<PlannerConsult['status']>(['pending', 'delivered', 'answered']);
  const isConsultOpen = (c: PlannerConsult): boolean => CONSULT_OPEN.has(c.status);
  /** The active clock's absolute deadline (ISO) — delivered ⇒ answer clock from deliveredAt, else the
   *  delivery clock from askedAt. For display only; the tick enforces the same arithmetic. Returns
   *  undefined on a non-finite timestamp (a corrupt/hand-edited consults.json survives loading, since
   *  askedAt/deliveredAt are z.string()) — the caller OMITS the field rather than letting `new Date(NaN)
   *  .toISOString()` throw a RangeError that would 500 the whole pending route for a record's healthy
   *  siblings. The tick's own clocks belt the same NaN so the consult still gates. */
  const consultDeadline = (c: PlannerConsult): string | undefined => {
    const base = c.status === 'delivered' && c.deliveredAt
      ? Date.parse(c.deliveredAt) + consultClocks.answerMs
      : Date.parse(c.askedAt) + consultClocks.deliverMs;
    return Number.isFinite(base) ? new Date(base).toISOString() : undefined;
  };

  const grantPlannerTowerctl = (term: Terminal): void => {
    try {
      if (term.provider !== 'claude-code' || !term.profileId) return;
      const profile = accounts.getProfile(term.profileId);
      if (!profile) return;
      const file = join(profile.configDir, 'settings.json');
      let current: Record<string, unknown> = {};
      try { current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* fresh file */ }
      const perms = (current.permissions as { allow?: string[] } | undefined) ?? {};
      const allow = new Set(perms.allow ?? []);
      allow.add('Bash(towerctl:*)');
      // Atomic (temp+rename) like the rest of the codebase: a raw writeFileSync mid-crash truncates the
      // account config, and two planners on one profile lose-update; a partial write is worse than the
      // grant it attempts (it's best-effort). 0600 — the config carries account settings.
      writeJsonAtomic(file, { ...current, permissions: { ...perms, allow: [...allow] } }, 0o600);
    } catch (e) {
      console.error('[planner] best-effort towerctl permission grant failed:', (e as Error).message);
    }
  };
  const missions = new Missions({
    store,
    loops,
    providerStore,
    routing: routingStore,
    // SPEC-TESTING §1.2/§1.4 — the account match-gate lookup (Accounts satisfies ProfileLookup) + the
    // reserved Brain profile ids, both threaded into resolveRouting/validateRoute at the start gate.
    accounts,
    reservedProfileIds,
    // SPEC-TERMINAL-OPS §3.3 — the SAME counting rule the createTerminal funnel enforces, composed
    // from the one exported helper so the two can never drift: a drift would turn the funnel's throw
    // into a permanent sortie ATTENTION where the design promises a bounded wait.
    terminalCapacity: (projectId: string) =>
      terminalCapacity(store.listTerminals(), {
        globalCap: settings.maxTerminals(),
        projectId,
        projectCap: store.getProject(projectId)?.maxTerminals,
      }),
    // SPEC-LOOP W6 — the review store (ReviewStore satisfies the deps' structural slice directly: the
    // completion evaluator reads getFor on the synchronous green branch, the review-fix assignment
    // resolves its pin by getById, and the escalation bundle reads latestFor). Absent + requireReview →
    // attention (review is load-bearing).
    reviews,
    // SPEC-SKILLS-GATE — the gate-evidence store: the completion evaluator's synchronous loop-green
    // enforcement read (the create-frozen loop.requiredGates). Absent while gates are required →
    // attention (load-bearing, the reviews posture).
    gates: gateEvidence,
    // SPEC-RESEARCH W9 — the research store: the reconcile finding gate's read, plus the spawn-time
    // digest and the re-planner bundle. Absent on a research sortie ⇒ attention, never a skip.
    research: researchStore,
    onUpdate: (m) => mission.emitMission(m),
    planDraft: (projectRepoPath, goal) => validator.planPhases(projectRepoPath, goal, buildRoster()),
    // SPEC-LOOP W2 (G2) — the codex Brain re-planner for an escalated loop round (tick-driven, no route).
    planRevision: (projectRepoPath, bundle) => validator.planRevision(projectRepoPath, bundle, buildRoster()),
    // SPEC-STORYLOOP §4/§3.3 — the regression gate (runAdvance) + the kit for the verify-fixer
    // partition join (`latestFor`, gate runs already excluded).
    gate,
    testkit,
    // SPEC-BACKLOG ⟦DP-B5⟧ — success-only auto-archive (transition INTO 'done' at the patch choke
    // point); mirrors the loops wiring above.
    backlog: { onExecutionDone: (ref) => backlogStore.archiveByExecution(ref) },
    // SPEC-LOOP W4 — the delivery report, fired fire-and-forget on the first transition INTO
    // 'done'/'failed' (report-never-blocks-done — generate() never throws).
    report: { onMissionFinished: (m) => reports.generate(m) },
    // SPEC-LOOP W7 — flush deferred auto-filing when an investigate loop mission settles terminally
    // (failed, or cap-exhausted attention): file the real failures of every run DEFERRED to this mission
    // that no triage submission ever completed. Enumerated by the persisted deferredForMission marker (set
    // at release, before any round-stamp), NOT by loop.rounds — so a run deferred then aborted before
    // evaluateCompletion stamps it is still found. INVARIANT: once a mission settles, NONE of its deferred
    // runs may stay GC-pinned — so we FINALIZE every one (clear the marker in a finally) whether the flush
    // filed it, skipped it (autoFileFailures off — autoFileReal's own guard), or errored; otherwise a
    // no-op flush would pin the run forever and ~/.ct/testruns would grow unbounded. autoFileReal is
    // idempotent (the run's autoFiled marker), so a run already filed by onParsed/triage is skipped.
    onLoopSettle: (mission) => {
      for (const run of testkit.listRuns()) {
        if (run.deferredForMission !== mission.id) continue;
        // Isolate each run FULLY: neither a backlog-write throw (autoFileReal) nor a meta-write throw
        // (setDeferredForMission's writeMeta, e.g. ENOSPC/EMFILE) may abort the loop — one throwing run
        // must not leak the remaining siblings' retention pins. The inner finally still clears the pin
        // even when autoFileReal throws; the outer catch absorbs a clear-write throw too (that single
        // run stays pinned — bounded to one — while every sibling still processes and clears).
        try {
          try {
            autoFileReal(run, 'test.autofile.flush'); // guard inside: skips a gate/no-failure/off/already-filed run
          } finally {
            testkit.setDeferredForMission(run.id, undefined); // release the retention pin — flush processed it
          }
        } catch (e) {
          console.error(`[testing] settle flush failed for run ${run.id}:`, (e as Error).message);
        }
      }
    },
    // SPEC-PLANNER §4/§5/§8 — the planner-consult bridge. Every closure runs at TICK time, so it may
    // reference tm / mail / mission / consultStore / killAndForget (all in scope by then). missions.ts may
    // not import mail/MissionControl, so the delivery, respawn and mail-migration wiring lives here.
    consults: {
      getById: (id) => consultStore.getById(id),
      ask: (input) => {
        const c = consultStore.create(input);
        const name = store.getMission(input.missionId)?.name ?? input.missionId;
        // Pointer mail — ONE short paragraph; the full brief + reply protocol ride the pending route so
        // the human/nudge interleave stays ≤3 short lines per consult (DEC-P1b).
        try {
          mail.send(
            input.terminalId, 'tower', 'Control Tower',
            `Mission "${name}" needs a planner consult (${input.kind}). Run \`towerctl planner pending\` for the full brief and reply protocol, then reply within the deadline — or the loop parks for a human.`,
          );
        } catch (e) {
          // The consult is already persisted but its pointer never enqueued. Don't leave an ORPHAN (the
          // operator would see "waiting on planner" while the mission parks at attention, and a planner
          // could even answer a consult no tick will consume). Expire it, then rethrow into the tick's
          // catch (afterConsultThrow bumps attempts; the consultId was never stamped, so the next tick asks
          // fresh — no duplicate).
          try { consultStore.resolve(c.id, 'expired', 'superseded'); } catch { /* already closed */ }
          mission.emitConsults();
          throw e;
        }
        mission.emitMailSent('tower', input.terminalId);
        void mission.maybeNudge(input.terminalId); // send-time, self-gating, danger-vetoing
        consultStore.bumpNudges(c.id); // count the ask as attempt 1 (and stamp lastNudgeAt for P5)
        mission.emitConsults();
        return c;
      },
      resolve: (id, status, reason) => { consultStore.resolve(id, status, reason); mission.emitConsults(); },
      renudge: (consult) => {
        // A still-PENDING consult: reset the nudge high-water mark so the unchanged unread re-nudges. A
        // DELIVERED one (inbox read → unread 0, so maybeNudge would no-op): a fresh reminder mail raises
        // unread 0→1 so the machinery fires verbatim. Either way count the attempt (cap enforced upstream).
        if (consult.status === 'delivered') {
          mail.send(consult.terminalId, 'tower', 'Control Tower', `Consult ${consult.id} still awaits your reply — run \`towerctl planner pending\`.`);
          mission.emitMailSent('tower', consult.terminalId);
        } else {
          mission.clearNudge(consult.terminalId);
        }
        void mission.maybeNudge(consult.terminalId);
        consultStore.bumpNudges(consult.id);
        mission.emitConsults();
      },
      migrate: (missionId, fromTid, toTid) => {
        const n = consultStore.migrate(missionId, fromTid, toTid);
        mail.migrate(fromTid, toTid); // move the unread pointer mail to the new pane
        mission.emitConsults();
        return n;
      },
      settle: (missionId, reason) => {
        let any = false;
        for (const c of consultStore.openFor(missionId)) {
          try { consultStore.resolve(c.id, 'expired', reason); any = true; } catch { /* raced to closed */ }
        }
        if (any) mission.emitConsults();
      },
      reanchor: (missionId) => {
        if (consultStore.reanchorOpen(missionId) > 0) mission.emitConsults();
      },
    },
    // SPEC-PLANNER §5 (DEC-P2) — the two consult clocks (defined once above; shared with the routes).
    consultTimeouts: consultClocks,
    // SPEC-PLANNER §8 (DEC-P6) — bounded respawn of a lost planner pane, reusing the stored routing. NO
    // worktree: the planner edits nothing and must see the real tree.
    plannerSpawn: async (m) => {
      const project = store.getProject(m.projectId);
      if (!project) throw new Error('planner respawn: the mission project is gone');
      const p = m.planner!;
      const term = await tm.createTerminal(project, {
        provider: p.provider, model: p.model, effort: p.effort, profileId: p.profileId,
        title: `planner · ${m.name}`, purpose: 'planner', worktree: false,
      });
      grantPlannerTowerctl(term);
      return term;
    },
    // SPEC-PLANNER §8 (P2) — best-effort teardown of a respawned pane orphaned by an abort during spawn.
    plannerKill: (tid) => { void killAndForget(tid); },
  });
  const poller = new Poller(
    store,
    mission,
    registry,
    intEnv('CT_POLL_INTERVAL_MS', 10_000),
    intEnv('CT_POLL_STALE_MS', 20_000),
    intEnv('CT_POLL_BACKSTOP_MS', 300_000),
  );
  // SPEC-RUNWAY W5 — reactive backstop: when a polled claude-code pane shows a usage-limit banner, mark
  // its subscription walled so the rotation controller reacts even if the proactive statusLine missed
  // the approach. `until` caps the wall at the longest session window (auto-lift; a fresh statusLine
  // sample clears it sooner). Audited once per new wall (deduped) to avoid a line per sweep.
  poller.setUsageWallHook((terminalId, kind) => {
    const term = store.getTerminal(terminalId);
    if (!term) return;
    if (term.rotatingFrom) return; // mid-rotation: don't attribute the old process's banner to the new account
    const dir = liveConfigDirFor(term, accounts.getProfile.bind(accounts), 'claude-code');
    const uuid = dir ? accountIdentityFor(dir)?.accountUuid : undefined;
    if (!uuid) return;
    const already = usageStore.get(uuid)?.wall;
    usageStore.markWall(uuid, { source: 'scrape', until: Date.now() + 5 * 60 * 60_000 });
    if (!already) audit('runway.wall.scrape', { terminalId, kind, accountUuid: uuid.slice(0, 8) });
  });
  // On a confirmed session vanish, release every per-terminal resource killTerminal
  // releases on a user kill — token files (hook + broker) AND in-memory maps — and
  // notify dashboards so they don't keep showing the dead terminal as alive with a
  // stale attention card (the kill route does the same via broadcastChange).
  // Live-swap: drop slot dirs with no terminal record (crash/missed-teardown leftovers) before anything can spawn.
  {
    const swept = sweepOrphanSlots(new Set(store.listTerminals().map((t) => t.id)));
    if (swept > 0) audit('runway.live-slot.orphans-swept', { count: swept });
  }
  const reconciler = new Reconciler(store, {
    // SPEC-RESTART-RESUME FIX A — defer the whole sweep for a terminal with an in-flight restart
    // (including a claude resume's detached health-check/fall-forward window): the reconciler's own
    // 15s timer is not phase-locked to a restart, so without this a sweep could vanish a pane the
    // background watcher is a poll-interval away from reviving, force-failing its bound loop.
    restartInFlight: (id) => tm.isRestartInFlight(id),
    onVanish: (term) => {
      hookTokens.forget(term.id, term.hookToken);
      broker.forget(term.id);
      mission.forget(term.id);
      poller.forget(term.id);
      loops.onTerminalGone(term.id); // fail any loop still bound to the vanished builder
      leases.releaseAllFor(term.id); // this path never goes through killTerminal (SPEC-FACTORY §3)
      if (term.liveSlotDir) {
        removeLiveSlot(term.liveSlotDir); // live-swap slot: guarded to the slots root
        store.patchTerminal(term.id, { liveSlotDir: undefined }); // symmetric with killTerminal/cleanupFailedCreate
      }
      // SPEC-PLANNER §8 — flip any mission whose LIVE planner is this pane to 'lost'; the tick's ask path
      // lazily respawns it (DEC-P6). The hook token is already forgotten above, so the dead pane's replies
      // fail closed at 401 immediately. Open consults are left in place for the tick to migrate.
      missions.markPlannerLost(term.id);
      mission.broadcastChange();
      void mission.pushAttention();
    },
  });

  const retention = new Retention();
  retention.start();

  // The kill fan-out shared by the kill ROUTE and the §4.4 reaper — one helper so a resource the
  // route releases can never be forgotten by the reaper (or the reverse).
  const killAndForget = async (terminalId: string): Promise<void> => {
    await tm.killTerminal(terminalId); // tmux server + hook/broker tokens + worktree leases
    mission.forget(terminalId);
    poller.forget(terminalId);
    loops.onTerminalGone(terminalId); // a no-op for the already-terminal owning loop
  };

  /**
   * SPEC-TERMINAL-OPS §4.3 — close the panes of mission builders whose mission is long finished. The
   * policy itself is the pure `shouldReapTerminal` (every clause errs toward keeping the terminal —
   * see its doc); this loop only resolves each terminal's owning loop + mission and does the killing.
   * Killing a pane destroys nothing: the pipe-pane log, the worktree and the branch all survive.
   */
  const reapMissionTerminals = async (): Promise<void> => {
    const windowMs = settings.terminalReapHours() * 3600_000;
    const now = Date.now();
    // ⟦DEC-6⟧ provenance, DERIVED not stored: the owning MISSION loop per terminal, resolved once
    // (loops.list() is a full scan). No entry here ⇒ not mission-spawned ⇒ never reaped.
    const owner = new Map<string, Loop>();
    for (const l of loops.list()) {
      if (l.terminalId && l.missionId) owner.set(l.terminalId, l);
    }
    let reaped = 0;
    for (const t of store.listTerminals()) {
      // Per-terminal isolation: one failing kill must never abort the sweep.
      try {
        // Re-read the terminal right before judging it: listTerminals() is a point-in-time snapshot and
        // `await killAndForget` yields between iterations, so a terminal late in a slow sweep could be
        // judged on stale state/lastEventAt — an operator re-attaching to a 24h-finished pane in that
        // window could see it reaped, defeating the "never close one under the operator" intent. Judge on
        // the fresh record; if it vanished mid-sweep, skip.
        const fresh = store.getTerminal(t.id);
        if (!fresh) continue;
        const loop = owner.get(fresh.id);
        const m = loop?.missionId ? store.getMission(loop.missionId) : undefined;
        if (!shouldReapTerminal(fresh, loop, m, { now, windowMs })) continue;
        await killAndForget(fresh.id);
        audit('terminal.reap', {
          terminalId: fresh.id,
          missionId: loop?.missionId,
          ageHours: Math.round((now - Date.parse(m ? m.updatedAt : loop!.updatedAt)) / 3600_000),
        });
        reaped++;
      } catch (e) {
        console.error(`[retention] terminal reap failed for ${t.id}:`, (e as Error).message);
      }
    }
    if (reaped) {
      console.log('[retention]', { terminalsReaped: reaped });
      mission.broadcastChange();
      void mission.pushAttention();
    }
  };
  // Retention itself stays fs-only; the reap rides its existing 10-minute cadence through this hook
  // (the testkit.setHooks pattern). The boot sweep already ran above, so the first reap lands at +10m.
  retention.setHooks({ reapTerminals: reapMissionTerminals });

  // Spool apply contract: this MUST await ingestSignal and let a throw propagate, so drainSpool
  // deletes a file only after its ingest actually applied (or was a judged no-op — resolving
  // false, which includes SPEC-CLEARANCE §A's screen-vetoed needs-input). A real I/O failure
  // throws → drainSpool keeps the file. ingestSignal (not ingest) so a spooled needs-input gets
  // the same phantom-hold veto as a live one — the spool replays exactly the wire signals.
  const applySpooled = async (ev: SpooledEvent): Promise<void> => {
    await mission.ingestSignal(ev.terminalId, ev.signal as WireHookSignal, ev.emitTs);
  };

  // Startup reconcile + spool drain run HERE, before app.listen — the single-instance
  // lock (not the port bind) is what protects the shared CT_HOME, so there is no reason
  // to defer these past listen. Running them before serving also avoids (a) a request
  // racing reconcile's tmux awaits, and (b) a WS-upgrade gap while reconcile/drain run.
  const first = await reconciler.reconcile();
  if (first.vanished.length || first.adopted.length || first.orphanSockets.length) {
    console.log('[reconcile:startup]', first);
  }
  // Re-acquire worktree leases for ADOPTED builders (SPEC-FACTORY §3): leases
  // are in-memory, and adoption doesn't go through createTerminal — without this, a live
  // re-armed builder's worktree could be reaped by worktrees.remove after a restart.
  for (const t of store.listTerminals()) {
    // Presume ALIVE on a hasSession throw (a stalled socket): wrongly acquiring a lease for a dead
    // terminal only delays worktree reaping (benign), but wrongly SKIPPING would let a live builder's
    // worktree be reaped. The asymmetry favors acquiring; the reconciler corrects the rest.
    if (t.worktreePath && t.state !== 'killed' && (await tmux.hasSession(t.tmuxSocket).catch(() => true))) {
      leases.acquire(t.worktreePath, { kind: 'terminal', id: t.id });
    }
  }
  // SPEC-LOOP W7 follow-up — boot reconcile of DEFERRED test runs. onParsed defers auto-filing for an
  // investigate mission's failing run (marking it deferredForMission); the mission-end flush (onLoopSettle)
  // normally files its real failures and clears the pin. But a Tower killed MID-SETTLE on a done/failed
  // transition (status persisted, flush not yet run) or a mission since archived/deleted leaves a run
  // deferred+unflushed — its real failures never reach the backlog and it stays GC-pinned. On boot, flush a
  // deferred run ONLY when its owning mission is TRULY TERMINAL (done/failed), archived, or gone — matching
  // start()'s own resume gate. Every NON-terminal state (draft/running/phase-gate/paused/attention) is LEFT:
  // each is resumable and may still drive a later investigator to triage this run, so flushing it here would
  // pre-file UNCLASSIFIED-as-real failures the investigator would have suppressed — the exact pre-fire
  // patch() forbids. Residual (accepted, bounded): a cap-exhausted give-up parked at 'attention' and then
  // ABANDONED keeps its run pinned until the operator resumes (re-flushes), aborts→failed, or archives it —
  // any of which makes it flush-eligible on the next boot. Per-run isolated exactly like onLoopSettle:
  // neither autoFileReal nor the pin-clear may abort the loop.
  let reconciledDeferred = 0;
  for (const run of testkit.listRuns()) {
    if (!run.deferredForMission) continue;
    const m = store.getMission(run.deferredForMission);
    if (m && !m.archivedAt && m.status !== 'done' && m.status !== 'failed') continue;
    reconciledDeferred++;
    try {
      try {
        autoFileReal(run, 'test.autofile.boot-reconcile'); // files real failures if the project opts in; guarded + idempotent
      } finally {
        testkit.setDeferredForMission(run.id, undefined); // release the retention pin — reconciled
      }
    } catch (e) {
      console.error(`[reconcile:deferred] flush failed for run ${run.id}:`, (e as Error).message);
    }
  }
  if (reconciledDeferred) console.log('[reconcile:deferred]', { flushed: reconciledDeferred });
  // SPEC-PLANNER §8 — boot reconcile of OPEN consults (the 4041bf8 deferred-run pattern). A Tower killed
  // mid-consult leaves persisted state (the consult + its consultId on the round). For each open consult:
  //   - owning mission gone / archived / done / failed → expire 'mission-ended' (the settle never ran);
  //   - mission live but NO escalating round record carries this consult's id (crash between consult-create
  //     and the round patch, or the round already became 'replanned') → expire 'superseded';
  //   - otherwise LEAVE IT — the tick re-entry resumes the SAME consult (the consultId is the no-duplicate-
  //     ask idempotency key). Per-record isolated try/catch exactly like the deferred-run loop.
  let reconciledConsults = 0;
  for (const c of consultStore.listOpen()) {
    try {
      const m = store.getMission(c.missionId);
      if (!m || m.archivedAt || m.status === 'done' || m.status === 'failed') {
        consultStore.resolve(c.id, 'expired', 'mission-ended');
        reconciledConsults++;
        continue;
      }
      // Only an ESCALATING record carrying this id means the tick will resume the SAME consult. A
      // REPLANNED record also carries consultId (provenance, stamped by appendRound) — so keying on
      // consultId alone would treat the P3(a) crash window (round appended, resolve('applied') not run)
      // as "still live" and LEAVE the answered consult open forever, the operator surface lying
      // indefinitely. The kind check is what makes the 'superseded' net fire in exactly that window.
      const carried = (m.loop?.rounds ?? []).some((r) => r.kind === 'escalating' && r.consultId === c.id);
      if (!carried) {
        consultStore.resolve(c.id, 'expired', 'superseded');
        reconciledConsults++;
      } else {
        // SPEC-PLANNER §5/§8 — the tick resumes THIS carried consult; re-anchor its clock to now so a
        // long Tower downtime doesn't expire it on the first post-restart tick (the absolute wall-clock
        // hazard, same as the resume path). Resets, never disables — it still gates if never answered.
        consultStore.reanchor(c.id);
      }
    } catch (e) {
      console.error(`[reconcile:consults] reconcile failed for consult ${c.id}:`, (e as Error).message);
    }
  }
  if (reconciledConsults) { console.log('[reconcile:consults]', { expired: reconciledConsults }); mission.emitConsults(); }
  // SPEC-TERMINAL-OPS §1.3 — boot sweep of orphaned account dirs. deleteProfile shreds on the happy
  // path; a crash between record-delete and rm, a delete that predates this wave, or an rm failure
  // leaves a credential-bearing dir with no owning profile. Enumerate ~/.ct/accounts/<provider>/<dir>
  // two levels deep ONLY; anything not referenced by a live profile record is shredded through the
  // same guarded helper. ~/.ct/agents (the shared per-provider dirs) is a DIFFERENT root and is never
  // enumerated. Per-item isolated; a throw logs and continues; the sweep never throws the boot.
  // Fail-safe: it shreds nothing at all unless the profile list loaded COMPLETELY (one dropped record
  // means some dir is still referenced by a record we cannot see), and it silently skips anything that
  // is not a plain directory at either level. Both sides of the referenced test are canonicalized, so
  // a record whose configDir spells the same directory differently is never mistaken for an orphan.
  const acctRoot = accountsRoot();
  if (existsSync(acctRoot)) {
    if (!accounts.profilesLoadedOk()) {
      console.error('[reconcile:accounts] profiles did not load completely — sweeping nothing (no dir removed)');
    } else {
      const referenced = new Set(accounts.listProfiles().map((p) => canonicalAccountPath(p.configDir)));
      let shredded = 0;
      for (const providerDir of readdirSync(acctRoot)) {
        const providerPath = join(acctRoot, providerDir);
        try {
          if (!lstatSync(providerPath).isDirectory()) continue;
          for (const entry of readdirSync(providerPath)) {
            const target = join(providerPath, entry);
            if (referenced.has(canonicalAccountPath(target))) continue;
            if (!lstatSync(target).isDirectory()) continue;
            if (shredAccountDir(target)) shredded++;
          }
        } catch (e) {
          console.error(`[reconcile:accounts] sweep failed under ${providerPath}:`, (e as Error).message);
        }
      }
      if (shredded) console.log('[reconcile:accounts]', { shredded });
    }
  }
  reconciler.start();
  poller.start();
  loops.start();
  // SPEC-STORYLOOP §4 — reap any orphaned `agent/gate-*` trial worktree left by a
  // Tower killed mid-gate, BEFORE any mission can mint a fresh one. Best-effort, per-project guarded.
  await gate.sweep(store.listProjects());
  missions.start_();
  const drained = await drainSpool(applySpooled).catch((err) => {
    console.error('[spool] startup drain failed:', err);
    return 0;
  });
  if (drained) console.log(`[spool] drained ${drained} queued hook event(s)`);
  const spoolTimer = setInterval(() => {
    drainSpool(applySpooled).catch((err) => console.error('[spool] timer drain failed:', err));
  }, intEnv('CT_SPOOL_DRAIN_MS', 15_000));
  spoolTimer.unref?.();
  // SPEC-CRED-REFRESH — keep idle claude-code account credentials fresh. Machine-mirror is the
  // always-on arm (a 0600 file copy for accounts matching the machine login); the headless vendor
  // ping is opt-in via CT_CRED_REFRESH_PING. Idle-gated against every live terminal on a dir, so
  // it never races a CLI's own credential write. Runs after the boot reconcile above: the terminal
  // records the gate reads have already been reconciled against live panes.
  const credRefresher = new ClaudeCredRefresher({
    listProfiles: () => accounts.listProfiles(),
    getProfile: (id) => accounts.getProfile(id),
    listTerminals: () => store.listTerminals(),
  });
  credRefresher.start();

  const app = Fastify({ logger: false });

  // Set true when a shutdown signal arrives; read by the onRequest hook (to refuse new mutating work
  // during the drain) and by the shutdown handler's re-entry guard.
  let shuttingDown = false;

  app.addHook('onRequest', async (req, reply) => {
    // Once shutdown has begun, refuse NEW mutating requests so nothing kicks off fresh loop/mission
    // work (a git commit, a new terminal, a check command) that the drain would then have to kill
    // mid-flight — the same "orphaned child / half-committed worktree" failure the drain prevents, via
    // the HTTP path. Reads (GET/HEAD) still pass so the UI and health probes stay usable while winding down.
    if (shuttingDown && req.method !== 'GET' && req.method !== 'HEAD') {
      reply.code(503).send({ error: 'server is shutting down' });
      return;
    }
    const path = authRoutePath(req.url, req.routeOptions?.url);
    const isApi = path.startsWith('/api/');
    // /preview (SPEC-FILES §4): Host (anti-DNS-rebind) + Origin checks but NO token — the
    // capability URL is the credential. Plain subresource GETs carry no Origin → pass; a
    // sandboxed artifact's fetch() carries the literal Origin 'null' → not allowlisted → 403.
    const isPreview = path === '/preview' || path.startsWith('/preview/');
    // /healthz is token-free (a supervisor probe carries no session token) but still rides the Host
    // + Origin checks like every other exemption (/preview, the TOKEN_EXEMPT /api routes) — skipping
    // the guard ENTIRELY would be the one route with no anti-DNS-rebind/anti-CSRF coverage. requireToken
    // stays false for it (isApi is false), so it passes httpGuard on Host/Origin alone.
    const isHealth = path === '/healthz';
    if (!isApi && !isPreview && !isHealth) return;
    const requireToken = isApi && !TOKEN_EXEMPT.has(path);
    // Per-route context so the SCOPED assistant token can be allow-listed by (method, route
    // PATTERN) — never by concrete url (GET and a mutating verb share a path). routeOptions.url
    // is the registered pattern (e.g. /api/memory/:id); undefined on a 404 → fails closed for the
    // assistant token (SPEC-ASSISTANT-CONTROL §5). The full session token ignores this context.
    const verdict = auth.httpGuard(req.raw, requireToken, { method: req.method, routePattern: req.routeOptions?.url });
    if (!verdict.ok) reply.code(verdict.code).send({ error: verdict.reason });
  });

  // ---- onboard assistant (Codex-brained; read + human-gated control via MCP) ----
  // SPEC-ASSISTANT-CONTROL: the proposal ledger. The executor replays a confirmed action through
  // the Tower's OWN public route via app.inject with the SESSION token (the scoped assistant token
  // can't reach a mutating route), so every guard/audit/SSE frame fires as a UI click would.
  const proposals = new ProposalStore({
    executor: makeProposalExecutor(app, auth.sessionToken, PORT),
    store: assistantStore,
    lookups: {
      getProject: (id) => store.getProject(id),
      getProfile: (id) => accounts.getProfile(id),
      // create_project / set_project_github enrich resolves defaultIdentityId → label + token presence.
      getIdentity: (id) => {
        const i = accounts.getIdentity(id);
        return i ? { label: i.label, hasCredential: i.hasCredential } : undefined;
      },
      // SPEC-TESTING-V2 §4 — enrich refuses a set_routing proposal targeting the assistant Brain account
      // at PROPOSE time (defense-in-depth: autonomous mode auto-confirms; the route guard is terminal).
      // Reads reservedProfileIds at call time (the id is machine-local, never hardcoded).
      isReservedProfile: (id) => reservedProfileIds().has(id),
      // SPEC-RESTART Wave 1 (§3.2) — close_terminal / restart_terminal enrich's live terminal view.
      // The owning loop is DERIVED per call, never stored (the reaper's ⟦DEC-6⟧ idiom): the loop
      // still BOUND to this terminal in a non-terminal status — exactly the set a close would FAIL
      // via onTerminalGone. isPlanner covers both the purpose stamp and a mission's live planner
      // binding (an ADOPTED planner pane carries purpose 'work', so the mission scan is load-bearing,
      // not a belt). profileReserved keys off the terminal's account binding at call time. All
      // in-memory reads, so enrich — and confirm's drift re-run — stay synchronous.
      getTerminal: (id) => {
        const t = store.getTerminal(id);
        if (!t) return undefined;
        const loop = loops
          .list()
          .find((l) => l.terminalId === id && l.status !== 'done' && l.status !== 'stopped' && l.status !== 'failed');
        return {
          title: t.title,
          provider: t.provider,
          state: t.state,
          purpose: t.purpose,
          projectName: store.getProject(t.projectId)?.name ?? t.projectId,
          ...(loop ? { owningLoop: { id: loop.id, name: loop.name, status: loop.status, iteration: loop.iteration } } : {}),
          isPlanner: t.purpose === 'planner' || missions.list().some((m) => m.planner?.terminalId === id),
          profileReserved: t.profileId !== undefined && reservedProfileIds().has(t.profileId),
        };
      },
      getTask: (id) => backlogStore.get(id),
      getRouting: (projectId?: string) => routingStore.layersFor(projectId),
      getWorkflow: (id) => routingStore.getWorkflow(id),
      hasProvider: (id) => listAdapters().some((a) => a.id === id),
      finishedCounts: () => countFinished(loops.list(), missions.list()),
      // create_project's path gate. Both sides go through the SAME normalizer the action's zod uses —
      // stored paths may predate it (a legacy '/x/repo/' or '/x/repo/.'), so normalize them too. The
      // boundary test uses a trailing '/' on both sides so '/x/repo2' is never read as inside '/x/repo'.
      // Re-run at confirm → a project registered between propose and confirm aborts the card as drift.
      projectPathConflict: (repoPath) => {
        const target = normalizeRepoPath(repoPath);
        const norm = store.listProjects().map((p) => ({ name: p.name, path: normalizeRepoPath(p.repoPath) }));
        // 'same' wins over containment: a single pass returning the first match of ANY relation would let
        // a nested legacy record shadow a true duplicate, handing the brain an error it cannot act on.
        const same = norm.find((p) => p.path === target);
        if (same) return { name: same.name, relation: 'same' };
        for (const p of norm) {
          if (target.startsWith(`${p.path}/`)) return { name: p.name, relation: 'contains' };
          if (p.path.startsWith(`${target}/`)) return { name: p.name, relation: 'inside' };
        }
        return undefined;
      },
      // SPEC-SKILLS Phase 5 — set_skill_enabled / set_project_skills enrich. getSkill projects the DERIVED
      // protection (isProtectedSkill — the ONE derivation site: protected flag OR a blocking gate) plus the
      // contentHash the drift baseline pins; getBundle/getProjectSkills resolve the project overlay's names +
      // current state. All synchronous (in-memory maps), so confirm's drift re-run stays before its await.
      getSkill: (id) => {
        const sk = skillStore.get(id);
        return sk
          ? { name: sk.name, enabled: sk.enabled, protected: isProtectedSkill(sk), contentHash: sk.contentHash, origin: sk.origin }
          : undefined;
      },
      // SPEC-SKILLS Phase 5b — promote_skill enrich's draft view. Synchronous (in-memory pad +
      // one sha256 over ≤64 KB), so confirm's drift re-run stays before its first await. contentHash
      // is RE-DERIVED from the live fields — never read from the stored record — so enrich voids a
      // card whose draft the assistant edited after proposing AND one whose pad file was hand-edited
      // to change the body while keeping the recorded hash.
      getSkillDraft: (id) => {
        const d = skillDrafts.get(id);
        return d
          ? { name: d.name, status: d.status, contentHash: draftContentHash(d), ...(d.targetSkillId !== undefined ? { targetSkillId: d.targetSkillId } : {}) }
          : undefined;
      },
      getBundle: (id) => {
        const b = skillSelection.getBundle(id);
        return b ? { name: b.name } : undefined;
      },
      getProjectSkills: (id) => skillSelection.getProjectSkills(id),
      // SPEC-SKILLS Phase 5 — the effective-set delta a set_project_skills REPLACE would cause. Drives
      // the omission/reset protected refusal (a full overlay replace can drop a protected skill without
      // naming it) AND the card's destructive-replace note. The impl lives on the selection store
      // (projectReplaceDelta — SHARED with the operator retype gate on PUT /api/projects/:id/skills, so
      // the assistant refusal and the operator gate can never diverge): both sides resolve through
      // resolveSkillSelection over the SANITIZED overlay, protection keys on isProtectedSkill (the
      // single derivation site). All in-memory (list + selection reads), so enrich stays synchronous.
      projectSkillReplaceDelta: (id, proposed) => skillSelection.projectReplaceDelta(skillStore.list(), id, proposed),
      // The synchronous account resolution create_loop's enrich gates on — the same resolveRouting
      // chain + credential probe the /api/loops start gate runs (loops.ts), wired from the real
      // stores so propose-time and spawn-time can never disagree.
      resolveLoopAccount: makeLoopAccountResolver({
        layersFor: (projectId) => routingStore.layersFor(projectId),
        getProject: (id) => store.getProject(id),
        accounts,
        providerStore,
        reservedProfileIds,
      }),
    },
  });
  registerAssistantRoutes(app, {
    store: assistantStore,
    accounts,
    towerPort: PORT,
    repoRoot,
    mcpTokenFile,
    proposals,
    // ⟦DP-J8⟧ the confirm route mounts for real only when the scoped token is active — i.e. the
    // MCP token file no longer holds the full session token (always true after this milestone).
    scopedTokenActive: auth.scopedTokenActive,
    // SPEC-SKILLS Phase 5b — the inert draft pad + its ADVISORY save-time warnings. Warnings are
    // non-blocking (enforcement lives in promote_skill's enrich + the promote route's belts) and are
    // derived from the SAME sources as the enforcing sites — isProtectedSkill (the one derivation
    // site) and slugifySkillName/isReservedSkillId — so a warning can never disagree with the later
    // refusal.
    skillDrafts,
    draftWarnings: ({ name, targetSkillId }) => {
      const warnings: string[] = [];
      if (targetSkillId !== undefined) {
        const t = skillStore.get(targetSkillId);
        if (!t) warnings.push(`targetSkillId '${targetSkillId}' does not exist — promote will be refused; clear it to create a new skill`);
        else if (isProtectedSkill(t)) warnings.push(`targetSkillId '${targetSkillId}' is protected — promote will be refused`);
        else if (t.origin !== 'assistant') warnings.push(`targetSkillId '${targetSkillId}' is ${t.origin}-authored — promote will be refused (the assistant only updates skills it authored)`);
      } else {
        const slug = slugifySkillName(name);
        if (!isSafeName(slug) || isReservedSkillId(slug)) warnings.push('the draft name cannot derive a valid skill id — promote will be refused; rename the draft');
        else if (skillStore.get(slug)) warnings.push(`a skill with id '${slug}' already exists — promote will be refused unless the draft targets it (assistant-origin only) or is renamed`);
      }
      return warnings;
    },
  });

  // ---- project files: browse / view / raw / sandboxed preview (SPEC-FILES §1) ----
  // Routes A–D ride the /api session-token guard above; route E (/preview/:pid/*) is a
  // capability URL guarded by Host/Origin only (hook extension above). READ-ONLY (§8).
  registerFileRoutes(app, {
    store,
    auth,
    caps: {
      maxEntries: intEnv('CT_FILES_MAX_ENTRIES', 1000),
      fileMaxBytes: intEnv('CT_FILE_MAX_BYTES', 1024 * 1024),
      rawMaxBytes: intEnv('CT_RAW_MAX_BYTES', 100 * 1024 * 1024),
      previewTtlMs: intEnv('CT_PREVIEW_TTL_MS', 15 * 60_000),
    },
  });

  // ---- session / health ----
  // SPEC-FILES §4: this response MUST stay application/json (Fastify's default
  // serialization) and never become JSONP/JS-shaped. The route is token-exempt, so a sandboxed
  // preview document CAN reach it with a no-CORS <script src="/api/session"> GET (such a GET
  // carries no Origin header); what keeps the token unreadable there is exactly that the body
  // is JSON (a SyntaxError as a script, no callback) and cross-origin ORB blocks the read.
  // Changing the shape of this response would arm the preview-escape this comment guards.
  app.get('/api/session', async () => ({ token: auth.sessionToken, version: VERSION }));

  // Liveness probe for a process supervisor / container orchestrator / uptime monitor. Token-free
  // (the onRequest hook's isHealth branch admits it with requireToken=false, still Host/Origin-checked)
  // and deliberately cheap: it touches no store, LLM, or network, only proving the process is up and
  // its event loop is responsive. A reply at all IS the readiness signal for a single-instance daemon;
  // body carries version + uptime for ops, both strictly less sensitive than the token /api/session
  // already returns unauthenticated on the same loopback port.
  app.get('/healthz', async () => ({ status: 'ok', version: VERSION, uptimeSeconds: Math.round(process.uptime()) }));
  app.get('/api/health', async (): Promise<HealthReport> => ({
    ok: true,
    version: VERSION,
    terminals: store.listTerminals().filter((t) => t.state !== 'killed').length,
    projects: store.listProjects().length,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  }));
  app.get('/api/adapters', async () => listAdapters().map((a) => ({ id: a.id, displayName: a.displayName, supportsAutoAccept: a.supportsAutoAccept === true })));
  app.get('/api/security', async () => securityStatus(true));

  // ---- global admin settings + system/isolation status (Settings view) ----
  const settingsView = (): GlobalSettingsView => ({
    ...settings.get(),
    effectiveTestMaxSlots: settings.testMaxSlots(),
    // SPEC-TERMINAL-OPS §3.1/§4.3 — the resolved terminal-plane caps.
    effectiveMaxTerminals: settings.maxTerminals(),
    effectiveTerminalReapHours: settings.terminalReapHours(),
  });
  app.get('/api/settings', async () => settingsView());
  app.patch<{ Body: { testMaxSlots?: number | null; maxTerminals?: number | null; terminalReapHours?: number | null } }>(
    '/api/settings',
    async (req, reply) => {
      // Forward only keys the client actually sent — always materializing a field would
      // turn an empty PATCH body into a silent reset of a configured cap. Non-object bodies
      // (a bare JSON primitive) are treated as empty: `in` on a primitive would throw.
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
      // SPEC-TERMINAL-OPS §3.1 — refuse a value that is neither a number nor null. The clamp treats a
      // non-finite value as "use the default", so without this a typo ("abc") would be STORED as an
      // explicit setting equal to the default and read back as if the operator had chosen it.
      for (const key of ['maxTerminals', 'terminalReapHours'] as const) {
        if (!(key in body)) continue;
        const v = body[key];
        if (v === null) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return reply.code(400).send({ error: `${key} must be a number, or null to reset it` });
        }
      }
      const next = settings.patch({
        ...('testMaxSlots' in body ? { testMaxSlots: body.testMaxSlots as number | null } : {}),
        ...('maxTerminals' in body ? { maxTerminals: body.maxTerminals as number | null } : {}),
        ...('terminalReapHours' in body ? { terminalReapHours: body.terminalReapHours as number | null } : {}),
      });
      audit('settings.update', {
        testMaxSlots: next.testMaxSlots ?? null,
        maxTerminals: next.maxTerminals ?? null,
        terminalReapHours: next.terminalReapHours ?? null,
      });
      return settingsView();
    },
  );
  app.get('/api/system/isolation', async () => ({
    perAgentUidProvisioned: hostIsolationAvailable(),
    sandboxAvailable: sandboxToolAvailable(),
    // Surfaced so the UI can say honestly that the assistant's sandbox gate is bypassed
    // process-wide — otherwise the per-account "allow without sandbox" toggle looks
    // authoritative while this env var silently overrides it.
    envNoSandboxOverride: process.env.CT_ASSISTANT_ALLOW_NO_SANDBOX === '1',
    setupCommand: SETUP_COMMAND,
  }));
  // SPEC-CLI-UPDATE — the installed built-in CLI versions + a self-update trigger. Session-token only
  // (NOT TOKEN_EXEMPT; the assistant reaches update via a confirmed propose_action, never these routes).
  app.get('/api/system/cli-versions', async () => detectAllVersions());
  app.post<{ Body: { provider?: string } }>('/api/system/cli-update', async (req, reply) => {
    const provider = typeof req.body?.provider === 'string' ? req.body.provider : '';
    if (!updatableProviders().includes(provider)) {
      return reply.code(400).send({ error: `provider must be one of: ${updatableProviders().join(', ')}` });
    }
    const result = await updateProvider(provider);
    audit('system.cli.update', { provider, ok: result.ok, before: result.before, after: result.after, changed: result.changed });
    if (!result.ok && result.outputTail === '' && (result.error ?? '').includes('already running')) {
      return reply.code(409).send({ error: result.error });
    }
    if (!result.ok) {
      // A genuine update failure returns non-2xx so a Jarvis-confirmed proposal reads as FAILED (the
      // proposal executor keys off the HTTP status), never a false "executed ✓". The body still carries
      // the error + output tail for the operator UI's error surface.
      return reply.code(500).send({ error: `update failed: ${result.error ?? 'see output'}`, ...result });
    }
    return result;
  });
  app.get('/api/audit', async () => auditTail(120));
  app.get('/api/observability', async () => {
    let spoolDepth = 0;
    try {
      for (const d of readdirSync(paths.spool)) {
        try {
          spoolDepth += readdirSync(join(paths.spool, d)).filter((f) => f.endsWith('.json')).length;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    const disk = diskInfo();
    return {
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      sseClients: mission.subscriberCount(),
      spoolDepth,
      diskFreeMb: disk.freeMb,
      diskLow: disk.low,
      testActive: testkit.activeCount(),
      testCapacity: testkit.capacity(),
    };
  });
  app.post('/api/retention/sweep', async () => {
    retention.sweep();
    return { ok: true };
  });

  // ONE probe closure for the profiles list and the shared-login readout (the assistant's
  // loop-account resolver builds the same probe inside makeLoopAccountResolver), so no signed-in
  // reader can disagree with the spawn probe — all of them end in credentialVerdict.
  const signedInProbe = (provider: ProviderId, configDir?: string) =>
    accountCredentialProbe(provider, configDir, providerStore.get(provider), (defId, k) => providerStore.hasSecret(defId, k));

  // ---- provider accounts (profiles) ----
  // `signedIn` is WIRE-ONLY, derived per request via the spawn probe's verdict. The spread is
  // load-bearing: listProfiles() returns the LIVE store records, so mapping must never mutate them
  // or the next writeArr would persist signedIn into profiles.json.
  app.get('/api/profiles', async () =>
    accounts.listProfiles().map((p) => ({ ...p, signedIn: signedInProbe(p.provider, p.configDir).verdict === 'present' })),
  );
  app.post('/api/profiles', async (req, reply) => {
    const b = (req.body ?? {}) as { provider?: string; label?: string };
    if (!b.provider || !b.label) return reply.code(400).send({ error: 'provider and label required' });
    const prof = accounts.createProfile(b.provider as never, b.label.trim());
    audit('profile.create', { profileId: prof.id, provider: prof.provider });
    return prof;
  });
  // Rename a provider account's display label (fix a mis-typed name). Label-only — the credential dir
  // and every live pane's binding are untouched. Session-token only (not TOKEN_EXEMPT/ASSISTANT_ACCEPT).
  app.patch<{ Params: { id: string }; Body: { label?: unknown } }>('/api/profiles/:id', async (req, reply) => {
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    if (!label) return reply.code(400).send({ error: 'label required' });
    if (label.length > 100) return reply.code(400).send({ error: 'label too long (max 100 chars)' });
    const next = accounts.renameProfile(req.params.id, label);
    if (!next) return reply.code(404).send({ error: 'unknown profile' });
    audit('profile.rename', { profileId: next.id, label: next.label });
    mission.emitProviders(); // open rosters (composer, routing selects, Runway tab) refresh the label
    return next;
  });
  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>('/api/profiles/:id', async (req, reply) => {
    const id = req.params.id;
    // SPEC-TERMINAL-OPS §1.2 — two refusals BEFORE anything is removed, each with a ?force=true escape.
    // The delete now SHREDS the account's credential dir, so a bound terminal loses its credentials
    // mid-flight and the assistant Brain is bricked outright — both must be a deliberate choice.
    const force = req.query.force === 'true';
    if (!force) {
      // The terminal record's profileId is the binding (stamped on the draft record at create, so a
      // mid-spawn terminal is already visible here); 'killed' is the only dead state, and the
      // reconciler flips vanished sessions to it, so this set self-heals. SPEC-RUNWAY: also count a
      // terminal mid-rotation OFF this account (rotatingFrom === its dir) — its old process is still
      // live, so shredding the dir now would pull credentials from under it.
      const dir = accounts.getProfile(id)?.configDir;
      const live = store
        .listTerminals()
        .filter((t) => t.state !== 'killed' && (t.profileId === id || (dir !== undefined && t.rotatingFrom === dir)));
      if (live.length > 0) {
        return reply
          .code(409)
          .send({ error: `${live.length} live terminal(s) run as this account — kill them first, or pass ?force=true` });
      }
      if (reservedProfileIds().has(id)) {
        return reply.code(409).send({
          error: 'this profile is the assistant Brain account — remove the assistant account first, or pass ?force=true',
        });
      }
    }
    // SPEC-TESTING §1.6 — strip this account from every role route BEFORE deleting it, so a stranded
    // profileId can't warn on every future mission (pruneProfile strips the field, the assignment stays).
    const routingChanged = routingStore.pruneProfile(id);
    const runwayChanged = runwayStore.pruneProfile(id); // SPEC-RUNWAY — a deleted account can't remain a rotation slot
    const { shredded } = accounts.deleteProfile(id);
    if (routingChanged) mission.emitProviders();
    if (runwayChanged) mission.emitRunway();
    audit('profile.delete', { profileId: id, forced: force, shredded });
    // `shredded` rides the RESPONSE, not just the audit: when the containment guard refused or the rm
    // failed, the record is gone but a readable 0600 credential is still on disk, and a bare {ok:true}
    // would tell the operator (and Jarvis) the account was fully removed. The next boot's sweep
    // retries; until then the degradation is visible where the action was taken.
    return { ok: true, shredded };
  });

  // SPEC-RUNWAY — the rotation config + status routes (session-token; NOT TOKEN_EXEMPT, NOT
  // ASSISTANT_ACCEPT — Jarvis does not edit the pool). claudeProfiles joins the live signedIn probe
  // (wire-only, never persisted); status groups by accountUuid so two profiles on one subscription
  // collapse to one slot.
  registerRunwayRoutes(app, {
    store: runwayStore,
    usage: usageStore,
    claudeProfiles: () =>
      accounts
        .listProfiles()
        .filter((p) => p.provider === 'claude-code')
        .map((p) => ({ id: p.id, label: p.label, configDir: p.configDir, signedIn: signedInProbe(p.provider, p.configDir).verdict === 'present' })),
    isReserved: (pid) => reservedProfileIds().has(pid),
    audit,
  });

  /** Open a terminal in the account's config dir to run the CLI's interactive login. */
  app.post<{ Params: { id: string } }>('/api/profiles/:id/login', async (req, reply) => {
    const prof = accounts.getProfile(req.params.id);
    if (!prof) return reply.code(404).send({ error: 'unknown profile' });
    const project = store.listProjects()[0];
    if (!project) return reply.code(400).send({ error: 'add a project first' });
    const term = await tm.createTerminal(project, {
      title: `login: ${prof.label}`,
      provider: prof.provider,
      profileId: prof.id,
      // SPEC-TERMINAL-OPS §2.3/§4.1 — this terminal EXISTS to create the credential, so it skips the
      // auth probe (which it could never pass), the terminal cap, and the reaper. The built-in login
      // runs the plain CLI whose own TUI does the login, so there is no loginCommand to key off.
      purpose: 'login',
    });
    mission.broadcastChange();
    return publicTerminal(term);
  });

  // ---- shared machine login (SPEC-ONBOARDING §2 ⟦DP-O3⟧) ----
  // Whether each subscription CLI has a login file on THIS machine. Drives Quick Connect
  // gating: absent → the "use this computer's login" action is not rendered at all.
  app.get('/api/profiles/machine-login', async () => ({
    'claude-code': accounts.machineLoginPresent('claude-code'),
    codex: accounts.machineLoginPresent('codex'),
  }));
  // Whether each agent provider's SHARED (account-less) login dir holds a credential — what a loop
  // or terminal with no profileId spawns under. Distinct from machine-login above (the operator's
  // own ~/.claude|~/.codex): this probes the Tower's ~/.ct/agents/<provider>. A login-mode custom
  // provider that can't be file-probed reads false here (display-only; the enrich gate is unaffected).
  app.get('/api/profiles/shared-login', async () => {
    const out: Record<string, boolean> = {};
    for (const a of listAdapters()) {
      if (a.id === 'shell') continue;
      out[a.id] = signedInProbe(a.id).verdict === 'present';
    }
    return out;
  });
  /** Adopt the machine's own CLI login into the profile's isolated configDir — the
   *  authenticated no-terminal path (vs /login above, which opens the vendor OAuth). */
  app.post<{ Params: { id: string } }>('/api/profiles/:id/adopt-login', async (req, reply) => {
    try {
      accounts.adoptMachineLogin(req.params.id);
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg === 'unknown profile' ? 404 : 409).send({ error: msg });
    }
    audit('profile.adopt-login', { profileId: req.params.id });
    mission.broadcastChange();
    return { ok: true };
  });

  // ---- GitHub identities ----
  app.get('/api/identities', async () => accounts.listIdentities());
  app.post('/api/identities', async (req, reply) => {
    const b = (req.body ?? {}) as { label?: string; gitName?: string; gitEmail?: string };
    if (!b.label || !b.gitName || !b.gitEmail) return reply.code(400).send({ error: 'label, gitName, gitEmail required' });
    const idn = accounts.createIdentity(b.label.trim(), b.gitName.trim(), b.gitEmail.trim());
    audit('identity.create', { identityId: idn.id });
    return idn;
  });
  app.post<{ Params: { id: string }; Body: { token?: string } }>('/api/identities/:id/credential', async (req, reply) => {
    if (!req.body?.token) return reply.code(400).send({ error: 'token required' });
    try {
      accounts.setCredential(req.params.id, req.body.token.trim());
      audit('identity.credential.set', { identityId: req.params.id });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/identities/:id/credential', async (req) => {
    accounts.revokeCredential(req.params.id);
    audit('identity.credential.revoke', { identityId: req.params.id });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/identities/:id', async (req) => {
    const id = req.params.id;
    // Referential integrity: a project's defaultIdentityId pointing at this identity would become a
    // dangling ref that 400s every createTerminal in that project ("unknown identity"). Clear it FIRST,
    // in the SAME synchronous tick (this handler holds both stores), before deleting the identity.
    // undefined drops the key from the persisted record (JSON.stringify). Idempotent: an unknown id
    // clears nothing and still returns ok.
    let clearedProjects = 0;
    for (const p of store.listProjects()) {
      if (p.defaultIdentityId === id) {
        store.upsertProject({ ...p, defaultIdentityId: undefined });
        clearedProjects++;
      }
    }
    accounts.deleteIdentity(id);
    audit('identity.delete', { identityId: id, clearedProjects });
    return { ok: true };
  });

  // ---- custom providers (SPEC-PROVIDERS §1/§3/§4) ----
  // Every :id contains a ':' (custom:<slug>); the client encodeURIComponent's it and Fastify
  // decodes the single path segment. The wire view augments each def with write-only secret
  // PRESENCE (hasSecret per secretEnvKeys entry), NEVER a value (§4.4).
  const providerView = (def: ProviderDef) => ({
    ...def,
    hasSecret: Object.fromEntries((def.secretEnvKeys ?? []).map((k) => [k, providerStore.hasSecret(def.id, k)])),
  });

  app.get('/api/providers', async () => providerStore.list().map(providerView));

  app.put<{ Params: { id: string } }>('/api/providers/:id', async (req, reply) => {
    const now = new Date().toISOString();
    // The path id is authoritative; the store stamps timestamps (preserves createdAt, bumps
    // updatedAt) and re-validates against the shared ProviderDefSchema — it throws (→400) on a
    // malformed slug, a secret-looking def.env value, or a broken §1.6 auth shape.
    const body = (req.body ?? {}) as Partial<ProviderDef>;
    const input = { ...body, id: req.params.id as CustomProviderId, createdAt: body.createdAt ?? now, updatedAt: now } as ProviderDef;
    try {
      const def = providerStore.upsert(input);
      audit('provider.upsert', { providerId: def.id });
      return providerView(def);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (req) => {
    const id = req.params.id as CustomProviderId;
    // Prune role assignments pointing at this provider (global + every project overlay + every
    // workflow, SPEC-ROUTING §7) BEFORE removing it, so the `providers` frame remove() emits
    // already carries the pruned routing — a stranded assignment would fail every future
    // mission's pre-start route check, invisibly. If the def was already gone, remove() emits
    // nothing, so push a frame ourselves when the prune still changed routing.
    const existed = providerStore.get(id) !== undefined;
    const routingChanged = routingStore.pruneProvider(id);
    providerStore.remove(id);
    if (routingChanged && !existed) mission.emitProviders();
    audit('provider.remove', { providerId: id });
    return { ok: true };
  });

  app.put<{ Params: { id: string; key: string }; Body: { value?: string } }>(
    '/api/providers/:id/secrets/:key',
    async (req, reply) => {
      try {
        providerStore.setSecret(req.params.id as CustomProviderId, req.params.key, String(req.body?.value ?? ''));
        audit('provider.secret.set', { providerId: req.params.id, key: req.params.key });
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );
  app.delete<{ Params: { id: string; key: string } }>('/api/providers/:id/secrets/:key', async (req, reply) => {
    try {
      providerStore.clearSecret(req.params.id as CustomProviderId, req.params.key);
      audit('provider.secret.clear', { providerId: req.params.id, key: req.params.key });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Hardened discovery probe (§3): 200 even on ok:false — discovery never blocks.
  app.get<{ Params: { id: string } }>('/api/providers/:id/models', async (req) =>
    discoverModels(req.params.id as CustomProviderId, providerStore),
  );

  // SPEC-MODELS §1 — the ONE roster read every model picker hits. Zero-egress: composed from the
  // stored/curated built-in catalog or a custom def's discovered roster (session-token guarded, NOT
  // in TOKEN_EXEMPT — the roster is operator surface, and refresh below spends the account's token).
  // ?profileId scopes the codex read to the asking account (tiers expose different catalogs).
  app.get<{ Params: { id: string }; Querystring: { profileId?: string } }>('/api/models/:id', async (req) =>
    buildModelsView(req.params.id as ProviderId, modelCatalog, providerStore, req.query.profileId || undefined),
  );

  // SPEC-MODELS §2 — the single "re-probe this provider's catalog" egress. Dispatches: codex → the
  // ChatGPT backend GET with the account's own token (server-side, header-only); a custom def with a
  // baseUrl → its /v1/models probe (writes the roster back onto the def, emitting the providers SSE).
  // Session-token ONLY (never TOKEN_EXEMPT / ASSISTANT_ACCEPT — an agent must not trigger network
  // spend). 200 even on ok:false; the note is status-only, never a token. Built-in claude/gemini have
  // no queryable catalog (discoverable:false in the view, so the UI never offers a refresh for them).
  app.post<{ Params: { id: string }; Body?: { profileId?: string } }>('/api/models/:id/refresh', async (req) => {
    const id = req.params.id as ProviderId;
    if (id === 'codex') return discoverCodexModels({ accounts, catalog: modelCatalog }, req.body?.profileId);
    if (id.startsWith('custom:')) return discoverModels(id as CustomProviderId, providerStore);
    return { ok: false, models: buildModelsView(id, modelCatalog, providerStore).models, note: 'this provider has no live catalog to refresh' };
  });

  // Test = discovery probe + route validation + a dry buildCommand render — NO terminal spawned.
  app.post<{ Params: { id: string } }>('/api/providers/:id/test', async (req, reply) => {
    const def = providerStore.get(req.params.id as CustomProviderId);
    if (!def) return reply.code(404).send({ error: 'unknown provider' });
    let discovery: { ok: boolean; count?: number; note?: string } | undefined;
    if (def.baseUrl) {
      const d = await discoverModels(def.id, providerStore);
      discovery = { ok: d.ok, count: d.models.length, note: d.note };
    }
    const route = validateRoute(def.id, def.model.defaultModel, providerStore);
    let drySpawn: { ok: boolean; note?: string };
    let binaryPresent: { ok: boolean; note?: string } | undefined;
    try {
      const repoPath = store.listProjects()[0]?.repoPath ?? paths.home;
      const dryCtx: LaunchContext = {
        terminalId: 'dry-run',
        projectId: 'dry-run',
        cwd: repoPath,
        repoPath,
        hookTokenFile: '',
        hookScript: HOOK_SCRIPT,
        towerPort: PORT,
        spoolDir: paths.spool,
        configDir: join(paths.home, 'agents', 'dry-run'),
        model: def.model.defaultModel,
      };
      const argv = registry.get(def.id).buildCommand(dryCtx);
      drySpawn = route.errors.length ? { ok: false, note: route.errors.join('; ') } : { ok: true, note: argv.join(' ') };
      // The dry render never executes, so a missing runner would otherwise pass ok:true —
      // this real PATH check on argv[0] is what surfaces it (SPEC-ONBOARDING §4 ⟦DP-O5⟧).
      const bin = argv[0];
      if (bin) binaryPresent = accounts.runnerOnPath(bin) ? { ok: true } : { ok: false, note: `${bin} is not on PATH` };
    } catch (e) {
      drySpawn = { ok: false, note: (e as Error).message };
    }
    audit('provider.test', { providerId: def.id });
    return {
      ok: drySpawn.ok,
      discovery,
      drySpawn,
      ...(binaryPresent ? { binaryPresent } : {}),
      // Missing-secret warnings surface as a soft note; they never fail the route (§2.3a).
      ...(route.warnings.length ? { error: route.warnings.join('; ') } : {}),
    };
  });

  // Binary preflight for the guided agent tile (SPEC-ONBOARDING §1 Tile 2): a pure PATH
  // check — runnerOnPath charset-validates the name and executes nothing.
  app.get<{ Querystring: { cmd?: string } }>('/api/runner-check', async (req) => ({
    present: accounts.runnerOnPath(String(req.query.cmd ?? '')),
  }));

  // Login: ensure/reuse a profile for this provider id, then open its login terminal in the
  // isolated configDir (mirrors /api/profiles/:id/login). auth.mode==='login' runs the def's
  // own login argv; the Tower never captures the credential (§4.5).
  app.post<{ Params: { id: string } }>('/api/providers/:id/login', async (req, reply) => {
    const def = providerStore.get(req.params.id as CustomProviderId);
    if (!def) return reply.code(404).send({ error: 'unknown provider' });
    const project = store.listProjects()[0];
    if (!project) return reply.code(400).send({ error: 'add a project first' });
    const profile =
      accounts.listProfiles().find((p) => p.provider === def.id) ?? accounts.createProfile(def.id, def.displayName);
    const term = await tm.createTerminal(project, {
      title: `login: ${def.displayName}`,
      provider: def.id,
      profileId: profile.id,
      loginCommand: def.auth.mode === 'login' ? def.auth.loginCommand : undefined,
      purpose: 'login', // SPEC-TERMINAL-OPS §2.3/§4.1 — as for the built-in login route above
    });
    audit('provider.login', { providerId: def.id, profileId: profile.id });
    mission.broadcastChange();
    return publicTerminal(term);
  });

  // ---- Settings → Routing role defaults (SPEC-PROVIDERS §2.1) ----
  // SPEC-TESTING §1.4 — refuse a routing WRITE pointing any role at a reserved (assistant Brain)
  // account. validateRoute also catches it at the start gate; this blocks it at the source.
  const refuseReservedRoutes = (routes?: RoleRouting): string | undefined => {
    if (!routes) return undefined;
    const reserved = reservedProfileIds();
    for (const [role, a] of Object.entries(routes)) {
      if (a?.profileId && reserved.has(a.profileId)) {
        return `role '${role}' may not route to the assistant Brain account`;
      }
    }
    return undefined;
  };
  app.get('/api/routing', async () => routingStore.get());
  app.put<{ Body: RoleRouting }>('/api/routing', async (req, reply) => {
    try {
      const bad = refuseReservedRoutes(req.body as RoleRouting);
      if (bad) return reply.code(400).send({ error: bad });
      const next = routingStore.setAll((req.body ?? {}) as RoleRouting);
      audit('routing.set', {});
      mission.emitProviders(); // B3: push a `providers` frame so open dashboards refetch routing now
      return next;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.put<{ Params: { role: string }; Body: RoleAssignment }>('/api/routing/:role', async (req, reply) => {
    try {
      const pid = (req.body as RoleAssignment | undefined)?.profileId;
      if (pid && reservedProfileIds().has(pid)) {
        return reply.code(400).send({ error: 'this role may not route to the assistant Brain account' });
      }
      const next = routingStore.setRole(req.params.role as PipelineRole, (req.body ?? {}) as RoleAssignment);
      audit('routing.set', { role: req.params.role });
      mission.emitProviders(); // B3: push a `providers` frame so open dashboards refetch routing now
      return next;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.delete<{ Params: { role: string } }>('/api/routing/:role', async (req, reply) => {
    try {
      const next = routingStore.clearRole(req.params.role as PipelineRole);
      audit('routing.set', { role: req.params.role, cleared: true });
      mission.emitProviders(); // B3: push a `providers` frame so open dashboards refetch routing now
      return next;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ---- Workflow profiles — named role→(provider,model) bundles (SPEC-ROUTING §4) ----
  app.get('/api/workflows', async () => routingStore.listWorkflows());
  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    const wf = routingStore.getWorkflow(req.params.id);
    if (!wf) return reply.code(404).send({ error: 'unknown workflow' });
    return wf;
  });
  app.post<{ Body: { name?: string; description?: string; routes?: RoleRouting } }>(
    '/api/workflows',
    async (req, reply) => {
      try {
        const body = req.body ?? {};
        const bad = refuseReservedRoutes(body.routes);
        if (bad) return reply.code(400).send({ error: bad });
        const wf = routingStore.upsertWorkflow({ name: String(body.name ?? ''), description: body.description, routes: body.routes });
        audit('workflow.set', { workflowId: wf.id });
        mission.emitProviders(); // routing changed → open dashboards refetch (same frame as /api/routing)
        return wf;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );
  app.put<{ Params: { id: string }; Body: { name?: string; description?: string; routes?: RoleRouting } }>(
    '/api/workflows/:id',
    async (req, reply) => {
      try {
        const body = req.body ?? {};
        const bad = refuseReservedRoutes(body.routes);
        if (bad) return reply.code(400).send({ error: bad });
        const wf = routingStore.upsertWorkflow({
          id: req.params.id,
          name: String(body.name ?? ''),
          description: body.description,
          routes: body.routes,
        });
        audit('workflow.set', { workflowId: wf.id });
        mission.emitProviders();
        return wf;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    try {
      // Reference-check + delete happen inside ONE synchronous store method — a
      // route-level check-then-call would leave a gap for a concurrent assignment.
      const removed = routingStore.deleteWorkflow(req.params.id, (pid) => store.getProject(pid)?.name);
      audit('workflow.delete', { workflowId: req.params.id, removed });
      if (removed) mission.emitProviders();
      return { ok: true };
    } catch (e) {
      if (e instanceof WorkflowReferencedError) {
        return reply.code(409).send({ error: e.message, referencedBy: e.referencedBy });
      }
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ---- Per-project routing overlay: workflow selection + ad-hoc role overrides (SPEC-ROUTING §4) ----
  // Both verbs answer { workflowId?, routes?, effective, warnings }: `effective` is the PARTIAL
  // provenance map (only roles configured at some layer; model post-gate resolved), `warnings`
  // the per-role validateRoute findings + the dangling-workflowId warning (§7).
  const projectRoutingView = (projectId: string) => {
    const pr = routingStore.getProjectRouting(projectId);
    const { effective, warnings } = routingStore.effectiveRouting(projectId, providerStore, accounts, reservedProfileIds());
    return {
      ...(pr?.workflowId !== undefined ? { workflowId: pr.workflowId } : {}),
      ...(pr?.routes !== undefined ? { routes: pr.routes } : {}),
      effective,
      warnings,
    };
  };
  app.get<{ Params: { id: string } }>('/api/projects/:id/routing', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    return projectRoutingView(project.id);
  });
  app.put<{ Params: { id: string }; Body: { workflowId?: string; routes?: RoleRouting } }>(
    '/api/projects/:id/routing',
    async (req, reply) => {
      const project = store.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'unknown project' });
      try {
        const bad = refuseReservedRoutes(req.body?.routes);
        if (bad) return reply.code(400).send({ error: bad });
        routingStore.setProjectRouting(project.id, {
          workflowId: req.body?.workflowId,
          routes: req.body?.routes,
        });
        audit('routing.project.set', { projectId: project.id, workflowId: req.body?.workflowId ?? null });
        mission.emitProviders();
        return projectRoutingView(project.id);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );

  // ---- Per-project skill selection: a selected bundle + per-skill overrides (SPEC-SKILLS Phase 3) ----
  // Both verbs answer { bundleId?, enable?, effective, warnings }: `effective` is the resolved skill set
  // for this project (provenance per entry, provider reach, and a `delivered` flag — see below), and
  // `warnings` carries the dangling-bundle / dangling-member surfacing. Composed from the library +
  // selection + the shared providerEligible predicate (the projectRoutingView clone).
  const projectSkillsView = (projectId: string) => {
    const ps = skillSelection.getProjectSkills(projectId);
    const { entries, warnings } = skillSelection.resolveForProject(skillStore.list(), projectId);
    const effective: EffectiveSkillEntry[] = entries.map(({ skill, source }) => ({
      id: skill.id,
      name: skill.name,
      source,
      providers: CHANNEL_PROVIDER_IDS.filter((p) => providerEligible(skill, p)),
      scope: skill.scope,
      // A global skill is delivered via the configDir baseline; a per-project, provider-reachable,
      // non-user-only skill is delivered too — via the sortie brief baked into a loop's task at create
      // (skills/brief.ts; the SAME briefDeliverable predicate as the brief filter, one source). NOT
      // keyed on `source`: a global skill that is also a bundle member has source:'bundle'
      // (most-specific tier) yet is still delivered via the baseline. Deliberately independent of
      // clearance — that is per-terminal, and the panel's uncleared chip covers it separately.
      delivered: skill.enabled && (skill.scope === 'global' || CHANNEL_PROVIDER_IDS.some((p) => briefDeliverable(skill, p))),
    }));
    return {
      ...(ps?.bundleId !== undefined ? { bundleId: ps.bundleId } : {}),
      ...(ps?.enable !== undefined ? { enable: ps.enable } : {}),
      effective,
      warnings,
    };
  };
  app.get<{ Params: { id: string } }>('/api/projects/:id/skills', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    return projectSkillsView(project.id);
  });
  // Session-token ONLY, like the /api/skills routes: deliberately absent from ASSISTANT_ACCEPT (only the
  // GET above is scoped-readable). The assistant CAN propose set_project_skills, but that kind is carved out
  // of autoConfirm; a confirmed proposal reaches this REPLACE route through the executor's session-token
  // inject, never the scoped token. The PUT is a full overlay replacement (setProjectSkills semantics).
  //
  // SPEC-SKILLS Phase 5b wave 2 — the selection-side retype gate, the /api/skills retypeRefusal twin.
  // The assistant path already refuses a set_project_skills that would drop a protected skill from the
  // effective set (enrich, re-run at confirm); without this the OPERATOR could drop a blocking-gate
  // skill with one un-retyped click. Rule: when the replace would remove protected skill(s) from this
  // project's effective set, body.confirmName must equal the dropped names EXACTLY — name-sorted,
  // joined with ', ' (a single name is just itself) — the deterministic string the 409 spells out.
  // Computed on the selection store over the SANITIZED overlay (the exact bytes the write would
  // persist) with NO await between check and write, so the gate cannot race it. confirmName is
  // wire-only: the write passes bundleId/enable field-by-field, so it can never reach the overlay.
  // The proposal executor never legitimately trips this: a confirmed set_project_skills was already
  // refused at enrich for protected drops; if protection lands in the last instants before the
  // executor's inject, this gate 409s that run — fail-closed, never a silent drop.
  app.put<{ Params: { id: string }; Body: { bundleId?: string; enable?: Record<string, boolean>; confirmName?: string } }>(
    '/api/projects/:id/skills',
    async (req, reply) => {
      const project = store.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'unknown project' });
      try {
        const delta = skillSelection.projectReplaceDelta(skillStore.list(), project.id, {
          bundleId: req.body?.bundleId,
          enable: req.body?.enable,
        });
        if (delta.droppedProtected.length) {
          const expected = delta.droppedProtected.join(', ');
          if (req.body?.confirmName !== expected) {
            return reply.code(409).send({
              error:
                `this change removes protected skill(s) ${delta.droppedProtected.map((n) => `"${n}"`).join(', ')} ` +
                `from project "${project.name}"'s effective set — retype '${expected}' exactly to confirm`,
              droppedProtected: delta.droppedProtected,
            });
          }
        }
        skillSelection.setProjectSkills(project.id, {
          bundleId: req.body?.bundleId,
          enable: req.body?.enable,
        });
        audit('skills.project.set', { projectId: project.id, bundleId: req.body?.bundleId ?? null });
        mission.emitSkills();
        return projectSkillsView(project.id);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );

  // ---- Per-project e2e testing config (SPEC-TESTING §4) ----
  app.get<{ Params: { id: string } }>('/api/projects/:id/testing', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    return testingStore.get(project.id) ?? {};
  });
  app.put<{ Params: { id: string }; Body: unknown }>('/api/projects/:id/testing', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    try {
      const cfg = testingStore.setProjectTesting(project.id, req.body);
      audit('testing.set', { projectId: project.id });
      return cfg ?? {};
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ---- projects ----
  app.get('/api/projects', async () => store.listProjects());
  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<Project> & { name?: string; repoPath?: string };
    const name = String(body.name ?? '').trim();
    // Canonicalize at the ONE place projects are created — this route serves the UI's "+ project" AND
    // every confirmed assistant proposal (executed through it via app.inject). Storing a non-canonical
    // path ('/x/repo/.', '/x//repo') would put this project's worktrees INSIDE its own working tree,
    // since the worktree root is dirname(repoPath).
    const repoPath = normalizeRepoPath(String(body.repoPath ?? '').trim());
    if (!name || !repoPath) return reply.code(400).send({ error: 'name and repoPath required' });
    // Reject relative input outright. normalizeRepoPath deliberately leaves it alone (resolving it would
    // anchor it to wherever the daemon happens to have started), and existsSync would then resolve it
    // against that same cwd — so a lucky relative path would be STORED relative, and dirname('src') = '.'
    // reproduces exactly the corruption the canonicalization above prevents.
    if (!repoPath.startsWith('/')) return reply.code(400).send({ error: 'repoPath must be an absolute path' });
    if (!existsSync(repoPath)) return reply.code(400).send({ error: 'repoPath does not exist' });
    // Optional per-project GitHub metadata. Only validated/persisted when actually sent (conditional
    // spread below keeps undefined-valued keys out of the JSON record). Read as unknown — the body is
    // untrusted input, so a non-string (or null) must fault cleanly, not slip past the string typing.
    const rawRepoUrl: unknown = body.repoUrl;
    let repoUrl: string | undefined;
    if (rawRepoUrl !== undefined && rawRepoUrl !== null && rawRepoUrl !== '') {
      if (typeof rawRepoUrl !== 'string') return reply.code(400).send({ error: 'repoUrl must be a string' });
      const v = validateRepoUrl(rawRepoUrl);
      if (!v.ok) return reply.code(400).send({ error: v.error });
      repoUrl = v.url || undefined;
    }
    const rawIdentityId: unknown = body.defaultIdentityId;
    let defaultIdentityId: string | undefined;
    if (rawIdentityId !== undefined && rawIdentityId !== null && rawIdentityId !== '') {
      if (typeof rawIdentityId !== 'string') return reply.code(400).send({ error: 'defaultIdentityId must be a string' });
      const idn = accounts.getIdentity(rawIdentityId);
      if (!idn) return reply.code(400).send({ error: 'unknown identity' });
      defaultIdentityId = idn.id;
    }
    const project: Project = {
      id: shortId(),
      name,
      repoPath,
      scaffoldMode: body.scaffoldMode ?? 'zero-footprint',
      ...(repoUrl ? { repoUrl } : {}),
      ...(defaultIdentityId ? { defaultIdentityId } : {}),
      createdAt: new Date().toISOString(),
    };
    store.upsertProject(project);
    audit('project.create', { projectId: project.id, repoPath, ...(repoUrl ? { repoUrl } : {}), ...(defaultIdentityId ? { defaultIdentityId } : {}) });
    return project;
  });

  // Per-project isolation: read the honest resolved status, and set the intent. Turning
  // ON per-agent isolation is refused (409) unless the host has been provisioned — the
  // Tower never pretends a boundary the host can't enforce, and never runs sudo itself.
  app.get<{ Params: { id: string } }>('/api/projects/:id/security', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    return projectSecurity(project, true);
  });
  app.post<{ Params: { id: string }; Body: { mode?: string } }>('/api/projects/:id/isolation', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    const mode = req.body?.mode;
    if (mode !== 'per-agent-uid' && mode !== 'single-uid') {
      return reply.code(400).send({ error: "mode must be 'per-agent-uid' or 'single-uid'" });
    }
    if (mode === 'per-agent-uid' && !hostIsolationAvailable()) {
      return reply.code(409).send({
        error: 'per-agent isolation is not provisioned on this host',
        setupCommand: SETUP_COMMAND,
      });
    }
    store.upsertProject({ ...project, isolation: mode });
    audit('project.isolation', { projectId: project.id, mode });
    return projectSecurity({ ...project, isolation: mode }, true);
  });

  // Hide/show a project on the Flightline. Presentation ONLY: every server consumer (routing,
  // gate.sweep, path-conflict, health counts, login-cwd fallback) keeps seeing an archived
  // project, and its live terminals/loops keep running — so GET /api/projects stays unfiltered
  // and the web client filters at its render sites. Unarchive passes undefined, which
  // JSON.stringify drops from the persisted record (never a null on disk).
  app.post<{ Params: { id: string }; Body: { archived?: boolean } }>('/api/projects/:id/archive', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    const archived = req.body?.archived;
    if (typeof archived !== 'boolean') {
      return reply.code(400).send({ error: 'archived must be a boolean' });
    }
    const updated: Project = { ...project, archivedAt: archived ? new Date().toISOString() : undefined };
    store.upsertProject(updated);
    audit('project.archive', { projectId: project.id, archived });
    return updated;
  });

  // Per-project GitHub config: repoUrl (metadata) + defaultIdentityId (the push/authorship identity,
  // honored end-to-end). One narrow sub-route (the /archive//limits idiom), NOT a general PATCH: it is
  // deliberately absent from the assistant ASSISTANT_ACCEPT set (a mutating route reachable only by the
  // session token). Field-present partial semantics — only keys actually sent change; null/'' clears one.
  app.post<{ Params: { id: string }; Body: unknown }>('/api/projects/:id/github', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    // A non-object body (a bare JSON primitive) would read as "no keys sent" — refuse it explicitly,
    // mirroring /limits, so a malformed request can never silently no-op.
    const body = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : undefined;
    if (!body) return reply.code(400).send({ error: 'body must be an object with a repoUrl and/or defaultIdentityId field' });
    const hasRepoUrl = 'repoUrl' in body;
    const hasIdentity = 'defaultIdentityId' in body;
    if (!hasRepoUrl && !hasIdentity) {
      return reply.code(400).send({ error: 'send repoUrl and/or defaultIdentityId (null or "" clears a field)' });
    }
    const updated: Project = { ...project };
    if (hasRepoUrl) {
      const raw = body.repoUrl;
      if (raw === null || raw === undefined || raw === '') {
        updated.repoUrl = undefined; // JSON.stringify drops it from the persisted record
      } else if (typeof raw !== 'string') {
        return reply.code(400).send({ error: 'repoUrl must be a string, or null to clear it' });
      } else {
        const v = validateRepoUrl(raw);
        if (!v.ok) return reply.code(400).send({ error: v.error });
        updated.repoUrl = v.url || undefined;
      }
    }
    if (hasIdentity) {
      const raw = body.defaultIdentityId;
      if (raw === null || raw === undefined || raw === '') {
        updated.defaultIdentityId = undefined;
      } else if (typeof raw !== 'string') {
        return reply.code(400).send({ error: 'defaultIdentityId must be a string, or null to clear it' });
      } else {
        const idn = accounts.getIdentity(raw);
        if (!idn) return reply.code(400).send({ error: 'unknown identity' });
        updated.defaultIdentityId = idn.id;
      }
    }
    store.upsertProject(updated);
    audit('project.github', { projectId: project.id, repoUrl: updated.repoUrl ?? null, defaultIdentityId: updated.defaultIdentityId ?? null });
    return updated;
  });

  // ---- repo bootstrap (SPEC-INITPUSH): preflight (read) + execute (mutating, operator-confirmed) ----
  app.get<{ Params: { id: string } }>('/api/projects/:id/bootstrap/preflight', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    const identity = project.defaultIdentityId ? accounts.getIdentity(project.defaultIdentityId) : undefined;
    return preflightBootstrap(project, identity, { pushAuth: (id) => broker.acquireDaemonPush(id) });
  });
  app.post<{ Params: { id: string }; Body: { acceptWarnings?: boolean } }>('/api/projects/:id/bootstrap', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    // Tolerate an ABSENT body (the confirmed assistant proposal injects none — the assistant path can
    // never pre-accept warnings); an object body may carry acceptWarnings from the UI preview.
    const acceptWarnings = typeof req.body === 'object' && req.body !== null && req.body.acceptWarnings === true;
    const identity = project.defaultIdentityId ? accounts.getIdentity(project.defaultIdentityId) : undefined;
    // A UNIQUE lease id per request: leases treat a same-id re-acquire as an idempotent no-op, so using
    // project.id would let two concurrent bootstraps of the same project BOTH pass and race git
    // init/add/commit. A per-request id makes the second concurrent POST collide as a clean 409, while
    // exclusion vs a concurrent land (whose id is the terminal id) still holds.
    const leaseId = `bootstrap-${shortId()}`;
    try {
      leases.acquire(project.repoPath, { kind: 'bootstrap', id: leaseId });
    } catch (e) {
      if (e instanceof LeaseHeldError) return reply.code(409).send({ error: e.message });
      throw e;
    }
    try {
      const out = await executeBootstrap(project, identity, { pushAuth: (id) => broker.acquireDaemonPush(id) }, { acceptWarnings });
      if (out.kind === 'refused') {
        audit('project.bootstrap.refuse', { projectId: project.id, codes: out.blocking.map((b) => b.code) });
        return reply.code(409).send({ error: out.error, blocking: out.blocking, warnings: out.warnings });
      }
      if (out.kind === 'failed') return reply.code(500).send({ error: out.error });
      audit('project.bootstrap', { projectId: project.id, pushed: out.result.pushed, files: out.result.fileCount ?? 0, branch: out.result.branch, identityId: identity?.id });
      return out.result;
    } finally {
      leases.release(project.repoPath, leaseId);
    }
  });

  // One-step bootstrap (bootstrap_project): register a BARE folder AND run the SAME executeBootstrap
  // init_project_repo uses, against the UNSTORED record — registering ONLY on out.kind==='done'. Every
  // refused/failed outcome is pre-commit in executeBootstrap and rolls back the .git it created, so a
  // failure registers NO project (a post-init refusal may leave a generated .gitignore + .local-context/,
  // but never a project record). A post-commit push failure is 'done' (pushed:false) and DOES register:
  // the folder is a real repo now and result.detail carries the finish command. Session-token only.
  app.post('/api/projects/bootstrap', async (req, reply) => {
    const body = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};
    const name = String(body.name ?? '').trim();
    const repoPath = normalizeRepoPath(String(body.repoPath ?? '').trim());
    if (!name || !repoPath) return reply.code(400).send({ error: 'name and repoPath required' });
    if (!repoPath.startsWith('/')) return reply.code(400).send({ error: 'repoPath must be an absolute path' });
    if (!existsSync(repoPath)) return reply.code(400).send({ error: 'repoPath does not exist' });
    // Zone refusals mirrored from bootstrap_project's enrich (defense-in-depth for a direct session-token
    // caller — the assistant path is gated at propose, but this route is reachable without it): never
    // bootstrap the Tower's own data dir (~/.ct holds credential files ghcred-*/mcptok-* that
    // executeBootstrap's by-name secret scan does NOT recognize) or a disposable Tower-managed worktree.
    // Resolve symlinks and check BOTH the literal and the link-resolved path, exactly as enrich does — a
    // literal-only check is fooled by a symlink whose target is under ~/.ct or a worktree, and
    // executeBootstrap would then commit+push those credential files through the link.
    let realRepoPath: string;
    try {
      realRepoPath = realpathSync(repoPath);
    } catch {
      return reply.code(400).send({ error: 'repoPath does not exist' });
    }
    const ctHome = normalizeRepoPath(paths.home);
    const worktreeSeg = `/${CT_WORKTREES_DIRNAME}/`;
    const inTowerZone = (p: string): boolean => p === ctHome || p.startsWith(`${ctHome}/`) || p.includes(worktreeSeg);
    if (inTowerZone(repoPath) || inTowerZone(realRepoPath)) {
      return reply.code(400).send({ error: "repoPath cannot bootstrap inside the Tower's own directory (~/.ct) or a Tower-managed worktree — point at a source directory instead" });
    }
    // BOTH GitHub fields REQUIRED (unlike POST /api/projects): v1 bootstrap is remote-required; 400 up
    // front instead of registering a record decideBootstrap would immediately refuse.
    const rawRepoUrl: unknown = body.repoUrl;
    if (typeof rawRepoUrl !== 'string' || rawRepoUrl.trim() === '') return reply.code(400).send({ error: 'repoUrl required — bootstrap pushes the first commit' });
    const v = validateRepoUrl(rawRepoUrl);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const rawIdentityId: unknown = body.defaultIdentityId;
    if (typeof rawIdentityId !== 'string' || rawIdentityId === '') return reply.code(400).send({ error: 'defaultIdentityId required — bootstrap pushes as the project identity' });
    const idn = accounts.getIdentity(rawIdentityId);
    if (!idn) return reply.code(400).send({ error: 'unknown identity' });
    const acceptWarnings = body.acceptWarnings === true;
    const project: Project = {
      id: shortId(),
      name,
      repoPath,
      scaffoldMode: 'zero-footprint',
      repoUrl: v.url,
      defaultIdentityId: idn.id,
      createdAt: new Date().toISOString(),
    };
    const leaseId = `bootstrap-${shortId()}`;
    try {
      leases.acquire(repoPath, { kind: 'bootstrap', id: leaseId });
    } catch (e) {
      if (e instanceof LeaseHeldError) return reply.code(409).send({ error: e.message });
      throw e;
    }
    try {
      const out = await executeBootstrap(project, idn, { pushAuth: (id) => broker.acquireDaemonPush(id) }, { acceptWarnings });
      if (out.kind === 'refused') {
        audit('project.bootstrap.refuse', { repoPath, codes: out.blocking.map((b) => b.code), registered: false });
        // executeBootstrap's unacknowledged-warnings refusal text points at a project's Initialize & push
        // preview — which does not exist for an UNREGISTERED folder (this caller has no project yet). Name
        // the remedy that works here: register via the UI "+ project" (POST /api/projects needs only an
        // existing directory, not a .git), then review + accept the warnings in that project's Initialize
        // & push preview. Additive to the frozen bootstrap.ts text — never a mutation of it.
        let error = out.error;
        if (out.blocking.some((b) => b.code === 'unacknowledged-warnings')) {
          error += ' — to proceed, register this folder as a project ("+ project" needs only an existing directory, not a git repo), then review and accept the warnings in that project\'s Initialize & push preview.';
        }
        return reply.code(409).send({ error, blocking: out.blocking, warnings: out.warnings, registered: false });
      }
      if (out.kind === 'failed') return reply.code(500).send({ error: out.error, registered: false });
      // A concurrent direct create_project of the SAME path could have registered it during the
      // (seconds-long) bootstrap. Re-check just before upsert; if the path is now registered, return the
      // existing project rather than storing a duplicate on one path. (projectPathConflict's 'same'
      // relation is a closure in the assistant lookups block, not in this route scope — replicate it
      // inline over normalizeRepoPath + store.listProjects.)
      const existing = store.listProjects().find((p) => normalizeRepoPath(p.repoPath) === repoPath);
      if (existing) {
        audit('project.bootstrap', { projectId: existing.id, pushed: out.result.pushed, files: out.result.fileCount ?? 0, branch: out.result.branch, identityId: idn.id, note: 'path-already-registered' });
        return { project: existing, result: out.result };
      }
      store.upsertProject(project);
      audit('project.create', { projectId: project.id, repoPath, repoUrl: project.repoUrl, defaultIdentityId: idn.id, via: 'bootstrap' });
      audit('project.bootstrap', { projectId: project.id, pushed: out.result.pushed, files: out.result.fileCount ?? 0, branch: out.result.branch, identityId: idn.id });
      return { project, result: out.result };
    } finally {
      leases.release(repoPath, leaseId);
    }
  });

  // SPEC-TERMINAL-OPS §3.1 — the per-project live-terminal cap (under the global one). API-only this
  // wave (no UI knob); null/undefined clears it, which JSON.stringify drops from the persisted record.
  app.post<{ Params: { id: string }; Body: { maxTerminals?: number | null } }>(
    '/api/projects/:id/limits',
    async (req, reply) => {
      const project = store.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: 'unknown project' });
      // A non-object body (a bare JSON primitive) would read as "field absent" and take the CLEAR
      // branch — silently removing a configured safety cap and reporting success. Refuse it, and treat
      // absence as a clear only when the caller actually sent the key (the /api/settings posture).
      const body = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : undefined;
      if (!body) return reply.code(400).send({ error: 'body must be an object with a maxTerminals field' });
      if (!('maxTerminals' in body)) return reply.code(400).send({ error: 'maxTerminals is required (null clears it)' });
      const raw = body.maxTerminals;
      let maxTerminals: number | undefined;
      if (raw !== null && raw !== undefined) {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          return reply.code(400).send({ error: 'maxTerminals must be a number, or null to clear it' });
        }
        maxTerminals = Math.max(1, Math.min(128, Math.floor(raw)));
      }
      const updated: Project = { ...project, maxTerminals };
      store.upsertProject(updated);
      audit('project.limits', { projectId: project.id, maxTerminals: maxTerminals ?? null });
      return updated;
    },
  );

  // "Autonomous (skip permissions)" per-project default. One narrow sub-route (the /archive//limits
  // idiom), session-token ONLY: deliberately absent from auth.ts ASSISTANT_ACCEPT (the per-project-
  // GitHub correction), so the SCOPED assistant token still cannot call it directly. The assistant CAN
  // propose arming it (set_project_autonomy), but that kind is carved out of autoConfirm — only the
  // operator's Confirm click executes it, and the confirmed proposal reaches this route through the
  // executor's session-token inject, never the scoped token.
  // false persists as undefined (JSON.stringify drops it) — off is the absent default, never a stored no.
  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>('/api/projects/:id/auto-accept', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be a boolean' });
    const updated: Project = { ...project, defaultAutoAccept: enabled ? true : undefined };
    store.upsertProject(updated);
    audit('project.auto-accept', { projectId: project.id, enabled });
    return updated;
  });

  // ---- terminals ----
  // Never expose the per-terminal hook token to the dashboard; it's a control-plane
  // capability the app doesn't need.
  const publicTerminal = ({ hookToken: _drop, ...rest }: Terminal): Omit<Terminal, 'hookToken'> => rest;

  app.get('/api/terminals', async () => {
    const rows = store.listTerminals();
    return Promise.all(
      rows.map(async (t) => ({
        ...publicTerminal(t),
        // hasSession re-throws on a tmux timeout (a stalled socket, not a gone one — a genuinely-gone
        // session answers false fast without throwing). Presume ALIVE on a throw so one wedged socket
        // neither 500s the whole list nor paints a live-but-stalled terminal dead (which would invite an
        // operator kill); the reconciler stays the authority that eventually flips it to killed.
        alive: t.state === 'killed' ? false : await tmux.hasSession(t.tmuxSocket).catch(() => true),
        // D1 J5/SPEC-LOOPWEDGE: whether this terminal's CURRENT idle was reached by inference
        // (no completion signal — the quiescence backstop, F1's lost-hook harvest, or F2's built-in
        // affirmative-idle demote). Now backed by the durable terminal.idleInferred record flag, so it
        // survives a Tower restart. Drives the amber "~inferred" honesty chip.
        turnInferred: poller.wasIdleInferred(t.id),
      })),
    );
  });

  app.post('/api/terminals', async (req, reply) => {
    const body = (req.body ?? {}) as CreateTerminalRequest;
    const project = store.getProject(body.projectId);
    if (!project) return reply.code(400).send({ error: 'unknown projectId' });
    // Tri-state override: absent = inherit. A present-but-non-boolean value (e.g. "false") must not
    // read as truthy OR silently degrade to inherit — refuse it.
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    if ('autoAccept' in rawBody && typeof rawBody.autoAccept !== 'boolean') {
      return reply.code(400).send({ error: 'autoAccept must be a boolean (omit it to inherit the project default)' });
    }
    // SPEC-TERMINAL-OPS §5 — a bare terminal now resolves and validates its route exactly like the
    // loop path, so the two can't disagree about what a given (provider, model, effort, account) means.
    // model/effort are API-ONLY this wave (like the per-project cap above): the composer's terminal
    // mode shows no model/effort pickers and never sends them, so the shell-refusal below is reachable
    // only from the API. Wiring the pickers into terminal mode is UI design, not route correctness.
    let model: string | undefined;
    let effort: string | undefined;
    let profileId: string | undefined;
    // An absent (or empty) provider means a plain shell — normalize both to undefined so the value
    // threaded into createTerminal is only ever a real provider id.
    let provider: ProviderId | undefined = body.provider || undefined;
    if (provider === undefined || provider === 'shell') {
      // A shell runs no agent, so model/effort/account have nowhere to go — refuse loudly rather than
      // drop them silently (the SPEC-EFFORT §0 posture).
      if (body.model || body.effort || body.profileId || body.autoAccept !== undefined) {
        return reply.code(400).send({ error: 'a shell terminal takes no model/effort/account/autonomy' });
      }
    } else {
      // No role is passed — a bare terminal plays no pipeline role — so the role tiers stay dormant
      // and the chain is explicit > provider default, exactly as for a role-less loop request.
      const resolved = resolveRouting(
        { provider: body.provider, model: body.model, effort: body.effort, profileId: body.profileId },
        {},
        routingStore.layersFor(project.id),
        providerStore,
        [],
        accounts,
      );
      provider = resolved.provider;
      model = resolved.model;
      effort = resolved.effort;
      profileId = resolved.profileId;
      // Autonomy capability gate — an EXPLICIT skip-permissions request on a provider whose adapter
      // cannot honor it is a 400, never a silent drop (createTerminal re-enforces; this gives the
      // friendly message + keeps the refusal pre-spawn). An inherited project default is NOT gated
      // here: it resolves to off inside createTerminal for unsupporting providers.
      if (body.autoAccept === true && getAdapter(provider).supportsAutoAccept !== true) {
        return reply.code(400).send({ error: `${provider} does not support autonomous (skip permissions) mode — claude-code only for now` });
      }
      const check = validateRoute(
        provider,
        model,
        providerStore,
        {
          explicitProfileId: body.profileId,
          resolvedProfileId: profileId,
          profiles: accounts,
          // Closes a real hole: a direct terminal could be spawned on the assistant Brain account,
          // which routing and loops both refuse.
          reservedProfileIds: reservedProfileIds(),
        },
        knownModelIds(provider, profileId),
        effort,
        knownEfforts(provider, profileId, model),
      );
      if (check.errors.length > 0) return reply.code(400).send({ error: check.errors.join('; ') });
      // Warnings never block (the loop.start.warn precedent) but must not vanish.
      if (check.warnings.length > 0) {
        audit('terminal.create.warn', { projectId: project.id, provider, warnings: check.warnings });
      }
    }
    try {
      const term = await tm.createTerminal(project, {
        title: body.title,
        provider,
        worktree: body.worktree,
        taskLabel: body.taskLabel,
        // The RESOLVED route, never the raw body — the adapters already consume these opts.
        model,
        effort,
        profileId,
        identityId: body.identityId,
        autoAccept: body.autoAccept,
      });
      mission.broadcastChange();
      return publicTerminal(term);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/terminals/:id/kill', async (req, reply) => {
    const term = store.getTerminal(req.params.id);
    if (!term) return reply.code(404).send({ error: 'unknown terminal' });
    await killAndForget(term.id); // tmux + tokens + leases, and unbind mission/poller/loop
    mission.broadcastChange();
    // Push a fresh attention set so a killed terminal that was in the queue drops its
    // card (killTerminal already set state 'killed', so buildAttention now excludes it).
    // Mirrors the reconciler's onVanish path.
    await mission.pushAttention();
    return { ok: true };
  });

  // SPEC-RESTART §4 — respawn the pane's CLI IN PLACE: same terminal id, socket, hook token,
  // broker, worktree lease and loop binding; only the process (and any in-flight turn) is new.
  // Deliberately NOT the kill fan-out — killAndForget fails a bound loop, this keeps it running
  // and re-arms its current iteration. Session-token gated like every other terminal route and
  // deliberately absent from ASSISTANT_ACCEPT: the assistant reaches restart only through a later
  // wave's confirmed action, never with its scoped token.
  app.post<{ Params: { id: string } }>('/api/terminals/:id/restart', async (req, reply) => {
    const term = store.getTerminal(req.params.id);
    if (!term) return reply.code(404).send({ error: 'unknown terminal' });
    let resumed = false;
    let alreadyRestarting = false;
    try {
      // preserves everything; audits terminal.restart. For a claude-code work/planner pane this may
      // RESUME the same conversation instead of starting a new one — see restartTerminal.
      ({ resumed, alreadyRestarting = false } = await tm.restartTerminal(term.id));
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
    // SPEC-RESTART-RESUME FIX B — a concurrent call (double-click, a client retry) landed on an
    // already-in-flight restart: restartTerminal did NOTHING (no respawn, no watcher, no state
    // change) and returned early, so this route must not fan out either — the FIRST call's own
    // route invocation already owns (or will own) the poller/loop/broadcast/attention refresh.
    // Calling loops.onTerminalRestarted AGAIN here with resumed:false would clobber the first
    // call's optimistic resumed:true cursor→delta mark into a spurious full re-brief.
    if (alreadyRestarting) return { ok: true, alreadyRestarting: true };
    // Fresh pane, fresh baselines: drop the poller's per-terminal snapshot/stability caches (a
    // stale hash or inferred-idle mark describes the dead process's screen). Non-destructive —
    // nothing here releases a token or lease.
    poller.forget(term.id);
    // Re-arm a bound builder's CURRENT iteration (a no-op for a plain terminal). `resumed` tells the
    // loop runner whether the agent's context survived, so it knows whether to brief full or delta.
    loops.onTerminalRestarted(term.id, { resumed });
    mission.broadcastChange();
    // A restart re-latches state (a blocked-* card's dialog died with the old process), so push a
    // fresh attention set exactly as the kill route does.
    await mission.pushAttention();
    return { ok: true, resumed };
  });

  // SPEC-RUNWAY — the shared rotate-and-fan-out: move a claude-code pane onto another subscription,
  // then the SAME non-destructive fan-out a restart does (poller rebaseline + loop re-arm + broadcast +
  // attention). Shared by the operator route below AND (W3) the loop runner's auto-rotation, so a manual
  // and an automatic rotation take the identical path. Propagates the primitive's error to the caller.
  const rotateAndFanOut = async (terminalId: string, toProfileId: string): Promise<void> => {
    await tm.rotateTerminal(terminalId, toProfileId, { isReserved: (pid) => reservedProfileIds().has(pid) });
    poller.forget(terminalId);
    loops.onTerminalRotated(terminalId, toProfileId);
    mission.broadcastChange();
    await mission.pushAttention();
  };

  app.post<{ Params: { id: string }; Body: { profileId?: string } }>('/api/terminals/:id/rotate', async (req, reply) => {
    const term = store.getTerminal(req.params.id);
    if (!term) return reply.code(404).send({ error: 'unknown terminal' });
    const toProfileId = req.body?.profileId;
    if (!toProfileId || typeof toProfileId !== 'string') return reply.code(400).send({ error: 'profileId required' });
    if (!accounts.getProfile(toProfileId)) return reply.code(404).send({ error: 'unknown target profile' });
    try {
      await rotateAndFanOut(term.id, toProfileId); // rotateTerminal audits terminal.rotate; refusals → 409
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
    return { ok: true };
  });

  // SPEC-RUNWAY W3 — late-bind the loop runner's rotation dep (it references signedInProbe +
  // rotateAndFanOut, both defined above). Resolves a builder terminal's subscription + the pool's
  // candidates by accountUuid and defers the decision to the pure controller. Rotation is inert while
  // Runway is disabled (plan short-circuits) — so the default fleet is untouched.
  // SPEC-RUNWAY live-swap -- the reactive trigger, built in the block below and fired by POST /api/agent/usage.
  let liveSwapTrigger: ReturnType<typeof createLiveSwapTrigger> | undefined;
  {
    const subOf = (
      terminalId: string,
    ): { accountUuid: string; usedPct?: number; walled: boolean; thresholdPct: number; soonestResetMs?: number } | undefined => {
      const term = store.getTerminal(terminalId);
      if (!term || term.provider !== 'claude-code') return undefined;
      const dir = liveConfigDirFor(term, accounts.getProfile.bind(accounts), 'claude-code');
      const uuid = dir ? accountIdentityFor(dir)?.accountUuid : undefined;
      if (!uuid) return undefined;
      const eff = usageStore.effective(uuid);
      return { accountUuid: uuid, usedPct: maxUsedPct(eff), walled: !!eff?.wall, thresholdPct: runwayStore.get().thresholdPct, soonestResetMs: soonestResetMs(eff) };
    };
    const candidatesOf = (): RotationCandidate[] => {
      const cfg = runwayStore.get();
      const out: RotationCandidate[] = [];
      cfg.pool.forEach((entry, order) => {
        const prof = accounts.getProfile(entry.profileId);
        if (!prof || prof.provider !== 'claude-code' || reservedProfileIds().has(entry.profileId)) return;
        const uuid = accountIdentityFor(prof.configDir)?.accountUuid;
        if (!uuid) return;
        const eff = usageStore.effective(uuid);
        out.push({
          profileId: entry.profileId,
          accountUuid: uuid,
          usedPct: maxUsedPct(eff),
          walled: !!eff?.wall,
          thresholdPct: entry.thresholdPct ?? cfg.thresholdPct,
          signedIn: signedInProbe('claude-code', prof.configDir).verdict === 'present',
          order,
          soonestResetMs: soonestResetMs(eff),
        });
      });
      return out;
    };
    // SPEC-RUNWAY live-swap -- swap a slotted pane's credential in place, then dispatch the outcome
    // (retry / respawn-fallback / quarantine). A successful swap fans out WITHOUT a respawn: only the loop's
    // cosmetic account and the board change (no poller rebaseline, no loop re-arm).
    const isReservedFn = (pid: string) => reservedProfileIds().has(pid);
    const liveSwapAndDispatch = async (terminalId: string, toProfileId: string) => {
      const outcome = await dispatchLiveSwap(terminalId, toProfileId, {
        swap: (tid, to) => tm.liveSwapTerminal(tid, to, { isReserved: isReservedFn }),
        rotate: (tid, to) => rotateAndFanOut(tid, to),
        kill: (tid) => killAndForget(tid), // quarantine last resort: never leave a cross-wired slot serving
        nextTarget: (tid, exclude) => {
          const current = subOf(tid);
          const next = chooseRotation(current, candidatesOf().filter((c) => !exclude.includes(c.profileId)));
          return next.kind === 'rotate' ? next.toProfileId : undefined;
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        audit,
      });
      if (outcome.kind === 'swapped') {
        loops.onTerminalAccountSwapped(terminalId, toProfileId);
        mission.broadcastChange();
        await mission.pushAttention();
      }
      return outcome;
    };
    const liveSwapOn = (): boolean => runwayStore.get().enabled && runwayStore.get().liveSwap !== false && runwayStore.get().pool.length > 0;
    liveSwapTrigger = createLiveSwapTrigger({
      enabled: liveSwapOn,
      isSlotted: (tid) => !!store.getTerminal(tid)?.liveSlotDir,
      overThreshold: (tid) => {
        const current = subOf(tid);
        return current ? isOverThreshold(current) : false;
      },
      pickTarget: (tid) => {
        const plan = chooseRotation(subOf(tid), candidatesOf());
        return plan.kind === 'rotate' ? plan.toProfileId : undefined;
      },
      run: liveSwapAndDispatch,
      now: Date.now,
      cooldownMs: 120_000,
      audit,
    });
    loops.setRunway({
      plan: (terminalId) => {
        const cfg = runwayStore.get();
        if (!cfg.enabled || cfg.pool.length === 0) return { kind: 'none' };
        const current = subOf(terminalId);
        if (!current) return { kind: 'none' };
        return chooseRotation(current, candidatesOf());
      },
      rotate: (terminalId, toProfileId) => rotateAndFanOut(terminalId, toProfileId),
      liveSwapReady: (terminalId) => liveSwapOn() && !!store.getTerminal(terminalId)?.liveSlotDir,
      liveSwap: async (terminalId, toProfileId) => {
        const outcome = await liveSwapAndDispatch(terminalId, toProfileId);
        if (outcome.kind === 'swapped' || outcome.kind === 'rotated') return;
        throw new Error(`live swap did not move the terminal (${outcome.kind}: ${'reason' in outcome ? outcome.reason : ''})`);
      },
      overThreshold: (terminalId) => {
        if (!runwayStore.get().enabled) return false;
        const current = subOf(terminalId);
        return current ? isOverThreshold(current) : false;
      },
    });
  }

  // ---- Mission Control: hook ingest, attention, triage ----
  app.post('/api/events', async (req, reply) => {
    const token = req.headers['x-tower-terminal-token'];
    const terminalId = typeof token === 'string' ? hookTokens.resolve(token) : undefined;
    if (!terminalId) return reply.code(401).send({ error: 'bad terminal token' });
    const body = (req.body ?? {}) as { terminalId?: string; signal?: string; emitTs?: string };
    if (body.terminalId && body.terminalId !== terminalId) {
      return reply.code(403).send({ error: 'terminal mismatch' });
    }
    // Runtime allowlist — the generated ct-hook defaults an argless invocation to the
    // string "unknown", and any non-empty string would otherwise reach ingest. Reject
    // anything that isn't a known signal so a bad value can't drive state to undefined.
    // ('agent-question' is SPEC-CLEARANCE §A's strong ask-the-user wire signal; ingestSignal
    // normalizes it to needs-input past the phantom-hold veto.)
    const KNOWN_SIGNALS: readonly WireHookSignal[] = ['needs-input', 'needs-permission', 'turn-done', 'session-start', 'agent-question'];
    const signal = body.signal as WireHookSignal | undefined;
    if (!signal || !KNOWN_SIGNALS.includes(signal)) {
      return reply.code(400).send({ error: 'unknown signal' });
    }
    reply.code(202).send({ ok: true }); // ack before doing work (the veto's capture included)
    // SPEC-LOOPWEDGE F5 — the 202 acks before the ingest runs (latency), so an ingest THROW after the
    // ack would otherwise drop the event silently. Respool it to disk (the drain replays it, exactly
    // like ct-hook's own fallback) so a lost Stop can still self-heal — never a silently swallowed hook.
    void mission.ingestSignal(terminalId, signal, body.emitTs).catch((err) => {
      console.error('[events] ingest failed; respooling:', err);
      // SPEC-LOOPWEDGE F5 — respool ONLY with the real nanosecond emitTs the hook sent, so the drain
      // replays it THROUGH ingest's ordering guard. A missing/'0'/malformed emitTs is un-ordered:
      // replayed, it could re-idle a pane that legitimately re-worked before the drain — a REAL-idle
      // (inferred=false) that would bypass the loop GUARD. Such a value can only come from a malformed
      // direct POST (ct-hook always stamps `date +%s%N`), so dropping it loses no genuine hook.
      if (isOrderedEmitTs(body.emitTs)) {
        spoolEvent({ terminalId, signal, emitTs: body.emitTs });
      } else {
        console.error('[events] not respooling an unordered event (no valid emitTs):', terminalId, signal);
      }
    });
  });

  app.get('/api/attention', async () => mission.buildAttention());

  app.post<{ Params: { id: string }; Body: { text?: string } }>('/api/terminals/:id/reply', async (req, reply) => {
    try {
      await mission.reply(req.params.id, String(req.body?.text ?? ''));
      return { ok: true };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  app.post<{ Params: { id: string } }>('/api/terminals/:id/approve', async (req, reply) => {
    try {
      await mission.approve(req.params.id);
      return { ok: true };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  app.post<{ Params: { id: string } }>('/api/terminals/:id/deny', async (req, reply) => {
    try {
      await mission.deny(req.params.id);
      return { ok: true };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  // ---- Review & Land ----
  const withTermProject = (id: string) => {
    const term = store.getTerminal(id);
    if (!term) return null;
    const project = store.getProject(term.projectId);
    if (!project) return null;
    return { term, project };
  };

  app.get<{ Params: { id: string } }>('/api/terminals/:id/review', async (req, reply) => {
    const ctx = withTermProject(req.params.id);
    if (!ctx) return reply.code(404).send({ error: 'unknown terminal' });
    try {
      return await worktrees.review(ctx.project, ctx.term);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { file?: string } }>('/api/terminals/:id/patch', async (req, reply) => {
    const ctx = withTermProject(req.params.id);
    if (!ctx) return reply.code(404).send({ error: 'unknown terminal' });
    try {
      const patch = await worktrees.patch(ctx.project, ctx.term, req.query.file);
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      return patch;
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/api/terminals/:id/request-changes',
    async (req, reply) => {
      try {
        await mission.reply(req.params.id, String(req.body?.text ?? ''));
        return { ok: true };
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { mode?: 'merge' | 'pr'; title?: string } }>(
    '/api/terminals/:id/land',
    async (req, reply) => {
      const ctx = withTermProject(req.params.id);
      if (!ctx) return reply.code(404).send({ error: 'unknown terminal' });
      try {
        return await worktrees.land(ctx.project, ctx.term, req.body?.mode ?? 'merge', req.body?.title);
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/terminals/:id/worktree/remove', async (req, reply) => {
    const ctx = withTermProject(req.params.id);
    if (!ctx) return reply.code(404).send({ error: 'unknown terminal' });
    try {
      const res = await worktrees.remove(ctx.project, ctx.term);
      if (res.dirty) return reply.code(409).send({ error: 'worktree has uncommitted changes', dirty: true });
      return res;
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/worktrees', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    return worktrees.listForProject(project);
  });

  // ---- loops (iterate-until-done) ----
  app.get('/api/loops', async () => loops.list());
  app.get<{ Params: { id: string } }>('/api/loops/:id', async (req, reply) => {
    const loop = loops.get(req.params.id);
    if (!loop) return reply.code(404).send({ error: 'unknown loop' });
    return loop;
  });
  app.post('/api/loops', async (req, reply) => {
    try {
      // Strip mission backrefs on the PUBLIC route: only the in-process mission autopilot may
      // set missionId/sortieId (they are load-bearing for crash-recovery de-dup, not user input).
      // backlogTaskId is route-consumed (⟦DP-B4⟧): stamped AFTER a successful create — link
      // refuses overwrite and ignores unknown ids, never failing the create.
      const { missionId: _mid, sortieId: _sid, backlogTaskId, ...body } = (req.body ?? {}) as CreateLoopRequest;
      const loop = await loops.create(body);
      if (backlogTaskId) backlogStore.link(backlogTaskId, { loopId: loop.id });
      return loop;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/api/loops/:id/continue', async (req, reply) => {
    try {
      return loops.continue(req.params.id, req.body?.note);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  app.post<{ Params: { id: string }; Body: { mode?: 'merge' | 'pr'; title?: string } }>('/api/loops/:id/land', async (req, reply) => {
    try {
      return await loops.land(req.params.id, req.body?.mode ?? 'merge', req.body?.title);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });
  app.post<{ Params: { id: string } }>('/api/loops/:id/pause', async (req, reply) => {
    try { return loops.pause(req.params.id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string } }>('/api/loops/:id/resume', async (req, reply) => {
    try { return loops.resume(req.params.id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string } }>('/api/loops/:id/step', async (req, reply) => {
    try { return loops.step(req.params.id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string } }>('/api/loops/:id/stop', async (req, reply) => {
    try { return loops.stop(req.params.id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // ---- missions (autopilot campaigns) ----
  app.get('/api/missions', async () => missions.list());
  app.get<{ Params: { id: string } }>('/api/missions/:id', async (req, reply) => {
    const mission = missions.get(req.params.id);
    if (!mission) return reply.code(404).send({ error: 'unknown mission' });
    return mission;
  });
  // SPEC-LOOP W4 — the mission's delivery report JSON (session-token; NOT TOKEN_EXEMPT). The web keys
  // off this: 404 while absent (a crash/GC race, or a mission that never finished) → "report pending".
  app.get<{ Params: { id: string } }>('/api/missions/:id/report', async (req, reply) => {
    if (!MISSION_ID_RE.test(req.params.id)) return reply.code(404).send({ error: 'not found' });
    const p = join(paths.reports, req.params.id, 'report.json');
    if (!existsSync(p)) return reply.code(404).send({ error: 'not found' });
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });
  // SPEC-LOOP W4 — the standalone REPORT.html, DOWNLOAD-ONLY (§3 W4: never rendered at the app origin).
  // attachment + nosniff + octet-stream, mirroring the testruns artifact route guard.
  app.get<{ Params: { id: string } }>('/api/missions/:id/report/html', async (req, reply) => {
    if (!MISSION_ID_RE.test(req.params.id)) return reply.code(404).send({ error: 'not found' });
    let fh: Awaited<ReturnType<typeof fsOpen>>;
    try {
      fh = await fsOpen(join(paths.reports, req.params.id, 'REPORT.html'), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        await fh.close();
        return reply.code(404).send({ error: 'not found' });
      }
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', `attachment; filename="REPORT-${req.params.id}.html"`);
      return reply.send(fh.createReadStream(st.size > 0 ? { end: st.size - 1 } : {}));
    } catch {
      await fh.close();
      return reply.code(404).send({ error: 'not found' });
    }
  });
  // SPEC-LOOP W4 — one proof file under the report's proof/ dir. Clones the testruns artifact-route
  // containment: resolveContained under <reports>/<missionId>/proof, byte-identical 404-on-escape,
  // attachment + nosniff + octet-stream. Session-token only.
  app.get<{ Params: { id: string; name: string } }>('/api/missions/:id/report/proof/:name', async (req, reply) => {
    if (!MISSION_ID_RE.test(req.params.id)) return reply.code(404).send({ error: 'not found' });
    let fh: Awaited<ReturnType<typeof fsOpen>>;
    try {
      const rc = resolveContained(join(paths.reports, req.params.id, 'proof'), req.params.name);
      fh = await fsOpen(rc.real, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        await fh.close();
        return reply.code(404).send({ error: 'not found' });
      }
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      const safeName = basename(req.params.name).replace(/["\\\r\n\x00-\x1f]/g, '_');
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      return reply.send(fh.createReadStream(st.size > 0 ? { end: st.size - 1 } : {}));
    } catch {
      await fh.close();
      return reply.code(404).send({ error: 'not found' });
    }
  });
  app.post('/api/missions', async (req, reply) => {
    try {
      // backlogTaskId + planner are ROUTE-consumed (⟦DP-B4⟧ / DEC-P8): both are stripped before
      // missions.create, so a raw-API body carrying either can never reach create() (no strip-trap to miss).
      const { backlogTaskId, planner, ...body } = (req.body ?? {}) as CreateMissionRequest;
      // SPEC-TESTING-V2 §2 — capture the project's configured gate suite at CREATE (route-side, mirroring
      // the backlog-link doctrine — Missions never learns testingStore). Key on `=== undefined` so an
      // explicit '' (operator opt-out) is never converted back to inherit; a value passes through.
      if (body.gateSuite === undefined) {
        const inherited = testingStore.get(body.projectId)?.gateSuite;
        if (inherited) body.gateSuite = inherited;
      }
      // SPEC-PLANNER §3 (DEC-P8) — spawn-BEFORE-create, fail-closed. Resolve + validate the planner route
      // (role 'plan') FIRST so a bad route 400s with NO side effects; then spawn the pane; then create the
      // mission and bind. A spawn failure → 400, no mission (never a silent degrade to the codex Brain). A
      // create failure AFTER the spawn → best-effort killTerminal in the catch.
      let plannerTerm: Terminal | undefined;
      let plannerModel: string | undefined;
      let plannerEffort: string | undefined;
      if (planner?.spawn) {
        const project = store.getProject(body.projectId);
        if (!project) return reply.code(400).send({ error: 'unknown project' });
        const spawn = planner.spawn;
        const resolved = resolveRouting(
          { role: 'plan', provider: spawn.provider, model: spawn.model, effort: spawn.effort, profileId: spawn.profileId },
          {}, routingStore.layersFor(project.id), providerStore, [], accounts,
        );
        if (resolved.provider === 'shell') return reply.code(400).send({ error: 'a planner cannot be a shell terminal' });
        const check = validateRoute(
          resolved.provider, resolved.model, providerStore,
          { explicitProfileId: spawn.profileId, resolvedProfileId: resolved.profileId, profiles: accounts, reservedProfileIds: reservedProfileIds() },
          knownModelIds(resolved.provider, resolved.profileId), resolved.effort, knownEfforts(resolved.provider, resolved.profileId, resolved.model),
        );
        if (check.errors.length > 0) return reply.code(400).send({ error: check.errors.join('; ') });
        try {
          plannerTerm = await tm.createTerminal(project, {
            provider: resolved.provider, model: resolved.model, effort: resolved.effort, profileId: resolved.profileId,
            title: `planner · ${body.name}`, purpose: 'planner', worktree: false,
          });
        } catch (e) {
          return reply.code(400).send({ error: `planner spawn failed: ${(e as Error).message}` });
        }
        plannerModel = resolved.model;   // the RESOLVED argv model/effort — Terminal doesn't record argv
        plannerEffort = resolved.effort;
        grantPlannerTowerctl(plannerTerm);
      }
      // SPEC-SKILLS-GATE — freeze the loop-green gate set at CREATE, route-side (the gateSuite-inherit
      // doctrine above: Missions never learns the skill stores). Only a LOOP mission gets one: the
      // project's resolved skill selection, filtered to enabled BLOCKING gates declaring 'loop-green',
      // ids sorted for determinism. Threaded as create()'s SECOND arg — deliberately never a
      // CreateMissionRequest field, so a raw-API body smuggling `loop.requiredGates` is structurally
      // inert (nothing reads it; no strip-trap to miss).
      let derivedGates: { requiredGates?: string[]; rerunGates?: string[] } | undefined;
      if (body.loop) {
        const { entries } = skillSelection.resolveForProject(skillStore.list(), body.projectId);
        const gateSkills = entries
          .map((e) => e.skill)
          .filter((s) => s.gate?.mode === 'blocking' && (s.gate.blocks ?? []).includes('loop-green'));
        if (gateSkills.length) {
          const rerun = gateSkills.filter((s) => s.gate?.rerunOnNewDiff === true).map((s) => s.id).sort();
          derivedGates = {
            requiredGates: gateSkills.map((s) => s.id).sort(),
            ...(rerun.length ? { rerunGates: rerun } : {}),
          };
        }
      }
      let created;
      try {
        created = missions.create(body as CreateMissionRequest, derivedGates);
      } catch (e) {
        if (plannerTerm) { try { await tm.killTerminal(plannerTerm.id); } catch { /* best-effort */ } }
        return reply.code(400).send({ error: (e as Error).message });
      }
      if (plannerTerm) {
        const p = plannerTerm;
        missions.attachPlanner(created.id, {
          terminalId: p.id, provider: p.provider,
          ...(p.profileId ? { profileId: p.profileId } : {}),
          ...(plannerModel ? { model: plannerModel } : {}), ...(plannerEffort ? { effort: plannerEffort } : {}),
          state: 'live', attachedAt: new Date().toISOString(), spawned: true,
        });
        mission.broadcastChange();
        created = missions.get(created.id) ?? created;
      }
      if (backlogTaskId) backlogStore.link(backlogTaskId, { missionId: created.id });
      return created;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  // Draft-only: never runs anything. 503 until the integrator injects planDraft.
  app.post<{ Body: { projectId?: string; goal?: string } }>('/api/missions/plan', async (req, reply) => {
    const { projectId, goal } = req.body ?? {};
    if (!projectId || !goal) return reply.code(400).send({ error: 'projectId and goal required' });
    try {
      const phases = await missions.plan(projectId, goal);
      return { phases };
    } catch (e) {
      const msg = (e as Error).message;
      const code = msg === 'assistant planning unavailable' ? 503 : 400;
      return reply.code(code).send({ error: msg });
    }
  });
  app.post<{ Params: { id: string } }>('/api/missions/:id/start', async (req, reply) => {
    try { return await missions.start(req.params.id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string } }>('/api/missions/:id/pause', async (req, reply) => {
    try { return missions.pause(req.params.id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string } }>('/api/missions/:id/abort', async (req, reply) => {
    try { return missions.abort(req.params.id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string } }>('/api/missions/:id/advance', async (req, reply) => {
    try { return await missions.advance(req.params.id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string; sid: string } }>('/api/missions/:id/sorties/:sid/retry', async (req, reply) => {
    try { return missions.retry(req.params.id, req.params.sid); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });

  // SPEC-PLANNER §3 — attach an EXISTING idle pane as the mission's planner (session-token, operator
  // action). The refusals run in order; each is a distinct 409 message (A8). Only past all of them does
  // the binding land.
  app.post<{ Params: { id: string }; Body: { terminalId?: string } }>('/api/missions/:id/planner/attach', async (req, reply) => {
    const m = missions.get(req.params.id);
    if (!m) return reply.code(404).send({ error: 'unknown mission' });
    if (m.status === 'done' || m.status === 'failed' || m.archivedAt) return reply.code(409).send({ error: 'the mission is finished' });
    if (m.planner && m.planner.state === 'live') return reply.code(409).send({ error: 'the mission already has a live planner — detach first' });
    const terminalId = req.body?.terminalId;
    if (!terminalId) return reply.code(400).send({ error: 'terminalId required' });
    const term = store.getTerminal(terminalId);
    if (!term || term.state === 'killed') return reply.code(409).send({ error: 'unknown or killed terminal' });
    if (term.provider === 'shell') return reply.code(409).send({ error: 'a shell terminal cannot be a planner' });
    // P6a — a login pane gets NO hooks (a gemini/custom login pane can reach idle without them), so refuse
    // it explicitly rather than let the idle preflight wave it through.
    if (term.purpose === 'login') return reply.code(409).send({ error: 'a login terminal cannot be a planner' });
    // An autonomous (skip-permissions) pane was LAUNCHED without the permission gate — re-stamping
    // its purpose cannot restore the gate, so it can never serve as a planner.
    if (term.autoAccept) return reply.code(409).send({ error: 'the pane runs without the permission gate (autonomous) — a planner must keep the human gate' });
    // P6b — cross-project: a planner grounded in the wrong tree leaks this mission's plan structure into a
    // foreign repo's session and reasons over the wrong code.
    if (term.projectId !== m.projectId) return reply.code(409).send({ error: 'the terminal belongs to a different project than the mission' });
    // 4 — another live mission's planner (the DEC-P3 predicate across ALL missions): one context window
    // serving two missions is cross-mission bleed.
    if (missions.list().some((o) => o.id !== m.id && o.planner?.terminalId === terminalId && o.planner.state === 'live' && o.status !== 'done' && o.status !== 'failed' && !o.archivedAt)) {
      return reply.code(409).send({ error: "the terminal is already another mission's planner" });
    }
    // 5 — the terminal drives a non-terminal loop (loops only ever CREATE terminals; a planner must be
    // loop-free, so this is where "excluded from loop assignment" is enforced).
    if (loops.list().some((l) => l.terminalId === terminalId && !isTerminalLoop(l.status))) {
      return reply.code(409).send({ error: 'the terminal is running a loop — a planner must be loop-free' });
    }
    // 6 — never adopt a Brain-reserved pane.
    if (term.profileId && reservedProfileIds().has(term.profileId)) {
      return reply.code(409).send({ error: 'the terminal runs on a reserved assistant-brain account' });
    }
    // 7 PREFLIGHT (DEC-P7): idle proves the hook pipeline is live (claude idles ONLY via its Stop hook),
    // and the hook token file must exist on disk (or replies can't authenticate).
    if (term.state !== 'idle') return reply.code(409).send({ error: 'the pane must be idle — for claude-code an idle pane proves its Stop hook is live' });
    if (!existsSync(hookTokens.tokenFile(terminalId))) return reply.code(409).send({ error: 'the terminal has no hook token on disk — it cannot authenticate consult replies' });
    missions.attachPlanner(m.id, {
      terminalId, provider: term.provider,
      ...(term.profileId ? { profileId: term.profileId } : {}),
      state: 'live', attachedAt: new Date().toISOString(), spawned: false,
    });
    store.patchTerminal(terminalId, { purpose: 'planner' });
    mission.broadcastChange();
    return {
      ...missions.get(m.id),
      // The honest posture: permission allowlisting can't be verified from outside (DEC-P7).
      preflight: 'Allowlist `towerctl` in this pane\'s permission config (e.g. Bash(towerctl:*)) so a consult reply does not stop at a permission dialog.',
    };
  });

  // SPEC-PLANNER §3 — detach the planner: an EXPLICIT operator choice to fall back to the codex Brain,
  // never a silent fallback. Clears the binding, clears the pane's purpose, and EXPIRES every open consult.
  app.post<{ Params: { id: string } }>('/api/missions/:id/planner/detach', async (req, reply) => {
    const m = missions.get(req.params.id);
    if (!m) return reply.code(404).send({ error: 'unknown mission' });
    if (!m.planner) return reply.code(409).send({ error: 'the mission has no planner' });
    const tid = m.planner.terminalId;
    missions.detachPlanner(m.id);
    // Clear purpose on the pane if it still exists (a detach of a vanished planner has nothing to clear).
    if (store.getTerminal(tid)) store.patchTerminal(tid, { purpose: 'work' });
    // Expire every open consult (P3: `answered → expired` is allowed) so none lingers "waiting on planner".
    let any = false;
    for (const c of consultStore.openFor(m.id)) {
      try { consultStore.resolve(c.id, 'expired', 'planner-detached'); any = true; } catch { /* raced to closed */ }
    }
    if (any) mission.emitConsults();
    mission.broadcastChange();
    return missions.get(m.id);
  });

  // SPEC-PLANNER §9 — the operator's consult view (session-token; NOT TOKEN_EXEMPT, NOT assistant). Open
  // consults plus the newest 10 CLOSED per mission. Never `answer` bodies; `question` capped at 200 chars.
  app.get<{ Querystring: { missionId?: string } }>('/api/consults', async (req) => {
    const wanted = req.query.missionId ? [req.query.missionId] : missions.list().map((m) => m.id);
    const out: unknown[] = [];
    for (const mid of wanted) {
      const all = consultStore.listFor(mid);
      if (all.length === 0) continue;
      const open = all.filter(isConsultOpen);
      const closed = all.filter((c) => !isConsultOpen(c)).slice(0, 10);
      for (const c of [...open, ...closed]) {
        out.push({
          id: c.id, missionId: c.missionId, kind: c.kind, status: c.status,
          askedAt: c.askedAt, ...(c.deliveredAt ? { deliveredAt: c.deliveredAt } : {}),
          ...(isConsultOpen(c) && consultDeadline(c) ? { deadline: consultDeadline(c) } : {}),
          ...(c.expireReason ? { expireReason: c.expireReason } : {}),
          question: c.question.slice(0, 200),
        });
      }
    }
    return { consults: out };
  });
  // SPEC-LOOP W3 (G4) — grade a DRAFT mission's plan with the codex Brain (two read-only lenses:
  // fact-check anchors + red-team soundness) BEFORE it can start. Session-token ONLY (NOT TOKEN_EXEMPT /
  // ASSISTANT_ACCEPT — LLM spend is operator-only; the grade is off the fixer path). Single-flight per
  // mission (the summarize idiom): an in-memory Set 409s a concurrent 2nd caller, released in finally (a
  // crash clears it — no permanent 409); an AbortController aborts the Brain when the request closes.
  // Idempotent-return ONLY a stored PASS bound to the CURRENT plan (no key, no LLM spend); a BLOCKED
  // review always re-runs (grading again) so a blocked plan is never a permanent dead-end; the
  // {force:true} re-grades even a passing plan. gradePlan/planPhases THROWING → 502 with NO stored review
  // (never fabricate a verdict). On a block: auto-redraft ONCE (planner, block findings as context) then
  // re-grade the redraft ONCE, and store that final grade.
  const reviewingPlans = new Set<string>();
  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/api/missions/:id/review-plan', async (req, reply) => {
    const mission = missions.get(req.params.id);
    if (!mission) return reply.code(404).send({ error: 'unknown mission' });
    if (mission.activePhase >= 0) {
      return reply.code(409).send({ error: 'plan review applies only to a draft (not-yet-started) mission' });
    }
    // Opt-in gate: the grade LLM-spends and the block path DESTRUCTIVELY redrafts the plan — only a
    // mission that asked for plan review (a loop mission with requirePlanReview) may be reviewed here.
    if (!mission.loop?.requirePlanReview) {
      return reply.code(400).send({ error: 'plan review is not enabled for this mission' });
    }
    const project = store.getProject(mission.projectId);
    if (!project) return reply.code(409).send({ error: 'mission project not found' });
    const force = (req.body as { force?: boolean } | undefined)?.force === true;
    // Idempotent-return ONLY a stored PASS for the CURRENT plan (no LLM spend). A block is never
    // idempotent — re-clicking re-grades (and may redraft), so a blocked plan can recover.
    if (!force && mission.planReview?.verdict === 'pass' && mission.planReview.phasesHash === computePhasesHash(mission.phases)) {
      return { planReview: mission.planReview };
    }
    if (!validator.available().ok) {
      return reply.code(503).send({ error: validator.available().reason ?? 'no assistant brain configured' });
    }
    if (reviewingPlans.has(mission.id)) return reply.code(409).send({ error: 'a plan review is already in flight' });
    reviewingPlans.add(mission.id);
    const ac = new AbortController();
    req.raw.on('close', () => ac.abort());
    try {
      // 1. Grade the current plan.
      const grade = await validator.gradePlan(project.repoPath, mission.goal, mission.phases, ac.signal);
      if (grade.verdict === 'pass') {
        const review: MissionPlanReview = {
          verdict: 'pass', findings: grade.findings, gradedAt: new Date().toISOString(),
          phasesHash: computePhasesHash(mission.phases),
        };
        const updated = missions.setPlanReview(mission.id, review);
        audit('mission.plan-review', { missionId: mission.id, verdict: 'pass', findings: grade.findings.length, redrafted: false });
        return { planReview: updated.planReview };
      }
      // 2. BLOCKED. Auto-redraft ONCE — but ONLY on the FIRST review of this mission (no prior review).
      //    A force RE-review that blocks must NOT redraft: LLM grades are non-deterministic, so a
      //    re-graded pass→block flip must never destroy the operator's already-authored/approved plan;
      //    record the block against the current plan and let the operator decide.
      if (mission.planReview) {
        const review: MissionPlanReview = {
          verdict: 'block', findings: grade.findings, gradedAt: new Date().toISOString(),
          phasesHash: computePhasesHash(mission.phases),
        };
        const updated = missions.setPlanReview(mission.id, review);
        audit('mission.plan-review', { missionId: mission.id, verdict: 'block', findings: grade.findings.length, redrafted: false });
        return { planReview: updated.planReview };
      }
      // First review blocked → auto-redraft once (planner, with the block findings as context).
      const blockCtx = grade.findings
        .filter((f) => f.severity === 'block')
        .map((f) => `- ${f.lens}${f.target ? ` [${f.target}]` : ''}: ${f.detail}`)
        .join('\n');
      const redraftGoal = `${mission.goal}\n\n--- THE PRIOR PLAN WAS BLOCKED IN REVIEW; address these before re-planning ---\n${blockCtx}`;
      const redraftPhases = await validator.planPhases(project.repoPath, redraftGoal, buildRoster(), ac.signal);
      // GRADE THE REDRAFT BEFORE COMMITTING IT — a transient throw here must leave the operator's
      // original plan intact (replaceDraftPhases has NOT run yet), never overwritten-but-unreviewed.
      const regrade = await validator.gradePlan(project.repoPath, mission.goal, redraftPhases, ac.signal);
      const afterRedraft = missions.replaceDraftPhases(mission.id, redraftPhases);
      const review: MissionPlanReview = {
        verdict: regrade.verdict, findings: regrade.findings, gradedAt: new Date().toISOString(),
        phasesHash: computePhasesHash(afterRedraft.phases),
      };
      const updated = missions.setPlanReview(mission.id, review);
      audit('mission.plan-review', { missionId: mission.id, verdict: regrade.verdict, findings: regrade.findings.length, redrafted: true });
      return { planReview: updated.planReview };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    } finally {
      reviewingPlans.delete(mission.id);
    }
  });

  // ---- stories: user-story corpus + derived four-state coverage (SPEC-STORYLOOP §1) ----
  app.get<{ Querystring: { projectId?: string } }>('/api/stories', async (req) =>
    storyStore.list(req.query.projectId));
  app.post('/api/stories', async (req, reply) => {
    const body = (req.body ?? {}) as CreateStoryRequest;
    // First story for a project → document the e2e kit in its glossary (§5.3). Checked
    // BEFORE the upsert; the memory write is best-effort and never fails the create.
    const wasEmpty = !!body.projectId && storyStore.list(body.projectId).length === 0;
    try {
      const story = storyStore.upsert(body);
      if (wasEmpty) { try { memory.ensureTestKitMemory(story.projectId); } catch { /* best effort */ } }
      return story;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.put<{ Params: { id: string } }>('/api/stories/:id', async (req, reply) => {
    try {
      return storyStore.upsert({ ...((req.body ?? {}) as CreateStoryRequest), id: req.params.id });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/stories/:id', async (req) => {
    storyStore.remove(req.params.id); // idempotent — unknown id is a no-op, no frame
    return { ok: true };
  });
  // Derived coverage ADAPTER (§1.4): reshape coverage()'s {perStory,rollup} to the coverage wire contract
  // { hasRun, coverage: StoryCoverage[] }. `hasRun` = a non-gate run WITH parsed results exists
  // (results !== undefined; an all-green run is `[]`, still a run). Uses the PARSED
  // accessor: acquire persists a `running` (results-undefined) meta immediately, and the bare
  // newest-run accessor would blank earned coverage for the whole duration of any in-flight run.
  // Mapped-story-no-run entries (coverage null) are OMITTED; unmapped stories always `uncovered`.
  app.get<{ Querystring: { projectId?: string } }>('/api/stories/coverage', async (req) => {
    const pid = req.query.projectId;
    if (!pid) return { hasRun: false, coverage: [] as StoryCoverage[] };
    const run = testkit.latestParsedForProject(pid);
    const hasRun = run?.results !== undefined;
    const report = coverage(storyStore.list(pid), run);
    const cov = report.perStory
      .map((e) => e.coverage)
      .filter((c): c is StoryCoverage => c !== null);
    return { hasRun, coverage: cov };
  });
  // Draft-only (§1.3, codex-only): never persists. A draft failure returns 200 with a note so manual
  // authoring is never blocked; only a bad/missing project is a 4xx.
  app.post<{ Body: { projectId?: string; goal?: string } }>('/api/stories/draft', async (req, reply) => {
    const { projectId, goal } = req.body ?? {};
    if (!projectId) return reply.code(400).send({ error: 'projectId required' });
    const project = store.getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'unknown project' });
    try {
      const drafts = await validator.draftStories(project.repoPath, goal);
      return { drafts };
    } catch (e) {
      return { drafts: [], note: (e as Error).message };
    }
  });

  // ---- skills: the canonical, provider-agnostic skill library (SPEC-SKILLS) ----
  // Session-token-only by default — the onRequest hook already enforces it for any /api path not in
  // TOKEN_EXEMPT, and nothing here is added to TOKEN_EXEMPT or ASSISTANT_ACCEPT (no agent or scoped
  // assistant reaches these). Routes CAST the body; the store's zod is the validator (throw → 400). The
  // store owns the SSE onChange frame; these handlers write the audit line on each mutation.
  app.get('/api/skills', async () => skillStore.list()); // META only — a bounded payload (no bodies)
  app.get<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const meta = skillStore.get(req.params.id);
    const body = skillStore.getBody(req.params.id);
    if (!meta || body === undefined) return reply.code(404).send({ error: 'unknown skill' });
    return { ...meta, body };
  });
  // SPEC-SKILLS Phase 5b wave 2 — the operator retype-the-name gate. When the RESOLVED target is
  // protected (isProtectedSkill: operator lock or blocking gate), every mutating skills route demands
  // body.confirmName === the current record's exact name (case-sensitive), else 409 — the two-step
  // that makes editing a load-bearing gate skill a deliberate act instead of a click. Checked
  // synchronously against the current record before each store write (the deleteWorkflow single-
  // writer argument). confirmName is wire-only: read off the raw body here, never store input
  // (buildAndStage assembles its candidate field-by-field, so an unknown key is structurally inert
  // anyway). The proposal executor never conflicts: every skills-mutating assistant action is
  // refused at enrich for protected targets — re-run at confirm — so a confirmed proposal cannot
  // legitimately reach a protected target; if protection lands in the last instants before the
  // executor's inject, this gate 409s that run — fail-closed, never a silent write.
  const retypeRefusal = (id: string, body: unknown): string | undefined => {
    const current = skillStore.get(id);
    if (!current || !isProtectedSkill(current)) return undefined;
    const confirmName = (body as { confirmName?: unknown } | null | undefined)?.confirmName;
    if (confirmName === current.name) return undefined;
    return `'${current.name}' is protected — retype its exact name to change it`;
  };
  app.post('/api/skills', async (req, reply) => {
    const input = { ...((req.body ?? {}) as UpsertSkillRequest) };
    delete input.confirmName; // wire-only (see retypeRefusal) — never store input
    // POST is patch-capable when the body carries an id, so the retype gate keys on the RESOLVED
    // target, not the verb; an id-less create has no existing record and is ungated.
    if (typeof input.id === 'string') {
      const refusal = retypeRefusal(input.id, req.body);
      if (refusal) return reply.code(409).send({ error: refusal });
    }
    try {
      const skill = skillStore.upsert(input);
      audit('skill.upsert', { id: skill.id });
      return skill;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.put<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const refusal = retypeRefusal(req.params.id, req.body);
    if (refusal) return reply.code(409).send({ error: refusal });
    try {
      const input = { ...((req.body ?? {}) as UpsertSkillRequest) };
      delete input.confirmName; // wire-only (see retypeRefusal) — never store input
      // Path id is authoritative (the stories PUT precedent) — a body id can never redirect the write.
      const skill = skillStore.upsert({ ...input, id: req.params.id });
      audit('skill.upsert', { id: skill.id });
      return skill;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.delete<{ Params: { id: string }; Body: { confirmName?: string } }>('/api/skills/:id', async (req, reply) => {
    const refusal = retypeRefusal(req.params.id, req.body);
    if (refusal) return reply.code(409).send({ error: refusal });
    // SPEC-SKILLS Phase 3 — refuse a delete that would silently vanish an AFFIRMATIVE reference (a
    // bundle member, or a project's enable:true): 409 naming both kinds. The reference CHECK spans two
    // stores but is safe without a transaction because BOTH it and store.remove are synchronous with NO
    // await between them (the deleteWorkflow single-writer argument), so a concurrent selection can't
    // slip into the gap. An inert enable:false is NOT a reference — pruneSkill sweeps it after the delete.
    const refs = skillSelection.skillReferences(req.params.id); // sync
    if (refs.bundles.length || refs.projects.length) {
      const referencedBy = [
        ...refs.bundles.map((bid) => `bundle "${skillSelection.getBundle(bid)?.name ?? bid}"`),
        ...refs.projects.map((pid) => `project "${store.getProject(pid)?.name ?? pid}"`),
      ];
      return reply.code(409).send({
        error: `skill is referenced by ${referencedBy.length} selection(s): ${referencedBy.join(', ')} — unassign it there before deleting`,
        referencedBy,
      });
    }
    skillStore.remove(req.params.id); // sync — NO await before this; fires {t:'skills'} iff the id existed
    // pruneSkill sweeps any inert enable:false leftover. skillStore.remove fires NO frame when the id was
    // already gone from the library (its early-return), so emit here whenever the prune actually changed
    // the selection — an open Settings page must not stay stale on a persisted selection mutation.
    if (skillSelection.pruneSkill(req.params.id)) mission.emitSkills();
    audit('skill.delete', { id: req.params.id });
    return { ok: true };
  });
  // A narrow toggle for a skill's `enabled` flag (the auto-accept sub-route idiom) — a full upsert can't
  // ride it because upsert demands name/description/body every call (store.setEnabled). Session-token ONLY:
  // deliberately absent from ASSISTANT_ACCEPT, so the SCOPED assistant token still cannot call it. The
  // assistant CAN propose set_skill_enabled, but that kind is carved out of autoConfirm — only the operator's
  // Confirm click executes it, and the confirmed proposal reaches this route through the executor's
  // session-token inject, never the scoped token. Flips ONLY enabled; version + contentHash are untouched,
  // and setEnabled's afterMutate fires the {t:'skills'} frame for an open Skills panel.
  app.post<{ Params: { id: string }; Body: { enabled?: boolean; confirmName?: string } }>('/api/skills/:id/enabled', async (req, reply) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be a boolean' });
    const refusal = retypeRefusal(req.params.id, req.body);
    if (refusal) return reply.code(409).send({ error: refusal });
    try {
      const skill = skillStore.setEnabled(req.params.id, enabled);
      audit('skill.enabled', { id: skill.id, enabled });
      return skill;
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });
  // SPEC-SKILLS Phase 5b wave 2 — the operator's autonomy-clearance flip (the enabled-toggle clone
  // above). Session-token ONLY, and deliberately with NO assistant action or proposal kind for it:
  // clearing widens what reaches ungated skip-permissions execution, so the act must ORIGINATE with
  // the human — never even as a card the human clicks through. Flips ONLY autonomyCleared
  // (setAutonomyCleared: no version bump, no contentHash move, fires the {t:'skills'} frame); the flag
  // resets to uncleared on ANY content change (the store's hash-keyed reset), so what was cleared is
  // exactly what materializes. Sync check→write with no await between (the deleteWorkflow argument).
  app.post<{ Params: { id: string }; Body: { cleared?: boolean; confirmName?: string } }>('/api/skills/:id/autonomy-cleared', async (req, reply) => {
    const cleared = req.body?.cleared;
    if (typeof cleared !== 'boolean') return reply.code(400).send({ error: 'cleared must be a boolean' });
    if (!skillStore.get(req.params.id)) return reply.code(404).send({ error: 'unknown skill' });
    const refusal = retypeRefusal(req.params.id, req.body);
    if (refusal) return reply.code(409).send({ error: refusal });
    try {
      const skill = skillStore.setAutonomyCleared(req.params.id, cleared);
      audit('skill.autonomyCleared', { id: skill.id, cleared });
      return skill;
    } catch (e) {
      // The one reachable throw after the 404 check: a non-assistant origin (never gated, so never flagged).
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  // SPEC-SKILLS Phase 5b wave 2 — per-skill version history + rollback. Snapshots are written by the
  // store inside its stage-swap on every REAL content change (retention 20, oldest pruned); these
  // routes read them and restore one as a NORMAL forward upsert (append-only — the pre-rollback state
  // becomes a history entry itself; prose fully replaced, governance/invocation/assets patch-
  // preserved, clearance auto-drops on the content change). Session-token ONLY like every skills
  // route — nothing added to TOKEN_EXEMPT/ASSISTANT_ACCEPT: rollback re-publishes content, an
  // operator act, and there is deliberately no assistant action for it.
  app.get<{ Params: { id: string } }>('/api/skills/:id/history', async (req, reply) => {
    if (!skillStore.get(req.params.id)) return reply.code(404).send({ error: 'unknown skill' });
    return skillStore.listHistory(req.params.id);
  });
  app.get<{ Params: { id: string; version: string } }>('/api/skills/:id/history/:version', async (req, reply) => {
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) return reply.code(400).send({ error: 'bad history version' });
    if (!skillStore.get(req.params.id)) return reply.code(404).send({ error: 'unknown skill' });
    const entry = skillStore.getHistoryEntry(req.params.id, version);
    if (!entry) return reply.code(404).send({ error: 'unknown history version' });
    return entry;
  });
  app.post<{ Params: { id: string }; Body: { version?: number; confirmName?: string } }>('/api/skills/:id/rollback', async (req, reply) => {
    const version = req.body?.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      return reply.code(400).send({ error: 'version must be a positive integer' });
    }
    if (!skillStore.get(req.params.id)) return reply.code(404).send({ error: 'unknown skill' });
    const refusal = retypeRefusal(req.params.id, req.body);
    if (refusal) return reply.code(409).send({ error: refusal });
    // ONE history read for the whole rollback: the store's own getHistoryEntry probe is the single
    // read, and its unknown-version throw maps to 404 here — no route-side pre-probe duplicating it.
    try {
      const skill = skillStore.rollback(req.params.id, version); // sync — no await since the checks above
      audit('skill.rollback', { id: skill.id, fromVersion: version, toVersion: skill.version });
      return skill;
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(/unknown history version/.test(msg) ? 404 : 400).send({ error: msg });
    }
  });
  // SPEC-SKILLS Phase 5b — publish an assistant DRAFT into the library. Session-token ONLY:
  // deliberately absent from ASSISTANT_ACCEPT and TOKEN_EXEMPT, so the SCOPED assistant token and
  // terminal tokens cannot call it. The assistant CAN propose promote_skill, but that kind is carved
  // out of autoConfirm — only the operator's Confirm click executes it, and the confirmed proposal
  // reaches this route through the executor's session-token inject, never the scoped token.
  //
  // The handler is SYNCHRONOUS end-to-end — no await between ANY check and the upsert (the
  // deleteWorkflow single-writer argument above): a scoped-token draft save can never land in an
  // event-loop gap between confirm()'s sync drift check and this execution, because there is no gap.
  // Belts RE-DERIVE rather than trust enrich (the executor path re-enriched already, but a later
  // operator-UI caller won't have): the payload hash came from the PINNED action, so what executes
  // is byte-identical to what the card's diff showed.
  //
  // Enable state (SPEC-SKILLS Phase 5b wave 2 — what the wave-1 comment here reserved): a NEW skill
  // lands enabled:false EXPLICITLY (upsert's default is enabled:true, so the expression is
  // load-bearing) — with selection rule 4's fail-closed master switch, a freshly-published
  // LLM-authored body has structurally ZERO fan-out until the operator's second explicit act. An
  // UPDATE preserves the target's enable state: forcing disabled-on-update made every draft revision
  // demand a rubber-stamp re-enable click, while the operator just reviewed the exact body diff on an
  // always-confirm card and interactive agents keep their permission gate. Skip-permissions agents
  // are excluded either way: the content change drops any autonomy clearance in the SAME upsert (the
  // store's hash-keyed reset), so the updated body is interactive-only until the operator re-clears
  // it. The targetEnabled denorm pin voids the card if the operator flips enable between propose and
  // confirm.
  app.post<{ Body: { draftId?: string; contentHash?: string } }>('/api/skills/promote-draft', async (req, reply) => {
    const draftId = req.body?.draftId;
    const contentHash = req.body?.contentHash;
    if (typeof draftId !== 'string' || !isSafeName(draftId)) return reply.code(400).send({ error: 'draftId required' });
    if (typeof contentHash !== 'string' || contentHash === '') return reply.code(400).send({ error: 'contentHash required' });
    const d = skillDrafts.get(draftId);
    if (!d) return reply.code(404).send({ error: 'unknown draft' });
    if (d.status !== 'open') return reply.code(409).send({ error: 'draft already promoted — save a new draft' });
    // Hash belt: the payload hash is the propose-time pin, compared against a RECOMPUTE over the
    // live loaded fields — never the stored record hash, which a hand-edited pad file could keep
    // while changing the body underneath it.
    if (contentHash !== draftContentHash(d)) {
      return reply.code(409).send({ error: 'draft changed since confirm — re-propose' });
    }
    // Secret-scan belt (defense in depth): a save-path bug or a hand-edited skill-drafts.json must
    // not publish. Same class-names-only posture as the save route.
    const found = scanSecrets(skillDraftScanText(d));
    if (found.length > 0) {
      return reply.code(400).send({ error: `draft refused — secret-shaped content detected (${found.join(', ')})` });
    }
    // Target belt — the same rules as promote_skill's enrich, re-derived. The resolved target is held
    // for the enable expression at the upsert below (still sync — no await anywhere in between).
    const target = d.targetSkillId !== undefined ? skillStore.get(d.targetSkillId) : undefined;
    if (d.targetSkillId !== undefined) {
      if (!target) return reply.code(409).send({ error: `target skill '${d.targetSkillId}' no longer exists` });
      if (isProtectedSkill(target)) {
        return reply.code(409).send({ error: `skill '${d.targetSkillId}' is a protected gate and cannot be changed through the assistant` });
      }
      if (target.origin !== 'assistant') {
        return reply.code(409).send({ error: `skill '${d.targetSkillId}' is not assistant-authored — the assistant only updates skills it authored` });
      }
    } else {
      const slug = slugifySkillName(d.name);
      if (!isSafeName(slug) || isReservedSkillId(slug)) {
        return reply.code(400).send({ error: 'cannot derive a valid skill id from the draft name — rename the draft' });
      }
      if (skillStore.get(slug)) {
        return reply.code(409).send({ error: `a skill with id '${slug}' already exists — target it or rename the draft` });
      }
    }
    try {
      // The whitelist means gate/providerOverrides/toolHints/assets/protected are NEVER in this
      // input, so an update PRESERVES the target's existing invocation (patch semantics) and can
      // never add what a draft cannot carry. trigger/tags pass '' / [] when absent so the promote is
      // a full replace of the whitelisted fields — a stale target trigger must not survive a draft
      // that dropped it (rendered == executed). origin is create-honored / patch-ignored, so passing
      // it is correct for both paths. scope rides ONLY the create path: upsert REPLACES a provided
      // scope, a draft cannot carry scope, and the card's diff shows body only — so an update
      // passing scope would silently widen an operator-narrowed scope:'project' target back to
      // global behind the review. An update omits it and the target's scope is preserved.
      const skill = skillStore.upsert({
        ...(d.targetSkillId !== undefined ? { id: d.targetSkillId } : { scope: 'global' }),
        name: d.name,
        description: d.description,
        body: d.body,
        trigger: d.trigger ?? '',
        tags: d.tags ?? [],
        origin: 'assistant',
        enabled: target ? target.enabled : false, // see the enable-state comment above the route
      });
      skillDrafts.markPromoted(draftId);
      // Gate-sabotage lint (SPEC-SKILLS Phase 5b wave 2): pattern-CLASS names onto the audit line for
      // post-hoc operator forensics — never the matched text, and NEVER the response body (the route's
      // output replays into the brain's transcript via the proposal result, and the lint verdict must
      // not coach an adversarial drafter). The operator saw these same flags rendered on the confirm
      // card, computed client-side from the draft the card already fetches. A flag never blocks —
      // the operator's read of the diff is the boundary; this is a highlighter over it.
      const lintFlags = lintGateSabotage(skillDraftScanText(d)).map((f) => f.cls);
      audit('skill.promote', {
        draftId,
        skillId: skill.id,
        version: skill.version,
        ...(lintFlags.length ? { lintFlags } : {}),
      });
      return skill;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  // The one-time importer — operator-triggered (session-token), reads the operator's real ~/.claude/skills
  // READ-ONLY and copies each skill into the store. Idempotent (skip-existing); per-skill parse failures
  // ride the report, never a thrown 500. The fixed default dir means zero caller-supplied path.
  app.post('/api/skills/import', async () => {
    const report = importSkillsFromDir(join(homedir(), '.claude', 'skills'), skillStore);
    audit('skills.import', {
      imported: report.imported.length,
      skipped: report.skipped.length,
      errors: report.errors.length,
    });
    return report;
  });

  // ---- skill bundles — named, reusable skill sets a project can select (SPEC-SKILLS Phase 3) ----
  // Session-token-only like the /api/skills routes above. Ids are client-minted; upsert is PUT-to-id
  // create-or-replace (the workflows idiom). DELETE refuses with 409 (naming the referencing projects)
  // while any project selects the bundle. Audit lines carry ids only (the counts-not-contents posture).
  app.get('/api/skill-bundles', async () => skillSelection.listBundles());
  app.post<{ Body: { name?: string; description?: string; skillIds?: string[] } }>(
    '/api/skill-bundles',
    async (req, reply) => {
      try {
        const body = req.body ?? {};
        const bundle = skillSelection.upsertBundle({ name: body.name, description: body.description, skillIds: body.skillIds });
        audit('skill.bundle.set', { bundleId: bundle.id });
        mission.emitSkills();
        return bundle;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );
  // SPEC-SKILLS Phase 5b wave 2 — the selection-side retype gate on bundle edits: a member removal
  // rewrites the effective set of EVERY project selecting this bundle, so if a protected skill would
  // leave any of them, demand the same retype confirmName as the project-skills gate (the dropped
  // protected names, name-sorted, ', '-joined — the 409 spells the exact string out and names the
  // affected projects, capped at five, honestly). Computed over the SANITIZED member list (what
  // upsertBundle would persist — an omitted skillIds IS the empty-the-bundle replace) with no await
  // before the write. POST above always mints a fresh id no project selects yet, so only this PUT can
  // rewrite a selected bundle. confirmName is wire-only — upsertBundle receives fields one by one.
  app.put<{ Params: { id: string }; Body: { name?: string; description?: string; skillIds?: string[]; confirmName?: string } }>(
    '/api/skill-bundles/:id',
    async (req, reply) => {
      try {
        const body = req.body ?? {};
        const gate = skillSelection.bundleReplaceDelta(
          skillStore.list(), req.params.id, body.skillIds, (pid) => store.getProject(pid)?.name,
        );
        if (gate.droppedProtected.length) {
          const expected = gate.droppedProtected.join(', ');
          if (body.confirmName !== expected) {
            const shown =
              gate.affectedProjects.slice(0, 5).map((n) => `"${n}"`).join(', ') +
              (gate.affectedProjects.length > 5 ? ` and ${gate.affectedProjects.length - 5} more` : '');
            return reply.code(409).send({
              error:
                `this edit removes protected skill(s) ${gate.droppedProtected.map((n) => `"${n}"`).join(', ')} ` +
                `from the effective set of project(s) ${shown} — retype '${expected}' exactly to confirm`,
              droppedProtected: gate.droppedProtected,
              affectedProjects: gate.affectedProjects,
            });
          }
        }
        const bundle = skillSelection.upsertBundle({
          id: req.params.id,
          name: body.name,
          description: body.description,
          skillIds: body.skillIds,
        });
        audit('skill.bundle.set', { bundleId: bundle.id });
        mission.emitSkills();
        return bundle;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/api/skill-bundles/:id', async (req, reply) => {
    try {
      // Reference-check + delete inside ONE synchronous store method (the deleteWorkflow discipline).
      const removed = skillSelection.deleteBundle(req.params.id, (pid) => store.getProject(pid)?.name);
      audit('skill.bundle.delete', { bundleId: req.params.id, removed });
      if (removed) mission.emitSkills();
      return { ok: true };
    } catch (e) {
      if (e instanceof BundleReferencedError) {
        return reply.code(409).send({ error: e.message, referencedBy: e.referencedBy });
      }
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ---- backlog: stored pre-execution lanes (SPEC-BACKLOG §5) ----
  // Cross-project by design — the Board is a single fleet-wide pane. The STORE owns the lifecycle
  // guards (create refuses smuggled ids + born-archived; transition owns the lane rules), so these
  // routes are thin adapters: TaskGuardError → 409 on PUT (a legal request in an illegal state),
  // anything else (zod: blank title) → 400.
  app.get('/api/backlog', async () => backlogStore.list());
  app.post('/api/backlog', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as CreateTaskRequest;
      if (body.projectId && !store.getProject(body.projectId)) {
        return reply.code(400).send({ error: 'unknown projectId' });
      }
      return backlogStore.create(body);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.put<{ Params: { id: string }; Body: { title?: string; body?: string; priority?: 0 | 1 | 2 | 3 | null; status?: TaskStatus } }>(
    '/api/backlog/:id',
    async (req, reply) => {
      if (!backlogStore.get(req.params.id)) return reply.code(404).send({ error: 'unknown task' });
      try {
        return backlogStore.transition(req.params.id, req.body ?? {});
      } catch (e) {
        const code = e instanceof TaskGuardError ? 409 : 400;
        return reply.code(code).send({ error: (e as Error).message });
      }
    },
  );

  // ---- archive for finished execution records (SPEC-BACKLOG §3) ----
  // Unknown id → 404 (gone is not a conflict); a guard refusal (still-live record) → 409.
  app.post<{ Params: { id: string } }>('/api/loops/:id/archive', async (req, reply) => {
    if (!loops.get(req.params.id)) return reply.code(404).send({ error: 'unknown loop' });
    try { return loops.archive(req.params.id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.post<{ Params: { id: string } }>('/api/missions/:id/archive', async (req, reply) => {
    if (!missions.get(req.params.id)) return reply.code(404).send({ error: 'unknown mission' });
    try { return missions.archive(req.params.id); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  // Bulk sweep: FINISHED records only — landed/stopped/failed loops, done/failed missions. Never
  // swept: draft missions, done-unlanded loops (live Review & Land candidates), and landed SORTIE
  // loops of a still-active mission — archiving those would hide live sortie cards out from under
  // an in-flight mission's board view. Per-record writes/frames are accepted at v1 scale; a
  // store-level bulk (one persist, one coalesced frame) is the upgrade path if sweeps grow.
  app.post('/api/board/clear-finished', async () => {
    const activeMissions = new Set(
      missions.list().filter((m) => m.status !== 'done' && m.status !== 'failed').map((m) => m.id),
    );
    let nLoops = 0;
    let nMissions = 0;
    for (const l of loops.list()) {
      if (l.archivedAt) continue;
      if (l.missionId && activeMissions.has(l.missionId)) continue;
      if (l.landedAt || l.status === 'stopped' || l.status === 'failed') {
        try { loops.archive(l.id); nLoops++; } catch { /* raced a state change — skip honestly */ }
      }
    }
    for (const m of missions.list()) {
      if (m.archivedAt) continue;
      if (m.status === 'done' || m.status === 'failed') {
        try { missions.archive(m.id); nMissions++; } catch { /* raced — skip */ }
      }
    }
    return { loops: nLoops, missions: nMissions };
  });

  // ---- coordination: mail, memory, log search (session-authed, HumanOverseer) ----
  app.get<{ Params: { id: string } }>('/api/mail/:id', async (req, reply) => {
    try {
      return mail.inbox(req.params.id);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.post<{ Body: { toTerminalId?: string; body?: string } }>('/api/mail', async (req, reply) => {
    const { toTerminalId, body } = req.body ?? {};
    if (!toTerminalId || !body) return reply.code(400).send({ error: 'toTerminalId and body required' });
    if (!store.getTerminal(toTerminalId)) return reply.code(404).send({ error: 'unknown terminal' });
    const msg = mail.send(toTerminalId, 'human', 'HumanOverseer', body);
    mission.emitMailSent('human', toTerminalId, store.getTerminal(toTerminalId)?.title);
    audit('mail.send', { to: toTerminalId, from: 'human' });
    return msg;
  });
  app.post<{ Params: { id: string } }>('/api/mail/:id/read', async (req, reply) => {
    try {
      mail.markAllRead(req.params.id);
      mission.clearNudge(req.params.id); // reset high-water mark so later mail nudges again
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // SPEC-MEMORY — map a memory store/facade error to its HTTP shape. A stale write/edit returns 409 with
  // the CURRENT state so the caller can merge and resend (never a silent clobber); a policy refusal is 422;
  // an unknown id 404; a bad project id 400. Returns null for anything else (an unexpected server fault).
  const memErr = (e: unknown): { code: number; body: unknown } | null => {
    if (e instanceof StaleViewError) return { code: 409, body: { error: 'stale', current: e.current } };
    if (e instanceof StaleRevError) return { code: 409, body: { error: 'stale', current: e.current } };
    if (e instanceof DisputedSourceError || e instanceof ForeignVersionError) return { code: 409, body: { error: e.message } };
    if (
      e instanceof RequestConflictError ||
      e instanceof CapError ||
      e instanceof TransitionError ||
      e instanceof OwnershipError ||
      e instanceof EvidencePermissionError ||
      e instanceof CycleError ||
      // Defense-in-depth: over HTTP the zod superRefine refuses a reserved-syntax body first (400 with the
      // message below), so this store-level guard is unreachable here today — but mapping it means any future
      // path that reaches the store directly refuses cleanly (422) instead of falling through to a 500.
      e instanceof ReservedSyntaxError
    )
      return { code: 422, body: { error: e.message } };
    if (e instanceof MemNotFoundError) return { code: 404, body: { error: e.message } };
    if ((e as Error).message === INVALID_PROJECT_ID) return { code: 400, body: { error: 'bad project id' } };
    return null;
  };
  // Surface the first schema issue so a client whose body carried reserved memory-view syntax (or otherwise
  // failed validation) learns the reason and can self-correct, rather than a blind 'invalid request'. The
  // messages are policy text (e.g. "body may not contain reserved memory-view syntax"), never server paths.
  const parseMsg = (issues: { message: string }[], fallback: string): string => issues[0]?.message ?? fallback;

  app.get<{ Params: { id: string } }>('/api/memory/:id', async (req) => memory.all(req.params.id));
  // SPEC-FLIGHTLINE-V2 §4 — per-file freshness metadata (fs.stat only; no content/secrets) for the
  // MemoryBar recency dot. Read-only; session-token by default (NOT in TOKEN_EXEMPT, and outside auth.ts's
  // default-deny ASSISTANT_ACCEPT), so the scoped assistant token can't read it. The content route above is
  // untouched (its Record<name,content> shape is load-bearing for MemoryPanel). PUT is verb-disjoint from GET.
  app.get<{ Params: { id: string } }>('/api/memory/:id/meta', async (req, reply) => {
    try {
      return memory.meta(req.params.id);
    } catch (e) {
      // A client-caused error (bad / unknown project id) takes its usual HTTP shape via memErr. Never echo
      // anything else — an mkdirSync EACCES/ENOSPC embeds absolute server paths — that is a server fault.
      const m = memErr(e);
      if (m) return reply.code(m.code).send(m.body);
      return reply.code(500).send({ error: 'memory meta unavailable' });
    }
  });
  app.put<{ Params: { id: string; file: string }; Body: { content?: string } }>(
    '/api/memory/:id/:file',
    async (req, reply) => {
      try {
        // The operator editor's whole-file save — attributed to the operator principal, revision-checked
        // via the view header hash (a stale save → 409 with the current view, never a silent clobber).
        memory.write(req.params.id, req.params.file, String(req.body?.content ?? ''), { kind: 'operator' });
        return { ok: true };
      } catch (e) {
        const m = memErr(e);
        if (m) return reply.code(m.code).send(m.body);
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );
  app.get('/api/memory-files', async () => MEMORY_FILES);

  // SPEC-MEMORY — entry-level OPERATOR routes (session-token; the mutating ones are NOT in
  // ASSISTANT_ACCEPT, so the scoped assistant token can read entries but never write them). The store's
  // transition table gates status changes by principal — here the operator, who alone may verify.
  const coerceSearch = (q: { q?: string; kind?: string; lifecycle?: string; verification?: string; sinceSeq?: string }): MemorySearchQuery => ({
    ...(q.q ? { q: q.q } : {}),
    ...(q.kind ? { kind: q.kind as MemoryKind } : {}),
    ...(q.lifecycle ? { lifecycle: q.lifecycle as MemoryLifecycle } : {}),
    ...(q.verification ? { verification: q.verification as MemoryVerification } : {}),
    ...(q.sinceSeq !== undefined && Number.isFinite(Number(q.sinceSeq)) ? { sinceSeq: Number(q.sinceSeq) } : {}),
  });
  app.get<{ Params: { id: string }; Querystring: { q?: string; kind?: string; lifecycle?: string; verification?: string; sinceSeq?: string } }>(
    '/api/memory/:id/entries',
    async (req, reply) => {
      try {
        return memoryStore.search(req.params.id, coerceSearch(req.query));
      } catch (e) {
        const m = memErr(e);
        if (m) return reply.code(m.code).send(m.body);
        throw e;
      }
    },
  );
  app.post<{ Params: { id: string }; Body: unknown }>('/api/memory/:id/entries', async (req, reply) => {
    const parsed = memoryAddRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parseMsg(parsed.error.issues, 'invalid add request') });
    try {
      const entry = memoryStore.add(req.params.id, { kind: 'operator' }, parsed.data);
      return reply.code(201).send(entry);
    } catch (e) {
      const m = memErr(e);
      if (m) return reply.code(m.code).send(m.body);
      throw e;
    }
  });
  app.post<{ Params: { id: string; eid: string }; Body: Record<string, unknown> }>('/api/memory/:id/entries/:eid', async (req, reply) => {
    const parsed = memoryUpdateRequestSchema.safeParse({ ...(req.body ?? {}), id: req.params.eid });
    if (!parsed.success) return reply.code(400).send({ error: parseMsg(parsed.error.issues, 'invalid update request') });
    try {
      return memoryStore.update(req.params.id, { kind: 'operator' }, parsed.data);
    } catch (e) {
      const m = memErr(e);
      if (m) return reply.code(m.code).send(m.body);
      throw e;
    }
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/memory/:id/consolidate', async (req, reply) => {
    const parsed = memoryConsolidateRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parseMsg(parsed.error.issues, 'invalid consolidate request') });
    try {
      return memoryStore.consolidate(req.params.id, { kind: 'operator' }, parsed.data);
    } catch (e) {
      const m = memErr(e);
      if (m) return reply.code(m.code).send(m.body);
      throw e;
    }
  });
  app.post<{ Params: { id: string; eid: string }; Body: { rev?: number } }>('/api/memory/:id/unconsolidate/:eid', async (req, reply) => {
    const rev = Number(req.body?.rev);
    if (!Number.isFinite(rev)) return reply.code(400).send({ error: 'rev required' });
    try {
      memoryStore.unconsolidate(req.params.id, { kind: 'operator' }, req.params.eid, rev);
      return { ok: true };
    } catch (e) {
      const m = memErr(e);
      if (m) return reply.code(m.code).send(m.body);
      throw e;
    }
  });

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => searchLogs(req.query.q ?? ''));

  // ---- coordination: agent endpoints (per-terminal token, for towerctl) ----
  const agentTerminal = (req: { headers: Record<string, unknown> }): string | undefined => {
    const t = req.headers['x-tower-terminal-token'];
    return typeof t === 'string' ? hookTokens.resolve(t) : undefined;
  };
  // SPEC-LOOP W7 — the newest LIVE loop a terminal drives that carries a mission backref (the
  // token/terminal→loop step of a routed sortie's ownership derivation AND the onParsed deferral's
  // owning-loop lookup — the ONE parameterized helper for both). Uses the missions loop-lookup idiom
  // verbatim (the !isTerminalLoop filter + createdAt-desc sort); `requireSortie` additionally demands a
  // sortie backref (the triage route, which needs the sortie pin). A miss returns undefined so every
  // caller can fail safe.
  const liveLoopForTerminal = (tid: string, requireSortie = false): Loop | undefined =>
    loops
      .list()
      .filter((l) => l.terminalId === tid && !isTerminalLoop(l.status) && !!l.missionId && (!requireSortie || !!l.sortieId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  // SPEC-MEMORY — the memory PRINCIPAL for an agent terminal: the newest live loop it drives (NO missionId
  // filter — a standalone loop counts too) supplies the run context; with no live loop it's a bare agent
  // principal (its entries default to project scope). Authorization for status changes keys on THIS
  // principal, never on a request-body field, so an agent cannot claim to be the operator.
  const principalForTerminal = (tid: string): MemoryPrincipal => {
    const l = loops
      .list()
      .filter((x) => x.terminalId === tid && !isTerminalLoop(x.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (l) return { kind: 'agent', terminalId: tid, loopId: l.id, ...(l.missionId ? { missionId: l.missionId } : {}), ...(l.sortieId ? { sortieId: l.sortieId } : {}) };
    return { kind: 'agent', terminalId: tid };
  };
  // SPEC-RUNWAY — the statusLine usage forwarder's sink (ct-usage). Terminal-token gated; resolves the
  // account token→terminal→configDir→accountUuid and records the parsed rate_limits (a pure UsageStore
  // write, zero LLM/network). Always 202s — an unattributable dir (no accountUuid) or an absent
  // rate_limits is a benign no-op, so the 60s forwarder never retries or logs noise. Never touches the
  // OAuth token or an Anthropic endpoint (vendor-binary-only posture).
  app.post('/api/agent/usage', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const term = store.getTerminal(tid);
    if (!term || term.provider !== 'claude-code') return reply.code(202).send({ ok: true });
    // SPEC-RUNWAY — skip a sample during a rotation: the record's profileId has flipped to the target
    // but the OLD process may still be alive for a tmux tick, so a stray sample could be attributed to
    // the wrong account. A dropped 60s sample is harmless (the next tick re-reports).
    if (term.rotatingFrom) return reply.code(202).send({ ok: true });
    const parsed = parseStatusLinePayload(req.body);
    if (!parsed || !parsed.available) return reply.code(202).send({ ok: true }); // not a subscription / no rate_limits yet
    const configDir = liveConfigDirFor(term, accounts.getProfile.bind(accounts), 'claude-code');
    const accountUuid = configDir ? accountIdentityFor(configDir)?.accountUuid : undefined;
    if (accountUuid) {
      usageStore.record(accountUuid, { windows: parsed.windows, terminalId: tid, ...(parsed.model ? { model: parsed.model } : {}) });
    }
    reply.code(202).send({ ok: true });
    // SPEC-RUNWAY live-swap -- reactive mid-turn trigger: DETACHED (never delays the 202) and debounced inside
    // the trigger. Inert unless Runway + live-swap are on, the pane is slotted, and its account is over threshold.
    if (accountUuid) void liveSwapTrigger?.fire(tid);
    return reply;
  });
  app.post<{ Body: { to?: string; body?: string } }>('/api/agent/mail/send', async (req, reply) => {
    const from = agentTerminal(req);
    if (!from) return reply.code(401).send({ error: 'bad terminal token' });
    const { to, body } = req.body ?? {};
    if (!to || !body) return reply.code(400).send({ error: 'to and body required' });
    // Recipient MUST be a real terminal id. Without this, `to` (an untrusted agent
    // arg) flows into mkdirSync(join(MAIL_ROOT, to)) — a path-traversal arbitrary
    // directory/file write — and a mistyped id would silently drop the message.
    if (!store.getTerminal(to)) return reply.code(404).send({ error: 'unknown recipient terminal' });
    const fromTerm = store.getTerminal(from);
    mail.send(to, from, fromTerm?.title ?? from, body);
    mission.emitMailSent(from, to, store.getTerminal(to)?.title);
    return { ok: true };
  });
  app.get('/api/agent/mail/inbox', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const msgs = mail.inbox(tid);
    mail.markAllRead(tid);
    mission.clearNudge(tid); // reset high-water mark so later mail nudges again
    // SPEC-PLANNER §4 — reading the inbox is one of the two 'delivered' evidence sites (the pending route
    // is the other, stronger, one): a pointer the planner has now seen. Stamp every one of ITS OWN open,
    // still-pending consults delivered so the answer clock starts. Scoped by terminalId (never the body).
    let deliveredAny = false;
    for (const c of consultStore.listOpen()) {
      if (c.terminalId === tid && c.status === 'pending' && consultStore.markDelivered(c.id)) deliveredAny = true;
    }
    if (deliveredAny) mission.emitConsults();
    return msgs;
  });
  app.get<{ Querystring: { file?: string } }>('/api/agent/memory', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const term = store.getTerminal(tid);
    if (!term) return reply.code(404).send({ error: 'unknown terminal' });
    try {
      return req.query.file ? { [req.query.file]: memory.read(term.projectId, req.query.file) } : memory.all(term.projectId);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  // SPEC-MEMORY — entry-level AGENT routes (per-terminal token; each STATIC path is in TOKEN_EXEMPT). The
  // project + principal are derived token→terminal server-side; the store's transition table refuses an
  // agent's attempt to set verification='verified' or to retract an entry it did not author, regardless of
  // what the body claims. `resolveAgentMem` sends the 401/404 and returns null so the route bails.
  const resolveAgentMem = (
    req: { headers: Record<string, unknown> },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): { pid: string; principal: MemoryPrincipal } | null => {
    const tid = agentTerminal(req);
    if (!tid) {
      reply.code(401).send({ error: 'bad terminal token' });
      return null;
    }
    const term = store.getTerminal(tid);
    if (!term) {
      reply.code(404).send({ error: 'unknown terminal' });
      return null;
    }
    return { pid: term.projectId, principal: principalForTerminal(tid) };
  };
  app.get<{ Querystring: { q?: string; kind?: string; lifecycle?: string; verification?: string; sinceSeq?: string } }>('/api/agent/memory/entries', async (req, reply) => {
    const ctx = resolveAgentMem(req, reply);
    if (!ctx) return reply;
    try {
      return memoryStore.search(ctx.pid, coerceSearch(req.query));
    } catch (e) {
      const m = memErr(e);
      if (m) return reply.code(m.code).send(m.body);
      throw e;
    }
  });
  app.post<{ Body: unknown }>('/api/agent/memory/entries', async (req, reply) => {
    const ctx = resolveAgentMem(req, reply);
    if (!ctx) return reply;
    const parsed = memoryAddRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parseMsg(parsed.error.issues, 'invalid add request') });
    try {
      const entry = memoryStore.add(ctx.pid, ctx.principal, parsed.data);
      return reply.code(201).send(entry);
    } catch (e) {
      const m = memErr(e);
      if (m) return reply.code(m.code).send(m.body);
      throw e;
    }
  });
  app.post<{ Body: unknown }>('/api/agent/memory/update', async (req, reply) => {
    const ctx = resolveAgentMem(req, reply);
    if (!ctx) return reply;
    const parsed = memoryUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parseMsg(parsed.error.issues, 'invalid update request') });
    try {
      return memoryStore.update(ctx.pid, ctx.principal, parsed.data);
    } catch (e) {
      const m = memErr(e);
      if (m) return reply.code(m.code).send(m.body);
      throw e;
    }
  });
  app.post<{ Body: unknown }>('/api/agent/memory/consolidate', async (req, reply) => {
    const ctx = resolveAgentMem(req, reply);
    if (!ctx) return reply;
    const parsed = memoryConsolidateRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parseMsg(parsed.error.issues, 'invalid consolidate request') });
    try {
      return memoryStore.consolidate(ctx.pid, ctx.principal, parsed.data);
    } catch (e) {
      const m = memErr(e);
      if (m) return reply.code(m.code).send(m.body);
      throw e;
    }
  });
  app.post<{ Body: { id?: string; rev?: number } }>('/api/agent/memory/unconsolidate', async (req, reply) => {
    const ctx = resolveAgentMem(req, reply);
    if (!ctx) return reply;
    const id = req.body?.id;
    const rev = Number(req.body?.rev);
    if (typeof id !== 'string' || !Number.isFinite(rev)) return reply.code(400).send({ error: 'id and rev required' });
    try {
      memoryStore.unconsolidate(ctx.pid, ctx.principal, id, rev);
      return { ok: true };
    } catch (e) {
      const m = memErr(e);
      if (m) return reply.code(m.code).send(m.body);
      throw e;
    }
  });
  // SPEC-MEMORY — the agent's progress note (`towerctl note`): an operator-facing status line recorded
  // onto the CURRENT iteration of the newest live loop this terminal drives (the principalForTerminal
  // derivation — never a body field). A terminal with no live loop gets a 202 and an audit line: the
  // note has nowhere to live, and a hook-driven caller must not retry or log noise. Never fed back into
  // any prompt or decision (loops.progress owns that guarantee); counts only in the audit.
  app.post<{ Body: { body?: string } }>('/api/agent/note', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    if (!store.getTerminal(tid)) return reply.code(404).send({ error: 'unknown terminal' });
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return reply.code(400).send({ error: 'body required' });
    const principal = principalForTerminal(tid);
    const loopId = principal.kind === 'agent' ? principal.loopId : undefined;
    if (!loopId) {
      audit('agent.note.unbound', { terminalId: tid, bytes: Buffer.byteLength(body, 'utf8') });
      return reply.code(202).send({ ok: true, recorded: false });
    }
    const { n } = loops.progress(loopId, body);
    audit('agent.note', { terminalId: tid, loopId, n, bytes: Buffer.byteLength(body, 'utf8') });
    return { ok: true, recorded: true, loopId, n };
  });

  // ---- test kit ----
  app.get('/api/testruns', async () => testkit.listRuns());
  app.get('/api/test/capacity', async () => ({ capacity: testkit.capacity(), active: testkit.activeCount() }));
  app.post('/api/agent/test/acquire', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const term = store.getTerminal(tid);
    if (!term) return reply.code(404).send({ error: 'unknown terminal' });
    // Pass the RUNNING TREE root as the parse join-key base: the agent runs in its worktree, so
    // specFile keys must be worktree-relative (e.g. tests/smoke.spec.ts). Fall back to the project
    // repo, then the terminal cwd, so a rare missing project can't drop the third arg.
    const repoPath = term.worktreePath ?? store.getProject(term.projectId)?.repoPath ?? term.cwd;
    const run = await testkit.acquire(tid, term.projectId, repoPath);
    if (!run) return reply.code(503).send({ error: 'test-kit at capacity — queue and retry', capacity: testkit.capacity() });
    audit('test.acquire', { runId: run.id, terminalId: tid, port: run.port });
    // SPEC-TESTING §4 — ride the project's configured suite command so `towerctl test run` defaults to it.
    const suiteCommand = testingStore.get(term.projectId)?.suiteCommand;
    return suiteCommand ? { ...run, suiteCommand } : run;
  });
  app.post<{ Body: { runId?: string; status?: 'passed' | 'failed' } }>('/api/agent/test/release', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    if (!req.body?.runId) return reply.code(400).send({ error: 'runId required' });
    // SPEC-TESTING §6 — only the owning terminal may release its run; byte-identical 404 for an
    // unknown or foreign run (no ownership oracle). release() is itself idempotent on a finished run.
    const owned = testkit.getRun(req.body.runId);
    if (!owned || owned.terminalId !== tid) return reply.code(404).send({ error: 'unknown run' });
    testkit.release(req.body.runId, req.body.status === 'passed' ? 'passed' : 'failed');
    audit('test.release', { runId: req.body.runId, status: req.body.status });
    return { ok: true };
  });
  // SPEC-LOOP W7 — the routed investigator submits its false-fail classifications here. Ownership is
  // derived ENTIRELY token→terminal→loop→sortie.investigateFromRun (NEVER the body — it carries only
  // `entries`); the investigator's terminal is NOT the runner that acquired the run, so release's
  // `run.terminalId === tid` check does NOT apply. EVERY derivation miss returns the byte-identical 404
  // release uses (no ownership oracle). TOKEN_EXEMPT + agentTerminal-guarded, spends zero LLM/network,
  // and deliberately NOT in ASSISTANT_ACCEPT (Jarvis must not submit triage — mirrors summarize's stance).
  app.post<{ Body: { entries?: unknown } }>('/api/agent/test/triage', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const notFound = { error: 'unknown run' };
    const loop = liveLoopForTerminal(tid, true);
    if (!loop || !loop.missionId || !loop.sortieId) return reply.code(404).send(notFound);
    const mission = missions.get(loop.missionId);
    if (!mission) return reply.code(404).send(notFound);
    // Find the caller's sortie and its investigateFromRun pin — the run it was assigned to classify.
    let runId: string | undefined;
    for (const phase of mission.phases) {
      const sortie = phase.sorties.find((s) => s.id === loop.sortieId);
      if (sortie) { runId = sortie.investigateFromRun; break; }
    }
    if (!runId) return reply.code(404).send(notFound); // not an investigate sortie / not yet finalized
    const run = testkit.getRun(runId);
    if (!run) return reply.code(404).send(notFound); // charset-failing / gone
    // Write-once: an already-triaged run returns IDEMPOTENT success (the stored triage UNCHANGED — setTriage
    // is not called, so no reclassification), NOT a 409. A retried investigator re-running its task then
    // completes cleanly instead of crash-looping on a 409; ownership derivation ties the run to this
    // caller's sortie pin, so only the owning investigator can ever reach here.
    if (run.triage !== undefined) {
      return { ok: true, runId, ...triageCounts(run.results ?? [], run.triage), alreadyTriaged: true };
    }
    // Validate against the run's ACTUAL failure keys BEFORE setTriage (same clean the store applies), and
    // 400 when zero survive — so a garbage submission can never burn the write-once slot with triage=[].
    const cleaned = cleanTriageEntries(req.body?.entries, new Set((run.results ?? []).map(triageKey)));
    if (cleaned.length === 0) {
      return reply.code(400).send({ error: 'no valid triage entries — each needs {specFile, testTitle, class: real|by-design|false} matching a real failure' });
    }
    testkit.setTriage(runId, cleaned);
    const after = testkit.getRun(runId)!; // re-read: counts come from the PERSISTED cleaned triage, never the body
    const counts = triageCounts(after.results ?? [], after.triage);
    audit('test.triage', { runId, terminalId: tid, ...counts });
    // Complete the deferred auto-file with the now-known real-only failures (the shared auto-file path;
    // the onParsed hook deferred this run when the mission had investigate on). Idempotent via autoFiled.
    autoFileReal(after);
    return { ok: true, runId, ...counts };
  });
  // SPEC-TESTING §5 — file a run's failures to the backlog on demand (works on gate runs too). This is the
  // MANUAL operator action, so it is triage-BLIND (files every failing spec, no `realOnly`): W7 triage
  // suppression applies ONLY to the automatic path (autoFileReal), never to an explicit operator file.
  app.post<{ Params: { id: string } }>('/api/testruns/:id/file-failures', async (req, reply) => {
    const run = testkit.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'unknown run' });
    if (run.results === undefined) return reply.code(409).send({ error: 'run has no parsed results' });
    try {
      const out = fileFailuresAsTasks(run, backlogStore); // triage-blind (no realOnly) — files all
      audit('test.file-failures', { runId: run.id, ...out });
      return out;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });
  // SPEC-TESTING-V2 §1 — on-demand LLM triage digest of a run's failures. Session-token ONLY (NOT
  // TOKEN_EXEMPT/ASSISTANT_ACCEPT — LLM spend is operator-only). Idempotent-return an existing summary
  // BEFORE acquiring the single-flight key unless the caller passes {force:true} to regenerate (the
  // "Re-summarize" button); the in-memory Set 409s a concurrent 2nd caller and is released in finally
  // (a crash clears it — no permanent 409). Display-only (never fed to fixers).
  const summarizingRuns = new Set<string>();
  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/api/testruns/:id/summarize', async (req, reply) => {
    const run = testkit.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'unknown run' });
    if (run.results === undefined || !run.failed) {
      return reply.code(409).send({ error: 'run has no parsed failures to triage' });
    }
    const force = (req.body as { force?: boolean } | undefined)?.force === true;
    if (run.summary && !force) return { summary: run.summary }; // idempotent — no key, no LLM spend
    if (!validator.available().ok) {
      return reply.code(503).send({ error: validator.available().reason ?? 'no assistant brain configured' });
    }
    if (summarizingRuns.has(run.id)) return reply.code(409).send({ error: 'a summary is already in flight' });
    summarizingRuns.add(run.id);
    const ac = new AbortController();
    req.raw.on('close', () => ac.abort());
    try {
      const project = store.getProject(run.projectId);
      const summary = await validator.summarizeFailures(project?.repoPath ?? repoRoot, run, ac.signal);
      testkit.setSummary(run.id, summary);
      audit('test.summarize', { runId: run.id });
      return { summary };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    } finally {
      summarizingRuns.delete(run.id);
    }
  });
  // SPEC-TESTING §6 — serve a copied artifact under the run's artifacts dir (session-token; contained
  // via resolveContained; O_NONBLOCK+fstat rejects a non-regular file; byte-identical 404, no oracle).
  app.get<{ Params: { id: string; name: string } }>('/api/testruns/:id/artifacts/:name', async (req, reply) => {
    const run = testkit.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    let fh: Awaited<ReturnType<typeof fsOpen>>;
    try {
      const rc = resolveContained(join(run.runDir, 'artifacts'), req.params.name);
      fh = await fsOpen(rc.real, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        await fh.close();
        return reply.code(404).send({ error: 'not found' });
      }
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      // The artifact name is report-controlled: strip quote/backslash/control chars so it can
      // neither break out of the quoted filename nor inject CR/LF into the header.
      const safeName = basename(req.params.name).replace(/["\\\r\n\x00-\x1f]/g, '_');
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      return reply.send(fh.createReadStream(st.size > 0 ? { end: st.size - 1 } : {}));
    } catch {
      await fh.close();
      return reply.code(404).send({ error: 'not found' });
    }
  });
  // SPEC-LOOP W5 — serve a captured log under the run's logs dir. IDENTICAL guard to the artifacts
  // route: SESSION-TOKEN ONLY (never TOKEN_EXEMPT, never ASSISTANT_ACCEPT — log contents carry
  // secrets), contained via resolveContained (a `../` escape 404s, not 403 — no oracle), O_NONBLOCK+
  // fstat rejects a non-regular file, and the name is stripped before it rides Content-Disposition.
  app.get<{ Params: { id: string; name: string } }>('/api/testruns/:id/logs/:name', async (req, reply) => {
    const run = testkit.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    let fh: Awaited<ReturnType<typeof fsOpen>>;
    try {
      const rc = resolveContained(join(run.runDir, 'logs'), req.params.name);
      fh = await fsOpen(rc.real, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        await fh.close();
        return reply.code(404).send({ error: 'not found' });
      }
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      const safeName = basename(req.params.name).replace(/["\\\r\n\x00-\x1f]/g, '_');
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      return reply.send(fh.createReadStream(st.size > 0 ? { end: st.size - 1 } : {}));
    } catch {
      await fh.close();
      return reply.code(404).send({ error: 'not found' });
    }
  });
  // SPEC-TESTING §6 — the calling terminal's latest run, trimmed. Derives the terminal from the
  // token, takes NO id param, NOT in ASSISTANT_ACCEPT. How a fixer/documentor reads structured results.
  app.get('/api/agent/test/latest', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const run = testkit.latestFor(tid);
    if (!run) return { id: null };
    return {
      id: run.id,
      status: run.status,
      total: run.total,
      failed: run.failed,
      results: run.results?.map((f) => ({
        specFile: f.specFile,
        testTitle: f.testTitle,
        errorTail: f.errorTail,
        artifacts: f.artifacts,
      })),
    };
  });

  // ---- SPEC-LOOP W6: the routed code reviewer's structured findings (per-terminal token) ----
  // Ownership is derived EXCLUSIVELY token→terminal→loop→(mission,sortie) — the request body carries
  // only finding CONTENT, never ids. EVERY miss (no owning loop / no mission / the sortie is not
  // review-marked) returns ONE byte-identical 404 so the route is no ownership oracle. The reviewer is
  // routed as role 'review-judge' (never the codex Brain) — this route is out of ASSISTANT_ACCEPT.
  //
  // Retry-freshness axis (the researchRetryAt shape, adapted for ⟦DEC-4⟧). After an operator retries a
  // reviewer, `retry()` stamps `sortie.reviewRetryAt` but leaves the previous ReviewRecord in place (the
  // post-land attestation flip is a review FEATURE, so the discarded reviewer may still submit). Two guards
  // together preserve the flip while closing the stale-clean hole: this resolver DISCARDS a pre-retry
  // caller (its loop.createdAt < the stamp) so the discarded reviewer's loop loses read+write on the
  // review (a 404 at both routes); and the GET applies isStaleReviewRecord so a pre-stamp record reads as
  // not-submitted. The REPLACEMENT reviewer's loop is created after the stamp (createdAt > stamp always),
  // so it keeps the route and its resubmit is fresh (submittedAt > stamp always).
  const resolveReviewContext = (
    tid: string,
  ): { missionId: string; sortieId: string; round?: number; range?: string; baseBranch?: string; retryAt?: string } | undefined => {
    // The newest loop this terminal drives that carries a mission+sortie backref.
    const loop = loops
      .list()
      .filter((l) => l.terminalId === tid && l.missionId && l.sortieId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!loop || !loop.missionId || !loop.sortieId) return undefined;
    const mission = missions.get(loop.missionId);
    if (!mission) return undefined;
    for (const phase of mission.phases) {
      const sortie = phase.sorties.find((s) => s.id === loop.sortieId);
      if (!sortie) continue;
      // Only a REVIEW (judge) sortie may submit — reviewSortie (pending) or reviewFromRange (finalized).
      if (sortie.reviewSortie !== true && sortie.reviewFromRange === undefined) return undefined;
      // A loop created BEFORE the sortie's retry stamp is the DISCARDED reviewer — it loses the route
      // (404), so it can never submit into or read the review that superseded it.
      if (isPreRetryReviewLoop(loop.createdAt, sortie.reviewRetryAt)) return undefined;
      return {
        missionId: mission.id,
        sortieId: sortie.id,
        ...(phase.round !== undefined ? { round: phase.round } : {}),
        ...(sortie.reviewFromRange !== undefined ? { range: sortie.reviewFromRange } : {}),
        ...(loop.baseBranch ? { baseBranch: loop.baseBranch } : {}),
        ...(sortie.reviewRetryAt !== undefined ? { retryAt: sortie.reviewRetryAt } : {}),
      };
    }
    return undefined;
  };
  // Route-side finding caps mirror the zod caps (defense-in-depth; the store also truncates). A finding
  // needs at least a file + summary; a bad verdict blanks (→ CONFIRMED semantics). At most 50 findings.
  const capFindings = (raw: unknown[]): ReviewFinding[] => {
    const out: ReviewFinding[] = [];
    for (const f of raw.slice(0, REVIEW_CAPS.findings)) {
      if (!f || typeof f !== 'object') continue;
      const o = f as Record<string, unknown>;
      // Canonicalize the free-text path at ingest so the STORED file is the partition key (a spelling
      // variant can't split one physical file across two fixers → a land conflict).
      const file = typeof o.file === 'string' ? canonicalizeReviewPath(o.file).slice(0, REVIEW_CAPS.file) : '';
      const summary = typeof o.summary === 'string' ? o.summary.slice(0, REVIEW_CAPS.summary) : '';
      if (!file || !summary) continue;
      const finding: ReviewFinding = { file, summary };
      if (typeof o.line === 'number' && Number.isInteger(o.line)) finding.line = o.line;
      if (typeof o.detail === 'string') finding.detail = o.detail.slice(0, REVIEW_CAPS.detail);
      if (typeof o.category === 'string') finding.category = o.category.slice(0, REVIEW_CAPS.category);
      // Normalize the verdict (case + surrounding space) before matching — a mis-cased 'plausible' must
      // not silently drop to undefined (which absent-verdict⇒CONFIRMED would then force a fixer round).
      if (typeof o.verdict === 'string') {
        const v = o.verdict.trim().toUpperCase();
        if (v === 'CONFIRMED' || v === 'PLAUSIBLE') finding.verdict = v;
      }
      out.push(finding);
    }
    return out;
  };
  const confirmedCount = (findings: ReviewFinding[]): number => findings.filter(isConfirmed).length;

  app.post<{ Body: { findings?: unknown } }>('/api/agent/review', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const ctx = resolveReviewContext(tid);
    if (!ctx) return reply.code(404).send({ error: 'no review sortie' });
    const body = req.body ?? {};
    if (!Array.isArray(body.findings)) return reply.code(400).send({ error: 'findings array required' });
    const findings = capFindings(body.findings);
    // Audit a resubmission over an existing record: prior→new confirmed counts, so a post-land attestation
    // flip is visible in the trail. ids/round/range are SERVER-derived — the body gives only findings.
    const prior = reviews.getFor(ctx.missionId, ctx.sortieId);
    const rec = reviews.upsert({
      missionId: ctx.missionId,
      sortieId: ctx.sortieId,
      ...(ctx.round !== undefined ? { round: ctx.round } : {}),
      ...(ctx.range !== undefined ? { range: ctx.range } : {}),
      findings,
    });
    const confirmed = confirmedCount(rec.findings);
    audit('review.submit', {
      missionId: ctx.missionId,
      sortieId: ctx.sortieId,
      findings: rec.findings.length,
      confirmed,
      ...(prior ? { priorConfirmed: confirmedCount(prior.findings) } : {}),
    });
    return { ok: true, findings: rec.findings.length, confirmed };
  });

  app.get('/api/agent/review', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const ctx = resolveReviewContext(tid);
    if (!ctx) return reply.code(404).send({ error: 'no review sortie' });
    // A record submitted before this reviewer was retried is not this run's work — read it as absent so
    // the replacement's `towerctl review check` keeps failing until IT resubmits (never green off the
    // discarded review). The provenance guard in resolveReviewContext already 404s a pre-retry caller.
    const prior = reviews.getFor(ctx.missionId, ctx.sortieId);
    const rec = isStaleReviewRecord(prior, ctx.retryAt) ? undefined : prior;
    return {
      submitted: !!rec,
      ...(rec ? { findings: rec.findings.length, confirmed: confirmedCount(rec.findings) } : {}),
      // The owning terminal's own worktree base branch — the `towerctl review check` commit-count belt.
      ...(ctx.baseBranch ? { baseBranch: ctx.baseBranch } : {}),
    };
  });

  // ---- SPEC-SKILLS-GATE: the loop-green gate attestation submit/read (per-terminal token) ----
  // Ownership is derived EXCLUSIVELY token→terminal→loop→(mission,sortie) — the body carries only the
  // gate id + verdict, never ids. EVERY miss (no owning loop / mission gone / the mission has no frozen
  // requiredGates) returns ONE byte-identical 404 so the route is no ownership oracle. Deltas from the
  // review route's derivation (parallel code — the review resolver above stays frozen): ANY sortie of
  // the mission may attest (agents record evidence DURING their sortie, before the green boundary —
  // there is no gate-marked sortie kind), and there is NO retry-stamp guard (freshness is the
  // evaluator's identity/phase-structure axis, never a stamp; resolveGateState is the sole judge).
  const resolveGateContext = (
    tid: string,
  ): { missionId: string; sortieId: string; round?: number; range?: string; requiredGates: string[] } | undefined => {
    // The newest loop this terminal drives that carries a mission+sortie backref.
    const loop = loops
      .list()
      .filter((l) => l.terminalId === tid && l.missionId && l.sortieId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!loop || !loop.missionId || !loop.sortieId) return undefined;
    const mission = missions.get(loop.missionId);
    if (!mission) return undefined;
    const requiredGates = mission.loop?.requiredGates;
    if (!requiredGates || requiredGates.length === 0) return undefined; // nothing frozen to attest
    for (const phase of mission.phases) {
      const sortie = phase.sorties.find((s) => s.id === loop.sortieId);
      if (!sortie) continue;
      const base = mission.baseSha ?? mission.loop?.baseSha;
      return {
        missionId: mission.id,
        sortieId: sortie.id,
        ...(phase.round !== undefined ? { round: phase.round } : {}),
        ...(base ? { range: `${base}..HEAD` } : {}),
        requiredGates: [...requiredGates],
      };
    }
    return undefined;
  };

  app.post<{ Body: { gate?: unknown; result?: unknown; summary?: unknown } }>('/api/agent/gate', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const ctx = resolveGateContext(tid);
    if (!ctx) return reply.code(404).send({ error: 'no gated mission' });
    const body = req.body ?? {};
    const gate = typeof body.gate === 'string' ? body.gate.trim() : '';
    // The caller legitimately owns this mission (the derivation above succeeded), so naming its own
    // required gates back to it leaks nothing the GET below does not already return.
    if (!gate || !ctx.requiredGates.includes(gate)) {
      return reply.code(400).send({ error: `gate must name one of this mission's required gates: ${ctx.requiredGates.join(', ')}` });
    }
    const result = body.result === 'pass' ? 'pass' : body.result === 'fail' ? 'fail' : undefined;
    if (!result) return reply.code(400).send({ error: 'result must be "pass" or "fail"' });
    const summary =
      typeof body.summary === 'string' && body.summary.trim() ? body.summary.trim().slice(0, GATE_CAPS.summary) : undefined;
    const rec = gateEvidence.upsert({
      missionId: ctx.missionId,
      sortieId: ctx.sortieId,
      gateId: gate,
      ...(ctx.round !== undefined ? { round: ctx.round } : {}),
      ...(ctx.range !== undefined ? { range: ctx.range } : {}),
      status: result,
      ...(summary !== undefined ? { summary } : {}),
    });
    // ids + verdict only — never the free-text summary (agent-authored text stays out of the audit trail).
    audit('gate.submit', { missionId: ctx.missionId, sortieId: ctx.sortieId, gateId: rec.gateId, status: rec.status });
    return { ok: true, gate: rec.gateId, status: rec.status };
  });

  app.get('/api/agent/gate', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const ctx = resolveGateContext(tid);
    if (!ctx) return reply.code(404).send({ error: 'no gated mission' });
    // Submission state only — NO staleness verdict here: the completion evaluator (resolveGateState)
    // is the sole judge, and this read is advisory (the `towerctl review check` stance).
    return {
      gates: ctx.requiredGates.map((id) => {
        const rec = gateEvidence.getFor(ctx.missionId, id);
        return { id, submitted: !!rec, ...(rec ? { status: rec.status } : {}) };
      }),
    };
  });

  // ---- SPEC-RESEARCH W9: the research sortie's finding submit/read ----
  /**
   * Ownership is SERVER-DERIVED and the body is content-only, exactly like the review and triage
   * routes: token → terminal → its newest LIVE mission loop → that loop's sortie. Every derivation
   * miss returns ONE byte-identical 404, so the route is never an ownership oracle.
   *
   * ⟦DEC-4⟧ live-loop-only (`liveLoopForTerminal`, the triage precedent) rather than the review
   * route's any-loop lookup: a post-land attestation flip is a deliberate review FEATURE, whereas a
   * finding submitted after its loop resolved could no longer change the sortie's outcome — the
   * mission has already left the tick's running-only scan — so a late submit gets an honest 404
   * instead of a dangling write nothing will ever read.
   */
  const resolveResearchContext = (
    tid: string,
  ): { missionId: string; sortieId: string; round?: number; baseBranch?: string; retryAt?: string } | undefined => {
    const loop = liveLoopForTerminal(tid, true);
    if (!loop || !loop.missionId || !loop.sortieId) return undefined;
    const mission = missions.get(loop.missionId);
    if (!mission) return undefined;
    for (const phase of mission.phases) {
      const sortie = phase.sorties.find((s) => s.id === loop.sortieId);
      if (!sortie) continue;
      // Only a RESEARCH sortie may submit. There is no pin field to also accept: research has no
      // assign-time task finalization, so the marker is never cleared and this single check suffices.
      if (sortie.researchSortie !== true) return undefined;
      return {
        missionId: mission.id,
        sortieId: sortie.id,
        ...(phase.round !== undefined ? { round: phase.round } : {}),
        ...(loop.baseBranch ? { baseBranch: loop.baseBranch } : {}),
        // The retry stamp, so the read below can tell THIS run's finding from the previous run's.
        ...(sortie.researchRetryAt !== undefined ? { retryAt: sortie.researchRetryAt } : {}),
      };
    }
    return undefined;
  };
  // Route-side caps mirror the zod caps (defense-in-depth; the store also truncates). Malformed
  // citations are dropped silently rather than 400ing the whole submission — a finding is worth more
  // than a well-formed pointer list, and the summary is the deliverable.
  const capResearch = (raw: unknown): ResearchCitation[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const out: ResearchCitation[] = [];
    for (const c of raw.slice(0, RESEARCH_CAPS.citations)) {
      if (!c || typeof c !== 'object') continue;
      const o = c as Record<string, unknown>;
      const ref = typeof o.ref === 'string' ? o.ref.trim().slice(0, RESEARCH_CAPS.citationRef) : '';
      if (!ref) continue;
      const entry: ResearchCitation = { ref };
      if (typeof o.note === 'string' && o.note.trim()) entry.note = o.note.slice(0, RESEARCH_CAPS.citationNote);
      out.push(entry);
    }
    return out.length ? out : undefined;
  };

  app.post<{ Body: { topic?: unknown; summary?: unknown; citations?: unknown } }>(
    '/api/agent/research',
    async (req, reply) => {
      const tid = agentTerminal(req);
      if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
      const ctx = resolveResearchContext(tid);
      if (!ctx) return reply.code(404).send({ error: 'no research sortie' });
      const body = req.body ?? {};
      const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
      if (!summary) return reply.code(400).send({ error: 'summary required — the finding body' });
      const topic = typeof body.topic === 'string' ? body.topic.trim().slice(0, RESEARCH_CAPS.topic) : '';
      const citations = capResearch(body.citations);
      // A resubmission REPLACES the prior finding; audit the fact so a retried researcher's overwrite is
      // visible in the trail. ids/round are SERVER-derived — the body carries content only.
      const prior = researchStore.getFor(ctx.missionId, ctx.sortieId);
      const rec = researchStore.upsert({
        missionId: ctx.missionId,
        sortieId: ctx.sortieId,
        ...(ctx.round !== undefined ? { round: ctx.round } : {}),
        topic,
        summary: summary.slice(0, RESEARCH_CAPS.summary),
        ...(citations ? { citations } : {}),
      });
      audit('research.submit', {
        missionId: ctx.missionId,
        sortieId: ctx.sortieId,
        topic: rec.topic.slice(0, 80),
        summaryChars: rec.summary.length,
        citations: rec.citations?.length ?? 0,
        replaced: !!prior,
      });
      return { ok: true, topic: rec.topic, summaryChars: rec.summary.length, citations: rec.citations?.length ?? 0 };
    },
  );

  app.get('/api/agent/research', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const ctx = resolveResearchContext(tid);
    if (!ctx) return reply.code(404).send({ error: 'no research sortie' });
    // SPEC-RESEARCH W9 — a record from BEFORE this sortie was retried is not this run's work. This
    // half is what keeps the AGENT honest: `towerctl research check` reads `submitted`, so reporting
    // the previous run's finding here would pass the check on the retry's first iteration and steer
    // the researcher away from ever submitting — the sortie would then land on the discarded finding.
    const prior = researchStore.getFor(ctx.missionId, ctx.sortieId);
    const rec = prior && ctx.retryAt !== undefined && prior.submittedAt < ctx.retryAt ? undefined : prior;
    return {
      submitted: !!rec,
      ...(rec ? { topic: rec.topic, summaryChars: rec.summary.length } : {}),
      // The owning terminal's own worktree base branch — the `towerctl research check` commit belt.
      ...(ctx.baseBranch ? { baseBranch: ctx.baseBranch } : {}),
    };
  });

  // ---- SPEC-PLANNER §6: the planner terminal's consult surface (pending + reply) ----
  /**
   * DEC-P3 — the loop-LESS ownership chain. The planner is the ONLY loop-less agent surface, so the W6/W7
   * token→terminal→loop chain returns undefined for it. Instead: token → terminal → the UNIQUE live
   * mission whose `planner.terminalId` matches, on a non-terminal, non-archived mission. Exactly ONE match
   * or the derivation fails (ambiguity fails CLOSED — attach/spawn enforce uniqueness; the scan is defence
   * in depth). Every miss → the byte-identical 404 `{error:'no planner consult'}` (m1), so the route is
   * never an ownership oracle.
   */
  const plannerMissionForTerminal = (tid: string): Mission | undefined => {
    const matches = missions.list().filter((m) =>
      m.planner?.terminalId === tid && m.planner.state === 'live'
      && m.status !== 'done' && m.status !== 'failed' && !m.archivedAt);
    return matches.length === 1 ? matches[0] : undefined;
  };
  // The ONE 404 body every derivation/selection miss returns — a foreign id must never probe (m1).
  const PLANNER_404 = { error: 'no planner consult' };

  app.get('/api/agent/planner/pending', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const m = plannerMissionForTerminal(tid);
    if (!m) return reply.code(404).send(PLANNER_404);
    // Delivery evidence — the stronger site (§4): stamp every returned pending consult delivered.
    let deliveredAny = false;
    for (const c of consultStore.openFor(m.id)) {
      if (c.status === 'pending' && consultStore.markDelivered(c.id)) deliveredAny = true;
    }
    if (deliveredAny) mission.emitConsults();
    // Re-read post-stamp so `status`/`deadline` reflect the delivery transition just made.
    const open = consultStore.openFor(m.id);
    return {
      consults: open.map((c) => {
        const deadline = consultDeadline(c); // undefined on a corrupt timestamp — omit, never throw/500
        return { id: c.id, kind: c.kind, status: c.status, askedAt: c.askedAt, ...(deadline ? { deadline } : {}), question: c.question };
      }),
      // The self-brief served on EVERY pending call so a respawned pane self-briefs over HTTP (DEC-P6).
      brief: buildPlannerBrief(m, consultStore.listFor(m.id)),
    };
  });

  app.post<{ Body: { consultId?: unknown; answer?: unknown } }>('/api/agent/planner/reply', async (req, reply) => {
    const tid = agentTerminal(req);
    if (!tid) return reply.code(401).send({ error: 'bad terminal token' });
    const m = plannerMissionForTerminal(tid);
    if (!m) return reply.code(404).send(PLANNER_404);
    const body = req.body ?? {};
    // Select among the mission's OWN answerable consults — past the ownership boundary, so specificity
    // here is not an oracle. None → the byte-identical 404; >1 without a consultId → 400 naming ITS ids;
    // a consultId not among them → the byte-identical 404 (a foreign id must not probe).
    const answerable = consultStore.openFor(m.id).filter((c) => c.status === 'pending' || c.status === 'delivered');
    if (answerable.length === 0) return reply.code(404).send(PLANNER_404);
    let target: PlannerConsult;
    const consultId = typeof body.consultId === 'string' ? body.consultId : undefined;
    if (consultId) {
      const found = answerable.find((c) => c.id === consultId);
      if (!found) return reply.code(404).send(PLANNER_404);
      target = found;
    } else if (answerable.length > 1) {
      return reply.code(400).send({ error: `multiple open consults — pass --consult <id>: ${answerable.map((c) => c.id).join(', ')}` });
    } else {
      target = answerable[0]!;
    }
    // Kind gate — only 'replan' in W8a (DEC-P9); any other kind is on the wire schema but not answerable.
    if (target.kind !== 'replan') return reply.code(400).send({ error: `consult kind '${target.kind}' is not answerable yet` });
    // Raw-body cap, THEN the light shape gate (the trusted pipeline stays at the tick, DEC-P4). A garbage
    // reply 400s WITHOUT burning the escalation attempt or the consult.
    if (JSON.stringify(body.answer ?? null).length > CONSULT_CAPS.answerBytes) {
      return reply.code(400).send({ error: 'reply too large' });
    }
    const parsed = parseReplyPhases(body.answer);
    if (!parsed) return reply.code(400).send({ error: 'invalid reply — expected {"phases":[{"name","sorties":[{"name","task",...}]}]}' });
    try {
      consultStore.recordAnswer(target.id, parsed); // pending|delivered → answered
    } catch {
      // §m7 — a tick expired the consult on an adjacent event-loop turn between the openFor read and here.
      return reply.code(409).send({ error: 'consult is no longer open' });
    }
    audit('consult.reply', { missionId: m.id, consultId: target.id, phases: parsed.phases.length });
    mission.emitConsults();
    return { ok: true, consultId: target.id };
  });

  // ---- SSE live stream (EventSource can't set headers -> token via query) ----
  app.get<{ Querystring: { token?: string } }>('/api/stream', (req, reply) => {
    if (!req.query.token || !auth.verifyToken(req.query.token)) {
      return reply.code(401).send({ error: 'bad token' });
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (ev: StreamEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const unsub = mission.subscribe(write);
    void mission.pushAttention();
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 25_000);
    keepalive.unref?.();
    req.raw.on('close', () => {
      clearInterval(keepalive);
      unsub();
    });
  });

  // ---- static web (prod build) ----
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web-dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      const p = req.url.split('?')[0] ?? req.url;
      // /preview (bare AND trailing-slash) must NEVER fall back to the app shell (SPEC-FILES
      //): an expired grant or a slash-less /preview gets a JSON 404 — files.ts's
      // onSend wrapper still stamps the CSP/no-store block on it.
      if (p.startsWith('/api/') || p.startsWith('/ws') || p === '/preview' || p.startsWith('/preview/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ host: HOST, port: PORT });

  // ---- WebSocket terminal streaming ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_TERMINAL_FRAME_BYTES });
  app.server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) return socket.destroy();
    if (!auth.wsUpgradeOk(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    attachTerminalSocket(ws, {
      verifyToken: (token) => auth.verifyToken(token),
      hasTerminal: (id) => !!store.getTerminal(id),
      noteViewerResize: (id) => poller.noteViewerResize(id),
      attach: (id, sink, size, onReflow) => tm.attach(id, sink, size, onReflow),
    });
  });

  console.log(`Control Tower v${VERSION} listening on http://${HOST}:${PORT}  (CT_HOME=${paths.home})`);
  audit('tower.start', { version: VERSION, port: PORT });

  const shutdown = () => {
    if (shuttingDown) return; // a second signal (SIGINT after SIGTERM) must not re-enter the drain
    shuttingDown = true;
    reconciler.stop();
    poller.stop();
    loops.stop_();
    missions.stop_();
    broker.stop();
    retention.stop();
    credRefresher.stop();
    clearInterval(spoolTimer);
    // Backstop: if the drain or app.close() ever hangs (a wedged check command, a stuck long-lived
    // connection), still exit so a supervisor/operator is never left with a zombie. unref so the timer
    // itself never keeps the process alive; release the instance lock here too, since a forced exit
    // skips the orderly releaseLock below.
    const force = setTimeout(() => {
      console.error('[shutdown] forced exit — drain/close exceeded timeout');
      try {
        releaseLock();
      } catch {
        /* best-effort — do not let a lock-release error prevent the forced exit */
      }
      process.exit(1);
    }, SHUTDOWN_FORCE_MS);
    force.unref();
    void (async () => {
      // The tick timers are stopped AND the onRequest hook now 503s new mutating requests, so no NEW
      // loop/mission work starts from either path; let whatever is already in flight (a running check
      // command or a git commit) finish so a SIGTERM mid-deploy doesn't orphan a child or leave a
      // worktree half-committed. Bounded by SHUTDOWN_DRAIN_MS; the force timer covers any overrun.
      const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
      while (loops.inFlight() + missions.inFlight() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      releaseLock();
      await app.close().catch(() => {});
      clearTimeout(force);
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Safety net: a single-instance daemon must not die on a stray background-promise rejection.
  // A fire-and-forget op that rejects with no local .catch() would otherwise, since Node 15,
  // terminate the process — dropping every live terminal, loop, and mission with it. Keep the Tower
  // up and record the rejection loudly so the gap is visible rather than fatal. Individual call sites
  // still handle their own errors; this is the backstop for the ones that are missed.
  // The whole body is guarded because a rejection reason can be ANY value — even a Symbol, whose
  // String() coercion throws — and a throw inside this handler would surface as an uncaughtException:
  // the very crash it exists to prevent.
  process.on('unhandledRejection', (reason) => {
    try {
      const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
      console.error('[unhandledRejection]', message);
      audit('server.unhandled-rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
    } catch {
      console.error('[unhandledRejection] (reason could not be stringified)');
    }
  });
}

main().catch((err) => {
  console.error('Tower failed to start:', err);
  process.exit(1);
});
