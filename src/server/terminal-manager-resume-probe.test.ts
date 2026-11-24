// SPEC-RESTART-RESUME — pins the resume-attempt health-check's PRODUCTION cap with a plain, static
// assertion instead of a timing race. "the cap covers a real CLI's variable death time" is not
// something a wall-clock unit test can prove without flaking under CPU contention (a real
// second-scale race is exactly what a synchronous or too-tight check would reintroduce) — so this
// guards the one thing that actually can be pinned deterministically: the constant itself never
// regresses below a floor with real measured margin behind it.
//
// MEASURED FACT (real claude 2.1.278, this machine, remain-on-exit, a `--resume` onto a session the
// CLI refuses, multiple passes): the pane dies at ~1.5-2.8s, NOT sub-second. The production cap
// (RESUME_PROBE_CAP_MS, terminal-manager.ts) must stay comfortably above that measured ceiling —
// this floor (4000ms) sits below the actual production value (6000ms) so a future adjustment has
// room to move without immediately failing this guard, while still catching a regression back
// toward the old, too-short (1500ms or less) synchronous-era cap that caused the SEVERE bug this
// design fixes: a refused resume reported as resumed:true with a dying session underneath it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-resume-probe-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { RESUME_PROBE_CAP_MS, RESUME_PROBE_INTERVAL_MS } = await import('./terminal-manager.js');

test('RESUME_PROBE_CAP_MS stays comfortably above the measured real-claude death window (~1.5-2.8s)', () => {
  assert.ok(
    RESUME_PROBE_CAP_MS >= 4000,
    `RESUME_PROBE_CAP_MS (${RESUME_PROBE_CAP_MS}ms) must stay >= 4000ms — a real claude 2.1.278 `
    + 'refused --resume dies at ~1.5-2.8s (measured across passes; pins C7); a cap this low or lower would miss it '
    + 'and report resumed:true over a dying session (the SEVERE bug this design fixes).',
  );
});

test('RESUME_PROBE_CAP_MS stays comfortably under the reconciler sweep (~15s) — the fall-forward must win that race', () => {
  assert.ok(
    RESUME_PROBE_CAP_MS <= 12_000,
    `RESUME_PROBE_CAP_MS (${RESUME_PROBE_CAP_MS}ms) should stay well under the reconciler's own `
    + '~15s sweep, or the fall-forward risks losing the race and the reconciler force-fails the loop first.',
  );
});

test('RESUME_PROBE_INTERVAL_MS is fine-grained enough that the cap holds several polls, not one or two', () => {
  assert.ok(
    RESUME_PROBE_INTERVAL_MS > 0 && RESUME_PROBE_INTERVAL_MS <= 1000,
    `RESUME_PROBE_INTERVAL_MS (${RESUME_PROBE_INTERVAL_MS}ms) should be <= 1000ms so the cap window `
    + 'holds enough polls to observe death promptly rather than coarsely.',
  );
  assert.ok(
    Math.floor(RESUME_PROBE_CAP_MS / RESUME_PROBE_INTERVAL_MS) >= 4,
    'the cap should hold at least a handful of polls, not just one or two',
  );
});

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
});
