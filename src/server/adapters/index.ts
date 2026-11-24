// getAdapter / listAdapters now resolve through the live ProviderRegistry (SPEC-PROVIDERS
// §1.3, ⟦DP-3⟧): a custom:<slug> id resolves to its synthesized adapter, a dangling one to a
// throwing tombstone — never the silent shell fallback this module used pre-registry. Kept as
// a thin re-export so every existing `from './adapters/index.js'` call site (mission.ts,
// loops.ts, /api/adapters) is unchanged; only the resolution source moved to the registry.
export { getAdapter, listAdapters } from '../providers/registry.js';
export type { AgentAdapter } from './types.js';
