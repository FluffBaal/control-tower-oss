// Control Tower — admin Settings surface (a dedicated rail view, distinct from the run/loop
// composer). Six tabs: Connections (provider accounts + GitHub identities + custom providers,
// with the guided Connect wizard as an inline step launched from the CTAs), Routing (the global
// role defaults + Workflows), Projects (a project picker over per-project routing, testing,
// GitHub, isolation and autonomy), Assistant (the onboard copilot config), Runway (usage-aware
// Claude subscription rotation: the pool, threshold, and live per-subscription usage/reset view),
// and System (terminal caps, the Test kit cap, the host isolation readout, and the health/audit block).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentProfile, AssistantAccount, GitHubIdentity, GlobalSettingsView, PipelineRole, Project, ProjectSecurity,
  ProjectTestingConfig, ProviderId, RoleRouting, WorkflowProfile, SkillBundle, Skill, EffectiveSkillEntry,
} from '../shared/types.js';
import { PIPELINE_ROLES } from '../shared/roles.js';
import { tower, retypeGateMessage, type AdapterInfo, type ProjectRoutingView, type ProjectSkillsView, type SystemIsolation, type CliVersion, type CliUpdateResult } from './api.js';
import { AccountsPanel, HealthAndAudit } from './AccountsPanel.js';
import { ProvidersPanel, RoleRoutingGrid, RoutingSection, type ProvidersApi, type ProviderDefView } from './ProvidersPanel.js';
import { SkillsPanel } from './SkillsPanel.js';
import { RunwayPanel } from './RunwayPanel.js';
import { SkillBundlesEditor } from './SkillBundles.js';
import { ModelSelect } from './ModelSelect.js';
import { EffortSelect } from './EffortSelect.js';
import { QuickConnect } from './QuickConnect.js';
import { RepoBootstrapPanel } from './RepoBootstrap.js';
import { AgentTile } from './quickconnect/AgentTile.js';
import type { QuickConnectApi } from './quickconnect/contract.js';
import {
  listAssistantAccounts,
  createAssistantAccount,
  deleteAssistantAccount,
  updateAssistantAccount,
  listCodexProfiles,
} from './assistant-api.js';

export type SettingsSection = 'connections' | 'routing' | 'projects' | 'assistant' | 'runway' | 'system';
const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'connections', label: 'Connections' },
  { id: 'routing', label: 'Routing' },
  { id: 'projects', label: 'Projects' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'runway', label: 'Runway' },
  { id: 'system', label: 'System' },
];

// Order-insensitive RoleRouting compare (SPEC-ROUTING §5): a delete-then-re-add reorders the map's
// keys but is not a real edit, so a key-order-sensitive JSON.stringify would flag a spurious
// "unsaved". Compare each role's assignment by value over the fixed registry order instead.
function routesEqual(a: RoleRouting, b: RoleRouting): boolean {
  return PIPELINE_ROLES.every((r) => {
    const x = a[r.id];
    const y = b[r.id];
    return (x?.provider ?? '') === (y?.provider ?? '')
      && (x?.model ?? '') === (y?.model ?? '')
      && (x?.profileId ?? '') === (y?.profileId ?? '');
  });
}

// ProvidersPanel is self-contained behind a props-injected api object; wire each method to the
// matching tower client call. Built here so the panel stays testable without the concrete client.
const providersApi: ProvidersApi = {
  listProviders: tower.listProviders,
  upsertProvider: tower.upsertProvider,
  removeProvider: tower.removeProvider,
  setProviderSecret: tower.setProviderSecret,
  clearProviderSecret: tower.clearProviderSecret,
  discoverModels: tower.discoverModels,
  loginProvider: tower.loginProvider,
  testProvider: tower.testProvider,
  getRouting: tower.getRouting,
  setRouting: tower.setRouting,
  listWorkflows: tower.listWorkflows,
  upsertWorkflow: tower.upsertWorkflow,
  deleteWorkflow: tower.deleteWorkflow,
};

// Quick Connect types against the FROZEN contract (quickconnect/contract.ts). The three
// onboarding methods (machineLoginStatus / adoptMachineLogin / runnerPresent) land in api.ts
// together with their routes — INTEGRATOR: this object compiles once those tower methods exist.
const quickConnectApi: QuickConnectApi = {
  listAdapters: tower.listAdapters,
  listProfiles: tower.listProfiles,
  createProfile: tower.createProfile,
  loginProfile: tower.loginProfile,
  machineLoginStatus: tower.machineLoginStatus,
  adoptMachineLogin: tower.adoptMachineLogin,
  setRoutingRole: tower.setRoutingRole,
  runnerPresent: tower.runnerPresent,
  upsertProvider: tower.upsertProvider,
  discoverModels: tower.discoverModels,
  testProvider: tower.testProvider,
  setProviderSecret: tower.setProviderSecret,
};

export function SettingsView({
  section,
  setSection,
  adapters,
  profiles,
  brainProfileIds,
  onError,
  onOpenTerminal,
  providersVersion,
  skillsVersion,
  runwayVersion,
  onStartRun,
  startRunLabel,
}: {
  section: SettingsSection;
  setSection: (s: SettingsSection) => void;
  adapters: AdapterInfo[];
  /** SPEC-TESTING §1.7 — the logged-in account roster (App state, refreshed with the fleet),
   *  for the routing grids' per-role account selects. Optional; absent = no account column. */
  profiles?: AgentProfile[];
  /** Every assistant Brain account's profileId — excluded from account dropdowns (UX only; the
   *  server refuses a reserved profileId on write regardless, SPEC-TESTING §1.4). */
  brainProfileIds?: string[];
  onError: (m: string) => void;
  onOpenTerminal: (id: string) => void;
  /** Bumped by App on each `{t:'providers'}` SSE frame, so the panel live-refreshes its roster. */
  providersVersion?: number;
  /** Bumped by App on each `{t:'skills'}` SSE frame, so the Skills panel refetches its list. */
  skillsVersion?: number;
  /** SPEC-RUNWAY — bumped by App on each `{t:'runway'}` SSE frame, so the Runway tab refetches config. */
  runwayVersion?: number;
  /** Quick Connect's success CTA action — App wires it to open the sole active project's run composer
   *  on the Flightline (or just hop to the Flightline when there are zero/many projects). Absent → the
   *  CTA just leaves the success step. */
  onStartRun?: () => void;
  /** The CTA's label — "Start a run on the Flightline" when there is exactly one project to run in,
   *  else "Go to the Flightline". Absent → Quick Connect's default label. */
  startRunLabel?: string;
}) {
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-title">Settings</div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`settings-navitem ${section === s.id ? 'active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {section === 'connections' ? (
          <ConnectionsSection
            adapters={adapters}
            profiles={profiles}
            brainProfileIds={brainProfileIds}
            onError={onError}
            onOpenTerminal={onOpenTerminal}
            providersVersion={providersVersion}
            onStartRun={onStartRun}
            startRunLabel={startRunLabel}
          />
        ) : section === 'routing' ? (
          <>
            <RoutingSection
              api={providersApi}
              adapters={adapters}
              profiles={profiles}
              brainProfileIds={brainProfileIds}
              onError={onError}
            />
            <SkillsPanel onError={onError} reloadSignal={skillsVersion} />
            <SkillBundlesEditor onError={onError} reloadSignal={skillsVersion} />
          </>
        ) : section === 'projects' ? (
          <ProjectsSection
            adapters={adapters}
            profiles={profiles}
            brainProfileIds={brainProfileIds}
            onError={onError}
            reloadSignal={providersVersion}
            skillsReloadSignal={skillsVersion}
          />
        ) : section === 'assistant' ? (
          <AssistantSettings onError={onError} onOpenTerminal={onOpenTerminal} />
        ) : section === 'runway' ? (
          <RunwayPanel onError={onError} reloadSignal={runwayVersion} onOpenTerminal={onOpenTerminal} />
        ) : (
          <>
            <TerminalLimitsSettings onError={onError} />
            <CliVersionsSettings onError={onError} />
            <TestKitSettings onError={onError} />
            <HostIsolationSection onError={onError} />
            <div className="accounts"><HealthAndAudit /></div>
          </>
        )}
      </div>
    </div>
  );
}

/** Shared "the initial fetch failed" affordance — an inline retry instead of a pane that
 *  sits on "Loading…" (or blank) forever after one transient error. */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="muted small">
      Couldn’t load this section.{' '}
      <button className="btn-sm" onClick={onRetry}>retry</button>
    </div>
  );
}

// ---- Connections (provider accounts + GitHub identities + custom providers) ----
// Accounts and custom providers stack here; the guided Connect wizard replaces the stack while it
// is open. Every entry point (Accounts "Connect an account", Providers "Add provider"/empty-state,
// the chooser's Advanced hop) flips one piece of local state — no tab hop, no modal.
function ConnectionsSection({ adapters, profiles, brainProfileIds, onError, onOpenTerminal, providersVersion, onStartRun, startRunLabel }: {
  adapters: AdapterInfo[];
  profiles?: AgentProfile[];
  brainProfileIds?: string[];
  onError: (m: string) => void;
  onOpenTerminal: (id: string) => void;
  providersVersion?: number;
  onStartRun?: () => void;
  startRunLabel?: string;
}) {
  // The Connect wizard replaces the stacked sections while open; closed = the noun views.
  // Tab switches unmount this component, so wizard state clears without the old nav-click reset.
  const [wizard, setWizard] = useState<{ tile: 'subscription' | null } | null>(null);
  // The chooser's Advanced tile returns to the stack with the blank ProviderForm open; the
  // ProvidersPanel acknowledges the signal so a later revisit doesn't re-open the form.
  const [pvOpenForm, setPvOpenForm] = useState(false);

  if (wizard) {
    return (
      <div>
        <div style={{ marginBottom: 10 }}>
          <button className="btn sm ghost" onClick={() => setWizard(null)}>← back to Connections</button>
        </div>
        <QuickConnect
          api={quickConnectApi}
          agentTile={(p) => <AgentTile {...p} />}
          initialTile={wizard.tile}
          onAdvanced={() => { setPvOpenForm(true); setWizard(null); }}
          onClose={() => setWizard(null)}
          onStartRun={onStartRun}
          startRunLabel={startRunLabel}
          onOpenTerminal={onOpenTerminal}
          onError={onError}
        />
      </div>
    );
  }
  return (
    <>
      <AccountsPanel
        adapters={adapters}
        onError={onError}
        onOpenTerminal={onOpenTerminal}
        onQuickConnect={() => setWizard({ tile: 'subscription' })}
      />
      <ProvidersPanel
        api={providersApi}
        adapters={adapters}
        profiles={profiles}
        brainProfileIds={brainProfileIds}
        onError={onError}
        onOpenTerminal={onOpenTerminal}
        reloadSignal={providersVersion}
        onQuickConnect={() => setWizard({ tile: null })}
        openForm={pvOpenForm}
        onOpenFormHandled={() => setPvOpenForm(false)}
      />
    </>
  );
}

// ---- Projects: one tab — a project picker over the per-project detail rows ----
// The picker + the "show archived" toggle pick which Project the detail pane configures. The detail
// wrapper is keyed on project.id so every row remounts on a project switch (the GitHub row baselines
// from the Project record at mount; the routing/testing rows refetch) — the accordion state lives
// OUTSIDE the keyed wrapper so the same area stays open as you compare projects.
function ProjectsSection({ adapters, profiles, brainProfileIds, onError, reloadSignal, skillsReloadSignal }: {
  adapters: AdapterInfo[];
  profiles?: AgentProfile[];
  brainProfileIds?: string[];
  onError: (m: string) => void;
  /** Bumped by App on each `providers` SSE frame — refresh lists (the old section idiom). */
  reloadSignal?: number;
  /** Bumped by App on each `skills` SSE frame — refresh the per-project skills row + bundle list. */
  skillsReloadSignal?: number;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowProfile[]>([]);
  const [bundles, setBundles] = useState<SkillBundle[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [providers, setProviders] = useState<ProviderDefView[]>([]);
  const [identities, setIdentities] = useState<GitHubIdentity[]>([]);
  const [failed, setFailed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [openArea, setOpenArea] = useState<'routing' | 'skills' | 'testing' | 'github' | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [ps, wfs, ids] = await Promise.all([
        tower.listProjects(), tower.listWorkflows(), tower.listIdentities(),
      ]);
      setProjects(ps);
      setWorkflows(wfs);
      setIdentities(ids);
      // Bundles + the library feed the per-project skills row — best-effort, never blocks the section.
      tower.listSkillBundles().then(setBundles).catch(() => {});
      tower.listSkills().then(setSkills).catch(() => {});
      // Custom defs feed the routing row's "model not inherited" note — best-effort, never blocks.
      tower.listProviders().then(setProviders).catch(() => {});
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => { void load(); }, [load, reloadSignal]);
  // Refresh the bundle list on each `skills` SSE frame so a bundle rename/add shows in the per-project
  // selector without a tab hop (the per-project skills row refetches its own view on the same signal).
  useEffect(() => {
    tower.listSkillBundles().then(setBundles).catch(() => {});
    tower.listSkills().then(setSkills).catch(() => {});
  }, [skillsReloadSignal]);

  const visible = useMemo(
    () => projects.filter((p) => showArchived || !p.archivedAt),
    [projects, showArchived],
  );
  // The selection resolved for THIS render — falls back to the first active (else first, else '')
  // whenever the stored pick isn't in `visible` (initial load, or an archived pick hidden by the
  // toggle). Deriving it in render, not only in an effect, keeps the <select> value always valid so
  // there is no empty-value frame; the effect below just persists it so onChange stays authoritative.
  const selectedId = visible.some((p) => p.id === projectId)
    ? projectId
    : (visible.find((p) => !p.archivedAt)?.id ?? visible[0]?.id ?? '');
  useEffect(() => {
    if (selectedId !== projectId) setProjectId(selectedId);
  }, [selectedId, projectId]);

  const project = visible.find((p) => p.id === selectedId);
  const agentAdapters = useMemo(() => adapters.filter((a) => a.id !== 'shell'), [adapters]);

  const toggleAutonomy = async (p: Project) => {
    try {
      const next = await tower.setProjectAutoAccept(p.id, !(p.defaultAutoAccept === true));
      setProjects((ps) => ps.map((x) => (x.id === p.id ? next : x)));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <>
      <section className="settings-section">
        <h2>Projects</h2>
        <p className="muted small">
          Per-project configuration. Pick a project, then tune how its runs route, test, push,
          isolate and ask for permission. Global defaults live under Routing and System.
        </p>
        {failed && <LoadFailed onRetry={() => void load()} />}
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <select className="st-proj" value={selectedId} onChange={(e) => setProjectId(e.target.value)}>
            {visible.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.archivedAt ? ' (archived)' : ''}</option>
            ))}
          </select>
          <label className="settings-toggle">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            <span>show archived</span>
          </label>
        </div>
        {projects.length === 0 && !failed && <div className="muted small" style={{ marginTop: 8 }}>No projects yet.</div>}
        {projects.length > 0 && visible.length === 0 && (
          <div className="muted small" style={{ marginTop: 8 }}>
            All projects are archived — turn on “show archived” to configure them.
          </div>
        )}
      </section>

      {project && (
        <div key={project.id}>
          <section className="settings-section">
            <h2>Routing</h2>
            <p className="muted small">
              Route each pipeline role for this project: select a reusable workflow and/or override
              single roles. An override replaces the whole row (provider + model); unset rows
              inherit — the workflow first, then the global defaults (Settings → Routing).
            </p>
            <ProjectRoutingRow
              project={project}
              workflows={workflows}
              adapters={agentAdapters}
              providers={providers}
              profiles={profiles}
              brainProfileIds={brainProfileIds}
              expanded={openArea === 'routing'}
              onToggle={() => setOpenArea((c) => (c === 'routing' ? null : 'routing'))}
              onError={onError}
              reloadSignal={reloadSignal}
            />
          </section>

          <section className="settings-section">
            <h2>Skills</h2>
            <p className="muted small">
              Select which skills this project’s runs get: pick a bundle and/or override single skills on or
              off. The global (default-on) library is always included; a disabled library skill stays excluded.
              Global skills are delivered to terminals today — project-scoped selections are delivered in a later phase.
            </p>
            <ProjectSkillsRow
              project={project}
              bundles={bundles}
              skills={skills}
              expanded={openArea === 'skills'}
              onToggle={() => setOpenArea((c) => (c === 'skills' ? null : 'skills'))}
              onError={onError}
              reloadSignal={skillsReloadSignal}
            />
          </section>

          <section className="settings-section">
            <h2>Testing</h2>
            <p className="muted small">
              Per-project e2e suite wiring. The suite command is what <span className="mono">towerctl test run</span> executes
              for this project (and the composer’s runner-check prefill); the gate suite prefills a mission’s regression gate.
              Both run in an agent’s shell — same trust class as a check command.
            </p>
            <ProjectTestingRow
              project={project}
              expanded={openArea === 'testing'}
              onToggle={() => setOpenArea((c) => (c === 'testing' ? null : 'testing'))}
              onError={onError}
            />
          </section>

          <section className="settings-section">
            <h2>GitHub</h2>
            <p className="muted small">
              Per-project repository URL (metadata for the Flightline link) and the default GitHub identity a
              project’s runs commit and push as. The credential broker’s host allowlist stays the authorization
              boundary — this only picks which stored identity is used. Add identities and their push tokens in{' '}
              <span className="mono">Connections → GitHub identities</span>.
            </p>
            <ProjectGithubRow
              project={project}
              identities={identities}
              expanded={openArea === 'github'}
              onToggle={() => setOpenArea((c) => (c === 'github' ? null : 'github'))}
              onError={onError}
              onSaved={(p) => setProjects((ps) => ps.map((x) => (x.id === p.id ? p : x)))}
            />
          </section>

          <section className="settings-section">
            <h2>Isolation</h2>
            <p className="muted small">
              Per-agent UID isolation for this project’s runs. Host provisioning status lives in
              Settings → System.
            </p>
            <ProjectIsolationRow project={project} onError={onError} />
          </section>

          <section className="settings-section">
            <h2>Autonomous (skip permissions)</h2>
            <p className="muted small">
              When on, WORK terminals in the project launch claude with <span className="mono">--dangerously-skip-permissions</span>:
              the agent runs any command without asking, and permission prompts never reach the Clearance dock.
              Login and planner terminals always keep the human gate. Applies only to providers that support it
              (Claude Code today); each run can force it on or off when composing. Off by default — never global.
            </p>
            {project.defaultAutoAccept !== true && (
              <p className="muted small">
                Projects run single-UID today — the operator’s own Unix user, not a sandboxed container or VM.
                An autonomous agent can run any command as you, so arm this only for a repository you would let
                work unattended.
              </p>
            )}
            <div className="acct-row">
              <span className="acct-label">{project.name}{project.archivedAt ? ' (archived)' : ''}</span>
              <span className="muted small mono">{project.repoPath}</span>
              <span className="spacer" />
              <span className={`chip ${project.defaultAutoAccept === true ? 'auto' : ''}`}>
                {project.defaultAutoAccept === true ? 'autonomous' : 'asks first'}
              </span>
              <button className="btn-sm" onClick={() => void toggleAutonomy(project)}>
                {project.defaultAutoAccept === true ? 'require approval' : 'set autonomous'}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

// Host half of the old Isolation overview — the machine-global readout (System tab).
function HostIsolationSection({ onError }: { onError: (m: string) => void }) {
  const [host, setHost] = useState<SystemIsolation | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    try { setHost(await tower.systemIsolation()); }
    catch (e) { setFailed(true); onError((e as Error).message); }
  }, [onError]);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className="settings-section">
      <h2>Isolation</h2>
      <p className="muted small">Host-level isolation status. Per-project modes are set in Settings → Projects.</p>
      {failed && <LoadFailed onRetry={() => void load()} />}
      {host && (
        <div className="health-grid" style={{ marginBottom: 16 }}>
          <div><span className="muted small">per-agent UID host setup</span><br />{host.perAgentUidProvisioned ? '● provisioned' : '○ not provisioned'}</div>
          <div><span className="muted small">assistant sandbox (bubblewrap)</span><br />{host.sandboxAvailable ? '● available' : '○ missing'}</div>
          <div>
            <span className="muted small">assistant no-sandbox env override</span><br />
            {host.envNoSandboxOverride ? '⚠ active — gate bypassed process-wide' : '○ not set'}
          </div>
        </div>
      )}
      {host && !host.perAgentUidProvisioned && (
        <p className="muted small">
          Run <span className="mono">{host.setupCommand}</span> once (sudo) to provision per-agent UID isolation + egress control.
        </p>
      )}
    </section>
  );
}

// Per-project half — one project's isolation chip + toggle (Projects tab detail pane).
function ProjectIsolationRow({ project, onError }: { project: Project; onError: (m: string) => void }) {
  const [sec, setSec] = useState<ProjectSecurity | null>(null);
  useEffect(() => {
    // Same tolerance as the old overview's per-project probe: a failed read just hides the controls.
    tower.projectSecurity(project.id).then(setSec).catch(() => {});
  }, [project.id]);
  const toggle = async () => {
    if (!sec?.available) return;
    try {
      setSec(await tower.setIsolation(project.id, sec.intent === 'per-agent-uid' ? 'single-uid' : 'per-agent-uid'));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const on = sec?.enforced;
  const pending = sec?.intent === 'per-agent-uid' && sec?.available && !on;
  return (
    <div className="acct-row">
      <span className="acct-label">{project.name}</span>
      <span className="muted small mono">{project.repoPath}</span>
      <span className="spacer" />
      {sec && <span className={`chip ${on ? 'question' : ''}`}>{on ? 'per-UID' : pending ? 'per-UID · pending' : 'single-UID'}</span>}
      {sec?.available && (
        <button className="btn-sm" onClick={() => void toggle()}>
          {sec.intent === 'per-agent-uid' ? 'set single-UID' : 'set per-UID'}
        </button>
      )}
    </div>
  );
}

// ---- Assistant (moved here from the chat dock — the dock now only chats) ----
// Self-contained: pick a ChatGPT model and hit one "Log in with ChatGPT" button. That ensures
// the isolated Codex profile, wires it as the assistant brain, and opens the `codex login`
// terminal on the Flightline for the ChatGPT device flow — no trip to another tab.

// The assistant brain is always a Codex/ChatGPT account. There is NO default model — the operator
// picks one explicitly (the live roster comes from the shared <ModelSelect provider="codex">, which
// reads GET /api/models/codex and can Refresh the catalog); the connect/save buttons stay disabled
// until a model is chosen, and the config writer never substitutes a slug of its own.
function ModelPicker({ value, onChange, profileId }: { value: string; onChange: (v: string) => void; profileId?: string }) {
  return (
    <div className="field">
      <label>ChatGPT model</label>
      {/* SPEC-MODELS §3 — scope the codex roster + Refresh to the connected brain account (the catalog
          is per ChatGPT tier), so the picker reads/refreshes THIS account, not the newest login.
          allowEmpty + a "select a model" prompt makes the pick explicit — the system imposes no default. */}
      <ModelSelect provider="codex" value={value} onChange={onChange} profileId={profileId} allowEmpty emptyLabel="— select a model —" ariaLabel="ChatGPT model" />
      <span className="hint">Pick the model this brain runs on — required. Refresh (↻) checks for newly released models, Custom… for anything not listed yet.</span>
    </div>
  );
}

function AssistantSettings({ onError, onOpenTerminal }: { onError: (m: string) => void; onOpenTerminal: (id: string) => void }) {
  const [accounts, setAccounts] = useState<AssistantAccount[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [host, setHost] = useState<SystemIsolation | null>(null);
  const [model, setModel] = useState(''); // no default — the operator must pick a brain model
  const [effort, setEffort] = useState(''); // SPEC-EFFORT §4 — optional; '' = codex's own default (no pin)
  const [allow, setAllow] = useState(false);
  const [auto, setAuto] = useState(false);
  const [timeoutS, setTimeoutS] = useState('');
  const [busy, setBusy] = useState(false);
  // "Saved ✓" affordance — a localhost save round-trips in ms, so the Save→Saving…→Save flicker reads as
  // "nothing happened" without a success signal. Shown only while the form still matches what was saved.
  const [saved, setSaved] = useState(false);
  const acct = accounts?.[0] ?? null;
  // `dirty` mirrors exactly what save() sends vs what the server stored, so a form the server NORMALIZED
  // (a clamped timeout 5→10, a trimmed model) reads as NOT dirty and keeps "Saved ✓" showing — the case
  // the operator most needs the confirmation. An actual edit flips it on the first keystroke. Gating the
  // badge on this (not on raw field changes) is why a normalized-equal form no longer reads as unsaved.
  const dirty =
    !acct ||
    model.trim() !== (acct.model ?? '') ||
    effort.trim() !== (acct.effort ?? '') ||
    allow !== !!acct.allowNoSandbox ||
    auto !== !!acct.autoConfirm ||
    (timeoutS.trim() ? Number(timeoutS) : null) !== (acct.turnTimeoutSec ?? null);

  /** Mirror the server-normalized account into the form so clamps/trims show truthfully. */
  const syncForm = (a: AssistantAccount) => {
    setModel(a.model || ''); // reflect the account's chosen model; never a fallback slug
    setEffort(a.effort || '');
    setAllow(!!a.allowNoSandbox);
    setAuto(!!a.autoConfirm);
    setTimeoutS(a.turnTimeoutSec ? String(a.turnTimeoutSec) : '');
  };

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const a = await listAssistantAccounts();
      setAccounts(a);
      if (a[0]) syncForm(a[0]);
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
    // Best-effort: only used to warn when the process-wide no-sandbox env override is set.
    tower.systemIsolation().then(setHost).catch(() => {});
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load]);

  // One button: ensure a Codex profile, wire it as the brain, THEN open its ChatGPT login
  // terminal. Wiring FIRST means a failure after the terminal opens can't leave the operator
  // logged in but assistant-less ("log in again" is the recovery for a failed login step).
  // Profiles are fetched at click time — held-as-state would leave a dead disabled button
  // after one transient fetch failure, and a stale list could create a duplicate profile.
  const loginWithChatGPT = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const profs = await listCodexProfiles();
      const prof = profs[0] ?? (await tower.createProfile('codex', 'ChatGPT'));
      const created = await createAssistantAccount({ profileId: prof.id, model: model.trim() || undefined, ...(effort.trim() ? { effort: effort.trim() } : {}) });
      setAccounts([created]);
      syncForm(created);
      const term = await tower.loginProfile(prof.id); // may 400 if no project exists yet
      onOpenTerminal(term.id); // hop to the Flightline to finish the ChatGPT device flow
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reLogin = async () => {
    if (!acct || busy) return;
    setBusy(true);
    try {
      const term = await tower.loginProfile(acct.profileId);
      onOpenTerminal(term.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!acct || busy) return;
    setBusy(true);
    setSaved(false);
    try {
      const u = await updateAssistantAccount(acct.id, {
        model: model.trim(),
        // SPEC-EFFORT §4 — effort is clearable: '' sends null (unpin, codex's own default), mirroring the
        // turnTimeoutSec reset idiom below; a value is sent trimmed (the server gates it against the codex tier).
        effort: effort.trim() ? effort.trim() : null,
        allowNoSandbox: allow,
        autoConfirm: auto,
        turnTimeoutSec: timeoutS.trim() ? Number(timeoutS) : null,
      });
      setAccounts((p) => (p ?? []).map((x) => (x.id === u.id ? u : x)));
      syncForm(u); // server clamps timeout [10,1800] + trims model — show what actually stuck
      setSaved(true);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!acct || busy) return;
    setBusy(true);
    try {
      await deleteAssistantAccount(acct.id);
      setAccounts([]);
      setSaved(false); // reset the confirmation on a successful disconnect so a reconnect can't re-show a stale "Saved ✓"
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Onboard assistant</h2>
      <p className="muted small">
        A read-only copilot on your own Codex (ChatGPT) subscription. Ask it about the fleet from the ✦ Ask dock;
        set it up here.
      </p>
      {failed ? (
        <LoadFailed onRetry={() => void load()} />
      ) : accounts === null ? (
        <div className="muted small">Loading…</div>
      ) : !acct ? (
        <div className="settings-form">
          {/* No brain account connected yet → the account-less codex roster (curated) is the honest view. */}
          <ModelPicker value={model} onChange={setModel} />
          {/* SPEC-EFFORT §4 — optional reasoning effort; the curated codex seed carries effort sets, so a
              pre-connect pick is available. Unset ⇒ codex's own default (no pin written). */}
          <div className="field">
            <label>Reasoning effort (optional)</label>
            <EffortSelect provider="codex" model={model.trim() || undefined} value={effort} onChange={setEffort} ariaLabel="brain reasoning effort" />
            <span className="hint">Unset = codex’s own default.</span>
          </div>
          <div>
            <button className="btn ok" disabled={busy || !model.trim()} onClick={() => void loginWithChatGPT()}>
              {busy ? 'Starting…' : 'Log in with ChatGPT'}
            </button>
          </div>
          <span className="hint">
            {model.trim()
              ? 'Opens a sign-in terminal on the Flightline — finish the ChatGPT login there and the assistant is ready.'
              : 'Pick a model above to continue.'}
          </span>
        </div>
      ) : (
        <div className="settings-form">
          <div className="acct-row">
            <span className="acct-label">Connected</span>
            <span className="muted small mono">codex · {acct.profileId}</span>
            <span className="spacer" />
            <button className="btn-sm" disabled={busy} onClick={() => void reLogin()}>log in again</button>
            <button className="btn-sm danger" disabled={busy} onClick={() => void disconnect()}>disconnect</button>
          </div>
          <ModelPicker value={model} onChange={setModel} profileId={acct?.profileId} />
          {/* SPEC-EFFORT §4 — optional reasoning effort for the connected Brain account (codex tier).
              Refresh the model list (↻ above) first if the effort options look empty. */}
          <div className="field">
            <label>Reasoning effort (optional)</label>
            <EffortSelect provider="codex" profileId={acct?.profileId} model={model.trim() || undefined} value={effort} onChange={setEffort} ariaLabel="brain reasoning effort" />
            <span className="hint">Unset = codex’s own default.</span>
          </div>
          <div className="field">
            <label>Per-turn timeout (seconds)</label>
            <input type="number" min={10} max={1800} value={timeoutS} onChange={(e) => setTimeoutS(e.target.value)} placeholder="300 (default)" />
          </div>
          <label className="settings-toggle">
            <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
            <span>Allow running without the OS sandbox</span>
          </label>
          <span className="settings-warn">
            ⚠ Only if you can’t install bubblewrap. Without the sandbox a prompt-injected turn could run an unsandboxed
            shell with network access — a real risk.
          </span>
          {host?.envNoSandboxOverride && (
            <span className="settings-warn">
              ⚠ CT_ASSISTANT_ALLOW_NO_SANDBOX=1 is set on the Tower process — the sandbox gate is bypassed no matter
              what this toggle says. Remove the env var to make this setting authoritative.
            </span>
          )}
          <label className={`settings-toggle${auto ? ' armed' : ''}`}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            <span>Autonomous mode — run most proposed actions without the confirm step</span>
          </label>
          <span className="settings-warn">
            ⚠ Jarvis runs its proposed actions automatically, with NO confirm step — except the four that always wait for
            your Confirm: a loop carrying a host shell check-command, registering a project, initializing &amp; pushing a
            repository, and arming a project’s autonomy (skip-permissions). It can add providers, groom the board, and START
            AGENT RUNS on its own. Every action is still
            audited and limited to the assistant’s action catalog (it can never land/kill work, touch secrets, or answer
            another agent’s prompt).
          </span>
          <div><button className="btn ok" disabled={busy || !model.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><span className="hint" role="status" aria-live="polite" style={{ marginLeft: 8 }}>{saved && !dirty ? 'Saved ✓' : ''}</span></div>
          {!model.trim() && <span className="hint">Pick a model to save.</span>}
        </div>
      )}
    </section>
  );
}

// ---- Terminal plane: live cap + reap window (SPEC-TERMINAL-OPS §3.1/§4.3) ----
// SPEC-CLI-UPDATE — the installed built-in agent CLIs + a per-CLI self-update button. Update runs the
// CLI's own updater on the host; running agents keep their version until they respawn, so nothing
// restarts underneath a live run.
function CliVersionsSettings({ onError }: { onError: (m: string) => void }) {
  const [rows, setRows] = useState<CliVersion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, CliUpdateResult>>({});
  const load = useCallback(async () => {
    try {
      setRows(await tower.cliVersions());
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => { void load(); }, [load]);

  const update = async (provider: string) => {
    setBusy(provider);
    try {
      const r = await tower.updateCli(provider); // rejects on a failed/refused update (non-2xx)
      setResult((m) => ({ ...m, [provider]: r }));
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-section">
      <h2>Provider CLI versions</h2>
      <p className="muted small">
        The built-in agent CLIs installed on this host. <b>Update</b> runs each CLI’s own self-updater;
        a running agent keeps its version until it respawns, so nothing restarts mid-run.
      </p>
      <div className="acct-list">
        {(rows ?? []).map((r) => {
          const res = result[r.provider];
          return (
            <div key={r.provider} className="acct-row">
              <span className="chip question">{r.provider}</span>
              <span className="acct-label mono">{r.present ? (r.version ?? 'installed') : 'not installed'}</span>
              <span className="spacer" />
              {res && (
                <span className="muted small">
                  {res.ok
                    ? res.changed
                      ? `updated ${res.before ?? '?'} → ${res.after ?? '?'}`
                      : 'already up to date'
                    : 'update failed'}
                </span>
              )}
              {r.present && (
                <button className="btn-sm" disabled={busy !== null} onClick={() => void update(r.provider)}>
                  {busy === r.provider ? 'updating…' : 'update'}
                </button>
              )}
            </div>
          );
        })}
        {rows && rows.length === 0 && <div className="muted small">No updatable CLIs detected on this host.</div>}
        {rows === null && <div className="muted small">Checking…</div>}
      </div>
    </section>
  );
}

function TerminalLimitsSettings({ onError }: { onError: (m: string) => void }) {
  const [settings, setSettings] = useState<GlobalSettingsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [cap, setCap] = useState('');
  const [hours, setHours] = useState('');
  const [busy, setBusy] = useState(false);
  const apply = useCallback((s: GlobalSettingsView) => {
    setSettings(s);
    setCap(s.maxTerminals != null ? String(s.maxTerminals) : '');
    setHours(s.terminalReapHours != null ? String(s.terminalReapHours) : '');
  }, []);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      apply(await tower.getSettings());
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
  }, [apply, onError]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async () => {
    setBusy(true);
    try {
      apply(
        await tower.patchSettings({
          maxTerminals: cap.trim() ? Number(cap) : null,
          terminalReapHours: hours.trim() ? Number(hours) : null,
        }),
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section">
      <h2>Terminals</h2>
      <p className="muted small">
        How many agent terminals may run at once, and how long a finished mission’s terminal is kept before its pane is
        closed. Login terminals are always exempt from the cap, and are never closed automatically.
      </p>
      {failed && <LoadFailed onRetry={() => void load()} />}
      {settings && (
        <div className="settings-form">
          <div className="field">
            <label>Max live terminals</label>
            <input type="number" min={1} max={128} value={cap} onChange={(e) => setCap(e.target.value)} placeholder="12 (default)" />
            <span className="hint">Effective now: {settings.effectiveMaxTerminals} · blank resets to the default (12).</span>
          </div>
          <div className="field">
            <label>Close finished mission terminals after (hours)</label>
            <input type="number" min={1} max={720} value={hours} onChange={(e) => setHours(e.target.value)} placeholder="24 (default)" />
            <span className="hint">
              Effective now: {settings.effectiveTerminalReapHours} · only terminals a finished mission spawned; your own
              terminals are never closed. The worktree, branch and log are kept.
            </span>
          </div>
          <div><button className="btn ok" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></div>
        </div>
      )}
    </section>
  );
}
// ---- Test kit concurrency cap ----
function TestKitSettings({ onError }: { onError: (m: string) => void }) {
  const [settings, setSettings] = useState<GlobalSettingsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      const s = await tower.getSettings();
      setSettings(s);
      setVal(s.testMaxSlots != null ? String(s.testMaxSlots) : '');
    } catch (e) {
      setFailed(true);
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async () => {
    setBusy(true);
    try {
      const s = await tower.patchSettings({ testMaxSlots: val.trim() ? Number(val) : null });
      setSettings(s);
      setVal(s.testMaxSlots != null ? String(s.testMaxSlots) : '');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section">
      <h2>Test kit</h2>
      <p className="muted small">
        Max concurrent Playwright test runs agents can hold at once. Each headless browser budgets ~400 MB, so the
        effective cap is also limited by free memory.
      </p>
      {failed && <LoadFailed onRetry={() => void load()} />}
      {settings && (
        <div className="settings-form">
          <div className="field">
            <label>Max concurrent runs</label>
            <input type="number" min={1} max={64} value={val} onChange={(e) => setVal(e.target.value)} placeholder="8 (default)" />
            <span className="hint">Effective now: {settings.effectiveTestMaxSlots} · blank resets to the env/default (8).</span>
          </div>
          <div><button className="btn ok" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></div>
        </div>
      )}
    </section>
  );
}

// SPEC-LOOP W5 — the logSources textarea is one path per line; parse to the trimmed, non-empty
// string[] the config stores (the server zod bounds count/length and 400s an over-cap edit).
function parseLogSources(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function ProjectTestingRow({
  project,
  expanded,
  onToggle,
  onError,
}: {
  project: Project;
  expanded: boolean;
  onToggle: () => void;
  onError: (m: string) => void;
}) {
  // `view` is the last server-confirmed config (null until the on-expand load) — the dirty
  // compare + chip read it, the form fields hold the edits.
  const [view, setView] = useState<ProjectTestingConfig | null>(null);
  const [suiteCommand, setSuiteCommand] = useState('');
  const [gateSuite, setGateSuite] = useState('');
  const [docsPhase, setDocsPhase] = useState(false);
  const [autoFile, setAutoFile] = useState(false);
  // SPEC-LOOP W5 — the PUT is a FULL replace, so these MUST round-trip or a save wipes them.
  const [logSources, setLogSources] = useState('');
  const [captureDocker, setCaptureDocker] = useState(false);
  const [busy, setBusy] = useState(false);

  const syncFrom = (c: ProjectTestingConfig) => {
    setView(c);
    setSuiteCommand(c.suiteCommand ?? '');
    setGateSuite(c.gateSuite ?? '');
    setDocsPhase(!!c.docsPhase);
    setAutoFile(!!c.autoFileFailures);
    setLogSources((c.logSources ?? []).join('\n'));
    setCaptureDocker(!!c.captureDocker);
  };
  const load = useCallback(async () => {
    try {
      syncFrom(await tower.getProjectTesting(project.id));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [project.id, onError]);
  // Loaded on expand (not eagerly per row) — a collapsed row costs no fetch.
  useEffect(() => {
    if (expanded && view === null) void load();
  }, [expanded, view, load]);

  const dirty =
    view !== null &&
    (suiteCommand.trim() !== (view.suiteCommand ?? '') ||
      gateSuite.trim() !== (view.gateSuite ?? '') ||
      docsPhase !== !!view.docsPhase ||
      autoFile !== !!view.autoFileFailures ||
      JSON.stringify(parseLogSources(logSources)) !== JSON.stringify(view.logSources ?? []) ||
      captureDocker !== !!view.captureDocker);
  const configured = !!(
    view &&
    (view.suiteCommand ||
      view.gateSuite ||
      view.docsPhase ||
      view.autoFileFailures ||
      view.logSources?.length ||
      view.captureDocker)
  );

  const save = async () => {
    setBusy(true);
    try {
      // PUT replaces the whole config; all-empty = "no testing config" (drops the entry).
      const sources = parseLogSources(logSources);
      syncFrom(
        await tower.setProjectTesting(project.id, {
          ...(suiteCommand.trim() ? { suiteCommand: suiteCommand.trim() } : {}),
          ...(gateSuite.trim() ? { gateSuite: gateSuite.trim() } : {}),
          ...(docsPhase ? { docsPhase: true } : {}),
          ...(autoFile ? { autoFileFailures: true } : {}),
          ...(sources.length ? { logSources: sources } : {}),
          ...(captureDocker ? { captureDocker: true } : {}),
        }),
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prt-row">
      <div className="acct-row">
        <span className="acct-label">{project.name}</span>
        <span className="muted small mono">{project.repoPath}</span>
        <span className="spacer" />
        {view && <span className={`chip ${configured ? 'question' : ''}`}>{configured ? 'configured' : 'defaults'}</span>}
        {dirty && <span className="chip hold">unsaved</span>}
        <button className="btn-sm" onClick={onToggle}>{expanded ? 'close' : 'testing'}</button>
      </div>
      {expanded && (
        <div className="prt-body settings-form">
          {view === null ? (
            <div className="muted small">
              Loading… <button className="btn-sm" onClick={() => void load()}>retry</button>
            </div>
          ) : (
            <>
              <div className="field">
                <label>Suite command</label>
                <input
                  className="mono"
                  placeholder="npx playwright test  (blank = kit default)"
                  value={suiteCommand}
                  onChange={(e) => setSuiteCommand(e.target.value)}
                />
                <span className="hint">
                  What <span className="mono">towerctl test run</span> executes for this project, and the composer’s
                  runner-check prefill. Blank falls back to the kit default.
                </span>
              </div>
              <div className="field">
                <label>Gate suite</label>
                <input
                  className="mono"
                  placeholder="npx playwright test  (blank = built-in prefill)"
                  value={gateSuite}
                  onChange={(e) => setGateSuite(e.target.value)}
                />
                <span className="hint">
                  Prefills the mission composer’s regression gate. A RAW command — the gate runs it in-process against a
                  trial-merge worktree, never <span className="mono">towerctl test run</span>.
                </span>
              </div>
              <label className="settings-toggle">
                <input type="checkbox" checked={docsPhase} onChange={(e) => setDocsPhase(e.target.checked)} />
                <span>Docs phase — the verify template appends a documentor phase</span>
              </label>
              <label className="settings-toggle">
                <input type="checkbox" checked={autoFile} onChange={(e) => setAutoFile(e.target.checked)} />
                <span>Auto-file failures — a non-gate run’s failures file to the backlog at release</span>
              </label>
              <div className="field">
                <label>Log sources</label>
                <textarea
                  className="mono"
                  rows={3}
                  placeholder={'server.log\nlogs/            (blank = capture nothing)'}
                  value={logSources}
                  onChange={(e) => setLogSources(e.target.value)}
                />
                <span className="hint">
                  One repo-relative path per line (a file, or a directory whose files are scanned one level —
                  no recursion). Up to 12; only the last 1&nbsp;MB of each is kept. Captured when a run produces
                  parsed results (not on a crashed/timed-out run). Contents may contain secrets — download-only.
                </span>
              </div>
              <label className="settings-toggle">
                <input type="checkbox" checked={captureDocker} onChange={(e) => setCaptureDocker(e.target.checked)} />
                <span>Capture docker logs — tail <span className="mono">docker compose logs</span> from the worktree at release</span>
              </label>
              <div>
                <button className="btn ok" disabled={busy || !dirty} onClick={() => void save()}>
                  {busy ? 'Saving…' : 'Save testing config'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectGithubRow({
  project,
  identities,
  expanded,
  onToggle,
  onError,
  onSaved,
}: {
  project: Project;
  identities: GitHubIdentity[];
  expanded: boolean;
  onToggle: () => void;
  onError: (m: string) => void;
  /** Fold the saved Project back into the parent roster: this row baselines from the Project record,
   *  so a picker switch away-and-back would otherwise re-seed from a stale roster and revert the save. */
  onSaved?: (p: Project) => void;
}) {
  // Baseline is the Project record itself (no per-row GET); a save re-baselines from the POST response.
  const [repoUrl, setRepoUrl] = useState(project.repoUrl ?? '');
  const [identityId, setIdentityId] = useState(project.defaultIdentityId ?? '');
  const [savedUrl, setSavedUrl] = useState(project.repoUrl ?? '');
  const [savedIdentity, setSavedIdentity] = useState(project.defaultIdentityId ?? '');
  const [busy, setBusy] = useState(false);
  const [showBootstrap, setShowBootstrap] = useState(false);

  const dirty = repoUrl.trim() !== savedUrl || identityId !== savedIdentity;
  const configured = !!(savedUrl || savedIdentity);
  const selected = identities.find((i) => i.id === identityId);
  // A selected identity with no push token still commits (authorship) but cannot push via the broker —
  // warn, don't block (the Tower's push then falls open to ambient daemon credentials).
  const missingToken = !!identityId && !!selected && !selected.hasCredential;

  const save = async () => {
    setBusy(true);
    try {
      // Both keys always sent — null clears one server-side (JSON.stringify drops undefined).
      const updated = await tower.setProjectGithub(project.id, {
        repoUrl: repoUrl.trim() || null,
        defaultIdentityId: identityId || null,
      });
      const u = updated.repoUrl ?? '';
      const id = updated.defaultIdentityId ?? '';
      setRepoUrl(u);
      setIdentityId(id);
      setSavedUrl(u);
      setSavedIdentity(id);
      onSaved?.(updated);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prt-row">
      <div className="acct-row">
        <span className="acct-label">{project.name}</span>
        <span className="muted small mono">{project.repoPath}</span>
        <span className="spacer" />
        <span className={`chip ${configured ? 'question' : ''}`}>{configured ? 'configured' : 'defaults'}</span>
        {dirty && <span className="chip hold">unsaved</span>}
        <button className="btn-sm" onClick={onToggle}>{expanded ? 'close' : 'github'}</button>
      </div>
      {expanded && (
        <div className="prt-body settings-form">
          <div className="field">
            <label>Repo URL</label>
            <input
              className="mono"
              placeholder="https://github.com/owner/repo  (blank = none)"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            <span className="hint">Display/wiring metadata only — the credential broker still decides what a push may reach.</span>
          </div>
          <div className="field">
            <label>GitHub identity</label>
            <select value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
              <option value="">— none —</option>
              {identities.map((i) => (
                <option key={i.id} value={i.id}>{i.label}{i.hasCredential ? '' : ' — no push token'}</option>
              ))}
            </select>
            <span className="hint">
              {missingToken
                ? 'This identity has no push token — commits use its author name, but a Tower push falls back to ambient credentials. Add a token in Connections → GitHub identities.'
                : 'Runs in this project commit and push as this identity. Leave as — none — to use the ambient login.'}
            </span>
          </div>
          <div>
            <button className="btn ok" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save GitHub config'}
            </button>
          </div>
          <div className="field">
            <button className="btn-sm" onClick={() => setShowBootstrap((v) => !v)}>{showBootstrap ? 'close initialize & push' : 'Initialize & push…'}</button>
            <span className="hint">For a project directory that is not yet a git repo: inspect files, generate a .gitignore, keep .local-context/ local, commit, and push the first commit. Always previewed and confirmed here.</span>
          </div>
          {showBootstrap && <RepoBootstrapPanel projectId={project.id} onError={onError} onDone={() => setShowBootstrap(false)} />}
        </div>
      )}
    </div>
  );
}

function ProjectRoutingRow({
  project,
  workflows,
  adapters,
  providers,
  profiles,
  brainProfileIds,
  expanded,
  onToggle,
  onError,
  reloadSignal,
}: {
  project: Project;
  workflows: WorkflowProfile[];
  adapters: AdapterInfo[];
  providers: ProviderDefView[];
  profiles?: AgentProfile[];
  brainProfileIds?: string[];
  expanded: boolean;
  onToggle: () => void;
  onError: (m: string) => void;
  reloadSignal?: number;
}) {
  const [view, setView] = useState<ProjectRoutingView | null>(null);
  const [wfId, setWfId] = useState('');
  const [routes, setRoutes] = useState<RoleRouting>({});
  const [busy, setBusy] = useState(false);

  const syncFrom = (v: ProjectRoutingView) => {
    setView(v);
    setWfId(v.workflowId ?? '');
    setRoutes(v.routes ?? {});
  };
  const load = useCallback(async () => {
    try {
      syncFrom(await tower.getProjectRouting(project.id));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [project.id, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  // Unsaved edits vs the last server view — guards the SSE refetch below from clobbering a
  // half-edited grid, and marks the row so the operator knows Save is pending.
  const dirty =
    view !== null &&
    (wfId !== (view.workflowId ?? '') || !routesEqual(routes, view.routes ?? {}));
  // Refetch on later `providers` SSE bumps only (the mount effect above already fetched once);
  // deliberately NOT keyed on `dirty`/`load` — the signal itself is the trigger.
  const firstSignal = useRef(true);
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false;
      return;
    }
    if (!dirty) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  const save = async () => {
    setBusy(true);
    try {
      // PUT replaces the whole overlay; an empty one = "inherit global" (§6).
      syncFrom(
        await tower.setProjectRouting(project.id, {
          ...(wfId ? { workflowId: wfId } : {}),
          ...(Object.keys(routes).length ? { routes } : {}),
        }),
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const labelFor = (pid: ProviderId) => adapters.find((a) => a.id === pid)?.displayName ?? pid;
  const wfName = (id: string) => workflows.find((w) => w.id === id)?.name ?? id;
  const overrideCount = Object.keys(routes).length;

  // Per-row annotations for the grid (computed here — the grid stays dumb/reusable):
  //  · row unset + configured somewhere → the inherited effective value + source placeholder
  //  · row's provider set with no model → the RT-5 drop, live even before Save (the server's
  //    resolved slug when it already reflects this row, else the provider's own defaultModel)
  const notes = useMemo(() => {
    const out: Partial<Record<PipelineRole, string>> = {};
    for (const { id: role } of PIPELINE_ROLES) {
      const r = routes[role];
      const e = view?.effective[role];
      if (r?.provider && !r.model) {
        // Only trust the last-saved effective model if it was resolved for THIS row's provider —
        // after switching a provider-only override to a different provider, e.model is the OLD
        // provider's default and would render beside the new provider's name.
        const m =
          (e && e.source === 'project' && e.modelSource === 'default' && e.provider === r.provider
            ? e.model
            : undefined) ?? providers.find((d) => d.id === r.provider)?.model.defaultModel;
        out[role] = `${labelFor(r.provider)} · ${m ?? 'provider default'} — model not inherited`;
      } else if (!r && e) {
        const src =
          e.source === 'workflow'
            ? `from workflow '${view?.workflowId ? wfName(view.workflowId) : '?'}'`
            : e.source === 'global'
              ? 'from global defaults'
              : 'project override';
        const m = e.model ? `${e.model}${e.modelSource === 'default' ? ' (provider default)' : ''}` : 'provider default';
        // SPEC-TESTING §1.7 — the resolved account rides the effective view; absent = shared login.
        const acct = e.profileId ? `acct ${e.profileLabel ?? e.profileId}` : 'shared login';
        out[role] = `${labelFor(e.provider)} · ${m} · ${acct} — ${src}`;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, view, workflows, adapters, providers]);

  return (
    <div className="prt-row">
      <div className="acct-row">
        <span className="acct-label">{project.name}</span>
        <span className="muted small mono">{project.repoPath}</span>
        <span className="spacer" />
        {view && (
          <span className={`chip ${wfId || overrideCount ? 'question' : ''}`}>
            {wfId ? `workflow: ${wfName(wfId)}` : 'inherit'}
            {overrideCount > 0 ? ` · ${overrideCount} override${overrideCount === 1 ? '' : 's'}` : ''}
          </span>
        )}
        {dirty && <span className="chip hold">unsaved</span>}
        <button className="btn-sm" onClick={onToggle}>{expanded ? 'close' : 'routing'}</button>
      </div>
      {expanded && (
        <div className="prt-body settings-form route-wide">
          {view === null ? (
            <div className="muted small">
              Loading… <button className="btn-sm" onClick={() => void load()}>retry</button>
            </div>
          ) : (
            <>
              {view.warnings.map((w, i) => (
                <span key={i} className="settings-warn">⚠ {w}</span>
              ))}
              <div className="field" style={{ maxWidth: 360 }}>
                <label>Workflow</label>
                <select value={wfId} onChange={(e) => setWfId(e.target.value)}>
                  <option value="">Inherit — global defaults</option>
                  {/* A dangling selection keeps its option so the select stays truthful; the
                      server's warnings above explain it. */}
                  {wfId && !workflows.some((w) => w.id === wfId) && (
                    <option value={wfId}>(missing workflow {wfId})</option>
                  )}
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <RoleRoutingGrid
                routes={routes}
                onChange={setRoutes}
                adapters={adapters}
                profiles={profiles}
                brainProfileIds={brainProfileIds}
                inheritLabel="Inherit"
                notes={notes}
              />
              <div>
                <button className="btn ok" disabled={busy || !dirty} onClick={() => void save()}>
                  {busy ? 'Saving…' : 'Save project routing'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// SPEC-SKILLS Phase 3 — per-project skill selection: a selected bundle + per-skill on/off overrides,
// with the resolved effective set below the controls. A ProjectRoutingRow clone: server-view state +
// syncFrom, a `dirty` guard that skips the SSE refetch while editing, PUT-replace save (empty overlay =
// inherit), and the missing-bundle option idiom. Provenance chips + the `delivered` "later phase" tag
// come straight off the server's effective view (the honest bit — Phase 3 delivers only the global set).
function ProjectSkillsRow({
  project,
  bundles,
  skills,
  expanded,
  onToggle,
  onError,
  reloadSignal,
}: {
  project: Project;
  bundles: SkillBundle[];
  skills: Skill[];
  expanded: boolean;
  onToggle: () => void;
  onError: (m: string) => void;
  reloadSignal?: number;
}) {
  const [view, setView] = useState<ProjectSkillsView | null>(null);
  const [bundleId, setBundleId] = useState('');
  const [enable, setEnable] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  // SPEC-SKILLS Phase 5b wave 2 — the selection-side retype gate's honest UX (the SkillDetail unlock
  // clone, reactive: the server's 409 names the dropped protected skill(s); the operator retypes them
  // and saves again). The server's equality check is the boundary — this input only carries the text.
  const [retypeMsg, setRetypeMsg] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');

  const syncFrom = (v: ProjectSkillsView) => {
    setView(v);
    setBundleId(v.bundleId ?? '');
    setEnable(v.enable ?? {});
  };
  const load = useCallback(async () => {
    try {
      syncFrom(await tower.getProjectSkills(project.id));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [project.id, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  // Unsaved edits vs the last server view — guards the SSE refetch from clobbering a half-edited row.
  const dirty = view !== null && (bundleId !== (view.bundleId ?? '') || !enableEqual(enable, view.enable ?? {}));
  const firstSignal = useRef(true);
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false;
      return;
    }
    if (!dirty) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  const save = async () => {
    setBusy(true);
    try {
      // PUT replaces the whole overlay; an empty one = inherit the global set. confirmName is
      // wire-only — the server never stores it; it rides only while the retype gate is open.
      syncFrom(
        await tower.setProjectSkills(project.id, {
          ...(bundleId ? { bundleId } : {}),
          ...(Object.keys(enable).length ? { enable } : {}),
          ...(retypeMsg && confirmName ? { confirmName } : {}),
        }),
      );
      setRetypeMsg(null);
      setConfirmName('');
    } catch (e) {
      const gate = retypeGateMessage(e);
      if (gate) setRetypeMsg(gate);
      else onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Tri-state per-skill override: '' = inherit (absent), 'on' = enable:true, 'off' = enable:false.
  const overrideOf = (id: string): '' | 'on' | 'off' => (id in enable ? (enable[id] ? 'on' : 'off') : '');
  const setOverride = (id: string, v: '' | 'on' | 'off') =>
    setEnable((cur) => {
      const next = { ...cur };
      if (v === '') delete next[id];
      else next[id] = v === 'on';
      return next;
    });

  const bundleName = (id: string) => bundles.find((b) => b.id === id)?.name ?? id;
  const overrideCount = Object.keys(enable).length;
  const sortedSkills = skills.slice().sort((a, b) => a.name.localeCompare(b.name));
  const provenance = (e: EffectiveSkillEntry) =>
    e.source === 'project' ? 'this project' : e.source === 'bundle' ? `bundle "${bundleId ? bundleName(bundleId) : '?'}"` : 'global';

  return (
    <div className="prt-row">
      <div className="acct-row">
        <span className="acct-label">{project.name}</span>
        <span className="muted small mono">{project.repoPath}</span>
        <span className="spacer" />
        {view && (
          <span className={`chip ${bundleId || overrideCount ? 'question' : ''}`}>
            {bundleId ? `bundle: ${bundleName(bundleId)}` : 'inherit'}
            {overrideCount > 0 ? ` · ${overrideCount} override${overrideCount === 1 ? '' : 's'}` : ''}
          </span>
        )}
        {dirty && <span className="chip hold">unsaved</span>}
        <button className="btn-sm" onClick={onToggle}>{expanded ? 'close' : 'skills'}</button>
      </div>
      {expanded && (
        <div className="prt-body settings-form">
          {view === null ? (
            <div className="muted small">
              Loading… <button className="btn-sm" onClick={() => void load()}>retry</button>
            </div>
          ) : (
            <>
              {view.warnings.map((w, i) => (
                <span key={i} className="settings-warn">⚠ {w}</span>
              ))}
              <div className="field" style={{ maxWidth: 360 }}>
                <label>Bundle</label>
                <select value={bundleId} onChange={(e) => setBundleId(e.target.value)}>
                  <option value="">— none (global skills only) —</option>
                  {/* A dangling selection keeps its option so the select stays truthful; the server's
                      warnings above explain it. */}
                  {bundleId && !bundles.some((b) => b.id === bundleId) && (
                    <option value={bundleId}>(missing bundle {bundleId})</option>
                  )}
                  {bundles.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              {sortedSkills.length > 0 && (
                <div className="field">
                  <label>Per-skill overrides</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflow: 'auto' }}>
                    {sortedSkills.map((s) => (
                      <div key={s.id} className="acct-row" style={{ gap: 8 }}>
                        <span>{s.name}</span>
                        <span className="muted small mono">{s.id}</span>
                        {!s.enabled && <span className="chip hold" title="disabled in the library — an override cannot resurrect it">library-disabled</span>}
                        {s.scope === 'project' && <span className="chip" title="delivered to terminals in a later phase">project scope</span>}
                        <span className="spacer" />
                        <select value={overrideOf(s.id)} onChange={(e) => setOverride(s.id, e.target.value as '' | 'on' | 'off')}>
                          <option value="">inherit</option>
                          <option value="on">on</option>
                          <option value="off">off</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="field">
                <label>Effective skills for this project</label>
                {view.effective.length === 0 ? (
                  <span className="hint">None — no enabled skills are selected for this project.</span>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {view.effective.map((e) => (
                      <div key={e.id} className="acct-row" style={{ gap: 8 }}>
                        <span>{e.name}</span>
                        <span className="muted small mono">{e.id}</span>
                        <span className="chip">{provenance(e)}</span>
                        <span className="muted small">{e.providers.length ? e.providers.join(', ') : 'no provider reach'}</span>
                        {!e.delivered && <span className="chip hold" title="selected — delivered to terminals in a later phase">delivered in a later phase</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {retypeMsg && (
                <div className="field">
                  <span className="settings-warn">⚠ {retypeMsg}</span>
                  <input
                    className="mono small"
                    style={{ maxWidth: 280 }}
                    value={confirmName}
                    placeholder="retype the protected skill name(s)"
                    onChange={(e) => setConfirmName(e.target.value)}
                  />
                </div>
              )}
              <div>
                <button className="btn ok" disabled={busy || !dirty} onClick={() => void save()}>
                  {busy ? 'Saving…' : 'Save project skills'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Order-insensitive enable-map compare — a re-add reorders keys but is not a real edit (the routesEqual
 *  idiom for the tri-state override map). */
function enableEqual(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => k in b && a[k] === b[k]);
}
