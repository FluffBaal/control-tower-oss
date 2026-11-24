// Control Tower — Stories section (SPEC-STORYLOOP §1 / S1).
//
// User stories as first-class DATA the Tower checks work against. One screen takes the operator
// from an empty corpus to a persisted per-project story list (J1): "Draft from codebase" asks
// Jarvis to read the repo and return drafts (routes + spec files pre-tagged); the operator edits,
// deletes, adds their own, and Saves. Each saved story carries a DERIVED four-state coverage badge
// (§1.4) plus a project rollup — never a stored verdict, always computed fresh from the latest
// non-gate e2e run.
//
// SELF-CONTAINED (mirrors ProvidersPanel.tsx): every server interaction is a method on a
// props-injected `api` object (see `StoriesApi` below — the Integrator wires each to a `tower.*`
// client call). The component never imports the concrete client, so it stays testable in isolation;
// the only imports are erased-at-compile TYPES from shared/types. New structure lives under `st-`
// classes whose CSS is appended as a trailing /* CSS FOR INTEGRATOR */ block — this file must NOT
// touch styles.css, App.tsx, or api.ts (§7 file ownership).
//
// House style follows OutcomesView.tsx (a top-level `.flightline` view) + ProvidersPanel.tsx
// (props-injected api, list/form CRUD): `.flightline`/`.view-title`/`.field`/`.seg-choice`/`.chip`/
// `.btn` idioms and the Flightline edge-light + beacon tokens.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CreateStoryRequest, Project, Story, StoryStatus } from '../shared/types.js';

// ============================================================================
//  INTEGRATOR CONTRACT — the props-injected api object + the coverage wire shape.
//
//  The Integrator adds these five client methods to api.ts (`tower.*`) and the matching
//  server.ts routes (§7 "Integrator" — stories CRUD/draft/coverage). Suggested wiring:
//    listStories  → GET    /api/stories?projectId=          → tower.listStories
//    upsertStory  → POST   /api/stories   (body may carry id) → tower.upsertStory
//    removeStory  → DELETE /api/stories/:id                  → tower.removeStory
//    draftStories → POST   /api/stories/draft  {projectId, goal?} → tower.draftStories
//    coverage     → GET    /api/stories/coverage?projectId=  → tower.storyCoverage
//  StoryStore.upsert(req) mints id+timestamps when `id` is absent and patches when present (§1.1),
//  so the create + edit paths share ONE route. CoverageState/StoryCoverage live server-side in
//  stories/coverage.ts (not shared/types.ts); the CoverageReport shape below is the wire
//  projection the server serializes — structurally identical to the server's StoryCoverage[] (§1.4).
// ============================================================================

/** Upsert payload: the frozen create shape (§1.1) plus an optional `id` to PATCH an existing
 *  story. Absent id → create (server mints id + timestamps); present id → patch that story. */
export type StoryUpsert = CreateStoryRequest & { id?: string };

/** One Jarvis draft returned by `POST /api/stories/draft` — never persisted until the operator
 *  Saves it (the plan-is-a-draft invariant, §1.3). Mirrors `parseStories` output. */
export interface StoryDraft {
  title: string;
  story: string;
  routes?: string[];
  specFiles?: string[];
}

/** The full `POST /api/stories/draft` response. The route returns 200 even when drafting yields
 *  nothing, carrying a `note` explaining why (a real drafter failure). The view surfaces `note`
 *  verbatim when drafts are empty instead of a generic "no clear behaviors" message (§1.3, W4). */
export interface StoryDraftResult {
  drafts: StoryDraft[];
  note?: string;
}

/** DERIVED, never stored (§1.4). Precedence over the latest non-gate run's {failures, ran}:
 *    uncovered      — specFiles empty/absent (nothing maps to it)
 *    failing        — a mapped specFile is in the run's failures
 *    stale-missing  — a mapped specFile is NOT in the run's ran-set (mapping points at nothing)
 *    covered        — every mapped specFile ran and none failed                                 */
export type CoverageState = 'covered' | 'failing' | 'stale-missing' | 'uncovered';

export interface StoryCoverage {
  storyId: string;
  state: CoverageState;
  failingSpecs: string[];
  missingSpecs: string[];
}

/** GET /api/stories/coverage response. `hasRun` = a non-gate run WITH parsed results exists for
 *  this project (§1.4: an all-green run is `results: []`, still a run; only a missing/
 *  unparseable report = no run). When `hasRun` is false, a MAPPED story has no `coverage` entry
 *  and renders a neutral "no run yet" marker; an UNMAPPED story is always present as `uncovered`. */
export interface CoverageReport {
  hasRun: boolean;
  coverage: StoryCoverage[];
}

export interface StoriesApi {
  /** GET the saved corpus for one project (the file holds all projects; server filters, §1.2). */
  listStories(projectId: string): Promise<Story[]>;
  /** Create (no id) or patch (with id). Server validates spec-file paths + mirrors zod, emits
   *  `{t:'stories'}`. Returns the persisted Story (server-stamped id/timestamps). */
  upsertStory(input: StoryUpsert): Promise<Story>;
  /** DELETE one story. Emits `{t:'stories'}`. */
  removeStory(id: string): Promise<void>;
  /** Ask Jarvis to draft stories from the repo (codex-only, §1.3). Returns DRAFTS + an optional
   *  `note` — nothing is persisted here; the operator reviews, edits, and Saves. Throws on transport
   *  failure; an empty-with-note result is a soft "drafting was inconclusive", surfaced verbatim. */
  draftStories(projectId: string, goal?: string): Promise<StoryDraftResult>;
  /** GET the derived four-state coverage for the project's corpus over the latest non-gate run. */
  coverage(projectId: string): Promise<CoverageReport>;
}

// ============================================================================
//  Pure helpers — spec-path validation (client mirror of §1.1), list parsing, form ↔ wire.
// ============================================================================

/** §1.1 allowlist: a repo-relative Playwright spec path. Rejects absolute + traversing paths so a
 *  story never points at an absolute/`..` join key. The SERVER is authoritative (drops bad paths on
 *  upsert); this mirror surfaces the problem in the form so a path is never silently dropped. */
const SPEC_RE = /^[A-Za-z0-9._/-]+\.(spec|test)\.[jt]sx?$/;
function specInvalid(p: string): boolean {
  const s = p.trim();
  if (!s) return true;
  if (s.startsWith('/') || s.includes('..')) return true;
  return !SPEC_RE.test(s);
}

/** Split a comma- OR newline-separated free-text field into trimmed, de-duped, non-empty tokens.
 *  Used for both `routes` (free text) and `specFiles` (validated separately). */
function parseList(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of s.split(/[\n,]/)) {
    const t = raw.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

const STATUSES: { id: StoryStatus; label: string; hint: string }[] = [
  { id: 'draft', label: 'Draft', hint: 'authored, not yet finalized' },
  { id: 'active', label: 'Active', hint: 'live behavior the suite should cover' },
  { id: 'retired', label: 'Retired', hint: 'deprecated — kept for history' },
];

/** A flat, editable mirror of Story (arrays flattened to newline-joined text), converted at save. */
interface FormState {
  id?: string;         // present ⇒ editing a saved story (patch); absent ⇒ create
  title: string;
  story: string;
  routesStr: string;
  specsStr: string;
  status: StoryStatus;
}

function blankForm(status: StoryStatus = 'active'): FormState {
  return { title: '', story: '', routesStr: '', specsStr: '', status };
}
function storyToForm(s: Story): FormState {
  return {
    id: s.id,
    title: s.title,
    story: s.story,
    routesStr: (s.routes ?? []).join('\n'),
    specsStr: (s.specFiles ?? []).join('\n'),
    status: s.status,
  };
}
function draftToForm(d: StoryDraft): FormState {
  // Jarvis drafts land as `draft` status until the operator reviews and promotes them.
  return {
    title: d.title ?? '',
    story: d.story ?? '',
    routesStr: (d.routes ?? []).join('\n'),
    specsStr: (d.specFiles ?? []).join('\n'),
    status: 'draft',
  };
}
function formToUpsert(f: FormState, projectId: string): StoryUpsert {
  const routes = parseList(f.routesStr);
  const specFiles = parseList(f.specsStr);
  const req: StoryUpsert = { projectId, title: f.title.trim(), story: f.story.trim(), status: f.status };
  if (f.id) req.id = f.id;
  if (routes.length) req.routes = routes;
  if (specFiles.length) req.specFiles = specFiles;
  return req;
}

/** Blocking validation — mirrors the server so the operator isn't surprised by a rejected upsert
 *  or a silently-dropped spec path. [] = ok. */
function validate(f: FormState): string[] {
  const e: string[] = [];
  if (!f.title.trim()) e.push('Title is required.');
  if (!f.story.trim()) e.push('Story text is required.');
  const bad = parseList(f.specsStr).filter(specInvalid);
  if (bad.length) e.push(`Not a valid repo-relative spec path (…​.spec.ts / .test.tsx, no leading “/”, no “..”): ${bad.join(', ')}`);
  return e;
}

// A gentle nudge, not a gate: the brief's stories read "As a … I want … so that …" (§1.1).
const SHAPE_RE = /as an?\b.*\bi want\b.*\bso that\b/i;

let tempSeq = 0; // client-only ids for unsaved pending entries (never sent to the server)

// ============================================================================
//  Main view
// ============================================================================

/** A pending (unsaved) authoring entry: a Jarvis draft OR a manual "add story". Lives only in the
 *  client until Saved; on save it upserts and joins the server corpus. */
interface Pending {
  tempId: string;
  form: FormState;
  fromDraft: boolean;
}

export function StoriesView({
  projects,
  api,
  onError,
  reloadSignal,
  initialProjectId,
}: {
  /** Project switcher source — Stories are per-project (J1 opens them "on a project"). */
  projects: Pick<Project, 'id' | 'name'>[];
  api: StoriesApi;
  onError: (m: string) => void;
  /** The Integrator bumps this on a `{t:'stories'}` SSE frame (and, ideally, when an e2e run
   *  completes) to re-fetch the corpus + coverage live — the ProvidersPanel `reloadSignal`. */
  reloadSignal?: number;
  /** Optional deep-link: pre-select this project (e.g. from a flightline card). */
  initialProjectId?: string;
}) {
  const [projectId, setProjectId] = useState<string>(
    () => initialProjectId ?? projects[0]?.id ?? '',
  );
  const [stories, setStories] = useState<Story[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [cover, setCover] = useState<CoverageReport | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState<string | null>(null);

  // A monotonic request generation, bumped on every project switch. Each async loader captures
  // the generation at start and discards its resolution if a switch superseded it, so a slow
  // project-A fetch can't land its results over project B's state after the operator moved on.
  const genRef = useRef(0);

  // Keep a valid selection as projects arrive / change.
  useEffect(() => {
    const first = projects[0];
    if (first && !projects.some((p) => p.id === projectId)) {
      setProjectId(initialProjectId && projects.some((p) => p.id === initialProjectId) ? initialProjectId : first.id);
    }
  }, [projects, projectId, initialProjectId]);

  const loadStories = useCallback(async () => {
    if (!projectId) return;
    const gen = genRef.current;
    setFailed(false);
    try {
      const list = await api.listStories(projectId);
      if (gen !== genRef.current) return; // a project switch superseded this fetch — drop the stale result
      setStories(list);
    } catch (e) {
      if (gen !== genRef.current) return;
      setFailed(true);
      onError((e as Error).message);
    }
  }, [api, projectId, onError]);

  const loadCoverage = useCallback(async () => {
    if (!projectId) return;
    const gen = genRef.current;
    try {
      const report = await api.coverage(projectId);
      if (gen !== genRef.current) return; // stale after a project switch — never overwrite the new project
      setCover(report);
    } catch {
      // Coverage is a derived, non-blocking read — a failure leaves the neutral "no run" render
      // rather than an error bar (the corpus is still fully editable). Silent by design.
    }
  }, [api, projectId]);

  // Corpus refetches on project switch + on `{t:'stories'}` (via reloadSignal). Editing lives in a
  // per-form FormState (like ProviderForm), so a background list refetch never clobbers an open edit.
  useEffect(() => {
    genRef.current++; // supersede any in-flight loader bound to the previous project (W3)
    setStories(null);
    setCover(null);
    setEditingId(null);
    setPending([]);
    setDraftNote(null);
    void loadStories();
    void loadCoverage();
  }, [projectId]); // loadStories/loadCoverage are re-created with projectId — narrow dep avoids a double fire
  useEffect(() => {
    void loadStories();
    void loadCoverage();
  }, [reloadSignal]); // refetch only when the Integrator bumps the SSE reload signal

  // No `{t:'testrun'}` SSE frame exists, so coverage (which depends on out-of-band `towerctl test
  // run`s) would otherwise never refresh after the corpus loads. A gentle poll keeps "derived from
  // the latest run" honest; the Integrator can retire it by bumping `reloadSignal` on run-complete.
  const coverRef = useRef(loadCoverage);
  coverRef.current = loadCoverage;
  useEffect(() => {
    const t = setInterval(() => void coverRef.current(), 15000);
    return () => clearInterval(t);
  }, []);

  const covByStory = useMemo(() => {
    const m = new Map<string, StoryCoverage>();
    for (const c of cover?.coverage ?? []) m.set(c.storyId, c);
    return m;
  }, [cover]);

  const displayFor = useCallback(
    (s: Story): CoverageDisplay => coverageDisplay(s, cover, covByStory),
    [cover, covByStory],
  );

  const rollup = useMemo(() => tallyCoverage(stories ?? [], displayFor), [stories, displayFor]);

  // ---- mutations ----
  const draftFromCodebase = async () => {
    if (!projectId) return;
    // Same staleness guard as the loaders: a Jarvis draft is SLOW, and a project switch
    // mid-flight would otherwise land the old project's drafts in the new project's pending
    // list — where Save persists them under the wrong projectId.
    const gen = genRef.current;
    setDrafting(true);
    setDraftNote(null);
    try {
      const { drafts, note } = await api.draftStories(projectId);
      if (gen !== genRef.current) return; // project switched while drafting — drop the result
      if (!drafts.length) {
        // A real drafter failure comes back 200 with a `note`; surface it verbatim. Only fall
        // back to the generic copy when the server said nothing about why.
        setDraftNote(note ?? 'Jarvis returned no stories — the repo may have no clear user-facing behaviors, or drafting was inconclusive. You can still add stories by hand.');
        return;
      }
      setPending((p) => [
        ...drafts.map((d) => ({ tempId: `t${++tempSeq}`, form: draftToForm(d), fromDraft: true })),
        ...p,
      ]);
    } catch (e) {
      if (gen !== genRef.current) return; // stale failure — don't surface it on the new project
      // Draft failure never blocks manual authoring (§1.3) — surface as a note, keep the screen live.
      setDraftNote(`Couldn’t draft from the codebase: ${(e as Error).message}. You can still add stories by hand.`);
    } finally {
      setDrafting(false);
    }
  };

  const addBlank = () =>
    setPending((p) => [{ tempId: `t${++tempSeq}`, form: blankForm('active'), fromDraft: false }, ...p]);

  const savePending = async (tempId: string, f: FormState) => {
    await api.upsertStory(formToUpsert(f, projectId));
    setPending((p) => p.filter((x) => x.tempId !== tempId));
    await loadStories();
    void loadCoverage();
  };
  const discardPending = (tempId: string) => setPending((p) => p.filter((x) => x.tempId !== tempId));
  // Mirror each pending StoryForm's live edits back into pending[].form so "Save all" and its
  // pre-flight validation read the current values, not the stale form captured when the entry was
  // added. Per-entry Save is unaffected (it already passes the form's own `f`).
  const updatePendingForm = (tempId: string, form: FormState) =>
    setPending((p) => p.map((x) => (x.tempId === tempId ? { ...x, form } : x)));

  const saveEdit = async (f: FormState) => {
    await api.upsertStory(formToUpsert(f, projectId));
    setEditingId(null);
    await loadStories();
    void loadCoverage();
  };
  const removeStory = async (id: string) => {
    try {
      await api.removeStory(id);
      if (editingId === id) setEditingId(null);
      await loadStories();
      void loadCoverage();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const projName = projects.find((p) => p.id === projectId)?.name ?? projectId;
  const isEmpty = (stories?.length ?? 0) === 0 && pending.length === 0;

  return (
    <div className="flightline">
      <div className="view-title">
        <h1>Stories</h1>
        <span className="sub">user stories as data · coverage derived from the last e2e run</span>
      </div>

      {projects.length === 0 ? (
        <div className="st-empty">Create a project first — stories are authored per project.</div>
      ) : (
        <>
          {/* ---- control bar: project switcher + rollup + actions ---- */}
          <div className="st-bar">
            {projects.length > 1 ? (
              <select className="st-proj" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            ) : (
              <span className="st-proj-name">{projName}</span>
            )}
            <RollupBadges rollup={rollup} hasRun={cover?.hasRun ?? null} loading={cover === null && stories !== null} />
            <span className="st-spacer" />
            <button className="btn" disabled={drafting || !projectId} onClick={() => void draftFromCodebase()}
              title="Ask Jarvis to read the repo and draft user stories (you review + Save)">
              {drafting ? 'Drafting…' : 'Draft from codebase'}
            </button>
            <button className="btn ok" disabled={!projectId} onClick={addBlank}>Add story</button>
          </div>

          {draftNote && (
            <div className="st-note" onClick={() => setDraftNote(null)} title="dismiss">{draftNote}</div>
          )}

          {/* ---- pending (unsaved) entries: Jarvis drafts + manual adds ---- */}
          {pending.length > 0 && (
            <section className="st-pending">
              <div className="st-pending-head">
                <span className="st-pending-title">Pending — nothing is saved yet</span>
                <span className="st-pending-sub">Review, edit, and Save each. Discard drops it.</span>
                {pending.length > 1 && (
                  <button className="btn sm" onClick={() => void saveAllPending(pending, savePending, onError)}>
                    Save all {pending.length}
                  </button>
                )}
              </div>
              {pending.map((p) => (
                <StoryForm
                  key={p.tempId}
                  mode={p.fromDraft ? 'draft' : 'new'}
                  initial={p.form}
                  onSave={(f) => savePending(p.tempId, f)}
                  onCancel={() => discardPending(p.tempId)}
                  onChange={(f) => updatePendingForm(p.tempId, f)}
                  onError={onError}
                />
              ))}
            </section>
          )}

          {/* ---- saved corpus ---- */}
          {failed ? (
            <div className="st-note st-note-bad">
              Couldn’t load stories. <button className="btn-sm" onClick={() => void loadStories()}>retry</button>
            </div>
          ) : stories === null ? (
            <div className="st-loading">Loading…</div>
          ) : isEmpty ? (
            <div className="st-onboard">
              <div className="st-onboard-title">No stories yet</div>
              <p>
                A story corpus is the app’s intended behavior as <b>data</b> the Tower checks work
                against — not a wiki nobody reads. Hit <b>Draft from codebase</b> to let Jarvis read
                the repo and propose stories (pre-tagged with the routes and spec files they touch),
                then edit and Save. Or add your own.
              </p>
              <div className="st-onboard-actions">
                <button className="btn ok" disabled={drafting || !projectId} onClick={() => void draftFromCodebase()}>
                  {drafting ? 'Drafting…' : 'Draft from codebase'}
                </button>
                <button className="btn" onClick={addBlank}>Add a story by hand</button>
              </div>
            </div>
          ) : (
            <div className="st-list">
              {stories.map((s) =>
                editingId === s.id ? (
                  <StoryForm
                    key={s.id}
                    mode="edit"
                    initial={storyToForm(s)}
                    onSave={saveEdit}
                    onCancel={() => setEditingId(null)}
                    onError={onError}
                  />
                ) : (
                  <StoryRow
                    key={s.id}
                    story={s}
                    display={displayFor(s)}
                    onEdit={() => setEditingId(s.id)}
                    onRemove={() => void removeStory(s.id)}
                  />
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================================
//  Coverage derivation (display) + rollup — pure, matches §1.4 precedence
// ============================================================================

/** What the badge shows: the four derived states, plus two render-level absences that are NEVER
 *  green — `no-run` (mapped, but no run with results yet) and `loading` (coverage not fetched). */
type CoverageDisplay =
  | { state: CoverageState; entry?: StoryCoverage }
  | { state: 'no-run' }
  | { state: 'loading' };

function coverageDisplay(story: Story, cover: CoverageReport | null, byStory: Map<string, StoryCoverage>): CoverageDisplay {
  if (!cover) return { state: 'loading' };
  const entry = byStory.get(story.id);
  if (entry) return { state: entry.state, entry };
  // No entry from the server. An unmapped story is `uncovered` regardless of any run; a MAPPED
  // story with no entry means the server deferred its verdict — "no run yet" (never silently green).
  if (!story.specFiles?.length) return { state: 'uncovered' };
  return { state: 'no-run' };
}

interface Rollup {
  covered: number; failing: number; stale: number; uncovered: number; norun: number; loading: number;
}
function tallyCoverage(stories: Story[], displayFor: (s: Story) => CoverageDisplay): Rollup {
  const r: Rollup = { covered: 0, failing: 0, stale: 0, uncovered: 0, norun: 0, loading: 0 };
  for (const s of stories) {
    const d = displayFor(s);
    if (d.state === 'covered') r.covered++;
    else if (d.state === 'failing') r.failing++;
    else if (d.state === 'stale-missing') r.stale++;
    else if (d.state === 'uncovered') r.uncovered++;
    else if (d.state === 'no-run') r.norun++;
    else r.loading++;
  }
  return r;
}

function RollupBadges({ rollup, hasRun, loading }: { rollup: Rollup; hasRun: boolean | null; loading: boolean }) {
  const total = rollup.covered + rollup.failing + rollup.stale + rollup.uncovered + rollup.norun + rollup.loading;
  if (total === 0) return null;
  return (
    <span className="st-rollup" title="derived from the latest non-gate e2e run — never stored">
      {rollup.covered > 0 && <span className="st-cov covered">{rollup.covered} covered</span>}
      {rollup.failing > 0 && <span className="st-cov failing">{rollup.failing} failing</span>}
      {rollup.stale > 0 && <span className="st-cov stale">{rollup.stale} stale</span>}
      {rollup.uncovered > 0 && <span className="st-cov uncovered">{rollup.uncovered} uncovered</span>}
      {rollup.norun > 0 && <span className="st-cov norun">{rollup.norun} no run yet</span>}
      {hasRun === false && rollup.norun === 0 && !loading && (
        <span className="st-cov norun" title="no non-gate e2e run with results for this project yet">no run yet</span>
      )}
    </span>
  );
}

/** The per-story coverage badge. Green is earned only by `covered`; every other state is a distinct,
 *  honest signal (§1.4) — a wrong or dead mapping reads `stale`, never a false `covered`. */
function CoverageBadge({ display }: { display: CoverageDisplay }) {
  switch (display.state) {
    case 'loading':
      return <span className="st-cov loading">…</span>;
    case 'covered':
      return <span className="st-cov covered" title="every mapped spec ran and passed">covered</span>;
    case 'failing': {
      const specs = display.entry?.failingSpecs ?? [];
      return (
        <span className="st-cov failing" title={specs.length ? `failing: ${specs.join(', ')}` : 'a mapped spec is red'}>
          failing{specs.length > 1 ? ` (${specs.length})` : ''}
        </span>
      );
    }
    case 'stale-missing': {
      const specs = display.entry?.missingSpecs ?? [];
      return (
        <span className="st-cov stale" title={specs.length ? `mapped spec never ran: ${specs.join(', ')}` : 'a mapped spec never ran'}>
          stale
        </span>
      );
    }
    case 'uncovered':
      return <span className="st-cov uncovered" title="no Playwright spec is mapped to this story">uncovered</span>;
    case 'no-run':
      return <span className="st-cov norun" title="no non-gate e2e run with results for this project yet">no run yet</span>;
  }
}

// ============================================================================
//  A saved-story row (view mode)
// ============================================================================

function StoryRow({
  story,
  display,
  onEdit,
  onRemove,
}: {
  story: Story;
  display: CoverageDisplay;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="st-row">
      <div className="st-row-main">
        <div className="st-row-head">
          <span className="st-title">{story.title}</span>
          <span className={`st-status ${story.status}`}>{story.status}</span>
          <CoverageBadge display={display} />
        </div>
        <div className="st-story">{story.story}</div>
        {(story.routes?.length || story.specFiles?.length) ? (
          <div className="st-tags">
            {story.routes?.map((r) => <span key={`r-${r}`} className="st-tag route mono">{r}</span>)}
            {story.specFiles?.map((f) => <span key={`s-${f}`} className="st-tag spec mono">{f}</span>)}
          </div>
        ) : null}
      </div>
      <div className="st-row-actions">
        <button className="btn-sm" onClick={onEdit}>edit</button>
        <button className="btn-sm danger" onClick={onRemove}>remove</button>
      </div>
    </div>
  );
}

// ============================================================================
//  The add / edit / draft-review form (one component, three modes)
// ============================================================================

function StoryForm({
  mode,
  initial,
  onSave,
  onCancel,
  onChange,
  onError,
}: {
  mode: 'new' | 'edit' | 'draft';
  initial: FormState;
  onSave: (f: FormState) => Promise<void>;
  onCancel: () => void;
  /** Called on every field edit so a parent holding this entry (pending[]) can mirror the live
   *  form and its "Save all" reads current values. Optional: the edit mode has no such parent. */
  onChange?: (f: FormState) => void;
  onError: (m: string) => void;
}) {
  const [f, setF] = useState<FormState>(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    const next: FormState = { ...f, [k]: v };
    setF(next);
    onChange?.(next);
  };
  const errors = useMemo(() => validate(f), [f]);
  const specs = useMemo(() => parseList(f.specsStr), [f.specsStr]);
  const routes = useMemo(() => parseList(f.routesStr), [f.routesStr]);
  const shapeOff = f.story.trim().length > 0 && !SHAPE_RE.test(f.story);

  const save = async () => {
    const first = errors[0];
    if (first) { onError(first); return; }
    setBusy(true);
    try {
      await onSave(f);
    } catch (e) {
      onError((e as Error).message);
      setBusy(false); // stay open on failure so the operator can retry / fix
    }
  };

  const label = mode === 'edit' ? 'Edit story' : mode === 'draft' ? 'Drafted story' : 'New story';
  return (
    <div className={`st-form${mode === 'draft' ? ' draft' : ''}`}>
      <div className="st-form-head">
        <strong>{label}</strong>
        {mode === 'draft' && <span className="st-form-badge">Jarvis draft</span>}
        <span className="st-spacer" />
        <button className="btn-sm ghost" disabled={busy} onClick={onCancel}>
          {mode === 'edit' ? 'cancel' : 'discard'}
        </button>
      </div>

      <div className="field">
        <label>Title</label>
        <input value={f.title} placeholder="Browse the catalog signed out" onChange={(e) => set('title', e.target.value)} />
      </div>

      <div className="field">
        <label>Story</label>
        <textarea
          value={f.story}
          placeholder="As a signed-out visitor I want to browse the catalog so that I can decide before I sign up"
          onChange={(e) => set('story', e.target.value)}
        />
        {shapeOff && <span className="st-hint">Tip: the house form is “As a &lt;role&gt; I want &lt;capability&gt; so that &lt;benefit&gt;”.</span>}
      </div>

      <div className="field-row">
        <div className="field">
          <label>Routes</label>
          <input className="mono" value={f.routesStr} placeholder="/catalog, /product/:id"
            onChange={(e) => set('routesStr', e.target.value)} />
          <span className="st-hint">comma- or newline-separated · free text, for the UI</span>
          {routes.length > 0 && (
            <div className="st-chips">{routes.map((r) => <span key={r} className="st-tag route mono">{r}</span>)}</div>
          )}
        </div>
        <div className="field">
          <label>Spec files</label>
          <input className="mono" value={f.specsStr} placeholder="tests/catalog.spec.ts"
            onChange={(e) => set('specsStr', e.target.value)} />
          <span className="st-hint">the coverage join key · repo-relative <span className="mono">*.spec|test.[jt]sx?</span></span>
          {specs.length > 0 && (
            <div className="st-chips">
              {specs.map((s) => (
                <span key={s} className={`st-tag spec mono${specInvalid(s) ? ' bad' : ''}`}
                  title={specInvalid(s) ? 'invalid path — will be rejected on save' : undefined}>
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="field">
        <label>Status</label>
        <div className="seg-choice">
          {STATUSES.map((st) => (
            <button key={st.id} className={f.status === st.id ? 'sel' : ''} title={st.hint}
              onClick={() => set('status', st.id)}>
              {st.label}
            </button>
          ))}
        </div>
      </div>

      {errors.length > 0 && (
        <ul className="st-errors">{errors.map((m, i) => <li key={i}>{m}</li>)}</ul>
      )}

      <div className="st-form-actions">
        <button className="btn ok" disabled={busy || errors.length > 0} onClick={() => void save()}>
          {busy ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Save story'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={onCancel}>
          {mode === 'edit' ? 'Cancel' : 'Discard'}
        </button>
      </div>
    </div>
  );
}

/** Save every pending entry in sequence, stopping (and surfacing) on the first failure. Each
 *  successful save removes its own entry via the per-entry `savePending`. */
async function saveAllPending(
  pending: Pending[],
  savePending: (tempId: string, f: FormState) => Promise<void>,
  onError: (m: string) => void,
) {
  for (const p of pending) {
    const errs = validate(p.form);
    if (errs.length) { onError(`“${p.form.title || 'untitled'}”: ${errs[0]}`); return; }
  }
  for (const p of pending) {
    try {
      await savePending(p.tempId, p.form);
    } catch (e) {
      onError(`“${p.form.title || 'untitled'}”: ${(e as Error).message}`);
      return;
    }
  }
}
