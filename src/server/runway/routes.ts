// SPEC-RUNWAY — the operator-facing config + status HTTP surface. Session-token only: these routes
// are NOT in server.ts TOKEN_EXEMPT (the global onRequest hook enforces Host/Origin + X-Tower-Token)
// and NOT in the scoped-assistant accept-list (Jarvis does not edit the rotation pool). Registered as
// a sub-router the way registerAssistantRoutes is.
//
// The status/validation LOGIC is extracted as pure functions (composeRunwayStatus, validatePoolForWrite)
// so it is unit-testable without a live Accounts/Fastify — the handlers are thin wrappers.

import type { FastifyInstance } from 'fastify';
import type { RunwayConfig, RunwayStatus, RunwayStatusSubscription } from '../../shared/runway.js';
import { accountIdentityFor } from './identity.js';
import type { RunwayStore } from './store.js';
import type { UsageStore } from './usage.js';

/** A claude-code provider-account profile as Runway needs it (id/label + its isolated dir + live signedIn). */
export interface RunwayProfileView {
  id: string;
  label: string;
  configDir: string;
  signedIn: boolean;
}

export interface RunwayRouteDeps {
  store: RunwayStore;
  usage: UsageStore;
  /** All claude-code provider-account profiles, with a freshly-probed signedIn (never persisted). */
  claudeProfiles: () => RunwayProfileView[];
  /** Machine-local reserved profile ids (the assistant Brain, judges) — never poolable. */
  isReserved: (id: string) => boolean;
  audit: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Compose the status view: group claude-code profiles into subscriptions by accountUuid, join the
 * effective usage + pool membership + threshold. PURE — takes the profile list + stores, so a test
 * feeds fixtures directly. Pooled subscriptions sort first by rotation order; the rest by label.
 */
export function composeRunwayStatus(
  store: RunwayStore,
  usage: UsageStore,
  profiles: RunwayProfileView[],
  now: number = Date.now(),
): RunwayStatus {
  const cfg = store.get();
  const poolIndex = new Map(cfg.pool.map((e, i) => [e.profileId, { i, thresholdPct: e.thresholdPct }]));

  const byUuid = new Map<string, { email?: string; orgName?: string; profiles: RunwayProfileView[] }>();
  const unidentified: RunwayStatus['unidentified'] = [];
  for (const p of profiles) {
    const id = accountIdentityFor(p.configDir);
    if (!id) {
      unidentified.push({ id: p.id, label: p.label, signedIn: p.signedIn });
      continue;
    }
    const g = byUuid.get(id.accountUuid) ?? { email: id.email, orgName: id.orgName, profiles: [] };
    g.profiles.push(p);
    byUuid.set(id.accountUuid, g);
  }

  const subscriptions: RunwayStatusSubscription[] = [];
  for (const [accountUuid, g] of byUuid) {
    const pooledEntries: { i: number; thresholdPct?: number }[] = [];
    for (const p of g.profiles) {
      const e = poolIndex.get(p.id);
      if (e) pooledEntries.push(e);
    }
    const pooled = pooledEntries.length > 0;
    const order = pooled ? Math.min(...pooledEntries.map((e) => e.i)) : undefined;
    const override = pooledEntries.map((e) => e.thresholdPct).find((t) => t !== undefined);
    const eff = usage.effective(accountUuid, now);
    subscriptions.push({
      accountUuid,
      ...(g.email ? { email: g.email } : {}),
      ...(g.orgName ? { orgName: g.orgName } : {}),
      profiles: g.profiles.map((p) => ({ id: p.id, label: p.label, signedIn: p.signedIn })),
      pooled,
      ...(order !== undefined ? { order } : {}),
      thresholdPct: override ?? cfg.thresholdPct,
      windows: eff?.windows ?? {},
      ...(eff?.wall ? { wall: eff.wall } : {}),
      ...(eff?.lastTerminalId ? { lastTerminalId: eff.lastTerminalId } : {}),
      ...(eff?.model ? { model: eff.model } : {}),
    });
  }
  subscriptions.sort((a, b) => {
    if (a.pooled !== b.pooled) return a.pooled ? -1 : 1; // pooled first
    if (a.pooled && b.pooled) return (a.order ?? 0) - (b.order ?? 0); // then rotation order
    return (a.email ?? a.accountUuid).localeCompare(b.email ?? b.accountUuid);
  });

  return { enabled: cfg.enabled, thresholdPct: cfg.thresholdPct, subscriptions, unidentified };
}

/**
 * Validate a proposed pool for a config PUT: every entry must name an EXISTING claude-code profile
 * that is not reserved (the Brain). Returns an error string (→ 400) or null. Rejecting an unknown/
 * non-poolable id is better self-correction than the store's silent drop — a typo shouldn't leave a
 * dead rotation slot. (The store still sanitizes on write as a belt.)
 */
export function validatePoolForWrite(
  pool: unknown,
  profiles: RunwayProfileView[],
  isReserved: (id: string) => boolean,
): string | null {
  if (pool === undefined) return null;
  if (!Array.isArray(pool)) return 'pool must be an array';
  const known = new Set(profiles.map((p) => p.id));
  for (const raw of pool) {
    if (!raw || typeof raw !== 'object') return 'each pool entry must be an object';
    const pid = (raw as { profileId?: unknown }).profileId;
    if (typeof pid !== 'string' || !pid) return 'each pool entry needs a profileId';
    if (isReserved(pid)) return `profile ${pid} is reserved and cannot be pooled`;
    if (!known.has(pid)) return `unknown or non-claude-code profile: ${pid}`;
    const t = (raw as { thresholdPct?: unknown }).thresholdPct;
    if (t !== undefined && t !== null && typeof t !== 'number') return `thresholdPct for ${pid} must be a number`;
  }
  return null;
}

export function registerRunwayRoutes(app: FastifyInstance, deps: RunwayRouteDeps): void {
  app.get('/api/runway/config', async () => deps.store.get());

  app.put<{ Body: Partial<RunwayConfig> }>('/api/runway/config', async (req, reply) => {
    const b = req.body ?? {};
    if (b.thresholdPct !== undefined && typeof b.thresholdPct !== 'number') {
      // Reject a non-number BEFORE the store clamps it — a typo must not be stored as the default.
      return reply.code(400).send({ error: 'thresholdPct must be a number' });
    }
    const poolErr = validatePoolForWrite(b.pool, deps.claudeProfiles(), deps.isReserved);
    if (poolErr) return reply.code(400).send({ error: poolErr });
    const next = deps.store.set({ enabled: b.enabled, liveSwap: b.liveSwap, thresholdPct: b.thresholdPct, pool: b.pool });
    deps.audit('runway.config', { enabled: next.enabled, thresholdPct: next.thresholdPct, pool: next.pool.map((e) => e.profileId) });
    return next;
  });

  // The per-account live-swap slider: ON adds the account to the rotation pool, OFF removes it. Same
  // validation as a config PUT (existing, non-reserved claude-code profile); removal is always allowed
  // so a stale id can be cleared. Returns the refreshed status so the tab re-renders from one response.
  app.post<{ Params: { profileId: string } }>('/api/runway/pool/:profileId', async (req, reply) => {
    const profileId = req.params.profileId;
    const err = validatePoolForWrite([{ profileId }], deps.claudeProfiles(), deps.isReserved);
    if (err) return reply.code(400).send({ error: err });
    const changed = deps.store.addToPool(profileId);
    if (!changed && !deps.store.get().pool.some((e) => e.profileId === profileId)) {
      return reply.code(409).send({ error: 'rotation pool is full' });
    }
    deps.audit('runway.pool.add', { profileId, changed });
    return composeRunwayStatus(deps.store, deps.usage, deps.claudeProfiles());
  });

  app.delete<{ Params: { profileId: string } }>('/api/runway/pool/:profileId', async (req) => {
    const profileId = req.params.profileId;
    const changed = deps.store.removeFromPool(profileId);
    deps.audit('runway.pool.remove', { profileId, changed });
    return composeRunwayStatus(deps.store, deps.usage, deps.claudeProfiles());
  });

  app.get('/api/runway/status', async () => composeRunwayStatus(deps.store, deps.usage, deps.claudeProfiles()));
}
