// Control-plane authentication (SPEC D16 / §14). The Tower binds to loopback, but
// loopback is NOT an origin boundary: any web page the user (or an agent's browser)
// visits could otherwise drive the terminals via fetch()/WebSocket. So every
// protected endpoint enforces three checks:
//
//   1. Host header ∈ allowlist   — defeats DNS-rebinding (a rebound request
//      carries the attacker's Host, not ours).
//   2. Origin header, if present, ∈ allowlist — defeats cross-origin CSRF.
//   3. A per-session token (X-Tower-Token header for HTTP; the `attach` frame for
//      WebSocket, since browsers can't set WS headers).
//
// The token is fetched by the same-origin app from GET /api/session (Origin+Host
// gated, no token) — a cross-origin attacker's Origin is rejected there and it
// can't read the response body cross-origin anyway.
//
// Two tokens are minted (SPEC-ASSISTANT-CONTROL §5). sessionToken is the full
// control-plane credential the same-origin app holds. assistantToken is a
// distinct, strictly narrower credential handed to the onboard assistant's MCP
// server (written to mcpTokenFile in its place): it authenticates the same way
// but is honoured on ONLY the read-tool routes plus POST /api/assistant/proposals
// (ASSISTANT_ACCEPT below). Every other verb — mutations, terminal control, and
// POST /api/assistant/confirm — is refused for it: this token can read + propose but cannot
// execute. This is a browser/API capability boundary, not authentication
// of local OS users: a native caller can omit Origin and fetch /api/session. An assistant
// must therefore remain sandboxed without direct loopback access to enforce the human gate.

import type { IncomingMessage } from 'node:http';
import { token as makeToken } from './ids.js';

/** Use the matched Fastify route for authorization and response policy. For unmatched
 * requests or a generic static route, classify the requested path without its query. */
export function authRoutePath(rawUrl: string, routePattern?: string): string {
  return routePattern && routePattern !== '/*' ? routePattern : (rawUrl.split('?')[0] ?? rawUrl);
}

// The assistant token's entire HTTP surface, as (METHOD, exact route-PATTERN)
// tuples keyed `${METHOD} ${pattern}` (⟦DP-J7⟧). Matching is on the Fastify route
// PATTERN (e.g. '/api/memory/:id', from req.routeOptions.url) AND the method —
// never a req.url prefix, never a path alone: GET and POST share paths
// (/api/loops, /api/terminals, /api/profiles, /api/backlog, /api/projects), so a
// path-only match would silently grant every write on them. Adding a line here
// widens what the assistant can reach; this Set is the whole boundary.
const ASSISTANT_ACCEPT: ReadonlySet<string> = new Set([
  'GET /api/projects',
  'GET /api/terminals',
  'GET /api/loops',
  'GET /api/observability',
  'GET /api/security',
  // SPEC-CLI-UPDATE — installed built-in CLI versions; get_health merges it so Jarvis can tell whether a
  // provider CLI is out of date before proposing update_provider_cli. Read-only (spawns `<bin> --version`,
  // 10s-bounded, no-throw); mirrors observability/security above. The MUTATING POST /api/system/cli-update
  // stays OUT — a confirmed update reaches it only via the executor's session-token inject.
  'GET /api/system/cli-versions',
  'GET /api/attention',
  'GET /api/search',
  'GET /api/memory/:id',
  // SPEC-MEMORY — read-only entry list/search so the assistant can ground a proposal on the versioned
  // entries (status/provenance), not just the rendered view. Method+pattern keyed, read-only. The
  // MUTATING entry routes stay OUT — a confirmed memory change reaches them only via the executor's
  // session-token inject, never this scoped token.
  'GET /api/memory/:id/entries',
  'GET /api/terminals/:id/review',
  'GET /api/profiles',
  'GET /api/profiles/shared-login', // list_profiles adds whether each provider's shared login is signed in
  'GET /api/identities', // list_identities grounds create_project/set_project_github's defaultIdentityId
  'GET /api/providers',
  'GET /api/adapters', // list_providers merges builtins (/api/adapters) with customs (/api/providers)
  'GET /api/routing',
  'GET /api/workflows', // get_routing enumerates workflow bundles to ground set_project_workflow
  'GET /api/projects/:id/routing', // get_routing(projectId) reads a project's layered overlay
  'GET /api/projects/:id/bootstrap/preflight', // preview_repo_bootstrap grounds init_project_repo (read-only plan)
  'GET /api/backlog',
  // list_skills grounds set_skill_enabled / set_project_skills — READ-ONLY meta (no bodies). The MUTATING
  // /api/skills* and PUT /api/projects/:id/skills routes stay OUT: a confirmed proposal reaches them only
  // via the executor's session-token inject, never this scoped token (SPEC-SKILLS Phase 5).
  'GET /api/skills',
  'GET /api/skill-bundles',
  'GET /api/projects/:id/skills',
  'POST /api/assistant/proposals',
  // SPEC-SKILLS Phase 5b — the assistant's skill-draft pad: the ONE scoped WRITE beyond proposals.
  // Admissible because a draft is INERT (a separate store/file/type the materializer cannot import —
  // no code path from a draft to any agent filesystem except the promote route), CAPPED (64 KB body,
  // 50 total / 10 per conversation), SECRET-SCAN-REJECTED at save (secret-shaped text never persists
  // at all), AUDITED (skill.draft.save), and CONVERSATION-BOUND (the x-tower-conversation header,
  // required even of the session token). NOT added: the draft DELETE (the scoped token must never
  // destroy pad evidence — the pad stays append-honest) and POST /api/skills/promote-draft (a
  // confirmed promote reaches the library ONLY via the executor's session-token inject).
  'POST /api/assistant/skill-drafts',
  'GET /api/assistant/skill-drafts',
  'GET /api/assistant/skill-drafts/:id',
]);

/**
 * Per-route context for scoping the assistant token. Both values come from
 * Fastify in the onRequest hook: `method` from req.method, `routePattern` from
 * req.routeOptions.url (the matched ':id' pattern, NOT the concrete req.url).
 * The session token ignores this; only the assistant token is scoped by it.
 */
export interface RouteContext {
  method: string;
  routePattern?: string;
}

export class Auth {
  readonly sessionToken = makeToken();
  /**
   * Distinct, narrower credential for the onboard assistant's MCP server (§5).
   * server.ts writes THIS (not sessionToken) to mcpTokenFile; httpGuard honours
   * it only on ASSISTANT_ACCEPT. It is deliberately NOT accepted by verifyToken,
   * so it can never grant a WebSocket attach or the SSE event feed.
   */
  readonly assistantToken = makeToken();
  private readonly allowedHosts: Set<string>;
  private readonly allowedOrigins: Set<string>;

  constructor(port: number) {
    const hostNames = ['127.0.0.1', 'localhost', '[::1]', '::1'];
    this.allowedHosts = new Set(hostNames.map((h) => `${h}:${port}`));

    const origins = new Set<string>();
    for (const h of ['127.0.0.1', 'localhost']) origins.add(`http://${h}:${port}`);
    // Dev: the Vite dev server proxies /api, /ws, and /preview to us with `changeOrigin: false`
    // (vite.config.ts), so a proxied request arrives carrying the dev server's OWN Host header
    // (localhost:5173), not ours. The dev web port must therefore join the HOST allowlist as well as
    // the origin allowlist — otherwise hostOk 421s every proxied request before originOk ever runs.
    // Gated to non-production; prod (NODE_ENV=production) admits the Tower port only.
    if (process.env.NODE_ENV !== 'production') {
      const webPort = process.env.CT_WEB_PORT ?? '5173';
      for (const h of ['127.0.0.1', 'localhost']) {
        origins.add(`http://${h}:${webPort}`);
        this.allowedHosts.add(`${h}:${webPort}`);
      }
    }
    for (const extra of (process.env.CT_ALLOWED_ORIGINS ?? '').split(',')) {
      const v = extra.trim();
      // Never allowlist the literal 'null' (SPEC-FILES §3): a sandboxed preview
      // document's requests carry the STRING Origin 'null', and originOk rejecting it is a
      // load-bearing layer of the preview escape defense — a config typo here must not be
      // able to collapse it.
      if (v && v !== 'null') origins.add(v);
    }
    this.allowedOrigins = origins;
  }

  /**
   * True once the assistant token is a credential distinct from the session
   * token (always, after §5 minted them separately). The integrator gates
   * POST /api/assistant/confirm registration on this: the confirm route must not
   * mount while mcpTokenFile could still hold the full session token (⟦DP-J8⟧),
   * or the scoped MCP channel could directly self-confirm. Direct loopback access remains
   * outside this capability boundary and must be blocked by the assistant's sandbox.
   */
  get scopedTokenActive(): boolean {
    return this.assistantToken !== this.sessionToken;
  }

  /**
   * The allowlisted app origins, for contexts that must name them explicitly — the preview
   * CSP's frame-ancestors (SPEC-FILES §4): only the Tower app itself may embed a preview.
   */
  get origins(): string[] {
    return [...this.allowedOrigins];
  }

  /**
   * The allowlisted Host:port values httpGuard admits (incl. the IPv6 loopback variants). The
   * preview CSP's host-source gate (SPEC-FILES §4) must admit exactly these — deriving it from
   * `origins` instead would omit [::1]:port and blank a preview served over the IPv6 literal.
   */
  get hosts(): string[] {
    return [...this.allowedHosts];
  }

  private hostOk(req: IncomingMessage): boolean {
    const host = req.headers.host;
    return !!host && this.allowedHosts.has(host);
  }

  private originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    // No Origin (same-origin GET, curl) is allowed here; protected routes still
    // require the token. A *present* Origin must be in the allowlist.
    if (origin === undefined) return true;
    return this.allowedOrigins.has(origin);
  }

  /**
   * Guard for HTTP. requireToken=false is used only for GET /api/session.
   *
   * `ctx` carries the resolved route (method + Fastify route pattern) so the
   * assistant token can be scoped — pass it from the onRequest hook. When the
   * presented X-Tower-Token is the session token, access is full and ctx is
   * ignored. When it is the assistant token, access is granted ONLY for an
   * ASSISTANT_ACCEPT (method, pattern) tuple; a missing/unresolved pattern fails
   * closed. Neither token → bad token.
   */
  httpGuard(
    req: IncomingMessage,
    requireToken: boolean,
    ctx?: RouteContext,
  ): { ok: true } | { ok: false; code: number; reason: string } {
    if (!this.hostOk(req)) return { ok: false, code: 421, reason: 'bad host' };
    if (!this.originOk(req)) return { ok: false, code: 403, reason: 'bad origin' };
    if (requireToken) {
      const t = req.headers['x-tower-token'];
      if (typeof t !== 'string') return { ok: false, code: 401, reason: 'bad token' };
      // Compare against BOTH tokens with no short-circuit, so total time does not
      // reveal which (if either) matched; the two are distinct so at most one does.
      const isSession = this.constTimeEq(t, this.sessionToken);
      const isAssistant = this.constTimeEq(t, this.assistantToken);
      if (isSession) return { ok: true };
      if (isAssistant) {
        // Fail closed: an assistant-token request whose route the hook could not
        // resolve is refused rather than allowed.
        if (!ctx?.routePattern) {
          return { ok: false, code: 403, reason: 'assistant token: route not permitted' };
        }
        const key = `${ctx.method.toUpperCase()} ${ctx.routePattern}`;
        if (ASSISTANT_ACCEPT.has(key)) return { ok: true };
        return { ok: false, code: 403, reason: 'assistant token: route not permitted' };
      }
      return { ok: false, code: 401, reason: 'bad token' };
    }
    return { ok: true };
  }

  /** Guard for the WebSocket upgrade (Host + Origin; token comes in the attach frame). */
  wsUpgradeOk(req: IncomingMessage): boolean {
    return this.hostOk(req) && this.originOk(req);
  }

  /**
   * Verify a token for the session-scoped transports (WS attach frame, SSE
   * stream). Accepts ONLY the session token — the assistant token must never
   * grant a terminal attach or the full event feed, so those callers stay
   * session-only and do not consult ASSISTANT_ACCEPT.
   */
  verifyToken(t: unknown): boolean {
    return typeof t === 'string' && this.constTimeEq(t, this.sessionToken);
  }

  /**
   * Length-checked constant-time compare. Both tokens are equal-length base64url,
   * so for any real token the length guard never varies and only the per-char XOR
   * timing remains — which is content-independent.
   */
  private constTimeEq(t: string, expected: string): boolean {
    if (t.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < t.length; i++) diff |= t.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  }
}
