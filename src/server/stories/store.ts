// The Story corpus store (SPEC-STORYLOOP §1.1/§1.2, S1). A user story is first-class
// data the Tower checks work against — persisted per-project in ~/.ct/config/stories.json
// via an atomic 0600 write. Mirrors providers/store.ts: a self-contained zod schema (so it
// never contends on store.ts, ⟦DP-S1⟧), PER-RECORD load validation (one bad record can't
// wipe the corpus), and an onChange hook the integrator wires to the SSE `{t:'stories'}`
// frame so open Stories views refresh live.
//
// Coverage is NOT stored here — it is DERIVED fresh from the latest run (coverage.ts, §1.4).
// `status` is the operator's AUTHORING intent (draft/active/retired), never a computed verdict.

import { readFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { z } from 'zod';
import { paths } from '../paths.js';
import { writeJsonAtomic } from '../store.js';
import { shortId } from '../ids.js';
import type { Story, StoryStatus, CreateStoryRequest } from '../../shared/types.js';

// ---- Field caps (bound the stored record; parseStories caps drafts the same way, §1.3) ----
const MAX_TITLE = 200;
const MAX_STORY = 2000;
const MAX_ROUTES = 100;
const MAX_ROUTE_LEN = 300;
const MAX_SPEC_FILES = 100;

/**
 * A spec-file mapping is a repo-relative Playwright path — the COVERAGE JOIN KEY (§1.1). It must
 * be a `*.spec|*.test.[jt]sx?` path with no `..` and no leading `/`: a story should never point at
 * an absolute or traversing path, and the parser normalizes results repo-relative to match (§2.1).
 * The charset regex admits `/` and `.`, so the traversal/absolute checks are enforced separately.
 */
const SPEC_FILE_RE = /^[A-Za-z0-9._/-]+\.(spec|test)\.[jt]sx?$/;
export function isSafeSpecFile(p: unknown): p is string {
  return typeof p === 'string' && SPEC_FILE_RE.test(p) && !p.includes('..') && !p.startsWith('/');
}

// ---- Self-contained zod mirror — EVERY persisted field listed (§0.8 M6 trap: an unlisted
//      optional field is stripped on load). specFiles elements are validated strictly so a
//      hand-mangled record with a bad path is dropped PER-RECORD by readStories (not fatal to
//      the file); the API path (upsert) sanitizes instead of rejecting, so it never reaches here.
const StorySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  story: z.string().min(1),
  routes: z.array(z.string()).optional(),
  specFiles: z.array(z.string().refine(isSafeSpecFile, 'invalid spec-file path')).optional(),
  status: z.enum(['draft', 'active', 'retired']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** upsert input: a CreateStoryRequest plus an optional `id` — id present patches that story,
 *  id absent mints a new one (mirrors the create POST / patch PUT route split). */
export interface UpsertStoryInput extends CreateStoryRequest {
  id?: string;
}

// ---- Sanitizers (run on upsert; drop bad entries rather than reject the whole story, §1.1) ----

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

/** Keep only §1.1-safe spec paths; drop bad ones (do not reject the story), dedupe, cap count. */
function sanitizeSpecFiles(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!isSafeSpecFile(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SPEC_FILES) break;
  }
  return out;
}

/**
 * Load stories.json with PER-RECORD validation (mirrors store.ts readJsonArray / providers/store.ts
 * readDefs): one bad record must never wipe the corpus, which the next persist would then make
 * permanent. A read failure on an existing file is a TRANSIENT I/O error → throw (fail loud,
 * recoverable by restart). A torn / non-array file IS corruption → quarantine `.corrupt-<ts>` then
 * start empty. Invalid records are skipped with the original bytes preserved in `.rejected-<ts>`.
 */
function readStories(): { records: Story[]; hadRejects: boolean } {
  if (!existsSync(paths.stories)) return { records: [], hadRejects: false };

  let text: string;
  try {
    text = readFileSync(paths.stories, 'utf8');
  } catch (err) {
    throw new Error(
      `[stories] cannot read ${paths.stories} (transient I/O — not corruption): ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
  } catch (err) {
    const quarantine = `${paths.stories}.corrupt-${Date.now()}`;
    console.error(`[stories] ${paths.stories} corrupt (${(err as Error).message}); quarantining as ${quarantine}`);
    renameSync(paths.stories, quarantine); // throws on failure -> boot fails (no silent wipe)
    return { records: [], hadRejects: false };
  }

  const records: Story[] = [];
  let rejects = 0;
  for (const el of parsed) {
    const res = StorySchema.safeParse(el);
    if (res.success) records.push(res.data);
    else {
      rejects++;
      console.error(`[stories] skipping invalid story record: ${res.error.message}`);
    }
  }
  let hadRejects = false;
  if (rejects > 0) {
    try {
      copyFileSync(paths.stories, `${paths.stories}.rejected-${Date.now()}`);
      hadRejects = true; // backup ok -> safe to re-persist survivors
    } catch (e) {
      console.error(`[stories] could not back up ${paths.stories}; NOT re-persisting (keeping original):`, e);
    }
  }
  return { records, hadRejects };
}

/** Wired after construction so a mutation pushes an SSE `{t:'stories'}` frame — open Stories
 *  views refresh their corpus without a restart (the `{t:'providers'}` precedent). */
export interface StoryStoreHooks {
  onChange?: () => void;
}

export class StoryStore {
  private stories = new Map<string, Story>();
  private hooks: StoryStoreHooks;

  constructor(hooks: StoryStoreHooks = {}) {
    this.hooks = hooks;
    const { records, hadRejects } = readStories();
    for (const s of records) this.stories.set(s.id, s);
    // Reach a clean steady state now: the live file becomes valid-records-only; the dropped
    // records are already preserved in the .rejected-<ts> copy above.
    if (hadRejects) this.persist();
  }

  /** Wire the SSE hook after the broadcaster exists (integrator boot order). */
  setHooks(hooks: StoryStoreHooks): void {
    this.hooks = hooks;
  }

  // ---- reads ----
  /** All stories, or just one project's (the file holds every project's, like terminals/loops). */
  list(projectId?: string): Story[] {
    const all = [...this.stories.values()];
    return projectId ? all.filter((s) => s.projectId === projectId) : all;
  }
  get(id: string): Story | undefined {
    return this.stories.get(id);
  }

  // ---- mutations (each persists + emits the SSE frame) ----
  /**
   * Mint a new story (no id) or patch an existing one (id present). Sanitizes routes/specFiles and
   * caps lengths so a single bad entry drops rather than rejecting the story (§1.1). Store-owned
   * timestamps: createdAt survives edits, updatedAt always bumps. A story never changes project on
   * patch. The assembled record is StorySchema.parse'd as a final guard (throws on empty
   * title/story/projectId → the route returns 400).
   */
  upsert(input: UpsertStoryInput): Story {
    const now = new Date().toISOString();
    const existing = input.id ? this.stories.get(input.id) : undefined;

    const routes = sanitizeStrList(input.routes, MAX_ROUTES, MAX_ROUTE_LEN);
    const specFiles = sanitizeSpecFiles(input.specFiles);

    const candidate: Story = {
      id: existing?.id ?? input.id ?? shortId(),
      projectId: existing?.projectId ?? input.projectId,
      title: capStr(input.title, MAX_TITLE),
      story: capStr(input.story, MAX_STORY),
      routes: routes.length ? routes : undefined,
      specFiles: specFiles.length ? specFiles : undefined,
      status: input.status ?? existing?.status ?? 'draft',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const story = StorySchema.parse(candidate) as Story;

    this.stories.set(story.id, story);
    this.persist();
    this.afterMutate();
    return story;
  }

  remove(id: string): void {
    if (!this.stories.delete(id)) return; // unknown id — no write, no frame
    this.persist();
    this.afterMutate();
  }

  private afterMutate(): void {
    this.hooks.onChange?.();
  }

  private persist(): void {
    writeJsonAtomic(paths.stories, [...this.stories.values()], 0o600);
  }
}

// Re-export the authoring-lifecycle type so route/integrator code can import it from one place.
export type { StoryStatus };
