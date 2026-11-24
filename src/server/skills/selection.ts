// SPEC-SKILLS Phase 3 — per-project skill SELECTION: named bundles + per-project overlays, plus the
// resolution VIEW that collapses them into a project's effective skill set. This is a leaf, a direct
// clone of RoutingStore (../providers/routing.ts): a v-envelope with PER-ENTRY zod salvage on load,
// foreign/future-version refusal + .bak, atomic 0600 writes, PUT-replace / empty-drops-entry mutation
// semantics, dangling-id tolerance (a restore can't be order-locked), and a reference-hygiene pair
// (deleteBundle's referenced-error guard + pruneSkill's field-strip). It owns ~/.ct/config/skill-
// selection.json and imports nothing from materialize/loops/missions, so those may compose it freely.
//
// It is deliberately NOT part of SkillStore: the library (bodies on disk, stage-swap) and the selection
// (pure JSON config) have different write disciplines, the deletion guards need bundle+project checks in
// ONE synchronous store, and the Project/Skill records' main-store zod is the M6 strip-trap surface this
// avoids touching. The resolver is a standalone pure function so the materializer can reuse it for the
// GLOBAL baseline without importing this store (no cycle) — see resolveSkillSelection below.

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../paths.js';
import { shortId, isSafeName } from '../ids.js';
import { isProtectedSkill } from './store.js';
import type { Skill, SkillBundle, ProjectSkills } from '../../shared/types.js';

// ---- Field caps. Prose/lists are SANITIZED (clamped + dropped) like the SkillStore sanitizers; the
//      enable-map is the one REJECT-over-cap surface — a silently dropped `false` would silently
//      RE-ENABLE a skill, the permission-ish fail-closed class (mirrors skillModelSchema's reasoning). ----
const MAX_BUNDLE_NAME = 120;
const MAX_BUNDLE_DESCRIPTION = 4000;
const MAX_BUNDLE_SKILLS = 256;
const MAX_ENABLE_ENTRIES = 512;

// ---- Self-contained zod mirror — EVERY persisted field listed (the M6 strip-trap: an unlisted optional
//      field is stripped on load). enable is z.record(string, boolean): its keys are skill ids, NOT a
//      fixed role enum, so (unlike routing's role map) a plain record is correct here. ----
const skillBundleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  skillIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const projectSkillsSchema = z.object({
  bundleId: z.string().min(1).optional(),
  enable: z.record(z.string(), z.boolean()).optional(),
});

/** Atomic write (temp + rename) mirroring RoutingStore's own; 0600 since it is Tower-owned config. */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

/** Trim + isSafeName-filter + dedupe (order-preserving) + cap a skill-id list — clamp/drop, never throw
 *  (the SkillStore sanitizeStrList posture: one bad id must not reject the whole bundle). */
function sanitizeSkillIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!isSafeName(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_BUNDLE_SKILLS) break;
  }
  return out;
}

/**
 * Sanitize a project's enable map: keys isSafeName-filtered, values coerced with `=== true`. REJECTS
 * (throws) over MAX_ENABLE_ENTRIES rather than clamping — a dropped `false` would silently re-enable a
 * skill a project deliberately turned off, so this fails CLOSED. Returns undefined for an empty map so
 * an empty overlay drops the project entry.
 */
function sanitizeEnable(v: unknown): Record<string, boolean> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('enable must be an object');
  const out: Record<string, boolean> = {};
  let count = 0;
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    const k = key.trim();
    if (!isSafeName(k)) continue; // an unsafe key can never name a real skill — drop it
    count++;
    if (count > MAX_ENABLE_ENTRIES) throw new Error(`too many skill overrides (>${MAX_ENABLE_ENTRIES})`);
    out[k] = val === true;
  }
  return Object.keys(out).length ? out : undefined;
}

function capStr(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

/** Thrown by deleteBundle while any project still selects the bundle — the route maps it to a 409
 *  carrying the referencing project names (the WorkflowReferencedError clone, routing.ts). */
export class BundleReferencedError extends Error {
  constructor(
    readonly bundleId: string,
    /** Referencing project NAMES (falls back to the id when no resolver is wired). */
    readonly referencedBy: string[],
  ) {
    super(
      `skill bundle is selected by ${referencedBy.length} project(s): ${referencedBy.join(', ')} — unassign it there before deleting`,
    );
    this.name = 'BundleReferencedError';
  }
}

// =====================================================================================
// Resolution — a VIEW, never persisted (the LayeredRoleRouting/effectiveRouting mirror)
// =====================================================================================

/** One resolved entry: the skill plus the most-specific tier that selected it. */
export interface ResolvedSelection {
  /** In deterministic skill-id order. */
  entries: { skill: Skill; source: 'project' | 'bundle' | 'global' }[];
  warnings: string[];
}

/**
 * Collapse the tiers into a project's effective skill set (SPEC-SKILLS Phase 3 §2). PURE — takes the
 * skill list and (optionally) the project's resolved bundle + overlay, so the materializer can call it
 * for the GLOBAL baseline (no `selection`) WITHOUT importing this store. Rules, in order:
 *  1. baseline: every `enabled && scope==='global'` skill → in, source 'global'. With NO selection this
 *     IS today's materialized set — the identity the §5 refactor and its no-change test key on.
 *  2. the selected bundle's members → in, source 'bundle' (provenance UPGRADES a global∩bundle member;
 *     the SET is unchanged). A dangling member id / dangling bundleId → a warning, excluded.
 *  3. `enable` overrides, ATOMIC per id: true adds (source 'project' — how a scope:'project' skill is
 *     turned on without a bundle); false removes whatever tier included it. Unknown-id true → warning.
 *  4. `skill.enabled === false` ALWAYS excludes — the library master switch beats a project enable:true
 *     (fail-closed; a project override widens selection, never resurrection). Applied as a universal
 *     filter LAST, so rules 1-3 need no per-rule enabled check.
 */
export function resolveSkillSelection(
  skills: Skill[],
  selection?: { bundle?: SkillBundle; project?: ProjectSkills },
): ResolvedSelection {
  const byId = new Map(skills.map((s) => [s.id, s]));
  const chosen = new Map<string, 'project' | 'bundle' | 'global'>();
  const warnings: string[] = [];

  // 1. Global baseline.
  for (const s of skills) {
    if (s.enabled && s.scope === 'global') chosen.set(s.id, 'global');
  }

  if (selection) {
    const { bundle, project } = selection;
    // 2. The selected bundle's members (provenance upgrades to 'bundle'; the set is unchanged for a
    //    global∩bundle member). A selected-but-missing bundle inherits the global set only.
    if (project?.bundleId && !bundle) {
      warnings.push(`skill bundle "${project.bundleId}" no longer exists; using global skills only`);
    }
    if (bundle) {
      for (const sid of bundle.skillIds) {
        if (!byId.has(sid)) {
          warnings.push(`skill "${sid}" in bundle "${bundle.name}" no longer exists`);
          continue;
        }
        chosen.set(sid, 'bundle');
      }
    }
    // 3. Per-skill overrides (most specific).
    for (const [sid, on] of Object.entries(project?.enable ?? {})) {
      if (on) {
        if (!byId.has(sid)) {
          warnings.push(`skill "${sid}" enabled for this project no longer exists`);
          continue;
        }
        chosen.set(sid, 'project');
      } else {
        chosen.delete(sid); // false removes whatever tier included it (even a default-on global)
      }
    }
  }

  // 4. Universal master-switch filter: a disabled skill can never appear, whatever tier chose it.
  const entries: ResolvedSelection['entries'] = [];
  for (const [sid, source] of chosen) {
    const skill = byId.get(sid);
    if (!skill || skill.enabled === false) continue;
    entries.push({ skill, source });
  }
  entries.sort((a, b) => (a.skill.id < b.skill.id ? -1 : a.skill.id > b.skill.id ? 1 : 0));
  return { entries, warnings };
}

/**
 * SPEC-SKILLS Phase 5b wave 2 — the effective-set delta a selection REPLACE would cause: which skills
 * are effective under `current` but NOT under `proposed`, both sides resolved through
 * resolveSkillSelection (the ONE resolution site). `droppedProtected` (isProtectedSkill — the single
 * derivation site) is what the operator retype gate and the assistant's set_project_skills enrich
 * refusal both key on; `dropped` names ALL leaving skills for the destructive-replace card note. Both
 * lists are name-sorted so the gate's expected retype string is deterministic. PURE — the store
 * methods below feed it the persisted-bytes view of each side.
 */
export function selectionReplaceDelta(
  skills: Skill[],
  current: { bundle?: SkillBundle; project?: ProjectSkills },
  proposed: { bundle?: SkillBundle; project?: ProjectSkills },
): { dropped: string[]; droppedProtected: string[] } {
  const byId = new Map(skills.map((sk) => [sk.id, sk]));
  const effIds = (side: { bundle?: SkillBundle; project?: ProjectSkills }): Set<string> =>
    new Set(resolveSkillSelection(skills, side).entries.map((e) => e.skill.id));
  const propEff = effIds(proposed);
  const dropped: string[] = [];
  const droppedProtected: string[] = [];
  for (const sid of effIds(current)) {
    if (propEff.has(sid)) continue;
    const sk = byId.get(sid);
    const name = sk?.name ?? sid;
    dropped.push(name);
    if (sk && isProtectedSkill(sk)) droppedProtected.push(name);
  }
  dropped.sort();
  droppedProtected.sort();
  return { dropped, droppedProtected };
}

/**
 * Persists the per-project skill selection in ~/.ct/config/skill-selection.json v1 — named bundles +
 * per-project overlays (SPEC-SKILLS Phase 3 §1). Loaded PER-ENTRY (one bad bundle/project drops alone),
 * a foreign/future-versioned file is backed up and NEVER written over. The list/upsert/delete/get/set
 * methods ARE the config API surface; the integrator registers thin routes over them.
 */
export class SkillSelectionStore {
  private bundles: SkillBundle[] = [];
  private projects: Record<string, ProjectSkills> = {};

  constructor(private readonly file: string = paths.skillSelection) {
    this.load();
  }

  /** Detection order mirrors RoutingStore.load: (1) version===1 → salvage per-entry; (2) versioned/
   *  shaped but not v1 → foreign/future, back up + keep empty + NEVER persist over it; (3) an object
   *  with none of our keys → ignore (no legacy format exists). A single bad sub-entry never discards
   *  the rest, and load NEVER rewrites — the next real mutation persists the salvaged-good state. */
  private load(): void {
    if (!existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      console.error(`[skill-selection] cannot read ${this.file}: ${(err as Error).message}`);
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`[skill-selection] ${this.file} is not an object — ignoring it`);
      return;
    }
    const obj = parsed as Record<string, unknown>;

    if (obj.version === 1) {
      let dropped = 0;
      this.bundles = [];
      for (const entry of Array.isArray(obj.bundles) ? obj.bundles : []) {
        const b = skillBundleSchema.safeParse(entry);
        if (b.success) this.bundles.push(b.data);
        else dropped++;
      }
      this.projects = {};
      const projects =
        obj.projects && typeof obj.projects === 'object' && !Array.isArray(obj.projects)
          ? (obj.projects as Record<string, unknown>)
          : {};
      for (const [pid, entry] of Object.entries(projects)) {
        const p = projectSkillsSchema.safeParse(entry);
        if (p.success) this.projects[pid] = p.data;
        else dropped++;
      }
      if (dropped > 0) {
        console.error(
          `[skill-selection] ${this.file} had ${dropped} unparseable entr${dropped === 1 ? 'y' : 'ies'} — ` +
            `kept the rest; the file is rewritten cleanly on the next change`,
        );
      }
      return;
    }

    // A versioned/shaped file we don't understand (corrupt, downgraded, or a FUTURE format): refuse it
    // — keep the selection empty in memory, back the file up, do NOT persist over it.
    if ('version' in obj || 'bundles' in obj || 'projects' in obj) {
      this.backupBadFile();
      console.error(
        `[skill-selection] ${this.file} looks like a corrupt or foreign versioned file — ` +
          `keeping the selection EMPTY and NOT persisting over it (original saved to ${this.file}.bak)`,
      );
      return;
    }

    console.error(`[skill-selection] ${this.file} has no recognized keys — ignoring it`);
  }

  private backupBadFile(): void {
    try {
      copyFileSync(this.file, `${this.file}.bak`);
    } catch (err) {
      console.error(`[skill-selection] could not back up ${this.file}: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    writeJsonAtomic(this.file, { version: 1, bundles: this.bundles, projects: this.projects });
  }

  // ---- bundles ----

  listBundles(): SkillBundle[] {
    return this.bundles.map((b) => ({ ...b, skillIds: [...b.skillIds] }));
  }

  getBundle(id: string): SkillBundle | undefined {
    const b = this.bundles.find((x) => x.id === id);
    return b ? { ...b, skillIds: [...b.skillIds] } : undefined;
  }

  /** Upsert a bundle by id: a missing id is minted (shortId); ANY provided id is honored (unknown →
   *  create with that id, existing → full REPLACE — PUT semantics, an omitted description clears it).
   *  skillIds sanitize (isSafeName-filter + dedupe + cap); a dangling id is ACCEPTED (a restore can't
   *  be order-locked — the routing.ts:875-881 rationale) and surfaced as a resolution warning. */
  upsertBundle(input: { id?: string; name?: string; description?: string; skillIds?: string[] }): SkillBundle {
    const name = capStr(input.name, MAX_BUNDLE_NAME);
    if (!name) throw new Error('skill bundle name is required');
    const description = capStr(input.description, MAX_BUNDLE_DESCRIPTION) || undefined;
    const skillIds = sanitizeSkillIds(input.skillIds);
    const now = new Date().toISOString();
    const id = input.id?.trim() || shortId();
    if (!isSafeName(id)) throw new Error(`invalid skill bundle id: ${id}`);
    const existing = this.bundles.find((b) => b.id === id);
    const bundle: SkillBundle = {
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      skillIds,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.bundles = existing ? this.bundles.map((b) => (b.id === id ? bundle : b)) : [...this.bundles, bundle];
    this.persist();
    return { ...bundle, skillIds: [...bundle.skillIds] };
  }

  /**
   * Reference-check + delete in ONE synchronous method — no await between them, so a project can never
   * select the bundle in the gap. Throws BundleReferencedError (→ 409) listing the referencing project
   * names (resolved via `resolveProjectName`, id fallback) while any project's bundleId === id. Returns
   * whether a bundle was actually removed (false = unknown id, an idempotent no-op).
   */
  deleteBundle(id: string, resolveProjectName?: (projectId: string) => string | undefined): boolean {
    const refs = this.projectsSelectingBundle(id).map((pid) => resolveProjectName?.(pid) ?? pid);
    if (refs.length > 0) throw new BundleReferencedError(id, refs);
    const next = this.bundles.filter((b) => b.id !== id);
    if (next.length === this.bundles.length) return false;
    this.bundles = next;
    this.persist();
    return true;
  }

  // ---- per-project overlays ----

  getProjectSkills(projectId: string): ProjectSkills | undefined {
    const p = this.projects[projectId];
    if (!p) return undefined;
    return {
      ...(p.bundleId !== undefined ? { bundleId: p.bundleId } : {}),
      ...(p.enable !== undefined ? { enable: { ...p.enable } } : {}),
    };
  }

  /**
   * REPLACE a project's overlay (PUT semantics — both fields, not a patch). An empty overlay (no
   * bundleId, empty/absent enable) drops the entry entirely (= inherit the global set). A bundleId is
   * accepted even when no such bundle exists — deleteBundle's refusal makes that unreachable via the
   * API, and the resolver surfaces it as a dangling warning if it ever appears (hand-edited file).
   */
  setProjectSkills(projectId: string, overlay: { bundleId?: string; enable?: Record<string, boolean> }): ProjectSkills | undefined {
    if (!projectId) throw new Error('projectId is required');
    if (overlay.bundleId !== undefined && typeof overlay.bundleId !== 'string') {
      throw new Error('bundleId must be a string');
    }
    const bundleId = overlay.bundleId?.trim() || undefined;
    const enable = sanitizeEnable(overlay.enable); // may THROW on an over-cap map (fail-closed)
    const next = { ...this.projects };
    if (!bundleId && !enable) delete next[projectId];
    else next[projectId] = { ...(bundleId ? { bundleId } : {}), ...(enable ? { enable } : {}) };
    this.projects = next;
    this.persist();
    return this.getProjectSkills(projectId);
  }

  // ---- replace-delta views (SPEC-SKILLS Phase 5b wave 2 — the selection-side retype gate) ----

  /** Project ids whose overlay SELECTS `bundleId` — the bundle gate's blast radius, and deleteBundle's
   *  reference set. Sync, read-only; returns ids, the caller resolves names. */
  projectsSelectingBundle(bundleId: string): string[] {
    return Object.entries(this.projects)
      .filter(([, p]) => p.bundleId === bundleId)
      .map(([pid]) => pid);
  }

  /**
   * The delta a full overlay REPLACE of `projectId` would cause, computed over the SANITIZED overlay —
   * the exact form setProjectSkills would persist (same bundleId trim + sanitizeEnable `=== true`
   * coercion), so a coercible wire value (`enable: {x: 'no'}` resolves truthy but PERSISTS false) can
   * never make the gate and the write disagree. Throws exactly where the write would (non-string
   * bundleId, over-cap enable map). Shared by the operator PUT gate on /api/projects/:id/skills and
   * the assistant's set_project_skills enrich refusal, so the two can never diverge.
   */
  projectReplaceDelta(
    skills: Skill[],
    projectId: string,
    proposed: { bundleId?: string; enable?: Record<string, boolean> },
  ): { dropped: string[]; droppedProtected: string[] } {
    if (proposed.bundleId !== undefined && typeof proposed.bundleId !== 'string') {
      throw new Error('bundleId must be a string');
    }
    const bundleId = proposed.bundleId?.trim() || undefined;
    const enable = sanitizeEnable(proposed.enable); // may THROW on an over-cap map (fail-closed)
    const proposedProject: ProjectSkills | undefined =
      bundleId || enable ? { ...(bundleId ? { bundleId } : {}), ...(enable ? { enable } : {}) } : undefined;
    const bundleOf = (p?: ProjectSkills): SkillBundle | undefined =>
      p?.bundleId ? this.bundles.find((b) => b.id === p.bundleId) : undefined;
    const cur = this.projects[projectId];
    return selectionReplaceDelta(
      skills,
      { bundle: bundleOf(cur), project: cur },
      { bundle: bundleOf(proposedProject), project: proposedProject },
    );
  }

  /**
   * The cross-project delta a bundle REPLACE would cause: for every project selecting `bundleId`, diff
   * its effective set under the current members vs the SANITIZED proposed members (sanitizeSkillIds —
   * the exact list upsertBundle would persist, so an omitted skillIds is the empty-the-bundle replace
   * it really is). Returns the union of protected names that would leave any selecting project's
   * effective set (name-sorted — the gate's expected retype string) plus the affected projects
   * (`resolveProjectName` resolves ids to names, id fallback — the deleteBundle convention). A bundle
   * no project selects, or an edit that only ADDS members, yields empty lists.
   */
  bundleReplaceDelta(
    skills: Skill[],
    bundleId: string,
    proposedSkillIds: unknown,
    resolveProjectName?: (projectId: string) => string | undefined,
  ): { droppedProtected: string[]; affectedProjects: string[] } {
    const current = this.bundles.find((b) => b.id === bundleId);
    const proposed: SkillBundle = {
      id: bundleId,
      name: current?.name ?? '',
      skillIds: sanitizeSkillIds(proposedSkillIds),
      createdAt: current?.createdAt ?? '',
      updatedAt: current?.updatedAt ?? '',
    };
    const droppedProtected = new Set<string>();
    const affectedProjects: string[] = [];
    for (const pid of this.projectsSelectingBundle(bundleId)) {
      const project = this.projects[pid];
      const delta = selectionReplaceDelta(skills, { bundle: current, project }, { bundle: proposed, project });
      if (!delta.droppedProtected.length) continue;
      affectedProjects.push(resolveProjectName?.(pid) ?? pid);
      for (const n of delta.droppedProtected) droppedProtected.add(n);
    }
    return { droppedProtected: [...droppedProtected].sort(), affectedProjects };
  }

  // ---- reference hygiene (feeds the DELETE /api/skills/:id guard) ----

  /** Skills that AFFIRMATIVELY reference `skillId`: bundles whose skillIds contain it, plus projects
   *  whose enable[skillId] === true. An enable:false entry is NOT a reference (suppressing a nonexistent
   *  skill is inert — pruneSkill sweeps it). Sync, read-only — returns ids, the route resolves names. */
  skillReferences(skillId: string): { bundles: string[]; projects: string[] } {
    return {
      bundles: this.bundles.filter((b) => b.skillIds.includes(skillId)).map((b) => b.id),
      projects: Object.entries(this.projects)
        .filter(([, p]) => p.enable?.[skillId] === true)
        .map(([pid]) => pid),
    };
  }

  /**
   * Strip a deleted skill from the selection (the pruneProfile field-strip mirror): remove its enable-map
   * ENTRY (true AND false) from every project, and (belt) remove it from every bundle's skillIds. An
   * overlay that empties out is dropped. Called AFTER a delete that passed the reference guard, so in
   * practice it sweeps enable:false leftovers. Persists iff changed; returns whether anything changed.
   */
  pruneSkill(skillId: string): boolean {
    let changed = false;
    const nextBundles = this.bundles.map((b) => {
      if (!b.skillIds.includes(skillId)) return b;
      changed = true;
      return { ...b, skillIds: b.skillIds.filter((s) => s !== skillId), updatedAt: new Date().toISOString() };
    });
    const nextProjects: Record<string, ProjectSkills> = {};
    for (const [pid, p] of Object.entries(this.projects)) {
      if (!p.enable || !(skillId in p.enable)) {
        nextProjects[pid] = p;
        continue;
      }
      changed = true;
      const { [skillId]: _stripped, ...restEnable } = p.enable;
      const enable = Object.keys(restEnable).length ? restEnable : undefined;
      // Drop the whole overlay if the strip left nothing (no bundle, no overrides).
      if (p.bundleId === undefined && !enable) continue;
      nextProjects[pid] = { ...(p.bundleId !== undefined ? { bundleId: p.bundleId } : {}), ...(enable ? { enable } : {}) };
    }
    if (changed) {
      this.bundles = nextBundles;
      this.projects = nextProjects;
      this.persist();
    }
    return changed;
  }

  // ---- composition ----

  /** Resolve a project's effective skill set (or, for projectId undefined, the global baseline). A thin
   *  wrapper that looks up the project's overlay + its selected bundle and delegates to the pure
   *  resolveSkillSelection — the ONE resolution site, shared with the materializer's global path. */
  resolveForProject(skills: Skill[], projectId: string | undefined): ResolvedSelection {
    if (projectId === undefined) return resolveSkillSelection(skills);
    const project = this.projects[projectId];
    const bundle = project?.bundleId ? this.bundles.find((b) => b.id === project.bundleId) : undefined;
    return resolveSkillSelection(skills, { bundle, project });
  }
}
