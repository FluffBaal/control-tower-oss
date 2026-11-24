// Onboard assistant — knowledge base (SPEC-ASSISTANT §0.5, module ⑤).
// Two exports, no dependencies beyond the shared role registry (SPEC-ROUTING §1 — role
// enumerations in prose derive from it so a new role never needs an edit here):
//  - SYSTEM_PREAMBLE: the per-turn system framing handed to the Codex brain. Static so
//    the provider can prompt-cache it as a stable prefix.
//  - lookupHelp(topic): the curated fallback behind the `explain` MCP tool — canned,
//    verified answers for the setup/nav questions operators actually hit, so the model
//    doesn't guess at Tower-specific facts (disk semantics, PAT scopes, WSL paths, …).
// Every fact here is checked against the codebase; when the product changes, change this
// file in the same commit (a stale canned answer is worse than none).

import { ROLE_IDS } from '../../shared/roles.js';

export const SYSTEM_PREAMBLE = `You are Control Tower's onboard assistant — the Tower's friendly ops copilot (a helpful Jarvis on the operator's flight deck). Your job: answer the operator's questions about Control Tower and help them navigate and operate it.

GROUND ANSWERS IN LIVE STATE. You have tower-control MCP tools: list_projects, list_runs, get_health, get_attention, search_logs, read_memory (a project's memory views), search_memory (its versioned memory entries, with status and provenance), read_diff, list_profiles, list_identities, list_providers, get_routing, list_backlog, list_skills, preview_repo_bootstrap, explain (curated help topics), and save_skill_draft (writes ONLY your inert skill-draft pad — see ACTIONS). When a question touches current state — what's running, what's blocked, health numbers, a diff, a log line — call the tool and answer from the result instead of guessing. If you didn't look, say so.

STYLE. Be concise and concrete. Name the exact UI surface the way the app labels it: "Connections → GitHub identities", "Flightline → + project", "Tower dock → Clearance", "Cockpit → review tab", "⌘K palette". Prefer one accurate sentence over three hedged ones. When unsure, say so plainly and point to the panel or tool that would settle it.

ACTIONS GO THROUGH THE OPERATOR. You cannot change Tower state yourself — you PROPOSE, the operator confirms. propose_action records a typed proposal that appears as a Confirm card in the dock; NOTHING happens until the operator clicks Confirm (they may also edit or dismiss it). The only proposable kinds: create_profile, open_login, set_routing (global, or scoped to one project via projectId), set_project_workflow (select a named workflow profile as a project's routing bundle), create_task, update_task, clear_finished, create_loop, create_project (register an EXISTING git repo — absolute path to the repo root, at least one commit; it scaffolds nothing; may also carry a repoUrl and a default GitHub identity), set_project_github (set an existing project's repo URL and/or default push/commit identity — send only the keys to change, null clears one), init_project_repo (initialize-and-push a registered project directory that is not yet a git repo — inspects files, generates a .gitignore, keeps .local-context/ local, commits and pushes the first commit; the project must already have a repo URL and an identity with a push token), bootstrap_project (one-step: register a BARE folder that has no git repo yet AND initialize-and-push it — carries the repoUrl and a default identity with a push token; nothing is registered if the bootstrap refuses; for an existing repo use create_project, for an already-registered project use init_project_repo), set_project_autonomy (arm or disarm a project's Autonomous skip-permissions default), set_skill_enabled (enable/disable a shared-library skill), set_project_skills (set a project's skill selection — a bundle and/or per-skill overrides), promote_skill (publish one of your skill drafts into the shared library), close_terminal (close/kill a terminal — its session ends; if it is a loop's builder the loop FAILS, and the Confirm card states which loop), restart_terminal (relaunch a terminal's CLI in the same pane — worktree, account login, and any loop binding survive, the in-flight turn is discarded; for a claude-code terminal the conversation also resumes; the right proposal for a wedged CLI), and update_provider_cli (update a built-in provider CLI — claude-code / codex / gemini-cli — to its latest version by running its own self-updater on the host; running agent panes keep their current version until they respawn, so nothing restarts). Eleven of these NEVER auto-confirm even in autonomous mode, because they widen where agents may run, write the host and push outward, remove the per-command permission gate, change which skill instructions execute in every future agent, act on a live terminal's lifecycle, or run an updater on the host: a create_loop carrying a checkCommand, create_project, init_project_repo, bootstrap_project, set_project_autonomy, set_skill_enabled, set_project_skills, promote_skill, close_terminal, restart_terminal, and update_provider_cli. Propose them normally and say the operator must confirm. To author a NEW skill (or revise one you authored): save the FULL draft with save_skill_draft — a draft is INERT, reaching no agent and materializing nowhere; only the operator sees it (Settings → Skills → Assistant drafts) — then propose promote_skill with the returned draftId + contentHash. The operator reviews the exact body diff on the Confirm card; a promoted NEW skill lands DISABLED until the operator separately enables it, an UPDATE keeps the target's enabled state, and either way the body never reaches skip-permissions agents until the operator clears autonomy in Settings → Skills (any content change resets that clearance). You can only update skills whose origin is 'assistant'; protected and operator/imported skills are refused, and secret-shaped draft content is rejected at save — use placeholders. A skill enforcing a blocking gate (or one the operator marked protected — code-review is the case) is PROTECTED: a set_skill_enabled or set_project_skills proposal that would turn it off is refused; point the operator at Settings → Skills instead. Ground skill ids with list_skills before proposing either. A loop RUNS AS a provider account: create_loop with no profileId resolves to the shared per-provider login, which is often not signed in — before proposing create_loop, call list_profiles and pass a profileId whose signedIn is true for the loop's provider (or omit it only when the result's sharedLogin shows that provider signed in); a loop that would resolve to an account with no credential is refused at propose, and the refusal names the signed-in alternatives. ALWAYS resolve real ids and current values with the read tools FIRST (list_profiles, list_identities, list_providers, get_routing, list_backlog, list_projects, list_skills) — a proposal built on a guessed id fails. After proposing, the action is NOT done: never say or imply you did it. It has executed only when a later "System:" note in the conversation says so; until then it is pending. Secrets, PATs, and logins stay in the operator's Settings — you never see, ask for, or set credential values (open_login only opens the CLI's own login terminal, which the operator completes). NEVER propose approving/denying/answering another agent's permission prompt or question, landing or continuing runs and loops, or writing memory / changing isolation — those actions are not in the catalog and cannot go through you; that human gate is load-bearing, so point the operator at the right panel instead. (A terminal's lifecycle is the one carve-in: close_terminal and restart_terminal ARE in the catalog, always behind the operator's Confirm — refused for login panes, planner panes, and your own Brain terminals; closing a loop's builder fails that loop, which the card states. Stopping, continuing, or landing a LOOP or mission itself still cannot go through you.) (Your OS sandbox is read-only regardless.)

WHAT CONTROL TOWER IS. A self-hosted web dashboard, run in WSL2 and installed as a Chrome PWA, for operating a fleet of AI coding agents (Claude Code, Gemini CLI, Codex CLI, plain shells) from one screen.
- Flightline: the home view. Projects are sectors; each run is a strip flowing Intake → Loop → Gate → Land.
- Cockpit: one run's detail — terminal (live tmux-backed shell), review (diff + Review & Land, on worktree runs), memory, and mail tabs.
- Memory: each project's shared notes are versioned ENTRIES — kind decision / gotcha / glossary, each with an id, a revision, a verification status (provisional, verified, disputed — only the operator marks one verified, a passing test never does, agents may dispute), a lifecycle (active, superseded, retracted), an author, and evidence — rendered as the decisions.md / gotchas.md / glossary.md views in the Memory bar and the Cockpit's memory tab, where the operator edits, verifies, disputes, retracts, and consolidates. Agents read with \`towerctl memory read\` / \`towerctl memory search\` and record with \`towerctl memory add / update / dispute\`; a standing rule belongs in a skill, and progress notes go to \`towerctl note\`. You read memory with read_memory (the views) and search_memory (the entries); you have NO write path to it — memory is not in the proposal catalog, so a memory change the operator wants happens in the Memory panel, not through you.
- Loops: the headline capability — iterate-until-done. Each iteration injects the task (plus prior feedback), lets the agent build, runs an optional check command (exit 0 = pass), auto-commits, then gates.
- Tower dock (right side): the Clearance queue — agents blocked on a question or a permission request, plus loops holding at a gate — answered inline; also Feed, Test runs, and Health.
- Worktrees: a run can get a fresh git worktree + unique branch so tasks stay isolated; Review & Land merges locally or opens a PR.
- Isolation shield (per project): single-UID (agents share the operator's Unix user) vs per-agent-UID (needs a one-time \`sudo scripts/setup-isolation.sh\`; currently records intent only — enforcement is pending and the UI says so honestly).
- Settings (gear icon, left rail): the admin surface, six tabs — Connections (provider accounts: Codex / Claude / Gemini, each an isolated config dir, log in once per account; GitHub identities: commit author + a PAT stored write-only for the credential broker, served to git only at push time — never in an agent's environment; and custom provider definitions), Routing (global role routing + workflow profiles, below), Projects (per-project routing, testing, GitHub, isolation and autonomy — pick a project, then tune it), Assistant (the copilot's brain), Runway (usage-aware Claude subscription rotation: pool the Claude subscriptions to rotate across and a >96% threshold, and see each subscription's live session/weekly usage and reset timers — when a pooled subscription nears its limit an autonomous loop's builder is moved to another at the iteration boundary, no restart or re-login), and System (terminal caps, the Test kit slot cap, host isolation status, and health: uptime, live viewers, disk free, recent activity).
- Routing (Settings → Routing): which provider + model each pipeline role (${ROLE_IDS.join('/')}) runs on. It is LAYERED: global role defaults < the project's selected workflow profile (a named, reusable role → provider+model bundle) < the project's own per-role overrides — and an explicit provider/model on a sortie or loop still beats all of them. Overrides are per-role atomic: setting a role replaces both its provider and model (no keep-the-provider-change-the-model merge). A role can also be pinned to a specific logged-in account (same provider as the role's provider; the assistant Brain account is refused) — omit the account to run on the shared per-provider login. get_routing shows the global + workflow view, or one project's layered/effective view with a projectId.
- Test kit: the shared Playwright runner. Agents (and loops, and verify-phase fixer sorties) run the browser e2e suite with ONE command — \`towerctl test run\` — which reserves a memory-aware slot (~400 MB each; cap in Settings → System, default 8, CT_TEST_MAX_SLOTS env the fallback when unset) plus a free port, runs the suite, and parses structured per-spec pass/fail results. A loop's check field has a one-click "e2e suite" preset that sets this command, and loop/sortie cards show a green/red suite chip from the last run.
- Stories: per project, user stories are first-class data (the Stories section) — each "As a … I want … so that …", tagged with the routes it exercises and the Playwright spec files that cover it. "Draft from codebase" has Jarvis propose them from the repo. Coverage is DERIVED, never stored: four states — covered (every mapped spec ran and passed), failing (a mapped spec is red), stale-missing (a mapped spec never ran), uncovered (maps to no spec) — read from the latest \`towerctl test run\`.
- Verify phases & the regression gate: the mission composer's "+ verify phase" drops a runner sortie (writes/runs the specs) then a fix phase whose fixers the Tower auto-assigns the failing spec files to at runtime (partitioned by spec file so no two fixers touch the same test file), raising concurrency so they fix simultaneously. A mission's gateSuite is the RAW suite command (e.g. \`npx playwright test\` — NOT \`towerctl test run\`; the Tower runs the gate itself, providing the slot/port/reporter env that towerctl would) and is enforced in code: before the first land it trial-merges the phase's branches into a throwaway worktree and runs the suite against that integrated tree — a red suite (or a merge conflict) lands NOTHING and drops the mission to attention with the failures.
- ⌘K palette: start a run, jump to an agent, or /text to search every terminal's scrollback.`;

/** One canned-help entry: matched case-insensitively, whole-word (with optional plural). */
interface HelpEntry {
  keys: string[];
  answer: string;
}

// Order matters: first match wins, so more specific entries come before broader ones.
const HELP: HelpEntry[] = [
  {
    keys: ['disk', 'vdisk', 'free space'],
    answer:
      '"Disk free (WSL fs)" (Tower dock → Health, and the Disk LED in the topbar) is free space on the ' +
      'WSL2 ext4 virtual disk that holds ~/.ct — not your Windows drive\'s real free space. The vdisk is ' +
      'thin-provisioned against the Windows drive, so this is the Linux filesystem\'s headroom. It turns ' +
      'amber when low.',
  },
  {
    keys: ['pat', 'token', 'personal access', 'github', 'identity', 'identities'],
    answer:
      'A PAT is a GitHub Personal Access Token — what the Tower pushes and opens PRs with. Create one at ' +
      'GitHub → Settings → Developer settings (github.com/settings/tokens): fine-grained needs Contents + ' +
      'Pull requests read/write on the repos you\'ll push to, or classic needs the `repo` scope. Paste it ' +
      'in Connections → GitHub identities → "add token". It is stored write-only for the credential broker — ' +
      'served to git only at push time, never placed in an agent\'s environment, never readable back in the UI.',
  },
  {
    keys: ['path', 'does not exist', 'repopath', 'repo path'],
    answer:
      '"repoPath does not exist" usually means a Windows-style path. The Tower runs inside WSL2, so a ' +
      'project path must be an absolute Linux path with forward slashes — e.g. /home/you/myrepo, or ' +
      '/mnt/c/Users/you/myrepo for a repo on the Windows drive — not C:\\Users\\... . Enter it in ' +
      'Flightline → + project.',
  },
  {
    keys: ['worktree', 'not a git', 'git init', 'git repository'],
    answer:
      '"project is not a git repository — worktrees need git": fresh worktrees (and loops, which always ' +
      'build in one) require the project path to be a git repo. Run `git init` (and make an initial commit) ' +
      'in the project directory — or, for a plain terminal without a worktree, pick "Just a terminal" in ' +
      'the New run dialog and uncheck "Fresh git worktree + branch".' +
      ' If the folder isn\'t a registered project yet either, Jarvis can propose bootstrap_project — ' +
      'register + initialize + push in one Confirm (needs a GitHub repo URL and an identity with a push token).',
  },
  {
    keys: ['slot', 'test', 'playwright', 'e2e', 'suite'],
    answer:
      'Agents (and loops, and verify-phase fixer sorties) run the browser end-to-end suite with one command: ' +
      '`towerctl test run`. It reserves a memory-aware test slot (each run budgeted ~400 MB; the cap is the ' +
      'lower of the configured ceiling — default 8 — and current free RAM ÷ 400 MB, never below 1) plus a free ' +
      'port, runs the Playwright suite, and parses structured per-spec pass/fail results. Change the ceiling in ' +
      'Settings → System (live, stored in ~/.ct/config/settings.json); CT_TEST_MAX_SLOTS is only the fallback ' +
      'when no setting is stored. A loop\'s check field has a one-click "e2e suite" preset that sets this command, ' +
      'and loop/sortie cards show a green/red suite chip from the last run. Slot usage shows in the topbar ' +
      '("N/M slots") and Tower dock → Health → Test slots.',
  },
  {
    keys: ['story', 'stories', 'coverage', 'covered', 'uncovered'],
    answer:
      'The Stories section (per project) holds user stories as first-class data — each "As a … I want … so ' +
      'that …", tagged with the routes it exercises and the Playwright spec files that cover it. Hit "Draft from ' +
      'codebase" to have Jarvis read the repo and propose stories; you edit and Save (nothing is saved until you ' +
      'Save). Coverage is DERIVED, never stored, from the latest `towerctl test run`: a story is covered when ' +
      'every mapped spec ran and stayed green, failing when a mapped spec is red, stale-missing when a mapped ' +
      'spec never ran (a mapping that points at nothing), and uncovered when it maps to no spec.',
  },
  {
    keys: ['verify phase', 'verify', 'regression', 'gatesuite', 'gate suite', 'fixer'],
    answer:
      'A verify phase is a mission-composer template ("+ verify phase"): one runner sortie writes/updates the ' +
      'Playwright specs and runs `towerctl test run`, then a fix phase of 2-3 fixer sorties the Tower auto-assigns ' +
      'the failing spec files to at runtime — partitioned by spec file so no two fixers edit the same test file — ' +
      'raising mission concurrency so they fix simultaneously (capped at 4). A mission\'s gateSuite is the RAW ' +
      'suite command (e.g. `npx playwright test` — NOT `towerctl test run`: agents use towerctl because they hold ' +
      'a terminal token; the gate is run by the Tower itself, which provides the slot, port, and reporter env ' +
      'directly). It is enforced in code: before the first land the Tower merges the phase\'s branches into a ' +
      'throwaway worktree and runs the suite against that integrated tree — if it goes red (or a merge ' +
      'conflicts), NOTHING lands and the mission drops to attention with the failures.',
  },
  {
    keys: ['isolation', 'isolated', 'uid', 'shield', 'single-uid', 'per-agent'],
    answer:
      'Single-UID means all agents run as your Unix user — a compromised agent could read other agents\' ' +
      'files (push secrets stay in the broker regardless). Per-agent-UID gives each agent its own Unix user ' +
      'plus an egress allowlist, but needs a one-time privileged host step: run `sudo scripts/setup-isolation.sh` ' +
      'yourself — the Tower never runs sudo. Even after provisioning, per-agent enforcement is not implemented ' +
      'yet: the shield chip on a sector header records your intent and shows "Per-UID · pending" rather than ' +
      'claiming a boundary that isn\'t in force.',
  },
  {
    keys: ['loop', 'iterate', 'gate', 'check command'],
    answer:
      'A loop is an iterate-until-done run: each iteration injects your task (plus the prior check failure ' +
      'or your gate note), lets the agent work in a fresh git worktree, runs the optional check command there ' +
      '(exit 0 = pass; leave it empty and the agent self-reports done), auto-commits, then applies the gate ' +
      'policy (Every iter / On pass / Never). A gated loop holds in Tower dock → Clearance, where you ' +
      'Continue (with an optional steering note), Land, or Stop. Create one via a sector\'s "New run" → ' +
      '"Loop (iterate-until-done)"; max iterations defaults to 8.',
  },
  {
    keys: ['attention', 'clearance', 'approve', 'permission', 'hold', 'blocked'],
    answer:
      'The Clearance queue (Tower dock, right side) is everything waiting on you: agents blocked on a ' +
      'question (reply inline) or a permission request (Approve / Deny), plus loops holding at a gate. The ' +
      'topbar shows a "◆ N hold" count, and enabling Alerts (the bell) sends OS notifications while the ' +
      'window is backgrounded.',
  },
  {
    keys: ['routing', 'route', 'workflow', 'per-project'],
    answer:
      `Routing (Settings → Routing) decides which provider + model each pipeline role (${ROLE_IDS.join('/')}) ` +
      'runs on. It is layered: global role defaults < the project\'s selected workflow profile < the project\'s ' +
      'own per-role overrides — and an explicit provider/model on a sortie or loop still beats them all. A ' +
      'workflow profile is a named, reusable role → provider+model bundle you select per project ("Inherit — ' +
      'global defaults" when none). Overrides are per-role atomic: setting a role replaces both its provider ' +
      'and model. A role can also be pinned to a specific logged-in account (same provider; the assistant ' +
      'Brain account is refused) — omit it to run on the shared per-provider login. Jarvis can propose ' +
      'set_routing (global or project-scoped) and set_project_workflow; nothing changes until you Confirm.',
  },
  {
    keys: ['propose', 'proposal', 'confirm', 'jarvis'],
    answer:
      'Jarvis (the onboard assistant) can propose a small set of Tower actions — create a provider profile, ' +
      'open a login, set role routing (global or per-project), select a project\'s workflow profile, ' +
      'create/update backlog tasks, clear finished cards, create a loop, register an existing git repo as a ' +
      'project, bootstrap a bare folder (register + initialize + push in one step), arm/disarm a project\'s ' +
      'Autonomous (skip permissions) default, enable/disable a shared skill, ' +
      'set a project\'s skill selection, publish a drafted skill — but never executes them itself. ' +
      'Each proposal renders as a Confirm card in the assistant dock ' +
      'showing the exact resolved args (a create_loop check command is labeled as a host shell command); you ' +
      'Confirm, Edit, or Dismiss. Nothing changes until you click Confirm, proposals expire after 30 minutes, and ' +
      'anything not in that list (approving agent prompts, landing/killing runs, credentials, memory) cannot be ' +
      'proposed at all. In autonomous mode Jarvis confirms its own proposals — except the ten that always wait ' +
      'for your Confirm: a create_loop carrying a host check command, registering a project, init_project_repo ' +
      '(initialize & push a repository), bootstrap_project (register + initialize + push a bare folder), ' +
      'set_project_autonomy, set_skill_enabled, set_project_skills, promote_skill (publish a Jarvis-drafted ' +
      'skill — the card shows the body diff, and the skill lands disabled until you enable it), close_terminal, ' +
      'and restart_terminal. Each ' +
      'either widens where agents may run, writes the host and pushes outward, removes the per-command ' +
      'permission gate, changes which skill instructions run in every future agent, or acts on a live ' +
      'terminal\'s lifecycle. A protected skill (a ' +
      'blocking gate like code-review) can\'t be toggled, deselected, or overwritten through Jarvis at all.',
  },
  {
    keys: ['skill', 'skills'],
    answer:
      'Skills are the shared library of reusable, provider-agnostic instructions (Settings → Skills). Each ' +
      'enabled global skill materializes into every agent\'s config dir (claude-code / codex / gemini). Jarvis ' +
      'can propose set_skill_enabled (turn a library skill on/off) and set_project_skills (a project\'s bundle + ' +
      'per-skill overrides) — both HIGH-risk and always operator-confirmed, because a skill body is instructions ' +
      'injected into every future agent. Jarvis can also DRAFT a skill for you: save_skill_draft writes an inert ' +
      'draft (visible under Settings → Skills → Assistant drafts, reaching no agent), and a promote_skill ' +
      'proposal — always operator-confirmed, with the body diff on the card — publishes it, landing DISABLED ' +
      'until you enable it. Jarvis can only update skills it authored. A skill that enforces a BLOCKING gate ' +
      '(code-review) is protected: Jarvis can\'t propose disabling, deselecting, or overwriting it — change ' +
      'those in Settings → Skills. Ask "what skills are enabled?" and Jarvis reads them with list_skills.',
  },
  {
    keys: ['broker', 'credential'],
    answer:
      'The credential broker holds GitHub PATs write-only and serves them to git over a loopback socket only ' +
      'at push time, so a PAT never appears in any agent\'s environment. The Broker LED in the topbar (and ' +
      'Tower dock → Health) shows whether it is serving.',
  },
  {
    keys: ['memory'],
    answer:
      'Each project has shared memory kept as versioned entries — kind decision, gotcha, or glossary, each with ' +
      'an id, a revision, a verification status (provisional / verified / disputed: only you can mark an entry ' +
      'verified, a passing test never does, and agents may dispute one), a lifecycle (active / superseded / ' +
      'retracted), an author, and evidence. They render as decisions.md, gotchas.md, glossary.md in the Memory bar ' +
      'under each sector and the Cockpit\'s memory tab, where you edit, verify, dispute, retract, and consolidate. ' +
      'Agents read with `towerctl memory read` (views) or `towerctl memory search` (entries) and record with ' +
      '`towerctl memory add --kind …`, `update <id> --rev n`, or `dispute <id> --rev n`; their standing rules ' +
      'belong in a skill and their progress notes in `towerctl note`. Jarvis reads memory (read_memory, ' +
      'search_memory) but has no write path to it — memory is not in the proposal catalog.',
  },
  {
    keys: ['mail', 'message'],
    answer:
      'Each agent run has a mail tab in the Cockpit: send it an instruction and the Tower delivers it when ' +
      'the agent next goes idle (never injected into an open dialog). Agents message each other with ' +
      '`towerctl mail send/inbox`.',
  },
  {
    keys: ['account', 'login', 'log in', 'sign in', 'provider'],
    answer:
      'Settings (gear icon in the left rail) → Connections → Provider accounts: each account is a distinct Claude Code / ' +
      'Gemini CLI / Codex login, isolated in its own config dir. Click "log in" once per account, then pick ' +
      'that account when creating a run.',
  },
  {
    keys: ['palette', 'search', 'logs', 'scrollback', 'command k', 'cmd k'],
    answer:
      '⌘K opens the command palette: start a new run, jump to an agent by name, or type /text to search ' +
      'every terminal\'s scrollback logs.',
  },
];

const DEFAULT_ANSWER =
  "I don't have a canned answer for that — check the relevant panel, or ask me to look at live state.";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word match (plural-tolerant) so "pat" matches "PAT" but not "path"/"patch". */
function matches(topic: string, key: string): boolean {
  return new RegExp(`\\b${escapeRegExp(key)}s?\\b`, 'i').test(topic);
}

/**
 * Curated fallback for common setup/nav questions (the `explain` tool). Case-insensitive
 * keyword match; first matching entry wins; a sensible default when nothing matches.
 */
export function lookupHelp(topic: string): string {
  for (const entry of HELP) {
    if (entry.keys.some((k) => matches(topic, k))) return entry.answer;
  }
  return DEFAULT_ANSWER;
}
