// Onboard assistant — SERVER-SIDE FROZEN CONTRACTS (SPEC-ASSISTANT §0.5).
// The assistant modules code against these seams. Do not change a signature here without
// updating every module that imports it.

import type { AssistantEvent } from '../../shared/types.js';

/** One turn's input to a provider. history is prior turns (oldest→newest), excluding this prompt.
 *  `system` turns are Tower-authored notes (a confirmed proposal's outcome) the brain replays as
 *  context (SPEC-ASSISTANT-CONTROL §4). */
export interface TurnRequest {
  conversationId: string;
  prompt: string;
  history: { role: 'user' | 'assistant' | 'system'; text: string }[];
  /** Aborts the underlying CLI process / HTTP call when the client disconnects. */
  signal?: AbortSignal;
}

/**
 * A pluggable assistant brain. v1 impl = CodexProvider (runs `codex exec --json` in a logged-in
 * CODEX_HOME). Later: an ApiProvider (API key). streamTurn yields normalized AssistantEvents.
 */
export interface AssistantProvider {
  readonly id: string; // e.g. "codex-cli"
  streamTurn(req: TurnRequest): AsyncIterable<AssistantEvent>;
  capabilities(): { tools: boolean; streaming: boolean };
}

/**
 * A tower-control tool exposed to the brain via the MCP server. M-A1 registers ONLY `kind: 'read'`
 * tools; mutate tools are physically absent until M-A3 adds the human-confirm gate. Handlers run
 * in-process on the Tower (trusted), typically calling the Tower's own loopback HTTP routes.
 */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** 'read' = pure query; 'propose' = records a human-gated proposal (mutates NOTHING itself,
   *  SPEC-ASSISTANT-CONTROL §1); 'draft' = writes ONLY the inert assistant draft pad (SPEC-SKILLS
   *  Phase 5b) — it may ride the MCP auto-approval because nothing executes or materializes from a
   *  draft (the mcp-tower guard keys on 'mutate' and continues to refuse only that); 'mutate' = a
   *  direct write (still refused by mcp-tower under auto-approval — there is no direct-mutate tool). */
  kind: 'read' | 'propose' | 'draft' | 'mutate';
  handler(args: Record<string, unknown>): Promise<unknown>;
}

/** SSE framing contract for POST /api/assistant/message: one event per `data:` line. */
export function sseFrame(ev: AssistantEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

export type { AssistantEvent };
