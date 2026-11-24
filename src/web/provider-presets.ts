// Quick Connect preset catalog (SPEC-ONBOARDING §3) — ready-made ProviderDefInput templates the
// Tile-2 flow (quickconnect/AgentTile.tsx) fills in and saves through the existing provider
// upsert. Pure client DATA: no backend, no component. The runner is always AIDER — the one OSS
// agent CLI the tile preflights — pointed either at a local Ollama or a hosted OpenAI-style
// endpoint.
//
// Correctness constraints baked into every def (each verified against the server source):
// - Aider routes model ids through litellm, so the command's {{model}} token carries the
//   endpoint's litellm provider prefix (`ollama/`, `openrouter/`, `groq/`, `together_ai/`,
//   `deepseek/`, generic compat = `openai/`) — a bare model id won't resolve without it.
// - `modelsPath` is NESTED under `model` (shared/types.ts ProviderModelConfig) — a top-level
//   modelsPath is stripped by the upsert schema. Discovery fetches
//   joinUrl(baseUrl, modelsPath), so the /v1-style baseUrls below pair with a '/models' path;
//   pairing them with '/v1/models' would double the segment (…/api/v1/v1/models).
// - Base-url env wiring: Ollama needs OLLAMA_API_BASE and the generic compat endpoint needs
//   OPENAI_API_BASE (both interpolate {{baseUrl}} at spawn). The named hosted endpoints are
//   deliberately NOT given a base-url env var — litellm's built-in default for each already
//   matches the def's baseUrl, and a wrong override would break the runtime while the def's
//   baseUrl still only drives discovery.
// - Turn detection ships at tier B (screen-regex): dwell-only would carry the degraded amber
//   badge. When a turn finishes, Aider returns to a bare input prompt — `> ` in the default
//   chat mode, mode-prefixed otherwise (`ask> `, `architect> `, `multi> `). The done-pattern
//   matches such a prompt line only when it is the LAST content of the pane snapshot (the
//   compiled RegExp gets no flags, so `$` is end-of-snapshot; `\s*` swallows trailing blank
//   pane lines): historical prompt lines keep the submitted text after the `>`, so they never
//   read as done mid-turn. needs-permission/needs-input patterns are deliberately omitted —
//   Aider's answered `(Y)es/(N)o` text scrolls but stays inside the poller's capture window,
//   and a stale match would re-block a terminal the operator just approved.
// - Secrets never ride `env` (the upsert rejects secret-looking values): each hosted preset
//   declares its key's env-var NAME in secretEnvKeys and mirrors it in `secretKey` for the
//   tile's write-only paste.
//
// `curatedModels` are a short familiar shortlist shown BEFORE the full discovered roster
// (SPEC-ONBOARDING §1 Tile 2) — suggestions only, not availability claims; the roster of
// record is whatever discovery returns from the live endpoint.

import type { ProviderDefInput } from './ProvidersPanel.js';
import type { ProviderPreset } from './quickconnect/contract.js';
import type { ProviderTurnDetection } from '../shared/types.js';

/** The binary the Tile-2 preflight checks for — every preset's command[0]. */
export const AIDER_BIN = 'aider';

/** Aider's ready-prompt as the tier-B done-pattern (see the header note for the anatomy). */
export const AIDER_DONE_PATTERN = '(?:^|\\n)[a-z-]*>\\s*$';

/** The one preset whose endpoint is operator-supplied, so the tile must ask for a base URL. */
export const OPENAI_COMPAT_KEY = 'openai-compat';

/** Fresh per-call so no two defs share a mutable turn object. */
function aiderTurn(): ProviderTurnDetection {
  return { mode: 'screen-regex', patterns: { turnDone: AIDER_DONE_PATTERN } };
}

/** One hosted-endpoint def: Aider + litellm prefix + write-only API key via secretEnvKeys. */
function hostedDef(o: {
  slug: string;
  name: string;
  prefix: string;
  keyVar: string;
  baseUrl: string;
  env?: Record<string, string>;
  /** Extra argv inserted before --no-auto-commits (the research preset's --chat-mode ask). */
  extraArgs?: string[];
}): ProviderDefInput {
  const def: ProviderDefInput = {
    id: `custom:${o.slug}`,
    displayName: o.name,
    command: [AIDER_BIN, '--model', `${o.prefix}/{{model}}`, ...(o.extraArgs ?? []), '--no-auto-commits'],
    secretEnvKeys: [o.keyVar],
    baseUrl: o.baseUrl,
    model: { modelsPath: '/models', defaultModel: '' },
    turn: aiderTurn(),
    approveKeys: { approve: ['y'], deny: ['n'] },
    auth: { mode: 'env' },
  };
  if (o.env) def.env = o.env;
  return def;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'ollama',
    label: 'Ollama on this computer',
    backend: 'ollama',
    def: {
      id: 'custom:aider-ollama-local',
      displayName: 'Aider + Ollama (local)',
      command: [AIDER_BIN, '--model', 'ollama/{{model}}', '--no-auto-commits'],
      env: { OLLAMA_API_BASE: '{{baseUrl}}' },
      baseUrl: 'http://localhost:11434',
      // Ollama's native tag listing; discovery also understands its { models: [{ name }] } shape.
      model: { modelsPath: '/api/tags', defaultModel: '' },
      turn: aiderTurn(),
      approveKeys: { approve: ['y'], deny: ['n'] },
      auth: { mode: 'none' },
    },
    curatedModels: ['llama3.2', 'qwen2.5-coder'],
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    backend: 'hosted',
    endpoint: 'openrouter',
    def: hostedDef({
      slug: 'aider-openrouter',
      name: 'Aider + OpenRouter',
      prefix: 'openrouter',
      keyVar: 'OPENROUTER_API_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
    }),
    secretKey: 'OPENROUTER_API_KEY',
    curatedModels: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o', 'qwen/qwen3-coder'],
  },
  {
    // SPEC-RESEARCH W9 ⟦DEC-8⟧ — a research posture for the same endpoint: aider's ASK mode answers
    // questions over the repo map instead of trying to patch files, which is what a research sortie
    // wants (and its branch is never merged anyway).
    //
    // What is VERIFIED here, from this repo: the shipped done-pattern matches a mode-prefixed prompt —
    // `ask> ` reads as turn-done, and a prompt line with typed text after it does not (tested against
    // AIDER_DONE_PATTERN itself); the endpoint, key wiring and litellm `openrouter/` prefix are the
    // shipped preset's, unchanged; and the def is pure data (a custom ProviderDef synthesizes its
    // whole adapter), so this costs zero server code.
    //
    // What is NOT verified: the `--chat-mode ask` argv, and how ask mode actually behaves turn to
    // turn. aider is not installed on the build host (its launcher exists but the package is gone),
    // so neither could be observed. If the flag is wrong the CLI fails loudly at spawn — a visible
    // start failure, not a silent wedge — but it has not been proven on a live pane, and the tile copy
    // says what ask mode is rather than overselling it.
    key: 'openrouter-research',
    label: 'OpenRouter — research (ask mode)',
    backend: 'hosted',
    endpoint: 'openrouter',
    def: hostedDef({
      slug: 'aider-openrouter-research',
      name: 'Aider ask-mode + OpenRouter (research)',
      prefix: 'openrouter',
      keyVar: 'OPENROUTER_API_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
      extraArgs: ['--chat-mode', 'ask'],
    }),
    secretKey: 'OPENROUTER_API_KEY',
    // Suggestions, not availability claims (the file's own rule) — discovery returns the live roster.
    curatedModels: ['z-ai/glm-4.6', 'deepseek/deepseek-chat', 'qwen/qwen3-coder'],
  },
  {
    key: 'groq',
    label: 'Groq',
    backend: 'hosted',
    endpoint: 'groq',
    def: hostedDef({
      slug: 'aider-groq',
      name: 'Aider + Groq',
      prefix: 'groq',
      keyVar: 'GROQ_API_KEY',
      baseUrl: 'https://api.groq.com/openai/v1',
    }),
    secretKey: 'GROQ_API_KEY',
    curatedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  },
  {
    key: 'together',
    label: 'Together AI',
    backend: 'hosted',
    endpoint: 'together',
    def: hostedDef({
      slug: 'aider-together',
      name: 'Aider + Together AI',
      prefix: 'together_ai',
      keyVar: 'TOGETHERAI_API_KEY',
      baseUrl: 'https://api.together.xyz/v1',
    }),
    secretKey: 'TOGETHERAI_API_KEY',
    curatedModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-Coder-32B-Instruct'],
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    backend: 'hosted',
    endpoint: 'deepseek',
    def: hostedDef({
      slug: 'aider-deepseek',
      name: 'Aider + DeepSeek',
      prefix: 'deepseek',
      keyVar: 'DEEPSEEK_API_KEY',
      baseUrl: 'https://api.deepseek.com',
    }),
    secretKey: 'DEEPSEEK_API_KEY',
    curatedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    key: OPENAI_COMPAT_KEY,
    label: 'OpenAI-compatible (any endpoint)',
    backend: 'hosted',
    endpoint: OPENAI_COMPAT_KEY,
    def: hostedDef({
      slug: 'aider-openai-compat',
      name: 'Aider + OpenAI-compatible',
      prefix: 'openai',
      keyVar: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
      env: { OPENAI_API_BASE: '{{baseUrl}}' },
    }),
    secretKey: 'OPENAI_API_KEY',
    curatedModels: ['gpt-4o', 'gpt-4o-mini'],
  },
];

/** The local sub-flow's preset (exactly one ollama-backend entry in the catalog). */
export const OLLAMA_PRESET: ProviderPreset = PROVIDER_PRESETS.find((p) => p.backend === 'ollama')!;

/** The hosted sub-flow's endpoint roster, in catalog order. */
export const HOSTED_PRESETS: ProviderPreset[] = PROVIDER_PRESETS.filter((p) => p.backend === 'hosted');
