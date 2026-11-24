// Cross-agent coordination (SPEC D8/D9, M5). Deliberately NOT a server: mail is
// Tower-mediated JSON files with provenance, delivered by an idle-nudge (agents don't
// poll mid-task, so the Tower pokes them when they next go idle). Memory is a few
// well-known markdown files per project, OUTSIDE any repo/worktree so it can't diverge
// per branch. The honest anti-collision guarantee remains worktree isolation; this is
// best-effort coordination on top.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { paths } from './paths.js';
import { shortId, isSafeName, uuid } from './ids.js';
import { renderView, parseView, viewHash, diffReplace, bodyHasReservedSyntax, RESERVED_SYNTAX_MESSAGE, TEST_KIT_KEY } from './memory/views.js';
import { importLegacy } from './memory/migrate.js';
import { MEMORY_KINDS, viewFileFor } from '../shared/memory.js';
import type { MemoryKind } from '../shared/memory.js';
import { StaleRevError, NotFoundError } from './memory/store.js';
import type { MemoryStore } from './memory/store.js';
import { BODY_MAX, MAX_ENTRIES_PER_PROJECT } from './memory/schema.js';

// Re-export the single source of truth for the three view filenames (derived from MEMORY_KINDS in
// shared/memory.ts) so server.ts / memory-instruction.ts keep importing it from here, with no drift-prone
// second literal.
export { MEMORY_FILES } from '../shared/memory.js';

const pexec = promisify(execFile);

export interface MailMessage {
  id: string;
  from: string; // terminalId, or 'human'
  fromLabel: string;
  body: string;
  ts: string;
  read: boolean;
}

const MAIL_ROOT = join(paths.home, 'mail');
const MEM_ROOT = join(paths.home, 'memory');

// The one client-caused Memory error (a project id that fails isSafeName). Exported so the HTTP layer
// can map it to 400 without matching a bare string literal — a reworded throw can no longer silently
// downgrade every bad id to a 500.
export const INVALID_PROJECT_ID = 'invalid project id';

// SPEC-STORYLOOP §5.3 — the bounded, idempotent "E2E test kit" block ensureTestKitMemory
// appends to a project's glossary.md. The HTML-comment marker is the idempotency key: invisible in
// rendered markdown and stable even if the operator edits the visible heading or body text.
const TEST_KIT_MARKER = '<!-- ct:e2e-test-kit -->';
const TEST_KIT_BLOCK = `${TEST_KIT_MARKER}
## E2E test kit

- Run the browser end-to-end (Playwright) suite with \`towerctl test run\`. It reserves a memory-aware
  test slot and a free port, runs the suite, and records structured per-spec pass/fail results.
- User stories live in the Stories section as first-class data ("As a … I want … so that …"). Each
  story maps to the Playwright spec file(s) that cover it — keep that story→spec map accurate when you
  add or move specs, because coverage and fixer assignment join on the spec-file path.
- In a verify phase the Tower assigns each fixer its own failing spec files from the runner's
  \`towerctl test run\` results; fix only the specs named in your task.`;

export class Mail {
  private dir(terminalId: string): string {
    // Defense-in-depth against path traversal: terminal ids are Tower-generated
    // shortIds, so anything else (e.g. an agent-supplied '../../tmp/evil') is rejected
    // before it can reach join()/mkdirSync.
    if (!isSafeName(terminalId)) throw new Error('invalid terminal id');
    const d = join(MAIL_ROOT, terminalId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  send(toTerminalId: string, from: string, fromLabel: string, body: string): MailMessage {
    const msg: MailMessage = {
      id: shortId(),
      from,
      fromLabel,
      body,
      ts: new Date().toISOString(),
      read: false,
    };
    writeFileSync(join(this.dir(toTerminalId), `${Date.now()}-${msg.id}.json`), JSON.stringify(msg, null, 2), 'utf8');
    return msg;
  }

  inbox(terminalId: string): MailMessage[] {
    const d = this.dir(terminalId);
    const out: MailMessage[] = [];
    for (const f of readdirSync(d).filter((n) => n.endsWith('.json')).sort()) {
      try {
        out.push(JSON.parse(readFileSync(join(d, f), 'utf8')));
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  }

  unreadCount(terminalId: string): number {
    return this.inbox(terminalId).filter((m) => !m.read).length;
  }

  markAllRead(terminalId: string): void {
    const d = this.dir(terminalId);
    for (const f of readdirSync(d).filter((n) => n.endsWith('.json'))) {
      const p = join(d, f);
      try {
        const m = JSON.parse(readFileSync(p, 'utf8')) as MailMessage;
        if (!m.read) writeFileSync(p, JSON.stringify({ ...m, read: true }, null, 2), 'utf8');
      } catch {
        /* skip */
      }
    }
  }

  /**
   * SPEC-PLANNER §8 — move a planner pane's UNREAD mail to its respawned successor, so a consult pointer
   * that was never read isn't stranded in a dead pane's inbox. Per-file rename (best-effort; a failed one
   * is skipped, not fatal — the consult body is also re-fetchable over the pending route). Read mail stays
   * behind (it's history, and the successor self-briefs via the pending route's ledger). Both ids pass
   * dir()'s isSafeName guard. Returns the count moved.
   */
  migrate(fromTerminalId: string, toTerminalId: string): number {
    const from = this.dir(fromTerminalId);
    const to = this.dir(toTerminalId); // creates the successor's dir if absent
    let moved = 0;
    for (const f of readdirSync(from).filter((n) => n.endsWith('.json'))) {
      const src = join(from, f);
      try {
        const m = JSON.parse(readFileSync(src, 'utf8')) as MailMessage;
        if (m.read) continue; // only the unread pointer needs to follow the pane
        renameSync(src, join(to, f));
        moved++;
      } catch {
        /* skip a corrupt / racing file — best-effort */
      }
    }
    return moved;
  }
}

/** A legacy whole-file write whose submitted header hash no longer matches the live view — the memory
 *  changed underneath the writer. Carries the current view so the caller can re-read and merge; the HTTP
 *  layer maps it to 409. */
export class StaleViewError extends Error {
  constructor(readonly current: string) {
    super('memory changed since it was read — re-read and retry');
    this.name = 'StaleViewError';
  }
}

/**
 * Shared memory as versioned ENTRIES (MemoryStore), presented through the SAME three-file API the rest of
 * the Tower already uses. The three practical categories — Decisions / Gotchas / Glossary — are the entry
 * `kind`; the three markdown files are GENERATED views, regenerated on every change, so `towerctl memory
 * read` and the MemoryBar (meta) keep working unchanged. `read`/`all` return a view; `write` is the
 * OPERATOR's revision-checked whole-file replace, turned into per-entry ops under the operator principal
 * (the old per-terminal agent path is retired — an agent records through the entry verbs instead); `meta`
 * stats the generated views. Legacy free-form files are imported to entries on first touch (their
 * originals archived, never deleted). This augments the old memory; it does not change the operator's or
 * an agent's mental model of it.
 */
export class Memory {
  constructor(private readonly store: MemoryStore) {}

  private dir(projectId: string): string {
    // Same path-traversal guard as Mail.dir: project ids are Tower-generated shortIds, so reject
    // anything that could escape MEM_ROOT before it can reach join()/mkdirSync.
    if (!isSafeName(projectId)) throw new Error(INVALID_PROJECT_ID);
    const d = join(MEM_ROOT, projectId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  private kindForFile(file: string): MemoryKind {
    const k = MEMORY_KINDS.find((x) => viewFileFor(x) === file);
    if (!k) throw new Error('unknown memory file');
    return k;
  }

  /**
   * First-load migration: if a project has no entries.json yet but legacy .md files exist, import them
   * (originals archived) and write the generated views. Wired to the store's `ensureLoaded` hook, so it
   * fires on the FIRST access via ANY path — the facade AND the direct entry routes — before an empty
   * store state can clobber the legacy files. Idempotent (hasProject short-circuit; the store's
   * loadingHooked guard stops re-entry while importLegacy mutates the store).
   */
  migrateProject(projectId: string): void {
    if (this.store.hasProject(projectId)) return; // entries.json exists → already migrated / just created
    const dir = this.dir(projectId);
    const n = importLegacy(this.store, projectId, dir);
    if (n > 0) this.writeViews(projectId);
  }

  /** Regenerate all three markdown view files on disk so meta() and `towerctl memory read` see current
   *  content. Writers: the store's onChange hook (every persisted mutation), the post-migration call, and
   *  the tail of write() (which can fire on a zero-op whole-file save before any entries.json exists —
   *  harmless, since importLegacy's isGeneratedView check skips a header-only view on the next load rather
   *  than mistaking it for legacy content). A read never writes.
   *
   *  Only a view whose freshly rendered text actually DIFFERS from what's on disk is rewritten (or one
   *  that's absent) — a mutation to one kind must not touch the other two files' mtime, since the
   *  MemoryBar's per-file recency dot (SPEC-FLIGHTLINE-V2 §4) is mtime-based and would otherwise light all
   *  three after any single-kind change. */
  writeViews(projectId: string): void {
    const dir = this.dir(projectId);
    const entries = this.store.list(projectId);
    for (const kind of MEMORY_KINDS) {
      const file = join(dir, viewFileFor(kind));
      const text = renderView(kind, entries);
      let current: string | undefined;
      try {
        current = readFileSync(file, 'utf8');
      } catch {
        current = undefined; // absent (or unreadable) → always (re)write
      }
      if (current === text) continue; // unchanged — skip the write so its mtime stays put
      try {
        writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        console.error(`[memory] could not write ${viewFileFor(kind)} for ${projectId}: ${(err as Error).message}`);
      }
    }
  }

  read(projectId: string, file: string): string {
    const kind = this.kindForFile(file);
    return renderView(kind, this.store.list(projectId)); // store.list triggers first-load migration
  }

  all(projectId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const kind of MEMORY_KINDS) out[viewFileFor(kind)] = this.read(projectId, viewFileFor(kind));
    return out;
  }

  /**
   * The legacy whole-file replace, now revision-checked + turned into entry ops under `principal` — the
   * OPERATOR only (the old per-terminal agent path is retired; over HTTP the sole remaining caller is the
   * operator's `PUT /api/memory/:id/:file`). The submitted text MUST carry the header hash it was read
   * with (parseView); a mismatch means the view changed underneath → StaleViewError (the caller re-reads).
   * diffReplace derives add/edit/retract ops, each attributed to `principal` and CAS'd on the marker rev.
   * ALL ops are PRE-VALIDATED before any is applied: this method is synchronous, so pre-flight + apply
   * cannot interleave, making the whole-file save effectively atomic — a stale marker rev or an over-cap
   * add rejects the ENTIRE save, never a partial write. Invariant: a concurrent change is never silently
   * clobbered.
   */
  write(projectId: string, file: string, content: string, principal: { kind: 'operator' }): void {
    const kind = this.kindForFile(file);
    if (content.length > 64 * 1024) throw new Error('memory file exceeds 64KB budget');
    const entries = this.store.list(projectId); // triggers first-load migration
    const currentView = renderView(kind, entries);
    if (parseView(content).hash !== viewHash(kind, entries)) throw new StaleViewError(currentView);
    const ops = diffReplace(currentView, content);
    // Pre-flight every body this save would store, BEFORE any op is applied (the store would refuse each
    // one too, but mid-loop — after earlier ops had landed, leaving a partial save). An over-long note is
    // named rather than truncated. Reserved view syntax is refused here too, and this check is LOAD-BEARING
    // on this path: parseView only splits on entry markers, drops header/heading LINES, and strips a
    // TRAILING status line — so an appended or edited section like `harmless\n— verified\nmore` (the badge
    // spoof mid-body), or `claim\r— verified` (a lone CR, which the operator's textarea shows as a line
    // break but parseView does not split on), reaches diffReplace's ops intact and is stopped only by this
    // pre-flight (and the store's own assertBody behind it).
    for (const body of [...ops.adds, ...ops.edits.map((e) => e.body)]) {
      if (body.length > BODY_MAX) throw new Error(`a single memory note exceeds ${BODY_MAX} chars — split it into separate entries`);
      if (bodyHasReservedSyntax(body)) throw new Error(RESERVED_SYNTAX_MESSAGE);
    }
    // Pre-flight the cap: the store's own CapError would fire mid-loop, after earlier adds had landed.
    const activeIds = new Set(entries.filter((e) => e.lifecycle === 'active').map((e) => e.id));
    const freed = ops.retracts.filter((id) => activeIds.has(id)).length;
    if (activeIds.size - freed + ops.adds.length > MAX_ENTRIES_PER_PROJECT) throw new Error('memory is full — retract or consolidate before adding');
    // Pre-flight EVERY op against current state so a mid-loop failure can't leave a partial save committed.
    for (const e of ops.edits) {
      const cur = this.store.get(projectId, e.id);
      if (!cur) throw new NotFoundError(e.id);
      if (cur.rev !== e.rev) throw new StaleRevError(structuredClone(cur));
    }
    // Apply (validated).
    for (const id of ops.retracts) {
      const cur = this.store.get(projectId, id);
      if (cur && cur.lifecycle === 'active') this.store.update(projectId, principal, { id, rev: cur.rev, lifecycle: 'retracted' });
    }
    for (const e of ops.edits) this.store.update(projectId, principal, { id: e.id, rev: e.rev, body: e.body });
    for (const body of ops.adds) this.store.add(projectId, principal, { requestId: uuid(), kind, body });
    this.writeViews(projectId);
  }

  /**
   * SPEC-FLIGHTLINE-V2 §4 — per-file freshness metadata (mtime + size) for the MemoryBar recency dot.
   * fs.stat only — no content, no secrets, and it never rewrites a view (so the dot reflects the last
   * real mutation, not the last read). It stats whatever views exist; an absent view is omitted and the
   * caller degrades gracefully. The seqOf() call is a cheap read that lets first-load migration fire.
   */
  meta(projectId: string): Record<string, { mtimeMs: number; size: number }> {
    this.store.seqOf(projectId); // a cheap read through forProject, so first-load migration still fires
    const dir = this.dir(projectId);
    const out: Record<string, { mtimeMs: number; size: number }> = {};
    for (const kind of MEMORY_KINDS) {
      try {
        const st = statSync(join(dir, viewFileFor(kind)));
        out[viewFileFor(kind)] = { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        /* an un-statable file is simply omitted, so the caller degrades gracefully */
      }
    }
    return out;
  }

  /**
   * SPEC-STORYLOOP §5.3 — the bounded "E2E test kit" glossary note, now a keyed upsert (idempotent by the
   * `ct:e2e-test-kit` key, not a marker scan). The Integrator calls it when a project's story corpus is
   * first created; repeat calls are safe no-ops unless the block text itself changed.
   */
  ensureTestKitMemory(projectId: string): void {
    this.store.upsertKeyed(projectId, TEST_KIT_KEY, { kind: 'glossary', body: TEST_KIT_BLOCK, author: { kind: 'tower', reason: 'test-kit' } });
    this.writeViews(projectId);
  }
}

export interface LogHit {
  terminalId: string;
  line: string;
}

/** grep across all terminal logs (SPEC P16). ANSI-stripped, capped. */
export async function searchLogs(query: string): Promise<LogHit[]> {
  if (!query || query.length > 200) return [];
  try {
    const { stdout } = await pexec(
      'grep',
      ['-rIn', '--include=*.log', '-e', query, paths.logs],
      { maxBuffer: 4 * 1024 * 1024 },
    ).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
    return stdout
      .split('\n')
      .filter(Boolean)
      .slice(0, 200)
      .map((l) => {
        // format: <path>:<lineno>:<text>
        const m = l.match(/\/([a-z0-9]+)\.log:\d+:(.*)$/i);
        // strip ANSI
        const text = (m?.[2] ?? l).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        return { terminalId: m?.[1] ?? '?', line: text.slice(0, 240) };
      });
  } catch {
    return [];
  }
}
