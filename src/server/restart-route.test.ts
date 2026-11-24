// SPEC-RESTART §4 — POST /api/terminals/:id/restart, driven against a REAL Tower over a process
// boundary (the autoaccept-route pattern — the token gate and the route wiring live in server.ts,
// so an in-process replica would guard nothing):
//   - no session token → 401 (the route is session-token gated like every terminal route);
//   - unknown terminal → 404;
//   - a 'killed' record → 409 with a clear message (restartTerminal's guard surfaced);
//   - success → 200 {ok:true}, the pane process is NEW (fresh pid on the SAME socket), the record
//     re-latches 'working', and `terminal.restart` lands in the scratch home's audit log. The
//     seeded terminal is bound to no loop, so this is also the plain-terminal case: the loop hook
//     is a no-op and nothing else changes.
//
// The pre-seeded live pane runs on a NON-`ct-` socket so the operator's real Tower (which lists
// `ct-*` sockets) never even sees it; the scratch Tower probes it by name off the record and keeps
// it (alive, not pane-dead, state not 'starting'). A scratch CT_HOME on a scratch port. Self-skips
// when tmux is unavailable or the Tower is just slow to boot; a DEAD child Tower or one that binds
// without serving fails loudly (a stolen port lands as a dead child).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { freePort, spawnTower } from './tower-fixture.js';

const pexec = promisify(execFile);

const home = mkdtempSync(join(tmpdir(), 'ct-restart-route-'));
const PORT = await freePort();
process.env.CT_HOME = home;
process.env.CT_PORT = String(PORT);

const SOCK = `rtroute-${process.pid}`; // NOT ct-* : no reconciler (ours or the operator's) lists it
const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);
const killScratch = async (): Promise<void> => {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
};
const panePid = async (): Promise<string> =>
  (await pexec('tmux', ['-L', SOCK, 'display-message', '-p', '-t', 'main', '#{pane_pid}'])).stdout.trim();

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
        "sh -c 'echo route-gen; sleep 600'"], { timeout: 10_000 });
      await pexec('tmux', ['-L', SOCK, 'set-option', '-t', 'main', 'remain-on-exit', 'on']);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] scratch tmux attempt ${attempt} hit a transient server-startup failure under load; retrying`);
    }
  }
}

// The live pane must exist BEFORE the Tower boots, or the startup reconcile vanishes the record
// (session gone → 'killed') and the success case would test nothing.
if (haveTmux) {
  await spawnLiveScratch();
}

const now = new Date().toISOString();
mkdirSync(join(home, 'config'), { recursive: true });
const write = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));
write('projects.json', [{ id: 'pr', name: 'pr', repoPath: home, scaffoldMode: 'zero-footprint', createdAt: now }]);
write('terminals.json', [
  { id: 'trt', projectId: 'pr', title: 'live pane', provider: 'claude-code', tmuxSocket: SOCK, cwd: home, command: ['sh'], state: 'idle', createdAt: now },
  { id: 'tkd', projectId: 'pr', title: 'dead record', provider: 'claude-code', tmuxSocket: `${SOCK}-x`, cwd: home, command: ['sh'], state: 'killed', createdAt: now },
]);

const base = `http://127.0.0.1:${PORT}`;

// Spawn + identity-gated readiness live in tower-fixture.ts: "ready" means OUR Tower (the startup
// line carrying THIS file's CT_HOME) answered /api/session. A DEAD child (how a stolen port lands)
// or a bound-but-unresponsive Tower throws loudly; only an alive-but-slow boot yields a skip.
const tower = await spawnTower(home, PORT);
const token = tower.sessionToken;
const skip = !haveTmux ? 'tmux is not installed' : tower.skip ?? false;

const restart = (id: string, withToken = true) =>
  fetch(`${base}/api/terminals/${id}/restart`, {
    method: 'POST',
    headers: withToken ? { 'X-Tower-Token': token } : {},
  });
const errOf = async (r: Response): Promise<string> => ((await r.json().catch(() => ({}))) as { error?: string }).error ?? '';
async function terminals(): Promise<Record<string, unknown>[]> {
  return (await (await fetch(`${base}/api/terminals`, { headers: { 'X-Tower-Token': token } })).json()) as Record<string, unknown>[];
}

test('restart route — token gate, 404, 409', { skip }, async () => {
  assert.equal((await restart('trt', false)).status, 401, 'no session token → 401 (the route is guarded)');
  assert.equal((await restart('nope')).status, 404, 'unknown terminal → 404');
  const killed = await restart('tkd');
  assert.equal(killed.status, 409, 'a killed record → 409, never a silent respawn attempt');
  assert.match(await errOf(killed), /killed/);
});

test('restart route — success respawns in place, re-latches working, audits', { skip }, async () => {
  const pid1 = await panePid();
  const r = await restart('trt');
  assert.equal(r.status, 200);
  // The seeded terminal carries no sessionId (a pre-wave record), so the bare-respawn path runs and
  // `resumed` is false — the route still surfaces the field on every response, never just on a resume.
  assert.deepEqual(await r.json(), { ok: true, resumed: false });

  const pid2 = await panePid();
  assert.notEqual(pid2, pid1, 'the pane process is new — the respawn really happened');
  assert.equal(
    (await terminals()).find((t) => t.id === 'trt')?.state, 'working',
    'the record re-latched working (create-time stamp mirrored)',
  );
  const auditFile = join(home, 'audit.log');
  assert.ok(existsSync(auditFile), 'the scratch Tower wrote an audit log');
  const line = readFileSync(auditFile, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((e) => e.action === 'terminal.restart');
  assert.ok(line, 'terminal.restart was audited');
  assert.equal(line?.terminalId, 'trt');
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
