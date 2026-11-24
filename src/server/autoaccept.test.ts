// Autonomy (skip-permissions) — the parts a typecheck cannot vouch for: the claude adapter binds
// --dangerously-skip-permissions ONLY on buildCommand and ONLY when ctx.skipPermissions is true; the
// headless path never gets it; codex/gemini never map the signal; and the new per-project
// defaultAutoAccept + the per-terminal autoAccept survive a real Store reload (the M6 strip-trap).
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time. The operator's ~/.ct
// is never touched. No server, no tmux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchContext } from './adapters/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-autoaccept-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { claudeAdapter } = await import('./adapters/claude.js');
const { codexAdapter } = await import('./adapters/codex.js');
const { geminiAdapter } = await import('./adapters/gemini.js');
const { Store } = await import('./store.js');

// buildCommand only reads model/effort/skipPermissions; a minimal ctx is all the argv shape needs.
const ctx = (over: Partial<LaunchContext> = {}): LaunchContext => ({ ...over } as unknown as LaunchContext);
const FLAG = '--dangerously-skip-permissions';

// ---- adapter argv (§5.2) ----

test('claudeAdapter.buildCommand binds --dangerously-skip-permissions IFF ctx.skipPermissions === true', () => {
  assert.ok(claudeAdapter.buildCommand(ctx({ skipPermissions: true })).includes(FLAG), 'present when true');
  // Absent for false AND for the field omitted — kills an unconditional-append mutation.
  assert.ok(!claudeAdapter.buildCommand(ctx({ skipPermissions: false })).includes(FLAG), 'absent when explicitly false');
  assert.ok(!claudeAdapter.buildCommand(ctx()).includes(FLAG), 'absent when omitted');
});

test('claudeAdapter.headlessCommand NEVER binds the flag, even with skipPermissions true', () => {
  // The headless `claude -p` path must not gain silent bypass — kills a copy-paste-into-headless mutation.
  assert.ok(claudeAdapter.headlessCommand);
  const argv = claudeAdapter.headlessCommand!(ctx({ skipPermissions: true }), 'do the thing');
  assert.ok(!argv.includes(FLAG), 'headless argv must be flag-free');
});

test('codex/gemini never map the skip-permissions signal (no drive-by mapping)', () => {
  const dangerous = /dangerously|bypass|yolo/;
  for (const [name, argv] of [
    ['codex', codexAdapter.buildCommand(ctx({ skipPermissions: true }))],
    ['gemini', geminiAdapter.buildCommand(ctx({ skipPermissions: true }))],
  ] as const) {
    assert.ok(!argv.some((tok) => dangerous.test(tok)), `${name} argv must carry no bypass token: ${argv.join(' ')}`);
  }
});

test('supportsAutoAccept is declared on claude only', () => {
  assert.equal(claudeAdapter.supportsAutoAccept, true, 'claude supports it');
  assert.equal(codexAdapter.supportsAutoAccept, undefined, 'codex does not');
  assert.equal(geminiAdapter.supportsAutoAccept, undefined, 'gemini does not');
});

// ---- M6 strip-trap: defaultAutoAccept + Terminal.autoAccept survive a real Store reload (§5.3) ----

test('defaultAutoAccept + Terminal.autoAccept survive a Store reload, and no default-on creep', () => {
  const now = new Date().toISOString();
  const s1 = new Store();
  s1.upsertProject({
    id: 'p-auto-on',
    name: 'auto-on',
    repoPath: home,
    scaffoldMode: 'zero-footprint',
    defaultAutoAccept: true,
    createdAt: now,
  });
  // A project written WITHOUT the field must NOT gain it on load (no default-on creep).
  s1.upsertProject({
    id: 'p-auto-absent',
    name: 'auto-absent',
    repoPath: home,
    scaffoldMode: 'zero-footprint',
    createdAt: now,
  });
  s1.upsertTerminal({
    id: 't-auto',
    projectId: 'p-auto-on',
    title: 't',
    provider: 'claude-code',
    tmuxSocket: 'ct-t-auto',
    cwd: home,
    command: [],
    state: 'idle',
    autoAccept: true,
    createdAt: now,
  });

  // A fresh Store re-reads projects.json / terminals.json through their zod schemas — the strip-trap path.
  const s2 = new Store();
  assert.equal(s2.getProject('p-auto-on')?.defaultAutoAccept, true, 'defaultAutoAccept must not be stripped on load');
  assert.equal(s2.getProject('p-auto-absent')?.defaultAutoAccept, undefined, 'a project without the field loads with undefined');
  assert.equal(s2.getTerminal('t-auto')?.autoAccept, true, 'Terminal.autoAccept must not be stripped on load');
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
