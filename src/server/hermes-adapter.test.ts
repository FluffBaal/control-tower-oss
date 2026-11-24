// The Hermes adapter: HERMES_HOME isolation, the --model flag, and the config.yaml hook wiring — the
// load-bearing parts of a driven-agent integration. The upsertHooksBlock helper is pure and gets the
// bulk of the coverage (it must never clobber an operator's other config.yaml keys while replacing the
// hooks block).
//
// CT_HOME is set before the module loads: paths.ts freezes it at import time (some transitively-imported
// module reads it), matching the suite convention.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-hermes-test-'));
process.env.CT_HOME = home;

const { hermesAdapter, upsertHooksBlock } = await import('./adapters/hermes.js');

const ctx = (o: Record<string, unknown> = {}) => ({
  terminalId: 't1',
  projectId: 'p1',
  cwd: '/tmp',
  repoPath: '/tmp',
  hookTokenFile: '/tok',
  hookScript: '/home/x/.ct/bin/ct-hook',
  towerPort: 4870,
  spoolDir: '/spool',
  configDir: join(home, 'cfg'),
  ...o,
}) as never;

test('buildCommand binds --model (provider-qualified slug) and omits it when unset', () => {
  assert.deepEqual(hermesAdapter.buildCommand(ctx({ model: 'openrouter/anthropic/claude-sonnet-4.6' })), [
    'hermes',
    '--model',
    'openrouter/anthropic/claude-sonnet-4.6',
  ]);
  assert.deepEqual(hermesAdapter.buildCommand(ctx()), ['hermes']);
});

test('buildEnv isolates HERMES_HOME to the config dir and grants non-interactive hook consent', () => {
  const env = hermesAdapter.buildEnv(ctx({ configDir: '/accounts/hermes/acct-1' }));
  assert.equal(env.HERMES_HOME, '/accounts/hermes/acct-1');
  assert.equal(env.HERMES_ACCEPT_HOOKS, '1');
  assert.equal(env.TOWER_TERMINAL_ID, 't1');
});

test('writeHookConfig writes the ct-hook wiring into config.yaml and returns the bindings', async () => {
  const dir = join(home, 'wh');
  const bindings = await hermesAdapter.writeHookConfig(ctx({ configDir: dir }));
  const yaml = readFileSync(join(dir, 'config.yaml'), 'utf8');
  assert.match(yaml, /on_session_end:\s*\n\s*- command: "\/home\/x\/\.ct\/bin\/ct-hook turn-done"/);
  assert.match(yaml, /on_session_start:\s*\n\s*- command: "\/home\/x\/\.ct\/bin\/ct-hook session-start"/);
  assert.deepEqual(bindings.map((b) => b.signal).sort(), ['session-start', 'turn-done']);
});

test('writeHookConfig preserves an operator config.yaml and is idempotent', async () => {
  const dir = join(home, 'merge');
  const file = join(dir, 'config.yaml');
  await hermesAdapter.writeHookConfig(ctx({ configDir: dir })); // create dir + initial hooks
  // Operator adds their own keys and a stale hooks block.
  writeFileSync(file, 'model:\n  provider: openrouter\n  name: anthropic/claude\nhooks:\n  on_session_end:\n    - command: "STALE"\ntelemetry: false\n');
  await hermesAdapter.writeHookConfig(ctx({ configDir: dir }));
  const yaml = readFileSync(file, 'utf8');
  assert.match(yaml, /model:\n {2}provider: openrouter/, 'operator model config preserved');
  assert.match(yaml, /telemetry: false/, 'trailing operator key preserved');
  assert.doesNotMatch(yaml, /STALE/, 'the stale hooks block was replaced, not duplicated');
  assert.equal((yaml.match(/^hooks:/gm) ?? []).length, 1, 'exactly one hooks block (no duplicate key)');
});

// --- upsertHooksBlock (pure) ---
const BLOCK = 'hooks:\n  on_session_end:\n    - command: "X"';

test('upsertHooksBlock appends to an empty or hooks-less file', () => {
  assert.equal(upsertHooksBlock('', BLOCK), `${BLOCK}\n`);
  assert.equal(upsertHooksBlock('model: x\n', BLOCK), `model: x\n${BLOCK}\n`);
});

test('upsertHooksBlock replaces an existing hooks block, keeping keys before AND after it', () => {
  const before = 'model: x\nhooks:\n  on_session_end:\n    - command: "OLD"\n  on_session_start:\n    - command: "OLD2"\ntelemetry: false\n';
  const out = upsertHooksBlock(before, BLOCK);
  assert.doesNotMatch(out, /OLD/, 'old hooks gone');
  assert.match(out, /^model: x$/m);
  assert.match(out, /^telemetry: false$/m, 'the key AFTER the hooks block survives');
  assert.equal((out.match(/^hooks:/gm) ?? []).length, 1);
});

test('upsertHooksBlock preserves a column-0 comment annotating the next key', () => {
  const before = 'hooks:\n  on_session_end:\n    - command: "OLD"\n# a comment for telemetry\ntelemetry: false\n';
  const out = upsertHooksBlock(before, BLOCK);
  assert.match(out, /# a comment for telemetry/, 'the top-level comment for the NEXT key is not swallowed');
  assert.match(out, /^telemetry: false$/m);
  assert.doesNotMatch(out, /OLD/);
  assert.equal((out.match(/^hooks:/gm) ?? []).length, 1);
});

test('upsertHooksBlock: a column-0 comment INSIDE the hooks region does not orphan a child', () => {
  // A comment sandwiched between two hooks children must not split the block and leave an orphaned
  // indented child under a duplicate `hooks:` mapping (whose stale content would win under YAML
  // last-key-wins). The whole region through the last child is replaced.
  const before = 'hooks:\n  on_session_end:\n    - command: "OLD-END"\n# note about start\n  on_session_start:\n    - command: "OLD-START"\ntelemetry: false\n';
  const out = upsertHooksBlock(before, BLOCK);
  assert.doesNotMatch(out, /OLD-START/, 'the orphaned child is not left behind');
  assert.doesNotMatch(out, /OLD-END/);
  assert.doesNotMatch(out, /on_session_start/, 'no stale duplicate child survives');
  assert.match(out, /^telemetry: false$/m, 'the next top-level key survives');
  assert.equal((out.match(/^hooks:/gm) ?? []).length, 1);
  assert.equal((out.match(/on_session_end:/g) ?? []).length, 1);
});

test('upsertHooksBlock handles a hooks block at end-of-file', () => {
  const before = 'model: x\nhooks:\n  on_session_end:\n    - command: "OLD"\n';
  const out = upsertHooksBlock(before, BLOCK);
  assert.doesNotMatch(out, /OLD/);
  assert.match(out, /^model: x$/m);
  assert.equal((out.match(/^hooks:/gm) ?? []).length, 1);
});

test('the config dir is created by writeHookConfig even when absent', async () => {
  const dir = join(home, 'fresh-dir-xyz');
  assert.equal(existsSync(dir), false);
  await hermesAdapter.writeHookConfig(ctx({ configDir: dir }));
  assert.equal(existsSync(join(dir, 'config.yaml')), true);
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
