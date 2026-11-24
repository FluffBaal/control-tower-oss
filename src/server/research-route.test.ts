// SPEC-RESEARCH W9 §2 — the submit route's OWNERSHIP CHAIN, driven against a real Tower.
//
// This is the security-relevant half of the wave and a typecheck says nothing about it. What has to
// hold: ownership is derived server-side (token → terminal → its newest LIVE mission loop → that
// loop's sortie) and never read from the body; only a sortie carrying the research marker may submit;
// a loop that has gone terminal may not (⟦DEC-4⟧); and EVERY derivation miss returns one
// byte-identical 404, so the route can never be used to enumerate other missions' sorties.
//
// Method: a scratch CT_HOME on a scratch port, seeded config files, and REAL tmux sessions for the
// seeded terminals — without a live session the boot reconciler vanishes them and forgets their hook
// tokens, so the fixture has to be honest about that. The operator's Tower and ~/.ct are untouched.
// Self-skips when tmux is unavailable or the scratch Tower is just slow to boot.

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

const home = mkdtempSync(join(tmpdir(), 'ct-research-route-'));
// Per-run socket suffix: two concurrent runs of this file (a watch loop, or a parallel CI shard)
// would otherwise fight over one set of ct- sockets.
const RUN = home.slice(-6).replace(/[^a-zA-Z0-9]/g, '');
const PORT = await freePort();
process.env.CT_HOME = home;
process.env.CT_PORT = String(PORT);

const now = new Date().toISOString();
const SOCKETS: string[] = [];
let server: ChildProcess | undefined;
let skip: string | false = haveTmux ? false : 'tmux is not installed';

/** A terminal record + a REAL tmux session behind it, so the boot reconciler adopts rather than
 *  vanishes it (a vanish forgets the hook token and every request would then 401). */
function terminal(id: string, token: string) {
  const socket = `ct-${id}${RUN}`;
  SOCKETS.push(socket);
  return {
    id, projectId: 'p1', title: id, provider: 'codex', tmuxSocket: socket,
    cwd: home, command: ['sleep', '600'], state: 'idle', hookToken: token, createdAt: now,
  };
}
function loop(id: string, terminalId: string, missionId: string, sortieId: string, status: string) {
  return {
    id, projectId: 'p1', name: id, task: 't', provider: 'codex', gatePolicy: 'never',
    maxIterations: 4, status, iteration: 1, iterations: [{ n: 1, verdict: 'pending', startedAt: now }],
    terminalId, missionId, sortieId, baseBranch: 'main', createdAt: now, updatedAt: now,
  };
}
function mission(id: string, sorties: Record<string, unknown>[]) {
  return {
    id, projectId: 'p1', name: id, goal: 'g', provider: 'codex', advance: 'gate',
    maxIterationsPerSortie: 4, concurrency: 1,
    phases: [{ id: `${id}-ph`, name: 'research', round: 2, sorties }],
    activePhase: 0, status: 'running', createdAt: now, updatedAt: now,
  };
}

if (haveTmux) {
  mkdirSync(join(home, 'config'), { recursive: true });
  const terminals = [
    terminal('tres', 'tok-research'),   // a research sortie, live loop        → may submit
    terminal('tbuild', 'tok-build'),    // a plain build sortie, live loop     → 404
    terminal('tnoloop', 'tok-noloop'),  // no loop at all                      → 404
    terminal('tdead', 'tok-dead'),      // research sortie, TERMINAL loop      → 404 (⟦DEC-4⟧)
    terminal('tother', 'tok-other'),    // another MISSION's research sortie   → its own only
    terminal('tretry', 'tok-retry'),    // a RETRIED research sortie           → the old finding is stale
  ];
  for (const socket of SOCKETS) {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); // nothing to kill is fine
    // …but a FAILED seed is not. Without the session the boot reconciler vanishes that terminal and
    // forgets its hook token, so the whole fixture reports 401s that read exactly like an ownership
    // regression. A fixture must never be able to impersonate the defect it is testing for.
    const made = spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'main', 'sleep 600']);
    if (made.error || made.status !== 0) {
      const why = made.error?.message ?? made.stderr?.toString().trim() ?? `exit ${String(made.status)}`;
      throw new Error(`could not seed the tmux session for ${socket}: ${why}`);
    }
  }
  const write = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));
  write('projects.json', [{ id: 'p1', name: 'p', repoPath: home, scaffoldMode: 'zero-footprint', createdAt: now }]);
  write('terminals.json', terminals);
  write('loops.json', [
    loop('l1', 'tres', 'm1', 's-research', 'running'),
    loop('l2', 'tbuild', 'm1', 's-build', 'running'),
    loop('l4', 'tdead', 'm1', 's-research', 'done'), // terminal status — the DEC-4 case
    loop('l3', 'tother', 'm2', 's-other', 'running'),
    loop('l5', 'tretry', 'm3', 's-retried', 'running'),
  ]);
  write('missions.json', [
    mission('m1', [
      { id: 's-research', name: 'research', task: 'find out', status: 'active', loopId: 'l1', researchSortie: true },
      { id: 's-build', name: 'build', task: 'build it', status: 'active', loopId: 'l2' },
    ]),
    mission('m2', [{ id: 's-other', name: 'research', task: 'other', status: 'active', loopId: 'l3', researchSortie: true }]),
    // Retried at 2026-06-01; the finding seeded below is from 2026-05-01, i.e. the discarded run's.
    mission('m3', [{
      id: 's-retried', name: 'research', task: 'again', status: 'active', loopId: 'l5',
      researchSortie: true, researchRetryAt: '2026-06-01T00:00:00.000Z',
    }]),
  ]);
  // The PREVIOUS run's finding, still on disk exactly as a retry leaves it.
  write('research.json', [{
    id: 'oldrec', missionId: 'm3', sortieId: 's-retried', topic: 'stale',
    summary: 'the discarded run', submittedAt: '2026-05-01T00:00:00.000Z',
  }]);
  // The Tower runs as a CHILD PROCESS, not an in-process import. Importing it here would leave a
  // listening server and live timers in the TEST process, which then never exits: the file hung the
  // runner for two minutes when it did that. Every workaround for that hang is worse — forcing an
  // exit from `after()` reports a RED file as green (`process.exitCode` is undefined there, verified
  // on node v22.14.0, and still undefined a tick later), and `--test-force-exit` on the runner
  // silently TRUNCATES slower files (it cut submit-verify from 48 tests to 33). A child process has
  // none of those problems, and it drives the Tower across a real process boundary the way a client
  // does.
  // Spawn + readiness live in tower-fixture.ts. "Ready" there means OUR Tower answered, not that
  // something did: the startup line carrying THIS file's CT_HOME, then /api/session — a bounded
  // poll, since a cold run (fresh clone, empty tsx cache, loaded CI box) can outrun any constant
  // sleep. A stranger already on the released port (a sibling file's Tower under runner
  // parallelism) is a loud fixture error — a poll that adopted it would run every ownership
  // assertion against it, and the byte-identical-404 case would go GREEN against anyone who 404s.
  const tower = await spawnTower(home, PORT);
  server = tower.server;
  if (tower.skip) skip = tower.skip;
}

const base = `http://127.0.0.1:${PORT}`;
type Res = { status: number; text: string; body: Record<string, unknown> };
async function call(method: 'GET' | 'POST', token: string | undefined, payload?: unknown): Promise<Res> {
  const res = await fetch(`${base}/api/agent/research`, {
    method,
    headers: {
      ...(token ? { 'x-tower-terminal-token': token } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON body */ }
  return { status: res.status, text, body };
}

test('the research route derives ownership and refuses everything else', { skip }, async (t) => {
  await t.test('a research sortie may submit, and the ids are SERVER-derived', async () => {
    // The body deliberately tries to name a different mission and sortie. Honouring either would let
    // any terminal write into any mission's findings, so the attempt must be ignored outright.
    const summary = 'the service verifies JWTs at the edge';
    const res = await call('POST', 'tok-research', {
      topic: 'auth model',
      summary,
      missionId: 'm2', sortieId: 's-other', round: 99,
      citations: [{ ref: 'src/auth.ts', note: 'entry point' }],
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.summaryChars, summary.length);
    const { ResearchStore } = await import('./research.js');
    const stored = new ResearchStore().getFor('m1', 's-research');
    assert.ok(stored, 'the record landed under the DERIVED mission/sortie');
    assert.equal(stored!.round, 2, "round comes from the sortie's phase, not the body's 99");
    assert.equal(new ResearchStore().getFor('m2', 's-other'), undefined, 'the body could not redirect the write');
  });

  await t.test('GET returns the caller’s own finding only', async () => {
    const mine = await call('GET', 'tok-research');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.submitted, true);
    assert.equal(mine.body.topic, 'auth model');
    // The other mission's researcher has submitted nothing, and must not see m1's finding.
    const theirs = await call('GET', 'tok-other');
    assert.equal(theirs.status, 200);
    assert.equal(theirs.body.submitted, false, 'no cross-mission read');
    assert.equal(theirs.body.topic, undefined);
  });

  await t.test('a RETRIED sortie reads as NOT submitted while only the old finding exists', async () => {
    // This is the half that keeps the AGENT honest. `towerctl research check` reads `submitted`, so
    // if the previous run's finding answered here the check would pass on the retry's first
    // iteration — actively steering the new researcher away from ever submitting, after which the
    // sortie lands on the finding the operator explicitly discarded.
    const before = await call('GET', 'tok-retry');
    assert.equal(before.status, 200);
    assert.equal(before.body.submitted, false, 'the stale finding must not satisfy the check');
    assert.equal(before.body.topic, undefined);

    // …and once the retried researcher actually submits, the check goes green.
    const post = await call('POST', 'tok-retry', { topic: 'fresh', summary: 'the second run found more' });
    assert.equal(post.status, 200, post.text);
    const after = await call('GET', 'tok-retry');
    assert.equal(after.body.submitted, true);
    assert.equal(after.body.topic, 'fresh');
  });

  await t.test('an empty summary is refused with 400, and nothing is stored', async () => {
    const res = await call('POST', 'tok-other', { topic: 't', summary: '   ' });
    assert.equal(res.status, 400);
    const { ResearchStore } = await import('./research.js');
    assert.equal(new ResearchStore().getFor('m2', 's-other'), undefined);
  });

  await t.test('no token ⇒ 401, bogus token ⇒ 401 (never 404, never 500)', async () => {
    for (const token of [undefined, 'not-a-real-token']) {
      const post = await call('POST', token, { summary: 'x' });
      const get = await call('GET', token);
      assert.equal(post.status, 401, `POST ${String(token)}: ${post.text}`);
      assert.equal(get.status, 401, `GET ${String(token)}: ${get.text}`);
    }
  });

  await t.test('every derivation miss is 404 with a BYTE-IDENTICAL body', async () => {
    // The no-oracle rule: if these bodies differed, the route would report which of "wrong sortie",
    // "no live loop" and "not a research sortie" applied — i.e. it would answer questions about
    // missions the caller does not own.
    const unmarked = await call('POST', 'tok-build', { summary: 'x' });      // sortie lacks the marker
    const noLoop = await call('POST', 'tok-noloop', { summary: 'x' });       // terminal drives no loop
    const terminalLoop = await call('POST', 'tok-dead', { summary: 'x' });   // ⟦DEC-4⟧ the loop has gone terminal
    for (const [name, r] of [['unmarked', unmarked], ['noLoop', noLoop], ['terminalLoop', terminalLoop]] as const) {
      assert.equal(r.status, 404, `${name}: ${r.text}`);
    }
    assert.equal(unmarked.text, noLoop.text);
    assert.equal(noLoop.text, terminalLoop.text);
    // …and the same on the read side.
    const g1 = await call('GET', 'tok-build');
    const g2 = await call('GET', 'tok-noloop');
    const g3 = await call('GET', 'tok-dead');
    assert.equal(g1.status, 404);
    assert.equal(g1.text, g2.text);
    assert.equal(g2.text, g3.text);
  });

  await t.test('an unmarked sortie cannot submit even with a valid token', async () => {
    const { ResearchStore } = await import('./research.js');
    assert.equal(new ResearchStore().getFor('m1', 's-build'), undefined, 'no record for the build sortie');
  });

  await t.test('the integration twin: a submitted finding lets the sortie RESOLVE', async () => {
    // The unit layer pins no-finding ⇒ attention. This is its other half, and it runs against the
    // record the ROUTE actually wrote: with a finding present the same gate passes the sortie through.
    const { Store } = await import('./store.js');
    const { Missions } = await import('./missions.js');
    const { ResearchStore } = await import('./research.js');
    const store = new Store();
    const research = new ResearchStore(); // reads the file the route just wrote
    const missions = new Missions({
      store,
      loops: {
        get: () => ({ id: 'l1', status: 'stopped', noChangesToLand: true, branch: 'agent/research' }),
        list: () => [], create: async () => ({ id: 'l1', status: 'running' }), stop: () => {},
      },
      onUpdate: () => {}, research,
    } as never);
    const m = store.getMission('m1')!;
    const sortie = m.phases[0]!.sorties.find((s) => s.id === 's-research')!;
    const out = (missions as unknown as { reconcileSortie(m1: typeof m, s: typeof sortie): typeof sortie })
      .reconcileSortie(m, sortie);
    assert.notEqual(out.status, 'attention', out.note ?? '');
    assert.equal(out.status, 'landed', 'a submitted finding resolves the sortie');
  });
});

/** Reap the child Tower and every scratch resource. Runs on normal exit AND on a crash, so a failed
 *  assertion cannot leave a listening server or a tmux session behind. */
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
