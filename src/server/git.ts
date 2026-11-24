// Git plumbing. Every invocation runs with hooks and system/global config
// neutralized (SPEC §8/S3): a freshly added repo may be hostile, and we must never
// let its core.hooksPath / clean-smudge filters execute as the Tower. argv arrays
// only — never shell strings — so branch/task names can't inject.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// NOTE: we do NOT set GIT_CONFIG_GLOBAL=/dev/null — global config is the USER's own
// ~/.gitconfig (not repo-controlled), and neutralizing it strips the committer identity
// the Tower's own `git merge` in land() relies on. The hostile-repo threat is the repo's
// LOCAL config + attributes, which core.hooksPath, --no-textconv and --no-ext-diff cover.
const SAFE_ENV = {
  ...process.env,
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_EXTERNAL_DIFF: '',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  // Neutralize git's trace family. SAFE_ENV inherits the WHOLE daemon environment, so a stray
  // GIT_TRACE_CURL / GIT_CURL_VERBOSE would make git dump the HTTP Authorization header — the broker's
  // ephemeral push PAT (served via credential.helper, never the URL) — onto its own stderr, which a
  // failed land()/push then surfaces (worktrees.ts throws `push failed: ${stderr}`) into error
  // messages, the audit log, and the delivery report. '0' is git's disabled value; because these come
  // AFTER the ...process.env spread, our values win over whatever the environment set.
  GIT_TRACE: '0',
  GIT_TRACE_CURL: '0',
  GIT_CURL_VERBOSE: '0',
  GIT_TRACE_PACKET: '0',
};

export async function git(repo: string, args: string[], envOverride?: Record<string, string>): Promise<GitResult> {
  try {
    const { stdout, stderr } = await pexec(
      'git',
      [
        '-C',
        repo,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        // The Tower's own commits/merges (e.g. land()'s `merge --no-ff`) run headless with
        // no TTY, so a user's global commit.gpgsign=true would make git try to invoke gpg/
        // pinentry and abort with 'gpg failed to sign the data'. Disable signing for the
        // Tower's git ops (this affects only the daemon's git, never the agents').
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      // envOverride carries non-secret authorship (GIT_AUTHOR_*/GIT_COMMITTER_*) so a loop's
      // per-iteration auto-commits are attributed to the loop's GitHub identity, not the
      // daemon's ~/.gitconfig. Never a credential — the broker still serves those at push.
      { env: envOverride ? { ...SAFE_ENV, ...envOverride } : SAFE_ENV, maxBuffer: 32 * 1024 * 1024 },
    );
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? 'git error' };
  }
}

export async function isGitRepo(repo: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true';
}

export async function currentBranch(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
}

/** Best-effort base branch: origin's HEAD, else main/master, else current branch. */
export async function defaultBase(repo: string): Promise<string> {
  const originHead = await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead.ok && originHead.stdout.trim()) return originHead.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    if ((await git(repo, ['rev-parse', '--verify', '--quiet', b])).ok) return b;
  }
  return currentBranch(repo);
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', branch])).ok;
}

/** Pick the remote to push to from a repo's remote names: prefer 'origin'; else the sole remote; else
 *  undefined (0 remotes, or 2+ with no 'origin' — ambiguous, so the caller must refuse rather than guess). */
export function pickPushRemote(names: string[]): string | undefined {
  if (names.includes('origin')) return 'origin';
  if (names.length === 1) return names[0];
  return undefined;
}

export async function worktreeAdd(repo: string, path: string, branch: string, base: string): Promise<GitResult> {
  // NOTE: repo-local clean/smudge FILTER drivers (gitattributes `filter=x` +
  // `[filter "x"] clean/smudge`) fire on checkout here and are NOT fully
  // neutralizable via git flags/env — unlike textconv/external-diff, there is no
  // switch that disables an arbitrary filter command during `worktree add`. That
  // residual class is covered only by per-agent OS isolation (the M4 hardening).
  return git(repo, ['worktree', 'add', '-b', branch, path, base]);
}

export interface WorktreeRow {
  path: string;
  branch?: string;
  head?: string;
  bare?: boolean;
  detached?: boolean;
}

export async function worktreeList(repo: string): Promise<WorktreeRow[]> {
  const res = await git(repo, ['worktree', 'list', '--porcelain']);
  const rows: WorktreeRow[] = [];
  let cur: WorktreeRow | null = null;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) rows.push(cur);
      cur = { path: line.slice('worktree '.length) };
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (cur && line === 'bare') cur.bare = true;
    else if (cur && line === 'detached') cur.detached = true;
  }
  if (cur) rows.push(cur);
  return rows;
}

export async function worktreeRemove(repo: string, path: string, force = false): Promise<GitResult> {
  const args = ['worktree', 'remove', path];
  if (force) args.push('--force');
  const res = await git(repo, args);
  await git(repo, ['worktree', 'prune']);
  return res;
}

export interface WorkStatus {
  dirty: boolean;
  files: { status: string; path: string }[];
}

export async function status(worktreePath: string): Promise<WorkStatus> {
  const res = await git(worktreePath, ['status', '--porcelain=v1']);
  const files = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  return { dirty: files.length > 0, files };
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  status: string;
}

/** Files + line counts between base and branch tips (three-dot: changes on branch). */
export async function diffStat(repo: string, base: string, branch: string): Promise<DiffFile[]> {
  const res = await git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', `${base}...${branch}`]);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [added, removed, ...rest] = l.split('\t');
      return {
        path: rest.join('\t'),
        added: added === '-' ? 0 : Number(added),
        removed: removed === '-' ? 0 : Number(removed),
        status: added === '-' ? 'bin' : 'mod',
      };
    });
}

export async function diffPatch(repo: string, base: string, branch: string, file?: string): Promise<string> {
  // --no-ext-diff disables external diff drivers (repo-local diff.external / any
  // GIT_EXTERNAL_DIFF) the correct way — unlike `-c diff.external=`, which git treats
  // as an empty diff command and dies, blanking the whole patch view.
  const args = ['diff', '--no-ext-diff', '--no-textconv', `${base}...${branch}`];
  if (file) args.push('--', file);
  return (await git(repo, args)).stdout;
}

/** Commits on branch not on base. */
export async function log(repo: string, base: string, branch: string): Promise<{ sha: string; subject: string }[]> {
  const res = await git(repo, ['log', '--format=%h%x00%s', `${base}..${branch}`]);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, subject] = l.split('\0');
      return { sha: sha ?? '', subject: subject ?? '' };
    });
}

/** A branch is safe to delete only if it's merged into base or exists on a remote. */
export async function isBranchSafeToDelete(repo: string, base: string, branch: string): Promise<boolean> {
  const merged = await git(repo, ['branch', '--merged', base, '--format=%(refname:short)']);
  if (merged.stdout.split('\n').map((s) => s.trim()).includes(branch)) return true;
  const remotes = await git(repo, ['branch', '-r', '--list', `*/${branch}`]);
  return remotes.stdout.trim().length > 0;
}
