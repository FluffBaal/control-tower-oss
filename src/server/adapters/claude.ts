// Claude Code adapter. Account isolation via CLAUDE_CONFIG_DIR (a pre-expanded
// absolute path — never a ~, per issue #37570). Hooks map Claude's
// Notification matchers + Stop/SessionStart onto our canonical signals.
//
// NOTE: the exact hooks.json schema is written to Anthropic's documented shape; it
// should be re-validated against the installed CLI version at account-setup time
// (a per-profile check M4 performs). The hook *pipeline* is provider-agnostic and is
// verified independently.

import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, HookBinding, LaunchContext } from './types.js';
import { claudeBusyFull } from '../busy-markers.js';

async function mergeJson(file: string, patch: Record<string, unknown>): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    /* new file */
  }
  await writeFile(file, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
}

/** The value when it is a plain JSON object, else {} — keeps a corrupt or oddly-typed field from
 *  throwing inside the degrade-not-throw state seed below. */
function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function cmd(ctx: LaunchContext, signal: string): { type: 'command'; command: string } {
  return { type: 'command', command: `${ctx.hookScript} ${signal}` };
}

/**
 * SPEC-RESTART — the ONE place a base claude argv is rewritten for a session action. PURE: no I/O,
 * no store access — callers own the mint-vs-resume decision (does a transcript exist for this id?)
 * and pass it in. Strips any PRIOR session-selecting flag (and, for the two that take a value, that
 * value token too) before appending exactly one pair — so a restart/rotate rewrite of an
 * already-once-rewritten command (e.g. a second restart) never accumulates flags, and NEVER emits
 * both `--session-id` and `--resume` together (the CLI treats that combination as an error).
 */
export function claudeSessionArgv(baseArgv: string[], session: { kind: 'new' | 'resume'; id: string }): string[] {
  const FLAG_WITH_VALUE = new Set(['--session-id', '--resume', '-r']);
  const FLAG_BARE = new Set(['--continue', '-c']);
  const kept: string[] = [];
  for (let i = 0; i < baseArgv.length; i++) {
    const tok = baseArgv[i]!;
    if (FLAG_WITH_VALUE.has(tok)) {
      i++; // drop the flag AND its value
      continue;
    }
    if (FLAG_BARE.has(tok)) continue; // drop the flag only — it takes no value
    kept.push(tok);
  }
  return session.kind === 'new' ? [...kept, '--session-id', session.id] : [...kept, '--resume', session.id];
}

/**
 * SPEC-RESTART — locate a session's transcript by SESSION ID rather than by recomputing claude's own
 * cwd-derived directory key: a uuid is globally unique (we mint it ourselves), so scanning every
 * `projects/*` subdir for `<sessionId>.jsonl` is unambiguous — at most one match — and, unlike
 * deriving the key ourselves, stays correct even if a future CLI version changes its key-derivation
 * format (a hardcoded key formula would then silently stop matching and `--resume` would quietly
 * never engage again, with no error — just a fresh session every restart). Synchronous, matching the
 * synchronous pre-check restartTerminal runs it from; never throws — a missing or unreadable
 * `projects/` dir reads as "no transcript" (the safe direction: falls to a fresh mint, never a
 * `--resume` onto a session that turns out not to exist).
 */
export function findClaudeTranscript(configDir: string, sessionId: string): string | undefined {
  const projectsDir = join(configDir, 'projects');
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  const fileName = `${sessionId}.jsonl`;
  for (const entry of entries) {
    const candidate = join(projectsDir, entry, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * SPEC-SUBMIT §2.2 — the claude composer's BODY, or undefined when no composer is on screen.
 * PINNED 2026-07-21 against claude 2.1.216. The composer is a
 * marker line SANDWICHED between two horizontal rules, with the status footer below it:
 *
 *     ────────────────────────────────────────  (U+2500 rule)
 *     ❯ first line                              (U+276F + NBSP, then the text)
 *       continuation lines, indented 2, no marker
 *     ────────────────────────────────────────
 *       ⏸ manual mode on · ? for shortcuts
 *
 * The rule sandwich is LOAD-BEARING, not decoration: the same `❯` marker also renders the
 * folder-trust menu (`❯ 1. Yes, I trust this folder`) and the echo of every previously submitted
 * prompt. Reading either as composer text would be a wrong `true` (which ⟦DEC-8⟧ forbids — it would
 * refuse every send as foreign-text) or a wrong our-text match (which would call a swallowed send
 * delivered). Neither is rule-sandwiched, and the search decides on the FIRST marker line found from
 * the bottom — the live composer is always the lowest one — rather than hunting upward for a
 * better-looking candidate.
 *
 * MID-TURN the composer stays rendered and EMPTY (footer: `esc to interrupt`), which is exactly what
 * makes ⟦DEC-2⟧'s primary signal work: after a real submit this reads empty within a poll.
 */
function claudeComposerBody(snapshot: string): string | undefined {
  return claudeComposerRegion(snapshot.split('\n'))?.body;
}

/**
 * The composer's LOCATION in the split snapshot, or undefined when none is on screen. `marker` is
 * the index of the `❯` line (its opening rule sits at marker-1 — everything above THAT is
 * transcript, everything from it down is chrome: composer, status footer, task list). `body` is
 * exactly what claudeComposerBody has always returned; the scan is byte-for-byte the pinned one
 * above, split out so SPEC-CLEARANCE's questionPending/describeAttention can reuse the sandwich
 * find without re-deriving the composer rules.
 */
function claudeComposerRegion(lines: string[]): { marker: number; body: string } | undefined {
  const isRule = (l: string | undefined): boolean => /^─{10,}\s*$/.test((l ?? '').trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    // The separator after the marker is optional: capture-pane TRIMS trailing whitespace, so an
    // empty composer's line arrives as a bare `❯` the moment the render stops using a NBSP.
    const m = /^❯(?:[\s\u00A0](.*))?$/.exec(line);
    if (!m) continue;
    if (!isRule(lines[i - 1])) return undefined; // a menu, or a scrollback echo — not the composer
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isRule(lines[j])) { close = j; break; }
      if (/^❯/.test(lines[j] ?? '')) break; // another marker before any rule: not a composer
    }
    if (close === -1) return undefined;
    // A wrapped or multiline prompt continues on the indented lines below the marker.
    return { marker: i, body: [m[1] ?? '', ...lines.slice(i + 1, close)].join('\n') };
  }
  return undefined; // no composer on screen: alt screen, dialog, or an unrecognized frame
}

// SPEC-CLEARANCE §A — the question affordances. AFFORDANCE (→ true): a selector-marked option row
// (`❯ 1. …`, claude's dialog/menu idiom) or a "Do you want" ask line. BLOCKER widens it for the
// suppress branch: ANY numbered option row (the unselected `  2. No` rows, box-edged or bare), or
// a dialog box frame — anything that might be a question keeps the veto inconclusive, because a
// wrong suppress hides a real question while a wrong hold only leaves today's phantom card
// standing. The BLOCKER term is the load-bearing suppression guard: in production only a `false`
// vetoes, so AFFORDANCE's `true` is a fast-path observationally redundant with `undefined` — but
// a selector-less boxed/numbered ask that kept an empty composer is caught ONLY by the blocker.
const QUESTION_AFFORDANCE = /❯\s*\d+\.\s|Do you want/i;
const QUESTION_BLOCKER = /^[\s│┃]*❯?\s*\d+\.\s|Do you want|[╭┌┏]─/im;
// Mid-turn busy detection lives in the shared busy-markers module (claudeBusyFull) so the composer
// veto, parseState, idle-evidence and the loop world-note can never drift — and so it stays robust to
// the `esc to interrupt` footer being SUPPRESSED under Runway's statusLine (SPEC-RUNWAY W0.5).

/** Clip a card message to ~200 chars — enough for a real question, never a pane dump. */
function clip(s: string): string {
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/**
 * SPEC-CLEARANCE §B — the last transcript block above the composer, as a single clipped line.
 * A block is the last contiguous run of non-empty rows; the `⏺`/`✳`/`⎿` transcript markers are
 * stripped (they are chrome, not content), and a row that was ONLY a marker drops out.
 */
function lastTranscriptBlock(lines: string[]): string | undefined {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--;
  let start = end;
  while (start > 0 && (lines[start - 1] ?? '').trim() !== '') start--;
  const text = lines
    .slice(start, end)
    .map((l) => l.replace(/^\s*[⏺✳⎿●]\s*/, '').trim())
    .filter((l) => l.length > 0)
    .join(' ')
    .trim();
  return text ? clip(text) : undefined;
}

/**
 * SPEC-CLEARANCE §B — describe a dialog/menu frame: `optionIdx` is a selector row (`❯ 1. …`).
 * The message is the question header — the contiguous content rows between the box top (or a
 * bounded window above the options) and the first option row, box edges stripped. The preview is
 * the box itself when its frame is drawn, else the option row's neighborhood — never the footer.
 */
function describeClaudeDialog(lines: string[], optionIdx: number): { message?: string; preview: string[] } {
  const frameOnly = (t: string): boolean => /^[─╭╮╰╯┌┐└┘┏┓┗┛━\s]*$/.test(t);
  const stripEdge = (l: string): string => l.replace(/[│┃]/g, ' ').trim();
  let top = -1;
  for (let i = optionIdx; i >= 0 && i >= optionIdx - 12; i--) {
    if (/^\s*[╭┌┏]/.test(lines[i] ?? '')) { top = i; break; }
  }
  let bottom = -1;
  for (let i = optionIdx; i < lines.length && i <= optionIdx + 8; i++) {
    if (/^\s*[╰└┗]/.test(lines[i] ?? '')) { bottom = i; break; }
  }
  const from = top !== -1 ? top : Math.max(0, optionIdx - 8);
  const parts: string[] = [];
  for (let i = from; i < optionIdx; i++) {
    const t = stripEdge(lines[i] ?? '');
    if (frameOnly(t)) continue;
    if (/^❯?\s*\d+\.\s/.test(t)) break; // the options started — the header is complete
    parts.push(t);
  }
  const start = top !== -1 ? top : Math.max(0, optionIdx - 6);
  const end = bottom !== -1 ? bottom + 1 : Math.min(lines.length, optionIdx + 6);
  const message = parts.length ? clip(parts.join(' ')) : undefined;
  return { ...(message !== undefined ? { message } : {}), preview: lines.slice(start, end).slice(0, 12) };
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  // SPEC-SUBMIT ⟦DEC-2⟧ — the UserPromptSubmit hook below fires on a tmux-INJECTED submit (verified
  // live, pins C1), so for claude alone a fresh 'working' is real evidence that a prompt went in.
  signalsSubmit: true,
  supportsAutoAccept: true,

  buildEnv(ctx) {
    return {
      TERM: 'xterm-256color',
      TOWER_TERMINAL_ID: ctx.terminalId,
      TOWER_PROJECT_ID: ctx.projectId,
      TOWER_PORT: String(ctx.towerPort),
      TOWER_HOOK_TOKEN_FILE: ctx.hookTokenFile,
      TOWER_SPOOL_DIR: ctx.spoolDir,
      CLAUDE_CONFIG_DIR: ctx.configDir,
      // SPEC-SUBMIT §2.2 — suppress inline prompt suggestions. capturePlain strips styling, so ghost
      // text rendered INSIDE the composer would read as un-submitted text to the classifier below.
      // Pin note (2026-07-21, 2.1.216): no suggestion text could be reproduced with the var either
      // set or unset, so its effect is UNVERIFIED here — it is kept because it is the documented kill
      // switch and costs nothing, but the classifier deliberately does not depend on it.
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    };
  },

  buildCommand(ctx) {
    // SPEC-MODELS §4 — bind the resolved model as a separate argv token (`--model <slug>`; claude
    // has no short form). Argv is injection-safe (execFile array, no shell); the built-in model
    // allowlist gate in routing.ts validates the slug before spawn.
    // SPEC-EFFORT §3 — bind the resolved effort as `--effort <v>`. The value is enforced against the
    // PINNED CLAUDE_EFFORTS enum at the start gate because clap hard-rejects an unknown value at launch
    // (a loud pre-check beats a dead spawn). Omitted ⇒ no flag (claude's own default).
    // Autonomy — bind --dangerously-skip-permissions ONLY when the create-time resolution
    // (work-purpose only, override ?? project default) set ctx.skipPermissions. The claude CLI
    // itself refuses this flag in some environments (e.g. running as root): that failure renders
    // in the pane — fail-loud, no Tower handling. headlessCommand below deliberately never gets
    // it: the headless `claude -p` path must not gain silent bypass.
    const base = ['claude', ...(ctx.model ? ['--model', ctx.model] : []), ...(ctx.effort ? ['--effort', ctx.effort] : []), ...(ctx.skipPermissions ? ['--dangerously-skip-permissions'] : [])];
    // SPEC-RESTART — thread the resolved session action (createTerminal mints 'new'; a restart that
    // finds an existing transcript resolves 'resume'). Absent for headless, login, and every
    // non-claude spawn, and for a claude spawn predating this wave (no session threaded at all).
    return ctx.session ? claudeSessionArgv(base, ctx.session) : base;
  },

  headlessCommand(ctx, prompt) {
    return ['claude', ...(ctx.model ? ['--model', ctx.model] : []), ...(ctx.effort ? ['--effort', ctx.effort] : []), '-p', prompt, '--output-format', 'stream-json'];
  },

  async writeHookConfig(ctx): Promise<HookBinding[]> {
    await mkdir(ctx.configDir, { recursive: true });
    const hooks = {
      Notification: [
        { matcher: 'permission_prompt', hooks: [cmd(ctx, 'needs-permission')] },
        // SPEC-CLEARANCE §A — the two ask-the-user matchers are SPLIT on the wire. idle_prompt is
        // noisy (claude fires it after ~60s at ANY bare prompt, so every idle pane used to become a
        // phantom QUESTION hold that nothing cleared); it keeps its registration — a soft plain-text
        // question surfaces through it — but its 'needs-input' is subject to ingestSignal's
        // affirmative-only screen veto (questionPending below). agent_needs_input, the explicit
        // ask-the-user path, sends 'agent-question': normalized to the same needs-input state but
        // NEVER vetoed — a strong signal.
        { matcher: 'idle_prompt', hooks: [cmd(ctx, 'needs-input')] },
        { matcher: 'agent_needs_input', hooks: [cmd(ctx, 'agent-question')] },
      ],
      PermissionRequest: [{ hooks: [cmd(ctx, 'needs-permission')] }],
      Stop: [{ hooks: [cmd(ctx, 'turn-done')] }],
      SessionStart: [{ hooks: [cmd(ctx, 'session-start')] }],
      // SPEC-SUBMIT §2.2/⟦DEC-6a⟧ — a DIRECT submit signal, which a screen-scraping stack cannot get.
      // VERIFIED live 2026-07-21 on 2.1.216: this fires for a
      // tmux-INJECTED submit, ~1 s before Stop. Reuses the existing 'session-start' signal, which maps
      // to 'working' (mission.ts) — no new HookSignal member, no schema change. Safe against claude's
      // prompt-blocking rule (a UserPromptSubmit hook that exits non-zero blocks the prompt): the
      // generated ct-hook drains stdin, writes no stdout, and unconditionally exits 0.
      UserPromptSubmit: [{ hooks: [cmd(ctx, 'session-start')] }],
    };
    // settings.json = hooks (full replace) + the SPEC-RUNWAY statusLine. A read-modify-write, not
    // mergeJson, so we can REMOVE a Tower-written statusLine when Runway is off: install ct-usage when
    // ctx.usageLine is set; otherwise delete a statusLine whose command is ours (ends with /ct-usage),
    // leaving any operator/foreign statusLine untouched. autoContinueAtUsageLimit rides usageLine.
    const settingsFile = join(ctx.configDir, 'settings.json');
    let settings: Record<string, unknown> = {};
    try {
      settings = asObject(JSON.parse(await readFile(settingsFile, 'utf8')));
    } catch {
      /* new or corrupt — start fresh */
    }
    // The unattended-spawn belt (work/planner, never a login pane), shared by BOTH disclaimer-skip seeds
    // so they can never drift: a login pane keeps the fully interactive first-run flow even if one is
    // hand-built with skipPermissions. An explicit allowlist — any future purpose stays fail-safe
    // interactive until it opts in.
    const seedUnattended = ctx.purpose === undefined || ctx.purpose === 'work' || ctx.purpose === 'planner';
    settings.hooks = hooks;
    // claude 2.1.316 moved the --dangerously-skip-permissions disclaimer acceptance OUT of .claude.json's
    // bypassPermissionsModeAccepted (older claude) and INTO settings.json's skipDangerousModePermissionPrompt.
    // Plant it on an UNATTENDED, ARMED spawn only — the SAME belt as the .claude.json bypass flag below.
    // Without it a per-terminal live-slot, whose seeded settings.json lacks the account copy, wedges an
    // armed loop builder at the disclaimer. A non-armed or login spawn never sets it (the disclaimer only
    // shows for --dangerously-skip-permissions, which only an armed spawn passes).
    if (ctx.skipPermissions === true && seedUnattended) settings.skipDangerousModePermissionPrompt = true;
    if (ctx.usageLine) {
      settings.statusLine = { type: 'command', command: ctx.usageLine.command, refreshInterval: ctx.usageLine.refreshInterval };
      if (ctx.autoContinueAtUsageLimit) settings.autoContinueAtUsageLimit = true;
    } else {
      const sl = asObject(settings.statusLine);
      if (typeof sl.command === 'string' && sl.command.endsWith('/ct-usage')) {
        delete settings.statusLine;
        // Runway wrote autoContinueAtUsageLimit alongside its statusLine — remove it symmetrically so
        // disabling Runway fully reverts the pane (it is only ever set paired with OUR statusLine).
        delete settings.autoContinueAtUsageLimit;
      }
    }
    await writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    // First-run gate: claude keeps its onboarding state (.claude.json) inside CLAUDE_CONFIG_DIR, and a
    // dir provisioned by any path other than adoptMachineLogin (the shared login dir, or an account a
    // login terminal signed in) can hold a credential but not the state — the CLI then wedges an
    // unattended spawn at an interactive gate: the first-run wizard (hasCompletedOnboarding), and PER
    // FOLDER the trust prompt ("Is this a project you trust?"), which even --dangerously-skip-permissions
    // does not bypass. Trust lives in the projects map keyed by the absolute folder the CLI opens —
    // exactly ctx.cwd, and a fresh worktree is a fresh key, so this must run on every spawn. Seed both
    // for every UNATTENDED spawn — work AND planner (both driven programmatically, absent purpose =
    // 'work' by the record convention); only a login pane keeps the fully interactive flow (that is
    // where the operator signs in). An explicit allowlist, so any future purpose stays fail-safe
    // interactive until it opts in. A single read-modify-write, NOT mergeJson: its shallow top-level
    // spread would replace the whole projects map, wiping every other folder's trust. Existing state
    // (oauthAccount, settings, other project entries, other keys on this folder's entry) survives, so a
    // re-run is a harmless no-op — the same 0600 posture accounts.ts adoptMachineLogin uses.
    // A THIRD flag rides the same write but ONLY on an autonomy spawn (ctx.skipPermissions):
    // bypassPermissionsModeAccepted, the one-time acceptance of the --dangerously-skip-permissions
    // disclaimer, so the armed pane skips that gate too. An ordinary (non-autonomy) spawn never plants
    // it — the conditional at the write below keeps the acceptance tied to the operator's arming.
    if (seedUnattended) {
      const stateFile = join(ctx.configDir, '.claude.json');
      let raw: unknown = {};
      try {
        raw = JSON.parse(await readFile(stateFile, 'utf8'));
      } catch {
        /* absent or corrupt — seed from scratch */
      }
      const state = asObject(raw);
      const projects = asObject(state.projects);
      projects[ctx.cwd] = {
        ...asObject(projects[ctx.cwd]),
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      };
      await writeFile(
        stateFile,
        JSON.stringify(
          {
            ...state,
            hasCompletedOnboarding: true,
            // Autonomy: a skip-permissions spawn launches `claude --dangerously-skip-permissions`
            // (buildCommand above), which claude gates behind a one-time interactive disclaimer.
            // OLDER claude reads bypassPermissionsModeAccepted from <configDir>/.claude.json (seeded
            // here); CURRENT claude (2.1.316+) reads skipDangerousModePermissionPrompt from settings.json
            // (seeded in the settings write above) — plant BOTH so the gate is skipped across versions.
            // Seed it ONLY
            // on such spawns: ctx.skipPermissions is true only when the operator armed autonomy
            // (resolveAutoAccept — work purpose, supportsAutoAccept, override ?? project default),
            // so the operator's arming decision IS the acceptance. A non-autonomous spawn on the
            // same account never plants it.
            ...(ctx.skipPermissions === true ? { bypassPermissionsModeAccepted: true } : {}),
            projects,
          },
          null,
          2,
        ),
        'utf8',
      );
      await chmod(stateFile, 0o600).catch(() => {});
    }
    return [
      { providerEvent: 'Notification/permission_prompt', signal: 'needs-permission' },
      { providerEvent: 'Notification/idle_prompt', signal: 'needs-input' },
      { providerEvent: 'Notification/agent_needs_input', signal: 'agent-question' },
      { providerEvent: 'PermissionRequest', signal: 'needs-permission' },
      { providerEvent: 'Stop', signal: 'turn-done' },
      { providerEvent: 'SessionStart', signal: 'session-start' },
      { providerEvent: 'UserPromptSubmit', signal: 'session-start' },
    ];
  },

  approveKeys() {
    // Claude's permission prompt is a numbered menu (1 Yes / 2 Yes+don't-ask / 3 No).
    // Provisional; re-pin against the installed CLI. The queue shows the request
    // before these are ever sent, and send is state-gated.
    return { approve: ['1'], deny: ['3'] };
  },

  parseState(s) {
    if (/Do you want to proceed|❯\s*1\.\s*Yes|Allow this|permission to/i.test(s)) return 'needs-permission';
    if (claudeBusyFull(s)) return null; // busy — leave as-is (spinner-widened; footer-suppression-safe)
    // Deliberately NO idle ('turn-done') heuristic. Claude Code's idle prompt has no
    // reliable, version-stable marker distinct from ordinary output (a prior `>$` match
    // fired on any line ending in `>`, e.g. a JS arrow `=>`), which mis-flagged working
    // terminals as idle and let the poller demote them + inject a mail-nudge. Claude idle
    // is driven by its Stop HOOK (turn-done). The one accepted cost: decide()'s
    // "dialog gone, now idle" re-check is inert for Claude, so decide() trusts the
    // hook-set blocked-permission state — see the comment in mission.ts decide().
    return null;
  },

  /**
   * SPEC-SUBMIT §2.2 — composer classification. PINNED 2026-07-21 against claude 2.1.216.
   * What we match is NOT the `╭─╮ │ > text │ ╰─╯` box earlier notes
   * describe — that shape is the welcome banner. The composer is a marker line SANDWICHED between
   * two horizontal rules, with the status footer below it:
   *
   *     ────────────────────────────────────────  (U+2500 rule)
   *     ❯ first line                              (U+276F + NBSP, then the text)
   *       continuation lines, indented 2, no marker
   *     ────────────────────────────────────────
   *       ⏸ manual mode on · ? for shortcuts
   *
   * The rule sandwich is LOAD-BEARING, not decoration: the same `❯` marker also renders the
   * folder-trust menu (`❯ 1. Yes, I trust this folder`) and the echo of every previously submitted
   * prompt, and both would otherwise read as un-submitted text — a wrong `true`, which ⟦DEC-8⟧
   * forbids because it would refuse every send as foreign-text. Neither is rule-sandwiched.
   *
   * MID-TURN the composer stays rendered and EMPTY (footer: `esc to interrupt`), which is exactly
   * what makes ⟦DEC-2⟧'s primary signal work: after a real submit this reads `false` within a poll.
   */
  composerPending(snapshot) {
    const body = claudeComposerBody(snapshot);
    return body === undefined ? undefined : body.replace(/[\s\u00A0]/g, '').length > 0;
  },

  composerText(snapshot) {
    return claudeComposerBody(snapshot);
  },

  /**
   * SPEC-CLEARANCE §A — the affirmative-only screen veto for a needs-input hold. Decision order:
   *   1. busy markers anywhere → undefined (mid-turn renders an EMPTY composer; a hook landing now
   *      is out of order — honor it rather than judge it);
   *   2. no composer sandwich → a full-frame dialog's selector rows / ask line affirm the hold
   *      (true); anything else (welcome banner, alt screen) is inconclusive (undefined);
   *   3. composer present: an affordance in the transcript above it → true. A FAST-PATH only —
   *      in production nothing distinguishes true from undefined (only false vetoes), and every
   *      screen it catches, step 4's wider blocker also refuses to suppress;
   *   4. composer present AND empty AND nothing above it that might be a question → false, the ONE
   *      suppressing verdict. The `!QUESTION_BLOCKER` term here is the load-bearing guard: without
   *      it, a selector-less boxed/numbered ask that kept an empty composer would read
   *      affirmatively idle. A typed draft or a blocked read stays undefined.
   * Fails toward SHOWING a card: every inconclusive path is undefined, and only step 4 suppresses.
   */
  questionPending(snapshot) {
    if (claudeBusyFull(snapshot)) return undefined;
    const lines = snapshot.split('\n');
    const region = claudeComposerRegion(lines);
    if (!region) return QUESTION_AFFORDANCE.test(snapshot) ? true : undefined;
    const above = lines.slice(0, region.marker - 1).join('\n');
    if (QUESTION_AFFORDANCE.test(above)) return true;
    const empty = region.body.replace(/[\s\u00A0]/g, '').length === 0;
    if (empty && !QUESTION_BLOCKER.test(above)) return false;
    return undefined;
  },

  /**
   * SPEC-CLEARANCE §B — the card content. A selector row anywhere takes the dialog path (an
   * ask-the-user box may keep the composer rendered below it, and the question lives in the box);
   * otherwise everything from the composer's opening rule down is chrome — dropped — and the
   * message is the last transcript block above it. No recognizable frame → undefined (the caller
   * keeps its raw-preview fallback and the card body falls back honestly).
   */
  describeAttention(snapshot) {
    const lines = snapshot.split('\n').map((l) => l.replace(/\s+$/, ''));
    let optionIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/❯\s*\d+\.\s/.test(lines[i] ?? '')) { optionIdx = i; break; }
    }
    if (optionIdx !== -1) return describeClaudeDialog(lines, optionIdx);
    const region = claudeComposerRegion(lines);
    if (!region) return undefined;
    const above = lines.slice(0, region.marker - 1);
    while (above.length && above[above.length - 1] === '') above.pop();
    if (!above.length) return undefined;
    const message = lastTranscriptBlock(above);
    return { ...(message !== undefined ? { message } : {}), preview: above.slice(-12) };
  },
};
