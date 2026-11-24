// Auth host/origin guard — the dev-proxy host allowlist (the Vite dev server proxies with
// changeOrigin:false, so the Tower must admit the dev web port's HOST, not just its origin), the
// production gate, the host-before-origin ordering, and the 'null'-origin preview-escape defense.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

const { Auth, authRoutePath } = await import('./auth.js');

type AuthEnv = { NODE_ENV?: string; CT_WEB_PORT?: string; CT_ALLOWED_ORIGINS?: string };
const ENV_KEYS = ['NODE_ENV', 'CT_WEB_PORT', 'CT_ALLOWED_ORIGINS'] as const;

/** Build an Auth under a chosen env, restoring EVERY managed key immediately after construction (the
 *  constructor reads process.env once, synchronously, at build time — so set-construct-restore has no
 *  await window and cannot leak to sibling tests). A key present with value undefined is DELETED, so a
 *  test can pin a var to its default (e.g. CT_WEB_PORT undefined ⇒ hermetic to an ambient CT_WEB_PORT). */
function mkAuth(port: number, env: AuthEnv) {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  for (const k of ENV_KEYS) {
    if (k in env) {
      const v = env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  try {
    return new Auth(port);
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const req = (headers: Record<string, string>): IncomingMessage =>
  ({ headers } as unknown as IncomingMessage);

test('session-token verification rejects malformed runtime values without throwing', () => {
  const auth = mkAuth(4870, { NODE_ENV: 'production' });
  for (const value of [undefined, null, 42, {}, [], false, '']) {
    assert.equal(auth.verifyToken(value), false);
  }
  assert.equal(auth.verifyToken(auth.sessionToken), true);
  assert.equal(auth.verifyToken(auth.assistantToken), false);
});

test('security policy uses the matched route and falls back to the path for static or unmatched requests', () => {
  const request = '/items/sample?sort=name';
  const route = '/items/:id';
  assert.equal(authRoutePath(request, route), route);
  assert.equal(authRoutePath(request, '/*'), '/items/sample');
  assert.equal(authRoutePath(request), '/items/sample');
});

test('dev: a proxied request carrying the dev web port Host is admitted (the 421 regression)', () => {
  const auth = mkAuth(4870, { NODE_ENV: undefined, CT_WEB_PORT: undefined }); // hermetic: force the 5173 default
  for (const h of ['localhost:5173', '127.0.0.1:5173']) {
    const g = auth.httpGuard(req({ host: h, origin: `http://${h.split(':')[0]}:5173` }), false);
    assert.deepEqual(g, { ok: true }, `dev must admit Host ${h}`);
  }
  // The Tower's own host is still admitted.
  assert.deepEqual(auth.httpGuard(req({ host: 'localhost:4870' }), false), { ok: true });
});

test('prod: the dev web port Host is rejected 421 — the gate holds', () => {
  const auth = mkAuth(4870, { NODE_ENV: 'production', CT_WEB_PORT: undefined });
  const g = auth.httpGuard(req({ host: 'localhost:5173', origin: 'http://localhost:5173' }), false);
  assert.deepEqual(g, { ok: false, code: 421, reason: 'bad host' });
  // The Tower port still works in prod.
  assert.deepEqual(auth.httpGuard(req({ host: 'localhost:4870' }), false), { ok: true });
});

test('host is checked BEFORE origin: a bad host wins over a bad origin (421, not 403)', () => {
  const auth = mkAuth(4870, { NODE_ENV: undefined, CT_WEB_PORT: undefined });
  // The DISTINGUISHING case: BOTH checks fail. Host-first ⇒ 421; an origin-first order would return
  // 403 here — so this assertion actually pins the ordering (a reorder in httpGuard fails it).
  const both = auth.httpGuard(req({ host: 'evil.example:5173', origin: 'http://evil.example' }), false);
  assert.deepEqual(both, { ok: false, code: 421, reason: 'bad host' });
  // Bad host + good origin is still 421 (host gate), and good host + bad origin is the 403 branch.
  assert.deepEqual(auth.httpGuard(req({ host: 'evil.example:5173', origin: 'http://localhost:5173' }), false),
    { ok: false, code: 421, reason: 'bad host' });
  assert.deepEqual(auth.httpGuard(req({ host: 'localhost:4870', origin: 'http://evil.example' }), false),
    { ok: false, code: 403, reason: 'bad origin' });
});

test("a CT_ALLOWED_ORIGINS='null' is stripped — the preview-escape defense actually runs", () => {
  // Exercise the `!== 'null'` filter: even when an operator (or a typo) puts the literal 'null' in the
  // allowlist env, a sandboxed preview document's Origin 'null' must still be rejected. Deleting the
  // filter in auth.ts would let this through — so this asserts the defense, not just an unconfigured absence.
  const auth = mkAuth(4870, { NODE_ENV: undefined, CT_WEB_PORT: undefined, CT_ALLOWED_ORIGINS: 'null' });
  const g = auth.httpGuard(req({ host: 'localhost:4870', origin: 'null' }), false);
  assert.deepEqual(g, { ok: false, code: 403, reason: 'bad origin' });
  // Control: a real (non-'null') entry in the same env var IS honored, so the filter is selective, not blanket.
  const auth2 = mkAuth(4870, { NODE_ENV: undefined, CT_WEB_PORT: undefined, CT_ALLOWED_ORIGINS: 'https://ok.example' });
  assert.deepEqual(auth2.httpGuard(req({ host: 'localhost:4870', origin: 'https://ok.example' }), false), { ok: true });
});

test('CT_WEB_PORT overrides the dev web port in the host allowlist', () => {
  const auth = mkAuth(4870, { NODE_ENV: undefined, CT_WEB_PORT: '6100' });
  assert.deepEqual(auth.httpGuard(req({ host: 'localhost:6100', origin: 'http://localhost:6100' }), false), { ok: true });
  assert.deepEqual(auth.httpGuard(req({ host: 'localhost:5173', origin: 'http://localhost:5173' }), false),
    { ok: false, code: 421, reason: 'bad host' });
});

test('the hosts getter reflects the dev/prod split (it feeds the preview CSP host-source)', () => {
  const dev = mkAuth(4870, { NODE_ENV: undefined, CT_WEB_PORT: undefined });
  assert.ok(dev.hosts.includes('localhost:5173'), 'dev hosts include the web port');
  assert.ok(dev.hosts.includes('localhost:4870'), 'dev hosts include the Tower port');
  const prod = mkAuth(4870, { NODE_ENV: 'production', CT_WEB_PORT: undefined });
  assert.ok(!prod.hosts.includes('localhost:5173'), 'prod hosts exclude the web port');
  assert.ok(prod.hosts.includes('localhost:4870'), 'prod hosts include the Tower port');
});

test('wsUpgradeOk shares the same host allowlist (dev web port admitted, prod rejected)', () => {
  const dev = mkAuth(4870, { NODE_ENV: undefined, CT_WEB_PORT: undefined });
  assert.equal(dev.wsUpgradeOk(req({ host: 'localhost:5173', origin: 'http://localhost:5173' })), true);
  const prod = mkAuth(4870, { NODE_ENV: 'production', CT_WEB_PORT: undefined });
  assert.equal(prod.wsUpgradeOk(req({ host: 'localhost:5173', origin: 'http://localhost:5173' })), false);
});
