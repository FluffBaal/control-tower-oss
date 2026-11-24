// Quick Connect — FROZEN contract (SPEC-ONBOARDING §5). The chooser shell (OB-B, QuickConnect.tsx)
// renders each tile (OB-C, AgentTile.tsx) against TileProps, and the integrator supplies a
// QuickConnectApi that satisfies its methods from the `tower` client. Do not change a signature
// here without updating every tile + the integrator wiring.

import type { ProviderDefInput, ProviderDefView, ProviderTestResult, DiscoverResult } from '../ProvidersPanel.js';
import type { AgentProfile, ProviderId, CustomProviderId, PipelineRole, RoleAssignment } from '../../shared/types.js';

/** The exact slice of the Tower client the tiles call. The two NEW methods (machineLoginStatus,
 *  adoptMachineLogin) are wired in api.ts by the integrator; the rest already exist. */
export interface QuickConnectApi {
  // ---- built-in subscription (Tile 1) ----
  listAdapters(): Promise<{ id: ProviderId; displayName: string }[]>;
  listProfiles(): Promise<AgentProfile[]>;
  createProfile(provider: ProviderId, label: string): Promise<AgentProfile>;
  /** Opens the CLI's own interactive login in a terminal (returns the created terminal). */
  loginProfile(profileId: string): Promise<unknown>;
  /** Which built-ins have a copyable machine login present (SPEC-ONBOARDING §2). */
  machineLoginStatus(): Promise<Record<'claude-code' | 'codex', boolean>>;
  /** Copy the machine login into the profile's isolated configDir — no second login (§2). */
  adoptMachineLogin(profileId: string): Promise<{ ok: boolean }>;
  setRoutingRole(role: PipelineRole, assignment: RoleAssignment): Promise<unknown>;
  // ---- custom agent (Tile 2) ----
  /** Is an OSS agent runner (e.g. 'aider') on PATH? The Tile-2 preflight (§1 R1) runs this BEFORE
   *  any questions or upsert, so a missing runner is caught with install guidance, not a broken def. */
  runnerPresent(cmd: string): Promise<{ present: boolean }>;
  upsertProvider(def: ProviderDefInput): Promise<ProviderDefView>;
  discoverModels(id: CustomProviderId): Promise<DiscoverResult>;
  testProvider(id: CustomProviderId): Promise<ProviderTestResult>;
  setProviderSecret(id: CustomProviderId, key: string, value: string): Promise<void>;
}

/** Every tile is rendered with this. onDone carries the created provider/profile id so the shell
 *  can show the shared success step (§1 R12). */
export interface TileProps {
  api: QuickConnectApi;
  onDone(id: string): void;
  onError(msg: string): void;
  onCancel(): void;
}

export type PresetBackend = 'ollama' | 'hosted';

/** A ready-made custom-agent template the Tile-2 flow fills (SPEC-ONBOARDING §3). `def` uses the
 *  AIDER runner; `def.model.modelsPath` is NESTED (F6); hosted `def.command` carries the litellm
 *  prefix per endpoint (F3). The tile pastes the key into secretKey and carries model.models
 *  forward from discover on the final save (F7). */
export interface ProviderPreset {
  key: string;
  label: string;
  backend: PresetBackend;
  /** Hosted-only: the endpoint id (openrouter/groq/together/deepseek/openai-compat). */
  endpoint?: string;
  def: ProviderDefInput;
  /** Hosted-only: the secret env-var NAME the operator's key is stored under. */
  secretKey?: string;
  /** A short curated list shown before the full discovered roster (§3 R11). */
  curatedModels?: string[];
}
