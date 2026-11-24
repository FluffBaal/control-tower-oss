// SPEC-RESTART W0 — the pure claude session-argv helper (claudeSessionArgv: rewrite a base argv for
// a mint-vs-resume decision) plus findClaudeTranscript (locate a session's transcript by SESSION ID
// — a drift-proof scan, never a re-derivation of claude's own cwd-key) and buildCommand's threading
// of ctx.session onto them. claudeSessionArgv is pure (no I/O); findClaudeTranscript touches a real
// tmpdir tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LaunchContext } from './adapters/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-claude-session-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { claudeAdapter, claudeSessionArgv, findClaudeTranscript } = await import('./adapters/claude.js');

const ID = 'b7e5d9a0-1111-4c2b-9abc-0123456789ab';
const ID2 = '00000000-0000-4000-8000-000000000001';

test('claudeSessionArgv: a bare argv gets --session-id appended for a new session', () => {
  assert.deepEqual(claudeSessionArgv(['claude'], { kind: 'new', id: ID }), ['claude', '--session-id', ID]);
});

test('claudeSessionArgv: a bare argv gets --resume appended for a resumed session', () => {
  assert.deepEqual(claudeSessionArgv(['claude'], { kind: 'resume', id: ID }), ['claude', '--resume', ID]);
});

test('claudeSessionArgv: other flags (model/effort/skip-permissions) are preserved ahead of the pair', () => {
  const base = ['claude', '--model', 'opus', '--effort', 'high', '--dangerously-skip-permissions'];
  assert.deepEqual(
    claudeSessionArgv(base, { kind: 'resume', id: ID }),
    ['claude', '--model', 'opus', '--effort', 'high', '--dangerously-skip-permissions', '--resume', ID],
  );
});

test('claudeSessionArgv: strips a PRIOR --session-id (and its value) before appending the new pair', () => {
  assert.deepEqual(
    claudeSessionArgv(['claude', '--session-id', ID], { kind: 'resume', id: ID2 }),
    ['claude', '--resume', ID2],
  );
});

test('claudeSessionArgv: strips a PRIOR --resume (and its value) before appending the new pair', () => {
  assert.deepEqual(
    claudeSessionArgv(['claude', '--resume', ID], { kind: 'new', id: ID2 }),
    ['claude', '--session-id', ID2],
  );
});

test('claudeSessionArgv: strips a PRIOR short -r <id>', () => {
  assert.deepEqual(
    claudeSessionArgv(['claude', '-r', ID], { kind: 'new', id: ID2 }),
    ['claude', '--session-id', ID2],
  );
});

test('claudeSessionArgv: strips a PRIOR --continue / -c (bare — no value token consumed)', () => {
  assert.deepEqual(claudeSessionArgv(['claude', '--continue', '--model', 'sonnet'], { kind: 'new', id: ID }),
    ['claude', '--model', 'sonnet', '--session-id', ID]);
  assert.deepEqual(claudeSessionArgv(['claude', '-c'], { kind: 'new', id: ID }), ['claude', '--session-id', ID]);
});

test('claudeSessionArgv: a messy argv carrying every prior form collapses to exactly one pair, never both kinds', () => {
  const messy = ['claude', '--session-id', ID, '--resume', ID2, '-r', ID, '--continue', '-c', '--model', 'sonnet'];
  for (const kind of ['new', 'resume'] as const) {
    const out = claudeSessionArgv(messy, { kind, id: ID2 });
    assert.equal(out.filter((t) => t === '--session-id').length, kind === 'new' ? 1 : 0);
    assert.equal(out.filter((t) => t === '--resume').length, kind === 'resume' ? 1 : 0);
    assert.equal(out.includes('--session-id') && out.includes('--resume'), false, 'never both kinds at once');
    assert.deepEqual(out.slice(0, 2), ['claude', '--model'], 'the surviving unrelated flag is kept, in place');
  }
});

let n = 0;
const freshConfigDir = (): string => mkdtempSync(join(home, `findtx-${n++}-`));

test('findClaudeTranscript: finds <configDir>/projects/<anything>/<sessionId>.jsonl regardless of the dir name', () => {
  const configDir = freshConfigDir();
  const projDir = join(configDir, 'projects', '-home-op-my-repo');
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, `${ID}.jsonl`);
  writeFileSync(file, '{}\n');
  assert.equal(findClaudeTranscript(configDir, ID), file);
});

test('findClaudeTranscript: drift-proof — an UNEXPECTED key-dir name (not the cwd-derived shape at all) is still found by session id', () => {
  // FIX 3 — the lookup must never depend on recomputing claude's own cwd → key formula: if a future
  // CLI version changes that format, a hardcoded re-derivation would silently stop matching (resume
  // would quietly never engage again, with no error). Scanning every projects/* subdir by session id
  // alone is immune to that drift — proven here with a directory name that looks nothing like any
  // cwd-derived key.
  const configDir = freshConfigDir();
  const weirdDir = join(configDir, 'projects', 'totally-unexpected-key-format-v9');
  mkdirSync(weirdDir, { recursive: true });
  const file = join(weirdDir, `${ID}.jsonl`);
  writeFileSync(file, '{}\n');
  assert.equal(findClaudeTranscript(configDir, ID), file);
});

test('findClaudeTranscript: no match ⇒ undefined (missing projects dir, empty dir, or a different session id present)', () => {
  assert.equal(findClaudeTranscript(freshConfigDir(), ID), undefined, 'no projects/ dir at all');
  const configDir = freshConfigDir();
  mkdirSync(join(configDir, 'projects', 'some-key'), { recursive: true });
  assert.equal(findClaudeTranscript(configDir, ID), undefined, 'a projects dir with no matching file');
  writeFileSync(join(configDir, 'projects', 'some-key', `${ID2}.jsonl`), '{}\n');
  assert.equal(findClaudeTranscript(configDir, ID), undefined, 'a transcript exists, but for a DIFFERENT session id');
  assert.equal(findClaudeTranscript(configDir, ID2), join(configDir, 'projects', 'some-key', `${ID2}.jsonl`));
});

test('buildCommand: threads ctx.session into --session-id / --resume; omits it entirely when absent', () => {
  const base: LaunchContext = {
    terminalId: 't', projectId: 'p', cwd: '/r', repoPath: '/r', hookTokenFile: '/tok',
    hookScript: 'ct-hook', towerPort: 1, spoolDir: '/spool', configDir: '/cfg',
  };
  assert.deepEqual(claudeAdapter.buildCommand(base), ['claude'], 'no session ⇒ no flag (pre-wave shape unchanged)');
  assert.deepEqual(claudeAdapter.buildCommand({ ...base, session: { kind: 'new', id: ID } }), ['claude', '--session-id', ID]);
  assert.deepEqual(claudeAdapter.buildCommand({ ...base, session: { kind: 'resume', id: ID } }), ['claude', '--resume', ID]);
  assert.deepEqual(
    claudeAdapter.buildCommand({ ...base, model: 'opus', session: { kind: 'resume', id: ID } }),
    ['claude', '--model', 'opus', '--resume', ID],
  );
});

test('headlessCommand: never threads a session flag (the -p path must not gain a session)', () => {
  const base: LaunchContext = {
    terminalId: 't', projectId: 'p', cwd: '/r', repoPath: '/r', hookTokenFile: '/tok',
    hookScript: 'ct-hook', towerPort: 1, spoolDir: '/spool', configDir: '/cfg', session: { kind: 'new', id: ID },
  };
  const out = claudeAdapter.headlessCommand!(base, 'do the thing');
  assert.equal(out.includes('--session-id'), false);
  assert.equal(out.includes('--resume'), false);
});

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
});
