// Assistant action catalog (SPEC-ASSISTANT-CONTROL §3, ⟦DP-J4⟧): the ONE table holding zod
// validation, route mapping, risk rating, and the summary/enrichment template for every kind
// the assistant may PROPOSE. The discriminated union IS the whole write surface — a capability
// absent here cannot be proposed (⟦DP-J5⟧ hard-never), so any addition is an attack-surface
// change, not a feature tweak. upsert_custom_provider is deliberately absent from v1 (§3):
// def.command[] is host argv behind a def blob — deferred until it can be allowlisted and
// rendered verbatim on the card.
//
// Execution is app.inject with trusted headers (⟦DP-J3⟧): a confirmed action re-enters the
// Tower's own public route, so the onRequest auth hook, route guards, audit lines, and SSE
// frames all fire exactly as a UI click would. The model never holds a mutating tool, and this
// file never ingests model prose — summaries are Tower-templated from zod-validated args.

import { z } from 'zod';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ROLE_IDS } from '../../shared/roles.js';
import { CT_WORKTREES_DIRNAME, normalizeRepoPath, paths } from '../paths.js';
import { validateRepoUrl } from '../broker.js';
// SPEC-SKILLS Phase 5b — the promote_skill create path derives its id from the store's OWN slugifier
// and reserved-id set (the validateRepoUrl import precedent above): one source, so a slug the store
// would refuse is refused at PROPOSE time, never first at the route.
import { slugifySkillName, isReservedSkillId } from '../skills/store.js';
import { isSafeName } from '../ids.js';
import type { LoopAccountInput, LoopAccountView } from '../loop-account.js';
// Re-exported: canonicalization lives in paths.ts (core modules must not import assistant code),
// but the action catalog is where its callers and the spec reference it from.
export { normalizeRepoPath } from '../paths.js';
import type {
  AssistantAction,
  CustomProviderId,
  LayeredRoleRouting,
  ProviderId,
  SkillOrigin,
} from '../../shared/types.js';
import { isValidEffort } from '../../shared/types.js';

// ---- live-state lookups (injected; the integrator wires these from the real stores) ----

/** Read-only views of live Tower state used to resolve ids → names for the card summary at
 *  propose time and to detect drift at confirm time (§2). All synchronous — every backing
 *  store is an in-memory map, and enrich may add sync fs probes (existsSync/realpathSync) —
 *  which is what lets confirm()'s guards run before its first await. An unknown referenced id
 *  makes enrich() throw a self-correctable Error. */
export interface ActionLookups {
  getProject(id: string): { name: string; repoPath: string; repoUrl?: string; defaultIdentityId?: string; defaultAutoAccept?: boolean } | undefined;
  getProfile(id: string): { label: string; provider: string } | undefined;
  /** Resolve a GitHub identity id → its label + push-token presence, for create_project /
   *  set_project_github enrich (an unknown id is self-correctable at propose; the route re-checks). */
  getIdentity(id: string): { label: string; hasCredential: boolean } | undefined;
  /** Whether a profile id is a Brain account reserved for the Tower's assistant (SPEC-TESTING-V2 §4):
   *  a reserved account can never run a builder role, so set_routing enrich refuses to pin one to a role.
   *  Wired orchestrator-side from reservedProfileIds (server.ts); the route guard is the belt to this. */
  isReservedProfile(id: string): boolean;
  /** Resolve the account a create_loop would SPAWN under (the same resolveRouting account chain +
   *  credential probe the /api/loops start gate runs), synchronously so enrich — and confirm's
   *  drift re-run — can gate on it. Wired orchestrator-side via makeLoopAccountResolver
   *  (server.ts, from routing + accounts + providers) — never reimplemented here. */
  resolveLoopAccount(input: LoopAccountInput): LoopAccountView;
  getTask(id: string): { title: string; status: string } | undefined;
  /** Layered routing view (SPEC-ROUTING §3) — wire as `(projectId) => routingStore.layersFor(projectId)`
   *  so a project-scoped card can show/drift-check that project's current layers, not just global. */
  getRouting(projectId?: string): LayeredRoleRouting;
  /** Resolve a workflow profile id → its name for the card summary (SPEC-ROUTING §2). Optional so
   *  the Tower keeps compiling until the routing store's workflow CRUD is wired in. */
  getWorkflow?(id: string): { name: string } | undefined;
  /** Whether a provider id is currently known (built-ins + synthesized customs). */
  hasProvider(id: string): boolean;
  /** LIVE clear-finished sweep counts — wire via countFinished() over loops/missions lists. */
  finishedCounts(): { loops: number; missions: number };
  /** create_project's path gate: the registered project this repoPath collides with, if any —
   *  'same' (already registered), 'contains' (an existing project's tree CONTAINS this path), or
   *  'inside' (this path contains an existing project). All three are harmful, because a project's
   *  worktree root is derived from dirname(repoPath): nesting either way puts one project's live
   *  worktrees inside another's working tree, where a repo-root `git add -A` sweeps them into commits.
   *  Compare on normalizeRepoPath'd strings with a path-boundary test. Re-run at confirm, so a project
   *  registered between propose and confirm aborts as drift. */
  projectPathConflict(repoPath: string): { name: string; relation: 'same' | 'contains' | 'inside' } | undefined;
  /** Resolve a skill id → its display name, current enabled state, DERIVED protection (isProtectedSkill:
   *  a protected flag OR a blocking gate), contentHash, and origin — for set_skill_enabled /
   *  set_project_skills / promote_skill enrich (SPEC-SKILLS Phase 5/5b; origin drives promote's
   *  non-assistant-target refusal). Unknown id is self-correctable at propose; the re-run at confirm is the
   *  drift gate (an operator body-edit changes contentHash; a skill protected between propose and confirm
   *  drift-aborts). Wired orchestrator-side (server.ts) so isProtectedSkill is the single derivation site. */
  getSkill(id: string): { name: string; enabled: boolean; protected: boolean; contentHash: string; origin: SkillOrigin } | undefined;
  /** Resolve a draft id → the promote-relevant view, for promote_skill enrich (SPEC-SKILLS Phase 5b).
   *  Synchronous (in-memory SkillDraftStore), so confirm's drift re-run stays before its first await.
   *  contentHash is the LIVE hash — the enrich comparison against the action's pinned hash is what
   *  voids a card whose draft was edited after propose (the assistant holds the draft-write route). */
  getSkillDraft(id: string): { name: string; status: 'open' | 'promoted'; contentHash: string; targetSkillId?: string } | undefined;
  /** Resolve a skill bundle id → its name, for set_project_skills enrich (an unknown id is self-correctable). */
  getBundle(id: string): { name: string } | undefined;
  /** A project's CURRENT skill overlay (selected bundle + per-skill overrides), for set_project_skills'
   *  drift baseline + summary. undefined when the project inherits the global set (no overlay). */
  getProjectSkills(id: string): { bundleId?: string; enable?: Record<string, boolean> } | undefined;
  /** SPEC-RESTART Wave 1 (§3.2) — close_terminal / restart_terminal enrich's live view of one
   *  terminal. `owningLoop` is the loop still BOUND to it (any non-terminal status — the set a close
   *  would FAIL via onTerminalGone); `isPlanner` covers both the purpose stamp and a mission's live
   *  planner binding; `profileReserved` = the terminal runs on a Brain account reserved for the
   *  Tower's assistant. Synchronous (in-memory store scans), so confirm's drift re-run stays before
   *  its first await. Wired orchestrator-side (server.ts) from the real store + loops + missions. */
  getTerminal(id: string): {
    title: string;
    provider: string;
    state: string;
    purpose?: 'work' | 'planner' | 'login';
    projectName: string;
    owningLoop?: { id: string; name: string; status: string; iteration: number };
    isPlanner: boolean;
    profileReserved: boolean;
  } | undefined;
  /** The EFFECTIVE-set delta a set_project_skills REPLACE would cause — resolved through resolveSkillSelection
   *  (the ONE resolution site) under the project's CURRENT overlay vs the PROPOSED one. `droppedProtected`
   *  names any protected skill that is effective NOW but would NOT be under the proposal: a full overlay
   *  replace can drop a protected skill by OMISSION (or the bare {projectId} reset) without ever naming it,
   *  which the explicit enable-map refusal misses. `dropped` names ALL leaving skills so the card can show a
   *  destructive replace. Wired orchestrator-side (server.ts) from the live library + selection. */
  projectSkillReplaceDelta(
    id: string,
    proposed: { bundleId?: string; enable?: Record<string, boolean> },
  ): { dropped: string[]; droppedProtected: string[] };
}

/**
 * The exact archive predicate of POST /api/board/clear-finished (server.ts), kept here so the
 * count echoed on the card and re-checked at confirm can never drift from the sweep itself:
 * loops — unarchived, not a sortie of a still-active mission, and landed/stopped/failed;
 * missions — unarchived and done/failed.
 */
export function countFinished(
  loops: { archivedAt?: string; missionId?: string; landedAt?: string; status: string }[],
  missions: { id: string; archivedAt?: string; status: string }[],
): { loops: number; missions: number } {
  const activeMissions = new Set(
    missions.filter((m) => m.status !== 'done' && m.status !== 'failed').map((m) => m.id),
  );
  let nLoops = 0;
  for (const l of loops) {
    if (l.archivedAt) continue;
    if (l.missionId && activeMissions.has(l.missionId)) continue;
    if (l.landedAt || l.status === 'stopped' || l.status === 'failed') nLoops++;
  }
  let nMissions = 0;
  for (const m of missions) {
    if (!m.archivedAt && (m.status === 'done' || m.status === 'failed')) nMissions++;
  }
  return { loops: nLoops, missions: nMissions };
}

// ---- summary sanitizer (§5 card integrity) ----

// C0/C1 controls, bidi embedding/override/isolate marks, zero-width and joiner chars, BOM,
// and Unicode line separators: anything that could re-shape or spoof the one-line summary.
// Whitespace is collapsed FIRST so newlines become spaces instead of vanishing words.
const UNSAFE_CHARS_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** The uncapped core of sanitizeInline — exactly how a value RENDERS on one summary line. Split out so
 *  an action can demand its args render as written (rendersAsWritten), and so that check can never drift
 *  from the sanitizer it is checking against. */
function inlineRendering(v: unknown): string {
  return String(v).replace(/\s+/g, ' ').replace(UNSAFE_CHARS_RE, '').trim();
}

/** Flatten a value into one safe, length-capped line for a Tower-templated summary. */
export function sanitizeInline(v: unknown, max = 80): string {
  const s = inlineRendering(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * True when a value survives inline rendering unchanged — i.e. the line the operator READS names exactly
 * the string that gets STORED and derived into filesystem paths.
 *
 * Used to REJECT an arg rather than scrub it. Scrubbing would make the approved string differ from the
 * one that executes; and this is not about the dock's rendering (it escapes args via sanitizeCardText) —
 * it is that a control byte or an odd space is hostile in a value later used as a path, however it was
 * displayed. Defined against the sanitizer itself, so it catches everything the sanitizer would silently
 * change: control/bidi/zero-width chars, and Unicode or repeated whitespace that would collapse to a
 * plain space on the card. Any future change to the sanitizer flows here automatically.
 */
function rendersAsWritten(v: string): boolean {
  return inlineRendering(v) === v;
}


// ---- validation: a hand-written zod mirror of the frozen AssistantAction union (§3) ----

const customProviderId = z.custom<CustomProviderId>(
  (v) => typeof v === 'string' && /^custom:[a-z0-9][a-z0-9-]{0,38}$/.test(v),
  'invalid provider id (built-in or custom:<slug>)',
);
const providerId: z.ZodType<ProviderId> = z.union([
  z.enum(['claude-code', 'gemini-cli', 'codex', 'shell', 'hermes']),
  customProviderId,
]);
const priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const entityId = z.string().trim().min(1).max(64);

// Kept in lockstep with the shared types by hand (PipelineRole, GatePolicy, TaskStatus):
// validateAction's declared return type makes tsc reject any drift toward a WIDER shape,
// and length caps keep card rendering and transcripts bounded (§5 tight schemas).
const ActionUnion = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create_profile'),
      provider: z.enum(['codex', 'claude-code', 'gemini-cli', 'hermes']),
      label: z.string().trim().min(1).max(120),
    })
    .strict(),
  z.object({ kind: z.literal('open_login'), profileId: entityId }).strict(),
  z
    .object({
      kind: z.literal('set_routing'),
      // Derived from the shared role registry (SPEC-ROUTING §1) — a new role is proposable
      // the moment it lands in PIPELINE_ROLES, no edit here.
      role: z.enum(ROLE_IDS),
      provider: providerId,
      model: z.string().trim().min(1).max(120).optional(),
      // SPEC-EFFORT §5 — optional reasoning effort (per-provider validated at enrich time, mirroring model).
      effort: z.string().trim().min(1).max(32).optional(),
      // SPEC-TESTING-V2 §4 — pin the role to a specific logged-in account of `provider`
      // (validated at enrich time; omitting it writes an account-less assignment = how one is cleared).
      profileId: entityId.optional(),
      // When present, the route targets this project's routing overlay, not global (§5).
      projectId: entityId.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set_project_workflow'),
      projectId: entityId,
      workflowId: entityId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('create_task'),
      projectId: entityId,
      title: z.string().trim().min(1).max(200),
      body: z.string().max(4000).optional(),
      priority: priority.optional(),
      status: z.enum(['triage', 'todo', 'ready']).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('update_task'),
      taskId: entityId,
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().max(4000).optional(),
      priority: priority.nullable().optional(),
      status: z.enum(['triage', 'todo', 'ready', 'archived']).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('clear_finished') }).strict(),
  z
    .object({
      kind: z.literal('create_loop'),
      projectId: entityId,
      name: z.string().trim().min(1).max(120),
      task: z.string().trim().min(1).max(4000),
      provider: providerId.optional(),
      model: z.string().trim().min(1).max(120).optional(),
      // SPEC-EFFORT §5 — optional reasoning effort (validated at enrich when provider is present).
      effort: z.string().trim().min(1).max(32).optional(),
      maxIterations: z.number().int().min(1).max(1000).optional(),
      gatePolicy: z.enum(['every', 'on-pass', 'never']).optional(),
      checkCommand: z.string().trim().min(1).max(1000).optional(),
      // Pin to a specific signed-in account (enrich-validated; omit ⇒ routing/shared login).
      profileId: entityId.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('create_project'),
      name: z.string().trim().min(1).max(120),
      // Canonicalize HERE so the card, the payload, the conflict compare, and the stored record are all
      // the SAME string — the operator must approve exactly what gets stored and derived from.
      repoPath: z.string().trim().min(1).max(512).transform(normalizeRepoPath),
      // Optional per-project GitHub config (validated at enrich: repoUrl shape, defaultIdentityId exists).
      repoUrl: z.string().trim().min(1).max(512).optional(),
      defaultIdentityId: entityId.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set_project_github'),
      projectId: entityId,
      // .nullable().optional(): null/absent clears; a string is validated at enrich. The ≥1-field gate is
      // in superRefine below (an === undefined test — null is a VALID clear op, not "field absent").
      repoUrl: z.string().trim().max(512).nullable().optional(),
      defaultIdentityId: entityId.nullable().optional(),
    })
    .strict(),
  // Single required field, no cross-field rule — so NO superRefine clause is added for it (SPEC-INITPUSH).
  z.object({ kind: z.literal('init_project_repo'), projectId: entityId }).strict(),
  // Four required fields, no cross-field rule → no superRefine clause. repoPath gets the same
  // normalize-at-parse as create_project; repoUrl/defaultIdentityId REQUIRED (v1 remote-required).
  z
    .object({
      kind: z.literal('bootstrap_project'),
      name: z.string().trim().min(1).max(120),
      repoPath: z.string().trim().min(1).max(512).transform(normalizeRepoPath),
      repoUrl: z.string().trim().min(1).max(512),
      defaultIdentityId: entityId,
    })
    .strict(),
  // Two required fields, no cross-field rule — so NO superRefine clause (like init_project_repo above).
  z.object({ kind: z.literal('set_project_autonomy'), projectId: entityId, enabled: z.boolean() }).strict(),
  // Two required fields, no cross-field rule (like init_project_repo / set_project_autonomy above).
  z.object({ kind: z.literal('set_skill_enabled'), skillId: entityId, enabled: z.boolean() }).strict(),
  // The whole overlay: an optional bundle + an optional per-skill on/off map (keys are skill ids). An
  // EMPTY overlay is VALID — bundleId null/absent + no enable clears to the global set — so no ≥1-field
  // superRefine (the set_project_github pattern is the opposite: it needs one). The enable count is capped
  // in superRefine below for card-renderability (well under the store's 512).
  z
    .object({
      kind: z.literal('set_project_skills'),
      projectId: entityId,
      bundleId: z.string().trim().max(64).nullable().optional(),
      enable: z.record(entityId, z.boolean()).optional(),
    })
    .strict(),
  // Two required fields, no cross-field rule — so NO superRefine clause (the init_project_repo idiom).
  // contentHash is the exact sha256 hex save_skill_draft returned — enrich compares it to the LIVE
  // draft hash, which is what keeps an Edit override from bypassing the pin (SPEC-SKILLS Phase 5b).
  z
    .object({
      kind: z.literal('promote_skill'),
      draftId: entityId,
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  // SPEC-RESTART Wave 1 (§3.2 addendum) — single required field, no cross-field rule, so NO
  // superRefine clause (the init_project_repo idiom), for both kinds.
  z.object({ kind: z.literal('close_terminal'), terminalId: entityId }).strict(),
  z.object({ kind: z.literal('restart_terminal'), terminalId: entityId }).strict(),
  // SPEC-CLI-UPDATE — the provider enum mirrors cli-updates.ts CLIS (the only self-updatable built-ins);
  // the id only SELECTS a fixed update command server-side, so no free text reaches the host process.
  z.object({ kind: z.literal('update_provider_cli'), provider: z.enum(['claude-code', 'codex', 'gemini-cli']) }).strict(),
]);

const ActionSchema = ActionUnion.superRefine((a, ctx) => {
  if (
    a.kind === 'update_task' &&
    a.title === undefined &&
    a.body === undefined &&
    a.priority === undefined &&
    a.status === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'update_task needs at least one of title/body/priority/status',
    });
  }
  // Test `=== undefined`, NOT truthiness: repoUrl:null / defaultIdentityId:null are VALID clear ops
  // (.nullable().optional()), so a proposal that clears exactly one field must pass. Error only when
  // BOTH keys are truly absent (the update_task pattern above).
  if (
    a.kind === 'set_project_github' &&
    a.repoUrl === undefined &&
    a.defaultIdentityId === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'set_project_github needs at least one of repoUrl/defaultIdentityId (null clears a field)',
    });
  }
  // A card-renderability cap on set_project_skills' enable map (NOT a ≥1-field gate — an empty overlay is a
  // valid clear). ~64 keeps the Confirm card readable; larger sets belong in a named bundle.
  if (a.kind === 'set_project_skills' && a.enable !== undefined && Object.keys(a.enable).length > 64) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'set_project_skills allows at most 64 per-skill overrides — assign a bundle for larger sets',
    });
  }
});

/** Parse untrusted input into a typed action, or throw a model-readable Error (routes → 400;
 *  the message names the offending field so the brain can self-correct and re-propose). */
export function validateAction(input: unknown): AssistantAction {
  const res = ActionSchema.safeParse(input);
  if (!res.success) {
    const detail = res.error.issues
      .map((i) => `${i.path.join('.') || 'action'}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid action: ${detail}`);
  }
  return res.data;
}

// ---- the per-kind mapping table ----

/** What the card shows beyond raw args: the sanitized one-line summary plus the denormalized
 *  live values it embeds — the baseline confirm() re-derives and compares for drift (§2). */
export interface Enrichment {
  summary: string;
  denorm: Record<string, string | number | null>;
}

type ActionOf<K extends AssistantAction['kind']> = Extract<AssistantAction, { kind: K }>;

/** GET a Tower route with the executor's own injected identity (executor-supplied). Lets a
 *  payload read-modify-write: PUT /api/projects/:id/routing REPLACES the whole overlay
 *  (routing store contract), so a card that promised ONE field's change must carry the rest
 *  of the overlay forward itself. Throws on a non-2xx read (→ the proposal fails cleanly). */
type RouteReader = (url: string) => Promise<unknown>;

interface CatalogEntry<K extends AssistantAction['kind']> {
  method: 'POST' | 'PUT';
  risk: 'low' | 'medium' | 'high';
  url(action: ActionOf<K>): string;
  payload(action: ActionOf<K>, read: RouteReader): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  /** Resolve referenced ids against live state; throws on any unknown id (self-correctable). */
  enrich(action: ActionOf<K>, lookups: ActionLookups): Enrichment;
}


const s = sanitizeInline;

/**
 * SPEC-RESTART Wave 1 (§3.2) — the shared guard rails of the two terminal actions. Throws are
 * self-correctable 400s at propose; re-run at confirm they are also the drift gate (a terminal
 * killed, repurposed, or newly Brain-bound between propose and confirm voids the card):
 *  - unknown / already-'killed' → nothing to act on;
 *  - a LOGIN pane → refused: it may be mid-way through the vendor's OAuth flow, and the two verbs
 *    part ways on the remedy (close: the operator ends it from the Cockpit; restart: open_login is
 *    the honest way to get a fresh login pane);
 *  - a mission's PLANNER pane → refused: the mission tick owns the planner lifecycle (lost-planner
 *    respawn, consult migration) and an out-of-band kill/respawn would fight it;
 *  - a terminal on a reserved BRAIN account → refused: the assistant must never manage its own
 *    substrate (the reserved-profile refusal that set_routing / create_loop enrich already apply).
 * A LOOP-BOUND builder is deliberately ALLOWED — the enrich summaries state the consequence
 * verbatim on the card, which the operator then owns.
 */
function terminalActionTarget(
  terminalId: string,
  verb: 'close' | 'restart',
  lookups: ActionLookups,
): NonNullable<ReturnType<ActionLookups['getTerminal']>> {
  const t = lookups.getTerminal(terminalId);
  if (!t) throw new Error(`unknown terminalId '${terminalId}' — call list_runs and use an existing id`);
  if (t.state === 'killed') throw new Error(`terminal '${terminalId}' is already stopped — nothing to ${verb}`);
  if (t.purpose === 'login') {
    throw new Error(
      verb === 'close'
        ? `terminal '${terminalId}' is a login pane (possibly mid-auth) — the operator closes it from its Cockpit once the login is done`
        : `terminal '${terminalId}' is a login pane — propose open_login instead of restarting it`,
    );
  }
  if (t.isPlanner) {
    throw new Error(`terminal '${terminalId}' is a mission's planner pane — the mission tick owns the planner lifecycle; point the operator at the mission instead`);
  }
  if (t.profileReserved) {
    throw new Error(`terminal '${terminalId}' runs on an account reserved for the Tower's assistant brain and cannot be managed through the assistant`);
  }
  return t;
}

/** Canonical JSON of a skill enable map (sorted keys) — the set_project_skills drift baseline. A denorm
 *  value must be string|number|null (proposals.ts), and sorting makes it order-independent so a re-enrich
 *  with the same overrides in a different key order never spuriously drift-voids the card. */
function canonEnableJson(m: Record<string, boolean> | undefined): string {
  const src = m ?? {};
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(src).sort()) out[k] = src[k] === true;
  return JSON.stringify(out);
}

const CATALOG: { [K in AssistantAction['kind']]: CatalogEntry<K> } = {
  create_profile: {
    method: 'POST',
    risk: 'low',
    url: () => '/api/profiles',
    payload: (a) => ({ provider: a.provider, label: a.label }),
    enrich: (a) => ({
      summary: `Create ${a.provider} profile "${s(a.label)}"`,
      denorm: {},
    }),
  },
  open_login: {
    method: 'POST',
    risk: 'low',
    url: (a) => `/api/profiles/${encodeURIComponent(a.profileId)}/login`,
    payload: () => undefined,
    enrich: (a, lookups) => {
      const prof = lookups.getProfile(a.profileId);
      if (!prof) throw new Error(`unknown profileId '${a.profileId}' — list profiles and use an existing id`);
      return {
        summary: `Open the interactive ${prof.provider} login for profile "${s(prof.label)}"`,
        denorm: { profileLabel: prof.label, profileProvider: prof.provider },
      };
    },
  },
  set_routing: {
    method: 'PUT',
    risk: 'low',
    // Global writes keep the per-role route; a project-scoped write hits that project's
    // overlay route (SPEC-ROUTING §4), read-modify-writing so only the one role changes.
    url: (a) =>
      a.projectId !== undefined
        ? `/api/projects/${encodeURIComponent(a.projectId)}/routing`
        : `/api/routing/${encodeURIComponent(a.role)}`,
    payload: async (a, read) => {
      // Per-role ATOMIC: the assignment is the WHOLE value for this role, so profileId rides it here
      // (global PUT below, and the project RMW's routes[role]); omitting profileId writes an account-less
      // assignment, which is how a pinned account is cleared.
      const assignment = {
        provider: a.provider,
        ...(a.model !== undefined ? { model: a.model } : {}),
        ...(a.effort !== undefined ? { effort: a.effort } : {}),
        ...(a.profileId !== undefined ? { profileId: a.profileId } : {}),
      };
      if (a.projectId === undefined) return assignment;
      // The overlay PUT is a REPLACE, and the card promised ONE role's change — read the live
      // overlay and carry its workflowId + sibling role overrides forward untouched.
      const cur = (await read(`/api/projects/${encodeURIComponent(a.projectId)}/routing`)) as {
        workflowId?: string;
        routes?: Record<string, unknown>;
      };
      return {
        ...(cur.workflowId !== undefined ? { workflowId: cur.workflowId } : {}),
        routes: { ...(cur.routes ?? {}), [a.role]: assignment },
      };
    },
    enrich: (a, lookups) => {
      if (!lookups.hasProvider(a.provider)) {
        throw new Error(`unknown provider '${a.provider}' — list providers and use an existing id`);
      }
      const scope = a.projectId !== undefined ? lookups.getProject(a.projectId) : undefined;
      if (a.projectId !== undefined && !scope) {
        throw new Error(`unknown projectId '${a.projectId}' — list projects and use an existing id`);
      }
      // §4 — a pinned account must exist, belong to the SAME provider as the role, and never be a
      // Brain account reserved for the Tower's assistant. These throws become a self-correctable 400
      // at propose; the route guard (server.ts) is the terminal belt behind them. (Its label also
      // rides the card summary below.)
      let prof: { label: string; provider: string } | undefined;
      if (a.profileId !== undefined) {
        prof = lookups.getProfile(a.profileId);
        if (!prof) throw new Error(`unknown profileId '${a.profileId}' — list profiles and use an existing id`);
        if (prof.provider !== a.provider) {
          throw new Error(`profile '${a.profileId}' is a ${prof.provider} account but the role targets ${a.provider} — pick a ${a.provider} account or omit profileId`);
        }
        if (lookups.isReservedProfile(a.profileId)) {
          throw new Error(`profile '${a.profileId}' is reserved for the Tower's assistant brain and cannot run a builder — pick another account or omit profileId`);
        }
      }
      // SPEC-EFFORT §5 — the effort must be valid for the role's provider (self-correctable 400 at propose,
      // mirroring profileId). set_routing always carries a concrete provider, so isValidEffort is decisive.
      if (a.effort !== undefined && !isValidEffort(a.provider, a.effort)) {
        throw new Error(`effort '${a.effort}' is not valid for ${a.provider} — claude-code: low/medium/high/xhigh/max; codex: a lowercase token like low/medium/high/xhigh; gemini/shell/custom have no effort surface`);
      }
      // The current assignment is part of what the operator reviews ("replace X with Y"),
      // so it is drift-checked: a routing change behind their back voids the card. For a
      // project scope the "current" value is that project's layered view (§3), tagged with
      // the layer it comes from, since the override lands on top of workflow/global.
      const layers = lookups.getRouting(a.projectId);
      const cur = layers.project?.[a.role] ?? layers.workflow?.[a.role] ?? layers.global[a.role];
      const curFrom = layers.project?.[a.role] ? ' (project)' : layers.workflow?.[a.role] ? ' (workflow)' : layers.global[a.role] ? ' (global)' : '';
      const curText = cur ? `${cur.provider}${cur.model ? ` (${s(cur.model)})` : ''}${cur.effort ? ` @ ${s(cur.effort)}` : ''}${curFrom}` : 'unset';
      return {
        summary: `Route ${a.role} to ${a.provider}${a.model ? ` (${s(a.model)})` : ''}${a.effort ? ` at ${s(a.effort)} effort` : ''}${prof ? ` on account "${s(prof.label)}"` : ''}${scope ? ` for project "${s(scope.name)}"` : ''} — currently ${curText}`,
        denorm: {
          currentProvider: cur?.provider ?? null,
          currentModel: cur?.model ?? null,
          // Only an account-pinning action asserts anything about the current account, so only then
          // does the baseline carry it — account-only re-routes (same provider/model, different
          // pinned account) still drift-void at confirm (proposals.ts compares denorm), while a
          // no-profileId proposal keeps the older {provider, model}-shaped denorm and is never
          // spuriously voided by this field appearing on re-enrich.
          ...(a.profileId !== undefined ? { currentProfileId: cur?.profileId ?? null } : {}),
          // SPEC-EFFORT §5 — same only-assert-when-pinned pattern as currentProfileId: an effort-less
          // proposal keeps the older denorm shape and is never spuriously drift-voided by this field.
          ...(a.effort !== undefined ? { currentEffort: cur?.effort ?? null } : {}),
          ...(scope ? { projectName: scope.name } : {}),
        },
      };
    },
  },
  set_project_workflow: {
    method: 'PUT',
    risk: 'low',
    url: (a) => `/api/projects/${encodeURIComponent(a.projectId)}/routing`,
    payload: async (a, read) => {
      // REPLACE semantics again: selecting a workflow must not clobber the project's ad-hoc
      // per-role overrides, so carry the live routes forward alongside the new workflowId.
      const cur = (await read(`/api/projects/${encodeURIComponent(a.projectId)}/routing`)) as {
        routes?: Record<string, unknown>;
      };
      return { workflowId: a.workflowId, ...(cur.routes !== undefined ? { routes: cur.routes } : {}) };
    },
    enrich: (a, lookups) => {
      const proj = lookups.getProject(a.projectId);
      if (!proj) throw new Error(`unknown projectId '${a.projectId}' — list projects and use an existing id`);
      // Workflow name resolution is best-effort until the store lookup is wired (see
      // ActionLookups.getWorkflow); once wired, an unknown id is self-correctable like any other.
      const wf = lookups.getWorkflow?.(a.workflowId);
      if (lookups.getWorkflow && !wf) {
        throw new Error(`unknown workflowId '${a.workflowId}' — call get_routing and use an existing workflow id`);
      }
      return {
        summary: `Select workflow "${s(wf?.name ?? a.workflowId)}" for project "${s(proj.name)}" — its role routes apply under the project's own overrides`,
        denorm: { projectName: proj.name, workflowName: wf?.name ?? null },
      };
    },
  },
  create_task: {
    method: 'POST',
    risk: 'low',
    url: () => '/api/backlog',
    payload: (a) => {
      const { kind: _kind, ...body } = a;
      return body;
    },
    enrich: (a, lookups) => {
      const proj = lookups.getProject(a.projectId);
      if (!proj) throw new Error(`unknown projectId '${a.projectId}' — list projects and use an existing id`);
      return {
        summary: `Create ${a.status ?? 'triage'} task "${s(a.title)}" in project "${s(proj.name)}"${a.priority !== undefined ? ` (P${a.priority})` : ''}`,
        denorm: { projectName: proj.name },
      };
    },
  },
  update_task: {
    method: 'PUT',
    risk: 'low',
    url: (a) => `/api/backlog/${encodeURIComponent(a.taskId)}`,
    payload: (a) => {
      const { kind: _kind, taskId: _taskId, ...body } = a;
      return body;
    },
    enrich: (a, lookups) => {
      const task = lookups.getTask(a.taskId);
      if (!task) throw new Error(`unknown taskId '${a.taskId}' — list backlog tasks and use an existing id`);
      const changes: string[] = [];
      if (a.title !== undefined) changes.push(`title → "${s(a.title)}"`);
      if (a.body !== undefined) changes.push('body updated');
      if (a.priority !== undefined) changes.push(a.priority === null ? 'priority cleared' : `priority → P${a.priority}`);
      if (a.status !== undefined) changes.push(`status → ${a.status}`);
      return {
        summary: `Update ${task.status} task "${s(task.title)}": ${changes.join(', ')}`,
        denorm: { taskTitle: task.title, taskStatus: task.status },
      };
    },
  },
  clear_finished: {
    method: 'POST',
    risk: 'medium',
    url: () => '/api/board/clear-finished',
    payload: () => undefined,
    enrich: (_a, lookups) => {
      // The LIVE count is the card's whole content — echoed at propose time, re-derived at
      // confirm; any change in between (a loop finished meanwhile) aborts as drift (§2).
      const n = lookups.finishedCounts();
      return {
        summary: `Archive ${n.loops} finished loop(s) and ${n.missions} finished mission(s) from the board`,
        denorm: { finishedLoops: n.loops, finishedMissions: n.missions },
      };
    },
  },
  create_loop: {
    method: 'POST',
    risk: 'high',
    url: () => '/api/loops',
    payload: (a) => {
      const { kind: _kind, ...body } = a;
      return body;
    },
    enrich: (a, lookups) => {
      const proj = lookups.getProject(a.projectId);
      if (!proj) throw new Error(`unknown projectId '${a.projectId}' — list projects and use an existing id`);
      if (a.provider !== undefined && !lookups.hasProvider(a.provider)) {
        throw new Error(`unknown provider '${a.provider}' — list providers and use an existing id`);
      }
      // SPEC-EFFORT §5 — gate effort ONLY when a provider is present (isValidEffort needs it); a
      // provider-less effort defers to loops.create where resolveRouting picks the provider.
      if (a.effort !== undefined && a.provider !== undefined && !isValidEffort(a.provider, a.effort)) {
        throw new Error(`effort '${a.effort}' is not valid for ${a.provider} — claude-code: low/medium/high/xhigh/max; codex: a lowercase token like low/medium/high/xhigh`);
      }
      // Resolve the account this loop would SPAWN under (same chain + probe as the /api/loops start
      // gate) and gate on it at PROPOSE time so a confirmed loop always spawns instead of 400ing on
      // an empty shared login. Re-run at confirm, this is also the drift gate: an account signed out
      // between propose and confirm voids the card.
      const view = lookups.resolveLoopAccount({ projectId: a.projectId, provider: a.provider, profileId: a.profileId });
      // Explicit-account gates mirror validateRoute's start-gate hard errors as self-correctable
      // 400s at propose (routing.ts:401-415) instead of a failed confirmed card.
      if (a.profileId !== undefined) {
        const prof = lookups.getProfile(a.profileId);
        if (!prof) throw new Error(`unknown profileId '${a.profileId}' — call list_profiles and use an existing id`);
        if (prof.provider !== view.provider) {
          throw new Error(`profile '${a.profileId}' is a ${prof.provider} account but this loop resolves to ${view.provider} — pass a signed-in ${view.provider} account from list_profiles, or set provider to ${prof.provider}`);
        }
      }
      // Brain refusal on the explicit AND the resolved account (today only the explicit one can be an
      // account — no role tiers on this surface — but checking the resolution closes the path however
      // it arrives). Same refusal the set_routing enrich raises for a reserved profile.
      if (a.profileId !== undefined && lookups.isReservedProfile(a.profileId)) {
        throw new Error(`profile '${a.profileId}' is reserved for the Tower's assistant brain and cannot run a builder — pick another account or omit profileId`);
      }
      if (view.profileId !== undefined && lookups.isReservedProfile(view.profileId)) {
        throw new Error(`profile '${view.profileId}' is reserved for the Tower's assistant brain and cannot run a builder — pick another account or omit profileId`);
      }
      // THE load-bearing gate: refuse exactly when the spawn probe would ('missing' — see
      // assertAuthenticated / accountCredentialProbe). 'unverifiable' (CT_SKIP_AUTH_PROBE,
      // login-mode custom) spawns with a warning there, so it passes here — annotated, never refused.
      if (view.verdict === 'missing') {
        const who = view.profileId !== undefined ? `account "${s(view.label)}"` : `the shared ${view.provider} login`;
        const keys = view.missingKeys?.length ? ` (missing ${view.missingKeys.join(', ')})` : '';
        const fix = view.signedInProfiles.length > 0
          ? `pass profileId of a signed-in ${view.provider} account from list_profiles: ${view.signedInProfiles.slice(0, 5).map((p) => `${p.id} ("${s(p.label)}")`).join(', ')}`
          : `no ${view.provider} account is signed in — propose create_profile then open_login, or the operator can sign in via Settings → Connections`;
        throw new Error(`this loop would run as ${who}, which is not signed in${keys} and would fail to spawn — ${fix}`);
      }
      const runsAs = view.profileId !== undefined ? `account "${s(view.label)}"` : `the shared ${view.provider} login`;
      return {
        summary: `Start autonomous loop "${s(a.name)}" in project "${s(proj.name)}"${a.provider ? ` on ${a.provider}${a.model ? ` (${s(a.model)})` : ''}` : ''}${a.effort ? ` at ${s(a.effort)} effort` : ''} — runs as ${runsAs}${view.verdict === 'unverifiable' ? ' (credentials unverified)' : ''}${a.checkCommand ? ' — runs a host shell check command each iteration' : ''}`,
        // runsAs* UNCONDITIONAL: the card always asserts the account, so it is always drift-baselined
        // (a sign-out flips the verdict and THROWS above; an account swap flips these and voids). A
        // pre-upgrade pending card gains keys and voids once — fail-safe.
        denorm: { projectName: proj.name, runsAsProfileId: view.profileId ?? null, runsAsLabel: view.label },
      };
    },
  },
  create_project: {
    method: 'POST',
    // HIGH, and the rating is pure card chrome (riskOf's only consumer stamps the chip; autoConfirm
    // never reads it) — which is exactly why it must be high: requiresHumanConfirm makes the CARD the
    // whole defense, and the dock's warning block renders only at 'high'. create_loop is high because
    // it starts an autonomous agent; this decides WHERE such an agent may ever run.
    risk: 'high',
    url: () => '/api/projects',
    payload: (a) => ({
      name: a.name,
      repoPath: a.repoPath,
      ...(a.repoUrl !== undefined ? { repoUrl: a.repoUrl } : {}),
      ...(a.defaultIdentityId !== undefined ? { defaultIdentityId: a.defaultIdentityId } : {}),
    }),
    enrich: (a, lookups) => {
      // Every gate here exists to hand the brain a self-correctable 400 at PROPOSE time instead of a
      // confusing failure later — and, re-run at confirm, they are also the drift gate (a path that
      // vanished or now conflicts aborts the stale card).
      //
      // Unsafe-char check FIRST: every throw below interpolates the raw arg, so reject-or-scrub has to
      // precede any message that echoes it. Rejecting (not stripping) is the point — the operator must
      // approve the exact string that gets stored and later derived into filesystem paths, where control
      // bytes are hostile no matter how the card renders them.
      if (!rendersAsWritten(a.repoPath) || !rendersAsWritten(a.name)) {
        throw new Error('name and repoPath must render exactly as written — no control characters, unusual whitespace, or repeated spaces');
      }
      // normalizeRepoPath deliberately leaves relative input alone so it reaches this gate rather than
      // being silently resolved against the daemon's working directory.
      if (!a.repoPath.startsWith('/')) {
        throw new Error(`repoPath '${a.repoPath}' must be an absolute path (a relative path would resolve against the Tower's own working directory)`);
      }
      if (!existsSync(a.repoPath)) throw new Error(`repoPath '${a.repoPath}' does not exist on this host`);
      // Resolve symlinks before the worktree-zone test: a literal-string check alone is fooled by a link
      // whose TARGET lives in a disposable worktree. Sync, so the all-synchronous enrich contract holds.
      let real: string;
      try {
        real = realpathSync(a.repoPath);
      } catch {
        throw new Error(`repoPath '${a.repoPath}' does not exist on this host`);
      }
      // A Tower-managed worktree is disposable — land/reap deletes it — so registering one would lose the
      // work with it. Checked on BOTH the literal and the link-resolved path.
      const worktreeSegment = `/${CT_WORKTREES_DIRNAME}/`;
      if (a.repoPath.includes(worktreeSegment) || real.includes(worktreeSegment)) {
        throw new Error(`repoPath '${a.repoPath}' is inside a Tower-managed worktree — those are disposable (deleted on land/reap); point at the source repository instead`);
      }
      // One gate for all three collisions. Nesting either way is harmful, because a project's worktree
      // root is derived from dirname(repoPath): one project's live worktrees would sit inside another's
      // working tree, where a repo-root `git add -A` sweeps them into commits.
      // Probe BOTH the literal and the link-resolved path. Literal first: if a STORED path is itself a
      // symlink, re-proposing that same literal is only caught by literal-vs-literal equality. Then the
      // resolved path, which catches an ALIAS of a registered repo ('~/work/repo' where work → /x, vs a
      // stored '/x/repo') — registering that twice would put two projects' agents in one working tree,
      // where land/reap on one commits over the other's uncommitted work. `real` is already computed, so
      // this costs no extra fs calls. Residual: a stored path that is itself a symlink is not resolved
      // (that needs realpath over every stored record, per enrich — ruled out on cost).
      const clash =
        lookups.projectPathConflict(a.repoPath) ??
        (real !== a.repoPath ? lookups.projectPathConflict(real) : undefined);
      if (clash) {
        if (clash.relation === 'same') {
          throw new Error(`repoPath '${a.repoPath}' is already registered as project '${s(clash.name)}'`);
        }
        if (clash.relation === 'contains') {
          throw new Error(`repoPath '${a.repoPath}' is inside project '${s(clash.name)}' — nested projects corrupt each other's worktrees; register the outer repository's root, or a path outside it`);
        }
        throw new Error(`repoPath '${a.repoPath}' contains project '${s(clash.name)}' — nested projects corrupt each other's worktrees; register a path that does not enclose an existing project`);
      }
      // `.git` is a dir in a normal repo and a FILE in a linked worktree — existsSync accepts both. A repo
      // SUBDIRECTORY has no .git and is rejected (stricter than the UI, and right: worktrees need the repo
      // root). A commitless repo still passes and fails cleanly at loop create (400, no dangling record) —
      // sync commit-detection is too fragile to be worth it.
      if (!existsSync(join(a.repoPath, '.git'))) {
        throw new Error(`repoPath '${a.repoPath}' is not a git repository root — point at the repository root, or run 'git init' plus one initial commit there first`);
      }
      // Optional per-project GitHub config. repoUrl is reject-not-scrubbed (same posture as name/repoPath:
      // a control byte in a value later shown/stored is hostile however it renders) then shape-validated.
      // defaultIdentityId must resolve to a real identity — a self-correctable 400 at propose, and the
      // re-run at confirm is the drift gate (a renamed/deleted identity voids the card).
      let ghSummary = '';
      let identityLabel: string | null = null;
      if (a.repoUrl !== undefined) {
        if (!rendersAsWritten(a.repoUrl)) {
          throw new Error('repoUrl must render exactly as written — no control characters, unusual whitespace, or repeated spaces');
        }
        const v = validateRepoUrl(a.repoUrl);
        if (!v.ok) throw new Error(v.error);
        ghSummary += `, repo ${s(a.repoUrl, 512)}`;
      }
      if (a.defaultIdentityId !== undefined) {
        const idn = lookups.getIdentity(a.defaultIdentityId);
        if (!idn) throw new Error(`unknown identity '${a.defaultIdentityId}' — call list_identities and use an existing id`);
        identityLabel = idn.label;
        ghSummary += `, pushing as "${s(idn.label)}"${idn.hasCredential ? '' : ' (no push token)'}`;
      }
      return {
        // The path is capped at the zod's own 512 rather than sanitizeInline's 80-char default: this card
        // is the whole defense for an always-human-confirmed action, so the one line the operator reads
        // must never truncate the value being approved.
        // Both args are capped at their OWN zod limits rather than sanitizeInline's 80-char default: this
        // card is the whole defense for an always-human-confirmed action, so the one line the operator
        // reads must never truncate either value being approved.
        summary: `Register project "${s(a.name, 120)}" at ${s(a.repoPath, 512)}${ghSummary} — agents may then be started in this repository`,
        // identityLabel is the one LIVE-resolved value this card carries when a default identity is set, so
        // it is baselined for drift (a rename/delete between propose and confirm voids the card). With no
        // identity it stays {} — every other displayed value is action-derived, and a denorm of an immutable
        // action could never trip. Real path/conflict drift is what the re-run gates above THROW on.
        denorm: { ...(identityLabel !== null ? { identityLabel } : {}) },
      };
    },
  },
  set_project_github: {
    method: 'POST',
    // Low: it does NOT widen where agents run (a project must already exist) — it only repoints which
    // stored identity a project pushes/commits as, and every referenced id is enrich-validated.
    risk: 'low',
    url: (a) => `/api/projects/${encodeURIComponent(a.projectId)}/github`,
    payload: (a) => {
      const { kind: _kind, projectId: _projectId, ...body } = a;
      return body;
    },
    enrich: (a, lookups) => {
      const proj = lookups.getProject(a.projectId);
      if (!proj) throw new Error(`unknown projectId '${a.projectId}' — list projects and use an existing id`);
      const changes: string[] = [];
      let identityLabel: string | null = null;
      let identityHasCredential: boolean | null = null;
      if (a.repoUrl !== undefined) {
        if (a.repoUrl === null || a.repoUrl === '') {
          changes.push('repo URL cleared');
        } else {
          if (!rendersAsWritten(a.repoUrl)) {
            throw new Error('repoUrl must render exactly as written — no control characters, unusual whitespace, or repeated spaces');
          }
          const v = validateRepoUrl(a.repoUrl);
          if (!v.ok) throw new Error(v.error);
          changes.push(`repo → ${s(a.repoUrl, 512)}`);
        }
      }
      if (a.defaultIdentityId !== undefined) {
        if (a.defaultIdentityId === null || a.defaultIdentityId === '') {
          changes.push('identity cleared');
        } else {
          const idn = lookups.getIdentity(a.defaultIdentityId);
          if (!idn) throw new Error(`unknown identity '${a.defaultIdentityId}' — call list_identities and use an existing id`);
          identityLabel = idn.label;
          identityHasCredential = idn.hasCredential;
          changes.push(`identity → "${s(idn.label)}"${idn.hasCredential ? '' : ' (no push token)'}`);
        }
      }
      return {
        summary: `Set GitHub config for project "${s(proj.name)}": ${changes.join(', ')}`,
        denorm: {
          projectName: proj.name,
          ...(identityLabel !== null ? { identityLabel } : {}),
          ...(identityHasCredential !== null ? { identityHasCredential: identityHasCredential ? 1 : 0 } : {}),
        },
      };
    },
  },
  init_project_repo: {
    method: 'POST',
    // HIGH for the same reason as create_project: the card is the whole defense for an always-human-
    // confirmed action. This one both writes the filesystem AND pushes outward.
    risk: 'high',
    url: (a) => `/api/projects/${encodeURIComponent(a.projectId)}/bootstrap`,
    // No payload: the route treats an absent body as acceptWarnings:false — the assistant path can never
    // pre-acknowledge preflight warnings; a warning-y tree 409s at confirm and directs the operator to
    // the UI preview.
    payload: () => undefined,
    enrich: (a, lookups) => {
      const proj = lookups.getProject(a.projectId);
      if (!proj) throw new Error(`unknown projectId '${a.projectId}' — list projects and use an existing id`);
      if (!proj.repoUrl) throw new Error(`project "${proj.name}" has no GitHub repo URL — propose set_project_github first`);
      if (!proj.defaultIdentityId) throw new Error(`project "${proj.name}" has no default GitHub identity — propose set_project_github with an identity from list_identities`);
      const idn = lookups.getIdentity(proj.defaultIdentityId);
      if (!idn) throw new Error(`project "${proj.name}" points at an unknown identity — re-set it via set_project_github`);
      if (!idn.hasCredential) throw new Error(`identity "${idn.label}" has no push token — the operator must add one in Connections → GitHub identities`);
      if (existsSync(join(proj.repoPath, '.git'))) throw new Error(`${proj.repoPath} is already a git repository — bootstrap is only for a project directory with no repo`);
      return {
        summary: `Initialize a git repository at ${s(proj.repoPath, 512)}, commit its current files behind a generated .gitignore (secrets and junk excluded, .local-context/ kept local), and push branch main to ${s(proj.repoUrl, 512)} as "${s(idn.label)}"`,
        // All three are LIVE values the card asserts — a changed repoUrl, a re-pointed/renamed identity,
        // or a revoked token between propose and confirm voids the card.
        denorm: { projectName: proj.name, repoUrl: proj.repoUrl, identityLabel: idn.label, identityHasCredential: 1 },
      };
    },
  },
  bootstrap_project: {
    method: 'POST',
    risk: 'high',
    url: () => '/api/projects/bootstrap',
    payload: (a) => ({ name: a.name, repoPath: a.repoPath, repoUrl: a.repoUrl, defaultIdentityId: a.defaultIdentityId }),
    enrich: (a, lookups) => {
      // create_project's path gates, then the .git check INVERTED (refuse when .git EXISTS), then
      // init_project_repo's identity/token gates. rendersAsWritten FIRST (later throws echo raw args).
      if (!rendersAsWritten(a.repoPath) || !rendersAsWritten(a.name)) {
        throw new Error('name and repoPath must render exactly as written — no control characters, unusual whitespace, or repeated spaces');
      }
      if (!a.repoPath.startsWith('/')) {
        throw new Error(`repoPath '${a.repoPath}' must be an absolute path (a relative path would resolve against the Tower's own working directory)`);
      }
      if (!existsSync(a.repoPath)) throw new Error(`repoPath '${a.repoPath}' does not exist on this host`);
      let real: string;
      try {
        real = realpathSync(a.repoPath);
      } catch {
        throw new Error(`repoPath '${a.repoPath}' does not exist on this host`);
      }
      const worktreeSegment = `/${CT_WORKTREES_DIRNAME}/`;
      if (a.repoPath.includes(worktreeSegment) || real.includes(worktreeSegment)) {
        throw new Error(`repoPath '${a.repoPath}' is inside a Tower-managed worktree — those are disposable (deleted on land/reap); point at the source directory instead`);
      }
      // Refuse the Tower's own data dir (~/.ct): it holds credential files (ghcred-*, mcptok-assistant,
      // *tok-*) that executeBootstrap's by-name secret scan does NOT recognize, so a prompt-injected
      // propose of `~/.ct/secrets` could commit+push them behind one inattentive Confirm. Check BOTH the
      // literal and the link-resolved path, like the worktree gate above.
      const ctHome = normalizeRepoPath(paths.home);
      if (a.repoPath === ctHome || a.repoPath.startsWith(`${ctHome}/`) || real === ctHome || real.startsWith(`${ctHome}/`)) {
        throw new Error(`repoPath '${a.repoPath}' is inside the Tower's own data directory (~/.ct) — it holds credentials and internal state and is never a project; point at a source directory instead`);
      }
      const clash = lookups.projectPathConflict(a.repoPath) ?? (real !== a.repoPath ? lookups.projectPathConflict(real) : undefined);
      if (clash) {
        if (clash.relation === 'same') {
          throw new Error(`repoPath '${a.repoPath}' is already registered as project '${s(clash.name)}' — propose init_project_repo for it instead`);
        }
        if (clash.relation === 'contains') {
          throw new Error(`repoPath '${a.repoPath}' is inside project '${s(clash.name)}' — nested projects corrupt each other's worktrees; register the outer repository's root, or a path outside it`);
        }
        throw new Error(`repoPath '${a.repoPath}' contains project '${s(clash.name)}' — nested projects corrupt each other's worktrees; register a path that does not enclose an existing project`);
      }
      // INVERTED from create_project's git-repo-required gate — bootstrap is only for a folder with NO repo.
      if (existsSync(join(a.repoPath, '.git'))) {
        throw new Error(`${a.repoPath} is already a git repository — propose create_project to register it instead`);
      }
      if (!rendersAsWritten(a.repoUrl)) {
        throw new Error('repoUrl must render exactly as written — no control characters, unusual whitespace, or repeated spaces');
      }
      const v = validateRepoUrl(a.repoUrl);
      if (!v.ok) throw new Error(v.error);
      const idn = lookups.getIdentity(a.defaultIdentityId);
      if (!idn) throw new Error(`unknown identity '${a.defaultIdentityId}' — call list_identities and use an existing id`);
      if (!idn.hasCredential) throw new Error(`identity "${idn.label}" has no push token — the operator must add one in Connections → GitHub identities`);
      return {
        summary: `Register project "${s(a.name, 120)}" at ${s(a.repoPath, 512)} AND initialize a git repository there: commit its current files behind a generated .gitignore (secrets and junk excluded, .local-context/ kept local), then push branch main to ${s(a.repoUrl, 512)} as "${s(idn.label)}". If the folder tree has warnings (large files, a nested repo), this refuses — register it via "+ project" and use Initialize & push instead.`,
        denorm: { identityLabel: idn.label, identityHasCredential: 1 },
      };
    },
  },
  set_project_autonomy: {
    method: 'POST',
    // HIGH and always-human-confirmed (reasonForHumanConfirm): the card is the whole defense, and this
    // decides whether agents in the project run WITHOUT the per-command permission gate.
    risk: 'high',
    url: (a) => `/api/projects/${encodeURIComponent(a.projectId)}/auto-accept`,
    payload: (a) => ({ enabled: a.enabled }),
    enrich: (a, lookups) => {
      const proj = lookups.getProject(a.projectId);
      if (!proj) throw new Error(`unknown projectId '${a.projectId}' — list projects and use an existing id`);
      const cur = proj.defaultAutoAccept === true; // absent and false are the same OFF
      const curText = cur ? 'autonomous' : 'asks first';
      return {
        summary: a.enabled
          ? `Set project "${s(proj.name)}" AUTONOMOUS: new claude-code work terminals and loop iterations run with the permission gate OFF (--dangerously-skip-permissions; first-run bypass acceptance is seeded per account) — currently ${curText}`
          : `Require approval again for project "${s(proj.name)}": new work terminals keep the per-command permission gate — currently ${curText}`,
        // The drift baseline: the flag flipping between propose and confirm voids the card. Read === true
        // so the route's drop-key-on-false persistence can never split absent vs false into spurious drift.
        denorm: { projectName: proj.name, currentAutoAccept: cur ? 1 : 0 },
      };
    },
  },
  set_skill_enabled: {
    method: 'POST',
    // HIGH and always-human-confirmed (reasonForHumanConfirm): the card is the whole defense, and enabling
    // a skill fans its instructions into EVERY future claude-code/codex/gemini agent.
    risk: 'high',
    url: (a) => `/api/skills/${encodeURIComponent(a.skillId)}/enabled`,
    payload: (a) => ({ enabled: a.enabled }),
    enrich: (a, lookups) => {
      const sk = lookups.getSkill(a.skillId);
      if (!sk) throw new Error(`unknown skillId '${a.skillId}' — call list_skills and use an existing id`);
      // Protected refusal (the reserved-brain-account clone, keyed on protection): a skill enforcing a
      // blocking gate (or operator-locked) can never be toggled through the assistant — refused at enrich,
      // so it never even becomes a pending card; the re-run at confirm drift-aborts a card whose target was
      // protected after propose.
      if (sk.protected) {
        throw new Error(`skill '${a.skillId}' is a protected gate and cannot be changed through the assistant — change it in Settings → Skills`);
      }
      const curText = sk.enabled ? 'enabled' : 'disabled';
      return {
        summary: a.enabled
          ? `Enable skill "${s(sk.name)}": it materializes into every future claude-code/codex/gemini agent — currently ${curText}`
          : `Disable skill "${s(sk.name)}": it stops materializing into future claude-code/codex/gemini agents — currently ${curText}`,
        // contentHash in the baseline voids the card on an operator body-edit between propose and confirm,
        // not just an enabled flip — the operator approves the exact skill they reviewed.
        denorm: { skillName: sk.name, currentEnabled: sk.enabled ? 1 : 0, contentHash: sk.contentHash },
      };
    },
  },
  set_project_skills: {
    method: 'PUT',
    // HIGH and always-human-confirmed: it changes which skill instructions reach this project's future
    // agents. The overlay PUT is a REPLACE and the overlay IS exactly {bundleId, enable}, so the action
    // carries the WHOLE overlay — the card honestly shows the full replacement, no read-modify-write.
    risk: 'high',
    url: (a) => `/api/projects/${encodeURIComponent(a.projectId)}/skills`,
    payload: (a) => ({
      // null/''/absent bundleId → omit (clear-to-inherit); the route's setProjectSkills rejects a non-string
      // bundleId, so a literal null must never ride the payload.
      ...(typeof a.bundleId === 'string' && a.bundleId !== '' ? { bundleId: a.bundleId } : {}),
      ...(a.enable !== undefined ? { enable: a.enable } : {}),
    }),
    enrich: (a, lookups) => {
      const proj = lookups.getProject(a.projectId);
      if (!proj) throw new Error(`unknown projectId '${a.projectId}' — list projects and use an existing id`);
      let bundleName: string | null = null;
      if (typeof a.bundleId === 'string' && a.bundleId !== '') {
        const b = lookups.getBundle(a.bundleId);
        if (!b) throw new Error(`unknown bundleId '${a.bundleId}' — call list_skills and use an existing bundle id`);
        bundleName = b.name;
      }
      // Every referenced skill must resolve (the resolver's dangling-tolerance is for restores, not fresh
      // model input) AND none may be protected — either polarity is refused (one honest rule; turning a
      // protected skill ON is benign but a polarity carve-out invites a bug, the set_project_autonomy
      // argument). This closes selection sabotage: a protected gate can't be disabled via the enable map.
      const overrides = a.enable ?? {};
      for (const sid of Object.keys(overrides)) {
        const sk = lookups.getSkill(sid);
        if (!sk) throw new Error(`unknown skill '${sid}' in the enable map — call list_skills and use existing ids`);
        if (sk.protected) {
          throw new Error(`skill '${sid}' is a protected gate and cannot be changed through the assistant — change it in Settings → Skills`);
        }
      }
      const cur = lookups.getProjectSkills(a.projectId);
      // Completeness against REPLACE-by-omission: the loop above only sees skills the proposal NAMES, but the
      // PUT is a FULL overlay replace — omitting a protected skill (or the bare {projectId} reset) silently
      // drops it from the project's EFFECTIVE resolved set. Diff current vs proposed effective sets and refuse
      // if a protected member would leave. Re-run at confirm, this also drift-guards a skill protected (or
      // newly effective) after propose.
      const proposedOverlay = {
        ...(typeof a.bundleId === 'string' && a.bundleId !== '' ? { bundleId: a.bundleId } : {}),
        ...(a.enable !== undefined ? { enable: a.enable } : {}),
      };
      const delta = lookups.projectSkillReplaceDelta(a.projectId, proposedOverlay);
      if (delta.droppedProtected.length) {
        throw new Error(
          `this selection would remove protected skill(s) from project "${s(proj.name)}"'s effective set: ${delta.droppedProtected.map((n) => `"${s(n)}"`).join(', ')} — a protected skill can't be dropped through the assistant; change it in Settings → Skills`,
        );
      }
      const curBundleId = cur?.bundleId ?? null;
      const curBundleText = curBundleId ? `bundle "${s(lookups.getBundle(curBundleId)?.name ?? curBundleId)}"` : 'no bundle';
      const nOverrides = Object.keys(overrides).length;
      const mOverrides = Object.keys(cur?.enable ?? {}).length;
      // Make a destructive REPLACE visible on the card: name the (non-protected) skills leaving the effective
      // set, capped so the one-line summary stays bounded.
      const dropNote = delta.dropped.length
        ? ` — drops ${delta.dropped.length} effective skill(s): ${delta.dropped.slice(0, 5).map((n) => `"${s(n)}"`).join(', ')}${delta.dropped.length > 5 ? ', …' : ''}`
        : '';
      return {
        summary:
          `Set skills for project "${s(proj.name)}": ${bundleName ? `bundle "${s(bundleName)}"` : 'no bundle'} + ${nOverrides} per-skill override(s) — ` +
          `replaces the current overlay (${curBundleText}, ${mOverrides} override(s))${dropNote}`,
        // The drift baseline: the operator changing this project's overlay between propose and confirm voids
        // the card. currentEnableJson is order-independent so a same-content re-enrich never false-drifts.
        denorm: { projectName: proj.name, currentBundleId: curBundleId, currentEnableJson: canonEnableJson(cur?.enable) },
      };
    },
  },
  promote_skill: {
    method: 'POST',
    // HIGH and always-human-confirmed (reasonForHumanConfirm): the card is the whole defense, and the
    // published body is LLM-authored instructions that — once the operator ALSO enables the skill —
    // reach every future agent. The payload carries the PINNED hash, which is what makes the route
    // belt airtight: what executes is byte-identical to what the card's diff showed.
    risk: 'high',
    url: () => '/api/skills/promote-draft',
    payload: (a) => ({ draftId: a.draftId, contentHash: a.contentHash }),
    // Why the Edit-override hole does NOT open here (SPEC-SKILLS Phase 5b): confirm(id, override)
    // skips the denorm drift compare for an edited action, but an override still runs enrich(cand) —
    // and step 2 below compares the candidate's contentHash against the LIVE draft hash. A stale or
    // fabricated hash throws (400, proposal stays pending); a "fresh" hash only validates against the
    // draft's CURRENT content, which the promote route then re-verifies with no await gap. The dock
    // additionally hides Edit for this kind — its two args are machine tokens with no human-editable
    // meaning.
    enrich: (a, lookups) => {
      // 1. The draft must exist and still be open (self-correctable 400 at propose; drift-abort at
      //    confirm — a discarded/promoted draft voids the card).
      const d = lookups.getSkillDraft(a.draftId);
      if (!d) throw new Error(`unknown draftId '${a.draftId}' — call save_skill_draft first (or list your drafts)`);
      if (d.status !== 'open') throw new Error(`draft '${a.draftId}' is already promoted — save a new draft`);
      // 2. The ACTION's own pin against the live draft (see the Edit-override note above).
      if (a.contentHash !== d.contentHash) {
        throw new Error("the draft changed since you read it — re-read save_skill_draft's returned contentHash and re-propose");
      }
      // 3. Target resolution. NO implicit retargeting: an explicit assistant-origin targetSkillId, or
      //    a fresh slug — nothing in between.
      let targetId: string;
      let target: { name: string; enabled: boolean; protected: boolean; contentHash: string; origin: SkillOrigin } | undefined;
      if (d.targetSkillId !== undefined) {
        target = lookups.getSkill(d.targetSkillId);
        if (!target) {
          throw new Error(`unknown target skill '${d.targetSkillId}' — clear the draft's targetSkillId to create a new skill, or target an existing assistant-authored skill from list_skills`);
        }
        // The 5a protected refusal, keyed on the SAME derived predicate: a protected skill's body is
        // load-bearing (code-review) — refused even though only meta+body would change.
        if (target.protected) {
          throw new Error(`skill '${d.targetSkillId}' is a protected gate and cannot be changed through the assistant — change it in Settings → Skills`);
        }
        if (target.origin !== 'assistant') {
          throw new Error(`skill '${d.targetSkillId}' was authored by the operator/importer — the assistant only updates skills it authored; the operator edits this one in Settings → Skills`);
        }
        targetId = d.targetSkillId;
      } else {
        const slug = slugifySkillName(d.name);
        if (!isSafeName(slug)) throw new Error(`cannot derive a valid skill id from the draft name "${s(d.name)}" — rename the draft`);
        if (isReservedSkillId(slug)) throw new Error(`'${slug}' is a reserved skill id — rename the draft`);
        if (lookups.getSkill(slug)) {
          throw new Error(`a skill with id '${slug}' already exists — set targetSkillId to update it (assistant-origin only), or rename the draft`);
        }
        targetId = slug;
      }
      return {
        // In lockstep with the promote route's enable expression (SPEC-SKILLS Phase 5b wave 2): a NEW
        // skill lands disabled; an UPDATE keeps the target's enable state (the targetEnabled pin below
        // voids the card if the operator flips it mid-flight). Both paths state the autonomy boundary:
        // an assistant-authored body never reaches a skip-permissions agent until the operator clears it,
        // and any content change — this promote included — resets that clearance.
        summary: `Publish assistant-drafted skill "${s(d.name)}" — ${
          target
            ? `updates "${s(target.name)}" — ${target.enabled ? 'stays enabled: interactive agents get the new body next spawn' : 'stays disabled until you enable it (Settings → Skills)'}`
            : `as NEW skill '${targetId}' — lands DISABLED until you enable it (Settings → Skills)`
        } — reaches every future claude-code/codex/gemini agent that selects it; skip-permissions agents never see it until you clear autonomy (Settings → Skills)`,
        // The DOUBLE PIN. draftHash: the assistant edits the draft after proposing (it holds the
        // draft-write route!) ⇒ this differs at confirm's re-enrich ⇒ drift-void. targetHash/targetId:
        // the operator edits the target skill, protection/origin flips, or a skill appears at the slug
        // ⇒ the re-enrich throws or these differ ⇒ drift-void. targetEnabled: setEnabled moves no
        // contentHash, and the promote route COPIES the target's current enable state (create lands
        // disabled; an update keeps the target's state — SPEC-SKILLS Phase 5b wave 2) — the pin is
        // LOAD-BEARING precisely because of that copy: it makes the card's "stays enabled/disabled"
        // phrase match what executes. Without it an operator flip between propose and confirm would
        // silently change which fan-out the Confirm click grants (an enable flip would turn a
        // reviewed-as-dormant update into an immediately-live one) with no drift signal; with it, the
        // intervening flip voids the card. Rendered == executed.
        denorm: {
          draftHash: d.contentHash,
          targetId,
          targetHash: target?.contentHash ?? null,
          targetName: target?.name ?? null,
          targetEnabled: target ? (target.enabled ? 1 : 0) : null,
        },
      };
    },
  },
  close_terminal: {
    method: 'POST',
    // HIGH: destroys a live agent pane (tmux session + hook/broker tokens + worktree leases via the
    // kill fan-out) and FAILS any loop still bound to it — and the card is the whole defense for an
    // always-human-confirmed action (the dock's warning block renders only at 'high').
    risk: 'high',
    url: (a) => `/api/terminals/${encodeURIComponent(a.terminalId)}/kill`,
    payload: () => undefined,
    enrich: (a, lookups) => {
      const t = terminalActionTarget(a.terminalId, 'close', lookups);
      // The loop consequence is stated VERBATIM on the card — the operator approves the loop
      // failure, not just the pane close.
      const loopNote = t.owningLoop
        ? ` — closing this terminal FAILS loop "${s(t.owningLoop.name)}" (${t.owningLoop.status}, iteration ${t.owningLoop.iteration})`
        : '';
      return {
        summary: `Close terminal "${s(t.title)}" (${t.provider}, ${t.state}) in project "${s(t.projectName)}" — its session ends and its resources are released${loopNote}`,
        // The drift baseline: a state flip, a repurpose, or the owning loop appearing/vanishing/
        // changing status between propose and confirm voids the card. purpose reads ?? 'work' so the
        // store's absent-means-work convention can never split into spurious drift.
        denorm: {
          title: t.title,
          provider: t.provider,
          state: t.state,
          purpose: t.purpose ?? 'work',
          projectName: t.projectName,
          owningLoopId: t.owningLoop?.id ?? null,
          owningLoopStatus: t.owningLoop?.status ?? null,
        },
      };
    },
  },
  update_provider_cli: {
    method: 'POST',
    // HIGH: runs a CLI's own self-updater ON THE HOST (downloads + swaps the binary), always
    // human-confirmed (reasonForHumanConfirm). No target to drift against — it always installs latest —
    // so denorm is empty. Running panes keep their version until they respawn; only future spawns pick
    // up the new one (stated on the card so the operator isn't surprised nothing restarts).
    risk: 'high',
    url: () => '/api/system/cli-update',
    payload: (a) => ({ provider: a.provider }),
    enrich: (a) => ({
      summary: `Update the ${a.provider} CLI to the latest version on this host — runs its own self-updater; running agent panes keep their current version until they respawn`,
      denorm: {},
    }),
  },
  restart_terminal: {
    method: 'POST',
    // Medium: unlike close, everything SURVIVES (worktree, account login, hook wiring, and the loop
    // binding — a bound loop stays running and re-arms its current iteration; SPEC-RESTART Wave 0);
    // only the in-flight turn is discarded. Still always-human-confirmed (reasonForHumanConfirm).
    risk: 'medium',
    url: (a) => `/api/terminals/${encodeURIComponent(a.terminalId)}/restart`,
    payload: () => undefined,
    enrich: (a, lookups) => {
      const t = terminalActionTarget(a.terminalId, 'restart', lookups);
      const loopNote = t.owningLoop
        ? ` — restarts the builder pane of loop "${s(t.owningLoop.name)}" — the in-flight turn is discarded; committed work and the worktree survive`
        : ' — relaunches its CLI in place; the in-flight turn is discarded';
      const resumeNote = t.provider === 'claude-code' ? ' — for claude-code the conversation resumes' : '';
      return {
        summary: `Restart terminal "${s(t.title)}" (${t.provider}, ${t.state}) in project "${s(t.projectName)}"${loopNote}${resumeNote}`,
        // close_terminal's baseline PLUS the loop iteration: a restart re-runs the CURRENT
        // iteration, so a loop that gated/continued/failed/finished — or merely advanced an
        // iteration — between propose and confirm changes what the Confirm click would do and
        // must void the card.
        denorm: {
          title: t.title,
          provider: t.provider,
          state: t.state,
          purpose: t.purpose ?? 'work',
          projectName: t.projectName,
          owningLoopId: t.owningLoop?.id ?? null,
          owningLoopStatus: t.owningLoop?.status ?? null,
          owningLoopIteration: t.owningLoop?.iteration ?? null,
        },
      };
    },
  },
};

// Per-kind narrowing is enforced where the table is DEFINED (the mapped type above); at the
// dispatch site the entry is used with the already-matching action, so widening is safe.
interface AnyEntry {
  method: 'POST' | 'PUT';
  risk: 'low' | 'medium' | 'high';
  url(action: AssistantAction): string;
  payload(action: AssistantAction, read: RouteReader): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  enrich(action: AssistantAction, lookups: ActionLookups): Enrichment;
}
function entryFor(action: AssistantAction): AnyEntry {
  return CATALOG[action.kind] as unknown as AnyEntry;
}

export function riskOf(action: AssistantAction): 'low' | 'medium' | 'high' {
  return CATALOG[action.kind].risk;
}

/**
 * The carve-outs to autoConfirm. THE INVARIANT: an action that expands WHERE model-influenced execution
 * can reach always waits for a human click, even under autoConfirm. Note the risk RATING is not a gate —
 * riskOf only stamps the card chip — so this predicate is the whole behavioral lever, and the card it
 * forces is the whole defense.
 *  - create_loop WITH a checkCommand: that command runs as a host shell each iteration (unsandboxed, with
 *    the loop terminal's token) — the one path where model-influenced output becomes host execution.
 *  - create_project: every repoPath registered today was typed by a human, and that curated list is
 *    exactly what bounds where an auto-confirmed loop can point an agent. Letting the brain widen its own
 *    boundary would end that invariant (register any readable repo, then auto-start a checkCommand-less
 *    loop in it, zero clicks).
 *  - init_project_repo: writes the host filesystem (git init + a first commit) and pushes outward to
 *    GitHub — an irreversible, outward-facing effect that must always carry a human click.
 *  - bootstrap_project: create_project and init_project_repo composed into one act — it REGISTERS a
 *    project (widening where agents may run) AND writes the host filesystem then pushes the first commit
 *    outward. It carries every reason both of those do, so it too always waits for a human click.
 *  - set_project_autonomy: arming it strips the per-command permission gate from every FUTURE work
 *    terminal and loop iteration in the project (and, with the adapter seed, plants the durable
 *    per-account bypass acceptance). Disarming is carved out too — one honest rule, zero benefit to
 *    auto-disarm, and a mixed-polarity carve-out would invite a polarity bug.
 *  - set_skill_enabled / set_project_skills: a skill body is instructions injected into every future
 *    agent, so toggling a skill or repointing a project's selection expands WHAT executes everywhere —
 *    the same class as widening WHERE it runs. Both polarities are carved out (the mixed-polarity
 *    argument again), and a protected skill can't even be proposed (enrich refuses it).
 *  - promote_skill: publishes an LLM-authored draft body into the shared library — the same
 *    instructions-reaching-every-agent class as the two above, with the extra wrinkle that the text
 *    itself came from the model. A CREATE lands enabled:false, so a second explicit human act (the
 *    enable toggle, or an always-confirm set_skill_enabled card) stands between a new draft and any
 *    agent; an UPDATE of an already-enabled assistant skill reaches interactive agents on this one
 *    Confirm — the operator just reviewed the exact body diff, and the targetEnabled pin voids the
 *    card if the enable state moved after review — while skip-permissions agents stay excluded
 *    regardless, because the content change resets autonomy clearance in the same upsert
 *    (SPEC-SKILLS Phase 5b, wave-2 seam).
 *  - close_terminal / restart_terminal (SPEC-RESTART Wave 1, §3.2): not a boundary-WIDENING pair but
 *    the destructive-verb class — one destroys a live agent pane and FAILS any loop bound to it, the
 *    other discards an in-flight turn. Both carved out UNCONDITIONALLY (the one-honest-rule posture:
 *    no live-state polarity like "only when loop-bound" — a mixed-polarity carve-out invites exactly
 *    the drift bug the set_project_autonomy argument names), so a Confirm click always stands between
 *    the brain and a terminal's lifecycle.
 * Everything else — including a checkCommand-less loop — still auto-confirms.
 *
 * ONE SOURCE: the carve-out list lives in reasonForHumanConfirm and this predicate is DERIVED from it,
 * so the gate and the reason it reports can never drift apart — a new carve-out is one entry, and a
 * caller can never hardcode a reason that outlives its cause.
 */
export function requiresHumanConfirm(action: AssistantAction): boolean {
  return reasonForHumanConfirm(action) !== '';
}

/** Why this action is carved out of autoConfirm (the skip audit reports it). Empty ⇒ not carved out,
 *  which is exactly what requiresHumanConfirm reads — keep every carve-out in this one list. */
export function reasonForHumanConfirm(action: AssistantAction): string {
  if (action.kind === 'create_loop' && action.checkCommand !== undefined) {
    return 'a loop carrying a host check command requires a human confirm';
  }
  if (action.kind === 'create_project') {
    return 'registering a project widens where agents may run and requires a human confirm';
  }
  if (action.kind === 'init_project_repo') {
    return 'initializing and pushing a repository writes this host and GitHub and requires a human confirm';
  }
  if (action.kind === 'bootstrap_project') {
    return 'registering a project AND initializing and pushing its repository widens where agents may run, writes this host, and pushes to GitHub — it requires a human confirm';
  }
  if (action.kind === 'set_project_autonomy') {
    return "changing a project's autonomy (skip-permissions) default removes or restores the per-command permission gate and requires a human confirm";
  }
  if (action.kind === 'set_skill_enabled') {
    return 'changing which skill instructions reach every future agent requires a human confirm';
  }
  if (action.kind === 'set_project_skills') {
    return "changing a project's selected skill instructions requires a human confirm";
  }
  if (action.kind === 'promote_skill') {
    return 'publishing assistant-authored skill instructions into the shared library requires a human confirm';
  }
  if (action.kind === 'close_terminal') {
    return 'closing a terminal destroys a live agent pane (and fails any loop bound to it) and requires a human confirm';
  }
  if (action.kind === 'restart_terminal') {
    return "restarting a terminal discards the pane's in-flight turn and requires a human confirm";
  }
  if (action.kind === 'update_provider_cli') {
    return "updating a provider CLI runs its self-updater on the host and requires a human confirm";
  }
  return '';
}

/** Resolve ids → live names and build the sanitized summary + drift baseline for an action.
 *  Throws a self-correctable Error on any unknown referenced id (propose → 400 to the model;
 *  confirm → drift abort). */
export function enrich(action: AssistantAction, lookups: ActionLookups): Enrichment {
  return entryFor(action).enrich(action, lookups);
}

// ---- the executor (⟦DP-J3⟧) ----

export type ProposalExecutor = (
  action: AssistantAction,
) => Promise<{ ok: boolean; status: number; body: unknown }>;

/**
 * Run a confirmed action through the Tower's own public route via app.inject. The injected
 * request carries the headers the auth hook demands (auth.ts): Host `127.0.0.1:<port>` from
 * the allowlist, a matching loopback Origin, and the SESSION token (never the scoped assistant
 * token — the whole point of §5 is that the scoped token CANNOT reach these routes). A non-2xx
 * route response resolves { ok: false } with the route's error body, never a throw.
 */
export function makeProposalExecutor(app: FastifyInstance, sessionToken: string, port: number): ProposalExecutor {
  // Host must match the SAME port Auth built its allowlist from (server.ts's PORT), not the live
  // bound address — an ephemeral/rebound port would 421 every confirm on a host-allowlist miss.
  const host = `127.0.0.1:${port}`;
  const headers = { host, origin: `http://${host}`, 'x-tower-token': sessionToken };
  // The payload-builder's read channel: the same inject identity, GET only. A non-2xx read
  // throws so the payload can never be built from an error body.
  const read: RouteReader = async (url) => {
    const res = await app.inject({ method: 'GET', url, headers });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`read of ${url} failed (${res.statusCode})`);
    }
    return res.json();
  };
  return async (action) => {
    const entry = entryFor(action);
    let payload: Record<string, unknown> | undefined;
    try {
      payload = await entry.payload(action, read);
    } catch (err) {
      // Keep the executor's no-throw contract: a failed payload build resolves { ok: false }.
      return { ok: false, status: 500, body: { error: `failed to build the request: ${(err as Error).message}` } };
    }
    const res = await app.inject({
      method: entry.method,
      url: entry.url(action),
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    let body: unknown;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body };
  };
}
