// Credential broker (SPEC D13/§13). No long-lived push secret ever enters an agent's
// environment. Instead each terminal gets a per-terminal broker token (0600 file);
// git's credential.helper (ct-credential) connects to this loopback unix socket at
// push time, presents the token, and the broker maps token -> terminal -> identity ->
// the stored PAT, returning it to git without the agent process ever holding it.
//
// Caller auth here is the per-terminal token. Under a single Unix user (M1–M3) that is
// the guarantee; once per-agent UIDs exist (M4 isolation setup), SO_PEERCRED becomes a
// real second factor. Even pre-UID this beats a PAT in env: off-env, revocable, and
// only reachable via the socket.

import net from 'node:net';
import { writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';
import { token as makeToken, shortId } from './ids.js';
import { audit } from './audit.js';
import type { Store } from './store.js';
import type { Accounts } from './accounts.js';
import type { Terminal } from '../shared/types.js';

// The stored credential is a GitHub PAT. It must ONLY be handed to GitHub hosts —
// otherwise a hostile repo whose remote / insteadOf URL points elsewhere (or an
// injected agent that `git push`es to attacker.example) would exfiltrate the real
// PAT. git presents the bare hostname (no port) as `host`.
const ALLOWED_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'api.github.com',
  'gist.github.com',
  'codeload.github.com',
]);
export function isAllowedHost(host: string | undefined): boolean {
  return typeof host === 'string' && ALLOWED_HOSTS.has(host.toLowerCase());
}

/** The verdict of validateRepoUrl: the accepted (verbatim) url, or a model/operator-readable error. */
export type RepoUrlVerdict = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate a per-project GitHub repo URL. Metadata only — the broker's host allowlist (isAllowedHost)
 * stays the authorization boundary, so this never widens what a push may reach. Accepts
 * https://github.com/owner/repo[.git] on an allowlisted GitHub host; blank clears the field. Stored
 * VERBATIM (no canonicalization), so anything the URL parser would rewrite is rejected rather than
 * silently normalized into the stored text.
 */
export function validateRepoUrl(raw: string): RepoUrlVerdict {
  const s = raw.trim();
  if (s === '') return { ok: true, url: '' }; // blank/absent clears the field
  if (s.length > 512) return { ok: false, error: 'repo URL is too long (max 512 characters)' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'repo URL must be a valid URL like https://github.com/owner/repo' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'repo URL must use https://' };
  if (u.username || u.password) return { ok: false, error: 'repo URL must not embed credentials' };
  if (u.port) return { ok: false, error: 'repo URL must not specify a port' };
  // Reject a query/fragment, including a BARE trailing '?' or '#' (u.search/u.hash are '' for those, but
  // the delimiter survives in the stored text and renders as an empty Flightline link) — check the raw input.
  if (u.search || u.hash || s.includes('?') || s.includes('#')) return { ok: false, error: 'repo URL must not carry a query string or fragment' };
  if (!isAllowedHost(u.hostname)) return { ok: false, error: `repo URL host '${u.hostname}' is not an allowed GitHub host` };
  // Accept a single trailing slash (a common paste): trim ONE before the owner/repo shape test.
  const path = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
  if (!/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(path)) {
    return { ok: false, error: 'repo URL must be https://github.com/owner/repo (optionally ending .git)' };
  }
  // Verbatim store: reject anything the parser would rewrite — a surviving '/a/..', an uppercase
  // scheme/host, percent-encoding — so the stored text always means exactly what it reads as. A single
  // trailing slash is the one tolerated difference (compare both sides with it removed).
  if (u.href.replace(/\/$/, '') !== s.replace(/\/$/, '')) {
    return { ok: false, error: 'repo URL must be written in canonical form (no path traversal or redundant encoding)' };
  }
  return { ok: true, url: s };
}

/** Whether the Tower's own land->push to this ALREADY-RESOLVED push URL should be brokered. True only
 *  for an https URL on an allowlisted GitHub host — the only thing the broker can serve a credential
 *  for. SSH/scp shorthand, non-URL forms, and non-GitHub https (GitHub Enterprise / GitLab) return
 *  false, so land() stays fail-open on the daemon's ambient credentials for any host the broker would
 *  refuse (brokering there would reset the ambient credential.helper and then deny — breaking a push
 *  that works today). Callers pass the post-insteadOf push URL (git remote get-url --push), so this
 *  reflects where the push ACTUALLY goes, not just what the remote is nominally configured as. */
export function isBrokerableGitHubPushUrl(pushUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(pushUrl);
  } catch {
    return false; // scp/ssh shorthand and other non-URL forms are never brokered
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false; // embedded userinfo — the broker matches on host alone
  if (!isAllowedHost(u.hostname)) return false;
  // git presents host=<host>:<port> to the credential helper for ANY explicit port (even :443), but
  // the broker's allowlist matches BARE hostnames — a ported URL would be denied at the socket and fail
  // closed. WHATWG normalizes :443 away (u.port === ''), so inspect the raw authority for a port and,
  // if present, decline to broker: the push stays fail-open on the ambient credentials instead.
  const authority = pushUrl.slice(pushUrl.indexOf('://') + 3).split('/')[0] ?? '';
  const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  if (hostPort.includes(':')) return false;
  return true;
}

// ---- One-shot GitHub PR creation (land 'pr' mode) ----------------------------------------------------
// A BOUNDED departure from the git-only broker: to actually open a PR the Tower makes ONE in-process
// HTTPS call to api.github.com (an allowlisted GitHub host, TLS-encrypted) with the project identity's
// PAT. The PAT is passed straight into the request headers — never logged, returned, placed in an env
// var / argv / child process, nor stored — and the caller keeps it in a request-scoped closure that
// outlives nothing. Everything here is pure/isolated so it is unit-testable without a live network, and
// PR creation is NON-FATAL to the already-succeeded push (see worktrees.land / formatPrLandDetail).

/** Parse a push URL to its GitHub owner/repo, or undefined when it is not exactly owner/repo. A push URL
 *  can be brokerable (host/scheme/port allowed) yet still carry an un-parseable path like
 *  `/owner/repo/extra` — return undefined there so the PR attempt is skipped rather than calling the API
 *  with a mangled owner/repo. Strips a leading '/', a trailing '/', and a trailing '.git'. */
export function parseGitHubOwnerRepo(pushUrl: string): { owner: string; repo: string } | undefined {
  let u: URL;
  try {
    u = new URL(pushUrl);
  } catch {
    return undefined;
  }
  const path = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  const segs = path.split('/');
  if (segs.length !== 2) return undefined; // owner/repo only — an extra segment is not a PR target
  const [owner, repo] = segs;
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

/** The classified outcome of a POST /pulls response — pure, so the status/body mapping is unit-tested. */
export type PrCreateOutcome =
  | { kind: 'created'; url: string }
  | { kind: 'exists' }
  | { kind: 'fail'; reason: string };

/** Map a GitHub PR-create response to an outcome. NEVER throws and NEVER includes the token (it only ever
 *  reads status + response body). 201+html_url ⇒ created; 422 "already exists" ⇒ exists; 422 no-commits,
 *  401/403 (cred), 404 (not visible), and any other status ⇒ fail with a bounded, token-free reason. */
export function classifyPrCreateResponse(status: number, body: unknown): PrCreateOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const topMessage = typeof b.message === 'string' ? b.message : '';
  const errs = Array.isArray(b.errors) ? b.errors : [];
  const errMessages = errs
    .map((e) =>
      e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string'
        ? ((e as Record<string, unknown>).message as string)
        : '',
    )
    .filter(Boolean);
  const allText = [topMessage, ...errMessages].join(' ').trim();

  if (status === 201) {
    const url = typeof b.html_url === 'string' ? b.html_url : '';
    return url ? { kind: 'created', url } : { kind: 'fail', reason: 'GitHub returned 201 without a pull-request URL' };
  }
  if (status === 422) {
    if (/already exists/i.test(allText)) return { kind: 'exists' };
    if (/no commits between/i.test(allText)) {
      return { kind: 'fail', reason: 'no commits between the base and the branch to open a PR from' };
    }
    return { kind: 'fail', reason: `GitHub rejected the PR (422)${allText ? `: ${allText.slice(0, 200)}` : ''}` };
  }
  if (status === 401 || status === 403) {
    return { kind: 'fail', reason: `the push credential is not authorized to open a PR (HTTP ${status})` };
  }
  if (status === 404) {
    return { kind: 'fail', reason: 'the repository is not visible to the push credential (HTTP 404)' };
  }
  return { kind: 'fail', reason: `GitHub returned HTTP ${status}${allText ? `: ${allText.slice(0, 200)}` : ''}` };
}

/** The arguments createGitHubPr needs (owner/repo resolved by parseGitHubOwnerRepo). */
export interface CreatePrArgs {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
}

/** The result of a PR attempt. `existing:true` means a PR was already open for this head. Never carries
 *  the token, and (via createGitHubPr's try/catch) never throws. */
export type CreatePrResult = { ok: true; url?: string; existing?: boolean } | { ok: false; reason: string };

/**
 * Open a PR with ONE in-process HTTPS POST to api.github.com using `pat`. On a 422 "already exists" it
 * follows up with a GET to recover the open PR's URL. The whole thing is wrapped in try/catch so any
 * network/abort error becomes `{ok:false, reason}` — the caller treats a failure as non-fatal to the push.
 */
export async function createGitHubPr(pat: string, args: CreatePrArgs): Promise<CreatePrResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'control-tower',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
  const repoUrl = `https://api.github.com/repos/${args.owner}/${args.repo}`;
  try {
    const res = await fetch(`${repoUrl}/pulls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: args.title, head: args.head, base: args.base }),
      signal: AbortSignal.timeout(15000),
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    const outcome = classifyPrCreateResponse(res.status, parsed);
    if (outcome.kind === 'created') return { ok: true, url: outcome.url };
    if (outcome.kind === 'exists') {
      // Recover the already-open PR's URL so the operator still gets a link.
      try {
        const q = `head=${encodeURIComponent(`${args.owner}:${args.head}`)}&state=open`;
        const list = await fetch(`${repoUrl}/pulls?${q}`, { headers, signal: AbortSignal.timeout(15000) });
        const arr = (await list.json()) as unknown;
        const first = Array.isArray(arr) ? arr[0] : undefined;
        const url =
          first && typeof first === 'object' && typeof (first as Record<string, unknown>).html_url === 'string'
            ? ((first as Record<string, unknown>).html_url as string)
            : undefined;
        return { ok: true, existing: true, ...(url ? { url } : {}) };
      } catch {
        return { ok: true, existing: true };
      }
    }
    return { ok: false, reason: outcome.reason };
  } catch (err) {
    // Defense-in-depth on this credential path: a fetch header-validation error echoes the whole
    // Authorization value (the PAT) in its message, and that reason is audited + shown in the UI. Redact
    // the token from any error before it escapes, so a token can never surface here regardless of how it
    // reached the header (no product path stores a CRLF token today — this keeps that a non-issue).
    return { ok: false, reason: redactToken((err as Error).message, pat) };
  }
}

/** Strip a token from a message before it becomes an audited / user-visible reason, then cap length.
 *  Redact-then-cap so the token is removed wherever it sits, not just within the first N chars. */
export function redactToken(message: string, token: string): string {
  const redacted = token ? String(message ?? '').split(token).join('[REDACTED]') : String(message ?? '');
  return redacted.slice(0, 300);
}

const BIN_DIR = join(paths.home, 'bin');
export const CREDENTIAL_SCRIPT = join(BIN_DIR, 'ct-credential');
export const BROKER_SOCK = join(paths.home, 'broker.sock');

/** Emit the git credential helper (a small node client for the broker socket). */
export function ensureCredentialScript(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  const script = `#!/usr/bin/env node
// Control Tower git credential helper (generated). Backed by the Tower broker.
const net = require('node:net');
const fs = require('node:fs');
if (process.argv[2] !== 'get') process.exit(0); // store/erase are no-ops
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const attrs = Object.fromEntries(
    input.split('\\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
  );
  const tokenFile = process.env.TOWER_BROKER_TOKEN_FILE;
  const sock = process.env.TOWER_BROKER_SOCK;
  if (!tokenFile || !sock) process.exit(0);
  let token = '';
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { process.exit(0); }
  const c = net.connect(sock, () => c.write(JSON.stringify({ token, host: attrs.host, protocol: attrs.protocol }) + '\\n'));
  let buf = '';
  c.on('data', (d) => (buf += d));
  c.on('end', () => {
    try {
      const r = JSON.parse(buf);
      if (r.username && r.password) process.stdout.write('username=' + r.username + '\\npassword=' + r.password + '\\n');
    } catch { /* deny */ }
    process.exit(0);
  });
  c.on('error', () => process.exit(0));
});
`;
  writeFileSync(CREDENTIAL_SCRIPT, script, 'utf8');
  chmodSync(CREDENTIAL_SCRIPT, 0o755);
}

export class Broker {
  private server?: net.Server;
  private byToken = new Map<string, string>(); // brokerToken -> terminalId
  // Ephemeral land-push tokens: an identity-scoped token minted by acquireDaemonPush for the Tower's own
  // `git push` in land() PR mode. Maps straight to an identityId (there is no owning terminal). The
  // landtok-* file name never collides with a per-terminal brokertok-<terminalId> file, so load() never
  // resurrects one.
  private byTokenIdentity = new Map<string, string>(); // landPushToken -> identityId

  constructor(
    private store: Store,
    private accounts: Accounts,
  ) {}

  private tokenFileFor(terminalId: string): string {
    return join(paths.secrets, `brokertok-${terminalId}`);
  }
  tokenFile(terminalId: string): string {
    return this.tokenFileFor(terminalId);
  }

  /**
   * Re-register per-terminal tokens from their on-disk 0600 files at startup. A
   * terminal's tmux session (and its already-injected TOWER_BROKER_TOKEN_FILE) survive
   * a Tower restart, so the token the agent still presents must resolve — otherwise a
   * post-restart `git push` gets no credential and hangs. Must be called on startup.
   */
  load(terminals: Terminal[]): void {
    for (const t of terminals) {
      if (t.state === 'killed') continue;
      const file = this.tokenFileFor(t.id);
      try {
        if (!existsSync(file)) continue;
        const tok = readFileSync(file, 'utf8').trim();
        if (tok) this.byToken.set(tok, t.id);
      } catch {
        /* unreadable token file — skip */
      }
    }
  }

  /** Mint a per-terminal broker token (0600 file) for a terminal that has an identity. */
  ensure(terminalId: string): string {
    const tok = makeToken();
    writeFileSync(this.tokenFileFor(terminalId), tok, { mode: 0o600 });
    this.byToken.set(tok, terminalId);
    return tok;
  }

  forget(terminalId: string): void {
    for (const [tok, id] of this.byToken) if (id === terminalId) this.byToken.delete(tok);
    try {
      if (existsSync(this.tokenFileFor(terminalId))) rmSync(this.tokenFileFor(terminalId));
    } catch {
      /* ignore */
    }
  }

  /**
   * Mint an ephemeral, identity-scoped push credential for the Tower's OWN `git push` (land() PR mode).
   * Returns a git env override + a release() the caller MUST call (finally) to revoke it, or undefined
   * when no credential can be served — the caller then pushes with ambient daemon credentials (FAIL-OPEN,
   * byte-identical to the pre-broker behavior). The env resets any prior credential.helper (the daemon
   * runs with the operator's global ~/.gitconfig, whose helper could otherwise answer first with the
   * wrong credential) and points git at the broker's helper; the real PAT is served by the socket at push
   * time, never placed in the env. identityId is `string | undefined` (the caller passes
   * `term.identityId ?? project.defaultIdentityId` straight in); a falsy or credential-less identity → undefined.
   */
  acquireDaemonPush(identityId: string | undefined): { env: Record<string, string>; release: () => void } | undefined {
    if (!identityId) return undefined;
    const identity = this.accounts.getIdentity(identityId);
    if (!identity || !identity.hasCredential) return undefined;
    const tok = makeToken();
    const file = join(paths.secrets, `landtok-${shortId()}`);
    writeFileSync(file, tok, { mode: 0o600 });
    this.byTokenIdentity.set(tok, identity.id);
    const env: Record<string, string> = {
      TOWER_BROKER_SOCK: BROKER_SOCK,
      TOWER_BROKER_TOKEN_FILE: file,
      // Two entries: reset (empty value) then the broker helper — so the operator's global credential.helper
      // can never answer first for the daemon's own push.
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: CREDENTIAL_SCRIPT,
    };
    const release = (): void => {
      this.byTokenIdentity.delete(tok);
      try {
        if (existsSync(file)) rmSync(file);
      } catch {
        /* ignore */
      }
    };
    return { env, release };
  }

  start(): void {
    try {
      if (existsSync(BROKER_SOCK)) rmSync(BROKER_SOCK);
    } catch {
      /* ignore */
    }
    // Sweep stale ephemeral land-push token files: landtok-* are created per land() and removed on
    // release, so any left on disk are from a crash mid-land. The byTokenIdentity map is empty after a
    // restart, so a leftover file could never resolve a grant anyway — remove it rather than leave a
    // token artifact behind. (Per-terminal brokertok-* files are deliberately NOT swept — load()
    // re-registers them for sessions that survived the restart.)
    try {
      for (const name of readdirSync(paths.secrets)) {
        if (name.startsWith('landtok-')) {
          try {
            rmSync(join(paths.secrets, name));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* secrets dir missing — nothing to sweep */
    }
    this.server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        // Cap the pre-newline buffer: a request is a single short JSON line. Without this,
        // an agent writing a newline-free stream would grow buf until the Tower heap-
        // exhausts (control-plane DoS) — the file is same-UID reachable in M1–M3.
        if (buf.length > 64 * 1024) {
          sock.destroy();
          return;
        }
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        // A malformed request must never crash the Tower process (control-plane DoS).
        try {
          this.handle(line, sock);
        } catch {
          try {
            sock.end(JSON.stringify({ error: 'bad request' }));
          } catch {
            sock.destroy();
          }
        }
      });
      sock.on('error', () => sock.destroy());
    });
    this.server.listen(BROKER_SOCK, () => {
      try {
        chmodSync(BROKER_SOCK, 0o600);
      } catch {
        /* ignore */
      }
    });
  }

  private handle(line: string, sock: net.Socket): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      sock.end(JSON.stringify({ error: 'bad request' }));
      return;
    }
    // JSON.parse('null') / a number / a string all parse WITHOUT throwing; only a real
    // object can carry {token, host}. Anything else (esp. `null`) would NPE on req.host.
    if (parsed === null || typeof parsed !== 'object') {
      sock.end(JSON.stringify({ error: 'bad request' }));
      return;
    }
    const req = parsed as { token?: string; host?: string; protocol?: string };
    // Refuse to release the PAT over cleartext: git presents `protocol` per request, and
    // an agent that sets http_proxy could otherwise coax git into sending the PAT (in the
    // Authorization header) over http:// to a proxy while the host still reads github.com.
    // Require https so the credential only ever travels TLS-encrypted.
    if (req.protocol !== 'https') {
      audit('broker.deny', { terminalId: req.token ? this.byToken.get(req.token) : undefined, host: req.host, protocol: req.protocol, reason: 'protocol-not-https' });
      sock.end(JSON.stringify({ error: 'protocol not allowed' }));
      return;
    }
    // Refuse to hand a GitHub PAT to any non-GitHub host (exfiltration guard).
    if (!isAllowedHost(req.host)) {
      audit('broker.deny', { terminalId: req.token ? this.byToken.get(req.token) : undefined, host: req.host, reason: 'host-not-allowed' });
      sock.end(JSON.stringify({ error: 'host not allowed' }));
      return;
    }
    // Resolve the caller AFTER the protocol + host boundary checks above (never before — those are the
    // authorization boundary). A per-terminal token maps to a terminal → its bound identity; an ephemeral
    // land-push token (landtok-*) maps straight to an identity with no owning terminal.
    const terminalId = req.token ? this.byToken.get(req.token) : undefined;
    const term = terminalId ? this.store.getTerminal(terminalId) : undefined;
    const identityId = term?.identityId ?? (req.token ? this.byTokenIdentity.get(req.token) : undefined);
    const identity = identityId ? this.accounts.getIdentity(identityId) : undefined;
    const cred = identity ? this.accounts.readCredential(identity.id) : null;
    if (!identity || !cred) {
      sock.end(JSON.stringify({ error: 'no credential' }));
      return;
    }
    // daemon:true marks a land-push grant (no owning terminal — the Tower's own push) vs a per-terminal
    // agent push, so the audit trail distinguishes them.
    audit('broker.grant', { terminalId, identityId: identity.id, host: req.host, daemon: terminalId === undefined });
    // GitHub HTTPS accepts a PAT as the password with any username.
    sock.end(JSON.stringify({ username: 'x-access-token', password: cred }));
  }

  stop(): void {
    this.server?.close();
    try {
      if (existsSync(BROKER_SOCK)) rmSync(BROKER_SOCK);
    } catch {
      /* ignore */
    }
  }
}
