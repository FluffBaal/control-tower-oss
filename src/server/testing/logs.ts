// SPEC-LOOP W5 — release-time log capture (G-QUALITY a). At the onParsed hook (server.ts) the
// worktree/compose stack is still guaranteed alive, so this is the LAST synchronous instant we can
// tail the project's server/docker logs into the run dir. It runs on the event loop inside the
// hook body, so it is SYNCHRONOUS and — like copyArtifacts — it NEVER THROWS: every source is in
// its own try/catch and the whole body is wrapped, degrading to `[]` (honest "captured nothing").
//
// SECRETS: captured contents routinely carry tokens/keys. They are written ONLY to
// `<runDir>/logs/` and served ONLY through the guarded (session-token) logs route. They are NEVER
// logged to the Tower console or the audit trail (the caller audits only runId + count).
//
// Containment: every requested path crosses resolveContained (realpath + prefix, no `..`/symlink
// escape — files.ts §2), and every open uses O_NOFOLLOW|O_NONBLOCK + fstat.isFile():
//   - O_NOFOLLOW: a symlink final component fails ELOOP → the per-source catch drops it (a dir
//     scan never follows a symlinked entry out of the tree).
//   - O_NONBLOCK: an attacker-placed FIFO can't wedge the synchronous read (mirrors files.ts) —
//     the fstat rejects it as non-regular before any byte is read.
// Bounds: 1 MB tail per file, 12 files, 8 MB per run, 500 dir entries scanned (one level).

import {
  openSync,
  fstatSync,
  readSync,
  closeSync,
  writeFileSync,
  mkdirSync,
  opendirSync,
  statSync,
  constants,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { join, basename } from 'node:path';
import { resolveContained } from '../files.js';
import type { TestRun } from '../testkit.js';
import type { ProjectTestingConfig } from '../../shared/types.js';

/** Tail kept per captured file. */
const MAX_TAIL_BYTES = 1 * 1024 * 1024;
/** Hard ceiling on captured files across the whole run. */
const MAX_FILES = 12;
/** Hard ceiling on total captured bytes across the whole run. */
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** A logSource that is a directory is scanned ONE level via opendirSync (an INCREMENTAL reader — it
 *  never materializes the whole listing), stopping after this many entries; beyond that the scan is
 *  truncated, so even a directory with millions of rotated logs can't stall the sync scan or spike
 *  memory. The scanned entries are then ordered newest-first (by mtime) before the file/byte caps
 *  apply, so the currently-active log wins the budget rather than an arbitrary OS-order entry. */
const MAX_DIR_SCAN = 500;
/** `docker compose logs --tail` line budget (the byte output is still tail-capped to MAX_TAIL_BYTES). */
const DOCKER_TAIL_LINES = 1000;
/** Wall-clock ceiling for the docker capture. captureDocker is OPT-IN and this runs SYNCHRONOUSLY on
 *  the event loop (the compose stack is only guaranteed alive at parse time), so a hung dockerd blocks
 *  the daemon for at most this window — kept short deliberately; it is the cost of the opt-in feature.
 *  On a maxBuffer/timeout overrun the partial stdout is salvaged (execFileSync keeps the OLDEST bytes
 *  of the tail window on overrun — an unavoidable limitation; the tail budget above makes it rare). */
const DOCKER_TIMEOUT_MS = 5_000;

// O_NOFOLLOW makes a symlinked final component ELOOP (dropped by the per-source catch); O_NONBLOCK
// stops a FIFO wedging the synchronous read (fstat rejects it as non-regular first).
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/**
 * Capture the project's opted-in server/docker logs for a finished run. SYNCHRONOUS and NEVER
 * THROWS — returns the run-dir-relative names written under `<runDir>/logs/` (byte-identical to
 * their on-disk names), or `[]` when nothing was captured / on any top-level error. The caller
 * persists the names via `TestKit.setLogs` and audits only the COUNT (never the contents).
 */
export function captureRunLogs(run: TestRun, cfg: ProjectTestingConfig | undefined): string[] {
  try {
    // Fast exit: not opted in → touch nothing (no dir made, no docker spawned).
    if (!(cfg?.logSources?.length || cfg?.captureDocker)) return [];

    const names: string[] = [];
    const dir = join(run.runDir, 'logs');
    // repoPath is the running worktree (alive at release); logSources are resolved repo-relative
    // against it. A legacy run without it falls back to runDir (contained but empty of repo logs).
    const root = run.repoPath ?? run.runDir;
    let totalBytes = 0;
    let madeDir = false;

    // Lazy mkdir on first write — copy the copyArtifacts madeDir idiom so an opted-in project that
    // captures nothing leaves no empty logs dir.
    const ensureDir = (): void => {
      if (!madeDir) {
        mkdirSync(dir, { recursive: true });
        madeDir = true;
      }
    };

    // Write one capture, applying the per-file tail cap AND the per-run total cap (tail-keep), then
    // recording the name. The dest basename is truncated AT WRITE time so the on-disk name is
    // byte-identical to the returned/stored name (no disk/meta desync). Returns false when the run
    // budget (files or bytes) is exhausted, so callers can stop early.
    const emit = (base: string, raw: Buffer): boolean => {
      if (names.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return false;
      let data = raw;
      if (data.length > MAX_TAIL_BYTES) data = data.subarray(data.length - MAX_TAIL_BYTES);
      const remaining = MAX_TOTAL_BYTES - totalBytes;
      if (data.length > remaining) data = data.subarray(data.length - remaining);
      if (data.length === 0) return true;
      const idx = names.length;
      const destName = `${idx}-${(basename(base) || 'log').slice(0, 180)}`;
      ensureDir();
      writeFileSync(join(dir, destName), data);
      totalBytes += data.length;
      names.push(destName);
      return true;
    };

    // Open a single candidate, reject non-regular (FIFO/dir/device/symlink-ELOOP) via fstat, read
    // only the last MAX_TAIL_BYTES (clamped to the remaining run budget), and emit it. Per-source
    // try/catch: a missing/ELOOP/unreadable candidate is dropped, never a throw.
    const captureFile = (absPath: string, base: string): boolean => {
      if (names.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return false;
      let fd: number | undefined;
      try {
        fd = openSync(absPath, OPEN_FLAGS);
        const st = fstatSync(fd);
        if (!st.isFile()) return true; // FIFO/device/dir/socket — dropped, keep going
        const size = st.size;
        if (size === 0) return true;
        const remaining = MAX_TOTAL_BYTES - totalBytes;
        const readLen = Math.min(MAX_TAIL_BYTES, size, remaining);
        if (readLen <= 0) return false;
        const position = size - readLen;
        const buf = Buffer.alloc(readLen);
        let off = 0;
        while (off < readLen) {
          const n = readSync(fd, buf, off, readLen - off, position + off);
          if (n === 0) break;
          off += n;
        }
        const data = off === readLen ? buf : buf.subarray(0, off);
        return emit(base, data);
      } catch {
        return true; // per-source drop (missing / ELOOP symlink / unreadable)
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            /* best-effort */
          }
        }
      }
    };

    for (const src of cfg?.logSources ?? []) {
      if (names.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) break;
      try {
        const rc = resolveContained(root, src);
        // rc.real is fully realpath-resolved (final component is NOT a symlink), so statSync here
        // classifies the resolved target — a symlinked source that escaped the root already threw.
        const st = statSync(rc.real);
        if (st.isDirectory()) {
          // Scan INCREMENTALLY via opendirSync (never materializes the full listing) up to
          // MAX_DIR_SCAN regular-file entries, then order newest-first so the currently-active log
          // wins the file/byte budget instead of an arbitrary OS-order entry.
          const cand: { name: string; mtimeMs: number }[] = [];
          const d = opendirSync(rc.real);
          try {
            // Bound on dirents ITERATED (not just files collected), so a directory of a million
            // subdirs/symlinks stops at MAX_DIR_SCAN too — matching the "500 entries scanned" doc.
            let scanned = 0;
            let ent = d.readSync();
            while (ent !== null && scanned < MAX_DIR_SCAN) {
              scanned++;
              if (ent.isFile()) {
                try {
                  cand.push({ name: ent.name, mtimeMs: statSync(join(rc.real, ent.name)).mtimeMs });
                } catch {
                  /* entry vanished mid-scan — skip */
                }
              }
              ent = d.readSync();
            }
          } finally {
            try {
              d.closeSync();
            } catch {
              /* best-effort */
            }
          }
          cand.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
          for (const c of cand) {
            if (!captureFile(join(rc.real, c.name), c.name)) break; // run budget exhausted
          }
        } else if (st.isFile()) {
          captureFile(rc.real, basename(src));
        }
      } catch {
        // resolveContained escape/missing, or a stat/readdir race → drop this source.
      }
    }

    // docker compose logs (tail). Runs from the worktree so compose finds the project. On a
    // maxBuffer/timeout overrun execFileSync throws but leaves the partial stdout on the error —
    // salvage that tail rather than losing everything. stderr is discarded (secrets) and never
    // surfaces on the Tower console.
    if (cfg?.captureDocker && names.length < MAX_FILES && totalBytes < MAX_TOTAL_BYTES) {
      try {
        const out = execFileSync(
          'docker',
          ['compose', 'logs', '--no-color', '--tail', String(DOCKER_TAIL_LINES)],
          { cwd: root, maxBuffer: MAX_TOTAL_BYTES, timeout: DOCKER_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        if (Buffer.isBuffer(out) && out.length) emit('docker-compose.log', out);
      } catch (e) {
        const partial = (e as SpawnSyncReturns<Buffer>).stdout;
        if (Buffer.isBuffer(partial) && partial.length) emit('docker-compose.log', partial);
      }
    }

    return names;
  } catch {
    // Top-level guard: this hook must NEVER throw (it runs synchronously inside onParsed) and must
    // never leak log contents through an error. Any unexpected failure → captured nothing.
    return [];
  }
}
