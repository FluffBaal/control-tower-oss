// SPEC-RUNWAY live credential swap -- the per-terminal config-dir SLOT. A slotted claude-code terminal
// runs under `slots/<terminalId>` (seeded from its account vault at spawn) instead of the vault itself, so
// a live swap rewrites the credential in a dir only that one pane reads and the vault stays pristine.
// Slots exist ONLY under liveSlotGate; everything else spawns exactly as before. Seeding is best-effort:
// ANY failure removes the half-built slot and returns undefined so the caller falls back to the vault.

import { existsSync, lstatSync, mkdirSync, chmodSync, rmSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { copyPrivate } from './accounts.js';
import { paths } from './paths.js';

/** The files that carry an account's identity; a slot is seeded with exactly these (0600). */
export const SLOT_SEED_FILES = ['.credentials.json', '.claude.json'] as const;

/** Should this spawn get a live-swap slot? PURE. Conservative: claude-code, a non-login purpose, Runway on
 *  AND live-swap on, and a real (not profile-less/shared) account whose id is in the Runway pool. */
export function liveSlotGate(input: {
  provider: string;
  purpose: string | undefined;
  runway: { enabled: boolean; liveSwap: boolean; pool: readonly string[] } | undefined;
  profile: { id: string } | undefined;
}): boolean {
  return (
    input.provider === 'claude-code' &&
    input.purpose !== 'login' &&
    input.runway?.enabled === true &&
    input.runway.liveSwap === true &&
    input.profile !== undefined &&
    input.runway.pool.includes(input.profile.id)
  );
}

/** Remove a slot dir, ONLY if it lies strictly inside `root` (never the root, never outside it, never a
 *  vault). A symlink at the path is unlinked, not followed. Best-effort: returns whether it removed. */
export function removeLiveSlot(dir: string | undefined, root: string = paths.slots): boolean {
  if (!dir) return false;
  try {
    const abs = resolve(dir);
    const base = resolve(root);
    if (abs === base || !abs.startsWith(base + sep)) {
      console.error(`[live-slot] refusing to remove ${dir}: outside the slots root`);
      return false;
    }
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return false; // already gone
    }
    if (st.isSymbolicLink()) unlinkSync(abs);
    else rmSync(abs, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.error(`[live-slot] remove failed for ${dir}:`, e);
    return false;
  }
}

/** Create `<root>/<terminalId>` (0700) and seed it from `vaultDir`. Returns the slot path, or undefined on
 *  ANY failure (after cleaning up) -- never throws, so a seeding bug can never break terminal creation. */
export function seedLiveSlot(terminalId: string, vaultDir: string, root: string = paths.slots): string | undefined {
  const slot = join(root, terminalId);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(slot, { recursive: true, mode: 0o700 });
    chmodSync(slot, 0o700);
    for (const f of SLOT_SEED_FILES) {
      const src = join(vaultDir, f);
      if (!existsSync(src)) throw new Error(`vault is missing ${f}`);
      copyPrivate(src, join(slot, f));
    }
    return slot;
  } catch (e) {
    console.error(`[live-slot] seeding failed for ${terminalId}; falling back to the vault dir:`, e instanceof Error ? e.message : e);
    removeLiveSlot(slot, root);
    return undefined;
  }
}

/** Boot sweep: remove every `<root>/<id>` slot dir whose id is not a known terminal (a Tower crash between
 *  slot seed and terminal persist, or a missed teardown, leaves a credential copy behind). Each removal goes
 *  through removeLiveSlot, so it is guarded to the slots root. Best-effort; returns how many were removed. */
export function sweepOrphanSlots(knownTerminalIds: ReadonlySet<string>, root: string = paths.slots): number {
  let removed = 0;
  try {
    for (const name of readdirSync(root)) {
      if (knownTerminalIds.has(name)) continue;
      if (removeLiveSlot(join(root, name), root)) removed++;
    }
  } catch {
    /* no slots dir yet, or unreadable: nothing to sweep */
  }
  return removed;
}
