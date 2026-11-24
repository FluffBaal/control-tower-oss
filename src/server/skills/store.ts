// The canonical skill library store (SPEC-SKILLS). A skill is a provider-agnostic, reusable named
// capability — persisted META in ~/.ct/config/skills.json (atomic 0600), with the VERBATIM body and
// any assets on disk under ~/.ct/skills/<id>/. Mirrors stories/store.ts structurally: a self-contained
// zod schema (so it never contends on store.ts), PER-RECORD load validation (one bad record can't wipe
// the library), store-owned timestamps + a final parse guard, and an onChange hook the integrator wires
// to the SSE `{t:'skills'}` frame so an open Skills panel refreshes live.
//
// Bodies-on-disk drive the deltas from the story store: the index carries META only (a bounded list
// payload), the body + assets are read lazily, and every mutation stages a fresh skill dir then swaps it
// into place so a crash mid-write can never leave a half-written skill.

import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync, rmSync, readdirSync, cpSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { paths } from '../paths.js';
import { writeJsonAtomic, providerIdSchema } from '../store.js';
import { isSafeName, shortId } from '../ids.js';
import type {
  Skill, SkillAsset, SkillInvocation, SkillGate, SkillRequires, SkillProviderOverride,
  SkillModelInvocation, SkillScope, SkillOrigin, ProviderId,
  SkillHistoryEntry, SkillHistoryMeta,
} from '../../shared/types.js';

// ---- Ids that can never name a skill: `import` would collide with POST /api/skills/import forever. ----
const RESERVED_IDS = new Set(['import']);

/** Exported for the promote_skill enrich (SPEC-SKILLS Phase 5b): the reserved-slug refusal must fire
 *  at PROPOSE time from the same set upsert enforces — never first at the route. */
export function isReservedSkillId(id: string): boolean {
  return RESERVED_IDS.has(id);
}

/**
 * DERIVED protection (SPEC-SKILLS Phase 5): a skill the assistant can never propose toggling off or
 * deselecting. True when the operator locked it (`protected===true`) OR it enforces a BLOCKING gate — a
 * blocking gate like code-review IS a protection with zero data migration, and the flag covers non-gate
 * skills the operator wants locked. One predicate so every enrich refusal keys on the same rule.
 */
export function isProtectedSkill(sk: { protected?: boolean; gate?: SkillGate }): boolean {
  return sk.protected === true || sk.gate?.mode === 'blocking';
}

/**
 * DERIVED autonomy gating (SPEC-SKILLS Phase 5b wave 2): an assistant-authored skill the operator has
 * not yet cleared for skip-permissions agents. Operator/imported bodies are the operator's own text and
 * are never gated. ONE predicate so the materializer's exclusion, the clearance route, the panel chip,
 * and the tests all key on the same rule.
 */
export function needsAutonomyClearance(sk: { origin: SkillOrigin; autonomyCleared?: boolean }): boolean {
  return sk.origin === 'assistant' && sk.autonomyCleared !== true;
}

// ---- Field caps. Prose/lists are SANITIZED (clamped + dropped) so one bad entry never rejects the
//      whole record; body/assets are REJECTED over-cap (a truncated skill with an embedded program is a
//      silently broken skill — the opposite failure class from a clipped title). ----
const MAX_NAME = 120;
const MAX_DESCRIPTION = 4000;
const MAX_TRIGGER = 2000;
const MAX_TAGS = 32;
const MAX_TAG_LEN = 60;
const MAX_TRIGGER_PHRASES = 50;
const MAX_TRIGGER_PHRASE_LEN = 200;
const MAX_ARGUMENT_HINT = 200;
const MAX_ALLOWED_TOOLS = 64;
const MAX_ALLOWED_TOOL_LEN = 200;
const MAX_REQUIRE_MODELS = 16;
const MAX_REQUIRE_MODEL_LEN = 60;
const MAX_CAPABILITIES = 32;
const MAX_CAPABILITY_LEN = 60;
const MAX_GATE_BLOCKS = 16;
const MAX_GATE_BLOCK_LEN = 40;
const MAX_GATE_ENFORCERS = 8;
const MAX_GATE_ENFORCER_LEN = 40;
const MAX_SUPPORTED_PROVIDERS = 32;
const MAX_PROVIDER_OVERRIDES = 32;

/** The five draft-relevant prose ceilings, exported for the assistant draft pad (SPEC-SKILLS Phase
 *  5b): drafts.ts enforces the SAME limits at its wire schema — one source, no drift-by-copy.
 *  Additive; zero behavior change in this store. */
export const SKILL_PROSE_CAPS = {
  name: MAX_NAME,
  description: MAX_DESCRIPTION,
  trigger: MAX_TRIGGER,
  tags: MAX_TAGS,
  tagLen: MAX_TAG_LEN,
} as const;

const MAX_BODY_BYTES = 512 * 1024;
// Version-history retention (SPEC-SKILLS Phase 5b wave 2): snapshots beyond this are pruned oldest-
// first inside the same stage-swap that writes the new one — the history dir is bounded by design.
const RETAIN_HISTORY = 20;
// Exported so the importer can size-gate a file BEFORE reading it into memory (the store enforces the
// same ceilings on its input, but the importer must never readFileSync a huge stray file first).
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_ASSETS_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_COUNT = 512;

// ---- Asset relPath guard: a charset-safe posix path, no absolute/traversing/hidden-root/empty segment.
//      A silently dropped asset changes skill content, so the store REJECTS a bad path rather than
//      skipping it (unlike the prose sanitizers). ----
const ASSET_PATH_RE = /^[A-Za-z0-9._/-]{1,300}$/;
export function isSafeAssetPath(p: unknown): p is string {
  if (typeof p !== 'string' || !ASSET_PATH_RE.test(p)) return false;
  if (p.startsWith('/') || p.startsWith('.')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '..') return false;
  }
  return true;
}

// ---- Self-contained zod mirror — EVERY persisted field listed (the M6 strip-trap: an unlisted optional
//      field is stripped on load). Downgrade tolerance: gate.blocks / gate.enforcedBy /
//      requires.capabilities / providerOverrides[*].channel persist as PLAIN STRINGS (not strict enums)
//      so a newer Tower's new value survives a round-trip through an older one — the strict TS unions in
//      shared/types.ts keep authoring honest, and consumers treat an unknown value fail-closed. The
//      record is cast `as Skill` at the parse boundary (the stories `as Story` precedent). ----
const skillAssetSchema = z.object({
  relPath: z.string(),
  mode: z.number().optional(),
  sha256: z.string(),
  size: z.number(),
});

// An out-of-range stored model value falls to 'never' (fail-closed: a permission-ish field must never
// widen on a downgrade or a mangled record). The union tries the strict enum first; anything else lands
// on the transform. Mirrors the storedRole blank-don't-brick idiom, but defaults instead of blanking.
const skillModelSchema = z.union([
  z.enum(['auto', 'suggest', 'never']),
  z.any().transform(() => 'never' as const),
]);

const skillInvocationSchema = z.object({
  user: z.boolean(),
  model: skillModelSchema,
  triggerPhrases: z.array(z.string()).optional(),
  argumentHint: z.string().optional(),
});

const skillGateSchema = z.object({
  mode: z.enum(['advisory', 'blocking']),
  blocks: z.array(z.string()).optional(),
  enforcedBy: z.array(z.string()).optional(),
  rerunOnNewDiff: z.boolean().optional(),
});

const skillRequiresSchema = z.object({
  capabilities: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
});

const skillProviderOverrideSchema = z.object({
  omit: z.boolean().optional(),
  body: z.string().optional(),
  channel: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

// supportedProviders / providerOverrides keys validate through the exported providerIdSchema — a deleted
// custom provider's id still parses (the `custom:` pattern), so a record never bricks when a provider is
// removed.
const SkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.number(),
  contentHash: z.string(),
  description: z.string().min(1),
  trigger: z.string().optional(),
  assets: z.array(skillAssetSchema).optional(),
  scope: z.enum(['global', 'project']),
  enabled: z.boolean(),
  protected: z.boolean().optional(),
  autonomyCleared: z.boolean().optional(), // load-bearing: an unlisted optional field is stripped on load

  invocation: skillInvocationSchema,
  gate: skillGateSchema.optional(),
  requires: skillRequiresSchema.optional(),
  supportedProviders: z.array(providerIdSchema).optional(),
  providerOverrides: z.record(providerIdSchema, skillProviderOverrideSchema).optional(),
  toolHints: z.object({ allowedTools: z.array(z.string()).optional() }).optional(),
  tags: z.array(z.string()).optional(),
  origin: z.enum(['imported', 'operator', 'assistant']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Upsert input. Over HTTP the asset `content` is utf8 text; the importer passes a Buffer for byte-exact
 *  capture, so the internal type accepts both.
 *
 *  `autonomyCleared` is DELIBERATELY absent (SPEC-SKILLS Phase 5b wave 2): buildAndStage assembles the
 *  candidate field-by-field and never reads unknown input keys, so this structural absence is the proof
 *  that no POST/PUT/promote payload can ever set clearance — it is operator-only via
 *  SkillStore.setAutonomyCleared (the same containment argument as the draft whitelist). */
export interface UpsertSkillInput {
  id?: string;
  name: string;
  description: string;
  body: string;
  trigger?: string;
  scope?: SkillScope;
  enabled?: boolean;
  protected?: boolean;
  invocation?: Partial<SkillInvocation>;
  gate?: SkillGate;
  requires?: SkillRequires;
  supportedProviders?: ProviderId[];
  providerOverrides?: Partial<Record<ProviderId, SkillProviderOverride>>;
  toolHints?: { allowedTools?: string[] };
  tags?: string[];
  origin?: SkillOrigin;
  assets?: { relPath: string; content: string | Buffer; mode?: number }[];
}

// ---- Sanitizers (run on upsert; clamp + drop bad entries rather than reject the whole skill) ----

function capStr(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

/** Trim, drop empties, cap length + count, dedupe (order-preserving). */
function sanitizeStrList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim().slice(0, maxLen);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normModel(v: unknown): SkillModelInvocation {
  return v === 'auto' || v === 'suggest' || v === 'never' ? v : 'never';
}

function sanitizeGate(g: SkillGate | undefined): SkillGate | undefined {
  if (!g || typeof g !== 'object') return undefined;
  const blocks = sanitizeStrList(g.blocks, MAX_GATE_BLOCKS, MAX_GATE_BLOCK_LEN) as SkillGate['blocks'];
  const enforcedBy = sanitizeStrList(g.enforcedBy, MAX_GATE_ENFORCERS, MAX_GATE_ENFORCER_LEN) as SkillGate['enforcedBy'];
  const out: SkillGate = { mode: g.mode === 'blocking' ? 'blocking' : 'advisory' };
  if (blocks && blocks.length) out.blocks = blocks;
  if (enforcedBy && enforcedBy.length) out.enforcedBy = enforcedBy;
  if (g.rerunOnNewDiff === true) out.rerunOnNewDiff = true;
  return out;
}

function sanitizeRequires(r: SkillRequires | undefined): SkillRequires | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const capabilities = sanitizeStrList(r.capabilities, MAX_CAPABILITIES, MAX_CAPABILITY_LEN) as SkillRequires['capabilities'];
  const models = sanitizeStrList(r.models, MAX_REQUIRE_MODELS, MAX_REQUIRE_MODEL_LEN);
  const out: SkillRequires = {};
  if (capabilities && capabilities.length) out.capabilities = capabilities;
  if (models.length) out.models = models;
  return out.capabilities || out.models ? out : undefined;
}

function sanitizeToolHints(t: { allowedTools?: string[] } | undefined): { allowedTools?: string[] } | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const allowedTools = sanitizeStrList(t.allowedTools, MAX_ALLOWED_TOOLS, MAX_ALLOWED_TOOL_LEN);
  return allowedTools.length ? { allowedTools } : undefined;
}

function sanitizeSupportedProviders(v: unknown): ProviderId[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ProviderId[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const parsed = providerIdSchema.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    out.push(parsed.data);
    if (out.length >= MAX_SUPPORTED_PROVIDERS) break;
  }
  return out.length ? out : undefined;
}

function sanitizeProviderOverrides(
  v: Partial<Record<ProviderId, SkillProviderOverride>> | undefined,
): Partial<Record<ProviderId, SkillProviderOverride>> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Partial<Record<ProviderId, SkillProviderOverride>> = {};
  let count = 0;
  for (const [key, ov] of Object.entries(v)) {
    if (count >= MAX_PROVIDER_OVERRIDES) break;
    const parsed = providerIdSchema.safeParse(key);
    if (!parsed.success || !ov || typeof ov !== 'object') continue;
    const clean: SkillProviderOverride = {};
    if (ov.omit === true) clean.omit = true;
    if (typeof ov.body === 'string') clean.body = ov.body;
    if (typeof ov.channel === 'string') clean.channel = ov.channel as SkillProviderOverride['channel'];
    const at = sanitizeStrList(ov.allowedTools, MAX_ALLOWED_TOOLS, MAX_ALLOWED_TOOL_LEN);
    if (at.length) clean.allowedTools = at;
    out[parsed.data] = clean;
    count++;
  }
  return count ? out : undefined;
}

function sanitizeInvocation(input: Partial<SkillInvocation> | undefined, base: SkillInvocation): SkillInvocation {
  const pin = input ?? {};
  const out: SkillInvocation = {
    user: typeof pin.user === 'boolean' ? pin.user : base.user,
    model: pin.model !== undefined ? normModel(pin.model) : base.model,
  };
  const phrases = pin.triggerPhrases !== undefined
    ? sanitizeStrList(pin.triggerPhrases, MAX_TRIGGER_PHRASES, MAX_TRIGGER_PHRASE_LEN)
    : base.triggerPhrases;
  if (phrases && phrases.length) out.triggerPhrases = phrases;
  const hint = pin.argumentHint !== undefined ? capStr(pin.argumentHint, MAX_ARGUMENT_HINT) : base.argumentHint;
  if (hint) out.argumentHint = hint;
  return out;
}

/** Copy + sort a set-like string array so the hash input is order-independent (the stored value keeps its
 *  authoring order — only the hash canonicalizes). Returns null for absent, so JSON.stringify is stable. */
function sortedOrNull(a: readonly string[] | undefined): string[] | null {
  return a ? [...a].sort() : null;
}

/** The materialization-affecting fields, in a FIXED order — the sha256 over this is a frozen contract a
 *  later manifest diff keys on. The input is CANONICALIZED so logically-identical skills hash the same
 *  regardless of authoring order: assets sort by relPath, providerOverrides sort by provider key, and the
 *  set-like arrays (gate.blocks/enforcedBy, requires.capabilities/models, supportedProviders, tags, every
 *  allowedTools list) sort before hashing. tags ARE emitted content — a materializer writes them into the
 *  skill's frontmatter — so they belong in the hash; only pure selection + provenance
 *  (enabled/scope/origin/timestamps/version) are excluded, changing WHICH skill is emitted, not its
 *  emitted content. */
function computeContentHash(r: {
  name: string; description: string; trigger?: string; body: string; assets?: SkillAsset[];
  invocation: SkillInvocation; gate?: SkillGate; requires?: SkillRequires;
  supportedProviders?: ProviderId[]; providerOverrides?: Partial<Record<ProviderId, SkillProviderOverride>>;
  toolHints?: { allowedTools?: string[] }; tags?: string[];
}): string {
  const obj = {
    name: r.name,
    description: r.description,
    trigger: r.trigger ?? null,
    body: r.body,
    assets: (r.assets ?? [])
      .slice()
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
      .map((a) => ({ relPath: a.relPath, mode: a.mode ?? null, sha256: a.sha256 })),
    invocation: {
      user: r.invocation.user,
      model: r.invocation.model,
      triggerPhrases: r.invocation.triggerPhrases ?? null,
      argumentHint: r.invocation.argumentHint ?? null,
    },
    gate: r.gate
      ? {
          mode: r.gate.mode,
          blocks: sortedOrNull(r.gate.blocks),
          enforcedBy: sortedOrNull(r.gate.enforcedBy),
          rerunOnNewDiff: r.gate.rerunOnNewDiff ?? null,
        }
      : null,
    requires: r.requires
      ? { capabilities: sortedOrNull(r.requires.capabilities), models: sortedOrNull(r.requires.models) }
      : null,
    supportedProviders: sortedOrNull(r.supportedProviders),
    providerOverrides: r.providerOverrides
      ? Object.keys(r.providerOverrides)
          .sort()
          .map((k) => {
            const ov = r.providerOverrides![k as ProviderId]!;
            return {
              provider: k,
              omit: ov.omit ?? null,
              body: ov.body ?? null,
              channel: ov.channel ?? null,
              allowedTools: sortedOrNull(ov.allowedTools),
            };
          })
      : null,
    toolHints: r.toolHints ? { allowedTools: sortedOrNull(r.toolHints.allowedTools) } : null,
    tags: sortedOrNull(r.tags),
  };
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

/** Derive a safe id slug from a display name. Non-slug runs become '-', leading non-alnum is trimmed so
 *  the first char is [a-z0-9] (isSafeName's requirement). Empty → caller throws. Exported (SPEC-SKILLS
 *  Phase 5b) so the promote_skill enrich derives the create-path id from this ONE source — the
 *  validateRepoUrl import precedent in assistant/actions.ts. */
export function slugifySkillName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
}

// ---- Disk helpers (raw bytes at 0600; writeJsonAtomic would JSON-wrap the body) ----
function writeRaw(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data, { mode: 0o600 });
}
function skillDir(id: string): string {
  return join(paths.skillsData, id);
}
function bodyPath(id: string): string {
  return join(skillDir(id), 'body.md');
}
function historyDir(id: string): string {
  return join(skillDir(id), 'history');
}

/** SPEC-SKILLS per-project delivery — the CENTRAL store's body path for a skill (~/.ct/skills/<id>/
 *  body.md), absolute and expanded (never a literal `~`: agents run in worktree cwds where tilde
 *  expansion inside a CLI's file tooling is not guaranteed). Exported next to the private bodyPath so
 *  the sortie brief and the store can never derive different paths. */
export function centralBodyPath(id: string): string {
  return bodyPath(id);
}
/** The central assets root (~/.ct/skills/<id>/assets) — the sortie brief's {{skillDir}} remap target.
 *  NOTE the layout difference from a materialized dir: the central store keeps assets under an
 *  `assets/` segment (readAsset/stage-swap below); a materialized skill dir holds them at the root. */
export function centralAssetsDir(id: string): string {
  return join(skillDir(id), 'assets');
}

// History snapshots load tolerantly (an unreadable entry is skipped + logged, never thrown —
// history is forensic, not load-bearing). origin persists as a plain string (the downgrade-
// tolerance posture of the main schema); the record is cast at the parse boundary.
const skillHistoryEntrySchema = z.object({
  version: z.number(),
  contentHash: z.string(),
  name: z.string(),
  description: z.string(),
  trigger: z.string().optional(),
  tags: z.array(z.string()).optional(),
  origin: z.string(),
  body: z.string(),
  ts: z.string(),
});

/** Prune a (staged) history dir down to the newest RETAIN_HISTORY `v<N>.json` snapshots. Runs on
 *  the STAGE copy only, so the swap lands the pruned set atomically — a crash mid-write leaves
 *  either the old history or the new, never a torn one. */
function pruneHistory(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // no history dir staged — nothing to prune
  }
  const versions = names
    .map((n) => /^v(\d+)\.json$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  for (const v of versions.slice(RETAIN_HISTORY)) {
    try {
      rmSync(join(dir, `v${v}.json`), { force: true });
    } catch {
      /* best-effort — an over-retained snapshot is inert */
    }
  }
}

/**
 * Load skills.json with PER-RECORD validation (the readStories / readJsonArray precedent): a read failure
 * on an existing file is TRANSIENT I/O → throw (recoverable by restart); a torn / non-array file IS
 * corruption → quarantine `.corrupt-<ts>` then start empty (a failed rename throws so a persist can never
 * overwrite unread data); invalid records are skipped with the bytes preserved in `.rejected-<ts>`. One
 * addition over stories: a record whose body.md is missing is ALSO rejected — a listed skill must always
 * have a readable body (its dir is left in place, inert).
 */
function readSkills(): { records: Skill[]; hadRejects: boolean } {
  if (!existsSync(paths.skills)) return { records: [], hadRejects: false };

  let text: string;
  try {
    text = readFileSync(paths.skills, 'utf8');
  } catch (err) {
    throw new Error(
      `[skills] cannot read ${paths.skills} (transient I/O — not corruption): ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
  } catch (err) {
    const quarantine = `${paths.skills}.corrupt-${Date.now()}`;
    console.error(`[skills] ${paths.skills} corrupt (${(err as Error).message}); quarantining as ${quarantine}`);
    renameSync(paths.skills, quarantine); // throws on failure -> boot fails (no silent wipe)
    return { records: [], hadRejects: false };
  }

  const records: Skill[] = [];
  let rejects = 0;
  for (const el of parsed) {
    const res = SkillSchema.safeParse(el);
    if (!res.success) {
      rejects++;
      console.error(`[skills] skipping invalid skill record: ${res.error.message}`);
      continue;
    }
    const rec = res.data as Skill;
    if (!existsSync(bodyPath(rec.id))) {
      rejects++;
      console.error(`[skills] skipping skill '${rec.id}': body.md is missing on disk`);
      continue;
    }
    records.push(rec);
  }
  let hadRejects = false;
  if (rejects > 0) {
    try {
      copyFileSync(paths.skills, `${paths.skills}.rejected-${Date.now()}`);
      hadRejects = true;
    } catch (e) {
      console.error(`[skills] could not back up ${paths.skills}; NOT re-persisting (keeping original):`, e);
    }
  }
  return { records, hadRejects };
}

export interface SkillStoreHooks {
  onChange?: () => void;
}

export class SkillStore {
  private skills = new Map<string, Skill>();
  private hooks: SkillStoreHooks;

  constructor(hooks: SkillStoreHooks = {}) {
    this.hooks = hooks;
    // skillsData is created lazily here, NOT in ensureDirs (the reports lazy-dir precedent).
    mkdirSync(paths.skillsData, { recursive: true });
    this.recoverAndSweep(); // restore any interrupted swap BEFORE the load validates body presence
    const { records, hadRejects } = readSkills();
    for (const s of records) this.skills.set(s.id, s);
    if (hadRejects) this.persist();
  }

  /** Wire the SSE hook after the broadcaster exists (integrator boot order). */
  setHooks(hooks: SkillStoreHooks): void {
    this.hooks = hooks;
  }

  // ---- reads ----
  /** META only — the body is fetched lazily via getBody, never loaded wholesale at boot. */
  list(): Skill[] {
    return [...this.skills.values()];
  }
  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }
  getBody(id: string): string | undefined {
    if (!isSafeName(id) || !this.skills.has(id)) return undefined;
    const p = bodyPath(id);
    if (!existsSync(p)) return undefined;
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  }
  /** Raw bytes of ONE declared asset, for the materializer. Validates id + relPath safety AND membership in
   *  the skill's asset metadata (a file not in the manifest must never propagate), then reads from disk.
   *  undefined on any miss (unknown skill, unsafe/unlisted path, or a read error). */
  readAsset(id: string, relPath: string): Buffer | undefined {
    if (!isSafeName(id) || !isSafeAssetPath(relPath)) return undefined;
    const skill = this.skills.get(id);
    if (!skill || !skill.assets?.some((a) => a.relPath === relPath)) return undefined;
    const p = join(skillDir(id), 'assets', relPath);
    if (!existsSync(p)) return undefined;
    try {
      return readFileSync(p);
    } catch {
      return undefined;
    }
  }

  // ---- mutations ----
  /** Mint a new skill (id absent → slug from name; a derived-slug collision throws) or patch/create at a
   *  given id (the importer needs create-with-id). Throws → the route returns 400. */
  upsert(input: UpsertSkillInput): Skill {
    let id: string;
    if (input.id) {
      id = input.id;
      if (!isSafeName(id)) throw new Error(`invalid skill id: ${id}`);
      if (RESERVED_IDS.has(id)) throw new Error(`reserved skill id: ${id}`);
    } else {
      id = slugifySkillName(input.name);
      if (!isSafeName(id)) throw new Error('cannot derive a valid id from the skill name');
      if (RESERVED_IDS.has(id)) throw new Error(`reserved skill id: ${id}`);
      if (this.skills.has(id)) throw new Error('skill id exists — pass id to edit');
    }
    const rec = this.buildAndStage(id, input, this.skills.get(id));
    this.skills.set(id, rec);
    this.persist();
    this.afterMutate();
    return rec;
  }

  /** Idempotent, skip-existing batch used by the one-time importer: one persist + one frame per run,
   *  never overwrites an existing id, and never lets one bad record abort the batch. */
  importMany(inputs: UpsertSkillInput[]): {
    imported: string[];
    skipped: { id: string; reason: string }[];
    errors: { id: string; reason: string }[];
  } {
    const imported: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const errors: { id: string; reason: string }[] = [];
    let changed = false;
    for (const input of inputs) {
      const id = input.id;
      if (!id || !isSafeName(id) || RESERVED_IDS.has(id)) {
        errors.push({ id: id ?? '?', reason: 'invalid or reserved skill id' });
        continue;
      }
      if (this.skills.has(id)) {
        skipped.push({ id, reason: 'exists' });
        continue;
      }
      try {
        const rec = this.buildAndStage(id, { ...input, origin: input.origin ?? 'imported' }, undefined);
        this.skills.set(id, rec);
        imported.push(id);
        changed = true;
      } catch (e) {
        errors.push({ id, reason: (e as Error).message });
      }
    }
    if (changed) {
      this.persist();
      this.afterMutate();
    }
    return { imported, skipped, errors };
  }

  /** Flip ONLY a skill's `enabled` flag (selection, not content) — the narrow POST /api/skills/:id/enabled
   *  toggle, which a full upsert cannot ride (upsert demands name/description/body). Persists + fires the
   *  {t:'skills'} SSE frame via afterMutate, but does NOT bump `version` and does NOT recompute
   *  `contentHash` (enabled is excluded from the hash by design). Unknown id throws (→ the route 404s). */
  setEnabled(id: string, enabled: boolean): Skill {
    const existing = this.skills.get(id);
    if (!existing) throw new Error(`unknown skill '${id}'`);
    const rec: Skill = { ...existing, enabled, updatedAt: new Date().toISOString() };
    this.skills.set(id, rec);
    this.persist();
    this.afterMutate();
    return rec;
  }

  /** Flip ONLY a skill's `autonomyCleared` flag (SPEC-SKILLS Phase 5b wave 2) — the setEnabled clone
   *  behind POST /api/skills/:id/autonomy-cleared: no version bump, no hash recompute (clearance is
   *  governance, excluded from the hash by design), persist + the {t:'skills'} SSE frame. Unknown id
   *  throws (→ the route 404s); a non-assistant origin throws its own message (→ 400) — operator and
   *  imported bodies are never gated, so a flag on them would be dead state. `cleared:false` DELETES
   *  the key: absent is the one canonical uncleared form (needsAutonomyClearance treats both the same,
   *  but persisted bytes should not carry a decoy `false`). */
  setAutonomyCleared(id: string, cleared: boolean): Skill {
    const existing = this.skills.get(id);
    if (!existing) throw new Error(`unknown skill '${id}'`);
    if (existing.origin !== 'assistant') {
      throw new Error('only assistant-authored skills carry autonomy clearance');
    }
    const rec: Skill = { ...existing, updatedAt: new Date().toISOString() };
    if (cleared) rec.autonomyCleared = true;
    else delete rec.autonomyCleared;
    this.skills.set(id, rec);
    this.persist();
    this.afterMutate();
    return rec;
  }

  remove(id: string): void {
    if (!this.skills.delete(id)) return; // unknown id — no write, no frame
    this.persist();
    this.afterMutate();
    // Best-effort dir removal (id was isSafeName-validated at insert; re-check before the join). A failed
    // removal leaves an inert orphan, logged.
    if (isSafeName(id)) {
      try {
        rmSync(skillDir(id), { recursive: true, force: true });
      } catch (e) {
        console.error(`[skills] could not remove skill dir for '${id}':`, e);
      }
    }
  }

  // ---- version history (SPEC-SKILLS Phase 5b wave 2) ----

  /** META list of a skill's history snapshots, newest first (no bodies — bounded payload). */
  listHistory(id: string): SkillHistoryMeta[] {
    return this.readHistoryEntries(id).map((e) => {
      const { body, ...meta } = e;
      return { ...meta, bodyBytes: Buffer.byteLength(body, 'utf8') };
    });
  }

  getHistoryEntry(id: string, version: number): SkillHistoryEntry | undefined {
    return this.readHistoryEntries(id).find((e) => e.version === version);
  }

  /** Restore a prior snapshot as a NORMAL forward upsert — append-only: the version increments,
   *  the pre-rollback state itself becomes a history entry, and history is never rewritten. Prose
   *  fields are fully replaced (the promote route's ''/[] replace idiom — a stale trigger/tags set
   *  must not survive a rollback that lacked one); governance/invocation/gate/overrides/assets stay
   *  patch-preserved and origin is immutable (upsert semantics). A content change drops
   *  autonomyCleared via the hash-keyed reset above — what was cleared is never what rolls in.
   *  Unknown id/version throws (→ the route 404s). */
  rollback(id: string, version: number): Skill {
    if (!this.skills.has(id)) throw new Error(`unknown skill '${id}'`);
    const e = this.getHistoryEntry(id, version);
    if (!e) throw new Error(`unknown history version ${version} for skill '${id}'`);
    return this.upsert({
      id,
      name: e.name,
      description: e.description,
      body: e.body,
      trigger: e.trigger ?? '',
      tags: e.tags ?? [],
    });
  }

  private readHistoryEntries(id: string): SkillHistoryEntry[] {
    if (!isSafeName(id) || !this.skills.has(id)) return [];
    let names: string[];
    try {
      names = readdirSync(historyDir(id));
    } catch {
      return []; // no history yet (created, never content-changed)
    }
    const out: SkillHistoryEntry[] = [];
    for (const name of names) {
      if (!/^v\d+\.json$/.test(name)) continue;
      try {
        const parsed = skillHistoryEntrySchema.safeParse(JSON.parse(readFileSync(join(historyDir(id), name), 'utf8')));
        if (!parsed.success) throw new Error(parsed.error.message);
        out.push(parsed.data as SkillHistoryEntry);
      } catch (e) {
        console.error(`[skills] skipping unreadable history entry ${name} for '${id}':`, e);
      }
    }
    return out.sort((a, b) => b.version - a.version);
  }

  // ---- internals ----

  /** Validate + sanitize + reject over-cap, assemble the record (final parse guard), THEN stage-swap the
   *  body + assets so a rejected record never touches disk. Does NOT persist or emit (the caller batches). */
  private buildAndStage(id: string, input: UpsertSkillInput, existing: Skill | undefined): Skill {
    const now = new Date().toISOString();

    // Body: verbatim, byte-preserved. Over-cap REJECTS (a truncated skill is a broken skill).
    const body = String(input.body ?? '');
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new Error(`skill body exceeds ${MAX_BODY_BYTES} bytes`);
    }

    // Assets: undefined = KEEP existing, [] = clear, else replace (validate paths + caps → throw).
    const baseInvocation: SkillInvocation = existing?.invocation ?? { user: true, model: 'auto' };
    let assetsMeta: SkillAsset[] | undefined;
    let assetWrite: { relPath: string; buf: Buffer }[] | undefined; // present only when replacing
    let assetMode: 'keep' | 'clear' | 'replace';
    if (input.assets === undefined) {
      assetsMeta = existing?.assets;
      assetMode = 'keep';
    } else if (input.assets.length === 0) {
      assetsMeta = undefined;
      assetMode = 'clear';
    } else {
      if (input.assets.length > MAX_ASSET_COUNT) throw new Error(`too many assets (>${MAX_ASSET_COUNT})`);
      const meta: SkillAsset[] = [];
      const write: { relPath: string; buf: Buffer }[] = [];
      const seen = new Set<string>();
      let total = 0;
      for (const a of input.assets) {
        if (!isSafeAssetPath(a.relPath)) throw new Error(`unsafe asset path: ${String(a.relPath)}`);
        if (seen.has(a.relPath)) throw new Error(`duplicate asset path: ${a.relPath}`);
        seen.add(a.relPath);
        const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? '', 'utf8');
        if (buf.length > MAX_ASSET_BYTES) throw new Error(`asset exceeds ${MAX_ASSET_BYTES} bytes: ${a.relPath}`);
        total += buf.length;
        if (total > MAX_ASSETS_TOTAL_BYTES) throw new Error(`assets exceed ${MAX_ASSETS_TOTAL_BYTES} bytes total`);
        meta.push({
          relPath: a.relPath,
          ...(a.mode !== undefined ? { mode: a.mode & 0o777 } : {}),
          sha256: createHash('sha256').update(buf).digest('hex'),
          size: buf.length,
        });
        write.push({ relPath: a.relPath, buf });
      }
      assetsMeta = meta;
      assetWrite = write;
      assetMode = 'replace';
    }

    const invocation = sanitizeInvocation(input.invocation, baseInvocation);
    const trigger = input.trigger !== undefined ? capStr(input.trigger, MAX_TRIGGER) || undefined : existing?.trigger;
    const tags = input.tags !== undefined
      ? (sanitizeStrList(input.tags, MAX_TAGS, MAX_TAG_LEN) as string[])
      : existing?.tags;
    // protected: patch-preserving like gate (undefined keeps, false clears). EXCLUDED from contentHash
    // below (governance, not emitted content) — it changes whether the assistant may propose a toggle,
    // never what materializes.
    const isProtected = input.protected !== undefined ? input.protected === true : existing?.protected;
    const gate = input.gate !== undefined ? sanitizeGate(input.gate) : existing?.gate;
    const requires = input.requires !== undefined ? sanitizeRequires(input.requires) : existing?.requires;
    const supportedProviders = input.supportedProviders !== undefined
      ? sanitizeSupportedProviders(input.supportedProviders)
      : existing?.supportedProviders;
    const providerOverrides = input.providerOverrides !== undefined
      ? sanitizeProviderOverrides(input.providerOverrides)
      : existing?.providerOverrides;
    const toolHints = input.toolHints !== undefined ? sanitizeToolHints(input.toolHints) : existing?.toolHints;

    const contentHash = computeContentHash({
      name: capStr(input.name, MAX_NAME),
      description: capStr(input.description, MAX_DESCRIPTION),
      trigger, body, assets: assetsMeta, invocation, gate, requires, supportedProviders, providerOverrides, toolHints, tags,
    });

    const candidate: Skill = {
      id,
      name: capStr(input.name, MAX_NAME),
      version: existing ? existing.version + 1 : 1,
      contentHash,
      description: capStr(input.description, MAX_DESCRIPTION),
      ...(trigger ? { trigger } : {}),
      ...(assetsMeta && assetsMeta.length ? { assets: assetsMeta } : {}),
      scope: input.scope ?? existing?.scope ?? 'global',
      enabled: input.enabled ?? existing?.enabled ?? true,
      ...(isProtected ? { protected: true } : {}),
      // Clearance is an attestation of EXACT content: preserved only while contentHash is unchanged,
      // dropped on any content change (a cleared body edited — by promote OR by the operator — returns
      // to interactive-only until re-cleared). Never settable from input: operator-only via the
      // autonomy-cleared route (see the UpsertSkillInput comment).
      ...(existing?.autonomyCleared === true && contentHash === existing.contentHash
        ? { autonomyCleared: true }
        : {}),
      invocation,
      ...(gate ? { gate } : {}),
      ...(requires ? { requires } : {}),
      ...(supportedProviders ? { supportedProviders } : {}),
      ...(providerOverrides ? { providerOverrides } : {}),
      ...(toolHints ? { toolHints } : {}),
      ...(tags && tags.length ? { tags } : {}),
      origin: existing?.origin ?? input.origin ?? 'operator', // immutable after create
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const rec = SkillSchema.parse(candidate) as Skill; // final guard: empty name/description → throws → 400

    // Version history (SPEC-SKILLS Phase 5b wave 2): snapshot the SUPERSEDED version inside the same
    // stage-swap — crash-safe for free — and only on a REAL content change. Flag flips ride
    // setEnabled/setAutonomyCleared (which never reach here) and a content-identical upsert changes
    // no hash, so neither ever spams an entry. importMany passes existing=undefined — creates have
    // no prior, no entry.
    let snapshot: { fileName: string; json: string } | undefined;
    if (existing && contentHash !== existing.contentHash) {
      const priorBody = this.getBody(id);
      if (priorBody === undefined) {
        console.error(`[skills] no readable prior body for '${id}' — skipping its history snapshot`);
      } else {
        const entry: SkillHistoryEntry = {
          version: existing.version,
          contentHash: existing.contentHash,
          name: existing.name,
          description: existing.description,
          ...(existing.trigger ? { trigger: existing.trigger } : {}),
          ...(existing.tags && existing.tags.length ? { tags: existing.tags } : {}),
          origin: existing.origin,
          body: priorBody,
          ts: now,
        };
        snapshot = { fileName: `v${existing.version}.json`, json: JSON.stringify(entry, null, 2) };
      }
    }

    this.stageWrite(id, body, assetMode, assetWrite, {
      carry: existing !== undefined,
      ...(snapshot ? { add: snapshot } : {}),
    });
    return rec;
  }

  /**
   * Crash-safe, single-writer body+assets write: build a fresh `.stage.<id>.<stamp>` dir, then swap it in
   * with a rename (the live dir → `.old.<id>.<stamp>` first, removed best-effort after). The name embeds
   * the id between dots — an id never contains '.' (isSafeName), so boot recovery can extract it. A crash
   * between the two renames leaves `live` missing with the only copy under `.old.<id>.…`, which
   * recoverAndSweep restores (never deletes). A crash after the swap but before the index persist leaves a
   * stale hash/version in the index over newer files — the accepted residual (self-heals on the next
   * upsert). Live skill dirs never start with '.', so stage/old dirs are unambiguous.
   */
  private stageWrite(
    id: string,
    body: string,
    mode: 'keep' | 'clear' | 'replace',
    assetWrite: { relPath: string; buf: Buffer }[] | undefined,
    history: { carry: boolean; add?: { fileName: string; json: string } },
  ): void {
    const live = skillDir(id);
    const stamp = `${Date.now()}-${shortId(4)}`;
    const stage = join(paths.skillsData, `.stage.${id}.${stamp}`);
    mkdirSync(stage, { recursive: true });
    writeRaw(join(stage, 'body.md'), body);
    if (mode === 'replace') {
      for (const a of assetWrite ?? []) writeRaw(join(stage, 'assets', a.relPath), a.buf);
    } else if (mode === 'keep') {
      const liveAssets = join(live, 'assets');
      if (existsSync(liveAssets)) cpSync(liveAssets, join(stage, 'assets'), { recursive: true });
    } // 'clear' writes no assets/
    // History rides every swap of an EXISTING skill, in all three asset modes — its survival must
    // never depend on asset semantics: carry the live history through, append the new snapshot (if
    // this write supersedes content), prune oldest beyond retention. All on the stage, so the swap
    // below lands the whole pruned set atomically. A CREATE (carry:false) starts CLEAN: a skill dir
    // can outlive its record (a quarantined index, a failed remove()), and a new skill minted at
    // that id must not inherit a dead incarnation's snapshots — the swap discards the leftover dir
    // wholesale. Best-effort THROUGHOUT (history is forensic, not load-bearing — the readSkills
    // doctrine): a history-dir failure is logged and the content write still lands; losing a
    // snapshot is acceptable, blocking the edit is not. Forward-compat honesty: an OLDER Tower's
    // stageWrite won't carry history/ through its swap — an old-binary edit loses history, never
    // content.
    try {
      if (history.carry) {
        const liveHistory = join(live, 'history');
        if (existsSync(liveHistory)) cpSync(liveHistory, join(stage, 'history'), { recursive: true });
      }
      if (history.add) writeRaw(join(stage, 'history', history.add.fileName), history.add.json);
      pruneHistory(join(stage, 'history'));
    } catch (e) {
      console.error(`[skills] history snapshot skipped for '${id}' (the content write proceeds):`, e);
    }

    let old: string | undefined;
    if (existsSync(live)) {
      old = join(paths.skillsData, `.old.${id}.${stamp}`);
      renameSync(live, old);
    }
    renameSync(stage, live);
    if (old) {
      try {
        rmSync(old, { recursive: true, force: true });
      } catch {
        /* an orphan .old dir is inert and cleared on next boot */
      }
    }
  }

  /**
   * Boot recovery for a crash mid-swap (best-effort crash hygiene). The swap is two non-atomic renames
   * (live→.old, .stage→live); a kill BETWEEN them leaves `live` missing with the ONLY copy under
   * `.old.<id>.…`. So a `.old` whose live dir is MISSING is PROMOTED back to live (its content is all that
   * survives); a `.old` whose live dir already exists is a completed swap → removed. Every `.stage` dir is
   * a partial or an orphan of a completed swap → removed. A rename failure leaves the `.old` in place for a
   * later attempt — the only copy is never deleted.
   */
  private recoverAndSweep(): void {
    let names: string[];
    try {
      names = readdirSync(paths.skillsData);
    } catch {
      return; // skillsData may not exist yet on the very first boot
    }
    const rm = (name: string): void => {
      try {
        rmSync(join(paths.skillsData, name), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    };
    for (const name of names) {
      if (name.startsWith('.stage.')) {
        rm(name);
        continue;
      }
      if (!name.startsWith('.old.')) continue;
      const rest = name.slice('.old.'.length);
      const dot = rest.indexOf('.'); // id has no '.', so the first dot ends it
      const id = dot > 0 ? rest.slice(0, dot) : '';
      if (id && isSafeName(id) && !existsSync(skillDir(id))) {
        try {
          renameSync(join(paths.skillsData, name), skillDir(id)); // interrupted swap — restore the survivor
          continue;
        } catch (e) {
          console.error(`[skills] could not recover an interrupted swap for '${id}' — left in place:`, e);
          continue; // never delete the only copy
        }
      }
      rm(name); // completed swap (live exists) or an unparsable name → discard the leftover
    }
  }

  private afterMutate(): void {
    this.hooks.onChange?.();
  }

  private persist(): void {
    writeJsonAtomic(paths.skills, [...this.skills.values()], 0o600);
  }
}
