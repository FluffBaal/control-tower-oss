// Codex CLI adapter. Account isolation via CODEX_HOME (dir must pre-exist — we
// mkdir it — and we pin the credential store to a file). Approval detection is the
// PermissionRequest hook (NOT notify — these are distinct hooks);
// turn-done comes from the Stop hook or notify's agent-turn-complete.
//
// Codex `notify` config is machine-local to CODEX_HOME (not repo-scaffoldable), so
// we set it in the per-terminal CODEX_HOME here.

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentAdapter, HookBinding, LaunchContext } from './types.js';

async function writeIfAbsentToml(file: string, content: string): Promise<void> {
  try {
    await readFile(file, 'utf8');
  } catch {
    await writeFile(file, content, 'utf8');
  }
}

/** Upgrade-path scrub: a config.toml written by an earlier Tower carries `[features]` /
 *  `hooks = true`, which writeIfAbsentToml can never rewrite (it only writes absent files) —
 *  leaving the hooks feature ON for exactly the ≥0.14x versions whose interactive "Hooks need
 *  review" banner wedges unattended builders. Drop `hooks = true` inside the `[features]`
 *  table, and the header too once the table is empty; any operator-added keys under it are
 *  preserved (removing the header with keys left would splice them into the previous table). */
async function scrubStaleHooksFeature(file: string): Promise<void> {
  let cur: string;
  try {
    cur = await readFile(file, 'utf8');
  } catch {
    return; // no config yet — nothing stale to scrub
  }
  const lines = cur.split('\n');
  const out: string[] = [];
  let inFeatures = false;
  let headerIdx = -1;
  let featureKeys = 0;
  let changed = false;
  for (const ln of lines) {
    if (/^\s*\[/.test(ln)) {
      if (inFeatures && featureKeys === 0 && headerIdx >= 0) {
        out.splice(headerIdx, 1); // empty [features] table — drop the header too
        changed = true;
      }
      inFeatures = /^\s*\[features\]\s*$/.test(ln);
      if (inFeatures) {
        headerIdx = out.length;
        featureKeys = 0;
      }
      out.push(ln);
      continue;
    }
    if (inFeatures && /^\s*hooks\s*=\s*true\s*$/.test(ln)) {
      changed = true;
      continue; // the stale flag — drop it
    }
    if (inFeatures && /^\s*\w[\w-]*\s*=/.test(ln)) featureKeys++;
    out.push(ln);
  }
  if (inFeatures && featureKeys === 0 && headerIdx >= 0) {
    out.splice(headerIdx, 1);
    changed = true;
  }
  if (changed) await writeFile(file, out.join('\n'), 'utf8');
}

/** Append a `[projects."<root>"] trust_level = "trusted"` table when absent. A TOML table
 *  appended at EOF is always well-formed; the JSON-string form escapes any path safely. */
async function ensureProjectTrust(file: string, repoRoot: string): Promise<void> {
  const key = `[projects.${JSON.stringify(repoRoot)}]`;
  let cur = '';
  try {
    cur = await readFile(file, 'utf8');
  } catch {
    /* no config yet — the append below creates it */
  }
  if (cur.includes(key)) return;
  await writeFile(file, `${cur.replace(/\n*$/, '\n')}\n${key}\ntrust_level = "trusted"\n`, 'utf8');
}

/**
 * SPEC-SUBMIT §2.3 — the placeholder hints an EMPTY codex composer cycles, extracted VERBATIM from
 * the shipped binary on 2026-07-21 (codex-cli 0.144.3, a contiguous literal block:
 * `strings vendor/.../bin/codex | grep "Run /review on my current changes"`). Pinned like approveKeys.
 *
 * Used ONLY as an empty-composer signature (see composerPending). Re-verify on the next codex
 * upgrade: an entry that disappears costs nothing, and a NEW hint this set does not know degrades to
 * an audited unverified send — never a false gate.
 */
const COMPOSER_HINTS = new Set([
  'Explain this codebase',
  'Summarize recent commits',
  'Implement {feature}',
  'Find and fix a bug in @filename',
  'Write tests for @filename',
  'Improve documentation in @filename',
  'Run /review on my current changes',
  'Use /skills to list available skills',
  'Check recently modified functions for compatibility',
  'How many files have been modified?',
  'Will this algorithm scale well?',
]);

/**
 * SPEC-SUBMIT §2.3 — the codex composer's BODY (the content after the `›` marker on the LAST marker
 * line), or undefined when no marker is on screen. Earlier marker lines are the echoes of prompts
 * already submitted; the live composer is the lowest one.
 */
function codexComposerBody(snapshot: string): string | undefined {
  const lines = snapshot.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*›\s?(.*)$/.exec(lines[i] ?? '');
    if (m) return (m[1] ?? '').trim();
  }
  return undefined;
}

/** The idle-chrome strip (composer hint rows + the path/model footer line) — the one filter both
 *  normalizeSnapshot (poller hashing) and describeAttention (card preview) apply. */
function stripCodexChrome(s: string): string {
  return s
    .split('\n')
    .filter((ln) => !/^\s*›/.test(ln) && !/^\s+\S.* · ~?\//.test(ln))
    .join('\n');
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  // Codex ≥0.14x re-paints its idle TUI (verified live 2026-07-06: three turn-done hooks
  // were each re-promoted to 'working' ~25s later by screen deltas alone). Its work truth
  // is the notify hook + live pane children; screen change alone must not imply work.
  screenChangeImpliesWork: false,
  // …and its npm wrapper keeps the vendored binary as a PERMANENT child (0.118 exec'd it),
  // so one idle descendant is structural, not work — real tools appear beyond it.
  persistentIdleChildren: 1,

  buildEnv(ctx) {
    return {
      TERM: 'xterm-256color',
      TOWER_TERMINAL_ID: ctx.terminalId,
      TOWER_PROJECT_ID: ctx.projectId,
      TOWER_PORT: String(ctx.towerPort),
      TOWER_HOOK_TOKEN_FILE: ctx.hookTokenFile,
      TOWER_SPOOL_DIR: ctx.spoolDir,
      CODEX_HOME: ctx.configDir,
    };
  },

  buildCommand(ctx) {
    // SPEC-MODELS §4 — bind the resolved model as a separate argv token (`-m <slug>`), never a
    // config.toml `model=` write: argv is injection-safe by construction (execFile array, no shell
    // in tmux.ts), whereas a TOML write could splice sibling keys. The built-in model allowlist gate
    // in routing.ts validates the slug before we ever reach here.
    // SPEC-EFFORT §3 — bind the resolved effort as its OWN token pair (`-c model_reasoning_effort=<v>`);
    // CODEX_EFFORT_RE's [a-z0-9-] charset excludes '=', whitespace, quotes and a leading dash, so the
    // composed key=value token cannot splice; the isValidEffort hoist validated it upstream. Omitted ⇒
    // no flag (codex's own default — §0 no imposed defaults).
    return ['codex', ...(ctx.model ? ['-m', ctx.model] : []), ...(ctx.effort ? ['-c', `model_reasoning_effort=${ctx.effort}`] : [])];
  },

  headlessCommand(ctx, prompt) {
    return ['codex', 'exec', ...(ctx.model ? ['-m', ctx.model] : []), ...(ctx.effort ? ['-c', `model_reasoning_effort=${ctx.effort}`] : []), prompt];
  },

  async writeHookConfig(ctx): Promise<HookBinding[]> {
    await mkdir(ctx.configDir, { recursive: true });
    // NO hook files for codex ≥0.14x — probed live 2026-07-06:
    //  · the pre-0.14x hooks.json shape is silently ignored;
    //  · the current shapes (hooks.json / inline [[hooks.*]] TOML) are parsed but gated
    //    behind an INTERACTIVE "Hooks need review" approval (a trusted_hash the TUI
    //    stores on manual review) — and an unreviewed-hooks session ran nothing at all,
    //    which would wedge every unattended builder at a banner nothing can click.
    // Turn completion rides the top-level `notify` program instead (agent-turn-complete,
    // verified firing in both TUI and exec), and permission prompts are caught by
    // parseState's screen heuristics. Also remove any stale Tower-written hooks.json so
    // a future codex version can't half-parse leftovers.
    await rm(join(ctx.configDir, 'hooks.json'), { force: true });
    // Upgrade path: an existing profile's config.toml may still carry the hooks feature flag
    // an earlier Tower wrote — the write-if-absent below can never remove it, so scrub first.
    await scrubStaleHooksFeature(join(ctx.configDir, 'config.toml'));
    // Pin the credential store to a file and wire the notify webhook.
    // `notify` is a TOP-LEVEL key and MUST appear before any [table] header, or TOML
    // parses it as a table key and Codex never invokes it.
    await writeIfAbsentToml(
      join(ctx.configDir, 'config.toml'),
      [
        'cli_auth_credentials_store = "file"',
        `notify = ["${ctx.hookScript}", "turn-done"]`,
        '',
      ].join('\n'),
    );
    // Pre-trust the project's MAIN repo root (codex keys trust by repository root, so a
    // linked worktree resolves to it). Without this, first run in any fresh worktree shows
    // the interactive trust dialog — invisible to the hook FSM, fatal to an unattended
    // mission builder (the loop's injected task lands in the dialog). Trusting is correct
    // by design here: the operator explicitly registered this repo as a Tower project, and
    // the Tower spawns agents precisely to work on it. Appended (not part of the
    // write-if-absent above) so existing profiles gain trust for newly added projects too.
    await ensureProjectTrust(join(ctx.configDir, 'config.toml'), ctx.repoPath);
    return [
      // Hook events are deliberately absent for ≥0.14x (see above): turn-done = notify,
      // needs-permission = parseState screen heuristics — the exact signal set the live
      // mission e2e completed on.
      { providerEvent: 'notify/agent-turn-complete', signal: 'turn-done' },
    ];
  },

  approveKeys() {
    return { approve: ['y'], deny: ['n'] }; // provisional; re-pin per version
  },

  parseState(s) {
    if (/Allow command|Approve|permission|\(y\/n\)|Run this command/i.test(s)) return 'needs-permission';
    if (/Esc to interrupt|Working|Thinking/i.test(s)) return null;
    // Deliberately NO idle ('turn-done') heuristic — see claude.ts parseState for the
    // rationale (the `>$`/`▌$` patterns misfired on working terminals). Codex idle is
    // driven by its Stop hook / notify agent-turn-complete.
    return null;
  },

  // Codex ≥0.14x animates its idle screen: the composer line cycles placeholder hints
  // ("› Find and fix a bug in @filename" → "› Write tests for …") and the footer carries a
  // live path/model line. Verified live 2026-07-06: that cycling made every poll read as
  // "output changed", pinning a hook-idled builder to 'working' and starving the loop
  // runner's idle dwell. Strip exactly that chrome before the poller hashes.
  normalizeSnapshot(s) {
    return stripCodexChrome(s);
  },

  /**
   * SPEC-CLEARANCE §B — best-effort card content, reusing the idle-chrome strip above (composer
   * hint rows + the path/model footer line are exactly the chrome a card must not dump). Codex has
   * no needs-input hook source today, so this only ever renders a stale/manually-driven hold.
   */
  describeAttention(snapshot) {
    const lines = stripCodexChrome(snapshot)
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return undefined;
    const last = lines[lines.length - 1] ?? '';
    const message = last.trim();
    return {
      ...(message ? { message: message.length > 200 ? `${message.slice(0, 199)}…` : message } : {}),
      preview: lines.slice(-12),
    };
  },

  /**
   * SPEC-SUBMIT §2.3 — composer classification. PINNED 2026-07-21 against codex-cli 0.144.3.
   *
   * The problem this has to solve: an EMPTY codex composer never renders a bare `›`. It always shows
   * a placeholder hint (verified by typing one character and deleting it — the hint came straight
   * back), and capturePlain strips the dim styling that distinguishes a hint from typed text. There
   * is no config switch to turn the hints off (X2: `codex features list` has no such flag).
   *
   * So the hint set — extracted verbatim from the shipped binary — IS the empty-composer signature,
   * and it is used in exactly ONE direction: a hint means EMPTY. This classifier never returns `true`.
   * That is a deliberate narrowing of the spec's "non-hint content ⇒ true": a pinned set goes stale
   * on the next CLI release, and a stale `true` would refuse every send as foreign-text and gate a
   * healthy fleet (⟦DEC-8⟧). A stale hint set instead yields `undefined` — an audited degraded send,
   * which is the safe direction. The cost is that hole 4a (typing onto a stuck composer) stays
   * audited-not-closed for codex, while holes 1-3 close: after a real submit the composer shows a
   * hint again, which reads `false` = submitted.
   */
  composerPending(snapshot) {
    const body = codexComposerBody(snapshot);
    if (body === undefined) return undefined;
    if (body.length === 0) return false; // bare marker (not observed on 0.144.3, but conclusive)
    if (COMPOSER_HINTS.has(body)) return false; // a placeholder ⇒ the composer is empty
    return undefined; // typed text, an unknown/newer hint, or a menu line (`› 1. Yes, continue`)
  },

  composerText(snapshot) {
    // ONLY the empty case is reported. A hint means the composer is empty, so `''` is exact and it
    // keeps a hint from ever standing in for our own prompt. Anything else returns `undefined` —
    // "region not identifiable" — because the marker line is NOT the whole composer: codex wraps a
    // multiline prompt onto 2-space-indented continuation lines (pins §1 M1), and a loop prompt is
    // `task + \n\n + feedback`, so its TAIL is always on a continuation line. Reporting just the
    // marker line as the region would scope the our-text search to a place the text can never be,
    // and every healthy codex send would then read as unverified — an alarm on the routine path,
    // which is the kind an operator learns to ignore.
    // Walking the continuations (as the claude classifier does between its rules) was considered and
    // rejected: the footer line is ALSO 2-space indented, so the walk depends on a blank-line
    // separator observed in a single capture — a second structural claim about a frame this file is
    // otherwise careful not to over-pin. `undefined` sends the match to the whole-snapshot fallback,
    // where the pre-send baseline (the delta rule) is what keeps an echo from standing in.
    const body = codexComposerBody(snapshot);
    return body !== undefined && COMPOSER_HINTS.has(body) ? '' : undefined;
  },
};
