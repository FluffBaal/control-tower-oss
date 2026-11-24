// The hook pipeline plumbing (SPEC §16, Sys-C2): a generic forwarder script that
// agent CLIs invoke on lifecycle events, per-terminal capability tokens so an event
// can only be reported for its own terminal, and a disk spool so events survive the
// Tower being down (drained on startup + on a timer).

import { writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, rmSync, renameSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './paths.js';
import { token as makeToken } from './ids.js';
import type { Terminal } from '../shared/types.js';

export const BIN_DIR = join(paths.home, 'bin');
export const HOOK_SCRIPT = join(BIN_DIR, 'ct-hook');
export const USAGE_SCRIPT = join(BIN_DIR, 'ct-usage');
export const TOWERCTL_SCRIPT = join(BIN_DIR, 'towerctl');

/**
 * Write the ct-hook forwarder. It reports only the canonical signal (arg) plus a
 * nanosecond emit timestamp and the terminal id — all safe tokens, so no shell JSON
 * escaping is needed. Rich context (the requested command, message) is read
 * server-side via capture-pane, not trusted from the hook body.
 */
export function ensureHookScript(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  const script = `#!/usr/bin/env bash
# Control Tower hook forwarder (generated). Invoked as: ct-hook <signal>
set +e
SIGNAL="\${1:-unknown}"
TID="\${TOWER_TERMINAL_ID:-}"
PORT="\${TOWER_PORT:-4870}"
TOKEN="$(cat "\${TOWER_HOOK_TOKEN_FILE}" 2>/dev/null)"
EMIT="$(date +%s%N 2>/dev/null || echo 0)"
cat >/dev/null 2>&1   # drain the CLI's event JSON on stdin so it isn't blocked
PAYLOAD=$(printf '{"terminalId":"%s","signal":"%s","emitTs":"%s"}' "\$TID" "\$SIGNAL" "\$EMIT")
# SPEC-LOOPWEDGE F5 — -f (--fail) makes curl exit non-zero on an HTTP 4xx/5xx (a lost Stop hook: a
# 401 while a token file is not yet readable, or a 5xx). Without it curl exits 0 on an HTTP error and
# the event is LOST without ever spooling; with it the || fallback below spools it for the drain.
curl -sf --max-time 2 -o /dev/null \\
  -X POST "http://127.0.0.1:\${PORT}/api/events" \\
  -H "Content-Type: application/json" \\
  -H "Origin: http://127.0.0.1:\${PORT}" \\
  -H "X-Tower-Terminal-Token: \${TOKEN}" \\
  --data "\$PAYLOAD" || {
    SP="\${TOWER_SPOOL_DIR:-${paths.spool}}/\${TID}"
    mkdir -p "\$SP" 2>/dev/null
    # Atomic spool write: write a .tmp (which the drain's *.json filter ignores) then
    # rename it into place, so a concurrent drain can never read a torn file. The \$\$ PID
    # in both names makes them unique even if two hooks share a nanosecond EMIT (also
    # fixes the old EMIT=0 collision where every fallback event was named 0.json).
    TMP="\${SP}/.\${EMIT}.\$\$.tmp"
    if printf '%s' "\$PAYLOAD" > "\$TMP" 2>/dev/null; then
      mv -f "\$TMP" "\${SP}/\${EMIT}.\$\$.json" 2>/dev/null || rm -f "\$TMP" 2>/dev/null
    else
      rm -f "\$TMP" 2>/dev/null
    fi
  }
exit 0
`;
  writeFileSync(HOOK_SCRIPT, script, 'utf8');
  chmodSync(HOOK_SCRIPT, 0o755);
}

/**
 * SPEC-RUNWAY — write the ct-usage statusLine forwarder. Claude Code runs a `statusLine` command on a
 * timer/events, piping a rich JSON (incl. rate_limits) on stdin. This forwards that JSON VERBATIM
 * (bounded — jq is not assumed installed, so the server parses) to /api/agent/usage under the pane's
 * own terminal token, then prints an EMPTY line (the status row costs at most one transcript row).
 * Deliberately UNLIKE ct-hook: NO spool fallback — a dropped 60-second usage sample is refreshed on
 * the next tick, so losing one is fine and a spool would just accumulate stale numbers. Never blocks
 * the pane: bounded read, 2s curl timeout, always exit 0.
 */
export function ensureUsageScript(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  const script = `#!/usr/bin/env bash
# Control Tower usage forwarder (generated). Invoked by Claude Code's statusLine with JSON on stdin.
set +e
PORT="\${TOWER_PORT:-4870}"
TOKEN="$(cat "\${TOWER_HOOK_TOKEN_FILE}" 2>/dev/null)"
BODY="$(head -c 65536)"   # bounded raw statusLine JSON on stdin (server-side parse; jq not assumed)
curl -sf --max-time 2 -o /dev/null \\
  -X POST "http://127.0.0.1:\${PORT}/api/agent/usage" \\
  -H "Content-Type: application/json" \\
  -H "Origin: http://127.0.0.1:\${PORT}" \\
  -H "X-Tower-Terminal-Token: \${TOKEN}" \\
  --data-binary "\$BODY" 2>/dev/null
printf ''   # empty status line — one blank row at most, never the footer's keyboard hints
exit 0
`;
  writeFileSync(USAGE_SCRIPT, script, 'utf8');
  chmodSync(USAGE_SCRIPT, 0o755);
}

/**
 * Render the `towerctl` launcher body. Split out as a pure function so the dev/prod
 * resolution is table-testable. `moduleFile` is the server module's own path (a `.ts`
 * URL under tsx, a `.js` under a built dist), which decides which CLI tree to exec:
 *   - dist build → `node <repoRoot>/dist/cli/towerctl.js`
 *   - tsx / source → `node <repoRoot>/node_modules/.bin/tsx <repoRoot>/src/cli/towerctl.ts`
 * The interpreter is the absolute `execPath` (usually process.execPath) so the wrapper
 * does not depend on `node` being on the pane's PATH, and dist's missing shebang stops
 * mattering — this wrapper is the shebanged entry. Every interpolated path is quoted
 * (Tower-controlled paths; the quoting guards spaces, not injection).
 */
export function renderTowerctlLauncher(moduleFile: string, execPath: string): string {
  const repoRoot = join(dirname(moduleFile), '..', '..');
  const dev = moduleFile.endsWith('.ts'); // tsx serves .ts module URLs; a dist build serves .js
  const line = dev
    ? `exec "${execPath}" "${join(repoRoot, 'node_modules', '.bin', 'tsx')}" "${join(repoRoot, 'src', 'cli', 'towerctl.ts')}" "$@"`
    : `exec "${execPath}" "${join(repoRoot, 'dist', 'cli', 'towerctl.js')}" "$@"`;
  return `#!/bin/sh\n${line}\n`;
}

/**
 * Write the `towerctl` launcher into ~/.ct/bin, mirroring ensureHookScript: rewritten on
 * every boot (0755) so a dev↔prod switch or a moved repo self-heals on restart, always
 * pointing at the tree that is actually serving the API.
 */
export function ensureTowerctlLauncher(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  const script = renderTowerctlLauncher(fileURLToPath(import.meta.url), process.execPath);
  writeFileSync(TOWERCTL_SCRIPT, script, 'utf8');
  chmodSync(TOWERCTL_SCRIPT, 0o755);
}

/**
 * Prepend ~/.ct/bin to the Tower process's own PATH, once (idempotent — segment match, not
 * substring, so a decoy like `…/binx` never counts as present). This is the mechanism that
 * actually reaches agent panes: tmux force-sets a spawned pane's PATH from the client
 * environment, so a per-terminal `-e PATH=` never lands, but every tmux client and per-terminal
 * server the Tower spawns inherits this process PATH. It also fixes daemon-side checks
 * (loops.runCheck spreads process.env), which otherwise could not resolve `towerctl`.
 */
export function ensureBinOnPath(): void {
  const parts = (process.env.PATH ?? '').split(':').filter(Boolean);
  if (!parts.includes(BIN_DIR)) process.env.PATH = [BIN_DIR, ...parts].join(':');
}

/** Per-terminal capability tokens. Files live 0600 under secrets/. */
export class HookTokens {
  private byToken = new Map<string, string>(); // token -> terminalId

  private fileFor(terminalId: string): string {
    return join(paths.secrets, `hooktok-${terminalId}`);
  }

  tokenFile(terminalId: string): string {
    return this.fileFor(terminalId);
  }

  /** Rebuild the index from persisted terminals on startup. */
  load(terminals: Terminal[]): void {
    for (const t of terminals) {
      if (t.hookToken && t.state !== 'killed') this.byToken.set(t.hookToken, t.id);
    }
  }

  /** Mint (or reuse) a terminal's token and write its 0600 file. */
  ensure(terminal: Terminal): string {
    if (terminal.hookToken && existsSync(this.fileFor(terminal.id))) {
      this.byToken.set(terminal.hookToken, terminal.id);
      return terminal.hookToken;
    }
    const tok = terminal.hookToken ?? makeToken();
    writeFileSync(this.fileFor(terminal.id), tok, { mode: 0o600 });
    this.byToken.set(tok, terminal.id);
    return tok;
  }

  resolve(token: string): string | undefined {
    return this.byToken.get(token);
  }

  forget(terminalId: string, token?: string): void {
    if (token) this.byToken.delete(token);
    try {
      // Remove the file entirely (not just empty it) so vanished terminals don't leak
      // 0600 token files under ~/.ct/secrets across repeated restarts/teardowns.
      if (existsSync(this.fileFor(terminalId))) rmSync(this.fileFor(terminalId));
    } catch {
      /* ignore */
    }
  }
}

export interface SpooledEvent {
  terminalId: string;
  signal: string;
  emitTs: string;
}

/**
 * SPEC-LOOPWEDGE F5 — the JS twin of ct-hook's bash spool fallback: persist ONE event to disk so an
 * in-process failure AFTER the /api/events 202 ack (mission.ingestSignal throwing) is retried by the
 * drain instead of being lost. Atomic like the bash: write a `.tmp` (which the drain's `*.json` filter
 * ignores) then rename it into place, so a concurrent drain never reads a torn file. The filename
 * leads with emitTs (then pid + a random suffix for uniqueness) so drainSpool's per-terminal name sort
 * preserves emit order across both writers. Best-effort — a spool-write failure is logged, never
 * thrown (the caller is already handling an error).
 */
/**
 * SPEC-LOOPWEDGE F5 — is `emitTs` a real, orderable hook stamp? ct-hook stamps `date +%s%N`
 * (nanoseconds), which ingest's monotonic guard uses to reject a stale/duplicate replay. A
 * missing/'0'/non-numeric value is UN-ordered: replaying such an event past ingest's guard could
 * re-idle a pane that legitimately re-worked before the drain (a real-idle that bypasses the loop
 * gate). Only a genuine hook carries a real stamp, so an un-ordered event is safe to refuse.
 */
export function isOrderedEmitTs(emitTs: string | undefined): emitTs is string {
  return typeof emitTs === 'string' && /^\d+$/.test(emitTs) && emitTs !== '0';
}

export function spoolEvent(ev: SpooledEvent): void {
  try {
    const dir = join(paths.spool, ev.terminalId);
    mkdirSync(dir, { recursive: true });
    const base = `${ev.emitTs && /^\d+$/.test(ev.emitTs) ? ev.emitTs : '0'}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const tmp = join(dir, `.${base}.tmp`);
    const dst = join(dir, `${base}.json`);
    writeFileSync(tmp, JSON.stringify(ev), 'utf8');
    try {
      renameSync(tmp, dst);
    } catch (err) {
      try { rmSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  } catch (err) {
    console.error(`[spool] failed to respool event for ${ev.terminalId}:`, err);
  }
}

/** Read a spool file safely. */
function parseSpooled(raw: string): SpooledEvent | null {
  try {
    const o = JSON.parse(raw);
    if (typeof o.terminalId === 'string' && typeof o.signal === 'string') return o as SpooledEvent;
  } catch {
    /* corrupt */
  }
  return null;
}

/** A genuinely corrupt spool file (or abandoned .tmp) older than this is deleted; a
 *  younger unparseable one is left alone — it may be a legacy hook still mid-write. */
const SPOOL_CORRUPT_GRACE_MS = 60_000;

let draining = false;

/**
 * Drain the spool in per-terminal emit order. Durability contract:
 *  - `apply` RESOLVING (either boolean) = event consumed → delete the file. ingest
 *    returning false (stale emitTs / unknown terminal / bad signal) is a judged no-op,
 *    i.e. consumed — keeping it would wedge the queue forever.
 *  - `apply` THROWING = not applied (real I/O failure) → keep the file for the next
 *    drain, and STOP processing that terminal's remaining files. Applying newer events
 *    first would make this older one permanently stale to ingest's ordering guard, i.e.
 *    silently dropped. break-not-continue preserves per-terminal order.
 *  - unparseable file → skip (retry) if young (possible mid-write), delete if past the
 *    grace (genuinely corrupt) so it can't wedge the queue forever.
 * Re-entrancy guarded so an overlapping timer drain can't double-apply / double-delete.
 */
export async function drainSpool(apply: (ev: SpooledEvent) => Promise<void>): Promise<number> {
  if (draining) return 0;
  draining = true;
  try {
    let n = 0;
    let termDirs: string[] = [];
    try {
      termDirs = await readdir(paths.spool);
    } catch {
      return 0;
    }
    for (const termId of termDirs) {
      const dir = join(paths.spool, termId);
      let names: string[] = [];
      try {
        names = (await readdir(dir)).sort();
      } catch {
        continue;
      }
      for (const f of names) {
        const p = join(dir, f);
        if (!f.endsWith('.json')) {
          if (f.endsWith('.tmp')) await rmIfOlderThan(p, SPOOL_CORRUPT_GRACE_MS); // abandoned temp
          continue;
        }
        let raw: string;
        try {
          raw = await readFile(p, 'utf8');
        } catch {
          // Unreadable. Could be a transient hiccup (retry) OR permanent (e.g. under
          // per-agent-uid isolation the file is 0600-owned by ct-agent-N and the Tower's
          // uid can't read it) — a permanent one would wedge this terminal's queue forever
          // on `break`. So age it out: skip past it once it's older than the grace window,
          // same escape hatch the parse-failure path uses.
          if (await rmIfOlderThan(p, SPOOL_CORRUPT_GRACE_MS)) continue;
          break; // young — retry this terminal next drain, in order
        }
        const ev = parseSpooled(raw);
        if (!ev) {
          if (await rmIfOlderThan(p, SPOOL_CORRUPT_GRACE_MS)) continue; // corrupt & aged out
          break; // young — possibly mid-write; keep order, retry next drain
        }
        try {
          await apply(ev);
        } catch (err) {
          console.error(`[spool] apply failed for ${p}; keeping file:`, err);
          break; // later events must not jump the queue (ordering-guard drop)
        }
        await rm(p, { force: true }).catch(() => {});
        n++;
      }
    }
    return n;
  } finally {
    draining = false;
  }
}

/**
 * rm `p` iff its mtime is older than `ms`. Returns true when the caller may move past
 * this file (removed, or it's genuinely gone). Returns FALSE on a transient stat failure
 * (not ENOENT) so the caller `break`s and retries next drain, preserving per-terminal
 * order — treating a transient stat error as "vanished" would let the drain skip past an
 * older event to a newer one, permanently dropping the older one via the ordering guard.
 */
async function rmIfOlderThan(p: string, ms: number): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(p)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true; // genuinely gone
    return false; // transient (EMFILE/EACCES on stat) — retry in order, don't skip past
  }
  if (Date.now() - mtimeMs < ms) return false; // too young to age out
  await rm(p, { force: true }).catch(() => {});
  return true;
}

export function readTokenFile(terminalId: string): string | null {
  const f = join(paths.secrets, `hooktok-${terminalId}`);
  try {
    return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
  } catch {
    return null;
  }
}
