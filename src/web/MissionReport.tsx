// Control Tower — Mission delivery report (SPEC-LOOP W4). Rendered under a done|failed mission's
// detail. §3 W4: we render React FROM the report JSON — NEVER dangerouslySetInnerHTML, NEVER an
// iframe of REPORT.html (the .html is download-only). generate() runs SYNCHRONOUSLY at the terminal
// transition, so report.json is on disk before the done/failed SSE — a fresh mission always has its
// report. A 404 therefore means it was never written (a crash mid-generate) or was pruned (a very old
// mission past the report-retention window): show an honest "not available", never a broken link.

import { useEffect, useState } from 'react';
import type { Mission, MissionReport, MissionRoundRecord } from '../shared/types.js';
import { tower } from './api.js';

/** A round's verify verdict as short text (mirrors report.ts roundResultText). */
function roundResult(rd: MissionRoundRecord): { text: string; tone: 'green' | 'red' | 'none' } {
  if (typeof rd.failed !== 'number') return { text: 'not evaluated', tone: 'none' };
  if (rd.failed === 0) {
    return { text: rd.total !== undefined ? `green ${rd.total}/${rd.total}` : 'green', tone: 'green' };
  }
  return { text: rd.total !== undefined ? `${rd.failed} failing / ${rd.total}` : `${rd.failed} failing`, tone: 'red' };
}

export function MissionReportSection({ mission }: { mission: Mission }) {
  const terminal = mission.status === 'done' || mission.status === 'failed';
  const [report, setReport] = useState<MissionReport | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'pending' | 'error'>('loading');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!terminal) return;
    let cancelled = false;
    setState('loading');
    tower.getMissionReport(mission.id)
      .then((r) => {
        if (cancelled) return;
        if (r) { setReport(r); setState('ready'); }
        else { setReport(null); setState('pending'); }
      })
      .catch((e) => { if (!cancelled) { setErr((e as Error).message); setState('error'); } });
    return () => { cancelled = true; };
    // Re-key on status so a mission that just flipped to done/failed re-fetches its fresh report.
  }, [mission.id, mission.status, terminal]);

  const downloadProof = async (name: string) => {
    try {
      const blob = await tower.fetchMissionProofBlob(mission.id, name);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const downloadHtml = () => {
    void tower.downloadMissionReportHtml(mission.id).catch((e) => setErr((e as Error).message));
  };

  if (!terminal) return null;

  return (
    <div className="msn-report" style={{ margin: '12px 0' }}>
      <div className="msn-phase-head" style={{ marginBottom: 8 }}>
        <span className="msn-phase-n">Delivery report</span>
        <div style={{ flex: 1 }} />
        {state === 'ready' && (
          <button className="btn sm" onClick={downloadHtml}>Download REPORT.html</button>
        )}
      </div>

      {state === 'loading' && <p className="muted small">Loading report…</p>}
      {state === 'pending' && (
        <p className="muted small">No delivery report is available for this mission — it may have finished before this feature, been interrupted mid-write, or aged out of the report-retention window.</p>
      )}
      {state === 'error' && <p className="muted small">Could not load the report: {err}</p>}

      {state === 'ready' && report && (
        <div className="msn-phase" style={{ padding: 12 }}>
          {err && <p className="muted small">{err}</p>}
          <div className="muted small" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
            <span>status <b>{report.status}</b></span>
            <span>finished {new Date(report.finishedAt).toLocaleString()}</span>
            {report.baseSha && <span className="mono">base {report.baseSha.slice(0, 10)}</span>}
            {report.gateRunId && <span className="mono">final gate {report.gateRunId}</span>}
          </div>

          {report.rounds.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '0 0 12px' }}>
              <span className="muted small" style={{ marginRight: 2 }}>rounds</span>
              {report.rounds.map((rd) => {
                const res = roundResult(rd);
                const bg = res.tone === 'green' ? 'rgba(60,180,90,0.18)'
                  : res.tone === 'red' ? 'rgba(210,70,70,0.18)' : 'transparent';
                return (
                  <span key={rd.n} title={`round ${rd.n} — ${rd.kind}`} style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 10, background: bg,
                    border: '1px solid rgba(127,127,127,0.3)', whiteSpace: 'nowrap',
                  }}>
                    R{rd.n} · {rd.kind} · {res.text}
                  </span>
                );
              })}
            </div>
          )}

          {/* SPEC-LOOP W6 — the Code review section (React-from-JSON; between Rounds and Phases). Hidden
              when report.reviews is absent (an old report renders unchanged). A clean review shows the
              verbatim attested wording only for a findings-empty record (attestedClean). */}
          {report.reviews && report.reviews.length > 0 && (
            <div style={{ margin: '0 0 12px' }}>
              <div className="muted small" style={{ marginBottom: 4 }}>Code review</div>
              {report.reviews.map((rv, i) => (
                <div key={i} style={{ margin: '0 0 8px' }}>
                  <div className="small">
                    <b>{rv.sortie}</b>
                    {rv.round !== undefined ? ` · round ${rv.round}` : ''}
                    {' · '}
                    {rv.attestedClean
                      ? <span>clean — attested by the reviewer, not machine-verified</span>
                      : <span>{rv.confirmed} confirmed, {rv.plausible} plausible</span>}
                  </div>
                  {!rv.attestedClean && rv.findings.length > 0 && (
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {rv.findings.map((f, j) => (
                        <li key={j} className="muted small">
                          {f.line !== undefined ? `${f.file}:${f.line}` : f.file} — {f.summary}
                          {f.verdict ? ` [${f.verdict}]` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* SPEC-RESEARCH W9 — the Research findings block. THIS is the "findings must be visible"
              surface: a research sortie's whole deliverable is this text, so the full summary renders
              (pre-wrapped, so the agent's own structure survives). Citations are refs the operator can
              follow — never fetched by the Tower. Hidden when report.research is absent (a pre-W9
              report renders unchanged). */}
          {report.research && report.research.length > 0 && (
            <div style={{ margin: '0 0 12px' }}>
              <div className="muted small" style={{ marginBottom: 4 }}>Research findings</div>
              {report.research.map((rc, i) => (
                <div key={i} style={{ margin: '0 0 10px' }}>
                  <div className="small">
                    <b>{rc.topic || '(untitled)'}</b>
                    {rc.round !== undefined ? ` · round ${rc.round}` : ''}
                    <span className="muted"> · {rc.submittedAt}</span>
                  </div>
                  <div className="small" style={{ whiteSpace: 'pre-wrap', margin: '2px 0 0' }}>{rc.summary}</div>
                  {rc.citations && rc.citations.length > 0 && (
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {rc.citations.map((c, j) => (
                        <li key={j} className="muted small">{c.ref}{c.note ? ` — ${c.note}` : ''}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* SPEC-LOOP W7 — the Investigations audit block (React-from-JSON; order: Rounds → Code review →
              Investigations). Triage never entered the verdict; this lists the suppressed failures for
              operator audit. Hidden when report.investigations is absent (old reports render unchanged). */}
          {report.investigations && report.investigations.length > 0 && (
            <div style={{ margin: '0 0 12px' }}>
              <div className="muted small" style={{ marginBottom: 4 }}>Investigations</div>
              {report.investigations.map((inv, i) => (
                <div key={i} style={{ margin: '0 0 8px' }}>
                  <div className="small">
                    <b>Round {inv.round}</b> · {inv.real} real · {inv.byDesign} by-design · {inv.falseFails} false
                  </div>
                  {inv.suppressed.length > 0 && (
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {inv.suppressed.map((s, j) => (
                        <li key={j} className="muted small">
                          [{s.class}] {s.specFile} › {s.testTitle}{s.reason ? ` — ${s.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="msn-report-phases">
            {report.phases.map((p, i) => (
              <div key={i} style={{ margin: '0 0 10px' }}>
                <div className="muted small" style={{ marginBottom: 4 }}>
                  <b>Phase {i + 1}: {p.title}</b>
                  {p.stage ? ` · ${p.stage}` : ''}{p.round !== undefined ? ` · round ${p.round}` : ''}
                </div>
                {p.sorties.length === 0
                  ? <span className="msn-empty small">no sorties</span>
                  : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {p.sorties.map((s, j) => {
                        // SPEC-EFFORT §5 — effort as a labeled '@' suffix, not a third '/' segment.
                        const base = [s.provider, s.model].filter(Boolean).join(' / ');
                        const route = base && s.effort ? `${base} @ ${s.effort}` : base;
                        return (
                          <span key={j} className="msn-chip" style={{ fontSize: 11 }}
                            title={s.branch ? `branch ${s.branch}` : undefined}>
                            {s.name} · {s.status}{route ? ` · ${route}` : ''}
                          </span>
                        );
                      })}
                    </div>
                  )}
              </div>
            ))}
          </div>

          {report.proof.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="muted small" style={{ marginBottom: 4 }}>Proof ({report.proof.length})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {report.proof.map((pr) => (
                  <button key={pr.name} className="btn sm" onClick={() => void downloadProof(pr.name)}
                    title={`${pr.kind} · ${pr.bytes} bytes`}>
                    ↓ {pr.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
