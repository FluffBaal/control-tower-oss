// Per-project shared memory (SPEC D9/M5, SPEC-MEMORY). Two doors onto the same store: the three generated
// markdown views (decisions/gotchas/glossary), edited whole-file in a textarea as before, and an ENTRIES
// mode over the versioned records behind the active view — status chips, per-entry operator actions
// (verify / dispute / retract / edit) and multi-select consolidate into a summary. Every write carries the
// revision it was based on; a stale one is refused server-side and this panel re-reads rather than clobbers.
// Lives outside any repo so it can't diverge per worktree.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tower, MemoryStaleError, apiErrorText } from './api.js';
import { MEMORY_KINDS, viewFileFor } from '../shared/memory.js';
import type { MemoryEntry, MemoryKind } from '../shared/memory.js';
import { timeAgo } from './flightline-utils.js';

type Mode = 'view' | 'entries';

/** An open inline body edit. `rev` is the revision the draft was based on — it rides on the save as the
 *  CAS token, and a list reload that shows a newer rev flips the "changed underneath you" notice. */
interface EditDraft { id: string; rev: number; body: string }
/** A pending add or consolidate composer. `requestId` is minted ONCE when the composer opens so a retried
 *  submit (network blip, double click) is idempotent server-side rather than a duplicate entry. */
interface Composer { requestId: string; body: string }
/** The consolidate composer also pins the sources it was composed FROM (id + rev, taken when it opened): the
 *  body was seeded from those entries at those revs, so the submit sends that same set rather than whatever
 *  the selection has drifted to since. A source that moves or leaves the list makes the composer stale. */
interface ConsolidateComposer extends Composer { sources: { id: string; rev: number }[] }

export function MemoryPanel({ projectId, onError, reloadSignal }: {
  projectId: string;
  onError: (m: string) => void;
  /** Bumped by App on the `{t:'memory'}` SSE frame (the StoriesView reloadSignal idiom) — re-reads the
   *  entries and, unless the textarea holds unsaved edits, the view text. */
  reloadSignal?: number;
}) {
  const [kind, setKind] = useState<MemoryKind>(MEMORY_KINDS[0]);
  const file = viewFileFor(kind);
  const [mode, setMode] = useState<Mode>('view');
  // view mode
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState(true);
  const savedRef = useRef(true);
  useEffect(() => { savedRef.current = saved; }, [saved]);
  // entries mode (loaded alongside the view so the disputed badge is live in both modes)
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [edit, setEdit] = useState<EditDraft | null>(null);
  // Ref mirror of `edit` for the post-load reconcile inside `load` (which must not re-create on every keystroke).
  const editRef = useRef<EditDraft | null>(null);
  useEffect(() => { editRef.current = edit; }, [edit]);
  const [adding, setAdding] = useState<Composer | null>(null);
  const [consolidating, setConsolidating] = useState<ConsolidateComposer | null>(null);
  const [busy, setBusy] = useState(false);
  // Ref mirror of `busy` for the mutation guard: two clicks in one tick both read the same closure state,
  // so the guard checks the ref (updated synchronously) rather than the render value.
  const busyRef = useRef(false);
  // Generation counter: a load that finishes after a project/kind switch must not paint the old target.
  const gen = useRef(0);

  const load = useCallback(async (opts: { keepDraft?: boolean } = {}) => {
    const g = ++gen.current;
    try {
      const [all, list] = await Promise.all([tower.memory(projectId), tower.memoryEntries(projectId, { kind })]);
      if (g !== gen.current) return;
      setEntries(list);
      // An open draft whose entry is no longer ACTIVE (superseded by a consolidate, retracted, or gone) has
      // no row left to live in — drop it and say so, rather than letting the unmount swallow the typed text.
      // A draft whose entry merely moved to a newer rev keeps its row and the "changed underneath you" notice.
      const draft = editRef.current;
      if (draft && !list.some((e) => e.id === draft.id && e.lifecycle === 'active')) {
        setEdit(null);
        onError(`your in-progress edit to ${draft.id} was discarded — the entry changed or was superseded; re-open it to redo`);
      }
      // A background reload (SSE) must not clobber unsaved textarea edits; a pending save that is now
      // stale is refused server-side and handled in save().
      if (!(opts.keepDraft && !savedRef.current)) {
        setContent(all[file] ?? '');
        setSaved(true);
      }
    } catch (e) {
      if (g === gen.current) onError(apiErrorText(e));
    }
  }, [projectId, kind, file, onError]);

  useEffect(() => {
    setEntries(null);
    setSelected(new Set());
    setEdit(null);
    setAdding(null);
    setConsolidating(null);
    void load();
  }, [load]);
  const lastSignal = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === lastSignal.current) return; // mount, or a kind switch re-creating `load`
    lastSignal.current = reloadSignal;
    void load({ keepDraft: true });
  }, [reloadSignal, load]);

  // Every mutation funnels through here: serialize on `busy`, re-read on success, and on a stale
  // refusal re-read + say so in prose (the current state is now on screen; the operator retries if wanted).
  const run = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
      await load({ keepDraft: true });
      return true;
    } catch (e) {
      if (e instanceof MemoryStaleError) {
        const cur = e.current;
        const rev = typeof cur === 'string' ? '' : ` (now rev ${cur.rev})`;
        onError(`${what}: it changed since you loaded it${rev} — showing the current version; retry if still wanted.`);
        await load({ keepDraft: true });
      } else {
        onError(`${what}: ${apiErrorText(e)}`);
      }
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // ---- view mode ----
  const save = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await tower.writeMemory(projectId, file, content);
      // Re-read after a successful save: the write is a revision-checked replace, so the view's header hash
      // advances on every save. Without reloading, a second consecutive save (same tab) would submit the
      // stale header and be rejected with a spurious 409. `load()` also folds in any concurrent change.
      await load();
    } catch (e) {
      if (e instanceof MemoryStaleError) {
        // Keep the operator's text (it may be a long edit) — they reload explicitly once they've copied it.
        onError(`${file} changed since you loaded it — your edit was NOT saved. Copy anything you need, then reload and re-apply.`);
      } else {
        onError(apiErrorText(e));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // ---- entries mode ----
  const sorted = useMemo(() => {
    const rank = (e: MemoryEntry) => (e.lifecycle === 'active' ? 0 : 1);
    return [...(entries ?? [])].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  }, [entries]);
  const inactiveCount = sorted.filter((e) => e.lifecycle !== 'active').length;
  const visible = showInactive ? sorted : sorted.filter((e) => e.lifecycle === 'active');
  // Ids currently active, to gate "restore" on a consolidation summary: restoring a summary whose sources
  // are active would duplicate their content in the views/briefings. The store refuses it too (422); this
  // just avoids offering a button that would error.
  const activeIds = new Set((entries ?? []).filter((e) => e.lifecycle === 'active').map((e) => e.id));
  const disputed = sorted.filter((e) => e.lifecycle === 'active' && e.verification === 'disputed').length;
  const selectedEntries = sorted.filter((e) => selected.has(e.id));

  const toggleSelected = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Only an active, undisputed entry with no open supersede link can be folded (the store refuses the rest).
  const consolidatable = (e: MemoryEntry) => e.lifecycle === 'active' && e.verification !== 'disputed' && !e.supersededBy;

  // Snapshot the selection when the composer opens: body and sources are taken from the same instant, and
  // the submit sends that snapshot (not the live `selected`) so the two cannot diverge.
  const openConsolidate = () => {
    if (selectedEntries.length === 0) return;
    setConsolidating({
      requestId: crypto.randomUUID(),
      body: selectedEntries.map((e) => e.body).join('\n'),
      sources: selectedEntries.map((e) => ({ id: e.id, rev: e.rev })),
    });
  };
  const submitConsolidate = async () => {
    if (!consolidating || consolidating.sources.length === 0) return;
    const body = consolidating.body.trim();
    if (!body) return;
    const ok = await run('consolidate', () => tower.consolidateMemory(projectId, {
      requestId: consolidating.requestId, kind, body, sources: consolidating.sources,
    }));
    if (ok) { setConsolidating(null); setSelected(new Set()); }
  };
  const submitAdd = async () => {
    if (!adding) return;
    const body = adding.body.trim();
    if (!body) return;
    const ok = await run('add', () => tower.addMemoryEntry(projectId, { requestId: adding.requestId, kind, body }));
    if (ok) setAdding(null);
  };
  const submitEdit = async () => {
    if (!edit) return;
    const body = edit.body.trim();
    if (!body) { onError('edit: an empty body is refused — retract the entry instead'); return; }
    const ok = await run('edit', () => tower.updateMemoryEntry(projectId, edit.id, { rev: edit.rev, body }));
    if (ok) setEdit(null);
  };

  // A selected row that is open for edit must not be folded out from under its draft: block the fold, not the edit.
  const editingSelected = edit !== null && selected.has(edit.id);
  const canConsolidate = selectedEntries.length > 0 && selectedEntries.every(consolidatable) && !editingSelected;
  // The open composer's pinned sources, as they stand in the current list. A reload that moved, disputed,
  // retracted or superseded one of them would be refused server-side on every retry (the revs are pinned), so
  // the submit goes dark with a hint to re-open instead.
  const snapshotIntact = consolidating !== null && consolidating.sources.every((s) => {
    const cur = entries?.find((e) => e.id === s.id);
    return cur !== undefined && cur.rev === s.rev && consolidatable(cur);
  });
  // Why a row's checkbox is locked (null = selectable): not foldable; the selection is pinned by an open
  // consolidate composer; or the row is the one under an open edit.
  const selectBlock = (e: MemoryEntry): string | null =>
    !consolidatable(e) ? 'Only active, undisputed entries can be consolidated'
    : consolidating ? 'Selection is pinned while the consolidate composer is open'
    : edit?.id === e.id ? 'Save or cancel the edit before selecting this entry'
    : null;

  return (
    <div className="memory">
      <div className="memory-tabs">
        {MEMORY_KINDS.map((k) => (
          <button key={k} className={`tab ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{viewFileFor(k)}</button>
        ))}
        <span className="sep" />
        <button className={`tab ${mode === 'view' ? 'active' : ''}`} onClick={() => setMode('view')} title="The generated markdown, edited as a whole">view</button>
        <button className={`tab ${mode === 'entries' ? 'active' : ''}`} onClick={() => setMode('entries')} title="The versioned entries behind this view">
          entries{entries ? ` · ${sorted.filter((e) => e.lifecycle === 'active').length}` : ''}
        </button>
        {disputed > 0 && (
          <button className="chip disputed as-btn" title="Active entries under dispute — open entries to resolve" onClick={() => setMode('entries')}>
            {disputed} disputed
          </button>
        )}
        <span className="spacer" />
        {mode === 'view' && (
          <>
            <span className="muted small">{saved ? 'saved' : 'unsaved'}</span>
            <button className="btn-sm" disabled={busy} title="Re-read from the server (discards unsaved edits)" onClick={() => void load()}>reload</button>
            <button className="btn-sm ok" disabled={saved || busy} onClick={() => void save()}>save</button>
          </>
        )}
      </div>

      {mode === 'view' ? (
        <textarea
          className="memory-text mono"
          value={content}
          onChange={(e) => { setContent(e.target.value); setSaved(false); }}
          placeholder={`Shared ${file} for this project — agents read and update this.`}
        />
      ) : (
        <>
          <div className="memory-toolbar">
            <label className="muted small mem-check">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              show superseded / retracted{inactiveCount > 0 ? ` (${inactiveCount})` : ''}
            </label>
            <span className="spacer" />
            {selected.size > 0 && (
              <button className="btn-sm" disabled={busy || !!consolidating} onClick={() => setSelected(new Set())}>clear selection</button>
            )}
            <button className="btn-sm" disabled={busy || !canConsolidate || !!consolidating}
              title={selected.size === 0 ? 'Select entries to fold into one summary'
                : editingSelected ? 'A selected entry is open for edit — save or cancel it first'
                : canConsolidate ? 'Fold the selected entries into one new summary; they become superseded'
                : 'Only active, undisputed entries can be consolidated'}
              onClick={openConsolidate}>
              consolidate{selected.size > 0 ? ` ${selected.size}` : ''}
            </button>
            <button className="btn-sm ok" disabled={busy || !!adding} onClick={() => setAdding({ requestId: crypto.randomUUID(), body: '' })}>+ add</button>
          </div>

          <div className="memory-entries">
            {adding && (
              <div className="mem-entry composer field">
                <label>new {kind} · project-wide</label>
                <textarea autoFocus value={adding.body} placeholder={`One ${kind}, in a sentence or two.`}
                  onChange={(e) => setAdding({ ...adding, body: e.target.value })} />
                <div className="mem-entry-actions">
                  <button className="btn-sm ok" disabled={busy || !adding.body.trim()} onClick={() => void submitAdd()}>add</button>
                  <button className="btn-sm" disabled={busy} onClick={() => setAdding(null)}>cancel</button>
                </div>
              </div>
            )}
            {consolidating && (
              <div className="mem-entry composer field">
                <label>summary of {consolidating.sources.length} selected · replaces them as one {kind}</label>
                <textarea autoFocus value={consolidating.body}
                  onChange={(e) => setConsolidating({ ...consolidating, body: e.target.value })} />
                <div className="mem-entry-actions">
                  <button className="btn-sm ok" disabled={busy || !consolidating.body.trim() || !snapshotIntact} onClick={() => void submitConsolidate()}>consolidate</button>
                  <button className="btn-sm" disabled={busy} onClick={() => setConsolidating(null)}>cancel</button>
                  {!snapshotIntact && <span className="hint warn">a selected entry changed or left the list — cancel and re-open to fold the current versions</span>}
                </div>
              </div>
            )}
            {entries === null && <div className="empty-sector">Loading entries…</div>}
            {entries !== null && visible.length === 0 && (
              <div className="empty-sector">
                {sorted.length === 0 ? `No ${kind} entries yet.` : `No active ${kind} entries — ${inactiveCount} superseded/retracted hidden.`}
              </div>
            )}
            {visible.map((e) => (
              <EntryRow key={e.id} entry={e} busy={busy}
                restoreBlocked={(e.supersedes?.length ?? 0) > 0 && (e.supersedes ?? []).some((id) => activeIds.has(id))}
                selected={selected.has(e.id)} selectBlock={selectBlock(e)} onSelect={() => toggleSelected(e.id)}
                edit={edit?.id === e.id ? edit : null}
                onEditStart={() => setEdit({ id: e.id, rev: e.rev, body: e.body })}
                onEditChange={(body) => setEdit((d) => (d && d.id === e.id ? { ...d, body } : d))}
                onEditRebase={(takeCurrent) => setEdit((d) => (d && d.id === e.id ? { ...d, rev: e.rev, body: takeCurrent ? e.body : d.body } : d))}
                onEditSave={() => void submitEdit()} onEditCancel={() => setEdit(null)}
                onVerification={(v) => void run(v === 'verified' ? 'verify' : v === 'disputed' ? 'dispute' : 'clear', () => tower.updateMemoryEntry(projectId, e.id, { rev: e.rev, verification: v }))}
                onLifecycle={(l) => void run(l === 'retracted' ? 'retract' : 'restore', () => tower.updateMemoryEntry(projectId, e.id, { rev: e.rev, lifecycle: l }))}
                onUnconsolidate={() => {
                  if (!window.confirm(`Undo this consolidation? The summary is retracted and its ${e.sources?.length ?? 0} source entries return to active.`)) return;
                  void run('unconsolidate', () => tower.unconsolidateMemory(projectId, e.id, e.rev));
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EntryRow({ entry: e, busy, selected, selectBlock, onSelect, edit, onEditStart, onEditChange, onEditRebase, onEditSave, onEditCancel, onVerification, onLifecycle, onUnconsolidate, restoreBlocked }: {
  entry: MemoryEntry; busy: boolean;
  /** Why the checkbox is locked, or null when the row can be ticked. */
  selected: boolean; selectBlock: string | null; onSelect: () => void;
  edit: EditDraft | null;
  onEditStart: () => void; onEditChange: (body: string) => void;
  /** The entry moved on under an open draft: rebase the draft onto the live rev, optionally taking its body. */
  onEditRebase: (takeCurrent: boolean) => void;
  onEditSave: () => void; onEditCancel: () => void;
  onVerification: (v: 'verified' | 'disputed' | 'provisional') => void;
  onLifecycle: (l: 'active' | 'retracted') => void;
  /** True when this is a consolidation summary whose sources are active — restoring it would duplicate them. */
  restoreBlocked: boolean;
  onUnconsolidate: () => void;
}) {
  const active = e.lifecycle === 'active';
  const isSummary = (e.supersedes?.length ?? e.sources?.length ?? 0) > 0;
  const app = e.applicability;
  const author = e.author.kind === 'agent' ? `agent · ${e.author.terminalId.slice(0, 8)}` : e.author.kind;
  // The draft was based on an older rev than the one now on screen — a reload (SSE or a stale refusal) moved it.
  const moved = edit !== null && edit.rev !== e.rev;
  return (
    <div className={`mem-entry ${active ? '' : 'inactive'} ${selected ? 'selected' : ''}`}>
      <div className="mem-entry-head">
        <input type="checkbox" checked={selected} disabled={selectBlock !== null || busy} onChange={onSelect}
          title={selectBlock ?? 'Select for consolidation'} />
        <span className={`chip ${e.verification}`}>{e.verification}</span>
        <span className={`chip ${e.lifecycle}`}>{e.lifecycle}{e.lifecycle === 'superseded' && e.supersededBy ? ` → ${e.supersededBy}` : ''}</span>
        {app.scope === 'run'
          ? <span className="chip run" title={`loop ${app.loopId}${app.missionId ? ` · mission ${app.missionId}` : ''}`}>run{app.branch ? ` · ${app.branch}` : ''} · {app.integration}</span>
          : <span className="chip">project</span>}
        <span className="chip" title={e.evidence.map((v) => v.type).join(', ') || 'no evidence attached'}>evidence {e.evidence.length}</span>
        <span className="chip" title={e.author.kind === 'agent' ? `terminal ${e.author.terminalId}` : e.author.kind}>{author}</span>
        {isSummary && <span className="chip" title={`consolidates ${(e.supersedes ?? []).join(', ')}`}>summary of {e.supersedes?.length ?? e.sources?.length}</span>}
        {e.key && <span className="chip mono" title="Tower-managed key">{e.key}</span>}
        <span className="spacer" />
        <span className="mem-entry-meta mono">{e.id} · rev {e.rev} · {timeAgo(e.updatedAt) || '—'}</span>
      </div>
      {edit ? (
        <div className="field">
          <textarea autoFocus value={edit.body} onChange={(ev) => onEditChange(ev.target.value)} />
          {moved && (
            <div className="hint warn mem-moved">
              changed underneath you (now rev {e.rev}): <span className="mem-moved-body">{e.body}</span>
              <button className="btn-sm" disabled={busy} onClick={() => onEditRebase(true)}>take current</button>
              <button className="btn-sm" disabled={busy} onClick={() => onEditRebase(false)}>keep mine</button>
            </div>
          )}
          <div className="mem-entry-actions">
            <button className="btn-sm ok" disabled={busy || moved || !edit.body.trim()} title={moved ? 'Resolve the change above first' : undefined} onClick={onEditSave}>save</button>
            <button className="btn-sm" disabled={busy} onClick={onEditCancel}>cancel</button>
          </div>
        </div>
      ) : (
        <div className="mem-entry-body">{e.body}</div>
      )}
      {!edit && (
        <div className="mem-entry-actions">
          {active && e.verification !== 'verified' && <button className="btn-sm" disabled={busy} title="Mark this claim operator-verified" onClick={() => onVerification('verified')}>verify</button>}
          {active && e.verification !== 'disputed' && <button className="btn-sm" disabled={busy} title="Flag this claim as contested" onClick={() => onVerification('disputed')}>dispute</button>}
          {active && e.verification === 'disputed' && <button className="btn-sm" disabled={busy} title="Drop the dispute without verifying" onClick={() => onVerification('provisional')}>clear dispute</button>}
          {active && e.verification === 'verified' && <button className="btn-sm" disabled={busy} title="Back to provisional" onClick={() => onVerification('provisional')}>unverify</button>}
          {active && <button className="btn-sm" disabled={busy} onClick={onEditStart}>edit</button>}
          {active && isSummary && <button className="btn-sm danger" disabled={busy} title="Retract this summary and restore the entries it replaced" onClick={onUnconsolidate}>unconsolidate</button>}
          {active && !isSummary && <button className="btn-sm danger" disabled={busy} title="Retract — it leaves the view but stays in history" onClick={() => onLifecycle('retracted')}>retract</button>}
          {e.lifecycle === 'retracted' && !restoreBlocked && <button className="btn-sm" disabled={busy} title="Back to active" onClick={() => onLifecycle('active')}>restore</button>}
          {e.lifecycle === 'retracted' && restoreBlocked && <span className="hint" title="Its source entries are active; re-consolidate to fold them again">re-consolidate to restore</span>}
        </div>
      )}
    </div>
  );
}
