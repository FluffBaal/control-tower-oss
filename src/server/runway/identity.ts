// SPEC-RUNWAY — resolve a config dir's SUBSCRIPTION identity. A claude-code credential file carries
// no identity; the account is stamped in the sibling `.claude.json` oauthAccount (accountUuid + email
// + org). Runway groups profiles into subscriptions by accountUuid, so two profile dirs that share an
// account are one rotation slot and one usage budget. Pure, read-only — never writes a `.claude.json`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountUuidAt } from '../claude-cred-refresher.js';

export interface AccountIdentity {
  accountUuid: string;
  email?: string;
  orgUuid?: string;
  orgName?: string;
}

/** No-throw object read — a missing/corrupt/non-object file degrades to undefined (never throws). */
function readObj(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const p = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return p !== null && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The subscription identity for a config dir, or undefined when the dir has never been logged in (no
 * oauthAccount.accountUuid). accountUuid is the load-bearing field (the rotation/usage key); email/org
 * are diagnostic labels for the Runway tab. Reuses accountUuidAt (claude-cred-refresher) as the single
 * accountUuid derivation site.
 */
export function accountIdentityFor(configDir: string): AccountIdentity | undefined {
  const stateFile = join(configDir, '.claude.json');
  const accountUuid = accountUuidAt(stateFile);
  if (!accountUuid) return undefined;
  const oa = readObj(stateFile)?.oauthAccount as Record<string, unknown> | undefined;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  return {
    accountUuid,
    ...(str(oa?.emailAddress) ? { email: str(oa?.emailAddress) } : {}),
    ...(str(oa?.organizationUuid) ? { orgUuid: str(oa?.organizationUuid) } : {}),
    ...(str(oa?.organizationName) ? { orgName: str(oa?.organizationName) } : {}),
  };
}
