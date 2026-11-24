// The Backlog store (SPEC-BACKLOG §1 ⟦DP-B2⟧). A Task is stored pre-execution work — the
// intake lanes (triage/todo/ready) the Board cannot derive, plus archived — persisted cross-project
// in ~/.ct/config/backlog.json via an atomic 0600 write. Mirrors the stories store shape (a
// self-contained zod mirror, PER-RECORD drop on load with a `.rejected-<ts>` backup, an onChange
// hook the integrator wires to the SSE `{t:'backlog'}` frame) BUT imports the CANONICAL
// readJsonArray / writeJsonAtomic from store.ts (passing mode 0o600) instead of cloning them.
//
// Execution state is NEVER stored here (⟦DP-B1⟧): a linked mission/loop owns running/done. A Task
// carries only the pre-execution lane + provenance (missionId/loopId); the display rule ⟦DP-B8⟧
// that hides/resurfaces a linked task is the client's, computed from props it already holds.
//
// THE STORE IS THE LIFECYCLE AUTHORITY: create() refuses ids and born-archived tasks, and
// transition() owns the lane-move guards (a linked task accepts only archive; archived restores
// only to triage). Routes are thin adapters — a future writer (towerctl, Jarvis) that calls the
// store directly cannot bypass an invariant, because the invariants live here, not in a route.

import { z } from 'zod';
import { paths } from '../paths.js';
import { shortId } from '../ids.js';
import { readJsonArray, writeJsonAtomic } from '../store.js';
import type { Task, TaskStatus, CreateTaskRequest } from '../../shared/types.js';

// ---- Field caps (bound the stored record) ----
const MAX_TITLE = 200;
const MAX_BODY = 4000;

// ---- Self-contained zod mirror — EVERY persisted Task field listed (the M6 trap: an unlisted
//      optional field is stripped on load). A hand-mangled record with a blank title / bad status
//      is dropped PER-RECORD by readJsonArray; the API path sanitizes instead, so a blank
//      title reaches this schema only as the final 400 guard.
const TaskSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  priority: z.number().int().min(0).max(3).optional(),
  status: z.enum(['triage', 'todo', 'ready', 'archived']),
  missionId: z.string().optional(),
  loopId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
});

/** A lifecycle-guard violation (illegal lane move, linked-task edit). Routes map it to 409 —
 *  distinct from a validation failure (blank title → zod throw → 400). */
export class TaskGuardError extends Error {}

/** transition() patch: absent field = unchanged; priority null = clear back to unranked (the
 *  only field needing an explicit clear — body clears via '', title can never be blank). */
export interface TaskPatch {
  title?: string;
  body?: string;
  priority?: 0 | 1 | 2 | 3 | null;
  status?: TaskStatus;
}

// ---- Sanitizers (normalize rather than reject so the record survives, §1) ----

function capStr(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

/** Trim + cap the body; an empty result becomes undefined so we never store a blank string. */
function sanitizeBody(v: unknown): string | undefined {
  const s = capStr(v, MAX_BODY);
  return s.length ? s : undefined;
}

/** Clamp priority to a 0-3 int (⟦DP-B3⟧ P0 highest); anything non-numeric is undefined (unranked). */
function clampPriority(v: unknown): 0 | 1 | 2 | 3 | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const n = Math.round(v);
  if (n <= 0) return 0;
  if (n >= 3) return 3;
  return n as 1 | 2;
}

/** Wired after construction so a mutation pushes the SSE `{t:'backlog'}` frame — open Boards pick
 *  up new/moved/archived tasks without a restart (the `{t:'stories'}` precedent, ⟦DP-B7⟧). */
export interface BacklogStoreHooks {
  onChange?: () => void;
}

export class BacklogStore {
  private tasks = new Map<string, Task>();
  private hooks: BacklogStoreHooks;

  constructor(hooks: BacklogStoreHooks = {}) {
    this.hooks = hooks;
    const { records, hadRejects } = readJsonArray(paths.backlog, TaskSchema);
    for (const t of records) this.tasks.set(t.id, t as Task);
    // Reach a clean steady state now: the live file becomes valid-records-only; dropped records
    // are already preserved in the `.rejected-<ts>` copy readJsonArray wrote.
    if (hadRejects) this.persist();
  }

  /** Wire the SSE hook after the broadcaster exists (integrator boot order). */
  setHooks(hooks: BacklogStoreHooks): void {
    this.hooks = hooks;
  }

  // ---- reads ----
  /** Every project's tasks (the Board is cross-project). NO sorting here — display sorts ⟦DP-B3⟧. */
  list(): Task[] {
    return [...this.tasks.values()];
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  // ---- mutations (each persists + emits the frame) ----

  /**
   * Mint a NEW task. The wire type excludes ids and 'archived' at compile time, but the store is
   * the runtime boundary: an id smuggled in the body must never turn a create into an unguarded
   * patch of an existing record, and a task is never born archived (⟦DP-B1⟧) — both are refused
   * here regardless of caller. TaskSchema.parse is the final guard (blank title throws → 400).
   */
  create(req: CreateTaskRequest): Task {
    if ((req as { id?: unknown }).id !== undefined) {
      throw new TaskGuardError('a create must not carry an id — use PUT to modify a task');
    }
    if (req.status === ('archived' as TaskStatus)) {
      throw new TaskGuardError('a task cannot be created archived');
    }
    const now = new Date().toISOString();
    const task = TaskSchema.parse({
      id: shortId(),
      projectId: req.projectId,
      title: capStr(req.title, MAX_TITLE),
      body: sanitizeBody(req.body),
      priority: clampPriority(req.priority),
      status: req.status ?? 'triage',
      createdAt: now,
      updatedAt: now,
    }) as Task;
    this.tasks.set(task.id, task);
    this.persist();
    this.afterMutate();
    return task;
  }

  /**
   * Patch an existing task under the lifecycle guards (SPEC-BACKLOG §5):
   *  - a LINKED task (missionId/loopId set) accepts ONLY a bare archive — its lane is derived
   *    from the run (⟦DP-B8⟧), so lane moves and content edits are refused;
   *  - an archived task's only lane exit is the restore to 'triage' (which clears archivedAt);
   *  - content merges field-by-field: absent = unchanged, priority null = clear to unranked.
   * Guard violations throw TaskGuardError (→ 409); a blank title throws out of zod (→ 400).
   */
  transition(id: string, patch: TaskPatch): Task {
    const cur = this.tasks.get(id);
    if (!cur) throw new TaskGuardError(`unknown task ${id}`);

    const linked = Boolean(cur.missionId ?? cur.loopId);
    const bareArchive =
      patch.status === 'archived' &&
      patch.title === undefined && patch.body === undefined && patch.priority === undefined;
    if (linked && !bareArchive) {
      throw new TaskGuardError('a task linked to a run only accepts archive — its lane is derived from the run');
    }
    if (!linked && cur.status === 'archived' && patch.status !== undefined
      && patch.status !== 'triage' && patch.status !== 'archived') {
      throw new TaskGuardError('an archived task can only be restored to triage');
    }

    const now = new Date().toISOString();
    const status: TaskStatus = patch.status ?? cur.status;
    const candidate: Task = {
      ...cur,
      title: patch.title !== undefined ? capStr(patch.title, MAX_TITLE) : cur.title,
      body: patch.body !== undefined ? sanitizeBody(patch.body) : cur.body,
      priority: patch.priority === null ? undefined
        : patch.priority !== undefined ? clampPriority(patch.priority) : cur.priority,
      status,
      updatedAt: now,
      // Re-archive keeps the first stamp; any live lane clears it (the archived→triage undo).
      archivedAt: status === 'archived' ? cur.archivedAt ?? now : undefined,
    };
    const task = TaskSchema.parse(candidate) as Task;
    this.tasks.set(task.id, task);
    this.persist();
    this.afterMutate();
    return task;
  }

  /**
   * Stamp provenance after a mission/loop is instantiated FROM a task (⟦DP-B4⟧; called by the
   * route, never the missions/loops modules). REFUSES to overwrite an existing missionId or
   * loopId (bounds a double-draft to one orphaned run) and ignores an unknown id; both are
   * logged skips. BEST-EFFORT BY CONTRACT: a persist failure here is logged and swallowed —
   * the run was already created, and a link I/O error must never surface as a create failure.
   */
  link(id: string, ref: { missionId?: string; loopId?: string }): void {
    const cur = this.tasks.get(id);
    if (!cur) {
      console.warn(`[backlog] link: unknown task ${id} — ignoring`);
      return;
    }
    if (cur.missionId || cur.loopId) {
      console.warn(`[backlog] link: task ${id} already linked (${cur.missionId ?? cur.loopId}) — refusing overwrite`);
      return;
    }
    this.tasks.set(id, { ...cur, missionId: ref.missionId, loopId: ref.loopId, updatedAt: new Date().toISOString() });
    try {
      this.persist();
      this.afterMutate();
    } catch (e) {
      console.error(`[backlog] link: persist failed for ${id} (link held in memory): ${(e as Error).message}`);
    }
  }

  /** Archive a task: stamp status 'archived' + archivedAt. Idempotent — an already-archived task
   *  (or an unknown id) is a silent no-op with no write and no frame. */
  archive(id: string): void {
    const cur = this.tasks.get(id);
    if (!cur || cur.status === 'archived') return;
    const now = new Date().toISOString();
    this.tasks.set(id, { ...cur, status: 'archived', archivedAt: now, updatedAt: now });
    this.persist();
    this.afterMutate();
  }

  /** Auto-archive the task linked to a finished execution (⟦DP-B5⟧, the onExecutionDone adapter).
   *  Iterates without cloning (this fires on every land / mission completion). No match is a
   *  single logged no-op — a landed loop with no originating task is normal. */
  archiveByExecution(ref: { missionId?: string; loopId?: string }): void {
    for (const t of this.tasks.values()) {
      if ((ref.missionId !== undefined && t.missionId === ref.missionId)
        || (ref.loopId !== undefined && t.loopId === ref.loopId)) {
        this.archive(t.id);
        return;
      }
    }
    console.log(`[backlog] archiveByExecution: no task for ${ref.missionId ?? ref.loopId ?? '(empty ref)'}`);
  }

  private afterMutate(): void {
    this.hooks.onChange?.();
  }

  private persist(): void {
    writeJsonAtomic(paths.backlog, [...this.tasks.values()], 0o600);
  }
}

// Re-export the lane-status type so route/integrator code can import it from one place.
export type { TaskStatus };
