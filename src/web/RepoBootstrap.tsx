// Initialize & push preview + confirm panel (SPEC-INITPUSH). One server preflight powers the whole
// view: detected stacks, the itemized file list, the .gitignore additions, the remote state, and every
// blocking/warning condition. The primary button is disabled while anything is blocking and needs an
// explicit acknowledgment for warnings — the confirm is always a real operator click on this preview.

import { useCallback, useEffect, useState } from 'react';
import { tower } from './api.js';
import type { RepoBootstrapPlan, RepoBootstrapResult } from '../shared/types.js';

const WIDE_LIST: React.CSSProperties = { overflow: 'auto', maxHeight: 220 };
const FILE_PREVIEW = 50;
// Blocking/warning rows carry long detail text (e.g. a full git error). They borrow .chip.hold for the
// amber affordance, but .chip is white-space:nowrap + a pill — which makes a long line overflow the modal
// instead of wrapping. Override to a wrapping callout: inline styles beat the class, so the text stays
// inside the panel. word-break is inherited, so a long unbroken path in the child list wraps too.
const ISSUE_ROW: React.CSSProperties = {
  display: 'block', marginBottom: 4, whiteSpace: 'normal', wordBreak: 'break-word',
  borderRadius: 6, padding: '4px 8px', lineHeight: 1.4,
};

function remoteLine(remote: RepoBootstrapPlan['remote']): string {
  switch (remote.state) {
    case 'empty':
      return 'remote is empty — safe to push the first commit';
    case 'has-refs':
      return `remote already has refs${remote.detail ? ` (${remote.detail})` : ''}`;
    case 'unreachable':
      return `remote unreachable${remote.detail ? ` (${remote.detail})` : ''}`;
    default:
      return 'remote not checked';
  }
}

export function RepoBootstrapPanel({ projectId, onDone, onError }: { projectId: string; onDone: () => void; onError: (m: string) => void }) {
  const [plan, setPlan] = useState<RepoBootstrapPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<RepoBootstrapResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setPlan(await tower.bootstrapPreflight(projectId));
    } catch (e) {
      setLoadError((e as Error).message);
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      setResult(await tower.bootstrapRepo(projectId, ack));
    } catch (e) {
      onError((e as Error).message);
      void load(); // refresh the itemized refusal view
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="settings-form">
        {result.pushed ? (
          <p className="chip question">Pushed branch {result.branch} to GitHub.</p>
        ) : (
          <p className="chip hold">Repo initialized and committed, but the push did not complete.</p>
        )}
        <p className="muted small">{result.detail}</p>
        {result.pushError && <p className="mono small">{result.pushError}</p>}
        <div className="field">
          <button className="btn ok" onClick={onDone}>Done</button>
        </div>
      </div>
    );
  }

  if (loading) return <p className="muted small">Inspecting the project files…</p>;
  if (loadError) {
    return (
      <div className="settings-form">
        <p className="chip hold">Could not load the preview.</p>
        <p className="mono small">{loadError}</p>
        <div className="field"><button className="btn-sm" onClick={() => void load()}>Retry</button></div>
      </div>
    );
  }
  if (!plan) return null;

  const blocked = plan.blocking.length > 0;
  const needsAck = plan.warnings.length > 0 && !ack;

  return (
    <div className="settings-form">
      <div className="field">
        {plan.detectedStacks.length > 0
          ? plan.detectedStacks.map((s) => <span key={s} className="chip">{s}</span>)
          : <span className="chip">generic</span>}
        <span className="chip">branch {plan.branch}</span>
      </div>
      <p className="muted small">
        {plan.identity ? `pushing as "${plan.identity.label}"${plan.identity.hasCredential ? '' : ' (no push token)'}` : 'no push identity set'}
        {plan.repoUrl ? ` → ${plan.repoUrl}` : ''}
      </p>
      <p className="muted small">{remoteLine(plan.remote)}</p>

      {blocked && (
        <div className="field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {plan.blocking.map((b, i) => (
            <div key={`${b.code}-${i}`} className="chip hold" style={ISSUE_ROW}>
              <strong>{b.code}</strong> — {b.detail}
              {b.paths && b.paths.length > 0 && <div className="mono small">{b.paths.join(', ')}</div>}
            </div>
          ))}
        </div>
      )}

      {plan.warnings.length > 0 && (
        <div className="field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {plan.warnings.map((w, i) => (
            <div key={`${w.code}-${i}`} className="chip hold" style={ISSUE_ROW}>
              <strong>{w.code}</strong> — {w.detail}
              {w.paths && w.paths.length > 0 && <div className="mono small">{w.paths.join(', ')}</div>}
            </div>
          ))}
          <label className="muted small">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Proceed despite the warnings above
          </label>
        </div>
      )}

      <div className="field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <span className="muted small">.gitignore additions</span>
        <pre className="mono small" style={WIDE_LIST}>
          {plan.gitignoreAppend.length > 0 ? plan.gitignoreAppend.join('\n') : 'no changes — every pattern already present'}
        </pre>
      </div>

      <div className="field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <span className="muted small">{plan.fileTotal} file(s) would be committed{plan.truncated ? ' (list truncated)' : ''} · .local-context/ stays local</span>
        <div className="mono small" style={WIDE_LIST}>
          {plan.filesToCommit.slice(0, FILE_PREVIEW).map((f) => <div key={f.path}>{f.path}</div>)}
          {plan.filesToCommit.length > FILE_PREVIEW && <div className="muted">…{plan.filesToCommit.length - FILE_PREVIEW} more</div>}
        </div>
      </div>

      <div className="field">
        <button className="btn ok" disabled={busy || blocked || needsAck} onClick={() => void confirm()}>
          {busy ? 'Initializing…' : 'Initialize & push'}
        </button>
      </div>
    </div>
  );
}
