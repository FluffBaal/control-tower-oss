// Quick Connect · Tile 2 — "Connect an open-source coding agent (Aider)" (SPEC-ONBOARDING §1).
// Rendered by the chooser shell against the frozen TileProps contract. The flow, in order:
//
//   1. PREFLIGHT — is the `aider` binary on PATH? Runs BEFORE any question or upsert, so a
//      missing runner ends in plain install guidance instead of a broken def.
//   2. ONE question — where does the model run? Local Ollama (ask the server URL) or a hosted
//      endpoint (pick one, paste an API key; the generic OpenAI-compatible entry also asks for
//      its base URL, since that endpoint is by definition operator-supplied).
//   3. Save the preset def (upsert), store the key write-only (hosted), test, then discover
//      models — every result surfaced in plain language; a dead endpoint never blocks the flow.
//   4. Pick a model — the preset's short curated list first, then the full discovered roster.
//   5. Final save. PUT replaces the WHOLE def, so this upsert carries the just-discovered
//      model.models forward alongside the picked defaultModel — otherwise the verified roster
//      the operator was just shown would be wiped from the saved def.
//
// House style: existing .settings-form/.field/.btn/.chip/.hint idioms; new structure under
// qc-* classes whose CSS is appended as a trailing /* CSS FOR INTEGRATOR */ block (this file
// must not touch styles.css). The tile never shows argv/env/turn internals — that is Tile 3.

import { useEffect, useState } from 'react';
import type { CustomProviderId } from '../../shared/types.js';
import type { ProviderDefInput } from '../ProvidersPanel.js';
import type { ProviderPreset, TileProps } from './contract.js';
import { AIDER_BIN, HOSTED_PRESETS, OLLAMA_PRESET, OPENAI_COMPAT_KEY } from '../provider-presets.js';

type Step = 'preflight' | 'no-runner' | 'where' | 'local' | 'hosted' | 'connecting' | 'pick';

/** `custom:<slug>` from the preset's display name — deterministic, so re-running the tile
 *  replaces the same def (PUT is create-or-replace) instead of minting siblings. */
function mintId(displayName: string): CustomProviderId {
  let slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39)
    .replace(/-+$/, '');
  if (!slug || !/^[a-z0-9]/.test(slug)) slug = 'aider-agent';
  return `custom:${slug}`;
}

export function AgentTile({ api, onDone, onError, onCancel }: TileProps) {
  const [step, setStep] = useState<Step>('preflight');
  const [checkFailed, setCheckFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  // Local sub-flow
  const [localUrl, setLocalUrl] = useState(OLLAMA_PRESET.def.baseUrl ?? 'http://localhost:11434');
  // Hosted sub-flow
  const [endpoint, setEndpoint] = useState<ProviderPreset | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [compatUrl, setCompatUrl] = useState(
    HOSTED_PRESETS.find((p) => p.key === OPENAI_COMPAT_KEY)?.def.baseUrl ?? '',
  );
  // Connect progress + pick-step state
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState<{ plain: string; detail?: string }[]>([]);
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [builtDef, setBuiltDef] = useState<ProviderDefInput | null>(null);
  const [savedId, setSavedId] = useState<CustomProviderId | null>(null);
  const [discovered, setDiscovered] = useState<{ id: string; verifiedAt?: string }[]>([]);
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);

  // Preflight first (SPEC-ONBOARDING §1 Tile 2): no questions, no upsert, until the runner is
  // confirmed on PATH. A failed CHECK (server error) is not a missing binary — it gets a retry,
  // not install guidance.
  useEffect(() => {
    let cancelled = false;
    setCheckFailed(false);
    void (async () => {
      try {
        const r = await api.runnerPresent(AIDER_BIN);
        if (!cancelled) setStep(r.present ? 'where' : 'no-runner');
      } catch (e) {
        if (!cancelled) {
          setCheckFailed(true);
          onError((e as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, onError, retryTick]);

  /** Upsert the preset def, store the key (hosted), test + discover — then hand off to pick. */
  const runSetup = async (p: ProviderPreset, baseUrl: string, key?: string) => {
    setStep('connecting');
    const collected: { plain: string; detail?: string }[] = [];
    try {
      const def: ProviderDefInput = {
        ...p.def,
        id: mintId(p.def.displayName),
        baseUrl: baseUrl.trim(),
        // This upsert lands BEFORE the model pick, so seed a real defaultModel (first curated) —
        // if the operator abandons the tile here, the saved def is still launchable rather than
        // carrying an empty defaultModel that would spawn with a bare `<prefix>/` model. finish()
        // overwrites this with the picked model on the final save.
        model: { ...p.def.model, defaultModel: p.def.model.defaultModel || p.curatedModels?.[0] || '' },
      };
      setStatus('Saving the connection…');
      const saved = await api.upsertProvider(def);
      if (key && p.secretKey) {
        setStatus('Storing your API key…');
        await api.setProviderSecret(saved.id, p.secretKey, key);
      }
      setStatus('Checking the connection…');
      const test = await api.testProvider(saved.id);
      if (test.binaryPresent && !test.binaryPresent.ok) {
        collected.push({
          plain: "Aider isn't installed — install it with `pipx install aider-chat`, then come back.",
          detail: test.binaryPresent.note,
        });
      }
      setStatus('Looking for models…');
      const found = await api.discoverModels(saved.id);
      if (found.models.length === 0) {
        collected.push({
          plain:
            p.backend === 'ollama'
              ? `Couldn't reach ${def.baseUrl} — is Ollama running? You can still pick a model now and start once it's up.`
              : `Couldn't reach ${def.baseUrl} — check the endpoint and your API key. You can still pick a model now.`,
          detail: found.note,
        });
      }
      setPreset(p);
      setBuiltDef(def);
      setSavedId(saved.id);
      setDiscovered(found.models);
      setNotes(collected);
      setPicked('');
      setStep('pick');
    } catch (e) {
      onError((e as Error).message);
      setStep(p.backend === 'ollama' ? 'local' : 'hosted');
    }
  };

  /** Final save (SPEC-ONBOARDING §3): the same def plus the picked defaultModel, with the
   *  discovered roster carried forward — PUT has no merge, so dropping model.models here
   *  would wipe what discovery just verified. */
  const finish = async () => {
    if (!builtDef || !savedId || !picked.trim()) return;
    setSaving(true);
    try {
      const final: ProviderDefInput = {
        ...builtDef,
        id: savedId,
        model: { ...builtDef.model, models: discovered, defaultModel: picked.trim() },
      };
      await api.upsertProvider(final);
      onDone(savedId);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (step === 'preflight') {
    return (
      <div className="qc-panel settings-form">
        <p className="muted small">{checkFailed ? "Couldn't check for Aider." : 'Checking for Aider…'}</p>
        <div className="pv-actions">
          {checkFailed && (
            <button className="btn" onClick={() => setRetryTick((n) => n + 1)}>
              Try again
            </button>
          )}
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step === 'no-runner') {
    return (
      <div className="qc-panel settings-form">
        <p>
          Aider isn't installed — install it with <span className="mono">pipx install aider-chat</span>, then come
          back.
        </p>
        <div className="pv-actions">
          <button className="btn" onClick={() => { setStep('preflight'); setRetryTick((n) => n + 1); }}>
            Check again
          </button>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step === 'where') {
    return (
      <div className="qc-panel settings-form">
        <p>Where does the model run?</p>
        <div className="qc-options">
          <button className="qc-option" onClick={() => setStep('local')}>
            <span className="qc-option-title">On this computer</span>
            <span className="qc-option-sub">A local Ollama server — free, private, no API key.</span>
          </button>
          <button className="qc-option" onClick={() => setStep('hosted')}>
            <span className="qc-option-title">Hosted</span>
            <span className="qc-option-sub">An API endpoint (OpenRouter, Groq, and others) — needs an API key.</span>
          </button>
        </div>
        <div className="pv-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step === 'local') {
    return (
      <div className="qc-panel settings-form">
        <div className="field">
          <label>Ollama server URL</label>
          <input className="mono" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} />
          <span className="hint">The default is right if Ollama runs on this computer.</span>
        </div>
        <div className="pv-actions">
          <button
            className="btn ok"
            disabled={!localUrl.trim()}
            onClick={() => void runSetup(OLLAMA_PRESET, localUrl)}
          >
            Connect
          </button>
          <button className="btn ghost" onClick={() => setStep('where')}>
            Back
          </button>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step === 'hosted') {
    const isCompat = endpoint?.key === OPENAI_COMPAT_KEY;
    const baseUrl = isCompat ? compatUrl : (endpoint?.def.baseUrl ?? '');
    const ready = endpoint !== null && apiKey.trim() !== '' && baseUrl.trim() !== '';
    return (
      <div className="qc-panel settings-form">
        <div className="field">
          <label>Endpoint</label>
          <div className="qc-options">
            {HOSTED_PRESETS.map((p) => (
              <button
                key={p.key}
                className={`qc-option${endpoint?.key === p.key ? ' sel' : ''}`}
                // Clear any pasted key only when actually SWITCHING endpoints — each endpoint
                // stores under a different secret var, so a carried-over key would be saved under
                // the wrong name. Re-clicking the current endpoint is a no-op (keeps the key).
                onClick={() => { if (endpoint?.key !== p.key) { setEndpoint(p); setApiKey(''); } }}
              >
                <span className="qc-option-title">{p.label}</span>
              </button>
            ))}
          </div>
        </div>
        {isCompat && (
          <div className="field">
            <label>Endpoint base URL</label>
            <input className="mono" value={compatUrl} onChange={(e) => setCompatUrl(e.target.value)} />
            <span className="hint">Any OpenAI-compatible server (vLLM, LM Studio, a proxy…).</span>
          </div>
        )}
        {endpoint && (
          <div className="field">
            <label>API key</label>
            <input
              type="password"
              className="mono"
              placeholder="paste your key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <span className="hint">
              About security: the key is stored write-only on this machine and handed to Aider as{' '}
              <span className="mono">{endpoint.secretKey}</span> when it runs, where a running agent could read it.
              You can clear it anytime in Settings → Connections.
            </span>
          </div>
        )}
        <div className="pv-actions">
          <button
            className="btn ok"
            disabled={!ready}
            onClick={() => endpoint && void runSetup(endpoint, baseUrl, apiKey.trim())}
          >
            Connect
          </button>
          <button className="btn ghost" onClick={() => setStep('where')}>
            Back
          </button>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step === 'connecting') {
    return (
      <div className="qc-panel settings-form">
        <p className="muted small">{status}</p>
      </div>
    );
  }

  // step === 'pick'
  const curated = preset?.curatedModels ?? [];
  const roster = discovered.filter((m) => !curated.includes(m.id));
  const modelChip = (id: string) => (
    <button key={id} className={`qc-model mono${picked === id ? ' sel' : ''}`} onClick={() => setPicked(id)}>
      {id}
    </button>
  );
  return (
    <div className="qc-panel settings-form">
      <p>Pick the model Aider should use.</p>
      {notes.map((n, i) => (
        <span key={i} className="pv-inline-warn">
          {n.plain}
          {n.detail && <span className="muted small"> ({n.detail})</span>}
        </span>
      ))}
      {curated.length > 0 && (
        <div className="field">
          <label>Common choices</label>
          <div className="qc-roster">{curated.map(modelChip)}</div>
        </div>
      )}
      {roster.length > 0 && (
        <div className="field">
          <label>{preset?.backend === 'ollama' ? 'Found on your server' : 'All available models'}</label>
          <div className="qc-roster">{roster.map((m) => modelChip(m.id))}</div>
        </div>
      )}
      <div className="field">
        <label>Model</label>
        <input
          className="mono"
          placeholder="pick above or type a model id"
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
        />
      </div>
      <div className="pv-actions">
        <button className="btn ok" disabled={saving || !picked.trim()} onClick={() => void finish()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn ghost" disabled={saving} onClick={() => setStep('where')}>
          Back
        </button>
        <button className="btn ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
