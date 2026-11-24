// Onboard assistant — tower-control tool registry (SPEC-ASSISTANT §4, M-A1;
// propose-then-confirm SPEC-ASSISTANT-CONTROL §1, M-A3).
//
// Two tool families are exposed to the assistant brain (Codex) via the MCP stdio server
// in ./mcp-tower.ts:
//  - READ_TOOLS (kind:'read'): pure queries over Tower state.
//  - PROPOSE_TOOL (kind:'propose'): propose_action — records a Tower-VALIDATED proposal
//    that renders as a Confirm card in the dock. It mutates NOTHING itself; only the
//    operator's Confirm click executes (SPEC-ASSISTANT-CONTROL §1). Direct mutate tools
//    remain physically absent from this file — the action catalog held by the Tower
//    (actions.ts) is the entire write surface.
//
// The MCP server runs as a SEPARATE process from the Tower (Codex spawns it), so every
// handler reaches the Tower over loopback HTTP with the token from TOWER_MCP_TOKEN_FILE —
// the same pattern towerctl's agentFetch uses (src/cli/towerctl.ts) — never via in-process
// Tower objects. Responses are trimmed to what the model actually needs: raw route
// payloads carry fields (full loop iteration history, tmux plumbing) that would only
// burn the brain's context window.

import { readFileSync } from 'node:fs';
import { ROLE_IDS } from '../../shared/roles.js';
import { MEMORY_KINDS } from '../../shared/memory.js';
import type { ToolDef } from './contracts.js';
import { lookupHelp } from './knowledge.js';

// ---- loopback plumbing -----------------------------------------------------------

/**
 * Call a Tower API route over loopback, authenticated by the assistant's Tower token.
 *
 * The token lives in a 0600 file named by TOWER_MCP_TOKEN_FILE (mirroring the broker's
 * token-in-file pattern, src/server/broker.ts — never a raw secret in env). It is read
 * per request, not cached at module load: the MCP process can outlive a Tower restart
 * that rotates the token file, and a fresh read makes the next call pick up the new one.
 *
 * The Origin header must be a Tower-allowlisted loopback origin — auth.ts rejects any
 * *present* Origin outside its allowlist, and `http://127.0.0.1:<port>` is always in it.
 */
async function towerRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const port = process.env.TOWER_PORT ?? '4870'; // default matches towerctl / server
  const tokenFile = process.env.TOWER_MCP_TOKEN_FILE;
  if (!tokenFile) {
    throw new Error('TOWER_MCP_TOKEN_FILE is not set — this MCP server must be launched by the Tower assistant runtime');
  }
  let token = '';
  try {
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch {
    throw new Error(`cannot read Tower token file at ${tokenFile}`);
  }
  if (!token) throw new Error(`Tower token file at ${tokenFile} is empty`);

  const base = `http://127.0.0.1:${port}`;
  // The conversation binding for a proposal comes from THIS process's per-turn env, set by the
  // Tower when it spawned the MCP server — never from the model's tool args. Forwarding it as a
  // header is the only way the separate Tower process learns which conversation a proposal belongs
  // to; POST /api/assistant/proposals rejects a request without it (SPEC-ASSISTANT-CONTROL §4).
  const conversationId = process.env.TOWER_CONVERSATION_ID;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Tower-Token': token,
        Origin: base,
        ...(conversationId ? { 'x-tower-conversation': conversationId } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new Error(`Tower unreachable at ${base} (${(e as Error).message}) — is the Tower running?`);
  }
  if (!res.ok) {
    // Surface the route's error body (it is usually a short {"error": ...}) but cap it —
    // this text goes straight into the model's context.
    const errBody = await res.text().catch(() => '');
    throw new Error(`Tower responded ${res.status} to ${method} ${path}${errBody ? `: ${errBody.slice(0, 300)}` : ''}`);
  }
  return res.json();
}

/** GET a Tower API route over loopback (see towerRequest for auth/plumbing). */
async function towerGet(path: string): Promise<unknown> {
  return towerRequest('GET', path);
}

/** POST a JSON body to a Tower API route over loopback (see towerRequest for auth/plumbing). */
async function towerPost(path: string, body: unknown): Promise<unknown> {
  return towerRequest('POST', path, body);
}

/** Require a non-empty string argument; tool args arrive untyped from the MCP client. */
function strArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`missing or invalid "${name}" (expected a non-empty string)`);
  }
  return v;
}

// ---- response trimming -----------------------------------------------------------
// Route payloads are typed server-side, but this process only sees JSON — treat them
// as loose records and pick fields, so a Tower-side shape change degrades to missing
// fields rather than a crash here.

type Rec = Record<string, unknown>;
const asList = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const pick = (r: Rec, keys: string[]): Rec => {
  const out: Rec = {};
  for (const k of keys) if (r[k] !== undefined) out[k] = r[k];
  return out;
};

/** GET /api/terminals rows → the orchestration-relevant subset (no tmux/hook plumbing). */
const trimTerminal = (t: Rec): Rec =>
  pick(t, ['id', 'projectId', 'title', 'provider', 'state', 'alive', 'branch', 'baseBranch', 'worktreePath', 'autoAccept', 'createdAt', 'lastEventAt']);

/** GET /api/loops rows → status without the full per-iteration history (can be huge). */
const trimLoop = (l: Rec): Rec => ({
  ...pick(l, ['id', 'projectId', 'name', 'provider', 'terminalId', 'branch', 'gatePolicy', 'status', 'iteration', 'maxIterations', 'stopReason', 'updatedAt']),
  iterationCount: asList(l.iterations).length,
});

/** GET /api/memory/:id/entries rows → the claim plus its status and provenance; `seq` (the store's
 *  delta cursor) is dropped because it means nothing to a reader. `history` stays: it is already the
 *  store's bounded inline tail, and the revision trail IS the provenance the brain asks this tool for. */
const trimEntry = (e: Rec): Rec =>
  pick(e, ['id', 'rev', 'kind', 'body', 'verification', 'lifecycle', 'author', 'origin', 'createdAt', 'updatedAt', 'evidence', 'applicability', 'supersededBy', 'supersedes', 'sources', 'key', 'importedFrom', 'history']);

/** The two status axes the entries route filters on, as the search tool's argument enums. */
const MEMORY_VERIFICATIONS = ['provisional', 'verified', 'disputed'] as const;
const MEMORY_LIFECYCLES = ['active', 'superseded', 'retracted'] as const;

// ---- the registry ----------------------------------------------------------------

/** JSON Schema for tools that take no arguments. */
const NO_ARGS: Record<string, unknown> = { type: 'object', properties: {} };

/**
 * All read-only tower-control tools. Every entry is kind:'read' by construction; the MCP
 * server always registers exactly this list (plus, only inside an assistant turn,
 * PROPOSE_TOOL below), so a mutate tool cannot leak in without touching this file.
 * list_profiles / list_providers / get_routing / list_backlog exist so the brain can
 * resolve REAL ids and current values before proposing an action — a proposal built on
 * a guessed id fails Tower validation.
 */
export const READ_TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    description:
      'List all projects registered in Control Tower: id, name, repo path, isolation mode, and archivedAt (set when the operator has hidden the project from the Flightline — it still works, but do not propose new runs into an archived project unless the operator explicitly asks). Use the id with other tools (read_memory, etc.).',
    parameters: NO_ARGS,
    kind: 'read',
    handler: async () => {
      const projects = asList(await towerGet('/api/projects'));
      return projects.map((p) => pick(p, ['id', 'name', 'repoPath', 'repoUrl', 'isolation', 'defaultIdentityId', 'archivedAt', 'createdAt']));
    },
  },
  {
    name: 'list_runs',
    description:
      'List active work: live agent terminals (killed ones excluded) and all autonomous loops with their status/iteration. The overview of "what is running right now".',
    parameters: NO_ARGS,
    kind: 'read',
    handler: async () => {
      const [terminalsRaw, loopsRaw] = await Promise.all([towerGet('/api/terminals'), towerGet('/api/loops')]);
      return {
        terminals: asList(terminalsRaw)
          .filter((t) => t.state !== 'killed')
          .map(trimTerminal),
        loops: asList(loopsRaw).map(trimLoop),
      };
    },
  },
  {
    name: 'get_health',
    description:
      'Tower health snapshot: observability metrics (uptime, SSE clients, spool depth, disk) merged with the security posture (isolation mode, egress control, broker, residual risk) AND the installed built-in CLI versions (claude-code / codex / gemini-cli — each present + version). Use cliVersions to see if a provider CLI is out of date before proposing update_provider_cli.',
    parameters: NO_ARGS,
    kind: 'read',
    handler: async () => {
      const [observability, security, cliVersions] = await Promise.all([
        towerGet('/api/observability'),
        towerGet('/api/security'),
        towerGet('/api/system/cli-versions').catch(() => []),
      ]);
      return { observability, security, cliVersions };
    },
  },
  {
    name: 'get_attention',
    description:
      'List agents currently waiting on the human: questions and permission requests, each with the extracted message and a short terminal preview. Empty list = nothing blocked.',
    parameters: NO_ARGS,
    kind: 'read',
    handler: async () => towerGet('/api/attention'),
  },
  {
    name: 'search_logs',
    description: 'Full-text search across Tower terminal/agent logs. Returns matching lines with their source.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text (plain substring/keyword query).' },
      },
      required: ['query'],
    },
    kind: 'read',
    handler: async (args) => towerGet(`/api/search?q=${encodeURIComponent(strArg(args, 'query'))}`),
  },
  {
    name: 'read_memory',
    description:
      "Read a project's shared memory as its three generated views — decisions.md, gotchas.md, glossary.md — the markdown agents and the operator see, rendered from the versioned entries underneath (each view line carries its entry id and rev in an HTML-comment marker). Good for the prose; to reason about an entry's status or provenance use search_memory. Takes a project id from list_projects.",
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id (from list_projects).' },
      },
      required: ['projectId'],
    },
    kind: 'read',
    handler: async (args) => towerGet(`/api/memory/${encodeURIComponent(strArg(args, 'projectId'))}`),
  },
  {
    name: 'search_memory',
    description:
      `Search a project's shared memory ENTRIES — the versioned records the read_memory views are rendered from. Each entry carries id, rev, kind (${MEMORY_KINDS.join(' / ')}), verification (${MEMORY_VERIFICATIONS.join(' / ')} — only the operator marks one verified; a passing test never does; agents may dispute), lifecycle (${MEMORY_LIFECYCLES.join(' / ')}), author, evidence, applicability (project-wide or scoped to one run/branch with its landed state), and its revision history. Use it to ground an answer or a proposal on what an entry's status and provenance actually say, not on the rendered text alone. Read-only, and there is no tool or proposal that writes memory. Takes a project id from list_projects; the text query and the kind / verification / lifecycle filters are optional — with no lifecycle filter, superseded and retracted entries are included.`,
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id (from list_projects).' },
        query: { type: 'string', description: 'Optional text to match against entry bodies.' },
        kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'Optional: only entries of this kind.' },
        verification: { type: 'string', enum: [...MEMORY_VERIFICATIONS], description: 'Optional: only entries with this verification status.' },
        lifecycle: { type: 'string', enum: [...MEMORY_LIFECYCLES], description: 'Optional: only entries in this lifecycle state (e.g. active).' },
      },
      required: ['projectId'],
    },
    kind: 'read',
    handler: async (args) => {
      const projectId = strArg(args, 'projectId');
      // Each optional filter is forwarded only when present and, for the enum ones, only when it is a
      // value the store recognises — an unknown value would silently match nothing and read as "no entries".
      const filters: [arg: string, param: string, allowed?: readonly string[]][] = [
        ['query', 'q'],
        ['kind', 'kind', MEMORY_KINDS],
        ['verification', 'verification', MEMORY_VERIFICATIONS],
        ['lifecycle', 'lifecycle', MEMORY_LIFECYCLES],
      ];
      const qs = new URLSearchParams();
      for (const [arg, param, allowed] of filters) {
        const v = args[arg];
        if (typeof v !== 'string' || v.trim() === '') continue;
        if (allowed && !allowed.includes(v)) throw new Error(`invalid "${arg}" (expected one of ${allowed.join(', ')})`);
        qs.set(param, v);
      }
      const suffix = qs.size ? `?${qs}` : '';
      return asList(await towerGet(`/api/memory/${encodeURIComponent(projectId)}/entries${suffix}`)).map(trimEntry);
    },
  },
  {
    name: 'read_diff',
    description:
      "Review a worktree terminal's pending changes vs its base branch: changed files with +/- counts, commit subjects, and dirty/uncommitted status. Takes a terminal id from list_runs.",
    parameters: {
      type: 'object',
      properties: {
        terminalId: { type: 'string', description: 'Terminal id (from list_runs).' },
      },
      required: ['terminalId'],
    },
    kind: 'read',
    handler: async (args) => towerGet(`/api/terminals/${encodeURIComponent(strArg(args, 'terminalId'))}/review`),
  },
  {
    name: 'list_profiles',
    description:
      'List provider account profiles (Connections → Provider accounts). Returns { profiles, sharedLogin }: each profile has id, label, provider, and signedIn — whether that account actually holds a credential right now; sharedLogin maps each provider id to whether the SHARED account-less login is signed in (a run or loop with NO profileId uses it; never pass "shared" as a profileId). Pass a signedIn:true account id as create_loop.profileId / set_routing.profileId; use the id when proposing open_login; check here before proposing create_profile to avoid duplicates.',
    parameters: NO_ARGS,
    kind: 'read',
    handler: async () => {
      const [profilesRaw, sharedLogin] = await Promise.all([towerGet('/api/profiles'), towerGet('/api/profiles/shared-login')]);
      return {
        profiles: asList(profilesRaw).map((p) => pick(p, ['id', 'label', 'provider', 'signedIn'])),
        sharedLogin,
      };
    },
  },
  {
    name: 'list_identities',
    description:
      'List GitHub identities (Connections → GitHub identities): id, label, git author name/email, and whether a push token is stored (hasCredential). Use the id when proposing create_project or set_project_github to set a project\'s default push/commit identity; an identity without a push token still authors commits but cannot push via the broker.',
    parameters: NO_ARGS,
    kind: 'read',
    handler: async () => {
      const identities = asList(await towerGet('/api/identities'));
      return identities.map((i) => pick(i, ['id', 'label', 'gitName', 'gitEmail', 'hasCredential', 'createdAt']));
    },
  },
  {
    name: 'preview_repo_bootstrap',
    description:
      'Preview what init_project_repo would do for a project: detected stacks, how many files would be committed (first 20 names), the .gitignore lines it would add, the remote state, and every blocking/warning condition. Read this BEFORE proposing init_project_repo. Blocking conditions mean the proposal would be refused at confirm.',
    parameters: { type: 'object', properties: { projectId: { type: 'string', description: 'Project id (from list_projects).' } }, required: ['projectId'] },
    kind: 'read',
    handler: async (args) => {
      const plan = (await towerGet(`/api/projects/${encodeURIComponent(strArg(args, 'projectId'))}/bootstrap/preflight`)) as Rec;
      return {
        ...pick(plan, ['detectedStacks', 'gitignoreExists', 'gitignoreAppend', 'fileTotal', 'truncated', 'remote', 'branch', 'identity', 'blocking', 'warnings']),
        files: asList(plan.filesToCommit).slice(0, 20).map((f) => f.path),
      };
    },
  },
  {
    name: 'list_providers',
    description:
      'List every provider a run or routing can target: builtin adapters (claude-code, gemini-cli, codex, shell) and custom providers with their known model ids. Resolve provider/model here before proposing set_routing or create_loop.',
    parameters: NO_ARGS,
    kind: 'read',
    handler: async () => {
      // Builtins and customs live on different routes (/api/adapters vs /api/providers);
      // the brain needs the union to pick a valid ProviderId, so merge them here.
      const [adaptersRaw, customRaw] = await Promise.all([towerGet('/api/adapters'), towerGet('/api/providers')]);
      return {
        builtin: asList(adaptersRaw).map((a) => pick(a, ['id', 'displayName'])),
        custom: asList(customRaw).map((p) => {
          const model = (p.model ?? {}) as Rec;
          return {
            ...pick(p, ['id', 'displayName']),
            ...pick(model, ['defaultModel']),
            models: asList(model.models)
              .map((m) => m.id)
              .filter((id) => id !== undefined),
          };
        }),
      };
    },
  },
  {
    name: 'get_routing',
    description:
      // The role list derives from the shared registry (SPEC-ROUTING §1) so a new role shows
      // up in this prose without an edit here.
      `Pipeline role routing: each role (${ROLE_IDS.join('/')}) resolves to a provider, a model, and optionally a specific logged-in account (profileId). Routing is LAYERED (SPEC-ROUTING): global defaults < the project's selected workflow profile < the project's own per-role overrides. Without arguments this returns the global defaults plus every named workflow profile (id, name, routes). With a projectId it returns that project's overlay — its workflowId, ad-hoc routes, the resolved effective route per role with its source layer, and any warnings. Read this before proposing set_routing or set_project_workflow so you know what you are changing from.`,
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: "Optional project id (from list_projects) — returns that project's layered routing view instead of the global defaults.",
        },
      },
    },
    kind: 'read',
    handler: async (args) => {
      const projectId = typeof args.projectId === 'string' && args.projectId.trim() !== '' ? args.projectId : undefined;
      if (projectId) return towerGet(`/api/projects/${encodeURIComponent(projectId)}/routing`);
      const [globalRouting, workflowsRaw] = await Promise.all([towerGet('/api/routing'), towerGet('/api/workflows')]);
      return {
        global: globalRouting,
        workflows: asList(workflowsRaw).map((w) => pick(w, ['id', 'name', 'description', 'routes'])),
      };
    },
  },
  {
    name: 'list_backlog',
    description:
      'List backlog tasks across projects: id, projectId, title, status (triage/todo/ready/archived), priority, and mission/loop provenance links. Use the id when proposing update_task.',
    parameters: NO_ARGS,
    kind: 'read',
    handler: async () => {
      const tasks = asList(await towerGet('/api/backlog'));
      return tasks.map((t) => pick(t, ['id', 'projectId', 'title', 'status', 'priority', 'missionId', 'loopId']));
    },
  },
  {
    name: 'list_skills',
    description:
      "List the shared skill library and bundles — and, with a projectId, that project's effective skill selection. Each skill: id, name, enabled, scope, origin, gateMode (advisory|blocking), protected, and a short description. A PROTECTED skill (protected:true, or a blocking gate like code-review) cannot be toggled or deselected through you — a proposal against it is refused. Bundles: id, name, skillIds. Resolve ids HERE before proposing set_skill_enabled or set_project_skills. Meta only — skill bodies are never returned.",
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: "Optional project id (from list_projects) — also returns that project's overlay + resolved effective skill set.",
        },
      },
    },
    kind: 'read',
    handler: async (args) => {
      const projectId = typeof args.projectId === 'string' && args.projectId.trim() !== '' ? args.projectId : undefined;
      const [skillsRaw, bundlesRaw] = await Promise.all([towerGet('/api/skills'), towerGet('/api/skill-bundles')]);
      const skills = asList(skillsRaw).map((sk) => {
        const gate = (sk.gate ?? undefined) as Rec | undefined;
        const gateMode = typeof gate?.mode === 'string' ? gate.mode : 'advisory';
        return {
          ...pick(sk, ['id', 'name', 'enabled', 'scope', 'origin']),
          gateMode,
          protected: sk.protected === true || gateMode === 'blocking',
          description: typeof sk.description === 'string' ? sk.description.slice(0, 120) : undefined,
        };
      });
      const bundles = asList(bundlesRaw).map((b) => pick(b, ['id', 'name', 'skillIds']));
      if (projectId) {
        const project = (await towerGet(`/api/projects/${encodeURIComponent(projectId)}/skills`)) as Rec;
        return { skills, bundles, project: pick(project, ['bundleId', 'enable', 'effective', 'warnings']) };
      }
      return { skills, bundles };
    },
  },
  {
    name: 'explain',
    description:
      'Explain a Control Tower concept or feature (e.g. "loops", "worktrees", "attention", "isolation", "broker") from the curated Tower knowledge base. No live Tower call.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The Tower concept/feature to explain.' },
      },
      required: ['topic'],
    },
    kind: 'read',
    handler: async (args) => lookupHelp(strArg(args, 'topic')),
  },
];

// ---- the propose tool (SPEC-ASSISTANT-CONTROL §1/§3) -------------------------------

/**
 * Hand-written JSON Schema mirroring the FROZEN AssistantAction union (shared/types.ts).
 * One flat object discriminated by `kind` — the handler splits kind from the rest and the
 * Tower re-validates against its own zod catalog (actions.ts), so this schema is guidance
 * for the model, never the security boundary. Kept in lockstep with the union by hand:
 * a new kind lands here AND in actions.ts or it cannot be proposed at all.
 */
const PROPOSE_PARAMS: Record<string, unknown> = {
  type: 'object',
  oneOf: [
    {
      description: 'Create a provider account profile (Connections → Provider accounts). Low risk.',
      properties: {
        kind: { enum: ['create_profile'] },
        provider: { enum: ['codex', 'claude-code', 'gemini-cli', 'hermes'], description: 'Builtin CLI provider for the new profile.' },
        label: { type: 'string', description: 'Display label for the profile, e.g. "codex main".' },
      },
      required: ['kind', 'provider', 'label'],
      additionalProperties: false,
    },
    {
      description:
        "Open a profile's interactive login terminal (the CLI's own OAuth flow — credentials never pass through the assistant). Low risk.",
      properties: {
        kind: { enum: ['open_login'] },
        profileId: { type: 'string', description: 'Profile id from list_profiles.' },
      },
      required: ['kind', 'profileId'],
      additionalProperties: false,
    },
    {
      description:
        "Point a pipeline role at a provider (and optionally a model) — globally, or for one project when projectId is given (the override sits on top of that project's workflow/global layers). Low risk.",
      properties: {
        kind: { enum: ['set_routing'] },
        // Enum derives from the shared role registry (SPEC-ROUTING §1) — never re-list roles here.
        role: { enum: [...ROLE_IDS], description: 'Pipeline role to re-route.' },
        provider: {
          type: 'string',
          description: 'A builtin id (claude-code | gemini-cli | codex | shell) or a custom:<slug> id from list_providers.',
        },
        model: { type: 'string', description: 'Optional model slug for that provider (see list_providers for known ids).' },
        effort: {
          type: 'string',
          description: "Optional reasoning effort for that provider (claude-code: low|medium|high|xhigh|max; codex: one of the model's supported levels, e.g. low|medium|high|xhigh). Omit to keep the CLI's own default.",
        },
        profileId: {
          type: 'string',
          description: 'Optional profile id from list_profiles — the logged-in account this role runs as. Must belong to the same provider; the assistant Brain account is refused.',
        },
        projectId: {
          type: 'string',
          description: "Optional project id (from list_projects): scope the route to that project's overlay instead of the global defaults.",
        },
      },
      required: ['kind', 'role', 'provider'],
      additionalProperties: false,
    },
    {
      description:
        "Select a named workflow profile as a project's routing bundle (its role routes apply beneath the project's own ad-hoc overrides). Resolve the workflow id with get_routing first. Low risk.",
      properties: {
        kind: { enum: ['set_project_workflow'] },
        projectId: { type: 'string', description: 'Project id from list_projects.' },
        workflowId: { type: 'string', description: 'Workflow profile id from get_routing.' },
      },
      required: ['kind', 'projectId', 'workflowId'],
      additionalProperties: false,
    },
    {
      description: 'Create a backlog task in a pre-execution lane. Low risk.',
      properties: {
        kind: { enum: ['create_task'] },
        projectId: { type: 'string', description: 'Project id from list_projects.' },
        title: { type: 'string', description: 'Task title (non-empty).' },
        body: { type: 'string', description: 'Optional task body/details.' },
        priority: { type: 'integer', enum: [0, 1, 2, 3], description: 'P0 highest; omit for unranked.' },
        status: { enum: ['triage', 'todo', 'ready'], description: 'Starting lane; default triage.' },
      },
      required: ['kind', 'projectId', 'title'],
      additionalProperties: false,
    },
    {
      description: 'Update a backlog task: retitle, edit body, reprioritize, move lanes, or archive (status archived). Low risk.',
      properties: {
        kind: { enum: ['update_task'] },
        taskId: { type: 'string', description: 'Task id from list_backlog.' },
        title: { type: 'string', description: 'New title.' },
        body: { type: 'string', description: 'New body.' },
        priority: { enum: [0, 1, 2, 3, null], description: 'P0 highest; null clears the priority.' },
        status: { enum: ['triage', 'todo', 'ready', 'archived'], description: 'New lane; archived archives the task.' },
      },
      required: ['kind', 'taskId'],
      additionalProperties: false,
    },
    {
      description: 'Archive every finished card on the board. Medium risk — affects all finished runs at once.',
      properties: {
        kind: { enum: ['clear_finished'] },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    {
      description:
        'Start an autonomous iterate-until-done loop. HIGH risk: it spawns an agent that works unattended, and checkCommand runs as a shell command ON THE HOST each iteration.',
      properties: {
        kind: { enum: ['create_loop'] },
        projectId: { type: 'string', description: 'Project id from list_projects.' },
        name: { type: 'string', description: 'Loop name.' },
        task: { type: 'string', description: 'The task the agent iterates on.' },
        provider: { type: 'string', description: 'Optional ProviderId (see list_providers); defaults from routing.' },
        profileId: {
          type: 'string',
          description: "Account id from list_profiles — the signed-in account this loop runs as. Resolve one with signedIn:true for the loop's provider; omit ONLY if sharedLogin shows that provider's shared login signed in. A not-signed-in (or assistant Brain) account is refused at propose.",
        },
        model: { type: 'string', description: 'Optional model slug for that provider.' },
        effort: {
          type: 'string',
          description: "Optional reasoning effort (claude-code: low|medium|high|xhigh|max; codex: one of the model's supported levels, e.g. low|medium|high|xhigh). Omit to keep the CLI's own default.",
        },
        maxIterations: { type: 'integer', minimum: 1, description: 'Iteration cap; default 8.' },
        gatePolicy: { enum: ['every', 'on-pass', 'never'], description: 'When the loop holds for the operator.' },
        checkCommand: {
          type: 'string',
          description: 'Optional pass/fail check (exit 0 = pass). Runs as a HOST shell command every iteration — keep it exactly what the operator asked for.',
        },
      },
      required: ['kind', 'projectId', 'name', 'task'],
      additionalProperties: false,
    },
    {
      description:
        'Register an EXISTING git repository as a Tower project (the Flightline → + project surface). High risk: a project is where agents may be started, so this ALWAYS waits for the operator to click Confirm — even in autonomous mode. Does not create or scaffold anything on disk.',
      properties: {
        kind: { enum: ['create_project'] },
        name: { type: 'string', description: 'Display name for the project sector, e.g. "trading run".' },
        repoPath: {
          type: 'string',
          description:
            'Absolute path to an existing git repository ROOT (must contain .git) with at least one commit — e.g. /home/you/repos/thing. Not a subdirectory of a repo, and never a Tower worktree under .ct-worktrees.',
        },
        repoUrl: {
          type: 'string',
          description: 'Optional GitHub repo URL (https://github.com/owner/repo[.git]) — display/wiring metadata only.',
        },
        defaultIdentityId: {
          type: 'string',
          description: 'Optional GitHub identity id from list_identities — the default push/commit identity for this project.',
        },
      },
      required: ['kind', 'name', 'repoPath'],
      additionalProperties: false,
    },
    {
      description:
        "Set an EXISTING project's GitHub config: its repo URL and/or default push/commit identity. Send only the keys you want to change; null clears one. Low risk — it does not create a project or widen where agents run. Resolve projectId with list_projects and defaultIdentityId with list_identities first.",
      properties: {
        kind: { enum: ['set_project_github'] },
        projectId: { type: 'string', description: 'Project id from list_projects.' },
        repoUrl: {
          type: ['string', 'null'],
          description: 'GitHub repo URL (https://github.com/owner/repo[.git]); null or "" clears it. Metadata only.',
        },
        defaultIdentityId: {
          type: ['string', 'null'],
          description: 'GitHub identity id from list_identities; null clears the project default.',
        },
      },
      required: ['kind', 'projectId'],
      additionalProperties: false,
    },
    {
      description:
        "Initialize & push: turn a registered project directory that is NOT yet a git repo into one — inspect the tree, generate/merge a stack-appropriate .gitignore, create .local-context/ (kept local), commit the files, and push the first commit to the project's stored GitHub repo URL as its default identity. HIGH risk: writes the filesystem and pushes to GitHub, so it ALWAYS waits for the operator's Confirm. Requires the project to already carry a repoUrl and a default identity with a push token (set_project_github). Call preview_repo_bootstrap first.",
      properties: {
        kind: { enum: ['init_project_repo'] },
        projectId: { type: 'string', description: 'Project id from list_projects.' },
      },
      required: ['kind', 'projectId'],
      additionalProperties: false,
    },
    {
      description:
        "One-step bootstrap: register a BARE folder (no .git) as a Tower project AND initialize-and-push it — register, inspect the tree, generate/merge a .gitignore, create .local-context/ (kept local), commit, and push the first commit to repoUrl as the given identity. HIGH risk (widens where agents may run + writes the filesystem + pushes to GitHub): ALWAYS waits for the operator's Confirm. The project is registered ONLY if the bootstrap succeeds — a refusal registers nothing. Requires a repoUrl and a defaultIdentityId with a push token (list_identities); the remote must be EMPTY. There is no preview for an unregistered folder; if the tree has warnings (large files, a nested repo) this refuses — register via the UI \"+ project\" and use that project's Initialize & push instead. For a folder that is ALREADY a git repo use create_project; for an already-registered project use init_project_repo.",
      properties: {
        kind: { enum: ['bootstrap_project'] },
        name: { type: 'string', description: 'Display name for the project sector.' },
        repoPath: { type: 'string', description: 'Absolute path to an existing folder with NO .git — never a Tower worktree under .ct-worktrees, and not nested in/around a registered project.' },
        repoUrl: { type: 'string', description: 'GitHub repo URL (https://github.com/owner/repo[.git]) the first commit is pushed to — the remote must be empty.' },
        defaultIdentityId: { type: 'string', description: 'GitHub identity id from list_identities — must have a push token.' },
      },
      required: ['kind', 'name', 'repoPath', 'repoUrl', 'defaultIdentityId'],
      additionalProperties: false,
    },
    {
      description:
        "Arm or disarm a project's Autonomous (skip permissions) default. HIGH risk: arming makes every FUTURE claude-code work terminal and loop iteration in the project run with the CLI's own permission bypass (no per-command approval), so this ALWAYS waits for the operator's Confirm — even in autonomous mode. enabled:false restores the per-command gate for future spawns (already-running terminals are unaffected).",
      properties: {
        kind: { enum: ['set_project_autonomy'] },
        projectId: { type: 'string', description: 'Project id from list_projects.' },
        enabled: { type: 'boolean', description: 'true = autonomous (skip permissions) by default; false = ask per command.' },
      },
      required: ['kind', 'projectId', 'enabled'],
      additionalProperties: false,
    },
    {
      description:
        "Enable or disable a skill in the shared library. HIGH risk: a skill's instructions materialize into EVERY future claude-code/codex/gemini agent, so this ALWAYS waits for the operator's Confirm — even in autonomous mode. A PROTECTED skill (protected, or a blocking gate like code-review) cannot be changed here — the proposal is refused. Resolve the skill id with list_skills first.",
      properties: {
        kind: { enum: ['set_skill_enabled'] },
        skillId: { type: 'string', description: 'Skill id from list_skills.' },
        enabled: { type: 'boolean', description: 'true = enabled (materializes into future agents); false = disabled.' },
      },
      required: ['kind', 'skillId', 'enabled'],
      additionalProperties: false,
    },
    {
      description:
        "Set a project's skill selection: a named bundle and/or per-skill on/off overrides. HIGH risk: it changes which skill instructions reach this project's future agents, so it ALWAYS waits for the operator's Confirm. This REPLACES the project's WHOLE overlay — send the full selection each time; omit bundleId (or null) with no enable to clear back to the global default. Turning OFF a protected skill via the enable map is refused. Resolve ids with list_skills first.",
      properties: {
        kind: { enum: ['set_project_skills'] },
        projectId: { type: 'string', description: 'Project id from list_projects.' },
        bundleId: { type: ['string', 'null'], description: 'Skill bundle id from list_skills; null or omitted selects no bundle.' },
        enable: {
          type: 'object',
          additionalProperties: { type: 'boolean' },
          description: 'Per-skill overrides { "<skillId>": true|false }: true adds a skill, false removes one (even a bundle member). At most 64 entries.',
        },
      },
      required: ['kind', 'projectId'],
      additionalProperties: false,
    },
    {
      description:
        "Publish a saved skill draft into the shared library: create a NEW skill from the draft, or update an assistant-authored one (via the draft's targetSkillId — protected or operator/imported skills are refused). HIGH risk: a skill body is instructions injected into every future agent, so this ALWAYS waits for the operator's Confirm — even in autonomous mode — and a promoted NEW skill lands DISABLED until the operator separately enables it (an UPDATE keeps the target's enabled state, but the new body never reaches skip-permissions agents until the operator clears autonomy in Settings → Skills). Save the draft with save_skill_draft first; a stale contentHash is refused.",
      properties: {
        kind: { enum: ['promote_skill'] },
        draftId: { type: 'string', description: 'Draft id returned by save_skill_draft.' },
        contentHash: {
          type: 'string',
          description: 'The contentHash save_skill_draft returned for the exact draft version you want published — it pins what the operator reviews to what executes.',
        },
      },
      required: ['kind', 'draftId', 'contentHash'],
      additionalProperties: false,
    },
    {
      description:
        "Close (kill) a terminal: its session ends and its resources are released. HIGH risk — this ALWAYS waits for the operator's Confirm, even in autonomous mode. If the terminal is a loop's builder, closing it FAILS that loop (the Confirm card states which). Login panes (possibly mid-auth), mission planner panes, and terminals on the assistant Brain's own account are refused at propose. Resolve the terminal id with list_runs first.",
      properties: {
        kind: { enum: ['close_terminal'] },
        terminalId: { type: 'string', description: 'Terminal id from list_runs.' },
      },
      required: ['kind', 'terminalId'],
      additionalProperties: false,
    },
    {
      description:
        "Restart a terminal IN PLACE: its CLI relaunches in the same pane — the worktree, account login, hook wiring, and any loop binding all survive; only the in-flight turn is discarded (a bound loop keeps running and re-runs its current iteration). Use it for a wedged CLI, e.g. one holding a stale in-memory credential after a re-login. This ALWAYS waits for the operator's Confirm. Login panes are refused — propose open_login instead; planner panes and Brain-account terminals are refused too. Resolve the terminal id with list_runs first.",
      properties: {
        kind: { enum: ['restart_terminal'] },
        terminalId: { type: 'string', description: 'Terminal id from list_runs.' },
      },
      required: ['kind', 'terminalId'],
      additionalProperties: false,
    },
    {
      description:
        "Update a built-in provider CLI to its latest version on the host by running its OWN self-updater (claude-code → `claude update`, codex → `codex update`, gemini-cli → `gemini update`). HIGH risk — it runs a command on the host and swaps the binary, so this ALWAYS waits for the operator's Confirm. Running agent panes keep their current version until they respawn; only future spawns pick up the new one. Check get_health's cliVersions first to see whether an update is actually needed.",
      properties: {
        kind: { enum: ['update_provider_cli'] },
        provider: { enum: ['claude-code', 'codex', 'gemini-cli'], description: 'Which built-in CLI to update.' },
      },
      required: ['kind', 'provider'],
      additionalProperties: false,
    },
  ],
};

/**
 * propose_action — the brain's ONLY path toward a mutation, and it mutates nothing itself:
 * the handler records the proposal with the Tower, which validates the args against the
 * typed action catalog and renders a Confirm card to the operator. The returned proposal
 * is `pending` — execution happens only on the operator's Confirm click, and the outcome
 * reaches the brain as a `System:` note in a LATER turn (codex exec is stateless, §4).
 *
 * The conversation binding is deliberately NOT an argument: the Tower takes it from this
 * MCP server's TOWER_CONVERSATION_ID env (written per turn into config.toml), so the model
 * can neither spoof another conversation's card stream nor mint fresh ids to dodge the
 * pending-proposals cap (SPEC-ASSISTANT-CONTROL §4).
 */
export const PROPOSE_TOOL: ToolDef = {
  name: 'propose_action',
  description:
    'Propose a Tower action for the operator to confirm. This NEVER executes anything: it records a pending proposal that appears as a Confirm card in the dock, where the operator can confirm, edit, or dismiss it. Resolve every id and argument with the read tools FIRST (list_profiles, list_identities, list_providers, get_routing, list_backlog, list_projects, list_runs) — unknown ids make the proposal fail. To publish a skill: save the full draft with save_skill_draft first, then propose promote_skill with the draftId + contentHash it returned. Treat the action as NOT done until a later System note says it executed.',
  parameters: PROPOSE_PARAMS,
  kind: 'propose',
  handler: async (args) => {
    const kind = strArg(args, 'kind');
    // Everything except the discriminant travels as the action's args; the Tower's zod
    // catalog is the real validator and its 400s flow back verbatim as tool errors the
    // model can self-correct from.
    const { kind: _kind, ...rest } = args;
    return towerPost('/api/assistant/proposals', { kind, args: rest });
  },
};

// ---- the skill-draft tool (SPEC-SKILLS Phase 5b) -----------------------------------

/**
 * save_skill_draft — kind 'draft', NOT a propose→confirm action, deliberately. The propose machinery
 * interposes a human click before EXECUTION; a draft has no execution — nothing reads it except the
 * operator's eyes and the promote path, which is itself an always-confirm, hash-pinned proposal. A
 * Confirm card per save would spam the operator for inert text and break iterative authoring while
 * adding zero containment: the human gate belongs at the single point where text becomes
 * agent-reaching instructions (promote_skill). The widening is admissible because the pad is inert
 * (structurally unreadable by the materializer), capped (64 KB body, 50/10 counts), secret-scan-
 * REJECTED at the door, audited, and conversation-bound — the full argument lives on the auth.ts
 * ASSISTANT_ACCEPT lines and the save route.
 *
 * Registered — like PROPOSE_TOOL — only when TOWER_CONVERSATION_ID is set (mcp-tower.ts): the save
 * route requires the conversation header, and the Validator's judge/planner/drafter brains (which
 * share this MCP server with no conversation id) must stay draft-less as well as propose-less.
 */
export const SAVE_DRAFT_TOOL: ToolDef = {
  name: 'save_skill_draft',
  description:
    'Save (or update, by draftId) a skill DRAFT: name, description, optional trigger/tags, and the full body text. A draft is INERT — it reaches no agent and materializes nowhere; only the operator sees it (Settings → Skills → Assistant drafts) until a promote_skill proposal is confirmed. Returns { id, contentHash, bodyBytes, warnings }; to publish, call propose_action { kind: "promote_skill", draftId, contentHash } with the returned hash. Secret-shaped content (keys, tokens, private-key blocks) is refused — use placeholders. Set targetSkillId ONLY to update a skill you previously authored: protected skills and operator/imported skills are refused at propose.',
  parameters: {
    type: 'object',
    properties: {
      draftId: { type: 'string', description: 'Omit to create a new draft; pass the id from a prior save to update it (same conversation only).' },
      name: { type: 'string', description: "Display name (≤120 chars); a NEW skill's id is derived from it." },
      description: { type: 'string', description: 'WHAT the skill does (≤4000 chars).' },
      trigger: { type: 'string', description: 'Optional WHEN-to-use guidance (≤2000 chars).' },
      body: { type: 'string', description: 'The full skill body (markdown, ≤64 KB).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (≤32, each ≤60 chars).' },
      targetSkillId: {
        type: 'string',
        description: 'Optional: promote will UPDATE this existing skill instead of creating a new one. Assistant-authored, non-protected skills only — resolve with list_skills.',
      },
    },
    required: ['name', 'description', 'body'],
    additionalProperties: false,
  },
  kind: 'draft',
  handler: async (args) => towerPost('/api/assistant/skill-drafts', args),
};
