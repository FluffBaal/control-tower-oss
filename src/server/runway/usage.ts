// SPEC-RUNWAY — per-subscription usage telemetry, keyed by accountUuid, one JSON file per account
// under ~/.ct/usage (0600). Fed by the statusLine forwarder (proactive rate_limits) and the reactive
// wall hooks; read by the rotation controller and the /api/runway/status route.
//
// Keyed by accountUuid, NOT profileId: usage windows are per account/org, and two profile dirs can be
// the same subscription. The uuid becomes a filename, so it is charset-gated before any join. A
// window is dropped once its resets_at has passed (mirrors the CLI's own drop rule). ABSENT ≠ 0%: a
// never-reported (fresh/idle) account has no entry and `effective` returns undefined — callers must
// treat that as UNKNOWN, never as full headroom or as exhausted.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../paths.js';
import type { RunwayUsage, RunwayUsageWindow, RunwayWall } from '../../shared/runway.js';

/** accountUuid → filename: hex + hyphens only, bounded length. Prevents traversal (no `/`, `.`, `..`)
 *  and rejects anything a real accountUuid could not be. Gate BEFORE join. */
const UUID_RE = /^[0-9a-fA-F-]{8,64}$/;
export function isAccountUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

const windowSchema = z.object({ usedPct: z.number(), resetsAt: z.number(), observedAt: z.number() });
const wallSchema = z.object({ at: z.number(), until: z.number().optional(), source: z.enum(['hook', 'scrape']) });
// EVERY persisted field listed (M6 strip-trap). windows is a record keyed by the CLI's window name.
const usageSchema = z.object({
  windows: z.record(z.string(), windowSchema),
  wall: wallSchema.optional(),
  lastTerminalId: z.string().optional(),
  model: z.string().optional(),
  source: z.enum(['statusline', 'hook', 'scrape']).optional(),
});

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

/** A statusLine sample: the CLI's rate_limits map already normalized to {usedPct, resetsAt} per window. */
export interface UsageSampleInput {
  windows: Record<string, { usedPct: number; resetsAt: number }>;
  terminalId?: string;
  model?: string;
}

export class UsageStore {
  private byAccount = new Map<string, RunwayUsage>();

  constructor(private readonly dir: string = paths.usage) {
    mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  private fileFor(uuid: string): string {
    if (!isAccountUuid(uuid)) throw new Error(`invalid accountUuid: ${uuid}`);
    return join(this.dir, `${uuid}.json`);
  }

  private load(): void {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return; // dir absent — nothing loaded (the constructor's mkdir usually prevents this)
    }
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      const uuid = f.slice(0, -'.json'.length);
      if (!isAccountUuid(uuid)) continue; // foreign file — never trust it as an account key
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(this.dir, f), 'utf8'));
      } catch {
        continue; // torn/corrupt — skip this account, never fail the boot
      }
      const res = usageSchema.safeParse(parsed);
      if (res.success) this.byAccount.set(uuid, res.data);
    }
  }

  private persist(uuid: string): void {
    const u = this.byAccount.get(uuid);
    if (!u) return;
    writeJsonAtomic(this.fileFor(uuid), { version: 1, ...u });
  }

  /** Record a proactive statusLine sample: REPLACE the windows (the CLI reports the full current
   *  rate_limits each time), stamping observedAt, and DROP any prior wall — a fresh sample carries the
   *  account's current rate_limits, so the windows are now authoritative (see the inline note below for
   *  how this clears a reactive/scraped wall once the pane resumes post-reset). A window with a
   *  non-finite number is dropped (a bad sample must not poison the store). */
  record(uuid: string, sample: UsageSampleInput): void {
    if (!isAccountUuid(uuid)) return;
    const now = Date.now();
    const windows: Record<string, RunwayUsageWindow> = {};
    for (const [name, w] of Object.entries(sample.windows)) {
      if (!w || !Number.isFinite(w.usedPct) || !Number.isFinite(w.resetsAt)) continue;
      windows[name] = { usedPct: w.usedPct, resetsAt: w.resetsAt, observedAt: now };
    }
    const prev = this.byAccount.get(uuid);
    const next: RunwayUsage = {
      windows,
      // A fresh statusLine sample carries the account's CURRENT rate_limits, so drop any prior
      // (reactive/scraped) wall — the windows below are now authoritative. This is how a scrape wall
      // clears once autoContinueAtUsageLimit resumes the pane at reset and it reports post-reset usage
      // (a still-exhausted account simply re-reports high usedPct, so isOverThreshold stays correct).
      ...(sample.terminalId ? { lastTerminalId: sample.terminalId } : prev?.lastTerminalId ? { lastTerminalId: prev.lastTerminalId } : {}),
      ...(sample.model ? { model: sample.model } : prev?.model ? { model: prev.model } : {}),
      source: 'statusline',
    };
    this.byAccount.set(uuid, next);
    this.persist(uuid);
  }

  /** Record a reactive usage-wall (a limit-reached hook or scraped banner). */
  markWall(uuid: string, wall: Omit<RunwayWall, 'at'> & { at?: number }): void {
    if (!isAccountUuid(uuid)) return;
    const prev = this.byAccount.get(uuid) ?? { windows: {} };
    this.byAccount.set(uuid, { ...prev, wall: { at: wall.at ?? Date.now(), ...(wall.until !== undefined ? { until: wall.until } : {}), source: wall.source }, source: wall.source });
    this.persist(uuid);
  }

  /** Clear a wall (a resume signal). No-op if none set. */
  clearWall(uuid: string): void {
    const prev = this.byAccount.get(uuid);
    if (!prev?.wall) return;
    const { wall: _dropped, ...rest } = prev;
    this.byAccount.set(uuid, rest);
    this.persist(uuid);
  }

  /** Raw stored snapshot (no expiry filtering) — for the status route to show even stale numbers. */
  get(uuid: string): RunwayUsage | undefined {
    const u = this.byAccount.get(uuid);
    return u ? structuredClone(u) : undefined;
  }

  /**
   * The EFFECTIVE usage at `now` (epoch ms): windows whose resets_at (seconds) has passed are dropped
   * (the CLI drops them too), and a wall past its `until` is lifted. Returns undefined when nothing
   * live remains — the caller reads that as UNKNOWN. Pure read; does not persist the expiry.
   */
  effective(uuid: string, now: number = Date.now()): RunwayUsage | undefined {
    const u = this.byAccount.get(uuid);
    if (!u) return undefined;
    const nowSec = Math.floor(now / 1000);
    const windows: Record<string, RunwayUsageWindow> = {};
    for (const [name, w] of Object.entries(u.windows)) {
      if (w.resetsAt > nowSec) windows[name] = { ...w };
    }
    const wallLive = u.wall && (u.wall.until === undefined || u.wall.until > now);
    if (Object.keys(windows).length === 0 && !wallLive) return undefined;
    return {
      windows,
      ...(wallLive && u.wall ? { wall: { ...u.wall } } : {}),
      ...(u.lastTerminalId ? { lastTerminalId: u.lastTerminalId } : {}),
      ...(u.model ? { model: u.model } : {}),
      ...(u.source ? { source: u.source } : {}),
    };
  }
}
