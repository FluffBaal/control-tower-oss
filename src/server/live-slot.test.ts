// SPEC-RUNWAY live swap -- direct unit coverage for the live-slot pure/fs guards: the slot gate truth
// table, the removeLiveSlot containment (never delete the root / outside / a sibling-prefix / follow a
// symlink), seedLiveSlot's best-effort fallback, and the boot orphan sweep. No tmux, no real claude.
// CT_HOME is set before the module loads (live-slot -> accounts -> paths freezes CT_HOME at import).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CT_HOME = mkdtempSync(join(tmpdir(), 'ct-liveslot-home-'));
const { liveSlotGate, removeLiveSlot, seedLiveSlot, sweepOrphanSlots, SLOT_SEED_FILES } = await import('./live-slot.js');

const mkroot = (): string => {
  const root = join(mkdtempSync(join(tmpdir(), 'ct-slots-')), 'slots');
  mkdirSync(root, { recursive: true });
  return root;
};

test('liveSlotGate: true only for claude-code + non-login + runway enabled+liveSwap + account in pool', () => {
  const ok = { provider: 'claude-code', purpose: undefined, runway: { enabled: true, liveSwap: true, pool: ['p1'] }, profile: { id: 'p1' } };
  assert.equal(liveSlotGate(ok), true);
  assert.equal(liveSlotGate({ ...ok, provider: 'codex' }), false);
  assert.equal(liveSlotGate({ ...ok, provider: 'shell' }), false);
  assert.equal(liveSlotGate({ ...ok, purpose: 'login' }), false);
  assert.equal(liveSlotGate({ ...ok, runway: { ...ok.runway, enabled: false } }), false);
  assert.equal(liveSlotGate({ ...ok, runway: { ...ok.runway, liveSwap: false } }), false);
  assert.equal(liveSlotGate({ ...ok, runway: undefined }), false);
  assert.equal(liveSlotGate({ ...ok, profile: undefined }), false);
  assert.equal(liveSlotGate({ ...ok, runway: { ...ok.runway, pool: ['other'] } }), false, 'account not in the pool');
  assert.equal(liveSlotGate({ ...ok, runway: { ...ok.runway, pool: [] } }), false, 'empty pool');
});

test('removeLiveSlot: removes a dir strictly inside root; refuses the root, an outside path, a sibling-prefix', () => {
  const root = mkroot();
  const slot = join(root, 'term1');
  mkdirSync(slot);
  writeFileSync(join(slot, 'x'), 'y');
  assert.equal(removeLiveSlot(slot, root), true);
  assert.equal(existsSync(slot), false);

  assert.equal(removeLiveSlot(root, root), false, 'must refuse the root itself');
  assert.equal(existsSync(root), true);

  const outside = mkdtempSync(join(tmpdir(), 'ct-outside-'));
  assert.equal(removeLiveSlot(outside, root), false, 'must refuse a path outside the root');
  assert.equal(existsSync(outside), true);

  const sibling = `${root}-x`;
  mkdirSync(sibling, { recursive: true });
  assert.equal(removeLiveSlot(sibling, root), false, 'must refuse a sibling-prefix dir');
  assert.equal(existsSync(sibling), true);

  assert.equal(removeLiveSlot(undefined, root), false);
  assert.equal(removeLiveSlot(join(root, 'never-existed'), root), false);
});

test('removeLiveSlot: unlinks a symlink at the slot path WITHOUT following it', () => {
  const root = mkroot();
  const target = mkdtempSync(join(tmpdir(), 'ct-symtarget-'));
  writeFileSync(join(target, 'keep'), '1');
  const link = join(root, 'linky');
  symlinkSync(target, link);
  assert.equal(removeLiveSlot(link, root), true);
  assert.equal(existsSync(link), false);
  assert.equal(existsSync(join(target, 'keep')), true, 'the symlink target must NOT be followed or deleted');
});

test('seedLiveSlot: copies the seed files 0600 from the vault and returns a path under root', () => {
  const root = mkroot();
  const vault = mkdtempSync(join(tmpdir(), 'ct-vault-'));
  for (const f of SLOT_SEED_FILES) writeFileSync(join(vault, f), `${f}-data`, { mode: 0o644 });
  const slot = seedLiveSlot('termA', vault, root);
  assert.ok(slot && slot.startsWith(root), 'slot is under the slots root');
  for (const f of SLOT_SEED_FILES) {
    assert.equal(readFileSync(join(slot!, f), 'utf8'), `${f}-data`);
    assert.equal(statSync(join(slot!, f)).mode & 0o777, 0o600, `${f} is 0600`);
  }
});

test('seedLiveSlot: a vault missing a seed file returns undefined and leaves NO half-slot', () => {
  const root = mkroot();
  const vault = mkdtempSync(join(tmpdir(), 'ct-vault-'));
  writeFileSync(join(vault, '.credentials.json'), 'only-one', { mode: 0o600 }); // .claude.json deliberately absent
  const slot = seedLiveSlot('termB', vault, root);
  assert.equal(slot, undefined);
  assert.equal(existsSync(join(root, 'termB')), false, 'the half-built slot must be cleaned up');
});

test('sweepOrphanSlots: removes unknown-id slots, keeps known ones, tolerates a missing root', () => {
  const root = mkroot();
  mkdirSync(join(root, 'live1'));
  mkdirSync(join(root, 'orphan1'));
  mkdirSync(join(root, 'orphan2'));
  const removed = sweepOrphanSlots(new Set(['live1']), root);
  assert.equal(removed, 2);
  assert.equal(existsSync(join(root, 'live1')), true, 'a live terminal slot is preserved');
  assert.equal(existsSync(join(root, 'orphan1')), false);
  assert.equal(existsSync(join(root, 'orphan2')), false);
  assert.equal(sweepOrphanSlots(new Set(), join(tmpdir(), `ct-no-slots-${Date.now()}`)), 0, 'missing root -> 0, no throw');
});
