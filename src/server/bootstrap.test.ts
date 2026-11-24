// SPEC-INITPUSH — the file-aware repo bootstrap. Pure helpers are unit-tested; the execute/preflight
// sequence is exercised against real git in temp dirs with probeRemote/runPush STUBBED (the live push
// is manual smoke — no network here). Every safety invariant that a typecheck cannot vouch for is
// pinned: the .gitignore merge is append-only + idempotent + always guarantees .local-context/; the
// secret classifier's exact boundary; the refuse/warn split (itemized, never first-only); the
// point-of-no-return rollback; the authoritative post-init VERIFY GATE catching a secret that escaped
// preflight enumeration; push-failure honesty; and the assistant action's never-auto-confirm gate.
//
// CT_HOME is set before the modules load: paths.ts freezes it at import time, so the operator's real
// ~/.ct is never touched and no live GitHub call is ever made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, GitHubIdentity } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-bootstrap-test-'));
process.env.CT_HOME = home;

const { ensureDirs } = await import('./paths.js');
ensureDirs();

const {
  detectStacks,
  isLikelySecretPath,
  gitignoreTemplate,
  mergeGitignore,
  BOOTSTRAP_MARKER,
  classifyRemote,
  decideBootstrap,
  preflightBootstrap,
  executeBootstrap,
} = await import('./bootstrap.js');
type BootstrapDeps = import('./bootstrap.js').BootstrapDeps;

const { validateAction, requiresHumanConfirm, reasonForHumanConfirm, riskOf, enrich, makeProposalExecutor } =
  await import('./assistant/actions.js');
type ActionLookups = import('./assistant/actions.js').ActionLookups;

const haveGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ct-bootstrap-fx-'));

function makeProject(repoPath: string, over: Partial<Project> = {}): Project {
  return { id: 'p1', name: 'demo', repoPath, scaffoldMode: 'committed', createdAt: new Date().toISOString(), ...over };
}
function makeIdentity(over: Partial<GitHubIdentity> = {}): GitHubIdentity {
  return { id: 'id1', label: 'Bot', gitName: 'Bot', gitEmail: 'bot@example.com', hasCredential: true, createdAt: new Date().toISOString(), ...over };
}

const gitRun = (repo: string, args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

// ---- 1. detectStacks ----

test('detectStacks — one detection file each, ordered node,python,rust,go', () => {
  assert.deepEqual(detectStacks(['package.json']), ['node']);
  assert.deepEqual(detectStacks(['pyproject.toml']), ['python']);
  assert.deepEqual(detectStacks(['requirements.txt']), ['python']);
  assert.deepEqual(detectStacks(['setup.py']), ['python']);
  assert.deepEqual(detectStacks(['setup.cfg']), ['python']);
  assert.deepEqual(detectStacks(['Cargo.toml']), ['rust']);
  assert.deepEqual(detectStacks(['go.mod']), ['go']);
  assert.deepEqual(detectStacks(['package.json', 'pyproject.toml']), ['node', 'python']);
  assert.deepEqual(detectStacks(['README.md']), []);
});

// ---- 2. gitignoreTemplate ----

const SECRET_PATTERNS = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_rsa.*', 'credentials.json', 'service-account*.json'];

test('gitignoreTemplate — every template carries .local-context/ and every secret pattern; stack block only when detected', () => {
  for (const stacks of [[], ['node'], ['node', 'python', 'rust', 'go']] as const) {
    const lines = gitignoreTemplate([...stacks]);
    assert.ok(lines.includes('.local-context/'), `.local-context/ missing for ${stacks.join('+') || 'generic'}`);
    for (const p of SECRET_PATTERNS) assert.ok(lines.includes(p), `${p} missing for ${stacks.join('+') || 'generic'}`);
  }
  assert.ok(gitignoreTemplate(['node']).includes('node_modules/'));
  assert.ok(!gitignoreTemplate([]).includes('node_modules/'), 'generic must not carry the node block');
  assert.ok(gitignoreTemplate(['rust']).includes('target/'));
});

// ---- 3. mergeGitignore ----

test('mergeGitignore — append-only, idempotent, trailing-newline repaired, .local-context/ guaranteed', () => {
  const gen = gitignoreTemplate(['node']);

  // no existing file → full generated content ending in a newline; appended lists the patterns incl .local-context/
  const fresh = mergeGitignore(undefined, gen);
  assert.equal(fresh.content, gen.join('\n') + '\n');
  assert.ok(fresh.content.endsWith('\n'));
  assert.ok(fresh.appended.includes('.local-context/'));

  // existing file missing exactly two lines → exactly those appended under the marker, order preserved
  const patterns = gen.filter((l) => l.trim() !== '' && !l.startsWith('#'));
  const existing = patterns.filter((l) => l !== 'node_modules/' && l !== 'dist/').join('\n') + '\n';
  const merged = mergeGitignore(existing, gen);
  assert.deepEqual(merged.appended, ['node_modules/', 'dist/']);
  assert.ok(merged.content.includes(BOOTSTRAP_MARKER));

  // idempotence: re-merging the merged content appends nothing and is byte-identical
  const again = mergeGitignore(merged.content, gen);
  assert.deepEqual(again.appended, []);
  assert.equal(again.content, merged.content);

  // trailing newline repaired before the appended block
  const noNL = mergeGitignore('foo', gen);
  assert.ok(noNL.content.startsWith('foo\n'));
  assert.ok(noNL.content.includes('\n' + BOOTSTRAP_MARKER + '\n'));

  // '.local-context' without the slash still gets '.local-context/' appended
  const guard = mergeGitignore('.local-context\n', gen);
  assert.ok(guard.appended.includes('.local-context/'));
});

// ---- 4. isLikelySecretPath ----

test('isLikelySecretPath — the exact refuse boundary and the safe-list', () => {
  for (const p of ['.env', '.env.local', 'a/b/.env.production', 'key.pem', 'sub/x.key', 'id_rsa', 'id_rsa.pub', 'credentials.json', 'secrets/service-account-prod.json', 'cert.p12', 'cert.pfx']) {
    assert.ok(isLikelySecretPath(p), `${p} should flag`);
  }
  for (const p of ['.env.example', '.env.sample', '.env.template', 'package.json', 'monkey.js', 'keyboard.ts']) {
    assert.ok(!isLikelySecretPath(p), `${p} should NOT flag`);
  }
  // Case-folded variants must flag too: on a case-sensitive fs the lowercase-only .gitignore template
  // does not ignore these, so this belt is the only guard. (Revert the .toLowerCase() → these go red.)
  for (const p of ['.ENV', '.Env', 'ID_RSA', 'CREDENTIALS.JSON', 'sub/Cert.PEM', 'Service-Account-Prod.JSON']) {
    assert.ok(isLikelySecretPath(p), `${p} (case variant) should flag`);
  }
  // …and a case-variant of a SAFE template is still safe.
  assert.ok(!isLikelySecretPath('.ENV.EXAMPLE'), '.ENV.EXAMPLE should NOT flag');
});

// ---- 5. classifyRemote ----

test('classifyRemote — empty / has-refs / unreachable', () => {
  assert.deepEqual(classifyRemote({ ok: true, stdout: '', stderr: '' }), { state: 'empty' });
  const refs = classifyRemote({ ok: true, stdout: 'deadbeef\tHEAD\n', stderr: '' });
  assert.equal(refs.state, 'has-refs');
  const bad = classifyRemote({ ok: false, stdout: '', stderr: 'auth failed' });
  assert.equal(bad.state, 'unreachable');
  if (bad.state === 'unreachable') assert.ok(bad.reason.includes('auth failed'));
});

// ---- 6. decideBootstrap ----

const cleanFacts = () => ({
  alreadyRepo: false,
  insideWorkTree: false,
  repoUrl: 'https://github.com/o/r' as string | undefined,
  identity: { id: 'id1', label: 'Bot', hasCredential: true } as { id: string; label: string; hasCredential: boolean } | undefined,
  candidates: [{ path: 'src/a.ts', size: 10 }],
  truncated: false,
  remote: { state: 'empty' } as Parameters<typeof decideBootstrap>[0]['remote'],
});
const codes = (r: { blocking: { code: string }[] }) => r.blocking.map((b) => b.code);

test('decideBootstrap — each blocking code refuses on its own; clean facts pass', () => {
  assert.deepEqual(decideBootstrap(cleanFacts()).blocking, []);
  assert.deepEqual(decideBootstrap(cleanFacts()).warnings, []);

  // already-repo short-circuits to a single blocker
  const ar = decideBootstrap({ ...cleanFacts(), alreadyRepo: true });
  assert.deepEqual(codes(ar), ['already-repo']);

  assert.ok(codes(decideBootstrap({ ...cleanFacts(), repoUrl: undefined })).includes('no-repo-url'));
  assert.ok(codes(decideBootstrap({ ...cleanFacts(), identity: { id: 'id1', label: 'Bot', hasCredential: false } })).includes('no-credential'));
  assert.ok(codes(decideBootstrap({ ...cleanFacts(), identity: undefined })).includes('no-identity'));
  assert.ok(codes(decideBootstrap({ ...cleanFacts(), remote: { state: 'has-refs', sample: 'deadbeef HEAD' } })).includes('remote-not-empty'));
  assert.ok(codes(decideBootstrap({ ...cleanFacts(), remote: { state: 'unreachable', reason: 'timeout' } })).includes('remote-unreachable'));
  assert.ok(codes(decideBootstrap({ ...cleanFacts(), candidates: [{ path: 'src/a.ts', size: 1 }, { path: '.env', size: 1 }] })).includes('secret-files'));
  assert.ok(codes(decideBootstrap({ ...cleanFacts(), candidates: [{ path: 'big.bin', size: 96 * 1024 * 1024 }, { path: 'a', size: 1 }] })).includes('oversize-file'));

  // nothing-to-commit — the "only .gitignore" variant
  assert.ok(codes(decideBootstrap({ ...cleanFacts(), candidates: [{ path: '.gitignore', size: 20 }] })).includes('nothing-to-commit'));

  // warnings, not blocking
  const large = decideBootstrap({ ...cleanFacts(), candidates: [{ path: 'a', size: 1 }, { path: 'big.txt', size: 11 * 1024 * 1024 }] });
  assert.deepEqual(large.blocking, []);
  assert.ok(large.warnings.map((w) => w.code).includes('large-file'));
  const inside = decideBootstrap({ ...cleanFacts(), insideWorkTree: true });
  assert.deepEqual(inside.blocking, []);
  assert.ok(inside.warnings.map((w) => w.code).includes('inside-work-tree'));
});

test('decideBootstrap — refusal is itemized, not first-only (two conditions both reported)', () => {
  const r = decideBootstrap({ ...cleanFacts(), repoUrl: undefined, candidates: [{ path: 'a', size: 1 }, { path: '.env', size: 1 }] });
  const cs = codes(r);
  assert.ok(cs.includes('no-repo-url'), 'no-repo-url present');
  assert.ok(cs.includes('secret-files'), 'secret-files present');
});

// ---- 7-11. Integration (real git; probeRemote/runPush stubbed; NO network) ----

test('happy path — init, commit as the identity, ignore secrets, keep .local-context local, push', { skip: !haveGit }, async () => {
  const repo = tmp();
  writeFileSync(join(repo, 'package.json'), '{"name":"x"}\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'credentials.json'), '{"secret":1}\n');
  const project = makeProject(repo, { repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' });
  const identity = makeIdentity();
  const deps: BootstrapDeps = { probeRemote: async () => ({ state: 'empty' }), runPush: async () => ({ ok: true, stdout: '', stderr: '' }) };

  const plan = await preflightBootstrap(project, identity, deps);
  assert.deepEqual(plan.blocking, []);
  assert.ok(!plan.filesToCommit.some((f) => f.path === 'credentials.json'), 'a secret is kept local, not committed');

  const out = await executeBootstrap(project, identity, deps, { acceptWarnings: false });
  assert.equal(out.kind, 'done');
  if (out.kind !== 'done') return;
  assert.equal(out.result.pushed, true);
  assert.equal(out.result.committed, true);

  assert.ok(existsSync(join(repo, '.git')));
  assert.equal(gitRun(repo, ['rev-list', '--count', 'HEAD']), '1', 'exactly one commit');
  const [an, ae] = gitRun(repo, ['log', '--format=%an%x0a%ae', '-1']).split('\n');
  assert.equal(an, 'Bot');
  assert.equal(ae, 'bot@example.com');
  const gi = readFileSync(join(repo, '.gitignore'), 'utf8');
  assert.ok(gi.includes('.local-context/'));
  assert.ok(gi.includes('node_modules/'));
  assert.ok(existsSync(join(repo, '.local-context')));
  assert.equal(gitRun(repo, ['remote', 'get-url', 'origin']), 'https://github.com/o/r');
  const tree = gitRun(repo, ['ls-tree', '-r', 'HEAD', '--name-only']);
  assert.ok(tree.includes('src/a.ts'));
  assert.ok(!tree.includes('credentials.json'), 'secret never committed');
  assert.ok(!tree.includes('.local-context'), '.local-context never committed');
});

test('semantic-drift — a re-included .env is refused at PREFLIGHT, dir byte-untouched', { skip: !haveGit }, async () => {
  const repo = tmp();
  writeFileSync(join(repo, '.env'), 'SECRET=1\n');
  writeFileSync(join(repo, '.gitignore'), '!.env\n'); // a per-dir negation exposes .env at preview
  writeFileSync(join(repo, 'README.md'), 'x\n');
  const project = makeProject(repo, { repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' });
  const deps: BootstrapDeps = { probeRemote: async () => ({ state: 'empty' }), runPush: async () => ({ ok: true, stdout: '', stderr: '' }) };

  const out = await executeBootstrap(project, makeIdentity(), deps, { acceptWarnings: false });
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.ok(out.blocking.some((b) => b.code === 'secret-files' && (b.paths ?? []).includes('.env')));
  assert.ok(!existsSync(join(repo, '.git')), 'never initialized');
  assert.ok(!existsSync(join(repo, '.local-context')), 'no local-context — execute never reached the merge');
  assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), '!.env\n', 'existing .gitignore byte-untouched');
});

test('verify gate — a secret that materializes after enumeration is caught post-init and rolled back', { skip: !haveGit }, async () => {
  const repo = tmp();
  writeFileSync(join(repo, 'package.json'), '{"name":"x"}\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  // Existing .gitignore whose `.env` then `!.env` survives the append-only merge (the merge does not
  // re-append an already-present `.env`), so `.env` stays visible to the post-init gate.
  writeFileSync(join(repo, '.gitignore'), '.env\n!.env\n');
  const project = makeProject(repo, { repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' });
  // The probe runs at preflight step 5, AFTER enumeration step 4 — so preflight passes and the .env
  // only exists when the authoritative post-init gate scans the tree.
  const deps: BootstrapDeps = {
    probeRemote: async (rp) => { writeFileSync(join(rp, '.env'), 'SECRET=1\n'); return { state: 'empty' }; },
    runPush: async () => ({ ok: true, stdout: '', stderr: '' }),
  };

  const out = await executeBootstrap(project, makeIdentity(), deps, { acceptWarnings: false });
  assert.equal(out.kind, 'refused');
  if (out.kind === 'refused') assert.ok(out.blocking.some((b) => b.code === 'secret-files' && (b.paths ?? []).includes('.env')));
  assert.ok(!existsSync(join(repo, '.git')), 'rolled back');
  assert.ok(existsSync(join(repo, '.local-context')), 'merged .local-context/ remains after rollback');
  const gi = readFileSync(join(repo, '.gitignore'), 'utf8');
  assert.ok(gi.includes(BOOTSTRAP_MARKER), 'merged .gitignore remains after rollback');
});

test('already-a-repo — preflight and execute both refuse, HEAD unchanged', { skip: !haveGit }, async () => {
  const repo = tmp();
  execFileSync('git', ['-C', repo, 'init', '-q']);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'init']);
  const before = gitRun(repo, ['rev-parse', 'HEAD']);
  const project = makeProject(repo, { repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' });

  const plan = await preflightBootstrap(project, makeIdentity(), {});
  assert.deepEqual(plan.blocking.map((b) => b.code), ['already-repo']);
  const out = await executeBootstrap(project, makeIdentity(), {}, { acceptWarnings: false });
  assert.equal(out.kind, 'refused');
  assert.equal(gitRun(repo, ['rev-parse', 'HEAD']), before, 'HEAD unchanged');
});

test('dangling .git symlink is treated as already-a-repo (never init through the link)', { skip: !haveGit }, async () => {
  // existsSync follows the link → false; a naive check would then let `git init` follow it and create the
  // real git dir OUTSIDE the project. lstat-based detection must refuse instead. (Revert to existsSync → red.)
  const repo = tmp();
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  symlinkSync(join(repo, 'nonexistent-target'), join(repo, '.git')); // dangling
  const project = makeProject(repo, { repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' });
  const plan = await preflightBootstrap(project, makeIdentity(), {});
  assert.deepEqual(plan.blocking.map((b) => b.code), ['already-repo'], 'a dangling .git symlink blocks');
  const out = await executeBootstrap(project, makeIdentity(), {}, { acceptWarnings: false });
  assert.equal(out.kind, 'refused');
  assert.ok(!existsSync(join(repo, 'nonexistent-target')), 'no real git dir was created at the symlink target');
});

test('push-failure is non-fatal — commit survives, honest partial-success detail', { skip: !haveGit }, async () => {
  const repo = tmp();
  writeFileSync(join(repo, 'package.json'), '{"name":"x"}\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const project = makeProject(repo, { repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' });
  const deps: BootstrapDeps = {
    probeRemote: async () => ({ state: 'empty' }),
    runPush: async () => ({ ok: false, stdout: '', stderr: 'remote: Permission denied' }),
  };

  const out = await executeBootstrap(project, makeIdentity(), deps, { acceptWarnings: false });
  assert.equal(out.kind, 'done');
  if (out.kind !== 'done') return;
  assert.equal(out.result.initialized, true);
  assert.equal(out.result.committed, true);
  assert.equal(out.result.pushed, false);
  assert.ok(out.result.pushError && out.result.pushError.includes('Permission denied'));
  assert.ok(out.result.detail.includes('git push -u origin main'));
  assert.ok(existsSync(join(repo, '.git')));
  assert.equal(gitRun(repo, ['rev-list', '--count', 'HEAD']), '1', 'the commit survives a failed push');
});

test('preconditions — missing repoUrl and a credential-less identity each block at preflight', { skip: !haveGit }, async () => {
  const repo1 = tmp();
  writeFileSync(join(repo1, 'package.json'), '{"name":"x"}\n');
  const plan1 = await preflightBootstrap(makeProject(repo1), undefined, {});
  assert.ok(plan1.blocking.some((b) => b.code === 'no-repo-url'));

  const repo2 = tmp();
  writeFileSync(join(repo2, 'package.json'), '{"name":"x"}\n');
  const plan2 = await preflightBootstrap(makeProject(repo2, { repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' }), makeIdentity({ hasCredential: false }), {});
  assert.ok(plan2.blocking.some((b) => b.code === 'no-credential'));
});

// ---- 12. Assistant action catalog (no git required) ----

const stubLookups = (o: Partial<ActionLookups>): ActionLookups =>
  ({ getProject: () => undefined, getIdentity: () => undefined, ...o } as unknown as ActionLookups);

test('init_project_repo action — parses strict, always-human-confirmed, high risk', () => {
  assert.deepEqual(validateAction({ kind: 'init_project_repo', projectId: 'p1' }), { kind: 'init_project_repo', projectId: 'p1' });
  assert.throws(() => validateAction({ kind: 'init_project_repo', projectId: 'p1', extra: 1 }), /invalid action/);
  const action = { kind: 'init_project_repo', projectId: 'p1' } as const;
  assert.equal(requiresHumanConfirm(action), true);
  assert.notEqual(reasonForHumanConfirm(action), '');
  assert.equal(riskOf(action), 'high');
});

test('init_project_repo enrich — throws on each missing precondition; happy summary + drift denorm', () => {
  const noGit = tmp();
  const action = { kind: 'init_project_repo', projectId: 'p1' } as const;

  assert.throws(() => enrich(action, stubLookups({ getProject: () => ({ name: 'demo', repoPath: noGit }) })), /no GitHub repo URL/);
  assert.throws(() => enrich(action, stubLookups({ getProject: () => ({ name: 'demo', repoPath: noGit, repoUrl: 'https://github.com/o/r' }) })), /no default GitHub identity/);
  assert.throws(
    () => enrich(action, stubLookups({ getProject: () => ({ name: 'demo', repoPath: noGit, repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' }), getIdentity: () => undefined })),
    /unknown identity/,
  );
  assert.throws(
    () => enrich(action, stubLookups({ getProject: () => ({ name: 'demo', repoPath: noGit, repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' }), getIdentity: () => ({ label: 'Bot', hasCredential: false }) })),
    /no push token/,
  );

  // existing .git → refuse (enrich only existsSync-checks, so a bare .git dir is enough)
  const hasGit = tmp();
  mkdirSync(join(hasGit, '.git'));
  assert.throws(
    () => enrich(action, stubLookups({ getProject: () => ({ name: 'demo', repoPath: hasGit, repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' }), getIdentity: () => ({ label: 'Bot', hasCredential: true }) })),
    /already a git repository/,
  );

  const happy = enrich(action, stubLookups({
    getProject: () => ({ name: 'demo', repoPath: noGit, repoUrl: 'https://github.com/o/r', defaultIdentityId: 'id1' }),
    getIdentity: () => ({ label: 'Bot', hasCredential: true }),
  }));
  assert.ok(happy.summary.includes(noGit));
  assert.ok(happy.summary.includes('https://github.com/o/r'));
  assert.ok(happy.summary.includes('Bot'));
  assert.deepEqual(happy.denorm, { projectName: 'demo', repoUrl: 'https://github.com/o/r', identityLabel: 'Bot', identityHasCredential: 1 });
});

test('init_project_repo route — POST, id-encoded url, no payload body', async () => {
  let captured: Record<string, unknown> | undefined;
  const fakeApp = {
    inject: async (opts: Record<string, unknown>) => {
      captured = opts;
      return { statusCode: 200, json: () => ({ ok: true }), body: '' };
    },
  } as unknown as Parameters<typeof makeProposalExecutor>[0];
  const exec = makeProposalExecutor(fakeApp, 'sess-token', 4870);
  await exec({ kind: 'init_project_repo', projectId: 'a/b' });
  assert.equal(captured?.method, 'POST');
  assert.equal(captured?.url, '/api/projects/a%2Fb/bootstrap');
  assert.equal('payload' in (captured ?? {}), false, 'payload() is undefined → body omitted');
});
