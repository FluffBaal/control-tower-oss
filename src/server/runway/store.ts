// SPEC-RUNWAY — the rotation CONFIG store: the master switch, the global >96% threshold, and the
// ordered pool of claude-code profiles to rotate across. A leaf modeled on SkillSelectionStore
// (../skills/selection.ts): a v-envelope, foreign/future-version refusal + .bak, atomic 0600 writes,
// PUT-replace mutation semantics, and a reference-hygiene pruneProfile field-strip. Salvage on load is
// HAND-ROLLED per field (clampThreshold + sanitizePool), NOT a single zod parse — this file imports no
// zod; see the load-discipline note below for why, and add any new field to those sanitizers. Owns
// ~/.ct/config/runway.json and imports nothing from terminal/loop/mission code, so those may compose it
// freely.
//
// The pool stores PROFILE ids; the on-disk subscription identity (accountUuid) is grouped at read
// time (identity.ts) — two pooled profiles that resolve to one subscription are one rotation slot.

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { paths } from '../paths.js';
import { isSafeName } from '../ids.js';
import type { RunwayConfig, RunwayPoolEntry } from '../../shared/runway.js';

export const DEFAULT_THRESHOLD_PCT = 96;
const MIN_THRESHOLD_PCT = 1;
const MAX_THRESHOLD_PCT = 100;
const MAX_POOL = 32;

// Load reads each field DEFENSIVELY rather than through one atomic zod parse: the pool is salvaged
// per-entry by sanitizePool (a single bad entry must not drop the whole config to defaults, the
// SkillSelectionStore per-entry-salvage discipline). sanitizePool reads each entry's thresholdPct
// explicitly, so there is no zod strip-trap surface here — nothing is silently dropped on load.

/** Atomic write (temp + rename), 0600 — Tower-owned config. Passes the mode EXPLICITLY: unlike
 *  SkillSelectionStore.persist (which omits it), Runway config names which subscriptions exist and
 *  must never be group/world-readable. */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

function clampThreshold(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_THRESHOLD_PCT;
  return Math.min(MAX_THRESHOLD_PCT, Math.max(MIN_THRESHOLD_PCT, Math.round(n)));
}

/** Sanitize the pool: keep only isSafeName profile ids, dedupe (order-preserving — first wins), clamp
 *  each per-entry threshold, cap the length. Clamp/drop, never throw — one bad entry must not reject a
 *  whole PUT (the sanitizeSkillIds posture). A duplicated id can't create two rotation slots. */
function sanitizePool(v: unknown): RunwayPoolEntry[] {
  if (!Array.isArray(v)) return [];
  const out: RunwayPoolEntry[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const pidRaw = (raw as { profileId?: unknown }).profileId;
    if (typeof pidRaw !== 'string') continue;
    const pid = pidRaw.trim();
    if (!isSafeName(pid) || seen.has(pid)) continue;
    seen.add(pid);
    const t = (raw as { thresholdPct?: unknown }).thresholdPct;
    const entry: RunwayPoolEntry = { profileId: pid };
    if (t !== undefined && t !== null) entry.thresholdPct = clampThreshold(t);
    out.push(entry);
    if (out.length >= MAX_POOL) break;
  }
  return out;
}

// Both `enabled` and `liveSwap` default ON for claude-code: rotation (via a live in-place credential
// swap) is active for any POOLED account. The pool is empty by default, so a default-config fleet still
// never rotates until the operator pools an account (the per-account slider) -- that is the one control.
const EMPTY: RunwayConfig = { enabled: true, liveSwap: true, thresholdPct: DEFAULT_THRESHOLD_PCT, pool: [] };

/**
 * Persists the Runway config in ~/.ct/config/runway.json v1. Loaded with zod salvage; a
 * foreign/future-versioned file is backed up to .bak and NEVER written over (the SkillSelectionStore
 * discipline) — the config stays at defaults in memory until the next real mutation persists it. The
 * get/set/pruneProfile methods ARE the config API; the integrator registers thin routes over them.
 */
export class RunwayStore {
  private config: RunwayConfig = { ...EMPTY, pool: [] };
  private hooks: { onChange?: () => void } = {};

  constructor(private readonly file: string = paths.runway) {
    this.load();
  }

  /** onChange fires on every successful mutation — the integrator forwards it as a `{t:'runway'}` SSE
   *  frame so an open Runway tab refetches (the routing/skills setHooks precedent). */
  setHooks(hooks: { onChange?: () => void }): void {
    this.hooks = hooks;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      console.error(`[runway] cannot read ${this.file}: ${(err as Error).message}`);
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`[runway] ${this.file} is not an object — ignoring it`);
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version === 1) {
      // Normalize every field through the same sanitizers a write uses, so a hand-edited file can't
      // seat an out-of-range threshold or a duplicate/unsafe pool id in memory; a malformed enabled/
      // threshold falls back safely, and one bad pool entry is dropped, never the whole config.
      this.config = {
        enabled: obj.enabled !== false, // default ON; only an explicit false (operator opt-out) disables it
        liveSwap: obj.liveSwap !== false,
        thresholdPct: clampThreshold(obj.thresholdPct),
        pool: sanitizePool(obj.pool),
      };
      return;
    }
    // A versioned/shaped file we don't understand (corrupt, downgraded, or FUTURE): back it up, keep
    // defaults in memory, do NOT persist over it.
    if ('version' in obj || 'enabled' in obj || 'pool' in obj) {
      try {
        copyFileSync(this.file, `${this.file}.bak`);
      } catch (err) {
        console.error(`[runway] could not back up ${this.file}: ${(err as Error).message}`);
      }
      console.error(
        `[runway] ${this.file} looks corrupt or foreign-versioned — keeping defaults and NOT persisting over it (saved to ${this.file}.bak)`,
      );
      return;
    }
    console.error(`[runway] ${this.file} has no recognized keys — ignoring it`);
  }

  private persist(): void {
    writeJsonAtomic(this.file, { version: 1, ...this.config });
    try {
      this.hooks.onChange?.();
    } catch (err) {
      console.error('[runway] onChange hook failed:', err);
    }
  }

  /** A defensive copy — callers must never mutate the store's internal config. */
  get(): RunwayConfig {
    // liveSwap now defaults true, so it is ALWAYS surfaced (omit-when-false no longer keeps the wire
    // shape constant).
    return {
      enabled: this.config.enabled,
      liveSwap: this.config.liveSwap !== false,
      thresholdPct: this.config.thresholdPct,
      pool: this.config.pool.map((e) => ({ ...e })),
    };
  }

  /**
   * REPLACE the whole config (PUT semantics). Every field is sanitized: enabled coerced to a real
   * boolean, thresholdPct clamped to [1,100] (default 96 when absent/NaN), pool sanitized+deduped+
   * capped. An omitted field resets to its default (this is a replace, not a patch). Never throws on
   * a bad value — it clamps/drops — so route-level strictness (rejecting a non-number threshold) is
   * the route's job; the store fails safe.
   */
  set(input: { enabled?: unknown; liveSwap?: unknown; thresholdPct?: unknown; pool?: unknown }): RunwayConfig {
    this.config = {
      enabled: input.enabled === true,
      liveSwap: input.liveSwap !== false, // omitted → default ON (matches load)
      thresholdPct: clampThreshold(input.thresholdPct),
      pool: sanitizePool(input.pool),
    };
    this.persist();
    return this.get();
  }

  /**
   * Add a profile to the END of the rotation pool (the live-swap slider ON). Idempotent: already
   * pooled -> no change, no persist. Honors the pool cap. Returns whether anything changed.
   */
  addToPool(profileId: string): boolean {
    if (!isSafeName(profileId) || this.config.pool.some((e) => e.profileId === profileId)) return false;
    if (this.config.pool.length >= MAX_POOL) return false;
    this.config = { ...this.config, pool: [...this.config.pool, { profileId }] };
    this.persist();
    return true;
  }

  /** Drop a profile from the pool (the live-swap slider OFF). Persists iff changed. */
  removeFromPool(profileId: string): boolean {
    return this.pruneProfile(profileId);
  }

  /**
   * Strip a deleted profile from the pool (the pruneProfile field-strip mirror). Called after a
   * profile delete so a dead account can't remain a rotation slot. Persists iff changed; returns
   * whether anything changed (false = not pooled, an idempotent no-op).
   */
  pruneProfile(profileId: string): boolean {
    const next = this.config.pool.filter((e) => e.profileId !== profileId);
    if (next.length === this.config.pool.length) return false;
    this.config = { ...this.config, pool: next };
    this.persist();
    return true;
  }
}
