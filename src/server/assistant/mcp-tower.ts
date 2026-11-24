// Onboard assistant — tower-control MCP stdio server (SPEC-ASSISTANT §0.5/§4, M-A1).
//
// The Codex brain spawns this as a child process (`npx tsx src/server/assistant/mcp-tower.ts`,
// cwd = repo root so node_modules resolves) per its `[mcp_servers.tower-control]` config, and
// talks JSON-RPC over stdio. This process is deliberately OUTSIDE the Tower: it holds no Tower
// objects and reaches the Tower only via loopback HTTP (see tools.ts), so a wedged/killed brain
// can never corrupt Tower state, and MCP calls work even though Codex's own shell sandbox is
// read-only (MCP tool calls run outside the sandbox — §0.5 item 3).
//
// Protocol handling is delegated to the official MCP SDK for correctness (initialize handshake,
// capability negotiation, JSON-RPC framing). We register only the two methods a tool server
// needs: tools/list and tools/call. Registry = READ_TOOLS, plus — ONLY inside an assistant
// turn — the propose_action tool, whose human-confirm gate lives Tower-side (M-A3,
// SPEC-ASSISTANT-CONTROL §1). Direct mutate tools stay structurally impossible here.
//
// stdio discipline: stdout belongs to JSON-RPC. Any diagnostics MUST go to stderr, or the
// client's framing breaks.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { PROPOSE_TOOL, READ_TOOLS, SAVE_DRAFT_TOOL } from './tools.js';
import type { ToolDef } from './contracts.js';

/**
 * The registry this process serves. READ_TOOLS always; propose_action AND save_skill_draft ONLY
 * when TOWER_CONVERSATION_ID is in the env. That env var is written into config.toml solely
 * for real assistant turns (codex-config.ts) — the Validator's judge/planner/drafter
 * brains share this exact MCP server via the same config writer but never set a
 * conversation id, so they stay strictly read-only: no Confirm cards, and no draft pad
 * (the save route requires the conversation header the gate here mirrors —
 * SPEC-ASSISTANT-CONTROL §5, SPEC-SKILLS Phase 5b).
 */
export function buildRegistry(): ToolDef[] {
  return [...READ_TOOLS, ...(process.env.TOWER_CONVERSATION_ID ? [PROPOSE_TOOL, SAVE_DRAFT_TOOL] : [])];
}

/** Build the tower-control MCP server over the given tool registry. */
export function createTowerMcpServer(tools: ToolDef[] = buildRegistry()): Server {
  // Hard runtime pair to the config-side `default_tools_approval_mode = "approve"` pin
  // (codex-config.ts): that pre-approves EVERY tool this server exposes, so refuse to
  // serve any direct-mutate tool. kind:'propose' may ride the auto-approval because it
  // mutates nothing — it records a proposal whose execution waits on the operator's
  // Confirm click in the dock (SPEC-ASSISTANT-CONTROL §1); the human gate moved
  // Tower-side rather than being an MCP approval.
  const mutating = tools.filter((t) => t.kind === 'mutate');
  if (mutating.length > 0) {
    throw new Error(
      `tower-control MCP refuses to serve direct-mutate tools under auto-approval: ${mutating.map((t) => t.name).join(', ')}`,
    );
  }
  const server = new Server(
    { name: 'tower-control', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // ToolDef.parameters is already a JSON Schema object — MCP calls the same thing inputSchema.
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as { type: 'object'; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      // Unknown tool is a *tool-level* error (isError result), not a protocol error: the
      // model should see the message and self-correct rather than the client aborting.
      return {
        content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>);
      // Plain-string results (e.g. explain's help text) go through verbatim — JSON.stringify
      // would wrap them in quotes and escape every newline, wasting the model's context.
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text' as const, text }] };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: (e as Error).message }],
        isError: true,
      };
    }
  });

  return server;
}

async function main(): Promise<void> {
  const tools = buildRegistry();
  const server = createTowerMcpServer(tools);
  await server.connect(new StdioServerTransport());
  // stderr only — stdout is the JSON-RPC channel. Count the read tools from the registry actually
  // served, and name both conversation-gated tools so the line stays honest as the roster grows.
  const proposing = tools.includes(PROPOSE_TOOL);
  const drafting = tools.includes(SAVE_DRAFT_TOOL);
  console.error(
    `tower-control MCP server ready (stdio, ${READ_TOOLS.length} read tools, propose_action ${proposing ? 'enabled' : 'absent — no conversation id'}, save_skill_draft ${drafting ? 'enabled' : 'absent — no conversation id'})`,
  );
}

// Run only when executed directly (node/tsx entrypoint), not when imported for tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`tower-control MCP server failed to start: ${(e as Error).message}`);
    process.exit(1);
  });
}
