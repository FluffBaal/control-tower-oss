// SPEC-SUBMIT §4.2/§11.4 — the NO_START belt: the last line of defence against a swallowed Enter.
//
// A swallowed submit leaves the terminal IDLE, so the per-turn wall-clock ceiling never trips and the
// runner would otherwise concede a "fast no-op turn" — recording a completed iteration for a prompt
// the agent never saw. The belt looks at the composer before conceding, re-presses Enter a BOUNDED
// number of times, and then faults the turn to a human gate.
//
// Driven against a real scratch tmux pane (non-`ct-` socket) whose screen is painted with the exact
// composer text captured from claude 2.1.216, so the real classifier and the real capture path run.
// Self-skips when tmux is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Loop, Terminal } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-belt-test-'));
process.env.CT_HOME = home;

const pexec = promisify(execFile);
const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { Loops } = await import('./loops.js');
const { ourTextTail } = await import('./tmux.js');
const { ProviderStore } = await import('./providers/store.js');
const { initProviderRegistry } = await import('./providers/registry.js');
initProviderRegistry(new ProviderStore());

const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);
const SOCK = `beltverify-${process.pid}`; // NOT ct-* : the reconciler must never see it
const RULE = '─'.repeat(78);
const NBSP = '\u00A0'; // the marker separator claude renders (pins C3), as an escape not a literal

const killScratch = async (): Promise<void> => {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
};
/** Run a case and ALWAYS reap its pane: a thrown assertion must not orphan a `sleep 600`. */
const withPane = async (text: string, body: () => Promise<void>): Promise<void> => {
  await paintComposer(text);
  try {
    await body();
  } finally {
    await killScratch();
  }
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A pane whose visible screen is a claude composer holding `text` (empty ⇒ an empty composer). */
async function paintComposer(text: string): Promise<void> {
  const screen = [RULE, `❯${NBSP}${text}`, RULE, '  ⏸ manual mode on'].join('\\n');
  // STAGED retry, bounded and loud: under full-suite load the kill-server → new-session pair on
  // the same socket can race the dying server ("server exited unexpectedly" — the fresh server
  // binds the socket, then exits with the old one). This is pure fixture staging, before any
  // product interaction, so re-staging here can never mask a product regression — a mid-drive
  // server death surfaces as different messages ("no server running", "error connecting") and any
  // other spawn failure still throws at once.
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      await pexec('tmux', ['-L', SOCK, 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '8',
        `sh -c 'printf "${screen}\\n"; sleep 600'`], { timeout: 10_000 });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] paint attempt ${attempt} lost the fresh tmux server to the kill-server race; re-staging`);
    }
  }
  // Wait for the pane to have actually PAINTED rather than guessing a settle time: these run on a
  // machine doing other work, and a fixed budget is a coin flip under load.
  const { captureVisible } = await import('./tmux.js');
  for (let i = 0; i < 50; i++) {
    if ((await captureVisible(SOCK)).includes('❯')) return;
    await wait(100);
  }
  // Never give up SILENTLY: an unpainted pane would hand the belt classifier stale bytes and let a
  // composer assert pass or fail against the wrong screen. Throw — this is a tmux infra failure
  // under load, not a product verdict.
  throw new Error('paintComposer: pane never rendered the composer (tmux infra error under load)');
}

function harness(sentPrompt = 'do the thing') {
  const store = new Store();
  const repo = join(home, `repo-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  const projectId = 'p1';
  store.upsertProject({ id: projectId, name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  const now = new Date().toISOString();
  const term: Terminal = {
    id: 't1', projectId, title: 'builder', provider: 'claude-code', tmuxSocket: SOCK,
    cwd: repo, command: ['claude'], state: 'idle', createdAt: now,
  };
  store.upsertTerminal(term);
  const loop: Loop = {
    id: 'l1', projectId, name: 'l', task: 'do the thing', provider: 'claude-code',
    gatePolicy: 'never', maxIterations: 8, status: 'running', iteration: 1,
    iterations: [{ n: 1, verdict: 'pending', startedAt: now }],
    terminalId: 't1', createdAt: now, updatedAt: now,
  };
  store.upsertLoop(loop);
  const loops = new Loops({ store, tm: {} as never, worktrees: {} as never, accounts: {} as never, onUpdate: () => {} });
  const inner = loops as unknown as {
    rt: Map<string, Record<string, unknown>>;
    driveOne(l: Loop): Promise<void>;
  };
  // Park the runtime exactly where the belt lives: injected, never saw 'working', past the fallback.
  // `sentTail` is what injectPrompt stamps so the belt can prove the composer holds OUR prompt.
  inner.rt.set('l1', {
    phase: 'await-start', injectAt: 0, injectedAt: Date.now() - 13_000, sawWorking: false, idleTicks: 0,
    sentTail: ourTextTail(sentPrompt),
  });
  return {
    store,
    inner,
    drive: () => inner.driveOne(store.getLoop('l1')!),
    rt: () => inner.rt.get('l1'),
    loop: () => store.getLoop('l1')!,
  };
}

test('the NO_START belt', { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {
  await t.test('an un-submitted prompt is re-Entered, not conceded as a no-op turn', async () => {
    await paintComposer('do the thing');
    const h = harness();
    await h.drive();
    assert.equal(h.rt()?.reEnter, 1, 'the belt pressed Enter once');
    assert.equal(h.rt()?.phase, 'await-start', 'and stayed in await-start rather than conceding');
    assert.equal(h.loop().status, 'running');
    await killScratch();
  });

  await t.test('the re-Enter is BOUNDED, then the turn is faulted to a human gate', async () => {
    await paintComposer('do the thing');
    const h = harness();
    // NO_START_REENTER_MAX is 2, so the third pass over a still-pending composer must gate.
    await h.drive();
    await h.drive();
    assert.equal(h.rt()?.reEnter, 2);
    assert.equal(h.loop().status, 'running', 'still trying at the bound');
    await h.drive();
    const loop = h.loop();
    assert.equal(loop.status, 'gated', 'past the bound the turn is gated, never re-Entered forever');
    assert.match(
      loop.stopReason ?? '',
      /the injected prompt never submitted — the composer still holds text/,
      'and the gate says exactly what happened',
    );
    assert.equal(loop.iterations[0]?.verdict, 'fail', 'the iteration is failed, never a fabricated pass');
    assert.equal(h.rt(), undefined, 'the runtime is dropped with the fault');
    await killScratch();
  });

  await t.test("a human's draft in the pane is NEVER submitted by the belt", async () => {
    // The operator types half an instruction into a builder pane and steps away. The composer reads
    // pending — but it is not OUR prompt, and pressing Enter would submit their half-sentence to the
    // agent. ⟦SB-2⟧'s foreign-text discipline applies here too: defer, never Enter.
    await paintComposer('delete the old migrations and ');
    const h = harness('do the thing'); // …which is NOT what is sitting in the composer
    await h.drive();
    assert.equal(h.rt()?.reEnter, undefined, 'no Enter was pressed on the human draft');
    assert.equal(h.loop().status, 'running', 'and the loop defers rather than faulting immediately');
    assert.ok(h.rt()?.deferSince, 'the bounded wait is anchored, so it still reaches a gate');
    await killScratch();
  });

  await t.test('a belt with no ownership marker (a restart) stands down instead of guessing', async () => {
    await paintComposer('do the thing');
    const h = harness();
    const rt = h.rt()!;
    delete rt.sentTail; // Runtime is rebuilt on restart; the marker does not survive it
    await h.drive();
    assert.equal(h.rt()?.reEnter, undefined, 'no Enter without proof of ownership');
    await killScratch();
  });

  await t.test('an EMPTY composer is conceded as a genuine no-op turn (no false accusation)', async () => {
    await paintComposer(''); // the agent really did nothing — the belt must not invent a fault
    const h = harness();
    await h.drive();
    assert.equal(h.rt()?.reEnter, undefined, 'no Enter was pressed');
    assert.equal(h.rt()?.phase, 'await-done', 'the turn proceeds to the idle dwell, exactly as before');
    assert.equal(h.loop().status, 'running');
    await killScratch();
  });

  await t.test('a state flip during the capture voids the evidence — never Enter into a working pane', async () => {
    await paintComposer('do the thing');
    const h = harness();
    // The poller's guard idiom: the classifier's snapshot is stale the moment the await returns, so
    // the belt re-reads state before acting. Simulate the flip landing during that window.
    const realGet = h.store.getTerminal.bind(h.store);
    let calls = 0;
    // driveOne reads the terminal twice before the belt (once up front, once after its hasSession
    // await), so the belt's OWN post-capture re-read is the 3rd lookup: flip exactly there, leaving
    // every earlier read idle so the drive actually reaches the belt.
    (h.store as unknown as { getTerminal: (id: string) => Terminal | undefined }).getTerminal = (id: string) => {
      const t0 = realGet(id);
      return t0 && ++calls >= 3 ? { ...t0, state: 'working' as const } : t0;
    };
    await h.drive();
    assert.ok(calls >= 3, 'the drive must have reached the belt, or this asserts nothing');
    assert.equal(h.rt()?.reEnter, undefined, 'no Enter was pressed into the now-working pane');
    await killScratch();
  });
});

test('suspectNoWork survives a store round-trip (the M6 strip-trap)', async () => {
  const store = new Store();
  const now = new Date().toISOString();
  store.upsertProject({ id: 'p2', name: 'p', repoPath: join(home, 'r2'), scaffoldMode: 'zero-footprint', createdAt: now });
  store.upsertLoop({
    id: 'l2', projectId: 'p2', name: 'l', task: 't', provider: 'claude-code', gatePolicy: 'never',
    maxIterations: 4, status: 'running', iteration: 2,
    iterations: [
      { n: 1, verdict: 'pass', startedAt: now, endedAt: now },
      { n: 2, verdict: 'pass', startedAt: now, endedAt: now, suspectNoWork: true },
    ],
    createdAt: now, updatedAt: now,
  });
  const reloaded = new Store().getLoop('l2');
  assert.equal(reloaded?.iterations[1]?.suspectNoWork, true, 'the flag must not be stripped on load');
  assert.equal(reloaded?.iterations[0]?.suspectNoWork, undefined, 'and an unflagged iteration stays unflagged');
});

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
  // tmux leaves the socket FILE behind after kill-server, so remove ours too: a test suite that
  // litters /tmp with one dead socket per run is a slow mess for whoever runs it next.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`) : `/tmp/tmux-${uid}`;
  rmSync(join(dir, SOCK), { force: true });
});
