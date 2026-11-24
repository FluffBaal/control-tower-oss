// Per-project GitHub config — the parts a typecheck cannot vouch for: the repo-URL validator's
// accept/reject boundary, the push-remote picker, the Project strip-trap (repoUrl/defaultIdentityId
// surviving a real Store reload), and land()'s PR-mode remote-name + identity resolution.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time. The operator's real ~/.ct
// is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Terminal, ProviderId } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-github-config-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { validateRepoUrl, isBrokerableGitHubPushUrl } = await import('./broker.js');
const { pickPushRemote } = await import('./git.js');
const { Store } = await import('./store.js');
const { WorktreeManager } = await import('./worktrees.js');
const { Leases } = await import('./leases.js');

const haveGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// ---- validateRepoUrl ----

test('validateRepoUrl accepts canonical GitHub URLs, stored verbatim', () => {
  const cases: [string, string][] = [
    ['https://github.com/owner/repo', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo.git'],
    // trimmed at the edges; letter case in the path preserved (GitHub owners can be mixed-case)
    ['  https://github.com/Owner/Repo-name_1.git  ', 'https://github.com/Owner/Repo-name_1.git'],
    ['https://www.github.com/owner/repo', 'https://www.github.com/owner/repo'],
    // a single trailing slash is a common paste — accepted, kept verbatim
    ['https://github.com/owner/repo/', 'https://github.com/owner/repo/'],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(validateRepoUrl(input), { ok: true, url: expected }, `input ${JSON.stringify(input)}`);
  }
});

test('validateRepoUrl treats blank/whitespace as a clear', () => {
  assert.deepEqual(validateRepoUrl(''), { ok: true, url: '' });
  assert.deepEqual(validateRepoUrl('   '), { ok: true, url: '' });
});

test('validateRepoUrl rejects everything off the happy path, with a non-empty error', () => {
  const bad = [
    'http://github.com/owner/repo', // not https
    'git@github.com:owner/repo.git', // scp/ssh shorthand
    'ssh://git@github.com/owner/repo.git', // ssh
    'https://x-access-token:tok@github.com/owner/repo', // embedded credentials
    'https://github.com:443/owner/repo', // default port — dropped from .href, caught by the verbatim check
    'https://github.com:8443/owner/repo', // non-default port — preserved in .href, caught only by the u.port guard
    'https://github.com/owner/repo?tab=readme', // query string
    'https://github.com/owner/repo#frag', // fragment
    'https://gitlab.com/owner/repo', // non-GitHub host
    'https://github.com/owner', // 1-segment path
    'https://github.com/owner/repo/extra', // 3-segment path
    'https://github.com/owner/../repo', // path traversal (parser normalizes)
    'HTTPS://github.com/owner/repo', // uppercase scheme (parser rewrites → not verbatim)
    `https://github.com/owner/${'r'.repeat(600)}`, // over the 512 cap
    'not a url',
  ];
  for (const input of bad) {
    const v = validateRepoUrl(input);
    assert.equal(v.ok, false, `expected reject: ${input}`);
    if (!v.ok) assert.ok(v.error.length > 0, `error must be non-empty for ${input}`);
  }
});

// ---- pickPushRemote ----

test('pickPushRemote prefers origin, else a sole remote, else nothing', () => {
  assert.equal(pickPushRemote(['origin', 'fork']), 'origin');
  assert.equal(pickPushRemote(['fork', 'origin']), 'origin'); // order-independent
  assert.equal(pickPushRemote(['upstream']), 'upstream'); // sole remote
  assert.equal(pickPushRemote(['a', 'b']), undefined); // ambiguous — refuse
  assert.equal(pickPushRemote([]), undefined); // no remote
});

// ---- Project strip-trap (M6): repoUrl + defaultIdentityId survive a real reload ----

test('Project repoUrl + defaultIdentityId survive a Store reload (M6 strip-trap)', () => {
  const now = new Date().toISOString();
  const s1 = new Store();
  s1.upsertProject({
    id: 'pgh-striptrap',
    name: 'gh',
    repoPath: home,
    scaffoldMode: 'zero-footprint',
    repoUrl: 'https://github.com/owner/repo.git',
    defaultIdentityId: 'idn-A',
    createdAt: now,
  });
  // A fresh Store re-reads projects.json through ProjectSchema.parse — the strip-trap path.
  const s2 = new Store();
  const p = s2.getProject('pgh-striptrap');
  assert.ok(p, 'the project reloaded');
  assert.equal(p?.repoUrl, 'https://github.com/owner/repo.git', 'repoUrl must not be stripped on load');
  assert.equal(p?.defaultIdentityId, 'idn-A', 'defaultIdentityId must not be stripped on load');
});

// ---- land() PR mode: real remote-name + identity resolution, always releases the grant ----

test('land() PR mode resolves the remote name and the identity, and always releases the grant', { skip: !haveGit }, async () => {
  const src = join(home, 'src-repo');
  mkdirSync(src, { recursive: true });
  const g = (args: string[], cwd = src): string => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
  g(['init']);
  g(['config', 'user.name', 'Test User']);
  g(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(src, 'README.md'), 'hello\n');
  g(['add', '-A']);
  g(['commit', '-m', 'initial']);
  // A local bare remote named 'upstream' (NOT origin) — proves remote-name resolution beyond origin.
  const bare = join(home, 'upstream.git');
  g(['init', '--bare', bare], home);
  g(['remote', 'add', 'upstream', bare]);

  const project = {
    id: 'p-land',
    name: 'land',
    repoPath: src,
    scaffoldMode: 'zero-footprint',
    createdAt: new Date().toISOString(),
  } as unknown as Project;

  // pushAuth spy: records the identityId land() asks for, and counts releases. Returns a harmless grant
  // (empty env — the local push needs no credential helper anyway).
  const asked: (string | undefined)[] = [];
  let released = 0;
  const pushAuth = (identityId: string | undefined) => {
    asked.push(identityId);
    return { env: {} as Record<string, string>, release: () => { released++; } };
  };
  const wt = new WorktreeManager(new Leases(), pushAuth);

  // A worktree + branch carrying a commit to land.
  const created = await wt.create(project, 'shell' as ProviderId, 'task');
  writeFileSync(join(created.path, 'change.txt'), 'work\n');
  g(['add', '-A'], created.path);
  g(['commit', '-m', 'a change'], created.path);
  const baseTerm = {
    id: 't-land',
    worktreePath: created.path,
    branch: created.branch,
    baseBranch: created.base,
  } as unknown as Terminal;

  // (a) sole LOCAL remote 'upstream' (not origin, not GitHub): land() resolves the remote by NAME
  //     (no hardcoded 'origin'), pushes for real, and is NOT brokered — a non-GitHub remote stays
  //     fail-open on the ambient credentials the local push doesn't even need.
  project.defaultIdentityId = 'proj-default';
  const r1 = await wt.land(project, baseTerm, 'pr');
  assert.equal(r1.mode, 'pr');
  assert.match(r1.detail, /to upstream/, 'pushes to the sole remote by name, not hardcoded origin');
  assert.equal(asked.length, 0, 'a non-GitHub (local) remote is never brokered — fail-open, pushAuth untouched');
  assert.equal(released, 0, 'no grant taken for a non-GitHub remote, so nothing to release');
  const remoteBranches = g(['branch', '-r'], src);
  assert.ok(remoteBranches.includes(`upstream/${created.branch}`), `remote should carry the branch: ${remoteBranches}`);

  // Now add a GitHub https 'origin' — pickPushRemote prefers it — so the brokered path is exercised.
  // The push to a nonexistent repo fails (the stub grant carries no real credential), which is exactly
  // what proves the finally still releases the grant on failure.
  g(['remote', 'add', 'origin', 'https://github.com/test/does-not-exist.git']);

  // (b) GitHub remote IS brokered, with the resolved identity — a terminal identity beats the project
  //     default — and the grant is released in the finally even though the push fails.
  const term2 = { ...baseTerm, identityId: 'term-id' } as unknown as Terminal;
  await assert.rejects(() => wt.land(project, term2, 'pr'), /push failed/, 'unauthenticated GitHub push fails');
  assert.equal(asked.at(-1), 'term-id', 'GitHub remote brokered with the resolved identity (terminal beats project default)');
  assert.equal(released, 1, 'grant.release runs in the finally even when the push fails');

  // (c) no identity anywhere → land() still asks (with undefined) on a brokerable remote; the real
  //     acquireDaemonPush would decline, so this stays fail-open. Grant still released.
  const term3 = { ...baseTerm, identityId: undefined } as unknown as Terminal;
  delete project.defaultIdentityId;
  await assert.rejects(() => wt.land(project, term3, 'pr'));
  assert.equal(asked.at(-1), undefined, 'no identity → pushAuth asked with undefined');
  assert.equal(released, 2, 'grant released on every brokered push');
});

test('isBrokerableGitHubPushUrl brokers only allowlisted GitHub https URLs', () => {
  for (const ok of [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://www.github.com/owner/repo.git',
  ]) {
    assert.equal(isBrokerableGitHubPushUrl(ok), true, `should broker: ${ok}`);
  }
  for (const no of [
    'git@github.com:owner/repo.git', // scp/ssh shorthand — new URL throws
    'ssh://git@github.com/owner/repo.git', // ssh scheme
    'http://github.com/owner/repo', // not https
    'https://gitlab.com/owner/repo', // non-GitHub host
    'https://github.example.com/owner/repo', // GHE host not on the allowlist
    'https://github.com:443/owner/repo', // explicit default port — git presents host=github.com:443, which the broker denies → must NOT broker (stay fail-open)
    'https://github.com:8443/owner/repo', // non-default port — same reason
    '/home/me/bare.git', // local path — new URL throws
    '', // empty
  ]) {
    assert.equal(isBrokerableGitHubPushUrl(no), false, `should NOT broker: ${no}`);
  }
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
