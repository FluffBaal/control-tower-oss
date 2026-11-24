// SPEC-TERMINAL-OPS §3.2/§4.3 — the two pure policy helpers behind the terminal plane's destructive
// and blocking decisions: terminalCapacity (which refuses a spawn / defers a sortie) and
// shouldReapTerminal (which kills a pane). Both were factored out and exported precisely so the policy
// could be table-tested instead of only living inside a server closure.
//
// CT_HOME is set before the module loads: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CustomProviderId, Loop, Mission, Project, ProviderDef, Terminal, TerminalState } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-tm-test-'));
process.env.CT_HOME = home;

const pexec = promisify(execFile);
const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { ProviderStore } = await import('./providers/store.js');
const { initProviderRegistry } = await import('./providers/registry.js');
// Kept (not discarded): the createTerminal spawn-env test below registers a CUSTOM provider def
// through this exact store, then rebuilds this exact registry, so getAdapter() resolves the
// synthesized adapter instead of the dangling-id tombstone.
const providerStore = new ProviderStore();
const registry = initProviderRegistry(providerStore);

const { terminalCapacity, shouldReapTerminal, resolveAutoAccept, liveBypassOnDir, sharedConfigDirFor, TerminalManager } =
  await import('./terminal-manager.js');

const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);

const term = (o: Partial<Terminal> = {}): Terminal => ({
  id: 't1',
  projectId: 'p1',
  title: 't',
  provider: 'codex',
  tmuxSocket: 'ct-t1',
  cwd: '/tmp',
  command: [],
  state: 'idle',
  createdAt: '2026-07-01T00:00:00.000Z',
  ...o,
});

test('terminalCapacity — the ONE live-terminal counting rule', async (t) => {
  const live = (n: number, projectId = 'p1'): Terminal[] =>
    Array.from({ length: n }, (_, i) => term({ id: `live${projectId}${i}`, projectId }));

  await t.test('under the global cap', () => {
    assert.equal(terminalCapacity(live(3), { globalCap: 4 }).ok, true);
  });

  await t.test('at the global cap refuses (>=, not >)', () => {
    const res = terminalCapacity(live(4), { globalCap: 4 });
    assert.equal(res.ok, false);
    assert.match(res.detail, /4\/4 live/);
  });

  await t.test('killed terminals do not count, every other state does', () => {
    const states: TerminalState[] = ['starting', 'working', 'blocked-question', 'blocked-permission', 'idle'];
    const terminals = [
      ...states.map((state, i) => term({ id: `s${i}`, state })),
      term({ id: 'dead1', state: 'killed' }),
      term({ id: 'dead2', state: 'killed' }),
    ];
    assert.equal(terminalCapacity(terminals, { globalCap: states.length }).ok, false, 'the 5 live ones fill the cap');
    assert.equal(terminalCapacity(terminals, { globalCap: states.length + 1 }).ok, true, 'the 2 killed ones are not counted');
  });

  await t.test('a starting draft counts (this is what makes check + upsert atomic)', () => {
    assert.equal(terminalCapacity([term({ state: 'starting' })], { globalCap: 1 }).ok, false);
  });

  await t.test('the per-project cap fires while the global still has room', () => {
    const terminals = [...live(1, 'p1'), ...live(2, 'p2')];
    const res = terminalCapacity(terminals, { globalCap: 12, projectId: 'p2', projectCap: 2 });
    assert.equal(res.ok, false);
    assert.match(res.detail, /2\/2 live in this project/);
    assert.equal(terminalCapacity(terminals, { globalCap: 12, projectId: 'p1', projectCap: 2 }).ok, true);
  });

  await t.test('no project cap set → only the global rule applies', () => {
    assert.equal(terminalCapacity(live(5, 'p2'), { globalCap: 12, projectId: 'p2' }).ok, true);
  });

  await t.test('the global cap wins even when the project is under its own', () => {
    const res = terminalCapacity(live(4, 'p1'), { globalCap: 4, projectId: 'p1', projectCap: 99 });
    assert.equal(res.ok, false);
    assert.match(res.detail, /terminal cap reached/);
  });
});

test('shouldReapTerminal — every keep/reap clause', async (t) => {
  const NOW = Date.parse('2026-07-21T12:00:00.000Z');
  const WINDOW = 24 * 3_600_000;
  const opts = { now: NOW, windowMs: WINDOW };
  const old = new Date(NOW - 48 * 3_600_000).toISOString();
  const recent = new Date(NOW - 1 * 3_600_000).toISOString();

  const loop = (o: Partial<Loop> = {}): Loop => ({
    id: 'l1',
    projectId: 'p1',
    name: 'l',
    task: 't',
    provider: 'codex',
    gatePolicy: 'never',
    maxIterations: 8,
    status: 'done',
    iteration: 1,
    iterations: [],
    terminalId: 't1',
    missionId: 'm1',
    createdAt: old,
    updatedAt: old,
    ...o,
  });
  const miss = (o: Partial<Mission> = {}): Mission => ({
    id: 'm1',
    projectId: 'p1',
    name: 'm',
    goal: 'g',
    provider: 'codex',
    advance: 'gate',
    maxIterationsPerSortie: 8,
    concurrency: 1,
    phases: [],
    activePhase: 0,
    status: 'done',
    createdAt: old,
    updatedAt: old,
    ...o,
  });

  // Each row: the ONE thing changed from the reapable baseline, and whether it should still be reaped.
  const cases: { name: string; t?: Partial<Terminal>; l?: Partial<Loop> | null; m?: Partial<Mission> | null; reap: boolean }[] = [
    { name: 'baseline: idle builder of a done mission, 48h old', reap: true },
    { name: 'explicit purpose work', t: { purpose: 'work' }, reap: true },
    { name: 'failed mission + failed loop', l: { status: 'failed' }, m: { status: 'failed' }, reap: true },
    { name: 'stopped loop', l: { status: 'stopped' }, reap: true },
    { name: 'archived mission that is still running', m: { status: 'running', archivedAt: old }, reap: true },
    { name: 'mission record vanished (age falls back to the loop)', m: null, reap: true },
    { name: 'old lastEventAt does not save it', t: { lastEventAt: old }, reap: true },

    { name: 'state killed', t: { state: 'killed' }, reap: false },
    { name: 'state working (in use)', t: { state: 'working' }, reap: false },
    { name: 'state blocked-question (attention queue, forensics)', t: { state: 'blocked-question' }, reap: false },
    { name: 'state blocked-permission', t: { state: 'blocked-permission' }, reap: false },
    { name: 'state starting', t: { state: 'starting' }, reap: true },

    { name: 'purpose login is never auto-reaped', t: { purpose: 'login' }, reap: false },
    { name: 'purpose planner is exempt this wave', t: { purpose: 'planner' }, reap: false },

    { name: 'no owning loop (an operator terminal)', l: null, m: null, reap: false },
    { name: 'owning loop carries no missionId (a standalone loop builder)', l: { missionId: undefined }, m: null, reap: false },
    { name: 'the owning loop is still running', l: { status: 'running' }, reap: false },

    { name: 'mission running', m: { status: 'running' }, reap: false },
    { name: 'mission attention (resumable)', m: { status: 'attention' }, reap: false },
    { name: 'mission paused (resumable)', m: { status: 'paused' }, reap: false },
    { name: 'mission phase-gate (resumable)', m: { status: 'phase-gate' }, reap: false },
    { name: 'mission draft', m: { status: 'draft' }, reap: false },

    { name: 'mission updated inside the window', m: { updatedAt: recent }, reap: false },
    { name: 'exactly at the window edge (strictly greater is required)', m: { updatedAt: new Date(NOW - WINDOW).toISOString() }, reap: false },
    { name: 'unparseable mission updatedAt', m: { updatedAt: 'not-a-date' }, reap: false },
    { name: 'recent lastEventAt (the operator is using the pane)', t: { lastEventAt: recent }, reap: false },
    { name: 'unparseable lastEventAt (NaN must not read as "no recent event")', t: { lastEventAt: 'not-a-date' }, reap: false },
  ];

  for (const c of cases) {
    await t.test(`${c.reap ? 'reaps' : 'keeps'}: ${c.name}`, () => {
      const l = c.l === null ? undefined : loop(c.l ?? {});
      const m = c.m === null ? undefined : miss(c.m ?? {});
      assert.equal(shouldReapTerminal(term(c.t ?? {}), l, m, opts), c.reap);
    });
  }

  await t.test('a longer reap window keeps a terminal the default window would take', () => {
    assert.equal(shouldReapTerminal(term(), loop(), miss(), { now: NOW, windowMs: 72 * 3_600_000 }), false);
  });
});

test('resolveAutoAccept — the ONE autonomy resolution rule (effective = override ?? default ?? false, work-only, capability-gated)', async (t) => {
  // Baseline is {requested: undefined, projectDefault: undefined, purpose: undefined (work), supported: true} → false.
  // Each row flips one input; `err` true means an EXPLICIT unhonorable request must FAIL LOUD (never a silent drop).
  type P = Terminal['purpose'];
  const rows: {
    name: string;
    args: { requested?: boolean; projectDefault?: boolean; purpose?: P; supported: boolean };
    autoAccept: boolean;
    err: boolean;
  }[] = [
    { name: 'baseline: nothing set, supported → never default-on', args: { purpose: undefined, supported: true }, autoAccept: false, err: false },
    { name: 'project default flows to a work terminal', args: { projectDefault: true, purpose: undefined, supported: true }, autoAccept: true, err: false },
    { name: "explicit 'work' equals absent", args: { projectDefault: true, purpose: 'work', supported: true }, autoAccept: true, err: false },
    { name: 'override forces on', args: { requested: true, purpose: undefined, supported: true }, autoAccept: true, err: false },
    { name: 'override false beats the project default (kills a ??→|| mutation)', args: { requested: false, projectDefault: true, purpose: undefined, supported: true }, autoAccept: false, err: false },
    { name: 'override true beats a false default the other way', args: { requested: true, projectDefault: false, purpose: undefined, supported: true }, autoAccept: true, err: false },
    { name: 'login never skips (inherited default, no error)', args: { projectDefault: true, purpose: 'login', supported: true }, autoAccept: false, err: false },
    { name: 'planner never skips (inherited default, no error)', args: { projectDefault: true, purpose: 'planner', supported: true }, autoAccept: false, err: false },
    { name: 'explicit on a login purpose is refused, not ignored', args: { requested: true, purpose: 'login', supported: true }, autoAccept: false, err: true },
    { name: 'explicit off on a planner purpose is refused too (both polarities)', args: { requested: false, purpose: 'planner', supported: true }, autoAccept: false, err: true },
    { name: 'explicit on an unsupported provider fails loud', args: { requested: true, purpose: undefined, supported: false }, autoAccept: false, err: true },
    { name: 'inherited default on an unsupported provider is honest off', args: { projectDefault: true, purpose: undefined, supported: false }, autoAccept: false, err: false },
    // FOLD row 13 — explicit FALSE on an unsupported provider is honored-off, NOT an error (only explicit TRUE errors).
    { name: 'explicit off on an unsupported provider is honored off, no error', args: { requested: false, projectDefault: undefined, purpose: undefined, supported: false }, autoAccept: false, err: false },
  ];

  for (const r of rows) {
    await t.test(r.name, () => {
      const res = resolveAutoAccept(r.args);
      assert.equal(res.autoAccept, r.autoAccept, 'autoAccept');
      if (r.err) {
        assert.ok(res.error && res.error.length > 0, 'an unhonorable explicit request must carry a non-empty error');
      } else {
        assert.equal(res.error, undefined, 'no error on an honorable/inherited resolution');
      }
    });
  }
});

test('liveBypassOnDir — the materializer autonomy-clearance belt truth table (SPEC-SKILLS Phase 5b wave 2)', async (t) => {
  const profiles: Record<string, { configDir: string }> = { p1: { configDir: '/accounts/p1' } };
  const getProfile = (id: string): { configDir: string } | undefined => profiles[id];
  const shared = sharedConfigDirFor('claude-code');

  await t.test('no terminals → false', () => {
    assert.equal(liveBypassOnDir([], '/accounts/p1', getProfile), false);
  });

  await t.test('a live skip-permissions terminal on a matching profile dir → true', () => {
    assert.equal(liveBypassOnDir([term({ autoAccept: true, state: 'working', profileId: 'p1' })], '/accounts/p1', getProfile), true);
  });

  await t.test("'killed' is the ONLY excluded state — a blocked bypass agent still holds a live CLI", () => {
    assert.equal(liveBypassOnDir([term({ autoAccept: true, state: 'killed', profileId: 'p1' })], '/accounts/p1', getProfile), false);
    for (const state of ['starting', 'working', 'blocked-question', 'blocked-permission', 'idle'] as TerminalState[]) {
      assert.equal(liveBypassOnDir([term({ autoAccept: true, state, profileId: 'p1' })], '/accounts/p1', getProfile), true, state);
    }
  });

  await t.test('a non-bypass terminal never counts (autoAccept absent and false alike)', () => {
    assert.equal(liveBypassOnDir([term({ state: 'working', profileId: 'p1' })], '/accounts/p1', getProfile), false);
    assert.equal(liveBypassOnDir([term({ autoAccept: false, state: 'working', profileId: 'p1' })], '/accounts/p1', getProfile), false);
  });

  await t.test('a different account dir does not match', () => {
    assert.equal(liveBypassOnDir([term({ autoAccept: true, state: 'working', profileId: 'p1' })], '/accounts/other', getProfile), false);
  });

  await t.test('no profileId resolves to the shared per-provider dir (the spawn-path resolution mirrored)', () => {
    const fleet = [term({ provider: 'claude-code', autoAccept: true, state: 'working' })];
    assert.equal(liveBypassOnDir(fleet, shared, getProfile), true, 'matches its own shared dir');
    assert.equal(liveBypassOnDir(fleet, '/accounts/p1', getProfile), false, 'and no profile dir');
  });

  await t.test('a dangling profileId matches CONSERVATIVELY — over-exclusion is the safe direction', () => {
    assert.equal(liveBypassOnDir([term({ autoAccept: true, state: 'working', profileId: 'gone' })], '/anything/at-all', getProfile), true);
  });
});

test(
  'createTerminal — a spawned NON-shell terminal never carries TOWER_MEMORY_DIR (the legacy coordEnv bridge is retired)',
  { skip: haveTmux ? false : 'tmux is not installed' },
  async () => {
    // The removed coordEnv block was gated `if (provider !== 'shell')`, so 'shell' never carried
    // TOWER_MEMORY_DIR even before the fix — a shell spawn here would prove nothing. This exercises
    // the actually-affected branch with a REGISTERED CUSTOM provider (auth 'none', so no credential;
    // turn mode 'dwell-only', so writeHookConfig is a no-op; command a harmless `sh -c 'sleep 600'`
    // stub — no real CLI binary needed), so `provider !== 'shell'` is true and the def resolves
    // through the SAME getAdapter() path a real claude-code/codex/gemini/hermes spawn takes. Against
    // the pre-removal code this same spawn WOULD have carried TOWER_MEMORY_DIR, so the assertion
    // below is a genuine regression guard, not a re-statement of an already-true fact.
    const CUSTOM_ID: CustomProviderId = 'custom:tmw-stub';
    const now = new Date().toISOString();
    const customDef: ProviderDef = {
      id: CUSTOM_ID,
      displayName: 'TM stub',
      command: ['sh', '-c', 'sleep 600'],
      model: {},
      turn: { mode: 'dwell-only' },
      approveKeys: { approve: ['y'], deny: ['n'] },
      auth: { mode: 'none' },
      createdAt: now,
      updatedAt: now,
    };
    providerStore.upsert(customDef);
    registry.rebuild();

    const store = new Store();
    const deps = {
      hookTokens: { ensure: () => 'tok', tokenFile: (id: string) => join(home, `tok-${id}`), forget: () => {} },
      hookScript: '/dev/null',
      towerPort: 4870,
      worktrees: {},
      accounts: {},
      broker: {},
      credentialScript: '/dev/null',
      brokerSock: '/dev/null',
      leases: {},
      providers: providerStore,
      skills: {},
      maxTerminals: () => 8,
    } as unknown as ConstructorParameters<typeof TerminalManager>[1];
    const tm = new TerminalManager(store, deps);
    const repoPath = mkdtempSync(join(home, 'repo-'));
    const project: Project = { id: 'p1', name: 'p', repoPath, scaffoldMode: 'zero-footprint', createdAt: now };
    store.upsertProject(project);

    const terminal = await tm.createTerminal(project, { provider: CUSTOM_ID });
    try {
      const { stdout } = await pexec('tmux', ['-L', terminal.tmuxSocket, 'show-environment', '-t', 'main']);
      assert.ok(!stdout.includes('TOWER_MEMORY_DIR'), 'no TOWER_MEMORY_DIR was ever -e\'d into a non-shell spawn');
      // Positive control: the synthesized adapter's own buildEnv DID land, so the negative assertion
      // above is exercising a real, populated env — not a vacuously empty one.
      assert.ok(stdout.includes('TOWER_TERMINAL_ID'), 'sanity: the real spawn env landed');
    } finally {
      await pexec('tmux', ['-L', terminal.tmuxSocket, 'kill-server']).catch(() => {});
    }
  },
);

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
