// SPEC — land 'pr' mode now actually opens a PR. The network call itself is manual smoke; what is pinned
// here is the pure, unit-testable surface (owner/repo parse, response classification, the non-fatal
// wording) and the ONE integration invariant that must hold without a network: a non-GitHub remote stays
// push-only and NEVER reaches the PR API, even with createPr wired. A brokerable host can still carry a
// path that is not owner/repo, so parseGitHubOwnerRepo must reject it (never a mangled API call).
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time. The real ~/.ct is untouched,
// and no live GitHub call is ever made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Terminal, ProviderId } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-pr-create-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { parseGitHubOwnerRepo, classifyPrCreateResponse, redactToken } = await import('./broker.js');
const { WorktreeManager, formatPrLandDetail, prAttemptArgs } = await import('./worktrees.js');
const { Leases } = await import('./leases.js');

const haveGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// ---- parseGitHubOwnerRepo ----

test('parseGitHubOwnerRepo — owner/repo only; undefined for anything else', () => {
  assert.deepEqual(parseGitHubOwnerRepo('https://github.com/owner/repo'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseGitHubOwnerRepo('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseGitHubOwnerRepo('https://github.com/owner/repo/'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(parseGitHubOwnerRepo('https://github.com/Owner/Repo-name_1.git'), { owner: 'Owner', repo: 'Repo-name_1' });
  // a brokerable host can still carry an extra segment — NOT a PR target.
  assert.equal(parseGitHubOwnerRepo('https://github.com/owner/repo/extra'), undefined);
  assert.equal(parseGitHubOwnerRepo('https://github.com/owner'), undefined, 'one segment');
  assert.equal(parseGitHubOwnerRepo('https://github.com/'), undefined, 'no segments');
  assert.equal(parseGitHubOwnerRepo('git@github.com:owner/repo.git'), undefined, 'scp/ssh shorthand is not a URL');
  assert.equal(parseGitHubOwnerRepo('/home/me/bare.git'), undefined, 'a local path is not a URL');
});

// ---- classifyPrCreateResponse ----

test('classifyPrCreateResponse — status/body → outcome, never throws, never a token', () => {
  assert.deepEqual(
    classifyPrCreateResponse(201, { html_url: 'https://github.com/o/r/pull/1' }),
    { kind: 'created', url: 'https://github.com/o/r/pull/1' },
  );
  assert.deepEqual(classifyPrCreateResponse(201, {}), { kind: 'fail', reason: 'GitHub returned 201 without a pull-request URL' });

  assert.deepEqual(
    classifyPrCreateResponse(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for o:branch.' }] }),
    { kind: 'exists' },
  );

  const noCommits = classifyPrCreateResponse(422, { message: 'Validation Failed', errors: [{ message: 'No commits between main and feature' }] });
  assert.equal(noCommits.kind, 'fail');
  if (noCommits.kind === 'fail') assert.match(noCommits.reason, /no commits between/i);

  for (const s of [401, 403]) {
    const out = classifyPrCreateResponse(s, { message: 'Bad credentials' });
    assert.equal(out.kind, 'fail');
    if (out.kind === 'fail') assert.match(out.reason, new RegExp(`HTTP ${s}`));
  }

  const notFound = classifyPrCreateResponse(404, { message: 'Not Found' });
  assert.equal(notFound.kind, 'fail');
  if (notFound.kind === 'fail') assert.match(notFound.reason, /404/);

  const other = classifyPrCreateResponse(500, { message: 'boom' });
  assert.equal(other.kind, 'fail');
  if (other.kind === 'fail') assert.match(other.reason, /HTTP 500/);

  // A non-object body must not throw.
  assert.equal(classifyPrCreateResponse(500, undefined).kind, 'fail');
});

// ---- formatPrLandDetail: the three shapes (non-fatal wording) ----

test('redactToken — a PAT never survives into an error reason (credential-path defense-in-depth)', () => {
  const pat = 'ghp_secretTOKEN1234567890';
  // The exact fetch header-validation error shape: it echoes the whole "Bearer <pat>" value.
  const msg = `Headers.append: "Bearer ${pat}" is an invalid header value.`;
  const out = redactToken(msg, pat);
  assert.ok(!out.includes(pat), 'the token must not appear in the redacted reason');
  assert.ok(out.includes('[REDACTED]'), 'the token is replaced with a marker');
  // A message with no token is passed through (capped); an empty token is a defensive no-op.
  assert.equal(redactToken('network timeout', pat), 'network timeout');
  assert.equal(redactToken('anything', ''), 'anything');
  // Length is capped even when the token isn't present.
  assert.equal(redactToken('x'.repeat(500), pat).length, 300);
  // Redact happens BEFORE the cap, so a token past char 300 is still removed.
  assert.ok(!redactToken('y'.repeat(400) + pat, pat).includes(pat));
});

test('prAttemptArgs — attempts a PR only when brokerable+grant+identity+baseBranch+parsed all hold', () => {
  const base = {
    brokerable: true, hasGrant: true, identityId: 'gh-1', baseBranch: 'main',
    parsed: { owner: 'o', repo: 'r' } as { owner: string; repo: string } | undefined,
  };
  assert.deepEqual(prAttemptArgs(base), { owner: 'o', repo: 'r', identityId: 'gh-1', baseBranch: 'main' });
  // THE LOCK: a brokerable host with an unparseable path (parsed undefined) must NOT attempt —
  // dropping the `parsed === undefined` clause in prAttemptArgs turns this red.
  assert.equal(prAttemptArgs({ ...base, parsed: undefined }), undefined);
  // Every other conjunct also gates the attempt.
  assert.equal(prAttemptArgs({ ...base, brokerable: false }), undefined);
  assert.equal(prAttemptArgs({ ...base, hasGrant: false }), undefined);
  assert.equal(prAttemptArgs({ ...base, identityId: undefined }), undefined);
  assert.equal(prAttemptArgs({ ...base, baseBranch: undefined }), undefined);
});

test('formatPrLandDetail — non-fatal wording for every shape', () => {
  const pushed = 'pushed agent/x to origin';
  // undefined → push-only, byte-identical to the pre-wave message, no prUrl.
  assert.deepEqual(formatPrLandDetail(pushed, undefined), { detail: `${pushed}; open the PR from your host or via gh` });
  // ok + url (created).
  assert.deepEqual(
    formatPrLandDetail(pushed, { ok: true, url: 'https://github.com/o/r/pull/1' }),
    { detail: `${pushed}; opened a PR: https://github.com/o/r/pull/1`, prUrl: 'https://github.com/o/r/pull/1' },
  );
  // ok existing + url.
  assert.deepEqual(
    formatPrLandDetail(pushed, { ok: true, existing: true, url: 'https://github.com/o/r/pull/2' }),
    { detail: `${pushed}; a PR is already open: https://github.com/o/r/pull/2`, prUrl: 'https://github.com/o/r/pull/2' },
  );
  // ok, no url recovered.
  assert.deepEqual(formatPrLandDetail(pushed, { ok: true, existing: true }), { detail: `${pushed}; a PR is already open` });
  // fail → still says the push succeeded (non-fatal), no prUrl.
  const fail = formatPrLandDetail(pushed, { ok: false, reason: 'the repository is not visible to the push credential (HTTP 404)' });
  assert.match(fail.detail, /^pushed agent\/x to origin; PR not created: /);
  assert.match(fail.detail, /open it from your host or via gh$/);
  assert.equal(fail.prUrl, undefined);
});

// ---- Integration: a non-GitHub remote stays push-only and never touches the PR API ----

test('land() PR mode — a non-GitHub remote stays push-only and NEVER calls createPr', { skip: !haveGit }, async () => {
  const src = join(home, 'src-repo');
  mkdirSync(src, { recursive: true });
  const g = (args: string[], cwd = src): string => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
  g(['init']);
  g(['config', 'user.name', 'Test User']);
  g(['config', 'user.email', 'test@example.com']);
  writeFileSync(join(src, 'README.md'), 'hello\n');
  g(['add', '-A']);
  g(['commit', '-m', 'initial']);
  // A sole LOCAL bare remote (not a GitHub https URL) → not brokerable → the PR attempt must be skipped.
  const bare = join(home, 'upstream.git');
  g(['init', '--bare', bare], home);
  g(['remote', 'add', 'origin', bare]);

  const project = {
    id: 'p-pr', name: 'land', repoPath: src, scaffoldMode: 'zero-footprint',
    defaultIdentityId: 'idn', createdAt: new Date().toISOString(),
  } as unknown as Project;

  // createPr spy — MUST stay uncalled for a non-GitHub remote even though it is wired.
  let prCalls = 0;
  const createPr = async () => { prCalls++; return { ok: true as const, url: 'https://example/pr' }; };
  // pushAuth is only consulted for a brokerable remote; a local remote must never reach it.
  const pushAuth = () => ({ env: {} as Record<string, string>, release: () => {} });
  const wt = new WorktreeManager(new Leases(), pushAuth, createPr);

  const created = await wt.create(project, 'shell' as ProviderId, 'task');
  writeFileSync(join(created.path, 'change.txt'), 'work\n');
  g(['add', '-A'], created.path);
  g(['commit', '-m', 'a change'], created.path);
  const term = {
    id: 't-pr', worktreePath: created.path, branch: created.branch, baseBranch: created.base, identityId: 'idn',
  } as unknown as Terminal;

  const r = await wt.land(project, term, 'pr');
  assert.equal(r.mode, 'pr');
  assert.equal(prCalls, 0, 'a non-GitHub remote must never trigger a PR API call');
  assert.equal(r.prUrl, undefined, 'no PR link on a push-only land');
  assert.match(r.detail, /open the PR from your host or via gh$/, 'push-only wording is preserved');
  const remoteBranches = g(['branch', '-r'], src);
  assert.ok(remoteBranches.includes(`origin/${created.branch}`), `the branch reached the bare remote: ${remoteBranches}`);
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
