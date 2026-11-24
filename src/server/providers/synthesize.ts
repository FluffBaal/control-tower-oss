// Synthesize an AgentAdapter from a ProviderDef (SPEC-PROVIDERS §1.3). The synthesized adapter
// satisfies the exact §0.1 contract, so a custom provider flows through the unchanged builder
// path (terminal → loop → mission → hook/poller FSM) with no code and no restart. It covers all
// three reliability tiers: A=webhook (a real hook, parity), B=screen-regex (parseState-as-data,
// poller demotes on turn-done), C=dwell-only (output-quiescence). `pollsToIdle` is the one
// adapter-surface hinge — true for B/C so the poller may demote by quiescence; absent for A,
// whose long quiescence backstop lives in the poller keyed off term.providerDef.turn.mode.
//
// tombstoneAdapter is the SAFE fallback for a dangling custom id: it never fabricates a
// signal, fails LOUD at launch, and quiesces — a deleted def must not silently become a shell.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentAdapter, HookBinding } from '../adapters/types.js';
import type { ProviderDef, ProviderId } from '../../shared/types.js';
import type { ProviderStore } from './store.js';

/** Compile a user-authored pattern; a bad regex must never crash rebuild()/forTerminal. */
function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    console.error(`[providers] invalid turn-detection pattern (ignored): ${src}`);
    return null;
  }
}

/**
 * Replace {{key}} placeholders in a single string (one argv token, or one env value). Only
 * own-property vars are substituted (no prototype keys like {{constructor}}); an unknown
 * placeholder is left verbatim. Note {{model}} may be embedded (e.g. `ollama/{{model}}`).
 */
function interpolate(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : m,
  );
}

export function synthesizeAdapter(def: ProviderDef, store: ProviderStore): AgentAdapter {
  void store; // reserved (secrets are injected server-side at terminal-manager, §4.2 — never here)

  // Compile tier-B patterns ONCE per synth (cached on this closure). Permission/input (blocking)
  // win over turn-done. A bad pattern compiles to null and simply never matches.
  const p = def.turn.patterns;
  const reNeedsPermission = p?.needsPermission ? safeRegex(p.needsPermission) : null;
  const reNeedsInput = p?.needsInput ? safeRegex(p.needsInput) : null;
  const reTurnDone = p?.turnDone ? safeRegex(p.turnDone) : null;

  // Compile the chrome-strip patterns ONCE per synth (like the tier-B patterns above): an
  // invalid one logs a single warning here and is dropped, never re-reported per poll. When any
  // survive, normalizeSnapshot strips their matching lines before the poller hashes — the
  // built-in codex normalizeSnapshot generalized to data, so an animated idle TUI reading its
  // own chrome as "output changed" isn't pinned 'working'.
  const chromeRes = (def.turn.chromeStripPatterns ?? [])
    .map((src) => safeRegex(src))
    .filter((re): re is RegExp => re !== null);

  return {
    id: def.id,
    displayName: def.displayName,

    buildEnv(ctx) {
      const model = ctx.model ?? def.model.defaultModel ?? '';
      // def.env is applied FIRST so the Tower-controlled vars below always win — a def.env must
      // never clobber the hook wiring (TOWER_*) or the account-isolation dir. NON-SECRET only;
      // secrets are merged separately at terminal-manager.ts:193 (§4.2), never through buildEnv.
      const env: Record<string, string> = {};
      if (def.env) {
        const vars = {
          model, // same value buildCommand interpolates, so {{model}} works in env values too
          baseUrl: def.baseUrl ?? '',
          cwd: ctx.cwd,
          repoPath: ctx.repoPath,
          towerPort: String(ctx.towerPort),
          configDir: ctx.configDir, // ⟦AR-2⟧ point a secondary XDG var into the one isolated dir
        };
        for (const [k, v] of Object.entries(def.env)) env[k] = interpolate(v, vars);
      }
      env.TERM = 'xterm-256color';
      env.TOWER_TERMINAL_ID = ctx.terminalId;
      env.TOWER_PROJECT_ID = ctx.projectId;
      env.TOWER_PORT = String(ctx.towerPort);
      env.TOWER_HOOK_TOKEN_FILE = ctx.hookTokenFile;
      env.TOWER_SPOOL_DIR = ctx.spoolDir;
      if (def.configDirEnv) env[def.configDirEnv] = ctx.configDir;
      // The resolved model as an env var (the modelEnv alternative to modelFlag), NON-SECRET.
      if (def.model.modelEnv && model) env[def.model.modelEnv] = model;
      return env;
    },

    buildCommand(ctx) {
      const model = ctx.model ?? def.model.defaultModel ?? '';
      const vars = { model, cwd: ctx.cwd, repoPath: ctx.repoPath, baseUrl: def.baseUrl ?? '' };
      const argv = def.command.map((tok) => interpolate(tok, vars));
      // modelFlag + model as SEPARATE argv tokens — never string-concatenated — so an
      // allowlist-checked (§3) model string cannot inject a flag. Skip when no model resolved
      // (pre-start validation §2.3a is the gate; a dangling `--model ''` is avoided here too).
      if (def.model.modelFlag && model) argv.push(def.model.modelFlag, model);
      return argv;
    },

    async writeHookConfig(ctx): Promise<HookBinding[]> {
      const hc = def.turn.hookConfig;
      if (def.turn.mode !== 'webhook' || !hc) return []; // tiers B/C wire no hook file
      // Materialize into a DEDICATED Tower-owned file under configDir — NEVER the CLI's
      // primary config. Tower-owned ⇒ a deterministic full overwrite is idempotent (no merge).
      const target = join(ctx.configDir, hc.relPath);
      const rendered = hc.template
        .replace(/\{\{HOOK_SCRIPT\}\}/g, ctx.hookScript)
        .replace(/\{\{SIGNAL:([^}]+)\}\}/g, (_m, sig: string) => sig.trim());
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, rendered, 'utf8');
      return hc.bindings;
    },

    approveKeys() {
      return def.approveKeys;
    },

    parseState(s) {
      if (reNeedsPermission && reNeedsPermission.test(s)) return 'needs-permission';
      if (reNeedsInput && reNeedsInput.test(s)) return 'needs-input';
      if (reTurnDone && reTurnDone.test(s)) return 'turn-done';
      return null;
    },

    // ⟦DP-4⟧/⟦DP-5⟧ tiers B & C demote to idle by output-quiescence; tier A (webhook) idles by
    // its real hook, so pollsToIdle is absent for A (its long backstop is the poller's).
    pollsToIdle: def.turn.mode === 'webhook' ? undefined : true,

    // Optional poller hints for an animated idle TUI: gate screen-change promotion, and strip
    // the volatile chrome lines before the poller hashes so the same idle screen reads stable.
    screenChangeImpliesWork: def.turn.screenChangeImpliesWork,
    normalizeSnapshot: chromeRes.length
      ? (s: string) => s.split('\n').filter((ln) => !chromeRes.some((re) => re.test(ln))).join('\n')
      : undefined,
  };
}

/**
 * The SAFE adapter for a dangling custom id (def deleted, or a terminal launched with no
 * snapshot). It must NOT degrade to a shell — that looks like it "ran" while doing nothing
 * agentic. Safe on every field the poller/loop touches: no TOWER_* env (nothing treats it as
 * launchable), buildCommand throws LOUD at launch, parseState never fabricates a signal, and
 * pollsToIdle:true lets the quiescence floor demote a stuck terminal rather than hang it.
 */
export function tombstoneAdapter(id: ProviderId): AgentAdapter {
  return {
    id,
    displayName: `${id} (unregistered)`,
    buildEnv: () => ({}),
    buildCommand: () => {
      throw new Error(`provider ${id} not registered`);
    },
    writeHookConfig: async () => [],
    approveKeys: () => ({ approve: [], deny: [] }),
    parseState: () => null,
    pollsToIdle: true,
  };
}
