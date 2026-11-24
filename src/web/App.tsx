// Control Tower — the Flightline. Projects are sectors; runs are strips flowing
// Intake → Loop → Gate → Land. Loops are first-class (author → watch iterations →
// gate → land). The Tower dock is the clearance/triage surface. Per-project isolation
// is a shield toggle. One live terminal mounts at a time, in the Cockpit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tower, connectStream, type TerminalWithLiveness, type AdapterInfo, type Observability, type TestRunInfo, type ProjectRoutingView, type ConsultView } from './api.js';
import type {
  Project, TerminalState, AttentionItem, ProviderId, GitHubIdentity, AgentProfile,
  Loop, Mission, PipelineRole, ProjectSecurity, CreateLoopRequest, SecurityStatus, ProviderDef, RoleRouting,
  Task,
} from '../shared/types.js';
import { PIPELINE_ROLES } from '../shared/roles.js';
import { TerminalView } from './TerminalView.js';
import { ReviewPanel } from './ReviewPanel.js';
import { MemoryPanel } from './MemoryPanel.js';
import { RepoBootstrapPanel } from './RepoBootstrap.js';
import { SettingsView, type SettingsSection } from './SettingsView.js';
import { BoardView } from './BoardView.js';
import { MissionsView } from './MissionsView.js';
import { ModelSelect, invalidateModelCache } from './ModelSelect.js';
import { EffortSelect } from './EffortSelect.js';
import { OutcomesView } from './OutcomesView.js';
import { StoriesView } from './StoriesView.js';
import { FilesView } from './FilesView.js';
import { FilesPanel } from './FilesPanel.js';
import { SuiteChip } from './SuiteChip.js';
import { TestRunsPanel } from './TestRunsPanel.js';
import { notify, setBadge, requestNotifyPermission } from './notify.js';
import { AssistantDock } from './AssistantDock.js';
import { listAssistantAccounts } from './assistant-api.js';
import { wirePath, pushSample, sparkPoints, isMemFresh, memAge, timeAgo, landedTodayByProject, repoShortName } from './flightline-utils.js';

// SPEC-STORYLOOP §5.1 — the loop composer's one-click e2e-kit check preset (mirrors MissionsView).
const E2E_SUITE_CMD = 'towerctl test run';

const STATE_LABEL: Record<TerminalState, string> = {
  starting: 'starting', working: 'working', 'blocked-question': 'needs answer',
  'blocked-permission': 'needs approval', idle: 'idle', killed: 'stopped',
};
function stripState(t: { state: TerminalState; alive?: boolean }): string {
  if (t.state === 'killed' || t.alive === false) return 's-dead';
  if (t.state === 'blocked-question' || t.state === 'blocked-permission') return 's-hold';
  if (t.state === 'working') return 's-working';
  if (t.state === 'idle') return 's-idle';
  return 's-working';
}
function isBlocked(s: TerminalState): boolean {
  return s === 'blocked-question' || s === 'blocked-permission';
}
// J5 honesty (D2): amber markers on a LIVE terminal whose idle is not a hard completion signal.
//   ~inferred — its CURRENT idle was reached by poller inference (quiescence/backstop), no signal.
//   tier C    — a dwell-only custom provider: it never reports completion, only a quiet screen.
function honestyFlags(t: TerminalWithLiveness): { inferred: boolean; dwellOnly: boolean } {
  const live = t.alive !== false && t.state !== 'killed';
  return {
    inferred: live && t.turnInferred === true,
    dwellOnly: live && t.providerDef?.turn.mode === 'dwell-only',
  };
}
function HonestyChips({ term }: { term: TerminalWithLiveness }) {
  const { inferred, dwellOnly } = honestyFlags(term);
  if (!inferred && !dwellOnly) return null;
  return (
    <>
      {inferred && (
        <span className="chip hold" title="Idle inferred from output quiescence — no completion signal was seen this turn (degraded).">~inferred</span>
      )}
      {dwellOnly && (
        <span className="chip hold" title="Dwell-only provider (tier C): completion is inferred from a quiet screen, not a reported signal.">tier C</span>
      )}
    </>
  );
}
// Built-in literals checked first (their narrowing/badges unchanged); a custom:<slug> id
// (⟦DP-1⟧/§1.2) gets the generic 'CU' badge + its slug — mirrors BoardView.tsx.
function avClass(p: ProviderId): string {
  return p === 'claude-code' ? 'cc' : p === 'gemini-cli' ? 'gm' : p === 'codex' ? 'cx' : p === 'hermes' ? 'he' : p.startsWith('custom:') ? 'cu' : 'sh';
}
function avText(p: ProviderId): string {
  return p === 'claude-code' ? 'CC' : p === 'gemini-cli' ? 'GM' : p === 'codex' ? 'CX' : p === 'hermes' ? 'HE' : p.startsWith('custom:') ? 'CU' : 'SH';
}
function providerShort(p: ProviderId): string {
  return p === 'claude-code' ? 'claude' : p === 'gemini-cli' ? 'gemini' : p === 'codex' ? 'codex' : p === 'hermes' ? 'hermes'
    : p.startsWith('custom:') ? p.slice('custom:'.length) : 'shell';
}

interface FeedItem { ts: string; kind: string; text: string; }

// The TestRuns view's api bundle — MODULE-level (the SettingsView providersApi idiom) so its
// identity is stable: TestRunsPanel keys its load callback + 6s poll effect on `api`, and a
// per-render literal would refetch GET /api/testruns on every App render and reset the interval.
const testRunsApi = {
  listRuns: tower.testRuns,
  fileFailures: tower.fileTestFailures,
  downloadArtifact: tower.downloadTestArtifact,
  downloadLog: tower.downloadTestLog,
  summarize: tower.summarizeRun,
  fetchArtifactBlob: tower.fetchTestArtifactBlob,
};

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [terminals, setTerminals] = useState<TerminalWithLiveness[]>([]);
  const [loops, setLoops] = useState<Loop[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  // SPEC-PLANNER §9 — open + newest-closed planner consults, parent-push (the backlog pattern): refetched
  // on the {t:'consults'} SSE frame and in refreshAll, passed to MissionsView for the amber waiting line.
  const [consults, setConsults] = useState<ConsultView[]>([]);
  const [focusMission, setFocusMission] = useState<string | undefined>(undefined);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  // Custom-provider roster (§1.1) + role-default routing (§2.1), for the composers, Missions
  // per-sortie routing, and Outcomes tier flags. providersVersion is bumped on each `providers`
  // SSE frame to live-refresh the settings panel without a restart.
  const [providers, setProviders] = useState<ProviderDef[]>([]);
  const [routing, setRouting] = useState<RoleRouting>({});
  // SPEC-STORYLOOP — a top-level testruns list feeds the mission/loop <SuiteChip>s (a FULL list,
  // one per builder terminal — not the dock's recent slice).
  const [testRuns, setTestRuns] = useState<TestRunInfo[]>([]);
  // Per-topic invalidation map for VERSION-SIGNAL consumers only — providers (SettingsView),
  // stories (StoriesView reloadSignal), memory (MemoryPanel + MemoryBar). Backlog is deliberately
  // absent: it is parent-push (the SSE handler refetches tasks straight into state), not a counter anyone reads.
  const [invalidations, setInvalidations] = useState<Record<'providers' | 'stories' | 'skills' | 'runway' | 'memory', number>>({
    providers: 0, stories: 0, skills: 0, runway: 0, memory: 0,
  });
  // SPEC-BACKLOG — the stored pre-execution task lanes (Board intake) + board archive reveal.
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  // Board → composer seeds (§2): seq-keyed mission-compose prefill; loop-composer prefill rides
  // the composer modal state below. Seeds are ONE-SHOT: cleared when their composer closes (the
  // mission seed also when the operator leaves the Missions view mid-compose) — a stale seed
  // would hijack the next compose AND cross-link its backlogTaskId onto an unrelated run.
  const [missionSeed, setMissionSeed] = useState<{ goal: string; backlogTaskId?: string; seq: number } | undefined>(undefined);
  const [loopSeed, setLoopSeed] = useState<{ name: string; task: string; backlogTaskId: string } | null>(null);
  // Tasks with a composer currently open on them (§2's optimistic 'drafting…' state): the Board
  // shows a chip and withholds instantiation actions, narrowing the sequential double-draft
  // window (link()'s overwrite refusal bounds what remains). Session-local by design (§8).
  const [draftingTaskIds, setDraftingTaskIds] = useState<ReadonlySet<string>>(new Set());
  const draftingRemove = (id?: string) => {
    if (id) setDraftingTaskIds((s) => { const n = new Set(s); n.delete(id); return n; });
  };
  // Ref mirror for the once-registered keydown listener (its closure never sees fresh state).
  const loopSeedRef = useRef<typeof loopSeed>(null);
  useEffect(() => { loopSeedRef.current = loopSeed; }, [loopSeed]);
  const [identities, setIdentities] = useState<GitHubIdentity[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  // SPEC-TESTING §1.4/§1.7 — the profileIds of ALL assistant Brain accounts, read at runtime
  // (never hardcoded), so every account dropdown can exclude them. The server reserves every
  // assistant account, not just the first. UX only; the server refuses them on write.
  const [brainProfileIds, setBrainProfileIds] = useState<string[]>([]);
  const [security, setSecurity] = useState<Record<string, ProjectSecurity>>({});
  const [globalSec, setGlobalSec] = useState<SecurityStatus | null>(null);
  const [obs, setObs] = useState<Observability | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  // SPEC-FLIGHTLINE-V2 §1 — the latest mail event as a pulse trigger for the Flightline wire overlay. seq
  // bumps per event so the WireOverlay effect keys on identity (a repeat from→to still fires a fresh pulse).
  const [mailPulse, setMailPulse] = useState<{ from: string; to: string; seq: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // terminalId → cockpit
  const [view, setView] = useState<'flightline' | 'settings' | 'board' | 'missions' | 'outcomes' | 'stories' | 'files' | 'testruns'>('flightline');
  // Leaving the Missions view mid-compose abandons the mission seed: without this, the still-set
  // seed re-hijacks the compose screen on every revisit and its backlogTaskId rides a later create.
  useEffect(() => {
    if (view !== 'missions' && missionSeed) {
      draftingRemove(missionSeed.backlogTaskId);
      setMissionSeed(undefined);
    }
  }, [view]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('connections');
  // Collapsible rail drawer — open by default, remembered across reloads.
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('ct.railOpen') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('ct.railOpen', railOpen ? '1' : '0'); } catch { /* storage unavailable — non-fatal */ }
  }, [railOpen]);
  // SPEC-FILES §5a — the Files view's controlled project id (the SettingsView section pattern).
  // Starts '' → FilesView's guard defaults it to the first project once the roster arrives.
  const [filesProjectId, setFilesProjectId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [alertsOn, setAlertsOn] = useState(false);
  const [clock, setClock] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [composer, setComposer] = useState<string | null>(null); // projectId
  const [isoPop, setIsoPop] = useState<{ projectId: string; rect: DOMRect } | null>(null);
  const [memoryModal, setMemoryModal] = useState<string | null>(null); // projectId
  const [bootstrapModal, setBootstrapModal] = useState<string | null>(null); // projectId (SPEC-INITPUSH)
  const [loopModal, setLoopModal] = useState<string | null>(null); // loopId
  const [showAddProject, setShowAddProject] = useState(false);
  const prevAttn = useRef<Set<string>>(new Set());
  const securityRef = useRef<Record<string, ProjectSecurity>>({});
  useEffect(() => { securityRef.current = security; }, [security]);

  const pushFeed = useCallback((kind: string, text: string) => {
    setFeed((f) => [{ ts: new Date().toISOString(), kind, text }, ...f].slice(0, 10));
  }, []);

  // ---- clock ----
  useEffect(() => {
    const t = () => {
      const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
      setClock(`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`);
    };
    t();
    const id = setInterval(t, 1000);
    return () => clearInterval(id);
  }, []);

  // ---- ⌘K ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); }
      // Escape must clear the loop SEED with the composer — a stale seed would prefill (and
      // cross-link) the next normally-opened composer. Read via ref: this listener registers
      // once, so state in its closure would be stale. The drafting chip clears with it.
      if (e.key === 'Escape') {
        setPaletteOpen(false); setIsoPop(null); setComposer(null);
        draftingRemove(loopSeedRef.current?.backlogTaskId); setLoopSeed(null);
        setMemoryModal(null); setBootstrapModal(null); setLoopModal(null); setAssistantOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Intent changes update the map directly (setIsolation), so a project is cached once
  // resolved — EXCEPT while the host is unprovisioned: keep polling those so that running
  // setup-isolation.sh flips `available` within a refresh cycle instead of needing a reload.
  const refreshSecurity = useCallback(async (ps: Project[]) => {
    const missing = ps.filter((p) => {
      const cur = securityRef.current[p.id];
      return !cur || !cur.available;
    });
    if (missing.length === 0) return;
    const entries = await Promise.all(
      missing.map(async (p) => [p.id, await tower.projectSecurity(p.id).catch(() => null)] as const),
    );
    setSecurity((cur) => {
      const nx = { ...cur };
      for (const [id, sec] of entries) if (sec) nx[id] = sec;
      return nx;
    });
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [p, t, l, m, at, a, idn, prof, gsec, ob] = await Promise.all([
        tower.listProjects(), tower.listTerminals(), tower.listLoops(), tower.listMissions(), tower.attention(),
        tower.listAdapters(), tower.listIdentities(), tower.listProfiles(), tower.security(), tower.observability(),
      ]);
      setProjects(p); setTerminals(t); setLoops(l); setMissions(m); setAttention(at);
      setAdapters(a); setIdentities(idn); setProfiles(prof); setGlobalSec(gsec); setObs(ob);
      void refreshSecurity(p);
      // Providers + routing are best-effort: a fetch failure keeps the prior roster rather than
      // blanking the composers/Outcomes (and never surfaces as the top-level error bar).
      tower.listProviders().then((pv) => setProviders(pv)).catch(() => {});
      tower.getRouting().then(setRouting).catch(() => {});
      // Best-effort: the full testruns list drives the mission/loop suite chips. A fetch failure
      // keeps the prior list rather than blanking chips, and never surfaces as the top-level error.
      tower.testRuns().then(setTestRuns).catch(() => {});
      // Best-effort: EVERY Brain account's profileId for the account-dropdown exclusion
      // (SPEC-TESTING §1.4 — the server reserves them all, so the UI must hide them all).
      listAssistantAccounts().then((a) => setBrainProfileIds(a.map((x) => x.profileId).filter(Boolean))).catch(() => {});
      // Best-effort: the Board's stored task lanes (SPEC-BACKLOG §4).
      tower.listTasks().then(setTasks).catch(() => {});
      // Best-effort: open planner consults (SPEC-PLANNER §9) — a fetch failure keeps the prior list.
      tower.listConsults().then(setConsults).catch(() => {});
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [refreshSecurity]);

  // ---- initial + SSE ----
  useEffect(() => {
    void refreshAll();
    void tower.audit().then((rows) => {
      const seed = rows.slice(0, 8).map((r) => ({
        ts: String(r.ts ?? new Date().toISOString()), kind: String(r.action ?? 'event').split('.')[0] ?? 'event',
        text: String(r.action ?? ''),
      }));
      setFeed(seed);
    }).catch(() => {});
    const stop = connectStream((ev) => {
      if (ev.t === 'attention') setAttention(ev.items);
      else if (ev.t === 'terminal-state') {
        setTerminals((ts) => ts.map((t) => (t.id === ev.terminalId ? { ...t, state: ev.state } : t)));
      } else if (ev.t === 'terminals-changed') void refreshAll();
      else if (ev.t === 'loop-state') {
        setLoops((ls) => { const i = ls.findIndex((x) => x.id === ev.loop.id); return i < 0 ? [...ls, ev.loop] : ls.map((x) => (x.id === ev.loop.id ? ev.loop : x)); });
        const it = ev.loop.iterations[ev.loop.iterations.length - 1];
        if (it && it.verdict !== 'pending') pushFeed('iter', `${ev.loop.name} · iter ${it.n} ${it.verdict === 'pass' ? '✓' : '✗'}`);
      } else if (ev.t === 'mission-state') {
        setMissions((ms) => { const i = ms.findIndex((x) => x.id === ev.mission.id); return i < 0 ? [...ms, ev.mission] : ms.map((x) => (x.id === ev.mission.id ? ev.mission : x)); });
        if (ev.mission.status === 'phase-gate') pushFeed('mission', `${ev.mission.name} · phase ${ev.mission.activePhase + 1} complete — gate`);
        else if (ev.mission.status === 'attention') pushFeed('mission', `${ev.mission.name} · needs attention`);
        else if (ev.mission.status === 'done') pushFeed('mission', `${ev.mission.name} · mission complete ✓`);
      } else if (ev.t === 'mail-sent') {
        pushFeed('mail', `${ev.from === 'human' ? 'you' : ev.from} → ${ev.toTitle ?? ev.to}`);
        // SPEC-FLIGHTLINE-V2 §1 — trigger the wire pulse (React 19 batches this with pushFeed into one render).
        setMailPulse((p) => ({ from: ev.from, to: ev.to, seq: (p?.seq ?? 0) + 1 }));
      } else if (ev.t === 'providers') {
        // A ProviderDef store mutation: bump the panel refresh signal and refetch BOTH the roster
        // (composers/Outcomes) and the adapters list (a new/removed custom id changes it).
        setInvalidations((m) => ({ ...m, providers: m.providers + 1 }));
        tower.listProviders().then((pv) => setProviders(pv)).catch(() => {});
        tower.listAdapters().then(setAdapters).catch(() => {});
        // SPEC-MODELS §3 — a def's model roster may have changed; drop the cached model views so every
        // open <ModelSelect> re-reads GET /api/models/:provider on its next render.
        invalidateModelCache();
        // B3: the routing PUT/DELETE routes also emit this frame, so refetch role-default routing
        // here too — kills the ≤15s window where a routing change lagged the periodic poll.
        tower.getRouting().then(setRouting).catch(() => {});
      } else if (ev.t === 'stories') {
        // A Story corpus mutation — bump the reload signal so an open Stories view re-fetches its
        // corpus + coverage without a restart.
        setInvalidations((m) => ({ ...m, stories: m.stories + 1 }));
      } else if (ev.t === 'skills') {
        // A skill-library mutation — bump the reload signal so an open Skills panel refetches its list.
        setInvalidations((m) => ({ ...m, skills: m.skills + 1 }));
      } else if (ev.t === 'runway') {
        // SPEC-RUNWAY — a rotation-config mutation: bump so an open Runway tab refetches its config.
        setInvalidations((m) => ({ ...m, runway: m.runway + 1 }));
      } else if (ev.t === 'memory') {
        // SPEC-MEMORY — a memory entry mutation (any project): bump so an open MemoryPanel re-reads its
        // entries/view and every MemoryBar refreshes its freshness + disputes. A plain counter — each
        // consumer re-fetches only its own project, so carrying projectId here buys nothing.
        setInvalidations((m) => ({ ...m, memory: m.memory + 1 }));
      } else if (ev.t === 'backlog') {
        // A Task corpus mutation — REFETCH into App state (the Board reads tasks as a prop;
        // parent-push, not a version counter). This is the ONLY task refetch: the mutation
        // handlers deliberately don't chain their own, so one edit costs one GET.
        tower.listTasks().then(setTasks).catch(() => {});
      } else if (ev.t === 'consults') {
        // A planner-consult mutation — REFETCH into App state (the backlog parent-push pattern), so the
        // amber "waiting on planner" line + the planner chip reflect delivery/answer/expiry live.
        tower.listConsults().then(setConsults).catch(() => {});
      }
    });
    const poll = setInterval(refreshAll, 15000);
    return () => { stop(); clearInterval(poll); };
  }, [refreshAll, pushFeed]);

  // ---- notifications ----
  useEffect(() => {
    setBadge(attention.length);
    const now = new Set(attention.map((a) => a.terminalId));
    for (const item of attention) {
      if (!prevAttn.current.has(item.terminalId)) {
        notify(item.kind === 'permission' ? 'Agent needs approval' : 'Agent has a question',
          `${item.title}${item.requested ? ` — ${item.requested}` : ''}`);
      }
    }
    prevAttn.current = now;
  }, [attention]);

  const enableAlerts = async () => { await requestNotifyPermission(); setAlertsOn('Notification' in window && Notification.permission === 'granted'); };

  const terminalsByProject = useMemo(() => {
    const m = new Map<string, TerminalWithLiveness[]>();
    for (const t of terminals) { const a = m.get(t.projectId) ?? []; a.push(t); m.set(t.projectId, a); }
    return m;
  }, [terminals]);
  const loopByTerminal = useMemo(() => {
    const m = new Map<string, Loop>();
    for (const l of loops) if (l.terminalId) m.set(l.terminalId, l);
    return m;
  }, [loops]);
  const gatedLoops = useMemo(() => loops.filter((l) => l.status === 'gated'), [loops]);
  const missionHolds = useMemo(() => missions.filter((m) => m.status === 'phase-gate' || m.status === 'attention'), [missions]);
  // Projects not hidden from the Flightline. Only render surfaces that must never point at a hidden
  // project use this (rail glyphs, command palette); the full `projects` list stays the source of truth
  // for name resolution and every other view.
  const activeProjects = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);
  const projectName = useCallback((id: string) => projects.find((p) => p.id === id)?.name ?? id, [projects]);
  const missionNameForLoop = useCallback(
    (l: Loop) => (l.missionId ? missions.find((m) => m.id === l.missionId)?.name : undefined),
    [missions],
  );
  const selectedTerm = terminals.find((t) => t.id === selected) ?? null;

  // ---- actions ----
  // Kick a refresh on open: callers (e.g. Settings → assistant login) may pass a terminal id
  // created server-side moments ago that hasn't arrived via SSE yet — without the refresh the
  // Flightline renders empty until the next poll instead of showing the new cockpit.
  const openTerminal = (id: string) => { setSelected(id); setView('flightline'); void refreshAll(); };
  const killTerminal = async (id: string) => {
    try { await tower.killTerminal(id); if (selected === id) setSelected(null); await refreshAll(); }
    catch (e) { setError((e as Error).message); }
  };
  // SPEC-RESTART — confirm-on-click: a restart replaces the CLI process in place (worktree, account
  // and loop binding survive) and discards the in-flight turn. For claude-code the conversation also
  // resumes (--resume the minted session id), so the confirm copy is provider-conditional.
  const restartTerminal = async (id: string) => {
    const t = terminals.find((x) => x.id === id);
    const resumes = t?.provider === 'claude-code' && t?.purpose !== 'login';
    const msg = resumes
      ? 'Restart this terminal? The CLI relaunches in place (same worktree, account, and loop) and resumes its conversation if one exists — the in-flight turn is discarded and re-driven.'
      : 'Restart this terminal? Its CLI relaunches in place (same worktree, account, and loop) — any in-flight turn is discarded.';
    if (!window.confirm(msg)) return;
    try { await tower.restartTerminal(id); await refreshAll(); }
    catch (e) { setError((e as Error).message); }
  };
  const goHome = () => { setSelected(null); setView('flightline'); };
  /** Sortie chips / board cards resolve a loop to its live cockpit (or the loop modal). */
  const openMissionLoop = (loopId: string) => {
    const l = loops.find((x) => x.id === loopId);
    if (l?.terminalId) openTerminal(l.terminalId);
    else setLoopModal(loopId);
  };
  const openMission = (id: string) => {
    setSelected(null);
    setView('missions');
    setFocusMission(undefined); // re-fire deep-link even for the same mission
    requestAnimationFrame(() => setFocusMission(id));
  };

  const holds = attention.length + gatedLoops.length + missionHolds.length;

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={goHome}><span className="mk" /> Control Tower</button>
        <button className="scope" onClick={() => setPaletteOpen(true)}>All projects <span className="faint">⌘K</span></button>
        <div className="spacer" />
        <div className="leds">
          <span className={`led ${globalSec?.brokerActive === false ? 'bad' : ''}`}><i />Broker</span>
          <span className={`led ${obs?.diskLow ? 'warn' : ''}`}><i />Disk{obs ? ` ${Math.round(obs.diskFreeMb / 1024)}g` : ''}</span>
          {obs && <span className="led"><i />{obs.testActive}/{obs.testCapacity} slots</span>}
        </div>
        {holds > 0 && <button className="hold-count" onClick={goHome}>◆ {holds} hold</button>}
        <button className="bell" onClick={() => setAssistantOpen(true)} title="Onboard assistant — asks about the fleet and proposes changes you confirm">✦ Ask</button>
        <button className={`bell ${alertsOn ? 'on' : ''}`} onClick={enableAlerts}>🔔 Alerts{alertsOn ? ' on' : ''}</button>
        <div className="clock mono">{clock}</div>
      </header>

      <div className={`body ${railOpen ? 'rail-open' : ''}`}>
        <nav className={`rail ${railOpen ? 'open' : ''}`} aria-label="Primary">
          <button type="button" className="rail-toggle" aria-expanded={railOpen}
            aria-label={railOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            title={railOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            onClick={() => setRailOpen((o) => !o)}>
            <span className="glyph">{railOpen ? '«' : '»'}</span>
            <span className="rail-label">Collapse</span>
          </button>
          <div className="rail-projects">
            {activeProjects.length > 0 && <div className="rail-section-label">Projects</div>}
            {activeProjects.map((p) => {
              const sec = security[p.id];
              const initials = p.name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toLowerCase() || 'p';
              return (
                <button type="button" key={p.id} className="rail-item" title={p.name}
                  onClick={() => { goHome(); document.getElementById(`sector-${p.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
                  <span className="glyph">
                    {initials}
                    {sec && <span className={`shield ${sec.effective === 'per-agent-uid' ? 'on' : 'off'}`}>{sec.effective === 'per-agent-uid' ? '✓' : '!'}</span>}
                  </span>
                  <span className="rail-label">{p.name}</span>
                </button>
              );
            })}
          </div>
          <div className="sep" />
          <div className="rail-views">
            <button type="button" className={`rail-item ${view === 'board' ? 'active' : ''}`} aria-current={view === 'board' ? 'page' : undefined}
              title="Board — the whole fleet as a derived kanban"
              onClick={() => { setSelected(null); setView('board'); }}>
              <span className="glyph"><span className="icon">▦</span></span><span className="rail-label">Board</span></button>
            <button type="button" className={`rail-item ${view === 'missions' ? 'active' : ''}`} aria-current={view === 'missions' ? 'page' : undefined}
              title="Missions — plan phases of sorties, autopilot advances at phase gates"
              onClick={() => { setSelected(null); setFocusMission(undefined); setView('missions'); }}>
              <span className="glyph"><span className="icon">◇</span></span><span className="rail-label">Missions</span></button>
            <button type="button" className={`rail-item ${view === 'stories' ? 'active' : ''}`} aria-current={view === 'stories' ? 'page' : undefined}
              title="Stories — user-story corpus + e2e coverage"
              onClick={() => { setSelected(null); setView('stories'); }}>
              <span className="glyph"><span className="icon">▧</span></span><span className="rail-label">Stories</span></button>
            <button type="button" className={`rail-item ${view === 'files' ? 'active' : ''}`} aria-current={view === 'files' ? 'page' : undefined}
              title="Files — browse a project's tree, view files, preview built artifacts"
              onClick={() => { setSelected(null); setView('files'); }}>
              <span className="glyph"><span className="icon">▥</span></span><span className="rail-label">Files</span></button>
            <button type="button" className={`rail-item ${view === 'testruns' ? 'active' : ''}`} aria-current={view === 'testruns' ? 'page' : undefined}
              title="Test runs — e2e run history, artifacts, file failures to the backlog"
              onClick={() => { setSelected(null); setView('testruns'); }}>
              <span className="glyph"><span className="icon">▩</span></span><span className="rail-label">Test runs</span></button>
            <button type="button" className={`rail-item ${view === 'outcomes' ? 'active' : ''}`} aria-current={view === 'outcomes' ? 'page' : undefined}
              title="Outcomes — who's good at what"
              onClick={() => { setSelected(null); setView('outcomes'); }}>
              <span className="glyph"><span className="icon">▤</span></span><span className="rail-label">Outcomes</span></button>
            <button type="button" className={`rail-item ${view === 'settings' ? 'active' : ''}`} aria-current={view === 'settings' ? 'page' : undefined}
              title="Settings — connections, routing, projects, assistant, system"
              onClick={() => { setSelected(null); setView('settings'); }}>
              <span className="glyph"><span className="icon">⚙</span></span><span className="rail-label">Settings</span></button>
          </div>
        </nav>

        <main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {error && <div className="error-bar" onClick={() => setError(null)}>{error}</div>}
          {selectedTerm ? (
            <Cockpit key={selectedTerm.id} term={selectedTerm} loop={loopByTerminal.get(selectedTerm.id)} onBack={goHome}
              onKill={() => killTerminal(selectedTerm.id)} onRestart={() => restartTerminal(selectedTerm.id)}
              onError={setError} onOpenLoop={setLoopModal} memoryVersion={invalidations.memory} />
          ) : view === 'settings' ? (
            <SettingsView section={settingsSection} setSection={setSettingsSection} adapters={adapters} profiles={profiles} brainProfileIds={brainProfileIds} onError={setError} onOpenTerminal={openTerminal} providersVersion={invalidations.providers} skillsVersion={invalidations.skills} runwayVersion={invalidations.runway}
              onStartRun={activeProjects.length === 1 ? () => { goHome(); setComposer(activeProjects[0]!.id); } : goHome}
              startRunLabel={activeProjects.length === 1 ? 'Start a run on the Flightline' : 'Go to the Flightline'} />
          ) : view === 'board' ? (
            <BoardView projects={projects} terminals={terminals} loops={loops} missions={missions}
              tasks={tasks} showArchived={showArchived} draftingTaskIds={draftingTaskIds}
              onOpenTerminal={openTerminal} onOpenMission={openMission}
              onToggleShowArchived={() => setShowArchived((v) => !v)}
              // Mutations rely on the {t:'backlog'} SSE refetch for state — no per-handler
              // refetch (it would double every GET). Create returns its promise so the quick-add
              // clears the typed title only on success.
              onTaskCreate={(req) => tower.createTask(req).then(() => undefined).catch((e) => { setError((e as Error).message); throw e; })}
              onTaskUpdate={(id, patch) => { void tower.updateTask(id, patch).catch((e) => setError((e as Error).message)); }}
              onTaskArchive={(id) => { void tower.updateTask(id, { status: 'archived' }).catch((e) => setError((e as Error).message)); }}
              onArchiveLoop={(id) => { void tower.archiveLoop(id).then(() => refreshAll()).catch((e) => setError((e as Error).message)); }}
              onArchiveMission={(id) => { void tower.archiveMission(id).then(() => refreshAll()).catch((e) => setError((e as Error).message)); }}
              onDraftMission={(task) => {
                // §2 — seed the mission composer with the task as the Jarvis goal; the create
                // request carries backlogTaskId (route-side link stamp). seq re-triggers on repeat.
                setDraftingTaskIds((s) => new Set(s).add(task.id));
                setMissionSeed((s) => ({
                  goal: task.body ? `${task.title}\n\n${task.body}` : task.title,
                  backlogTaskId: task.id,
                  seq: (s?.seq ?? 0) + 1,
                }));
                setSelected(null); setView('missions');
              }}
              onComposeLoop={(task) => {
                setDraftingTaskIds((s) => new Set(s).add(task.id));
                setLoopSeed({ name: task.title, task: task.body || task.title, backlogTaskId: task.id });
                setComposer(task.projectId);
              }}
              onClearFinished={() => {
                void tower.clearFinished()
                  .then((n) => { pushFeed('board', `cleared ${n.loops} loop${n.loops === 1 ? '' : 's'} · ${n.missions} mission${n.missions === 1 ? '' : 's'}`); void refreshAll(); })
                  .catch((e) => setError((e as Error).message));
              }}
            />
          ) : view === 'missions' ? (
            <MissionsView missions={missions} projects={projects} adapters={adapters} providers={providers} routing={routing}
              testRuns={testRuns} loops={loops} profiles={profiles} brainProfileIds={brainProfileIds}
              consults={consults} terminals={terminals}
              api={{
                createMission: tower.createMission, startMission: tower.startMission, pauseMission: tower.pauseMission,
                abortMission: tower.abortMission, advanceMission: tower.advanceMission, retrySortie: tower.retrySortie,
                reviewPlan: tower.reviewPlan,
                planMission: tower.planMission, getProjectRouting: tower.getProjectRouting,
                getProjectTesting: tower.getProjectTesting,
                attachPlanner: tower.attachPlanner, detachPlanner: tower.detachPlanner,
              }}
              onOpenLoop={openMissionLoop} onError={setError} focusMissionId={focusMission}
              composeSeed={missionSeed}
              onSeedDone={() => { draftingRemove(missionSeed?.backlogTaskId); setMissionSeed(undefined); }}
            />
          ) : view === 'files' ? (
            <FilesView projects={projects} projectId={filesProjectId} setProjectId={setFilesProjectId} onError={setError} />
          ) : view === 'testruns' ? (
            <TestRunsPanel
              projects={projects}
              api={testRunsApi}
              onError={setError}
              onFeed={pushFeed}
            />
          ) : view === 'outcomes' ? (
            <OutcomesView loops={loops} missions={missions} providers={providers} />
          ) : view === 'stories' ? (
            <StoriesView
              projects={projects}
              api={{
                listStories: tower.listStories, upsertStory: tower.upsertStory, removeStory: tower.removeStory,
                draftStories: tower.draftStories, coverage: tower.storyCoverage,
              }}
              onError={setError} reloadSignal={invalidations.stories}
            />
          ) : (
            <Flightline
              projects={projects} terminalsByProject={terminalsByProject} loopByTerminal={loopByTerminal}
              security={security} projectName={projectName} missionNameForLoop={missionNameForLoop} testRuns={testRuns}
              loops={loops} mailPulse={mailPulse} memoryVersion={invalidations.memory}
              onOpenTerminal={openTerminal} onOpenLoop={setLoopModal} onNewRun={setComposer}
              onShield={(projectId, rect) => setIsoPop({ projectId, rect })} onMemory={setMemoryModal}
              onBootstrap={setBootstrapModal}
              onFiles={(pid) => { setFilesProjectId(pid); setSelected(null); setView('files'); }}
              onBoard={() => { setShowArchived(true); setSelected(null); setView('board'); }}
              onArchive={(pid, archived) => { void tower.setProjectArchived(pid, archived).then(() => refreshAll()).catch((e) => setError((e as Error).message)); }}
              showAddProject={showAddProject} setShowAddProject={setShowAddProject}
              onAddDone={() => { setShowAddProject(false); void refreshAll(); }} onError={setError}
            />
          )}
        </main>

        <TowerDock
          attention={attention} gatedLoops={gatedLoops} missionHolds={missionHolds} feed={feed} obs={obs} globalSec={globalSec}
          onOpenTerminal={openTerminal} onOpenLoop={setLoopModal} onOpenMission={openMission} onError={setError} onFeed={pushFeed}
        />
      </div>

      <footer className="ticker mono">
        {feed.slice(0, 4).map((f, i) => (
          <span key={i}>{i > 0 && ' · '}<span className="t">{f.ts.slice(11, 19)}</span> <span className="a">{f.kind}</span> {f.text}</span>
        ))}
        {feed.length === 0 && <span className="faint">Tower online — waiting for events.</span>}
      </footer>

      {paletteOpen && (
        <CommandPalette
          projects={activeProjects} terminals={terminals} onClose={() => setPaletteOpen(false)}
          onOpenTerminal={openTerminal} onNewRun={(pid) => { setComposer(pid); }} onGoAccounts={() => { setSelected(null); setView('settings'); setSettingsSection('connections'); }}
          onAsk={() => setAssistantOpen(true)} onError={setError}
        />
      )}
      {assistantOpen && (
        <AssistantDock
          onClose={() => setAssistantOpen(false)}
          onOpenSettings={() => { setAssistantOpen(false); setSelected(null); setView('settings'); setSettingsSection('assistant'); }}
        />
      )}
      {composer && (
        <LoopComposer projectId={composer} projectName={projectName(composer)} adapters={adapters}
          profiles={profiles} brainProfileIds={brainProfileIds} identities={identities}
          projectDefaultIdentity={(() => { const d = projects.find((p) => p.id === composer)?.defaultIdentityId; return d ? identities.find((i) => i.id === d) : undefined; })()}
          projectAutoAccept={projects.find((p) => p.id === composer)?.defaultAutoAccept === true}
          seed={loopSeed ?? undefined}
          onClose={() => { setComposer(null); draftingRemove(loopSeed?.backlogTaskId); setLoopSeed(null); }}
          onDone={() => { setComposer(null); draftingRemove(loopSeed?.backlogTaskId); setLoopSeed(null); void refreshAll(); }} onError={setError} />
      )}
      {isoPop && (
        <IsolationPopover sec={security[isoPop.projectId]} projectName={projectName(isoPop.projectId)} rect={isoPop.rect}
          onClose={() => setIsoPop(null)}
          onSet={async (mode) => {
            try { const next = await tower.setIsolation(isoPop.projectId, mode); setSecurity((s) => ({ ...s, [isoPop.projectId]: next })); }
            catch (e) { setError((e as Error).message); }
          }} />
      )}
      {memoryModal && (
        <Modal title={`Shared memory · ${projectName(memoryModal)}`} onClose={() => setMemoryModal(null)} wide>
          <div style={{ height: 420, display: 'flex' }}><MemoryPanel projectId={memoryModal} onError={setError} reloadSignal={invalidations.memory} /></div>
        </Modal>
      )}
      {bootstrapModal && (
        <Modal title={`Initialize & push · ${projectName(bootstrapModal)}`} onClose={() => setBootstrapModal(null)} wide>
          <RepoBootstrapPanel projectId={bootstrapModal} onError={setError}
            onDone={() => { setBootstrapModal(null); void refreshAll(); }} />
        </Modal>
      )}
      {loopModal && (
        <LoopDetail loop={loops.find((l) => l.id === loopModal) ?? null} onClose={() => setLoopModal(null)}
          onOpenTerminal={openTerminal} onError={setError} onChanged={refreshAll} />
      )}
    </div>
  );
}

// ============================ FLIGHTLINE ============================
function Flightline({
  projects, terminalsByProject, loopByTerminal, security, projectName, missionNameForLoop, testRuns,
  loops, mailPulse, memoryVersion,
  onOpenTerminal, onOpenLoop, onNewRun, onShield, onMemory, onBootstrap, onFiles, onBoard, onArchive,
  showAddProject, setShowAddProject, onAddDone, onError,
}: {
  projects: Project[]; terminalsByProject: Map<string, TerminalWithLiveness[]>; loopByTerminal: Map<string, Loop>;
  security: Record<string, ProjectSecurity>; projectName: (id: string) => string;
  missionNameForLoop: (l: Loop) => string | undefined; testRuns: TestRunInfo[];
  loops: Loop[]; mailPulse: { from: string; to: string; seq: number } | null;
  /** The `{t:'memory'}` SSE counter — each MemoryBar re-reads its own project's freshness + disputes on a bump. */
  memoryVersion: number;
  onOpenTerminal: (id: string) => void; onOpenLoop: (id: string) => void; onNewRun: (pid: string) => void;
  onShield: (pid: string, rect: DOMRect) => void; onMemory: (pid: string) => void; onBootstrap: (pid: string) => void; onFiles: (pid: string) => void;
  onBoard: () => void; onArchive: (pid: string, archived: boolean) => void;
  showAddProject: boolean; setShowAddProject: (b: boolean) => void; onAddDone: () => void; onError: (m: string) => void;
}) {
  const liveCount = (pid: string) => (terminalsByProject.get(pid) ?? []).filter((t) => t.state !== 'killed').length;
  // SPEC-FLIGHTLINE-V2 §1 — the wire overlay measures strip rects relative to this scroll container and
  // anchors its position:absolute svg to it (must be a DIRECT child, not .sector-body which is also relative).
  const flRef = useRef<HTMLDivElement | null>(null);
  // SPEC-FLIGHTLINE-V2 §5 — landed-today per project in one pass, memoized on [loops] so the 1Hz clock
  // render doesn't rescan the loops list for every sector.
  const landedByProject = useMemo(() => landedTodayByProject(loops, new Date()), [loops]);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  // Archiving is presentation-only: `projects` still holds every record (name lookup, pickers, and
  // every other view need the full list), so we split ONLY for what the Flightline renders. An
  // archived project that still has live crew is SURFACED anyway (dimmed, unconditional): work you
  // cannot see is work you cannot reach or kill — the incident this guards against was live
  // terminals invisible inside an archived project. Only genuinely-empty archived projects hide
  // behind the toggle. Memoized like landedByProject above — the Flightline re-renders every second
  // on the 1Hz clock.
  const { visible, surfacedArchived, hidden } = useMemo(() => {
    const visible: Project[] = [];
    const surfacedArchived: Project[] = [];
    const hidden: Project[] = [];
    for (const p of projects) {
      if (!p.archivedAt) visible.push(p);
      else if ((terminalsByProject.get(p.id) ?? []).some((t) => t.state !== 'killed')) surfacedArchived.push(p);
      else hidden.push(p);
    }
    return { visible, surfacedArchived, hidden };
  }, [projects, terminalsByProject]);
  // The whole-fleet running count, hidden projects included: once a project is hidden this is the only
  // home-surface trace that its loop is still running, so it deliberately does NOT drop hidden sectors.
  const runningLoops = useMemo(() => [...loopByTerminal.values()].filter((l) => l.status === 'running').length, [loopByTerminal]);
  // Reset the show-hidden toggle once nothing is hidden, or a stale `true` would make the NEXT hide
  // render the sector on-surface (dimmed) instead of removing it — the toggle itself is gone by then.
  useEffect(() => {
    if (hidden.length === 0 && showArchivedProjects) setShowArchivedProjects(false);
  }, [hidden.length, showArchivedProjects]);

  const renderSector = (p: Project, archived: boolean) => {
    const terms = (terminalsByProject.get(p.id) ?? []).filter((t) => t.state !== 'killed');
    const sec = security[p.id];
    // SPEC-FLIGHTLINE-V2 §5 — loops of THIS project landed on the local calendar day (archived count).
    const landedToday = landedByProject.get(p.id) ?? 0;
    return (
      <section className={`sector${archived ? ' archived' : ''}`} id={`sector-${p.id}`} key={p.id}>
        <div className="sector-head">
          <button className="name" onClick={() => onNewRun(p.id)}>{p.name}</button>
          <span className="meta mono">{p.repoPath} · {liveCount(p.id)} crew</span>
          {p.repoUrl && (
            <a className="meta mono repo-link" href={p.repoUrl} target="_blank" rel="noreferrer" title={p.repoUrl}>{repoShortName(p.repoUrl)}</a>
          )}
          <div style={{ flex: 1 }} />
          {archived
            ? <button className="btn sm ghost" title="Show this project on the Flightline again" onClick={() => onArchive(p.id, false)}>unhide</button>
            : <HideProjectButton live={liveCount(p.id)} onHide={() => onArchive(p.id, true)} />}
          <button className="btn sm ghost" title="Browse this project's files" onClick={() => onFiles(p.id)}>files</button>
          {!archived && p.repoUrl && (
            <button className="btn sm ghost" title="Initialize this directory as a git repo and push the first commit" onClick={() => onBootstrap(p.id)}>init repo</button>
          )}
          {sec && <ShieldChip sec={sec} onClick={(rect) => onShield(p.id, rect)} />}
        </div>
        <div className="sector-body">
          {terms.length === 0 && <div className="empty-sector">No runs in flight.</div>}
          {terms.map((t) => {
            const loop = loopByTerminal.get(t.id);
            return loop
              ? <LoopStrip key={t.id} term={t} loop={loop} missionName={missionNameForLoop(loop)} testRuns={testRuns} onOpen={() => onOpenTerminal(t.id)} onOpenLoop={() => onOpenLoop(loop.id)} />
              : <WorkStrip key={t.id} term={t} onOpen={() => onOpenTerminal(t.id)} />;
          })}
          <div className="ghost" onClick={() => onNewRun(p.id)}><span className="plus">+</span> New run — a loop, or just a terminal</div>
          <MemoryBar projectId={p.id} onOpen={() => onMemory(p.id)} landedToday={landedToday} onBoard={onBoard} memoryVersion={memoryVersion} />
        </div>
      </section>
    );
  };

  const onSurface = visible.length + surfacedArchived.length; // sectors actually rendered on the surface

  return (
    <div className="flightline" ref={flRef}>
      <div className="view-title">
        <h1>Flightline</h1>
        <span className="sub">{onSurface} sector{onSurface === 1 ? '' : 's'}{hidden.length > 0 ? ` · ${hidden.length} hidden` : ''} · {runningLoops} loop{runningLoops === 1 ? '' : 's'} running</span>
        <div style={{ flex: 1 }} />
        {/* Renders whenever anything is hidden, INDEPENDENT of the visible count — otherwise a fully
            archived Flightline would have no way back to un-hide. */}
        {hidden.length > 0 && (
          <button className={`btn sm ghost fl-toggle ${showArchivedProjects ? 'is-on' : ''}`} aria-pressed={showArchivedProjects}
            onClick={() => setShowArchivedProjects((v) => !v)}>
            {showArchivedProjects ? 'hide hidden' : `${hidden.length} hidden`}
          </button>
        )}
        <button className="btn sm" onClick={() => setShowAddProject(!showAddProject)}>+ project</button>
      </div>
      {showAddProject && <AddProject onDone={onAddDone} onError={onError} />}
      {visible.length === 0 && surfacedArchived.length === 0 && hidden.length === 0 && !showAddProject && <div className="empty-sector">No projects yet — add one to start (a git repo path).</div>}
      {visible.length === 0 && surfacedArchived.length === 0 && hidden.length > 0 && !showArchivedProjects && !showAddProject && <div className="empty-sector">All projects are hidden — use the “{hidden.length} hidden” button above to show them.</div>}

      {visible.map((p) => renderSector(p, false))}
      {/* Archived-but-live: always on-surface, dimmed, with its unhide button — never behind the toggle. */}
      {surfacedArchived.map((p) => renderSector(p, true))}
      {showArchivedProjects && hidden.map((p) => renderSector(p, true))}
      {/* SPEC-FLIGHTLINE-V2 §1 — the ephemeral mail-wire overlay, a DIRECT child of .flightline. */}
      <WireOverlay containerRef={flRef} signal={mailPulse} />
    </div>
  );
}

/** The Flightline hide control. With no live crew it's a one-click hide; with live runs it arms first
 *  (the house two-click confirm idiom) so a project with agents in flight can't be swept off the surface
 *  by a stray click — the runs keep running either way. */
function HideProjectButton({ live, onHide }: { live: number; onHide: () => void }) {
  const [armed, setArmed] = useState(false);
  if (live === 0) {
    return <button className="btn sm ghost" title="Hide this project from the Flightline (all data kept)" onClick={onHide}>hide</button>;
  }
  return armed ? (
    <button className="btn sm warn" onClick={() => { setArmed(false); onHide(); }} onBlur={() => setArmed(false)}>hide · {live} live?</button>
  ) : (
    <button className="btn sm ghost" title="Hide from the Flightline — live runs keep running" onClick={() => setArmed(true)}>hide</button>
  );
}

function ShieldChip({ sec, onClick }: { sec: ProjectSecurity; onClick: (rect: DOMRect) => void }) {
  const enforced = sec.enforced;
  const pending = sec.intent === 'per-agent-uid' && sec.available && !enforced;
  const cls = enforced ? 'on' : sec.available ? 'off' : 'unavail';
  const label = enforced ? 'Isolated' : pending ? 'Per-UID · pending' : sec.available ? 'Single-UID' : 'Setup required';
  return (
    <button className={`shield-chip ${cls}`} onClick={(e) => onClick((e.currentTarget as HTMLElement).getBoundingClientRect())}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z" />{!enforced && <path d="M9 12h6" />}
      </svg>{label}
    </button>
  );
}

function WorkStrip({ term, onOpen }: { term: TerminalWithLiveness; onOpen: () => void }) {
  const s = stripState(term);
  const preview = term.state === 'blocked-question' ? 'waiting on your input'
    : term.state === 'blocked-permission' ? 'awaiting approval'
    : term.state === 'working' ? 'working…' : term.alive === false ? 'session stopped' : 'idle';
  const word = isBlocked(term.state) ? 'hold' : term.state === 'working' ? 'working' : term.alive === false ? 'dead' : 'idle';
  const { inferred, dwellOnly } = honestyFlags(term);
  return (
    <div className={`strip work ${s}`} onClick={onOpen} data-term-id={term.id}>
      <div className="seg intake">
        <span className="seg-label">Intake · Run</span>
        <div className="crew"><span className={`av ${avClass(term.provider)}`}>{avText(term.provider)}</span>
          <div><div className="who">{term.title}</div><div className="role">{providerShort(term.provider)}{term.branch ? ' · wt' : ''}</div></div></div>
        {(term.branch || term.autoAccept || inferred || dwellOnly) && (
          <div className="chips">
            {term.branch && <span className="chip wt">{term.branch.split('/').slice(-2).join('/')}</span>}
            {term.branch && term.identityId && <span className="chip">gh</span>}
            {term.autoAccept && <span className="chip auto" title="Autonomous — runs any command without asking (permission prompts are skipped)">auto</span>}
            <HonestyChips term={term} />
          </div>
        )}
      </div>
      <div className="preview"><div className={`pl ${term.state === 'working' ? 'cur' : ''}`}>{preview}</div>
        <div className="pl faint mono">{term.cwd}</div></div>
      <div className="strip-end"><span className={`state-word ${word}`}>{STATE_LABEL[term.state]}{term.lastEventAt ? ` · ${timeAgo(term.lastEventAt)}` : ''}</span></div>
    </div>
  );
}

function LoopStrip({ term, loop, missionName, testRuns, onOpen, onOpenLoop }: { term: TerminalWithLiveness; loop: Loop; missionName?: string; testRuns: TestRunInfo[]; onOpen: () => void; onOpenLoop: () => void }) {
  const s = loop.status === 'gated' ? 's-hold' : stripState(term);
  const last = loop.iterations[loop.iterations.length - 1];
  const stopped = loop.status === 'stopped' || loop.status === 'done' || loop.status === 'failed';
  const { inferred, dwellOnly } = honestyFlags(term);
  // SPEC-FLIGHTLINE-V2 §2 — pop ONLY the newest bead when the iteration count grows within a mount. popN is
  // STATE (not a per-render flag) so an unrelated re-render — e.g. another loop's 1Hz SSE tick — can't strip
  // .new mid-animation. The keyed bead node persists across re-renders, so re-applying the same class does
  // not replay the CSS animation; popN just moves to the next bead on the next growth. prevCountRef starts
  // -1 so a first render (page load, view switch, cockpit round-trip remount) never pops.
  const count = loop.iterations.length;
  const prevCountRef = useRef(-1);
  const [popN, setPopN] = useState<number | null>(null);
  useEffect(() => {
    if (prevCountRef.current !== -1 && count > prevCountRef.current) setPopN(count - 1);
    prevCountRef.current = count;
  }, [count]);
  return (
    <div className={`strip loop ${s}`} onClick={onOpen} data-term-id={term.id}>
      <div className="seg intake">
        <span className="seg-label">Intake · Run</span>
        <div className="crew"><span className={`av ${avClass(term.provider)}`}>{avText(term.provider)}</span>
          <div><div className="who">{loop.name}</div><div className="role">{providerShort(term.provider)} · builder</div></div></div>
        {/* Guard on whether a suite chip can actually RENDER (a parsed non-gate run exists), not on
            bare terminalId — every live loop has one, and an all-absent chip row still consumes the
            parent flex column's gap as an empty box. */}
        {(loop.branch || missionName || term.autoAccept || inferred || dwellOnly ||
          (loop.terminalId && testRuns.some((r) => r.terminalId === loop.terminalId && r.kind !== 'gate' && r.results !== undefined))) && (
          <div className="chips">
            {missionName && <span className="chip msn" title={`sortie of mission "${missionName}"`}>◇ {missionName}</span>}
            {loop.branch && <span className="chip wt">{loop.branch.split('/').slice(-2).join('/')}</span>}
            <HonestyChips term={term} />
            {term.autoAccept && <span className="chip auto" title="Autonomous — runs any command without asking (permission prompts are skipped)">auto</span>}
            {/* SPEC-STORYLOOP §5.2 — derived e2e verdict for this builder's latest non-gate run
                (renders nothing when the reporter isn't wired). */}
            {loop.terminalId && <SuiteChip terminalId={loop.terminalId} testRuns={testRuns} />}
          </div>
        )}
      </div>
      <div className="track">
        <div className="track-top">
          <span className="loop-badge"><span className={`ring ${stopped ? 'stopped' : ''}`} /> Loop</span>
          <button className="lap mono" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); onOpenLoop(); }}>
            iter {loop.iteration}/{loop.maxIterations}
          </button>
          <span className="until">{loop.checkCommand ? <>until <b className="mono">{loop.checkCommand}</b> passes</> : 'agent self-reports done'}</span>
        </div>
        <div className="beads">
          {loop.iterations.map((it, i) => (
            <span key={it.n} className={`bead ${it.verdict === 'pending' ? (loop.status === 'running' ? 'live' : 'pending') : it.verdict}${i === popN ? ' new' : ''}`}
              // Clear .new the instant the pop finishes: the beadin shorthand resets all animation longhands
              // at equal specificity to .bead.live, so a lingering .new would suppress the live bead's pulse
              // forever. Gate on animationName so only beadin (not pulse) triggers the clear, AND on this
              // being the currently-popped bead — a stale animationend from the previous pop (queued just as
              // a back-to-back growth moved popN) must not cancel the new bead's pop.
              onAnimationEnd={(e) => { if (e.animationName === 'beadin' && i === popN) setPopN(null); }}
              title={`iter ${it.n} — ${it.verdict}${it.note ? ` · ${it.note}` : ''}`}>
              {it.verdict === 'pass' ? '✓' : it.verdict === 'fail' ? '✕' : ''}
            </span>
          ))}
        </div>
        {last && (last.added || last.removed) ? (
          <div className="diffstat mono">iter {last.n}: <span className="add">+{last.added ?? 0}</span> <span className="del">−{last.removed ?? 0}</span> · {last.files ?? 0} files</div>
        ) : <div className="diffstat faint">{loop.status === 'gated' ? 'waiting at gate' : loop.status === 'stopped' ? (loop.stopReason ?? 'stopped') : loop.status === 'done' ? 'done' : 'running…'}</div>}
        {/* SPEC-MEMORY — the builder's own `towerctl note` for the latest iteration: what it BELIEVES it is doing.
            Its own row (not crammed into the diffstat line), CSS-clamped to one line with the full text in the
            title; prose, so it reads apart from the mono check tail on the Gate card and the quoted operator
            note in the detail view. Annotation only — the server never feeds it back into a prompt. */}
        {last?.progress && (
          <div className="progress" title={last.progress}>
            <span className="lbl">progress</span>
            <span className="txt">{last.progress}</span>
          </div>
        )}
      </div>
      <div className="strip-end">
        <div className="gate"><div className={`diamond ${loop.status === 'gated' ? 'open' : loop.status === 'done' ? 'done' : ''}`} /><span className="gl">Gate</span></div>
        {/* SPEC-FLIGHTLINE-V2 §6 — a landed loop shows the completed state (armed look persists) + 'Landed'. */}
        <div className={`thr ${loop.landedAt ? 'armed landed' : loop.status === 'done' ? 'armed' : ''}`}><div className="bar" /><span className="gl faint">{loop.landedAt ? 'Landed' : 'Land'}</span></div>
      </div>
    </div>
  );
}

function MemoryBar({ projectId, onOpen, landedToday, onBoard, memoryVersion }: { projectId: string; onOpen: () => void; landedToday: number; onBoard: () => void; memoryVersion: number }) {
  // SPEC-FLIGHTLINE-V2 §4 — meta-first: the fresh dot now means "modified in the last 10 min" (isMemFresh)
  // with a coarse age suffix. On ANY meta failure (older server / fetch error) degrade to today's exact
  // has-content behavior via the legacy content fetch — never a broken bar. Once per mount, then again on
  // each `{t:'memory'}` bump (a mutation just moved the mtime, so the dot would otherwise lag to the next remount).
  const [meta, setMeta] = useState<Record<string, { mtimeMs: number; size: number }> | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  // SPEC-MEMORY — active entries under dispute, project-wide. Purely additive: a fetch failure (older
  // server, no entries yet) renders nothing rather than a broken bar.
  const [disputed, setDisputed] = useState(0);
  useEffect(() => {
    let stale = false;
    void tower.memoryMeta(projectId)
      .then((m) => { if (!stale) setMeta(m); })
      .catch(() => { if (!stale) void tower.memory(projectId).then((f) => { if (!stale) setFiles(f); }).catch(() => {}); });
    void tower.memoryEntries(projectId, { verification: 'disputed', lifecycle: 'active' })
      .then((list) => { if (!stale) setDisputed(list.length); })
      .catch(() => {});
    return () => { stale = true; };
  }, [projectId, memoryVersion]);
  const names = ['decisions.md', 'gotchas.md', 'glossary.md'];
  const now = Date.now();
  return (
    <div className="beacon-bar">
      <span className="bl">Memory</span>
      {names.map((n) => {
        const m = meta?.[n];
        const fresh = meta ? (m !== undefined && isMemFresh(m.mtimeMs, now)) : !!files[n]?.trim();
        return (
          <button key={n} className={`mem ${fresh ? 'fresh' : ''}`} onClick={onOpen}>
            <span className="dot" />{n}{m && <span className="faint"> · {memAge(m.mtimeMs, now)}</span>}
          </button>
        );
      })}
      {disputed > 0 && (
        <button className="mem disputed" onClick={onOpen} title="Memory entries under dispute — open to resolve">
          <span className="dot" />{disputed} disputed
        </button>
      )}
      {/* SPEC-FLIGHTLINE-V2 §5 — landed-today counter; zero renders nothing; click opens the Board. */}
      {landedToday > 0 && (
        <button className="landed-row" onClick={onBoard} title="Loops landed today — open the Board">
          landed today: {landedToday} <span aria-hidden="true">▸</span>
        </button>
      )}
    </div>
  );
}

// SPEC-FLIGHTLINE-V2 §1 — the ephemeral mail-wire pulse overlay. Each mail event (a fresh signal.seq)
// measures the two strips ONCE, computes a curved wire between their centers, and enqueues a self-removing
// (3s) pulse. Travel is SMIL animateMotion — zero JS per frame (no rAF, no per-frame React state). Each
// pulse is its OWN <svg> so its SMIL time container starts FRESH — a shared svg would freeze a pulse that
// overlaps a live one at the destination. The whole svg fades (wire + dot together) via .wire-svg wirefade.
function WireOverlay({ containerRef, signal }: { containerRef: { current: HTMLDivElement | null }; signal: { from: string; to: string; seq: number } | null }) {
  const [pulses, setPulses] = useState<{ key: number; d: string }[]>([]);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // SPEC-FLIGHTLINE-V2 §1 — seenSeq baselines AT MOUNT to the current signal's seq: mailPulse persists in
  // App state, so a Flightline remount (cockpit round-trip / view switch) replaying the last pulse must be a
  // no-op (its seq already equals the baseline). Only a genuinely NEW mail (bumped seq) animates.
  const seenSeq = useRef(signal?.seq ?? 0);
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []); // clear LIVE timers on unmount

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    if (!signal || signal.from === signal.to || signal.seq === seenSeq.current) return; // not a new mail
    seenSeq.current = signal.seq;
    // LOAD-BEARING (do NOT drop as "redundant"): SMIL animateMotion ignores the global CSS animation squash
    // in the reduced-motion block, so THIS JS skip is the only thing honoring §1's "skip entirely" rule.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const fromEl = root.querySelector(`[data-term-id="${CSS.escape(signal.from)}"]`);
    const toEl = root.querySelector(`[data-term-id="${CSS.escape(signal.to)}"]`);
    if (!fromEl || !toEl) return; // one strip absent (cockpit / other view / killed) → render nothing
    const rootRect = root.getBoundingClientRect();
    // scroll-corrected: .flightline is overflow:auto and its abs children scroll with content.
    const rel = (r: DOMRect) => ({
      left: r.left - rootRect.left + root.scrollLeft,
      top: r.top - rootRect.top + root.scrollTop,
      width: r.width,
      height: r.height,
    });
    const d = wirePath(rel(fromEl.getBoundingClientRect()), rel(toEl.getBoundingClientRect()));
    // seq-key dedupe keeps StrictMode's double-invoke a no-op; the queue is capped at 3.
    setPulses((ps) => (ps.some((p) => p.key === signal.seq) ? ps : [...ps, { key: signal.seq, d }].slice(-3)));
    const t = setTimeout(() => {
      setPulses((ps) => ps.filter((p) => p.key !== signal.seq));
      timers.current.delete(t); // self-prune the fired handle so the Set never grows unbounded
    }, 3000);
    timers.current.add(t);
  }, [signal, containerRef]);

  if (pulses.length === 0) return null;
  return (
    <>
      {pulses.map((p) => (
        <svg key={p.key} className="wire-svg" aria-hidden="true">
          <path className="wire" d={p.d} />
          <circle className="pulse-dot" r="3.5">
            <animateMotion dur="1.6s" repeatCount="1" fill="freeze" path={p.d} />
          </circle>
        </svg>
      ))}
    </>
  );
}

// ============================ TOWER DOCK ============================
function TowerDock({
  attention, gatedLoops, missionHolds, feed, obs, globalSec, onOpenTerminal, onOpenLoop, onOpenMission, onError, onFeed,
}: {
  attention: AttentionItem[]; gatedLoops: Loop[]; missionHolds: Mission[]; feed: FeedItem[]; obs: Observability | null; globalSec: SecurityStatus | null;
  onOpenTerminal: (id: string) => void; onOpenLoop: (id: string) => void; onOpenMission: (id: string) => void; onError: (m: string) => void; onFeed: (k: string, t: string) => void;
}) {
  const total = attention.length + gatedLoops.length + missionHolds.length;
  // SPEC-FLIGHTLINE-V2 §3 — a 60-sample ring buffer of obs.testActive, fed on each obs refetch (obs arrives
  // as a fresh identity per 15s poll). Drawn to a canvas below with the --beacon token colour; <2 samples
  // renders no canvas at all. Zero server change, no persistence.
  const [spark, setSpark] = useState<number[]>([]);
  const sparkRef = useRef<HTMLCanvasElement | null>(null);
  const lastSampleAt = useRef(0);
  useEffect(() => {
    if (!obs) return;
    // The buffer is a TIME series (~15s poll cadence). obs also gets a fresh identity on churn
    // (terminals-changed SSE, open/kill/archive, composer-done → refreshAll), which are NOT ticks — so
    // gate to at most one sample per 10s, else a burst floods the 60-sample window.
    const t = Date.now();
    if (t - lastSampleAt.current < 10_000) return;
    lastSampleAt.current = t;
    setSpark((b) => pushSample(b, obs.testActive, 60));
  }, [obs]);
  useEffect(() => {
    const c = sparkRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const pts = sparkPoints(spark, c.width, c.height);
    if (pts.length < 2) return;
    const beacon = getComputedStyle(c).getPropertyValue('--beacon').trim();
    if (!beacon) return; // never a hardcoded hex — the token is the source of truth
    const trace = () => { ctx.beginPath(); ctx.moveTo(pts[0]![0], pts[0]![1]); for (const [x, y] of pts) ctx.lineTo(x, y); };
    // faint fill under the line (closed polygon down to the baseline)
    trace();
    ctx.lineTo(pts[pts.length - 1]![0], c.height);
    ctx.lineTo(pts[0]![0], c.height);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = beacon;
    ctx.fill();
    // the line
    ctx.globalAlpha = 1;
    trace();
    ctx.strokeStyle = beacon;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [spark]);
  return (
    <aside className="dock">
      <div className="dock-sec">
        <div className="dock-head">Clearance <span className={`n ${total ? 'amber' : ''}`}>{total}</span></div>
        {total === 0 ? (
          <div className="allclear">All quiet. No agent is waiting on you.</div>
        ) : (
          <div className="clearance">
            {missionHolds.map((m) => <MissionHoldCard key={m.id} mission={m} onOpen={() => onOpenMission(m.id)} onError={onError} onFeed={onFeed} />)}
            {gatedLoops.map((l) => <GateCard key={l.id} loop={l} onOpenLoop={() => onOpenLoop(l.id)} onError={onError} onFeed={onFeed} />)}
            {attention.map((it) => <ClearanceCard key={it.terminalId} item={it} onOpen={onOpenTerminal} onError={onError} onFeed={onFeed} />)}
          </div>
        )}
      </div>

      <div className="dock-sec">
        <div className="dock-head">Feed</div>
        <div className="feed">
          {feed.length === 0 && <div className="allclear" style={{ padding: '2px 2px 8px' }}>No activity yet.</div>}
          {feed.map((f, i) => (
            <div className="fr" key={i}><span className="t">{f.ts.slice(11, 19)}</span> <span className="a">{f.kind}</span> {f.text}</div>
          ))}
        </div>
      </div>

      <RunsSection />

      <div className="dock-sec">
        <div className="dock-head">Health</div>
        <div className="health">
          {spark.length >= 2 && <canvas ref={sparkRef} className="spark" width={340} height={34} title="test slots active" />}
          <div className="hrow"><span className="hk">Broker</span><span className={`hv ${globalSec?.brokerActive ? 'good' : 'bad'}`}>{globalSec?.brokerActive ? '● serving' : '○ down'}</span></div>
          <div className="hrow"><span className="hk">Host isolation</span><span className="hv">{globalSec?.isolationMode === 'per-agent-uid' ? 'provisioned' : 'not provisioned'}</span></div>
          {obs && <>
            <div className="hrow"><span className="hk">Test slots</span><span className="hv mono">{obs.testActive} / {obs.testCapacity} active</span></div>
            <div className="hrow"><span className="hk">Spool depth</span><span className="hv mono">{obs.spoolDepth} event{obs.spoolDepth === 1 ? '' : 's'}</span></div>
            <div className="hrow" title="Free space on the WSL2 ext4 virtual disk that holds ~/.ct — thin-provisioned against your Windows drive, so this is the vdisk's headroom, not the host's real free space."><span className="hk">Disk free (WSL fs)</span><span className={`hv mono ${obs.diskLow ? 'bad' : ''}`}>{(obs.diskFreeMb / 1024).toFixed(1)} GB</span></div>
            <div className="hrow"><span className="hk">Uptime</span><span className="hv mono">{Math.floor(obs.uptimeSec / 3600)}h {Math.floor((obs.uptimeSec % 3600) / 60)}m</span></div>
          </>}
        </div>
      </div>
    </aside>
  );
}

function RunsSection() {
  const [runs, setRuns] = useState<TestRunInfo[]>([]);
  useEffect(() => {
    const load = () => void tower.testRuns().then((r) => setRuns(r.slice(0, 6))).catch(() => {});
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, []);
  if (runs.length === 0) return null;
  const dot = (s: TestRunInfo['status']) => (s === 'passed' ? 'var(--landed)' : s === 'failed' ? 'var(--danger)' : 'var(--working)');
  return (
    <div className="dock-sec">
      <div className="dock-head">Test runs</div>
      <div className="feed">
        {runs.map((r) => (
          <div className="fr" key={r.id} style={{ alignItems: 'center' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot(r.status), flexShrink: 0 }} />
            <span className="mono">{r.id}</span>
            <span style={{ color: dot(r.status) }}>{r.status}</span>
            <span className="t mono">:{r.port}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ClearanceCard({ item, onOpen, onError, onFeed }: { item: AttentionItem; onOpen: (id: string) => void; onError: (m: string) => void; onFeed: (k: string, t: string) => void }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true);
    try { await fn(); setReply(''); onFeed('clear', `${item.title} — ${label}`); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={`card ${item.kind}`}>
      <div className="card-top"><span className={`kind ${item.kind}`}>{item.kind}</span>
        <button className="who" onClick={() => onOpen(item.terminalId)}>{item.title}</button><span className="ago">{timeAgo(item.since)}</span></div>
      {item.kind === 'permission' && item.requested && <div className="card-body"><div className="req">{item.requested}</div></div>}
      {/* SPEC-CLEARANCE §B — message is the adapter-extracted question. When absent, say so
          honestly: the old preview.slice(-1)[0] fallback dumped the pane's last chrome row
          (status footer / task list) as if it were the question. */}
      {item.kind === 'question' && <div className="card-body">{item.message ?? 'Waiting on your input — open the pane.'}</div>}
      {item.preview.length > 0 && <div style={{ padding: '0 12px' }}><div className="tail">{item.preview.join('\n')}</div></div>}
      {item.kind === 'permission' ? (
        <div className="card-actions">
          <button className="btn ok" disabled={busy} onClick={() => act(() => tower.approve(item.terminalId), 'approved')}>Approve</button>
          <button className="btn warn ghost" disabled={busy} onClick={() => act(() => tower.deny(item.terminalId), 'denied')}>Deny</button>
          <button className="btn ghost" onClick={() => onOpen(item.terminalId)}>Open</button>
        </div>
      ) : (
        <div className="card-actions">
          <input className="reply" placeholder="reply inline…" value={reply} disabled={busy}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && reply.trim()) act(() => tower.reply(item.terminalId, reply), 'answered'); }} />
          <button className="btn ok" disabled={busy || !reply.trim()} onClick={() => act(() => tower.reply(item.terminalId, reply), 'answered')}>Send</button>
        </div>
      )}
    </div>
  );
}

function GateCard({ loop, onOpenLoop, onError, onFeed }: { loop: Loop; onOpenLoop: () => void; onError: (m: string) => void; onFeed: (k: string, t: string) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const last = loop.iterations[loop.iterations.length - 1];
  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true);
    try { await fn(); onFeed('gate', `${loop.name} — ${label}`); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card gate">
      <div className="card-top"><span className="kind gate">Gate</span>
        <button className="who" onClick={onOpenLoop}>{loop.name}</button><span className="ago">iter {loop.iteration}</span></div>
      <div className="card-body">{last?.verdict === 'pass' ? 'Check passed. Land it, or keep iterating.' : 'Check failed — steer the loop, continue, or stop.'}</div>
      {/* SPEC-MEMORY — the builder's last progress note sits ABOVE the check tail: what it said it was doing,
          then what the check said. Prose (one clamped line, full text in the title) vs the mono tail well. */}
      {last?.progress && (
        <div className="progress" title={last.progress}>
          <span className="lbl">progress</span>
          <span className="txt">{last.progress}</span>
        </div>
      )}
      {last?.checkTail && <div style={{ padding: '0 12px' }}><div className="tail">{last.checkTail}</div></div>}
      <div className="card-actions">
        <input className="reply" placeholder="steering note (optional)…" value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="card-actions">
        <button className="btn ok" disabled={busy} onClick={() => act(() => tower.loopContinue(loop.id, note || undefined), 'continued')}>Continue ↻</button>
        <button className="btn ghost" disabled={busy} onClick={() => act(() => tower.loopLand(loop.id, 'merge'), 'landed')}>Land</button>
        <button className="btn warn ghost" disabled={busy} onClick={() => act(() => tower.loopStop(loop.id), 'stopped')}>Stop</button>
      </div>
    </div>
  );
}

/** A mission waiting on the operator: a completed phase gate, or a sortie needing attention. */
function MissionHoldCard({ mission, onOpen, onError, onFeed }: { mission: Mission; onOpen: () => void; onError: (m: string) => void; onFeed: (k: string, t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const gate = mission.status === 'phase-gate';
  const phase = mission.phases[mission.activePhase];
  const troubled = mission.phases.flatMap((p) => p.sorties).filter((s) => s.status === 'attention' || s.status === 'gated');
  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true);
    try { await fn(); onFeed('mission', `${mission.name} — ${label}`); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={`card ${gate ? 'gate' : 'hold'}`}>
      <div className="card-top"><span className={`kind ${gate ? 'gate' : 'q'}`}>{gate ? 'Phase gate' : 'Mission'}</span>
        <button className="who" onClick={onOpen}>◇ {mission.name}</button>
        <span className="ago">phase {mission.activePhase + 1}/{mission.phases.length}</span></div>
      <div className="card-body">
        {gate
          ? <>Phase {mission.activePhase + 1}{phase ? ` — ${phase.name}` : ''} complete. Review the sorties, then land &amp; advance.</>
          : troubled.length > 0
            ? <>Needs you: {troubled.map((s) => s.name).join(', ')}{troubled[0]?.note ? ` — ${troubled[0].note}` : ''}</>
            : (mission.stopReason ?? 'Needs attention.')}
      </div>
      <div className="card-actions">
        {gate && <button className="btn ok" disabled={busy} onClick={() => act(() => tower.advanceMission(mission.id), 'landed & advanced')}>Land &amp; advance</button>}
        {!gate && <button className="btn ok" disabled={busy} onClick={() => act(() => tower.startMission(mission.id), 'resumed')}>Resume</button>}
        <button className="btn ghost" disabled={busy} onClick={onOpen}>open</button>
      </div>
    </div>
  );
}

// ============================ COCKPIT ============================
function Cockpit({ term, loop, onBack, onKill, onRestart, onError, onOpenLoop, memoryVersion }: {
  term: TerminalWithLiveness; loop?: Loop; onBack: () => void; onKill: () => void; onRestart: () => void; onError: (m: string) => void; onOpenLoop: (id: string) => void;
  memoryVersion: number;
}) {
  const hasWorktree = !!term.worktreePath;
  const [tab, setTab] = useState<'terminal' | 'review' | 'files' | 'memory' | 'mail'>('terminal');
  return (
    <div className="cockpit">
      <div className="cp-head">
        <button className="cp-back" onClick={onBack}>◀ Flightline</button>
        <span className={`av ${avClass(term.provider)}`} style={{ width: 20, height: 20, borderRadius: 6 }}>{avText(term.provider)}</span>
        <span className="who">{loop ? loop.name : term.title}</span>
        <span className={`state-word ${isBlocked(term.state) ? 'hold' : term.state === 'working' ? 'working' : term.alive === false ? 'dead' : 'idle'}`}>{STATE_LABEL[term.state]}</span>
        <HonestyChips term={term} />
        {term.autoAccept && <span className="chip auto" title="Autonomous — runs any command without asking (permission prompts are skipped)">auto</span>}
        <div style={{ flex: 1 }} />
        <div className="cp-tabs">
          <button className={`cp-tab ${tab === 'terminal' ? 'active' : ''}`} onClick={() => setTab('terminal')}>terminal</button>
          {hasWorktree && <button className={`cp-tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>review</button>}
          <button className={`cp-tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>files</button>
          <button className={`cp-tab ${tab === 'memory' ? 'active' : ''}`} onClick={() => setTab('memory')}>memory</button>
          {term.provider !== 'shell' && <button className={`cp-tab ${tab === 'mail' ? 'active' : ''}`} onClick={() => setTab('mail')}>mail</button>}
        </div>
        {loop && <button className="btn ghost" onClick={() => onOpenLoop(loop.id)}>loop</button>}
        {term.state !== 'killed' && (
          <button className="btn ghost" title={term.provider === 'claude-code' && term.purpose !== 'login' ? "Relaunch this terminal's CLI in place — worktree, account, and loop survive; the conversation resumes if one exists and the in-flight turn is re-driven" : "Relaunch this terminal's CLI in place — worktree, account, and loop survive; an in-flight turn is discarded"} onClick={onRestart}>restart</button>
        )}
        <button className="btn warn ghost" onClick={onKill}>kill</button>
      </div>
      <div className="cp-meta mono">
        {term.profileId && <span>acct set</span>}
        {term.identityId && <span>gh identity</span>}
        {term.worktreePath && <span>wt: {term.worktreePath.split('/').slice(-1)[0]}</span>}
        {term.branch && <span>branch: {term.branch} ← {term.baseBranch}</span>}
        {loop && <span>loop: iter {loop.iteration}/{loop.maxIterations} · {loop.status}</span>}
      </div>
      <div className="cp-body">
        {tab === 'review' && hasWorktree ? <ReviewPanel terminalId={term.id} />
          : tab === 'files' ? (
            // SPEC-FILES §5b — worktree scope when this agent has one ("what it's building"),
            // else the project repo. The chip states which root is on screen.
            <div className="files-tab">
              <div className="files-tab-head">
                <span className={`chip ${hasWorktree ? 'wt' : ''}`}>
                  {hasWorktree ? `wt: ${term.branch ?? term.worktreePath!.split('/').slice(-1)[0]}` : 'repo'}
                </span>
              </div>
              <FilesPanel scope={{ projectId: term.projectId, terminalId: hasWorktree ? term.id : undefined }} onError={onError} />
            </div>
          )
          : tab === 'memory' ? <MemoryPanel projectId={term.projectId} onError={onError} reloadSignal={memoryVersion} />
          : tab === 'mail' ? <MailThread terminalId={term.id} onError={onError} />
          : term.alive ? <TerminalView key={term.id} terminalId={term.id} />
          : <div className="empty big">This terminal's session has stopped.{hasWorktree && <><br />Its worktree is still here — switch to <b>review</b> to land or remove it.</>}</div>}
      </div>
    </div>
  );
}

function MailThread({ terminalId, onError }: { terminalId: string; onError: (m: string) => void }) {
  const [msgs, setMsgs] = useState<{ id: string; fromLabel: string; from: string; body: string; ts: string }[]>([]);
  const [text, setText] = useState('');
  const load = useCallback(() => { void tower.mailInbox(terminalId).then(setMsgs).catch((e) => onError((e as Error).message)); }, [terminalId, onError]);
  useEffect(() => { load(); }, [load]);
  const send = async () => {
    if (!text.trim()) return;
    try { await tower.sendMail(terminalId, text.trim()); setText(''); load(); }
    catch (e) { onError((e as Error).message); }
  };
  return (
    <div className="thread">
      {msgs.length === 0 && <div className="faint">No messages. Send this agent an instruction — it's delivered when the agent next goes idle.</div>}
      {msgs.map((m) => (
        <div key={m.id} className={`msg ${m.from === 'human' ? 'human' : ''}`}>
          <div className="mh"><b>{m.fromLabel}</b> · {timeAgo(m.ts)}</div>{m.body}
        </div>
      ))}
      <div className="thread-compose">
        <input className="reply" placeholder="message this agent…" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} />
        <button className="btn ok" onClick={send} disabled={!text.trim()}>Send</button>
      </div>
    </div>
  );
}

// ============================ LOOP COMPOSER ============================
function LoopComposer({ projectId, projectName, adapters, profiles, brainProfileIds, identities, projectDefaultIdentity, projectAutoAccept, seed, onClose, onDone, onError }: {
  projectId: string; projectName: string; adapters: AdapterInfo[]; profiles: AgentProfile[];
  /** SPEC-TESTING §1.4 — every Brain account's profileId, excluded from the account dropdown (UX only). */
  brainProfileIds?: string[];
  identities: GitHubIdentity[];
  /** The project's default GitHub identity (resolved from project.defaultIdentityId) — shown as what
   *  the "default" identity option resolves to when no per-run identity is picked. */
  projectDefaultIdentity?: GitHubIdentity;
  /** The project's Autonomous (skip-permissions) default — shown as what the Inherit choice resolves to. */
  projectAutoAccept?: boolean;
  /** SPEC-BACKLOG §2 — a Board "Compose loop" seed: prefills name/task; backlogTaskId rides the
   *  create request (route-side link stamp). The modal mounts fresh per open, so initializers work. */
  seed?: { name: string; task: string; backlogTaskId: string };
  onClose: () => void; onDone: () => void; onError: (m: string) => void;
}) {
  const [mode, setMode] = useState<'loop' | 'terminal'>('loop');
  const agentAdapters = adapters.filter((a) => a.id !== 'shell');
  // '' = "Inherit (use role default)" (SPEC-ROUTING §5): the create request OMITS provider so
  // routing's role tier actually resolves — a concrete provider is the top routing rank and
  // would gate out every role-tier value. Loop mode only; terminal mode needs a concrete pick.
  const [provider, setProvider] = useState<ProviderId | ''>(agentAdapters[0]?.id ?? 'claude-code');
  const [role, setRole] = useState<PipelineRole | ''>(''); // optional pipeline role (SPEC-ROUTING §3)
  const [model, setModel] = useState(''); // optional per-run model override (§2.2); '' = provider default
  const [effort, setEffort] = useState(''); // SPEC-EFFORT §4 — optional reasoning effort; '' = the CLI's own default
  const [task, setTask] = useState(seed?.task ?? '');
  const [name, setName] = useState(seed?.name ?? ''); // loop name
  const [label, setLabel] = useState(''); // terminal label
  const [profileId, setProfileId] = useState('');
  const [identityId, setIdentityId] = useState('');
  const [worktree, setWorktree] = useState(true);
  const [autoPerm, setAutoPerm] = useState<'inherit' | 'on' | 'off'>('inherit');
  const [checkCommand, setCheckCommand] = useState('');
  const [assertionsText, setAssertionsText] = useState('');
  const [gatePolicy, setGatePolicy] = useState<CreateLoopRequest['gatePolicy']>('on-pass');
  const [maxIterations, setMaxIterations] = useState(8);
  const [busy, setBusy] = useState(false);

  // SPEC-TESTING §1.7 — the project's server-resolved role routes, for the routed-account note
  // (and so an Inherit-provider loop can still list the ROUTED provider's accounts). Best-effort:
  // a failure just drops the note, never blocks composing.
  const [projRouting, setProjRouting] = useState<ProjectRoutingView | null>(null);
  useEffect(() => {
    let stale = false;
    tower.getProjectRouting(projectId).then((v) => { if (!stale) setProjRouting(v); }).catch(() => {});
    return () => { stale = true; };
  }, [projectId]);
  // Whether each provider's SHARED login is signed in — the no-account fallback this run would spawn
  // under. Best-effort: a failure leaves it null and the warning simply never shows.
  const [sharedLogin, setSharedLogin] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    let stale = false;
    tower.sharedLoginStatus().then((v) => { if (!stale) setSharedLogin(v); }).catch(() => {});
    return () => { stale = true; };
  }, []);
  const effRoute = mode === 'loop' && role ? projRouting?.effective[role] : undefined;
  // Accounts are provider-scoped: an explicit provider wins; Inherit falls back to the routed
  // role's provider. The Brain account is filtered out (§1.4 — the server refuses it anyway).
  const effProvider = provider || effRoute?.provider || '';
  const providerProfiles = profiles.filter((p) => p.provider === effProvider && !brainProfileIds?.includes(p.id));
  // The account this run would actually spawn under, mirroring the server's chain: explicit pick >
  // (loop mode) the routed role's account > the effective provider's SHARED login. undefined = unknown
  // (fetch not landed / old server) → never warn; the server's Start-time probe stays authoritative.
  const effAcctId = profileId || (mode === 'loop' ? effRoute?.profileId : undefined);
  const effSignedIn = effAcctId
    ? profiles.find((p) => p.id === effAcctId)?.signedIn
    : sharedLogin?.[effProvider || 'claude-code'];

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === 'loop') {
        if (!task.trim()) throw new Error('a loop needs a task');
        const assertions = assertionsText.split('\n').map((s) => s.trim()).filter(Boolean);
        // Inherit ('') OMITS provider so the role tier resolves server-side (SPEC-ROUTING §5);
        // `role` rides along either way — with a concrete provider it still labels the loop.
        await tower.createLoop({ projectId, name: name.trim() || task.trim().slice(0, 40), task: task.trim(),
          ...(provider ? { provider } : {}),
          ...(role ? { role } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(effort ? { effort } : {}),
          profileId: profileId || undefined, identityId: identityId || undefined,
          checkCommand: checkCommand.trim() || undefined, gatePolicy, maxIterations,
          ...(assertions.length > 0 ? { assertions } : {}),
          ...(seed?.backlogTaskId ? { backlogTaskId: seed.backlogTaskId } : {}) });
      } else {
        // Terminal mode always holds a concrete provider (switching to it resets Inherit), so the
        // guard is only about the '' type — an omitted provider means a plain shell.
        await tower.createTerminal({ projectId, worktree, taskLabel: label.trim() || undefined,
          ...(provider ? { provider } : {}),
          ...(profileId ? { profileId } : {}), ...(identityId ? { identityId } : {}),
          ...(autoPerm === 'on' ? { autoAccept: true } : autoPerm === 'off' ? { autoAccept: false } : {}) });
      }
      onDone();
    } catch (e) { onError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal title={`New run · ${projectName}`} onClose={onClose}>
      {/* A SEEDED compose is a task instantiation — only the loop branch carries backlogTaskId,
          so terminal mode would silently orphan the intake item. Lock the mode instead. */}
      {seed ? (
        <div className="seg-choice"><button className="sel" disabled>Loop — instantiates the board task</button></div>
      ) : (
        <div className="seg-choice">
          <button className={mode === 'loop' ? 'sel' : ''} onClick={() => setMode('loop')}>Loop (iterate-until-done)</button>
          <button className={mode === 'terminal' ? 'sel' : ''} onClick={() => {
            setMode('terminal');
            // A plain terminal isn't routed — it needs a concrete provider, so Inherit resets.
            if (!provider) setProvider(agentAdapters[0]?.id ?? 'claude-code');
          }}>Just a terminal</button>
        </div>
      )}

      {mode === 'loop' ? (
        <div className="field"><label>Task</label>
          <textarea placeholder="What should the loop drive the agent to do?" value={task} onChange={(e) => setTask(e.target.value)} />
          <span className="hint">Injected each iteration, with the prior check failure / your gate note appended.</span></div>
      ) : (
        <div className="field"><label>Label (optional)</label>
          <input placeholder="what this terminal is for" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
      )}

      <div className="field-row">
        {mode === 'loop' && (
          <div className="field"><label>Role (optional)</label>
            {/* SPEC-ROUTING §3 — the pipeline role this loop plays; with Inherit below, the
                project/workflow/global route for this role picks the provider + model. */}
            <select value={role} onChange={(e) => {
              setRole(e.target.value as PipelineRole | '');
              // With Inherit, the routed provider follows the role, so a kept account OR model OR effort
              // could silently cross providers (a model or a claude-only effort like 'max' riding onto a
              // codex run) and only fail at Start. Clear all three (SPEC-EFFORT §4 clear-on-role-inherit-switch).
              if (!provider) { setProfileId(''); setModel(''); setEffort(''); }
            }}>
              <option value="">— none —</option>
              {PIPELINE_ROLES.map((r) => <option key={r.id} value={r.id} title={r.hint}>{r.label}</option>)}
            </select></div>
        )}
        <div className="field"><label>Provider</label>
          {/* Switching provider clears the model AND account — both are provider-specific, so a
              carried-over pair (e.g. claude --model gpt-5.5) would only fail at spawn. */}
          <select value={provider} onChange={(e) => { setProvider(e.target.value as ProviderId | ''); setProfileId(''); setModel(''); setEffort(''); setAutoPerm('inherit'); }}>
            {mode === 'loop' && <option value="">Inherit (use role default)</option>}
            {(mode === 'loop' ? agentAdapters : adapters).map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
          </select>
          {mode === 'loop' && !provider && (
            <span className="hint">{role
              ? 'Resolved at start from the project’s route for this role (workflow / global fallback).'
              : 'Pick a role too — with no role, inherit falls through to the built-in default.'}</span>
          )}</div>
        {mode === 'loop' && (
          <div className="field"><label>Model (optional)</label>
            {/* SPEC-MODELS §3 — the unified picker: roster of the resolved provider (empty = provider
                default), Custom… for anything newer, and a Refresh when the catalog is discoverable. */}
            <ModelSelect provider={(effProvider || undefined) as ProviderId | undefined} value={model} onChange={setModel} profileId={profileId || undefined} allowEmpty /></div>
        )}
        {mode === 'loop' && (
          <div className="field"><label>Effort (optional)</label>
            {/* SPEC-EFFORT §4 — beside the model; enabled for codex/claude even model-less, '— not set —'
                default, cleared on a provider/role-inherit switch (kept on a model switch). */}
            <EffortSelect provider={(effProvider || undefined) as ProviderId | undefined} model={model.trim() || undefined} profileId={profileId || undefined} value={effort} onChange={setEffort} ariaLabel="loop effort" /></div>
        )}
        <div className="field"><label>Account</label>
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">default</option>
            {providerProfiles.map((p) => <option key={p.id} value={p.id}>{p.label}{p.signedIn === undefined ? '' : p.signedIn ? ' — signed in' : ' — not signed in'}</option>)}
          </select>
          {/* SPEC-TESTING §1.7 — what "default" resolves to for the routed role (read-only note;
              the server's match-gated chain is authoritative at start). */}
          {mode === 'loop' && !profileId && effRoute && (
            <span className="hint">
              routes to {effRoute.profileId
                ? `account ${effRoute.profileLabel ?? effRoute.profileId} — from ${effRoute.source} routing`
                : 'the shared login'}
            </span>
          )}
          {effSignedIn === false && (
            <span className="hint warn">
              {effAcctId ? (profileId ? 'this account is not signed in' : 'the routed account is not signed in') : 'the shared login is not signed in'} — this run will likely fail to start; sign in via Settings → Connections, or pick a signed-in account
            </span>
          )}</div>
        <div className="field"><label>GitHub identity</label>
          <select value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
            <option value="">default</option>
            {identities.map((i) => <option key={i.id} value={i.id}>{i.label}{i.hasCredential ? '' : ' — no push token'}</option>)}
          </select>
          {/* What "default" resolves to: the project's default identity (if set) or the ambient login. */}
          {!identityId && (
            <span className="hint">
              default = {projectDefaultIdentity
                ? `${projectDefaultIdentity.label}${projectDefaultIdentity.hasCredential ? '' : ' — no push token'}`
                : 'none (ambient login)'}
            </span>
          )}</div>
      </div>

      {mode === 'loop' ? (
        <>
          <div className="field"><label>Name (optional)</label>
            <input placeholder="short name for this loop" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>Check command (optional)</label>
            {/* SPEC-STORYLOOP §5.1 — one-click e2e-kit preset beside the free-text check input. */}
            <div className="msn-check-row">
              <input className="mono" placeholder="e.g. pnpm test — exit 0 = pass" value={checkCommand} onChange={(e) => setCheckCommand(e.target.value)} />
              <button type="button" className="btn sm ghost" title={`Set the check to the e2e test kit (${E2E_SUITE_CMD})`}
                onClick={() => setCheckCommand(E2E_SUITE_CMD)}>e2e suite</button>
            </div>
            <span className="hint">Runs in the worktree after each iteration. Empty = the agent self-reports done.</span></div>
          <div className="field"><label>Acceptance criteria (optional, one per line)</label>
            <textarea placeholder={'e.g.\nGET /api/settings returns the effective cap\nthe new field is zod-mirrored in store.ts'} value={assertionsText} onChange={(e) => setAssertionsText(e.target.value)} />
            <span className="hint">The assistant brain grades each iteration against these, read-only, in the worktree — an unverifiable iteration gates to you instead of passing.</span></div>
          <div className="field-row">
            <div className="field"><label>Gate</label>
              <div className="seg-choice">
                <button className={gatePolicy === 'every' ? 'sel' : ''} onClick={() => setGatePolicy('every')}>Every iter</button>
                <button className={gatePolicy === 'on-pass' ? 'sel' : ''} onClick={() => setGatePolicy('on-pass')}>On pass</button>
                <button className={gatePolicy === 'never' ? 'sel' : ''} onClick={() => setGatePolicy('never')}>Never</button>
              </div>
              <span className="hint">When to pause for your review.</span></div>
            <div className="field" style={{ maxWidth: 130 }}><label>Max iterations</label>
              <input type="number" min={1} max={50} value={maxIterations}
                onChange={(e) => setMaxIterations(Math.max(1, Math.min(50, Math.floor(Number(e.target.value)) || 1)))} /></div>
          </div>
        </>
      ) : (
        <>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} style={{ width: 'auto' }} />
            <span>Fresh git worktree + branch</span>
          </label>
          {adapters.find((a) => a.id === provider)?.supportsAutoAccept ? (
            <div className="field"><label>Permissions</label>
              <div className="seg-choice">
                <button className={autoPerm === 'inherit' ? 'sel' : ''} onClick={() => setAutoPerm('inherit')}>Project default ({projectAutoAccept ? 'autonomous' : 'ask'})</button>
                <button className={autoPerm === 'on' ? 'sel' : ''} onClick={() => setAutoPerm('on')}>Autonomous</button>
                <button className={autoPerm === 'off' ? 'sel' : ''} onClick={() => setAutoPerm('off')}>Ask every time</button>
              </div>
              <span className="hint">Autonomous launches claude with --dangerously-skip-permissions: it runs any command without asking, and permission prompts never reach the Clearance dock.</span>
            </div>
          ) : projectAutoAccept ? (
            <span className="hint">This project defaults to Autonomous, but this provider doesn&rsquo;t support skip-permissions — the terminal will ask as usual.</span>
          ) : null}
        </>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn ok"
          // Block the silent fall-through: Inherit ('' provider) with no role sends neither, so the
          // server would use the built-in default instead of any routed resolution (SPEC-ROUTING §5).
          disabled={busy || (mode === 'loop' && (!task.trim() || (!provider && !role)))}
          onClick={submit}
        >
          {busy ? 'Starting…' : mode === 'loop' ? 'Arm loop' : 'Open terminal'}
        </button>
      </div>
    </Modal>
  );
}

// ============================ LOOP DETAIL ============================
function LoopDetail({ loop, onClose, onOpenTerminal, onError, onChanged }: {
  loop: Loop | null; onClose: () => void; onOpenTerminal: (id: string) => void; onError: (m: string) => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!loop) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); void onChanged(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Loop · ${loop.name}`} onClose={onClose} wide>
      <div className="field-row">
        <div className="field"><label>Status</label><div>{loop.status}{loop.stopReason ? ` — ${loop.stopReason}` : ''}</div></div>
        <div className="field"><label>Iteration</label><div className="mono">{loop.iteration} / {loop.maxIterations}</div></div>
        <div className="field"><label>Gate</label><div>{loop.gatePolicy}</div></div>
      </div>
      {loop.checkCommand && <div className="field"><label>Check</label><div className="mono">{loop.checkCommand}</div></div>}
      <div className="field"><label>Task</label><div className="faint" style={{ whiteSpace: 'pre-wrap' }}>{loop.task}</div></div>

      <div className="field loop-detail"><label>Iterations</label>
        <div className="iter-tape">
          {loop.iterations.slice().reverse().map((it) => (
            <div className="iter-row" key={it.n}>
              <span className="n">iter {it.n}</span>
              <span className={`v ${it.verdict}`}>{it.verdict}</span>
              {(it.added || it.removed) ? <span className="mono diffstat"><span className="add">+{it.added ?? 0}</span> <span className="del">−{it.removed ?? 0}</span></span> : null}
              {it.note && <span className="note">“{it.note}”</span>}
              {/* SPEC-MEMORY — per-iteration builder progress note, in full (the tape is the history view), on
                  its own line under the verdict so it never fights the n / verdict / diffstat / note row. */}
              {it.progress && (
                <div className="progress full">
                  <span className="lbl">progress</span>
                  <span className="txt">{it.progress}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="modal-actions">
        {loop.terminalId && <button className="btn ghost" onClick={() => { onOpenTerminal(loop.terminalId!); onClose(); }}>Open terminal</button>}
        <div style={{ flex: 1 }} />
        {loop.status === 'running' && <button className="btn ghost" disabled={busy} onClick={() => act(() => tower.loopPause(loop.id))}>Pause</button>}
        {loop.status === 'paused' && <><button className="btn ghost" disabled={busy} onClick={() => act(() => tower.loopStep(loop.id))}>Step once</button>
          <button className="btn ok" disabled={busy} onClick={() => act(() => tower.loopResume(loop.id))}>Resume</button></>}
        {loop.status === 'gated' && <><button className="btn ok" disabled={busy} onClick={() => act(() => tower.loopContinue(loop.id))}>Continue</button>
          <button className="btn ghost" disabled={busy} onClick={() => act(() => tower.loopLand(loop.id, 'merge'))}>Land</button></>}
        {(loop.status === 'running' || loop.status === 'paused' || loop.status === 'gated') &&
          <button className="btn warn ghost" disabled={busy} onClick={() => act(() => tower.loopStop(loop.id))}>Stop</button>}
      </div>
    </Modal>
  );
}

// ============================ COMMAND PALETTE ============================
function CommandPalette({ projects, terminals, onClose, onOpenTerminal, onNewRun, onGoAccounts, onAsk, onError }: {
  projects: Project[]; terminals: TerminalWithLiveness[]; onClose: () => void;
  onOpenTerminal: (id: string) => void; onNewRun: (pid: string) => void; onGoAccounts: () => void; onAsk: () => void; onError: (m: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ terminalId: string; line: string }[]>([]);
  useEffect(() => {
    if (!q.startsWith('/') || q.length < 2) { setHits([]); return; }
    const h = setTimeout(() => { void tower.searchLogs(q.slice(1)).then(setHits).catch(() => {}); }, 200);
    return () => clearTimeout(h);
  }, [q]);
  const live = terminals.filter((t) => t.state !== 'killed');
  const term = q.toLowerCase().replace(/^\//, '');
  const matchTerms = live.filter((t) => t.title.toLowerCase().includes(term));
  const firstProject = projects[0];
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input autoFocus placeholder="Run a task, jump to an agent, or /search all logs…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="pl-list">
          {q.startsWith('/') ? (
            hits.length === 0 ? <div className="pl-group">No log matches{q.length < 2 ? ' — type a query' : ''}</div>
              : hits.map((h, i) => (
                <button className="pl-item" key={i} onClick={() => { onOpenTerminal(h.terminalId); onClose(); }}>
                  <span className="verb">{h.terminalId}</span><span className="sub mono">{h.line}</span>
                </button>
              ))
          ) : (
            <>
              <div className="pl-group">Orchestrate</div>
              {firstProject && <button className="pl-item" onClick={() => { onNewRun(firstProject.id); onClose(); }}>
                <span className="verb">run:</span> New run in {firstProject.name}<span className="k">↵</span></button>}
              <button className="pl-item" onClick={() => { onAsk(); onClose(); }}>
                <span className="verb">ask:</span> Ask the tower — onboard assistant</button>
              <button className="pl-item" onClick={() => { onGoAccounts(); onClose(); }}><span className="verb">go:</span> Settings — connections, routing, projects, assistant, system</button>
              {matchTerms.length > 0 && <div className="pl-group">Jump to agent</div>}
              {matchTerms.slice(0, 6).map((t) => (
                <button className="pl-item" key={t.id} onClick={() => { onOpenTerminal(t.id); onClose(); }}>
                  <span className="verb">go:</span> {t.title}<span className="sub">{STATE_LABEL[t.state]}</span></button>
              ))}
              <div className="pl-group">Search</div>
              <button className="pl-item" onClick={() => setQ('/')}><span className="verb">/</span> Search every agent’s scrollback</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================ SHARED BITS ============================
function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={wide ? { width: 760 } : undefined}>
        <div className="modal-head">{title}<button className="x" onClick={onClose}>✕</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function IsolationPopover({ sec, projectName, rect, onClose, onSet }: {
  sec?: ProjectSecurity; projectName: string; rect: DOMRect; onClose: () => void; onSet: (mode: 'per-agent-uid' | 'single-uid') => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.pop') && !(e.target as HTMLElement).closest('.shield-chip')) onClose(); };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [onClose]);
  if (!sec) return null;
  const enforced = sec.enforced;
  const intentOn = sec.intent === 'per-agent-uid';
  const pending = intentOn && sec.available && !enforced;
  const body = enforced
    ? 'Per-agent Unix users + an egress allowlist are active. Each agent gets its own UID; a compromised agent can’t read another’s files, and outbound traffic is restricted. Push secrets stay in the broker regardless.'
    : pending
      ? 'Per-agent isolation is REQUESTED for this project but not yet enforced — agents still share your Unix user. Spawning each agent under its own UID ships as a separate, host-validated change. Intent is recorded so it takes effect once enforcement lands.'
      : sec.available
        ? 'Agents in this project share your Unix user. Credentials are still broker-served, but a compromised agent could read another agent’s working files. Fine for trusted repos; request per-agent isolation for anything you don’t fully trust.'
        : 'Per-agent UIDs + egress control need a one-time privileged host step. Run the command below once, then this toggle unlocks. The Tower never runs sudo for you.';
  const top = Math.min(rect.bottom + 8, window.innerHeight - 240);
  const left = Math.min(rect.left, window.innerWidth - 352);
  return (
    <div className="pop" style={{ top, left }}>
      <div className="pop-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z" /></svg>
        Isolation · {projectName}
      </div>
      <div className="pop-body">{body}</div>
      <div className="toggle-row">
        <div className={`toggle ${intentOn ? 'on' : ''} ${sec.available ? '' : 'disabled'}`}
          onClick={() => { if (sec.available) onSet(intentOn ? 'single-uid' : 'per-agent-uid'); }}><div className="knob" /></div>
        <div>
          <div className="tl">Per-agent isolation</div>
          <div className="ts">{enforced ? 'On · isolated UIDs + egress' : pending ? 'Requested · enforcement pending' : sec.available ? 'Off · agents share your UID' : 'Unavailable — host setup required'}</div>
        </div>
      </div>
      {!sec.available && sec.setupCommand && (
        <div className="cmd">{sec.setupCommand}
          <button onClick={() => { navigator.clipboard?.writeText(sec.setupCommand!); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
    </div>
  );
}

function AddProject({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const submit = async () => {
    try {
      await tower.createProject({
        name: name.trim(),
        repoPath: repoPath.trim(),
        ...(repoUrl.trim() ? { repoUrl: repoUrl.trim() } : {}),
      });
      onDone();
    } catch (e) { onError((e as Error).message); }
  };
  return (
    <div className="add-project">
      <input placeholder="project name" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="/abs/path/to/repo" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
      <input placeholder="https://github.com/owner/repo.git (optional)" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
      <button className="btn ok" onClick={submit} disabled={!name.trim() || !repoPath.trim()}>Add project</button>
    </div>
  );
}
