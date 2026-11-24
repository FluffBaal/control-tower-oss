// SPEC-RESTART §2 — restartTerminal: respawn the pane's CLI IN PLACE, preserving everything a kill
// releases. The contract under test, both directions:
//   - restart PRESERVES: hook token, broker registration, worktree lease, and every binding field on
//     the record; only the pane process (fresh pid) and the state re-latch change. NO release/forget
//     call fires.
//   - kill RELEASES (the contrast, on the same recording harness): hookTokens.forget, broker.forget,
//     leases.releaseAllFor all fire — proving the harness would have caught a restart that released.
//   - refusals: unknown id, a 'killed' record, and a respawn that could not happen (no session) all
//     throw a clear message and stamp nothing.
//   - a DEAD pane (the crashed-CLI case, pane_dead=1 under remain-on-exit) is revived.
//   - live pty attachments are swept before the respawn so viewers re-attach to the fresh pane.
//
// SPEC-RESTART-RESUME — a second block below drives the claude-code resume/mint/re-seed contract:
// a restart with a sessionId whose transcript exists on disk resumes it (--resume) and reports
// resumed:true OPTIMISTICALLY, synchronously, without waiting on the detached health-check; one
// whose transcript is missing mints a brand-new id (--session-id) with NO background work at all; a
// resume the CLI still refuses — whether it dies instantly or with a short delay — is caught by the
// detached health-check and falls forward onto ANOTHER brand-new id, never a retry of the id that
// just failed; a non-claude / login / sessionId-less terminal takes the historical bare respawn
// unchanged; and a rotation always mints a fresh id (never a resume — a different account's config
// dir can never resume the old one's transcript).
//
// Every resume-path test injects a TINY health-check cap/interval (TINY_PROBE, via
// deps.resumeProbe) and asserts BEHAVIOR (fall-forward fired or not, new id minted or not, audits),
// never a real wall-clock window: production's real timing (6000ms cap / 500ms poll, comfortably
// above the MEASURED real claude 2.1.278 death time of 2.0-2.8s on a refused `--resume`, 3 trials,
// and comfortably under the reconciler's own ~15s sweep) is pinned separately and STATICALLY in
// terminal-manager-resume-probe.test.ts — a real-time race is exactly what flakes under CPU
// contention, and this suite must never depend on one. Tests that exercise the fall-forward (or
// prove its absence) await the returned `settled` promise (test-only; production never awaits it),
// which also prevents a background poller from leaking into a later test on the shared scratch socket.
//
// Driven against a real scratch tmux server (non-`ct-` socket, so no reconciler — the operator's or
// a scratch Tower's — ever sees it). Self-skips when tmux is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import type { Terminal } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-tm-restart-test-'));
process.env.CT_HOME = home;

const pexec = promisify(execFile);
const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { TerminalManager } = await import('./terminal-manager.js');
const { auditTail } = await import('./audit.js');
const tmuxMod = await import('./tmux.js');
const { SkillStore } = await import('./skills/store.js');
const { ProviderStore } = await import('./providers/store.js');
const { initProviderRegistry } = await import('./providers/registry.js');
initProviderRegistry(new ProviderStore());

const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);
const SOCK = `tmrestart-${process.pid}`; // NOT ct-* : no reconciler must ever see it

const killScratch = async (): Promise<void> => {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A live scratch pane whose recorded command is known (echo + sleep), remain-on-exit on —
 *  the exact session shape newSession leaves behind. `sleepSecs` 600 = a live pane; a short
 *  sleep lets a subtest age it into a corpse (pane_dead=1). */
async function freshSession(sleepSecs = 600): Promise<void> {
  // STAGED retry, bounded and loud: under full-suite load the kill-server → new-session pair on
  // the same socket can race the dying server ("server exited unexpectedly" — the fresh server
  // binds the socket, then exits with the old one). This is pure fixture staging, before any
  // product interaction, so re-staging here can never mask a product regression — a mid-drive
  // server death surfaces as different messages ("no server running", "error connecting") and any
  // other spawn failure still throws at once.
  // The retried unit includes set-option (the fresh server can still lose the race between the two
  // calls, wearing the same message) and re-runs with the SAME sleepSecs — a corpse fixture
  // (short sleep) re-stages as a corpse fixture, never as a live pane.
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      await pexec('tmux', ['-L', SOCK, 'new-session', '-d', '-s', 'main', '-x', '80', '-y', '24',
        `sh -c 'echo gen; sleep ${sleepSecs}'`], { timeout: 10_000 });
      await pexec('tmux', ['-L', SOCK, 'set-option', '-t', 'main', 'remain-on-exit', 'on']);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] paint attempt ${attempt} lost the fresh tmux server to the kill-server race; re-staging`);
    }
  }
}
const paneFmt = async (fmt: string): Promise<string> =>
  (await pexec('tmux', ['-L', SOCK, 'display-message', '-p', '-t', 'main', fmt])).stdout.trim();

/** A TerminalManager over a fresh store whose release-path deps RECORD every call — the
 *  preservation assertions are only meaningful because the kill contrast proves these
 *  recorders fire when a release actually happens. Everything restart/kill never touches
 *  is stubbed empty. */
function harness() {
  const store = new Store();
  const calls = { hookForget: [] as string[], brokerForget: [] as string[], leaseReleaseAll: [] as string[] };
  const deps = {
    hookTokens: { forget: (id: string) => { calls.hookForget.push(id); } },
    hookScript: '/dev/null',
    towerPort: 0,
    worktrees: {},
    accounts: {},
    broker: { forget: (id: string) => { calls.brokerForget.push(id); } },
    credentialScript: '/dev/null',
    brokerSock: '/dev/null',
    leases: { releaseAllFor: (id: string) => { calls.leaseReleaseAll.push(id); } },
    providers: {},
    skills: {},
    maxTerminals: () => 8,
  } as unknown as ConstructorParameters<typeof TerminalManager>[1];
  const tm = new TerminalManager(store, deps);
  const seed = (over: Partial<Terminal> = {}): Terminal => {
    const t: Terminal = {
      id: 'trm1', projectId: 'p1', title: 'builder', provider: 'claude-code',
      tmuxSocket: SOCK, cwd: home, command: ['sh'], state: 'idle',
      hookToken: 'tok-abc', worktreePath: '/w/x', branch: 'ct/b', baseBranch: 'main',
      createdAt: new Date().toISOString(), ...over,
    };
    store.upsertTerminal(t);
    return t;
  };
  return { store, tm, calls, seed };
}

test('restartTerminal', { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {
  await t.test('preserves the record + tokens and respawns in place; kill releases (contrast)', async () => {
    await freshSession();
    const h = harness();
    const before = h.seed();
    const pid1 = Number(await paneFmt('#{pane_pid}'));

    const { terminal: after, resumed } = await h.tm.restartTerminal('trm1');
    const pid2 = Number(await paneFmt('#{pane_pid}'));
    assert.notEqual(pid2, pid1, 'the pane process is NEW');
    assert.throws(() => process.kill(pid1, 0), 'the old process was killed by the respawn');

    // No sessionId on this record (the base seed) ⇒ the historical bare-respawn path — never resumed.
    assert.equal(resumed, false);
    // The state re-latch is the ONLY record change; every binding/credential field survives.
    assert.equal(after.state, 'working', 'an agent CLI is re-latched working (the create-time stamp)');
    assert.equal(after.hookToken, before.hookToken, 'hook token preserved');
    assert.equal(after.worktreePath, before.worktreePath, 'worktree binding preserved');
    assert.equal(after.branch, before.branch);
    assert.equal(after.baseBranch, before.baseBranch);
    assert.equal(after.tmuxSocket, before.tmuxSocket, 'same socket — the same pane respawned');
    assert.deepEqual(after.command, before.command);
    assert.equal(after.closedAt, undefined, 'never marked closed');
    assert.deepEqual(h.calls, { hookForget: [], brokerForget: [], leaseReleaseAll: [] },
      'restart releases NOTHING — no hook-token forget, no broker forget, no lease release');
    assert.ok(auditTail(50).some((e) => e.action === 'terminal.restart' && e.terminalId === 'trm1'),
      'the restart is audited');

    // CONTRAST (the mutation check for the recorders): a kill on the same harness releases all three.
    await h.tm.killTerminal('trm1');
    assert.equal(h.store.getTerminal('trm1')!.state, 'killed');
    assert.deepEqual(h.calls, { hookForget: ['trm1'], brokerForget: ['trm1'], leaseReleaseAll: ['trm1'] },
      'kill releases everything restart preserved — the recorders demonstrably fire');
  });

  await t.test('refuses an unknown terminal and a killed record', async () => {
    const h = harness();
    await assert.rejects(() => h.tm.restartTerminal('nope'), /unknown terminal/);
    h.seed({ id: 'tk', state: 'killed' });
    await assert.rejects(() => h.tm.restartTerminal('tk'), /killed/);
  });

  await t.test('a respawn that could not happen throws and stamps nothing', async () => {
    const h = harness();
    h.seed({ id: 'tg', tmuxSocket: `${SOCK}-gone` }); // no tmux server on this socket
    await assert.rejects(() => h.tm.restartTerminal('tg'), /could not respawn/);
    assert.equal(h.store.getTerminal('tg')!.state, 'idle', 'a failed respawn never re-latches state');
    assert.equal(auditTail(50).some((e) => e.action === 'terminal.restart' && e.terminalId === 'tg'), false,
      'and never audits a restart that did not happen');
  });

  await t.test('revives a DEAD pane — the crashed-CLI case', async () => {
    await freshSession(1); // the command exits after 1s; remain-on-exit leaves the corpse
    await wait(2000);
    assert.equal(await paneFmt('#{pane_dead}'), '1', 'the fixture pane is genuinely dead');
    const h = harness();
    h.seed(); // state 'idle' — a dead pane's record often still reads a live state; restart must not care
    const { resumed } = await h.tm.restartTerminal('trm1');
    assert.equal(resumed, false, 'no sessionId on this record — the bare-respawn path');
    assert.equal(await paneFmt('#{pane_dead}'), '0', 'the corpse was revived in place');
    assert.equal(h.store.getTerminal('trm1')!.state, 'working');
  });

  await t.test('sweeps live pty attachments before the respawn', async () => {
    await freshSession();
    const h = harness();
    h.seed();
    let swept = false;
    // The attachment set is private; a real attach needs node-pty + a browser socket. A recording
    // stand-in in the same slot exercises exactly the sweep (kill + map drop) restart performs.
    (h.tm as unknown as { attachments: Map<string, Set<{ pty: { kill(): void } }>> }).attachments
      .set('trm1', new Set([{ pty: { kill: () => { swept = true; } } }]));
    await h.tm.restartTerminal('trm1');
    assert.equal(swept, true, 'the viewer pty was killed so the client re-attaches to the fresh pane');
    assert.equal(
      (h.tm as unknown as { attachments: Map<string, unknown> }).attachments.has('trm1'),
      false,
      'and the attachment set was dropped',
    );
  });

  await t.test('a shell terminal re-latches idle (the create-time stamp, mirrored)', async () => {
    await freshSession();
    const h = harness();
    h.seed({ id: 'tsh', provider: 'shell', hookToken: undefined, state: 'idle' });
    const { terminal: after, resumed } = await h.tm.restartTerminal('tsh');
    assert.equal(after.state, 'idle', 'a fresh shell is immediately idle, not working');
    assert.equal(resumed, false, 'a non-claude provider never resumes');
  });
});

/** A one-element base argv (an executable script FILE, never a bare `sh -c ...` array) that records
 *  the EXTRA tokens a respawn appended as its OWN $1.. — this is deliberately NOT `['sh', '-c', ...]`:
 *  a literal `-c` token in the BASE command would collide with claudeSessionArgv's `-c`/`--continue`
 *  strip set (real claude's "continue" short flag) and get silently stripped, corrupting the fixture
 *  rather than the code under test. `failOnResume` makes the script exit(1) when the FIRST appended
 *  token is `--resume` (the "CLI still refuses this session" case), so the async fall-forward has
 *  something real to catch. `failOnResumeDelaySecs` (FIX 2) sleeps that long BEFORE exiting — a
 *  MEASURED real claude 2.1.278 dies at 2.0-2.8s under remain-on-exit, not instantly, and an
 *  instant-exit fixture alone could never catch a health-check cap that was too short to cover that. */
let scriptSeq = 0;
function recordingCommand(
  markerFile: string,
  opts: { failOnResume?: boolean; failOnResumeDelaySecs?: number } = {},
): string[] {
  const write = `printf '%s\\n' "$*" > '${markerFile}'`;
  const delay = opts.failOnResumeDelaySecs ? `sleep ${opts.failOnResumeDelaySecs}; ` : '';
  const body = opts.failOnResume
    ? `#!/bin/sh\ncase "$1" in\n--resume) ${delay}${write}; exit 1 ;;\n*) ${write}; exec sleep 600 ;;\nesac\n`
    : `#!/bin/sh\n${write}\nexec sleep 600\n`;
  const scriptFile = join(home, `record-${process.pid}-${scriptSeq++}.sh`);
  writeFileSync(scriptFile, body, 'utf8');
  chmodSync(scriptFile, 0o755);
  return [scriptFile];
}

async function waitForFile(path: string, expect: string): Promise<string> {
  // Wait until the marker shows EXACTLY `expect` (its trimmed argv). Two truncate-then-write races both
  // widen under heavy CPU load and must be waited out here:
  //   - 0-byte window: the stub's `printf '%s\n' "$*" > file` truncates before it writes, so the file
  //     can read "" for a beat. A bare respawn (empty args) still writes a lone "\n" (1 byte), so a
  //     `length > 0` guard distinguishes "not written yet" (0 bytes) from a legitimately-empty-args
  //     marker — a plain trim()==='' guard could not (a 0-byte file also trims to '').
  //   - double-write window: a fall-forward writes `--resume <id>` first, then RE-writes
  //     `--session-id <new>`; matching `trim() === expect` waits for the FINAL argv, never a stale first
  //     write. (This is why the -restart flake showed `--resume ...` where `--session-id ...` was wanted.)
  // On timeout, the last-seen content is reported so a genuine wrong-argv bug is still diagnosable (not
  // masked): it fails after the budget instead of silently. (5s budget: 50 x 100ms.)
  let last = '<never created>';
  for (let i = 0; i < 50; i++) {
    if (existsSync(path)) {
      const s = readFileSync(path, 'utf8');
      last = s;
      if (s.length > 0 && s.trim() === expect) return s;
    }
    await wait(100);
  }
  throw new Error(`marker never reached expected content: ${path} (want ${JSON.stringify(expect)}, last saw ${JSON.stringify(last)})`);
}

/** SPEC-RESTART-RESUME — the resume-attempt health-check timing every test below injects (never the
 *  real 6000ms/500ms production default): a full-suite run must not depend on a multi-second real
 *  wait to prove fall-forward BEHAVIOR, and a real wall-clock window is exactly what flakes under
 *  CPU contention. The production cap value itself is pinned separately, statically, in
 *  terminal-manager-resume-probe.test.ts. */
const TINY_PROBE = { capMs: 400, intervalMs: 50 };

/** Where this fixture places a fake transcript. FIX 3 — findClaudeTranscript scans EVERY
 *  `projects/*` subdir by session id, so the exact directory NAME is irrelevant; this deliberately
 *  does NOT reproduce claude's own cwd-derived key format (a fixed, arbitrary name), proving the
 *  lookup that restartTerminal actually runs does not depend on that format either. */
function fakeTranscriptPath(configDir: string, sessionId: string): string {
  return join(configDir, 'projects', 'fixture-key-whatever-shape', `${sessionId}.jsonl`);
}

/** A fuller harness than the preservation suite above: a real Store + a real (empty) SkillStore
 *  (so materializeSkills' plumbing runs for real) + a project record (so restartTerminal's re-seed
 *  branch actually engages) + a single fake claude-code profile with an isolated config dir.
 *  `onResumeFallForward` lets a test observe the late-bound correction hook (SPEC-RESTART-RESUME)
 *  without needing the real Loops/Mission surface. `resumeProbe` overrides watchClaudeResume's
 *  poll interval/cap — every resume-path test below injects a TINY one (production stays at the
 *  real, measured 6000ms/500ms — see RESUME_PROBE_CAP_MS): a full-suite run must never depend on a
 *  multi-second real wait to prove BEHAVIOR that a millisecond-scale one proves identically, and a
 *  real wall-clock window is exactly what flakes under load. */
function resumeHarness(opts: {
  onResumeFallForward?: (terminalId: string) => void;
  resumeProbe?: { capMs: number; intervalMs: number };
} = {}) {
  const store = new Store();
  const skills = new SkillStore();
  const profiles = new Map<string, { id: string; provider: 'claude-code'; configDir: string; label: string }>();
  const deps = {
    hookTokens: { tokenFile: (id: string) => join(home, `tok-${id}`), ensure: () => 'tok', forget: () => {} },
    hookScript: '/dev/null',
    towerPort: 0,
    worktrees: {},
    accounts: { getProfile: (id: string) => profiles.get(id) },
    broker: { forget: () => {}, ensure: () => {} },
    credentialScript: '/dev/null',
    brokerSock: '/dev/null',
    leases: { releaseAllFor: () => {} },
    providers: { get: () => undefined, hasSecret: () => false },
    skills,
    maxTerminals: () => 8,
    ...(opts.onResumeFallForward ? { onResumeFallForward: opts.onResumeFallForward } : {}),
    ...(opts.resumeProbe ? { resumeProbe: opts.resumeProbe } : {}),
  } as unknown as ConstructorParameters<typeof TerminalManager>[1];
  const tm = new TerminalManager(store, deps);
  const projectId = `pr-${Math.random().toString(36).slice(2)}`;
  const repoPath = mkdtempSync(join(home, 'repo-'));
  store.upsertProject({ id: projectId, name: 'p', repoPath, scaffoldMode: 'zero-footprint', createdAt: new Date().toISOString() });
  const addProfile = (id: string): string => {
    const configDir = mkdtempSync(join(home, `cfg-${id}-`));
    profiles.set(id, { id, provider: 'claude-code', configDir, label: id });
    return configDir;
  };
  const seed = (over: Partial<Terminal> & { command: string[] }): Terminal => {
    const t: Terminal = {
      id: 'ct1', projectId, title: 'builder', provider: 'claude-code',
      tmuxSocket: SOCK, cwd: repoPath,
      state: 'idle', createdAt: new Date().toISOString(), ...over,
    };
    store.upsertTerminal(t);
    return t;
  };
  /** Spawn the REAL scratch pane running the terminal's OWN recorded command — a bare respawn
   *  replays whatever tmux itself last recorded as the pane's creation/respawn argv, never the
   *  Terminal store's `command` field directly, so the fixture must actually create the pane with
   *  it for the bare-respawn assertions below to mean anything. */
  const spawn = async (term: Terminal): Promise<void> => {
    // STAGED retry, bounded and loud (the freshSession idiom above): under full-suite load the
    // kill-server → new-session pair on the same socket can race the dying server ("server exited
    // unexpectedly"). Pure fixture staging, before any product interaction, so it can never mask a
    // regression — any other spawn failure still throws on the first attempt.
    for (let attempt = 1; ; attempt++) {
      await killScratch();
      try {
        await tmuxMod.newSession({ socket: term.tmuxSocket, cwd: term.cwd, cols: 80, rows: 24, env: {}, command: term.command });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
        console.error(`[infra-retry] resumeHarness spawn attempt ${attempt} lost the fresh tmux server to the kill-server race; re-staging`);
      }
    }
  };
  return { store, tm, seed, spawn, addProfile, projectId, repoPath };
}

test('SPEC-RESTART-RESUME — claude-code resume / mint / re-seed / rotate', { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {
  await t.test('a transcript on disk ⇒ resumes OPTIMISTICALLY and SYNCHRONOUSLY with --resume <id>; SURVIVING the cap never falls forward', async () => {
    // Injects TINY_PROBE (400ms cap / 50ms poll) — behavior only, no real multi-second wait, and no
    // wall-clock window assertion (that is exactly what flakes under CPU contention). The production
    // cap VALUE is pinned separately, statically, in terminal-manager-resume-probe.test.ts.
    const h = resumeHarness({ resumeProbe: TINY_PROBE });
    const configDir = h.addProfile('acct-resume');
    const sessionId = 'session-with-transcript-0001';
    const marker = join(home, 'marker-resume-hit');
    const term = h.seed({ profileId: 'acct-resume', sessionId, command: recordingCommand(marker) });
    await h.spawn(term);
    const transcript = fakeTranscriptPath(configDir, sessionId);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{}\n');

    const before = Date.now();
    const { terminal, resumed, settled } = await h.tm.restartTerminal('ct1');
    // The call itself must not be held on the health-check — it returns as soon as the respawn is
    // issued, whatever the configured cap is.
    assert.ok(Date.now() - before < 300, 'restartTerminal returns immediately — it never awaits the health-check');
    assert.equal(resumed, true, 'an existing transcript resumes the same conversation, reported optimistically');
    assert.equal(terminal.sessionId, sessionId, 'the id is unchanged — nothing new was minted');
    assert.equal(terminal.state, 'working');
    assert.equal((await waitForFile(marker, `--resume ${sessionId}`)).trim(), `--resume ${sessionId}`);
    const restartEvt = auditTail(100).find((e) => e.action === 'terminal.restart' && e.terminalId === 'ct1');
    assert.deepEqual(restartEvt && { resumed: restartEvt.resumed, sessionId: restartEvt.sessionId }, { resumed: true, sessionId });

    // A live pane through the WHOLE cap must never fall forward — awaited so the negative space is
    // actually proven, not merely unobserved (and so no background poller leaks into a later test).
    assert.ok(settled, 'a resume attempt always returns an awaitable settle promise');
    await settled;
    assert.equal(h.store.getTerminal('ct1')!.sessionId, sessionId, 'still the original id — no fall-forward occurred');
    assert.equal(
      auditTail(100).some((e) => e.action === 'terminal.restart.resume-failed' && e.terminalId === 'ct1'),
      false,
      'a healthy resume is never audited as failed',
    );
  });

  await t.test('no transcript on disk ⇒ mints a fresh id and launches with --session-id <new>, with NO background work', async () => {
    const h = resumeHarness();
    h.addProfile('acct-mint');
    const oldId = 'session-missing-transcript-0002';
    const marker = join(home, 'marker-mint-hit');
    const term = h.seed({ profileId: 'acct-mint', sessionId: oldId, command: recordingCommand(marker) });
    await h.spawn(term);
    // No transcript file written for oldId — the pre-check must find it absent.

    const { terminal, resumed, settled } = await h.tm.restartTerminal('ct1');
    assert.equal(resumed, false, 'no transcript ⇒ a fresh conversation, not a resume');
    assert.notEqual(terminal.sessionId, oldId, 'a brand-new id was minted');
    assert.ok(terminal.sessionId, 'and persisted on the record');
    assert.equal((await waitForFile(marker, `--session-id ${terminal.sessionId}`)).trim(), `--session-id ${terminal.sessionId}`);
    assert.equal(settled, undefined, 'a freshly minted session starts no health-check at all — nothing to await');
  });

  await t.test('a resume the CLI refuses INSTANTLY falls forward onto ANOTHER new id — never a retry', async () => {
    const h = resumeHarness({ resumeProbe: TINY_PROBE });
    const configDir = h.addProfile('acct-resume-fail');
    const sessionId = 'session-refused-by-cli-0003';
    const marker = join(home, 'marker-fail-hit');
    const term = h.seed({
      profileId: 'acct-resume-fail', sessionId,
      command: recordingCommand(marker, { failOnResume: true }),
    });
    await h.spawn(term);
    const transcript = fakeTranscriptPath(configDir, sessionId);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{}\n');

    const { terminal, resumed, settled } = await h.tm.restartTerminal('ct1');
    // Optimistic report — the call returns before the CLI has even had a chance to exit.
    assert.equal(resumed, true, 'reported optimistically; the death is caught by the background check, not this return');
    assert.equal(terminal.sessionId, sessionId, 'not yet corrected — the fall-forward happens in the background');
    assert.ok(settled);
    await settled;

    const after = h.store.getTerminal('ct1')!;
    assert.notEqual(after.sessionId, sessionId, 'the fallback minted a BRAND-NEW id');
    assert.equal(after.state, 'working', 're-latched after the fallback respawn succeeded');
    assert.equal((await waitForFile(marker, `--session-id ${after.sessionId}`)).trim(), `--session-id ${after.sessionId}`, 'the surviving process ran the fallback argv');
    assert.ok(
      auditTail(100).some((e) => e.action === 'terminal.restart.resume-failed' && e.terminalId === 'ct1'),
      'the failed resume is audited, never silent',
    );
  });

  await t.test('FIX 2 — a resume that dies SHORTLY (not instantly) within the injected cap still falls forward', async () => {
    // The instant-exit fixture above can never prove the health-check actually POLLS rather than
    // just checking once at t=0: this fixture dies partway through the injected TINY_PROBE window
    // (well within its 400ms cap, at 8 polls of 50ms), so catching it only works if the loop keeps
    // checking. No real-time assertion — behavior only, per the flake-fix mandate: a real wall-clock
    // window (the previous version of this test asserted elapsed >= 2400ms && < 6500ms against a
    // real 2.5s sleep) is exactly what flakes under CPU contention. The production cap's real
    // MARGIN over the measured 2.0-2.8s claude death time is pinned separately and statically in
    // terminal-manager-resume-probe.test.ts — this test only needs to prove the poll-and-catch
    // mechanism itself, which is cap-scale-independent.
    const h = resumeHarness({ resumeProbe: TINY_PROBE });
    const configDir = h.addProfile('acct-resume-slow-fail');
    const sessionId = 'session-refused-slowly-0006';
    const marker = join(home, 'marker-slow-fail-hit');
    const term = h.seed({
      profileId: 'acct-resume-slow-fail', sessionId,
      command: recordingCommand(marker, { failOnResume: true, failOnResumeDelaySecs: 0.15 }),
    });
    await h.spawn(term);
    const transcript = fakeTranscriptPath(configDir, sessionId);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{}\n');

    const { resumed, settled } = await h.tm.restartTerminal('ct1');
    assert.equal(resumed, true, 'still reported optimistically at issue time');
    assert.ok(settled);
    await settled;

    const after = h.store.getTerminal('ct1')!;
    assert.notEqual(after.sessionId, sessionId, 'the fallback minted a BRAND-NEW id even against the delayed death');
    assert.equal(after.state, 'working');
    assert.equal((await waitForFile(marker, `--session-id ${after.sessionId}`)).trim(), `--session-id ${after.sessionId}`);
    assert.ok(
      auditTail(100).some((e) => e.action === 'terminal.restart.resume-failed' && e.terminalId === 'ct1'),
      'the delayed-death fall-forward is audited too',
    );
  });

  await t.test('deps.onResumeFallForward fires exactly once on a fall-forward, and never on a healthy resume', async () => {
    const calls: string[] = [];
    const h = resumeHarness({ onResumeFallForward: (terminalId) => { calls.push(terminalId); }, resumeProbe: TINY_PROBE });

    // A healthy resume: the hook must never fire, however long the health-check runs.
    const okConfigDir = h.addProfile('acct-hook-ok');
    const okSessionId = 'session-hook-ok-0007';
    const okMarker = join(home, 'marker-hook-ok');
    const okTerm = h.seed({ profileId: 'acct-hook-ok', sessionId: okSessionId, command: recordingCommand(okMarker) });
    await h.spawn(okTerm);
    const okTranscript = fakeTranscriptPath(okConfigDir, okSessionId);
    mkdirSync(dirname(okTranscript), { recursive: true });
    writeFileSync(okTranscript, '{}\n');
    const ok = await h.tm.restartTerminal('ct1');
    await ok.settled;
    assert.deepEqual(calls, [], 'no fall-forward, no hook call');

    // A refused resume: the hook fires exactly once, with the terminal id, AFTER the fall-forward
    // respawn has already landed.
    const failConfigDir = h.addProfile('acct-hook-fail');
    const failSessionId = 'session-hook-fail-0008';
    const failMarker = join(home, 'marker-hook-fail');
    const failTerm = h.seed({
      profileId: 'acct-hook-fail', sessionId: failSessionId,
      command: recordingCommand(failMarker, { failOnResume: true }),
    });
    await h.spawn(failTerm);
    const failTranscript = fakeTranscriptPath(failConfigDir, failSessionId);
    mkdirSync(dirname(failTranscript), { recursive: true });
    writeFileSync(failTranscript, '{}\n');
    const failed = await h.tm.restartTerminal('ct1');
    await failed.settled;
    assert.deepEqual(calls, ['ct1'], 'the hook fired exactly once, for the fallen-back terminal');
    assert.notEqual(h.store.getTerminal('ct1')!.sessionId, failSessionId, 'the fallback had already landed when the hook fired');
  });

  await t.test('FIX B — two OVERLAPPING restartTerminal calls: the second is a no-op, never a second respawn/watcher racing unordered sessionId patches', async () => {
    // restartTerminal's synchronous prefix — including adding to restartInFlight — runs to
    // completion before its FIRST await (adapter.writeHookConfig), so constructing this array
    // deterministically runs call A up to that await, THEN starts call B, which sees the mutex
    // already held. No artificial delay or scheduling luck required.
    const fallForwardCalls: string[] = [];
    const h = resumeHarness({ onResumeFallForward: (id) => { fallForwardCalls.push(id); }, resumeProbe: TINY_PROBE });
    const configDir = h.addProfile('acct-concurrent');
    const sessionId = 'session-concurrent-0009';
    const marker = join(home, 'marker-concurrent');
    const term = h.seed({
      profileId: 'acct-concurrent', sessionId,
      command: recordingCommand(marker, { failOnResume: true }),
    });
    await h.spawn(term);
    const transcript = fakeTranscriptPath(configDir, sessionId);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{}\n');

    // Every test in this file shares one on-disk audit log AND the terminal id 'ct1', so a raw
    // count would double-count earlier tests' resume-failed events — a BEFORE/AFTER delta isolates
    // just this test's own audits regardless of what ran before it.
    const resumeFailedCount = (): number =>
      auditTail(4000).filter((e) => e.action === 'terminal.restart.resume-failed' && e.terminalId === 'ct1').length;
    const before = resumeFailedCount();

    const [r1, r2] = await Promise.all([h.tm.restartTerminal('ct1'), h.tm.restartTerminal('ct1')]);
    assert.equal(r1.alreadyRestarting, undefined, 'the FIRST call performs the real restart');
    assert.ok(r1.settled, 'and starts exactly one watcher');
    assert.equal(r2.alreadyRestarting, true, 'the SECOND, overlapping call is a no-op');
    assert.equal(r2.settled, undefined, 'the no-op starts no watcher of its own');
    assert.equal(r2.terminal.id, 'ct1');

    await r1.settled;
    // The fixture fails on --resume, so the ONE real watcher falls forward exactly once — never
    // twice, which is what an unordered pair of concurrent fall-forwards would have produced.
    assert.deepEqual(fallForwardCalls, ['ct1'], 'onResumeFallForward fired exactly once, not twice');
    const after = h.store.getTerminal('ct1')!;
    assert.notEqual(after.sessionId, sessionId, 'a brand-new id was minted by the ONE fall-forward');
    // The recorded sessionId matches the argv the surviving process actually ran — no split-brain
    // between "what the store says" and "what the pane is actually running".
    assert.equal((await waitForFile(marker, `--session-id ${after.sessionId}`)).trim(), `--session-id ${after.sessionId}`);
    assert.equal(resumeFailedCount() - before, 1, 'exactly one NEW resume-failed audit from this test, never two');
  });

  await t.test('FIX C — restart and rotate are mutually exclusive per terminal', async (tc) => {
    await tc.test('rotateTerminal refuses while a restart/resume-watch is in flight', async () => {
      const h = resumeHarness({ resumeProbe: TINY_PROBE });
      const configDir = h.addProfile('acct-fixc-from');
      const targetConfigDir = h.addProfile('acct-fixc-to');
      writeFileSync(join(targetConfigDir, '.credentials.json'), '{}\n'); // the target must read signed-in
      const sessionId = 'session-fixc-restart-0010';
      const marker = join(home, 'marker-fixc-restart');
      const term = h.seed({ profileId: 'acct-fixc-from', sessionId, command: recordingCommand(marker) });
      await h.spawn(term);
      const transcript = fakeTranscriptPath(configDir, sessionId);
      mkdirSync(dirname(transcript), { recursive: true });
      writeFileSync(transcript, '{}\n');

      // The resume path returns fast but keeps the watcher (and the flag) alive for the WHOLE
      // TINY_PROBE window — a real window in which a naive rotate could otherwise double-respawn.
      const restart = await h.tm.restartTerminal('ct1');
      assert.ok(restart.settled, 'the watcher is running');
      await assert.rejects(
        () => h.tm.rotateTerminal('ct1', 'acct-fixc-to'),
        /restart is in progress/,
        'a rotate while the resume-watch is in flight is refused outright — never a stray double-respawn',
      );
      await restart.settled; // drain the watcher before the harness/pane is torn down
    });

    await tc.test('restartTerminal is a no-op while a rotate is in flight — never a stray double-respawn', async () => {
      const h = resumeHarness();
      h.addProfile('acct-fixc2-from');
      const targetConfigDir = h.addProfile('acct-fixc2-to');
      writeFileSync(join(targetConfigDir, '.credentials.json'), '{}\n');
      const marker = join(home, 'marker-fixc2');
      const term = h.seed({ profileId: 'acct-fixc2-from', sessionId: 'session-fixc2-0011', command: recordingCommand(marker) });
      await h.spawn(term);

      // rotateTerminal's own synchronous prefix (including adding to `rotating`) runs to completion
      // before its first await, exactly like restartTerminal's — so this array is deterministic too.
      const [rotated, restarted] = await Promise.all([
        h.tm.rotateTerminal('ct1', 'acct-fixc2-to'),
        h.tm.restartTerminal('ct1'),
      ]);
      assert.equal(restarted.alreadyRestarting, true, 'restart is a no-op while the rotate owns the terminal');
      assert.equal(restarted.settled, undefined);
      assert.equal(rotated.profileId, 'acct-fixc2-to', 'the rotate completed normally, unaffected by the racing restart');
      // Only ONE respawn happened (the rotate's): the marker shows exactly its fresh id, never a
      // second, unrelated respawn racing it in from the no-op restart.
      assert.equal((await waitForFile(marker, `--session-id ${rotated.sessionId}`)).trim(), `--session-id ${rotated.sessionId}`);
    });
  });

  await t.test('a claude-code terminal with NO sessionId (pre-wave record) takes the historical bare respawn', async () => {
    const h = resumeHarness();
    const marker = join(home, 'marker-no-sid');
    const term = h.seed({ command: recordingCommand(marker) }); // no profileId, no sessionId
    await h.spawn(term);

    const { resumed } = await h.tm.restartTerminal('ct1');
    assert.equal(resumed, false);
    // A bare respawn replays the ORIGINAL creation argv verbatim (no appended flags) — "$@" is empty.
    assert.equal((await waitForFile(marker, '')).trim(), '');
  });

  await t.test('a codex terminal never resumes, whatever its sessionId — the bare respawn, unaffected', async () => {
    const h = resumeHarness();
    const marker = join(home, 'marker-codex');
    const term = h.seed({ provider: 'codex', sessionId: 'irrelevant-for-codex', command: recordingCommand(marker) });
    await h.spawn(term);

    const { terminal, resumed } = await h.tm.restartTerminal('ct1');
    assert.equal(resumed, false);
    assert.equal(terminal.sessionId, 'irrelevant-for-codex', 'untouched — codex never threads a session');
    assert.equal((await waitForFile(marker, '')).trim(), '', 'the bare respawn carries no session flag');
  });

  await t.test('a login pane never resumes, whatever its sessionId', async () => {
    const h = resumeHarness();
    const marker = join(home, 'marker-login');
    const term = h.seed({ purpose: 'login', sessionId: 'irrelevant-for-login', command: recordingCommand(marker) });
    await h.spawn(term);

    const { resumed } = await h.tm.restartTerminal('ct1');
    assert.equal(resumed, false);
    assert.equal((await waitForFile(marker, '')).trim(), '', 'a login pane takes the bare respawn, no session flag ever threaded');
  });

  await t.test('rotateTerminal always mints a fresh id (--session-id, never --resume)', async () => {
    const h = resumeHarness();
    h.addProfile('acct-rotate-from');
    const toConfigDir = h.addProfile('acct-rotate-to');
    writeFileSync(join(toConfigDir, '.credentials.json'), '{}\n'); // the target must read signed-in
    const oldId = 'session-before-rotate-0004';
    const marker = join(home, 'marker-rotate');
    const term = h.seed({ profileId: 'acct-rotate-from', sessionId: oldId, command: recordingCommand(marker) });
    await h.spawn(term);

    const after = await h.tm.rotateTerminal('ct1', 'acct-rotate-to');
    assert.equal(after.profileId, 'acct-rotate-to');
    assert.equal(after.rotatingFrom, undefined, 'the transient marker is cleared on success');
    assert.notEqual(after.sessionId, oldId, 'a rotation NEVER resumes the old account\'s transcript — always a fresh id');
    assert.equal(after.state, 'working');
    assert.equal((await waitForFile(marker, `--session-id ${after.sessionId}`)).trim(), `--session-id ${after.sessionId}`);
    assert.ok(
      auditTail(100).some((e) => e.action === 'terminal.rotate' && e.terminalId === 'ct1' && e.sessionId === after.sessionId),
      'the rotate audit carries the new session id',
    );
  });

  await t.test('SPEC-RESTART W2 — re-seeding on restart is idempotent: two consecutive restarts leave ONE clean hook/trust state', async () => {
    // The claude-onboarding.test.ts contract, exercised via restartTerminal instead of a fresh
    // spawn: hasCompletedOnboarding + the cwd's trust entry must land clean on the FIRST restart's
    // re-seed and stay byte-for-byte identical (never duplicated, never a second cwd entry) after a
    // SECOND restart re-seeds the SAME dir again. TINY_PROBE keeps both awaited `settled`s fast.
    const h = resumeHarness({ resumeProbe: TINY_PROBE });
    const configDir = h.addProfile('acct-idem');
    const sessionId = 'session-idempotent-0005';
    const marker = join(home, 'marker-idem');
    const term = h.seed({ profileId: 'acct-idem', sessionId, command: recordingCommand(marker) });
    await h.spawn(term);
    const transcript = fakeTranscriptPath(configDir, sessionId);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{}\n');

    const stateFile = join(configDir, '.claude.json');
    const settingsFile = join(configDir, 'settings.json');
    const readState = (): Record<string, unknown> => JSON.parse(readFileSync(stateFile, 'utf8'));
    const readSettings = (): Record<string, unknown> => JSON.parse(readFileSync(settingsFile, 'utf8'));

    // Both restarts resume a live pane (never dying), so both start a background health-check —
    // AWAITED here (test-isolation, not just thoroughness): SOCK is reused by every test in this
    // file, and an un-awaited checker left running into a LATER test could observe that test's own
    // pane and act on it.
    const r1 = await h.tm.restartTerminal('ct1');
    await r1.settled;
    const stateAfter1 = readState();
    const settingsAfter1 = readSettings();
    assert.equal(stateAfter1.hasCompletedOnboarding, true);
    assert.deepEqual(
      (stateAfter1.projects as Record<string, unknown>)[h.repoPath],
      { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      'the cwd is registered trusted after the first restart',
    );
    assert.equal(Object.keys(stateAfter1.projects as Record<string, unknown>).length, 1, 'exactly one trusted folder');

    // The pane the first restart left behind is still resumable (same sessionId, same transcript) —
    // a second restart re-seeds the SAME configDir a second time.
    const r2 = await h.tm.restartTerminal('ct1');
    await r2.settled;
    const stateAfter2 = readState();
    const settingsAfter2 = readSettings();
    assert.deepEqual(stateAfter2, stateAfter1, 'the SECOND re-seed leaves the trust/onboarding state byte-identical — no duplication');
    assert.deepEqual(settingsAfter2, settingsAfter1, 'and the hook config is unchanged too');
    assert.equal(Object.keys(stateAfter2.projects as Record<string, unknown>).length, 1, 'still exactly one trusted folder, not two');
  });
});

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`) : `/tmp/tmux-${uid}`;
  rmSync(join(dir, SOCK), { force: true });
});

test.after(async () => {
  await killScratch();
});
