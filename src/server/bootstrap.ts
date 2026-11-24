// File-aware repo bootstrap for a registered-but-repo-less project (SPEC-INITPUSH).
// A read-only preflight inspects the tree with git itself as the ignore-authority (a scratch
// --work-tree trick that writes NOTHING into the project) and returns a structured plan; the
// execute path re-runs the preflight, then init → merged .gitignore → .local-context/ →
// git-verified stage gate → commit → remote add → brokered push.
//
// Load-bearing invariants:
//   - the preview NEVER writes into the project (all git bookkeeping lives in a mkdtemp scratch
//     .git, removed in finally);
//   - NEVER force-push (fixed argv ['push','-u','origin','main']; has-refs/unreachable hard-refuse;
//     no --force anywhere);
//   - secrets and .local-context/ can NEVER be committed — the post-init verify gate AND the staged
//     belt scan the FULL status/diff output and roll back + refuse on any hit;
//   - the PAT stays inside the broker grant env only (never a raw env/argv/child/log; released in a
//     finally on every path including throw; error strings capped);
//   - the commit sha is the point of no return — refusals/failures BEFORE it roll back the .git this
//     run created (proved safe because step 1 confirmed no .git pre-existed); nothing is ever rolled
//     back after the sha is recorded, and a push failure is non-fatal.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as git from './git.js';
import { isBrokerableGitHubPushUrl } from './broker.js';
import type { GitHubIdentity, Project, RepoBootstrapIssue, RepoBootstrapPlan, RepoBootstrapResult } from '../shared/types.js';

const ERR_CAP = 300;
const OVERSIZE_BYTES = 95 * 1024 * 1024; // GitHub rejects >100 MB — the push would fail anyway
const LARGE_FILE_BYTES = 10 * 1024 * 1024;
const LARGE_TREE_COUNT = 2000;
const ENUMERATION_CAP = 4000; // preview-only; the execute verify gate scans the FULL, uncapped list
const WIRE_FILE_CAP = 200;
const PATHS_CAP = 20;

const cap = (s: string): string => s.trim().slice(0, ERR_CAP);

// ---- stack detection ----

export type StackId = 'node' | 'python' | 'rust' | 'go';

const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg'];

/** Detect the project's stacks from its root directory entries. Order fixed node,python,rust,go. */
export function detectStacks(rootEntries: string[]): StackId[] {
  const set = new Set(rootEntries);
  const stacks: StackId[] = [];
  if (set.has('package.json')) stacks.push('node');
  if (PYTHON_MARKERS.some((m) => set.has(m))) stacks.push('python');
  if (set.has('Cargo.toml')) stacks.push('rust');
  if (set.has('go.mod')) stacks.push('go');
  return stacks;
}

// ---- secret classification (ONE source for the scanner and the .gitignore template) ----

const SECRET_BASENAMES = ['.env', 'credentials.json', 'id_rsa'];
const SECRET_BASENAME_PREFIXES = ['.env.', 'id_rsa.']; // .env.* / id_rsa.*
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];
const SECRET_SAFE = new Set(['.env.example', '.env.sample', '.env.template']);
const SECRET_SA_RE = /^service-account.*\.json$/;

/** True when a repo-relative path looks like a secret we must never commit. git emits '/' separators;
 *  the check is on the BASENAME so a nested secrets/service-account-prod.json still flags. The SAFE set
 *  (documented example templates) wins first. id_rsa.pub IS flagged — safe-side noise, on purpose. */
export function isLikelySecretPath(relPath: string): boolean {
  // Lowercase the basename before every compare: on a case-sensitive fs (Linux/ext4, core.ignorecase
  // false) the lowercase-only .gitignore template does NOT ignore .ENV / ID_RSA / CREDENTIALS.JSON, so
  // this belt is the only thing standing between a case-variant secret and the commit. The SAFE set,
  // SECRET_BASENAMES, prefixes, extensions, and the service-account regex are all already lowercase.
  const base = (relPath.split('/').pop() ?? relPath).toLowerCase();
  if (SECRET_SAFE.has(base)) return false;
  if (SECRET_BASENAMES.includes(base)) return true;
  if (SECRET_BASENAME_PREFIXES.some((p) => base.startsWith(p))) return true;
  if (SECRET_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  if (SECRET_SA_RE.test(base)) return true;
  return false;
}

// ---- .gitignore template ----

const COMMON_LINES = [
  '# local scratch — never pushed',
  '.local-context/',
  '# secrets',
  '.env',
  '.env.*',
  // The three SAFE re-includes below can un-ignore a file an earlier rule matched; safe by construction
  // because only these documented example templates are ever re-included.
  '!.env.example',
  '!.env.sample',
  '!.env.template',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_rsa.*',
  'credentials.json',
  'service-account*.json',
  '# junk',
  '.DS_Store',
  'Thumbs.db',
];

const STACK_LINES: Record<StackId, string[]> = {
  node: ['# node', 'node_modules/', 'dist/', 'coverage/', '*.tsbuildinfo', 'npm-debug.log*'],
  python: ['# python', '__pycache__/', '*.pyc', '.venv/', 'venv/', '.pytest_cache/', '.mypy_cache/', 'build/', 'dist/', '*.egg-info/'],
  rust: ['# rust', 'target/'],
  go: ['# go', '*.test', '*.out'],
};

/** COMMON block + each detected stack's block, deduped, order-preserving. */
export function gitignoreTemplate(stacks: StackId[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (line: string): void => {
    if (line.startsWith('#')) {
      out.push(line); // keep comment headers (they are not deduped against pattern lines)
      return;
    }
    if (seen.has(line)) return;
    seen.add(line);
    out.push(line);
  };
  for (const l of COMMON_LINES) push(l);
  for (const s of stacks) for (const l of STACK_LINES[s]) push(l);
  return out;
}

// ---- .gitignore merge (append-only, idempotent, .local-context/ always guaranteed) ----

export const BOOTSTRAP_MARKER = '# Control Tower repo bootstrap';

/** Append-only merge. No existing file → the generated content. Otherwise append only the missing
 *  non-comment pattern lines under BOOTSTRAP_MARKER; byte-identical output when nothing is missing
 *  (idempotent). !-negations in the existing file are out-precedenced because appended lines come
 *  later (git: last match wins); the execute verify gate is the authority regardless. */
export function mergeGitignore(existing: string | undefined, generated: string[]): { content: string; appended: string[] } {
  const patternLines = generated.filter((l) => l.trim() !== '' && !l.startsWith('#'));
  if (existing === undefined) {
    return { content: generated.join('\n') + '\n', appended: patternLines };
  }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = patternLines.filter((l) => !have.has(l.trim()));
  if (missing.length === 0) return { content: existing, appended: [] };
  const endsWithNL = existing.endsWith('\n');
  const content = existing + (endsWithNL ? '' : '\n') + '\n' + BOOTSTRAP_MARKER + '\n' + missing.join('\n') + '\n';
  return { content, appended: missing };
}

// ---- remote classification ----

export type RemoteState =
  | { state: 'empty' }
  | { state: 'has-refs'; sample: string }
  | { state: 'unreachable'; reason: string };

/** Classify an `ls-remote` result. !ok → unreachable; empty stdout → empty; else has-refs (sample = first ref). */
export function classifyRemote(res: { ok: boolean; stdout: string; stderr: string }): RemoteState {
  if (!res.ok) return { state: 'unreachable', reason: cap(res.stderr) || 'git ls-remote failed' };
  if (res.stdout.trim() === '') return { state: 'empty' };
  const firstLine = res.stdout.split('\n').find((l) => l.trim() !== '') ?? '';
  const parts = firstLine.split('\t');
  const sample = (parts[1] ?? parts[0] ?? firstLine).trim();
  return { state: 'has-refs', sample };
}

// ---- the ask/refuse decision (pure over gathered facts) ----

export interface BootstrapFacts {
  alreadyRepo: boolean;
  insideWorkTree: boolean; // isGitRepo() true while own .git absent
  repoUrl: string | undefined;
  identity: { id: string; label: string; hasCredential: boolean } | undefined;
  candidates: { path: string; size: number }[]; // post-merged-ignore untracked list
  truncated: boolean;
  remote: RemoteState | { state: 'unchecked' };
}

export function decideBootstrap(f: BootstrapFacts): { blocking: RepoBootstrapIssue[]; warnings: RepoBootstrapIssue[] } {
  const blocking: RepoBootstrapIssue[] = [];
  const warnings: RepoBootstrapIssue[] = [];

  if (f.alreadyRepo) {
    // Short-circuit: a single, honest blocker (never itemize past an already-a-repo directory).
    blocking.push({
      code: 'already-repo',
      detail:
        'this directory is already a git repository — bootstrap is only for a project with no repo. If the first push failed earlier, finish with `git push -u origin main`.',
    });
    return { blocking, warnings };
  }

  // Accumulate ALL applicable conditions (itemized ask, never first-only).
  if (!f.repoUrl) {
    blocking.push({ code: 'no-repo-url', detail: 'the project has no GitHub repo URL — set one first (Settings → Projects → GitHub).' });
  } else if (!isBrokerableGitHubPushUrl(f.repoUrl)) {
    blocking.push({ code: 'repo-url-not-brokerable', detail: 'the repo URL is not a brokerable github.com https URL — the push credential cannot be served for it.' });
  }
  if (!f.identity) {
    blocking.push({ code: 'no-identity', detail: 'the project has no default GitHub identity — set one in Connections → GitHub identities.' });
  } else if (!f.identity.hasCredential) {
    blocking.push({ code: 'no-credential', detail: `identity "${f.identity.label}" has no push token — add one in Connections → GitHub identities.` });
  }

  if (f.remote.state === 'has-refs') {
    blocking.push({ code: 'remote-not-empty', detail: `the remote already has refs (${f.remote.sample}) — never force-pushed; pull/clone instead.` });
  } else if (f.remote.state === 'unreachable') {
    blocking.push({ code: 'remote-unreachable', detail: `the remote is unreachable (${f.remote.reason}) — cannot prove the first push would not clobber it.` });
  }

  const secretPaths = f.candidates.filter((c) => isLikelySecretPath(c.path)).map((c) => c.path);
  if (secretPaths.length > 0) {
    blocking.push({ code: 'secret-files', detail: 'files that look like secrets would be committed — ignore or remove them first.', paths: secretPaths.slice(0, PATHS_CAP) });
  }

  const oversize = f.candidates.filter((c) => c.size > OVERSIZE_BYTES);
  if (oversize.length > 0) {
    blocking.push({
      code: 'oversize-file',
      detail: 'a file exceeds 95 MB — GitHub would reject the push.',
      paths: oversize.slice(0, PATHS_CAP).map((c) => `${c.path} (${c.size} bytes)`),
    });
  }

  // Nothing to commit: no candidate other than a bare .gitignore.
  if (f.candidates.filter((c) => c.path !== '.gitignore').length === 0) {
    blocking.push({ code: 'nothing-to-commit', detail: 'there is nothing to commit — the directory has no files that would be included.' });
  }

  // Warnings — block execute unless acknowledged.
  const largeFiles = f.candidates.filter((c) => c.size > LARGE_FILE_BYTES && c.size <= OVERSIZE_BYTES);
  if (largeFiles.length > 0) {
    warnings.push({
      code: 'large-file',
      detail: 'a file is larger than 10 MB — confirm you intend to commit it.',
      paths: largeFiles.slice(0, PATHS_CAP).map((c) => `${c.path} (${c.size} bytes)`),
    });
  }
  if (f.candidates.length > LARGE_TREE_COUNT) {
    warnings.push({ code: 'large-tree', detail: `the first commit would include more than ${LARGE_TREE_COUNT} files — confirm this is intended.` });
  }
  if (f.insideWorkTree) {
    warnings.push({ code: 'inside-work-tree', detail: 'this directory sits inside another git work-tree but has no .git of its own — confirm you want a separate repository here.' });
  }
  // git lists a nested untracked git repository as a single trailing-slash entry; `git add -A` would
  // commit it as a bare gitlink (a broken submodule). Warn so the operator resolves it deliberately.
  const nested = f.candidates.filter((c) => c.path.endsWith('/')).map((c) => c.path);
  if (nested.length > 0) {
    warnings.push({ code: 'nested-repo', detail: 'a nested git repository would be committed as a broken submodule (gitlink) — remove its .git or exclude it.', paths: nested.slice(0, PATHS_CAP) });
  }

  return { blocking, warnings };
}

// ---- candidate enumeration (git is the ignore-evaluator; ZERO writes to the project) ----

async function enumerateCandidates(
  repoPath: string,
  appendLines: string[],
): Promise<{ candidates: { path: string; size: number }[]; truncated: boolean; total: number }> {
  const scratch = mkdtempSync(join(tmpdir(), 'ct-bootstrap-'));
  try {
    await git.git(scratch, ['init']);
    const excludesPath = join(scratch, 'excludes');
    writeFileSync(excludesPath, appendLines.join('\n') + '\n');
    // -C scratch → git dir is scratch/.git; --work-tree repoPath overrides the work tree, so every file
    // in the project shows as untracked while NOTHING is written into the project. core.excludesFile
    // applies the to-be-appended patterns on top of the tree's own (root + nested) .gitignore files.
    // Documented caveat: core.excludesFile < per-directory .gitignore, so an existing negation can beat
    // the appended pattern HERE while the merged final file wins at execute — the execute-side verify
    // gate is authoritative regardless (this is labeled a preview).
    const res = await git.git(scratch, [
      '-c',
      'core.excludesFile=' + excludesPath,
      '--work-tree',
      repoPath,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    const entries = res.stdout.split('\0').filter((e) => e.length > 0);
    const paths = entries.map((e) => e.slice(3)); // strip the 3-char XY-space prefix
    const total = paths.length;
    const truncated = total > ENUMERATION_CAP;
    const capped = paths.slice(0, ENUMERATION_CAP);
    const candidates = capped.map((p) => {
      let size = 0;
      try {
        size = lstatSync(join(repoPath, p)).size;
      } catch {
        // vanished between enumeration and stat — skip its size
      }
      return { path: p, size };
    });
    return { candidates, truncated, total };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- injectable deps (probeRemote / runPush stubbable for tests; defaults use git()) ----

export interface BootstrapDeps {
  pushAuth?: (identityId: string | undefined) => { env: Record<string, string>; release: () => void } | undefined;
  probeRemote?: (repoPath: string, repoUrl: string, env?: Record<string, string>) => Promise<RemoteState>;
  runPush?: (repoPath: string, branch: string, env?: Record<string, string>) => Promise<git.GitResult>;
}

const remoteToWire = (r: RemoteState | { state: 'unchecked' }): RepoBootstrapPlan['remote'] => {
  if (r.state === 'has-refs') return { state: 'has-refs', detail: r.sample };
  if (r.state === 'unreachable') return { state: 'unreachable', detail: r.reason };
  return { state: r.state };
};

/** Is there ANY `.git` entry at the repo root — dir, file, or symlink (incl. a dangling one)? lstat does
 *  not follow the link, so it catches a dangling `.git` symlink that existsSync would report as absent. */
function gitEntryExists(repoPath: string): boolean {
  try {
    lstatSync(join(repoPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

// ---- preflight ----

export async function preflightBootstrap(
  project: Project,
  identity: GitHubIdentity | undefined,
  deps: BootstrapDeps,
): Promise<RepoBootstrapPlan> {
  const repoPath = project.repoPath;
  const identityEcho = identity ? { id: identity.id, label: identity.label, hasCredential: identity.hasCredential } : undefined;

  // 1. already-a-repo short-circuit. Use lstat, NOT existsSync: a .git that is a FILE (linked
  // worktree/submodule) or a symlink — including a DANGLING symlink (existsSync follows it → false,
  // then `git init` would follow the link and create the real git dir OUTSIDE the project, defeating
  // rollback) — must all count as already-a-repo and refuse.
  if (gitEntryExists(repoPath)) {
    const { blocking, warnings } = decideBootstrap({
      alreadyRepo: true,
      insideWorkTree: false,
      repoUrl: project.repoUrl,
      identity: identityEcho,
      candidates: [],
      truncated: false,
      remote: { state: 'unchecked' },
    });
    return {
      projectId: project.id,
      branch: 'main',
      repoUrl: project.repoUrl,
      identity: identityEcho,
      detectedStacks: [],
      gitignoreExists: existsSync(join(repoPath, '.gitignore')),
      gitignoreAppend: [],
      filesToCommit: [],
      fileTotal: 0,
      truncated: false,
      remote: { state: 'unchecked' },
      blocking,
      warnings,
    };
  }

  // 2. nested-inside-another-work-tree (own .git absent).
  const insideWorkTree = await git.isGitRepo(repoPath);

  // 3. stacks + existing .gitignore + merge.
  let rootEntries: string[] = [];
  try {
    rootEntries = readdirSync(repoPath);
  } catch {
    /* unreadable dir — leaves detection empty; enumeration will surface the real error */
  }
  const detectedStacks = detectStacks(rootEntries);
  const gitignorePath = join(repoPath, '.gitignore');
  const gitignoreExists = existsSync(gitignorePath);
  const existingGitignore = gitignoreExists ? readFileSync(gitignorePath, 'utf8') : undefined;
  const { appended } = mergeGitignore(existingGitignore, gitignoreTemplate(detectedStacks));

  // 4. candidate enumeration.
  const { candidates, truncated, total } = await enumerateCandidates(repoPath, appended);

  // 5. remote probe — only when a brokerable repoUrl AND a credentialed identity are present (else a
  // missing precondition is already a blocker); the broker grant is released in finally on every path.
  let remote: RemoteState | { state: 'unchecked' } = { state: 'unchecked' };
  if (project.repoUrl && isBrokerableGitHubPushUrl(project.repoUrl) && identity?.hasCredential) {
    const grant = deps.pushAuth?.(identity.id);
    try {
      const probe =
        deps.probeRemote ?? (async (rp, url, env) => classifyRemote(await git.git(rp, ['ls-remote', url], env)));
      remote = await probe(repoPath, project.repoUrl, grant?.env);
    } finally {
      grant?.release();
    }
  }

  // 6. decide + assemble.
  const { blocking, warnings } = decideBootstrap({
    alreadyRepo: false,
    insideWorkTree,
    repoUrl: project.repoUrl,
    identity: identityEcho,
    candidates,
    truncated,
    remote,
  });

  return {
    projectId: project.id,
    branch: 'main',
    repoUrl: project.repoUrl,
    identity: identityEcho,
    detectedStacks,
    gitignoreExists,
    gitignoreAppend: appended,
    filesToCommit: candidates.slice(0, WIRE_FILE_CAP),
    fileTotal: total,
    truncated,
    remote: remoteToWire(remote),
    blocking,
    warnings,
  };
}

// ---- execute ----

export type BootstrapOutcome =
  | { kind: 'refused'; error: string; blocking: RepoBootstrapIssue[]; warnings: RepoBootstrapIssue[] }
  | { kind: 'failed'; error: string }
  | { kind: 'done'; result: RepoBootstrapResult };

const FINISH_CMD = 'git push -u origin main';

/** Scan a NUL-separated path list (from `status --porcelain -z` after stripping the 3-char prefix, or
 *  from `diff --cached --name-only -z`) for anything that must never be committed. Scans the FULL list —
 *  the enumeration cap is preview-only; a secret past the cap must still be caught here. */
function gateHits(repoPath: string, paths: string[]): { secrets: string[]; localContext: string[]; oversize: string[] } {
  const secrets: string[] = [];
  const localContext: string[] = [];
  const oversize: string[] = [];
  for (const p of paths) {
    if (p === '.local-context' || p.startsWith('.local-context/')) localContext.push(p);
    else if (isLikelySecretPath(p)) secrets.push(p);
    let size = 0;
    try {
      size = lstatSync(join(repoPath, p)).size;
    } catch {
      /* vanished — skip */
    }
    if (size > OVERSIZE_BYTES) oversize.push(`${p} (${size} bytes)`);
  }
  return { secrets, localContext, oversize };
}

export async function executeBootstrap(
  project: Project,
  identity: GitHubIdentity | undefined,
  deps: BootstrapDeps,
  opts: { acceptWarnings: boolean },
): Promise<BootstrapOutcome> {
  const repoPath = project.repoPath;

  // 1. terminal gate: re-run the full preflight.
  const plan = await preflightBootstrap(project, identity, deps);
  if (plan.blocking.length > 0) {
    return { kind: 'refused', error: plan.blocking.map((b) => `${b.code}: ${b.detail}`).join('; '), blocking: plan.blocking, warnings: plan.warnings };
  }
  if (plan.warnings.length > 0 && !opts.acceptWarnings) {
    const issue: RepoBootstrapIssue = {
      code: 'unacknowledged-warnings',
      detail: "review and acknowledge the warnings in the project's Initialize & push preview before proceeding.",
    };
    return { kind: 'refused', error: `${issue.code}: ${issue.detail}`, blocking: [issue, ...plan.warnings], warnings: plan.warnings };
  }

  // repoUrl + a credentialed identity are guaranteed non-null past the blocking gate; narrow for TS.
  if (!project.repoUrl || !identity) {
    return { kind: 'failed', error: 'missing repo URL or identity after preflight passed (unexpected)' };
  }

  const identityEnv: Record<string, string> = {
    GIT_AUTHOR_NAME: identity.gitName,
    GIT_AUTHOR_EMAIL: identity.gitEmail,
    GIT_COMMITTER_NAME: identity.gitName,
    GIT_COMMITTER_EMAIL: identity.gitEmail,
  };

  const gitDir = join(repoPath, '.git');
  const rmGitDir = (): void => {
    try {
      rmSync(gitDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  };

  // 3. init (fixed 'main'). Fallback for old git: init + symbolic-ref.
  // TOCTOU guard: the already-repo proof ran at the start of the preflight above, before a full-tree
  // scan + a network ls-remote — seconds ago. Re-check immediately before init so an outside `git init`
  // that landed in that window is refused (never reinitialized), keeping rmGitDir's "this run created
  // the .git" invariant true.
  if (gitEntryExists(repoPath)) {
    return { kind: 'refused', error: 'already-repo: this directory became a git repository while the bootstrap was preparing', blocking: [{ code: 'already-repo', detail: 'a .git appeared during preflight — nothing was changed' }], warnings: [] };
  }
  // Prefer `init -b main`; fall back to a plain `init` for git < 2.28. Do NOT name the branch yet — the
  // reinit belt below must inspect the repo's REAL HEAD/refs before we touch HEAD (on the fallback path
  // a `symbolic-ref` would otherwise move an outside repo's HEAD and blind the probe).
  let init = await git.git(repoPath, ['init', '-b', 'main']);
  let usedFallback = false;
  if (!init.ok) {
    init = await git.git(repoPath, ['init']);
    usedFallback = true;
  }
  if (!init.ok) {
    rmGitDir(); // a partial .git can remain — same step-1 safety proof (no .git pre-existed)
    return { kind: 'failed', error: `git init failed: ${cap(init.stderr)}` };
  }
  // Belt for the millisecond gap between the recheck above and init: `git init` on an existing repo
  // exits 0 and REINITIALIZES it, leaving its refs/commits intact. Detect that locale-independently
  // (the "Reinitialized existing" message is a translated gettext string) via git plumbing, and refuse
  // WITHOUT rmGitDir — deleting a .git (and commits) this run did not create would be data loss. Two
  // probes cover both init paths and the orphan-HEAD corner: HEAD resolving to a commit, OR any ref
  // existing even when HEAD is unborn. A genuine fresh init has neither, so we proceed. (Residual: a
  // truly empty reinit — no refs, no commits — is undetectable post-init; its only harm is discarding an
  // outside empty .git's config/hooks, which the earlier recheck already makes a ms-wide race.)
  const headProbe = await git.git(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const refProbe = await git.git(repoPath, ['for-each-ref', '--count=1']);
  // Fail CLOSED if the ref state is unreadable: an errored for-each-ref could be hiding pre-existing
  // refs, so refuse WITHOUT rmGitDir rather than proceed (never delete a .git whose contents we could
  // not verify are ours). Practically unreachable — git init just exited 0 on this .git — but strict.
  // (headProbe uses --verify --quiet, which returns ok:false for a normal unborn HEAD, so it is NOT a
  // readability signal and must not gate here.)
  if (!refProbe.ok) {
    return { kind: 'failed', error: `could not read the repository refs to screen for a pre-existing repo: ${cap(refProbe.stderr)}` };
  }
  if ((headProbe.ok && headProbe.stdout.trim() !== '') || refProbe.stdout.trim() !== '') {
    return { kind: 'refused', error: 'already-repo: this directory is already a git repository', blocking: [{ code: 'already-repo', detail: 'git reinitialized an existing repository (it has refs or commits) — no commit or file was changed' }], warnings: [] };
  }
  // Clean fresh init confirmed. Only now — on the fallback path — name the initial branch main.
  if (usedFallback) {
    const sr = await git.git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    if (!sr.ok) {
      rmGitDir(); // safe — the probe above proved no pre-existing refs/commits; this .git is ours
      return { kind: 'failed', error: `git init failed: ${cap(sr.stderr)}` };
    }
  }
  // rollback() is safe: step 1 proved no .git existed, so this .git was created by THIS run.

  let sha: string | undefined;
  let fileCount = 0;
  try {
    // 4. write merged .gitignore only when changed; create .local-context/.
    const gitignorePath = join(repoPath, '.gitignore');
    const existingGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : undefined;
    const detectedStacks = detectStacks(existsSync(repoPath) ? readdirSync(repoPath) : []);
    const merged = mergeGitignore(existingGitignore, gitignoreTemplate(detectedStacks));
    if (merged.content !== existingGitignore) writeFileSync(gitignorePath, merged.content);
    mkdirSync(join(repoPath, '.local-context'), { recursive: true });

    // 5. VERIFY GATE (authoritative) — scan the FULL untracked list (uncapped).
    const statusRes = await git.git(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    // FAIL CLOSED on a non-ok status: git()'s 32 MiB maxBuffer overflow returns {ok:false, stdout:<truncated>},
    // and `git add -A` below stages the FULL tree regardless — so scanning a truncated list would let a
    // secret past the cut be committed. A failed/truncated scan is never treated as "clean".
    if (!statusRes.ok) {
      rmGitDir();
      return { kind: 'failed', error: `could not read the working tree to screen it for secrets: ${cap(statusRes.stderr)}` };
    }
    const statusPaths = statusRes.stdout.split('\0').filter((e) => e.length > 0).map((e) => e.slice(3));
    let hits = gateHits(repoPath, statusPaths);
    if (hits.secrets.length || hits.localContext.length || hits.oversize.length) {
      rmGitDir();
      return refuseGate(hits);
    }

    // 6. stage everything.
    const add = await git.git(repoPath, ['add', '-A', '--']);
    if (!add.ok) {
      rmGitDir();
      return { kind: 'failed', error: `git add failed: ${cap(add.stderr)}` };
    }

    // 7. belt: re-scan the FULL staged list.
    const staged = await git.git(repoPath, ['diff', '--cached', '--name-only', '-z']);
    // Same fail-closed rule as the gate: a truncated/failed staged scan must never read as "no secrets".
    if (!staged.ok) {
      await git.git(repoPath, ['reset']);
      rmGitDir();
      return { kind: 'failed', error: `could not read the staged files to screen them for secrets: ${cap(staged.stderr)}` };
    }
    const stagedPaths = staged.stdout.split('\0').filter((e) => e.length > 0);
    hits = gateHits(repoPath, stagedPaths);
    if (hits.secrets.length || hits.localContext.length || hits.oversize.length) {
      await git.git(repoPath, ['reset']);
      rmGitDir();
      return refuseGate(hits);
    }
    if (stagedPaths.length === 0) {
      rmGitDir();
      return { kind: 'failed', error: 'nothing staged for the first commit' };
    }
    fileCount = stagedPaths.length;

    // 8. commit — the point of no return.
    const commit = await git.git(repoPath, ['commit', '-m', 'Initial commit'], identityEnv);
    if (!commit.ok) {
      rmGitDir();
      return { kind: 'failed', error: `git commit failed: ${cap(commit.stderr)}` };
    }
    sha = (await git.git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
  } catch (e) {
    // Any throw BEFORE the sha is recorded (writeFileSync/mkdirSync/lstat EACCES, disk-full, …).
    rmGitDir();
    return { kind: 'failed', error: cap((e as Error)?.message ?? 'bootstrap failed') };
  }

  // ===== POINT OF NO RETURN — sha recorded; NEVER roll back below. Push failure is non-fatal. =====

  // 9. remote add.
  const remoteAdd = await git.git(repoPath, ['remote', 'add', 'origin', project.repoUrl]);
  if (!remoteAdd.ok) {
    return {
      kind: 'done',
      result: {
        initialized: true,
        committed: true,
        pushed: false,
        branch: 'main',
        commit: sha,
        fileCount,
        detail: `repo initialized and first commit created; adding the remote failed: ${cap(remoteAdd.stderr)} — finish with \`git remote add origin ${project.repoUrl} && ${FINISH_CMD}\``,
        pushError: `remote add failed: ${cap(remoteAdd.stderr)}`,
      },
    };
  }

  // 10. push (fixed argv — never force). The grant acquisition is INSIDE the try: acquireDaemonPush
  // writes a token file and can throw (e.g. disk-full), and post-commit that must degrade to a non-fatal
  // push failure, never a post-commit 500. Grant released in finally; a throwing injected runPush is
  // likewise absorbed.
  let grant: { env: Record<string, string>; release: () => void } | undefined;
  let push: git.GitResult;
  try {
    grant = deps.pushAuth?.(identity.id);
    const doPush = deps.runPush ?? (async (rp, branch, env) => git.git(rp, ['push', '-u', 'origin', branch], env));
    push = await doPush(repoPath, 'main', grant?.env);
  } catch (e) {
    push = { ok: false, stdout: '', stderr: (e as Error)?.message ?? 'push threw' };
  } finally {
    grant?.release();
  }

  if (push.ok) {
    return {
      kind: 'done',
      result: {
        initialized: true,
        committed: true,
        pushed: true,
        branch: 'main',
        commit: sha,
        fileCount,
        detail: `initialized, committed ${fileCount} file(s), pushed main to ${project.repoUrl}`,
      },
    };
  }
  return {
    kind: 'done',
    result: {
      initialized: true,
      committed: true,
      pushed: false,
      branch: 'main',
      commit: sha,
      fileCount,
      detail: `repo initialized and first commit created; push failed: ${cap(push.stderr)} — fix the cause, then run \`${FINISH_CMD}\` (or push from a Tower terminal)`,
      pushError: cap(push.stderr),
    },
  };
}

function refuseGate(hits: { secrets: string[]; localContext: string[]; oversize: string[] }): BootstrapOutcome {
  const blocking: RepoBootstrapIssue[] = [];
  if (hits.secrets.length) blocking.push({ code: 'secret-files', detail: 'the verify gate found files that look like secrets — the repo was rolled back; the merged .gitignore and .local-context/ remain in place, the directory is otherwise restored.', paths: hits.secrets.slice(0, PATHS_CAP) });
  if (hits.localContext.length) blocking.push({ code: 'local-context-leak', detail: '.local-context/ must never be committed — the repo was rolled back.', paths: hits.localContext.slice(0, PATHS_CAP) });
  if (hits.oversize.length) blocking.push({ code: 'oversize-file', detail: 'a file exceeds 95 MB — the repo was rolled back.', paths: hits.oversize.slice(0, PATHS_CAP) });
  return { kind: 'refused', error: blocking.map((b) => `${b.code}: ${b.detail}`).join('; '), blocking, warnings: [] };
}
