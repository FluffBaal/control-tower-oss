// SPEC-SKILLS per-project delivery — the 'sortie-brief' channel. Global skills reach agents through
// the per-ACCOUNT configDir sync (materialize.ts); a project-scoped selection can NEVER ride that
// channel, because the configDir is shared across every project a same-account terminal serves — a
// project-dependent sync in project B would delete project A's live skills out from under A's
// still-running agent (the baseEligibleSkills rationale in materialize.ts). This module renders the
// complement instead: a bounded POINTER block appended to a loop's task prompt, naming each
// per-project skill and where its body lives in the CENTRAL store (~/.ct/skills/<id>/body.md). No
// filesystem writes at all — delivery IS the pane text, so the destructive-deletion class that rules
// out the configDir is structurally absent.
//
// Clearance (the autonomy invariant's brief-channel leg): an UNCLEARED assistant-origin skill is
// excluded when the receiving builder is skip-permissions (`excludeUncleared`). Deliberately ONLY
// that leg — the configDir sync's second leg (hasLiveBypass on the account dir) is NOT applied here,
// because it guards a SHARED FILESYSTEM read by every same-account session including bypass ones,
// where an interactive sync can arm a bypass agent. The brief is typed into exactly one pane and read
// only by that session: an interactive builder receiving an uncleared skill's pointer places no text
// where a bypass agent reads. And the central body file exists on disk regardless of delivery (the
// store wrote it at upsert), so the pointer adds no filesystem exposure. Delivery == the pane text;
// the pane is the boundary.
//
// Readability assumption (stated, not checked per-call): central bodies/assets are 0600 but owned by
// the daemon's OS user, and every loop builder is a local tmux pane spawned as that same user, so a
// same-user read succeeds. Loop builders are always local tmux — remote provisioning (isolation.ts)
// is a separate assistant feature, not on the loops spawn path. Readable is not executable, though:
// brief-delivered assets are the CENTRAL 0600 copies (an asset's exec bit is METADATA, restored only
// in materialized configDir dirs), so a body that invokes `{{skillDir}}/x.sh` directly must route it
// through an interpreter (`sh x.sh`) — or the skill should be global-scoped so exec delivery rides
// the configDir channel.
//
// Staleness: the brief is frozen at loop create, like `task` itself. A skill DELETED mid-loop leaves
// a dangling pointer — the agent's read fails LOUDLY (file gone), and the entry still carries
// name/description inline so intent survives. A skill EDITED mid-loop yields the new body (the
// pointer is by-id, not by-hash) — acceptable, arguably correct, with ONE carve-out: an edit (or
// promote/rollback) that DROPS a delivered assistant skill's clearance via the hash-keyed reset
// suppresses the whole brief on a skip-permissions loop at the next inject (the live re-check in
// loops.ts keys on `assistantIds` below) — the by-id pointer must never keep feeding now-uncleared
// content to a bypass pane. Neither shape is chased with invalidation machinery beyond that.
//
// Custom providers (`custom:<slug>`) get no brief — providerEligible has no channel for them, the
// same fail-closed posture as both existing channels. A deliberate decision, not an accident.

import type { ProviderId, Skill } from '../../shared/types.js';
import { providerEligible, sectionGateText } from './materialize.js';
import { renderSectionBody, SECTION_BUDGET_BYTES, type SectionNote } from './sections.js';
import { needsAutonomyClearance, centralBodyPath, centralAssetsDir } from './store.js';

// Per-entry prose clamps: the brief is a pointer block, not a body — descriptions/triggers are
// context for choosing to read the file, so they fold to one bounded line each.
const MAX_BRIEF_DESCRIPTION = 300;
const MAX_BRIEF_TRIGGER = 200;

/** The block's lead-in. Plain prose, no vendor names or bracketed markers — it lands in panes agents
 *  quote onward (the sections/materialize precedent). */
const BRIEF_HEADER = 'Project skills for this task (not preinstalled; read the body file before using one):';

/**
 * Whether `skill` is brief-deliverable to `provider` on skill grounds alone — per-project scope
 * (globals ride the configDir channel; the two sets are disjoint by construction, so double-delivery
 * is impossible), provider-eligible (the built-in three only; custom providers get nothing,
 * fail-closed), not user-only (a `model:'never'` skill has no enforcement surface in pane text —
 * the same fail-closed skip the non-user-only configDir channels apply), and carrying no per-provider
 * body variant (the by-id pointer names the BASE body only — there is no on-disk file for an override
 * body, so delivering the pointer would hand this provider the WRONG content; skip fail-safe).
 * Clearance is DELIBERATELY not part of this predicate: it is per-terminal, keyed at render. The
 * SINGLE source for both the render filter below and the projectSkillsView `delivered` flag
 * (server.ts).
 */
export function briefDeliverable(skill: Skill, provider: ProviderId): boolean {
  return (
    skill.scope !== 'global' &&
    providerEligible(skill, provider) &&
    skill.invocation.model !== 'never' &&
    !skill.providerOverrides?.[provider]?.body
  );
}

/** Counts only, never contents — the no-secrets-in-audit posture (materialize.ts). */
export type SkillBriefCounts = {
  entries: number;
  gated: number;
  skippedUncleared: number;
  skippedUnsupported: number;
  skippedIneligible: number;
  skippedProviderBody: number;
};

export type SkillBrief = {
  /** The rendered pointer block, or undefined when everything filtered out — the counts still come
   *  back so an all-skipped selection is audited, never silent (exactly where skippedUncleared
   *  matters most). */
  text: string | undefined;
  /** ≥1 delivered skill still needs autonomy clearance (possible only when excludeUncleared was
   *  false, i.e. an interactive builder) — persisted next to the brief as the inject-time belt flag. */
  hasUncleared: boolean;
  counts: SkillBriefCounts;
  /** Ids of DELIVERED assistant-origin skills — the by-id live pointers a skip-permissions loop
   *  re-verifies at every inject: clearance is content-hash-keyed, so a mid-loop edit/promote/rollback
   *  can drop it while the frozen brief keeps pointing at the same body file. */
  assistantIds: string[];
};

/** Collapse to one line and clamp — a pointer entry never carries multi-line authored prose. */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Render the per-project pointer block for a resolved selection. `entries` is the project's resolved
 * effective set (resolveForProject — the ONE resolution site); this filters it to the
 * brief-deliverable complement of the configDir channel and renders a bounded block via
 * renderSectionBody: blocking-gate policy lines FIRST (never silently dropped — sectionGateText, the
 * same renderer the configDir span uses, so one wording everywhere), then one note per skill that
 * folds to its pointer line under the ~4KB soft / 8KB hard budget with an honest "…and N more"
 * summary. ALWAYS returns a brief: when the filtered set is empty, `text` is undefined (the
 * no-selection default stays a byte-zero prompt change) but the counts still come back, so an
 * all-skipped selection is audited rather than vanishing — the caller (loops.ts) audits whenever it
 * gets a brief, text or not.
 */
export function renderSkillBrief(
  entries: { skill: Skill }[],
  provider: ProviderId,
  excludeUncleared: boolean,
): SkillBrief {
  const counts: SkillBriefCounts = {
    entries: 0,
    gated: 0,
    skippedUncleared: 0,
    skippedUnsupported: 0,
    skippedIneligible: 0,
    skippedProviderBody: 0,
  };
  const kept: Skill[] = [];
  // Every non-kept path increments exactly ONE counter — no silent skips. Global is the sole
  // uncounted continue: it rides the configDir channel by design, disjoint from this one, so it is
  // not a "skip" of anything this channel owes. The three per-reason checks together MUST stay
  // equivalent to !briefDeliverable for a non-global skill (a test pins the equivalence, so the
  // single-source property shared with the server's `delivered` flag can't silently drift).
  for (const { skill } of entries) {
    if (skill.scope === 'global') continue; // rides the configDir channel — never double-delivered
    if (!providerEligible(skill, provider)) {
      counts.skippedIneligible++;
      continue;
    }
    // Counted, not silent: a provider-reachable user-only skill stays undelivered by design (the
    // no-enforcement-surface rationale in the module header).
    if (skill.invocation.model === 'never') {
      counts.skippedUnsupported++;
      continue;
    }
    // A per-provider body variant has no on-disk pointer target — the base body would be WRONG for
    // this provider (the briefDeliverable rationale above). Fail-safe: skip + count, never mis-point.
    if (skill.providerOverrides?.[provider]?.body) {
      counts.skippedProviderBody++;
      continue;
    }
    if (excludeUncleared && needsAutonomyClearance(skill)) {
      counts.skippedUncleared++;
      continue;
    }
    kept.push(skill);
  }
  if (kept.length === 0) return { text: undefined, hasUncleared: false, counts, assistantIds: [] };

  const gateLines = kept.flatMap(sectionGateText);
  counts.entries = kept.length;
  counts.gated = gateLines.length;
  const notes: SectionNote[] = kept.map((s) => {
    const lines = [oneLine(s.description, MAX_BRIEF_DESCRIPTION)];
    if (s.trigger) lines.push(`Use when: ${oneLine(s.trigger, MAX_BRIEF_TRIGGER)}`);
    lines.push(`Body: ${centralBodyPath(s.id)}`);
    if (s.assets?.length) {
      // The layout remap (central store vs a materialized dir — see centralAssetsDir): bodies hold the
      // reserved token RAW here, so state the one honest mapping instead of rewriting the body.
      lines.push(`Assets: ${centralAssetsDir(s.id)}/ — any {{skillDir}}/X in the body means that dir's X`);
    }
    return {
      name: s.name === s.id ? s.name : `${s.name} (${s.id})`,
      body: lines.filter((l) => l !== '').join('\n'),
      pointer: centralBodyPath(s.id),
    };
  });
  return {
    text: `${BRIEF_HEADER}\n\n${renderSectionBody(gateLines, notes, SECTION_BUDGET_BYTES)}`,
    hasUncleared: kept.some(needsAutonomyClearance),
    counts,
    assistantIds: kept.filter((s) => s.origin === 'assistant').map((s) => s.id),
  };
}
