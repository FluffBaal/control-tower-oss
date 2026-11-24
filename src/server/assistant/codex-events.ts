// Pure mapper: `codex exec --json` JSONL ThreadEvents -> normalized AssistantEvents.
// Shapes validated against openai/codex codex-rs/exec/src/exec_events.rs: the stream is
// tagged `type` ("thread.started" | "turn.started" | "turn.completed" | "turn.failed" |
// "item.started" | "item.updated" | "item.completed" | "error"), with item payloads
// flattened under `item` and tagged by `item.type` (snake_case: agent_message, reasoning,
// mcp_tool_call, command_execution, ...). agent_message/reasoning arrive WHOLE on
// item.completed only (the exec JSONL processor never emits item.started for them —
// no token deltas; see SPEC-ASSISTANT §0.5.2).
//
// No I/O here — CodexProvider owns the process; this file owns the wire shapes so it can
// be unit-tested against captured JSONL.

import type { AssistantEvent } from '../../shared/types.js';

/**
 * Classify a Codex failure message into a first-class dock state (SPEC-ASSISTANT §0.5.4c):
 * quota (usage window exhausted — degrades mid-conversation on a subscription), auth (needs a
 * re-login; there is no headless re-auth path), sandbox (bwrap/landlock degraded or refused).
 */
export function classifyCodexError(msg: string): 'quota' | 'auth' | 'sandbox' | 'other' {
  // Specific tokens only — a bare `rate` matched "gene(rate)d", and `log ?in`/`sign ?in`
  // matched inside "de(sign in)g", misclassifying unrelated failures.
  if (/usage limit|quota|rate limit|too many requests|\b429\b/i.test(msg)) return 'quota';
  if (/refresh token|not logged|unauthoriz|forbidden|missing bearer|forced login|\b401\b|\b403\b|log in again|sign in again|please (log|sign) ?in/i.test(msg)) return 'auth';
  if (/sandbox|bwrap|landlock|seccomp/i.test(msg)) return 'sandbox';
  return 'other';
}

/**
 * Map one parsed JSONL event to an AssistantEvent, or null for events the dock doesn't
 * render (thread.started, turn.started, command_execution, todo_list, ...). `evt` is `any`
 * on purpose: it's an untrusted wire blob from a child process — read defensively.
 */
export function mapCodexEvent(evt: any): AssistantEvent | null {
  if (!evt || typeof evt !== 'object') return null;

  switch (evt.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = evt.item;
      if (!item || typeof item !== 'object') return null;
      switch (item.type) {
        case 'agent_message':
          // Whole answer text; only ever emitted on item.completed (see header comment).
          return { t: 'text', delta: String(item.text ?? '') };
        case 'reasoning':
          // Reasoning summary — likewise whole-on-completed.
          return { t: 'thinking', delta: String(item.text ?? '') };
        case 'mcp_tool_call':
          // Tower-control tool call. started -> a "running" chip; completed fills result.
          // (item.updated also maps to 'started' — the call is still in flight.)
          return {
            t: 'tool',
            id: String(item.id ?? ''),
            name: `${item.server ?? 'tool'}.${item.tool ?? '?'}`,
            args: item.arguments,
            status: evt.type === 'item.completed' ? 'completed' : 'started',
            result: item.result ?? undefined,
          };
        default:
          return null;
      }
    }

    case 'turn.completed':
      return {
        t: 'done',
        stopReason: 'end',
        usage: {
          inputTokens: typeof evt.usage?.input_tokens === 'number' ? evt.usage.input_tokens : undefined,
          outputTokens: typeof evt.usage?.output_tokens === 'number' ? evt.usage.output_tokens : undefined,
        },
      };

    case 'turn.failed': {
      const msg = String(evt.error?.message ?? 'codex turn failed');
      return { t: 'error', error: msg, kind: classifyCodexError(msg) };
    }

    // A stream-level `error` is frequently TRANSIENT — e.g. the "Reconnecting… 401" retries
    // codex prints WHILE recovering, before a successful turn.completed. Treating each as a
    // terminal {t:'error'} made a successful turn render a false failure banner (and emit
    // several terminal events). But dropping them entirely would lose a genuinely fatal one,
    // so surface as NON-terminal progress (faint "thinking"); the authoritative outcome is
    // still turn.failed or CodexProvider's nonzero-exit synthesis from the stderr tail.
    case 'error':
      return { t: 'thinking', delta: String(evt.message ?? 'codex stream error') };

    default:
      return null;
  }
}
