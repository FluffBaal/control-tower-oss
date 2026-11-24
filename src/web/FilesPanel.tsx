// Control Tower — Project Files (SPEC-FILES §5). Tree (left, the .review-files idiom) + viewer
// (right). Browses ONE scope: the project repo root, or — when `scope.terminalId` is set — that
// agent's worktree ("what this agent is building" vs the Files view's "what landed"). Text renders
// in a plain monospace <pre> with a CSS-counter line gutter (the ReviewPanel renderDiff idiom — NO
// syntax highlighting in v1); small images arrive base64 inline; anything else gets a download
// card via the raw route. `.html/.htm` adds a [code | preview] toggle that mounts the artifact in
// the isolated /preview sandbox. VIEW-ONLY (§8) — no write/edit affordance anywhere.
//
// SECURITY INVARIANT: this module must NOT register a window 'message' listener.
// The preview iframe is one-way — the parent never listens, so a hostile artifact has no
// postMessage channel through which to phish the token or app state. Keep it that way.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileContent, FileEntry, PreviewMintResponse } from '../shared/types.js';
import { tower } from './api.js';

export interface FilesScope {
  projectId: string;
  /** Set → browse this terminal's worktree (`wt=term:<id>`); absent → the project repo root. */
  terminalId?: string;
}

type DirState = { entries: FileEntry[]; truncated: boolean } | 'loading' | 'error';

type Row =
  | { kind: 'entry'; path: string; entry: FileEntry; depth: number }
  | { kind: 'note'; id: string; text: string; depth: number; retryDir?: string };

function fmtSize(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}k`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}G`;
}
const isHtml = (p: string) => /\.html?$/i.test(p);
const basename = (p: string) => p.split('/').slice(-1)[0] ?? p;
// Above this line count, render the text as a single <pre> (no per-line gutter spans): a near-cap
// 1 MiB file is ~20-35k lines, and one span per line would mount that many DOM nodes on the main
// thread on open and again on every wrap toggle.
const LINE_SPAN_CAP = 5000;

/** Heavy dirs (node_modules/dist/…) sort last, dimmed, never auto-expanded — the server flags
 *  them; the client only re-orders (stable sort keeps the server's dirs-first alpha within groups). */
function sortHeavyLast(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => Number(a.heavy ?? false) - Number(b.heavy ?? false));
}

export function FilesPanel({ scope, onError }: { scope: FilesScope; onError: (m: string) => void }) {
  // ---- tree state: lazy per-dir cache + expansion set + roving focus ----
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [rootMeta, setRootMeta] = useState<{ root: 'repo' | 'worktree'; rootLabel: string } | null>(null);
  const [focusPath, setFocusPath] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  // Stale worktree target (removed/landed) → the root list 409s; fall back to the repo root
  // with a banner instead of a dead pane (SPEC-FILES §7).
  const [wtGone, setWtGone] = useState(false);
  const wt = scope.terminalId && !wtGone ? scope.terminalId : undefined;
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // Monotonic scope token: bumped on every scope change (incl. the wtGone fallback flip). A listFiles
  // in flight for the old scope compares against it and drops its write, so a stale worktree fetch
  // can't clobber the fresh repo-root cache after the fallback.
  const scopeTok = useRef(0);

  // Full reset when the scope changes (also covers the wtGone fallback flip via `wt`).
  useEffect(() => {
    scopeTok.current++;
    setDirs(new Map()); setExpanded(new Set()); setRootMeta(null);
    setFocusPath(''); setSelected(null);
  }, [scope.projectId, wt]);
  useEffect(() => { setWtGone(false); }, [scope.projectId, scope.terminalId]);

  // Lazy loader: the root plus every expanded dir without a cache entry gets fetched. ⟳ refresh
  // just drops the cache — this effect refills whatever is still expanded on screen.
  useEffect(() => {
    const need = ['', ...expanded].filter((d) => !dirs.has(d));
    if (need.length === 0) return;
    setDirs((m) => { const n = new Map(m); for (const d of need) n.set(d, 'loading'); return n; });
    const tok = scopeTok.current;
    for (const d of need) {
      tower.listFiles(scope.projectId, d, wt)
        .then((l) => {
          if (scopeTok.current !== tok) return; // scope changed since the fetch started — drop it
          setDirs((m) => new Map(m).set(d, { entries: l.entries, truncated: l.truncated }));
          if (d === '') setRootMeta({ root: l.root, rootLabel: l.rootLabel });
        })
        .catch((e) => {
          if (scopeTok.current !== tok) return;
          const msg = (e as Error).message;
          if (d === '' && wt && /-> 409/.test(msg)) { setWtGone(true); return; }
          setDirs((m) => new Map(m).set(d, 'error'));
          if (d === '') onError(msg);
        });
    }
  }, [expanded, dirs, scope.projectId, wt, onError]);

  const refresh = () => { setDirs(new Map()); setRootMeta(null); };
  const retryDir = (d: string) => setDirs((m) => { const n = new Map(m); n.delete(d); return n; });
  const toggleDir = (p: string) =>
    setExpanded((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  // Flattened visible rows (entries + inline loading/error/empty/truncated notes).
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const st = dirs.get(dir);
      if (st === undefined || st === 'loading') { out.push({ kind: 'note', id: `${dir}\0loading`, text: 'loading…', depth }); return; }
      if (st === 'error') { out.push({ kind: 'note', id: `${dir}\0error`, text: 'failed to list — retry', depth, retryDir: dir }); return; }
      if (st.entries.length === 0) { out.push({ kind: 'note', id: `${dir}\0empty`, text: 'empty', depth }); return; }
      for (const e of sortHeavyLast(st.entries)) {
        const p = dir ? `${dir}/${e.name}` : e.name;
        out.push({ kind: 'entry', path: p, entry: e, depth });
        if (e.type === 'dir' && expanded.has(p)) walk(p, depth + 1);
      }
      if (st.truncated) out.push({ kind: 'note', id: `${dir}\0trunc`, text: 'listing truncated (entry cap)', depth });
    };
    walk('', 0);
    return out;
  }, [dirs, expanded]);
  const entryRows = useMemo(() => rows.filter((r): r is Extract<Row, { kind: 'entry' }> => r.kind === 'entry'), [rows]);
  // Roving tabindex target: the focused path if visible, else the first entry row.
  const tabPath = entryRows.some((r) => r.path === focusPath) ? focusPath : entryRows[0]?.path;

  // Move the roving focus: state for the tabindex AND imperative DOM focus (an effect on
  // focusPath alone misses the no-op case where state already points at the target row).
  const focusRow = (p: string) => { setFocusPath(p); rowRefs.current.get(p)?.focus(); };

  const activate = (row: Extract<Row, { kind: 'entry' }>) => {
    setFocusPath(row.path);
    if (row.entry.type === 'dir') toggleDir(row.path);
    else if (row.entry.broken) onError(`${row.path}: broken symlink`);
    else setSelected(row.path);
  };

  // Keyboard nav (roving tabindex): ↑/↓ move, → expand / step in, ← collapse / step to parent,
  // Enter opens a file or toggles a dir.
  const onTreeKey = (e: React.KeyboardEvent) => {
    if (entryRows.length === 0) return;
    // Anchor on the row that actually holds DOM focus (the event target), falling back to the
    // roving tab target — they can diverge if focus arrived by any path other than ↑/↓/click.
    const tp = (e.target as HTMLElement).dataset?.path ?? tabPath ?? '';
    const cur = Math.max(0, entryRows.findIndex((r) => r.path === tp));
    const row = entryRows[cur];
    if (!row) return;
    const go = (i: number) => {
      const t = entryRows[Math.max(0, Math.min(entryRows.length - 1, i))];
      if (t) focusRow(t.path);
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); go(cur + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(cur - 1); }
    else if (e.key === 'ArrowRight') {
      if (row.entry.type !== 'dir') return;
      e.preventDefault();
      if (!expanded.has(row.path)) toggleDir(row.path); else go(cur + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (row.entry.type === 'dir' && expanded.has(row.path)) toggleDir(row.path);
      else {
        const parent = row.path.split('/').slice(0, -1).join('/');
        if (parent) focusRow(parent);
      }
    } else if (e.key === 'Enter') { e.preventDefault(); activate(row); }
  };

  return (
    <div className="files-panel">
      <div className="files-tree" role="tree" aria-label="Project files" onKeyDown={onTreeKey}>
        <div className="files-tree-head">
          <span className="files-root mono" title={rootMeta ? `${rootMeta.root} root` : undefined}>
            {rootMeta ? `${rootMeta.root === 'worktree' ? 'wt · ' : ''}${rootMeta.rootLabel}` : '…'}
          </span>
          <div style={{ flex: 1 }} />
          <button className="fv-tool" title="Refresh — drops the listing cache and re-reads expanded dirs" onClick={refresh}>⟳</button>
        </div>
        {wtGone && <div className="files-note">This worktree has landed or been removed — showing the project repo.</div>}
        <div className="files-rows">
          {rows.map((r) =>
            r.kind === 'note' ? (
              r.retryDir !== undefined ? (
                <button key={r.id} className="files-rownote clickable" style={{ paddingLeft: 10 + r.depth * 14 }}
                  onClick={() => retryDir(r.retryDir!)}>{r.text}</button>
              ) : (
                <div key={r.id} className="files-rownote" style={{ paddingLeft: 10 + r.depth * 14 }}>{r.text}</div>
              )
            ) : (
              <button
                key={r.path}
                role="treeitem"
                aria-expanded={r.entry.type === 'dir' ? expanded.has(r.path) : undefined}
                className={`files-row ${r.entry.heavy ? 'heavy' : ''} ${selected === r.path ? 'active' : ''}`}
                style={{ paddingLeft: 6 + r.depth * 14 }}
                data-path={r.path}
                ref={(el) => { if (el) rowRefs.current.set(r.path, el); else rowRefs.current.delete(r.path); }}
                tabIndex={r.path === tabPath ? 0 : -1}
                title={r.path}
                onClick={() => activate(r)}
              >
                <span className="files-disc">{r.entry.type === 'dir' ? (expanded.has(r.path) ? '▾' : '▸') : ''}</span>
                <span className="files-name mono">{r.entry.name}{r.entry.type === 'dir' ? '/' : ''}</span>
                {r.entry.broken ? <span className="files-size">broken ↯</span>
                  : r.entry.type === 'symlink' ? <span className="files-size">→</span>
                  : r.entry.type !== 'dir' && r.entry.size !== undefined ? <span className="files-size">{fmtSize(r.entry.size)}</span>
                  : null}
              </button>
            ),
          )}
        </div>
      </div>
      <FileViewer scope={scope} wt={wt} path={selected} onError={onError} />
    </div>
  );
}

// ============================ VIEWER ============================

function FileViewer({ scope, wt, path, onError }: {
  scope: FilesScope; wt: string | undefined; path: string | null; onError: (m: string) => void;
}) {
  const [content, setContent] = useState<FileContent | 'loading' | null>(null);
  const [viewErr, setViewErr] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [mode, setMode] = useState<'code' | 'preview'>('code');
  const [mint, setMint] = useState<PreviewMintResponse | 'loading' | null>(null);
  const [expired, setExpired] = useState(false);
  // Monotonic token so a mint in flight for an earlier file can't win setMint and preview the
  // WRONG artifact under the current file's title. Bumped on every file change and every mint.
  const mintReq = useRef(0);

  useEffect(() => {
    mintReq.current++;
    setMode('code'); setMint(null); setExpired(false); setViewErr(null);
    if (!path) { setContent(null); return; }
    setContent('loading');
    let gone = false;
    tower.readFile(scope.projectId, path, wt)
      .then((c) => { if (!gone) setContent(c); })
      .catch((e) => { if (!gone) { setContent(null); setViewErr((e as Error).message); } });
    return () => { gone = true; };
  }, [path, scope.projectId, wt]);

  const mintNow = useCallback(async (): Promise<PreviewMintResponse | null> => {
    if (!path) return null;
    const my = ++mintReq.current;
    setMint('loading'); setExpired(false);
    try {
      const m = await tower.mintPreview(scope.projectId, path, wt);
      if (mintReq.current !== my) return null; // a newer file/mint superseded this one — discard
      setMint(m);
      return m;
    } catch (e) {
      if (mintReq.current !== my) return null;
      setMint(null); setMode('code'); onError((e as Error).message);
      return null;
    }
  }, [path, scope.projectId, wt, onError]);

  // Flag the grant once its TTL passes, so the trust bar says "expired — ⟳" instead of the
  // iframe silently 404ing on the next artifact navigation. ⟳ always re-mints (also covers a
  // Tower restart, which loses the in-memory grant store before the clock expiry).
  useEffect(() => {
    if (!mint || mint === 'loading') return;
    const ms = Date.parse(mint.expiresAt) - Date.now();
    if (ms <= 0) { setExpired(true); return; }
    const id = setTimeout(() => setExpired(true), ms);
    return () => clearTimeout(id);
  }, [mint]);

  const enterPreview = () => {
    setMode('preview');
    const live = mint && mint !== 'loading' && Date.parse(mint.expiresAt) > Date.now();
    if (!live) void mintNow();
  };
  const openTab = () => {
    // The CSP `sandbox` HEADER makes even a top-level open opaque-origin (§4) — safe to pop out.
    if (mint && mint !== 'loading' && !expired) window.open(mint.url, '_blank', 'noopener');
    else void mintNow().then((m) => { if (m) window.open(m.url, '_blank', 'noopener'); });
  };

  if (!path) {
    return <div className="fv-empty">Select a file — ▸ expands a dir, Enter opens.<br /><span className="faint">html files get an isolated in-Tower preview.</span></div>;
  }
  const segs = path.split('/');
  const html = isHtml(path);

  return (
    <div className="fv">
      <div className="fv-head">
        <div className="fv-crumb mono" title={path}>
          {segs.map((s, i) => (
            <span key={i} className={i === segs.length - 1 ? 'fv-crumb-leaf' : ''}>
              {i > 0 && <span className="fv-crumb-sep">/</span>}{s}
            </span>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {content && content !== 'loading' && !content.binary && content.encoding === 'utf8' && mode === 'code' && (
          <button className={`fv-tool ${wrap ? 'on' : ''}`} title="Toggle soft-wrap" onClick={() => setWrap((w) => !w)}>wrap</button>
        )}
        {html && (
          <>
            <div className="seg-choice fv-mode">
              <button className={mode === 'code' ? 'sel' : ''} onClick={() => setMode('code')}>code</button>
              <button className={mode === 'preview' ? 'sel' : ''} onClick={enterPreview}>preview</button>
            </div>
            <button className="fv-tool" title="Open the isolated preview in a new tab" onClick={openTab}>open ↗</button>
          </>
        )}
      </div>

      {html && mode === 'preview' ? (
        <PreviewPane mint={mint} expired={expired} onReload={() => void mintNow()} name={basename(path)} />
      ) : viewErr ? (
        <div className="fv-empty">{viewErr}</div>
      ) : !content || content === 'loading' ? (
        <div className="fv-body"><div className="fv-skel" /><div className="fv-skel w60" /><div className="fv-skel w80" /></div>
      ) : content.encoding === 'base64' ? (
        <div className="fv-body fv-imgwrap">
          <img className="fv-img" src={`data:${content.mime ?? 'application/octet-stream'};base64,${content.content}`} alt={path} />
          <div className="fv-meta mono">{fmtSize(content.size)}{content.mime ? ` · ${content.mime}` : ''}</div>
        </div>
      ) : content.encoding === 'none' ? (
        <div className="fv-body fv-dlwrap">
          <div className="fv-download">
            <div className="fv-dl-name mono">{basename(path)}</div>
            <div className="fv-dl-meta">{content.binary ? 'binary file' : 'too large to view inline'} · {fmtSize(content.size)}</div>
            <DownloadLink projectId={scope.projectId} path={path} wt={wt} onError={onError} className="btn">⤓ download</DownloadLink>
          </div>
        </div>
      ) : (
        <>
          {content.truncated && (
            <div className="fv-banner">
              Showing the first part only (server size cap) —{' '}
              <DownloadLink projectId={scope.projectId} path={path} wt={wt} onError={onError} className="fv-banner-link">download the full file</DownloadLink>
            </div>
          )}
          {content.content.split('\n').length > LINE_SPAN_CAP ? (
            <>
              <div className="fv-banner">Large file — line numbers are off for performance.</div>
              <pre className={`fv-text plain ${wrap ? 'wrap' : ''}`}>{content.content}</pre>
            </>
          ) : (
            <pre className={`fv-text ${wrap ? 'wrap' : ''}`}>
              {content.content.split('\n').map((ln, i) => <span key={i} className="fv-ln">{ln || ' '}</span>)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/** The sandboxed artifact frame + teal isolation trust bar (SPEC-FILES §4/§5). Belt (iframe
 *  `sandbox` attribute) + suspenders (the server's CSP `sandbox` header): the doc runs on an
 *  opaque origin with no Tower token, no /api reach, no exfil. src is the RELATIVE /preview URL
 *  from the mint — never an absolute :4870. White background: a transparent artifact would
 *  otherwise show the app's --void through. */
function PreviewPane({ mint, expired, onReload, name }: {
  mint: PreviewMintResponse | 'loading' | null; expired: boolean; onReload: () => void; name: string;
}) {
  return (
    <div className="fv-preview">
      <div className={`fv-isolation ${expired ? 'expired' : ''}`}>
        <svg className="fv-iso-shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z" />
        </svg>
        <span className="fv-iso-text">Isolated preview — separate origin, no Tower token, scripts sandboxed</span>
        {mint && mint !== 'loading' && (
          <span className="fv-iso-path mono" title={mint.url}>/preview/{mint.previewId}</span>
        )}
        {expired && <span className="fv-iso-expired">grant expired — ⟳</span>}
        <div style={{ flex: 1 }} />
        <button className="fv-tool" title="Reload — re-mints the preview grant and re-sets the frame src" onClick={onReload}>⟳</button>
      </div>
      {mint && mint !== 'loading' ? (
        <iframe
          key={mint.previewId}
          className="fv-frame"
          src={mint.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={{ background: '#fff' }}
          title={`Isolated preview — ${name}`}
        />
      ) : (
        <div className="fv-empty">{mint === 'loading' ? 'minting preview grant…' : 'preview unavailable'}</div>
      )}
    </div>
  );
}

/** Downloads the raw file via a HEADER-authenticated fetch → ephemeral blob URL. Route C is
 *  token-gated by the X-Tower-Token header (not token-exempt), so an <a href> with the token in the
 *  query would 401 on click AND leak the full session token into history / access logs. */
function DownloadLink({ projectId, path, wt, onError, className, children }: {
  projectId: string; path: string; wt?: string; onError: (m: string) => void; className?: string; children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await tower.downloadFile(projectId, path, wt);
    } catch (e) {
      onError(`couldn't download ${basename(path)}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={className} disabled={busy} onClick={() => void go()}>
      {children}
    </button>
  );
}
