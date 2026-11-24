// Review & Land (SPEC §10). The surface that consumes a worktree agent's output:
// see the diff (branch vs base), request changes (inject a prompt), and land via a
// guarded local merge or a PR. Dirty worktrees are surfaced, never silently removed.

import { useCallback, useEffect, useState } from 'react';
import type { DiffSummary } from '../shared/types.js';
import { tower } from './api.js';

export function ReviewPanel({ terminalId }: { terminalId: string }) {
  const [review, setReview] = useState<DiffSummary | null>(null);
  const [patch, setPatch] = useState<string>('');
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [changeReq, setChangeReq] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await tower.review(terminalId);
      setReview(r);
      setMsg(null);
      setPrUrl(null); // a fresh (re)load clears any prior PR link
      const first = r.files[0]?.path ?? null;
      setActiveFile(first);
      setPatch(await tower.patch(terminalId, first ?? undefined));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, [terminalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const showFile = async (file: string) => {
    setActiveFile(file);
    try {
      setPatch(await tower.patch(terminalId, file));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const out = await fn();
      await load(); // refresh first (this clears msg + prUrl) …
      // … then apply the outcome AFTER the refresh so it isn't wiped (the PR link must survive load()).
      const o = (out && typeof out === 'object' ? out : {}) as { msg?: string; prUrl?: string | null };
      if (o.prUrl !== undefined) setPrUrl(o.prUrl);
      const outMsg = o.msg ?? ok;
      if (outMsg) setMsg(outMsg);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!review) {
    return <div className="review"><div className="review-msg">{msg ?? 'Loading review…'}</div></div>;
  }

  return (
    <div className="review">
      <div className="review-head">
        <div>
          <span className="mono">{review.branch}</span>
          <span className="muted"> → {review.base}</span>
          {review.dirty && <span className="chip permission" style={{ marginLeft: 8 }}>uncommitted</span>}
        </div>
        <div className="review-meta muted">
          {review.commits.length} commit{review.commits.length === 1 ? '' : 's'} · {review.files.length} file{review.files.length === 1 ? '' : 's'}
        </div>
      </div>

      {msg && <div className="review-msg">{msg}</div>}
      {prUrl && <div className="review-msg"><a href={prUrl} target="_blank" rel="noreferrer">view PR</a></div>}

      <div className="review-body">
        <div className="review-files">
          {review.commits.length > 0 && (
            <div className="review-commits">
              {review.commits.map((c) => (
                <div key={c.sha} className="commit"><span className="mono muted">{c.sha}</span> {c.subject}</div>
              ))}
            </div>
          )}
          {review.files.map((f) => (
            <button key={f.path} className={`file-row ${activeFile === f.path ? 'active' : ''}`} onClick={() => showFile(f.path)}>
              <span className="file-path mono">{f.path}</span>
              <span className="file-stat"><span className="add">+{f.added}</span> <span className="del">−{f.removed}</span></span>
            </button>
          ))}
          {review.files.length === 0 && <div className="muted" style={{ padding: 8 }}>No committed changes vs base.</div>}
        </div>
        <pre className="review-diff">{renderDiff(patch)}</pre>
      </div>

      <div className="review-actions">
        <input
          className="attn-reply"
          placeholder="request changes (sends a prompt to the agent)…"
          value={changeReq}
          disabled={busy}
          onChange={(e) => setChangeReq(e.target.value)}
        />
        <button className="btn-sm" disabled={busy || !changeReq.trim()} onClick={() => act(() => tower.requestChanges(terminalId, changeReq), 'sent to agent')}>
          request changes
        </button>
        <span className="spacer" />
        <button className="btn-sm ok" disabled={busy} onClick={() => act(() => tower.land(terminalId, 'merge'), 'merged into base')}>
          merge
        </button>
        <button
          className="btn-sm"
          disabled={busy}
          onClick={() => act(async () => {
            const r = await tower.land(terminalId, 'pr');
            return { msg: r.detail, prUrl: r.prUrl ?? null };
          })}
        >
          Open PR
        </button>
        <button className="btn-sm danger" disabled={busy} onClick={() => act(() => tower.removeWorktree(terminalId), 'worktree removed')}>
          remove
        </button>
      </div>
    </div>
  );
}

function renderDiff(patch: string) {
  if (!patch) return [<span key="empty" className="muted">Select a file to see its diff.</span>];
  return patch.split('\n').map((line, i) => {
    let cls = 'd-ctx';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'd-add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'd-del';
    else if (line.startsWith('@@')) cls = 'd-hunk';
    else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) cls = 'd-meta';
    return <span key={i} className={cls}>{line || ' '}{'\n'}</span>;
  });
}
