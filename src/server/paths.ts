// Canonical on-disk layout for Tower state. Everything lives under ~/.ct
// (overridable with CT_HOME for tests / multiple instances). No SQLite — JSON
// config + append-only JSONL events, per SPEC D15.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';

export const CT_HOME = process.env.CT_HOME ?? join(homedir(), '.ct');

/** Tower-managed worktrees live in `<dirname(repoPath)>/<CT_WORKTREES_DIRNAME>/<projectId>` — a SIBLING
 *  of the repo, never inside its working tree (a nested one would be swept into the repo by a loop's
 *  `git add -A`). Named here so the derivation sites and the guard that refuses to register such a
 *  directory as a project all agree on one literal. */
export const CT_WORKTREES_DIRNAME = '.ct-worktrees';

/**
 * The ONE canonical form of a project repoPath — every producer and comparer must use it, or the same
 * repo registers twice under paths that only LOOK different.
 *
 * This is load-bearing beyond de-duplication: a project's worktree root is `dirname(repoPath)/…`, so an
 * un-canonical '/x/repo/.' has dirname '/x/repo' and would put live worktrees INSIDE the repo's own
 * working tree, where a loop's `git add -A` sweeps them into commits. resolve() collapses '.', '..',
 * '//' and trailing slashes to the single path they all denote.
 *
 * Two deliberate limits. (1) Only absolute input is resolved: resolve() is CWD-relative, so resolving a
 * relative path here would silently anchor it to the daemon's working directory and slip past enrich's
 * absolute-path gate — left untouched, it reaches that gate and gets a self-correctable error. (2) No
 * realpathSync: this runs inside the action's zod, which re-validates persisted proposals on load, and
 * realpath THROWS on a path that no longer exists — that would drop stored records. Symlink resolution
 * belongs in enrich, where a throw is a caught, reportable error.
 */
export function normalizeRepoPath(p: string): string {
  return p.startsWith('/') ? resolve(p) : p;
}

export const paths = {
  home: CT_HOME,
  config: join(CT_HOME, 'config'),
  projects: join(CT_HOME, 'config', 'projects.json'),
  terminals: join(CT_HOME, 'config', 'terminals.json'),
  loops: join(CT_HOME, 'config', 'loops.json'),
  missions: join(CT_HOME, 'config', 'missions.json'),
  providers: join(CT_HOME, 'config', 'providers.json'),
  // SPEC-STORYLOOP §1.2 — per-project user-story corpus (all projects; StoryStore filters).
  stories: join(CT_HOME, 'config', 'stories.json'),
  // SPEC-SKILLS — the canonical skill store: META index here; bodies/assets under skillsData.
  skills: join(CT_HOME, 'config', 'skills.json'),
  skillsData: join(CT_HOME, 'skills'),
  // SPEC-SKILLS Phase 3 — per-project skill bundles + selection overlays (config JSON, 0600).
  skillSelection: join(CT_HOME, 'config', 'skill-selection.json'),
  // SPEC-SKILLS Phase 5b — the assistant's INERT skill-draft pad (bodies inline, atomic 0600).
  // Deliberately a separate file from `skills`: the materializer never reads it.
  skillDrafts: join(CT_HOME, 'config', 'skill-drafts.json'),
  // SPEC-BACKLOG §1 ⟦DP-B2⟧ — cross-project stored pre-execution lanes (all projects; BacklogStore).
  backlog: join(CT_HOME, 'config', 'backlog.json'),
  // SPEC-LOOP W6 — the routed reviewers' structured submissions (all missions; ReviewStore, 0600).
  reviews: join(CT_HOME, 'config', 'reviews.json'),
  // SPEC-SKILLS-GATE — loop-green gate attestations (all missions; GateEvidenceStore, 0600).
  gates: join(CT_HOME, 'config', 'gate-evidence.json'),
  research: join(CT_HOME, 'config', 'research.json'),
  // SPEC-PLANNER §1 — the planner-terminal consults (all missions; ConsultStore, 0600).
  consults: join(CT_HOME, 'config', 'consults.json'),
  // SPEC-TESTING §4 — per-project e2e testing config (all projects; TestingConfigStore).
  testing: join(CT_HOME, 'config', 'testing.json'),
  // SPEC-RUNWAY — usage-aware claude-code subscription rotation config (RunwayStore, 0600).
  runway: join(CT_HOME, 'config', 'runway.json'),
  // SPEC-RUNWAY — per-subscription usage samples, one JSON file per accountUuid (UsageStore, 0600).
  usage: join(CT_HOME, 'usage'),
  // SPEC-RUNWAY live-swap -- per-terminal CLAUDE_CONFIG_DIR slots (`slots/<terminalId>`), seeded from the
  // account vault at spawn ONLY for live-swap-eligible claude-code terminals (live-slot.ts). 0700 root.
  slots: join(CT_HOME, 'slots'),
  // SPEC-MEMORY — versioned shared-memory entries, one subdir per project (entries.json + history.jsonl,
  // 0600) + the generated decisions/gotchas/glossary markdown views. No SQLite (D15). See memory/store.ts.
  memory: join(CT_HOME, 'memory'),
  // SPEC-MODELS §2 — built-in provider model catalogs (codex live-discovered; claude/gemini curated). No secrets.
  modelCatalogs: join(CT_HOME, 'config', 'model-catalogs.json'),
  session: join(CT_HOME, 'config', 'session.json'),
  // SPEC-ASSISTANT-CONTROL §2 — the human-gate proposal ledger (ProposalStore, written 0600).
  assistantProposals: join(CT_HOME, 'assistant', 'proposals.json'),
  events: join(CT_HOME, 'events'),
  // SPEC-LOOP W4 — per-mission delivery reports (report.json + REPORT.md/.html + proof/). Created
  // LAZILY by report.ts at the done/failed transition (the RUNS_DIR precedent), NOT in ensureDirs.
  reports: join(CT_HOME, 'reports'),
  spool: join(CT_HOME, 'spool'),
  logs: join(CT_HOME, 'logs'),
  secrets: join(CT_HOME, 'secrets'),
  audit: join(CT_HOME, 'audit.log'),
  intent: join(CT_HOME, 'intent.log'),
} as const;

/** Create the directory tree once at startup. Idempotent. */
export function ensureDirs(): void {
  for (const dir of [paths.config, paths.events, paths.spool, paths.logs, paths.usage, paths.memory, paths.slots]) {
    mkdirSync(dir, { recursive: true });
  }
  // Secrets dir is 0700 — it holds the assistant MCP token. `mode` on mkdirSync only applies when the
  // dir is CREATED and is masked by umask, so a secrets dir made by an older Tower (before this mode
  // was set, or under a loose umask) would keep world/group-traversable perms. chmod it every boot to
  // re-tighten unconditionally.
  mkdirSync(paths.secrets, { recursive: true, mode: 0o700 });
  try {
    chmodSync(paths.secrets, 0o700);
  } catch {
    /* best-effort re-tighten — a missing/again dir surfaces on the write that follows, not here */
  }
}

export function logPathFor(terminalId: string): string {
  return join(paths.logs, `${terminalId}.log`);
}
