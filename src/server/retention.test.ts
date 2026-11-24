// SPEC-TERMINAL-OPS §4.4 — the two guards around the retention sweep's terminal-reap hook. Both are
// of the silent-permanent-disable class: if either fails open, the reaper either kills the same
// terminals twice or stops running entirely, with no gate and no log to notice it by.
//   - re-entrancy: the reap is the only ASYNC step in a synchronous sweep and awaits a tmux kill per
//     terminal, so a slow one can outlive the 10-minute interval and overlap the next sweep;
//   - the flag must be released on EVERY exit path — resolve, reject, and a synchronous throw. The
//     hook is pluggable; a sync throw would otherwise escape into the interval callback with the flag
//     stuck true and the reaper would be dead for the life of the process.
// The reap-hook guards below are one focus; the other fs sweep steps (log/audit rotation, run/report/
// event GC) are left to their own tests and here just run against a scratch CT_HOME finding nothing.
// The memory-history GC (gcMemoryHistory) is the exception — its rotation is covered directly below.
//
// CT_HOME is set before the module loads: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-retention-test-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { Retention, gcMemoryHistory } = await import('./retention.js');

/** Let the microtask queue drain so a settled hook's .finally() has released the flag. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

test('the reap hook never overlaps itself', async (t) => {
  const r = new Retention();
  let starts = 0;
  let inFlight = 0;
  let overlapped = false;
  let release: (() => void) | undefined;
  r.setHooks({
    reapTerminals: async () => {
      starts++;
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise<void>((res) => { release = res; });
      inFlight--;
    },
  });

  await t.test('sweeps during a hung reap do not start a second one', async () => {
    r.sweep();
    r.sweep();
    r.sweep();
    await settle();
    assert.equal(starts, 1);
    assert.equal(overlapped, false);
  });

  await t.test('once the reap settles, the next sweep runs it again', async () => {
    release?.();
    await settle();
    r.sweep();
    await settle();
    assert.equal(starts, 2);
    release?.();
    await settle();
  });

  r.stop();
});

test('the in-flight flag is released on every exit path', async (t) => {
  await t.test('a REJECTING reap does not disable the reaper', async () => {
    const r = new Retention();
    let starts = 0;
    r.setHooks({ reapTerminals: async () => { starts++; throw new Error('async boom'); } });
    r.sweep();
    await settle();
    r.sweep();
    await settle();
    assert.equal(starts, 2, 'the second sweep must still reach the hook');
    r.stop();
  });

  await t.test('a SYNCHRONOUSLY throwing reap does not disable the reaper forever', async () => {
    // The cardinal case: without the try/catch the throw escapes sweep() into the interval callback
    // with the flag still set, and the reaper never runs again — silently, for the whole process.
    // The cast is the point of the test: the declared type cannot express this, but a pluggable hook can.
    const r = new Retention();
    let starts = 0;
    r.setHooks({
      reapTerminals: (() => { starts++; throw new Error('sync boom'); }) as unknown as () => Promise<void>,
    });
    r.sweep();
    await settle();
    r.sweep();
    await settle();
    assert.equal(starts, 2, 'the second sweep must still reach the hook');
    r.stop();
  });

  await t.test('a sweep with no hook wired is a no-op, and a hook set later still runs', async () => {
    const r = new Retention();
    r.sweep(); // the boot sweep runs before setHooks in server.ts — it must not throw
    let starts = 0;
    r.setHooks({ reapTerminals: async () => { starts++; } });
    r.sweep();
    await settle();
    assert.equal(starts, 1);
    r.stop();
  });
});

test('gcMemoryHistory rotates an oversized history.jsonl (0600), never touching entries or archives', () => {
  const pdir = join(paths.memory, 'proj1');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, 'entries.json'), '{"version":1,"seq":1,"entries":[]}');
  writeFileSync(join(pdir, 'decisions.md.imported-123'), 'legacy original bytes');
  writeFileSync(join(pdir, 'entries.rejected-456.json'), '[{"bad":true}]');
  writeFileSync(join(pdir, 'history.jsonl'), 'x'.repeat(200), { mode: 0o644 }); // loose on purpose

  gcMemoryHistory(100); // small cap trips rotation without writing 4MB

  assert.equal(existsSync(join(pdir, 'history.jsonl')), false, 'the over-cap history was rotated away');
  assert.equal(existsSync(join(pdir, 'history.jsonl.1')), true, 'exactly one generation is kept');
  assert.equal(readFileSync(join(pdir, 'history.jsonl.1'), 'utf8'), 'x'.repeat(200), 'the generation holds the rotated bytes');
  // chmod-first is load-bearing: a pre-existing loose file must ship into .1 as 0600, not world-readable.
  assert.equal(statSync(join(pdir, 'history.jsonl.1')).mode & 0o777, 0o600, 'the rotated generation is tightened to 0600');
  assert.equal(existsSync(join(pdir, 'entries.json')), true, 'the source of truth is never touched');
  assert.equal(readFileSync(join(pdir, 'decisions.md.imported-123'), 'utf8'), 'legacy original bytes', 'the legacy archive is byte-untouched');
  assert.equal(existsSync(join(pdir, 'entries.rejected-456.json')), true, 'the salvage copy is never touched');

  // A second rotation REPLACES the one prior generation — never accumulates .2/.3…
  writeFileSync(join(pdir, 'history.jsonl'), 'y'.repeat(200));
  gcMemoryHistory(100);
  assert.equal(readFileSync(join(pdir, 'history.jsonl.1'), 'utf8'), 'y'.repeat(200), 'the prior generation is overwritten, not stacked');
  assert.equal(existsSync(join(pdir, 'history.jsonl.2')), false, 'no second generation accumulates');

  // An under-cap history is left in place (the store recreates a fresh 0600 log on the next append).
  writeFileSync(join(pdir, 'history.jsonl'), 'small'); // lands 0644 under umask 022
  gcMemoryHistory(100);
  assert.equal(existsSync(join(pdir, 'history.jsonl')), true, 'an under-cap history is left in place');
  // chmod-first is unconditional: an under-cap file is still tightened in place, so a pre-existing loose
  // one does not stay world-readable until it happens to cross the cap. Guards a future refactor that
  // moves the chmod inside the size check.
  assert.equal(statSync(join(pdir, 'history.jsonl')).mode & 0o777, 0o600, 'the under-cap history is tightened to 0600 in place');
});

test('gcMemoryHistory ignores a stray non-directory entry and an empty project dir', () => {
  writeFileSync(join(paths.memory, 'stray'), 'not a project dir'); // <stray>/history.jsonl is ENOTDIR
  mkdirSync(join(paths.memory, 'proj2'), { recursive: true }); // an empty project dir, no history yet
  assert.doesNotThrow(() => gcMemoryHistory(100));
  assert.equal(readFileSync(join(paths.memory, 'stray'), 'utf8'), 'not a project dir', 'the stray file is untouched');
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
