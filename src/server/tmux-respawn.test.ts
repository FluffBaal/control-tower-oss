// SPEC-RESTART W0 — respawnPane's argv contract, driven against a real scratch tmux server (a
// non-`ct-` socket, so no reconciler ever sees it):
//   - opts.argv is exec'd directly in place of the pane's process (no shell wrapping);
//   - opts.cwd sets the respawned pane's working directory;
//   - omitting opts is byte-identical to the historical bare call: a FOLLOWING bare respawnPane
//     replays whatever argv was LAST given to respawn-pane, never the original creation argv. This
//     pins the rotation hazard a caller that rewrites argv on respawn (a claude resume/rotate) must
//     account for: an unrelated later bare respawn on the same pane silently repeats the last
//     rewrite, not a fresh default.
// Self-skips when tmux is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const { newSession, respawnPane, capturePlain, killServer } = await import('./tmux.js');

const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);
const SOCK = `tmrespawn-${process.pid}`; // NOT ct-* : no reconciler must ever see it
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const paneFmt = async (fmt: string): Promise<string> =>
  (await pexec('tmux', ['-L', SOCK, 'display-message', '-p', '-t', 'main', fmt])).stdout.trim();
const killScratch = async (): Promise<void> => {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
};

/** Stage a fresh scratch session, retrying a bounded number of times on ONE specific transient:
 *  under full-suite load tmux's own server startup can intermittently fail ("server exited
 *  unexpectedly" — the fresh server binds the socket, then dies) with no product interaction
 *  involved at all, so re-staging here can never mask a regression in respawnPane/newSession
 *  itself. Any other failure (including a real assertion downstream) still throws at once. Mirrors
 *  the established staged-retry shape used for the same transient in reconciler.test.ts et al. */
async function stageScratchSession(opts: Parameters<typeof newSession>[0]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      await newSession(opts);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] scratch tmux attempt ${attempt} hit a transient server-startup failure under load; retrying`);
    }
  }
}

async function waitFor(pattern: RegExp): Promise<string> {
  let out = '';
  for (let i = 0; i < 50; i++) {
    out = await capturePlain(SOCK);
    if (pattern.test(out)) return out;
    await wait(100);
  }
  return out;
}

test('respawnPane argv contract', { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {
  await t.test('an argv respawn runs the GIVEN command; a following bare respawn REPLAYS it (not the creation argv)', async () => {
    await stageScratchSession({
      socket: SOCK, cwd: process.cwd(), cols: 80, rows: 24, env: {},
      command: ['sh', '-c', 'echo CREATE-MARKER; sleep 600'],
    });
    const pid0 = Number(await paneFmt('#{pane_pid}'));
    assert.match(await waitFor(/CREATE-MARKER/), /CREATE-MARKER/, 'the pane ran the CREATION argv');

    assert.equal(await respawnPane(SOCK, { argv: ['sh', '-c', 'echo RESPAWN-ARGV-ONE; sleep 600'] }), true);
    const pid1 = Number(await paneFmt('#{pane_pid}'));
    assert.notEqual(pid1, pid0, 'a new process');
    assert.match(await waitFor(/RESPAWN-ARGV-ONE/), /RESPAWN-ARGV-ONE/, 'the pane ran the RESPAWNED argv');

    // A following BARE respawn (today's exact call shape, no opts) must replay the LAST-recorded
    // argv (RESPAWN-ARGV-ONE), never the original creation command and never a blank default.
    assert.equal(await respawnPane(SOCK), true);
    const pid2 = Number(await paneFmt('#{pane_pid}'));
    assert.notEqual(pid2, pid1, 'a new process again');
    assert.match(await waitFor(/RESPAWN-ARGV-ONE/), /RESPAWN-ARGV-ONE/, 'the bare respawn replayed the SAME last-respawned argv');
  });

  await t.test('opts.cwd sets the respawned pane\'s working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-tmux-respawn-cwd-'));
    try {
      await stageScratchSession({
        socket: SOCK, cwd: process.cwd(), cols: 80, rows: 24, env: {},
        command: ['sh', '-c', 'sleep 600'],
      });
      assert.equal(await respawnPane(SOCK, { argv: ['sh', '-c', 'sleep 600'], cwd: dir }), true);
      // tmux resolves symlinks (e.g. macOS /tmp -> /private/tmp); compare the resolved path.
      const { stdout } = await pexec('sh', ['-c', `cd "${dir}" && pwd -P`]);
      assert.equal(await paneFmt('#{pane_current_path}'), stdout.trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('opts omitted is byte-identical to the historical bare call (no -c, no argv)', async () => {
    await stageScratchSession({
      socket: SOCK, cwd: process.cwd(), cols: 80, rows: 24, env: {},
      command: ['sh', '-c', 'echo BARE-MARKER; sleep 600'],
    });
    assert.equal(await respawnPane(SOCK), true);
    assert.match(await waitFor(/BARE-MARKER/), /BARE-MARKER/, 'a bare respawn (no opts) replays the recorded creation argv unchanged');
  });
});

process.on('exit', () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`) : `/tmp/tmux-${uid}`;
  rmSync(join(dir, SOCK), { force: true });
});

test.after(async () => {
  await killScratch();
});
