// Provider secret READER (SPEC-PROVIDERS §4.2). The WRITE side of the per-provider
// write-only 0600 store — setSecret / hasSecret / clearSecret + the providerSecretFile
// path convention — lives on the ProviderStore (providers/store.ts, the §1.1 frozen
// surface). This module is the single VALUE reader, consumed ONLY at the spawn-env merge
// in terminal-manager (§4.2). It reuses store.ts's providerSecretFile so both agree on the
// on-disk layout — one source of truth, no drift.
//
// By design there is NO getter that returns a value to any API route: readSecretEnv's
// output goes straight into the tmux session env and nowhere else — never providers.json,
// /api/providers, an SSE frame, or a log line (§4.4). This mirrors accounts.readCredential,
// whose only caller is the broker.

import { existsSync, readFileSync } from 'node:fs';
import { providerSecretFile } from './store.js';
import type { ProviderDef } from '../../shared/types.js';

/**
 * §4.2 spawn-env injection: resolve every declared secretEnvKey to {KEY: value} for the
 * SINGLE server-side merge at terminal-manager's env-assembly line — NEVER through an
 * adapter's buildEnv (which stays NON-SECRET, §0.1:38; the def declares only KEY NAMES in
 * secretEnvKeys). Best-effort per §2.3a: a missing / unreadable key is skipped (a pre-start
 * warning, not a hard block here), so one absent secret can't wedge the spawn. Trims like
 * accounts.readCredential to guard a pasted trailing newline. providerSecretFile throws on
 * a malformed key name (its path-traversal guard) — caught here so a bad name can't abort
 * the launch, only omit that one var.
 */
export function readSecretEnv(def: ProviderDef): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of def.secretEnvKeys ?? []) {
    try {
      const file = providerSecretFile(def.id, key);
      if (existsSync(file)) out[key] = readFileSync(file, 'utf8').trim();
    } catch {
      /* invalid key name or unreadable file → treat as absent; pre-start surfaces the gap */
    }
  }
  return out;
}
