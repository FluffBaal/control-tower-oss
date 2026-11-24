// The live provider registry (SPEC-PROVIDERS §1.3, ⟦DP-3⟧). Replaces the static getAdapter
// (adapters/index.ts:16): a boot-time singleton composing the four built-in adapters with
// adapters SYNTHESIZED from the store, recomposed on every store mutation (rebuild). Crucially
// it does NOT silently shell-degrade a dangling `custom:` id — that resolves to a tombstone.
//
// getAdapter / listAdapters stay thin free-function wrappers over the singleton, so every
// existing composer/roster call site is unchanged — only the import source moves here. The
// poller and loop runner instead call registry.forTerminal(term), which resolves off the def
// FROZEN onto the terminal at launch, never the live store — so an edit / delete /
// rebuild can never change a live terminal's turn detection mid-turn (the hot-reload race).

import type { Terminal, ProviderId, BuiltinProviderId, CustomProviderId } from '../../shared/types.js';
import type { AgentAdapter } from '../adapters/types.js';
import { claudeAdapter } from '../adapters/claude.js';
import { geminiAdapter } from '../adapters/gemini.js';
import { codexAdapter } from '../adapters/codex.js';
import { shellAdapter } from '../adapters/shell.js';
import { hermesAdapter } from '../adapters/hermes.js';
import { synthesizeAdapter, tombstoneAdapter } from './synthesize.js';
import type { ProviderStore } from './store.js';

const BUILTIN_REGISTRY: Record<BuiltinProviderId, AgentAdapter> = {
  'claude-code': claudeAdapter,
  'gemini-cli': geminiAdapter,
  codex: codexAdapter,
  shell: shellAdapter,
  hermes: hermesAdapter,
};

function isBuiltinId(id: ProviderId): id is BuiltinProviderId {
  return (
    id === 'claude-code' || id === 'gemini-cli' || id === 'codex' || id === 'shell' || id === 'hermes'
  );
}

export class ProviderRegistry {
  private synth = new Map<CustomProviderId, AgentAdapter>();
  /** Memoized forTerminal adapters, keyed by terminal id — the def snapshot is frozen onto the
   *  terminal at launch and never changes, so this is safe; released when the terminal ends. */
  private forTerminalCache = new Map<string, AgentAdapter>();

  constructor(private store: ProviderStore) {
    this.rebuild();
  }

  /**
   * Recompose the synthesized adapters from the store. Composer-roster refresh ONLY — a running
   * terminal is unaffected (it resolves via forTerminal off its frozen snapshot).
   */
  rebuild(): void {
    this.synth.clear();
    for (const d of this.store.list()) this.synth.set(d.id, synthesizeAdapter(d, this.store));
  }

  /** For composers / roster: resolve against the CURRENT store (built-in, synth, or tombstone). */
  get(id: ProviderId): AgentAdapter {
    if (isBuiltinId(id)) return BUILTIN_REGISTRY[id];
    const synth = this.synth.get(id);
    if (synth) return synth;
    return tombstoneAdapter(id); // a dangling custom id — never a silent shell
  }

  /**
   * SNAPSHOT-AT-LAUNCH: a running terminal resolves its adapter from the def frozen onto
   * it at launch (Terminal.providerDef), NOT the live store. The poller and loop runner use this
   * so an edit / delete / registry rebuild can never change a live terminal's turn detection.
   */
  forTerminal(term: Terminal): AgentAdapter {
    if (isBuiltinId(term.provider)) return BUILTIN_REGISTRY[term.provider];
    // Memoized per terminal id: the poller (every tick) and the loop runner both call this, and
    // the def snapshot is immutable per terminal, so synthesizing once — and compiling its
    // patterns / logging any malformed one once — is safe. release(term.id) drops it on end.
    const cached = this.forTerminalCache.get(term.id);
    if (cached) return cached;
    const adapter = term.providerDef
      ? synthesizeAdapter(term.providerDef, this.store)
      : tombstoneAdapter(term.provider);
    this.forTerminalCache.set(term.id, adapter);
    return adapter;
  }

  /** Drop a terminal's memoized forTerminal adapter when it is released/killed (its snapshot is
   *  gone). Wired from the terminal-release fan-out (poller.forget), so it can't leak per id. */
  release(terminalId: string): void {
    this.forTerminalCache.delete(terminalId);
  }

  list(): AgentAdapter[] {
    return [...Object.values(BUILTIN_REGISTRY), ...this.synth.values()];
  }
}

// ---- boot-time singleton + thin free-function wrappers ----
// Boot order (integrator): const store = new ProviderStore(); const registry =
// initProviderRegistry(store); store.setHooks({ onRebuild: () => registry.rebuild(),
// onChange: () => sse.broadcast({ t: 'providers' }) });

let singleton: ProviderRegistry | null = null;

/** Construct the boot-time singleton. The registry's ctor calls rebuild(), so the store must
 *  already be loaded. Returns it so the integrator can wire it into the store's hooks. */
export function initProviderRegistry(store: ProviderStore): ProviderRegistry {
  singleton = new ProviderRegistry(store);
  return singleton;
}

/** The boot-time singleton. Throws if accessed before initProviderRegistry (a boot-order bug). */
export function providerRegistry(): ProviderRegistry {
  if (!singleton) throw new Error('provider registry not initialized — call initProviderRegistry(store) at boot');
  return singleton;
}

/** Thin wrapper over registry.get — the drop-in replacement for adapters/index.ts's getAdapter. */
export function getAdapter(id: ProviderId): AgentAdapter {
  return providerRegistry().get(id);
}

/** Thin wrapper over registry.list — the drop-in replacement for adapters/index.ts's listAdapters. */
export function listAdapters(): AgentAdapter[] {
  return providerRegistry().list();
}
