// SPEC-RUNWAY — normalize the Claude Code statusLine JSON (forwarded by ct-usage) into a usage sample.
// PURE + defensive: the body is untrusted (arrives over the terminal-token route), so every field is
// type-checked and anything unexpected is dropped, never thrown.
//
// Live-probe facts this is built to (claude 2.1.275, a Max login):
//   - rate_limits = { five_hour:{used_percentage, resets_at}, seven_day:{...}, seven_day_opus?, ... }
//     — a per-window map; used_percentage 0..100, resets_at epoch SECONDS. Windows appear only after
//     the first API response and each may be independently absent.
//   - rate_limits_available was ABSENT (undefined) for a working subscription — so absent means
//     "available"; only an explicit `false` (API-key / Bedrock / Vertex) marks a non-subscription.

import type { UsageSampleInput } from './usage.js';

export interface ParsedStatusLine {
  windows: UsageSampleInput['windows'];
  model?: string;
  sessionId?: string;
  /** False only when the CLI explicitly says plan rate limits don't apply (exclude from the pool). */
  available: boolean;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function parseStatusLinePayload(body: unknown): ParsedStatusLine | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const available = o.rate_limits_available !== false; // absent or true ⇒ available (live-probe: absent for a max sub)
  const windows: UsageSampleInput['windows'] = {};
  const rl = o.rate_limits;
  if (available && rl && typeof rl === 'object' && !Array.isArray(rl)) {
    for (const [name, w] of Object.entries(rl as Record<string, unknown>)) {
      if (!w || typeof w !== 'object') continue;
      const used = num((w as Record<string, unknown>).used_percentage);
      const reset = num((w as Record<string, unknown>).resets_at);
      if (used !== undefined && reset !== undefined) windows[name] = { usedPct: used, resetsAt: reset };
    }
  }
  const model = o.model && typeof o.model === 'object' ? str((o.model as Record<string, unknown>).id) : undefined;
  return {
    windows,
    ...(model ? { model } : {}),
    ...(str(o.session_id) ? { sessionId: str(o.session_id) } : {}),
    available,
  };
}
