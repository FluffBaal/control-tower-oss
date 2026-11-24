// SPEC-MEMORY — PUT /api/agent/memory over a REAL Tower: the legacy whole-file AGENT write has
// been hard-removed (Memory.write now only accepts the operator principal — see coordination.ts,
// and the one-release 410 deprecation stub is gone). The route no longer exists at all, so a PUT
// 404s regardless of token — the path stays in TOKEN_EXEMPT (shared, path-keyed) but that only
// governs the onRequest hook's token requirement, not routing; Fastify has no PUT handler left to
// dispatch to. GET /api/agent/memory is untouched and still serves the generated views.
//
// Method mirrors restart-route.test.ts / gate-route.test.ts: a scratch CT_HOME on a scratch port,
// a seeded terminal carrying a hook token, and a REAL tmux session behind it — without a live
// session the boot reconciler forgets the hook token and every call 401s regardless of the fix
// under test. Self-skips when tmux is unavailable or the scratch Tower is just slow to boot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { freePort, spawnTower } from './tower-fixture.js';

const pexec = promisify(execFile);
const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);

const home = mkdtempSync(join(tmpdir(), 'ct-mem-write-route-'));
const PORT = await freePort();
process.env.CT_HOME = home;
process.env.CT_PORT = String(PORT);

const SOCK = `memwrite-${process.pid}`; // NOT ct-* : no reconciler (ours or the operator's) lists it
const killScratch = async (): Promise<void> => {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
};

// STAGED retry, bounded and loud: under full-suite load tmux's own server startup can intermittently
// fail ("server exited unexpectedly" — the fresh server binds the socket, then dies) with no product
// interaction involved at all, so a re-stage here can never mask a product regression. Any other
// spawn failure still throws at once. Mirrors the established staged-retry shape used for the same
// transient elsewhere (e.g. reconciler.test.ts).
async function spawnLiveScratch(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      await pexec('tmux', ['-L', SOCK, 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '24',
        "sh -c 'echo memwrite-gen; sleep 600'"], { timeout: 10_000 });
      await pexec('tmux', ['-L', SOCK, 'set-option', '-t', 'main', 'remain-on-exit', 'on']);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] scratch tmux attempt ${attempt} hit a transient server-startup failure under load; retrying`);
    }
  }
}

// The live pane must exist BEFORE the Tower boots, or the startup reconcile forgets the hook
// token (session gone → 'killed') and the valid-token case below would test nothing.
if (haveTmux) {
  await spawnLiveScratch();
}

const now = new Date().toISOString();
const TOKEN = 'tok-memwrite';
mkdirSync(join(home, 'config'), { recursive: true });
const write = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));
write('projects.json', [{ id: 'pr', name: 'pr', repoPath: home, scaffoldMode: 'zero-footprint', createdAt: now }]);
write('terminals.json', [
  { id: 'tmw', projectId: 'pr', title: 'live pane', provider: 'claude-code', tmuxSocket: SOCK, cwd: home, command: ['sh'], state: 'idle', hookToken: TOKEN, createdAt: now },
]);

const base = `http://127.0.0.1:${PORT}`;

// Spawn + identity-gated readiness live in tower-fixture.ts (see restart-route.test.ts).
const tower = await spawnTower(home, PORT);
const skip = !haveTmux ? 'tmux is not installed' : tower.skip ?? false;

const put = (token?: string) =>
  fetch(`${base}/api/agent/memory`, {
    method: 'PUT',
    headers: {
      ...(token ? { 'x-tower-terminal-token': token } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: 'gotchas.md', content: 'whatever' }),
  });

const get = (token?: string) =>
  fetch(`${base}/api/agent/memory`, {
    headers: token ? { 'x-tower-terminal-token': token } : {},
  });

test('PUT /api/agent/memory — the legacy whole-file write is hard-removed: 404 regardless of token', { skip }, async () => {
  // The path is TOKEN_EXEMPT (shared with GET, path-keyed), so the onRequest hook never demands a
  // token here — but there is no PUT handler left to route to, so every case 404s the same way,
  // including a fully valid terminal token.
  const noToken = await put();
  assert.equal(noToken.status, 404, 'no token ⇒ 404 — the route is gone, not just unauthenticated');
  const badToken = await put('not-a-real-token');
  assert.equal(badToken.status, 404, 'a bogus token ⇒ 404 too — nothing to authenticate into');
  const validToken = await put(TOKEN);
  assert.equal(validToken.status, 404, 'a VALID terminal token still 404s — the PUT route no longer exists');
});

test('GET /api/agent/memory — survives the PUT removal and still serves the generated views', { skip }, async () => {
  const noToken = await get();
  assert.equal(noToken.status, 401, 'GET still requires a valid terminal token');

  const res = await get(TOKEN);
  assert.equal(res.status, 200, 'a valid terminal token still reaches the GET handler');
  const body = (await res.json()) as Record<string, string>;
  assert.ok(Object.keys(body).length > 0, 'GET returns the generated memory views');
});

test.after(async () => {
  try {
    tower.server?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  await killScratch();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`) : `/tmp/tmux-${uid}`;
  rmSync(join(dir, SOCK), { force: true });
  rmSync(home, { recursive: true, force: true });
});
