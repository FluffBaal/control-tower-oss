// Retention / GC (SPEC Sys-M3). Nothing under ~/.ct may grow without bound: pipe-pane
// logs rotate at a size cap, old test-run dirs and event files are pruned, and a disk
// watermark is exposed for the health panel. Runs on startup + a timer.

import { statSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, statfsSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';
import { readRunMeta } from './testkit.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate a terminal log past 5MB
const MAX_AUDIT_BYTES = 5 * 1024 * 1024; // rotate the audit log past 5MB, keeping one prior generation
const MAX_MEMORY_HISTORY_BYTES = 4 * 1024 * 1024; // rotate a project's memory history.jsonl past 4MB, one generation
const KEEP_TEST_RUNS = 50;
// SPEC-LOOP W4 — keep the newest N per-mission delivery reports; prune the rest (mtime-desc).
// Missions are never GC'd (they stay viewable in Outcomes), so a report pruned by count would leave a
// viewable mission with no report. Keep a large window so normal operation never prunes a live mission's
// report; only very old reports are reaped. Reports are metadata + a bounded (≤20MB) proof copy each.
const KEEP_REPORTS = 500;
const KEEP_EVENT_DAYS = 30;
const DISK_WARN_MB = 1024; // warn when the volume has < 1GB free

export interface DiskInfo {
  freeMb: number;
  low: boolean;
}

export function diskInfo(): DiskInfo {
  try {
    const st = statfsSync(paths.home);
    const freeMb = Math.round((st.bavail * st.bsize) / (1024 * 1024));
    return { freeMb, low: freeMb < DISK_WARN_MB };
  } catch {
    return { freeMb: -1, low: false };
  }
}

function rotateLogs(): void {
  if (!existsSync(paths.logs)) return;
  for (const f of readdirSync(paths.logs)) {
    if (!f.endsWith('.log')) continue;
    const p = join(paths.logs, f);
    try {
      if (statSync(p).size > MAX_LOG_BYTES) {
        // Truncate in place, keeping the recent tail. We cannot renameSync here:
        // tmux pipe-pane feeds this file through a long-lived `cat >> '<file>'` that
        // holds a single O_APPEND FD to the inode (opened once at session creation,
        // never re-opened). A rename leaves that FD attached to the same inode under
        // its new name, so the "rotated" file keeps growing unbounded and the live
        // path is never written again. writeFileSync truncates the same inode to 0
        // and lays down the tail; the held FD keeps appending after it. A minor
        // interleave with a concurrent append is acceptable for logs — retention
        // runs every 10 min, so at worst one line straddles a rotation.
        const buf = readFileSync(p);
        let tail = buf.subarray(buf.length - MAX_LOG_BYTES / 2);
        const nl = tail.indexOf(0x0a); // drop a partial first line
        if (nl >= 0) tail = tail.subarray(nl + 1);
        writeFileSync(p, tail);
      }
    } catch {
      /* ignore */
    }
  }
}

/** Rotate + tighten the append-only audit log. Unlike the tmux-piped terminal logs (held open by a
 *  long-lived pipe-pane FD, so rotateLogs truncates in place), audit.log is written via short-lived
 *  appendFileSync calls with no held FD — so a rename is safe and preserves the previous generation as
 *  audit.log.1 rather than discarding history. A fresh audit.log is recreated 0600 by the next audit()
 *  write. When the file hasn't yet grown past the cap, still re-tighten a pre-existing world-readable
 *  one to 0600 (defense-in-depth: the trail can name accounts/terminals/error strings). `maxBytes` is a
 *  parameter only so a test can trip the rotation without writing 5MB. */
export function rotateAudit(maxBytes = MAX_AUDIT_BYTES): void {
  if (!existsSync(paths.audit)) return;
  try {
    // Tighten FIRST, before any rename. renameSync preserves the source inode's mode, so a pre-existing
    // loose audit.log (created before 0600 enforcement) that is ALSO over the cap would otherwise ship
    // its loose bits straight into audit.log.1 — which nothing ever revisits — leaving it permanently
    // world-readable. This is the real upgrade path: retention runs an immediate sweep on startup, so
    // the first restart after deploy hits it. chmod-then-maybe-rename makes the rotated generation
    // inherit 0600 too. Also tightens the in-place file when it hasn't yet grown past the cap.
    chmodSync(paths.audit, 0o600);
    if (statSync(paths.audit).size > maxBytes) {
      renameSync(paths.audit, `${paths.audit}.1`); // overwrites any prior .1; keeps one 0600 generation
    }
  } catch {
    /* rotation/tighten is best-effort — never break the sweep */
  }
}

/**
 * SPEC-LOOP W7 — a run DEFERRED for an investigate loop mission (meta.deferredForMission set) but not yet
 * flushed (meta.autoFiled !== true) is PINNED from GC: the mission-end flush enumerates live run dirs to
 * file its real failures, so deleting it before the flush would silently lose them (the deferral opens a
 * window pre-W7 immediate-filing didn't have). Once the flush files-and-marks it (autoFiled=true), the next
 * GC reaps it normally (the mission-end flush clears deferredForMission when it finalizes the run, so a
 * settled mission never leaves a run pinned — even a no-op flush). Reads meta via TestKit's ONE meta-read
 * path (readRunMeta) so a layout change can't drift; an unreadable/absent meta is NOT pinned (deletable, as
 * pre-W7). Bounded: only a genuinely abandoned mid-flight mission (never settles) pins its own rounds' runs.
 */
function isPinnedDeferredRun(runDir: string): boolean {
  const meta = readRunMeta(runDir);
  return !!meta && typeof meta.deferredForMission === 'string' && meta.deferredForMission.length > 0 && meta.autoFiled !== true;
}

function gcTestRuns(): void {
  const dir = join(paths.home, 'testruns');
  if (!existsSync(dir)) return;
  try {
    const runs = readdirSync(dir)
      .map((d) => ({ d, t: statSync(join(dir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const r of runs.slice(KEEP_TEST_RUNS)) {
      // SPEC-LOOP W7 — never reap a deferred-but-unflushed run; the mission-end flush still needs it.
      if (isPinnedDeferredRun(join(dir, r.d))) continue;
      rmSync(join(dir, r.d), { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}

// SPEC-LOOP W4 — prune old per-mission delivery reports (structural twin of gcTestRuns over
// paths.reports): keep the newest KEEP_REPORTS by dir mtime, recursively remove the rest.
function gcReports(): void {
  const dir = paths.reports;
  if (!existsSync(dir)) return;
  try {
    const reports = readdirSync(dir)
      .map((d) => ({ d, t: statSync(join(dir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const r of reports.slice(KEEP_REPORTS)) rmSync(join(dir, r.d), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function gcEvents(): void {
  if (!existsSync(paths.events)) return;
  try {
    const files = readdirSync(paths.events).filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_EVENT_DAYS))) {
      rmSync(join(paths.events, f), { force: true });
    }
  } catch {
    /* ignore */
  }
}

/**
 * SPEC-MEMORY — rotate each project's write-ahead memory history.jsonl past the cap, keeping one prior
 * generation as history.jsonl.1 (the rotateAudit idiom: short-lived appendFileSync writes, no held FD, so
 * a rename is safe and a fresh 0600 file is recreated by the store's next append). Tighten to 0600 FIRST so
 * the rotated generation inherits it. NEVER touches entries.json (the source of truth), the
 * <file>.md.imported-<ts> legacy archives, or the entries.rejected-<ts>.json salvage copies — only the
 * append-only history log. Add-idempotency is unaffected: the dedup index is rebuilt from each entry's
 * INLINE rev-1 record (which boundHistory always retains), so a line rotated out of history.jsonl can never
 * resurrect a deduped add. `maxBytes` is a parameter only so a test can trip rotation without writing 4MB.
 */
export function gcMemoryHistory(maxBytes = MAX_MEMORY_HISTORY_BYTES): void {
  if (!existsSync(paths.memory)) return;
  let projects: string[];
  try {
    projects = readdirSync(paths.memory);
  } catch {
    return;
  }
  for (const pid of projects) {
    const hf = join(paths.memory, pid, 'history.jsonl');
    try {
      if (!existsSync(hf)) continue; // a non-dir entry, or a project with no history yet
      chmodSync(hf, 0o600);
      if (statSync(hf).size > maxBytes) {
        renameSync(hf, `${hf}.1`); // overwrites any prior .1; keeps exactly one 0600 generation
      }
    } catch {
      /* per-project best-effort — a bad one must never break the sweep */
    }
  }
}

export class Retention {
  private timer?: NodeJS.Timeout;
  /** SPEC-TERMINAL-OPS §4.4 — the terminal reaper, injected by the integrator. This module is
   *  deliberately fs-only (it may not reach into the terminal/mission plane), so the lifecycle GC
   *  rides the existing sweep cadence as a hook — the testkit.setHooks pattern. */
  private hooks?: { reapTerminals?: () => Promise<void> };
  /** Whether a reap is still in flight. The other sweep steps are synchronous, but the reap awaits a
   *  tmux kill per terminal and has no timeout guarantee, so a slow one (large fleet, stalled socket)
   *  can outlive the 10-minute interval. Without this, the next sweep would see store state that has
   *  not flipped yet and kill the same terminals a second time. */
  private reaping = false;
  setHooks(h: { reapTerminals?: () => Promise<void> }): void {
    this.hooks = h;
  }
  sweep(): void {
    rotateLogs();
    rotateAudit();
    gcTestRuns();
    gcReports();
    gcEvents();
    gcMemoryHistory();
    // Fire-and-forget: sweep() stays synchronous, and a reap failure must never break log rotation.
    // Skipped while one is still running — the next sweep is only 10 minutes away.
    // The try/catch is the guard for a SYNCHRONOUS throw. The declared hook returns a Promise and the
    // only implementation is `async` (which cannot throw synchronously), but the hook is pluggable:
    // were one ever to throw before returning, the exception would escape into the interval callback
    // with `reaping` still true and the reaper would be dead for the life of the process — no gate, no
    // log, no way to notice. Resetting the flag on every exit path is what keeps that impossible.
    const reap = this.hooks?.reapTerminals;
    if (reap && !this.reaping) {
      this.reaping = true;
      try {
        void reap()
          .catch((e) => console.error('[retention] terminal reap failed:', e))
          .finally(() => {
            this.reaping = false;
          });
      } catch (e) {
        this.reaping = false;
        console.error('[retention] terminal reap threw synchronously:', e);
      }
    }
  }
  start(): void {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
