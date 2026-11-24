// Shared E2E test kit (SPEC §12/M6). Deliberately NOT a scheduler: a free-port
// allocator + ONE global, memory-aware semaphore so many agents can run Playwright
// suites at once without the OOM-killer-takes-tmux cascade
// (Sys-C5). Slots are leases with a TTL so a crashed run can't starve the fleet.
//
// SPEC-STORYLOOP §2.1 (the keystone) adds STRUCTURED results on top: at release we
// parse Playwright's JSON reporter into `TestRun.results` (+ ran/total/failed), the
// one array that fans out to the loop feedback, the judge, coverage, and fixer
// assignment. `parsePlaywrightResults` is the frozen parser the test-kit callers join on.

import net from 'node:net';
import os from 'node:os';
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, lstatSync, copyFileSync } from 'node:fs';
import { join, relative, isAbsolute, basename } from 'node:path';
import { paths } from './paths.js';
import { shortId } from './ids.js';
// writeMeta reuses the store's temp+rename helper so a crash mid-write can never leave a torn
// meta.json — a torn meta reads back as `undefined`, which for a deferred run drops its GC pin and
// lets a real failure be reaped off disk. No import cycle: store.ts never imports the kit.
import { writeJsonAtomic } from './store.js';
import type { TestFailure, ParsedRun, TestTriageEntry, TriageClass } from '../shared/types.js';
// TRIAGE_CLASSES / triageKey are runtime VALUES (setTriage validates class membership + normalizes join
// keys) — value imports, never `import type`, or they would erase at compile and the checks would break.
import { TRIAGE_CLASSES, TRIAGE_KEY_CAP, TRIAGE_REASON_CAP, triageKey } from '../shared/types.js';

const RUNS_DIR = join(paths.home, 'testruns');
/** Rough per-browser budget; the cap divides free RAM by this. */
const MB_PER_SLOT = 400;
const LEASE_TTL_MS = 30 * 60 * 1000;
/** Largest results.json the Tower will parse in-process; bigger reports degrade to `undefined`
 *  (honest "no parseable results") instead of risking an OOM of the whole control plane. */
const MAX_RESULTS_JSON_BYTES = 25 * 1024 * 1024;
// SPEC-TESTING §6 — hard caps on the release-time artifact copy, so a pathological suite can't
// turn the run store into a disk bomb (retention keeps 50 runs → worst case 25 MB × 50).
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACTS_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 20;
/** The shortId alphabet (ids.ts:7) as a runId gate: getRun joins runId into RUNS_DIR and
 *  the /api/testruns/:id/... routes hand it caller input, so anything outside the id charset
 *  (e.g. `../../..`) must be byte-identical to not-found — never a path join. */
const RUN_ID_RE = /^[a-z0-9]{1,16}$/;

export interface TestRun {
  id: string;
  terminalId: string;
  projectId: string;
  port: number;
  status: 'running' | 'passed' | 'failed';
  runDir: string;
  startedAt: string;
  finishedAt?: string;
  // ---- SPEC-STORYLOOP §2.1: structured results, parsed at release ----
  /** Failing tests parsed from Playwright's JSON reporter. `undefined` = the
   *  reporter was not wired (honest degradation → consumers fall back to the check
   *  tail); `[]` = the suite ran and stayed all-green. The `undefined` vs `[]`
   *  distinction is load-bearing (§1.4/§3.3): "all green" is never "no reporter". */
  results?: TestFailure[];
  /** Every non-skipped spec's normalized repo-relative path that ran (deduped) —
   *  lets coverage tell a green mapping from one pointing at a spec that never ran
   *  (`stale-missing`). */
  ran?: string[];
  total?: number;
  failed?: number;
  /** `'gate'` tags trial-merge regression-gate runs so they are EXCLUDED from every
   *  user-facing derivation (`latestFor`/`latestForProject`, chips, coverage);
   *  `'agent'` is the normal `towerctl test run` path. Absent on legacy runs. */
  kind?: 'agent' | 'gate';
  /** The repo-relative join-key base for the release-time parse fold, stored
   *  at acquire and read back by `release`. Pass the RUNNING TREE root (the agent's
   *  worktree / the gate's trial worktree) so `specFile` keys stay repo-relative and
   *  worktree-location-independent. */
  repoPath?: string;
  /** SPEC-TESTING-V2 §1 — an on-demand LLM triage digest of this run's failures (display-only; never
   *  fed to fixer/documentor prompts). Set by TestKit.setSummary AFTER release, which is a SYNCHRONOUS
   *  read→cap→writeMeta that refuses `status === 'running'` — so it never races release()'s own meta
   *  write. meta.json is raw JSON (no zod), so this field is the contract; nothing strips it. */
  summary?: string;
  /** SPEC-LOOP W5 — the run-dir-relative names of release-time captured logs, under `<runDir>/logs/`.
   *  Set by TestKit.setLogs (the setSummary contract: a SYNCHRONOUS read→cap→writeMeta that refuses
   *  `status === 'running'`). meta.json is raw JSON (no zod), so THIS doc IS the contract — nothing
   *  strips it. Contents are secret (tokens) and reachable ONLY through the guarded logs route. */
  logs?: string[];
  /** SPEC-LOOP W7 — the routed investigator's false-fail classifications of this run's failures. Set by
   *  TestKit.setTriage (the setSummary contract: a SYNCHRONOUS read→validate→writeMeta that refuses
   *  `status === 'running'`), and WRITE-ONCE — a retried fixer re-reading its pinned run must re-derive an
   *  IDENTICAL suppression filter (the deterministic-partition rule), so a submitted triage is never
   *  reclassified. meta.json is raw JSON (no zod), so THIS doc IS the contract — nothing strips it. Entries
   *  are agent-authored, keyed by specFile+testTitle; never fed anywhere as instructions, only as a filter. */
  triage?: TestTriageEntry[];
  /** SPEC-LOOP W7 — set true once this run's failures have been auto-filed to the backlog (by the
   *  immediate onParsed path, the triage route's deferred completion, OR the mission-end flush). The
   *  idempotency marker that keeps the flush from double-filing a run the triage route already filed.
   *  meta.json is raw JSON, so THIS doc IS the contract. Set by TestKit.setAutoFiled (the setLogs contract). */
  autoFiled?: boolean;
  /** SPEC-LOOP W7 — the investigate loop mission whose onParsed hook DEFERRED this run's auto-file (set at
   *  RELEASE, before any round-stamp). The mission-end flush enumerates runs by THIS field (not the loop's
   *  round stamps, which the abort path never writes), so a run deferred then aborted before evaluateCompletion
   *  ever stamps it is still flushed — and it survives a restart (meta persists). Set by setDeferredForMission. */
  deferredForMission?: string;
}

/**
 * SPEC-LOOP W7 — validate + clamp raw triage entries against a run's ACTUAL failure keys. Shared by
 * TestKit.setTriage (the write) AND the triage route (its 400-when-zero-survive pre-check), so the route
 * can never burn the write-once slot with a triage the store would persist as []. An entry survives only
 * with non-empty specFile+testTitle (sliced to the join cap), a class in TRIAGE_CLASSES, and a key that
 * matches one of the run's real failures. Caps the count at 100 and the reason at the join cap.
 */
export function cleanTriageEntries(entries: unknown, failureKeys: Set<string>): TestTriageEntry[] {
  const cleaned: TestTriageEntry[] = [];
  const seen = new Set<string>(); // DEDUP by triageKey (FIRST-wins) so the stored triage, the fixer filter,
  // and the report all agree on one entry per (specFile, testTitle) — a duplicate entry would otherwise
  // inflate the report's by-design/false count above the deduped set the fixer partition suppresses.
  for (const e of (Array.isArray(entries) ? entries : []).slice(0, 100)) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const specFile = typeof o.specFile === 'string' ? o.specFile.slice(0, TRIAGE_KEY_CAP) : '';
    const testTitle = typeof o.testTitle === 'string' ? o.testTitle.slice(0, TRIAGE_KEY_CAP) : '';
    if (!specFile || !testTitle) continue;
    if (typeof o.class !== 'string' || !(TRIAGE_CLASSES as readonly string[]).includes(o.class)) continue;
    const key = triageKey({ specFile, testTitle });
    if (!failureKeys.has(key)) continue; // no matching real failure — drop
    if (seen.has(key)) continue; // first classification for this key wins
    seen.add(key);
    const entry: TestTriageEntry = { specFile, testTitle, class: o.class as TriageClass };
    if (typeof o.reason === 'string' && o.reason.trim()) entry.reason = o.reason.slice(0, TRIAGE_REASON_CAP);
    cleaned.push(entry);
  }
  return cleaned;
}

/** SPEC-LOOP W7 — the ONE meta.json read path: getRun AND retention's GC pin both go through here, so a
 *  meta layout change can never silently drift the two. Returns the parsed TestRun, or undefined on a
 *  missing / torn meta. The caller is responsible for any runId charset gate before building `runDir`. */
export function readRunMeta(runDir: string): TestRun | undefined {
  const p = join(runDir, 'meta.json');
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as TestRun;
  } catch {
    return undefined;
  }
}

/** Allocate a currently-free TCP port (OS-assigned from the ephemeral range). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Wired after construction (the BacklogStore.setHooks pattern, SPEC-TESTING §5/§6). `onParsed`
 *  fires at the END of release() — AFTER the meta write and ONLY when the run carries
 *  parsed results. release() stays synchronous: the orchestrator's hook body owns the auto-file
 *  decision and contains its own async rejections (`void p.catch(log)`). */
export interface TestKitHooks {
  onParsed?: (run: TestRun) => void;
}

export class TestKit {
  private slots = new Map<string, { acquiredAt: number; terminalId: string; port: number }>();
  private hooks: TestKitHooks = {};

  /** `maxSlots` is the operator's configured ceiling (Settings); read each capacity()
   *  call so a UI change takes effect live. Guarded/clamped inside Settings, never NaN. */
  constructor(private maxSlots: () => number) {
    mkdirSync(RUNS_DIR, { recursive: true });
  }

  /** Wire the release hook after the integrator's dependents exist (boot order). */
  setHooks(hooks: TestKitHooks): void {
    this.hooks = hooks;
  }

  /** Concurrency cap computed against CURRENT free memory, not a static total. */
  capacity(): number {
    const freeMb = os.freemem() / (1024 * 1024);
    return Math.max(1, Math.min(this.maxSlots(), Math.floor(freeMb / MB_PER_SLOT)));
  }

  private reclaimStale(): void {
    const now = Date.now();
    for (const [id, s] of this.slots) if (now - s.acquiredAt > LEASE_TTL_MS) this.slots.delete(id);
  }

  activeCount(): number {
    this.reclaimStale();
    return this.slots.size;
  }

  /** Acquire a slot + port, or null if at capacity. Records a 'running' TestRun.
   *  `repoPath` is the repo-relative join-key base for the release-time parse
   *  — pass the running tree root (the agent terminal's worktree). */
  async acquire(terminalId: string, projectId: string, repoPath: string): Promise<TestRun | null> {
    this.reclaimStale();
    if (this.slots.size >= this.capacity()) return null;
    const id = shortId();
    // Reserve the slot SYNCHRONOUSLY, before the first await, so the next
    // concurrent acquire() sees the incremented size and can't also pass the
    // capacity guard on the same pre-increment count (the TOCTOU that over-
    // commits the memory budget).
    this.slots.set(id, { acquiredAt: Date.now(), terminalId, port: 0 });
    try {
      const port = await freePort();
      return this.finishAcquire(id, terminalId, projectId, repoPath, port, 'agent');
    } catch (err) {
      // Anything after the reservation failing (port alloc, mkdir, write) must
      // not leak the held slot, or a transient error permanently shrinks the cap.
      this.slots.delete(id);
      throw err;
    }
  }

  /** Terminal-less acquire for the regression gate. The gate runs
   *  server-side with NO terminal token, so it cannot go through the token-guarded
   *  `acquire`; it mints a `kind:'gate'` run that every user-facing accessor excludes.
   *  SYNCHRONOUS `TestRun | null` per the frozen contract (§7) — see `freePortSync`.
   *  Returns null at capacity; the gate treats that as a bounded queue+retry, NOT a
   *  regression (§4.3). */
  acquireGate(projectId: string, repoPath: string): TestRun | null {
    this.reclaimStale();
    if (this.slots.size >= this.capacity()) return null;
    const id = shortId();
    this.slots.set(id, { acquiredAt: Date.now(), terminalId: '', port: 0 });
    try {
      const port = this.freePortSync();
      return this.finishAcquire(id, '', projectId, repoPath, port, 'gate');
    } catch (err) {
      this.slots.delete(id);
      throw err;
    }
  }

  /** Shared tail of acquire/acquireGate once a slot is held and a port is chosen:
   *  records the port on the live slot (so freePortSync avoids it), lays out the run
   *  dir, and persists meta.json. */
  private finishAcquire(
    id: string,
    terminalId: string,
    projectId: string,
    repoPath: string,
    port: number,
    kind: 'agent' | 'gate',
  ): TestRun {
    const slot = this.slots.get(id);
    if (slot) slot.port = port;
    const runDir = join(RUNS_DIR, id);
    mkdirSync(join(runDir, 'blob'), { recursive: true });
    const run: TestRun = {
      id,
      terminalId,
      projectId,
      port,
      status: 'running',
      runDir,
      startedAt: new Date().toISOString(),
      kind,
      repoPath,
    };
    this.writeMeta(run);
    return run;
  }

  /** Synchronous best-effort free port for the terminal-less gate path. The frozen
   *  contract makes `acquireGate` return `TestRun | null` synchronously (§7), so it
   *  cannot `await freePort()`. Pick a random high port not currently reserved by a
   *  live slot in THIS process; cross-process contention is the same best-effort
   *  window as `freePort`'s close-then-bind gap. A rare collision surfaces as the
   *  gate suite failing to bind → the gate treats any non-green suite as attention
   *  (§4.3), so it degrades safely, never a silent pass. */
  private freePortSync(): number {
    const inUse = new Set<number>();
    for (const s of this.slots.values()) if (s.port) inUse.add(s.port);
    for (let i = 0; i < 100; i++) {
      const p = 20000 + Math.floor(Math.random() * 40000); // 20000–59999
      if (!inUse.has(p)) return p;
    }
    return 20000 + Math.floor(Math.random() * 40000);
  }

  /** Release a slot, finalize status, and fold Playwright's structured results into
   *  the SAME meta.json write (§2.1). A run with no parseable report keeps
   *  `results` undefined (honest degradation). */
  release(runId: string, status: 'passed' | 'failed'): void {
    this.slots.delete(runId);
    const run = this.getRun(runId);
    if (!run) return;
    // idempotence at the choke point: a second release of an already-finished run must not
    // re-parse, re-copy artifacts, or re-fire the hook. The route additionally 404s non-owners;
    // this holds even for callers that reach release() directly.
    if (run.status !== 'running') return;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    // repoPath is the join-key base stored at acquire; a legacy run without it
    // falls back to runDir so the parse can't throw (its keys are then run-dir-
    // relative and simply won't join — honest, never a fabricated result).
    const parsed = parsePlaywrightResults(run.runDir, run.repoPath ?? run.runDir);
    if (parsed) {
      run.results = parsed.failures;
      run.ran = parsed.ran;
      run.total = parsed.total;
      run.failed = parsed.failed;
      // §6: copy referenced artifacts NOW — release is the LAST instant the source tree
      // (the worktree's test-results) is guaranteed to exist. Rewrites failure.artifacts
      // in place to the copied run-dir-relative names, so the SAME meta write below
      // persists them.
      this.copyArtifacts(run, parsed.attachments);
    }
    this.writeMeta(run);
    // §5 hook — AFTER writeMeta (a hook crash can't lose the parsed-results write) and
    // only when there ARE parsed results. Sync throws are contained here; async rejections are
    // the hook body's own job (release stays synchronous).
    if (run.results !== undefined) {
      try {
        this.hooks.onParsed?.(run);
      } catch (err) {
        console.error(`[testkit] onParsed hook failed for run ${runId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Attach an on-demand LLM triage digest to a finished run (SPEC-TESTING-V2 §1, D1). This is
   * the ONLY meta writer besides release(). CONTRACT INVARIANTS: a SYNCHRONOUS read→cap→writeMeta
   * with NO interior await, and REFUSE a still-`running` run.
   *
   * Why it can't race release()'s own meta write: release() is fully synchronous and idempotent
   * (status!=='running' early return), and the summarize route is only reachable after the run has
   * parsed results (written by release, at which point status is 'passed'/'failed'). So by the time
   * a summary is requested, release() has already made its final meta write and can't run again.
   * The refuse-running guard makes that safety explicit rather than merely emergent. Display-only
   * (DEC-1): TestRun.summary rides meta.json to the client and is NEVER fed to a fixer/documentor.
   */
  setSummary(runId: string, text: string): void {
    // Re-read the current meta through getRun (which also enforces the runId charset guard). The
    // route already read this run, but the re-read is DELIBERATE: mutating the freshest meta means
    // a field written between the route's read and now can never be clobbered here. Unknown run →
    // silent return, mirroring release()'s miss handling; the route 404s an unknown id before this
    // anyway.
    const run = this.getRun(runId);
    if (!run) return;
    // Never touch a live run's meta mid-flight — only release() may write while running, and a
    // summary is meaningless before results exist.
    if (run.status === 'running') return;
    run.summary = text.slice(0, 4000); // cap ~4000 chars (defense-in-depth; the validator caps too)
    this.writeMeta(run);
  }

  /**
   * Attach the release-time captured log names to a finished run (SPEC-LOOP W5). Mirrors setSummary
   * VERBATIM (the same read→cap→writeMeta contract): re-read through getRun (the charset gate + the
   * freshest meta so an interleaving field write is never clobbered), silent return on an unknown
   * run, and REFUSE a still-`running` run so this never races release()'s own meta write. Caps at 12
   * names (the capture engine already bounds this; the cap is defense-in-depth). Names only — the
   * log CONTENTS live under `<runDir>/logs/` and never ride meta.json.
   */
  setLogs(runId: string, files: string[]): void {
    const run = this.getRun(runId);
    if (!run) return;
    if (run.status === 'running') return;
    run.logs = files.slice(0, 12);
    this.writeMeta(run);
  }

  /**
   * SPEC-LOOP W7 — attach the routed investigator's false-fail classifications to a finished run. Mirrors
   * setSummary/setLogs VERBATIM (the same SYNCHRONOUS read→validate→writeMeta contract): re-read through
   * getRun (the charset gate + freshest meta), silent return on an unknown run, and REFUSE a still-
   * `running` run so it never races release()'s own meta write. PLUS write-once (refuse when run.triage is
   * already set) — a retried fixer re-reading its pinned run must re-derive an IDENTICAL suppression
   * filter (the deterministic-partition rule), so a submitted triage is never reclassified mid-round. The
   * entries are validated + clamped against the run's ACTUAL failure keys (cleanTriageEntries); an entry
   * matching no real failure, with a bad class, or over the caps is dropped. Never throws.
   */
  setTriage(runId: string, entries: TestTriageEntry[]): void {
    const run = this.getRun(runId);
    if (!run) return;
    if (run.status === 'running') return;
    if (run.triage !== undefined) return; // write-once
    run.triage = cleanTriageEntries(entries, new Set((run.results ?? []).map(triageKey)));
    this.writeMeta(run);
  }

  /**
   * SPEC-LOOP W7 — mark a finished run's failures as auto-filed to the backlog (idempotency for the
   * mission-end flush). Mirrors setLogs VERBATIM (the read→set→writeMeta contract): re-read through
   * getRun (charset gate + freshest meta), silent return on an unknown run, refuse a still-`running`
   * run, idempotent (already set → no-op re-write avoided). Never throws.
   */
  setAutoFiled(runId: string): void {
    const run = this.getRun(runId);
    if (!run) return;
    if (run.status === 'running') return;
    if (run.autoFiled === true) return; // idempotent — already marked
    run.autoFiled = true;
    this.writeMeta(run);
  }

  /**
   * SPEC-LOOP W7 — set or CLEAR a finished run's deferred-for-mission marker. Set at release when onParsed
   * defers it (the mission-end flush enumerates runs by this field); CLEARED (missionId undefined) by the
   * flush after it FINALIZES the run, so the retention GC pin (deferredForMission set && !autoFiled)
   * releases even when the flush was a no-op (autoFileFailures toggled off, or a backlog throw) — otherwise
   * the run would stay pinned forever and ~/.ct/testruns would grow unbounded. Mirrors setAutoFiled (the
   * read→set→writeMeta contract): unknown run / running → no-op; idempotent.
   */
  setDeferredForMission(runId: string, missionId: string | undefined): void {
    const run = this.getRun(runId);
    if (!run) return;
    if (run.status === 'running') return;
    const next = missionId || undefined;
    if (run.deferredForMission === next) return; // idempotent (also covers clear-when-already-clear)
    if (next === undefined) delete run.deferredForMission;
    else run.deferredForMission = next;
    this.writeMeta(run);
  }

  /**
   * Bounded copy of every artifact a failing test referenced (SPEC-TESTING §6 ⟦D4⟧) into
   * `<runDir>/artifacts/<i>-<basename>`, rewriting each TestFailure.artifacts to the copied
   * names. Hard caps: per-file 5 MB, per-run 25 MB, 20 files; over-cap / missing / non-regular
   * sources are dropped SILENTLY — the failure record survives artifact loss.
   */
  private copyArtifacts(run: TestRun, sources: AttachmentSource[][]): void {
    if (!run.results?.length) return;
    const dir = join(run.runDir, 'artifacts');
    let files = 0;
    let totalBytes = 0;
    let madeDir = false;
    for (let i = 0; i < run.results.length; i++) {
      if (files >= MAX_ARTIFACT_FILES || totalBytes >= MAX_ARTIFACTS_TOTAL_BYTES) break;
      const failure = run.results[i]!;
      const copied: string[] = [];
      for (const src of sources[i] ?? []) {
        if (files >= MAX_ARTIFACT_FILES || totalBytes >= MAX_ARTIFACTS_TOTAL_BYTES) break;
        // <global-index>-<basename> keeps names unique across failures; basename() strips any
        // directory part, so the stored name is always a single path segment (the serve route's
        // resolveContained re-checks containment anyway).
        const base = basename(src.path ?? src.name) || 'attachment';
        const destName = `${files}-${base}`;
        try {
          let size: number;
          if (src.path !== undefined) {
            const abs = isAbsolute(src.path) ? src.path : join(run.repoPath ?? run.runDir, src.path);
            // source hardening (liveness, not secrecy): lstat — NO symlink deref — and
            // require a REGULAR file. A FIFO smuggled into a report would otherwise block this
            // synchronous copy and wedge the whole control plane.
            const st = lstatSync(abs);
            if (!st.isFile()) continue;
            size = st.size;
            if (size > MAX_ARTIFACT_BYTES || totalBytes + size > MAX_ARTIFACTS_TOTAL_BYTES) continue;
            if (!madeDir) {
              mkdirSync(dir, { recursive: true });
              madeDir = true;
            }
            copyFileSync(abs, join(dir, destName));
          } else {
            const buf = Buffer.from(src.body ?? '', 'base64');
            size = buf.length;
            if (size === 0 || size > MAX_ARTIFACT_BYTES || totalBytes + size > MAX_ARTIFACTS_TOTAL_BYTES) continue;
            if (!madeDir) {
              mkdirSync(dir, { recursive: true });
              madeDir = true;
            }
            writeFileSync(join(dir, destName), buf);
          }
          totalBytes += size;
          files++;
          copied.push(destName);
        } catch {
          // Missing/unreadable source ⇒ dropped silently (§6).
        }
      }
      if (copied.length > 0) failure.artifacts = copied;
    }
  }

  private writeMeta(run: TestRun): void {
    mkdirSync(run.runDir, { recursive: true });
    // Atomic: the temp lands inside run.runDir (not RUNS_DIR, so listRuns' readdir is unpolluted) and a
    // crash between write and rename leaves a harmless meta.json.tmp GC'd with the dir.
    writeJsonAtomic(join(run.runDir, 'meta.json'), run);
  }

  getRun(runId: string): TestRun | undefined {
    // charset gate BEFORE the join — a non-shortId id (`../../..`) never touches the
    // filesystem, and the miss is byte-identical to an unknown run (404 upstream).
    if (!RUN_ID_RE.test(runId)) return undefined;
    return readRunMeta(join(RUNS_DIR, runId));
  }

  listRuns(): TestRun[] {
    if (!existsSync(RUNS_DIR)) return [];
    const runs: TestRun[] = [];
    for (const d of readdirSync(RUNS_DIR)) {
      const r = this.getRun(d);
      if (r) runs.push(r);
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Newest NON-GATE run for a builder terminal — chips (§5.2), loop feedback
   *  (§2.3a), the fixer-assignment join (§3.3). Excludes `kind:'gate'` runs.
   *  `results` may be `undefined` (reporter not wired) — consumers guard on it. */
  latestFor(terminalId: string): TestRun | undefined {
    return this.listRuns().find((r) => r.kind !== 'gate' && r.terminalId === terminalId);
  }

  /** Newest NON-GATE run for a project — coverage (§1.4). Excludes
   *  `kind:'gate'` runs; `results` may be `undefined` (a run with no reporter),
   *  which coverage renders as a neutral "no run yet", never green. */
  latestForProject(projectId: string): TestRun | undefined {
    return this.listRuns().find((r) => r.kind !== 'gate' && r.projectId === projectId);
  }

  /** Newest non-gate run WITH parsed results for a project (§1.4's stated accessor).
   *  `acquire` persists a `running` meta (results undefined) immediately, so the bare
   *  newest-run accessor above would blank a project's earned coverage for the whole
   *  duration of any in-progress run — this one skips unparsed runs the same way
   *  SuiteChip's client-side scan does, so the two derivations agree. */
  latestParsedForProject(projectId: string): TestRun | undefined {
    return this.listRuns().find(
      (r) => r.kind !== 'gate' && r.projectId === projectId && r.results !== undefined,
    );
  }
}

// ---- The parser (SPEC-STORYLOOP §2.1) — frozen: parsePlaywrightResults(runDir, repoPath) ----

/** Strips ANSI SGR / CSI escapes (Playwright colorizes error messages). */
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');
const toPosix = (p: string): string => p.replace(/\\/g, '/');

/** Minimal shapes of Playwright's JSON reporter — only the fields we read. */
interface PwError {
  message?: string;
}
/** JSONReportTestResult.attachments (shape CONFIRMED, SPEC-TESTING §0) — every field optional
 *  HERE because foreign/older reports may omit or mistype any of them. */
interface PwAttachment {
  name?: string;
  path?: string;
  body?: string; // base64
  contentType?: string;
}
interface PwResult {
  status?: string;
  error?: PwError;
  errors?: PwError[];
  attachments?: PwAttachment[];
}
interface PwTest {
  status?: string; // 'expected' | 'unexpected' | 'skipped' | 'flaky'
  results?: PwResult[];
}
interface PwSpec {
  title?: string;
  file?: string; // relative to config.rootDir
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  config?: { rootDir?: string };
  suites?: PwSuite[];
}

/** One artifact source referenced by a failing test (SPEC-TESTING §6): a reporter file `path`
 *  OR an inline base64 `body`. Collected at parse, copied (bounded) at release — never persisted
 *  itself; TestFailure.artifacts carries the COPIED run-dir-relative names instead. */
export interface AttachmentSource {
  name: string;
  path?: string;
  body?: string;
}

/** What release() consumes: the frozen ParsedRun plus per-failure attachment sources,
 *  PARALLEL to `failures` by index. Structurally a ParsedRun, so existing consumers
 *  (the gate, the fixer join) are untouched. */
export interface ParsedRunWithAttachments extends ParsedRun {
  attachments: AttachmentSource[][];
}

/** Every attachment referenced by ANY result of a failing test (a retry attaches its own
 *  screenshot/trace), fully defensively — skip malformed entries, dedup repeated paths. */
function attachmentSourcesOf(results: PwResult[] | undefined): AttachmentSource[] {
  const out: AttachmentSource[] = [];
  const seenPaths = new Set<string>();
  for (const r of results ?? []) {
    if (!Array.isArray(r?.attachments)) continue;
    for (const a of r.attachments) {
      if (!a || typeof a !== 'object') continue;
      const name = typeof a.name === 'string' && a.name ? a.name : 'attachment';
      if (typeof a.path === 'string' && a.path) {
        if (seenPaths.has(a.path)) continue;
        seenPaths.add(a.path);
        out.push({ name, path: a.path });
      } else if (typeof a.body === 'string' && a.body) {
        out.push({ name, body: a.body });
      }
    }
  }
  return out;
}

/** The last ~12 lines of the first result carrying an error, ANSI-stripped, ≤2000
 *  chars — the compact failure the loop feedback / judge / fixer task quote (§2.3). */
function errorTailOf(results: PwResult[] | undefined): string {
  let msg = '';
  for (const r of results ?? []) {
    const m = r?.error?.message ?? r?.errors?.find((e) => e?.message)?.message;
    if (m) {
      msg = m;
      break;
    }
  }
  const clean = stripAnsi(msg).replace(/\r/g, '');
  const tail = clean.split('\n').slice(-12).join('\n').trim();
  return tail.length > 2000 ? tail.slice(0, 2000) : tail;
}

/**
 * Parse Playwright's JSON reporter (`runDir/results.json`) into structured results
 * (SPEC-STORYLOOP §2.1). Returns `undefined` when the file is absent or unparseable
 * — honest degradation (consumers fall back to the 12-line check tail). A present,
 * even empty or all-green, report returns a `ParsedRun` (all-green ⇒ `failures: []`),
 * so callers tell "all green" from "no reporter" on `undefined` vs `[]`.
 *
 * Outcome mapping (verified against the real reporter): the TEST-level
 * `status` drives it — `unexpected` → a failure; `expected` → pass; `skipped` →
 * ignored (not in `ran`); `flaky` (failed then passed on a retry) → a PASS, so it is
 * NOT a failure, aligning `results` with the suite's own exit code (a flaky suite
 * exits 0). Every non-skipped spec's normalized path enters `ran` (deduped).
 *
 * `specFile` normalization: the JSON's `file` is relative to
 * `config.rootDir` — and Playwright's `rootDir` is the TEST dir, NOT the repo root
 * (verified). So we resolve `file` to absolute via `rootDir`, then re-anchor at
 * `repoPath` to produce a repo-relative key (e.g. `tests/checkout.spec.ts`) that
 * joins with `Story.specFiles`. Pass `repoPath` = the running tree root and the key
 * is stable regardless of which worktree ran it; if `repoPath` is not an ancestor
 * (e.g. a worktree ran while `repoPath` is the base repo) we fall back to a
 * `rootDir`-relative key rather than emit a `..`-laden path.
 */
export function parsePlaywrightResults(runDir: string, repoPath: string): ParsedRunWithAttachments | undefined {
  const file = join(runDir, 'results.json');
  if (!existsSync(file)) return undefined;
  let report: PwReport;
  try {
    // Size ceiling BEFORE the read: this runs in the single Tower process, and a pathological
    // report (huge embedded stdout/error blobs) would otherwise be slurped and parsed whole —
    // an OOM takes down the control plane. Oversize degrades to `undefined` like unparseable
    // JSON does, matching the module's bounded-memory posture (200KB suite-output cap).
    if (statSync(file).size > MAX_RESULTS_JSON_BYTES) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    report = parsed as PwReport;
  } catch {
    return undefined;
  }

  const rootDir =
    typeof report.config?.rootDir === 'string' && report.config.rootDir
      ? report.config.rootDir
      : repoPath;

  const normSpec = (f: string): string => {
    const abs = isAbsolute(f) ? f : join(rootDir, f);
    let rel = relative(repoPath, abs);
    // ..-free (§2.1): if repoPath isn't an ancestor of the file, anchor at rootDir
    // so the key stays clean and worktree-stable (a `..` path can't be a join key).
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) rel = relative(rootDir, abs);
    // If the file escapes BOTH anchors, `rel` is still `..`-laden — fall back to the
    // basename so the guarantee holds: still a stable grouping key, never a `..` path
    // in fixer prompts or attention notes.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) rel = basename(abs);
    return toPosix(rel);
  };

  const failures: TestFailure[] = [];
  // §6 — per-failure attachment sources, parallel to `failures` (pushed in lockstep below).
  const attachments: AttachmentSource[][] = [];
  const ran = new Set<string>();
  let total = 0;
  let failed = 0;

  // Top-level suites are file suites (title = file basename); nested suites are
  // `describe` blocks. `testTitle` is the describe-chain + spec title WITHOUT the
  // file (consumers render `specFile › testTitle`, so folding the file in would
  // double it) — hence `isFileLevel` starts the describe path empty.
  const walk = (suites: PwSuite[] | undefined, describePath: string[], isFileLevel: boolean): void => {
    for (const suite of suites ?? []) {
      const childPath = isFileLevel
        ? []
        : suite.title
          ? [...describePath, suite.title]
          : describePath;
      for (const spec of suite.specs ?? []) {
        const specFile = normSpec(spec.file ?? suite.file ?? suite.title ?? '');
        const titles = spec.title ? [...childPath, spec.title] : childPath;
        for (const t of spec.tests ?? []) {
          if (t.status === 'skipped') continue; // ignored
          ran.add(specFile);
          total++;
          if (t.status === 'unexpected') {
            // 'expected'/'flaky' ⇒ pass; only 'unexpected' is a failure.
            failed++;
            failures.push({
              specFile,
              testTitle: titles.join(' › '),
              errorTail: errorTailOf(t.results),
            });
            attachments.push(attachmentSourcesOf(t.results));
          }
        }
      }
      walk(suite.suites, childPath, false);
    }
  };

  walk(report.suites, [], true);
  return { failures, attachments, ran: [...ran], total, failed };
}
