// SPEC-SKILLS-GATE — the gate attestation route's OWNERSHIP CHAIN, driven against a real Tower, plus
// the END-TO-END boundary proof: a green loop with a required gate parks at attention until evidence
// is recorded through the real route/CLI, then finishes done on resume. gates-store.test.ts pins the
// store and missions-completion.test.ts pins the evaluator; this is the half that keeps the LIVE
// routes honest.
//
// What has to hold on GET/POST /api/agent/gate:
//   - ownership is derived server-side (token → terminal → its newest loop carrying a mission+sortie
//     backref → that mission's frozen loop.requiredGates) and never read from the body — a body naming
//     a different mission/sortie cannot redirect the write;
//   - ANY sortie of a GATED mission may attest (there is no gate-marked sortie kind — deltas from the
//     review route are deliberate);
//   - EVERY derivation miss (no loop, mission gone, mission not gated) returns ONE byte-identical 404,
//     so the route is no ownership oracle;
//   - 400 on an unknown/missing gate id or a bad result; a resubmit REPLACES (fail overwrites pass);
//   - `towerctl gate check` exits 1 pre-submit and after a fail, 0 once every required gate passes.
//
// Method mirrors review-route.test.ts: a scratch CT_HOME on a scratch port, seeded config files, and
// REAL tmux sessions for the seeded terminals — without a live session the boot reconciler vanishes
// them and forgets their hook tokens. The operator's Tower and ~/.ct are untouched. Self-skips when
// tmux is unavailable or the scratch Tower is just slow to boot.

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

const home = mkdtempSync(join(tmpdir(), 'ct-gate-route-'));
// Per-run socket suffix: two concurrent runs of this file would otherwise fight over one socket set.
const RUN = home.slice(-6).replace(/[^a-zA-Z0-9]/g, '');
const PORT = await freePort();
process.env.CT_HOME = home;
process.env.CT_PORT = String(PORT);

const now = new Date().toISOString();
const SOCKETS: string[] = [];
let server: ChildProcess | undefined;
let sessionToken = '';
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
function loop(id: string, terminalId: string, missionId: string, sortieId: string) {
  return {
    id, projectId: 'p1', name: id, task: 't', provider: 'codex', gatePolicy: 'never',
    maxIterations: 4, status: 'running', iteration: 1, iterations: [{ n: 1, verdict: 'pending', startedAt: now }],
    terminalId, missionId, sortieId, baseBranch: 'main', createdAt: now, updatedAt: now,
  };
}
/** A loop-mission config with a frozen gate set, pinned to the seeded green run. */
function gatedLoop(requiredGates: string[]) {
  return {
    maxRounds: 2, mechanicalRounds: 0, sortieBudget: 8, round: 1,
    rounds: [{ n: 1, kind: 'authored', appendedAt: now, verifyRunId: 'run1' }],
    requiredGates,
  };
}

if (haveTmux) {
  mkdirSync(join(home, 'config'), { recursive: true });
  const terminals = [
    terminal('tgate', 'tok-gate'),     // sortie of a GATED mission        → may submit + read
    terminal('tplain', 'tok-plain'),   // sortie of an UN-gated mission    → 404
    terminal('tnoloop', 'tok-noloop'), // no loop at all                   → 404
    terminal('tghost', 'tok-ghost'),   // loop → a mission that is gone    → 404
    terminal('tgo', 'tok-go'),         // the end-to-end mission's sortie  → CLI submit path
  ];
  for (const socket of SOCKETS) {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); // nothing to kill is fine
    // A FAILED seed must throw: without the session the boot reconciler vanishes that terminal and the
    // fixture would report 401s that read exactly like an ownership regression (a fixture must never be
    // able to impersonate the defect it is testing for).
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
    loop('l1', 'tgate', 'mgate', 's-gate'),
    loop('l2', 'tplain', 'mplain', 's-plain'),
    loop('l3', 'tghost', 'ghost-mission', 's-ghost'),
    loop('l-go', 'tgo', 'mgo', 's-go'),
  ]);
  write('missions.json', [
    // The submit/read fixture: a RUNNING gated loop mission mid-phase (never reaches the boundary, so
    // the tick cannot interfere with the route assertions). Two required gates; baseSha grounds range.
    {
      id: 'mgate', projectId: 'p1', name: 'mgate', goal: 'g', provider: 'codex', advance: 'auto',
      maxIterationsPerSortie: 4, concurrency: 1, baseSha: 'basecafe01',
      phases: [{ id: 'mg-ph', name: 'build', stage: 'build', round: 2, sorties: [
        { id: 's-gate', name: 'build', task: 't', status: 'active', loopId: 'l1' },
      ] }],
      activePhase: 0, loop: gatedLoop(['g-a', 'g-b']), status: 'running', createdAt: now, updatedAt: now,
    },
    // An UN-gated loop mission — its sortie's derivation must miss (no frozen requiredGates).
    {
      id: 'mplain', projectId: 'p1', name: 'mplain', goal: 'g', provider: 'codex', advance: 'auto',
      maxIterationsPerSortie: 4, concurrency: 1,
      phases: [{ id: 'mp-ph', name: 'build', stage: 'build', sorties: [
        { id: 's-plain', name: 'build', task: 't', status: 'active', loopId: 'l2' },
      ] }],
      activePhase: 0, loop: { maxRounds: 2, mechanicalRounds: 0, sortieBudget: 8, round: 1, rounds: [{ n: 1, kind: 'authored', appendedAt: now }] },
      status: 'running', createdAt: now, updatedAt: now,
    },
    // END-TO-END: a gated loop mission AT the completion boundary over a GREEN pinned run. The tick
    // parks it at attention (no evidence); the CLI records a pass; resume finishes it done.
    {
      id: 'mgo', projectId: 'p1', name: 'mgo', goal: 'g', provider: 'codex', advance: 'auto',
      maxIterationsPerSortie: 4, concurrency: 1, baseSha: 'deadbeef01',
      phases: [
        { id: 'go-b', name: 'build', stage: 'build', round: 1, sorties: [
          { id: 's-go', name: 'build', task: 't', status: 'landed', loopId: 'l-go' },
        ] },
        { id: 'go-v', name: 'verify', stage: 'verify', round: 1, sorties: [
          { id: 'r-go', name: 'verify', task: 't', status: 'done' },
        ] },
      ],
      activePhase: 2, loop: gatedLoop(['gate-a']), status: 'running', createdAt: now, updatedAt: now,
    },
    // CONTROL: the same boundary shape with NO evidence ever — must park and STAY parked.
    {
      id: 'mstay', projectId: 'p1', name: 'mstay', goal: 'g', provider: 'codex', advance: 'auto',
      maxIterationsPerSortie: 4, concurrency: 1,
      phases: [
        { id: 'st-v', name: 'verify', stage: 'verify', round: 1, sorties: [
          { id: 'r-stay', name: 'verify', task: 't', status: 'done' },
        ] },
      ],
      activePhase: 1, loop: gatedLoop(['gate-a']), status: 'running', createdAt: now, updatedAt: now,
    },
  ]);
  // The GREEN pinned run both boundary missions resolve (raw meta.json — the TestKit contract).
  const runDir = join(home, 'testruns', 'run1');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    id: 'run1', terminalId: 'tgo', projectId: 'p1', port: 0, status: 'passed', runDir,
    startedAt: now, results: [], total: 3, failed: 0, kind: 'agent', repoPath: home,
  }, null, 2));

  // Spawn + identity-gated readiness live in tower-fixture.ts ("ready" = the startup line carrying
  // THIS file's CT_HOME, so a sibling Tower on the released port is a loud fixture error); the
  // session token it captures serves the mission status reads + resume below.
  const tower = await spawnTower(home, PORT);
  server = tower.server;
  sessionToken = tower.sessionToken;
  if (tower.skip) skip = tower.skip;
}

const base = `http://127.0.0.1:${PORT}`;
type Res = { status: number; text: string; body: Record<string, unknown> };
async function call(method: 'GET' | 'POST', token: string | undefined, payload?: unknown): Promise<Res> {
  const res = await fetch(`${base}/api/agent/gate`, {
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

async function missionRead(id: string): Promise<{ status?: string; stopReason?: string }> {
  const r = await fetch(`${base}/api/missions/${id}`, { headers: { 'X-Tower-Token': sessionToken } });
  if (!r.ok) return {};
  return (await r.json()) as { status?: string; stopReason?: string };
}
async function waitForStatus(id: string, want: string, ms: number): Promise<{ status?: string; stopReason?: string }> {
  const until = Date.now() + ms;
  let last: { status?: string; stopReason?: string } = {};
  while (Date.now() < until) {
    last = await missionRead(id);
    if (last.status === want) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

// The CLI under test, run exactly as a sortie would run it (per-terminal token via the env file).
const TOWERCTL = join(import.meta.dirname, '..', 'cli', 'towerctl.ts');
const goTokenFile = join(home, 'tok-go.txt');
if (haveTmux) writeFileSync(goTokenFile, 'tok-go\n');
function cli(...args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', TOWERCTL, ...args], {
    env: { ...process.env, TOWER_PORT: String(PORT), TOWER_HOOK_TOKEN_FILE: goTokenFile },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('the gate route derives ownership and refuses everything else', { skip }, async (t) => {
  await t.test('no token ⇒ 401, bogus token ⇒ 401 (never 404, never 500)', async () => {
    for (const token of [undefined, 'not-a-real-token']) {
      const post = await call('POST', token, { gate: 'g-a', result: 'pass' });
      const get = await call('GET', token);
      assert.equal(post.status, 401, `POST ${String(token)}: ${post.text}`);
      assert.equal(get.status, 401, `GET ${String(token)}: ${get.text}`);
    }
  });

  await t.test('every derivation miss is 404 with a BYTE-IDENTICAL body (no oracle)', async () => {
    // If these differed, the route would report which of "no owning loop", "mission gone" and "mission
    // not gated" applied — answering questions about missions the caller does not own. The un-gated
    // mission is the load-bearing case: it is adjacent to a real gated mission but must still 404.
    const noLoop = await call('POST', 'tok-noloop', { gate: 'g-a', result: 'pass' });
    const ghost = await call('POST', 'tok-ghost', { gate: 'g-a', result: 'pass' });
    const ungated = await call('POST', 'tok-plain', { gate: 'g-a', result: 'pass' });
    for (const [name, r] of [['noLoop', noLoop], ['ghost', ghost], ['ungated', ungated]] as const) {
      assert.equal(r.status, 404, `${name}: ${r.text}`);
    }
    assert.equal(noLoop.text, ghost.text, 'miss bodies are byte-identical (noLoop vs ghost)');
    assert.equal(noLoop.text, ungated.text, 'miss bodies are byte-identical (noLoop vs ungated)');
    const gets = await Promise.all([call('GET', 'tok-noloop'), call('GET', 'tok-ghost'), call('GET', 'tok-plain')]);
    for (const g of gets) assert.equal(g.status, 404);
    assert.ok(gets.every((g) => g.text === gets[0]!.text), 'GET miss bodies are byte-identical too');
  });

  await t.test('400 on a missing/unknown gate id and on a bad result — never a silent write', async () => {
    const missing = await call('POST', 'tok-gate', { result: 'pass' });
    assert.equal(missing.status, 400, missing.text);
    const unknown = await call('POST', 'tok-gate', { gate: 'not-frozen', result: 'pass' });
    assert.equal(unknown.status, 400, unknown.text);
    assert.match(String(unknown.body.error), /required gates/);
    const badResult = await call('POST', 'tok-gate', { gate: 'g-a', result: 'maybe' });
    assert.equal(badResult.status, 400, badResult.text);
    const noResult = await call('POST', 'tok-gate', { gate: 'g-a' });
    assert.equal(noResult.status, 400, noResult.text);
    // None of those wrote anything: the mission still reads fully unsubmitted.
    const get = await call('GET', 'tok-gate');
    assert.equal(get.status, 200, get.text);
    assert.deepEqual(get.body.gates, [{ id: 'g-a', submitted: false }, { id: 'g-b', submitted: false }]);
  });

  await t.test('an owned sortie submits and reads back; the ids are SERVER-derived', async () => {
    // The body deliberately names a DIFFERENT mission/sortie/round. The route reads only gate/result/
    // summary; honouring either id would let any terminal attest any mission's gates.
    const res = await call('POST', 'tok-gate', {
      missionId: 'mgo', sortieId: 'evil', round: 99, // the redirect attempt
      gate: 'g-a', result: 'pass', summary: 'ran clean',
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.gate, 'g-a');
    assert.equal(res.body.status, 'pass');

    const { GateEvidenceStore } = await import('./gates.js');
    const stored = new GateEvidenceStore().getFor('mgate', 'g-a');
    assert.ok(stored, 'the record landed under the DERIVED mission');
    assert.equal(stored!.sortieId, 's-gate', 'the sortie is the DERIVED one, not the body\'s');
    assert.equal(stored!.round, 2, "round comes from the sortie's phase, not the body's 99");
    assert.equal(stored!.range, 'basecafe01..HEAD', 'range is grounded on the mission base commit');
    assert.equal(stored!.summary, 'ran clean');
    assert.equal(new GateEvidenceStore().getFor('mgo', 'g-a'), undefined, 'the body could not redirect the write');

    const get = await call('GET', 'tok-gate');
    assert.equal(get.status, 200, get.text);
    assert.deepEqual(get.body.gates, [{ id: 'g-a', submitted: true, status: 'pass' }, { id: 'g-b', submitted: false }]);
  });

  await t.test('a resubmit REPLACES — a later fail overwrites the pass, one record per pair', async () => {
    const res = await call('POST', 'tok-gate', { gate: 'g-a', result: 'fail', summary: 'regressed on retry' });
    assert.equal(res.status, 200, res.text);
    const get = await call('GET', 'tok-gate');
    assert.deepEqual(get.body.gates, [{ id: 'g-a', submitted: true, status: 'fail' }, { id: 'g-b', submitted: false }]);
    const { GateEvidenceStore } = await import('./gates.js');
    const store = new GateEvidenceStore();
    assert.equal(store.listFor('mgate').length, 1, 'the replacement left exactly one record for the pair');
    assert.equal(store.getFor('mgate', 'g-a')?.status, 'fail', 'the honest current attestation is the fail');
  });
});

test('end-to-end: the boundary parks without evidence, the CLI records it, resume finishes done', { skip }, async (t) => {
  await t.test('both boundary missions park at attention naming the gate', async () => {
    const go = await waitForStatus('mgo', 'attention', 30_000);
    const stay = await waitForStatus('mstay', 'attention', 30_000);
    assert.equal(go.status, 'attention', `mgo: ${JSON.stringify(go)}`);
    assert.equal(stay.status, 'attention', `mstay: ${JSON.stringify(stay)}`);
    assert.match(stay.stopReason ?? '', /gate-a — no evidence/);
    assert.match(stay.stopReason ?? '', /towerctl gate submit/, 'the park names the recovery command');
  });

  await t.test('towerctl gate check fails pre-submit and after a fail; status lists the gate', async () => {
    const pre = cli('gate', 'check');
    assert.equal(pre.code, 1, pre.out);
    assert.match(pre.out, /gate-a: not submitted/);

    const failSubmit = cli('gate', 'submit', '--gate', 'gate-a', '--result', 'fail', '--summary', 'first run red');
    assert.equal(failSubmit.code, 0, failSubmit.out);
    const afterFail = cli('gate', 'check');
    assert.equal(afterFail.code, 1, afterFail.out);
    assert.match(afterFail.out, /gate-a: fail/);

    const status = cli('gate', 'status');
    assert.equal(status.code, 0, status.out);
    assert.match(status.out, /gate-a: fail/);
  });

  await t.test('towerctl gate submit pass flips check green', async () => {
    const passSubmit = cli('gate', 'submit', '--gate', 'gate-a', '--result', 'pass');
    assert.equal(passSubmit.code, 0, passSubmit.out);
    assert.match(passSubmit.out, /gate recorded — gate-a: pass/);
    const check = cli('gate', 'check');
    assert.equal(check.code, 0, check.out);
    assert.match(check.out, /gate-a: pass/);
  });

  await t.test('resume re-enters the evaluator: pass evidence finishes done; the control stays parked', async () => {
    // start() may transiently collide with the tick's busy-guard — retry briefly.
    let started = false;
    let lastErr = '';
    for (let i = 0; i < 20 && !started; i++) {
      const r = await fetch(`${base}/api/missions/mgo/start`, {
        method: 'POST', headers: { 'X-Tower-Token': sessionToken },
      });
      started = r.ok;
      if (!started) {
        lastErr = await r.text().catch(() => '');
        await new Promise((r2) => setTimeout(r2, 500));
      }
    }
    assert.ok(started, `mgo start never succeeded: ${lastErr}`);
    const done = await waitForStatus('mgo', 'done', 30_000);
    assert.equal(done.status, 'done', `mgo: ${JSON.stringify(done)}`);
    // The control mission never got evidence — it must still be parked, not silently finished.
    const stay = await missionRead('mstay');
    assert.equal(stay.status, 'attention', 'no evidence ⇒ still parked');
  });
});

function cleanup(): void {
  try { server?.kill('SIGKILL'); } catch { /* ignore */ }
  for (const socket of SOCKETS) {
    try { spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  rmSync(home, { recursive: true, force: true });
}
process.on('exit', cleanup);
