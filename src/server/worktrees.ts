// Worktree orchestration + Review & Land (SPEC §10/§11, M3). One worktree per
// agent/task with a Tower-generated unique branch, on demand (no pre-warmed pool
// until latency is measured as painful). Dirty worktrees are first-class and are
// NEVER force-removed. Landing is either a guarded local merge or a PR.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as git from './git.js';
import { isBrokerableGitHubPushUrl, parseGitHubOwnerRepo } from './broker.js';
// Type-only imports so worktrees gains NO runtime network dependency — its only broker RUNTIME imports
// stay the pure isBrokerableGitHubPushUrl + parseGitHubOwnerRepo. The live createGitHubPr is injected.
import type { CreatePrArgs, CreatePrResult } from './broker.js';
import { shortId, isSafeName } from './ids.js';
import { audit } from './audit.js';
import { CT_WORKTREES_DIRNAME, normalizeRepoPath } from './paths.js';
import { Leases, LeaseHeldError } from './leases.js';
import type { Project, Terminal, DiffSummary, ProviderId } from '../shared/types.js';

function slugify(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return s || 'task';
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  base: string;
}

export class WorktreeManager {
  // Land serializes per BASE REPO and remove refuses held trees via these leases (§3). pushAuth (injected
  // by server.ts as broker.acquireDaemonPush) brokers an ephemeral identity-scoped credential for land()'s
  // PR push; absent/undefined-returning ⇒ the push runs with ambient daemon credentials (fail-open).
  constructor(
    private leases: Leases,
    private pushAuth?: (identityId: string | undefined) => { env: Record<string, string>; release: () => void } | undefined,
    // Injected by server.ts: opens a PR for a pushed branch using the identity's PAT (held in a
    // request-scoped closure there — worktrees never sees the token). Absent ⇒ push-only land (the
    // pre-this-wave behavior), so a caller that wires no createPr is unchanged.
    private createPr?: (identityId: string, args: CreatePrArgs) => Promise<CreatePrResult>,
  ) {}

  /** Create a fresh worktree + unique branch off the project's base branch. */
  async create(project: Project, provider: ProviderId, taskLabel?: string): Promise<CreatedWorktree> {
    if (!(await git.isGitRepo(project.repoPath))) {
      throw new Error('project is not a git repository — worktrees need git');
    }
    const base = await git.defaultBase(project.repoPath);
    const slug = slugify(taskLabel ?? provider);
    // Tower-generated, guaranteed-unique branch (git hard-errors on double-checkout).
    const suffix = shortId(6);
    const branch = `agent/${slug}/${suffix}`;
    if (!branch.split('/').every((seg) => isSafeName(seg) || /^[a-z0-9-]+$/.test(seg))) {
      throw new Error('unsafe branch name');
    }
    const root = join(dirname(normalizeRepoPath(project.repoPath)), CT_WORKTREES_DIRNAME, project.id);
    mkdirSync(root, { recursive: true });
    const path = join(root, `${slug}-${suffix}`);
    const res = await git.worktreeAdd(project.repoPath, path, branch, base);
    if (!res.ok) throw new Error(`worktree add failed: ${res.stderr.trim()}`);
    audit('worktree.create', { projectId: project.id, path, branch, base });
    return { path, branch, base };
  }

  /** Diff + commit + dirty summary for a terminal's worktree (Review). */
  async review(project: Project, term: Terminal): Promise<DiffSummary> {
    if (!term.worktreePath || !term.branch || !term.baseBranch) {
      throw new Error('terminal has no worktree to review');
    }
    const [st, files, commits] = await Promise.all([
      git.status(term.worktreePath),
      git.diffStat(project.repoPath, term.baseBranch, term.branch),
      git.log(project.repoPath, term.baseBranch, term.branch),
    ]);
    return {
      base: term.baseBranch,
      branch: term.branch,
      dirty: st.dirty,
      uncommitted: st.files,
      files,
      commits,
    };
  }

  async patch(project: Project, term: Terminal, file?: string): Promise<string> {
    if (!term.branch || !term.baseBranch) throw new Error('no worktree');
    return git.diffPatch(project.repoPath, term.baseBranch, term.branch, file);
  }

  /**
   * Land a terminal's branch. mode 'merge' does a guarded local no-ff merge into the base (only if the
   * main checkout is on base and clean); mode 'pr' pushes the branch to the remote and, for a brokerable
   * github.com https remote whose identity has a stored credential, opens a PR via one in-process GitHub
   * REST call. PR creation is NON-FATAL: a failed attempt still returns the successful-push result.
   */
  async land(
    project: Project,
    term: Terminal,
    mode: 'merge' | 'pr',
    title?: string,
  ): Promise<{ mode: string; detail: string; prUrl?: string }> {
    if (!term.branch || !term.baseBranch) throw new Error('terminal has no worktree branch');
    const review = await this.review(project, term);
    if (review.dirty) throw new Error('worktree has uncommitted changes — commit or discard them first');
    if (review.commits.length === 0) throw new Error('no commits on this branch to land');

    if (mode === 'merge') {
      // Serialize lands per BASE REPO: only merge mutates the shared checkout,
      // so a second concurrent land into this repo gets a clean 409 (LeaseHeldError)
      // instead of an index.lock collision. acquire is BEFORE the try so a 409 here does
      // not run the finally-release. PR mode pushes only the branch and stays unleased.
      this.leases.acquire(project.repoPath, { kind: 'land', id: term.id });
      try {
        const cur = await git.currentBranch(project.repoPath);
        if (cur !== term.baseBranch) {
          throw new Error(`main checkout is on '${cur}', not base '${term.baseBranch}'. Switch it to base, or use PR mode.`);
        }
        const mainStatus = await git.status(project.repoPath);
        if (mainStatus.dirty) throw new Error('main checkout has uncommitted changes — clean it or use PR mode');
        const msg = title ?? `Merge ${term.branch}`;
        const res = await git.git(project.repoPath, ['merge', '--no-ff', term.branch, '-m', msg]);
        if (!res.ok) {
          // A conflicted land must leave base pristine — never a wedged MERGING
          // checkout that blocks every other land on the repo. Abort, re-verify clean,
          // then throw a message that distinguishes a clean rollback from a stuck tree.
          await git.git(project.repoPath, ['merge', '--abort']);
          const after = await git.status(project.repoPath);
          if (after.dirty) {
            throw new Error(`merge conflict — abort failed, MANUAL CLEANUP NEEDED: ${res.stderr.trim()}`);
          }
          throw new Error(`merge conflict — aborted; base checkout restored: ${res.stderr.trim()}`);
        }
        audit('worktree.land', { projectId: project.id, branch: term.branch, mode: 'merge' });
        return { mode: 'merge', detail: `merged ${term.branch} into ${term.baseBranch}` };
      } finally {
        this.leases.release(project.repoPath, term.id);
      }
    }

    // PR mode: outward-facing. Requires a remote; refuse cleanly otherwise. Resolve the remote name for
    // real (no more hardcoded 'origin'): prefer origin, accept a sole remote, refuse an ambiguous set.
    const remoteList = await git.git(project.repoPath, ['remote']);
    const remotes = remoteList.stdout.split('\n').map((r) => r.trim()).filter(Boolean);
    if (remotes.length === 0) throw new Error('no git remote configured — cannot open a PR');
    const remote = git.pickPushRemote(remotes);
    if (!remote) throw new Error(`multiple remotes and none named 'origin' (${remotes.join(', ')}) — cannot choose one to push to`);
    // Honor the per-terminal / per-project GitHub identity: broker an ephemeral identity-scoped push
    // credential. FAIL-OPEN — no identity, an unknown one, or one without a token yields no grant, so the
    // push runs with the ambient daemon credentials exactly as before (audited brokered:false).
    //
    // Only broker a push to an allowlisted GitHub https remote. The broker's grant env RESETS the
    // daemon's ambient credential.helper and then serves credentials ONLY to allowlisted GitHub hosts;
    // if the actual remote is SSH or a non-GitHub https host (GitHub Enterprise / GitLab), brokering
    // would strip the ambient helper and then refuse — breaking a push that works today. So resolve the
    // remote's real push URL and skip the grant unless it is a GitHub https URL: stay truly fail-open on
    // the ambient credentials for every host the broker cannot serve.
    const identityId = term.identityId ?? project.defaultIdentityId;
    const pushUrlRes = await git.git(project.repoPath, ['remote', 'get-url', '--push', remote]);
    const pushUrl = pushUrlRes.stdout.trim();
    const brokerable = pushUrlRes.ok && isBrokerableGitHubPushUrl(pushUrl);
    const grant = brokerable ? this.pushAuth?.(identityId) : undefined;
    try {
      const push = await git.git(project.repoPath, ['push', '-u', remote, term.branch], grant?.env);
      if (!push.ok) throw new Error(`push failed: ${push.stderr.trim()}`);
    } finally {
      grant?.release();
    }
    audit('worktree.land', {
      projectId: project.id, branch: term.branch, mode: 'pr', remote, identityId, brokered: !!grant,
      // Record why an identity-bound push still went out on ambient creds, so a non-GitHub remote is
      // an obvious log line rather than a silent "why isn't my identity used".
      ...(identityId && !brokerable ? { brokerSkipped: 'non-github-remote' } : {}),
    });

    // The push has SUCCEEDED and is committed. Everything below is best-effort PR creation and MUST stay
    // NON-FATAL — a failed attempt still returns a 'pr' result describing the successful push.
    // Attempt a PR only for a brokerable github.com https remote we can parse as owner/repo, with a
    // credential-bearing identity (grant present) and the createPr dep wired. prAttemptArgs encodes
    // that decision (and its load-bearing `parsed !== undefined` gate: a brokerable host can still carry
    // a path like `/owner/repo/extra` that parses to undefined — never call the API with a mangled
    // owner/repo) as a pure, unit-tested function, returning the narrowed args or undefined.
    const attempt = prAttemptArgs({
      brokerable, hasGrant: !!grant, identityId, baseBranch: term.baseBranch,
      parsed: parseGitHubOwnerRepo(pushUrl),
    });
    let pr: CreatePrResult | undefined;
    if (attempt && this.createPr) {
      const prTitle = title ?? review.commits[review.commits.length - 1]?.subject ?? `Merge ${term.branch}`;
      // The non-fatal guarantee is structural HERE, not merely a property of the injected createPr: the
      // push already succeeded and is committed, so even a throwing createPr must degrade to a push-only
      // result, never fault the land.
      try {
        pr = await this.createPr(attempt.identityId, {
          owner: attempt.owner, repo: attempt.repo, head: term.branch, base: attempt.baseBranch, title: prTitle,
        });
      } catch (err) {
        pr = { ok: false, reason: `PR request failed: ${(err as Error).message}`.slice(0, 300) };
      }
      // Audit the PR attempt with ENUMERATED fields only — never the response body/headers, never a token.
      audit('worktree.pr', {
        projectId: project.id,
        branch: term.branch,
        ok: pr.ok,
        ...(pr.ok ? (pr.url ? { url: pr.url } : {}) : { reason: pr.reason }),
        ...(pr.ok && pr.existing ? { existing: true } : {}),
      });
    }
    const { detail, prUrl } = formatPrLandDetail(`pushed ${term.branch} to ${remote}`, pr);
    return { mode: 'pr', detail, ...(prUrl ? { prUrl } : {}) };
  }

  /** Remove a worktree. Refuses to destroy uncommitted work (dirty => caller decides). */
  async remove(project: Project, term: Terminal): Promise<{ removed: boolean; dirty: boolean }> {
    if (!term.worktreePath) return { removed: false, dirty: false };
    // Refuse to reap a tree still held by a DIFFERENT owner (an
    // adopted, actively-driven builder). Its own terminal removing it is fine. Let the
    // LeaseHeldError propagate — the route maps it to HTTP 409 naming the holder.
    const held = this.leases.holder(term.worktreePath);
    if (held && held.id !== term.id) throw new LeaseHeldError(held);
    const st = await git.status(term.worktreePath);
    if (st.dirty) return { removed: false, dirty: true };
    const res = await git.worktreeRemove(project.repoPath, term.worktreePath, false);
    if (!res.ok && !res.stderr.includes('is not a working tree')) {
      throw new Error(`worktree remove failed: ${res.stderr.trim()}`);
    }
    // Delete the branch only if it's safe (merged or on a remote).
    if (term.branch && term.baseBranch && (await git.isBranchSafeToDelete(project.repoPath, term.baseBranch, term.branch))) {
      await git.git(project.repoPath, ['branch', '-D', term.branch]);
    }
    audit('worktree.remove', { projectId: project.id, path: term.worktreePath });
    return { removed: true, dirty: false };
  }

  async listForProject(project: Project): Promise<git.WorktreeRow[]> {
    if (!(await git.isGitRepo(project.repoPath))) return [];
    return git.worktreeList(project.repoPath);
  }
}

/** land()'s PR-attempt decision, pure so the load-bearing gates (esp. `parsed !== undefined`, which a
 *  live push can't reach — the push to an unparseable-but-brokerable URL fails first) are unit-testable.
 *  Returns the narrowed args when a PR should be attempted, else undefined (push-only). The createPr dep
 *  is checked at the call site (it isn't decision input — a missing dep just means push-only). */
export function prAttemptArgs(x: {
  brokerable: boolean;
  hasGrant: boolean;
  identityId: string | undefined;
  baseBranch: string | undefined;
  parsed: { owner: string; repo: string } | undefined;
}): { owner: string; repo: string; identityId: string; baseBranch: string } | undefined {
  if (!x.brokerable || !x.hasGrant || !x.identityId || !x.baseBranch || x.parsed === undefined) return undefined;
  return { owner: x.parsed.owner, repo: x.parsed.repo, identityId: x.identityId, baseBranch: x.baseBranch };
}

/** Compose the land 'pr' detail message + optional PR URL from the push line and the PR attempt result.
 *  Pure so the (non-fatal) wording is unit-tested against every shape:
 *   - undefined (PR not attempted) → the byte-identical push-only message.
 *   - ok → opened / already-open, carrying the URL when one was recovered.
 *   - fail → "PR not created: <reason>" — the push still succeeded, so the wording says so. */
export function formatPrLandDetail(pushed: string, pr: CreatePrResult | undefined): { detail: string; prUrl?: string } {
  if (pr === undefined) return { detail: `${pushed}; open the PR from your host or via gh` };
  if (pr.ok) {
    const verb = pr.existing ? 'a PR is already open' : 'opened a PR';
    if (pr.url) return { detail: `${pushed}; ${verb}: ${pr.url}`, prUrl: pr.url };
    return { detail: `${pushed}; ${verb}` };
  }
  return { detail: `${pushed}; PR not created: ${pr.reason} — open it from your host or via gh` };
}
