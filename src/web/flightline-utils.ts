// SPEC-FLIGHTLINE-V2 — pure helpers for the additive Flightline polish. NO JSX and NO DOM/react imports,
// so every testable calculation loads standalone under `npx tsx` for runtime tests. tsconfig.web.json's
// `src/web/**/*.ts` include picks this up; App.tsx imports it via the `.js` specifier.

/** A DOMRect-compatible subset — the four fields wirePath needs. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * SPEC-FLIGHTLINE-V2 §1 — a single cubic bezier from one strip's geometric center to the other's, bowing
 * RIGHTWARD (both control points offset by +bow on x). bow scales with the gap (mostly the vertical one)
 * and is clamped to a pleasant range; every coordinate is rounded to 1 decimal to keep the `d` string tidy.
 */
export function wirePath(from: Rect, to: Rect): string {
  const x1 = from.left + from.width / 2;
  const y1 = from.top + from.height / 2;
  const x2 = to.left + to.width / 2;
  const y2 = to.top + to.height / 2;
  const bow = clamp(Math.abs(y2 - y1) * 0.4 + Math.abs(x2 - x1) * 0.1, 28, 160);
  return `M ${round1(x1)} ${round1(y1)} C ${round1(x1 + bow)} ${round1(y1)}, ${round1(x2 + bow)} ${round1(y2)}, ${round1(x2)} ${round1(y2)}`;
}

/**
 * SPEC-FLIGHTLINE-V2 §3 — append `v` to a ring buffer and keep only the last `cap` samples. Returns a NEW
 * array (never mutates the input) so React state updates stay referentially honest.
 */
export function pushSample(buf: readonly number[], v: number, cap: number): number[] {
  return [...buf, v].slice(-cap);
}

/**
 * SPEC-FLIGHTLINE-V2 §3 — map a sample buffer to canvas points inside a `w`×`h` box with 2px padding.
 * Returns [] below 2 samples (the caller draws nothing). y is inverted (max value near the top); the
 * Math.max(1, …) floor keeps an all-zero buffer finite (no divide-by-zero).
 */
export function sparkPoints(buf: readonly number[], w: number, h: number): [number, number][] {
  if (buf.length < 2) return [];
  const pad = 2;
  const max = Math.max(1, ...buf);
  const span = buf.length - 1;
  return buf.map((v, i) => {
    const x = pad + (i * (w - 2 * pad)) / span;
    const y = h - pad - (v / max) * (h - 2 * pad);
    return [x, y];
  });
}

/** SPEC-FLIGHTLINE-V2 §4 — a memory file is "fresh" when its mtime is within the last 10 minutes. */
export function isMemFresh(mtimeMs: number, nowMs: number): boolean {
  return nowMs - mtimeMs < 600_000;
}

/**
 * SPEC-FLIGHTLINE-V2 §4 — a coarse, floored age suffix (a 4-bucket s/m/h/d humanizer, kept by
 * design so a 30-minute-old file reads "30m", never "0h"). Negative ages (clock skew) clamp to 0.
 * Now the single shared "time-ago" humanizer across the web app — timeAgo (below) is a thin ISO adapter.
 */
export function memAge(mtimeMs: number, nowMs: number): string {
  const s = Math.floor(Math.max(0, nowMs - mtimeMs) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * ISO-string adapter over memAge: humanize the age of an ISO timestamp. Empty/absent or unparsable
 * inputs return '' (render nothing) rather than 'NaN…'. nowMs defaults to Date.now() so callers pass
 * only the timestamp; pass nowMs explicitly for deterministic tests.
 */
export function timeAgo(iso?: string, nowMs: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return memAge(t, nowMs);
}

/**
 * Extract a short "owner/repo" label from a per-project GitHub repo URL, for the Flightline sector head
 * link. Strips a trailing '.git' and/or trailing slash. Returns '' for an absent or unparseable input
 * (the caller then renders no link). Pure — no DOM, so it runs under the runtime tests.
 */
export function repoShortName(url?: string): string {
  if (!url) return '';
  const m = /^https:\/\/[^/]+\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : '';
}

/**
 * SPEC-FLIGHTLINE-V2 §5 — count the loops of one project whose `landedAt` falls on `now`'s LOCAL calendar
 * day. Delegates to landedTodayByProject so the local-day + archived-counts semantics live in ONE place
 * (the UI renders the map; this per-project accessor is exercised by the runtime tests — they must not
 * drift). Kept exported for that per-project test.
 */
export function landedTodayCount(
  loops: ReadonlyArray<{ projectId: string; landedAt?: string }>,
  projectId: string,
  now: Date,
): number {
  return landedTodayByProject(loops, now).get(projectId) ?? 0;
}

/**
 * SPEC-FLIGHTLINE-V2 §5 — landed-today counts for EVERY project in ONE pass over the loops (same LOCAL-day
 * + archived semantics as landedTodayCount). The Flightline memoizes this on [loops] so it is not recomputed
 * on the 1Hz clock render; landedTodayCount stays exported for the per-project runtime test.
 */
export function landedTodayByProject(
  loops: ReadonlyArray<{ projectId: string; landedAt?: string }>,
  now: Date,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of loops) {
    if (!l.landedAt) continue;
    const d = new Date(l.landedAt);
    if (Number.isNaN(d.getTime())) continue;
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      out.set(l.projectId, (out.get(l.projectId) ?? 0) + 1);
    }
  }
  return out;
}
