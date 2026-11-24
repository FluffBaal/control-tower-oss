// Routing by cognitive shape + model discovery (SPEC-PROVIDERS §2, §3). This module is the
// single place that decides a sortie's (provider, model), the place that validates a route
// BEFORE any terminal spawns, the place that persists Settings → Routing role defaults, and
// the place that probes a provider's /models endpoint. It is a leaf: it reads the ProviderStore
// (passed in — never imported as a singleton) and owns its own ~/.ct/config/routing.json; it
// imports nothing from loops/missions/validator, so those may import it without a cycle.
//
// Three design points concentrate here:
//  - resolveRouting (⟦DP-7⟧): provider and model resolve as INDEPENDENT layered lookups,
//    each falling through its OWN chain, so a per-sortie model override never drags a provider
//    along, and vice-versa; the provider's own defaultModel is the FINAL model fallback.
//  - validateRoute / validateMissionRoutes: every resolved route is checked before a
//    spawn — the def exists, a needed model is present, the §1.6 auth invariants hold — with
//    missing secrets a WARNING (best-effort) rather than a hard block, and errors reported
//    per-sortie so a bad route in phase 2 never launches phase 1.
//  - discoverModels (⟦DP-10⟧): discovery is UNTRUSTED input, hardened before anything is
//    stored or shell-bound — a fetch timeout + response size cap so a hostile/slow endpoint can't
//    hang or OOM the Tower, strict shape validation, and a model-id allowlist (the same allowlist
//    manual model strings are held to) that makes the separate-token argv in §1.1 injection-safe.

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../paths.js';
import { shortId } from '../ids.js';
import { providerIdSchema } from '../store.js';
import { ROLE_IDS } from '../../shared/roles.js';
import type {
  ProviderId,
  ProviderDef,
  PipelineRole,
  RoleAssignment,
  RoleRouting,
  WorkflowProfile,
  ProjectRouting,
  LayeredRoleRouting,
  Mission,
} from '../../shared/types.js';
import { isValidEffort, CLAUDE_EFFORTS, CODEX_EFFORT_RE } from '../../shared/types.js';

// ---- The ProviderStore slices this module reads (BP1's ProviderStore satisfies all three
//      structurally — we accept the minimal surface each function needs so each stays unit-
//      testable with a tiny stub, and so we never hard-couple to BP1's exact class shape). ----

/** Model-default lookup — all resolveRouting needs from the store. */
export interface ProviderDefLookup {
  get(id: ProviderId): ProviderDef | undefined;
}

/** Route validation additionally probes whether a declared secret is present. */
export interface ProviderSecretLookup extends ProviderDefLookup {
  hasSecret(id: ProviderId, key: string): boolean;
}

/** Discovery writes the verified roster back through upsert (which rebuilds + SSEs, BP1). */
export interface ProviderDefWriter extends ProviderDefLookup {
  upsert(def: ProviderDef): ProviderDef;
}

/** SPEC-TESTING §1.2 — the account slice the provider-MATCH gate reads (Accounts satisfies it
 *  structurally, mirroring the ProviderDefLookup idiom above; this module stays a leaf — the
 *  lookup is always passed IN, never imported). `label` is optional surface for the effective-
 *  routing provenance view. */
export interface ProfileLookup {
  getProfile(id: string): { provider: ProviderId; label?: string } | undefined;
}

/** A custom provider id is the only one carrying a ProviderDef; built-ins have coded adapters. */
function isCustom(id: ProviderId): boolean {
  return id.startsWith('custom:');
}

/** The coded built-in AGENT providers (shell is a built-in but not an agent, handled separately).
 *  C3: a non-custom route must be POSITIVELY one of these — an unknown non-custom id (e.g. 'gpt-4')
 *  is a hard pre-start error, not a tombstone adapter that spawns a terminal and then throws. */
const BUILTIN_AGENT_IDS = new Set<ProviderId>(['claude-code', 'gemini-cli', 'codex', 'hermes']);

// =====================================================================================
// §3 — the model-id allowlist (shared by discovery AND manual entry validation)
// =====================================================================================

/**
 * The allowlist a model id must satisfy to be stored or bound onto an argv. It is what makes the
 * `modelFlag` + separate-token argv in §1.1 safe: a conforming id cannot carry a space (argv
 * split) or a leading dash (flag injection). Manual model strings are held to the exact same bar.
 */
export const MODEL_ID_RE = /^[A-Za-z0-9._:/-]+$/;

/** True when `s` is a safe model id: non-empty, bounded, allowlist-conforming, no leading dash. */
export function isValidModelId(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && MODEL_ID_RE.test(s) && !s.startsWith('-');
}

// =====================================================================================
// §2.3 ⟦DP-7⟧ — resolveRouting: the single precedence function
// =====================================================================================

/** The routing-relevant fields of a sortie (a MissionSortie, a draft sortie, or a loop request). */
export interface RoutingInput {
  role?: PipelineRole;
  provider?: ProviderId;
  model?: string;
  /** SPEC-EFFORT §1 — the request-explicit reasoning effort (the most specific effort tier). */
  effort?: string;
  /** SPEC-TESTING §1 — the request-explicit account (the most specific account tier). */
  profileId?: string;
}

/** The routing-relevant fields of the enclosing mission (mission-level defaults). */
export interface RoutingMissionDefaults {
  provider?: ProviderId;
  model?: string;
  /** SPEC-EFFORT §1 — the mission-level reasoning-effort default (the least specific effort tier). */
  effort?: string;
  /** SPEC-TESTING §1 — the mission-level account default (the least specific account tier). */
  profileId?: string;
}

/**
 * ⟦DP-8⟧ v2 attribute-rule seam. `matchRule` is a NAMED no-op in v1 (rules is always []), so v2
 * can slot a rules engine in behind this signature without touching a single caller. The shape it
 * returns mirrors a RoleAssignment so provider/model each participate in their own ?? chain.
 */
export interface RoutingRule {
  provider?: ProviderId;
  model?: string;
  /** SPEC-EFFORT §1 — a rule that pins a model may pin its effort too (rank 5). */
  effort?: string;
}
export function matchRule(_rules: RoutingRule[], _sortie: RoutingInput): RoutingRule | undefined {
  return undefined; // v1: no attribute rules — Jarvis (§2.5) covers the intent per-sortie
}

// ---- SPEC-TESTING §1.2 ⟦D1⟧ — the account chain: provider-MATCH gate, NOT a rank gate ----

type AccountTier = 'sortie' | 'project' | 'workflow' | 'global' | 'mission';

/** The present account tiers, most specific first (the account's OWN chain — never coupled to
 *  which tier supplied the provider or model). */
function accountChain(
  sortie: RoutingInput,
  mission: RoutingMissionDefaults,
  routing: LayeredRoleRouting,
): { tier: AccountTier; profileId: string }[] {
  const chain: { tier: AccountTier; profileId: string }[] = [];
  if (sortie.profileId !== undefined) chain.push({ tier: 'sortie', profileId: sortie.profileId });
  if (sortie.role) {
    const project = routing.project?.[sortie.role];
    const workflow = routing.workflow?.[sortie.role];
    const global = routing.global[sortie.role];
    if (project?.profileId !== undefined) chain.push({ tier: 'project', profileId: project.profileId });
    if (workflow?.profileId !== undefined) chain.push({ tier: 'workflow', profileId: workflow.profileId });
    if (global?.profileId !== undefined) chain.push({ tier: 'global', profileId: global.profileId });
  }
  if (mission.profileId !== undefined) chain.push({ tier: 'mission', profileId: mission.profileId });
  return chain;
}

interface AccountResolution {
  profileId?: string;
  tier?: AccountTier;
  /** Tiers whose account was present but SKIPPED (unknown id, or a provider mismatch under the
   *  match gate) — validation surfaces these; resolution just falls through them (§1.2). */
  skipped: { tier: AccountTier; profileId: string; reason: 'unknown' | 'mismatch' }[];
}

/**
 * Walk the account chain under the provider-MATCH gate (⟦D1⟧): a tier's profileId contributes iff
 * the lookup resolves it AND its provider equals the already-resolved provider; otherwise that
 * tier is skipped and the chain continues. A model string can't be checked for provider coherence
 * (hence the model's rank gate below), but an account carries `provider`, so the real coherence
 * property is checked DIRECTLY — a rank gate here would silently drop the mission account whenever
 * a higher tier resolves the SAME provider (the common config). With NO lookup wired (unit tests /
 * degraded) the most-specific present account attaches UNCHECKED — the terminal-manager spawn
 * guard is the loud backstop; never a silent drop to the shared login dir.
 */
function resolveAccount(
  chain: { tier: AccountTier; profileId: string }[],
  provider: ProviderId,
  profiles?: ProfileLookup,
): AccountResolution {
  if (!profiles) {
    const top = chain[0];
    return top ? { profileId: top.profileId, tier: top.tier, skipped: [] } : { skipped: [] };
  }
  const skipped: AccountResolution['skipped'] = [];
  for (const c of chain) {
    const p = profiles.getProfile(c.profileId);
    if (!p) {
      skipped.push({ ...c, reason: 'unknown' });
      continue;
    }
    if (p.provider !== provider) {
      skipped.push({ ...c, reason: 'mismatch' });
      continue;
    }
    return { profileId: c.profileId, tier: c.tier, skipped };
  }
  return { skipped };
}

/**
 * Decide a sortie's (provider, model). Provider and model resolve through INDEPENDENT layered
 * lookups — a per-sortie model override does not drag a provider along, and a per-sortie
 * provider override does not force a model — with ONE coupling: a RoleAssignment and the mission
 * defaults each pair a provider with a model chosen FOR that provider, so a model may only be taken
 * from a tier at least as SPECIFIC as the tier that supplied the provider. Otherwise a finer
 * provider override (per-sortie, or a role default) would silently inherit a model picked for a
 * different provider. The role default is THREE ranked sub-tiers (SPEC-ROUTING §3): the project's
 * ad-hoc override, then the project's selected workflow, then the global role default. Precedence,
 * most specific first:
 *
 *   provider:  sortie > [rule, v2] > project[role] > workflow[role] > global[role] > mission > 'claude-code'
 *   model:     sortie > [rule, v2] > project[role] > workflow[role] > global[role] > mission > provider.defaultModel
 *
 * with model gated so its tier is at least as specific as the provider's: a sortie-provider
 * override skips a role/mission model and falls through to the chosen provider's own defaultModel;
 * mission.model applies only when the provider also came from mission-or-broader. The store is
 * threaded in for that defaultModel fallback; built-ins carry no def, so their model stays
 * undefined here (ignored downstream) — that's correct, not a gap.
 *
 * SPEC-TESTING §1.2: the ACCOUNT resolves on its own third chain (sortie/loop-explicit >
 * project[role] > workflow[role] > global[role] > mission), gated by provider MATCH against the
 * resolved provider — see resolveAccount above. Unresolved ⇒ profileId undefined (shared login dir).
 * `accountSkipped` reports the tiers the match gate fell through (present only when non-empty), so
 * validateMissionRoutes can surface them without re-running the chain — one resolution per sortie,
 * and the warnings can never desync from the profileId actually attached.
 */
export function resolveRouting(
  sortie: RoutingInput,
  mission: RoutingMissionDefaults,
  routing: LayeredRoleRouting,
  store?: ProviderDefLookup,
  rules: RoutingRule[] = [],
  profiles?: ProfileLookup,
): { provider: ProviderId; model?: string; effort?: string; profileId?: string; accountSkipped?: AccountResolution['skipped'] } {
  const rule = matchRule(rules, sortie);
  const projectRole = sortie.role ? routing.project?.[sortie.role] : undefined;
  const workflowRole = sortie.role ? routing.workflow?.[sortie.role] : undefined;
  const globalRole = sortie.role ? routing.global[sortie.role] : undefined;

  // Resolve the provider AND record which tier supplied it (its specificity rank), so the model
  // lookup below can refuse a model from a tier less specific than the provider's.
  const SORTIE = 6,
    RULE = 5,
    PROJECT_ROLE = 4,
    WORKFLOW_ROLE = 3,
    GLOBAL_ROLE = 2,
    MISSION = 1,
    GLOBAL = 0;
  let provider: ProviderId;
  let providerRank: number;
  if (sortie.provider !== undefined) {
    provider = sortie.provider; // per-sortie override
    providerRank = SORTIE;
  } else if (rule?.provider !== undefined) {
    provider = rule.provider; // [v2 seam] attribute rule
    providerRank = RULE;
  } else if (projectRole?.provider !== undefined) {
    provider = projectRole.provider; // project ad-hoc role override
    providerRank = PROJECT_ROLE;
  } else if (workflowRole?.provider !== undefined) {
    provider = workflowRole.provider; // the project's selected workflow
    providerRank = WORKFLOW_ROLE;
  } else if (globalRole?.provider !== undefined) {
    provider = globalRole.provider; // global role default
    providerRank = GLOBAL_ROLE;
  } else if (mission.provider !== undefined) {
    provider = mission.provider; // mission default
    providerRank = MISSION;
  } else {
    provider = 'claude-code'; // global default
    providerRank = GLOBAL;
  }

  // Model resolves through its own chain, but each tier contributes only when it is at least as
  // specific as the provider's tier (sortie is the most specific, so a per-sortie model is never
  // gated out). A tier whose model loses this gate is skipped — never paired with a foreign provider.
  let model: string | undefined;
  if (sortie.model !== undefined && SORTIE >= providerRank) model = sortie.model;
  else if (rule?.model !== undefined && RULE >= providerRank) model = rule.model;
  else if (projectRole?.model !== undefined && PROJECT_ROLE >= providerRank) model = projectRole.model;
  else if (workflowRole?.model !== undefined && WORKFLOW_ROLE >= providerRank) model = workflowRole.model;
  else if (globalRole?.model !== undefined && GLOBAL_ROLE >= providerRank) model = globalRole.model;
  else if (mission.model !== undefined && MISSION >= providerRank) model = mission.model;

  // FINAL fallback: the chosen provider's own default model (always coherent — it is that
  // provider's). Undefined for built-ins (no def) — fine, ignored downstream.
  model ??= store?.get(provider)?.model.defaultModel;

  // SPEC-EFFORT §2 — effort resolves through the SAME chain + rank gate as model (above), so a
  // less-specific tier's effort (e.g. a global-role claude 'max') is skipped rather than riding onto a
  // more-specific provider override (e.g. a sortie codex). There is NO final fallback here — unset ⇒ no
  // flag (§0 no-imposed-defaults; the catalog defaultEffort is display-only, never applied).
  let effort: string | undefined;
  if (sortie.effort !== undefined && SORTIE >= providerRank) effort = sortie.effort;
  else if (rule?.effort !== undefined && RULE >= providerRank) effort = rule.effort;
  else if (projectRole?.effort !== undefined && PROJECT_ROLE >= providerRank) effort = projectRole.effort;
  else if (workflowRole?.effort !== undefined && WORKFLOW_ROLE >= providerRank) effort = workflowRole.effort;
  else if (globalRole?.effort !== undefined && GLOBAL_ROLE >= providerRank) effort = globalRole.effort;
  else if (mission.effort !== undefined && MISSION >= providerRank) effort = mission.effort;

  // SPEC-TESTING §1.2 — the account joins the resolution on its own match-gated chain.
  const account = resolveAccount(accountChain(sortie, mission, routing), provider, profiles);

  return {
    provider,
    model,
    ...(effort !== undefined ? { effort } : {}),
    ...(account.profileId !== undefined ? { profileId: account.profileId } : {}),
    ...(account.skipped.length > 0 ? { accountSkipped: account.skipped } : {}),
  };
}

// =====================================================================================
// §2.3a — pre-start validation: no spawn on an unresolvable route
// =====================================================================================

export interface RouteValidation {
  /** Hard blocks — a route with any error must NOT spawn. */
  errors: string[];
  /** Best-effort concerns (e.g. a declared secret not yet set) — surfaced, never a hard block. */
  warnings: string[];
}

/** SPEC-TESTING §1.3/§1.4 — the account inputs validateRoute checks alongside the (provider,
 *  model). Mirrors resolution's tiers: the request-EXPLICIT account is the hard-error tier (the
 *  operator named a specific account — silent fallback is the trap the terminal-manager comment
 *  warns of); the RESOLVED account (whatever tier won the match gate) is checked against the
 *  Brain-reserved set, so a builder can never route onto the assistant's profile. */
export interface AccountRouteCheck {
  /** The sortie/loop-request-explicit account, when the request named one. */
  explicitProfileId?: string;
  /** The account resolveRouting attached (post-match-gate; may equal explicitProfileId). */
  resolvedProfileId?: string;
  profiles?: ProfileLookup;
  /** SPEC-TESTING §1.4 — the assistant Brain's profile id(s), read at runtime (never hardcoded). */
  reservedProfileIds?: ReadonlySet<string>;
}

/**
 * Validate one already-resolved (provider, model) against the store. HARD errors: an unregistered
 * custom def; a model needed (the command interpolates {{model}}, or a modelFlag/modelEnv is set)
 * but neither resolved nor defaulted; a model id that fails the §3 allowlist; a violated §1.6 auth
 * invariant (login ⇒ configDirEnv|HOME; env ⇒ secretEnvKeys); an EXPLICIT account that is unknown,
 * provider-mismatched, or Brain-reserved, or ANY resolved account that is Brain-reserved
 * (SPEC-TESTING §1.3/§1.4). WARNINGS: a declared secretEnvKey with no stored value (missing →
 * warning, not a block — §2.3a). Inherited-tier account mismatches warn in validateMissionRoutes
 * (which sees the tiers), never here. Built-ins carry no def, but SPEC-MODELS now threads the model
 * onto their argv, so their model IS checked here: a hard error if it fails the §3 allowlist, and a
 * soft warning (via knownModelIds) if it isn't in the account's known catalog. Account checks also apply.
 */
export function validateRoute(
  provider: ProviderId,
  model: string | undefined,
  store?: ProviderSecretLookup,
  account?: AccountRouteCheck,
  knownModelIds?: string[],
  effort?: string,
  knownEfforts?: string[],
): RouteValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // SPEC-MODELS §4 — built-ins now put the resolved model on argv (previously ignored), so a stored
  // slug the account's backend rejects (e.g. a legacy codex model) would break a run that used to
  // work. When a known-good set exists for this account (knownModelIds passed non-empty — a discovered
  // roster or codex's verified curated seed), a model that isn't in it gets a non-fatal warning —
  // never an error (an operator may deliberately pick a just-released slug before the catalog verifies).
  if (model && knownModelIds && knownModelIds.length > 0 && !knownModelIds.includes(model)) {
    warnings.push(`model "${model}" isn't in this account's known catalog — it may be rejected at launch`);
  }

  // SPEC-EFFORT §2 — effort gate (mirrors the model-id hoist), placed BEFORE the shell/built-in early
  // returns so it covers EVERY provider. Asymmetric per §0: claude-code = pinned hard enum (clap crashes
  // on an unknown value at launch — a loud pre-check beats a dead spawn); codex = syntactic HARD gate
  // plus a set-membership WARNING (never an error — codex is lenient and the backend can ship an effort
  // before the catalog re-verifies); gemini/shell/custom = hard error (no effort surface — clear it,
  // never a silent drop). knownEfforts (the resolved codex model's captured set) feeds ONLY the warning.
  if (effort !== undefined && effort !== '') {
    if (!isValidEffort(provider, effort)) {
      if (provider === 'claude-code') {
        errors.push(`effort "${effort}" is not valid for claude-code (must be one of ${CLAUDE_EFFORTS.join(', ')})`);
      } else if (provider === 'codex') {
        errors.push(`effort "${effort}" is not a valid codex effort token (must match ${CODEX_EFFORT_RE.source})`);
      } else {
        errors.push(`provider ${provider} has no reasoning-effort surface — clear the effort on this route`);
      }
    } else if (provider === 'codex' && knownEfforts && knownEfforts.length > 0 && !knownEfforts.includes(effort)) {
      warnings.push(`effort "${effort}" isn't in this model's known set — it may be ignored or rejected at launch`);
    }
  }

  // SPEC-TESTING §1.3/§1.4 — account checks run first (they apply to built-ins, which return
  // early below). Explicit: unknown / mismatched / reserved ⇒ hard error. Resolved: reserved ⇒
  // hard error (the closure — an inherited role-tier account pointing at the Brain profile
  // would pass the match gate, so the reserved check must look at the RESOLVED account).
  if (account) {
    const { explicitProfileId, resolvedProfileId, profiles, reservedProfileIds } = account;
    if (explicitProfileId !== undefined) {
      if (reservedProfileIds?.has(explicitProfileId)) {
        errors.push(`account ${explicitProfileId} is reserved for the Tower's assistant brain and cannot run a builder`);
      } else if (profiles) {
        const p = profiles.getProfile(explicitProfileId);
        if (!p) errors.push(`unknown account ${explicitProfileId}`);
        else if (p.provider !== provider) errors.push(`account ${explicitProfileId} is not a ${provider} account`);
      }
    }
    if (
      resolvedProfileId !== undefined &&
      resolvedProfileId !== explicitProfileId &&
      reservedProfileIds?.has(resolvedProfileId)
    ) {
      errors.push(`account ${resolvedProfileId} is reserved for the Tower's assistant brain and cannot run a builder`);
    }
  }

  if (provider === 'shell') {
    errors.push('shell is not an agent provider');
    return { errors, warnings };
  }
  if (!isCustom(provider)) {
    // C3: POSITIVE membership — a non-custom id must be a known coded built-in. Anything else
    // (a typo, a bare model name like 'gpt-4', a renamed/stale id) is a hard error at THIS
    // pre-start gate, so no terminal ever spawns on a tombstone that would throw mid-turn.
    if (!BUILTIN_AGENT_IDS.has(provider)) {
      errors.push(`provider ${provider} is not a known built-in or a registered custom provider`);
    }
    // SPEC-MODELS §4 — a built-in now threads the resolved model onto argv (codex -m / claude
    // --model / gemini -m), so gate it against the allowlist HERE (the custom tail's isValidModelId
    // check below is unreachable for built-ins, which early-return). An unset model is fine (the CLI's
    // own default). This closes the mission/loop/sortie unvalidated-model paths at the start gate.
    if (model !== undefined && model !== '' && !isValidModelId(model)) {
      errors.push(`model "${model}" is not a valid model id`);
    }
    return { errors, warnings }; // known built-in agent: coded adapter, no def to check
  }

  const def = store?.get(provider);
  if (!store) return { errors, warnings }; // no store wired (tests / degraded) — can't check the def
  if (!def) {
    errors.push(`provider ${provider} is not registered`);
    return { errors, warnings };
  }

  const needsModel =
    def.command.some((tok) => tok.includes('{{model}}')) || !!def.model.modelFlag || !!def.model.modelEnv;
  const effectiveModel = model ?? def.model.defaultModel;
  if (needsModel && !effectiveModel) {
    errors.push(`provider ${provider} needs a model but none is resolved and it has no defaultModel`);
  }
  if (effectiveModel && !isValidModelId(effectiveModel)) {
    errors.push(`model "${effectiveModel}" is not a valid model id (must match ${MODEL_ID_RE.source}, no leading dash)`);
  }

  // §1.6 ⟦AR-1⟧ auth invariants (also enforced at upsert; re-checked here before a spawn).
  if (def.auth.mode === 'login' && !def.configDirEnv && !def.env?.HOME) {
    errors.push(`provider ${provider} uses auth 'login' but sets neither configDirEnv nor an env HOME to isolate the login`);
  }
  if (def.auth.mode === 'env' && !(def.secretEnvKeys && def.secretEnvKeys.length > 0)) {
    errors.push(`provider ${provider} uses auth 'env' but declares no secretEnvKeys`);
  }

  // Best-effort secret presence — a missing secret warns, it does not block (§2.3a).
  for (const key of def.secretEnvKeys ?? []) {
    if (!store.hasSecret(provider, key)) {
      warnings.push(`secret ${key} is not set for ${provider}`);
    }
  }

  return { errors, warnings };
}

/** One sortie's resolved-and-validated route, for the pre-start mission gate. */
export interface SortieRouteReport {
  sortieId: string;
  sortieName: string;
  provider: ProviderId;
  model?: string;
  /** SPEC-TESTING §1 — the RESOLVED account (post-match-gate), so warnings name the account. */
  profileId?: string;
  errors: string[];
  warnings: string[];
}
export interface MissionRouteReport {
  sorties: SortieRouteReport[];
  hasErrors: boolean;
}

/**
 * Resolve + validate EVERY sortie across EVERY phase of a mission before it starts. The
 * caller refuses to start when `hasErrors`, so a bad route in a later phase never launches an
 * earlier one. Warnings (missing secrets) are reported but do not set `hasErrors`.
 *
 * SPEC-TESTING §1.3 ⟦D2⟧ — the account checks mirror resolution: the sortie-explicit account
 * validates hard inside validateRoute; each INHERITED tier that was present but skipped by the
 * match gate (unknown / provider mismatch) becomes a WARNING + shared-dir (or lower-tier) fallback
 * — never a block, so a stale hand-edited role account can't brick every mission fleet-wide. The
 * one exception: the MISSION-tier account being UNKNOWN is a hard error (pruneProfile can't
 * reach mission records, and the operator named that account in the create body; a mission-tier
 * provider MISMATCH stays a per-sortie warning, the §1.5 fix).
 */
export function validateMissionRoutes(
  mission: Mission,
  routing: LayeredRoleRouting,
  store?: ProviderSecretLookup,
  profiles?: ProfileLookup,
  reservedProfileIds?: ReadonlySet<string>,
): MissionRouteReport {
  const sorties: SortieRouteReport[] = [];
  for (const phase of mission.phases) {
    for (const sortie of phase.sorties) {
      const { provider, model, effort, profileId, accountSkipped } = resolveRouting(sortie, mission, routing, store, [], profiles);
      // SPEC-EFFORT §2 — pass the resolved effort; knownEfforts stays undefined here (the codex catalog
      // warning fires later at loops.create, mirroring the model-id knownModelIds comment below).
      const v = validateRoute(provider, model, store, {
        explicitProfileId: sortie.profileId,
        resolvedProfileId: profileId,
        profiles,
        reservedProfileIds,
      }, undefined, effort);
      const errors = [...v.errors];
      const warnings = [...v.warnings];
      // The skipped tiers come from the SAME resolveAccount walk that attached profileId above —
      // never a recomputation, so the warnings can't desync from the resolved account.
      for (const s of accountSkipped ?? []) {
        if (s.tier === 'sortie') continue; // the explicit tier already hard-errored in validateRoute
        if (s.tier === 'mission' && s.reason === 'unknown') {
          errors.push(`mission account ${s.profileId} no longer exists — remove or replace it`);
        } else if (s.reason === 'unknown') {
          warnings.push(`account ${s.profileId} (${s.tier} routing) no longer exists — skipped; falling through the account chain`);
        } else {
          warnings.push(`account ${s.profileId} (${s.tier} routing) is not a ${provider} account — skipped; falling through the account chain`);
        }
      }
      sorties.push({ sortieId: sortie.id, sortieName: sortie.name, provider, model, profileId, errors, warnings });
    }
  }
  return { sorties, hasErrors: sorties.some((s) => s.errors.length > 0) };
}

// =====================================================================================
// §2.1 — RoleRouting persistence (Settings → Routing), self-contained routing.json
// =====================================================================================

const roleAssignmentSchema = z.object({
  provider: providerIdSchema,
  model: z.string().optional(),
  // SPEC-EFFORT §1 — MUST be listed (the same fixed-key-partial strip trap as profileId below).
  effort: z.string().min(1).optional(),
  // SPEC-TESTING §1.6 — MUST be listed (the fixed-key partial STRIPS unknown fields on an old
  // Tower, so a missing entry here would silently drop every stored role account on load).
  profileId: z.string().min(1).optional(),
});
// Registry-derived FIXED-KEY partial object (SPEC-ROUTING §1). Deliberately NOT
// z.record(z.enum(ROLE_IDS), …): verified on this repo's zod 3.25.76 that a record with an enum
// key REJECTS an out-of-enum key — the whole safeParse fails, load() then ignores the ENTIRE
// file, and the next persist() clobbers it. That turns "a newer Tower wrote a `tester` route"
// into total routing data loss. The fixed-key object form STRIPS unknown keys instead (parse
// succeeds, unknown role dropped in memory, file untouched) — the desired forward/back compat.
const roleRoutingShape = Object.fromEntries(ROLE_IDS.map((id) => [id, roleAssignmentSchema])) as Record<
  PipelineRole,
  typeof roleAssignmentSchema
>;
const roleRoutingSchema = z.object(roleRoutingShape).partial();
// STRICT variant for §6 migration step 3 only: a legacy flat file must contain NOTHING but role
// keys — roleRoutingSchema would happily "parse" any foreign object to {} and the migration would
// then persist that {} over it.
const legacyRoleRoutingSchema = z.object(roleRoutingShape).partial().strict();

const projectRoutingSchema = z.object({
  workflowId: z.string().min(1).optional(),
  routes: roleRoutingSchema.optional(),
});
const workflowProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  routes: roleRoutingSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
// routing.json v2 (SPEC-ROUTING §2) = one global layer + per-project overlays + named workflows.
// It is loaded PER-ENTRY (see load()) — global, each project, and each workflow are validated
// independently so one bad entry can't discard the rest — so there is no whole-file schema.

const ROLE_KEYS: readonly PipelineRole[] = ROLE_IDS;

/** Atomic write (temp + rename) mirroring the main store idiom; 0600 since it is Tower-owned config. */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

/** Thrown by deleteWorkflow while any project still selects the workflow — the route maps it to
 *  a 409 carrying the referencing project names (SPEC-ROUTING §7). */
export class WorkflowReferencedError extends Error {
  constructor(
    readonly workflowId: string,
    /** Referencing project NAMES (falls back to the id when no resolver is wired). */
    readonly referencedBy: string[],
  ) {
    super(
      `workflow is selected by ${referencedBy.length} project(s): ${referencedBy.join(', ')} — unassign it there before deleting`,
    );
    this.name = 'WorkflowReferencedError';
  }
}

/** One role's collapsed project>workflow>global result, with provenance for the UI (§4). */
export interface EffectiveRoleRoute {
  provider: ProviderId;
  /** The RESOLVED model (post-gate) — may be the provider's own defaultModel. */
  model?: string;
  /** SPEC-EFFORT §1 — the WINNING layer's own effort (no cross-layer fallback — same reasoning
   *  as the model drop; effort is provider-specific so a lower layer's effort must not ride up). */
  effort?: string;
  source: 'project' | 'workflow' | 'global';
  /** Set when `model` fell through to the provider's defaultModel — i.e. a lower layer's model
   *  was rank-gated out (the drop) or no layer named one. Lets the UI render it honestly. */
  modelSource?: 'default';
  /** SPEC-TESTING §1 — the RESOLVED account (post-match-gate over the role's own account chain)
   *  and its display label, so the effective view names the logged-in AI honestly. */
  profileId?: string;
  profileLabel?: string;
}
/** PARTIAL by design (SPEC-ROUTING §4): only roles configured at SOME layer appear — an omitted
 *  role must fall through to the client's own sortie/mission/global tiers, never `source:'default'`. */
export type EffectiveRouting = Partial<Record<PipelineRole, EffectiveRoleRoute>>;

/**
 * Persists ALL routing state in ~/.ct/config/routing.json v2 — the global role defaults, the
 * per-project overlays, and the named workflow profiles (SPEC-ROUTING §2; zod-validated on load
 * with the §6 migration; a malformed file is ignored — and backed up — never fatal, and never
 * silently overwritten). The get/set/clear/workflow/project methods ARE the routing config API
 * surface — the integrator registers thin routes over them.
 */
export class RoutingStore {
  private global: RoleRouting = {};
  private projects: Record<string, ProjectRouting> = {};
  private workflows: WorkflowProfile[] = [];

  constructor(private readonly file: string = join(paths.config, 'routing.json')) {
    this.load();
  }

  /** §6 detection order: (1) version===2 → v2; (2) version-less but v2-shaped → corrupt/foreign,
   *  keep empty + back up + NEVER persist over it at load; (3) STRICT legacy flat RoleRouting →
   *  wrap as v2 + persist. Never eagerly persist a migration whose non-empty input parsed to {}. */
  private load(): void {
    if (!existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      console.error(`[routing] cannot read ${this.file}: ${(err as Error).message}`);
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`[routing] ${this.file} is not an object — ignoring it`);
      return;
    }
    const obj = parsed as Record<string, unknown>;

    // (1) A versioned v2 file — salvaged PER-ENTRY (the readJsonArray idiom): global, each project
    // overlay, and each workflow are validated INDEPENDENTLY, keeping the good and dropping only the
    // bad. A single malformed sub-entry must never discard every unrelated project/workflow. We do
    // NOT rewrite the file here — the salvaged-good state is in memory, and the next real mutation
    // persists exactly that (good entries preserved, bad ones naturally gone), so a bad entry can
    // never clobber the roster to near-empty. The original file is left intact until then.
    if (obj.version === 2) {
      let dropped = 0;
      const g = roleRoutingSchema.safeParse(obj.global ?? {});
      if (g.success) this.global = g.data;
      else dropped++;
      this.projects = {};
      const projects =
        obj.projects && typeof obj.projects === 'object' && !Array.isArray(obj.projects)
          ? (obj.projects as Record<string, unknown>)
          : {};
      for (const [pid, entry] of Object.entries(projects)) {
        const p = projectRoutingSchema.safeParse(entry);
        if (p.success) this.projects[pid] = p.data;
        else dropped++;
      }
      this.workflows = [];
      for (const entry of Array.isArray(obj.workflows) ? obj.workflows : []) {
        const w = workflowProfileSchema.safeParse(entry);
        if (w.success) this.workflows.push(w.data);
        else dropped++;
      }
      if (dropped > 0) {
        console.error(
          `[routing] ${this.file} had ${dropped} unparseable routing entr${dropped === 1 ? 'y' : 'ies'} — ` +
            `kept the rest; the file is rewritten cleanly on the next routing change`,
        );
      }
      return;
    }

    // (2) No version:2, but versioned/v2-shaped keys present → a corrupt, downgraded, or FUTURE
    // format we don't understand. roleRoutingSchema is a non-strict partial, so this object would
    // "parse as legacy" to {} — and step 3's migration persist would then silently replace every
    // layer of config. Refuse: keep routing empty in memory, back the file up, do NOT write it.
    if ('version' in obj || 'global' in obj || 'projects' in obj || 'workflows' in obj) {
      this.backupBadFile();
      console.error(
        `[routing] ${this.file} looks like a corrupt or foreign versioned routing file — ` +
          `keeping routing EMPTY and NOT persisting over it (original saved to ${this.file}.bak)`,
      );
      return;
    }

    // (3) Legacy flat RoleRouting — STRICT parse, so only a genuinely role-shaped object migrates.
    const legacy = legacyRoleRoutingSchema.safeParse(obj);
    if (!legacy.success) {
      this.backupBadFile();
      console.error(
        `[routing] ${this.file} invalid — ignoring it (original saved to ${this.file}.bak): ${legacy.error.message}`,
      );
      return;
    }
    this.global = legacy.data;
    this.persist(); // wrap { version:2, global: legacy, projects:{}, workflows:[] }
    console.log(`[routing] migrated legacy routing.json to v2 (${Object.keys(legacy.data).length} role default(s))`);
  }

  /** Best-effort copy of an unreadable/foreign file to routing.json.bak BEFORE any possible write. */
  private backupBadFile(): void {
    try {
      copyFileSync(this.file, `${this.file}.bak`);
    } catch (err) {
      console.error(`[routing] could not back up ${this.file}: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    writeJsonAtomic(this.file, {
      version: 2,
      global: this.global,
      projects: this.projects,
      workflows: this.workflows,
    });
  }

  /** Parse + allowlist-check one routes map (shared by setAll / workflow / project writes). */
  private parseRoutes(routes: unknown, what: string): RoleRouting {
    const res = roleRoutingSchema.safeParse(routes ?? {});
    if (!res.success) throw new Error(`invalid ${what}: ${res.error.message}`);
    for (const [role, a] of Object.entries(res.data)) {
      if (a?.model !== undefined && !isValidModelId(a.model)) {
        throw new Error(`invalid model id "${a.model}" for role "${role}"`);
      }
      // SPEC-EFFORT §2 — write gate mirroring the model-id check (codex stays SYNTACTIC-only here, so a
      // per-model catalog-set mismatch is still writable — that mismatch is warning-tier at resolve time).
      if (a?.effort !== undefined && !isValidEffort(a.provider, a.effort)) {
        throw new Error(`invalid effort "${a.effort}" for role "${role}" (provider ${a.provider})`);
      }
    }
    return res.data;
  }

  // ---- global layer (the pre-v2 API surface, unchanged) ----

  /** A defensive copy of the current GLOBAL role defaults (never the live object). */
  get(): RoleRouting {
    return { ...this.global };
  }

  getRole(role: PipelineRole): RoleAssignment | undefined {
    return this.global[role];
  }

  /** Set one global role default (validates provider id + model allowlist). Returns the new routing. */
  setRole(role: PipelineRole, assignment: RoleAssignment): RoleRouting {
    if (!ROLE_KEYS.includes(role)) throw new Error(`unknown pipeline role "${role}"`);
    const res = roleAssignmentSchema.safeParse(assignment);
    if (!res.success) throw new Error(`invalid role assignment: ${res.error.message}`);
    if (res.data.model !== undefined && !isValidModelId(res.data.model)) {
      throw new Error(`invalid model id "${res.data.model}" (must match ${MODEL_ID_RE.source}, no leading dash)`);
    }
    // SPEC-EFFORT §2 — write gate (codex syntactic-only; a per-model set mismatch stays warning-tier).
    if (res.data.effort !== undefined && !isValidEffort(res.data.provider, res.data.effort)) {
      throw new Error(`invalid effort "${res.data.effort}" for provider ${res.data.provider}`);
    }
    this.global = { ...this.global, [role]: res.data };
    this.persist();
    return this.get();
  }

  /** Clear one global role default. Returns the new routing. */
  clearRole(role: PipelineRole): RoleRouting {
    if (!ROLE_KEYS.includes(role)) throw new Error(`unknown pipeline role "${role}"`);
    const next = { ...this.global };
    delete next[role];
    this.global = next;
    this.persist();
    return this.get();
  }

  /** Replace the whole GLOBAL routing map at once (validates every entry). Returns the new routing. */
  setAll(routing: RoleRouting): RoleRouting {
    this.global = this.parseRoutes(routing, 'routing');
    this.persist();
    return this.get();
  }

  // ---- workflows (SPEC-ROUTING §2/§4) ----

  listWorkflows(): WorkflowProfile[] {
    return this.workflows.map((w) => ({ ...w, routes: { ...w.routes } }));
  }

  getWorkflow(id: string): WorkflowProfile | undefined {
    const w = this.workflows.find((x) => x.id === id);
    return w ? { ...w, routes: { ...w.routes } } : undefined;
  }

  /** Upsert a workflow by id: a missing id is minted; ANY provided id is honored (unknown → create
   *  with that id, existing → full REPLACE). The route layer never forwards a client `id` on the
   *  POST create path (server mints there); PUT /:id passes the path id, which the web client relies
   *  on for create-or-replace. Routes validate like setAll. */
  upsertWorkflow(input: { id?: string; name: string; description?: string; routes?: RoleRouting }): WorkflowProfile {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new Error('workflow name is required');
    const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : undefined;
    const routes = this.parseRoutes(input.routes, `workflow "${name}" routes`);
    const now = new Date().toISOString();
    const id = input.id?.trim() || shortId();
    const existing = this.workflows.find((w) => w.id === id);
    // Replace semantics (PUT): the body IS the new workflow — an omitted description clears it.
    const wf: WorkflowProfile = {
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      routes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.workflows = existing ? this.workflows.map((w) => (w.id === id ? wf : w)) : [...this.workflows, wf];
    this.persist();
    return { ...wf, routes: { ...wf.routes } };
  }

  /**
   * Reference-check + delete in ONE synchronous method — no await between them (SPEC-ROUTING §7), so
   * a project can never select the workflow in the gap. Throws WorkflowReferencedError (→ 409)
   * listing the referencing project names while any project's workflowId === id. Returns whether
   * a workflow was actually removed (false = unknown id, an idempotent no-op).
   */
  deleteWorkflow(id: string, resolveProjectName?: (projectId: string) => string | undefined): boolean {
    const refs = Object.entries(this.projects)
      .filter(([, p]) => p.workflowId === id)
      .map(([pid]) => resolveProjectName?.(pid) ?? pid);
    if (refs.length > 0) throw new WorkflowReferencedError(id, refs);
    const next = this.workflows.filter((w) => w.id !== id);
    if (next.length === this.workflows.length) return false;
    this.workflows = next;
    this.persist();
    return true;
  }

  // ---- per-project overlays (SPEC-ROUTING §2/§4) ----

  getProjectRouting(projectId: string): ProjectRouting | undefined {
    const p = this.projects[projectId];
    if (!p) return undefined;
    return {
      ...(p.workflowId !== undefined ? { workflowId: p.workflowId } : {}),
      ...(p.routes !== undefined ? { routes: { ...p.routes } } : {}),
    };
  }

  /**
   * REPLACE a project's routing overlay (PUT semantics — both fields, not a patch). Routes
   * validate like setAll; an empty overlay (no workflowId, no routes) drops the entry entirely
   * (= inherit global). A workflowId is accepted even when no such workflow exists — deletion
   * refusal makes that unreachable via the API, and effectiveRouting surfaces it as the dangling
   * warning if it ever appears (hand-edited file, downgrade) — so a restore can't be order-locked.
   */
  setProjectRouting(projectId: string, routing: { workflowId?: string; routes?: RoleRouting }): ProjectRouting | undefined {
    if (!projectId) throw new Error('projectId is required');
    if (routing.workflowId !== undefined && typeof routing.workflowId !== 'string') {
      throw new Error('workflowId must be a string');
    }
    const workflowId = routing.workflowId?.trim() || undefined;
    const routes = routing.routes !== undefined ? this.parseRoutes(routing.routes, `project ${projectId} routes`) : undefined;
    const hasRoutes = routes !== undefined && Object.keys(routes).length > 0;
    const next = { ...this.projects };
    if (!workflowId && !hasRoutes) delete next[projectId];
    else next[projectId] = { ...(workflowId ? { workflowId } : {}), ...(hasRoutes ? { routes } : {}) };
    this.projects = next;
    this.persist();
    return this.getProjectRouting(projectId);
  }

  /** Drop a deleted project's overlay (stale entries are inert, but keep the file clean — §7). */
  pruneProject(projectId: string): boolean {
    if (!(projectId in this.projects)) return false;
    const next = { ...this.projects };
    delete next[projectId];
    this.projects = next;
    this.persist();
    return true;
  }

  // ---- composition (SPEC-ROUTING §3) ----

  /**
   * The layered view resolveRouting consumes: the project's ad-hoc routes over its selected
   * workflow's routes over the global defaults. Missing project / no selected workflow / a
   * DANGLING workflowId → that layer absent (the caller's `?? { global: {} }` stays valid —
   * consumers keep the optional-dep idiom). Defensive copies throughout.
   */
  layersFor(projectId?: string): LayeredRoleRouting {
    const layers: LayeredRoleRouting = { global: { ...this.global } };
    if (projectId !== undefined) {
      const p = this.projects[projectId];
      if (p?.routes && Object.keys(p.routes).length > 0) layers.project = { ...p.routes };
      const wf = p?.workflowId ? this.workflows.find((w) => w.id === p.workflowId) : undefined;
      if (wf) layers.workflow = { ...wf.routes };
    }
    return layers;
  }

  /**
   * Collapse the role tiers for one project into a PARTIAL provenance map (§4): only roles
   * configured at some layer appear, each with the layer that won and the post-gate resolved
   * model. Within a role the winning layer supplies the provider, and any LOWER layer's model is
   * rank-gated out exactly as resolveRouting would — so the model is the winner's own,
   * else the provider's defaultModel (flagged modelSource:'default'). `warnings` carries each
   * configured role's validateRoute findings plus the top-level dangling-workflowId warning (§7).
   * SPEC-TESTING §1 — the account resolves per role over its OWN project>workflow>global chain
   * under the provider-match gate (skipped tiers warn, mirroring the dangling-workflowId
   * treatment), and the winner surfaces as profileId + profileLabel on the effective route.
   */
  effectiveRouting(
    projectId?: string,
    store?: ProviderSecretLookup,
    profiles?: ProfileLookup,
    reservedProfileIds?: ReadonlySet<string>,
  ): { effective: EffectiveRouting; warnings: string[] } {
    const layers = this.layersFor(projectId);
    const effective: EffectiveRouting = {};
    const warnings: string[] = [];
    if (projectId !== undefined) {
      const wfId = this.projects[projectId]?.workflowId;
      if (wfId && !this.workflows.some((w) => w.id === wfId)) {
        warnings.push(`workflow "${wfId}" no longer exists; inheriting global defaults`);
      }
    }
    for (const role of ROLE_KEYS) {
      let a: RoleAssignment | undefined;
      let source: EffectiveRoleRoute['source'];
      if (layers.project?.[role] !== undefined) {
        a = layers.project[role];
        source = 'project';
      } else if (layers.workflow?.[role] !== undefined) {
        a = layers.workflow[role];
        source = 'workflow';
      } else if (layers.global[role] !== undefined) {
        a = layers.global[role];
        source = 'global';
      } else {
        continue; // unconfigured — OMITTED, the client falls through to its own tiers
      }
      if (!a) continue;
      const explicit = a.model !== undefined;
      const model = explicit ? a.model : store?.get(a.provider)?.model.defaultModel;
      // SPEC-TESTING §1 — the account resolves over the role's own layered chain (independent of
      // which layer won the provider), match-gated; a present-but-skipped tier warns.
      const account = resolveAccount(accountChain({ role }, {}, layers), a.provider, profiles);
      for (const s of account.skipped) {
        warnings.push(
          s.reason === 'unknown'
            ? `${role}: account ${s.profileId} (${s.tier} routing) no longer exists — skipped`
            : `${role}: account ${s.profileId} (${s.tier} routing) is not a ${a.provider} account — skipped`,
        );
      }
      const profileLabel = account.profileId !== undefined ? profiles?.getProfile(account.profileId)?.label : undefined;
      effective[role] = {
        provider: a.provider,
        ...(model !== undefined ? { model } : {}),
        // SPEC-EFFORT §1 — the WINNING layer's OWN effort only (no cross-layer fallback — same drop
        // reasoning as model: effort is provider-specific, a lower layer's effort must not ride up).
        ...(a.effort !== undefined ? { effort: a.effort } : {}),
        source,
        ...(!explicit && model !== undefined ? { modelSource: 'default' as const } : {}),
        ...(account.profileId !== undefined ? { profileId: account.profileId } : {}),
        ...(profileLabel !== undefined ? { profileLabel } : {}),
      };
      const v = validateRoute(a.provider, model, store, {
        resolvedProfileId: account.profileId,
        profiles,
        reservedProfileIds,
      }, undefined, a.effort);
      for (const msg of [...v.errors, ...v.warnings]) warnings.push(`${role}: ${msg}`);
    }
    return { effective, warnings };
  }

  /**
   * Drop every role assignment whose provider is the given (now-deleted) id — across the global
   * layer, EVERY project overlay, and EVERY workflow (§7) — so a removed provider can't strand an
   * invisible assignment that would fail every future mission's pre-start route check. Persists
   * and returns whether anything changed — the caller emits the change frame (this store never
   * imports the SSE/mission layer; that stays a server.ts concern).
   */
  pruneProvider(provider: ProviderId): boolean {
    let changed = false;
    const sweep = (routes: RoleRouting): RoleRouting => {
      const out: RoleRouting = {};
      for (const role of ROLE_KEYS) {
        const a = routes[role];
        if (!a) continue;
        if (a.provider === provider) changed = true; // stranded assignment — drop it
        else out[role] = a;
      }
      return out;
    };
    const nextGlobal = sweep(this.global);
    const nextWorkflows = this.workflows.map((w) => ({ ...w, routes: sweep(w.routes) }));
    const nextProjects: Record<string, ProjectRouting> = {};
    for (const [pid, p] of Object.entries(this.projects)) {
      const routes = p.routes ? sweep(p.routes) : undefined;
      const hasRoutes = routes !== undefined && Object.keys(routes).length > 0;
      const entry: ProjectRouting = {
        ...(p.workflowId !== undefined ? { workflowId: p.workflowId } : {}),
        ...(hasRoutes ? { routes } : {}),
      };
      if (entry.workflowId !== undefined || entry.routes !== undefined) nextProjects[pid] = entry;
    }
    if (changed) {
      this.global = nextGlobal;
      this.projects = nextProjects;
      this.workflows = nextWorkflows;
      this.persist();
    }
    return changed;
  }

  /**
   * SPEC-TESTING §1.6 — strip a deleted account's profileId FIELD from every role assignment
   * across the global layer, EVERY workflow, and EVERY project overlay (mirrors pruneProvider,
   * but the assignment itself STAYS — the provider/model routing outlives the account; the role
   * just falls back to the shared login dir). Wired into DELETE /api/profiles/:id. Mission/Loop/
   * sortie profileId on records is deliberately NOT rewritten (rewriting mission history on delete
   * is worse); a mid-flight explicit account pointing at the deleted profile hard-fails at the
   * start gate. Persists and returns whether anything changed — the caller emits the change frame.
   */
  pruneProfile(profileId: string): boolean {
    let changed = false;
    const sweep = (routes: RoleRouting): RoleRouting => {
      const out: RoleRouting = {};
      for (const role of ROLE_KEYS) {
        const a = routes[role];
        if (!a) continue;
        if (a.profileId === profileId) {
          changed = true; // stranded account — strip the field, keep the assignment
          const { profileId: _stripped, ...rest } = a;
          out[role] = rest;
        } else out[role] = a;
      }
      return out;
    };
    const nextGlobal = sweep(this.global);
    const nextWorkflows = this.workflows.map((w) => ({ ...w, routes: sweep(w.routes) }));
    const nextProjects: Record<string, ProjectRouting> = {};
    for (const [pid, p] of Object.entries(this.projects)) {
      nextProjects[pid] = {
        ...(p.workflowId !== undefined ? { workflowId: p.workflowId } : {}),
        ...(p.routes !== undefined ? { routes: sweep(p.routes) } : {}),
      };
    }
    if (changed) {
      this.global = nextGlobal;
      this.projects = nextProjects;
      this.workflows = nextWorkflows;
      this.persist();
    }
    return changed;
  }
}

// =====================================================================================
// §3 ⟦DP-10⟧ — hardened model discovery
// =====================================================================================

const DISCOVERY_TIMEOUT_MS = 5_000; // a hostile/slow endpoint can't hang the Tower
const DISCOVERY_MAX_BYTES = 1024 * 1024; // 1 MiB cap — a huge body can't OOM the Tower

export interface DiscoveryResult {
  ok: boolean;
  /** The stored roster after this probe (unchanged on failure — the prior roster is kept). */
  models: { id: string; verifiedAt?: string }[];
  /** A non-blocking note on failure; discovery failure never blocks onboarding or a run. */
  note?: string;
}

/** Join a baseUrl and a models path without doubling or dropping the slash. */
function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * Fetch a body under a hard timeout AND a hard byte cap, then JSON.parse it. The cap is enforced
 * by STREAMING the body and aborting past the ceiling (an early content-length check short-circuits
 * an honest-but-huge response), so we never buffer an unbounded body into memory.
 */
// SPEC-MODELS §2 — exported + a headers param so codex catalog discovery can pass its Bearer +
// chatgpt-account-id headers. Headers are NEVER logged; a thrown error carries only the status code.
export async function fetchCappedJson(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  headers?: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response too large (${declared} bytes)`);
    const text = await readCapped(res, maxBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('response was not valid JSON');
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(`timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Read a Response body, aborting and throwing once the accumulated bytes exceed `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`response exceeded ${maxBytes} byte cap`);
    return text;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* best-effort */
      }
      throw new Error(`response exceeded ${maxBytes} byte cap`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Extract candidate model ids from a discovery response. Supports the OpenAI-compatible shape
 * (`{ data: [{ id }] }` — OpenRouter/Groq/Together/DeepSeek/vLLM/Ollama's compat layer) and
 * Ollama's native shape (`{ models: [{ name }] }`, reached via modelsPath '/api/tags'). Any other
 * shape returns null → the caller treats it as a failure and keeps the prior roster.
 */
function extractModelIds(json: unknown): string[] | null {
  if (!json) return null;
  // Some endpoints (e.g. Together's /v1/models) return a bare top-level array of OpenAI-style
  // { id } objects rather than wrapping it in { data } / { models }.
  if (Array.isArray(json)) {
    return json
      .map((d) => (d && typeof d === 'object' ? (d as { id?: unknown }).id : undefined))
      .filter((v): v is string => typeof v === 'string');
  }
  if (typeof json !== 'object') return null;
  const obj = json as { data?: unknown; models?: unknown };
  if (Array.isArray(obj.data)) {
    return obj.data
      .map((d) => (d && typeof d === 'object' ? (d as { id?: unknown }).id : undefined))
      .filter((v): v is string => typeof v === 'string');
  }
  if (Array.isArray(obj.models)) {
    return obj.models
      .map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : undefined))
      .filter((v): v is string => typeof v === 'string');
  }
  return null;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Probe a provider's models endpoint and, on success, persist the last-verified roster back onto
 * the def (via upsert, which rebuilds the registry + emits the `providers` SSE frame — BP1). All
 * failure modes (no baseUrl, endpoint down, timeout, over-cap, non-JSON, wrong shape, everything
 * filtered out) resolve to `{ ok: false, note }` with the PRIOR roster untouched — discovery is a
 * convenience that never blocks onboarding or a run (§3). Discovered ids pass the SAME allowlist
 * manual entries do, so a stored id is always safe to bind as a separate argv token.
 */
export async function discoverModels(id: ProviderId, store: ProviderDefWriter): Promise<DiscoveryResult> {
  const def = store.get(id);
  if (!def) return { ok: false, models: [], note: `unknown provider ${id}` };
  const prior = def.model.models ?? [];
  if (!def.baseUrl) return { ok: false, models: prior, note: `provider ${id} has no baseUrl to probe` };

  const url = joinUrl(def.baseUrl, def.model.modelsPath ?? '/v1/models');
  let json: unknown;
  try {
    json = await fetchCappedJson(url, DISCOVERY_TIMEOUT_MS, DISCOVERY_MAX_BYTES);
  } catch (err) {
    return { ok: false, models: prior, note: `couldn't reach ${url}: ${(err as Error).message}` };
  }

  const raw = extractModelIds(json);
  if (raw === null) return { ok: false, models: prior, note: `unexpected response shape from ${url}` };

  const ids = dedupe(raw.filter(isValidModelId));
  if (ids.length === 0) return { ok: false, models: prior, note: `no valid model ids from ${url}` };

  const now = new Date().toISOString();
  const models = ids.map((mid) => ({ id: mid, verifiedAt: now }));
  // A3 TOCTOU: the def may have been DELETED during the (awaited) probe above. Re-read before
  // writing — upserting the pre-fetch `def` would RESURRECT a provider the operator just removed
  // (worse: its secret files are already unlinked). If it's gone now, discard the result; if it
  // was edited concurrently, merge onto the FRESH def so we don't clobber that edit's fields.
  const fresh = store.get(id);
  if (!fresh) return { ok: false, models: [], note: `provider ${id} was removed during discovery` };
  const updated = store.upsert({ ...fresh, model: { ...fresh.model, models }, updatedAt: now });
  return { ok: true, models: updated.model.models ?? models };
}
