// Global Control Tower settings — operator/admin-level config, persisted as JSON under
// ~/.ct/config/settings.json. Deliberately distinct from per-run/loop setup (the composer)
// and per-account settings (AssistantAccount): this is the Tower itself. v1 holds the
// test-kit concurrency cap (previously env-only CT_TEST_MAX_SLOTS).

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from './paths.js';
import type { GlobalSettings } from '../shared/types.js';

const settingsFile = join(paths.config, 'settings.json');
const SLOT_MIN = 1;
const SLOT_MAX = 64;
// SPEC-TERMINAL-OPS §3.1/§4.3 — the terminal-plane caps. New settings, so no legacy env to honor:
// an unset value is simply the default.
const TERMINALS_MIN = 1;
const TERMINALS_MAX = 128;
const TERMINALS_DEFAULT = 12;
const REAP_HOURS_MIN = 1;
const REAP_HOURS_MAX = 720;
const REAP_HOURS_DEFAULT = 24;

const SettingsSchema = z.object({
  testMaxSlots: z.number().optional(),
  // SPEC-TERMINAL-OPS §3.1/§4.3 — MUST be listed or zod strips them on load (M6).
  maxTerminals: z.number().optional(),
  terminalReapHours: z.number().optional(),
});

/** Env fallback (kept so an existing CT_TEST_MAX_SLOTS deployment keeps working), clamped
 *  to the same [1,64] range as stored values so the documented ceiling holds on every path. */
function envMaxSlots(): number {
  const n = Number(process.env.CT_TEST_MAX_SLOTS);
  return Number.isFinite(n) && n > 0 ? Math.max(SLOT_MIN, Math.min(SLOT_MAX, Math.floor(n))) : 8;
}
function clampSlots(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(SLOT_MIN, Math.min(SLOT_MAX, n)) : envMaxSlots();
}
/** Clamp helper for the settings that have NO env fallback — an unusable value falls back to the
 *  setting's own default rather than to an env var (SPEC-TERMINAL-OPS §3.1). */
function clampRange(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

export class Settings {
  private data: GlobalSettings = {};

  constructor() {
    if (!existsSync(settingsFile)) return;
    try {
      const res = SettingsSchema.safeParse(JSON.parse(readFileSync(settingsFile, 'utf8')));
      if (res.success) this.data = res.data;
      else console.error('[settings] invalid settings.json; starting from defaults');
    } catch (err) {
      console.error(`[settings] unreadable settings.json (${(err as Error).message}); defaults`);
    }
  }

  /** Raw stored settings (what the UI edits). */
  get(): GlobalSettings {
    return { ...this.data };
  }

  /** The effective test-slot ceiling: explicit setting, else env, else 8 — clamped [1,64]. */
  testMaxSlots(): number {
    return this.data.testMaxSlots !== undefined ? clampSlots(this.data.testMaxSlots) : envMaxSlots();
  }

  /** SPEC-TERMINAL-OPS §3.1 — the effective ceiling on LIVE terminals: explicit setting, else 12;
   *  clamped [1,128]. */
  maxTerminals(): number {
    return this.data.maxTerminals !== undefined
      ? clampRange(this.data.maxTerminals, TERMINALS_MIN, TERMINALS_MAX, TERMINALS_DEFAULT)
      : TERMINALS_DEFAULT;
  }

  /** SPEC-TERMINAL-OPS §4.3 — how long a mission-spawned terminal of a truly-finished mission is kept
   *  before the reaper kills its pane: explicit setting, else 24 hours; clamped [1,720]. */
  terminalReapHours(): number {
    return this.data.terminalReapHours !== undefined
      ? clampRange(this.data.terminalReapHours, REAP_HOURS_MIN, REAP_HOURS_MAX, REAP_HOURS_DEFAULT)
      : REAP_HOURS_DEFAULT;
  }

  patch(p: { testMaxSlots?: number | null; maxTerminals?: number | null; terminalReapHours?: number | null }): GlobalSettings {
    if ('testMaxSlots' in p) {
      // null / undefined resets to the env/default; a number is clamped.
      this.data.testMaxSlots = p.testMaxSlots === null || p.testMaxSlots === undefined ? undefined : clampSlots(p.testMaxSlots);
    }
    if ('maxTerminals' in p) {
      this.data.maxTerminals =
        p.maxTerminals === null || p.maxTerminals === undefined
          ? undefined
          : clampRange(p.maxTerminals, TERMINALS_MIN, TERMINALS_MAX, TERMINALS_DEFAULT);
    }
    if ('terminalReapHours' in p) {
      this.data.terminalReapHours =
        p.terminalReapHours === null || p.terminalReapHours === undefined
          ? undefined
          : clampRange(p.terminalReapHours, REAP_HOURS_MIN, REAP_HOURS_MAX, REAP_HOURS_DEFAULT);
    }
    this.persist();
    return this.get();
  }

  private persist(): void {
    const tmp = `${settingsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, settingsFile);
  }
}
