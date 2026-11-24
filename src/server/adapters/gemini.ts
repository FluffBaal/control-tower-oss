// Gemini CLI adapter. Account isolation via GEMINI_CLI_HOME — a *home* override, so
// state lands in $GEMINI_CLI_HOME/.gemini. Gemini OAuth is file-based,
// so this isolation is sound. Crucially, Gemini has NO idle event: its hooks give us
// permission-wait (Notification) and turn-done (AfterAgent), and idle detection falls
// to parseState via the PTY poller.
//
// Context-file trick: point Gemini at AGENTS.md directly via
// context.fileName so we don't need a GEMINI.md shim.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentAdapter, HookBinding, LaunchContext } from './types.js';

async function mergeJson(file: string, patch: Record<string, unknown>): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    /* new file */
  }
  await writeFile(file, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
}

function cmd(ctx: LaunchContext, signal: string): { type: 'command'; command: string } {
  return { type: 'command', command: `${ctx.hookScript} ${signal}` };
}

/**
 * SPEC-SUBMIT §2.4 — the empty-composer placeholder (pins G1, gemini-cli 0.51.0:
 * `Type your message or @path/to/file`, plus the voice and shell-mode variants; the
 * `Type your message` prefix is the stable part).
 *
 * The 8-row window is a HEURISTIC, not a pin. G1 was read from the shipped bundle and explicitly did
 * NOT observe the frame live, so nothing pinned says the placeholder renders within 8 rows of the
 * bottom. The anchoring is there because an unanchored scan reads the placeholder out of ordinary
 * agent OUTPUT (this repo's own agents print captured panes), and a wrong `false` certifies a send
 * that never happened. If the composer sits higher than 8 rows the cost is the safe direction: no
 * conclusive reading, so every gemini send degrades to audited-'unverified'.
 *
 * Deliberate split from `parseState` below, which still matches the same string across the WHOLE
 * snapshot: that is a pre-existing idle heuristic with different consequences (it feeds the poller,
 * not the send verdict), and narrowing it is not this wave's change to make.
 */
function placeholderNearBottom(snapshot: string): boolean {
  const tail = snapshot.split('\n').slice(-8).join('\n');
  return /Type your (message|shell command)/i.test(tail);
}

export const geminiAdapter: AgentAdapter = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',

  buildEnv(ctx) {
    return {
      TERM: 'xterm-256color',
      TOWER_TERMINAL_ID: ctx.terminalId,
      TOWER_PROJECT_ID: ctx.projectId,
      TOWER_PORT: String(ctx.towerPort),
      TOWER_HOOK_TOKEN_FILE: ctx.hookTokenFile,
      TOWER_SPOOL_DIR: ctx.spoolDir,
      GEMINI_CLI_HOME: ctx.configDir,
    };
  },

  buildCommand(ctx) {
    // SPEC-MODELS §4 — bind the resolved model as a separate argv token (`-m <slug>`). Argv is
    // injection-safe (execFile array, no shell); the built-in model allowlist gate in routing.ts
    // validates the slug before spawn.
    return ['gemini', ...(ctx.model ? ['-m', ctx.model] : [])];
  },

  headlessCommand(ctx, prompt) {
    return ['gemini', ...(ctx.model ? ['-m', ctx.model] : []), '-p', prompt, '--output-format', 'json'];
  },

  async writeHookConfig(ctx): Promise<HookBinding[]> {
    const dir = join(ctx.configDir, '.gemini');
    await mkdir(dir, { recursive: true });
    const settings = {
      context: { fileName: ['AGENTS.md', 'GEMINI.md'] },
      hooks: {
        Notification: [{ hooks: [cmd(ctx, 'needs-permission')] }],
        AfterAgent: [{ hooks: [cmd(ctx, 'turn-done')] }],
        SessionStart: [{ hooks: [cmd(ctx, 'session-start')] }],
      },
    };
    await mergeJson(join(dir, 'settings.json'), settings);
    return [
      { providerEvent: 'Notification(ToolPermission)', signal: 'needs-permission' },
      { providerEvent: 'AfterAgent', signal: 'turn-done' },
      { providerEvent: 'SessionStart', signal: 'session-start' },
      // idle: none — parseState/poller supplies it
    ];
  },

  approveKeys() {
    return { approve: ['y'], deny: ['n'] }; // provisional; re-pin per version
  },

  parseState(s) {
    if (/Apply this change|Allow execution|\(y\/n\)|Do you want to allow/i.test(s)) return 'needs-permission';
    if (/esc to cancel|Loading|Thinking/i.test(s)) return null; // busy
    // A visible prompt box with no busy indicator ≈ idle/turn-done.
    if (/Type your message|╭─+╮[\s\S]*╰─+╯/.test(s)) return 'turn-done';
    return null;
  },

  /**
   * SPEC-SUBMIT §2.4 — composer classification. CONSERVATIVE BY NECESSITY: this classifier never
   * returns `true`.
   *
   * What is pinned (2026-07-21): the empty composer's
   * placeholder, read from the shipped bundle of the installed gemini-cli 0.51.0 —
   * `Type your message or @path/to/file`, with variants `…or ${voiceAction} (Esc to exit)` and
   * `Type your shell command`. The `Type your message` PREFIX is the stable part, and parseState
   * already keys idle on it.
   *
   * What is NOT pinned: the composer FRAME on 0.51.0. An authenticated pane was not reachable on
   * this host (a scratch config home starts at the auth-method menu, and completing an OAuth flow
   * on the operator's account was out of scope), so the shape that would distinguish "typed text in
   * the composer" from "any other text on screen" has never been observed. Guessing it would risk a
   * wrong `true` on an idle composer, which ⟦DEC-8⟧ forbids — that turns every send into a gate.
   *
   * So: placeholder visible ⇒ `false` (affirmatively empty, which is what ⟦SB-4⟧ needs to confirm a
   * submit), anything else ⇒ `undefined` (an audited, degraded send). Holes 1-3 close for gemini;
   * hole 4a stays audited until the frame is pinned. Upgrade this the moment a live pane is available.
   */
  composerPending(snapshot) {
    // ANCHORED to the bottom of the screen. A whole-snapshot scan would read the placeholder out of
    // ordinary agent output — this repo's own agents print captured panes — and a wrong `false` is
    // as damaging as a wrong `true` here: an empty-reading composer is what confirms a submit, so a
    // false one would certify a send that never happened.
    return placeholderNearBottom(snapshot) ? false : undefined;
  },

  composerText(snapshot) {
    // The composer FRAME on the installed version was never observed (pins G1: an authenticated pane
    // was not reachable), so the region cannot be identified. Reporting the placeholder line as
    // "composer text" would be worse than admitting ignorance: the our-text matcher would then be
    // scoped to a region that may not be the composer at all. undefined ⇒ the caller falls back to a
    // whole-snapshot match with its pre-send baseline, which is honest about what is known.
    void snapshot;
    return undefined;
  },

  /**
   * SPEC-CLEARANCE §B — best-effort card content: drop the input box (the `╭─╮…╰─╯` frame holding
   * the Type-your-message placeholder) and everything below it — chrome, not content. If the
   * placeholder isn't on screen the frame is unrecognized → undefined (raw-preview fallback).
   * Gemini has no needs-input hook source today, so this only ever renders a stale hold.
   */
  describeAttention(snapshot) {
    const lines = snapshot.split('\n').map((l) => l.replace(/\s+$/, ''));
    let ph = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/Type your (message|shell command)/i.test(lines[i] ?? '')) { ph = i; break; }
    }
    if (ph === -1) return undefined;
    let cut = ph;
    for (let i = ph; i >= 0 && i >= ph - 4; i--) {
      if (/^\s*╭/.test(lines[i] ?? '')) { cut = i; break; }
    }
    const above = lines.slice(0, cut);
    while (above.length && above[above.length - 1] === '') above.pop();
    if (!above.length) return undefined;
    const message = (above[above.length - 1] ?? '').trim();
    return {
      ...(message ? { message: message.length > 200 ? `${message.slice(0, 199)}…` : message } : {}),
      preview: above.slice(-12),
    };
  },
};
