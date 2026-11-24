// SPEC-RUNWAY live credential swap -- instead of re-pointing CLAUDE_CONFIG_DIR and respawning the pane,
// atomically rewrite the OAuth credential IN the config dir a RUNNING claude is reading, so it picks up a
// different account on its next request (claude re-reads .credentials.json per request). Because claude
// reads unlocked and may refresh at any moment, every step that touches the live dir runs while holding
// Claude's own OAuth locks (claude-lock.ts), and the credential write is atomic (temp + rename, 0600).
//
// This module only EXECUTES a chosen swap. WHICH account to swap to is decided elsewhere (chooseRotation
// in controller.ts, at the future call site). The `.claude.json` update below is SURGICAL and
// DELIBERATE -- unlike the adopt path's clobber, it preserves everything (bypassPermissionsModeAccepted,
// hasTrustDialogAccepted, mcpOAuth, projects...) and only swaps the identity and drops the account-scoped
// caches. Token VALUES never reach the audit sink: dir + accountUuid only.

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { refreshDecision, readJsonObjectNoThrow, writeCredentialGraft } from '../claude-cred-refresher.js';
import { withClaudeOauthLocks, ClaudeLockBusyError } from './claude-lock.js';

/** claude-code's own performLogout account-scoped cache keys (verified against 2.1.x): claude clears
 *  these on an account change, so a live swap must too or the new account inherits the old one's
 *  model-access / usage / roster caches. */
export const ACCOUNT_CACHE_KEYS = [
  'additionalModelOptionsCache',
  'additionalModelOptionsAnsweredAt',
  'additionalModelCostsCache',
  'modelAccessCache',
  'orgModelDefaultCache',
  'cachedArtifactRoster',
  'artifactRosterDenied',
  'lastSeenOrgDefaultUpdatedAt',
  'clientDataCache',
  'clientDataCacheSlots',
  'autoCompactWindowsCache',
  'cachedUsageUtilization',
  'metricsStatusCache',
  'metricsStatusCacheByPrincipal',
  'githubWebConnectionStatusCache',
  'startupPrefetchedAt',
] as const;

/**
 * The outcome of a live swap. On `{ ok: false, reason: 'write-failed' }`, `rolledBack` tells the caller
 * whether the live dir was restored to its pre-swap credential:
 *   - `rolledBack: true`  -- the dir is back on the ORIGINAL account; safe to leave in place.
 *   - `rolledBack: false` -- a DOUBLE fault (the `.claude.json` identity write failed AND the credential
 *     rollback ALSO failed): the dir may be CROSS-WIRED (credential = target, identity = old). The caller
 *     MUST treat the terminal as poisoned -- force a full respawn-rotation / quarantine it -- and never
 *     keep serving requests from it. (A single fault alone can never cross-wire: the credential is grafted
 *     FIRST and the identity write is last, so a failed identity write triggers a rollback of the credential,
 *     leaving the dir on the ORIGINAL account; see performLiveSwap step 6.)
 */
export type LiveSwapResult =
  | { ok: true; toAccountUuid: string }
  | {
      ok: false;
      reason: 'target-unhealthy' | 'no-target-oauth' | 'no-target-identity' | 'lock-busy' | 'write-failed';
      rolledBack?: boolean;
    };

export interface LiveSwapDeps {
  withLocks?: typeof withClaudeOauthLocks;
  audit?: (event: string, data: Record<string, unknown>) => void;
  now?: () => number;
}

/** A credential the CLI could actually spend: a refresh token that is present and unexpired. Never swap
 *  a dead token into a live dir. Pure. */
export function targetIsHealthy(targetCred: Record<string, unknown> | undefined, now: number): boolean {
  const d = refreshDecision(targetCred, now);
  return d !== 'needs-login' && d !== 'not-logged-in';
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Atomic temp + rename JSON write, 0600 from the first byte (chmod on the tmp too: a leftover tmp keeps
 *  its old perms). */
function atomicWriteJson(file: string, obj: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Atomic restore of previously captured raw bytes (rollback). */
function atomicWriteBytes(file: string, bytes: Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export async function performLiveSwap(
  input: { liveConfigDir: string; targetConfigDir: string },
  deps: LiveSwapDeps = {},
): Promise<LiveSwapResult> {
  const withLocks = deps.withLocks ?? withClaudeOauthLocks;
  const now = (deps.now ?? Date.now)();
  const { liveConfigDir, targetConfigDir } = input;
  try {
    return await withLocks(liveConfigDir, (): LiveSwapResult => {
      // 1. The target credential must be healthy and carry a claudeAiOauth object.
      const targetCred = readJsonObjectNoThrow(join(targetConfigDir, '.credentials.json'));
      if (!targetIsHealthy(targetCred, now)) return { ok: false, reason: 'target-unhealthy' };
      const targetOauth = targetCred?.claudeAiOauth;
      if (!isObj(targetOauth)) return { ok: false, reason: 'no-target-oauth' };

      // 2. The target identity (oauthAccount) with a non-empty accountUuid.
      const targetOauthAccount = readJsonObjectNoThrow(join(targetConfigDir, '.claude.json'))?.oauthAccount;
      if (!isObj(targetOauthAccount)) return { ok: false, reason: 'no-target-identity' };
      const toAccountUuid = targetOauthAccount.accountUuid;
      if (typeof toAccountUuid !== 'string' || toAccountUuid.length === 0) {
        return { ok: false, reason: 'no-target-identity' };
      }

      // 3. Capture the live credential bytes for rollback; its parsed form is the graft base (keeps mcpOAuth).
      const liveCredFile = join(liveConfigDir, '.credentials.json');
      const liveStateFile = join(liveConfigDir, '.claude.json');
      const originalBytes = existsSync(liveCredFile) ? readFileSync(liveCredFile) : undefined;
      const base = readJsonObjectNoThrow(liveCredFile);

      try {
        // 4. Graft the target's claudeAiOauth into the live credential file (atomic).
        writeCredentialGraft(liveCredFile, base, targetOauth);
        // 5. Surgical .claude.json update: drop account caches, swap identity, preserve everything else.
        const cfg = readJsonObjectNoThrow(liveStateFile) ?? {};
        for (const k of ACCOUNT_CACHE_KEYS) delete cfg[k];
        cfg.oauthAccount = targetOauthAccount;
        atomicWriteJson(liveStateFile, cfg);
      } catch {
        // 6. Roll the credential back so the file and the identity never disagree. A step-5 throw means
        // `.claude.json` was never written (atomic rename is last), so restoring the credential alone
        // returns the dir to a consistent ORIGINAL state. If the rollback write ITSELF fails, the dir may
        // be left cross-wired (credential = target, identity = old): rolledBack:false signals that the
        // caller MUST quarantine it (see LiveSwapResult). Nothing more can be done from a failing fs here.
        let rolledBack = false;
        try {
          if (originalBytes) atomicWriteBytes(liveCredFile, originalBytes);
          else rmSync(liveCredFile, { force: true });
          rolledBack = true;
        } catch {
          rolledBack = false;
        }
        return { ok: false, reason: 'write-failed', rolledBack };
      }

      // 7. Audit: dir + uuid only, never a token value.
      deps.audit?.('runway.live-swap', { fromDir: liveConfigDir, toAccountUuid });
      return { ok: true, toAccountUuid };
    });
  } catch (e) {
    if (e instanceof ClaudeLockBusyError || (e as { code?: string } | undefined)?.code === 'ELOCKED') {
      return { ok: false, reason: 'lock-busy' };
    }
    throw e;
  }
}
