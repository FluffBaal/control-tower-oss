// Control Tower — the ONE model picker (SPEC-MODELS §3). Every place a model is chosen for a
// provider renders <ModelSelect>: Settings → ChatGPT model, the Routing role grid, and the mission /
// sortie overrides. It reads the unified roster from GET /api/models/:provider (zero-egress; custom
// def rosters + built-in curated/discovered catalogs) through a small module cache, and — when the
// provider is discoverable (codex) — offers a Refresh that triggers the one server-side catalog GET.
//
// The codex catalog is per ChatGPT account (tiers expose different models), so the roster read AND the
// module cache are keyed by (provider, profileId). Free-text stays possible everywhere via "Custom…":
// OpenAI can ship a slug before our catalog re-verifies, and the start gate allowlists the id anyway.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId, ProviderModelsView } from '../shared/types.js';
import { tower } from './api.js';

const CUSTOM = '__custom__';

/** The only bit of a refresh result the picker reads back — a failure note to surface. Kept minimal so
 *  the component doesn't couple to the DiscoverResult type's home module (ProvidersPanel). */
type RefreshResult = { note?: string };

// ---- module cache: one composed roster per (provider, profileId), shared across every mounted picker.
// `generation` bumps on every invalidation so a GET that was already in flight when the cache was
// cleared can't repopulate it with stale data after a newer read (the epoch guard).
const cache = new Map<string, ProviderModelsView>();
const inflight = new Map<string, Promise<ProviderModelsView>>();
const listeners = new Set<() => void>();
let generation = 0;

function cacheKey(provider: ProviderId, profileId?: string): string {
  return `${provider}::${profileId ?? ''}`;
}

/** Drop cached rosters so the next read re-fetches — call on a `providers` SSE frame (a def's models
 *  or a codex catalog may have changed) or right after a successful refresh. Clears ALL accounts of a
 *  provider (or every provider when no arg). */
export function invalidateModelCache(provider?: ProviderId): void {
  generation++;
  if (provider) {
    const prefix = `${provider}::`;
    for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
    for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k);
  } else {
    cache.clear();
    inflight.clear();
  }
  for (const l of listeners) l();
}

function fetchView(provider: ProviderId, profileId?: string): Promise<ProviderModelsView> {
  const key = cacheKey(provider, profileId);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(key);
  if (existing) return existing;
  const gen = generation;
  const req = tower
    .getProviderModels(provider, profileId)
    .then((v) => {
      // Epoch guard: only trust this result if no invalidation happened while it was in flight —
      // otherwise a stale read could clobber a fresher one that ran after the cache was cleared.
      if (gen === generation) cache.set(key, v);
      if (inflight.get(key) === req) inflight.delete(key);
      return v;
    })
    .catch((e) => {
      if (inflight.get(key) === req) inflight.delete(key);
      throw e;
    });
  inflight.set(key, req);
  return req;
}

/** Subscribe a component to a (provider, profileId) roster. Returns the view (null until loaded), a
 *  loading flag, and refresh() which triggers the server-side catalog GET then re-reads the view and
 *  returns the raw DiscoverResult so the caller can surface a failure note. */
export function useProviderModels(
  provider?: ProviderId,
  profileId?: string,
): {
  view: ProviderModelsView | null;
  loading: boolean;
  failed: boolean;
  refresh: () => Promise<RefreshResult | null>;
} {
  const key = provider ? cacheKey(provider, profileId) : '';
  const [view, setView] = useState<ProviderModelsView | null>(() => (key ? cache.get(key) ?? null : null));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // A monotonic id so ONLY the latest fetch may update view: within one subscription, an invalidation
  // (SSE) re-runs sync() and issues a new GET, and the stale earlier GET must not win if it resolves
  // later (the cache epoch guard protects the cache; this protects the component's own view state).
  const reqSeq = useRef(0);

  // Render-phase reset on a (provider, profileId) switch: synchronously reflect the NEW key's cached
  // roster (or null) — a reused picker instance must never paint the previous account's roster even for
  // one frame, and a switch to an already-cached account must clear a stuck loading/failed state.
  const [seenKey, setSeenKey] = useState(key);
  if (key !== seenKey) {
    setSeenKey(key);
    setView(key ? cache.get(key) ?? null : null);
    setLoading(false);
    setFailed(false);
  }

  useEffect(() => {
    if (!provider) return;
    let alive = true;
    const k = cacheKey(provider, profileId);
    const sync = () => {
      const cached = cache.get(k);
      if (cached) {
        setView(cached);
        setLoading(false); // a cache-hit re-subscribe must clear any loading left over from a switch
        setFailed(false);
        return;
      }
      // Same-key re-sync (SSE) keeps the current roster on screen until the new one lands (no flto-null
      // flicker); a key SWITCH already cleared view synchronously in the render-phase reset above.
      const myReq = ++reqSeq.current;
      setLoading(true);
      setFailed(false);
      fetchView(provider, profileId)
        .then((v) => {
          if (alive && myReq === reqSeq.current) {
            setView(v);
            setLoading(false);
          }
        })
        .catch(() => {
          // A roster read failing must never break the form: mark failed so the picker still allows
          // inline (Custom) editing and can offer a retry, rather than stranding an empty dropdown.
          if (alive && myReq === reqSeq.current) {
            setLoading(false);
            setFailed(true);
          }
        });
    };
    listeners.add(sync);
    sync();
    return () => {
      alive = false;
      listeners.delete(sync);
    };
  }, [provider, profileId]);

  const refresh = useCallback(async (): Promise<RefreshResult | null> => {
    if (!provider) return null;
    setLoading(true);
    try {
      return await tower.refreshProviderModels(provider, profileId);
    } catch {
      return null; // network/refuse — the note (if any) is lost; the roster is unchanged
    } finally {
      // Invalidate the INITIATING tab's cache directly so its picker re-reads even if the `providers`
      // SSE frame (which invalidates every OTHER tab) is dropped mid-reconnect. Both firing on this tab
      // costs one extra idempotent local GET — cheaper than showing a stale roster after an apparent
      // success. A no-op on failure (nothing changed server-side).
      invalidateModelCache(provider);
      setLoading(false);
    }
  }, [provider, profileId]);

  return { view, loading, failed, refresh };
}

export interface ModelSelectProps {
  provider?: ProviderId;
  value: string;
  onChange: (v: string) => void;
  /** Which logged-in account's token drives a Refresh + scopes the codex roster read (tiers differ). */
  profileId?: string;
  /** Render a leading empty option (value="") — for optional overrides (routing grid, missions) or a
   *  required-but-unpicked field. Its text is `emptyLabel`. */
  allowEmpty?: boolean;
  /** Text for the empty option. Default "— not set —" (an unset override); a required picker can pass
   *  e.g. "— select a model —" and gate its submit on a non-empty value. */
  emptyLabel?: string;
  /** Drop the hint line + verbose chrome for tight inline rows (grid / sortie). Refresh stays available. */
  compact?: boolean;
  /** Greyed + non-interactive — e.g. a routing row with no provider chosen yet. */
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
}

/** The unified picker. Provider-less → a bare text input (no roster to offer). Otherwise a roster
 *  <select> with a "Custom…" escape to a free-text id, plus an inline Refresh when discoverable. */
export function ModelSelect({ provider, value, onChange, profileId, allowEmpty, emptyLabel, compact, disabled, id, ariaLabel }: ModelSelectProps) {
  const { view, loading, failed, refresh } = useProviderModels(provider, profileId);
  const roster = view?.models ?? [];
  const inRoster = (v: string) => roster.some((m) => m.id === v);

  // Custom is EXPLICIT state (never derived), so typing a slug that transiently matches a roster id
  // mid-word can't unmount the input and eat keystrokes (the SettingsView ModelPicker lesson).
  const [custom, setCustom] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  // Reset custom + any stale refresh note when the PROVIDER or the ACCOUNT changes (a persisted picker
  // instance is reused across both in the routing grid). The flip effect below then re-derives custom
  // against the new roster. Render-phase reset (React's documented pattern) so it can't lag a render
  // behind the switch — otherwise the picker kept a stale custom mode / a "no login" note for a
  // healthy account. Keyed on (provider, profileId) since a codex account switch keeps provider='codex'.
  const selKey = `${provider ?? ''}::${profileId ?? ''}`;
  const selKeyRef = useRef(selKey);
  selKeyRef.current = selKey; // always the latest, so a late async result can tell if the account moved
  const [seenKey, setSeenKey] = useState(selKey);
  if (selKey !== seenKey) {
    setSeenKey(selKey);
    setCustom(false);
    setRefreshMsg(null);
  }
  useEffect(() => {
    // A stored slug not on the roster is free-text. Gate on the roster having RESOLVED — loaded (view)
    // OR failed to load — so an empty-roster provider (and a picker whose GET errored) still lets the
    // operator edit a saved slug inline, instead of stranding it as a locked, uneditable option.
    if (!custom && value && (view !== null || failed) && !inRoster(value)) setCustom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, view, failed, custom]);

  if (!provider) {
    return (
      <input
        id={id}
        aria-label={ariaLabel}
        className="model-select-input"
        placeholder="model id"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
      />
    );
  }

  const showTransient = !custom && !!value && !inRoster(value); // value set, roster not yet loaded

  const onRefresh = () => {
    const startedAt = selKey;
    // Only surface the note if the picker is STILL on the account the refresh was started for — a slow
    // codex probe (up to ~13s) that resolves after an account switch must not stamp its failure onto
    // the account now shown.
    void refresh().then((r) => {
      if (selKeyRef.current === startedAt) setRefreshMsg(r?.note ?? null);
    });
  };

  return (
    <div className={`model-select${compact ? ' compact' : ''}`}>
      <div className="model-select-row">
        <select
          id={id}
          aria-label={ariaLabel}
          disabled={disabled}
          value={custom ? CUSTOM : value}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(true);
              onChange('');
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          {/* Empty = the operator set no model here: the routing grid then leaves it to the CLI's own
              choice, the sortie/mission/loop pickers inherit the resolved route model. The system never
              substitutes a model of its own, so this is "not set"/"select a model", never a named default. */}
          {allowEmpty && <option value="">{emptyLabel ?? '— not set —'}</option>}
          {roster.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label ?? m.id}
            </option>
          ))}
          {showTransient && <option value={value}>{value}</option>}
          <option value={CUSTOM}>Custom…</option>
        </select>
        {view?.discoverable && (
          <button
            type="button"
            className="model-select-refresh"
            title="Check for newly released models"
            disabled={loading || disabled}
            onClick={onRefresh}
          >
            {loading ? '…' : '↻'}
          </button>
        )}
      </div>
      {custom && (
        <input
          className="model-select-input"
          style={{ marginTop: 6 }}
          placeholder="model id (e.g. gpt-5.5)"
          aria-label={ariaLabel ? `${ariaLabel} (custom)` : 'custom model id'}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      )}
      {refreshMsg && <span className="hint model-select-hint model-select-warn">{refreshMsg}</span>}
      {failed && !refreshMsg && (
        <span className="hint model-select-hint model-select-warn">
          couldn’t load the model list{view?.discoverable ? ' — ↻ to retry, or Custom… to type one' : ' — Custom… to type one'}
        </span>
      )}
      {!compact && view && !refreshMsg && !failed && (
        <span className="hint model-select-hint">
          {view.source === 'discovered' && `${roster.length} models · live-verified${view.lastVerifiedAt ? ` ${view.lastVerifiedAt.slice(0, 10)}` : ''}`}
          {view.source === 'curated' && `${roster.length} models · curated list — Custom… for anything newer`}
          {view.source === 'none' && 'no known models — type a model id'}
          {view.note ? ` · ${view.note}` : ''}
        </span>
      )}
    </div>
  );
}
