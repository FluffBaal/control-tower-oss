// SPEC-SKILLS Phase 5b — the assistant's INERT skill-draft pad. A draft is chat-authored meta+body
// the brain saves via the ONE scoped-token write beyond proposals (save_skill_draft); NOTHING reads
// it except the operator's eyes and the always-confirm promote path. Inert BY STRUCTURE, not by
// filter: a separate store, file (~/.ct/config/skill-drafts.json), and type — materialize.ts imports
// only ./store.js + ./selection.js and must never gain ./drafts.js (asserted source-level AND
// behaviorally in tests), so one missed filter can never inject LLM text into agent config dirs.
//
// The record's field set IS the whitelist (shared/types.ts SkillDraft — see its containment
// comment): gate / providerOverrides / toolHints / assets / scope / supportedProviders / protected /
// enabled / origin / invocation are structurally absent here AND strict-rejected at the wire schema
// below. Persistence mirrors the readSkills/ProposalStore precedent: one atomic 0600 JSON array,
// bodies INLINE (≤ 64 KB × ≤ 50 open ≈ 3.2 MB worst case — a single crash-safe write needs none of
// the skill store's stage-swap machinery), per-record load validation with quarantine/reject backups.
//
// Every method is SYNCHRONOUS (in-memory map + one file write): promote_skill's enrich — and
// confirm()'s drift re-run — must complete before their first await (assistant/actions.ts contract).

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { paths } from '../paths.js';
import { writeJsonAtomic } from '../store.js';
import { isSafeName, shortId } from '../ids.js';
import { SKILL_PROSE_CAPS } from './store.js';
import type { SkillDraft, SkillDraftMeta } from '../../shared/types.js';

/** Draft body ceiling: 64 KB — the memory-file budget (coordination.ts MEMORY_FILES), deliberately
 *  far tighter than the skill store's 512 KB. A draft is chat-authored prose, not an imported
 *  asset-bearing skill; over-cap REJECTS (a truncated skill is a silently broken skill). */
export const DRAFT_BODY_MAX = 64 * 1024;
const MAX_OPEN_DRAFTS = 50;
const MAX_OPEN_PER_CONVERSATION = 10;
/** Terminal (promoted) records retained for provenance, oldest-first eviction — never an open one
 *  (the ProposalStore persist() idiom). */
const RETAIN_TERMINAL = 100;

// ---- The wire schema — the whitelist proof at the wire (SPEC-SKILLS Phase 5b invariant 2). ----
// .strict(): an unknown key (gate, providerOverrides, assets, enabled, …) is a 400, not a silent
// drop — better self-correction for the model, and the test suite proves the reject on persisted
// bytes. Prose ceilings come from SKILL_PROSE_CAPS (the skill store's own constants — one source).
const saveDraftRequestSchema = z
  .object({
    draftId: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(SKILL_PROSE_CAPS.name),
    description: z.string().trim().min(1).max(SKILL_PROSE_CAPS.description),
    trigger: z.string().trim().min(1).max(SKILL_PROSE_CAPS.trigger).optional(),
    body: z.string().min(1),
    tags: z.array(z.string().trim().min(1).max(SKILL_PROSE_CAPS.tagLen)).max(SKILL_PROSE_CAPS.tags).optional(),
    targetSkillId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type SaveDraftInput = z.infer<typeof saveDraftRequestSchema>;

/** Parse an untrusted save request, or throw a model-readable Error (route → 400; the message names
 *  the offending field so the brain self-corrects and re-saves). */
export function validateSaveDraftRequest(input: unknown): SaveDraftInput {
  const res = saveDraftRequestSchema.safeParse(input);
  if (!res.success) {
    const detail = res.error.issues.map((i) => `${i.path.join('.') || 'draft'}: ${i.message}`).join('; ');
    throw new Error(`invalid draft: ${detail}`);
  }
  return res.data;
}

// ---- Persisted-record schema: self-contained, EVERY field listed (the M6 strip-trap). ----
const draftRecordSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  trigger: z.string().optional(),
  body: z.string(),
  tags: z.array(z.string()).optional(),
  targetSkillId: z.string().optional(),
  status: z.enum(['open', 'promoted']),
  contentHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Copy + sort a set-like array so the hash input is order-independent; null for absent so
 *  JSON.stringify is stable. Local twin of skills/store.ts sortedOrNull (3 lines — a copy beats an
 *  export that widens that module's surface). */
function sortedOrNull(a: readonly string[] | undefined): string[] | null {
  return a ? [...a].sort() : null;
}

/** sha256 over canonical JSON of exactly the whitelisted, promote-relevant fields in a FIXED order
 *  (the skill store's computeContentHash idiom). targetSkillId IS hashed: retargeting an
 *  already-proposed draft must void its card. EXPORTED because the promote pin must be re-derived
 *  from LIVE fields at every belt (the getSkillDraft wiring feeding enrich, and the promote route) —
 *  comparing against the STORED hash would let a hand-edited pad file that changed `body` but kept
 *  the recorded hash sail through. */
export function draftContentHash(r: {
  name: string;
  description: string;
  trigger?: string;
  body: string;
  tags?: string[];
  targetSkillId?: string;
}): string {
  const obj = {
    name: r.name,
    description: r.description,
    trigger: r.trigger ?? null,
    body: r.body,
    tags: sortedOrNull(r.tags),
    targetSkillId: r.targetSkillId ?? null,
  };
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

/**
 * Load skill-drafts.json with the readSkills precedent: a read failure on an existing file is
 * transient I/O → throw; a torn/non-array file IS corruption → quarantine `.corrupt-<ts>` (a failed
 * rename throws — never silently wipe) and start empty; an invalid record is skipped with the file
 * bytes preserved once in `.rejected-<ts>`. contentHash is NOT recompute-verified on load — every
 * belt (the getSkillDraft wiring feeding enrich, and the promote route) re-derives the pin from the
 * LIVE fields via draftContentHash and never trusts this stored value, so a hand-mangled record
 * simply drift-voids.
 */
function readDrafts(file: string): SkillDraft[] {
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`[skill-drafts] cannot read ${file} (transient I/O — not corruption): ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
  } catch (err) {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    console.error(`[skill-drafts] ${file} corrupt (${(err as Error).message}); quarantining as ${quarantine}`);
    renameSync(file, quarantine); // throws on failure -> boot fails (no silent wipe)
    return [];
  }
  const records: SkillDraft[] = [];
  let rejects = 0;
  for (const el of parsed) {
    const res = draftRecordSchema.safeParse(el);
    if (!res.success) {
      rejects++;
      console.error(`[skill-drafts] skipping invalid draft record: ${res.error.message}`);
      continue;
    }
    records.push(res.data as SkillDraft);
  }
  if (rejects > 0) {
    try {
      copyFileSync(file, `${file}.rejected-${Date.now()}`);
    } catch (e) {
      console.error(`[skill-drafts] could not back up ${file}:`, e);
    }
  }
  return records;
}

export interface SkillDraftStoreHooks {
  onChange?: () => void;
}

export class SkillDraftStore {
  private drafts = new Map<string, SkillDraft>();
  private hooks: SkillDraftStoreHooks;

  /** `file` is overridable for tests only (the SkillSelectionStore precedent). */
  constructor(hooks: SkillDraftStoreHooks = {}, private readonly file: string = paths.skillDrafts) {
    this.hooks = hooks;
    mkdirSync(dirname(this.file), { recursive: true });
    for (const d of readDrafts(this.file)) this.drafts.set(d.id, d);
  }

  /** Wire the SSE hook after the broadcaster exists (integrator boot order — the SkillStore idiom).
   *  The integrator forwards it as the `{t:'skills'}` frame so the drafts strip refreshes live. */
  setHooks(hooks: SkillDraftStoreHooks): void {
    this.hooks = hooks;
  }

  /**
   * Create (draftId absent) or update (present) a draft. Throws a plain, model-readable Error the
   * route maps to 400 — and throws BEFORE any mutation, so a rejected save provably persists
   * nothing (the never-silent-pass tests assert the file bytes). An update is a full replace of the
   * whitelisted fields; it refuses a draft owned by another conversation and a promoted draft.
   */
  save(input: SaveDraftInput, conversationId: string): SkillDraft {
    if (!isSafeName(conversationId)) throw new Error('invalid conversation id');
    const bodyBytes = Buffer.byteLength(input.body, 'utf8');
    if (bodyBytes > DRAFT_BODY_MAX) {
      throw new Error(`draft body exceeds ${DRAFT_BODY_MAX} bytes — split the skill or trim the body`);
    }
    let existing: SkillDraft | undefined;
    if (input.draftId !== undefined) {
      if (!isSafeName(input.draftId)) throw new Error(`unknown draftId '${input.draftId}'`);
      existing = this.drafts.get(input.draftId);
      if (!existing) throw new Error(`unknown draftId '${input.draftId}' — omit draftId to create a new draft`);
      if (existing.conversationId !== conversationId) {
        throw new Error('draft belongs to another conversation — omit draftId to create your own');
      }
      if (existing.status !== 'open') throw new Error('draft already promoted — save a new draft');
    } else {
      const open = [...this.drafts.values()].filter((d) => d.status === 'open');
      if (open.length >= MAX_OPEN_DRAFTS) {
        throw new Error(`${MAX_OPEN_DRAFTS} drafts are already open — ask the operator to promote or discard some first`);
      }
      if (open.filter((d) => d.conversationId === conversationId).length >= MAX_OPEN_PER_CONVERSATION) {
        throw new Error(
          `${MAX_OPEN_PER_CONVERSATION} drafts are already open in this conversation — update one by draftId instead of creating more`,
        );
      }
    }
    const now = new Date().toISOString();
    const rec: SkillDraft = {
      id: existing?.id ?? shortId(),
      conversationId,
      name: input.name,
      description: input.description,
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
      body: input.body,
      ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
      ...(input.targetSkillId !== undefined ? { targetSkillId: input.targetSkillId } : {}),
      status: 'open',
      contentHash: draftContentHash(input),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.drafts.set(rec.id, rec);
    this.persist();
    this.afterMutate();
    return rec;
  }

  get(id: string): SkillDraft | undefined {
    return this.drafts.get(id);
  }

  /** META only — no bodies (a bounded list payload; the meta carries bodyBytes instead). */
  list(): SkillDraftMeta[] {
    return [...this.drafts.values()].map((d) => {
      const { body, ...meta } = d;
      return { ...meta, bodyBytes: Buffer.byteLength(body, 'utf8') };
    });
  }

  /** Operator discard (session-token DELETE). Returns whether the id existed (route → 404). */
  remove(id: string): boolean {
    if (!this.drafts.delete(id)) return false;
    this.persist();
    this.afterMutate();
    return true;
  }

  /** Flip a draft terminal after a successful promote. Unknown id throws (integrator error). */
  markPromoted(id: string): SkillDraft {
    const d = this.drafts.get(id);
    if (!d) throw new Error(`unknown draft '${id}'`);
    const rec: SkillDraft = { ...d, status: 'promoted', updatedAt: new Date().toISOString() };
    this.drafts.set(id, rec);
    this.persist();
    this.afterMutate();
    return rec;
  }

  // ---- internals ----

  private afterMutate(): void {
    try {
      this.hooks.onChange?.();
    } catch (err) {
      console.error('[skill-drafts] onChange hook failed:', err);
    }
  }

  private persist(): void {
    // Retain the newest RETAIN_TERMINAL promoted records, evicting oldest-first (Map order is
    // insertion order) — NEVER an open draft (the ProposalStore persist() idiom: eviction must not
    // vanish a draft a pending promote card still points at).
    let terminal = 0;
    for (const d of this.drafts.values()) {
      if (d.status !== 'open') terminal++;
    }
    for (const [id, d] of this.drafts) {
      if (terminal <= RETAIN_TERMINAL) break;
      if (d.status === 'open') continue;
      this.drafts.delete(id);
      terminal--;
    }
    writeJsonAtomic(this.file, [...this.drafts.values()], 0o600);
  }
}
