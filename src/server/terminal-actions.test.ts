// close_terminal / restart_terminal — the two proposable terminal-lifecycle actions (SPEC-RESTART
// Wave 1, SPEC-ASSISTANT-CONTROL §3.2 addendum), a direct clone of the skills-actions test shape.
// Two layers, mirroring skills-actions.test.ts:
//   - in-process unit asserts on the action catalog: validateAction strictness, the ALWAYS-human-
//     confirm carve-out, every enrich guard-rail refusal (unknown / killed / login / planner /
//     Brain-reserved), the loop-bound warning summaries, the denorm baselines (restart pins the loop
//     iteration; close deliberately does not), and the propose-tool schema round-trip;
//   - route-level asserts against a REAL Tower with a REAL tmux pane: the autoConfirm carve-out
//     (both kinds stay PENDING even in autonomous mode, beside a POSITIVE control proving the same
//     account DOES auto-execute a non-carved kind), the guard rails through the real server-side
//     getTerminal wiring — including the ADOPTED-planner scan (a purpose-'work' pane a live mission
//     binds as its planner, refused only because of the missions.list() scan), the loop-bound warning
//     on a live card, the executors really targeting /restart (pane pid changes, state re-latches
//     'working', the bound loop SURVIVES at its iteration) and /kill (state 'killed', the bound loop
//     FAILS — the card's warning proven true), drift-voiding both ways (a vanished target, and a
//     restart card voided by the bound loop moving with the pane provably never respawned), and the
//     scoped-token belt (the brain's own token cannot reach either route).
//
// A scratch CT_HOME on a scratch port; the live pane runs on a NON-`ct-` socket so the operator's
// real Tower never lists it. The route block self-skips without tmux or when the Tower is just
// slow to boot; a DEAD child Tower or one that binds without serving fails loudly (a stolen port
// lands as a dead child).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ActionLookups } from './assistant/actions.js';
import { freePort, spawnTower } from './tower-fixture.js';

const home = mkdtempSync(join(tmpdir(), 'ct-termactions-'));
process.env.CT_HOME = home;

const pexec = promisify(execFile);

// ---- in-process unit asserts on the action catalog (no server) ----

const { validateAction, requiresHumanConfirm, reasonForHumanConfirm, enrich, riskOf } = await import(
  './assistant/actions.js'
);
const { PROPOSE_TOOL } = await import('./assistant/tools.js');

type TerminalView = NonNullable<ReturnType<ActionLookups['getTerminal']>>;
const tv = (over: Partial<TerminalView> = {}): TerminalView => ({
  title: 'builder pane',
  provider: 'claude-code',
  state: 'idle',
  projectName: 'Proj',
  isPlanner: false,
  profileReserved: false,
  ...over,
});
const mkLookups = (terminals: Record<string, TerminalView>): ActionLookups =>
  ({ getTerminal: (id: string) => terminals[id] } as unknown as ActionLookups);

test('validateAction: both terminal kinds parse strictly (missing / empty / extra-key throw)', () => {
  assert.deepEqual(validateAction({ kind: 'close_terminal', terminalId: 't1' }), { kind: 'close_terminal', terminalId: 't1' });
  assert.deepEqual(validateAction({ kind: 'restart_terminal', terminalId: 't1' }), { kind: 'restart_terminal', terminalId: 't1' });
  for (const kind of ['close_terminal', 'restart_terminal']) {
    assert.throws(() => validateAction({ kind }), /invalid action/, `${kind} without terminalId`);
    assert.throws(() => validateAction({ kind, terminalId: '  ' }), /invalid action/, `${kind} with a blank id`);
    assert.throws(() => validateAction({ kind, terminalId: 't1', extra: 1 }), /invalid action/, `${kind} with an extra key`);
    assert.throws(() => validateAction({ kind, terminalId: 42 }), /invalid action/, `${kind} with a non-string id`);
  }
});

test('the carve-out: both kinds ALWAYS require a human confirm — unconditionally, loop-bound or not', () => {
  const close = validateAction({ kind: 'close_terminal', terminalId: 't1' });
  const restart = validateAction({ kind: 'restart_terminal', terminalId: 't1' });
  assert.equal(requiresHumanConfirm(close), true);
  assert.equal(requiresHumanConfirm(restart), true);
  assert.match(reasonForHumanConfirm(close), /fails any loop bound/);
  assert.match(reasonForHumanConfirm(restart), /in-flight turn/);
  // Risk stays card chrome (§3.2): close renders the dock's warning block, restart does not.
  assert.equal(riskOf(close), 'high');
  assert.equal(riskOf(restart), 'medium');
});

test('enrich guard rails: unknown / killed / login / planner / Brain-reserved are each refused with a distinct message', () => {
  const lookups = mkLookups({
    tkilled: tv({ state: 'killed' }),
    tlogin: tv({ purpose: 'login' }),
    tplanner: tv({ isPlanner: true }),
    // The adopted-planner shape at the UNIT level: getTerminal is mocked here, so this proves only
    // that enrich keys the refusal off isPlanner regardless of purpose — the route-level adopted-
    // planner test below is what exercises the real missions.list() scan behind the flag.
    tadopted: tv({ purpose: 'work', isPlanner: true }),
    tbrain: tv({ profileReserved: true }),
  });
  for (const kind of ['close_terminal', 'restart_terminal'] as const) {
    assert.throws(() => enrich(validateAction({ kind, terminalId: 'nope' }), lookups), /unknown terminalId/);
    assert.throws(() => enrich(validateAction({ kind, terminalId: 'tkilled' }), lookups), /already stopped/);
    assert.throws(() => enrich(validateAction({ kind, terminalId: 'tplanner' }), lookups), /planner pane/);
    assert.throws(() => enrich(validateAction({ kind, terminalId: 'tadopted' }), lookups), /planner pane/, 'an ADOPTED planner (purpose work) is still refused');
    assert.throws(() => enrich(validateAction({ kind, terminalId: 'tbrain' }), lookups), /assistant brain/);
  }
  // The login refusal names a different remedy per verb.
  assert.throws(() => enrich(validateAction({ kind: 'close_terminal', terminalId: 'tlogin' }), lookups), /login pane.*Cockpit/);
  assert.throws(() => enrich(validateAction({ kind: 'restart_terminal', terminalId: 'tlogin' }), lookups), /login pane.*open_login/);
});

test('enrich close_terminal: the loop-bound warning is verbatim on the card; denorm baselines state + loop identity/status', () => {
  const lookups = mkLookups({
    tplain: tv(),
    tbound: tv({ title: 'L1 builder', state: 'working', owningLoop: { id: 'l1', name: 'L1', status: 'running', iteration: 3 } }),
  });
  const plain = enrich(validateAction({ kind: 'close_terminal', terminalId: 'tplain' }), lookups);
  assert.match(plain.summary, /Close terminal "builder pane" \(claude-code, idle\) in project "Proj"/);
  assert.equal(/FAILS loop/.test(plain.summary), false, 'no loop, no warning');
  assert.deepEqual(plain.denorm, {
    title: 'builder pane', provider: 'claude-code', state: 'idle', purpose: 'work',
    projectName: 'Proj', owningLoopId: null, owningLoopStatus: null,
  });

  const bound = enrich(validateAction({ kind: 'close_terminal', terminalId: 'tbound' }), lookups);
  assert.match(bound.summary, /closing this terminal FAILS loop "L1" \(running, iteration 3\)/);
  assert.equal(bound.denorm.owningLoopId, 'l1');
  assert.equal(bound.denorm.owningLoopStatus, 'running');
});

test('enrich restart_terminal: the discard warning is verbatim; denorm additionally pins the loop iteration', () => {
  const lookups = mkLookups({
    tplain: tv(),
    tbound: tv({ owningLoop: { id: 'l1', name: 'L1', status: 'running', iteration: 3 } }),
  });
  const plain = enrich(validateAction({ kind: 'restart_terminal', terminalId: 'tplain' }), lookups);
  assert.match(plain.summary, /relaunches its CLI in place; the in-flight turn is discarded/);
  assert.equal(plain.denorm.owningLoopIteration, null);

  const bound = enrich(validateAction({ kind: 'restart_terminal', terminalId: 'tbound' }), lookups);
  assert.match(
    bound.summary,
    /restarts the builder pane of loop "L1" — the in-flight turn is discarded; committed work and the worktree survive/,
  );
  assert.equal(bound.denorm.owningLoopIteration, 3);
});

test('drift baselines: a loop advancing an iteration voids a restart card but not a close card; a status change voids both', () => {
  const at = (status: string, iteration: number): ActionLookups =>
    mkLookups({ t: tv({ owningLoop: { id: 'l1', name: 'L1', status, iteration } }) });
  const close = validateAction({ kind: 'close_terminal', terminalId: 't' });
  const restart = validateAction({ kind: 'restart_terminal', terminalId: 't' });
  const dj = (e: { denorm: unknown }): string => JSON.stringify(e.denorm);

  // Iteration 3 → 4: restart's Confirm would re-run a DIFFERENT iteration — void; close fails the
  // loop identically either way — its baseline is deliberately iteration-free.
  assert.notEqual(dj(enrich(restart, at('running', 3))), dj(enrich(restart, at('running', 4))));
  assert.equal(dj(enrich(close, at('running', 3))), dj(enrich(close, at('running', 4))));
  // A status change (gated / finished behind the card) voids both.
  assert.notEqual(dj(enrich(close, at('running', 3))), dj(enrich(close, at('gated', 3))));
  assert.notEqual(dj(enrich(restart, at('running', 3))), dj(enrich(restart, at('gated', 3))));
  // A loop finishing entirely (owningLoop gone) voids both too.
  const noLoop = mkLookups({ t: tv() });
  assert.notEqual(dj(enrich(close, at('running', 3))), dj(enrich(close, noLoop)));
  assert.notEqual(dj(enrich(restart, at('running', 3))), dj(enrich(restart, noLoop)));
});

test('propose-tool round-trip: both kinds are in the PROPOSE_TOOL schema (a kind absent here cannot be proposed)', () => {
  const oneOf = (PROPOSE_TOOL.parameters as { oneOf: { properties: { kind: { enum: string[] } }; required: string[] }[] }).oneOf;
  for (const kind of ['close_terminal', 'restart_terminal']) {
    const branch = oneOf.find((b) => b.properties.kind.enum.includes(kind));
    assert.ok(branch, `${kind} has a schema branch`);
    assert.deepEqual(branch!.required, ['kind', 'terminalId']);
  }
});

// ---- route-level asserts against a real Tower + a real pane ----

const PORT = await freePort();
process.env.CT_PORT = String(PORT);

const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);
const SOCK_A = `termact-a-${process.pid}`; // NOT ct-* : no reconciler ever lists these
const SOCK_B = `termact-b-${process.pid}`;
const killPane = async (sock: string): Promise<void> => {
  await pexec('tmux', ['-L', sock, 'kill-server']).catch(() => {});
};
const panePid = async (sock: string): Promise<string> =>
  (await pexec('tmux', ['-L', sock, 'display-message', '-p', '-t', 'main', '#{pane_pid}'])).stdout.trim();

// Live panes must exist BEFORE the Tower boots (the startup reconcile vanishes sessionless records).
// `exec sleep` keeps the pane childless and its screen static, so the poller never flips the seeded
// state and the denorm baselines stay deterministic between propose and confirm.
if (haveTmux) {
  for (const sock of [SOCK_A, SOCK_B]) {
    await killPane(sock);
    await pexec('tmux', ['-L', sock, 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '24',
      "sh -c 'echo pane; exec sleep 600'"], { timeout: 10_000 });
    await pexec('tmux', ['-L', sock, 'set-option', '-t', 'main', 'remain-on-exit', 'on']);
  }
}

const now = new Date().toISOString();
mkdirSync(join(home, 'config'), { recursive: true });
const writeConfig = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));

writeConfig('projects.json', [{ id: 'pa', name: 'pa', repoPath: home, scaffoldMode: 'zero-footprint', createdAt: now }]);
// tlogin / tplan / tbrain SHARE pane A's socket: their sessions read alive, so their own guard rail —
// not the killed-refusal — is what each propose exercises. tbrain's profileId matches the assistant
// account's, making it Brain-reserved.
writeConfig('terminals.json', [
  { id: 'tplain', projectId: 'pa', title: 'live pane', provider: 'claude-code', tmuxSocket: SOCK_A, cwd: home, command: ['sh'], state: 'idle', createdAt: now },
  { id: 'tdrift', projectId: 'pa', title: 'drift pane', provider: 'claude-code', tmuxSocket: SOCK_B, cwd: home, command: ['sh'], state: 'idle', createdAt: now },
  { id: 'tkd', projectId: 'pa', title: 'dead record', provider: 'claude-code', tmuxSocket: `${SOCK_A}-x`, cwd: home, command: ['sh'], state: 'killed', createdAt: now },
  { id: 'tlogin', projectId: 'pa', title: 'login pane', provider: 'claude-code', tmuxSocket: SOCK_A, cwd: home, command: ['sh'], state: 'idle', purpose: 'login', createdAt: now },
  { id: 'tplan', projectId: 'pa', title: 'planner pane', provider: 'claude-code', tmuxSocket: SOCK_A, cwd: home, command: ['sh'], state: 'idle', purpose: 'planner', createdAt: now },
  // The ADOPTED-planner fixture: purpose is ABSENT (= 'work'), so only the missions.list() planner
  // scan in the real getTerminal wiring can refuse it — a refactor dropping that scan turns this red.
  { id: 'tadopt', projectId: 'pa', title: 'adopted planner', provider: 'claude-code', tmuxSocket: SOCK_A, cwd: home, command: ['sh'], state: 'idle', createdAt: now },
  { id: 'tbrain', projectId: 'pa', title: 'brain pane', provider: 'codex', tmuxSocket: SOCK_A, cwd: home, command: ['sh'], state: 'idle', profileId: 'brainx', createdAt: now },
]);
// GATED loops bound to the live panes: bound (non-terminal status) so the warning renders and a
// close FAILS them, but not 'running', so the loop runner never drives a scratch pane un-asked.
// gl rides the tplain restart/close flows; gd exists for the restart-card drift test on tdrift.
writeConfig('loops.json', [
  {
    id: 'gl', projectId: 'pa', name: 'gl', task: 't', provider: 'claude-code', gatePolicy: 'never',
    maxIterations: 8, status: 'gated', iteration: 2,
    iterations: [
      { n: 1, verdict: 'pass', startedAt: now, endedAt: now },
      { n: 2, verdict: 'pending', startedAt: now },
    ],
    terminalId: 'tplain', createdAt: now, updatedAt: now,
  },
  {
    id: 'gd', projectId: 'pa', name: 'gd', task: 't', provider: 'claude-code', gatePolicy: 'never',
    maxIterations: 8, status: 'gated', iteration: 2,
    iterations: [
      { n: 1, verdict: 'pass', startedAt: now, endedAt: now },
      { n: 2, verdict: 'pending', startedAt: now },
    ],
    terminalId: 'tdrift', createdAt: now, updatedAt: now,
  },
]);
// A DRAFT mission whose live planner binding is tadopt — the adopted-planner ground truth the
// getTerminal scan reads. Draft, so the mission tick never runs it.
writeConfig('missions.json', [
  {
    id: 'ma', projectId: 'pa', name: 'm', goal: 'g', provider: 'codex', advance: 'gate',
    maxIterationsPerSortie: 8, concurrency: 1, phases: [], activePhase: 0, status: 'draft',
    planner: { terminalId: 'tadopt', provider: 'claude-code', state: 'live', attachedAt: now },
    createdAt: now, updatedAt: now,
  },
]);
// autoConfirm ON — so it is the carve-out, not a non-autonomous account, that keeps cards pending.
// profileId 'brainx' also makes tbrain's binding reserved.
writeConfig('assistant-accounts.json', [
  { id: 'aa', mode: 'cli', provider: 'codex', profileId: 'brainx', autoConfirm: true, createdAt: now },
]);

const base = `http://127.0.0.1:${PORT}`;
// Spawn + identity-gated readiness live in tower-fixture.ts: "ready" means OUR Tower (the startup
// line carrying THIS file's CT_HOME) answered /api/session. A DEAD child (how a stolen port lands)
// or a bound-but-unresponsive Tower throws loudly; only an alive-but-slow boot yields a skip.
const tower = await spawnTower(home, PORT);
const token = tower.sessionToken;
const skip = !haveTmux ? 'tmux is not installed' : tower.skip ?? false;

const sessionHeaders = { 'X-Tower-Token': token, 'Content-Type': 'application/json' };
const propose = (conv: string, body: unknown): Promise<Response> =>
  fetch(`${base}/api/assistant/proposals`, {
    method: 'POST',
    headers: { ...sessionHeaders, 'X-Tower-Conversation': conv },
    body: JSON.stringify(body),
  });
const confirm = (proposalId: string): Promise<Response> =>
  fetch(`${base}/api/assistant/confirm`, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ proposalId }) });
async function terminal(id: string): Promise<Record<string, unknown> | undefined> {
  const list = (await (await fetch(`${base}/api/terminals`, { headers: { 'X-Tower-Token': token } })).json()) as Record<string, unknown>[];
  return list.find((t) => t.id === id);
}
async function loopRec(id: string): Promise<Record<string, unknown> | undefined> {
  const list = (await (await fetch(`${base}/api/loops`, { headers: { 'X-Tower-Token': token } })).json()) as Record<string, unknown>[];
  return list.find((l) => l.id === id);
}
const errOf = async (r: Response): Promise<string> => ((await r.json().catch(() => ({}))) as { error?: string }).error ?? '';

test('propose: every guard rail refuses through the REAL server-side getTerminal wiring', { skip }, async () => {
  const cases: [unknown, RegExp][] = [
    [{ kind: 'close_terminal', args: { terminalId: 'nope' } }, /unknown terminalId/],
    [{ kind: 'close_terminal', args: { terminalId: 'tkd' } }, /already stopped/],
    [{ kind: 'close_terminal', args: { terminalId: 'tlogin' } }, /login pane/],
    [{ kind: 'restart_terminal', args: { terminalId: 'tlogin' } }, /open_login/],
    [{ kind: 'close_terminal', args: { terminalId: 'tplan' } }, /planner pane/],
    [{ kind: 'restart_terminal', args: { terminalId: 'tplan' } }, /planner pane/],
    // The ADOPTED planner: purpose 'work', refused ONLY because a live mission's planner binding
    // names it — this is the missions.list() scan itself under test, not the purpose stamp.
    [{ kind: 'close_terminal', args: { terminalId: 'tadopt' } }, /planner pane/],
    [{ kind: 'restart_terminal', args: { terminalId: 'tadopt' } }, /planner pane/],
    [{ kind: 'close_terminal', args: { terminalId: 'tbrain' } }, /assistant brain/],
    [{ kind: 'restart_terminal', args: { terminalId: 'tbrain' } }, /assistant brain/],
  ];
  for (const [body, re] of cases) {
    const r = await propose('convrails', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} refused`);
    assert.match(await errOf(r), re);
  }
});

test('autoConfirm carve-out: both kinds stay PENDING in autonomous mode; the loop-bound warnings ride the live card', { skip }, async () => {
  const close = await propose('convpend1', { kind: 'close_terminal', args: { terminalId: 'tplain' } });
  assert.equal(close.status, 200);
  const closeCard = (await close.json()) as Record<string, unknown>;
  assert.equal(closeCard.status, 'pending', 'close never auto-confirms');
  assert.match(String(closeCard.summary), /closing this terminal FAILS loop "gl" \(gated, iteration 2\)/);
  assert.equal((await terminal('tplain'))?.state, 'idle', 'the pane is untouched (nothing executed)');

  const restart = await propose('convpend2', { kind: 'restart_terminal', args: { terminalId: 'tplain' } });
  assert.equal(restart.status, 200);
  const restartCard = (await restart.json()) as Record<string, unknown>;
  assert.equal(restartCard.status, 'pending', 'restart never auto-confirms');
  assert.match(String(restartCard.summary), /restarts the builder pane of loop "gl"/);

  // POSITIVE CONTROL: the SAME account really is autonomous — a non-carved kind auto-executes on
  // this very propose path. Without this, "close/restart stay pending" could pass for the wrong
  // reason (auto-confirm broken wholesale rather than the carve-out holding).
  const control = await propose('convpend3', { kind: 'create_task', args: { projectId: 'pa', title: 'auto control' } });
  assert.equal(control.status, 200);
  assert.equal(
    ((await control.json()) as Record<string, unknown>).status, 'executed',
    'a non-carved kind auto-executes under this account — the pending cards above are the carve-out, proven',
  );
});

test('confirm restart_terminal: the executor targets /restart — pane respawned in place, loop SURVIVES', { skip }, async () => {
  const pid1 = await panePid(SOCK_A);
  const r = await propose('convrst', { kind: 'restart_terminal', args: { terminalId: 'tplain' } });
  const p = (await r.json()) as { id: string; status: string };
  assert.equal(p.status, 'pending');
  const done = await confirm(p.id);
  assert.equal(done.status, 200);
  assert.equal(((await done.json()) as Record<string, unknown>).status, 'executed');
  assert.notEqual(await panePid(SOCK_A), pid1, 'the pane process is NEW — the /restart route really ran');
  assert.equal((await terminal('tplain'))?.state, 'working', 'restart re-latched the record');
  const gl = await loopRec('gl');
  assert.equal(gl?.status, 'gated', 'a restart never fails the bound loop');
  assert.equal(gl?.iteration, 2, 'and the loop still sits at its CURRENT iteration — the re-arm survived, nothing advanced');
});

test('confirm close_terminal: the executor targets /kill — pane dies and the card-promised loop failure happens', { skip }, async () => {
  const r = await propose('convcls', { kind: 'close_terminal', args: { terminalId: 'tplain' } });
  const card = (await r.json()) as { id: string; status: string; summary: string };
  assert.equal(card.status, 'pending');
  assert.match(card.summary, /FAILS loop "gl"/);
  const done = await confirm(card.id);
  assert.equal(done.status, 200);
  assert.equal(((await done.json()) as Record<string, unknown>).status, 'executed');
  assert.equal((await terminal('tplain'))?.state, 'killed', 'the /kill route really ran');
  assert.equal((await loopRec('gl'))?.status, 'failed', 'the warning the operator approved was the truth');
});

test('e2e drift: a restart card is VOIDED when the bound loop moves behind it — and the pane provably never respawns', { skip }, async () => {
  // The distinctive restart pin, end-to-end: the card was reviewed against gd @ (gated, iteration 2);
  // the operator's own Continue click advances the loop (gated → running, iteration 2 → 3) behind it,
  // so the Confirm would re-run a DIFFERENT iteration — the drift compare must void it and the
  // executor must never fire. (The other half of the asymmetry — an iteration-ONLY advance leaving a
  // CLOSE card valid — is pinned at the unit layer above: no public route moves a loop's iteration
  // without also moving its status (continue necessarily flips gated → running, which close's own
  // status pin rightly voids too), so the byte-equal denorm assert is that half's proof.)
  const pid1 = await panePid(SOCK_B);
  const r = await propose('convdrift0', { kind: 'restart_terminal', args: { terminalId: 'tdrift' } });
  const p = (await r.json()) as { id: string; status: string; summary: string };
  assert.equal(p.status, 'pending');
  assert.match(p.summary, /restarts the builder pane of loop "gd"/);
  const cont = await fetch(`${base}/api/loops/gd/continue`, { method: 'POST', headers: { 'X-Tower-Token': token } });
  assert.equal(cont.status, 200, 'the out-of-band Continue advanced the loop');
  const drifted = await confirm(p.id);
  assert.equal(drifted.status, 409, 'the moved loop voids the restart card');
  assert.match(await errOf(drifted), /changed since proposed/);
  assert.equal(await panePid(SOCK_B), pid1, 'the executor never ran — the pane was never respawned');
});

test('drift: a terminal killed behind the card voids the confirm (409) and the executor never runs', { skip }, async () => {
  const r = await propose('convdrift', { kind: 'close_terminal', args: { terminalId: 'tdrift' } });
  const p = (await r.json()) as { id: string; status: string };
  assert.equal(p.status, 'pending');
  // Kill it out-of-band (the operator's own kill click) — the re-enrich at confirm now throws.
  // Token header only: a JSON content-type with no body is a Fastify 400 before the route runs.
  const kill = await fetch(`${base}/api/terminals/tdrift/kill`, { method: 'POST', headers: { 'X-Tower-Token': token } });
  assert.equal(kill.status, 200);
  const drifted = await confirm(p.id);
  assert.equal(drifted.status, 409, 'a vanished target aborts the confirm as drift');
  assert.match(await errOf(drifted), /changed since proposed/);
});

test('scoped-token belt: the assistant token reaches NEITHER /kill NOR /restart (the brain never self-executes)', { skip }, async () => {
  const assistantToken = readFileSync(join(home, 'secrets', 'mcptok-assistant'), 'utf8').trim();
  for (const path of ['/api/terminals/tplain/kill', '/api/terminals/tplain/restart']) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'X-Tower-Token': assistantToken, 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 403, `${path} is refused for the scoped token`);
  }
});

test.after(async () => {
  try {
    tower.server?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  await killPane(SOCK_A);
  await killPane(SOCK_B);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`) : `/tmp/tmux-${uid}`;
  rmSync(join(dir, SOCK_A), { force: true });
  rmSync(join(dir, SOCK_B), { force: true });
  rmSync(home, { recursive: true, force: true });
});
