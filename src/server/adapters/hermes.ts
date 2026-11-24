// Hermes Agent adapter (NousResearch/hermes-agent). Account isolation via HERMES_HOME — a first-class
// config-dir override (hermes_constants.get_hermes_home: in-process ctx → HERMES_HOME env → platform
// default), so config.yaml, .env, the shell-hook allowlist, session DB, logs and skills all land under
// <configDir>. This is the direct analog of CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME.
//
// COMPLETION IS HOOK-PRIMARY, not screen-scraped. The interactive UI is a custom Ink/React renderer
// with a live shimmer/animation, so diff-based idle detection is unreliable; instead Hermes fires a
// shell hook on on_session_end after EVERY turn (a stable, versioned contract), which we point at the
// ct-hook forwarder exactly as claude's Stop hook and codex's notify program are. HERMES_ACCEPT_HOOKS=1
// grants non-interactive consent so a fresh HERMES_HOME runs the hook without an approval prompt.
//
// KNOWN LIMITATION (first cut): the composer/permission SCREEN classifiers are not implemented — the
// Ink frame strings are not yet pinned against a live install. Consequences, both fail-safe: (1) sends degrade to an audited blind send (no composerPending
// ⇒ tmux.sendTextVerified's documented degraded path), and (2) the poller's affirmative-idle backstop
// never fires for hermes, so completion rests entirely on the on_session_end hook (like claude was for a
// long time). parseState returns null (no screen idle/permission heuristic). Upgrade both the moment a
// live pane is available to pin the frame.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentAdapter, HookBinding, LaunchContext } from './types.js';

/**
 * Upsert a top-level `hooks:` block into an existing config.yaml WITHOUT a YAML dependency, preserving
 * every other top-level key the operator may have set (model default, provider, etc.). YAML top-level
 * keys sit at column 0 and their children are indented, so the block runs from a `^hooks:` line to the
 * next column-0 key (or EOF). If no hooks block exists it is appended; if one exists (ours or a prior
 * write) it is replaced. Pure and tested. The model/provider come via the --model FLAG (buildCommand),
 * never this file, so replacing only the hooks block is non-destructive for a driven spawn.
 */
export function upsertHooksBlock(content: string, block: string): string {
  const normalizedBlock = block.replace(/\n+$/, '');
  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^hooks:(\s|$)/.test(l));
  if (start === -1) {
    const trimmed = content.replace(/\n+$/, '');
    return (trimmed === '' ? '' : `${trimmed}\n`) + `${normalizedBlock}\n`;
  }
  // The block runs from `hooks:` through its LAST indented child. A real column-0 key definitively ends
  // it; trailing column-0 comments and blank lines AFTER the last child belong to whatever follows, so a
  // comment annotating the next top-level key is preserved. A column-0 comment SANDWICHED between
  // indented children is skipped (kept scanning), so a later child still extends the block — this avoids
  // orphaning that child into a duplicate `hooks:` key. Comments INSIDE the block we overwrite are
  // discarded, which is fine: the Tower owns this block. Blank lines are ambiguous until we see what
  // follows, so they never end the scan on their own.
  let lastContent = start; // index of the `hooks:` line; grows to the last indented child of the block
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.trim() === '') continue; // blank — internal or trailing; decided by what follows
    if (/^\s/.test(l)) {
      lastContent = i; // an indented child extends the block
      continue;
    }
    if (l.startsWith('#')) continue; // column-0 comment — internal, or annotating the next key
    break; // a real column-0 key ends the block
  }
  const merged = [...lines.slice(0, start), ...normalizedBlock.split('\n'), ...lines.slice(lastContent + 1)];
  return `${merged.join('\n').replace(/\n+$/, '')}\n`;
}

/** The fixed hooks block wiring Hermes's per-turn lifecycle events to the ct-hook forwarder. */
function hooksBlock(ctx: LaunchContext): string {
  return [
    'hooks:',
    '  on_session_start:',
    `    - command: "${ctx.hookScript} session-start"`,
    '  on_session_end:',
    `    - command: "${ctx.hookScript} turn-done"`,
  ].join('\n');
}

export const hermesAdapter: AgentAdapter = {
  id: 'hermes',
  displayName: 'Hermes',

  buildEnv(ctx) {
    return {
      TERM: 'xterm-256color',
      TOWER_TERMINAL_ID: ctx.terminalId,
      TOWER_PROJECT_ID: ctx.projectId,
      TOWER_PORT: String(ctx.towerPort),
      TOWER_HOOK_TOKEN_FILE: ctx.hookTokenFile,
      TOWER_SPOOL_DIR: ctx.spoolDir,
      // Isolate the whole Hermes home (config.yaml, .env, allowlist, session DB, logs) into the Tower's
      // per-account dir instead of the operator's real ~/.hermes.
      HERMES_HOME: ctx.configDir,
      // Non-interactive consent for the shell hooks below: a fresh HERMES_HOME would otherwise prompt
      // for approval on first sight of the (event, command) pair and wedge an unattended spawn.
      HERMES_ACCEPT_HOOKS: '1',
    };
  },

  buildCommand(ctx) {
    // Bare `hermes` is the interactive TUI (== `hermes chat`). --model is a TOP-LEVEL flag and takes a
    // provider-qualified slug (e.g. openrouter/anthropic/claude-sonnet-4.6); argv is injection-safe
    // (execFile array, no shell) and the model allowlist gate in routing.ts validates the slug first.
    return ['hermes', ...(ctx.model ? ['--model', ctx.model] : [])];
  },

  headlessCommand(ctx, prompt) {
    // `hermes -z <prompt>` prints only the final response (no banner/spinner) and auto-approves tool
    // prompts — the one-shot shape for future automation.
    return ['hermes', ...(ctx.model ? ['--model', ctx.model] : []), '-z', prompt];
  },

  async writeHookConfig(ctx): Promise<HookBinding[]> {
    await mkdir(ctx.configDir, { recursive: true });
    const file = join(ctx.configDir, 'config.yaml');
    let current = '';
    try {
      current = await readFile(file, 'utf8');
    } catch {
      /* fresh config */
    }
    await writeFile(file, upsertHooksBlock(current, hooksBlock(ctx)), 'utf8');
    return [
      { providerEvent: 'on_session_start', signal: 'session-start' },
      { providerEvent: 'on_session_end', signal: 'turn-done' },
      // needs-permission: NOT wired for the first cut. Hermes's pre_tool_call hook fires on EVERY tool
      // call (not only when approval is needed), so mapping it to needs-permission would mis-signal;
      // deferred until the approval semantics are pinned against a live install.
    ];
  },

  approveKeys() {
    return { approve: ['y'], deny: ['n'] }; // provisional; re-pin against a live install
  },

  parseState() {
    // Hook-primary (see file header): the Ink UI animates, so there is no reliable version-stable screen
    // marker for idle or permission. Return null (inconclusive) and let the on_session_end hook drive
    // turn-done. Deliberately no idle heuristic — a wrong one would mis-demote a working pane.
    return null;
  },
};
