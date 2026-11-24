// Single-instance lock. The Tower is the sole mutator of its CT_HOME (config, secrets,
// event log, spool, broker socket). A second, accidental process (double-launch, a
// supervisor restart race) that ran even part of startup — Store construction, broker
// rebind, a retention sweep, reconcile — would corrupt or delete the LIVE Tower's shared
// state before dying on EADDRINUSE. So acquire an exclusive lock BEFORE constructing
// anything that touches CT_HOME; a second process refuses to start and touches nothing.

import { openSync, writeSync, closeSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';

const LOCKFILE = join(paths.home, 'tower.lock');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire the single-instance lock or throw. Uses O_EXCL (atomic create) so two
 * simultaneous starts can't both win; a stale lock (holder pid dead) is reclaimed.
 * Returns a release function to call on shutdown.
 */
export function acquireInstanceLock(): () => void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(LOCKFILE, 'wx'); // wx = create, fail if exists (atomic)
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        // Release only if the lock is still ours (don't delete a successor's lock).
        try {
          if (existsSync(LOCKFILE) && Number(readFileSync(LOCKFILE, 'utf8').trim()) === process.pid) {
            rmSync(LOCKFILE);
          }
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder = 0;
      try {
        holder = Number(readFileSync(LOCKFILE, 'utf8').trim());
      } catch {
        /* unreadable lock — treat as stale below */
      }
      if (holder && pidAlive(holder)) {
        throw new Error(
          `another Control Tower is already running (pid ${holder}) against ${paths.home}. ` +
            `Refusing to start — a second instance would corrupt shared state.`,
        );
      }
      // Stale lock (holder dead or unreadable): reclaim it and retry.
      try {
        rmSync(LOCKFILE);
      } catch {
        /* ignore, retry */
      }
    }
  }
  throw new Error('could not acquire the Control Tower instance lock');
}
