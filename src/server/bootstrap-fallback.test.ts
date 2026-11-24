// Regression tests for the reinit belt's git<2.28 FALLBACK path and the recheck→init race — paths the
// CI git (>=2.28, `init -b` supported, no racing writer) never exercises through bootstrap.test.ts's
// normal `-b` leg. A PATH shim stands in for old git and/or a racing outside actor.
//
// Why a dedicated file: git.ts's SAFE_ENV snapshots process.env (incl. PATH) at MODULE LOAD, so the
// shim only takes effect if PATH is mangled BEFORE importing bootstrap. node --test runs each test file
// in its own child process, so this PATH mutation never leaks into the other suites. Because PATH is
// frozen at import, ONE shim serves every test; each test selects its behavior by writing a mode word
// to a control file the shim reads at runtime (the shim child gets SAFE_ENV, not live env, so a file —
// not an env var — is how a per-test signal reaches it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Resolve the REAL git BEFORE we shadow it on PATH; skip the whole file if git or bash is unavailable.
let REAL_GIT = '';
try {
  REAL_GIT = execFileSync('/usr/bin/env', ['sh', '-c', 'command -v git']).toString().trim();
} catch {
  /* no git on PATH */
}
const canRun = REAL_GIT !== '' && existsSync('/bin/bash');

const CTRL = join(mkdtempSync(join(tmpdir(), 'ct-fb-ctrl-')), 'mode');
const setMode = (m: string): void => writeFileSync(CTRL, m);

if (canRun) {
  // The shim reads $CTRL each call: reject `init -b` for the old-git modes, and (for the race modes)
  // seed a fully-committed outside repo at the -C target the instant `init` hits a .git-less dir —
  // simulating an outside writer landing in the recheck→init window. Then delegate to REAL_GIT.
  const shimDir = mkdtempSync(join(tmpdir(), 'ct-fb-shim-'));
  const script =
    '#!/bin/bash\n' +
    `REAL_GIT=${JSON.stringify(REAL_GIT)}\n` +
    `CTRL=${JSON.stringify(CTRL)}\n` +
    'MODE=$(cat "$CTRL" 2>/dev/null || echo passthru)\n' +
    'target=""; [ "$1" = "-C" ] && target="$2"\n' +
    'has_init=0; has_b=0\n' +
    'for a in "$@"; do [ "$a" = "init" ] && has_init=1; [ "$a" = "-b" ] && has_b=1; done\n' +
    'case "$MODE" in\n' +
    '  old|oldrace|orphan)\n' +
    '    if [ "$has_init" = 1 ] && [ "$has_b" = 1 ]; then echo "error: unknown switch \\`b\'" >&2; exit 129; fi ;;\n' +
    'esac\n' +
    'case "$MODE" in\n' +
    '  brace|oldrace|orphan)\n' +
    '    if [ "$has_init" = 1 ] && [ -n "$target" ] && [ ! -e "$target/.git" ]; then\n' +
    '      "$REAL_GIT" -C "$target" init -q -b outside\n' +
    '      echo x > "$target/outside-file"\n' +
    '      "$REAL_GIT" -C "$target" add outside-file\n' +
    '      "$REAL_GIT" -C "$target" -c user.name=O -c user.email=o@e commit -q -m outside\n' +
    '      [ "$MODE" = "orphan" ] && "$REAL_GIT" -C "$target" symbolic-ref HEAD refs/heads/unborn-orphan\n' +
    '    fi ;;\n' +
    'esac\n' +
    'exec "$REAL_GIT" "$@"\n';
  writeFileSync(join(shimDir, 'git'), script, { mode: 0o755 });
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
}

process.env.CT_HOME = mkdtempSync(join(tmpdir(), 'ct-fb-home-'));
const { ensureDirs } = await import('./paths.js');
if (canRun) ensureDirs();
const { executeBootstrap } = await import('./bootstrap.js');
import type { BootstrapDeps } from './bootstrap.js';
import type { GitHubIdentity, Project } from '../shared/types.js';

const rg = (repo: string, args: string[]): string => execFileSync(REAL_GIT, ['-C', repo, ...args]).toString().trim();
const identity = { id: 'id1', label: 'Bot', gitName: 'Bot', gitEmail: 'bot@example.com', hasCredential: true, createdAt: 'now' } as GitHubIdentity;
const deps: BootstrapDeps = { probeRemote: async () => ({ state: 'empty' }), runPush: async () => ({ ok: true, stdout: '', stderr: '' }) };
const makeProject = (repoPath: string): Project =>
  ({ id: 'p1', name: 'demo', repoPath, repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1', scaffoldMode: 'zero-footprint', createdAt: 'now' } as unknown as Project);

/** A fresh project dir with a couple of committable, non-secret files. */
function freshRepoDir(): string {
  const repo = mkdtempSync(join(tmpdir(), 'ct-fb-repo-'));
  writeFileSync(join(repo, 'package.json'), '{"name":"x"}\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  return repo;
}

test('fallback path (git<2.28): a fresh dir still inits on main and commits', { skip: !canRun }, async () => {
  setMode('old'); // reject `init -b`, no racing writer
  const repo = freshRepoDir();
  const out = await executeBootstrap(makeProject(repo), identity, deps, { acceptWarnings: false });
  assert.equal(out.kind, 'done', 'fallback fresh init succeeds');
  if (out.kind !== 'done') return;
  assert.equal(out.result.branch, 'main');
  assert.equal(rg(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'the plain-init + symbolic-ref named main');
  assert.equal(rg(repo, ['rev-list', '--count', 'HEAD']), '1', 'exactly one commit');
});

test('fallback path race: an outside repo appearing at init is refused, its commits untouched', { skip: !canRun }, async () => {
  setMode('oldrace'); // reject `init -b` AND seed an outside repo+commit on branch "outside" at init
  const repo = freshRepoDir();
  const out = await executeBootstrap(makeProject(repo), identity, deps, { acceptWarnings: false });
  assert.equal(out.kind, 'refused', 'the belt trips on the reinit');
  if (out.kind === 'refused') assert.ok(out.blocking.some((b) => b.code === 'already-repo'));
  assert.ok(existsSync(join(repo, '.git')), '.git NOT deleted — no rmGitDir on the belt path');
  assert.equal(rg(repo, ['symbolic-ref', 'HEAD']), 'refs/heads/outside', 'symbolic-ref never ran — outside HEAD preserved');
  assert.equal(rg(repo, ['rev-list', '--count', 'HEAD']), '1', 'the outside commit is intact');
  assert.equal(rg(repo, ['log', '--format=%s', '-1']), 'outside', 'it is the OUTSIDE commit, not ours');
});

test('-b path race: an outside repo appearing at init is refused, its commits untouched', { skip: !canRun }, async () => {
  setMode('brace'); // delegate `init -b` (git>=2.28) but seed an outside repo+commit at init
  const repo = freshRepoDir();
  const out = await executeBootstrap(makeProject(repo), identity, deps, { acceptWarnings: false });
  assert.equal(out.kind, 'refused', 'the belt trips on the -b reinit too');
  assert.ok(existsSync(join(repo, '.git')), '.git NOT deleted');
  assert.equal(rg(repo, ['symbolic-ref', 'HEAD']), 'refs/heads/outside', 'reinit -b does not move HEAD; belt caught it');
  assert.equal(rg(repo, ['log', '--format=%s', '-1']), 'outside', 'outside commit intact');
});

test('orphan-HEAD race: refs exist but HEAD is unborn — the ref probe still refuses', { skip: !canRun }, async () => {
  setMode('orphan'); // seed an outside repo with a commit on "outside", then park HEAD on an unborn branch
  const repo = freshRepoDir();
  const out = await executeBootstrap(makeProject(repo), identity, deps, { acceptWarnings: false });
  assert.equal(out.kind, 'refused', 'for-each-ref catches the ref even though rev-parse HEAD is unborn');
  assert.ok(existsSync(join(repo, '.git')), '.git NOT deleted');
  assert.equal(rg(repo, ['symbolic-ref', 'HEAD']), 'refs/heads/unborn-orphan', 'HEAD untouched');
  assert.equal(rg(repo, ['rev-parse', 'refs/heads/outside']).length, 40, 'the outside branch + commit survive');
});
