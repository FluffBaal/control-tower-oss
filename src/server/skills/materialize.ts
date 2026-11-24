// SPEC-SKILLS — materialize the central skill library into a provider's native skills location. The
// Phase-1 sync/lock/marker/manifest/stage-swap machinery is provider-agnostic; each built-in provider is
// described by a Channel descriptor (below) that parametrizes the SAME machinery — the diff over Phase 1
// is parametrization plus two small units (managed-section spans + command wrappers in ./sections). Every
// write lands under ctx.configDir — NOTHING under ctx.cwd/repoPath (the git tree stays untouched;
// per-project skills ride the sortie brief in a later phase).
//
// PINNED 2026-08-06:
//  · claude 2.1.223 — user-scope skills load from join(CLAUDE_CONFIG_DIR ?? ~/.claude, 'skills'), each as
//    <name>/SKILL.md. User memory ("User" scope) loads from join(CLAUDE_CONFIG_DIR ?? ~/.claude, 'CLAUDE.md'),
//    always-on for every session in every project (binary-verified: the "User" case of the memory-path
//    switch). Re-probe on any CLI update: string the binary for the "CLAUDE.md" join in the memory-path
//    switch, then live-check a spawned pane's /memory listing. configDir is always Tower-minted, so the
//    operator's personal ~/.claude/CLAUDE.md is out of reach.
//  · codex-cli 0.144.3 — NATIVE Agent Skills at $CODEX_HOME/skills/<id>/SKILL.md (CODEX_HOME=configDir),
//    proven via the app-server `skills/list` probe; the frontmatter `name` is the identity/mention handle
//    and the allowed key set is {name, description, license, allowed-tools, metadata}. Global
//    instructions load from $CODEX_HOME/AGENTS.md. There is NO $CODEX_HOME/prompts/ custom-prompt dir in
//    0.144.3 — do not target it.
//  · gemini-cli 0.51.0 — NATIVE Agent Skills at <configDir>/.gemini/skills/<id>/SKILL.md (loader keys on
//    frontmatter name + description), user command wrappers at <configDir>/.gemini/commands/<id>.toml,
//    and home-level context files (AGENTS.md / GEMINI.md) under <configDir>/.gemini/.
// Each provider's skills dir is a SHARED namespace (claude plants installed plugins + skills/.staging;
// codex plants skills/.system; gemini its own) — so ownership is PER-SKILL-DIR (an in-dir marker + a
// manifest), never a whole-dir swap or wipe, and the Tower stages OUTSIDE the skills dirs (at
// .ct-skills-stage/). Re-run the SPEC-SKILLS §1 probes on any CLI update (claude: string the binary for
// the "Loading skills from:" line; codex: the app-server `skills/list` probe against a scratch
// CODEX_HOME; gemini: `GEMINI_CLI_HOME=<scratch> gemini skills list`) — if a probe stops discovering the
// planted skill, STOP: the channel target moved.

import { createHash } from 'node:crypto';
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, lstatSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { writeJsonAtomic } from '../store.js';
import { isSafeName, shortId } from '../ids.js';
import { audit } from '../audit.js';
import { isSafeAssetPath, needsAutonomyClearance, type SkillStore } from './store.js';
import { resolveSkillSelection } from './selection.js';
import {
  applyManagedSection, renderSectionBody, sectionHash, emitCommandToml, parseCommandMarker,
  SECTION_BUDGET_BYTES, type SectionNote,
} from './sections.js';
import { MEMORY_SECTION_BLOCK } from '../memory-instruction.js';
import type { Skill, ProviderId, Terminal } from '../../shared/types.js';
import type { LaunchContext } from '../adapters/types.js';

// The Tower's per-configDir sync index, ownership marker, and staging area — all names OUTSIDE the CLIs'
// own skills-staging dirs so the two writers never collide.
const MANIFEST_NAME = '.ct-skills.json';
const MARKER_NAME = '.ct-skill.json';
const STAGE_DIRNAME = '.ct-skills-stage';

// Per-provider capability rows (SPEC-SKILLS §3/§5). A skill that `requires` anything OUTSIDE its
// channel's row is not materialized for that provider (fail-closed, below). The multi-agent family
// (subagents/workflow-tool/worktree-isolation) is claude-only — excluded from codex/gemini here AND by
// its curated supportedProviders, so it is excluded twice over.
const PROVIDER_CAPABILITIES: Record<'claude-code' | 'codex' | 'gemini-cli', ReadonlySet<string>> = {
  'claude-code': new Set(['subagents', 'workflow-tool', 'worktree-isolation', 'shell', 'network', 'interactive-questions']),
  codex: new Set(['shell', 'network']),
  'gemini-cli': new Set(['shell', 'network']),
};

/**
 * A per-provider materialization channel — the ONE new concept. Each descriptor parametrizes the shared
 * sync/lock/manifest machinery: where the skills dir is, how a SKILL.md's frontmatter is emitted, which
 * capabilities the harness has, whether it can honor a user-only ('never') skill natively, and (codex +
 * gemini only) the shared instructions file + (gemini only) the command-wrapper dir.
 */
interface SkillDirChannel {
  provider: ProviderId; // the overrides / supportedProviders key
  channelId: string; // recorded as the manifest `channel`
  capabilities: ReadonlySet<string>;
  skillsRoot(configDir: string): string;
  emit(skill: Skill, body: string): string;
  /** true only when the harness can enforce user-only invocation natively (claude's disable flag). When
   *  false, a `model:'never'` skill has no enforcement surface and is skipped (fail-closed, §5.3). */
  userOnlyInvocable: boolean;
  sectionFile?(configDir: string): string; // AGENTS.md (codex) / .gemini/GEMINI.md (gemini)
  commandsRoot?(configDir: string): string; // .gemini/commands (gemini only)
}

const CHANNELS: Partial<Record<ProviderId, SkillDirChannel>> = {
  'claude-code': {
    provider: 'claude-code',
    channelId: 'claude-skill-dir',
    capabilities: PROVIDER_CAPABILITIES['claude-code'],
    skillsRoot: (cfg) => join(cfg, 'skills'),
    emit: emitSkillMd,
    userOnlyInvocable: true,
    // claude's always-on user memory (see the PINNED note) — the ONE surface where a blocking gate's
    // policy text can reach every claude session. It routes through the SAME Phase-2 syncManagedSection
    // machinery as codex AGENTS.md / gemini GEMINI.md: a fenced managed span, merge-not-replace, torn-fence
    // hands-off, byte-preserving of every operator byte outside the fence. SPEC-MEMADOPT: the span now
    // ALWAYS carries the standing project-memory block, so every synced account dir on all three channels
    // gains its section file — the span is ever-present, no longer non-empty-on-claude-only (see the
    // behavior-change note in syncManagedSection).
    sectionFile: (cfg) => join(cfg, 'CLAUDE.md'),
  },
  codex: {
    provider: 'codex',
    channelId: 'codex-skill-dir',
    capabilities: PROVIDER_CAPABILITIES.codex,
    skillsRoot: (cfg) => join(cfg, 'skills'), // CODEX_HOME === configDir
    emit: emitPortableSkillMd,
    userOnlyInvocable: false,
    sectionFile: (cfg) => join(cfg, 'AGENTS.md'),
  },
  'gemini-cli': {
    provider: 'gemini-cli',
    channelId: 'gemini-skill-dir',
    capabilities: PROVIDER_CAPABILITIES['gemini-cli'],
    skillsRoot: (cfg) => join(cfg, '.gemini', 'skills'),
    emit: emitPortableSkillMd,
    userOnlyInvocable: false,
    sectionFile: (cfg) => join(cfg, '.gemini', 'GEMINI.md'),
    commandsRoot: (cfg) => join(cfg, '.gemini', 'commands'),
  },
};

interface ManifestEntry {
  version: number;
  contentHash: string;
  writtenPaths: string[];
}
interface Manifest {
  v: number;
  channel: string;
  skills: Record<string, ManifestEntry>;
  // Additive, OPTIONAL Phase-2 maps (§4.3). Only present for channels that have those surfaces, so a
  // Phase-1 (claude) manifest stays byte-shape-identical. The in-artifact markers/fences remain the
  // ownership TRUTH; these are a rebuildable fast index.
  files?: Record<string, { skillId: string; contentHash: string }>;
  sections?: Record<string, { contentHash: string }>;
}
interface Marker {
  skillId: string;
  contentHash: string;
  version: number;
  writtenAt: string;
}
interface SyncCounts {
  written: number;
  removed: number;
  skippedConflict: number;
  unchanged: number;
  skippedUnsupported: number; // a 'never' skill with no enforcement surface on this channel (§5.3)
  skippedUncleared: number; // an uncleared assistant-origin skill excluded from a bypass-context sync (wave 2)
  removedTampered: number; // a marker-less artifact at a known uncleared skill id, removed by an excluding sync (wave 2)
  scanFailures: number; // a classification readdir FAILED — the removal pass was blind this sync (wave 2)
  sectionWritten: number;
  sectionRemoved: number;
  commandsWritten: number;
  commandsRemoved: number;
}

function emptyCounts(): SyncCounts {
  return {
    written: 0, removed: 0, skippedConflict: 0, unchanged: 0, skippedUnsupported: 0, skippedUncleared: 0,
    removedTampered: 0, scanFailures: 0,
    sectionWritten: 0, sectionRemoved: 0, commandsWritten: 0, commandsRemoved: 0,
  };
}

/**
 * The gate, pure so the call site stays one dumb line and the dispatch extends without touching
 * terminal-manager. A provider materializes iff it has a Channel descriptor (claude-code, codex,
 * gemini-cli) — `shell` and `custom:<slug>` fall out through the lookup, so no synthesize.ts change is
 * needed. The purpose allowlist mirrors the onboarding-seed gate (adapters/claude.ts): work AND planner
 * spawns run programmatically and get the library; a login pane keeps its fully-interactive first run and
 * is skipped. An explicit allowlist stays fail-safe: any future purpose materializes nothing until it
 * opts in.
 */
export function shouldMaterialize(provider: ProviderId, purpose: Terminal['purpose'] | undefined): boolean {
  if (!CHANNELS[provider]) return false;
  return purpose === undefined || purpose === 'work' || purpose === 'planner';
}

// requires.capabilities persists as PLAIN STRINGS for downgrade tolerance (store.ts), so an unrecognized
// value must never widen eligibility — a capability outside the channel's row fails CLOSED.
function capsSatisfied(caps: readonly string[] | undefined, channelCaps: ReadonlySet<string>): boolean {
  if (!caps) return true;
  return caps.every((c) => channelCaps.has(c));
}

/** The provider ids that have a materialization channel (claude-code, codex, gemini-cli) — the set a
 *  skill can ever reach a filesystem for. Exported so the per-project resolution VIEW can report each
 *  entry's provider reach without re-deriving the channel table (SPEC-SKILLS Phase 3 §2.2). */
export const CHANNEL_PROVIDER_IDS: ProviderId[] = Object.keys(CHANNELS) as ProviderId[];

/**
 * Whether `skill` is eligible for `provider` on PROVIDER grounds ALONE — has a channel, the channel is
 * in supportedProviders (or none is declared), its required capabilities fit the channel's row, and the
 * skill is not omit'd for this provider. `enabled`/`scope` are DELIBERATELY excluded: those are
 * SELECTION, resolved by resolveSkillSelection (§2.1); splitting eligibility from selection IS the
 * Phase-3 conceptual change, and the same predicate feeds both the sync and the API view (one source of
 * truth). Exported for the effective-view composer (server.ts).
 */
export function providerEligible(skill: Skill, provider: ProviderId): boolean {
  const ch = CHANNELS[provider];
  if (!ch) return false;
  return (
    (!skill.supportedProviders || skill.supportedProviders.includes(provider)) &&
    capsSatisfied(skill.requires?.capabilities, ch.capabilities) &&
    skill.providerOverrides?.[provider]?.omit !== true
  );
}

/** The channel's base-eligible skill set (before per-skill channel routing). Deterministically ordered so
 *  the sync + audit are stable. requires.models is deliberately NOT a filter: it names what the BODY
 *  needs at run time (e.g. a subagent-model fleet), which the harness can spawn regardless of the pane's
 *  own model. The 'never'-invocation rule is applied per-skill during routing (§5.3), not here, so a
 *  skipped skill can still be counted in the audit.
 *
 *  SPEC-SKILLS Phase 3 §5 — the SELECTION half now runs through resolveSkillSelection with NO project
 *  (the GLOBAL baseline: enabled ∧ scope==='global'); providerEligible is the PROVIDER half. This is
 *  byte-identical to the pre-Phase-3 filter (proven by the no-change materialize test). Per-project
 *  selection MUST NEVER enter this function: ctx.configDir is per-ACCOUNT and shared across every project
 *  a same-account terminal serves, so emitting a project-dependent set would let a spawn in project B
 *  delete project A's live skills out from under A's still-running agent — per-project delivery is the
 *  sortie-brief sub-phase, never the shared account dir. */
function baseEligibleSkills(store: SkillStore, ch: SkillDirChannel): Skill[] {
  return resolveSkillSelection(store.list())
    .entries.map((e) => e.skill)
    .filter((s) => providerEligible(s, ch.provider))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- Per-configDir single-writer mutex. Two concurrent claude terminals on ONE account share
//      ctx.configDir; the Tower is the ONLY writer of these paths (single Node process), so an in-process
//      promise chain per dir is sufficient — no cross-process file lock. Different configDirs run in
//      parallel (different keys). ----
const chains = new Map<string, Promise<void>>();

function withConfigDirLock(dir: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(dir) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn); // a prior failure never blocks the next spawn
  const tail = run.catch(() => {}); // the STORED tail is failure-swallowed so the chain can't be poisoned
  chains.set(dir, tail);
  void tail.finally(() => {
    if (chains.get(dir) === tail) chains.delete(dir); // compare-and-delete so the map can't grow unbounded
  });
  return run;
}

/** The materializer's spawn-plane dependency (SPEC-SKILLS Phase 5b wave 2). REQUIRED, never
 *  optional-with-default — a `() => false` default would be a fail-open seam for any future call site.
 *  The one production implementation reads the terminal registry (terminal-manager). */
export interface MaterializeDeps {
  /** Any not-killed skip-permissions terminal whose account resolves to this configDir. */
  hasLiveBypass(configDir: string): boolean;
}

/**
 * Materialize the eligible global skills into this account's native provider location. NEVER throws for a
 * per-skill problem (those degrade in place); a whole-sync failure (unwritable configDir, disk full) DOES
 * reject so the terminal-manager call site can log + audit and launch skill-less — the caller's `.catch` is
 * load-bearing (a throw into createTerminal would trigger cleanupFailedCreate and kill the spawn).
 *
 * Autonomy clearance (wave 2): an UNCLEARED assistant-origin skill is excluded whenever the sync runs in
 * a bypass context — this spawn itself skips permissions, OR any live skip-permissions terminal shares
 * the account dir. The belt read happens INSIDE the per-configDir lock, as late as possible: every spawn
 * upserts its Terminal record (autoAccept stamped) BEFORE its materialize runs, and same-dir syncs
 * serialize on this lock — so if an interactive sync reads the registry before a bypass spawn's record
 * exists, that bypass spawn's own sync is queued AFTER it on the same lock and removes the uncleared
 * skill before its session ever starts. A bypass session can therefore never START with an uncleared
 * skill present, and while its record is live no interactive sync re-adds one.
 *
 * Residual windows (honesty, not silently claimed closed): the belt's truth is the RECORD, not the
 * process. A bypass CLI that outlives its 'killed' record (SIGKILL-timeout lag, a crash between
 * record-kill and process death) could re-scan mid-session after an interactive sync re-added an
 * uncleared skill; likewise anything running in the account dir outside Tower records. The REMOVAL
 * direction has its own residuals: (a) a whole-sync THROW on a bypass spawn (unwritable configDir,
 * disk full) is caught at the call site so the spawn proceeds — the CLI then launches over UN-SWEPT
 * content, uncleared leftovers included, because the removal pass never ran; (b) a TORN
 * managed-section fence (CLAUDE.md / AGENTS.md / GEMINI.md) puts that file hands-off, so an uncleared
 * skill's section body already inside the fence survives into bypass sessions until the operator
 * repairs the fence. Closing all of these needs the per-spawn sortie-brief delivery path (or
 * spawn-blocking on sync failure / a fence-reset policy) — named forward seams, out of scope here.
 */
export async function materializeSkills(
  provider: ProviderId,
  ctx: LaunchContext,
  store: SkillStore,
  deps: MaterializeDeps,
): Promise<void> {
  if (!shouldMaterialize(provider, ctx.purpose)) return;
  const ch = CHANNELS[provider];
  if (!ch) return; // defensive — shouldMaterialize already gates on the CHANNELS lookup
  await withConfigDirLock(ctx.configDir, async () => {
    let live = true; // fail CLOSED: a registry read failure must exclude, never include
    try {
      live = deps.hasLiveBypass(ctx.configDir);
    } catch {
      live = true;
    }
    const excludeUncleared = ctx.skipPermissions === true || live;
    const counts = syncChannel(ch, ctx, store, { excludeUncleared });
    // Counts only, never contents (the no-secrets-in-audit posture).
    audit('skill.materialize', {
      terminalId: ctx.terminalId,
      projectId: ctx.projectId,
      provider,
      ...counts,
    });
  });
}

/** The per-skill routing decision for a channel (§4.2/§5.3): a base-eligible skill materializes as a
 *  skill DIR (the common path), a command-only wrapper, an inline section note, or is skipped-unsupported. */
interface ChannelRouting {
  dirSkills: Skill[]; // materialize as <skillsRoot>/<id>/SKILL.md
  commandTargets: { skill: Skill; hasDir: boolean }[]; // gemini command wrappers (dir-backed or inline)
  sectionNotes: Skill[]; // authored channel:'instructions-file' bodies → the managed section
  gateSkills: Skill[]; // materialized skills with a blocking gate → one policy line in the section
  skippedUnsupported: number;
  skippedUncleared: number;
}

/** Per-sync routing options (SPEC-SKILLS Phase 5b wave 2). `excludeUncleared`: this sync runs in a
 *  bypass context (a skip-permissions spawn, or a live skip-permissions terminal on the account dir). */
interface SyncOpts {
  excludeUncleared: boolean;
}

/** Route each base-eligible skill to exactly one target for this channel. An authored per-provider
 *  override channel is honored ONLY where the channel has that surface (instructions-file → a channel with
 *  a section file; invocable-prompt → a channel with a commands dir); otherwise it falls through to the
 *  skill dir. A 'never' skill has no enforcement surface on a non-user-only channel, so it is skipped
 *  (fail-closed) unless an authored invocable-prompt override gives it a genuinely user-triggered home.
 *
 *  The autonomy-clearance gate is the FIRST line of the loop, before any routing branch, so ONE predicate
 *  covers every surface at once: an excluded skill never enters dirSkills (not written, absent from
 *  eligibleIds, so the deletion pass REMOVES an already-materialized dir), never enters commandTargets
 *  (the wrapper desired-set diff removes its .toml), never enters sectionNotes/gateSkills (the managed
 *  section re-renders without it). The churn invariant this enforces: a sync with excludeUncleared leaves
 *  ZERO uncleared assistant-origin artifacts in the configDir; a sync without it restores them —
 *  divergence between consecutive syncs on a shared dir always moves toward FEWER LLM-authored
 *  instructions reaching a bypass agent, never more. */
function routeSkills(ch: SkillDirChannel, store: SkillStore, opts: SyncOpts): ChannelRouting {
  const r: ChannelRouting = {
    dirSkills: [], commandTargets: [], sectionNotes: [], gateSkills: [], skippedUnsupported: 0, skippedUncleared: 0,
  };
  let loggedCodexInvocable = false;
  for (const skill of baseEligibleSkills(store, ch)) {
    if (opts.excludeUncleared && needsAutonomyClearance(skill)) {
      r.skippedUncleared++;
      continue;
    }
    const overrideChannel = skill.providerOverrides?.[ch.provider]?.channel;
    const blocking = skill.gate?.mode === 'blocking';

    if (overrideChannel === 'instructions-file' && ch.sectionFile) {
      r.sectionNotes.push(skill);
      if (blocking) r.gateSkills.push(skill);
      continue;
    }
    if (overrideChannel === 'invocable-prompt' && ch.commandsRoot) {
      // gemini's one honest user-only surface: a command wrapper, no skill dir.
      r.commandTargets.push({ skill, hasDir: false });
      if (blocking) r.gateSkills.push(skill);
      continue;
    }
    if (overrideChannel === 'invocable-prompt' && !ch.commandsRoot && !ch.userOnlyInvocable) {
      // codex has no invocable-prompt target — honest, not silent, then fall through to the dir channel.
      if (!loggedCodexInvocable) {
        console.error(`[skills] '${skill.id}': provider override channel 'invocable-prompt' has no target on ${ch.provider}; materializing as a skill dir`);
        loggedCodexInvocable = true;
      }
    }

    // Default: the skill dir, subject to the user-only ('never') rule on non-user-only channels.
    if (!ch.userOnlyInvocable && skill.invocation.model === 'never') {
      r.skippedUnsupported++;
      continue;
    }
    r.dirSkills.push(skill);
    if (blocking) r.gateSkills.push(skill);
    if (ch.commandsRoot && skill.invocation.user) r.commandTargets.push({ skill, hasDir: true });
  }
  return r;
}

/** The whole sync, synchronous like the store's own fs work, run inside the per-configDir lock. Any tear
 *  is healed on the next spawn by the marker/fence scan + hash diff, so all artifact writes precede the
 *  single manifest write. */
function syncChannel(ch: SkillDirChannel, ctx: LaunchContext, store: SkillStore, opts: SyncOpts): SyncCounts {
  const configDir = ctx.configDir;
  const skillsRoot = ch.skillsRoot(configDir);
  const stageRoot = join(configDir, STAGE_DIRNAME);
  const manifestPath = join(configDir, MANIFEST_NAME);
  const relRoot = relative(configDir, skillsRoot).split(sep).join('/');

  mkdirSync(skillsRoot, { recursive: true }); // must NOT depend on writeHookConfig having run

  // 1. Sweep stale staging leftovers from a crashed prior sync.
  sweepDir(stageRoot);

  // 2. Read the manifest tolerantly (missing => empty; corrupt => quarantine + empty).
  const manifest = readManifest(manifestPath);
  const counts = emptyCounts();

  // 3. Scan the live skills dir once; classify each entry owned (marker matches its dirname) vs unmanaged.
  //    A scan FAILURE is not an empty dir: nothing gets classified, so the removal pass is blind this
  //    sync — under an excluding sync that means stale uncleared content can survive. readdirChecked
  //    logs it and the scanFailures count rides the skill.materialize audit line, so a blind removal
  //    pass is never reported as a clean one (removed:0 with scanFailures:0 is the only honest "clean").
  const scan = readdirChecked(skillsRoot);
  if (scan.failed) counts.scanFailures++;
  const owned = new Map<string, Marker>();
  const unmanaged = new Set<string>();
  for (const name of scan.names) {
    if (name.startsWith('.')) continue; // dotfiles/dot-dirs (incl the CLIs' own staging + codex's .system) are never skills
    // lstat so a symlink is classified by its OWN entry, not its target. Only a real directory carrying a
    // matching marker is ours; EVERY other entry — a plain dir, a plain file, or a symlink — is non-owned
    // content that must be surfaced as a conflict and never clobbered (a bare file at skills/<id> would
    // otherwise slip past the conflict guard and have its bytes destroyed by the swap).
    let entry;
    try {
      entry = lstatSync(join(skillsRoot, name));
    } catch {
      continue;
    }
    const marker = entry.isDirectory() ? readMarker(join(skillsRoot, name, MARKER_NAME)) : undefined;
    if (marker && marker.skillId === name) owned.set(name, marker);
    else unmanaged.add(name); // an operator hand-drop, a CLI plugin/system skill, or a stray file — never touched
  }

  const routing = routeSkills(ch, store, opts);
  const eligibleIds = new Set(routing.dirSkills.map((s) => s.id));
  counts.skippedUnsupported = routing.skippedUnsupported;
  counts.skippedUncleared = routing.skippedUncleared;
  // The tamper-belt input for an excluding sync (wave 2): every KNOWN uncleared skill id, STORE-WIDE —
  // selection/eligibility deliberately do not narrow it (a disabled or deselected uncleared skill's
  // leftover artifact is just as much LLM-authored text). undefined when this sync may carry uncleared
  // skills, so the belt below cannot fire on an interactive sync.
  const unclearedIds = opts.excludeUncleared
    ? new Set(store.list().filter((s) => needsAutonomyClearance(s)).map((s) => s.id))
    : undefined;
  const next: Manifest = { v: 1, channel: ch.channelId, skills: {} };

  // 4. Write/refresh each skill-dir skill.
  for (const skill of routing.dirSkills) {
    const id = skill.id;
    if (!isSafeName(id)) {
      // Defensive: the store enforces this at insert, but a hand-edited skills.json might not.
      console.error(`[skills] refusing to materialize '${id}': unsafe skill id`);
      continue;
    }
    if (unmanaged.has(id)) {
      // Conflict: a non-owned entry (dir, file, or symlink) sits at this id. Never clobber operator/CLI
      // content — surface it and retry (and re-surface) every spawn; recovery is the operator renaming or
      // deleting theirs.
      counts.skippedConflict++;
      continue;
    }
    const marker = owned.get(id);
    if (marker && marker.contentHash === skill.contentHash && existsSync(join(skillsRoot, id, 'SKILL.md'))) {
      // Idempotent fast path: unchanged content AND the emitted file is present (existsSync self-heals a
      // hand-gutted managed dir). Carry the manifest entry forward, rebuilding it if the manifest was lost.
      counts.unchanged++;
      next.skills[id] = manifest.skills[id] ?? {
        version: skill.version,
        contentHash: skill.contentHash,
        writtenPaths: writtenPathsFor(skill, relRoot),
      };
      continue;
    }
    try {
      writeSkillDir(ch, store, skill, skillsRoot, stageRoot);
      counts.written++;
      next.skills[id] = { version: skill.version, contentHash: skill.contentHash, writtenPaths: writtenPathsFor(skill, relRoot) };
    } catch (err) {
      // Per-skill degradation: skip this one, keep going. It is simply not recorded, so a later healthy
      // spawn retries it. A stage-swap that threw mid-way leaves an orphan under stageRoot, swept next sync.
      console.error(`[skills] skipping '${id}' during materialization:`, err);
    }
  }

  // 5. Deletion pass: a managed dir whose skill is no longer eligible dies. Unmanaged dirs were never in
  //    `owned`, so they are untouched by construction. Refuse a symlink (the shred discipline).
  for (const id of owned.keys()) {
    if (eligibleIds.has(id)) continue; // still eligible (written, unchanged, or a kept transient write-fail)
    if (removeManagedDir(skillsRoot, id)) counts.removed++;
  }
  // 5b. Tamper belt (wave 2): an UNMANAGED entry sitting at a KNOWN uncleared skill id. The conflict
  //     discipline above preserves unmanaged entries forever — which would turn marker deletion into a
  //     PERMANENT exemption: an agent following an uncleared body's "delete the .ct-skill.json in your
  //     skill dir" would leave that body loading into every future bypass session on this shared
  //     account dir, unhealable by any sync. Under an excluding sync the exact name-match to an
  //     uncleared skill outweighs the missing/corrupt marker: the entry is a TAMPERED owned artifact
  //     and is removed, marker or not. The accepted narrow trade-off: an operator hand-drop or CLI
  //     plugin named EXACTLY like an uncleared skill id is removed too — only ever under a
  //     bypass-context sync (an interactive sync still never touches unmanaged entries).
  if (unclearedIds) {
    for (const name of unmanaged) {
      if (!unclearedIds.has(name)) continue;
      if (removeTamperedEntry(join(skillsRoot, name), name)) counts.removedTampered++;
    }
  }

  // 6. Command wrappers (gemini only) — Model A owned artifacts, same scan/classify/conflict discipline.
  //    A SEPARATE surface: an obstruction (e.g. a file sitting at .gemini/commands, so its mkdir throws)
  //    is logged and this surface skipped — it must NEVER abort the dir sync + manifest write, which would
  //    mis-audit a partial success as a total failure and re-launch "skill-less" though the dirs did land.
  if (ch.commandsRoot) {
    try {
      const r = syncCommandFiles(ch, configDir, routing.commandTargets, store, unclearedIds);
      counts.commandsWritten += r.commandsWritten;
      counts.commandsRemoved += r.commandsRemoved;
      counts.skippedConflict += r.skippedConflict;
      counts.removedTampered += r.removedTampered;
      counts.scanFailures += r.scanFailures;
      next.files = r.files;
    } catch (err) {
      console.error(`[skills] command-wrapper surface failed for ${ch.provider}; skipping it:`, err);
    }
  }

  // 7. Managed section (codex + gemini) — Model B managed span inside a file we do NOT own. Isolated the
  //    same way: a section-surface failure degrades in place, never aborting the dir sync + manifest write.
  if (ch.sectionFile) {
    try {
      const r = syncManagedSection(ch, configDir, routing.gateSkills, routing.sectionNotes, store);
      counts.sectionWritten += r.sectionWritten;
      counts.sectionRemoved += r.sectionRemoved;
      counts.skippedConflict += r.skippedConflict;
      next.sections = r.sections;
    } catch (err) {
      console.error(`[skills] managed-section surface failed for ${ch.provider}; skipping it:`, err);
    }
  }

  // 8. Persist the manifest fresh from what is NOW recorded on disk.
  writeJsonAtomic(manifestPath, next, 0o600);
  return counts;
}

function writtenPathsFor(skill: Skill, relRoot: string): string[] {
  return [`${relRoot}/${skill.id}/SKILL.md`, ...(skill.assets ?? []).map((a) => `${relRoot}/${skill.id}/${a.relPath}`)];
}

// ---- Command wrappers (gemini) — a Model A owned artifact per user-invocable / invocable-prompt skill.
//      The first-line TOML comment is the ownership marker; the loader's zod strips it. ----

interface CommandSyncResult {
  commandsWritten: number;
  commandsRemoved: number;
  skippedConflict: number;
  removedTampered: number;
  scanFailures: number;
  files: Record<string, { skillId: string; contentHash: string }>;
}

function syncCommandFiles(
  ch: SkillDirChannel,
  configDir: string,
  targets: { skill: Skill; hasDir: boolean }[],
  store: SkillStore,
  unclearedIds: Set<string> | undefined, // present ⇔ an excluding sync (the wave-2 tamper belt input)
): CommandSyncResult {
  const root = ch.commandsRoot!(configDir);
  mkdirSync(root, { recursive: true });
  const out: CommandSyncResult = { commandsWritten: 0, commandsRemoved: 0, skippedConflict: 0, removedTampered: 0, scanFailures: 0, files: {} };

  // Classify only TOP-LEVEL *.toml FILES: an operator's namespaced commands live in subdirs and any
  // non-.toml entry is not ours — both are left untouched by construction. A scan failure is counted,
  // not conflated with an empty dir (the syncChannel step-3 rationale).
  const scan = readdirChecked(root);
  if (scan.failed) out.scanFailures++;
  const owned = new Map<string, string>(); // id -> markered contentHash
  const unmanaged = new Set<string>();
  for (const name of scan.names) {
    if (!name.endsWith('.toml')) continue;
    let st;
    try {
      st = lstatSync(join(root, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue; // a symlink or dir named <x>.toml — never touched
    const id = name.slice(0, -'.toml'.length);
    const marker = parseCommandMarker(firstLineOf(join(root, name)) ?? '');
    if (marker && marker.id === id) owned.set(id, marker.contentHash);
    else unmanaged.add(id);
  }

  const desiredIds = new Set(targets.map((t) => t.skill.id));
  for (const { skill, hasDir } of targets) {
    const id = skill.id;
    if (!isSafeName(id)) continue;
    if (unmanaged.has(id)) {
      // An operator's own <id>.toml sits here — never clobber it; surface every spawn.
      out.skippedConflict++;
      continue;
    }
    const file = join(root, `${id}.toml`);
    const relKey = relative(configDir, file).split(sep).join('/');
    if (owned.get(id) === skill.contentHash && existsSync(file)) {
      out.files[relKey] = { skillId: id, contentHash: skill.contentHash }; // unchanged fast path
      continue;
    }
    try {
      const toml = emitCommandToml({
        id,
        contentHash: skill.contentHash,
        description: skill.description,
        prompt: commandPrompt(ch, configDir, skill, hasDir, store),
      });
      writeTextAtomic(file, toml, 0o600);
      out.commandsWritten++;
      out.files[relKey] = { skillId: id, contentHash: skill.contentHash };
    } catch (err) {
      console.error(`[skills] skipping command wrapper '${id}':`, err);
    }
  }

  // Deletion: an owned wrapper whose skill left eligibility/user-invocability dies. Refuse a symlink.
  for (const id of owned.keys()) {
    if (desiredIds.has(id)) continue;
    if (removeOwnedFile(join(root, `${id}.toml`))) out.commandsRemoved++;
  }
  // The wave-2 tamper belt, wrapper edition (the syncChannel step-5b rationale): a marker-stripped
  // .toml at a known uncleared skill id must not outlive an excluding sync as "operator content".
  if (unclearedIds) {
    for (const id of unmanaged) {
      if (!unclearedIds.has(id)) continue;
      if (removeTamperedEntry(join(root, `${id}.toml`), id)) out.removedTampered++;
    }
  }
  return out;
}

/** A dir-backed wrapper points the model at the materialized SKILL.md; an invocable-prompt (command-only)
 *  skill has no dir, so its authored body is inlined so the prompt is self-contained. `{{args}}` always
 *  present so the loader never auto-appends the raw invocation. */
function commandPrompt(ch: SkillDirChannel, configDir: string, skill: Skill, hasDir: boolean, store: SkillStore): string {
  const dir = join(ch.skillsRoot(configDir), skill.id);
  if (hasDir) {
    return `Read ${dir}/SKILL.md and follow it for this request. Arguments: {{args}}`;
  }
  const override = skill.providerOverrides?.[ch.provider];
  const body = (override?.body ?? store.getBody(skill.id) ?? '').replaceAll('{{skillDir}}', dir);
  return `${body}\n\nArguments: {{args}}`;
}

// ---- Managed section (codex + gemini) — the Model B fenced span inside a NON-owned instructions file. ----

interface SectionSyncResult {
  sectionWritten: number;
  sectionRemoved: number;
  skippedConflict: number;
  sections: Record<string, { contentHash: string }>;
}

function syncManagedSection(
  ch: SkillDirChannel,
  configDir: string,
  gateSkills: Skill[],
  sectionNotes: Skill[],
  store: SkillStore,
): SectionSyncResult {
  const file = ch.sectionFile!(configDir);
  const relKey = relative(configDir, file).split(sep).join('/');
  const out: SectionSyncResult = { sectionWritten: 0, sectionRemoved: 0, skippedConflict: 0, sections: {} };

  const gateLines = gateSkills.flatMap(sectionGateText);
  const notes: SectionNote[] = sectionNotes.map((s) => ({
    name: s.name,
    body: sectionNoteBody(ch, configDir, s, store),
    pointer: `${join(ch.skillsRoot(configDir), s.id)}/SKILL.md`,
  }));
  // SPEC-MEMADOPT — the standing project-memory block leads the span, composed ABOVE renderSectionBody
  // and thus OUTSIDE the SECTION_BUDGET_BYTES accounting: the budget bounds only the gate/note corpus,
  // so a full roster can never squeeze a gate line to make room for the block, and the block is never
  // squeezed by the roster. BEHAVIOR CHANGE, deliberate: the block is a non-empty constant, so `body`
  // is never '' and the managed fence is EVER-PRESENT on every synced channel — an empty gate/note
  // corpus used to write nothing (no fence, no file), and sectionRemoved is unreachable from here now
  // (the counter stays in SyncCounts for shape stability, not because this path can still reach it).
  const corpus = renderSectionBody(gateLines, notes, SECTION_BUDGET_BYTES);
  const body = [MEMORY_SECTION_BLOCK, corpus].filter((s) => s !== '').join('\n\n');

  const current = existsSync(file) ? safeReadText(file) : undefined;
  const action = applyManagedSection(current, body);
  if (action.kind === 'conflict') {
    // Torn fence — hands off the whole file, count it, record no ownership.
    console.error(`[skills] managed section ${relKey} has a torn ct-skills fence; leaving it untouched`);
    out.skippedConflict++;
    return out;
  }
  if (action.kind === 'write') {
    try {
      writeTextAtomic(file, action.content, 0o600);
      if (body === '') out.sectionRemoved++;
      else out.sectionWritten++;
    } catch (err) {
      console.error(`[skills] could not write managed section ${relKey}:`, err);
      return out;
    }
  }
  // Record the section hash whenever a fence is now present (non-empty body), for the manifest fast index.
  if (body !== '') out.sections[relKey] = { contentHash: sectionHash(body) };
  return out;
}

// The gate blocks that a PANE agent can itself perform — these are named in the emitted policy text.
const AGENT_ACTIONABLE_BLOCKS: ReadonlySet<string> = new Set(['commit', 'push', 'forge-write']);
// The ORCHESTRATOR's contract blocks (a loop turning green, a mission landing), split by what the AGENT
// can contribute. 'loop-green' is enforced by the completion evaluator (missions.ts resolveGateState on
// the create-frozen loop.requiredGates) and the agent's contribution is EVIDENCE — so it emits its own
// line telling a mission sortie how to attest (`towerctl gate submit`). 'mission-land' has no agent
// contribution and its enforcement is still pending, so it stays SUPPRESSED from agent-facing text —
// that exclusion is its forward-compat seam.
const LOOP_GREEN_BLOCK = 'loop-green';
const ORCHESTRATOR_SUPPRESSED_BLOCKS: ReadonlySet<string> = new Set(['mission-land']);

/**
 * The full blocking-gate policy for ONE skill, as 0..2 whole lines (flatMap'd at the call site so a
 * gate with nothing to tell the agent contributes nothing). This is the policy-text floor a blocking
 * gate delivers to every agent that HAS the skill; it is the universal enforcement plane, independent
 * of `enforcedBy` (a declared-intent hint — the orchestrator plane lives in the completion evaluator
 * and the provider-hook plane is separate work, so it is deliberately un-consulted here).
 *
 * Keying is on `gate.mode`, never on blocks/rerunOnNewDiff — an advisory skill produces NO gate text even
 * with blocks set (the call site already filters to blocking, but the renderer self-guards too). `blocks`
 * persists as plain strings (downgrade tolerance), so it is partitioned fail-closed: agent-actionable →
 * named in the diff-policy line; 'loop-green' → its OWN line telling a mission sortie how to record
 * evidence (`towerctl gate submit`, conditional "when working a Tower mission sortie" phrasing — the
 * enforcement itself lives in the completion evaluator); 'mission-land' → suppressed (the orchestrator's
 * contract only, enforcement pending); any UNRECOGNIZED value → the gate still emits, with generic
 * phrasing, so an unknown block is never silently un-enforced. A gate whose blocks are ALL suppressed
 * (or empty) yields no line — the gate still binds at the orchestrator's own enforcement points.
 * No AI/vendor names or bracketed markers in the emitted prose: it lands in files agents read and may quote
 * onward, and the wording ("run the `<id>` skill") reads on every loader (claude skill, codex `$<id>`
 * mention, gemini activate_skill/`/<id>`).
 */
export function sectionGateText(s: Skill): string[] {
  if (s.gate?.mode !== 'blocking') return []; // advisory / absent gate ⇒ no agent-facing policy (key on MODE)
  const named: string[] = [];
  let hasUnknown = false;
  let loopGreen = false;
  for (const b of s.gate.blocks ?? []) {
    if (AGENT_ACTIONABLE_BLOCKS.has(b)) named.push(b);
    else if (b === LOOP_GREEN_BLOCK) loopGreen = true; // emits its own evidence line below
    else if (ORCHESTRATOR_SUPPRESSED_BLOCKS.has(b)) continue; // orchestrator's contract, not the agent's
    else hasUnknown = true; // fail-closed: an unrecognized block must still reach the agent as a gate
  }
  const rerun = s.gate.rerunOnNewDiff ? ' After any fix, re-run it over the new diff before proceeding.' : '';
  const lines: string[] = [];
  if (named.length > 0 || hasUnknown) {
    // An unknown block means our partition can't be trusted complete, so name the actions generically
    // (covers the unknown one) rather than a possibly-incomplete explicit list; a purely-known set is
    // listed by name.
    const actionPhrase = hasUnknown || named.length === 0 ? 'the gated actions' : `any ${named.join(', ')}`;
    lines.push(
      `- ${s.name} — BLOCKING gate: before ${actionPhrase}, run the \`${s.id}\` skill over the exact diff ` +
      'about to land and surface every finding (state an empty result explicitly). Never perform the gated ' +
      `action in the same turn the findings are surfaced.${rerun}`,
    );
  }
  if (loopGreen) {
    lines.push(
      `- ${s.name} — BLOCKING loop gate: when working a Tower mission sortie, run the \`${s.id}\` skill ` +
      `over the change and record the outcome with \`towerctl gate submit --gate ${s.id} --result pass\` ` +
      `(or fail) — the mission cannot finish green without it.${rerun}`,
    );
  }
  return lines;
}

/** An instructions-file skill's inline body, with the reserved token pointed at where its dir would live. */
function sectionNoteBody(ch: SkillDirChannel, configDir: string, s: Skill, store: SkillStore): string {
  const override = s.providerOverrides?.[ch.provider];
  const body = override?.body ?? store.getBody(s.id) ?? '';
  return body.replaceAll('{{skillDir}}', join(ch.skillsRoot(configDir), s.id));
}

/**
 * Stage a fresh skill dir (SKILL.md + assets + marker) OUTSIDE skills/, then swap it into place with a
 * rename — a deterministic FULL overwrite of the managed dir, never a merge (a Tower-owned file). Throws on
 * any per-skill problem (unreadable body, missing/mismatched asset, unsafe path) so the caller can degrade.
 */
function writeSkillDir(ch: SkillDirChannel, store: SkillStore, skill: Skill, skillsRoot: string, stageRoot: string): void {
  const id = skill.id;
  const liveDir = join(skillsRoot, id);

  const override = skill.providerOverrides?.[ch.provider];
  // An explicitly-authored per-provider variant REPLACES the canonical body (never auto-generated).
  const body = override?.body ?? store.getBody(id);
  if (body === undefined) throw new Error('body unreadable'); // a listed skill without a body is a reject class

  // The ONLY templating: substitute the reserved token to the FINAL materialized dir. No other {{…}} is
  // touched; assets are byte-exact (templating executable content is a footgun). replaceAll (not replace)
  // so every occurrence is substituted. The channel supplies the frontmatter emitter.
  const skillMd = ch.emit(skill, body.replaceAll('{{skillDir}}', liveDir));

  mkdirSync(stageRoot, { recursive: true });
  const stamp = `${Date.now()}-${shortId(4)}`;
  const stage = join(stageRoot, `${id}.${stamp}`);
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, 'SKILL.md'), skillMd, { mode: 0o600 });

  // Assets: driven by the METADATA list, never a blind dir copy (a stray file not in the metadata must not
  // propagate). Re-validate isSafeAssetPath before the TARGET join too — the load schema does not re-check
  // relPath, so a hand-edited skills.json could carry a traversal.
  for (const asset of skill.assets ?? []) {
    if (!isSafeAssetPath(asset.relPath)) throw new Error(`unsafe asset path: ${String(asset.relPath)}`);
    const buf = store.readAsset(id, asset.relPath);
    if (buf === undefined) throw new Error(`asset missing: ${asset.relPath}`);
    // Integrity: a half-true skill is worse than none — a mismatch skips the WHOLE skill.
    if (createHash('sha256').update(buf).digest('hex') !== asset.sha256) {
      throw new Error(`asset sha256 mismatch: ${asset.relPath}`);
    }
    const target = join(stage, asset.relPath);
    mkdirSync(dirname(target), { recursive: true });
    // Restore the exec bit from metadata; the | 0o600 floor keeps a weird stored mode readable/writable.
    writeFileSync(target, buf, { mode: ((asset.mode ?? 0o644) & 0o777) | 0o600 });
  }

  // The ownership marker rides the atomic swap (written INTO the staged dir). It is a dotfile inert to the
  // CLI loader (which reads SKILL.md and its referenced files).
  const marker: Marker = { skillId: id, contentHash: skill.contentHash, version: skill.version, writtenAt: new Date().toISOString() };
  writeFileSync(join(stage, MARKER_NAME), JSON.stringify(marker, null, 2), { mode: 0o600 });

  // Swap: live → .old (if present, it is a real marker-owned dir here), stage → live, best-effort rm .old.
  // Same filesystem (both under configDir). A crash between the two renames leaves the managed dir briefly
  // ABSENT — it is RE-DERIVED from the SkillStore (the source of truth) on the next spawn's write pass, NOT
  // promoted from .old: .old lives under stageRoot, which sweepDir clears before classification, so nothing
  // ever reads it. The residual is an at-most-one-spawn window where the skill is missing, not data loss.
  let old: string | undefined;
  if (existsSync(liveDir)) {
    // Belt-and-braces (the classification scan already routes a symlink to the conflict path): never rename
    // a symlink into .old — lstat the entry itself and refuse, matching removeManagedDir. Throws into the
    // per-skill catch, so the operator's symlink is left intact.
    if (lstatSync(liveDir).isSymbolicLink()) throw new Error(`refusing to overwrite a symlink at skills/${id}`);
    old = join(stageRoot, `.old.${id}.${stamp}`);
    renameSync(liveDir, old);
  }
  renameSync(stage, liveDir);
  if (old) {
    try {
      rmSync(old, { recursive: true, force: true });
    } catch {
      /* an orphan .old under the stage root is inert and swept next sync */
    }
  }
}

/**
 * Emit the SKILL.md frontmatter (mapped, not copied) + the verbatim body. Every string scalar is emitted
 * via JSON.stringify — a JSON string is a valid YAML double-quoted scalar, so colons/quotes/newlines in a
 * description can't break the frontmatter. Only the BODY carries the byte-verbatim guarantee.
 */
function emitSkillMd(skill: Skill, body: string): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${yamlScalar(skill.name)}`);
  // Pack the trigger (WHEN-to-use) onto the description with a single space when set. Imported skills carry
  // no trigger, so their description round-trips byte-identical.
  const description = skill.trigger ? `${skill.description} ${skill.trigger}` : skill.description;
  lines.push(`description: ${yamlScalar(description)}`);
  lines.push(`user_invocable: ${skill.invocation.user ? 'true' : 'false'}`);
  // Only 'never' maps to the CLI's disable flag; 'suggest'/'auto' carry no frontmatter (their contract
  // lives in body prose).
  if (skill.invocation.model === 'never') lines.push('disable-model-invocation: true');
  const allowedTools = skill.providerOverrides?.['claude-code']?.allowedTools ?? skill.toolHints?.allowedTools;
  if (allowedTools && allowedTools.length) lines.push(`allowed-tools: ${yamlScalar(allowedTools.join(', '))}`);
  if (skill.invocation.argumentHint) lines.push(`argument-hint: ${yamlScalar(skill.invocation.argumentHint)}`);
  if (skill.tags && skill.tags.length) {
    lines.push('metadata:');
    lines.push(`  tags: ${yamlScalar(skill.tags.join(', '))}`);
  }
  lines.push('---');
  // One newline joins the closing delimiter to the verbatim body (which keeps its own leading structure).
  return `${lines.join('\n')}\n${body}`;
}

function yamlScalar(v: string): string {
  return JSON.stringify(v);
}

/**
 * The PORTABLE SKILL.md emitter (codex + gemini). `name` is the skill SLUG (skill.id), not the display
 * name: codex keys `$<name>` mentions and its authoring contract on the frontmatter name (lowercase /
 * hyphen ≤64 — exactly an isSafeName slug) and gemini's loader keys activate_skill on it, so a display
 * name with spaces/case would break mention-ability. Only {name, description} are emitted — the intersection
 * of both loaders' contract; `allowed-tools` is deliberately omitted (its enforcement is unpinned on codex
 * and ignored by gemini, so emitting it would be a false safety claim). Description packing matches the
 * claude emitter; only the BODY carries the byte-verbatim guarantee.
 */
function emitPortableSkillMd(skill: Skill, body: string): string {
  const description = skill.trigger ? `${skill.description} ${skill.trigger}` : skill.description;
  return `---\nname: ${yamlScalar(skill.id)}\ndescription: ${yamlScalar(description)}\n---\n${body}`;
}

// ---- Manifest / marker IO (all tolerant; no deletion is ever driven by a guess) ----

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** readdir that DISTINGUISHES an empty dir from an unreadable one (SPEC-SKILLS Phase 5b wave 2). The
 *  classification scans feed the removal passes, so conflating the two turns a transient EMFILE/EACCES
 *  into a silent fail-open: nothing classified ⇒ nothing removed ⇒ `removed: 0` audited as if clean —
 *  and under an excluding sync that leaves stale uncleared content in place with zero signal. The
 *  failure is logged here and counted by the caller into the audit line. */
function readdirChecked(dir: string): { names: string[]; failed: boolean } {
  try {
    return { names: readdirSync(dir), failed: false };
  } catch (err) {
    console.error(`[skills] cannot scan ${dir} — the removal pass is blind this sync:`, err);
    return { names: [], failed: true };
  }
}

function safeReadText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function firstLineOf(file: string): string | undefined {
  const txt = safeReadText(file);
  if (txt === undefined) return undefined;
  const nl = txt.indexOf('\n');
  return nl === -1 ? txt : txt.slice(0, nl);
}

/** Atomic text write (tmp + rename), 0600, parent dirs created. The section + command wrappers are the
 *  only non-JSON artifacts the materializer writes; a crash mid-write can't leave a torn file. */
function writeTextAtomic(file: string, text: string, mode: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}

/** Remove a Tower-owned file (a command wrapper), refusing a symlink (the shred discipline). Returns
 *  whether a file was removed (for the counts). */
function removeOwnedFile(file: string): boolean {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      console.error(`[skills] refusing to remove '${file}': it is a symlink`);
      return false;
    }
  } catch {
    return false; // already gone
  }
  try {
    rmSync(file, { force: true });
    return true;
  } catch (err) {
    console.error(`[skills] could not remove command wrapper '${file}':`, err);
    return false;
  }
}

function sweepDir(dir: string): void {
  for (const name of safeReaddir(dir)) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function readManifest(path: string): Manifest {
  // The channel is set fresh at write time from the descriptor; the reader only needs the maps, which are
  // a rebuildable fast index (the in-artifact markers/fences are the ownership truth).
  const empty: Manifest = { v: 1, channel: '', skills: {} };
  if (!existsSync(path)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // Corrupt manifest: quarantine and rebuild ownership from the in-dir markers.
    const quarantine = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, quarantine);
      console.error(`[skills] ${path} corrupt (${(err as Error).message}); quarantined as ${quarantine}`);
    } catch {
      /* leave it — the fresh writeJsonAtomic at the end of the sync overwrites it */
    }
    return empty;
  }
  const root = asRecord(parsed);
  const skills: Record<string, ManifestEntry> = {};
  for (const [id, raw] of Object.entries(asRecord(root.skills))) {
    const e = asRecord(raw);
    skills[id] = {
      version: typeof e.version === 'number' ? e.version : 0,
      contentHash: typeof e.contentHash === 'string' ? e.contentHash : '',
      writtenPaths: Array.isArray(e.writtenPaths) ? e.writtenPaths.filter((p): p is string => typeof p === 'string') : [],
    };
  }
  // Additive maps read TOLERANTLY: a Phase-1 manifest lacks them (default {}); a newer manifest read by an
  // older Tower simply ignores its own unknown keys — nothing is lost, both rebuild from the markers.
  const files: Record<string, { skillId: string; contentHash: string }> = {};
  for (const [k, raw] of Object.entries(asRecord(root.files))) {
    const e = asRecord(raw);
    if (typeof e.skillId === 'string' && typeof e.contentHash === 'string') files[k] = { skillId: e.skillId, contentHash: e.contentHash };
  }
  const sections: Record<string, { contentHash: string }> = {};
  for (const [k, raw] of Object.entries(asRecord(root.sections))) {
    const e = asRecord(raw);
    if (typeof e.contentHash === 'string') sections[k] = { contentHash: e.contentHash };
  }
  return { v: 1, channel: typeof root.channel === 'string' ? root.channel : '', skills, files, sections };
}

function readMarker(path: string): Marker | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const m = asRecord(JSON.parse(readFileSync(path, 'utf8')));
    if (typeof m.skillId === 'string' && typeof m.contentHash === 'string') {
      return {
        skillId: m.skillId,
        contentHash: m.contentHash,
        version: typeof m.version === 'number' ? m.version : 0,
        writtenAt: typeof m.writtenAt === 'string' ? m.writtenAt : '',
      };
    }
  } catch {
    /* unparsable marker → the dir is treated as unmanaged (never clobbered) */
  }
  return undefined;
}

/** Remove a TAMPERED artifact sitting at a KNOWN uncleared skill id (the wave-2 tamper belts — see the
 *  syncChannel step-5b rationale). Unlike removeManagedDir/removeOwnedFile this also takes a plain file
 *  or a symlink: refusing symlinks here would hand the tamperer a durable exemption (symlink the body
 *  back in under the same name). The shred discipline still holds — a symlink is unlinked ITSELF via a
 *  non-recursive rm, which never follows it, so nothing outside the entry is ever deleted. */
function removeTamperedEntry(path: string, id: string): boolean {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return false; // already gone
  }
  try {
    if (st.isDirectory()) rmSync(path, { recursive: true, force: true });
    else rmSync(path, { force: true }); // plain file OR symlink: unlink the entry itself only
    console.error(
      `[skills] removed '${id}': it sits at an uncleared assistant skill id without a valid ownership marker (excluding sync)`,
    );
    return true;
  } catch (err) {
    console.error(`[skills] could not remove tampered entry '${path}':`, err);
    return false;
  }
}

/** Remove a managed skill dir, refusing a symlink (the accounts.ts shred discipline). Returns whether a dir
 *  was removed (for the counts). */
function removeManagedDir(skillsRoot: string, id: string): boolean {
  const dir = join(skillsRoot, id);
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      console.error(`[skills] refusing to remove '${id}': it is a symlink`);
      return false;
    }
  } catch {
    return false; // already gone
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error(`[skills] could not remove managed skill dir '${id}':`, err);
    return false;
  }
}
