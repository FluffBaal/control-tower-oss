// Tower-managed config.toml for the assistant's CODEX_HOME (SPEC-ASSISTANT §0.5.3).
// Written AUTHORITATIVELY (full overwrite, unlike the launch adapter's write-if-absent):
// this profile exists solely to be the assistant brain, so the Tower owns its config and
// re-asserts the safety pins (read-only sandbox, never-approve, subscription-only login)
// on every write. Only auth.json in the same dir is codex's own (the login).
//
// TOML gotcha (same one adapters/codex.ts documents): every top-level key MUST appear
// BEFORE the first [table] header, or it silently becomes a key of that table and codex
// ignores it. Keep the scalar pins first, [mcp_servers.tower-control] last.

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TOML basic-string literal. JSON string escaping is a compatible subset of TOML's
 * (\" \\ \n \t \uXXXX...), so JSON.stringify is a correct encoder for the paths/ports
 * we write here.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function writeAssistantCodexConfig(
  configDir: string,
  opts: {
    model?: string;
    /** SPEC-EFFORT §3 — the Brain's reasoning effort, pinned as `model_reasoning_effort`; unset = no line
     *  (codex's own default). Codex-only — this file is the assistant Brain's config. */
    effort?: string;
    towerPort: number;
    mcpTokenFile: string;
    repoRoot: string;
    /**
     * The assistant conversation this turn belongs to. When set, it is injected into the
     * MCP server's env as TOWER_CONVERSATION_ID — the presence of that var is what makes
     * mcp-tower serve propose_action, and the Tower binds every proposal to this id
     * server-side (SPEC-ASSISTANT-CONTROL §4). Callers must pass it per turn, BEFORE the
     * turn runs. The Validator's judge/planner/drafter writes omit it, so those brains
     * stay strictly read-only.
     */
    conversationId?: string;
  },
): void {
  mkdirSync(configDir, { recursive: true });

  // Launch the tower-control MCP server from the COMPILED build when present (prod: no tsx /
  // no src tree needed), else fall back to running the TS source via tsx (dev). Getting this
  // wrong (npx-tsx in a lean prod install) hard-fails every turn, since required = true.
  // Prod (NODE_ENV=production) runs the COMPILED server (no tsx / no src tree needed); dev
  // always runs the TS source via tsx so edits are live (an existsSync-only check would pin
  // dev to a stale dist left over from a prior `npm run build`).
  const distEntry = join(opts.repoRoot, 'dist/server/assistant/mcp-tower.js');
  const useDist = process.env.NODE_ENV === 'production' && existsSync(distEntry);
  const [mcpCommand, mcpArgs] = useDist
    ? ['node', [distEntry]]
    : ['npx', ['tsx', join(opts.repoRoot, 'src/server/assistant/mcp-tower.ts')]];

  // The MCP server's env. TOWER_CONVERSATION_ID appears ONLY for a real assistant turn
  // (see the opts doc): its presence is the switch that adds propose_action to the served
  // registry, so leaving it out is what keeps the Validator's shared runs read-only.
  const mcpEnv = [
    `TOWER_PORT = ${tomlString(String(opts.towerPort))}`,
    `TOWER_MCP_TOKEN_FILE = ${tomlString(opts.mcpTokenFile)}`,
    ...(opts.conversationId ? [`TOWER_CONVERSATION_ID = ${tomlString(opts.conversationId)}`] : []),
  ];

  const lines = [
    // -- top-level pins (must precede any [table] header — see file comment) --
    // The operator picks the brain's model explicitly (SPEC-MODELS — the system imposes NO default):
    // when set we pin it; when unset we write NO `model` line at all so codex falls back to its OWN
    // default rather than a slug we chose. Subscription auth allows only a NARROW catalog (verified
    // 2026-07, codex-cli 0.144.3, ChatGPT Pro: gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark;
    // most other slugs 400 "not supported when using Codex with a ChatGPT account" — re-verify before editing).
    ...(opts.model && opts.model.trim() ? [`model = ${tomlString(opts.model.trim())}`] : []),
    // SPEC-EFFORT §3 — pin the Brain's reasoning effort directly after model, still a TOP-LEVEL key BEFORE
    // any [table] header (the TOML gotcha above); NO line when unset so codex uses its own default.
    ...(opts.effort && opts.effort.trim() ? [`model_reasoning_effort = ${tomlString(opts.effort.trim())}`] : []),
    'approval_policy = "never"', // exec never prompts; combined with read-only there is no unsandboxed retry
    'sandbox_mode = "read-only"', // OS shell sandboxed; MCP tools still fire (that is the design)
    'forced_login_method = "chatgpt"', // guarantee the subscription login, never an API key
    'cli_auth_credentials_store = "file"', // auth.json in this CODEX_HOME, not the OS keychain
    '',
    // -- tower-control MCP server: how the brain reads live Tower state (§0.5.3) --
    '[mcp_servers.tower-control]',
    `command = ${tomlString(mcpCommand)}`,
    `args = [${mcpArgs.map(tomlString).join(', ')}]`,
    `env = { ${mcpEnv.join(', ')} }`,
    `cwd = ${tomlString(opts.repoRoot)}`,
    'required = true', // a turn without Tower tools is worse than a failed turn — fail loudly
    // codex ≥0.14x routes MCP tool calls through the approval system, and approval_policy
    // = "never" AUTO-DENIES them ("user cancelled MCP tool call" on every call — verified
    // live 2026-07-05 on 0.142.5). Pre-approve: this server exposes only the read-only tool
    // registry, so auto-running its tools is the design (§0.5 item 3), not a loosening.
    'default_tools_approval_mode = "approve"',
    '',
  ];

  // Atomic write (tmp + rename): every Brain turn (judge / plan / grade / plan-revision / story-draft)
  // rewrites this shared file, and W2's escalation adds an AUTONOMOUS writer on the tick drive. A plain
  // O_TRUNC write would let a concurrent codex spawn read a half-truncated file (missing the required
  // [mcp_servers.tower-control] block) and hard-fail; rename is atomic so a reader sees only the complete
  // old or new file. All turns write identical content (same active account), so there is no lost-update.
  const target = join(configDir, 'config.toml');
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, lines.join('\n'), 'utf8');
  renameSync(tmp, target);
}
