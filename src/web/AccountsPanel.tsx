// Accounts (provider logins) + GitHub identities management (SPEC M4). Push
// credentials are write-only here: you paste a PAT to store it for the broker, but it
// is never read back to the UI.

import { useCallback, useEffect, useState } from 'react';
import type { AgentProfile, GitHubIdentity } from '../shared/types.js';
import { tower, type AdapterInfo as AI, type Observability } from './api.js';

export function AccountsPanel({
  adapters,
  onError,
  onOpenTerminal,
  onQuickConnect,
}: {
  adapters: AI[];
  onError: (m: string) => void;
  /** Surface the login terminal the "log in" button spawns — App selects it and hops to the
   *  Flightline, so the OAuth flow is in front of the operator instead of orphaned. */
  onOpenTerminal: (id: string) => void;
  /** Open Quick Connect on its subscription tile — account CREATION lives there now
   *  (SPEC-ONBOARDING §1); this panel keeps listing + managing. */
  onQuickConnect: () => void;
}) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [identities, setIdentities] = useState<GitHubIdentity[]>([]);
  // Gates the per-row "use this computer's login" recovery action (SPEC-ONBOARDING §1): shown
  // only when the machine actually has that provider's login file. A failed probe hides it.
  const [machine, setMachine] = useState<Record<'claude-code' | 'codex', boolean> | null>(null);
  const [adoptedId, setAdoptedId] = useState<string | null>(null);
  /** The account the operator clicked "remove" on, plus the server's refusal once it has answered. */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; refusal?: string } | null>(null);
  /** The account being renamed inline (id + the draft label), or null. */
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  /** The account the operator clicked "use this computer's login" on — armed for a confirm, because
   *  adopt OVERWRITES the account's saved credential and a misclick would clobber a fresh login. */
  const [pendingAdopt, setPendingAdopt] = useState<string | null>(null);
  /** profileIds currently in the Runway rotation pool (null until the config has loaded; a failed
   *  load leaves it null and hides the live-swap toggle rather than showing a wrong state). */
  const [pooled, setPooled] = useState<Set<string> | null>(null);
  /** Account whose pool add/remove call is in flight (disables its toggle). */
  const [poolBusy, setPoolBusy] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [p, i] = await Promise.all([tower.listProfiles(), tower.listIdentities()]);
      setProfiles(p);
      setIdentities(i);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void (async () => {
      try {
        setMachine(await tower.machineLoginStatus());
      } catch {
        // probe failure (or the route not wired yet) just hides the recovery action
      }
    })();
  }, []);

  const loadPool = useCallback(async () => {
    try {
      const cfg = await tower.getRunwayConfig();
      setPooled(new Set(cfg.pool.map((e) => e.profileId)));
    } catch {
      // route unavailable: hide the live-swap toggle
    }
  }, []);
  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  // Live-swap rotation: put an account into / take it out of the Runway pool. The routes return the
  // RunwayStatus; re-read the config so the toggle reflects the server's pool exactly (e.g. a 409
  // "pool full" leaves it off and surfaces the server's message).
  const setLiveSwap = async (id: string, on: boolean) => {
    setPoolBusy((b) => new Set(b).add(id));
    try {
      if (on) await tower.runwayPoolAdd(id);
      else await tower.runwayPoolRemove(id);
    } catch (e) {
      onError(serverError((e as Error).message).error);
    }
    await loadPool();
    setPoolBusy((b) => {
      const n = new Set(b);
      n.delete(id);
      return n;
    });
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  // SPEC-TERMINAL-OPS §1.2 — removing an account now SHREDS its stored credential, so the row asks
  // first. A server refusal (a live terminal runs as this account, or it is the assistant Brain
  // account) is shown verbatim on the row with a force button, because the operator is the only one
  // who can weigh it — and the 409 text tells them to pass ?force=true, which no click could do before.
  const remove = async (id: string, force: boolean) => {
    try {
      const res = await tower.deleteProfile(id, { force });
      setPendingDelete(null);
      await refresh();
      // The record is gone but a readable credential is still on disk. Loud: the boot sweep retries,
      // but until then the account's secret outlives the account.
      if (res.shredded === false) {
        onError('Account removed, but its stored login could not be deleted from disk — the Tower will retry the cleanup at its next restart.');
      }
    } catch (e) {
      const { status, error } = serverError((e as Error).message);
      // Only a 409 is a REFUSAL the operator can override; anything else is a real failure and must
      // not be offered a "remove anyway" button.
      if (status === 409) setPendingDelete({ id, refusal: error });
      else {
        setPendingDelete(null);
        onError(error);
      }
    }
  };

  // Fresh OAuth: the login route SPAWNS a "login: <label>" terminal, so open it — a bare
  // act() would await the POST, refresh, and DISCARD the returned terminal, leaving the
  // operator staring at an unchanged row while orphan login terminals pile up. Adopt
  // (below) stays terminal-less: it copies the machine credential, nothing to open.
  const login = async (id: string) => {
    try {
      const term = await tower.loginProfile(id);
      await refresh();
      onOpenTerminal(term.id);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  // Re-copy the machine login into an existing profile (the recovery path when an adopted login
  // expires). Nothing in the row changes on success, so confirm with a transient chip instead.
  const adopt = async (id: string) => {
    try {
      await tower.adoptMachineLogin(id);
      setAdoptedId(id);
      setTimeout(() => setAdoptedId((cur) => (cur === id ? null : cur)), 2500);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  // Rename a provider account's display label (label-only; the credential + live bindings are untouched).
  const saveRename = async () => {
    if (!editing) return;
    const label = editing.label.trim();
    if (!label) { setEditing(null); return; } // empty = cancel, never persist a blank name
    await act(() => tower.renameProfile(editing.id, label));
    setEditing(null);
  };

  return (
    <div className="accounts">
      <section className="home-section">
        <h2>Provider accounts</h2>
        <p className="muted small">Each account is a distinct login, isolated in its own config dir. Log in once per account.</p>
        <div className="acct-list">
          {profiles.map((p) => (
            <div key={p.id} className="acct-row">
              <span className="chip question">{providerName(adapters, p.provider)}</span>
              {/* The label/input gate mirrors the action ladder below: an input shows iff `editing` is
                  this row, and the arming buttons (rename/remove/use-this-login) live ONLY in the
                  default action branch, so a row can be in exactly one of edit/delete/adopt at a time. */}
              {editing?.id === p.id ? (
                <input
                  className="acct-label-edit mono"
                  value={editing.label}
                  autoFocus
                  maxLength={100}
                  aria-label="Account name"
                  onChange={(e) => setEditing({ id: p.id, label: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') void saveRename(); else if (e.key === 'Escape') setEditing(null); }}
                />
              ) : (
                <span className="acct-label">{p.label}</span>
              )}
              <span className="spacer" />
              {pendingDelete?.id === p.id ? (
                <>
                  <span className="muted small">
                    {pendingDelete.refusal
                      ? pendingDelete.refusal.replace(/,? *(or )?pass \?force=true\.?/i, '')
                      : 'Remove this account and delete its stored login from disk?'}
                  </span>
                  <button
                    className="btn-sm danger"
                    onClick={() => void remove(p.id, !!pendingDelete.refusal)}
                  >
                    {pendingDelete.refusal ? 'remove anyway' : 'remove'}
                  </button>
                  <button className="btn-sm" onClick={() => setPendingDelete(null)}>cancel</button>
                </>
              ) : editing?.id === p.id ? (
                <>
                  <button className="btn-sm ok" onClick={() => void saveRename()}>save</button>
                  <button className="btn-sm" onClick={() => setEditing(null)}>cancel</button>
                </>
              ) : pendingAdopt === p.id ? (
                <>
                  <span className="muted small">Overwrite this account’s saved login with this computer’s current login?</span>
                  <button className="btn-sm danger" onClick={() => { setPendingAdopt(null); void adopt(p.id); }}>overwrite</button>
                  <button className="btn-sm" onClick={() => setPendingAdopt(null)}>cancel</button>
                </>
              ) : (
                <>
                  {adoptedId === p.id && <span className="chip question">login copied</span>}
                  {p.provider === 'claude-code' && pooled && (
                    <label
                      className="settings-toggle"
                      title="Allow this account into automatic mid-task rotation (Runway live-swap)."
                    >
                      <input
                        type="checkbox"
                        checked={pooled.has(p.id)}
                        disabled={poolBusy.has(p.id)}
                        onChange={(e) => void setLiveSwap(p.id, e.target.checked)}
                      />
                      Live-swap rotation
                    </label>
                  )}
                  <button className="btn-sm" onClick={() => setEditing({ id: p.id, label: p.label })}>rename</button>
                  {(p.provider === 'claude-code' || p.provider === 'codex') && machine?.[p.provider] && (
                    <button
                      className="btn-sm"
                      title="Copy the login this computer already has into this account — overwrites this account's saved login (asks first)."
                      onClick={() => setPendingAdopt(p.id)}
                    >
                      use this computer’s login
                    </button>
                  )}
                  <button className="btn-sm" onClick={() => void login(p.id)}>log in</button>
                  <button className="btn-sm danger" onClick={() => setPendingDelete({ id: p.id })}>remove</button>
                </>
              )}
            </div>
          ))}
          {profiles.length === 0 && <div className="muted small">No accounts yet.</div>}
        </div>
        <div style={{ marginTop: 6 }}>
          <button className="btn ok" onClick={onQuickConnect}>Connect an account</button>
        </div>
      </section>

      <section className="home-section">
        <h2>GitHub identities</h2>
        <p className="muted small">
          Commits use these author details. Pushes use a GitHub <b>Personal Access Token (PAT)</b> — stored
          write-only and served by the broker only at push time, never placed in an agent's environment.{' '}
          <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">Create a token ↗</a>{' '}
          (fine-grained: <span className="mono">Contents</span> + <span className="mono">Pull requests</span> read/write on the repos you want; or classic: <span className="mono">repo</span> scope).
        </p>
        <div className="acct-list">
          {identities.map((i) => (
            <IdentityRow key={i.id} identity={i} onAct={act} />
          ))}
          {identities.length === 0 && <div className="muted small">No identities yet.</div>}
        </div>
        <NewIdentity onCreate={(l, n, e) => act(() => tower.createIdentity(l, n, e))} />
      </section>
    </div>
  );
}

// Host observability + recent activity. Lives in its own "System health" settings section
// (SettingsView) — it used to trail the Accounts panel; exported so that section can render it.
export function HealthAndAudit() {
  const [obs, setObs] = useState<Observability | null>(null);
  const [audit, setAudit] = useState<Record<string, unknown>[]>([]);
  useEffect(() => {
    const load = async () => {
      try {
        const [o, a] = await Promise.all([tower.observability(), tower.audit()]);
        setObs(o);
        setAudit(a.slice(0, 20));
      } catch {
        /* ignore */
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <section className="home-section">
        <h2>Health</h2>
        {obs && (
          <div className="health-grid">
            <div><span className="muted small">uptime</span><br />{Math.floor(obs.uptimeSec / 60)}m</div>
            <div><span className="muted small">live viewers</span><br />{obs.sseClients}</div>
            <div><span className="muted small">unsent hook events</span><br />{obs.spoolDepth}</div>
            <div><span className="muted small">test slots</span><br />{obs.testActive}/{obs.testCapacity}</div>
            <div className={obs.diskLow ? 'disk-low' : ''} title="Free space on the WSL2 ext4 virtual disk holding ~/.ct — not the Windows host disk."><span className="muted small">disk free (WSL fs)</span><br />{(obs.diskFreeMb / 1024).toFixed(1)} GB</div>
          </div>
        )}
      </section>
      <section className="home-section">
        <h2>Recent activity</h2>
        <div className="audit-list">
          {audit.map((e, i) => (
            <div key={i} className="audit-row mono small">
              <span className="muted">{String(e.ts ?? '').slice(11, 19)}</span>
              <span className="audit-action">{String(e.action ?? 'event')}</span>
              <span className="muted">{Object.entries(e).filter(([k]) => k !== 'ts' && k !== 'action').map(([k, v]) => `${k}=${v}`).join(' ')}</span>
            </div>
          ))}
          {audit.length === 0 && <div className="muted small">No activity yet.</div>}
        </div>
      </section>
    </>
  );
}

/** Pull the server's own sentence (and status) out of api()'s "<path> -> <status> <body>" error text,
 *  so a refusal can be shown to the operator as prose instead of as transport noise. */
function serverError(msg: string): { status?: number; error: string } {
  const m = /-> (\d{3}) ([\s\S]*)$/.exec(msg);
  if (!m) return { error: msg };
  const status = Number(m[1]);
  try {
    const parsed = JSON.parse(m[2] ?? '') as { error?: unknown };
    if (typeof parsed.error === 'string') return { status, error: parsed.error };
  } catch {
    /* not a JSON body — fall through to the raw tail */
  }
  return { status, error: m[2]?.trim() || msg };
}

function providerName(adapters: AI[], id: string): string {
  return adapters.find((a) => a.id === id)?.displayName ?? id;
}

function IdentityRow({ identity, onAct }: { identity: GitHubIdentity; onAct: (fn: () => Promise<unknown>) => void }) {
  const [pat, setPat] = useState('');
  const [editing, setEditing] = useState(false);
  return (
    <div className="acct-row identity">
      <span className="acct-label">{identity.label}</span>
      <span className="muted small mono">{identity.gitName} &lt;{identity.gitEmail}&gt;</span>
      <span className="spacer" />
      {identity.hasCredential ? (
        <>
          <span className="chip question">token set</span>
          <button className="btn-sm danger" onClick={() => onAct(() => tower.revokeCredential(identity.id))}>revoke</button>
        </>
      ) : editing ? (
        <>
          <input className="nt-label" type="password" placeholder="paste GitHub PAT (ghp_… / github_pat_…)"
            title="GitHub Personal Access Token. Fine-grained: Contents + Pull requests read/write on the target repos; or classic: repo scope. Stored write-only for the credential broker."
            value={pat} onChange={(e) => setPat(e.target.value)} />
          <button className="btn-sm ok" disabled={!pat.trim()} onClick={() => { onAct(() => tower.setCredential(identity.id, pat.trim())); setPat(''); setEditing(false); }}>save</button>
        </>
      ) : (
        <button className="btn-sm" onClick={() => setEditing(true)}>add token</button>
      )}
      <button className="btn-sm danger" onClick={() => onAct(() => tower.deleteIdentity(identity.id))}>delete</button>
    </div>
  );
}

function NewIdentity({ onCreate }: { onCreate: (label: string, name: string, email: string) => void }) {
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const ok = label.trim() && name.trim() && email.trim();
  return (
    <div className="acct-new">
      <input className="nt-label" placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <input className="nt-label" placeholder="git name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="nt-label" placeholder="git email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button className="btn-sm" disabled={!ok} onClick={() => { onCreate(label.trim(), name.trim(), email.trim()); setLabel(''); setName(''); setEmail(''); }}>add identity</button>
    </div>
  );
}
