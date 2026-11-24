// Board — the fleet's single pane over STORED INTAKE and DERIVED EXECUTION (SPEC-BACKLOG §4).
// Three stored lanes (Triage → Todo → Ready) hold Task cards the operator authors before any
// agent runs; four derived lanes (Clearance → Working → Gate → Landed) place every terminal /
// loop / mission by its LIVE status. Still derived truth for the execution half: no drag, zero
// fetches, all data and control flow in via props.
//
// Linked-task display (⟦DP-B8⟧, hardened by review): the ONLY success signal that hides a task
// for good is its own archivedAt (server truth via auto-archive) — a finished run whose
// auto-archive missed leaves the task VISIBLE with a "run landed/finished" chip and a prominent
// archive, never a black hole. A linked run that was itself archived shows "run archived".
// Otherwise: a still-'draft' mission shows "◇ drafted" (opens it); failed/stopped shows
// "✗ run ended"; an active run hides the task (its execution card is the work — paused
// missions/loops render as Clearance cards so operator-held work never vanishes); a link that
// resolves to no loaded record renders plainly with an honest "link?" chip. A task whose
// composer is open right now (draftingTaskIds) shows "drafting…" with actions withheld.
//
// Archived-rendering asymmetry (deliberate): EXECUTION records keep their column semantics —
// when show-archived is on they render dimmed IN their normal column, sorted after live cards
// so the toggle only ever ADDS; off, they drop out. TASKS lose lane membership on archive, so
// archived tasks collect in ONE trailing, collapsible "Archive" column (capped like Landed).
//
// The only local state here is presentational: the Triage quick-add's text/project/busy, the
// Archive column's expansion, and the Clear-finished arm. No board data is held or cached.

import { useEffect, useMemo, useState } from 'react';
import type {
  Project, Terminal, Loop, Mission, Task, TaskStatus, CreateTaskRequest, ProviderId, ValidatorVerdict,
} from '../shared/types.js';
import { timeAgo } from './flightline-utils.js';

// ---- provider idioms (mirror App.tsx) ----
// Built-in literals are checked first so their narrowing/badges are unchanged; a custom:<slug>
// id (⟦DP-1⟧/§1.2) gets a generic 'CU' badge and its slug as the short label — the composer
// roster carries the full displayName, the badge only needs to read "a registered custom agent".
function avClass(p: ProviderId): 'cc' | 'gm' | 'cx' | 'he' | 'cu' | 'sh' {
  return p === 'claude-code' ? 'cc' : p === 'gemini-cli' ? 'gm' : p === 'codex' ? 'cx' : p === 'hermes' ? 'he'
    : p.startsWith('custom:') ? 'cu' : 'sh';
}
function avText(p: ProviderId): string {
  return p === 'claude-code' ? 'CC' : p === 'gemini-cli' ? 'GM' : p === 'codex' ? 'CX' : p === 'hermes' ? 'HE'
    : p.startsWith('custom:') ? 'CU' : 'SH';
}
function providerShort(p: ProviderId): string {
  return p === 'claude-code' ? 'claude' : p === 'gemini-cli' ? 'gemini' : p === 'codex' ? 'codex' : p === 'hermes' ? 'hermes'
    : p.startsWith('custom:') ? p.slice('custom:'.length) : 'shell';
}

// ---- stored lanes (Task cards) ----
type StoredLaneId = 'triage' | 'todo' | 'ready';
const STORED_LANES: { id: StoredLaneId; name: string }[] = [
  { id: 'triage', name: 'Triage' },
  { id: 'todo', name: 'Todo' },
  { id: 'ready', name: 'Ready' },
];
// One-step lane moves — no drag; the operator promotes/demotes explicitly. Ready has no promote
// (leaving Ready is instantiation, not a status), Triage no demote.
const NEXT_LANE: Record<StoredLaneId, StoredLaneId | null> = { triage: 'todo', todo: 'ready', ready: null };
const PREV_LANE: Record<StoredLaneId, StoredLaneId | null> = { triage: null, todo: 'triage', ready: 'todo' };

/** How a visible stored task wears its execution link. `null` from linkFor = hidden (active run
 *  or already archived) — 'none' means STRICTLY unlinked, the only state with lane-move +
 *  instantiation actions. 'ended' carries the honest chip label (run ended / archived / landed). */
type LinkInfo =
  | { kind: 'none' }
  | { kind: 'drafting' }
  | { kind: 'drafted'; missionId: string }
  | { kind: 'ended'; label: string }
  | { kind: 'stale' };

// The display rule (header comment). Computed from Maps built once per derivation pass.
function linkFor(
  task: Task,
  loopById: Map<string, Loop>,
  missionById: Map<string, Mission>,
): LinkInfo | null {
  if (!task.missionId && !task.loopId) return { kind: 'none' };
  if (task.missionId) {
    const m = missionById.get(task.missionId);
    if (!m) return { kind: 'stale' };
    if (m.archivedAt) return { kind: 'ended', label: '✗ run archived' };
    if (m.status === 'draft') return { kind: 'drafted', missionId: m.id };
    if (m.status === 'failed') return { kind: 'ended', label: '✗ run ended' };
    // done reaching HERE means the task outlived auto-archive (it fires best-effort on the
    // done transition) — surface it with an archive affordance, never a hidden orphan.
    if (m.status === 'done') return { kind: 'ended', label: '✓ run finished' };
    return null; // running / phase-gate / paused / attention — the execution card is the work
  }
  const l = loopById.get(task.loopId!);
  if (!l) return { kind: 'stale' };
  if (l.archivedAt) return { kind: 'ended', label: '✗ run archived' };
  if (l.status === 'stopped' || l.status === 'failed') return { kind: 'ended', label: '✗ run ended' };
  if (l.landedAt) return { kind: 'ended', label: '✓ run landed' }; // auto-archive missed — surface
  return null; // running / gated / paused / done-unlanded — live board presence
}

// ⟦DP-B3⟧ stored order: priority ascending (P0 first, absent last), then updatedAt desc.
function taskOrder(a: Task, b: Task): number {
  const pa = a.priority ?? 99;
  const pb = b.priority ?? 99;
  if (pa !== pb) return pa - pb;
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

// ---- derived lanes (terminals / loops / missions) ----
type DerivedColumnId = 'clearance' | 'working' | 'gate' | 'landed';
const DERIVED_COLUMNS: { id: DerivedColumnId; name: string }[] = [
  { id: 'clearance', name: 'Clearance' },
  { id: 'working', name: 'Working' },
  { id: 'gate', name: 'Gate' },
  { id: 'landed', name: 'Landed' },
];
const LANDED_CAP = 20; // Landed shows the most recent, capped (SPEC-FACTORY §4).
const ARCHIVE_CAP = 40; // the Archive column mirrors the cap idea — archived tasks never prune.

interface ValidatorChip { verdict: ValidatorVerdict; pass: number; total: number }
interface BoardCardData {
  key: string;
  provider: ProviderId;
  projectName: string;
  title: string;
  ageIso?: string;
  /** Sort key (epoch ms) — most recent first within a column. */
  ts: number;
  /** Mission name tag for a sortie loop. */
  missionName?: string;
  /** Loop iteration chip, e.g. "i3/8". */
  iter?: string;
  /** SPEC-MEMORY — the builder's latest `towerctl note` (LoopIteration.progress); one clamped line. */
  progress?: string;
  validator?: ValidatorChip;
  /** Archived record shown in-column dimmed while show-archived is on. */
  archived?: boolean;
  /** Present on a FINISHED, unarchived record: the per-card single-record archive. */
  onArchive?: () => void;
  onClick?: () => void;
}

export function BoardView({
  projects, terminals, loops, missions, tasks, showArchived, draftingTaskIds,
  onOpenTerminal, onOpenMission, onToggleShowArchived,
  onTaskCreate, onTaskUpdate, onTaskArchive, onArchiveLoop, onArchiveMission,
  onDraftMission, onComposeLoop, onClearFinished,
}: {
  projects: Project[];
  terminals: (Terminal & { alive: boolean })[];
  loops: Loop[];
  missions: Mission[];
  tasks: Task[];
  showArchived: boolean;
  /** Tasks with a composer open on them this session — chip shown, actions withheld (§2). */
  draftingTaskIds: ReadonlySet<string>;
  onOpenTerminal: (id: string) => void;
  onOpenMission: (id: string) => void;
  onToggleShowArchived: () => void;
  /** Resolves on server accept — the quick-add clears its text only then (a failed create
   *  keeps the operator's typing). Rejections are surfaced by the parent. */
  onTaskCreate: (req: CreateTaskRequest) => Promise<void>;
  onTaskUpdate: (id: string, patch: { status?: TaskStatus }) => void;
  onTaskArchive: (id: string) => void;
  onArchiveLoop: (id: string) => void;
  onArchiveMission: (id: string) => void;
  onDraftMission: (task: Task) => void;
  onComposeLoop: (task: Task) => void;
  onClearFinished: () => void;
}) {
  const [quickAddText, setQuickAddText] = useState('');
  const [quickAddProject, setQuickAddProject] = useState('');
  const [quickAddBusy, setQuickAddBusy] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Two-click arm for the bulk sweep (the house confirm idiom — MissionsView's abort pattern);
  // disarms on its own after a beat so a stale armed state can't linger.
  const [armClear, setArmClear] = useState(false);
  useEffect(() => {
    if (!armClear) return;
    const t = setTimeout(() => setArmClear(false), 4000);
    return () => clearTimeout(t);
  }, [armClear]);

  // The whole board derivation is one memo: App re-renders on every SSE frame (terminal ticks
  // included), and an unrelated frame must not re-partition and re-sort every lane. Lookups go
  // through Maps built once here — never a find() per card.
  const { cols, storedCols, archivedTasks, archivedTotal, total, projNameOf } = useMemo(() => {
    const projById = new Map(projects.map((p) => [p.id, p.name] as const));
    const loopById = new Map(loops.map((l) => [l.id, l] as const));
    const missionById = new Map(missions.map((m) => [m.id, m] as const));
    const projNameOf = (id: string) => projById.get(id) ?? id;

    const cols: Record<DerivedColumnId, BoardCardData[]> = { clearance: [], working: [], gate: [], landed: [] };

    // A terminal driven by a loop is represented by the loop's card, not a duplicate terminal card.
    const loopTerminalIds = new Set(loops.map((l) => l.terminalId).filter((x): x is string => !!x));

    // ---- bare terminals (no gating loop) ----
    for (const t of terminals) {
      if (loopTerminalIds.has(t.id)) continue;
      let col: DerivedColumnId | null = null;
      if (t.state === 'blocked-question' || t.state === 'blocked-permission') col = 'clearance';
      // A 'working' record with a dead session is stale, not working — suppress it.
      else if (t.state === 'working' && t.alive !== false) col = 'working';
      if (!col) continue;
      const age = t.lastEventAt ?? t.createdAt;
      cols[col].push({
        key: `t:${t.id}`,
        provider: t.provider,
        projectName: projNameOf(t.projectId),
        title: t.title,
        ageIso: age,
        ts: Date.parse(age) || 0,
        onClick: () => onOpenTerminal(t.id),
      });
    }

    // ---- loops (these also represent mission sorties, tagged with the mission name) ----
    for (const l of loops) {
      if (l.archivedAt && !showArchived) continue; // filtered unless show-archived; then dimmed in-column
      let col: DerivedColumnId | null = null;
      if (l.landedAt) col = 'landed';                                              // landed wins
      else if (l.status === 'gated' || l.status === 'failed' || l.status === 'stopped') col = 'clearance';
      // Paused is operator-held, not invisible: without a card here, a paused run linked to a
      // task would vanish from the board entirely (the task hides while its run is alive).
      else if (l.status === 'paused') col = 'clearance';
      else if (l.status === 'running') col = 'working';
      else if (l.status === 'done') col = 'gate';                                  // done, awaiting Review & Land
      if (!col) continue;
      const last = l.iterations.at(-1);
      const v = last?.validator;
      const finished = Boolean(l.landedAt) || l.status === 'stopped' || l.status === 'failed';
      cols[col].push({
        key: `l:${l.id}`,
        provider: l.provider,
        projectName: projNameOf(l.projectId),
        title: l.name,
        ageIso: l.updatedAt,
        ts: Date.parse(l.updatedAt) || 0,
        missionName: l.missionId ? missionById.get(l.missionId)?.name : undefined,
        iter: `i${l.iteration}/${l.maxIterations}`,
        progress: last?.progress,
        validator: v ? { verdict: v.verdict, pass: v.results.filter((r) => r.pass).length, total: v.results.length } : undefined,
        archived: !!l.archivedAt,
        onArchive: finished && !l.archivedAt ? () => onArchiveLoop(l.id) : undefined,
        onClick: l.terminalId ? () => onOpenTerminal(l.terminalId!) : undefined,
      });
    }

    // ---- missions (a card at a phase gate / attention / paused, or when done) ----
    for (const m of missions) {
      if (m.archivedAt && !showArchived) continue; // same asymmetry as loops: dimmed in-column when shown
      let col: DerivedColumnId | null = null;
      if (m.status === 'phase-gate' || m.status === 'attention' || m.status === 'paused') col = 'clearance';
      else if (m.status === 'done') col = 'landed';
      else if (m.status === 'failed') col = 'clearance';
      if (!col) continue; // running missions are represented by their sortie loops; drafts by MissionsView
      const finished = m.status === 'done' || m.status === 'failed';
      cols[col].push({
        key: `m:${m.id}`,
        provider: m.provider,
        projectName: projNameOf(m.projectId),
        title: m.name,
        ageIso: m.updatedAt,
        ts: Date.parse(m.updatedAt) || 0,
        archived: !!m.archivedAt,
        onArchive: finished && !m.archivedAt ? () => onArchiveMission(m.id) : undefined,
        onClick: () => onOpenMission(m.id),
      });
    }

    // Live cards always outrank archived ones inside a column, so show-archived only ever ADDS
    // dimmed cards after the live set — it can never push a live card past the Landed cap.
    for (const c of DERIVED_COLUMNS) {
      cols[c.id].sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0) || b.ts - a.ts);
    }
    cols.landed = cols.landed.slice(0, LANDED_CAP);

    // ---- stored lanes (Task cards) + the archived-tasks pool ----
    const storedCols: Record<StoredLaneId, { task: Task; link: LinkInfo }[]> = { triage: [], todo: [], ready: [] };
    const allArchived: Task[] = [];
    for (const task of tasks) {
      if (task.status === 'archived' || task.archivedAt) { allArchived.push(task); continue; }
      const link = draftingTaskIds.has(task.id)
        ? ({ kind: 'drafting' } as LinkInfo)
        : linkFor(task, loopById, missionById);
      if (link === null) continue; // the execution card is the work
      storedCols[task.status].push({ task, link });
    }
    for (const lane of STORED_LANES) storedCols[lane.id].sort((a, b) => taskOrder(a.task, b.task));
    allArchived.sort((a, b) => (Date.parse(b.archivedAt ?? b.updatedAt) || 0) - (Date.parse(a.archivedAt ?? a.updatedAt) || 0));
    const archivedTasks = allArchived.slice(0, ARCHIVE_CAP);

    const storedTotal = STORED_LANES.reduce((n, l) => n + storedCols[l.id].length, 0);
    const derivedTotal = DERIVED_COLUMNS.reduce((n, c) => n + cols[c.id].length, 0);
    return {
      cols, storedCols, archivedTasks, archivedTotal: allArchived.length,
      total: storedTotal + derivedTotal, projNameOf,
    };
  }, [projects, terminals, loops, missions, tasks, showArchived, draftingTaskIds,
    onOpenTerminal, onOpenMission, onArchiveLoop, onArchiveMission]);

  // Quick-add needs a project; default to the first, honour an explicit pick. The text clears
  // only on server accept — a failed create keeps the operator's typing (the parent surfaces
  // the error). Enter during IME composition confirms the candidate, never submits.
  const addProject = quickAddProject || (projects[0]?.id ?? '');
  const submitQuickAdd = () => {
    const title = quickAddText.trim();
    if (!title || !addProject || quickAddBusy) return;
    setQuickAddBusy(true);
    onTaskCreate({ projectId: addProject, title, status: 'triage' })
      .then(() => setQuickAddText(''))
      .catch(() => { /* parent surfaced it; keep the text */ })
      .finally(() => setQuickAddBusy(false));
  };

  return (
    <div className="board-view">
      <div className="board-head">
        <h1>Board</h1>
        <span className="board-sub">stored intake · derived execution · {total} card{total === 1 ? '' : 's'}</span>
        <div className="board-head-actions">
          <button className={`board-head-btn ${armClear ? 'is-armed' : ''}`}
            onClick={() => { if (armClear) { setArmClear(false); onClearFinished(); } else { setArmClear(true); } }}>
            {armClear ? 'Confirm clear?' : 'Clear finished'}
          </button>
          <button
            className={`board-head-btn board-toggle${showArchived ? ' is-on' : ''}`}
            aria-pressed={showArchived}
            onClick={onToggleShowArchived}
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        </div>
      </div>
      <div className="board">
        {STORED_LANES.map((lane) => {
          const items = storedCols[lane.id];
          return (
            <section className={`board-col board-${lane.id}`} key={lane.id}>
              <h3>{lane.name}<span className="board-count">{items.length}</span></h3>
              {lane.id === 'triage' && (
                <div className="board-quickadd">
                  <select
                    className="board-qa-proj"
                    value={addProject}
                    disabled={projects.length === 0}
                    onChange={(e) => setQuickAddProject(e.target.value)}
                    aria-label="Project for the new task"
                  >
                    {projects.length === 0
                      ? <option value="">No projects</option>
                      : projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input
                    className="board-qa-input"
                    value={quickAddText}
                    placeholder={projects.length ? 'Quick add task ⏎' : 'Add a project first'}
                    disabled={!addProject || quickAddBusy}
                    onChange={(e) => setQuickAddText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitQuickAdd();
                    }}
                  />
                </div>
              )}
              <div className="board-list">
                {items.length === 0
                  ? <div className="board-empty">—</div>
                  : items.map(({ task, link }) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        projectName={projNameOf(task.projectId)}
                        link={link}
                        prevLane={PREV_LANE[lane.id]}
                        nextLane={NEXT_LANE[lane.id]}
                        canInstantiate={lane.id === 'todo' || lane.id === 'ready'}
                        onTaskUpdate={onTaskUpdate}
                        onTaskArchive={onTaskArchive}
                        onDraftMission={onDraftMission}
                        onComposeLoop={onComposeLoop}
                        onOpenMission={onOpenMission}
                      />
                    ))}
              </div>
            </section>
          );
        })}

        {DERIVED_COLUMNS.map((c) => {
          const items = cols[c.id];
          return (
            <section className={`board-col board-${c.id}`} key={c.id}>
              <h3>{c.name}<span className="board-count">{items.length}</span></h3>
              <div className="board-list">
                {items.length === 0
                  ? <div className="board-empty">—</div>
                  : items.map((card) => <BoardCard key={card.key} card={card} />)}
              </div>
            </section>
          );
        })}

        {showArchived && (
          <section className={`board-col board-col-archive${archiveOpen ? '' : ' is-collapsed'}`}>
            <button
              className="board-arch-head"
              aria-expanded={archiveOpen}
              onClick={() => setArchiveOpen((o) => !o)}
            >
              <span className="board-arch-caret">{archiveOpen ? '▾' : '▸'}</span>
              Archive<span className="board-count">{archivedTotal}</span>
            </button>
            <div className="board-list">
              {archivedTasks.length === 0
                ? <div className="board-empty">—</div>
                : archivedTasks.map((task) => (
                    <ArchivedTaskCard
                      key={task.id}
                      task={task}
                      projectName={projNameOf(task.projectId)}
                      onTaskUpdate={onTaskUpdate}
                    />
                  ))}
              {archivedTotal > archivedTasks.length && (
                <div className="board-empty" title="Older archived tasks are retained in the store">
                  +{archivedTotal - archivedTasks.length} older
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task, projectName, link, prevLane, nextLane, canInstantiate,
  onTaskUpdate, onTaskArchive, onDraftMission, onComposeLoop, onOpenMission,
}: {
  task: Task;
  projectName: string;
  link: LinkInfo;
  prevLane: StoredLaneId | null;
  nextLane: StoredLaneId | null;
  canInstantiate: boolean;
  onTaskUpdate: (id: string, patch: { status?: TaskStatus }) => void;
  onTaskArchive: (id: string) => void;
  onDraftMission: (task: Task) => void;
  onComposeLoop: (task: Task) => void;
  onOpenMission: (id: string) => void;
}) {
  const emptyBody = !task.body || !task.body.trim();
  // Only a STRICTLY unlinked card offers lane moves + instantiation — the store rejects any
  // other status change on a linked task, and a second instantiation would orphan a run (link
  // stamping refuses to overwrite). 'drafting' withholds everything but the chip.
  const unlinked = link.kind === 'none';
  const bodyHint = emptyBody ? ' — this task has no body, so the goal is just the title' : '';
  return (
    <div className="board-card board-task-card" title={task.body || undefined}>
      <div className="board-card-head">
        <span className="board-proj">{projectName}</span>
        {task.priority !== undefined && (
          <span className={`board-pchip board-p${task.priority}`}>P{task.priority}</span>
        )}
        <span className="board-age">{timeAgo(task.updatedAt)}</span>
      </div>
      <div className="board-card-title">{task.title}</div>

      {link.kind !== 'none' && (
        <div className="board-card-meta">
          {link.kind === 'drafting' && (
            <span className="board-linkchip board-linkchip-draft" title="A composer is open on this task">drafting…</span>
          )}
          {link.kind === 'drafted' && (
            <button className="board-linkchip board-linkchip-draft" onClick={() => onOpenMission(link.missionId)}>◇ drafted</button>
          )}
          {link.kind === 'ended' && <span className="board-linkchip board-linkchip-ended">{link.label}</span>}
          {link.kind === 'stale' && (
            <span className="board-linkchip board-linkchip-stale" title="Linked run not found — the link is stale">link?</span>
          )}
        </div>
      )}

      {link.kind !== 'drafting' && (
        <div className="board-task-actions">
          {unlinked ? (
            <>
              {prevLane && (
                <button className="board-act" title={`Move back to ${prevLane}`} onClick={() => onTaskUpdate(task.id, { status: prevLane })}>←</button>
              )}
              {nextLane && (
                <button className="board-act" title={`Move to ${nextLane}`} onClick={() => onTaskUpdate(task.id, { status: nextLane })}>→</button>
              )}
              {canInstantiate && (
                <>
                  <button className="board-act" title={`Draft a mission from this task${bodyHint}`} onClick={() => onDraftMission(task)}>
                    Draft mission{emptyBody && <span className="board-warn-dot" aria-hidden="true">!</span>}
                  </button>
                  <button className="board-act" title={`Compose a loop from this task${bodyHint}`} onClick={() => onComposeLoop(task)}>
                    Compose loop{emptyBody && <span className="board-warn-dot" aria-hidden="true">!</span>}
                  </button>
                </>
              )}
              <button className="board-act board-act-arch" title="Archive this task" onClick={() => onTaskArchive(task.id)}>Archive</button>
            </>
          ) : (
            <button
              className={`board-act board-act-arch${link.kind === 'ended' ? ' is-prominent' : ''}`}
              title="Archive this task"
              onClick={() => onTaskArchive(task.id)}
            >
              Archive
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ArchivedTaskCard({
  task, projectName, onTaskUpdate,
}: {
  task: Task;
  projectName: string;
  onTaskUpdate: (id: string, patch: { status?: TaskStatus }) => void;
}) {
  // Only an unlinked archived task can be restored — the store accepts archived→triage as the
  // undo for those, but rejects any status change on a linked task.
  const linked = !!(task.missionId || task.loopId);
  return (
    <div className="board-card board-task-card board-card-archived" title={task.body || undefined}>
      <div className="board-card-head">
        <span className="board-proj">{projectName}</span>
        {task.priority !== undefined && (
          <span className={`board-pchip board-p${task.priority}`}>P{task.priority}</span>
        )}
        <span className="board-age">{timeAgo(task.archivedAt ?? task.updatedAt)}</span>
      </div>
      <div className="board-card-title">{task.title}</div>
      {!linked && (
        <div className="board-task-actions">
          <button className="board-act" title="Restore this task to Triage" onClick={() => onTaskUpdate(task.id, { status: 'triage' })}>↩ Restore</button>
        </div>
      )}
    </div>
  );
}

function validatorLabel(v: ValidatorChip): string {
  const g = v.verdict === 'pass' ? '✓' : v.verdict === 'fail' ? '✗' : '?';
  return v.total > 0 ? `${g} ${v.pass}/${v.total}` : g;
}

function BoardCard({ card }: { card: BoardCardData }) {
  const inner = (
    <>
      <div className="board-card-head">
        <span className="board-proj">{card.projectName}</span>
        <span className={`board-av board-av-${avClass(card.provider)}`}>{avText(card.provider)}</span>
      </div>
      <div className="board-card-title">{card.title}</div>
      {/* SPEC-MEMORY — the builder's own progress note, between the title and the meta chips: one clamped
          line, full text in the title. Only a loop card carries it. */}
      {card.progress && (
        <div className="progress" title={card.progress}>
          <span className="lbl">progress</span>
          <span className="txt">{card.progress}</span>
        </div>
      )}
      <div className="board-card-meta">
        <span className="muted">{providerShort(card.provider)}</span>
        {card.iter && <span className="board-chip mono">{card.iter}</span>}
        {card.validator && (
          <span className={`board-val board-val-${card.validator.verdict}`}>{validatorLabel(card.validator)}</span>
        )}
        {card.missionName && <span className="board-tag">◇ {card.missionName}</span>}
        <span className="board-age">{timeAgo(card.ageIso)}</span>
        {card.onArchive && (
          <button
            className="board-act board-act-arch"
            title="Archive this finished record"
            onClick={(e) => { e.stopPropagation(); card.onArchive!(); }}
          >
            ✕
          </button>
        )}
      </div>
    </>
  );
  const cls = `board-card${card.archived ? ' board-card-archived' : ''}`;
  // A card with an inner archive button renders as a div (nested <button> is invalid HTML);
  // its whole surface stays clickable via onClick, keyboard access via the inner controls.
  if (card.onArchive) {
    return (
      <div className={`${cls}${card.onClick ? '' : ' board-card-static'}`}
        onClick={card.onClick} role={card.onClick ? 'button' : undefined}>
        {inner}
      </div>
    );
  }
  return card.onClick
    ? <button className={cls} onClick={card.onClick}>{inner}</button>
    : <div className={`${cls} board-card-static`}>{inner}</div>;
}
