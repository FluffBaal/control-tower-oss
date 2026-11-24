// SPEC-RUNWAY live swap -- the proper-lockfile-compatible dir lock: acquire/release, busy timeout,
// stale takeover, all-or-nothing acquisition, result passthrough, release-on-throw. Pure fs on tmp dirs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, statSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withClaudeOauthLocks, ClaudeLockBusyError } from './runway/claude-lock.js';

const fresh = (): { dir: string; l1: string; l2: string; l3: string; l4: string } => {
  const dir = join(mkdtempSync(join(tmpdir(), 'claude-lock-')), 'cfg');
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    l1: join(dir, '.oauth_refresh.lock'),
    l2: `${realpathSync(dir)}.lock`,
    l3: join(dir, '.claude.json.lock'),
    l4: join(dir, '.storage-write.lock'),
  };
};

test('withClaudeOauthLocks: holds all locks during fn, removes them after, returns the result', async () => {
  const { dir, l1, l2, l3, l4 } = fresh();
  const out = await withClaudeOauthLocks(dir, () => {
    assert.ok(existsSync(l1) && existsSync(l2) && existsSync(l3) && existsSync(l4));
    return 42;
  });
  assert.equal(out, 42);
  assert.ok(!existsSync(l1) && !existsSync(l2) && !existsSync(l3) && !existsSync(l4));
});

test('withClaudeOauthLocks: a concurrent acquire times out with ClaudeLockBusyError (ELOCKED)', async () => {
  const { dir } = fresh();
  await withClaudeOauthLocks(dir, async () => {
    await assert.rejects(
      () => withClaudeOauthLocks(dir, () => 1, { timeoutMs: 150 }),
      (e: unknown) => e instanceof ClaudeLockBusyError && (e as ClaudeLockBusyError).code === 'ELOCKED',
    );
  });
});

test('withClaudeOauthLocks: a stale lock dir is taken over', async () => {
  const { dir, l1 } = fresh();
  mkdirSync(l1);
  const old = new Date(Date.now() - 120_000);
  utimesSync(l1, old, old);
  let ran = false;
  await withClaudeOauthLocks(dir, () => {
    ran = true;
  });
  assert.ok(ran);
  assert.ok(!existsSync(l1));
});

test('withClaudeOauthLocks: all-or-nothing -- a held 2nd lock releases the 1st', async () => {
  const { dir, l1, l2 } = fresh();
  mkdirSync(l2); // fresh mtime => not stale
  await assert.rejects(() => withClaudeOauthLocks(dir, () => 1, { timeoutMs: 150 }), ClaudeLockBusyError);
  assert.ok(!existsSync(l1), 'first lock must not survive the failed attempt');
  assert.ok(existsSync(l2), 'the foreign lock is untouched');
});

test('withClaudeOauthLocks: all-or-nothing -- a held 3rd lock releases the first two', async () => {
  const { dir, l1, l2, l3 } = fresh();
  mkdirSync(l3); // fresh mtime => not stale; l1 and l2 acquire, l3 blocks
  await assert.rejects(() => withClaudeOauthLocks(dir, () => 1, { timeoutMs: 150 }), ClaudeLockBusyError);
  assert.ok(!existsSync(l1) && !existsSync(l2), 'the first two locks must not survive the failed attempt');
  assert.ok(existsSync(l3), 'the foreign lock is untouched');
});

test('withClaudeOauthLocks: fn throwing still releases all locks', async () => {
  const { dir, l1, l2, l3, l4 } = fresh();
  await assert.rejects(
    () =>
      withClaudeOauthLocks(dir, () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.ok(!existsSync(l1) && !existsSync(l2) && !existsSync(l3) && !existsSync(l4));
});

test('withClaudeOauthLocks: the mtime heartbeat keeps a held lock fresh (not a no-op)', async () => {
  const { dir, l1 } = fresh();
  // staleMs small, refreshMs smaller: without the heartbeat the held lock would look stale within ~30ms.
  await withClaudeOauthLocks(
    dir,
    async () => {
      const first = statSync(l1).mtimeMs;
      await new Promise((r) => setTimeout(r, 120)); // several refresh ticks
      assert.ok(statSync(l1).mtimeMs > first, 'heartbeat advanced the held lock mtime');
    },
    { staleMs: 30, refreshMs: 20, timeoutMs: 1000 },
  );
});
