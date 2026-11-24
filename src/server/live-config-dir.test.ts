// SPEC-RUNWAY live-swap stage A1 - liveConfigDirFor: the slot when present, else TODAY'S derivation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-live-dir-'));
process.env.CT_HOME = home;
const { liveConfigDirFor, sharedConfigDirFor } = await import('./terminal-manager.js');

const profiles: Record<string, { configDir: string }> = { p1: { configDir: '/acct/p1' } };
const getProfile = (id: string) => profiles[id];

test('no slot: profile-bound terminal resolves to profile.configDir', () => {
  assert.equal(liveConfigDirFor({ provider: 'claude-code', profileId: 'p1' }, getProfile), '/acct/p1');
});

test('no slot: profile-less terminal resolves to the shared per-provider dir', () => {
  assert.equal(liveConfigDirFor({ provider: 'claude-code' }, getProfile), sharedConfigDirFor('claude-code'));
  assert.equal(liveConfigDirFor({ provider: 'codex' }, getProfile), sharedConfigDirFor('codex'));
});

test('no slot: dangling profileId yields undefined (as the inlined idiom did)', () => {
  assert.equal(liveConfigDirFor({ provider: 'claude-code', profileId: 'gone' }, getProfile), undefined);
});

test('fallbackProvider overrides the shared-dir provider only', () => {
  assert.equal(liveConfigDirFor({ provider: 'codex' }, getProfile, 'claude-code'), sharedConfigDirFor('claude-code'));
  assert.equal(liveConfigDirFor({ provider: 'codex', profileId: 'p1' }, getProfile, 'claude-code'), '/acct/p1');
});

test('slot present wins over profile and shared', () => {
  assert.equal(liveConfigDirFor({ provider: 'claude-code', profileId: 'p1', liveSlotDir: '/slot/1' }, getProfile), '/slot/1');
  assert.equal(liveConfigDirFor({ provider: 'claude-code', liveSlotDir: '/slot/2' }, getProfile), '/slot/2');
});
