// SPEC-RUNWAY live swap -- a proper-lockfile-compatible DIRECTORY lock that coordinates with Claude
// Code's own OAuth locks. Claude serializes its token refresh with `proper-lockfile`: a mkdir-based dir
// lock whose staleness is judged by the lock dir's mtime. A live credential swap rewrites the very file
// a running claude may be refreshing at any instant, so it must hold the SAME locks claude takes. All four
// were OBSERVED via strace of a REAL forced refresh (claude 2.1.295, 2026-10-16):
//   1. `<configDir>/.oauth_refresh.lock`        (claude's named OAuth refresh lock)
//   2. `<realpath(configDir)>.lock`             (proper-lockfile's default lock for the config dir)
//   3. `<configDir>/.claude.json.lock`          (the state-file write lock)
//   4. `<configDir>/.storage-write.lock`        (held while claude writes .credentials.json on refresh -- the
//                                                one most directly racing the swap's own credential write)
// Acquired in that order, ALL-OR-NOTHING (a failed later lock releases the earlier ones), released in reverse
// order in a finally. While held, an mtime heartbeat keeps the dirs fresh for an ASYNC critical section; a
// SYNCHRONOUS one (the live-swap today) completes well within staleMs on the acquisition-time mtime, so the
// heartbeat is belt-and-suspenders there.
// Pure fs -- no claude dependency, fully testable on tmp dirs.

import { mkdirSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

/** Claude's REFRESH_LOCK_STALE_MS: a lock whose mtime is older than this is presumed abandoned. */
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REFRESH_MS = 5_000;

export class ClaudeLockBusyError extends Error {
  readonly code = 'ELOCKED';
  constructor(lockPath: string) {
    super(`claude oauth lock busy: ${lockPath}`);
    this.name = 'ClaudeLockBusyError';
  }
}

export interface ClaudeLockOpts {
  staleMs?: number;
  timeoutMs?: number;
  refreshMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Take ONE dir lock: mkdir; on EEXIST, steal it if its mtime is stale, else wait (jittered) until the
 *  deadline and then throw ClaudeLockBusyError. */
async function acquireOne(path: string, staleMs: number, deadline: number): Promise<void> {
  for (;;) {
    try {
      mkdirSync(path);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let stale = false;
    try {
      stale = Date.now() - statSync(path).mtimeMs > staleMs;
    } catch {
      // Usually the dir was released between mkdir and stat (the next mkdir wins) -- but a PERSISTENT
      // stat failure (EACCES/EPERM) must not spin the event loop: honor the deadline and back off.
      if (Date.now() >= deadline) throw new ClaudeLockBusyError(path);
      await sleep(50 + Math.floor(Math.random() * 100));
      continue;
    }
    if (stale) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new ClaudeLockBusyError(path);
    await sleep(100 + Math.floor(Math.random() * 150));
  }
}

/**
 * Run `fn` while holding both Claude OAuth locks on `configDir`. Returns fn's result; throws
 * ClaudeLockBusyError (code 'ELOCKED') when the locks cannot be taken within `timeoutMs`. The locks are
 * always released, including when fn throws.
 */
export async function withClaudeOauthLocks<T>(
  configDir: string,
  fn: () => T | Promise<T>,
  opts: ClaudeLockOpts = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  mkdirSync(configDir, { recursive: true });
  let real = configDir;
  try {
    real = realpathSync(configDir);
  } catch {
    /* fall back to the given path */
  }
  const lockPaths = [
    join(configDir, '.oauth_refresh.lock'), // claude's named OAuth refresh lock (OBSERVED in a real refresh)
    `${real}.lock`, // proper-lockfile default for the config dir (OBSERVED in a real refresh)
    join(configDir, '.claude.json.lock'), // the state-file write lock (OBSERVED)
    join(configDir, '.storage-write.lock'), // held while claude writes .credentials.json on refresh (OBSERVED 2026-10-16)
  ];
  const deadline = Date.now() + timeoutMs;
  const held: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    for (const p of lockPaths) {
      await acquireOne(p, staleMs, deadline);
      held.push(p);
    }
    timer = setInterval(() => {
      const t = new Date();
      for (const p of held) {
        try {
          utimesSync(p, t, t);
        } catch {
          /* best-effort heartbeat */
        }
      }
    }, refreshMs);
    timer.unref?.();
    return await fn();
  } finally {
    if (timer) clearInterval(timer);
    for (const p of [...held].reverse()) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // Best-effort: a lock we cannot remove keeps its (now un-bumped) mtime and self-heals once a
        // peer judges it stale after staleMs. Never let a release failure mask fn's result or error.
      }
    }
  }
}
