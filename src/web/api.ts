// Thin API client. Fetches the per-session control-plane token once from
// /api/session (same-origin; a cross-origin page's Origin is rejected server-side)
// and attaches it as X-Tower-Token on every subsequent call.

import type {
  Project,
  Terminal,
  HealthReport,
  CreateTerminalRequest,
  SessionInfo,
  AttentionItem,
  ProviderId,
  StreamEvent,
  DiffSummary,
  AgentProfile,
  GitHubIdentity,
  SecurityStatus,
  ProjectSecurity,
  Loop,
  CreateLoopRequest,
  GlobalSettingsView,
  Mission,
  MissionPlanReview,
  MissionReport,
  CreateMissionRequest,
  CustomProviderId,
  PipelineRole,
  ProjectRouting,
  RoleAssignment,
  RoleRouting,
  WorkflowProfile,
  TestFailure,
  TestTriageEntry,
  Story,
  Skill,
  SkillWithBody,
  SkillDraft,
  SkillDraftMeta,
  SkillHistoryEntry,
  SkillHistoryMeta,
  UpsertSkillRequest,
  SkillImportReport,
  SkillBundle,
  ProjectSkills,
  EffectiveSkillEntry,
  Task,
  TaskStatus,
  CreateTaskRequest,
  FileListing,
  FileContent,
  PreviewMintResponse,
  ProjectTestingConfig,
  ProviderModelsView,
  ConsultKind,
  ConsultStatus,
  RepoBootstrapPlan,
  RepoBootstrapResult,
} from '../shared/types.js';
import type { RunwayConfig, RunwayStatus } from '../shared/runway.js';
import type {
  MemoryEntry,
  MemoryAddRequest,
  MemoryUpdateRequest,
  MemoryConsolidateRequest,
  MemorySearchQuery,
  MemoryStaleResponse,
} from '../shared/memory.js';
import type {
  ProviderDefInput,
  ProviderDefView,
  DiscoverResult,
  ProviderTestResult,
  WorkflowUpsert,
} from './ProvidersPanel.js';
// Stories wire shapes live in StoriesView.tsx (its INTEGRATOR CONTRACT header) — a web file, so we
// import rather than re-declare (the ProvidersPanel view-type precedent; StoriesView never imports api).
import type { StoryUpsert, StoryDraftResult, CoverageReport } from './StoriesView.js';

// `turnInferred` (D1/J5) is a COMPUTED, non-persisted signal from GET /api/terminals — whether
// the terminal's current idle was reached by inference (no completion signal), not on Terminal.
export type TerminalWithLiveness = Terminal & { alive: boolean; turnInferred?: boolean };

// SPEC-PLANNER §9 — the operator consult view returned by GET /api/consults (never answer bodies; the
// question is capped server-side at 200 chars). Drives the amber "waiting on planner" line + the detail.
export interface ConsultView {
  id: string;
  missionId: string;
  kind: ConsultKind;
  status: ConsultStatus;
  askedAt: string;
  deliveredAt?: string;
  deadline?: string;      // present while open (the active clock's absolute deadline)
  expireReason?: string;
  question: string;       // ≤200 chars
}

let sessionToken: string | null = null;

async function getToken(): Promise<string> {
  if (sessionToken) return sessionToken;
  const res = await fetch('/api/session');
  if (!res.ok) throw new Error(`session bootstrap failed (${res.status})`);
  const info = (await res.json()) as SessionInfo;
  sessionToken = info.token;
  return sessionToken;
}

export function currentToken(): string | null {
  return sessionToken;
}

/**
 * SPEC-SKILLS Phase 5b wave 2 — the selection retype gate's 409 detector + message extractor. api()
 * folds the response body into the Error text, so this recovers the server's `error` prose when it is
 * the retype-to-confirm refusal; the selection UIs answer it with a confirmName retype input instead
 * of a plain error toast. Keyed on the gate's fixed closing phrase (server.ts owns both messages).
 */
export function retypeGateMessage(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  const jsonPart = /\{.*\}$/s.exec(e.message);
  if (!jsonPart) return null;
  try {
    const body = JSON.parse(jsonPart[0]) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.includes('exactly to confirm')) return body.error;
  } catch {
    /* not a JSON error body */
  }
  return null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      'X-Tower-Token': token,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`${path} -> ${res.status} ${msg}`);
  }
  return res.json() as Promise<T>;
}

/**
 * SPEC-MEMORY — a revision-checked memory write was refused because its target changed since it was read
 * (HTTP 409 `{error:'stale', current}`). `current` is the entry as it stands now (entry routes) or the whole
 * view text (the whole-file PUT), so a panel can re-read/merge instead of clobbering. Thrown by memApi in
 * place of the generic folded-body Error so callers branch on it with `instanceof`; the message is prose
 * (never the raw JSON body) because onError paths print it verbatim.
 */
export class MemoryStaleError extends Error {
  constructor(path: string, readonly current: MemoryEntry | string) {
    super(`${path} -> 409: changed since it was loaded — re-read and retry`);
    this.name = 'MemoryStaleError';
  }
}

/** The server's `error` prose from an api() Error when the folded body is `{error: string}` (a 4xx refusal
 *  such as "source is disputed"), else the Error's own message. For onError paths that should read as a
 *  sentence rather than a path + JSON tail. */
export function apiErrorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const m = /\{.*\}$/s.exec(e.message);
  if (m) {
    try {
      const body = JSON.parse(m[0]) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) return body.error;
    } catch {
      /* not a JSON error body */
    }
  }
  return e.message;
}

/** Recover the stale 409 body from an api() Error (which folds the response text into its message — the
 *  retypeGateMessage precedent). Null for anything that is not a `{error:'stale', current}` 409. */
function staleBodyOf(e: unknown): MemoryStaleResponse | null {
  if (!(e instanceof Error)) return null;
  const m = / -> 409 (\{.*\})$/s.exec(e.message);
  if (!m) return null;
  try {
    const body = JSON.parse(m[1]!) as Partial<MemoryStaleResponse> & { current?: unknown };
    if (body.error === 'stale' && (typeof body.current === 'string' || (typeof body.current === 'object' && body.current !== null))) {
      return body as MemoryStaleResponse;
    }
  } catch {
    /* not a JSON error body */
  }
  return null;
}

/** api() for the memory routes: identical, except a stale 409 surfaces as MemoryStaleError. */
async function memApi<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await api<T>(path, init);
  } catch (e) {
    const stale = staleBodyOf(e);
    if (stale) throw new MemoryStaleError(path, stale.current);
    throw e;
  }
}

/** Build the `?q&kind&lifecycle&verification&sinceSeq` querystring for GET /api/memory/:id/entries. */
function memoryQuery(q?: MemorySearchQuery): string {
  if (!q) return '';
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.kind) p.set('kind', q.kind);
  if (q.lifecycle) p.set('lifecycle', q.lifecycle);
  if (q.verification) p.set('verification', q.verification);
  if (q.sinceSeq !== undefined) p.set('sinceSeq', String(q.sinceSeq));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface AdapterInfo {
  id: ProviderId;
  displayName: string;
  supportsAutoAccept?: boolean;
}

// Token-fetch one run file's raw Response. Both the artifacts (SPEC-TESTING §6) and logs (SPEC-LOOP
// W5) routes are HEADER-token gated (no ?token carve-out), so a plain <img src>/<a href> would 401 —
// every byte-read goes through here with X-Tower-Token. `sub` selects the run subtree. Shared by
// downloadTestArtifact/downloadTestLog (→ res.blob() forced download) and fetchTestArtifactBlob
// (→ res.arrayBuffer() for the in-app thumbnail blob).
async function fetchRunFileResponse(runId: string, sub: 'artifacts' | 'logs', name: string): Promise<Response> {
  const token = await getToken();
  const url = `/api/testruns/${encodeURIComponent(runId)}/${sub}/${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { 'X-Tower-Token': token } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res;
}

// SPEC-TESTING-V2 §5 — the strict image-extension allowlist for the artifact thumbnail. SVG is
// deliberately EXCLUDED (png/jpg/jpeg/webp/gif only) to keep the allowlist trivially safe: a
// polyglot artifact named .png is typed image/png by mimeForImage → the decoder rejects it →
// broken image, never script. Non-images (incl. SVG) keep the download chip.
function artifactExt(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}
const IMAGE_ARTIFACT_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
export function isImageArtifact(name: string): boolean {
  return IMAGE_ARTIFACT_EXTS.has(artifactExt(name));
}
/** The image MIME to type the blob with — derived SOLELY from OUR ext allowlist (never the server
 *  Content-Type), so a mistyped/polyglot artifact can't smuggle a scriptable type. Only call on a
 *  name that passed `isImageArtifact`. */
export function mimeForImage(name: string): string {
  const e = artifactExt(name);
  return e === 'jpg' ? 'image/jpeg' : `image/${e}`;
}

// ---- Per-project routing wire shapes (SPEC-ROUTING §4) ----

/** One role's server-resolved route in `ProjectRoutingView.effective`. `model` is the RESOLVED
 *  slug (post-specificity-gate) — when it fell back to the provider's own defaultModel the
 *  server flags `modelSource:'default'` (the drop), so the UI can say "model not
 *  inherited" instead of implying a lower-tier model rode along. */
export interface EffectiveRoleRoute {
  provider: ProviderId;
  model?: string;
  /** SPEC-EFFORT §1 — the winning layer's own effort (server view parity; additive, no consumer change). */
  effort?: string;
  source: 'project' | 'workflow' | 'global';
  modelSource?: 'default';
  /** SPEC-TESTING §1.2 — the resolved account for this role (the provider-MATCH-gated chain);
   *  absent = the shared per-provider login dir. `profileLabel` is display-only enrichment. */
  profileId?: string;
  profileLabel?: string;
}

/** GET/PUT `/api/projects/:id/routing` response: the stored overlay (`workflowId`/`routes`)
 *  plus the resolved view. `effective` is a PARTIAL map — only roles configured at some layer
 *  appear; unset roles are OMITTED so client previews fall through their own
 *  sortie/mission tiers. `warnings` carries per-role route warnings (missing secret etc.) plus
 *  the dangling-workflowId surfacing. */
export interface ProjectRoutingView extends ProjectRouting {
  effective: Partial<Record<PipelineRole, EffectiveRoleRoute>>;
  warnings: string[];
}

// ---- Per-project skill selection wire shapes (SPEC-SKILLS Phase 3) ----

/** A bundle create/replace body — the WorkflowUpsert mirror (server stamps createdAt/updatedAt). */
export type SkillBundleUpsert = Omit<SkillBundle, 'createdAt' | 'updatedAt'>;

/** GET/PUT `/api/projects/:id/skills` response: the stored overlay (`bundleId`/`enable`) plus the
 *  resolved `effective` set (per-entry provenance, provider reach, and the `delivered` flag — false
 *  for a non-global entry that awaits the per-project delivery sub-phase) and dangling-selection
 *  `warnings`. The ProjectRoutingView mirror. */
export interface ProjectSkillsView extends ProjectSkills {
  effective: EffectiveSkillEntry[];
  warnings: string[];
}

export const tower = {
  bootstrapToken: getToken,
  health: () => api<HealthReport>('/api/health'),
  listAdapters: () => api<AdapterInfo[]>('/api/adapters'),
  listProjects: () => api<Project[]>('/api/projects'),
  createProject: (body: { name: string; repoPath: string; repoUrl?: string; defaultIdentityId?: string }) =>
    api<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  setProjectArchived: (id: string, archived: boolean) =>
    api<Project>(`/api/projects/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }),
  // Per-project GitHub config: only the keys sent change (null clears one). Project records now carry
  // both fields, so there is no separate GET.
  setProjectGithub: (id: string, cfg: { repoUrl?: string | null; defaultIdentityId?: string | null }) =>
    api<Project>(`/api/projects/${encodeURIComponent(id)}/github`, { method: 'POST', body: JSON.stringify(cfg) }),
  setProjectAutoAccept: (id: string, enabled: boolean) =>
    api<Project>(`/api/projects/${encodeURIComponent(id)}/auto-accept`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  // Repo bootstrap (SPEC-INITPUSH): a read-only preflight that powers the preview, and the mutating execute.
  bootstrapPreflight: (id: string) =>
    api<RepoBootstrapPlan>(`/api/projects/${encodeURIComponent(id)}/bootstrap/preflight`),
  bootstrapRepo: (id: string, acceptWarnings: boolean) =>
    api<RepoBootstrapResult>(`/api/projects/${encodeURIComponent(id)}/bootstrap`, { method: 'POST', body: JSON.stringify({ acceptWarnings }) }),
  listTerminals: () => api<TerminalWithLiveness[]>('/api/terminals'),
  createTerminal: (body: CreateTerminalRequest) =>
    api<Terminal>('/api/terminals', { method: 'POST', body: JSON.stringify(body) }),
  killTerminal: (id: string) => api<{ ok: boolean }>(`/api/terminals/${id}/kill`, { method: 'POST' }),
  // SPEC-RESTART — respawn the terminal's CLI in place (same worktree/account/loop; the in-flight
  // turn is discarded). NOT a kill: a bound loop keeps running. `resumed` — claude-code work/planner
  // panes only — reports whether the fresh process resumed the SAME conversation (a transcript still
  // existed) or had to start a new one. `alreadyRestarting` — a concurrent call landed on a restart
  // already in flight for this terminal; it was a no-op (the first call owns the outcome), so
  // `resumed` is absent on this shape.
  restartTerminal: (id: string) =>
    api<{ ok: boolean; resumed?: boolean; alreadyRestarting?: boolean }>(`/api/terminals/${id}/restart`, { method: 'POST' }),
  attention: () => api<AttentionItem[]>('/api/attention'),
  reply: (id: string, text: string) =>
    api<{ ok: boolean }>(`/api/terminals/${id}/reply`, { method: 'POST', body: JSON.stringify({ text }) }),
  approve: (id: string) => api<{ ok: boolean }>(`/api/terminals/${id}/approve`, { method: 'POST' }),
  deny: (id: string) => api<{ ok: boolean }>(`/api/terminals/${id}/deny`, { method: 'POST' }),
  // Review & Land
  review: (id: string) => api<DiffSummary>(`/api/terminals/${id}/review`),
  patch: async (id: string, file?: string): Promise<string> => {
    const token = await getToken();
    const q = file ? `?file=${encodeURIComponent(file)}` : '';
    const res = await fetch(`/api/terminals/${id}/patch${q}`, { headers: { 'X-Tower-Token': token } });
    if (!res.ok) throw new Error(`patch ${res.status}`);
    return res.text();
  },
  requestChanges: (id: string, text: string) =>
    api<{ ok: boolean }>(`/api/terminals/${id}/request-changes`, { method: 'POST', body: JSON.stringify({ text }) }),
  land: (id: string, mode: 'merge' | 'pr', title?: string) =>
    api<{ mode: string; detail: string; prUrl?: string }>(`/api/terminals/${id}/land`, {
      method: 'POST',
      body: JSON.stringify({ mode, title }),
    }),
  removeWorktree: (id: string) => api<{ removed: boolean; dirty: boolean }>(`/api/terminals/${id}/worktree/remove`, { method: 'POST' }),
  // Loops (iterate-until-done)
  listLoops: () => api<Loop[]>('/api/loops'),
  getLoop: (id: string) => api<Loop>(`/api/loops/${id}`),
  createLoop: (body: CreateLoopRequest) => api<Loop>('/api/loops', { method: 'POST', body: JSON.stringify(body) }),
  loopContinue: (id: string, note?: string) =>
    api<Loop>(`/api/loops/${id}/continue`, { method: 'POST', body: JSON.stringify({ note }) }),
  loopLand: (id: string, mode: 'merge' | 'pr' = 'merge', title?: string) =>
    api<Loop>(`/api/loops/${id}/land`, { method: 'POST', body: JSON.stringify({ mode, title }) }),
  loopPause: (id: string) => api<Loop>(`/api/loops/${id}/pause`, { method: 'POST' }),
  loopResume: (id: string) => api<Loop>(`/api/loops/${id}/resume`, { method: 'POST' }),
  loopStep: (id: string) => api<Loop>(`/api/loops/${id}/step`, { method: 'POST' }),
  loopStop: (id: string) => api<Loop>(`/api/loops/${id}/stop`, { method: 'POST' }),
  // Missions + autopilot (SPEC-FACTORY §2)
  listMissions: () => api<Mission[]>('/api/missions'),
  getMission: (id: string) => api<Mission>(`/api/missions/${id}`),
  createMission: (body: CreateMissionRequest) =>
    api<Mission>('/api/missions', { method: 'POST', body: JSON.stringify(body) }),
  startMission: (id: string) => api<Mission>(`/api/missions/${id}/start`, { method: 'POST' }),
  /** SPEC-LOOP W3 (G4) — grade a DRAFT mission's plan with the codex Brain (two read-only lenses:
   *  fact-check + red-team) before it can start. 404 unknown; 409 not-a-draft OR a review already in
   *  flight; 502 when the grader/planner errors (no review stored — never fabricated); 503 when no
   *  assistant Brain is available. Idempotent — returns a stored PASS for the current plan immediately —
   *  unless `force`, which re-grades (a BLOCKED review always re-grades and may auto-redraft once).
   *  Session-token only (LLM spend is operator-only). */
  reviewPlan: (id: string, force?: boolean) =>
    api<{ planReview: MissionPlanReview }>(`/api/missions/${id}/review-plan`, {
      method: 'POST', ...(force ? { body: JSON.stringify({ force: true }) } : {}) }),
  pauseMission: (id: string) => api<Mission>(`/api/missions/${id}/pause`, { method: 'POST' }),
  abortMission: (id: string) => api<Mission>(`/api/missions/${id}/abort`, { method: 'POST' }),
  advanceMission: (id: string) => api<Mission>(`/api/missions/${id}/advance`, { method: 'POST' }),
  retrySortie: (id: string, sortieId: string) =>
    api<Mission>(`/api/missions/${id}/sorties/${sortieId}/retry`, { method: 'POST' }),
  // SPEC-PLANNER §3/§9 — the planner-consult operator surface. attach adopts an idle, loop-free pane;
  // detach falls back to the codex Brain (an explicit choice); listConsults drives the amber waiting line.
  attachPlanner: (id: string, terminalId: string) =>
    api<Mission & { preflight?: string }>(`/api/missions/${id}/planner/attach`, { method: 'POST', body: JSON.stringify({ terminalId }) }),
  detachPlanner: (id: string) => api<Mission>(`/api/missions/${id}/planner/detach`, { method: 'POST' }),
  listConsults: (missionId?: string) =>
    api<{ consults: ConsultView[] }>(`/api/consults${missionId ? `?missionId=${encodeURIComponent(missionId)}` : ''}`).then((r) => r.consults),
  planMission: (projectId: string, goal: string) =>
    // The route returns { phases } — unwrap so consumers get the bare array they type against.
    api<{ phases: CreateMissionRequest['phases'] }>('/api/missions/plan', {
      method: 'POST',
      body: JSON.stringify({ projectId, goal }),
    }).then((r) => r.phases),
  /** SPEC-LOOP W4 — the mission's delivery report JSON, or null when absent. 404 → null (NOT an error):
   *  the report is written fire-and-forget at the done/failed transition, so a crash/GC race can 404 —
   *  the view renders "report pending" rather than a broken link (§3 W4 — never an html iframe). */
  getMissionReport: async (id: string): Promise<MissionReport | null> => {
    const token = await getToken();
    const res = await fetch(`/api/missions/${encodeURIComponent(id)}/report`, { headers: { 'X-Tower-Token': token } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`/api/missions/${id}/report -> ${res.status}`);
    return res.json() as Promise<MissionReport>;
  },
  /** SPEC-LOOP W4 — download the standalone REPORT.html. The route is DOWNLOAD-ONLY (attachment +
   *  octet-stream) and header-token gated, so a plain <a href> would 401: fetch with X-Tower-Token and
   *  save via an ephemeral blob URL (the downloadTestArtifact idiom — the token never enters a URL). */
  downloadMissionReportHtml: async (id: string): Promise<void> => {
    const token = await getToken();
    const res = await fetch(`/api/missions/${encodeURIComponent(id)}/report/html`, { headers: { 'X-Tower-Token': token } });
    if (!res.ok) throw new Error(`/api/missions/${id}/report/html -> ${res.status}`);
    const objUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = `REPORT-${id}.html`;
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      setTimeout(() => { a.remove(); URL.revokeObjectURL(objUrl); }, 1000);
    }
  },
  /** SPEC-LOOP W4 — token-fetch one proof file's raw bytes (the fetchTestArtifactBlob idiom: header-token
   *  gated, so a plain <a href> would 401). Returns the Blob; the caller builds/revokes the object URL. */
  fetchMissionProofBlob: async (id: string, name: string): Promise<Blob> => {
    const token = await getToken();
    const url = `/api/missions/${encodeURIComponent(id)}/report/proof/${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: { 'X-Tower-Token': token } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.blob();
  },
  // Custom providers + routing (SPEC-PROVIDERS §1/§2/§3/§4). ids are custom:<slug> — encoded.
  listProviders: () => api<ProviderDefView[]>('/api/providers'),
  upsertProvider: (def: ProviderDefInput) =>
    api<ProviderDefView>(`/api/providers/${encodeURIComponent(def.id)}`, { method: 'PUT', body: JSON.stringify(def) }),
  removeProvider: (id: CustomProviderId) => api<void>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setProviderSecret: (id: CustomProviderId, key: string, value: string) =>
    api<void>(`/api/providers/${encodeURIComponent(id)}/secrets/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  clearProviderSecret: (id: CustomProviderId, key: string) =>
    api<void>(`/api/providers/${encodeURIComponent(id)}/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  discoverModels: (id: CustomProviderId) => api<DiscoverResult>(`/api/providers/${encodeURIComponent(id)}/models`),
  // SPEC-MODELS §1 — the unified roster read (ZERO egress; every ModelSelect mounts on it) + the operator-only
  // refresh (the ONLY egress: a codex catalog GET with the account's token, server-side). getProviderModels
  // takes any ProviderId (built-ins + custom); refresh's `profileId` pins which codex login to query.
  getProviderModels: (id: ProviderId, profileId?: string) =>
    api<ProviderModelsView>(`/api/models/${encodeURIComponent(id)}${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''}`),
  refreshProviderModels: (id: ProviderId, profileId?: string) =>
    api<DiscoverResult>(`/api/models/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: JSON.stringify({ profileId }) }),
  testProvider: (id: CustomProviderId) =>
    api<ProviderTestResult>(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  loginProvider: (id: CustomProviderId) =>
    api<{ id: string }>(`/api/providers/${encodeURIComponent(id)}/login`, { method: 'POST' }),
  getRouting: () => api<RoleRouting>('/api/routing'),
  setRouting: (routing: RoleRouting) => api<RoleRouting>('/api/routing', { method: 'PUT', body: JSON.stringify(routing) }),
  setRoutingRole: (role: PipelineRole, a: RoleAssignment) =>
    api<RoleRouting>(`/api/routing/${encodeURIComponent(role)}`, { method: 'PUT', body: JSON.stringify(a) }),
  clearRoutingRole: (role: PipelineRole) =>
    api<RoleRouting>(`/api/routing/${encodeURIComponent(role)}`, { method: 'DELETE' }),
  // Workflows + per-project routing (SPEC-ROUTING §4). Workflow ids are client-minted; upsert is
  // PUT-to-id create-or-replace (the providers idiom; server stamps createdAt/updatedAt). DELETE
  // refuses with 409 (listing the referencing project names) while any project selects it.
  listWorkflows: () => api<WorkflowProfile[]>('/api/workflows'),
  getWorkflow: (id: string) => api<WorkflowProfile>(`/api/workflows/${encodeURIComponent(id)}`),
  upsertWorkflow: (w: WorkflowUpsert) =>
    api<WorkflowProfile>(`/api/workflows/${encodeURIComponent(w.id)}`, { method: 'PUT', body: JSON.stringify(w) }),
  deleteWorkflow: (id: string) => api<void>(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // PUT is a full replace of the project's overlay: omit `workflowId` to clear the selection,
  // omit/empty `routes` to clear the ad-hoc overrides — "empty overlay = inherit global" (§6).
  getProjectRouting: (projectId: string) =>
    api<ProjectRoutingView>(`/api/projects/${encodeURIComponent(projectId)}/routing`),
  setProjectRouting: (projectId: string, overlay: ProjectRouting) =>
    api<ProjectRoutingView>(`/api/projects/${encodeURIComponent(projectId)}/routing`, {
      method: 'PUT',
      body: JSON.stringify(overlay),
    }),
  // Per-project e2e testing config (SPEC-TESTING §4). PUT is a full replace like
  // setProjectRouting — an empty config drops the project's entry.
  getProjectTesting: (projectId: string) =>
    api<ProjectTestingConfig>(`/api/projects/${encodeURIComponent(projectId)}/testing`),
  setProjectTesting: (projectId: string, cfg: ProjectTestingConfig) =>
    api<ProjectTestingConfig>(`/api/projects/${encodeURIComponent(projectId)}/testing`, {
      method: 'PUT',
      body: JSON.stringify(cfg),
    }),
  // Per-project isolation
  projectSecurity: (id: string) => api<ProjectSecurity>(`/api/projects/${id}/security`),
  setIsolation: (id: string, mode: 'per-agent-uid' | 'single-uid') =>
    api<ProjectSecurity>(`/api/projects/${id}/isolation`, { method: 'POST', body: JSON.stringify({ mode }) }),
  // Accounts, identities, security (M4)
  security: () => api<SecurityStatus>('/api/security'),
  listProfiles: () => api<AgentProfile[]>('/api/profiles'),
  /** Per agent provider, whether the SHARED (no-account) login is signed in (GET /api/profiles/shared-login). */
  sharedLoginStatus: () => api<Record<string, boolean>>('/api/profiles/shared-login'),
  createProfile: (provider: ProviderId, label: string) =>
    api<AgentProfile>('/api/profiles', { method: 'POST', body: JSON.stringify({ provider, label }) }),
  loginProfile: (id: string) => api<Terminal>(`/api/profiles/${id}/login`, { method: 'POST' }),
  // Rename a provider account's display label (label-only; the credential dir + live bindings are untouched).
  renameProfile: (id: string, label: string) =>
    api<AgentProfile>(`/api/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ label }) }),
  // SPEC-TERMINAL-OPS §1.2 — `shredded: false` means the record is gone but its credential dir could
  // NOT be removed; the caller must surface that rather than report a clean removal. `force` overrides
  // the 409 refusals (a live terminal runs as this account / it is the assistant Brain account).
  deleteProfile: (id: string, opts?: { force?: boolean }) =>
    api<{ ok: boolean; shredded?: boolean }>(`/api/profiles/${id}${opts?.force ? '?force=true' : ''}`, { method: 'DELETE' }),
  // Quick Connect: shared machine-login adopt + OSS-runner preflight (SPEC-ONBOARDING §2/§1).
  // machineLoginStatus reports which built-ins have a copyable login on this machine; adoptMachineLogin
  // copies it into the profile's isolated configDir (no second /login); runnerPresent is the Tile-2
  // preflight that gates the agent flow on a runner (e.g. aider) being on PATH.
  machineLoginStatus: () => api<Record<'claude-code' | 'codex', boolean>>('/api/profiles/machine-login'),
  adoptMachineLogin: (id: string) =>
    api<{ ok: boolean }>(`/api/profiles/${id}/adopt-login`, { method: 'POST' }),
  runnerPresent: (cmd: string) =>
    api<{ present: boolean }>(`/api/runner-check?cmd=${encodeURIComponent(cmd)}`),
  listIdentities: () => api<GitHubIdentity[]>('/api/identities'),
  createIdentity: (label: string, gitName: string, gitEmail: string) =>
    api<GitHubIdentity>('/api/identities', { method: 'POST', body: JSON.stringify({ label, gitName, gitEmail }) }),
  setCredential: (id: string, token: string) =>
    api<{ ok: boolean }>(`/api/identities/${id}/credential`, { method: 'POST', body: JSON.stringify({ token }) }),
  revokeCredential: (id: string) => api<{ ok: boolean }>(`/api/identities/${id}/credential`, { method: 'DELETE' }),
  deleteIdentity: (id: string) => api<{ ok: boolean }>(`/api/identities/${id}`, { method: 'DELETE' }),
  // Coordination (M5)
  mailInbox: (terminalId: string) =>
    api<{ id: string; from: string; fromLabel: string; body: string; ts: string; read: boolean }[]>(`/api/mail/${terminalId}`),
  sendMail: (toTerminalId: string, body: string) =>
    api<unknown>('/api/mail', { method: 'POST', body: JSON.stringify({ toTerminalId, body }) }),
  markMailRead: (terminalId: string) => api<{ ok: boolean }>(`/api/mail/${terminalId}/read`, { method: 'POST' }),
  memory: (projectId: string) => api<Record<string, string>>(`/api/memory/${projectId}`),
  // SPEC-FLIGHTLINE-V2 §4 — per-file freshness metadata (mtime/size) for the MemoryBar recency dot; a
  // !res.ok throw drives the bar's degrade-to-has-content fallback. The `memory` shape above is unchanged.
  memoryMeta: (projectId: string) =>
    api<Record<string, { mtimeMs: number; size: number }>>(`/api/memory/${projectId}/meta`),
  writeMemory: (projectId: string, file: string, content: string) =>
    memApi<{ ok: boolean }>(`/api/memory/${projectId}/${file}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  // SPEC-MEMORY — the entry-level operator surface behind the three generated views. All session-token
  // routes. Every write that names an entry carries the caller's expected `rev`; a stale one is refused
  // with 409 → MemoryStaleError (carrying the current entry) rather than a silent clobber.
  memoryEntries: (projectId: string, query?: MemorySearchQuery) =>
    memApi<MemoryEntry[]>(`/api/memory/${encodeURIComponent(projectId)}/entries${memoryQuery(query)}`),
  addMemoryEntry: (projectId: string, req: MemoryAddRequest) =>
    memApi<MemoryEntry>(`/api/memory/${encodeURIComponent(projectId)}/entries`, { method: 'POST', body: JSON.stringify(req) }),
  // The entry id rides in the path; the body is the update minus `id` (rev + changed fields only).
  updateMemoryEntry: (projectId: string, id: string, patch: Omit<MemoryUpdateRequest, 'id'>) =>
    memApi<MemoryEntry>(`/api/memory/${encodeURIComponent(projectId)}/entries/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  // Fold `sources` (each pinned at its rev) into one new summary entry; the sources become superseded.
  // 409 with prose (not stale) when a source is disputed or moved on — surfaced as the plain Error.
  consolidateMemory: (projectId: string, req: MemoryConsolidateRequest) =>
    memApi<MemoryEntry>(`/api/memory/${encodeURIComponent(projectId)}/consolidate`, { method: 'POST', body: JSON.stringify(req) }),
  // Undo a consolidation: the summary (at `rev`) is retracted and its sources return to active.
  unconsolidateMemory: (projectId: string, id: string, rev: number) =>
    memApi<{ ok: boolean }>(`/api/memory/${encodeURIComponent(projectId)}/unconsolidate/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ rev }),
    }),
  searchLogs: (q: string) => api<{ terminalId: string; line: string }[]>(`/api/search?q=${encodeURIComponent(q)}`),
  testRuns: () => api<TestRunInfo[]>('/api/testruns'),
  testCapacity: () => api<{ capacity: number; active: number }>('/api/test/capacity'),
  /** SPEC-TESTING §5 — file a run's parsed failures to the backlog (manual button). 404 unknown
   *  run; 409 when the run has no parsed results (never fabricate); else {created, skipped}. */
  fileTestFailures: (runId: string) =>
    api<{ created: number; skipped: number }>(
      `/api/testruns/${encodeURIComponent(runId)}/file-failures`, { method: 'POST' }),
  /** SPEC-TESTING-V2 §1 — on-demand LLM triage of a run's failures (display-only). 404 unknown run;
   *  409 unless the run has parsed results with failures (never fabricated), or a summarize is
   *  already in flight; 503 when no assistant Brain is available. Idempotent — returns an existing
   *  summary immediately — unless `force`, which regenerates over the stored one (the panel's
   *  Re-summarize button). Session-token only (LLM spend is operator-only). */
  summarizeRun: (runId: string, force?: boolean) =>
    api<{ summary: string }>(
      `/api/testruns/${encodeURIComponent(runId)}/summarize`,
      { method: 'POST', ...(force ? { body: JSON.stringify({ force: true }) } : {}) }),
  /** SPEC-TESTING §6 — download one run artifact (screenshot/trace). The route is session-token
   *  gated by the HEADER, so a plain <a href> would 401: fetch with X-Tower-Token and save via an
   *  ephemeral blob URL (the downloadFile idiom — the token never enters a URL). */
  downloadTestArtifact: async (runId: string, name: string): Promise<void> => {
    const res = await fetchRunFileResponse(runId, 'artifacts', name);
    const objUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = name.split('/').pop() || 'artifact';
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      // Defer cleanup — revoking in the click frame can cancel the download (see downloadFile).
      setTimeout(() => { a.remove(); URL.revokeObjectURL(objUrl); }, 1000);
    }
  },
  /** SPEC-LOOP W5 — download one run's captured log (server/docker tail). Same header-token gate as
   *  downloadTestArtifact (the route is session-token only — log contents carry secrets): fetch with
   *  X-Tower-Token and save via an ephemeral blob URL so the token never enters a URL. */
  downloadTestLog: async (runId: string, name: string): Promise<void> => {
    const res = await fetchRunFileResponse(runId, 'logs', name);
    const objUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = name.split('/').pop() || 'log';
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      // Defer cleanup — revoking in the click frame can cancel the download (see downloadFile).
      setTimeout(() => { a.remove(); URL.revokeObjectURL(objUrl); }, 1000);
    }
  },
  /** SPEC-TESTING-V2 §5 — token-fetch an artifact's raw BYTES for the in-app thumbnail. Returns the
   *  ArrayBuffer (NOT a blob) so the caller is the sole type source (mimeForImage), never the server
   *  Content-Type. The caller MUST build/revoke the object URL in a useEffect (the poll re-renders
   *  every row, so a render-body createObjectURL would leak) — this only fetches. */
  fetchTestArtifactBlob: (runId: string, name: string): Promise<ArrayBuffer> =>
    fetchRunFileResponse(runId, 'artifacts', name).then((res) => res.arrayBuffer()),
  // Stories: user-story corpus CRUD + Jarvis draft + derived four-state coverage (SPEC-STORYLOOP §1).
  // upsert splits on `id`: present → PUT (patch), absent → POST (create; server mints id/timestamps).
  listStories: (projectId: string) => api<Story[]>(`/api/stories?projectId=${encodeURIComponent(projectId)}`),
  upsertStory: (input: StoryUpsert) =>
    input.id
      ? api<Story>(`/api/stories/${encodeURIComponent(input.id)}`, { method: 'PUT', body: JSON.stringify(input) })
      : api<Story>('/api/stories', { method: 'POST', body: JSON.stringify(input) }),
  removeStory: (id: string) => api<void>(`/api/stories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  draftStories: (projectId: string, goal?: string) =>
    // The route returns { drafts, note? } (200 even on drafter failure, with a note explaining why).
    // Return the full shape so the view can surface the note instead of a generic "no behaviors" copy.
    api<StoryDraftResult>('/api/stories/draft', {
      method: 'POST',
      body: JSON.stringify({ projectId, goal }),
    }),
  storyCoverage: (projectId: string) =>
    api<CoverageReport>(`/api/stories/coverage?projectId=${encodeURIComponent(projectId)}`),
  // Skills: the canonical skill library (SPEC-SKILLS). list is META only; getSkill returns the body.
  // upsert splits on `id`: present → PUT (patch/create at that id), absent → POST (mint a slug).
  listSkills: () => api<Skill[]>('/api/skills'),
  getSkill: (id: string) => api<SkillWithBody>(`/api/skills/${encodeURIComponent(id)}`),
  upsertSkill: (input: UpsertSkillRequest) =>
    input.id
      ? api<Skill>(`/api/skills/${encodeURIComponent(input.id)}`, { method: 'PUT', body: JSON.stringify(input) })
      : api<Skill>('/api/skills', { method: 'POST', body: JSON.stringify(input) }),
  // confirmName (here and below): the retype-the-name gate — required by the server when the target
  // skill is protected (operator lock or blocking gate); the typed value must equal the exact name.
  removeSkill: (id: string, confirmName?: string) =>
    api<void>(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      ...(confirmName !== undefined ? { body: JSON.stringify({ confirmName }) } : {}),
    }),
  // Autonomy clearance (SPEC-SKILLS Phase 5b wave 2): the operator-only attestation that an
  // assistant-authored body may reach skip-permissions agents. Session-token route; no assistant
  // action can even propose it.
  setSkillAutonomyCleared: (id: string, cleared: boolean, confirmName?: string) =>
    api<Skill>(`/api/skills/${encodeURIComponent(id)}/autonomy-cleared`, {
      method: 'POST',
      body: JSON.stringify({ cleared, ...(confirmName !== undefined ? { confirmName } : {}) }),
    }),
  // Per-skill version history + rollback (SPEC-SKILLS Phase 5b wave 2). The list is META only
  // (bodyBytes, no body); the entry carries the verbatim prior body for the panel's preview;
  // rollback restores an entry as a normal forward upsert (append-only — version increments).
  getSkillHistory: (id: string) => api<SkillHistoryMeta[]>(`/api/skills/${encodeURIComponent(id)}/history`),
  getSkillHistoryEntry: (id: string, version: number) =>
    api<SkillHistoryEntry>(`/api/skills/${encodeURIComponent(id)}/history/${version}`),
  rollbackSkill: (id: string, version: number, confirmName?: string) =>
    api<Skill>(`/api/skills/${encodeURIComponent(id)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ version, ...(confirmName !== undefined ? { confirmName } : {}) }),
    }),
  importSkills: () => api<SkillImportReport>('/api/skills/import', { method: 'POST' }),
  // Assistant skill drafts (SPEC-SKILLS Phase 5b): list is META (bodyBytes, no body); getSkillDraft
  // returns the full draft for the promote card's live diff + the drafts strip's viewer; discard is
  // the operator's session-token DELETE (the scoped assistant token can save but never destroy).
  listSkillDrafts: () => api<SkillDraftMeta[]>('/api/assistant/skill-drafts'),
  getSkillDraft: (id: string) => api<SkillDraft>(`/api/assistant/skill-drafts/${encodeURIComponent(id)}`),
  discardSkillDraft: (id: string) =>
    api<{ ok: boolean }>(`/api/assistant/skill-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Skill bundles + per-project skill selection (SPEC-SKILLS Phase 3). Bundle ids are client-minted;
  // upsert is PUT-to-id create-or-replace (the workflows idiom). deleteSkillBundle refuses with 409
  // (listing referencing project names) while any project selects it. setProjectSkills is a full
  // REPLACE of the overlay — an empty one = inherit the global set. Both writes take the wire-only
  // confirmName rider for the selection-side retype gate (Phase 5b wave 2): the server 409s a change
  // that would drop a protected skill from an effective set until the dropped name(s) are retyped.
  listSkillBundles: () => api<SkillBundle[]>('/api/skill-bundles'),
  upsertSkillBundle: (b: SkillBundleUpsert & { confirmName?: string }) =>
    api<SkillBundle>(`/api/skill-bundles/${encodeURIComponent(b.id)}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteSkillBundle: (id: string) => api<void>(`/api/skill-bundles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getProjectSkills: (projectId: string) =>
    api<ProjectSkillsView>(`/api/projects/${encodeURIComponent(projectId)}/skills`),
  setProjectSkills: (projectId: string, overlay: ProjectSkills & { confirmName?: string }) =>
    api<ProjectSkillsView>(`/api/projects/${encodeURIComponent(projectId)}/skills`, {
      method: 'PUT',
      body: JSON.stringify(overlay),
    }),
  // Backlog: stored pre-execution kanban lanes + the archive layer (SPEC-BACKLOG §5).
  listTasks: () => api<Task[]>('/api/backlog'),
  createTask: (req: CreateTaskRequest) =>
    api<Task>('/api/backlog', { method: 'POST', body: JSON.stringify(req) }),
  updateTask: (id: string, patch: { title?: string; body?: string; priority?: 0 | 1 | 2 | 3 | null; status?: TaskStatus }) =>
    // priority null = clear back to unranked (absent = unchanged; the store's transition contract).
    api<Task>(`/api/backlog/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  archiveLoop: (id: string) =>
    api<Loop>(`/api/loops/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
  archiveMission: (id: string) =>
    api<Mission>(`/api/missions/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
  clearFinished: () =>
    api<{ loops: number; missions: number }>('/api/board/clear-finished', { method: 'POST' }),
  // Project files (SPEC-FILES §1) — browse/view a project repo or a terminal's worktree.
  // `worktreeOf` is a TERMINAL id: it rides as `wt=term:<id>`; absent → the project repo root.
  // View-only (§8): there is deliberately no write/edit method here.
  listFiles: (projectId: string, path = '', worktreeOf?: string) =>
    api<FileListing>(`/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}${
      worktreeOf ? `&wt=${encodeURIComponent(`term:${worktreeOf}`)}` : ''}`),
  readFile: (projectId: string, path: string, worktreeOf?: string) =>
    api<FileContent>(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}${
      worktreeOf ? `&wt=${encodeURIComponent(`term:${worktreeOf}`)}` : ''}`),
  /** Download a file via the streamed raw route (route C — octet-stream + attachment). Route C is
   *  token-gated by the HEADER (it is not token-exempt), so we fetch with X-Tower-Token and save via
   *  an ephemeral blob URL. We deliberately do NOT put the token in the URL: a click would 401 (no
   *  header) and the full session token would leak into browser history / server access logs. */
  downloadFile: async (projectId: string, path: string, worktreeOf?: string): Promise<void> => {
    const token = await getToken();
    const url = `/api/projects/${encodeURIComponent(projectId)}/file/raw?path=${encodeURIComponent(path)}${
      worktreeOf ? `&wt=${encodeURIComponent(`term:${worktreeOf}`)}` : ''}`;
    const res = await fetch(url, { headers: { 'X-Tower-Token': token } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    const objUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = path.split('/').pop() || 'download';
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      // Defer cleanup — revoking the object URL in the same frame as click() can cancel the
      // download in Firefox/WebKit before the navigation captures the blob.
      setTimeout(() => { a.remove(); URL.revokeObjectURL(objUrl); }, 1000);
    }
  },
  /** Mint a short-lived capability grant for the sandboxed artifact preview (SPEC-FILES §4).
   *  The returned `url` is RELATIVE (`/preview/<pid>/<basename>`) — use it as-is for the iframe
   *  src / window.open so it resolves against the serving origin in both dev and prod. */
  mintPreview: (projectId: string, path: string, worktreeOf?: string) =>
    api<PreviewMintResponse>(`/api/projects/${encodeURIComponent(projectId)}/preview`, {
      method: 'POST',
      body: JSON.stringify({ path, ...(worktreeOf ? { wt: `term:${worktreeOf}` } : {}) }),
    }),
  audit: () => api<Record<string, unknown>[]>('/api/audit'),
  observability: () => api<Observability>('/api/observability'),
  // Global admin settings + system isolation status (Settings view)
  getSettings: () => api<GlobalSettingsView>('/api/settings'),
  patchSettings: (patch: { testMaxSlots?: number | null; maxTerminals?: number | null; terminalReapHours?: number | null }) =>
    api<GlobalSettingsView>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  systemIsolation: () => api<SystemIsolation>('/api/system/isolation'),
  // SPEC-CLI-UPDATE — installed built-in CLI versions + a self-update trigger (Settings → System).
  cliVersions: () => api<CliVersion[]>('/api/system/cli-versions'),
  updateCli: (provider: string) =>
    api<CliUpdateResult>('/api/system/cli-update', { method: 'POST', body: JSON.stringify({ provider }) }),
  // SPEC-RUNWAY — the rotation config (GET/PUT-replace) + the live status snapshot (per-subscription
  // usage + reset timers), polled by the Runway tab. rotateTerminal moves a claude-code pane onto a
  // pooled subscription (the manual escape hatch on a terminal card).
  getRunwayConfig: () => api<RunwayConfig>('/api/runway/config'),
  setRunwayConfig: (cfg: RunwayConfig) => api<RunwayConfig>('/api/runway/config', { method: 'PUT', body: JSON.stringify(cfg) }),
  runwayStatus: () => api<RunwayStatus>('/api/runway/status'),
  // Live-swap pool membership for one claude-code account; both return the updated RunwayStatus.
  runwayPoolAdd: (profileId: string) =>
    api<RunwayStatus>(`/api/runway/pool/${encodeURIComponent(profileId)}`, { method: 'POST' }),
  runwayPoolRemove: (profileId: string) =>
    api<RunwayStatus>(`/api/runway/pool/${encodeURIComponent(profileId)}`, { method: 'DELETE' }),
  rotateTerminal: (terminalId: string, profileId: string) =>
    api<{ ok: boolean }>(`/api/terminals/${encodeURIComponent(terminalId)}/rotate`, { method: 'POST', body: JSON.stringify({ profileId }) }),
};

export interface CliVersion {
  provider: string;
  bin: string;
  present: boolean;
  version?: string;
}
export interface CliUpdateResult {
  provider: string;
  ok: boolean;
  before?: string;
  after?: string;
  changed: boolean;
  outputTail: string;
  error?: string;
}

export interface SystemIsolation {
  perAgentUidProvisioned: boolean;
  sandboxAvailable: boolean;
  /** CT_ASSISTANT_ALLOW_NO_SANDBOX=1 on the Tower process — bypasses the assistant's
   *  sandbox gate regardless of any per-account toggle; the UI must say so honestly. */
  envNoSandboxOverride: boolean;
  setupCommand: string;
}

export interface Observability {
  uptimeSec: number;
  sseClients: number;
  spoolDepth: number;
  diskFreeMb: number;
  diskLow: boolean;
  testActive: number;
  testCapacity: number;
}

export interface TestRunInfo {
  id: string;
  terminalId: string;
  projectId: string;
  port: number;
  status: 'running' | 'passed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  // SPEC-STORYLOOP §2.1 — structured results (mirrors the server TestRun). `results !== undefined`
  // distinguishes an all-green run (`[]`) from a reporter-not-wired run (undefined). `kind` lets the
  // web filter gate runs out of chips/coverage (matching the server's latestFor accessors).
  results?: TestFailure[];
  ran?: string[];
  total?: number;
  failed?: number;
  kind?: 'agent' | 'gate';
  // SPEC-TESTING-V2 §1 — the on-demand LLM triage digest (display-only). Rides GET /api/testruns free.
  summary?: string;
  // SPEC-LOOP W5 — run-dir-relative names of release-time captured logs (downloadable via the logs
  // route). Mirrors the server TestRun; contents are secret and never inlined into this list.
  logs?: string[];
  // SPEC-LOOP W7 — the routed investigator's false-fail classifications (display-only). Rides GET
  // /api/testruns free; the operator-visible surface for suppressions even when no report generates.
  triage?: TestTriageEntry[];
}

/**
 * Subscribe to the live Mission Control stream (SSE). EventSource can't set headers,
 * so the session token rides as a query param (loopback + Origin-checked).
 * Auto-reconnects; returns a cleanup function.
 */
export function connectStream(onEvent: (ev: StreamEvent) => void): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  const open = async () => {
    const token = await getToken();
    if (stopped) return;
    es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as StreamEvent);
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (!stopped) setTimeout(() => void open(), 2000); // reconnect
    };
  };
  void open();
  return () => {
    stopped = true;
    es?.close();
  };
}
