// The safety-critical scoping behind the orphan-tmux reap (#4): a terminal record DROPPED by schema
// validation on load has its tmuxSocket captured in droppedTerminalSockets() — so the reconciler can
// reap its leaked tmux server — while a VALID (loaded) record's socket is NOT captured. The reap must
// only ever touch sockets from THIS store's own file, never another Tower's machine-global ct-* socket
// (the cross-Tower footgun that reverted the first, blanket reap attempt).
//
// CT_HOME is set before the module loads: paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-dropped-sockets-'));
process.env.CT_HOME = home;

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');

test('a dropped terminal record\'s socket is reap-eligible; a valid record\'s (and a stranger\'s) is not', () => {
  const valid = {
    id: 'good',
    projectId: 'p1',
    title: 't',
    provider: 'shell',
    tmuxSocket: 'ct-good',
    cwd: '/tmp',
    command: [],
    state: 'idle',
    createdAt: '2026-07-01T00:00:00.000Z',
  };
  // Invalid (a bad state enum) but still carrying a tmuxSocket — exactly the orphan case: the record is
  // dropped on load yet its tmux server may still be running.
  const invalid = { id: 'bad', tmuxSocket: 'ct-bad', state: 'not-a-real-state', projectId: 'p1' };
  writeFileSync(paths.terminals, JSON.stringify([valid, invalid]));

  const dropped = new Store().droppedTerminalSockets();
  assert.equal(dropped.has('ct-bad'), true, 'the dropped record\'s socket IS reap-eligible');
  assert.equal(dropped.has('ct-good'), false, 'a valid, loaded record\'s socket is NEVER reap-eligible');
  assert.equal(dropped.has('ct-some-other-tower'), false, 'a socket never in our file is never eligible');
});

test('garbage-shaped dropped elements never crash or capture a bogus socket', () => {
  writeFileSync(
    paths.terminals,
    JSON.stringify([
      null,
      ['not', 'an', 'object'],
      42,
      { id: 'a', tmuxSocket: 123 }, // wrong type
      { id: 'b', tmuxSocket: '' }, // empty string
      { id: 'c', state: 'bogus' }, // no tmuxSocket at all
      { id: 'd', tmuxSocket: 'ct-real', state: 'bogus' }, // the one genuine capture
    ]),
  );
  const dropped = new Store().droppedTerminalSockets();
  assert.deepEqual([...dropped], ['ct-real'], 'only a genuine non-empty string socket is captured');
});

test('no dropped records → an empty reap-eligible set', () => {
  const valid = {
    id: 'only',
    projectId: 'p1',
    title: 't',
    provider: 'shell',
    tmuxSocket: 'ct-only',
    cwd: '/tmp',
    command: [],
    state: 'idle',
    createdAt: '2026-07-01T00:00:00.000Z',
  };
  writeFileSync(paths.terminals, JSON.stringify([valid]));
  assert.equal(new Store().droppedTerminalSockets().size, 0);
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
