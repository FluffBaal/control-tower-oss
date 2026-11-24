// Control Tower — Missions view (SPEC-FACTORY §2). A planned multi-phase campaign the
// autopilot advances at phase boundaries. Three surfaces in one self-contained state
// machine: list → detail → compose. The mission's control points are assertions (forced
// gate on inconclusive), the PHASE GATE (Land & advance), and pause/abort/retry — there is
// NO per-iteration gate (mission loops always run gatePolicy:'never'). Landing is BATCHED
// at the phase boundary; a partial-advance failure lands mission → attention with the card
// naming exactly which sorties already merged.
//
// Source of truth is the `missions` prop (integrator keeps it live via the mission-state
// SSE frame + refresh). Actions call the api and rely on that update — this view holds no
// mission state of its own, only which screen is showing.

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Mission, MissionStatus, MissionSortie, MissionPlanReview, SortieStatus, ProviderId,
  Project, CreateMissionRequest, ProjectTestingConfig, ProviderDef, RoleAssignment, RoleRouting, PipelineRole, Loop,
  AgentProfile, PhaseStage,
} from '../shared/types.js';
import { LOOP_VERIFY_TASK, LOOP_REVIEW_TASK, REVIEW_CHECK_COMMAND, RESEARCH_CHECK_COMMAND } from '../shared/types.js';
import { PIPELINE_ROLES } from '../shared/roles.js';
import type { EffectiveRoleRoute, ProjectRoutingView, TestRunInfo, ConsultView, TerminalWithLiveness } from './api.js';
import { ModelSelect } from './ModelSelect.js';
import { EffortSelect } from './EffortSelect.js';
import { SuiteChip } from './SuiteChip.js';
import { MissionReportSection } from './MissionReport.js';

// SPEC-STORYLOOP §5.1/§0.2 — the one-click e2e-kit preset for a sortie's check command and the
// runner sortie's check. `towerctl test run` is the only kit entrypoint (⟦§0.2⟧), and the check
// must ALWAYS be it: a raw suite command bypasses the kit, so no TestRun is recorded and the
// fixer/docs phase assignment finds nothing (the mission stalls to attention). SPEC-TESTING §4:
// a project's ProjectTestingConfig.suiteCommand rides the ACQUIRE response server-side — the kit
// runs it internally, so it never replaces this entrypoint client-side.
const E2E_SUITE_CMD = 'towerctl test run';

// SPEC-STORYLOOP §4 — the mission's regression-gate suite. The gate runs IN-PROCESS in the
// Tower against a trial-merge worktree and holds NO terminal token, so it execs the RAW suite
// command directly — NOT `towerctl test run` (which needs an agent token and would fail every
// advance). Keep this the raw runner, distinct from E2E_SUITE_CMD. SPEC-TESTING §4: the FALLBACK —
// a project's ProjectTestingConfig.gateSuite replaces it when set.
const GATE_SUITE_CMD = 'npx playwright test';

/** The mission control surface the integrator wires to api.ts (see integration notes). */
export type MissionApi = {
  createMission: (req: CreateMissionRequest) => Promise<Mission>;
  startMission: (id: string) => Promise<Mission>;
  /** SPEC-LOOP W3 (G4) — grade a draft's plan (fact-check + red-team, read-only) before start; may
   *  auto-redraft once on a block. Idempotent on a stored PASS unless `force`. Returns the stored grade. */
  reviewPlan: (id: string, force?: boolean) => Promise<{ planReview: MissionPlanReview }>;
  pauseMission: (id: string) => Promise<Mission>;
  abortMission: (id: string) => Promise<Mission>;
  advanceMission: (id: string) => Promise<Mission>;
  retrySortie: (id: string, sortieId: string) => Promise<Mission>;
  planMission: (projectId: string, goal: string) => Promise<CreateMissionRequest['phases']>;
  /** ⟦NEW — integrator wires to tower.getProjectRouting (GET /api/projects/:id/routing)⟧
   *  Feeds the compose preview's collapsed ROLE tier with the SERVER-resolved per-project
   *  effective routes (project > workflow > global, SPEC-ROUTING §4). Optional: when absent
   *  (or the fetch fails) the preview approximates the role tier from the global `routing`
   *  prop alone — exactly the pre-workflow layering, so nothing regresses unwired. */
  getProjectRouting?: (projectId: string) => Promise<ProjectRoutingView>;
  /** ⟦NEW (SPEC-TESTING §4) — integrator wires to tower.getProjectTesting⟧ The project's testing
   *  config; its suiteCommand/gateSuite replace the hardcoded composer prefills when set, and
   *  docsPhase auto-appends the documentor phase to the verify template (§3). Optional: absent
   *  (or a failed fetch) keeps the built-in prefills — prefill-only, nothing regresses unwired. */
  getProjectTesting?: (projectId: string) => Promise<ProjectTestingConfig>;
  /** SPEC-PLANNER §3 — attach an existing idle, loop-free pane as the mission's planner (returns the
   *  mission + a `preflight` reminder), or detach it (fall back to the codex Brain). Optional: absent →
   *  the planner controls hide (the feature is additive). */
  attachPlanner?: (id: string, terminalId: string) => Promise<Mission & { preflight?: string }>;
  detachPlanner?: (id: string) => Promise<Mission>;
};

// ---- status vocab ----------------------------------------------------------------------

const MISSION_PILL: Record<MissionStatus, string> = {
  draft: 'draft', running: 'running', 'phase-gate': 'phase gate',
  attention: 'attention', paused: 'paused', done: 'done', failed: 'failed',
};
// pill accent class (maps to the design's state-light tokens): running→working blue,
// phase-gate→amber hold, attention/failed→danger, done→beacon teal, draft/paused→muted.
function pillCls(s: MissionStatus): string {
  return s === 'phase-gate' ? 'gate' : s === 'attention' || s === 'failed' ? 'bad'
    : s === 'done' ? 'good' : s === 'running' ? 'work' : 'idle';
}

const SORTIE_LABEL: Record<SortieStatus, string> = {
  pending: 'pending', active: 'active', gated: 'at gate',
  done: 'done', landed: 'landed', attention: 'attention',
};

/** A mission is "live" (abortable, and not a terminal draft/done/failed) when it's mid-flight. */
function isLive(s: MissionStatus): boolean {
  return s === 'running' || s === 'phase-gate' || s === 'attention' || s === 'paused';
}

function phaseLabel(m: Mission): string {
  const n = m.phases.length;
  if (m.activePhase < 0) return `${n} phase${n === 1 ? '' : 's'}`;
  return `phase ${Math.min(m.activePhase + 1, n)}/${n}`;
}

// ---- root -------------------------------------------------------------------------------

export function MissionsView(props: {
  missions: Mission[];
  projects: Project[];
  adapters: { id: ProviderId; displayName: string }[];
  /** ⟦NEW PROP — integrator wires from GET /api/providers + the `providers` SSE frame⟧
   *  The live custom-provider roster. The per-sortie/mission provider *dropdowns* already list
   *  every provider via `adapters` (the /api/adapters roster includes synthesized custom
   *  adapters), and the model pickers read their rosters through <ModelSelect> now, so this prop
   *  is used only for the effective-route PREVIEW: it supplies each custom provider's
   *  `model.defaultModel`, which the preview falls back to (§2.3). Built-ins carry no model config,
   *  so they simply have no default. Optional; defaults to []. */
  providers?: ProviderDef[];
  /** ⟦NEW PROP — integrator wires from GET /api/routing (Settings → Routing)⟧
   *  The role-default routing map. It is the MIDDLE precedence layer of the effective-route
   *  preview (below a per-sortie override, above the mission default). Display-only here — the
   *  server's resolveRouting is authoritative at Start (§2.3). Optional; defaults to {}. */
  routing?: RoleRouting;
  /** ⟦NEW PROP (SPEC-STORYLOOP §5.2) — integrator wires from GET /api/testruns + the
   *  `testruns` refresh⟧ The live testruns list. Each sortie card derives a green/red e2e
   *  <SuiteChip> from the latest NON-GATE run for its builder terminal. Pass a
   *  list that carries the latest run per builder terminal (not just the dock's recent slice) so
   *  every active sortie can resolve its verdict. Optional; defaults to [] (→ no chips). */
  testRuns?: TestRunInfo[];
  /** ⟦NEW PROP (SPEC-STORYLOOP §5.2) — integrator wires the live `loops` array (already held
   *  in App, as passed to BoardView)⟧ Used ONLY to resolve a sortie's loopId → its builder
   *  terminalId for the SuiteChip join. Optional; defaults to [] (→ no chips). */
  loops?: Loop[];
  /** ⟦NEW PROP (SPEC-TESTING-V2 §3) — integrator wires App's `profiles` (GET /api/profiles + the
   *  `profiles` SSE refresh)⟧ The full account roster; the compose per-sortie account picker filters
   *  it to the effective provider's accounts. Optional; defaults to [] (→ inherit-only picker). */
  profiles?: AgentProfile[];
  /** ⟦NEW PROP (SPEC-TESTING-V2 §3) — integrator wires App's `brainProfileIds`⟧ Account ids reserved
   *  for the Tower's assistant Brain: excluded from the account picker (cosmetic — the start gate
   *  refuses them server-side regardless). Optional; defaults to []. */
  brainProfileIds?: string[];
  /** SPEC-PLANNER §9 — the open + newest-closed planner consults (App parent-push on {t:'consults'}),
   *  and the terminal roster for the attach picker. Both optional; absent → the planner UI hides. */
  consults?: ConsultView[];
  terminals?: TerminalWithLiveness[];
  api: MissionApi;
  onOpenLoop: (loopId: string) => void;
  onError: (m: string) => void;
  /** Optional deep-link (e.g. a dock phase-gate/attention card): when this changes to a
   *  mission id, jump straight to that mission's detail. Toggle it (undefined → id) to
   *  re-focus the same mission after the operator has navigated away. */
  focusMissionId?: string;
  /** SPEC-BACKLOG §2 — a Board "Draft mission" seed: a `seq` bump opens compose with `goal`
   *  prefilled and `backlogTaskId` carried on the create request (route-side link stamp).
   *  The focusMissionId deep-link precedent, compose-flavored. ONE-SHOT: the parent must clear
   *  it via onSeedDone (fired when the seeded compose closes) — a seed that outlives its compose
   *  would re-hijack this view on remount and cross-link a later unrelated create. */
  composeSeed?: { goal: string; backlogTaskId?: string; seq: number };
  onSeedDone?: () => void;
}) {
  const {
    missions, projects, adapters, api, onOpenLoop, onError, focusMissionId,
    providers = [], routing = {}, testRuns = [], loops = [], profiles = [], brainProfileIds = [],
    consults = [], terminals = [],
    composeSeed, onSeedDone,
  } = props;
  const [screen, setScreen] = useState<'list' | 'detail' | 'compose'>('list');
  const [activeId, setActiveId] = useState<string | null>(null);

  // Resolve a sortie's execution loop → its builder terminal, for the sortie SuiteChip join
  // (§5.2). Order-independent lookup; a sortie whose loop hasn't started (no terminalId) yields
  // undefined → no chip.
  const terminalForLoop = useMemo(() => {
    const m = new Map(loops.map((l) => [l.id, l.terminalId] as const));
    return (loopId: string): string | undefined => m.get(loopId);
  }, [loops]);

  // Detail reads its mission from props each render, so SSE updates flow through live. If it
  // vanished (never happens today — no delete — but be safe), fall back to the list.
  const active = missions.find((m) => m.id === activeId) ?? null;
  useEffect(() => {
    if (screen === 'detail' && !active) setScreen('list');
  }, [screen, active]);

  // Deep-link from a dock card. Depends ONLY on focusMissionId so pressing Back (which sets
  // screen='list') isn't immediately overridden by a mission-state re-render. A bogus id is
  // caught by the fallback above.
  useEffect(() => {
    if (focusMissionId) { setActiveId(focusMissionId); setScreen('detail'); }
  }, [focusMissionId]);

  // Board "Draft mission" seed (§2): seq-keyed so a fresh draft re-opens compose. The parent
  // clears the seed when this compose closes (onSeedDone below) or when the operator leaves the
  // view mid-compose — so a truthy composeSeed here always means a LIVE, unconsumed seed.
  useEffect(() => {
    if (composeSeed) setScreen('compose');
  }, [composeSeed?.seq]);

  if (screen === 'compose') {
    const closeCompose = () => {
      if (composeSeed) onSeedDone?.(); // consume the seed with its compose — never outlive it
      setScreen('list');
    };
    return (
      <MissionCompose
        key={composeSeed?.seq ?? 'plain'}
        projects={projects}
        adapters={adapters}
        providers={providers}
        routing={routing}
        profiles={profiles}
        brainProfileIds={brainProfileIds}
        api={api}
        initialGoal={composeSeed?.goal}
        backlogTaskId={composeSeed?.backlogTaskId}
        onError={onError}
        onDone={closeCompose}
        onCancel={closeCompose}
      />
    );
  }
  if (screen === 'detail' && active) {
    return (
      <MissionDetail
        key={active.id}
        mission={active}
        projectName={projects.find((p) => p.id === active.projectId)?.name ?? active.projectId}
        api={api}
        onOpenLoop={onOpenLoop}
        onError={onError}
        onBack={() => setScreen('list')}
        testRuns={testRuns}
        terminalForLoop={terminalForLoop}
        consults={consults.filter((c) => c.missionId === active.id)}
        terminals={terminals}
        loops={loops}
      />
    );
  }
  return (
    <MissionList
      missions={missions}
      projects={projects}
      onOpen={(id) => { setActiveId(id); setScreen('detail'); }}
      onNew={() => setScreen('compose')}
    />
  );
}

// ---- list -------------------------------------------------------------------------------

function MissionList({
  missions, projects, onOpen, onNew,
}: {
  missions: Mission[]; projects: Project[];
  onOpen: (id: string) => void; onNew: () => void;
}) {
  const running = missions.filter((m) => m.status === 'running').length;
  const holds = missions.filter((m) => m.status === 'phase-gate' || m.status === 'attention').length;
  const projName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="flightline">
      <div className="view-title">
        <h1>Missions</h1>
        <span className="sub">
          {missions.length} mission{missions.length === 1 ? '' : 's'} · {running} running{holds ? ` · ${holds} awaiting you` : ''}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn sm ok" onClick={onNew}>◇ New mission</button>
      </div>

      {missions.length === 0 ? (
        <div className="msn-empty">
          No missions yet. A mission plans a multi-phase campaign — phases of sorties (each an
          iterate-until-done loop) the autopilot advances at each phase boundary.
          <div style={{ marginTop: 10 }}><button className="btn ok" onClick={onNew}>◇ New mission</button></div>
        </div>
      ) : (
        <div className="msn-list">
          {missions.map((m) => {
            const sorties = m.phases.flatMap((ph) => ph.sorties);
            return (
              <button className="msn-row" key={m.id} onClick={() => onOpen(m.id)}>
                <span className={`msn-pill ${pillCls(m.status)}`}>{MISSION_PILL[m.status]}</span>
                <div className="msn-row-main">
                  <div className="msn-name">{m.name}</div>
                  <div className="msn-row-meta">
                    <span className="mono">{projName(m.projectId)}</span>
                    <span className="msn-sep">·</span>
                    <span>{phaseLabel(m)}</span>
                    {m.advance === 'auto' && <><span className="msn-sep">·</span><span className="msn-auto">autopilot</span></>}
                  </div>
                </div>
                <div className="msn-dots" title={`${sorties.length} sortie${sorties.length === 1 ? '' : 's'}`}>
                  {sorties.map((s) => (
                    <span key={s.id} className={`msn-dot ${s.status}`} title={`${s.name} — ${SORTIE_LABEL[s.status]}`} />
                  ))}
                  {sorties.length === 0 && <span className="msn-dots-empty">no sorties</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- detail -----------------------------------------------------------------------------

/**
 * SPEC-LOOP W3 (G4) — the pre-execution plan-gate card shown on a draft that requires a plan review.
 * Renders the codex Brain's verdict (pass/block) + per-lens findings and a Review / Re-review button.
 * When blocked, the parent disables Start; re-reviewing re-grades (and auto-redrafts once) so a blocked
 * plan can recover. Display-only: the mission (with the new grade) flows back via the SSE frame.
 */
function PlanReviewCard({ mission, busy, onReview }: {
  mission: Mission; busy: boolean; onReview: (force?: boolean) => void;
}) {
  const pr = mission.planReview;
  const verdict = pr?.verdict;
  const border = verdict === 'pass' ? 'rgba(60,180,90,0.5)' : verdict === 'block' ? 'rgba(210,70,70,0.5)' : 'rgba(127,127,127,0.35)';
  return (
    <div className="msn-plan-review" style={{ border: `1px solid ${border}`, borderRadius: 8, padding: 12, margin: '0 0 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Plan review</strong>
        {verdict && (
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 10,
            background: verdict === 'pass' ? 'rgba(60,180,90,0.18)' : 'rgba(210,70,70,0.18)',
          }}>{verdict === 'pass' ? '✓ pass' : '✕ blocked'}</span>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn sm" disabled={busy} onClick={() => onReview(pr ? true : undefined)}>
          {busy ? 'Reviewing…' : pr ? 'Re-review' : 'Review plan'}
        </button>
      </div>
      {!pr && (
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          This mission requires a plan review before it can start. The assistant grades the plan
          (fact-check + red-team, read-only) and auto-redrafts once if it’s blocked.
        </p>
      )}
      {pr && pr.findings.length === 0 && (
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          {verdict === 'pass' ? 'No findings — the plan is cleared to start.' : 'Blocked with no itemized findings.'}
        </p>
      )}
      {pr && pr.findings.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {pr.findings.map((f, i) => (
            <li key={i} style={{ fontSize: 12, margin: '3px 0' }}>
              <span style={{ fontWeight: 600, color: f.severity === 'block' ? 'rgb(210,90,90)' : 'inherit' }}>
                [{f.severity} · {f.lens}]
              </span>{' '}
              {f.detail}
              {f.target && <span className="muted small"> — {f.target}</span>}
            </li>
          ))}
        </ul>
      )}
      {verdict === 'block' && (
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          Start is disabled until the plan passes. Re-review to grade again; the first blocked review auto-redrafts the plan once.
        </p>
      )}
    </div>
  );
}

/** Minutes-from-now for a consult deadline, floored at 0 ("<deadline in Xm>" / "overdue"). */
function inMinutes(iso?: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  return ms <= 0 ? 'overdue' : `in ${Math.ceil(ms / 60000)}m`;
}

/**
 * SPEC-PLANNER §9 — the planner control surface. Shows the bound planner chip (green live / red lost),
 * an amber "waiting on planner" line per OPEN consult (so a running-but-idle mission's cause is visible),
 * and Attach (a picker of this project's idle, loop-free, non-shell panes) / Detach. Hidden entirely when
 * the mission has no planner AND the api can't attach one (the feature is additive).
 */
function PlannerCard({
  mission, consults, terminals, loops, api, onError,
}: {
  mission: Mission; consults: ConsultView[]; terminals: TerminalWithLiveness[]; loops: Loop[];
  api: MissionApi; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState('');
  const canManage = !!api.attachPlanner && !!api.detachPlanner;
  const planner = mission.planner;
  const missionLive = mission.status !== 'done' && mission.status !== 'failed' && !mission.archivedAt;
  const open = consults.filter((c) => c.status === 'pending' || c.status === 'delivered' || c.status === 'answered');
  if (!planner && !canManage) return null;
  if (!planner && !missionLive) return null;

  // Attachable panes: this project's idle, non-shell, loop-free terminals (the server enforces the full
  // rule; this is the operator-facing shortlist).
  const loopTerminals = new Set(loops.filter((l) => l.status === 'running' || l.status === 'gated' || l.status === 'paused').map((l) => l.terminalId));
  const attachable = terminals.filter((t) =>
    t.projectId === mission.projectId && t.state === 'idle' && t.provider !== 'shell'
    && t.purpose !== 'login' && !loopTerminals.has(t.id));
  const plannerTitle = planner ? (terminals.find((t) => t.id === planner.terminalId)?.title ?? planner.terminalId) : '';

  const attach = async () => {
    if (busy || !pick || !api.attachPlanner) return;
    setBusy(true);
    try { const r = await api.attachPlanner(mission.id, pick); setPicking(false); setPick(''); if (r.preflight) onError(r.preflight); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  const detach = async () => {
    if (busy || !api.detachPlanner) return;
    setBusy(true);
    try { await api.detachPlanner(mission.id); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="msn-planner" style={{ border: '1px solid rgba(127,127,127,0.3)', borderRadius: 8, padding: '10px 12px', margin: '0 0 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>Planner</strong>
        {planner ? (
          <span title={plannerTitle} style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 10,
            background: planner.state === 'live' ? 'rgba(60,180,90,0.18)' : 'rgba(210,70,70,0.18)',
            border: '1px solid rgba(127,127,127,0.3)',
          }}>
            {planner.state === 'live' ? '● live' : '● lost'} · {plannerTitle}
          </span>
        ) : (
          <span className="muted small">none — escalations use the built-in brain</span>
        )}
        <div style={{ flex: 1 }} />
        {planner && canManage && (
          <button className="btn sm" disabled={busy} onClick={detach}>Detach</button>
        )}
        {!planner && canManage && missionLive && !picking && (
          <button className="btn sm" disabled={busy} onClick={() => setPicking(true)}>Attach a planner</button>
        )}
      </div>
      {picking && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
            <option value="">— pick an idle, loop-free pane —</option>
            {attachable.map((t) => <option key={t.id} value={t.id}>{t.title} ({t.provider})</option>)}
          </select>
          <button className="btn sm ok" disabled={busy || !pick} onClick={attach}>Attach</button>
          <button className="btn sm" disabled={busy} onClick={() => { setPicking(false); setPick(''); }}>Cancel</button>
          {attachable.length === 0 && <span className="muted small">no idle, loop-free pane in this project — open one first</span>}
        </div>
      )}
      {open.map((c) => (
        <div key={c.id} className="msn-planner-wait" style={{ marginTop: 8, fontSize: 12, color: 'rgb(200,150,60)' }}>
          waiting on planner: {c.kind}
          {c.status === 'answered'
            ? ' — reply received, applying next tick'
            : ` — asked ${new Date(c.askedAt).toLocaleTimeString()}, ${c.status === 'delivered' ? 'answer' : 'delivery'} deadline ${inMinutes(c.deadline)}`}
        </div>
      ))}
    </div>
  );
}

function MissionDetail({
  mission, projectName, api, onOpenLoop, onError, onBack, testRuns, terminalForLoop, consults, terminals, loops,
}: {
  mission: Mission; projectName: string;
  api: MissionApi; onOpenLoop: (id: string) => void; onError: (m: string) => void; onBack: () => void;
  testRuns: TestRunInfo[]; terminalForLoop: (loopId: string) => string | undefined;
  consults: ConsultView[]; terminals: TerminalWithLiveness[]; loops: Loop[];
}) {
  const [busy, setBusy] = useState(false);
  const [armAbort, setArmAbort] = useState(false);

  // Two-click arm: the first click arms, the second (within 3s) fires. Disarm on status
  // change so a stale "Confirm" can't fire against a mission that already moved on.
  useEffect(() => {
    if (!armAbort) return;
    const t = setTimeout(() => setArmAbort(false), 3000);
    return () => clearTimeout(t);
  }, [armAbort]);
  useEffect(() => { setArmAbort(false); }, [mission.status]);

  const run = async (fn: () => Promise<Mission>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  const doAbort = () => { setArmAbort(false); void run(() => api.abortMission(mission.id)); };
  // SPEC-LOOP W3 (G4) — kick the plan grade (returns the review, not a Mission; the updated mission
  // arrives via the mission-state SSE frame, so this view just refreshes from its `missions` prop).
  const reviewPlan = async (force?: boolean) => {
    if (busy) return;
    setBusy(true);
    try { await api.reviewPlan(mission.id, force); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };

  const s = mission.status;
  // SPEC-LOOP W3 (G4) — a requirePlanReview draft can't start without a passing grade. The client
  // mirrors the server start() guard as UX (the server 409s a stale pass the client can't detect).
  const planGateBlocked = s === 'draft' && !!mission.loop?.requirePlanReview && mission.planReview?.verdict !== 'pass';
  return (
    <div className="flightline">
      <button className="cp-back" onClick={onBack} style={{ marginBottom: 12 }}>◀ Missions</button>

      <div className="msn-detail-head">
        <span className={`msn-pill ${pillCls(s)}`}>{MISSION_PILL[s]}</span>
        <h1 className="msn-detail-name">{mission.name}</h1>
        <span className={`msn-chip ${mission.advance === 'auto' ? 'auto' : ''}`}>
          {mission.advance === 'auto' ? '⚡ autopilot' : '◆ phase gate'}
        </span>
        <div style={{ flex: 1 }} />
        <span className="muted small mono">{projectName}</span>
      </div>
      {mission.goal && <p className="msn-goal">{mission.goal}</p>}
      {mission.stopReason && (s === 'failed' || s === 'done' || (s === 'attention' && !!mission.loop)) && (
        <p className="muted small" style={{ margin: '0 0 12px' }}>{mission.stopReason}</p>
      )}

      {/* SPEC-PLANNER §9 — the planner card: the operator must never guess why a running mission waits. */}
      <PlannerCard mission={mission} consults={consults} terminals={terminals} loops={loops} api={api} onError={onError} />

      {/* SPEC-LOOP §2 — the round-history strip: one chip per iterate-until-green round (kind +
          failed/total once its verify run is recorded), plus the round / cap counter. */}
      {mission.loop && (
        <div className="msn-rounds" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '0 0 12px' }}>
          <span className="muted small" style={{ marginRight: 2 }}>loop</span>
          {mission.loop.rounds.map((r) => {
            const graded = typeof r.failed === 'number';
            const green = graded && r.failed === 0;
            const bg = !graded ? 'transparent' : green ? 'rgba(60,180,90,0.18)' : 'rgba(210,70,70,0.18)';
            return (
              <span key={r.n} title={`round ${r.n} — ${r.kind}`} style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 10, background: bg,
                border: '1px solid rgba(127,127,127,0.3)', whiteSpace: 'nowrap',
              }}>
                R{r.n} · {r.kind}
                {graded && (green
                  ? <> · green{r.total !== undefined ? ` ${r.total}/${r.total}` : ''}</>
                  : <> · {r.failed} failing{r.total !== undefined ? ` / ${r.total}` : ''}</>)}
              </span>
            );
          })}
          <span className="muted small">round {mission.loop.round}/{mission.loop.maxRounds}</span>
        </div>
      )}

      {/* SPEC-LOOP W4 — the deterministic delivery report, rendered React-from-JSON (§3 W4) once the
          mission is terminal. The section itself no-ops until the report.json exists (404 → pending). */}
      {(s === 'done' || s === 'failed') && <MissionReportSection mission={mission} />}

      {/* SPEC-LOOP W3 (G4) — the pre-execution plan-gate card on a draft that requires a plan review. */}
      {s === 'draft' && mission.loop?.requirePlanReview && (
        <PlanReviewCard mission={mission} busy={busy} onReview={reviewPlan} />
      )}

      {/* action bar — contextual to status */}
      <div className="msn-actions">
        {s === 'draft' && (
          <button className="btn ok" disabled={busy || planGateBlocked}
            title={planGateBlocked ? 'A passing plan review is required before this mission can start.' : undefined}
            onClick={() => run(() => api.startMission(mission.id))}>▸ Start mission</button>
        )}
        {s === 'paused' && (
          <button className="btn ok" disabled={busy} onClick={() => run(() => api.startMission(mission.id))}>▸ Resume</button>
        )}
        {s === 'running' && (
          <button className="btn" disabled={busy} onClick={() => run(() => api.pauseMission(mission.id))}>Pause</button>
        )}
        {s === 'phase-gate' && (
          <>
            <button className="btn ok" disabled={busy} onClick={() => run(() => api.advanceMission(mission.id))}>◇ Land &amp; advance</button>
            <button className="btn" disabled={busy} onClick={() => run(() => api.pauseMission(mission.id))}>Pause</button>
          </>
        )}
        {s === 'attention' && (
          <>
            <button className="btn ok" disabled={busy} onClick={() => run(() => api.advanceMission(mission.id))}>↻ Retry advance</button>
            <button className="btn" disabled={busy} onClick={() => run(() => api.startMission(mission.id))}>Resume</button>
          </>
        )}
        {isLive(s) && (
          <>
            <div style={{ flex: 1 }} />
            <button className={`btn warn ghost ${armAbort ? 'armed' : ''}`} disabled={busy}
              onClick={() => (armAbort ? doAbort() : setArmAbort(true))}>
              {armAbort ? 'Confirm abort' : 'Abort'}
            </button>
          </>
        )}
      </div>

      {/* phases as ordered rows; sorties as chips inside */}
      <div className="msn-phases">
        {mission.phases.map((ph, i) => {
          const isActiveGate = s === 'phase-gate' && i === mission.activePhase;
          const done = ph.sorties.length > 0 && ph.sorties.every((x) => x.status === 'landed');
          return (
            <div className={`msn-phase ${i === mission.activePhase ? 'active' : ''} ${done ? 'landed' : ''}`} key={ph.id}>
              <div className="msn-phase-head">
                <span className="msn-phase-n">Phase {i + 1}</span>
                <span className="msn-phase-name">{ph.name}</span>
                <div style={{ flex: 1 }} />
                <span className="muted small">{ph.sorties.length} sortie{ph.sorties.length === 1 ? '' : 's'}</span>
              </div>
              {isActiveGate && (
                <div className="msn-gatehint">Phase {i + 1} complete — review sorties, then <b>Land &amp; advance</b>.</div>
              )}
              <div className="msn-sorties">
                {ph.sorties.length === 0 && <span className="msn-empty small">Empty phase (skipped by the autopilot).</span>}
                {ph.sorties.map((sortie) => (
                  <SortieChip key={sortie.id} sortie={sortie} missionId={mission.id} api={api}
                    phaseActive={i === mission.activePhase}
                    missionDrivable={s !== 'failed' && s !== 'done'}
                    onOpenLoop={onOpenLoop} onError={onError}
                    testRuns={testRuns} terminalForLoop={terminalForLoop} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SortieChip({
  sortie, missionId, api, phaseActive, missionDrivable, onOpenLoop, onError, testRuns, terminalForLoop,
}: {
  sortie: MissionSortie; missionId: string; phaseActive: boolean; missionDrivable: boolean;
  api: MissionApi; onOpenLoop: (id: string) => void; onError: (m: string) => void;
  testRuns: TestRunInfo[]; terminalForLoop: (loopId: string) => string | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const openable = !!sortie.loopId;
  const needsNote = sortie.status === 'attention' || sortie.status === 'gated';
  // Derived e2e verdict for this sortie's builder terminal (§5.2). Resolves only once the loop
  // has started (has a terminalId); SuiteChip itself renders nothing without a parsed run.
  const termId = sortie.loopId ? terminalForLoop(sortie.loopId) : undefined;
  const retry = async () => {
    if (busy) return;
    setBusy(true);
    try { await api.retrySortie(missionId, sortie.id); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  // Retry is offered for an 'attention' sortie or a no-change 'landed' one in the active phase, but
  // only while the mission is drivable (not terminal). Button + hint share the no-change predicate.
  const canRetryNoChange = missionDrivable && !!sortie.noChangeLanded && phaseActive;
  // SPEC-TESTING §3 — a docs-marked 'landed' sortie stays retryable in place in the active phase
  // (docs sorties map every failure to 'landed', so 'landed' is not proof of a merge): same gating
  // as the no-change case, keyed on the runtime docs marker (docsFromRun), never on note prose.
  const canRetryDocs = missionDrivable && sortie.docsFromRun !== undefined && sortie.status === 'landed' && phaseActive;
  const showRetry = (missionDrivable && sortie.status === 'attention') || canRetryNoChange || canRetryDocs;
  return (
    <div className="msn-sortie-wrap">
      <button className={`msn-sortie ${sortie.status} ${openable ? 'link' : ''}`}
        disabled={!openable}
        title={openable ? 'Open this sortie’s loop' : undefined}
        onClick={() => sortie.loopId && onOpenLoop(sortie.loopId)}>
        <span className={`msn-dot ${sortie.status}`} />
        <span className="msn-sortie-name">{sortie.name}</span>
        <span className="msn-sortie-st">{SORTIE_LABEL[sortie.status]}</span>
      </button>
      {termId && <SuiteChip terminalId={termId} testRuns={testRuns} />}
      {needsNote && sortie.note && <div className="msn-sortie-note">{sortie.note}</div>}
      {showRetry && (
        <button className="btn sm" disabled={busy} onClick={retry}>{busy ? '…' : '↻ Retry sortie'}</button>
      )}
      {canRetryNoChange && (
        <span className="msn-sortie-hint">landed with no changes — Retry to re-run the builder</span>
      )}
      {canRetryDocs && !canRetryNoChange && (
        <span className="msn-sortie-hint">docs sortie — Retry re-derives the docs task from the latest run</span>
      )}
      {sortie.researchSortie === true && sortie.status === 'landed' && (
        <span className="msn-sortie-hint">research sortie — finding submitted (Retry re-runs the question)</span>
      )}
      {sortie.status === 'gated' && (
        <span className="msn-sortie-hint">at a forced gate — open to resolve, then Resume</span>
      )}
    </div>
  );
}

// ---- compose ----------------------------------------------------------------------------

let _rk = 0;
const rk = () => ++_rk;
// role/provider/model are the per-sortie routing overrides (SPEC-PROVIDERS §2.2); all three are
// stored as strings where '' means "unset — inherit down the precedence chain". `rationale` is
// the Jarvis draft's one-line why (§2.5) — display-only, never persisted on the sortie.
interface DraftSortie {
  k: number; name: string; task: string; assertions: string; checkCommand: string;
  role: string; provider: string; model: string; effort: string; rationale?: string;
  /** SPEC-TESTING-V2 §3 — the per-sortie account override (''=inherit down the account chain).
   *  Sent on create only when set; a value whose provider doesn't match the resolved provider is
   *  hard-errored at the start gate (never a silent wrong-account spawn). */
  profileId: string;
  /** SPEC-STORYLOOP §3.2 — a verify-phase fixer slot: carried into the create request so the
   *  Tower rewrites the task from the runner's failures at fixer-phase-start (§3.3). */
  verifyFixer?: boolean;
  /** SPEC-TESTING §3 — a documentor slot: carried into the create request so the Tower finalizes
   *  the docs task from the verify run at docs-phase-start (assignDocsPhase). Never gates. */
  docsSortie?: boolean;
  /** SPEC-LOOP W6 — a routed-reviewer slot: carried into the create request so the Tower finalizes
   *  the review task from the mission's base commit at review-phase-start (assignReviewPhase). */
  reviewSortie?: boolean;
  /** SPEC-RESEARCH W9 — a research sortie: success is a submitted finding, never commits. */
  researchSortie?: boolean;
}
// SPEC-LOOP §0 — the loop stage a template phase carries (verify/fix/docs). Sent on create so the
// completion evaluator finds the tail verify phase and the loop-round gate-skip keys on it.
interface DraftPhase { k: number; name: string; sorties: DraftSortie[]; stage?: PhaseStage; }
const newSortie = (): DraftSortie =>
  ({ k: rk(), name: '', task: '', assertions: '', checkCommand: '', role: '', provider: '', model: '', effort: '', profileId: '' });
const newPhase = (): DraftPhase => ({ k: rk(), name: '', sorties: [newSortie()] });
const lines = (s: string): string[] => s.split('\n').map((x) => x.trim()).filter(Boolean);

// SPEC-STORYLOOP §3.1/§3.3 — the two-phase verify template. Phase "verify" holds ONE runner sortie
// that writes/updates the Playwright specs and runs the suite (its check IS the kit). Phase "fix"
// holds N fixer slots, each marked verifyFixer with a PLACEHOLDER task — the Tower partitions the
// runner's structured failures across them at fixer-phase-start (§3.3), so we don't enumerate
// failures here. The composer also raises concurrency to the fixer count so they run at once.
// SPEC-TESTING §4 — the checks are ALWAYS the kit entrypoint (see E2E_SUITE_CMD): a project's
// configured suiteCommand is applied inside `towerctl test run`, never substituted for it here.
const VERIFY_FIXER_COUNT = 3; // brief J3 "three fixer slots"; bounded by the mission clamp [1,4]
// SPEC-TESTING §3.1 — the NON-LOOP verify template's runner phase: writes/updates specs, runs the
// suite, and gates on it (checkCommand). A loop mission uses `loopVerifyRunnerPhase` below instead.
function verifyRunnerPhase(): DraftPhase {
  const runner: DraftSortie = {
    ...newSortie(),
    name: 'run e2e suite',
    task: 'Write or update the Playwright end-to-end specs for the target user stories, then run the '
      + 'suite with `towerctl test run`. The Tower partitions any failures across the next phase’s '
      + 'fixers — you own coverage, not the fixes.',
    checkCommand: E2E_SUITE_CMD,
    role: 'tester', // SPEC-TESTING §2 — the runner TEMPLATE routes as the tester role
  };
  return { k: rk(), name: 'verify', stage: 'verify', sorties: [runner] };
}
function fixPhase(): DraftPhase {
  const fixers: DraftSortie[] = Array.from({ length: VERIFY_FIXER_COUNT }, (_, i) => ({
    ...newSortie(),
    name: `fixer ${i + 1}`,
    task: 'Fix the e2e failures assigned to you. The Tower rewrites this task at the start of the '
      + 'phase with your specific failing tests (partitioned by spec file from the runner’s results) '
      + '— wait for that, then fix them and re-run `towerctl test run` until green.',
    checkCommand: E2E_SUITE_CMD,
    role: 'implement', // §3.2 — a disciplined coding model fixes the failing code
    verifyFixer: true,
  }));
  return { k: rk(), name: 'fix', stage: 'fix', sorties: fixers };
}
function verifyPhases(): DraftPhase[] {
  return [verifyRunnerPhase(), fixPhase()];
}

// SPEC-LOOP §2 — a LOOP mission's tail verify phase: a single RUN-AND-REPORT runner with NO
// checkCommand. A checkCommand would gate the sortie on the suite (gatePolicy:'never' iterates a red
// check to attention), so the phase would never reach the completion boundary on a red suite. With no
// check the agent runs the suite (recording the TestRun), self-reports done, makes zero commits, and
// the no-change path LANDS it — so evaluateCompletion is the sole green/red judge off the recorded run.
// Distinct from the non-loop `verifyRunnerPhase` (which keeps its checkCommand + write-specs task).
function loopVerifyRunnerPhase(): DraftPhase {
  const runner: DraftSortie = {
    ...newSortie(),
    name: 'verify e2e suite',
    // The one canonical run-and-report task string, shared with the server's mechanical-round
    // runner (mechanicalRoundPhases) so the two never drift apart.
    task: LOOP_VERIFY_TASK,
    role: 'tester', // SPEC-TESTING §2 — the runner routes as the tester role
    // no checkCommand — run-and-report (the loop evaluator judges, not the sortie check)
  };
  return { k: rk(), name: 'verify', stage: 'verify', sorties: [runner] };
}

// SPEC-LOOP W6 — a LOOP mission's review phase (inserted before the verify tail when "Require code
// review" is on): ONE review-marked sortie routed as the 'review-judge' role, whose PLACEHOLDER task
// the Tower finalizes from the mission's base commit at review-phase-start (assignReviewPhase). Its
// checkCommand (REVIEW_CHECK_COMMAND) fails while it has not submitted or its branch holds commits.
function loopReviewPhase(): DraftPhase {
  const reviewer: DraftSortie = {
    ...newSortie(),
    name: 'code review',
    task: LOOP_REVIEW_TASK,
    role: 'review-judge', // SPEC-ROUTING §1 — routed as the review role (never the codex Brain)
    checkCommand: REVIEW_CHECK_COMMAND,
    reviewSortie: true,
  };
  return { k: rk(), name: 'review', stage: 'review', sorties: [reviewer] };
}

// SPEC-TESTING §3 — the documentor phase: ONE docs-marked sortie whose PLACEHOLDER task the Tower
// finalizes from the verify run at docs-phase-start (assignDocsPhase mirrors the fixer assignment).
// It NEVER gates — no checkCommand, and the runtime skips the regression gate for a docs phase.
function docsPhase(): DraftPhase {
  return {
    k: rk(),
    name: 'document',
    stage: 'docs',
    sorties: [{
      ...newSortie(),
      name: 'document',
      task: 'Update the README / docs for the behavior the e2e run verified. The Tower rewrites this '
        + 'task at the start of the phase from the latest run’s results — wait for that, then document '
        + 'what actually shipped. Docs only: change no code.',
      role: 'docs',
      docsSortie: true,
    }],
  };
}

// SPEC-RESEARCH W9 — a research phase: ONE marked 'explore' sortie whose task IS the research
// question (the operator edits it, and duplicates the sortie per parallel question). Unlike docs and
// review there is NO assign-time finalization: the authored task is the contract. Success is a
// submitted finding, never commits — the check belt fails until one exists, and the runtime finding
// gate is what guarantees it.
function researchPhase(): DraftPhase {
  return {
    k: rk(),
    name: 'research',
    sorties: [{
      ...newSortie(),
      name: 'research',
      task: 'Research the question in this task, grounded in the repository in your working '
        + 'directory. Do NOT modify, create, or delete any file — anything left in the worktree is '
        + 'auto-committed to a branch that is never merged. When done, submit ONCE with:\n\n'
        + '  towerctl research submit --file - <<\'JSON\'\n'
        + '  {"topic":"…","summary":"…","citations":[{"ref":"…","note":"…"}]}\n'
        + '  JSON\n\n'
        + 'The summary is the deliverable (≤8000 chars): findings, evidence, recommendation.',
      role: 'explore',
      checkCommand: RESEARCH_CHECK_COMMAND,
      researchSortie: true,
    }],
  };
}

/** The compose preview's collapsed role tier: `effective[role]` from GET /api/projects/:id/routing
 *  — the server-resolved project > workflow > global route per role (SPEC-ROUTING §4). */
type EffectiveRoleMap = Partial<Record<PipelineRole, EffectiveRoleRoute>>;

/**
 * Client mirror of the server's resolveRouting (§2.3 / SPEC-ROUTING §3) — PREVIEW ONLY, so the
 * operator sees where a sortie will actually run before Start. Provider and model resolve as
 * INDEPENDENT layered lookups under the server's numeric specificity gate, over the
 * collapsed client tiers { SORTIE:3, ROLE:2, MISSION:1, GLOBAL:0 } — ROLE reads the
 * server-resolved `effective[role]` (already gated WITHIN the role layer, so project/workflow/
 * global collapse losslessly). A model may only ride a provider chosen at an equal-or-less
 * specific tier (`modelTier >= providerRank`); anything gated out falls back to the provider's
 * own defaultModel — matching resolveRouting exactly instead of the old ungated `||` chain
 * (SPEC-ROUTING §5). `shadows` reports when a project/workflow role route outranks the chosen
 * mission provider (§5's shadow hint). The v2 attribute-rules layer is a no-op here. The
 * server stays authoritative at Start; this never executes anything.
 */
export function effectiveRoute(
  s: Pick<DraftSortie, 'role' | 'provider' | 'model'>, missionProvider: string, missionModel: string,
  effective: EffectiveRoleMap, providers: ProviderDef[],
): { provider: ProviderId; model: string; shadows?: 'project' | 'workflow' } {
  const role = s.role as PipelineRole | '';
  const eff = role ? effective[role] : undefined;
  // Provider: the most specific tier that names one. SORTIE(3) > ROLE(2) > MISSION(1) > GLOBAL(0).
  const [provider, providerRank] = s.provider
    ? ([s.provider as ProviderId, 3] as const)
    : eff
      ? ([eff.provider, 2] as const)
      : missionProvider
        ? ([missionProvider as ProviderId, 1] as const)
        : (['claude-code' as ProviderId, 0] as const);
  // Model: the most specific tier whose rank clears the gate. A sortie model (3) always rides;
  // the role-tier model only rides a role-or-less-specific provider; a mission model only a
  // mission-or-global provider. `eff.model` is already post-gate for `eff.provider` (rank ties).
  const model =
    (s.model.trim() ? s.model.trim() : undefined) ??
    (2 >= providerRank && eff?.model ? eff.model : undefined) ??
    (1 >= providerRank && missionModel.trim() ? missionModel.trim() : undefined) ??
    providers.find((d) => d.id === provider)?.model.defaultModel ??
    '';
  // Shadow hint (§5): no per-sortie provider, and the role's PROJECT/WORKFLOW route outranks —
  // and actually changes — the chosen mission provider. A same-provider or global-tier win is
  // not flagged (global-beats-mission is today's behavior, not a surprise this hint exists for).
  const shadows =
    !s.provider && missionProvider && eff && eff.provider !== missionProvider &&
    (eff.source === 'project' || eff.source === 'workflow')
      ? eff.source
      : undefined;
  return { provider, model, ...(shadows ? { shadows } : {}) };
}

function MissionCompose({
  projects, adapters, providers, routing, profiles, brainProfileIds, api, initialGoal, backlogTaskId, onError, onDone, onCancel,
}: {
  projects: Project[]; adapters: { id: ProviderId; displayName: string }[];
  providers: ProviderDef[]; routing: RoleRouting;
  profiles: AgentProfile[]; brainProfileIds: string[];
  api: MissionApi;
  /** SPEC-BACKLOG §2 — Board seed: prefills the Jarvis goal; the parent keys this component on
   *  the seed's seq, so useState initializers are fresh per seed. */
  initialGoal?: string;
  /** Carried verbatim on the create request; the SERVER stamps the task link after success. */
  backlogTaskId?: string;
  onError: (m: string) => void; onDone: () => void; onCancel: () => void;
}) {
  const agentAdapters = adapters.filter((a) => a.id !== 'shell');
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState(initialGoal ?? '');
  const [provider, setProvider] = useState<ProviderId>(agentAdapters[0]?.id ?? 'claude-code');
  // Mission-level model default (§2.2) — the fallback below per-sortie/role in the
  // effective route. A free-text slug; empty = the provider's own default.
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState(''); // SPEC-EFFORT §4 — mission-tier effort default; '' = the CLI's own
  const [advance, setAdvance] = useState<'gate' | 'auto'>('gate');
  const [concurrency, setConcurrency] = useState(1);
  const [maxIter, setMaxIter] = useState(8);
  // SPEC-LOOP §1 — the iterate-until-green loop. When on, the mission runs append-only fix rounds until
  // its tail verify phase is green or a cap trips; the plan must END in a single-sortie verify phase
  // (the composer's "+ verify phase" adds exactly that in loop mode). Caps mirror the server clamps.
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [maxRounds, setMaxRounds] = useState(4);
  const [mechanicalRounds, setMechanicalRounds] = useState(2);
  const [sortieBudget, setSortieBudget] = useState(24);
  // SPEC-LOOP W3 (G4) — request the pre-execution plan gate: the Brain grades the drafted plan before
  // it can start (fact-check + red-team). Only meaningful when looping, so it lives in the loop block.
  const [requirePlanReview, setRequirePlanReview] = useState(false);
  // SPEC-LOOP W6 — require an in-loop code review: on green, a routed reviewer must attest the change
  // (or its confirmed findings are fixed) before the loop completes. Only meaningful when looping.
  const [requireReview, setRequireReview] = useState(false);
  // SPEC-LOOP W7 — prepend a false-fail investigator to each mechanical round; only meaningful when looping.
  const [investigate, setInvestigate] = useState(false);
  // SPEC-PLANNER §3 (DEC-P8) — spawn a Tower planner terminal bound to this mission, so an escalation
  // consults it instead of the codex Brain. Most useful for a loop mission (escalation is a loop event);
  // routes via the 'plan' role defaults. The operator can also attach an existing pane from the detail.
  const [spawnPlanner, setSpawnPlanner] = useState(false);
  // SPEC-LOOP §1 — a loop mission is autonomous by construction: the closed loop must land and
  // advance each appended fix → verify round on its own, so a phase gate would stall it at every
  // round boundary (two Land & advance clicks per round) and it would never iterate. Derived, not
  // stored: the operator's own `advance` choice is untouched and restores when the loop toggles off.
  const effectiveAdvance: 'gate' | 'auto' = loopEnabled ? 'auto' : advance;
  // SPEC-STORYLOOP §4 — the optional regression-gate suite. Sent as gateSuite on create only once
  // the operator touches it (see submit); the server runs it against a trial-merge worktree before
  // landing a phase (§4.2). RAW command (see GATE_SUITE_CMD) — never `towerctl test run`.
  const [gateSuite, setGateSuite] = useState('');
  const [phases, setPhases] = useState<DraftPhase[]>([newPhase()]);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);

  // SPEC-ROUTING §5 — the server-resolved per-project role routes, refetched on project change;
  // they are the preview's collapsed ROLE tier. Best-effort: a failure (or an unwired api
  // method) falls back to the global `routing` prop below rather than blanking the preview.
  // Depend on the METHOD, not `api`: the parent rebuilds the api literal every render, but the
  // wired tower.getProjectRouting reference is stable — keying on `api` would refetch per render.
  const [projRouting, setProjRouting] = useState<ProjectRoutingView | null>(null);
  const fetchProjectRouting = api.getProjectRouting;
  useEffect(() => {
    setProjRouting(null);
    if (!projectId || !fetchProjectRouting) return;
    let stale = false;
    fetchProjectRouting(projectId)
      .then((v) => { if (!stale) setProjRouting(v); })
      .catch(() => {
        // Don't leave a CONFIDENT-but-wrong preview: the fallback below shows global-only routing,
        // which diverges from what the server resolves once a project/workflow overlay exists. Say so.
        if (!stale) onError("Couldn't load this project's routing — the route preview shows global defaults only and may differ from what runs.");
      });
    return () => { stale = true; };
  }, [projectId, fetchProjectRouting]);
  const effective: EffectiveRoleMap = useMemo(() => {
    if (projRouting) return projRouting.effective;
    // Fallback: only the global layer exists client-side — identical to the pre-workflow server.
    const out: EffectiveRoleMap = {};
    for (const [role, a] of Object.entries(routing) as [PipelineRole, RoleAssignment | undefined][]) {
      if (a) out[role] = { provider: a.provider, ...(a.model ? { model: a.model } : {}), source: 'global' };
    }
    return out;
  }, [projRouting, routing]);

  // SPEC-TESTING §4 — the project's testing config, refetched on project change. Prefill-only
  // (the gate preset + the docsPhase template append), so a failure silently keeps the
  // built-in fallbacks — never the onError bar, unlike the routing preview above.
  // SPEC-TESTING-V2 §2 — a "touched" ref stops a slow config fetch from clobbering operator
  // typing (or an addVerifyPhases-set value). It's a REF (no re-render needed) so the async resolve
  // reads its live value; it resets on projectId change alongside the gate reset below.
  const [testingCfg, setTestingCfg] = useState<ProjectTestingConfig | null>(null);
  const fetchProjectTesting = api.getProjectTesting;
  const gateTouched = useRef(false);
  useEffect(() => {
    setTestingCfg(null);
    // Reset the gate to this project's default: clear now (blank while loading; also the honest
    // fetch-fail state), re-prefill from the config on resolve. Touched resets with the project.
    gateTouched.current = false;
    setGateSuite('');
    if (!projectId || !fetchProjectTesting) return;
    let stale = false;
    fetchProjectTesting(projectId)
      .then((c) => {
        if (stale) return;
        setTestingCfg(c);
        // Value-prefill the gate from the project config (''=no configured gate) — but never
        // over operator typing or an addVerifyPhases write (the touched ref guards it).
        if (!gateTouched.current) setGateSuite(c.gateSuite ?? '');
      })
      .catch(() => {});
    return () => { stale = true; };
  }, [projectId, fetchProjectTesting]);
  // The composer's effective GATE prefill: the project config when set, else the hardcode. The
  // suite check has no such swap — it is always E2E_SUITE_CMD (a project suiteCommand runs
  // inside the kit, server-side); only the in-process gate execs a raw command directly.
  const gateCmd = testingCfg?.gateSuite?.trim() || GATE_SUITE_CMD;

  // ---- editor mutation helpers (immutable updates keyed by row .k) ----
  const setPhase = (k: number, patch: Partial<DraftPhase>) =>
    setPhases((ps) => ps.map((p) => (p.k === k ? { ...p, ...patch } : p)));
  const setSortie = (pk: number, sk: number, patch: Partial<DraftSortie>) =>
    setPhases((ps) => ps.map((p) => (p.k === pk
      ? { ...p, sorties: p.sorties.map((s) => (s.k === sk ? { ...s, ...patch } : s)) } : p)));
  const addSortie = (pk: number) =>
    setPhases((ps) => ps.map((p) => (p.k === pk ? { ...p, sorties: [...p.sorties, newSortie()] } : p)));
  const removeSortie = (pk: number, sk: number) =>
    setPhases((ps) => ps.map((p) => (p.k === pk ? { ...p, sorties: p.sorties.filter((s) => s.k !== sk) } : p)));
  const addPhase = () => setPhases((ps) => [...ps, newPhase()]);
  const removePhase = (pk: number) => setPhases((ps) => ps.filter((p) => p.k !== pk));
  // SPEC-STORYLOOP §3.1 — drop in the verify → fix phase pair and SET mission concurrency to
  // the fixer count so the fix phase starts all its fixers simultaneously (VERIFY_FIXER_COUNT is
  // within the [1,4] clamp the number input also enforces). SPEC-TESTING §3 — when the project's
  // testing config turns docsPhase on, the template also appends the documentor phase.
  const addVerifyPhases = () => {
    // SPEC-LOOP §2 — in loop mode the plan's tail is a SINGLE-sortie verify phase (the completion
    // evaluator's regression evidence); the mechanical fix rounds are appended by the Tower, not
    // authored here. So drop only the verify runner phase and DON'T prefill a gate — the loop's own
    // verify phase IS the regression evidence — a separate gate on the same red suite would dead-end
    // the loop. Off loop mode: the classic verify → fix template + gate prefill, unchanged.
    if (loopEnabled) {
      // SPEC-LOOP W6 — when a code review is required, the review phase goes just BEFORE the verify
      // tail (the tail stays the single-sortie verify phase, so invalid() + server assertLoopTail hold).
      setPhases((ps) => [...ps, ...(requireReview ? [loopReviewPhase()] : []), loopVerifyRunnerPhase()]);
      return;
    }
    setPhases((ps) => [...ps, ...verifyPhases(), ...(testingCfg?.docsPhase ? [docsPhase()] : [])]);
    setConcurrency(VERIFY_FIXER_COUNT);
    // A verify template implies a regression gate over the integrated result; pre-fill the raw
    // suite command (not `towerctl test run`) if the operator hasn't set one, but never clobber it.
    // This is an operator-intent gate write — mark touched so a late config fetch won't undo it.
    gateTouched.current = true;
    setGateSuite((g) => (g.trim() ? g : gateCmd));
  };
  // SPEC-TESTING §3 — append a standalone documentor phase (the addVerifyPhases mirror).
  const addDocsPhase = () => setPhases((ps) => [...ps, docsPhase()]);
  // SPEC-RESEARCH W9 — append a research phase (the addDocsPhase mirror). The operator duplicates the
  // sortie per parallel question; the runtime raises concurrency to match at phase start.
  const addResearchPhase = () => setPhases((ps) => [...ps, researchPhase()]);

  // Readable provider name — the /api/adapters roster carries displayName for built-ins AND
  // synthesized custom adapters, so it labels every id the dropdown can hold.
  const labelFor = (pid: string): string => adapters.find((a) => a.id === pid)?.displayName ?? pid;

  const draftWithAssistant = async () => {
    if (drafting || !projectId || !goal.trim()) return;
    setDrafting(true);
    try {
      const planned = await api.planMission(projectId, goal.trim());
      if (planned.length > 0) {
        // The draft now carries Jarvis's per-sortie routing proposals (§2.5): role, provider,
        // model, and a one-line rationale. Pre-fill the editable pickers from them — the operator
        // reviews and can override any before Start; nothing executes from the draft.
        setPhases(planned.map((ph) => ({
          k: rk(), name: ph.name,
          // SPEC-LOOP §0 — preserve a drafted phase's loop stage so a loop plan round-trips.
          ...(ph.stage ? { stage: ph.stage } : {}),
          sorties: (ph.sorties.length ? ph.sorties : [{ name: '', task: '' }]).map((s) => ({
            k: rk(), name: s.name ?? '', task: s.task ?? '',
            assertions: (s.assertions ?? []).join('\n'), checkCommand: s.checkCommand ?? '',
            role: s.role ?? '', provider: s.provider ?? '', model: s.model ?? '',
            // SPEC-EFFORT §4 — the planner never proposes effort (parsePlan whitelist strips it), so
            // seed empty; the operator dials it in the composer before Start.
            effort: '',
            profileId: s.profileId ?? '', rationale: s.rationale,
            // Carry a Jarvis-drafted verify-fixer marker through so the runtime assignment fires (§3.2).
            ...(s.verifyFixer ? { verifyFixer: true } : {}),
            // Same for a Jarvis-drafted documentor slot (SPEC-TESTING §3).
            ...(s.docsSortie ? { docsSortie: true } : {}),
            // Same for a Jarvis-drafted reviewer slot (SPEC-LOOP W6).
            ...(s.reviewSortie ? { reviewSortie: true } : {}),
            // …and a research slot (SPEC-RESEARCH W9). Dormant until the planner can emit the marker;
            // carried here so the two maps never diverge.
            ...(s.researchSortie ? { researchSortie: true } : {}),
          })),
        })));
      }
    } catch (e) { onError((e as Error).message); } finally { setDrafting(false); }
  };

  // ---- client-side validation (≥1 phase, ≥1 sortie each, names/tasks non-empty) ----
  const invalid = useMemo(() => {
    if (!projectId) return 'Pick a project.';
    if (!name.trim()) return 'Give the mission a name.';
    if (!goal.trim()) return 'Describe the goal.';
    if (phases.length === 0) return 'Add at least one phase.';
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i]!;
      if (!p.name.trim()) return `Phase ${i + 1} needs a name.`;
      if (p.sorties.length === 0) return `Phase ${i + 1} needs at least one sortie.`;
      for (let j = 0; j < p.sorties.length; j++) {
        const so = p.sorties[j]!;
        if (!so.name.trim()) return `Phase ${i + 1}, sortie ${j + 1} needs a name.`;
        if (!so.task.trim()) return `Phase ${i + 1}, sortie ${j + 1} needs a task.`;
      }
    }
    // SPEC-LOOP §2 — a loop mission must end in a single-sortie verify phase (the round's fixers
    // partition from it; the server rejects start() otherwise). Guide the operator before submit.
    if (loopEnabled) {
      const last = phases[phases.length - 1];
      if (!last || last.stage !== 'verify' || last.sorties.length !== 1) {
        return 'Loop mode needs the plan to end in a single-sortie verify phase — click “+ verify phase”.';
      }
    }
    return null;
  }, [projectId, name, goal, phases, loopEnabled]);

  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true);
    try {
      const req: CreateMissionRequest = {
        projectId, name: name.trim(), goal: goal.trim(), provider, advance: effectiveAdvance,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(effort ? { effort } : {}),
        // Send the gate only once the operator TOUCHED the field (typed / preset / verify template):
        // touched-empty '' = explicit opt-out; a touched value ships verbatim (WYSIWYG). UNTOUCHED
        // omits the key so the route-side stamp inherits the project default — the same value the
        // prefill shows once loaded, and still right when submit lands before the async config
        // fetch resolves (always-sending would ship the reset-'' as a bogus opt-out in that window).
        // SPEC-LOOP — a loop mission never ships a gate: its verify phase IS the regression check
        // (the server clears gateSuite on loop creates too; the composer shows the field disabled).
        ...(gateTouched.current && !loopEnabled ? { gateSuite: gateSuite.trim() } : {}),
        ...(backlogTaskId ? { backlogTaskId } : {}),
        // SPEC-LOOP §1 — request the iterate-until-green loop; the server clamps the caps and seeds
        // round 1 (the authored plan). Absent → a classic linear mission.
        ...(loopEnabled ? { loop: { maxRounds, mechanicalRounds, sortieBudget, ...(requirePlanReview ? { requirePlanReview: true } : {}), ...(requireReview ? { requireReview: true } : {}), ...(investigate ? { investigate: true } : {}) } } : {}),
        // SPEC-PLANNER §3 (DEC-P8) — request a Tower-spawned planner; the route resolves the 'plan' role
        // route, spawns the pane BEFORE the mission, and fails closed (a spawn failure → 400, no mission).
        ...(spawnPlanner ? { planner: { spawn: {} } } : {}),
        maxIterationsPerSortie: maxIter, concurrency,
        phases: phases.map((p) => ({
          name: p.name.trim(),
          // SPEC-LOOP §0 — carry the phase's loop stage (verify/fix/docs) so the completion evaluator
          // + the loop-round gate-skip can key on it.
          ...(p.stage ? { stage: p.stage } : {}),
          // Per-sortie routing overrides ship only when set (§2.2) — an unset field falls through
          // the server's resolveRouting chain (per-sortie → role default → mission → global).
          sorties: p.sorties.map((s) => ({
            name: s.name.trim(), task: s.task.trim(),
            ...(lines(s.assertions).length ? { assertions: lines(s.assertions) } : {}),
            ...(s.checkCommand.trim() ? { checkCommand: s.checkCommand.trim() } : {}),
            ...(s.role ? { role: s.role as PipelineRole } : {}),
            ...(s.provider ? { provider: s.provider as ProviderId } : {}),
            ...(s.model.trim() ? { model: s.model.trim() } : {}),
            ...(s.effort ? { effort: s.effort } : {}),
            ...(s.profileId ? { profileId: s.profileId } : {}),
            ...(s.verifyFixer ? { verifyFixer: true } : {}),
            ...(s.docsSortie ? { docsSortie: true } : {}),
            ...(s.reviewSortie ? { reviewSortie: true } : {}),
            // SPEC-RESEARCH W9 — LOAD-BEARING: this is the map that builds the create REQUEST. Without
            // it the marker never reaches CreateMissionRequest, buildPhases never persists it, the
            // submit route 404s every finding, and the mission burns to its iteration cap looking like
            // a routing bug. (The Jarvis-prefill map above is the cosmetic twin.)
            ...(s.researchSortie ? { researchSortie: true } : {}),
          })),
        })),
      };
      await api.createMission(req);
      onDone();
    } catch (e) { onError((e as Error).message); setBusy(false); }
  };

  return (
    <div className="flightline">
      <button className="cp-back" onClick={onCancel} style={{ marginBottom: 12 }}>◀ Missions</button>
      <div className="view-title"><h1>New mission</h1><span className="sub">plan → phases → sorties</span></div>

      <div className="settings-form" style={{ maxWidth: 640 }}>
        <div className="field-row">
          <div className="field"><label>Project</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.length === 0 && <option value="">no projects</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Provider</label>
            {/* Switching provider CLEARS the model AND effort — both are provider-specific, so carrying
                either across would spawn an incompatible pair (e.g. claude --model gpt-5.5, claude 'max' onto
                codex). Re-pick from the new roster. Sorties that DIRECTLY inherit this provider (no provider,
                no role) inherit the same staleness, so clear their model, effort AND account; a sortie with
                its own provider/role resolves independently and is left untouched. */}
            <select value={provider} onChange={(e) => {
              setProvider(e.target.value as ProviderId);
              setModel('');
              setEffort('');
              setPhases((ps) => ps.map((p) => ({ ...p, sorties: p.sorties.map((s) => (!s.provider && !s.role ? { ...s, model: '', effort: '', profileId: '' } : s)) })));
            }}>
              {agentAdapters.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 220 }}><label>Model (optional)</label>
            {/* SPEC-MODELS §3 — shared roster picker (built-in curated/live catalogs + custom rosters),
                empty = not set (the CLI's own choice), Custom… for anything newer, ↻ refreshes a catalog. */}
            <ModelSelect provider={provider} value={model} onChange={setModel} allowEmpty compact ariaLabel="Mission model" />
            <span className="hint">Mission default — per-sortie can override.</span>
          </div>
          <div className="field" style={{ maxWidth: 220 }}><label>Effort (optional)</label>
            {/* SPEC-EFFORT §4 — mission-tier reasoning-effort default (concrete provider). */}
            <EffortSelect provider={provider} model={model.trim() || undefined} value={effort} onChange={setEffort} compact ariaLabel="Mission effort" />
            <span className="hint">Mission default — per-sortie can override.</span>
          </div>
        </div>
        <div className="field"><label>Name</label>
          <input placeholder="short name for this campaign" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field"><label>Goal</label>
          <textarea placeholder="What should this mission accomplish, end to end?" value={goal} onChange={(e) => setGoal(e.target.value)} />
          <span className="hint">The goal is prepended to every sortie’s task as shared context.</span>
        </div>

        <div className="field"><label>Advance</label>
          {/* Loop mode locks this to autopilot (effectiveAdvance): the loop's appended rounds
              land + advance unattended, which is what "Loop until green" opts into. The stored
              `advance` choice survives underneath and comes back when the loop toggles off. */}
          <div className="seg-choice">
            <button className={effectiveAdvance === 'gate' ? 'sel' : ''} disabled={loopEnabled} onClick={() => setAdvance('gate')}>Stop at each phase for review (recommended)</button>
            <button className={effectiveAdvance === 'auto' ? 'sel' : ''} disabled={loopEnabled} onClick={() => setAdvance('auto')}>Full autopilot (auto-land)</button>
          </div>
          <span className="hint">
            {loopEnabled
              ? 'Loop until green runs autonomously — it lands and advances each round without a manual gate.'
              : advance === 'gate'
                ? 'When a phase completes, the mission waits for your Land & advance.'
                : '⚠ Unattended: the autopilot lands each phase and advances on its own. Opt-in — you own the merge surface.'}
          </span>
        </div>

        <div className="field-row">
          <div className="field" style={{ maxWidth: 150 }}><label>Concurrency</label>
            <input type="number" min={1} max={4} value={concurrency}
              onChange={(e) => setConcurrency(clamp(e.target.value, 1, 4, 1))} />
            <span className="hint">Sorties in flight per phase (1–4).</span>
          </div>
          <div className="field" style={{ maxWidth: 170 }}><label>Max iterations / sortie</label>
            <input type="number" min={1} max={50} value={maxIter}
              onChange={(e) => setMaxIter(clamp(e.target.value, 1, 50, 8))} />
          </div>
        </div>

        {/* SPEC-LOOP §1 — the iterate-until-green toggle. On → the mission appends mechanical
            fix → verify rounds until the tail verify phase is green or a cap trips. */}
        <div className="field">
          <label className="msn-check-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={loopEnabled} onChange={(e) => setLoopEnabled(e.target.checked)} />
            <span>Loop until green</span>
          </label>
          <span className="hint">
            {loopEnabled
              ? 'The mission iterates: once the tail verify phase runs, the Tower appends a fix → verify round for the failing spec files and re-runs, until the suite is green or a cap trips. The plan must END in a single-sortie verify phase — use “+ verify phase” below.'
              : 'Off: the mission finishes at its last phase (the classic linear walk).'}
          </span>
          {loopEnabled && (
            <div className="field-row" style={{ marginTop: 8 }}>
              <div className="field" style={{ maxWidth: 130 }}><label>Max rounds</label>
                <input type="number" min={1} max={8} value={maxRounds}
                  onChange={(e) => setMaxRounds(clamp(e.target.value, 1, 8, 4))} />
                <span className="hint">1–8 total rounds.</span>
              </div>
              <div className="field" style={{ maxWidth: 160 }}><label>Mechanical rounds</label>
                <input type="number" min={0} max={4} value={mechanicalRounds}
                  onChange={(e) => setMechanicalRounds(clamp(e.target.value, 0, 4, 2))} />
                <span className="hint">Fix rounds before escalation.</span>
              </div>
              <div className="field" style={{ maxWidth: 140 }}><label>Sortie budget</label>
                <input type="number" min={1} max={64} value={sortieBudget}
                  onChange={(e) => setSortieBudget(clamp(e.target.value, 1, 64, 24))} />
                <span className="hint">Max sorties, all rounds.</span>
              </div>
            </div>
          )}
          {/* SPEC-LOOP W3 (G4) — the pre-execution plan gate. On → the mission won't start until the
              codex Brain grades the drafted plan green (fact-check anchors + red-team soundness). */}
          {loopEnabled && (
            <div style={{ marginTop: 8 }}>
              <label className="msn-check-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={requirePlanReview} onChange={(e) => setRequirePlanReview(e.target.checked)} />
                <span>Require plan review before start</span>
              </label>
              <span className="hint">
                The assistant grades the plan (fact-check + red-team, read-only) before any agent runs; a
                blocked plan auto-redrafts once. You review the grade on the draft and clear the gate to start.
              </span>
            </div>
          )}
          {/* SPEC-LOOP W6 — the in-loop code review. On → once the suite is green, a routed reviewer must
              attest the change (or its confirmed findings get fixed) before the loop completes. */}
          {loopEnabled && (
            <div style={{ marginTop: 8 }}>
              <label className="msn-check-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={requireReview} onChange={(e) => setRequireReview(e.target.checked)} />
                <span>Require code review before done</span>
              </label>
              <span className="hint">
                When the suite goes green, a routed reviewer reviews the change. A clean attestation completes
                the loop; confirmed findings append a fix round and re-verify. Add the review phase with
                “+ verify phase” (it goes just before the verify tail).
              </span>
            </div>
          )}
          {/* SPEC-LOOP W7 — the false-fail investigator. On → each fix round starts with an investigator
              that classifies the failures real / by-design / false; fixers work only the real ones. */}
          {loopEnabled && (
            <div style={{ marginTop: 8 }}>
              <label className="msn-check-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={investigate} onChange={(e) => setInvestigate(e.target.checked)} />
                <span>Investigate failures each round</span>
              </label>
              <span className="hint">
                Each fix round starts with an investigator that classifies failures real / by-design / false;
                the fixers work only the real ones, and the suppressions are listed in the delivery report.
                The suite must still go fully green — triage never fabricates a pass.
              </span>
            </div>
          )}
          {/* SPEC-PLANNER §3 (DEC-P8) — spawn a planner terminal. Offered in the loop block because an
              escalation (where the planner is consulted) is a loop event; an existing pane can also be
              attached from the mission detail after create. */}
          {loopEnabled && (
            <div style={{ marginTop: 8 }}>
              <label className="msn-check-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={spawnPlanner} onChange={(e) => setSpawnPlanner(e.target.checked)} />
                <span>Spawn a planner terminal</span>
              </label>
              <span className="hint">
                Binds a Tower-spawned agent pane (routed via the ‘plan’ role) as this mission’s planner. When
                the loop escalates, the Tower consults it for a re-plan instead of the built-in brain. A spawn
                failure blocks the create; you can also attach an existing idle pane from the mission detail.
              </span>
            </div>
          )}
        </div>

        <div className="field"><label>Regression gate (optional)</label>
          {/* §4 — the RAW suite the Tower runs itself against a trial-merge worktree before landing
              a phase. It holds no agent terminal, so this is a plain command, not `towerctl test run`.
              SPEC-TESTING §4 — the prefill is the project's configured gateSuite when set.
              SPEC-LOOP — a loop mission carries NO separate gate (its verify phase IS the regression
              check; a per-advance gate is incompatible with the loop's incremental round landing), so
              loop mode DISABLES the field and shows it empty — the operator sees the gate isn't
              applied rather than a silent drop. Like effectiveAdvance, the stored gateSuite text is
              untouched and restores when the loop toggles off. */}
          <div className="msn-check-row">
            {/* A real VALUE (prefilled from the project config), not a placeholder — WYSIWYG: what's
                here is what ships. Editing marks it touched; only a touched field is sent on create
                (touched-empty = explicit opt-out), so an untouched composer inherits the project gate. */}
            <input className="mono" placeholder={loopEnabled ? '' : gateCmd} disabled={loopEnabled}
              value={loopEnabled ? '' : gateSuite}
              onChange={(e) => { gateTouched.current = true; setGateSuite(e.target.value); }} />
            <button type="button" className="btn sm ghost" disabled={loopEnabled}
              title={`Set the gate to the ${testingCfg?.gateSuite?.trim() ? 'project’s configured' : 'raw e2e'} suite command (${gateCmd})`}
              onClick={() => { gateTouched.current = true; setGateSuite(gateCmd); }}>
              {testingCfg?.gateSuite?.trim() ? 'project suite' : 'playwright'}
            </button>
          </div>
          <span className="hint">
            {loopEnabled
              ? 'In loop mode the verify phase is the regression check — a separate gate isn’t used. Your gate command comes back if the loop is turned off.'
              : <>Before landing a phase, the Tower merges its sorties into a throwaway worktree and runs this
                suite — a red result blocks the land, nothing merges. Runs in-process (no agent terminal), so
                give the raw command, e.g. <span className="mono">{gateCmd}</span>. Prefilled from the project’s
                testing config; leave empty for no gate.</>}
          </span>
        </div>

        <div className="field">
          <div className="msn-editor-head">
            <label style={{ margin: 0 }}>Phases &amp; sorties</label>
            <div style={{ flex: 1 }} />
            <button className="btn sm" disabled={drafting || !projectId || !goal.trim()} onClick={draftWithAssistant}>
              {drafting ? 'Drafting…' : '✦ Draft phases with assistant'}
            </button>
          </div>
          <span className="hint">Draft a starting plan from the goal, then edit freely. No reorder in v1.</span>
        </div>

        <div className="msn-editor">
          {phases.map((p, i) => (
            <div className="msn-phase-card" key={p.k}>
              <div className="msn-phase-card-head">
                <span className="msn-phase-n">Phase {i + 1}</span>
                <input className="msn-phase-input" placeholder="phase name" value={p.name}
                  onChange={(e) => setPhase(p.k, { name: e.target.value })} />
                <button className="btn sm ghost" disabled={phases.length <= 1} title={phases.length <= 1 ? 'a mission needs at least one phase' : 'remove phase'}
                  onClick={() => removePhase(p.k)}>✕</button>
              </div>
              <div className="msn-sortie-cards">
                {p.sorties.map((so, j) => {
                  const eff = effectiveRoute(so, provider, model, effective, providers);
                  // D3 account picker (§3): accounts of the RESOLVED provider (Brain accounts
                  // excluded — cosmetic; the start gate refuses them server-side regardless).
                  const acctOptions = profiles.filter((pr) => pr.provider === eff.provider && !brainProfileIds.includes(pr.id));
                  // Effective account for the preview: the sortie account rides iff it's an
                  // account of the resolved provider; else the role tier's server-resolved account
                  // (api.ts EffectiveRoleRoute — already provider-MATCH-gated for the role's provider,
                  // so it only rides when that IS the resolved provider); else the shared login
                  // (nothing shown). The mission tier is unreachable from the composer, so the client
                  // chain honestly stops at role.
                  const effRole = so.role ? effective[so.role as PipelineRole] : undefined;
                  const sortieProfile = so.profileId ? profiles.find((pr) => pr.id === so.profileId) : undefined;
                  const effAccount =
                    sortieProfile && sortieProfile.provider === eff.provider
                      ? sortieProfile.label
                      : effRole && effRole.provider === eff.provider && effRole.profileId
                        ? (effRole.profileLabel ?? effRole.profileId)
                        : null;
                  return (
                  <div className="msn-sortie-card" key={so.k}>
                    <div className="msn-sortie-card-head">
                      <span className="msn-sortie-n">Sortie {j + 1}</span>
                      <input className="msn-sortie-input" placeholder="sortie name" value={so.name}
                        onChange={(e) => setSortie(p.k, so.k, { name: e.target.value })} />
                      <button className="btn sm ghost" disabled={p.sorties.length <= 1} title={p.sorties.length <= 1 ? 'a phase needs at least one sortie' : 'remove sortie'}
                        onClick={() => removeSortie(p.k, so.k)}>✕</button>
                    </div>
                    <textarea className="msn-ta" placeholder="task — what should this sortie’s agent do?" value={so.task}
                      onChange={(e) => setSortie(p.k, so.k, { task: e.target.value })} />

                    {/* Per-sortie routing (§2.2): role/provider/model overrides, each optional and
                        each falling through its own precedence chain. The effective line previews
                        where the server's resolveRouting will actually send this sortie at Start. */}
                    <div className="msn-route">
                      <div className="msn-route-fields">
                        {/* With an INHERITED provider the role picks it, so a role change can strand a
                            now-cross-provider account/model/effort — clear all. With an EXPLICIT sortie
                            provider the role is just a label (routing ignores it), so keep the operator's picks. */}
                        <div className="field msn-route-f"><label>Role</label>
                          <select value={so.role} onChange={(e) => setSortie(p.k, so.k, so.provider ? { role: e.target.value } : { role: e.target.value, profileId: '', model: '', effort: '' })}>
                            <option value="">— auto —</option>
                            {PIPELINE_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                          </select>
                        </div>
                        <div className="field msn-route-f"><label>Provider</label>
                          {/* Switching provider clears this sortie's model, effort AND account — all are
                              provider-specific; a carried-over triple would only fail at spawn. */}
                          <select value={so.provider} onChange={(e) => setSortie(p.k, so.k, { provider: e.target.value, profileId: '', model: '', effort: '' })}>
                            <option value="">inherit</option>
                            {agentAdapters.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
                          </select>
                        </div>
                        <div className="field msn-route-f"><label>Model</label>
                          {/* SPEC-MODELS §3 — the resolved provider's roster (empty = inherit the route
                              default); ↻ refresh uses this sortie's account when one is picked. */}
                          <ModelSelect
                            provider={(eff.provider || undefined) as ProviderId | undefined}
                            value={so.model}
                            onChange={(v) => setSortie(p.k, so.k, { model: v })}
                            profileId={so.profileId || undefined}
                            allowEmpty
                            compact
                            ariaLabel="Sortie model"
                          />
                        </div>
                        {/* SPEC-EFFORT §4 — the per-sortie effort, same eff.provider resolution as the
                            sortie ModelSelect above; codex/claude only, kept across a model switch. */}
                        <div className="field msn-route-f"><label>Effort</label>
                          <EffortSelect
                            provider={(eff.provider || undefined) as ProviderId | undefined}
                            model={so.model.trim() || undefined}
                            profileId={so.profileId || undefined}
                            value={so.effort}
                            onChange={(v) => setSortie(p.k, so.k, { effort: v })}
                            compact
                            ariaLabel="Sortie effort"
                          />
                        </div>
                        {/* §3 — the per-sortie account: options are the resolved provider's accounts;
                            ''=inherit (role account / shared login). A stale mismatch stays visible +
                            truthful below and the start gate hard-errors it. */}
                        <div className="field msn-route-f"><label>Account</label>
                          <select value={so.profileId} onChange={(e) => setSortie(p.k, so.k, { profileId: e.target.value })}>
                            <option value="">inherit</option>
                            {so.profileId && !acctOptions.some((pr) => pr.id === so.profileId) && (
                              <option value={so.profileId}>(not a {labelFor(eff.provider)} account — will fail at start)</option>
                            )}
                            {acctOptions.map((pr) => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="msn-route-eff">
                        <span className="msn-route-arrow">→ runs on</span>
                        <span className="msn-route-prov">{labelFor(eff.provider)}</span>
                        <span className="msn-route-model mono">{eff.model || 'provider default'}</span>
                        {/* §3 — the resolved account; absent = the provider's shared login dir. */}
                        {effAccount && <span className="msn-route-acct">· {effAccount}</span>}
                      </div>
                      {/* §5 shadow hint: the role's project/workflow route outranks (and differs
                          from) the mission provider picked above — say so, don't let the operator
                          think the mission default applies here. */}
                      {eff.shadows && (
                        <div className="msn-route-shadow">
                          ⚠ mission provider {labelFor(provider)} shadowed by the{' '}
                          {eff.shadows === 'project' ? 'project’s' : 'project workflow’s'} route for{' '}
                          {PIPELINE_ROLES.find((r) => r.id === so.role)?.label ?? so.role}
                        </div>
                      )}
                      {so.rationale && <div className="msn-route-why" title="Jarvis proposal — why this routing">✦ {so.rationale}</div>}
                    </div>

                    <div className="field">
                      <label>Acceptance criteria (one per line)</label>
                      <textarea className="msn-ta sm" placeholder="the judge grades each — one assertion per line" value={so.assertions}
                        onChange={(e) => setSortie(p.k, so.k, { assertions: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Check command (optional)</label>
                      {/* §5.1 — one-click e2e-kit preset beside the free-text check input.
                          SPEC-TESTING §4 — ALWAYS the kit entrypoint (a project suiteCommand
                          runs inside it, server-side; a raw command records no TestRun). */}
                      <div className="msn-check-row">
                        <input className="mono" placeholder="e.g. pnpm test — exit 0 = pass" value={so.checkCommand}
                          onChange={(e) => setSortie(p.k, so.k, { checkCommand: e.target.value })} />
                        <button type="button" className="btn sm ghost"
                          title={`Set the check to the e2e test kit (${E2E_SUITE_CMD})`}
                          onClick={() => setSortie(p.k, so.k, { checkCommand: E2E_SUITE_CMD })}>
                          e2e suite
                        </button>
                      </div>
                    </div>
                  </div>
                  );
                })}
                <button className="msn-add sm" onClick={() => addSortie(p.k)}>+ sortie</button>
              </div>
            </div>
          ))}
          <button className="msn-add" onClick={addPhase}>+ phase</button>
          {/* §3.1 — the verify template: inserts a runner phase + a fixer phase and raises
              concurrency so the fixers run simultaneously. */}
          <button className="msn-add msn-verify" onClick={addVerifyPhases}
            title="Insert a verify → fix phase pair: one sortie writes & runs the e2e suite, then fixers split its failures. Raises concurrency so the fixers run simultaneously.">
            + verify phase <span className="msn-verify-sub">runner writes &amp; runs the suite, then {VERIFY_FIXER_COUNT} fixers split the failures</span>
          </button>
          {/* SPEC-TESTING §3 — the documentor phase: one docs sortie whose task the Tower finalizes
              from the verify run at phase start. It never gates (docs change docs, not code). */}
          <button className="msn-add msn-verify" onClick={addDocsPhase}
            title="Append a documentor phase: one docs-routed sortie updates README/docs from the verify run's results. Never gates — a docs failure can't block the mission.">
            + docs phase <span className="msn-verify-sub">documentor writes up the verified behavior — never gates</span>
          </button>
          {/* SPEC-RESEARCH W9 — the research phase: marked 'explore' sorties whose success is a
              submitted finding rather than commits. Never lands code; never gates. */}
          <button className="msn-add msn-verify" onClick={addResearchPhase}
            title="Append a research phase: 'explore'-routed sorties answer a question and submit a typed finding. Never lands code — the finding feeds later sorties, the re-planner and the report.">
            + research phase <span className="msn-verify-sub">explorer submits a finding — never lands code</span>
          </button>
        </div>

        <div className="modal-actions" style={{ border: 'none', padding: 0 }}>
          {invalid && <span className="msn-invalid">{invalid}</span>}
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn ok" disabled={!!invalid || busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create mission'}
          </button>
        </div>
      </div>
    </div>
  );
}

function clamp(v: string, lo: number, hi: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
