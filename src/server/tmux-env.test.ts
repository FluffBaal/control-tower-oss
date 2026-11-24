// serverSpawnEnv — the env a new tmux SERVER inherits. The Tower runs under NODE_ENV=production
// (sidecar dist + origin tightening), but a pane inherits the server's env, and an inherited
// NODE_ENV=production makes an agent's `npm install` skip devDependencies. serverSpawnEnv drops ONLY
// NODE_ENV and leaves everything else untouched, so a pane's base env matches a normal login shell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverSpawnEnv } from './tmux.js';

test('serverSpawnEnv drops NODE_ENV and preserves every other var', () => {
  const out = serverSpawnEnv({ NODE_ENV: 'production', PATH: '/usr/bin', HOME: '/home/x', FOO: 'bar' });
  assert.equal('NODE_ENV' in out, false, 'NODE_ENV must be absent — a pane must not inherit the Tower production flag');
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/home/x');
  assert.equal(out.FOO, 'bar');
});

test('serverSpawnEnv is a non-mutating copy of the base env', () => {
  const base = { NODE_ENV: 'production', KEEP: '1' };
  const out = serverSpawnEnv(base);
  assert.equal(base.NODE_ENV, 'production', 'the base object must not be mutated');
  assert.notEqual(out, base, 'returns a fresh object, not the same reference');
});

test('serverSpawnEnv is a no-op (copy) when NODE_ENV is already absent', () => {
  const out = serverSpawnEnv({ PATH: '/bin' });
  assert.equal('NODE_ENV' in out, false);
  assert.equal(out.PATH, '/bin');
});
