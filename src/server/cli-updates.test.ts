// SPEC-CLI-UPDATE — the built-in CLI self-update helpers. The version PARSE + the no-spawn safety of an
// unknown provider are pure/deterministic; a live --version detect is asserted tolerantly (only when the
// CLI is actually installed) so the suite stays green on a host without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, updatableProviders, detectVersion, updateProvider } from './cli-updates.js';

test('parseVersion: pulls semver from the real --version strings', () => {
  assert.equal(parseVersion('2.1.277 (Claude Code)'), '2.1.277');
  assert.equal(parseVersion('codex-cli 0.147.0'), '0.147.0');
  assert.equal(parseVersion('gemini 1.2.3-preview.4'), '1.2.3-preview.4');
  assert.equal(parseVersion('no version here'), undefined);
});

test('updatableProviders: exactly the built-ins with a self-updater', () => {
  assert.deepEqual(updatableProviders().sort(), ['claude-code', 'codex', 'gemini-cli']);
});

test('an unknown provider never spawns and is refused', async () => {
  const v = await detectVersion('not-a-provider');
  assert.deepEqual(v, { provider: 'not-a-provider', bin: 'not-a-provider', present: false });
  const u = await updateProvider('not-a-provider');
  assert.equal(u.ok, false);
  assert.match(u.error ?? '', /no updater/);
  assert.equal(u.outputTail, '');
});

test('detectVersion is no-throw and shape-correct for a built-in (version only asserted when installed)', async () => {
  const v = await detectVersion('claude-code');
  assert.equal(v.provider, 'claude-code');
  assert.equal(v.bin, 'claude');
  assert.equal(typeof v.present, 'boolean');
  if (v.present) assert.match(v.version ?? '', /^\d+\.\d+\.\d+/);
});
