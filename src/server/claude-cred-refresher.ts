// SPEC-CRED-REFRESH — background refresh of idle claude-code account credentials. An idle
// subscription account's access token simply expires (only a live claude CLI on the account renews
// it, and a concurrent-spawn race can null expiresAt outright), while the refresh token stays valid
// for weeks — so renewal is possible without a re-login. This sweeper keeps eligible account dirs
// fresh WITHOUT ever talking to the OAuth token endpoint itself (only the vendor binary may spend a subscription credential):
//   (c) PRIMARY, machine-mirror — when an account dir holds the SAME account as the machine's own
//       claude login (oauthAccount.accountUuid match) and the machine credential is fresher, graft
//       the machine's claudeAiOauth into the dir's credential file, preserving every OTHER key the
//       account accumulated on its own (above all its mcpOAuth map — those tokens exist nowhere
//       else). A local 0600 file write: zero network, zero spend, zero terms exposure.
//   (b) FALLBACK, vendor ping — for an account that does NOT match the machine login, spawn one
//       bounded headless claude turn so the CLI performs its own refresh and writes its own file.
//       OPT-IN via CT_CRED_REFRESH_PING (default OFF): a headless turn SPENDS, and whether `claude
//       -p` bills per-token or against the subscription is unverified — a background timer must not
//       quietly spend on a 12-minute cadence by default, and (c) already covers every account
//       adopted from the machine login.
// Both arms are idle-gated (never touch a dir a live CLI is using), latched (a slow sweep cannot
// overlap the next tick), and credentials-only (`.claude.json` is NEVER written — the adopt path's
// state rewrite is exactly what this module must not repeat). Token VALUES never appear in logs or
// audit output: label + path + booleans + expiry timestamps only.

import { readFileSync, writeFileSync, renameSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { audit } from './audit.js';
import { paths } from './paths.js';
import { machineLoginFile } from './accounts.js';
import { sharedConfigDirFor, liveConfigDirFor } from './terminal-manager.js';
import type { AgentProfile, Terminal } from '../shared/types.js';

const execFileAsync = promisify(execFile);

/** Sweep cadence. Access tokens live hours and the fire window below is 60 minutes wide, so a
 *  12-minute tick reaches every account several times before its token lapses. */
const SWEEP_INTERVAL_MS = 12 * 60_000;
/** Fire when less than this much lifetime remains — early enough that a refresh always lands
 *  before expiry even if one sweep is skipped by the idle gate. */
const EXPIRY_WINDOW_MS = 60 * 60_000;
/** Hard ceiling on a (b) ping. A healthy `-p ok` turn finishes in seconds; SIGKILL because the
 *  child is disposable and must never outlive the latch that assumes it is bounded. */
const PING_TIMEOUT_MS = 60_000;

/** The env-as-boolean convention (terminal-manager's envFlagOn): `FLAG=0`/`FLAG=false` must read
 *  as OFF, not as a truthy non-empty string. */
function envFlagOn(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
}

/** No-throw object read (the readCodexToken discipline): a missing, unreadable, or non-object file
 *  reports `undefined` — a corrupt credential must degrade to "skip this dir", never throw a sweep. */
export function readJsonObjectNoThrow(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function claudeOauth(cred: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const o = cred?.claudeAiOauth;
  return o !== null && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined;
}

/** The claudeAiOauth.expiresAt epoch-ms, or undefined when absent/nulled/malformed. */
function oauthExpiry(cred: Record<string, unknown> | undefined): number | undefined {
  const e = claudeOauth(cred)?.expiresAt;
  return typeof e === 'number' ? e : undefined;
}

export type RefreshDecision = 'fire' | 'fresh' | 'needs-login' | 'not-logged-in';

/**
 * SPEC-CRED-REFRESH §1 — the fire condition, pure so the truth table is testable directly.
 *  - No claudeAiOauth at all ⇒ 'not-logged-in': the dir was never authenticated (or the file is
 *    corrupt); there is nothing to refresh and a ping would only wedge on the login wizard.
 *  - No refresh token, or refreshTokenExpiresAt in the past ⇒ 'needs-login': renewal is impossible,
 *    only a human re-login helps — report once, never spin. An ABSENT refreshTokenExpiresAt with a
 *    refresh token present is treated as still-valid (unknown must not brick a working account).
 *  - expiresAt absent/nulled (the concurrent-spawn race leaves exactly this) or inside the 60-minute
 *    window ⇒ 'fire'. Otherwise 'fresh'.
 */
export function refreshDecision(cred: Record<string, unknown> | undefined, now: number): RefreshDecision {
  const o = claudeOauth(cred);
  if (!o) return 'not-logged-in';
  const refresh = o.refreshToken;
  if (typeof refresh !== 'string' || refresh.length === 0) return 'needs-login';
  const refreshExp = o.refreshTokenExpiresAt;
  if (typeof refreshExp === 'number' && refreshExp <= now) return 'needs-login';
  const exp = o.expiresAt;
  if (typeof exp !== 'number') return 'fire';
  return exp - now < EXPIRY_WINDOW_MS ? 'fire' : 'fresh';
}

/**
 * SPEC-CRED-REFRESH §2 — the idle gate: is ANY live terminal bound to this config dir? Mirrors
 * liveBypassOnDir (terminal-manager.ts) MINUS its autoAccept filter — the clearance belt only cares
 * about skip-permissions agents, but here every live CLI counts: any claude process on the dir may
 * rewrite .credentials.json mid-turn, and racing that write from outside is the exact corruption
 * this gate exists to prevent (a live pane refreshes on use anyway, so skipping loses nothing).
 * Same resolution as the spawn path: profile.configDir when account-bound, else the shared
 * per-provider dir; 'killed' is the only excluded state; a dangling profileId matches
 * CONSERVATIVELY — over-skipping is the safe direction for a background writer.
 */
export function liveTerminalOnDir(
  terminals: Terminal[],
  configDir: string,
  getProfile: (id: string) => { configDir: string } | undefined,
): boolean {
  return terminals.some((t) => {
    if (t.state === 'killed') return false;
    const dir = liveConfigDirFor(t, getProfile);
    // SPEC-RUNWAY — `rotatingFrom` is the OLD dir a mid-rotation pane is moving off; its old process is
    // still alive until the respawn, so count it as live too (never graft under a live writer).
    return dir === undefined || dir === configDir || t.rotatingFrom === configDir;
  });
}

/**
 * Where the MACHINE claude login keeps its `.claude.json` state (the oauthAccount.accountUuid the
 * §3 match reads). With CLAUDE_CONFIG_DIR set the CLI relocates state into that dir; without it the
 * default state file is `~/.claude.json` at the HOME ROOT — not inside `~/.claude/` — so both spots
 * are probed, root first, for layouts where the env was set when the operator logged in.
 */
export function machineClaudeStateFiles(): string[] {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (cfg) return [join(cfg, '.claude.json')];
  return [join(homedir(), '.claude.json'), join(homedir(), '.claude', '.claude.json')];
}

/** The oauthAccount.accountUuid recorded in a `.claude.json`, or undefined. Read-only — this module
 *  never writes any `.claude.json`. */
export function accountUuidAt(stateFile: string): string | undefined {
  const oa = readJsonObjectNoThrow(stateFile)?.oauthAccount;
  if (oa === null || typeof oa !== 'object' || Array.isArray(oa)) return undefined;
  const uuid = (oa as Record<string, unknown>).accountUuid;
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : undefined;
}

/**
 * SPEC-CRED-REFRESH §3 / SPEC-RUNWAY live swap -- the shared graft+atomic-write core: write
 * `{ ...baseCred, claudeAiOauth: newClaudeAiOauth }` to `destCredFile` via temp + rename, 0600 from the
 * first byte (chmod on the tmp too: a leftover tmp from a crash keeps its old perms). Every OTHER key of
 * baseCred (above all mcpOAuth) is preserved. Callers own any gating (idle gate, locks) BEFORE calling.
 */
export function writeCredentialGraft(
  destCredFile: string,
  baseCred: Record<string, unknown> | undefined,
  newClaudeAiOauth: unknown,
): void {
  const tmp = `${destCredFile}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...(baseCred ?? {}), claudeAiOauth: newClaudeAiOauth }, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, destCredFile);
}

export type MirrorOutcome = 'copied' | 'no-match' | 'unclassified' | 'not-newer' | 'machine-unreadable' | 'gated';

/** SPEC-CRED-REFRESH §4 default (b) arm — one bounded headless turn with the dir's own config, so
 *  the vendor CLI performs the refresh and writes its own credential file. Never throws. */
async function headlessPing(configDir: string): Promise<boolean> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  // The ping exists to exercise the OAuth credential: an ambient API key or a Bedrock/Vertex
  // routing flag would bill another channel and refresh nothing — strip them from the child.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  try {
    // cwd is the Tower home: an existing directory with no repo, keeping claude's project-settings
    // layer inert (the accountCredentialProbe precedent). Cheapest model, one-word prompt — the
    // turn's OUTPUT is irrelevant, only the CLI's own credential write matters.
    await execFileAsync('claude', ['--model', 'haiku', '-p', 'ok'], {
      env,
      cwd: paths.home,
      timeout: PING_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch {
    return false;
  }
}

export interface CredRefresherDeps {
  listProfiles: () => AgentProfile[];
  getProfile: (id: string) => { configDir: string } | undefined;
  listTerminals: () => Terminal[];
  /** Test seam for the (b) arm; the default spawns the real vendor binary. */
  ping?: (configDir: string) => Promise<boolean>;
}

/**
 * SPEC-CRED-REFRESH — the sweeper. Modeled on Retention (retention.ts): start() sweeps once, then
 * every SWEEP_INTERVAL_MS on an unref'd timer; sweep() is a latched fire-and-forget so a slow pass
 * (a hung ping is bounded at 60s, but bounded ≠ instant) can never overlap the next tick.
 */
export class ClaudeCredRefresher {
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  /** Per-dir condition memos (`<kind>:<dir>`): once-per-condition audit dedup for
   *  needs-login/ping-skipped/unclassified (a 12-minute cadence must not re-file the same line
   *  forever) and the ping-futile spend back-off. Cleared when the condition clears (a re-login,
   *  a successful refresh), so a RECURRENCE audits — and the ping retries — again. */
  private noted = new Set<string>();

  constructor(private deps: CredRefresherDeps) {}

  start(): void {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The retention `reaping` idiom: the flag is reset on EVERY exit path, so one throw can never
   *  leave the sweeper latched-dead for the life of the process. */
  sweep(): void {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      void this.runOnce()
        .catch((e) => console.error('[cred-refresh] sweep failed:', e))
        .finally(() => {
          this.sweeping = false;
        });
    } catch (e) {
      this.sweeping = false;
      console.error('[cred-refresh] sweep threw synchronously:', e);
    }
  }

  /**
   * One full pass, awaitable (exposed for tests; sweep() is the latched production entry). The
   * eligible set is every claude-code PROFILE dir plus the shared per-provider dir (profileless
   * spawns live there). The provider filter alone keeps the Brain and gemini out of scope: the
   * Brain is a codex profile (codex self-refreshes on its own turns) and gemini keeps a different
   * credential store entirely. Per-dir isolated — one failing dir never aborts the rest.
   */
  async runOnce(): Promise<void> {
    const dirs = new Map<string, string>(); // configDir → audit label
    for (const p of this.deps.listProfiles()) {
      if (p.provider === 'claude-code') dirs.set(p.configDir, p.label);
    }
    const shared = sharedConfigDirFor('claude-code');
    if (!dirs.has(shared)) dirs.set(shared, 'shared');
    const now = Date.now();
    for (const [dir, label] of dirs) {
      try {
        await this.refreshDir(dir, label, now);
      } catch (e) {
        console.error(`[cred-refresh] ${label} failed:`, (e as Error).message);
      }
    }
  }

  private async refreshDir(dir: string, label: string, now: number): Promise<void> {
    const cred = readJsonObjectNoThrow(join(dir, '.credentials.json'));
    const decision = refreshDecision(cred, now);
    if (decision !== 'needs-login') this.noted.delete(`needs-login:${dir}`);
    if (decision === 'fresh') {
      // Recovery clears every per-dir memo, so a RECURRENCE reports — and, for the ping, retries
      // once per expiry cycle — instead of staying muted forever.
      this.noted.delete(`ping-skipped:${dir}`);
      this.noted.delete(`ping-futile:${dir}`);
      this.noted.delete(`unclassified:${dir}`);
    }
    if (decision === 'not-logged-in' || decision === 'fresh') return;
    // decision is 'fire' | 'needs-login'. A 'needs-login' dir (its own token blanked or its refresh
    // token dead) is NOT hopeless when it is the SAME account as a healthy machine login: the
    // machine holds a live token for that account, so the machine-mirror graft repairs it exactly as
    // it repairs a raced 'fire' dir. This is the shared profile-less dir's real failure mode — a
    // clobbered concurrent write leaves accessToken/refreshToken blank while the machine login for
    // the same account is fine. So BOTH decisions attempt the mirror; only the FALLBACK differs: a
    // 'needs-login' dir the mirror can't repair needs a human re-login (never a headless ping, which
    // would just wedge on the login wizard), whereas a 'fire' dir with a clean account MISMATCH is
    // the (b) ping's territory.
    //
    // Idle gate first (§2): a live CLI on the dir refreshes on use — skipping the WRITE costs one
    // tick, but racing its credential write could cost the account. Surfacing is different from
    // writing, though: a spawn wedged on a blanked cred IS a live terminal, so going silent about a
    // gated 'needs-login' would hide the very failure this reports — audit it (once) even when gated.
    if (liveTerminalOnDir(this.deps.listTerminals(), dir, this.deps.getProfile)) {
      if (decision === 'needs-login') this.auditNeedsLoginOnce(dir, label);
      return;
    }
    const mirror = this.tryMirror(dir, label, cred, now);
    if (mirror === 'copied') {
      // Repaired. Clear the ping back-off AND the needs-login memo: the clobber race can recur
      // before any intervening 'fresh' pass, and a still-set needs-login memo would swallow that
      // recurrence's audit (the top-of-method clear at line ~250 only fires when the decision was
      // NOT needs-login — but a repaired needs-login dir's decision WAS needs-login).
      this.noted.delete(`ping-skipped:${dir}`);
      this.noted.delete(`ping-futile:${dir}`);
      this.noted.delete(`needs-login:${dir}`);
      return;
    }
    if (mirror === 'unclassified') {
      // An accountUuid could not be read on one side while a machine login exists: this dir may BE
      // the machine account, so neither arm may touch it. Surfaced once — only a human can restore
      // the uuid stamp (re-adopt) or delete the account.
      if (!this.noted.has(`unclassified:${dir}`)) {
        this.noted.add(`unclassified:${dir}`);
        audit('profile.cred-refresh.unclassified-skip', { label, configDir: dir });
      }
      return;
    }
    // The mirror could not repair (no-match / not-newer / machine-unreadable / gated). A
    // 'needs-login' dir stops here — its own token is unusable and no matching healthy machine login
    // could stand in, so only a human re-login helps: audited once, NEVER pinged (a dead refresh
    // token cannot be revived headlessly).
    if (decision === 'needs-login') {
      this.auditNeedsLoginOnce(dir, label);
      return;
    }
    // decision === 'fire' from here. Only a clean accountUuid MISMATCH (or no machine login) falls
    // through to (b): a matched account with an unreadable/not-newer machine file belongs to the
    // machine login and will be refreshed by the operator's own CLI use — pinging spends for nothing.
    if (mirror !== 'no-match') return;
    if (!envFlagOn(process.env.CT_CRED_REFRESH_PING)) {
      // (b) is opt-in (header verdict): headless billing is unverified, so the default posture is
      // to REPORT the stale non-machine account once rather than silently spend on a timer.
      if (!this.noted.has(`ping-skipped:${dir}`)) {
        this.noted.add(`ping-skipped:${dir}`);
        audit('profile.cred-refresh.ping-skipped', { label, configDir: dir });
      }
      return;
    }
    // Back-off: a prior ping this expiry cycle that did not move the token forward would only
    // repeat the same spend every 12 minutes forever. The memo mutes the arm until the dir
    // recovers (a live CLI or a re-login flips it 'fresh', which clears the memo above) — at most
    // one spend per expiry cycle. The futile attempt itself was already audited below.
    if (this.noted.has(`ping-futile:${dir}`)) return;
    const before = oauthExpiry(cred);
    const ok = await (this.deps.ping ?? headlessPing)(dir);
    // Re-read for the audit trail: outcome + the resulting expiry, never a token value.
    const after = oauthExpiry(readJsonObjectNoThrow(join(dir, '.credentials.json')));
    if (!(typeof after === 'number' && (before === undefined || after > before))) {
      this.noted.add(`ping-futile:${dir}`);
    }
    audit('profile.cred-refresh.pinged', { label, configDir: dir, ok, expiresAt: after ?? null });
  }

  /** Once-per-condition needs-login report: renewal is impossible without a human re-login, so a
   *  12-minute cadence must not re-file the same line. The memo is cleared on recovery (a 'fresh'
   *  pass, or a mirror repair) so a genuine recurrence audits again. */
  private auditNeedsLoginOnce(dir: string, label: string): void {
    if (this.noted.has(`needs-login:${dir}`)) return;
    this.noted.add(`needs-login:${dir}`);
    audit('profile.cred-refresh.needs-login', { label, configDir: dir });
  }

  /**
   * SPEC-CRED-REFRESH §3 — the (c) machine-mirror arm. MERGE-PRESERVE, not a whole-file copy: only
   * `claudeAiOauth` is taken from the machine file; every other key of the ACCOUNT's own credential
   * file survives — above all its mcpOAuth map, whose tokens were minted for this dir and exist
   * nowhere else (a whole-file copy would wipe them and force MCP re-auth). This is also how a
   * BLANKED dir is repaired: the account's own claudeAiOauth is present but its tokens are empty
   * (the clobbered-concurrent-write shape), so the merge swaps in the machine's live tokens while
   * keeping the dir's mcpOAuth. The whole-machine-file fallback below only fires when the account
   * file gave nothing to preserve (defensive: a 'fire' or 'needs-login' decision already implies a
   * readable claudeAiOauth object — blanked or not). Credentials-only: the account's
   * `.claude.json` is never touched. Atomic temp+rename created 0600 from the first byte. The whole
   * mirror path is SYNCHRONOUS — no await from the first idle gate (in refreshDir) through the
   * rename below — so a RECORDED terminal cannot spawn mid-tick and the gate cannot go stale within
   * a single pass. The idle gate is nonetheless re-checked once more just before the rename as pure
   * defense-in-depth: a no-op on today's synchronous path, but load-bearing the instant any future
   * edit introduces an await into this method. It costs one array scan and forecloses a silent
   * TOCTOU regression against a live CLI's own credential write.
   */
  private tryMirror(dir: string, label: string, accountCred: Record<string, unknown> | undefined, now: number): MirrorOutcome {
    const machineCredFile = machineLoginFile('claude-code');
    if (!machineCredFile || !existsSync(machineCredFile)) return 'no-match'; // no machine login to collide with
    const machineUuid = machineClaudeStateFiles().map(accountUuidAt).find((u) => u !== undefined);
    const acctUuid = accountUuidAt(join(dir, '.claude.json'));
    // A machine login EXISTS but one side cannot be classified: the account MAY be the machine
    // login, so it must be neither overwritten nor pinged. Only a definite mismatch is 'no-match'
    // (the (b)-eligible verdict) — "unknown" must never become "spend on it".
    if (!machineUuid || !acctUuid) return 'unclassified';
    if (machineUuid !== acctUuid) return 'no-match';
    const machineFile = readJsonObjectNoThrow(machineCredFile);
    const machineExp = oauthExpiry(machineFile);
    // Matched account but nothing usable to copy: stop here — never fall through to a ping on the
    // machine login's own account.
    if (!machineFile || machineExp === undefined) return 'machine-unreadable';
    // Machine-health guard: a numeric expiresAt (even 0) is NOT proof the machine login is usable —
    // a blanked or logged-out machine credential carries no live token. Grafting a dead machine oauth
    // over a dir that still holds a working refresh token (the raced 'fire' state, acctExp undefined,
    // where the not-newer guard below is skipped) would DESTROY a usable credential. Only a machine
    // login the CLI could actually spend may stand in for this account.
    const machineDecision = refreshDecision(machineFile, now);
    if (machineDecision === 'needs-login' || machineDecision === 'not-logged-in') return 'machine-unreadable';
    const acctExp = oauthExpiry(accountCred);
    // Strictly newer only (no churn re-writing an equal credential). An absent/nulled account
    // expiry is the raced state §1 fires on — any readable machine credential repairs it.
    if (acctExp !== undefined && machineExp <= acctExp) return 'not-newer';
    const dest = join(dir, '.credentials.json');
    if (accountCred) {
      // Defense-in-depth re-check (see the method doc): a no-op on today's synchronous path, kept so an
      // await introduced into this method later cannot silently open a TOCTOU on the idle gate. It
      // runs BEFORE writeCredentialGraft (which writes + renames in one step), so a gated pass leaves
      // no tmp behind.
      if (liveTerminalOnDir(this.deps.listTerminals(), dir, this.deps.getProfile)) return 'gated';
      writeCredentialGraft(dest, accountCred, machineFile.claudeAiOauth);
    } else {
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, readFileSync(machineCredFile), { mode: 0o600 });
      chmodSync(tmp, 0o600); // a leftover tmp from a crash keeps old perms; writeFileSync mode only applies at create
      if (liveTerminalOnDir(this.deps.listTerminals(), dir, this.deps.getProfile)) {
        rmSync(tmp, { force: true });
        return 'gated';
      }
      renameSync(tmp, dest);
    }
    audit('profile.cred-refresh.mirrored', { label, configDir: dir, expiresAt: machineExp });
    return 'copied';
  }
}
