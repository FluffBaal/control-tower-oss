// SPEC-RUNWAY — the Settings → Runway tab. Shows each claude-code SUBSCRIPTION (grouped by accountUuid)
// with its live 5h/7d usage and reset countdowns, lets the operator pick the rotation POOL + order + a
// >96% default threshold, and toggle rotation on. Config is edited as a draft and PUT-replaced (the
// server normalizes + returns it); the live status polls every 5s and refetches on the {t:'runway'} SSE.
//
// Rotation defaults OFF and never installs a statusLine or rotates until the operator enables it here.

import { useCallback, useEffect, useRef, useState } from 'react';
import { tower } from './api.js';
import type { RunwayConfig, RunwayStatus, RunwayStatusSubscription } from '../shared/runway.js';

/** "resets in 2h 10m" / "resets in 4m" / "resetting…" from an epoch-SECONDS reset time. */
function resetsIn(resetsAtSec: number): string {
  const ms = resetsAtSec * 1000 - Date.now();
  if (ms <= 0) return 'resetting…';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `resets in ${h}h${m ? ` ${m}m` : ''}`;
}

/** A subscription's worst (highest-used) window %, or undefined when usage is unknown. */
function worstPct(sub: RunwayStatusSubscription): number | undefined {
  const vals = Object.values(sub.windows).map((w) => w.usedPct);
  return vals.length ? Math.max(...vals) : undefined;
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: 'Session (5h)',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
};

function UsageBar({ name, usedPct, resetsAt, threshold }: { name: string; usedPct: number; resetsAt: number; threshold: number }) {
  const over = usedPct >= threshold;
  return (
    <div className="rw-bar-row">
      <span className="rw-bar-label">{WINDOW_LABEL[name] ?? name}</span>
      <span className="rw-bar-track">
        <span className={`rw-bar-fill ${over ? 'over' : ''}`} style={{ width: `${Math.min(100, Math.max(0, usedPct))}%` }} />
      </span>
      <span className="rw-bar-pct">{Math.round(usedPct)}%</span>
      <span className="rw-bar-reset muted small">{resetsIn(resetsAt)}</span>
    </div>
  );
}

export function RunwayPanel({ onError, reloadSignal, onOpenTerminal }: { onError: (m: string) => void; reloadSignal?: number; onOpenTerminal?: (id: string) => void }) {
  const [cfg, setCfg] = useState<RunwayConfig | null>(null);
  const [status, setStatus] = useState<RunwayStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Mirror `dirty` synchronously so the SSE reload effect can skip clobbering an unsaved draft without
  // depending on `dirty` in its deps (which would re-run the effect on every keystroke).
  const dirtyRef = useRef(false);
  const markDirty = (v: boolean) => { dirtyRef.current = v; setDirty(v); };

  const loadConfig = useCallback(async () => {
    try {
      setCfg(await tower.getRunwayConfig());
      dirtyRef.current = false;
      setDirty(false);
      setFailed(false);
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
  }, [onError]);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await tower.runwayStatus());
    } catch {
      /* status is best-effort; the config load surfaces a hard error */
    }
  }, []);

  // Load on mount and on the {t:'runway'} SSE bump — but NOT while the operator has an unsaved draft
  // (a concurrent config change elsewhere must not silently discard in-progress edits).
  useEffect(() => { if (!dirtyRef.current) void loadConfig(); }, [loadConfig, reloadSignal]);
  useEffect(() => {
    void loadStatus();
    const t = window.setInterval(() => void loadStatus(), 5000); // live budget + reset countdowns
    return () => window.clearInterval(t);
  }, [loadStatus]);

  if (failed && !cfg) {
    return (
      <section className="settings-section">
        <h2>Runway</h2>
        <p className="muted small">Couldn’t load Runway config. <button className="lnk" onClick={() => void loadConfig()}>Retry</button></p>
      </section>
    );
  }
  if (!cfg) return <section className="settings-section"><h2>Runway</h2><p className="muted small">Loading…</p></section>;

  const patch = (p: Partial<RunwayConfig>) => { setCfg({ ...cfg, ...p }); markDirty(true); };

  // The profileId (if any) by which a subscription is currently in the pool.
  const pooledProfileOf = (sub: RunwayStatusSubscription): string | undefined =>
    cfg.pool.find((e) => sub.profiles.some((p) => p.id === e.profileId))?.profileId;

  const togglePool = (sub: RunwayStatusSubscription) => {
    const current = pooledProfileOf(sub);
    if (current) {
      patch({ pool: cfg.pool.filter((e) => !sub.profiles.some((p) => p.id === e.profileId)) });
    } else {
      const rep = sub.profiles.find((p) => p.signedIn) ?? sub.profiles[0];
      if (rep) patch({ pool: [...cfg.pool, { profileId: rep.id }] });
    }
  };

  const move = (profileId: string, dir: -1 | 1) => {
    const i = cfg.pool.findIndex((e) => e.profileId === profileId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cfg.pool.length) return;
    const next = cfg.pool.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    patch({ pool: next });
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await tower.setRunwayConfig(cfg);
      setCfg(saved); // re-apply the SERVER-normalized result (clamps/dedupe show truthfully)
      markDirty(false);
      void loadStatus();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const subs = status?.subscriptions ?? [];
  const orderOf = (sub: RunwayStatusSubscription): number => {
    const pid = pooledProfileOf(sub);
    return pid ? cfg.pool.findIndex((e) => e.profileId === pid) : Number.MAX_SAFE_INTEGER;
  };
  const rows = [...subs].sort((a, b) => orderOf(a) - orderOf(b));

  return (
    <section className="settings-section rw">
      <h2>Runway</h2>
      <p className="muted small">
        Usage-aware Claude subscription rotation. When a pooled subscription nears its session or weekly
        limit, an autonomous loop’s builder is moved to another subscription at the next iteration boundary —
        no restart, no re-login. Rotation is off until you enable it, and only affects the subscriptions you pool.
      </p>

      <div className="settings-form">
        <label className="rw-toggle">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>Enable subscription rotation</span>
        </label>
        <div className="field">
          <label>Rotate at</label>
          <input
            type="number" min={1} max={100}
            value={cfg.thresholdPct}
            onChange={(e) => patch({ thresholdPct: e.target.value === '' ? 96 : Number(e.target.value) })}
          />
          <span className="hint">% of any usage window (default 96)</span>
        </div>
      </div>

      <h3 className="rw-h3">Subscriptions</h3>
      {subs.length === 0 && <p className="muted small">No usage reported yet. A subscription appears here once one of its panes has made a request (while rotation is enabled).</p>}
      <div className="rw-subs">
        {rows.map((sub) => {
          const pid = pooledProfileOf(sub);
          const pooled = pid !== undefined;
          const anySignedIn = sub.profiles.some((p) => p.signedIn);
          const wp = worstPct(sub);
          return (
            <div key={sub.accountUuid} className={`rw-sub ${pooled ? 'pooled' : ''}`}>
              <div className="rw-sub-head">
                <label className="rw-pool-check">
                  <input type="checkbox" checked={pooled} disabled={!anySignedIn} onChange={() => togglePool(sub)} />
                </label>
                <span className={`dot ${anySignedIn ? 'ok' : 'off'}`} title={anySignedIn ? 'signed in' : 'signed out'} />
                <span className="rw-sub-label">{sub.email ?? sub.profiles.map((p) => p.label).join(', ') ?? sub.accountUuid.slice(0, 8)}</span>
                {sub.orgName && <span className="muted small">· {sub.orgName}</span>}
                {sub.wall && <span className="chip bad">limit reached</span>}
                {wp !== undefined && wp >= (sub.thresholdPct) && !sub.wall && <span className="chip warn">over threshold</span>}
                {pooled && (
                  <span className="rw-order">
                    <button className="btn xs" title="rotate earlier" onClick={() => pid && move(pid, -1)}>↑</button>
                    <button className="btn xs" title="rotate later" onClick={() => pid && move(pid, 1)}>↓</button>
                  </span>
                )}
              </div>
              <div className="rw-sub-body">
                {Object.keys(sub.windows).length === 0 ? (
                  <span className="muted small">usage unknown (no request yet)</span>
                ) : (
                  Object.entries(sub.windows).map(([name, w]) => (
                    <UsageBar key={name} name={name} usedPct={w.usedPct} resetsAt={w.resetsAt} threshold={sub.thresholdPct} />
                  ))
                )}
                {sub.lastTerminalId && onOpenTerminal && (
                  <button className="lnk small" onClick={() => onOpenTerminal(sub.lastTerminalId!)}>view last pane</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {(status?.unidentified.length ?? 0) > 0 && (
        <p className="muted small">
          Not signed in / no account yet: {status!.unidentified.map((u) => u.label).join(', ')} — log them in under Connections to pool them.
        </p>
      )}

      <div className="rw-save">
        <button className="btn ok" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
        {dirty && <span className="muted small">unsaved changes — takes effect on the next spawn/rotate</span>}
      </div>
    </section>
  );
}
