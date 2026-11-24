// Control Tower — Test runs panel (SPEC-TESTING §6, BS-W). The run list off GET /api/testruns:
// failed/total per run, per-failure artifact links (screenshots/traces copied at release), and
// the manual "File failures as tasks" button (§5 — POST /api/testruns/:id/file-failures, which
// works on gate runs too; the server 409s when a run has no parsed results, never fabricates).
//
// SELF-CONTAINED behind a props-injected api object (the StoriesView/ProvidersPanel idiom): the
// integrator wires listRuns → tower.testRuns, fileFailures → tower.fileTestFailures, and
// downloadArtifact → tower.downloadTestArtifact (the artifact route is header-token gated, so a
// plain <a href> would 401 — the client helper fetches with X-Tower-Token and saves via a blob).
// Like the dock's RunsSection it polls: test runs have no SSE frame today.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, TestFailure } from '../shared/types.js';
import { triageCounts } from '../shared/types.js';
import { isImageArtifact, mimeForImage, type TestRunInfo } from './api.js';
import { timeAgo } from './flightline-utils.js';

export type TestRunsApi = {
  /** GET /api/testruns — the full run list, newest first (the dock RunsSection source). */
  listRuns: () => Promise<TestRunInfo[]>;
  /** POST /api/testruns/:id/file-failures (SPEC-TESTING §5) — {created, skipped}. */
  fileFailures: (runId: string) => Promise<{ created: number; skipped: number }>;
  /** POST /api/testruns/:id/summarize (SPEC-TESTING-V2 §1) — on-demand LLM triage digest
   *  (display-only). 409 when the run has no parsed failures / one is already in flight; 503 when
   *  no assistant Brain. Idempotent (returns any existing summary) — `force` regenerates instead. */
  summarize: (runId: string, force?: boolean) => Promise<{ summary: string }>;
  /** GET /api/testruns/:id/artifacts/:name (SPEC-TESTING §6) — token-header fetch + blob save. */
  downloadArtifact: (runId: string, name: string) => Promise<void>;
  /** GET /api/testruns/:id/logs/:name (SPEC-LOOP W5) — token-header fetch + blob save of a captured
   *  server/docker log tail (contents are secret, so the route is session-token only). */
  downloadLog: (runId: string, name: string) => Promise<void>;
  /** GET /api/testruns/:id/artifacts/:name (SPEC-TESTING-V2 §5) — token-header fetch of the raw
   *  BYTES for the in-app image thumbnail (the caller builds/revokes the object URL). */
  fetchArtifactBlob: (runId: string, name: string) => Promise<ArrayBuffer>;
};

export function TestRunsPanel({
  projects,
  api,
  onError,
  onFeed,
}: {
  projects: Project[];
  api: TestRunsApi;
  onError: (m: string) => void;
  /** Optional feed toast (App's pushFeed) — "filed N · skipped M" rides the ticker too. */
  onFeed?: (kind: string, text: string) => void;
}) {
  const [runs, setRuns] = useState<TestRunInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // Only surface the FIRST failure (a poll loop must not re-toast every 6s) — ref, not state,
  // so the check is synchronous and safe under strict-mode double-invocation.
  const surfaced = useRef(false);

  const load = useCallback(async () => {
    try {
      setRuns(await api.listRuns());
      setFailed(false);
      surfaced.current = false;
    } catch (e) {
      setFailed(true);
      if (!surfaced.current) {
        surfaced.current = true;
        onError((e as Error).message);
      }
    }
  }, [api, onError]);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 6000);
    return () => clearInterval(id);
  }, [load]);

  const projName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="flightline">
      <div className="view-title">
        <h1>Test runs</h1>
        <span className="sub">
          {runs ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : 'loading…'} · e2e kit history — artifacts + failures → backlog
        </span>
      </div>

      {failed && runs === null ? (
        <div className="muted small">
          Couldn’t load test runs. <button className="btn-sm" onClick={() => void load()}>retry</button>
        </div>
      ) : runs === null ? (
        <div className="muted small">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="tr-empty">
          No test runs yet. Runs appear here when an agent executes <span className="mono">towerctl test run</span> (or a
          mission’s regression gate fires). Each parsed run carries its failures, their artifacts, and a one-click
          “File failures as tasks” into the backlog.
        </div>
      ) : (
        <div className="tr-list">
          {runs.map((r) => (
            <TestRunRow
              key={r.id}
              run={r}
              projectName={projName(r.projectId)}
              expanded={open === r.id}
              onToggle={() => setOpen((cur) => (cur === r.id ? null : r.id))}
              api={api}
              onError={onError}
              onFeed={onFeed}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TestRunRow({
  run,
  projectName,
  expanded,
  onToggle,
  api,
  onError,
  onFeed,
}: {
  run: TestRunInfo;
  projectName: string;
  expanded: boolean;
  onToggle: () => void;
  api: TestRunsApi;
  onError: (m: string) => void;
  onFeed?: (kind: string, text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // The last file-failures outcome, kept inline on the row (the poll refetch preserves it —
  // this component keys on run.id, so React state survives list replacement).
  const [filed, setFiled] = useState<{ created: number; skipped: number } | null>(null);
  // SPEC-TESTING-V2 §1 — the LLM triage digest. A locally-set value (freshest, after a
  // re-summarize) wins over the poll-provided `run.summary`; either renders in the expanded body.
  const [summarizing, setSummarizing] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const shownSummary = summary ?? run.summary ?? null;

  // `results !== undefined` distinguishes an all-green run ([]) from a reporter-not-wired run.
  const parsed = run.results !== undefined;
  const failures = run.results ?? [];
  // Only failures are triageable (a green/no-parse run has nothing to summarize; the route 409s).
  const canSummarize = parsed && (run.failed ?? 0) > 0;

  const fileFailures = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.fileFailures(run.id);
      setFiled(r);
      onFeed?.('testrun', `${run.id} — filed ${r.created} task${r.created === 1 ? '' : 's'}, skipped ${r.skipped}`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // `force` bypasses the route's idempotent stored-summary return — the Re-summarize path must
  // actually regenerate, while the first summarize is happy to take an existing digest.
  const summarize = async (force: boolean) => {
    if (summarizing) return;
    setSummarizing(true);
    try {
      const r = await api.summarize(run.id, force);
      setSummary(r.summary);
      // The digest lives in the expanded body — open the row so the operator sees the result.
      if (!expanded) onToggle();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSummarizing(false);
    }
  };

  const st = run.status;
  return (
    <div className="tr-row-wrap">
      <div className="tr-row">
        <span className={`tr-dot ${st}`} />
        <span className="mono tr-id">{run.id}</span>
        <span className="muted small">{projectName}</span>
        {run.kind === 'gate' && <span className="chip" title="A regression-gate run (in-process trial-merge suite), not an agent's kit run.">gate</span>}
        <span className="spacer" />
        {parsed ? (
          <span className={`tr-count ${run.failed ? 'bad' : 'ok'}`}>
            {run.failed ?? 0} failed / {run.total ?? 0}
          </span>
        ) : (
          <span className="tr-count faint" title="The Playwright JSON reporter wasn't wired for this run — no structured results.">no parsed results</span>
        )}
        <span className="muted small">{timeAgo(run.finishedAt ?? run.startedAt)}</span>
        <button
          className="btn-sm"
          disabled={summarizing || !canSummarize}
          title={canSummarize
            ? (shownSummary ? 'Re-run the LLM triage over this run’s failures' : 'LLM-triage this run’s failures into a root-cause digest')
            : 'Only runs with parsed failures can be summarized'}
          onClick={() => void summarize(!!shownSummary)}
        >
          {summarizing ? '…' : `✦ ${shownSummary ? 'Re-summarize' : 'Summarize failures'}`}
        </button>
        <button
          className="btn-sm"
          disabled={busy || !parsed}
          title={parsed ? 'File this run’s failures to the backlog (dedup by title; archived don’t block re-filing)' : 'No parsed results to file (the server refuses to fabricate)'}
          onClick={() => void fileFailures()}
        >
          {busy ? '…' : 'File failures as tasks'}
        </button>
        <button className="btn-sm" onClick={onToggle}>{expanded ? 'close' : `failures${parsed ? ` (${failures.length})` : ''}`}</button>
      </div>
      {filed && (
        <div className="tr-filed">
          filed {filed.created} task{filed.created === 1 ? '' : 's'} · skipped {filed.skipped} duplicate{filed.skipped === 1 ? '' : 's'} — see the Board’s triage lane
        </div>
      )}
      {expanded && (
        <div className="tr-body">
          {shownSummary && (
            <div className="tr-summary" title="LLM triage digest — display only, not fed to fixers">
              <span className="tr-summary-tag">✦ triage</span>
              {shownSummary}
            </div>
          )}
          {run.logs && run.logs.length > 0 && (
            <div className="tr-logs">
              <span className="tr-logs-tag muted small">captured logs</span>
              {run.logs.map((name) => (
                <button
                  key={name}
                  className="tr-artifact mono"
                  title={`Download ${name} (server/docker log tail captured at release — may contain secrets)`}
                  onClick={() => void api.downloadLog(run.id, name).catch((e) => onError((e as Error).message))}
                >
                  ⤓ {name}
                </button>
              ))}
            </div>
          )}
          {/* SPEC-LOOP W7 — the false-fail investigator's classifications. Operator-visible surface for the
              suppressions even when no delivery report generates (e.g. a mission parked at attention). */}
          {run.triage && run.triage.length > 0 && (() => {
            // Occurrence-granularity counts (the shared triageCounts) so they match the report/fixer; the
            // LIST is the deduped by-design/false entries (unique tests).
            const counts = triageCounts(run.results ?? [], run.triage);
            const suppressed = run.triage.filter((t) => t.class === 'by-design' || t.class === 'false');
            return (
              <div className="tr-logs muted small">
                <span className="tr-logs-tag muted small" title="Routed investigator's false-fail triage — display only; only 'real' failures are handed to fixers.">false-fail triage</span>
                {' '}{counts.real} real · {counts.byDesign + counts.falseFails} suppressed
                {suppressed.length > 0 && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {suppressed.map((t, i) => (
                      <li key={i}>[{t.class}] {t.specFile} › {t.testTitle}{t.reason ? ` — ${t.reason}` : ''}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })()}
          {!parsed ? (
            <div className="muted small">No structured results for this run.</div>
          ) : failures.length === 0 ? (
            <div className="muted small">All green — {run.total ?? 0} test{run.total === 1 ? '' : 's'} passed.</div>
          ) : (
            failures.map((f, i) => (
              <FailureRow key={i} runId={run.id} failure={f} api={api} onError={onError} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FailureRow({
  runId,
  failure,
  api,
  onError,
}: {
  runId: string;
  failure: TestFailure;
  api: TestRunsApi;
  onError: (m: string) => void;
}) {
  const [showTail, setShowTail] = useState(false);
  const artifacts = failure.artifacts ?? [];
  return (
    <div className="tr-failure">
      <div className="tr-failure-head">
        <span className="mono small tr-spec">{failure.specFile}</span>
        <span className="tr-sep">›</span>
        <span className="small tr-title">{failure.testTitle}</span>
        <span className="spacer" />
        {failure.errorTail && (
          <button className="btn-sm ghost" onClick={() => setShowTail((v) => !v)}>{showTail ? 'hide error' : 'error'}</button>
        )}
      </div>
      {artifacts.length > 0 && (
        <div className="tr-artifacts">
          {artifacts.map((name) => (
            // §5 — allowlisted images render as an in-app thumbnail (lazy: this row mounts only on
            // expand); everything else (incl. SVG) keeps the download chip.
            isImageArtifact(name) ? (
              <ArtifactThumb key={name} runId={runId} name={name} api={api} onError={onError} />
            ) : (
              <button
                key={name}
                className="tr-artifact mono"
                title={`Download ${name} (screenshot / trace copied at release)`}
                onClick={() => void api.downloadArtifact(runId, name).catch((e) => onError((e as Error).message))}
              >
                ⤓ {name}
              </button>
            )
          ))}
        </div>
      )}
      {showTail && failure.errorTail && <div className="tail">{failure.errorTail}</div>}
    </div>
  );
}

// SPEC-TESTING-V2 §5 — an in-app image thumbnail for an allowlisted artifact. The artifacts route
// is header-token gated (a plain <img src> would 401), so we token-fetch the raw BYTES and render
// from a blob object URL. The object URL is created inside the effect and REVOKED in its
// cleanup — NEVER in the render body (the panel's 6s poll re-renders every row and would leak the
// URLs). The Blob is typed from OUR ext allowlist (mimeForImage), never the server
// Content-Type — a polyglot named .png fails the image decoder (broken image) rather than scripting.
// While the bytes load (or if the fetch fails) it degrades to the same download chip.
function ArtifactThumb({
  runId,
  name,
  api,
  onError,
}: {
  runId: string;
  name: string;
  api: TestRunsApi;
  onError: (m: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objUrl: string | null = null;
    api
      .fetchArtifactBlob(runId, name)
      .then((bytes) => {
        if (cancelled) return; // unmounted / re-keyed before the fetch resolved — create nothing
        objUrl = URL.createObjectURL(new Blob([bytes], { type: mimeForImage(name) }));
        setUrl(objUrl);
      })
      .catch(() => {
        // Silent degrade — `url` stays null, so the row keeps the download chip below. An
        // auto-fetch failure on row-expand (transient network, a token refresh, a reaped
        // artifact) must not hit the global error bar; a click-initiated download still
        // surfaces its own error via the chip's handler.
      });
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
      setUrl(null); // drop the (now-revoked) URL if the deps changed on a live instance
    };
    // Keyed on [runId, name] only — api/onError are stable per row; re-running per render
    // would re-fetch each artifact on every 6s poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, name]);

  if (!url) {
    return (
      <button
        className="tr-artifact mono"
        title={`Download ${name} (screenshot / trace copied at release)`}
        onClick={() => void api.downloadArtifact(runId, name).catch((e) => onError((e as Error).message))}
      >
        ⤓ {name}
      </button>
    );
  }
  return (
    <button
      className="tr-thumb"
      title={`${name} — click to download`}
      onClick={() => void api.downloadArtifact(runId, name).catch((e) => onError((e as Error).message))}
    >
      <img src={url} alt={name} className="tr-thumb-img" />
    </button>
  );
}
