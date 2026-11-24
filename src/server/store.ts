// JSON config stores + append-only JSONL event log. Config is the record of
// *intent*; the true runtime state of terminals is derived live from tmux by the
// reconciler (SPEC §11/§17), so this store never claims to know what is running —
// only what the user asked to exist.

import { readFileSync, writeFileSync, appendFileSync, renameSync, copyFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths, logPathFor } from './paths.js';
import { ROLE_IDS } from '../shared/roles.js';
import { PHASE_STAGES, CONSULT_KINDS } from '../shared/types.js';
import type {
  Project,
  Terminal,
  TowerEvent,
  Loop,
  Mission,
  ProviderId,
  CustomProviderId,
} from '../shared/types.js';

// ---- Shared provider-id schema (SPEC-PROVIDERS §1.2) ----
// ONE zod gate for provider ids, replacing the four hand-copied z.enum literals (here ×3 +
// accounts.ts). Accepts the four built-ins verbatim and the open `custom:<slug>` namespace; a
// malformed slug is rejected (readJsonArray then drops just that record). z.custom keeps the
// inferred type EXACTLY `ProviderId` — a bare z.union([...]) would widen it to `string` and
// erase the load-bearing `=== 'shell'` sentinel at every persistence site.
const BUILTIN_PROVIDER_IDS = ['claude-code', 'gemini-cli', 'codex', 'shell', 'hermes'] as const;
const CUSTOM_PROVIDER_ID_RE = /^custom:[a-z0-9][a-z0-9-]{0,38}$/;
export const providerIdSchema = z.custom<ProviderId>(
  (v) =>
    typeof v === 'string' &&
    ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(v) || CUSTOM_PROVIDER_ID_RE.test(v)),
  { message: 'invalid provider id (expected a built-in or custom:<slug>)' },
);

// ---- ProviderDef schema (SPEC-PROVIDERS §1.1) ----
// Exported so BP1's providers/store.ts validates upserts against the SAME shape the Terminal
// snapshot is validated against — one schema, no drift. Unlisted fields are stripped on
// load (the M6 lesson): keep this in lockstep with the ProviderDef interface in shared/types.ts.
const providerAuthSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('env') }),
  z.object({ mode: z.literal('login'), loginCommand: z.array(z.string()).optional() }),
]);
const providerTurnDetectionSchema = z.object({
  mode: z.enum(['webhook', 'screen-regex', 'dwell-only']),
  hookConfig: z
    .object({
      relPath: z.string(),
      template: z.string(),
      bindings: z.array(
        z.object({
          providerEvent: z.string(),
          signal: z.enum(['needs-input', 'needs-permission', 'turn-done', 'session-start']),
        }),
      ),
    })
    .optional(),
  patterns: z
    .object({
      needsPermission: z.string().optional(),
      needsInput: z.string().optional(),
      turnDone: z.string().optional(),
    })
    .optional(),
  busyPattern: z.string().optional(),
  socketBusy: z.boolean().optional(),
  screenChangeImpliesWork: z.boolean().optional(),
  chromeStripPatterns: z.array(z.string()).optional(),
});
const providerModelConfigSchema = z.object({
  modelFlag: z.string().optional(),
  modelEnv: z.string().optional(),
  defaultModel: z.string().optional(),
  modelsPath: z.string().optional(),
  models: z.array(z.object({ id: z.string(), verifiedAt: z.string().optional() })).optional(),
});
export const ProviderDefSchema = z.object({
  id: z.custom<CustomProviderId>((v) => typeof v === 'string' && CUSTOM_PROVIDER_ID_RE.test(v), {
    message: 'invalid custom provider id',
  }),
  displayName: z.string(),
  command: z.array(z.string()),
  configDirEnv: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  secretEnvKeys: z.array(z.string()).optional(),
  baseUrl: z.string().optional(),
  model: providerModelConfigSchema,
  turn: providerTurnDetectionSchema,
  approveKeys: z.object({ approve: z.array(z.string()), deny: z.array(z.string()) }),
  auth: providerAuthSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

// PipelineRole gate (SPEC-PROVIDERS §2.1) for the per-sortie routing override mirror below.
// Registry-derived (SPEC-ROUTING §1): when a new role lands in PIPELINE_ROLES, a stored mission
// carrying it keeps loading — a hand-copied enum here would turn it into a parse failure that
// bricks the whole mission record.
const pipelineRoleSchema = z.enum(ROLE_IDS);
// A STORED role id outside the current registry (a downgrade, or a removed/renamed role) blanks the
// field instead of failing the whole Mission/Loop record on load (SPEC-ROUTING §3 — the routing
// store strips unknown roles the same way). Preprocess to undefined BEFORE the enum so it never
// throws. NOT used for API-input validation, which stays strict on pipelineRoleSchema.
// The union tries the strict enum first (a valid role parses normally); anything else — an
// out-of-registry role from a downgrade or a removed/renamed role — falls to the second member,
// which accepts any value and yields undefined. So an unknown role blanks the field rather than
// failing the whole Mission/Loop record on load, keeping a concrete inferred type (PipelineRole |
// undefined) for the enclosing object.
const storedRole = z.union([pipelineRoleSchema, z.any().transform(() => undefined)]).optional();

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  repoPath: z.string(),
  scaffoldMode: z.enum(['zero-footprint', 'local-only', 'committed']),
  // Optional fields on the Project type MUST be listed or zod strips them on load —
  // dropping defaultIdentityId on restart would silently launch agents with no identity.
  defaultIdentityId: z.string().optional(),
  isolation: z.enum(['per-agent-uid', 'single-uid']).optional(),
  archivedAt: z.string().optional(),
  // SPEC-TERMINAL-OPS §3.1 — per-project live-terminal cap; MUST be listed or zod strips it on load.
  maxTerminals: z.number().optional(),
  // Per-project GitHub repo URL (metadata only); MUST be listed or the M6 strip-trap drops it on load.
  repoUrl: z.string().optional(),
  // "Autonomous (skip permissions)" per-project default; MUST be listed or zod strips it on load
  // and every restart would silently disarm (or worse, later re-arm surprise) the operator's choice.
  defaultAutoAccept: z.boolean().optional(),
  createdAt: z.string(),
});

const TerminalSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  provider: providerIdSchema,
  tmuxSocket: z.string(),
  cwd: z.string(),
  command: z.array(z.string()),
  state: z.enum(['starting', 'working', 'blocked-question', 'blocked-permission', 'idle', 'killed']),
  sessionId: z.string().optional(),
  // Fields added M2–M4 — MUST be listed or zod strips them on load, silently losing
  // a terminal's token/worktree/identity across a Tower restart.
  hookToken: z.string().optional(),
  autoAccept: z.boolean().optional(),
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  profileId: z.string().optional(),
  identityId: z.string().optional(),
  // SPEC-RUNWAY — transient old-config-dir marker during a rotation (M6: listed or zod strips it, and a
  // crash mid-rotation would then lose the belt that keeps the old dir protected). A rotation completes
  // in-process, so this is normally absent on disk; any value present at load is boot-stale and the Store
  // constructor strips it (so the old-dir belts recover after a mid-rotation Tower death).
  rotatingFrom: z.string().optional(),
  liveSlotDir: z.string().optional(), // SPEC-RUNWAY live-swap — must be registered or the schema-strip drops it on reload
  // SPEC-TERMINAL-OPS §4.1 — what the terminal is for; absent = 'work'. MUST be listed or zod strips
  // it on load, and a login terminal would then lose its probe skip, cap exemption and reap immunity.
  purpose: z.enum(['work', 'planner', 'login']).optional(),
  // Snapshot-at-launch of a custom provider's def (custom: ids only). MUST be listed or
  // zod strips it on load — a live terminal would then lose its frozen turn detection across a
  // Tower restart and fall back to the tombstone adapter. Reuses ProviderDefSchema (no second one).
  providerDef: ProviderDefSchema.optional(),
  // SPEC-LOOPWEDGE — the current idle was reached by inference (lost-hook harvest / poller
  // affirmative-idle backstop), not a completion hook. MUST be listed or zod strips it on load,
  // and a wedged builder's inferred marking would be lost across a Tower restart (the loop GUARD
  // would then read it as a real idle). Absent = a real (or no) idle.
  idleInferred: z.boolean().optional(),
  createdAt: z.string(),
  closedAt: z.string().optional(),
  lastEventAt: z.string().optional(),
});

const ValidatorRunSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  results: z.array(z.object({ assertionId: z.string(), pass: z.boolean(), reason: z.string() })),
  inconclusiveReason: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(), // SPEC-EFFORT §5 — MUST be listed or zod strips it on load
  ms: z.number(),
  ranAt: z.string(),
});

const LoopIterationSchema = z.object({
  n: z.number(),
  verdict: z.enum(['pending', 'pass', 'fail']),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  added: z.number().optional(),
  removed: z.number().optional(),
  files: z.number().optional(),
  checkTail: z.string().optional(),
  note: z.string().optional(),
  validator: ValidatorRunSchema.optional(),
  // SPEC-SUBMIT §4.3/§7 — the no-work-no-commit suspicion flag; MUST be listed or zod strips it on load.
  suspectNoWork: z.boolean().optional(),
  // SPEC-MEMORY — the briefing-delivered annotation + the agent's progress note; MUST be listed or zod
  // strips them on load (the same M6 trap): a restarted Tower would silently forget which memory revs
  // the builder was shown, and the board's progress note would vanish mid-iteration.
  memoryDelivered: z.array(z.object({ id: z.string(), rev: z.number() })).optional(),
  progress: z.string().optional(),
});

const LoopSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  task: z.string(),
  provider: providerIdSchema,
  // Optional fields MUST be listed or zod strips them on load (same trap as Terminal).
  model: z.string().optional(), // resolved model slug for buildCommand {{model}}
  effort: z.string().optional(), // SPEC-EFFORT §1 — MUST be listed or zod strips it on load
  role: storedRole, // SPEC-ROUTING §3 — the pipeline role a standalone loop plays (tolerant on load)
  profileId: z.string().optional(),
  identityId: z.string().optional(),
  terminalId: z.string().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  worktreePath: z.string().optional(),
  checkCommand: z.string().optional(),
  gatePolicy: z.enum(['every', 'on-pass', 'never']),
  maxIterations: z.number(),
  status: z.enum(['running', 'gated', 'paused', 'done', 'stopped', 'failed']),
  iteration: z.number(),
  iterations: z.array(LoopIterationSchema),
  stopReason: z.string().optional(),
  // SPEC-FACTORY §1 additions — MUST be listed or zod strips them on load (M6 trap).
  assertions: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  missionId: z.string().optional(),
  sortieId: z.string().optional(),
  landedAt: z.string().optional(),
  landDetail: z.string().optional(),
  // Structured no-change marker — MUST be listed or the M6 zod-strip drops it on load, and a
  // restart between the loop resolving and the mission reconcile would re-park the mission.
  noChangesToLand: z.boolean().optional(),
  // SPEC-BACKLOG §3 ⟦DP-B6⟧ archive marker — MUST be listed or the M6 zod-strip drops it on load.
  archivedAt: z.string().optional(),
  // SPEC-SKILLS per-project delivery — the frozen sortie brief + its clearance belt flag + the
  // delivered assistant-skill ids (the inject-time live clearance re-check keys on them). MUST be
  // listed or the M6 zod-strip drops them on load: a RESTARTED loop re-sends its prompt from the
  // STORED record (the loops.ts restore path), so an unlisted field silently loses the project's
  // skills mid-flight — or, for the id list, silently disarms the re-check.
  skillBrief: z.string().optional(),
  skillBriefUncleared: z.boolean().optional(),
  skillBriefAssistantIds: z.array(z.string()).optional(),
  // SPEC-MEMORY — the memory briefing cursor. MUST be listed or the M6 zod-strip drops it on load:
  // a Tower restart would then re-send the FULL active set as if the builder had never been briefed,
  // instead of the "changes since" delta the persisted cursor exists to preserve.
  memoryCursor: z.object({ seq: z.number(), briefedAt: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// SPEC-FACTORY §2 — missions. Every optional field listed (same zod-strip trap).
const MissionSortieSchema = z.object({
  id: z.string(),
  name: z.string(),
  task: z.string(),
  assertions: z.array(z.string()).optional(),
  checkCommand: z.string().optional(),
  // ⟦§2.2⟧ Per-sortie routing overrides — MUST be listed or zod strips them on load. `storedRole`
  // keeps an out-of-registry role from bricking the whole Mission on load (SPEC-ROUTING §3).
  role: storedRole,
  provider: providerIdSchema.optional(),
  model: z.string().optional(),
  effort: z.string().optional(), // SPEC-EFFORT §1 — MUST be listed or the M6 zod-strip drops it on load
  // SPEC-TESTING §1 — per-role account; MUST be listed or the M6 zod-strip drops it on load.
  profileId: z.string().optional(),
  loopId: z.string().optional(),
  status: z.enum(['pending', 'active', 'gated', 'done', 'landed', 'attention']),
  landDetail: z.string().optional(),
  // Set when a sortie landed as a benign no-change (zero-commit) stop — MUST be listed or the M6
  // zod-strip drops it on load; the mission UI keys the in-place retry affordance off it.
  noChangeLanded: z.boolean().optional(),
  note: z.string().optional(),
  // SPEC-STORYLOOP §3.3 — persisted verify-fixer marker + the runner runId a fixer was assigned
  // from. MUST be listed or the M6 zod-strip drops them on load (assignedFrom is set at
  // runtime and must survive a restart).
  verifyFixer: z.boolean().optional(),
  assignedFrom: z.string().optional(),
  // SPEC-TESTING §3 — documentor-phase markers; MUST be listed or the M6 zod-strip drops them on load.
  docsSortie: z.boolean().optional(),
  docsFromRun: z.string().optional(),
  // SPEC-LOOP W6 — code-review markers (reviewer + review-fixer); MUST be listed or the M6 zod-strip
  // drops them on load and a Tower restart mid-review-round strands the phase.
  reviewSortie: z.boolean().optional(),
  reviewFromRange: z.string().optional(),
  reviewFixer: z.boolean().optional(),
  assignedFromReview: z.string().optional(),
  // …and the review-retry stamp the freshness check reads (mirrors researchRetryAt). MUST be listed or
  // the M6 zod-strip drops it on load and a retried reviewer silently re-inherits the discarded review.
  reviewRetryAt: z.string().optional(),
  // SPEC-LOOP W7 — false-fail investigator markers; MUST be listed or the M6 zod-strip drops them on
  // load. investigateFromRun is set at runtime and must survive a restart — it is also the triage
  // route's ownership pin, so losing it would break in-flight triage after a Tower restart.
  investigateSortie: z.boolean().optional(),
  investigateFromRun: z.string().optional(),
  // SPEC-RESEARCH W9 — the research marker. MUST be listed or zod strips it on load, and every research
  // mission would then lose its markers on the first Tower restart: the reconcile-time finding gate
  // would stop firing and a researcher that submitted nothing would land silently.
  researchSortie: z.boolean().optional(),
  // …and the retry stamp the freshness check reads. MUST be listed too: without it the stamp
  // evaporates on the first restart and a retried researcher silently re-inherits the old finding.
  researchRetryAt: z.string().optional(),
});

const MissionPhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  sorties: z.array(MissionSortieSchema),
  // SPEC-LOOP §0 — MUST be listed or the M6 zod-strip drops them on load. Registry-derived like
  // pipelineRoleSchema above: the ONE stage tuple lives in shared/types.ts.
  stage: z.enum(PHASE_STAGES).optional(),
  round: z.number().optional(),
  gateRunId: z.string().optional(),
});

// SPEC-LOOP §2 — one iterate-until-green round's outcome (persisted on the mission's loop state).
const MissionRoundRecordSchema = z.object({
  n: z.number(),
  kind: z.enum(['authored', 'mechanical', 'replanned', 'review', 'review-fix', 'delivery', 'escalating']),
  appendedAt: z.string(),
  verifyRunId: z.string().optional(),
  failed: z.number().optional(),
  total: z.number().optional(),
  failureKeys: z.array(z.string()).optional(),
  // SPEC-LOOP W2 — transient planner-attempt counter on an 'escalating' record; MUST be listed or the
  // M6 zod-strip drops it on load and a mid-escalation restart loses its bounded-retry accounting.
  attempts: z.number().optional(),
  // SPEC-PLANNER §7 — the escalating record's persisted consult link; MUST be listed or the M6 zod-strip
  // drops it on load and a mid-consult restart re-asks a duplicate (the consultId is the idempotency key).
  consultId: z.string().optional(),
});

// SPEC-LOOP §1 — the iterate-until-green loop config + running state. MUST be listed (M6 zod-strip).
const MissionLoopSchema = z.object({
  maxRounds: z.number(),
  mechanicalRounds: z.number(),
  sortieBudget: z.number(),
  round: z.number(),
  deliveryAppended: z.boolean().optional(),
  baseSha: z.string().optional(),
  requirePlanReview: z.boolean().optional(),
  requireReview: z.boolean().optional(),
  // SPEC-LOOP W7 — the false-fail investigator opt-in; MUST be listed or the M6 zod-strip drops it on load.
  investigate: z.boolean().optional(),
  // SPEC-SKILLS-GATE — the create-frozen loop-green gate set + its rerun subset; MUST be listed or the
  // M6 zod-strip drops them on load and a Tower restart would silently UN-GATE a running loop's green
  // boundary (the exact enforcement these fields exist to carry).
  requiredGates: z.array(z.string()).optional(),
  rerunGates: z.array(z.string()).optional(),
  rounds: z.array(MissionRoundRecordSchema),
});

// SPEC-LOOP W3 (G4) — one pre-execution plan-grade finding. Every field listed (M6 zod-strip), and the
// operator-text strings are TRUNCATED (not rejected) to their caps so a pathological grade can never
// drop the whole mission on load — capping defensively while staying non-destructive.
const PlanFindingSchema = z.object({
  lens: z.enum(['fact-check', 'red-team']),
  severity: z.enum(['block', 'warn']),
  detail: z.string().transform((s) => s.slice(0, 500)),
  target: z.string().transform((s) => s.slice(0, 200)).optional(),
});

const MissionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  goal: z.string(),
  provider: providerIdSchema,
  model: z.string().optional(), // mission-level model default (resolveRouting)
  effort: z.string().optional(), // SPEC-EFFORT §1 — MUST be listed or zod strips it on load
  profileId: z.string().optional(),
  identityId: z.string().optional(),
  advance: z.enum(['gate', 'auto']),
  maxIterationsPerSortie: z.number(),
  concurrency: z.number(),
  // SPEC-STORYLOOP §4 — the regression-gate suite; MUST be listed or the M6 zod-strip drops it.
  gateSuite: z.string().optional(),
  phases: z.array(MissionPhaseSchema),
  activePhase: z.number(),
  // SPEC-TERMINAL-OPS §6 — the base commit for ALL missions; MUST be listed or the M6 zod-strip drops it.
  baseSha: z.string().optional(),
  // SPEC-LOOP §1 — the iterate-until-green loop state; MUST be listed or the M6 zod-strip drops it on load.
  loop: MissionLoopSchema.optional(),
  // SPEC-LOOP W3 (G4) — the pre-execution plan grade; MUST be listed or the M6 zod-strip drops it on load.
  // Bound to the plan's phasesHash; findings capped (≤20) so a pathological grade can't bloat the record.
  planReview: z.object({
    verdict: z.enum(['pass', 'block']),
    findings: z.array(PlanFindingSchema).transform((f) => f.slice(0, 20)),
    gradedAt: z.string(),
    phasesHash: z.string(),
  }).optional(),
  // SPEC-PLANNER §1 — the bound planner terminal; MUST be listed in FULL or the M6 zod-strip drops it (or
  // a sub-field) on load and the mission silently reverts to the codex Brain path mid-flight. Every field
  // mirrors the MissionPlanner interface.
  planner: z.object({
    terminalId: z.string(),
    provider: providerIdSchema,
    model: z.string().optional(),
    effort: z.string().optional(),
    profileId: z.string().optional(),
    state: z.enum(['live', 'lost']),
    attachedAt: z.string(),
    spawned: z.boolean().optional(),
    respawns: z.number().optional(),
    respawnedAt: z.string().optional(),
  }).optional(),
  status: z.enum(['draft', 'running', 'phase-gate', 'paused', 'attention', 'done', 'failed']),
  stopReason: z.string().optional(),
  // SPEC-BACKLOG §3 ⟦DP-B6⟧ archive marker — MUST be listed or the M6 zod-strip drops it on load.
  archivedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// SPEC-LOOP W6 — the ONE cap set shared by the zod schema below AND the route-side capFindings in
// server.ts (one source of truth, so bumping a cap can never make the two silently disagree).
export const REVIEW_CAPS = { file: 300, summary: 500, detail: 2000, category: 40, findings: 50 } as const;

// SPEC-LOOP W6 — the routed reviewer's structured submission. EXPORTED so reviews.ts validates against
// the SAME shape (the ProviderDefSchema-export precedent) instead of a second, drift-prone schema. Every
// operator/agent string TRUNCATES rather than rejects (the PlanFindingSchema idiom) so a pathological
// finding can never drop the whole record on load; an unknown/absent verdict blanks (→ CONFIRMED
// semantics, the fail-safe posture) via the storedRole union idiom rather than bricking the record. `line`
// is tolerant the same way — a non-integer maps to undefined instead of dropping the whole record.
export const ReviewFindingSchema = z.object({
  file: z.string().transform((s) => s.slice(0, REVIEW_CAPS.file)),
  line: z.union([z.number().int(), z.any().transform(() => undefined)]).optional(),
  summary: z.string().transform((s) => s.slice(0, REVIEW_CAPS.summary)),
  detail: z.string().transform((s) => s.slice(0, REVIEW_CAPS.detail)).optional(),
  category: z.string().transform((s) => s.slice(0, REVIEW_CAPS.category)).optional(),
  verdict: z.union([z.enum(['CONFIRMED', 'PLAUSIBLE']), z.any().transform(() => undefined)]).optional(),
});
export const ReviewRecordSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  sortieId: z.string(),
  round: z.number().optional(),
  range: z.string().optional(),
  findings: z.array(ReviewFindingSchema).transform((f) => f.slice(0, REVIEW_CAPS.findings)),
  submittedAt: z.string(),
});

// SPEC-SKILLS-GATE — the cap set for a loop-green gate attestation, shared by the zod schema below and
// any future route-side capper (the REVIEW_CAPS discipline: one source of truth). An UNKNOWN status
// FAILS CLOSED to 'fail' — a mangled attestation must never read as a pass — while the record itself is
// KEPT (the storedRole idiom, never dropped), so the operator sees an honest FAILED gate instead of a
// silent "no evidence" of a different flavor.
export const GATE_CAPS = { gateId: 100, summary: 2000 } as const;
export const GateEvidenceRecordSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  sortieId: z.string(),
  gateId: z.string().transform((s) => s.slice(0, GATE_CAPS.gateId)),
  round: z.number().optional(),
  range: z.string().optional(),
  status: z.union([z.enum(['pass', 'fail']), z.any().transform(() => 'fail' as const)]),
  summary: z.string().transform((s) => s.slice(0, GATE_CAPS.summary)).optional(),
  submittedAt: z.string(),
});

// SPEC-RESEARCH W9 — the ONE cap set shared by the zod schema below AND the route-side capper in
// server.ts (the REVIEW_CAPS discipline: one source of truth, so the two can never silently disagree).
// The 8KB summary is the STORED budget — a real survey needs room, and the per-mission prune is what
// bounds the file. The PROMPT-facing budgets are far smaller and live at their own call sites.
export const RESEARCH_CAPS = {
  topic: 200, summary: 8192, citationRef: 500, citationNote: 300, citations: 20,
} as const;

// SPEC-RESEARCH W9 — a research sortie's submitted finding. EXPORTED so research.ts validates against
// the SAME shape (the ReviewRecordSchema precedent) rather than a second, drift-prone schema. Every
// agent string TRUNCATES rather than rejects (the PlanFindingSchema idiom) so a pathological finding
// can never drop the whole record on load.
export const ResearchCitationSchema = z.object({
  ref: z.string().transform((s) => s.slice(0, RESEARCH_CAPS.citationRef)),
  note: z.string().transform((s) => s.slice(0, RESEARCH_CAPS.citationNote)).optional(),
});
export const ResearchRecordSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  sortieId: z.string(),
  round: z.number().optional(),
  topic: z.string().transform((s) => s.slice(0, RESEARCH_CAPS.topic)),
  summary: z.string().transform((s) => s.slice(0, RESEARCH_CAPS.summary)),
  citations: z.array(ResearchCitationSchema).transform((c) => c.slice(0, RESEARCH_CAPS.citations)).optional(),
  submittedAt: z.string(),
});

// SPEC-PLANNER §1 — the caps shared by the zod schema below AND the route-side capper in server.ts (the
// REVIEW_CAPS discipline: one source of truth). `question` is the STORED body budget (self-contained:
// reply protocol + payload rendered in); `answerBytes` bounds a raw reply so a pathological body can't
// bloat the store even though `answer` is z.unknown.
export const CONSULT_CAPS = { question: 16000, answerBytes: 262144 } as const;

// SPEC-PLANNER §1/§2 — one structured planner consult. EXPORTED so consults.ts validates against the
// SAME shape (the ReviewRecordSchema precedent) rather than a second, drift-prone schema. Every agent/
// operator string TRUNCATES rather than rejects (the PlanFindingSchema idiom); an unknown status/kind/
// expireReason blanks to a safe value via the storedRole union idiom rather than bricking the record.
// `payload`/`answer` are tolerant (z.unknown/passthrough): the trusted pipeline re-validates at the
// consume point, so a malformed payload must never drop the whole record on load.
const consultStatusSchema = z.union([
  z.enum(['pending', 'delivered', 'answered', 'applied', 'rejected', 'expired']),
  z.any().transform(() => 'expired' as const), // an unrecognised status fails CLOSED (terminal)
]);
const consultExpireReasonSchema = z.union([
  z.enum(['delivery-timeout', 'answer-timeout', 'planner-unrecoverable', 'planner-detached', 'mission-ended', 'superseded']),
  z.any().transform(() => undefined),
]).optional();
export const PlannerConsultSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  terminalId: z.string(),
  kind: z.enum(CONSULT_KINDS),
  question: z.string().transform((s) => s.slice(0, CONSULT_CAPS.question)),
  payload: z.unknown().optional(),
  phasesHash: z.string().optional(),
  status: consultStatusSchema,
  askedAt: z.string(),
  deliveredAt: z.string().optional(),
  answeredAt: z.string().optional(),
  answer: z.unknown().optional(),
  nudges: z.number().optional(),
  lastNudgeAt: z.string().optional(),
  expireReason: consultExpireReasonSchema,
});

/**
 * Load an array config file with PER-RECORD validation. One invalid record must never
 * wipe the whole collection (which the next persist would then make permanent by
 * overwriting the file with only the survivors). Valid records are kept, invalid ones
 * skipped with a loud log, and the original bytes preserved in a `.rejected-<ts>` copy
 * before any re-persist. If the FILE itself is unreadable (torn JSON, not an array) it
 * is renamed to `.corrupt-<ts>` before falling back to empty — so a later persist can
 * never overwrite data we simply failed to read. Returns `hadRejects` so the caller can
 * re-persist to a clean steady state (and not re-log the same rejects every startup), and
 * `dropped` — the raw schema-rejected elements — so a caller can salvage a field from a dropped
 * record (e.g. an orphaned terminal's tmuxSocket, for the reconciler's ownership-scoped reap).
 */
export function readJsonArray<T>(
  file: string,
  schema: z.ZodType<T>,
): { records: T[]; hadRejects: boolean; dropped: unknown[] } {
  if (!existsSync(file)) return { records: [], hadRejects: false, dropped: [] };

  // 1. READ. A read failure on a file that exists is a TRANSIENT I/O error (EMFILE, EIO),
  //    NOT corruption — so throw (fail startup loudly, recoverable by restart) rather than
  //    quarantine the live file, which would then be overwritten with an empty fleet.
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`[store] cannot read ${file} (transient I/O — not corruption): ${(err as Error).message}`);
  }

  // 2. PARSE. Malformed JSON / non-array IS corruption: quarantine the bytes (rename), then
  //    start empty. If the rename fails we MUST throw — starting empty while the corrupt
  //    file is still in place would let the next persist overwrite (destroy) it.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
  } catch (err) {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    console.error(`[store] ${file} corrupt (${(err as Error).message}); quarantining as ${quarantine}`);
    renameSync(file, quarantine); // throws on failure -> Tower fails to start (no silent wipe)
    return { records: [], hadRejects: false, dropped: [] };
  }

  // 3. VALIDATE per record. One bad record must not drop the rest. Preserve the original
  //    bytes in a .rejected copy BEFORE the constructor re-persists survivors-only; if that
  //    backup fails, report hadRejects=false so the constructor does NOT re-persist (leaving
  //    the original intact for recovery) — losing survivors-only is better than losing all.
  const records: T[] = [];
  const dropped: unknown[] = [];
  for (const el of parsed) {
    const res = schema.safeParse(el);
    if (res.success) records.push(res.data);
    else {
      dropped.push(el); // keep the raw element so a caller can salvage e.g. an orphaned tmux socket
      console.error(`[store] skipping invalid record in ${file}: ${res.error.message}`);
    }
  }
  let hadRejects = false;
  if (dropped.length > 0) {
    try {
      copyFileSync(file, `${file}.rejected-${Date.now()}`);
      hadRejects = true; // backup ok -> safe to re-persist survivors
    } catch (e) {
      console.error(`[store] could not back up ${file}; NOT re-persisting (keeping original):`, e);
    }
  }
  return { records, hadRejects, dropped };
}

/** Atomic write: temp file + rename, so a crash mid-write can't corrupt config. An optional `mode`
 *  is applied to the temp file before the rename carries it to the target (0o600 for secret-bearing
 *  stores); omitting it preserves the prior default-permissions behavior. */
export function writeJsonAtomic(file: string, data: unknown, mode?: number): void {
  const tmp = `${file}.tmp`;
  // writeFileSync's {mode} only takes effect when the temp file is newly CREATED: a `${file}.tmp` left
  // behind by a crash-interrupted prior write keeps its old (possibly looser) bits on overwrite. Tighten
  // it BEFORE any secret byte is written, so the sidecar never holds secret content at loose perms and
  // the rename carries 0o600 onto the target (reviews / gates / consults / research are all written
  // 0o600, and paths.config is not 0700-locked, so file mode is their only defense). On a fresh path the
  // chmod throws ENOENT (caught) and the writeFileSync below creates it {mode} from the first byte.
  // Best-effort: a chmod error must not fail an otherwise-durable write. Mirrors accounts.ts copyPrivate.
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode);
    } catch {
      /* not yet created — the writeFileSync below makes it {mode}; never block the write on a chmod */
    }
  }
  writeFileSync(tmp, JSON.stringify(data, null, 2), mode === undefined ? 'utf8' : { mode });
  renameSync(tmp, file);
}

export class Store {
  private projects: Map<string, Project>;
  private terminals: Map<string, Terminal>;
  private loops: Map<string, Loop>;
  private missions: Map<string, Mission>;
  /** Per-terminal monotonic event sequence, rebuilt from disk on load. */
  private seq = new Map<string, number>();
  /** tmux sockets of terminal records DROPPED by schema validation on load. Their tmux servers may
   *  still be running with no record to reconcile against — an invisible orphan the reconciler reaps.
   *  Scoped to THIS store's own file, so it can never name another Tower's machine-global ct-* socket. */
  private droppedTerminalSockets_ = new Set<string>();

  constructor() {
    const proj = readJsonArray(paths.projects, ProjectSchema);
    const term = readJsonArray(paths.terminals, TerminalSchema);
    const loop = readJsonArray(paths.loops, LoopSchema);
    const miss = readJsonArray(paths.missions, MissionSchema);
    this.projects = new Map(proj.records.map((p) => [p.id, p]));
    this.terminals = new Map(term.records.map((t) => [t.id, t]));
    // SPEC-RUNWAY — clear any BOOT-STALE `rotatingFrom`. It is an in-process-only marker set for the
    // brief window of a rotation and cleared when the respawn lands, so a rotation always completes
    // within one process; any value still on disk at load means the Tower died mid-rotation. Left set,
    // it makes the usage-ingest, wall-scrape, cred-refresh idle-gate, autonomy-bypass and profile-delete
    // belts all treat the OLD dir as perpetually live for that terminal — silently, forever. Strip it
    // here at load (once, before the reconciler/loops/rotate primitive can run, so this can never race a
    // legitimate in-flight rotation) and persist so the on-disk record drops it too.
    let clearedRotating = false;
    for (const [id, t] of this.terminals) {
      if (t.rotatingFrom !== undefined) {
        this.terminals.set(id, { ...t, rotatingFrom: undefined });
        clearedRotating = true;
      }
    }
    for (const el of term.dropped) {
      const sock = el && typeof el === 'object' ? (el as { tmuxSocket?: unknown }).tmuxSocket : undefined;
      if (typeof sock === 'string' && sock !== '') this.droppedTerminalSockets_.add(sock);
    }
    this.loops = new Map(loop.records.map((l) => [l.id, l]));
    this.missions = new Map(miss.records.map((m) => [m.id, m]));
    // Reach a clean steady state now: the live file becomes valid-records-only; the
    // dropped records are already preserved in the .rejected-<ts> copy above.
    if (proj.hadRejects) this.persistProjects();
    if (term.hadRejects || clearedRotating) this.persistTerminals();
    if (loop.hadRejects) this.persistLoops();
    if (miss.hadRejects) this.persistMissions();
    this.rebuildSeq();
  }

  /** tmux sockets whose terminal record this store dropped on load — provably ours (from our own file),
   *  so the reconciler can reap their leaked servers without risking another Tower's machine-global socket. */
  droppedTerminalSockets(): ReadonlySet<string> {
    return this.droppedTerminalSockets_;
  }

  /**
   * Rebuild each terminal's seq high-water mark from the append-only event log so
   * nextSeq() continues past the last persisted value after a restart instead of
   * restarting at 1 and re-emitting (terminalId, seq) pairs already on disk.
   * Best-effort: a missing events dir (fresh install) or a malformed file/line is
   * skipped rather than thrown — a broken log must not stop the Tower from starting.
   */
  private rebuildSeq(): void {
    let files: string[];
    try {
      files = readdirSync(paths.events);
    } catch {
      return; // events dir not created yet
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      let text: string;
      try {
        text = readFileSync(join(paths.events, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { terminalId?: unknown; seq?: unknown };
          if (typeof ev.terminalId === 'string' && typeof ev.seq === 'number') {
            const prev = this.seq.get(ev.terminalId) ?? 0;
            if (ev.seq > prev) this.seq.set(ev.terminalId, ev.seq);
          }
        } catch {
          // Skip a malformed line; a torn final write shouldn't lose the rest.
        }
      }
    }
  }

  // ---- projects ----
  listProjects(): Project[] {
    return [...this.projects.values()];
  }
  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }
  upsertProject(p: Project): Project {
    this.projects.set(p.id, p);
    this.persistProjects();
    return p;
  }

  // ---- terminals (intent records) ----
  listTerminals(): Terminal[] {
    return [...this.terminals.values()];
  }
  getTerminal(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }
  upsertTerminal(t: Terminal): Terminal {
    this.terminals.set(t.id, t);
    this.persistTerminals();
    return t;
  }
  patchTerminal(id: string, patch: Partial<Terminal>): Terminal | undefined {
    const cur = this.terminals.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.terminals.set(id, next);
    this.persistTerminals();
    return next;
  }

  // ---- loops (iterate-until-done cycles) ----
  listLoops(): Loop[] {
    return [...this.loops.values()];
  }
  getLoop(id: string): Loop | undefined {
    return this.loops.get(id);
  }
  upsertLoop(l: Loop): Loop {
    this.loops.set(l.id, l);
    this.persistLoops();
    return l;
  }
  patchLoop(id: string, patch: Partial<Loop>): Loop | undefined {
    const cur = this.loops.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.loops.set(id, next);
    this.persistLoops();
    return next;
  }

  // ---- missions (autopilot campaigns) ----
  listMissions(): Mission[] {
    return [...this.missions.values()];
  }
  getMission(id: string): Mission | undefined {
    return this.missions.get(id);
  }
  upsertMission(m: Mission): Mission {
    this.missions.set(m.id, m);
    this.persistMissions();
    return m;
  }
  patchMission(id: string, patch: Partial<Mission>): Mission | undefined {
    const cur = this.missions.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.missions.set(id, next);
    this.persistMissions();
    return next;
  }
  private persistMissions(): void {
    writeJsonAtomic(paths.missions, [...this.missions.values()]);
  }

  private persistProjects(): void {
    writeJsonAtomic(paths.projects, [...this.projects.values()]);
  }
  private persistTerminals(): void {
    writeJsonAtomic(paths.terminals, [...this.terminals.values()]);
  }
  private persistLoops(): void {
    writeJsonAtomic(paths.loops, [...this.loops.values()]);
  }

  // ---- events (append-only JSONL, one file per UTC day) ----
  nextSeq(terminalId: string): number {
    const n = (this.seq.get(terminalId) ?? 0) + 1;
    this.seq.set(terminalId, n);
    return n;
  }

  /**
   * Append an event and, in the SAME terminals.json write, apply lastEventAt plus any
   * `extraPatch` (e.g. the new state) — so a state transition costs one atomic rewrite,
   * not two back-to-back.
   */
  appendEvent(ev: Omit<TowerEvent, 'seq' | 'ts'> & { ts?: string }, extraPatch?: Partial<Terminal>): TowerEvent {
    const full: TowerEvent = {
      ...ev,
      seq: this.nextSeq(ev.terminalId),
      ts: ev.ts ?? new Date().toISOString(),
    };
    const day = full.ts.slice(0, 10);
    appendFileSync(`${paths.events}/${day}.jsonl`, JSON.stringify(full) + '\n', 'utf8');
    const patch: Partial<Terminal> = { ...extraPatch };
    if (full.type !== 'reconcile') patch.lastEventAt = full.ts;
    if (Object.keys(patch).length > 0) this.patchTerminal(full.terminalId, patch);
    return full;
  }

  logPathFor = logPathFor;
}
