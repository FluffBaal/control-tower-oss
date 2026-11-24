// Control Tower — Quick Connect (SPEC-ONBOARDING §1): the guided default entry for plugging a
// provider into the Tower. THREE tiles: use an existing Claude / ChatGPT (Codex) / Gemini
// subscription (built here), connect an open-source coding agent (the AgentTile arrives through
// the injected `agentTile` slot so this file never imports it), and Advanced — the existing
// ProviderForm (progressive disclosure §4; reached via onAdvanced, never rebuilt here). Every
// flow ends on the shared success step: what was created, where it now lives, one CTA to the
// Flightline.
//
// Copy rules from the design review: pipeline agents are never called "assistant" (that word
// belongs to the Jarvis Settings section), and PipelineRole names never render — the success
// step's "Use this for coding" checkbox maps to the implement role in code only.
//
// SELF-CONTAINED like ProvidersPanel: every server call goes through the FROZEN QuickConnectApi
// (quickconnect/contract.ts); SettingsView wires the concrete tower client. New structure uses
// qc- classes; CSS is appended as a trailing /* CSS FOR INTEGRATOR */ block (styles.css untouched).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AgentProfile, ProviderId } from '../shared/types.js';
import type { QuickConnectApi, TileProps } from './quickconnect/contract.js';

// The three built-in subscription CLIs, in tile order. Filtered against the live adapter roster
// at load, so a build missing one simply doesn't offer it.
type SubscriptionProviderId = 'claude-code' | 'codex' | 'gemini-cli';
const SUBSCRIPTION_VENDORS: { id: SubscriptionProviderId; vendor: string; blurb: string }[] = [
  { id: 'claude-code', vendor: 'Claude', blurb: 'Anthropic subscription (Claude Pro / Max)' },
  { id: 'codex', vendor: 'ChatGPT (Codex)', blurb: 'OpenAI subscription (ChatGPT Plus / Pro)' },
  { id: 'gemini-cli', vendor: 'Gemini', blurb: 'Google account' },
];

/** What the shared success step shows (§1): the thing created, where it now lives, and — for a
 *  subscription account — the optional coding-default offer plus any pending sign-in terminal. */
export interface SuccessInfo {
  name: string;
  home: 'Accounts' | 'Providers';
  /** Subscription flows only — enables the "Use this for coding" routing offer. */
  provider?: ProviderId;
  /** Plain vendor name for the routing-offer hint ("New coding runs will default to Claude."). */
  vendor?: string;
  /** Separate-login path: the vendor sign-in terminal to finish on the Flightline. */
  pendingTerminalId?: string | null;
  /** Extra honesty line (e.g. adopting this computer's login fell back to a fresh sign-in). */
  note?: string;
}

export interface QuickConnectProps {
  api: QuickConnectApi;
  /** INTEGRATOR SLOT: the open-source agent tile (src/web/quickconnect/AgentTile.tsx), passed as
   *  `agentTile={(p) => <AgentTile {...p} />}` once it lands. Rendered as a component — never
   *  invoked inline — so its hooks stay its own. Absent → the tile shows a not-wired notice. */
  agentTile?: (p: TileProps) => JSX.Element;
  /** Advanced tile → open the existing ProviderForm; the host returns to Connections with the provider form open. */
  onAdvanced: () => void;
  /** Leave Quick Connect (the success step's quiet "Done"). */
  onClose: () => void;
  onError: (m: string) => void;
  /** Success CTA "Start a run on the Flightline". Absent → falls back to onClose. */
  onStartRun?: () => void;
  /** The success CTA's label. Absent → "Start a run on the Flightline". */
  startRunLabel?: string;
  /** Hop to a Flightline terminal to finish a vendor sign-in. */
  onOpenTerminal?: (terminalId: string) => void;
  /** Deep-link: AccountsPanel's "Connect an account" opens the subscription tile directly. */
  initialTile?: 'subscription' | 'agent' | null;
}

type Step =
  | { kind: 'choose' }
  | { kind: 'subscription' }
  | { kind: 'agent' }
  | { kind: 'success'; info: SuccessInfo };

export function QuickConnect({ api, agentTile, onAdvanced, onClose, onError, onStartRun, startRunLabel, onOpenTerminal, initialTile }: QuickConnectProps) {
  const [step, setStep] = useState<Step>(() => (initialTile ? { kind: initialTile } : { kind: 'choose' }));
  const toChooser = () => setStep({ kind: 'choose' });

  // Tracks the most recent agent completion so an in-flight prettify from an earlier connect
  // can't overwrite the name shown for a later one ("connect another" then a fast second finish).
  const latestAgentId = useRef<string | null>(null);

  // Agent-tile completion: the frozen contract hands back the created provider id; show it at
  // once, then prettify from the adapter roster (which carries the synthesized displayName).
  const agentDone = (id: string) => {
    latestAgentId.current = id;
    setStep({ kind: 'success', info: { name: id.replace(/^custom:/, ''), home: 'Providers' } });
    void api
      .listAdapters()
      .then((roster) => {
        if (latestAgentId.current !== id) return; // a later connect superseded this success
        const hit = roster.find((a) => a.id === id);
        if (hit) {
          setStep((s) =>
            s.kind === 'success' && s.info.home === 'Providers' ? { kind: 'success', info: { ...s.info, name: hit.displayName } } : s,
          );
        }
      })
      .catch(() => {});
  };

  const AgentTile = agentTile;
  return (
    <section className="settings-section qc">
      <h2>Connect</h2>
      <p className="muted small">
        Plug a coding provider into the Tower — your existing subscription, an open-source coding agent, or a fully
        custom CLI.
      </p>

      {step.kind === 'choose' && (
        <div className="qc-grid">
          <button className="qc-tile" onClick={() => setStep({ kind: 'subscription' })}>
            <span className="qc-tile-kicker">Subscription</span>
            <span className="qc-tile-title">Use your Claude, ChatGPT (Codex), or Gemini subscription</span>
            <span className="qc-tile-desc">Sign in with an account you already pay for — no API keys.</span>
          </button>
          <button className="qc-tile" onClick={() => setStep({ kind: 'agent' })}>
            <span className="qc-tile-kicker">Open-source agent</span>
            <span className="qc-tile-title">Connect an open-source coding agent (Aider)</span>
            <span className="qc-tile-desc">Requires Aider, plus Ollama or an API key.</span>
          </button>
          <button className="qc-tile" onClick={onAdvanced}>
            <span className="qc-tile-kicker">Advanced</span>
            <span className="qc-tile-title">Define a custom CLI</span>
            <span className="qc-tile-desc">The full provider form — command, environment, turn detection.</span>
          </button>
        </div>
      )}

      {step.kind === 'subscription' && (
        <SubscriptionTile api={api} onDone={(info) => setStep({ kind: 'success', info })} onError={onError} onCancel={toChooser} />
      )}

      {step.kind === 'agent' && (
        <div className="qc-step">
          <StepHead title="Connect an open-source coding agent (Aider)" onBack={toChooser} />
          {AgentTile ? (
            <AgentTile api={api} onDone={agentDone} onError={onError} onCancel={toChooser} />
          ) : (
            <p className="muted small">This build doesn’t have the open-source agent flow wired in yet.</p>
          )}
        </div>
      )}

      {step.kind === 'success' && (
        <SuccessStep
          info={step.info}
          api={api}
          onError={onError}
          startRunLabel={startRunLabel}
          onStartRun={() => {
            toChooser();
            (onStartRun ?? onClose)();
          }}
          onOpenTerminal={
            onOpenTerminal
              ? (tid) => {
                  toChooser();
                  onOpenTerminal(tid);
                }
              : undefined
          }
          onDone={() => {
            toChooser();
            onClose();
          }}
          onAnother={toChooser}
        />
      )}
    </section>
  );
}

function StepHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="qc-step-head">
      <button className="btn sm ghost" onClick={onBack}>
        ← back
      </button>
      <span className="qc-step-title">{title}</span>
    </div>
  );
}

// ---- Tile 1 · subscription (adopt this computer's login, or a fresh vendor sign-in) ----

interface SubscriptionData {
  vendors: typeof SUBSCRIPTION_VENDORS;
  profiles: AgentProfile[];
  machine: Record<'claude-code' | 'codex', boolean>;
}

function SubscriptionTile({
  api,
  onDone,
  onError,
  onCancel,
}: {
  api: QuickConnectApi;
  onDone: (info: SuccessInfo) => void;
  onError: (m: string) => void;
  onCancel: () => void;
}) {
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<(typeof SUBSCRIPTION_VENDORS)[number] | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<'adopt' | 'login' | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      // machineLoginStatus is probed ONCE per visit and gates the adopt button (§1): file absent →
      // that action is not rendered at all and "Log in" is the sole primary. A failed probe
      // degrades quietly to "absent" — the separate-login path always works.
      const [roster, profiles, machine] = await Promise.all([
        api.listAdapters(),
        api.listProfiles(),
        api.machineLoginStatus().catch(() => ({ 'claude-code': false, codex: false })),
      ]);
      setData({
        vendors: SUBSCRIPTION_VENDORS.filter((v) => roster.some((a) => a.id === v.id)),
        profiles,
        machine,
      });
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
  }, [api, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  const connect = async (mode: 'adopt' | 'login') => {
    if (busy || !data || !picked) return;
    setBusy(mode);
    try {
      const lbl = label.trim() || autoLabel(data.profiles, picked.id, mode === 'adopt' ? 'this computer' : 'personal');
      const profile = await api.createProfile(picked.id, lbl);
      const name = `${picked.vendor} (${lbl})`;
      if (mode === 'adopt') {
        try {
          await api.adoptMachineLogin(profile.id);
          onDone({ name, home: 'Accounts', provider: picked.id, vendor: picked.vendor });
          return;
        } catch {
          // Adopt refused (no machine login after all / non-adoptable provider): never orphan the
          // profile just created — fall through to the vendor's own sign-in on the SAME profile (§1).
        }
      }
      const term = await api.loginProfile(profile.id);
      onDone({
        name,
        home: 'Accounts',
        provider: picked.id,
        vendor: picked.vendor,
        pendingTerminalId: terminalIdOf(term),
        note: mode === 'adopt' ? 'Copying this computer’s login didn’t work, so a fresh sign-in opened instead.' : undefined,
      });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (failed) {
    return (
      <div className="qc-step">
        <StepHead title="Use your subscription" onBack={onCancel} />
        <div className="muted small">
          Couldn’t load providers.{' '}
          <button className="btn-sm" onClick={() => void load()}>
            retry
          </button>
        </div>
      </div>
    );
  }

  const sameProvider = data && picked ? data.profiles.filter((p) => p.provider === picked.id) : [];
  const adoptable = !!(data && picked && (picked.id === 'claude-code' || picked.id === 'codex') && data.machine[picked.id]);

  return (
    <div className="qc-step">
      <StepHead
        title={picked ? `Connect ${picked.vendor}` : 'Use your subscription'}
        onBack={
          picked
            ? () => {
                setPicked(null);
                setLabel('');
              }
            : onCancel
        }
      />
      {data === null ? (
        <div className="muted small">Loading…</div>
      ) : picked === null ? (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            Which subscription do you want to use?
          </p>
          <div className="qc-vendors">
            {data.vendors.map((v) => (
              <button key={v.id} className="qc-tile" onClick={() => setPicked(v)}>
                <span className="qc-tile-title">{v.vendor}</span>
                <span className="qc-tile-desc">{v.blurb}</span>
              </button>
            ))}
            {data.vendors.length === 0 && <div className="muted small">No built-in providers are available in this build.</div>}
          </div>
        </>
      ) : (
        <div className="settings-form">
          {sameProvider.length > 0 && (
            <div className="field">
              <label>account label</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void connect(adoptable ? 'adopt' : 'login');
                }}
                placeholder="e.g. work — blank picks one for you"
              />
              <span className="hint">You already have a {picked.vendor} account here — a label tells them apart.</span>
            </div>
          )}
          {adoptable && (
            <>
              <div>
                <button className="btn ok" disabled={busy !== null} onClick={() => void connect('adopt')}>
                  {busy === 'adopt' ? 'Connecting…' : 'Use this computer’s login'}
                </button>
              </div>
              <span className="hint">
                This computer is already signed in to {picked.vendor}. Copy that login into an isolated Tower account —
                no second sign-in, and your own setup stays untouched.
              </span>
            </>
          )}
          <div>
            <button className={adoptable ? 'btn' : 'btn ok'} disabled={busy !== null} onClick={() => void connect('login')}>
              {busy === 'login' ? 'Opening sign-in…' : adoptable ? 'Log in with a separate account' : 'Log in'}
            </button>
          </div>
          <span className="hint">Opens {picked.vendor}’s own sign-in in a terminal on the Flightline.</span>
        </div>
      )}
    </div>
  );
}

/** Label defaults (§1): adopt → "this computer", separate login → "personal"; when the name is
 *  taken by a same-provider account, count up ("personal 2") — never a duplicate. The label field
 *  itself only appears once a same-provider account exists (the caller gates on that). */
function autoLabel(profiles: AgentProfile[], provider: ProviderId, base: string): string {
  const taken = new Set(profiles.filter((p) => p.provider === provider).map((p) => p.label));
  let label = base;
  for (let n = 2; taken.has(label); n++) label = `${base} ${n}`;
  return label;
}

/** The contract keeps loginProfile's result opaque (Promise<unknown>); the live route returns the
 *  created Terminal. Pull its id defensively so the success step can offer the hop. */
function terminalIdOf(t: unknown): string | null {
  if (t && typeof t === 'object' && 'id' in t && typeof (t as { id: unknown }).id === 'string') return (t as { id: string }).id;
  return null;
}

// ---- Shared success step (§1): what was created, where it lives, one CTA ----

function SuccessStep({
  info,
  api,
  onError,
  startRunLabel,
  onStartRun,
  onOpenTerminal,
  onDone,
  onAnother,
}: {
  info: SuccessInfo;
  api: QuickConnectApi;
  onError: (m: string) => void;
  startRunLabel?: string;
  onStartRun: () => void;
  onOpenTerminal?: (terminalId: string) => void;
  onDone: () => void;
  onAnother: () => void;
}) {
  const [useForCoding, setUseForCoding] = useState(false);
  const [busy, setBusy] = useState(false);

  // Apply the routing offer exactly once, on the way out — toggling the checkbox costs nothing
  // until the operator leaves, so un-checking needs no "clear routing" call.
  const leave = async (go: () => void) => {
    if (busy) return;
    setBusy(true);
    try {
      if (useForCoding && info.provider) {
        // Maps to the implement role; the copy never says so — the Routing section fine-tunes.
        await api.setRoutingRole('implement', { provider: info.provider });
      }
    } catch (e) {
      onError((e as Error).message); // the routing offer is a bonus — don't trap the operator here
    } finally {
      setBusy(false);
    }
    go();
  };

  const pendingTerm = info.pendingTerminalId ?? null;
  return (
    <div className="qc-success">
      <div className="qc-success-title">{pendingTerm ? `${info.name} — one step left` : `Connected ${info.name}`}</div>
      <p className="muted small" style={{ margin: 0 }}>
        It now lives in Connections → {info.home === 'Accounts' ? 'Provider accounts' : 'Providers'}.
        {pendingTerm ? ' Finish the vendor sign-in in the terminal that just opened on the Flightline.' : ''}
        {info.note ? ` ${info.note}` : ''}
      </p>
      {info.provider && (
        <>
          <label className="settings-toggle">
            <input type="checkbox" checked={useForCoding} onChange={(e) => setUseForCoding(e.target.checked)} />
            <span>Use this for coding</span>
          </label>
          <span className="hint">New coding runs will default to {info.vendor ?? info.name}.</span>
        </>
      )}
      <div className="qc-success-actions">
        {pendingTerm && onOpenTerminal ? (
          <button className="btn ok" disabled={busy} onClick={() => void leave(() => onOpenTerminal(pendingTerm))}>
            Finish sign-in on the Flightline
          </button>
        ) : (
          <button className="btn ok" disabled={busy} onClick={() => void leave(onStartRun)}>
            {startRunLabel ?? 'Start a run on the Flightline'}
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => void leave(onDone)}>
          Done
        </button>
        <button className="btn ghost" disabled={busy} onClick={onAnother}>
          connect another
        </button>
      </div>
    </div>
  );
}
