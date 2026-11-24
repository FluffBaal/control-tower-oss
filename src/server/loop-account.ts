// Loop-account resolution — the synchronous "which account would this loop actually spawn under"
// resolver behind the assistant's create_loop gate. A FACTORY the orchestrator (server.ts) wires
// from the real stores; its own leaf module so the propose-time gate is table-testable without
// booting Fastify. Read-only: resolves + probes, never mutates, never mkdir.
import { join } from 'node:path';
import { paths } from './paths.js';
import type { AgentProfile, ProviderId, LayeredRoleRouting } from '../shared/types.js';
import { resolveRouting } from './providers/routing.js';
import type { ProviderSecretLookup } from './providers/routing.js';
import { accountCredentialProbe } from './terminal-manager.js';

export interface LoopAccountInput {
  projectId: string;
  provider?: ProviderId;
  profileId?: string;
  // NOTE: the assistant create_loop surface carries NO role — so the account chain here is
  // [explicit profileId] or empty (⇒ shared login). If create_loop EVER gains a role, this
  // resolver MUST gain it in the SAME commit or propose/spawn account parity breaks.
}

export interface LoopAccountView {
  provider: ProviderId;            // explicit > routing > built-in default
  profileId?: string;              // the account the spawn binds; undefined ⇒ shared per-provider login
  label: string;                   // account label, or `shared <provider> login`
  verdict: 'present' | 'unverifiable' | 'missing';  // 'missing' is exactly what assertAuthenticated refuses
  missingKeys?: string[];          // declared-but-unset env keys when verdict 'missing' (env-mode custom)
  signedInProfiles: { id: string; label: string }[]; // signed-in, NON-reserved accounts of the resolved provider
}

export interface LoopAccountDeps {
  layersFor(projectId?: string): LayeredRoleRouting;
  getProject(id: string): { repoPath: string } | undefined;
  accounts: { getProfile(id: string): AgentProfile | undefined; listProfiles(): AgentProfile[] };
  providerStore: ProviderSecretLookup; // ProviderStore satisfies this structurally (get + hasSecret)
  reservedProfileIds(): ReadonlySet<string>;
}

export function makeLoopAccountResolver(deps: LoopAccountDeps): (input: LoopAccountInput) => LoopAccountView {
  return ({ projectId, provider, profileId }) => {
    // The REAL precedence function with the SAME inputs the /api/loops start gate hands it
    // (loops.ts create: mission defaults {}, no rules), minus role/model/effort which this surface
    // does not carry — so provider+account resolution is identical to spawn.
    const resolved = resolveRouting({ provider, profileId }, {}, deps.layersFor(projectId), deps.providerStore, [], deps.accounts);
    const prof = resolved.profileId !== undefined ? deps.accounts.getProfile(resolved.profileId) : undefined;
    // The project's REAL repoPath makes the verdict byte-equal to the spawn probe's
    // (claude's repo-settings layer reads it); unknown project ⇒ the account-scoped sentinel.
    const repoPath = deps.getProject(projectId)?.repoPath ?? join(paths.home, 'no-repo');
    const probe = (p: ProviderId, configDir: string | undefined) =>
      accountCredentialProbe(p, configDir, deps.providerStore.get(p), (defId, k) => deps.providerStore.hasSecret(defId, k), repoPath);
    const p = probe(resolved.provider, prof?.configDir);
    const reserved = deps.reservedProfileIds();
    return {
      provider: resolved.provider,
      ...(resolved.profileId !== undefined ? { profileId: resolved.profileId } : {}),
      label: prof ? prof.label : `shared ${resolved.provider} login`,
      verdict: p.verdict,
      ...(p.verdict === 'missing' && p.missingKeys ? { missingKeys: p.missingKeys } : {}),
      signedInProfiles: deps.accounts.listProfiles()
        .filter((x) => x.provider === resolved.provider && !reserved.has(x.id))
        .filter((x) => probe(x.provider, x.configDir).verdict === 'present')
        .map((x) => ({ id: x.id, label: x.label })),
    };
  };
}
