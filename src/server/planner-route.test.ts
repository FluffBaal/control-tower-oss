// SPEC-PLANNER §6 — the planner consult routes, driven against a REAL Tower. This is the security-
// relevant half of the wave (the loop-LESS ownership chain, DEC-P3) and a typecheck says nothing about it.
// What has to hold: ownership is derived server-side (token → terminal → the UNIQUE live mission whose
// planner is this terminal) and never from the body; a builder terminal is NOT a planner; a foreign
// consultId cannot probe; and EVERY derivation/selection miss returns ONE byte-identical 404.
//
// Method mirrors research-route.test.ts with the two fixture lessons earned there: a PROBE-BOUND free
// port + a readiness check that asserts the responder is OURS (never adopting a stranger already on the
// port), and a CHECKED tmux seed (a failed session must fail the fixture loudly, not masquerade as a 401).
// The Tower runs as a CHILD PROCESS (an in-process import leaves a live server + timers that hang the
// runner). Self-skips when tmux is unavailable or the scratch Tower is just slow to boot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { freePort, spawnTower } from './tower-fixture.js';

const pexec = promisify(execFile);
const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);

const home = mkdtempSync(join(tmpdir(), 'ct-planner-route-'));
const RUN = home.slice(-6).replace(/[^a-zA-Z0-9]/g, '');
const PORT = await freePort();
process.env.CT_HOME = home;
process.env.CT_PORT = String(PORT);

const now = new Date().toISOString();
const SOCKETS: string[] = [];
let server: ChildProcess | undefined;
let skip: string | false = haveTmux ? false : 'tmux is not installed';

/** A terminal record + a REAL tmux session behind it, so the boot reconciler adopts rather than vanishes
 *  it (a vanish forgets the hook token and every request would then 401 — a fixture masquerading as the
 *  defect it tests for). */
function terminal(id: string, token: string, extra: Record<string, unknown> = {}) {
  const socket = `ct-${id}${RUN}`;
  SOCKETS.push(socket);
  return { id, projectId: 'p1', title: id, provider: 'codex', tmuxSocket: socket, cwd: home, command: ['sleep', '600'], state: 'idle', hookToken: token, createdAt: now, ...extra };
}
function loop(id: string, terminalId: string, missionId: string, sortieId: string, status: string) {
  return { id, projectId: 'p1', name: id, task: 't', provider: 'codex', gatePolicy: 'never', maxIterations: 4, status, iteration: 1, iterations: [{ n: 1, verdict: 'pending', startedAt: now }], terminalId, missionId, sortieId, baseBranch: 'main', createdAt: now, updatedAt: now };
}
function mission(id: string, planner: Record<string, unknown> | undefined, sorties: Record<string, unknown>[], loopRec?: Record<string, unknown>) {
  return {
    id, projectId: 'p1', name: id, goal: 'g', provider: 'codex', advance: 'auto',
    maxIterationsPerSortie: 4, concurrency: 1,
    phases: [{ id: `${id}-ph`, name: 'work', round: 1, sorties }],
    activePhase: 0, status: 'running', createdAt: now, updatedAt: now,
    ...(planner ? { planner } : {}),
    ...(loopRec ? { loop: loopRec } : {}),
  };
}

if (haveTmux) {
  mkdirSync(join(home, 'config'), { recursive: true });
  const terminals = [
    terminal('tplan', 'tok-plan', { purpose: 'planner' }),  // mp's LIVE planner (loop-less)
    terminal('tbuild', 'tok-build'),                        // a builder driving a loop (NOT a planner)
    terminal('tother', 'tok-other', { purpose: 'planner' }), // ANOTHER mission's planner
    terminal('tcorrupt', 'tok-corrupt', { purpose: 'planner' }), // mc's planner — a corrupt-timestamp consult
  ];
  for (const socket of SOCKETS) {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); // nothing to kill is fine
    const made = spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'main', 'sleep 600']);
    if (made.error || made.status !== 0) {
      throw new Error(`could not seed the tmux session for ${socket}: ${made.error?.message ?? made.stderr?.toString().trim() ?? `exit ${String(made.status)}`}`);
    }
  }
  const write = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));
  write('projects.json', [{ id: 'p1', name: 'p', repoPath: home, scaffoldMode: 'zero-footprint', createdAt: now }]);
  write('terminals.json', terminals);
  // Only the BUILDER drives a loop; the planner is deliberately loop-less (the DEC-P3 case).
  write('loops.json', [loop('lb', 'tbuild', 'mb', 's-build', 'running')]);
  write('missions.json', [
    // mp: a live planner mission whose escalating round carries the seeded consult id (so the boot
    // reconcile leaves it open instead of expiring it 'superseded').
    mission('mp', { terminalId: 'tplan', provider: 'codex', state: 'live', attachedAt: now },
      [{ id: 's-plan', name: 'work', task: 't', status: 'landed' }],
      { maxRounds: 4, mechanicalRounds: 2, sortieBudget: 24, round: 1, rounds: [{ n: 2, kind: 'escalating', appendedAt: now, consultId: 'cid-mp' }] }),
    mission('mb', undefined, [{ id: 's-build', name: 'build', task: 't', status: 'active', loopId: 'lb' }]),
    mission('mo', { terminalId: 'tother', provider: 'codex', state: 'live', attachedAt: now },
      [{ id: 's-other', name: 'work', task: 't', status: 'landed' }],
      { maxRounds: 4, mechanicalRounds: 2, sortieBudget: 24, round: 1, rounds: [{ n: 2, kind: 'escalating', appendedAt: now, consultId: 'cid-mo' }] }),
    // ms: the crash window where the round was appended (kind 'replanned', carrying consultId for
    // provenance) but resolve('applied') never ran, so cid-ms is still ANSWERED and no ESCALATING record
    // carries it. Boot reconcile must expire it 'superseded' — a consultId-only predicate would find the
    // replanned record and LEAVE it open forever.
    mission('ms', { terminalId: 'tplan2', provider: 'codex', state: 'live', attachedAt: now },
      [{ id: 's-sup', name: 'work', task: 't', status: 'landed' }],
      { maxRounds: 4, mechanicalRounds: 2, sortieBudget: 24, round: 2, rounds: [{ n: 2, kind: 'replanned', appendedAt: now, consultId: 'cid-ms' }] }),
    // mc: PAUSED (so the tick never consumes it) with an ANSWERED consult carrying a CORRUPT askedAt.
    // answered is left unchanged by the boot reanchor, so the corrupt timestamp reaches consultDeadline on
    // the pending route — which must OMIT the deadline, not 500 the whole route. Carried by an
    // escalating record so the boot reconcile leaves it open.
    { id: 'mc', projectId: 'p1', name: 'mc', goal: 'g', provider: 'codex', advance: 'auto',
      maxIterationsPerSortie: 4, concurrency: 1,
      phases: [{ id: 'mc-ph', name: 'work', round: 1, sorties: [{ id: 's-c', name: 'work', task: 't', status: 'landed' }] }],
      activePhase: 0, status: 'paused', createdAt: now, updatedAt: now,
      planner: { terminalId: 'tcorrupt', provider: 'codex', state: 'live', attachedAt: now },
      loop: { maxRounds: 4, mechanicalRounds: 2, sortieBudget: 24, round: 1, rounds: [{ n: 2, kind: 'escalating', appendedAt: now, consultId: 'cid-corrupt' }] } },
  ]);
  write('consults.json', [
    { id: 'cid-mp', missionId: 'mp', terminalId: 'tplan', kind: 'replan', question: 'replan mp', status: 'pending', askedAt: now },
    { id: 'cid-mo', missionId: 'mo', terminalId: 'tother', kind: 'replan', question: 'replan mo', status: 'pending', askedAt: now },
    { id: 'cid-ms', missionId: 'ms', terminalId: 'tplan2', kind: 'replan', question: 'replan ms', status: 'answered', askedAt: now, deliveredAt: now, answeredAt: now, answer: { phases: [] } },
    { id: 'cid-corrupt', missionId: 'mc', terminalId: 'tcorrupt', kind: 'replan', question: 'replan mc', status: 'answered', askedAt: 'not-a-timestamp', answeredAt: now, answer: { phases: [] } },
  ]);

  // Spawn + identity-gated readiness live in tower-fixture.ts: "ready" means OUR Tower — the startup
  // line carrying THIS file's CT_HOME — answered, so a stranger already on the released port (a
  // sibling file's Tower, whose token map never minted ours) is a loud fixture error, not nine 401s.
  const tower = await spawnTower(home, PORT);
  server = tower.server;
  if (tower.skip) skip = tower.skip;
}

const base = `http://127.0.0.1:${PORT}`;
type Res = { status: number; text: string; body: Record<string, unknown> };
async function call(method: 'GET' | 'POST', path: string, token: string | undefined, payload?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { 'x-tower-terminal-token': token } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, text, body };
}

test('the planner routes derive ownership loop-lessly and refuse everything else', { skip }, async (t) => {
  await t.test('pending returns the mission own consults + brief, and flips pending→delivered', async () => {
    const res = await call('GET', '/api/agent/planner/pending', 'tok-plan');
    assert.equal(res.status, 200, res.text);
    const consults = res.body.consults as { id: string; status: string }[];
    assert.equal(consults.length, 1);
    assert.equal(consults[0]!.id, 'cid-mp');
    assert.equal(consults[0]!.status, 'delivered', 'reading the pending route is a delivery event');
    assert.ok(res.body.brief, 'the self-brief is served on every pending call');
    // Persisted: a fresh store read confirms the delivery stamp landed.
    const { ConsultStore } = await import('./consults.js');
    assert.equal(new ConsultStore().getById('cid-mp')?.status, 'delivered');
  });

  await t.test('OWNERSHIP: a foreign consultId cannot probe — byte-identical 404 (while mp own consult is still open)', async () => {
    // Runs BEFORE the reply below closes cid-mp, so mp DOES have an answerable consult — this genuinely
    // exercises the consultId-not-among-mine branch, not the empty-answerable one. tok-plan is mp's
    // planner; naming mo's consult id must not confirm it exists.
    const foreign = await call('POST', '/api/agent/planner/reply', 'tok-plan', { consultId: 'cid-mo', answer: { phases: [{ name: 'x', sorties: [{ name: 's', task: 't' }] }] } });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error, 'no planner consult');
    // And mo's consult is untouched (the foreign reference wrote nothing).
    const { ConsultStore } = await import('./consults.js');
    assert.equal(new ConsultStore().getById('cid-mo')?.status, 'pending');
  });

  await t.test('a valid reply is recorded (pending|delivered → answered)', async () => {
    const res = await call('POST', '/api/agent/planner/reply', 'tok-plan', {
      answer: { phases: [{ name: 'more work', sorties: [{ name: 's', task: 'do it' }] }] },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.consultId, 'cid-mp');
    const { ConsultStore } = await import('./consults.js');
    const rec = new ConsultStore().getById('cid-mp');
    assert.equal(rec?.status, 'answered');
    assert.deepEqual((rec?.answer as { phases: unknown[] }).phases.length, 1);
  });

  await t.test('a garbage reply body is 400 and leaves the consult untouched (no attempt burned)', async () => {
    // cid-mp is already answered above; drive mo via its OWN token so this is purely about the shape gate.
    const res = await call('POST', '/api/agent/planner/reply', 'tok-other', { answer: { not: 'phases' } });
    assert.equal(res.status, 400, res.text);
    const { ConsultStore } = await import('./consults.js');
    assert.equal(new ConsultStore().getById('cid-mo')?.status, 'pending', 'a 400 does not touch the consult');
  });

  await t.test('OWNERSHIP: a builder token on the planner routes gets the byte-identical 404', async () => {
    const pend = await call('GET', '/api/agent/planner/pending', 'tok-build');
    const reply = await call('POST', '/api/agent/planner/reply', 'tok-build', { answer: { phases: [] } });
    assert.equal(pend.status, 404);
    assert.equal(reply.status, 404);
    assert.equal(pend.text, reply.text, 'a miss and a wrong-caller miss are byte-identical (no oracle)');
    assert.equal(pend.body.error, 'no planner consult');
  });

  await t.test('OWNERSHIP: the planner token on the REVIEW route gets that route own 404 (no loop)', async () => {
    // A planner is loop-less, so the W6 token→terminal→loop chain resolves nothing for it.
    const rev = await call('GET', '/api/agent/review', 'tok-plan');
    assert.equal(rev.status, 404);
    assert.equal(rev.body.error, 'no review sortie');
  });

  await t.test('BOOT RECONCILE: an answered consult in the append-but-not-resolved crash window is expired superseded', async () => {
    // The boot reconcile already ran when the Tower started with the seeded ms fixture. cid-ms is answered
    // with only a REPLANNED round carrying it — the tick will never resume it, so it must be closed. With
    // a `some(r => r.consultId === c.id)` predicate the replanned record would keep it open forever.
    const { ConsultStore } = await import('./consults.js');
    const rec = new ConsultStore().getById('cid-ms');
    assert.equal(rec?.status, 'expired', 'the crash-window consult was closed at boot');
    assert.equal(rec?.expireReason, 'superseded');
  });

  await t.test('a consult with a CORRUPT timestamp does not 500 the pending route (deadline omitted)', async () => {
    const res = await call('GET', '/api/agent/planner/pending', 'tok-corrupt');
    assert.equal(res.status, 200, `a corrupt timestamp must not 500 the route: ${res.text}`);
    const consults = res.body.consults as { id: string; status: string; deadline?: string }[];
    const corrupt = consults.find((c) => c.id === 'cid-corrupt');
    assert.ok(corrupt, 'the consult is still returned');
    assert.equal(corrupt!.deadline, undefined, 'the unparseable deadline is OMITTED, not thrown');
  });

  await t.test('no token ⇒ 401, bogus token ⇒ 401 (never 404, never 500)', async () => {
    assert.equal((await call('GET', '/api/agent/planner/pending', undefined)).status, 401);
    assert.equal((await call('GET', '/api/agent/planner/pending', 'not-a-real-token')).status, 401);
    assert.equal((await call('POST', '/api/agent/planner/reply', 'not-a-real-token', { answer: {} })).status, 401);
  });
});

/** Reap the child Tower and every scratch resource. Runs on normal exit AND on a crash. */
function cleanup(): void {
  server?.kill('SIGKILL');
  for (const socket of SOCKETS) {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`) : `/tmp/tmux-${uid}`;
    rmSync(join(dir, socket), { force: true });
  }
  rmSync(home, { recursive: true, force: true });
}
process.on('exit', cleanup);
