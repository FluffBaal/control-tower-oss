// Runway — usage-aware claude-code SUBSCRIPTION rotation. Shared types (web + server both import).
//
// A "subscription" is identified by its accountUuid (from a config dir's .claude.json oauthAccount),
// NOT by profile: two profile dirs can hold the same account, and rotating between them would hit the
// same usage limit. The rotation POOL stores profile ids (the on-disk identity is grouped by
// accountUuid at read time); `pool` order is the rotation order.
//
// Usage numbers come ONLY from the vendor CLI's statusLine JSON (rate_limits) — never by reading the
// OAuth token or calling an Anthropic endpoint (the codebase's vendor-binary-only posture). A window
// is ABSENT until the account makes its first API response, so "no sample" means UNKNOWN, never 0%.

/** One rotation-pool member: a claude-code profile id, with an optional per-subscription threshold. */
export interface RunwayPoolEntry {
  profileId: string;
  /** Per-entry override of the global threshold (percent, 1..100); omitted ⇒ use RunwayConfig.thresholdPct. */
  thresholdPct?: number;
}

/** The operator-editable Runway configuration (the API shape; the store wraps it in a versioned envelope). */
export interface RunwayConfig {
  /** Master switch. When false, Runway writes no statusLine and never rotates. Defaults ON. */
  enabled: boolean;
  /** When true AND enabled, Runway rotates a pooled claude-code account by a live in-place credential
   *  swap instead of a respawn. Defaults ON for claude-code. */
  liveSwap?: boolean;
  /** Global rotate-at threshold as a percent of any usage window (default 96). */
  thresholdPct: number;
  /** The rotation pool, in rotation ORDER (deduped by profileId). */
  pool: RunwayPoolEntry[];
}

/** One usage window as reported by the CLI statusLine (rate_limits.<window>). */
export interface RunwayUsageWindow {
  /** Percent of the window consumed, 0..100 (the CLI's used_percentage). */
  usedPct: number;
  /** When the window resets — epoch SECONDS (the CLI's resets_at). */
  resetsAt: number;
  /** When the Tower recorded this sample — epoch MS. */
  observedAt: number;
}

/** A reactive usage-wall signal (a limit-reached hook or a scraped banner), distinct from a proactive window. */
export interface RunwayWall {
  /** When the wall was observed — epoch MS. */
  at: number;
  /** Best-known reset time — epoch MS — after which the wall should be treated as lifted. */
  until?: number;
  source: 'hook' | 'scrape';
}

/** One subscription in the Runway status view — a group of profiles sharing an accountUuid. */
export interface RunwayStatusSubscription {
  accountUuid: string;
  email?: string;
  orgName?: string;
  /** The profiles that resolve to this subscription (a subscription can back several). */
  profiles: { id: string; label: string; signedIn: boolean }[];
  /** True when any of its profiles is in the rotation pool. */
  pooled: boolean;
  /** Rotation position (the smallest pool index among its pooled profiles); undefined when unpooled. */
  order?: number;
  /** The threshold that applies to this subscription (a pooled per-entry override, else the global). */
  thresholdPct: number;
  /** EFFECTIVE usage windows (expired dropped); empty ⇒ UNKNOWN, never 0%. */
  windows: Record<string, RunwayUsageWindow>;
  wall?: RunwayWall;
  lastTerminalId?: string;
  model?: string;
}

/** The GET /api/runway/status payload — the Runway tab's live view. */
export interface RunwayStatus {
  enabled: boolean;
  thresholdPct: number;
  /** Subscriptions, pooled-first in rotation order, then the rest. */
  subscriptions: RunwayStatusSubscription[];
  /** claude-code profiles with no resolvable accountUuid (never logged in) — surfaced so the operator can. */
  unidentified: { id: string; label: string; signedIn: boolean }[];
}

/** The per-subscription usage snapshot the Tower keeps (persisted keyed by accountUuid). */
export interface RunwayUsage {
  /** Per-window usage, keyed by the CLI's window name (five_hour, seven_day, seven_day_opus, ...). */
  windows: Record<string, RunwayUsageWindow>;
  wall?: RunwayWall;
  /** The terminal whose statusLine/hook last reported for this account (diagnostic only). */
  lastTerminalId?: string;
  /** The model in use at last report (diagnostic only). */
  model?: string;
  /** Where the freshest signal came from. */
  source?: 'statusline' | 'hook' | 'scrape';
}
