// The regression gate (SPEC-STORYLOOP §4/S4). Before a mission lands a completed phase, the gate
// integrates every done sortie's branch into a DISPOSABLE trial-merge worktree — never the shared
// base — runs the mission's e2e suite against that fully-integrated tree, and returns a verdict.
// runAdvance lands NOTHING unless the verdict is 'pass'. This makes the regression check enforced
// in code at the land boundary, yet its worst case only ever degrades to today's per-land behavior:
// base is untouched until the gate is green, so a red gate leaves `git status` on base exactly as
// clean as before the advance (⟦DP-S4⟧).
//
// Why a trial worktree and not sequential-land-with-rollback: sorties land one at a time with NO
// un-land, and the codebase has no rollback machinery by deliberate design (§0.4) — a post-land
// gate is a detector, not a gate, and a rollback gate would have to `git reset` the single shared
// base checkout the land guards exist to protect. A throwaway worktree touches neither base nor its
// land lease (§0.6), so the gate composes cleanly with the existing sortie-by-sortie land.
//
// The suite runs IN-PROCESS: the gate holds no server-side terminal token, so it can NOT
// reuse `towerctl test run` (that path requires an agent terminal). It mints a terminal-less
// `kind:'gate'` run via TestKit.acquireGate and execs the raw suite like loops.runCheck — detached,
// so a timeout kills the whole process group (orphaned Chromium included). Gate runs are tagged so
// every user-facing derivation (chips, coverage, the fixer-assignment join) excludes them.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as git from './git.js';
import { parsePlaywrightResults } from './testkit.js';
import { shortId } from './ids.js';
import { audit } from './audit.js';
import { CT_WORKTREES_DIRNAME, normalizeRepoPath } from './paths.js';
import type { Project, MissionPhase, MissionSortie, TestFailure } from '../shared/types.js';

/** How long the integrated suite may run before the gate kills its process group and gives up. */
const GATE_SUITE_TIMEOUT_MS = 15 * 60_000;
/** Bounded queue+retry when the kit is at capacity, before routing to a (non-regression) capacity
 *  verdict. A few backed-off attempts, never an unbounded wait. */
const GATE_ACQUIRE_ATTEMPTS = 3;
const GATE_ACQUIRE_BACKOFF_MS = 2000;
/** The exact throwaway-branch shape the gate mints (`agent/gate-<shortId>`, ids.ts alphabet). The
 *  sweep matches THIS, never a prefix — agent worktrees are agent/<slug>/<suffix> (three segments),
 *  and a slug beginning with 'gate-' must not be reaped. */
const GATE_BRANCH_RE = /^agent\/gate-[a-z0-9]+$/;

/**
 * The gate's verdict. Only 'pass' lets runAdvance proceed to land; every other case routes the
 * mission to attention and lands nothing. 'capacity' and 'error' are deliberately DISTINCT from
 * 'failures' — the kit being full or the suite failing to run is NOT a red-suite regression verdict
 * so the operator sees an honest reason instead of a phantom test failure.
 */
export type GateResult =
  // SPEC-LOOP §2 — `runId` is the kind:'gate' TestRun that passed (the report's gate-green proof).
  // Optional: gate.ts's empty-branch trivial pass acquires no run. runGate must RETURN it (not collapse
  // pass → undefined) so runAdvance can stamp phase.gateRunId.
  | { status: 'pass'; runId?: string }
  | { status: 'conflict'; detail: string }
  | { status: 'failures'; failures: TestFailure[] }
  | { status: 'capacity'; detail: string }
  | { status: 'error'; detail: string };

/** The terminal-less slice of TestKit the gate drives (the frozen TestKit surface). Typed
 *  structurally so this slice compiles against the frozen contract without coupling to testkit.ts's
 *  evolving TestRun shape — the integrator injects the real TestKit, which satisfies it. */
export interface GateRun {
  id: string;
  runDir: string;
  port: number;
}
export interface GateTestKit {
  /** Mint a `kind:'gate'` run (no terminal token), or null when the kit is at capacity. */
  acquireGate(projectId: string, repoPath: string): GateRun | null;
  release(runId: string, status: 'passed' | 'failed'): void;
}

/** Read-only loop lookup — resolves a done sortie's loopId to the branch the gate trial-merges. */
export interface GateLoops {
  get(id: string): { branch?: string } | undefined;
}

export interface GateDeps {
  testkit: GateTestKit;
  loops: GateLoops;
}

export class RegressionGate {
  constructor(private deps: GateDeps) {}

  /**
   * Integrate the phase's done sorties into a throwaway worktree and run `gateSuite` against it.
   * Lands NOTHING (that stays runAdvance's job) — returns only a verdict. Cleanup of the trial
   * worktree + branch is guaranteed in a `finally`, even on throw.
   */
  async check(
    project: Project,
    phase: MissionPhase,
    doneSorties: MissionSortie[],
    gateSuite: string,
  ): Promise<GateResult> {
    // 1. Resolve each done sortie's branch (loop.branch). A done sortie without a loop/branch is
    //    left for runAdvance's own per-sortie no-builder check to surface — the gate just skips it.
    const branches: string[] = [];
    for (const s of doneSorties) {
      if (!s.loopId) continue;
      const branch = this.deps.loops.get(s.loopId)?.branch;
      if (branch) branches.push(branch);
    }
    if (branches.length === 0) return { status: 'pass' }; // nothing to integrate → nothing to regress

    // 2. Build a disposable worktree DIRECTLY via git.worktreeAdd — worktrees.create's slugify
    //    strips '_' and could never mint a gate-tagged name. Branch agent/gate-<suffix>:
    //    two path segments, each isSafeName, and the hyphen keeps it distinct from an agent
    //    worktree's agent/<slug>/<suffix> so the startup sweep can identify it.
    const base = await git.defaultBase(project.repoPath);
    const suffix = shortId(6);
    const gateBranch = `agent/gate-${suffix}`;
    const root = join(dirname(normalizeRepoPath(project.repoPath)), CT_WORKTREES_DIRNAME, project.id);
    mkdirSync(root, { recursive: true });
    const worktreePath = join(root, `gate-${suffix}`);
    const add = await git.worktreeAdd(project.repoPath, worktreePath, gateBranch, base);
    if (!add.ok) {
      // A partial add can leave the branch (or a half-registered worktree) behind; reap it now
      // rather than leaning on the next boot's sweep. cleanup is best-effort by design.
      await this.cleanup(project.repoPath, worktreePath, gateBranch);
      return { status: 'error', detail: `gate worktree add failed: ${add.stderr.trim()}` };
    }

    try {
      // 3. Merge each done branch INTO the gate worktree (never base). Raw argv like
      //    worktrees.land:110 — there is no git.merge helper. A conflict here is a BETTER
      //    signal than today's mid-land-batch conflict (§0.4): it's caught before any real land.
      for (const branch of branches) {
        const res = await git.git(worktreePath, ['merge', '--no-ff', branch, '-m', `ct-gate: integrate ${branch} (${phase.name})`]);
        if (!res.ok) {
          await git.git(worktreePath, ['merge', '--abort']);
          return { status: 'conflict', detail: `${branch}: ${res.stderr.trim() || 'merge conflict'}` };
        }
      }

      // 4. Run gateSuite in-process against the integrated tree. A capacity miss is a
      //    deferral, not a regression.
      // The suite RUNS in the trial worktree, so the worktree is the running-tree root the
      // parser re-anchors spec paths against — passing base repoPath would skew join keys.
      const run = await this.acquireGateRun(project.id, worktreePath);
      if (!run) {
        return { status: 'capacity', detail: 'test kit at capacity — gate deferred, re-advance when slots free' };
      }
      let releaseStatus: 'passed' | 'failed' = 'failed';
      try {
        const suite = await runSuite(gateSuite, worktreePath, {
          PORT: String(run.port),
          BASE_URL: `http://127.0.0.1:${run.port}`,
          CT_RUN_DIR: run.runDir,
          PLAYWRIGHT_BLOB_OUTPUT_DIR: join(run.runDir, 'blob'),
          PLAYWRIGHT_JSON_OUTPUT_FILE: join(run.runDir, 'results.json'),
        });

        // 5. Parse the integrated tree's results. Non-parseable (a missing/forced-off JSON
        //    reporter, or a suite that couldn't start) is NEVER fabricated into a pass — the gate's
        //    "never pass unverified" stance mirrors the loop judge (loops.ts:445-455).
        const parsed = parsePlaywrightResults(run.runDir, worktreePath);
        if (parsed === undefined) {
          const why = suite.timedOut
            ? `suite timed out after ${Math.round(GATE_SUITE_TIMEOUT_MS / 1000)}s`
            : `suite exited ${suite.code ?? 'null'} with no parseable results.json`;
          return { status: 'error', detail: `${why}\n${suite.tail}`.slice(0, 2000) };
        }
        if (parsed.failures.length > 0) {
          return { status: 'failures', failures: parsed.failures };
        }
        // Green: an all-passed integrated tree (parsed.failures === []). Only here does anything land.
        // §2 — RETURN the gate run's id (never collapse pass → undefined) so runAdvance can stamp
        // phase.gateRunId — the report's gate-green proof. The empty-branch trivial pass at the top
        // stays runId-less (it acquired no run).
        releaseStatus = 'passed';
        return { status: 'pass', runId: run.id };
      } finally {
        this.deps.testkit.release(run.id, releaseStatus);
      }
    } finally {
      // 6. Owned cleanup — force-remove the trial worktree + delete its throwaway
      //    branch even on throw. retention.ts prunes only ~/.ct/testruns and NEVER worktrees, so
      //    the gate cannot lean on it; it reaps its own leftovers here + in sweep() at startup.
      await this.cleanup(project.repoPath, worktreePath, gateBranch);
    }
  }

  /**
   * Startup sweep: a Tower killed between worktreeAdd and the check's `finally`
   * leaves an orphaned gate worktree. List each project's worktrees, force-remove any on an
   * agent/gate-* branch, and delete the branch. Bounded, self-healing, never wedges a repo. Runs
   * once at boot, before any gate can create a fresh trial worktree — so there is no concurrency.
   */
  async sweep(projects: Project[]): Promise<void> {
    for (const project of projects) {
      let rows: git.WorktreeRow[];
      try {
        rows = await git.worktreeList(project.repoPath);
      } catch {
        continue; // not a git repo / unreadable — nothing to reap
      }
      for (const row of rows) {
        const branch = row.branch;
        // Exact two-segment gate shape only. A bare prefix would also match a live agent
        // worktree whose task slug starts with 'gate-' (agent/gate-check/<suffix>) and reap it.
        if (!branch || !GATE_BRANCH_RE.test(branch)) continue;
        audit('gate.sweep', { projectId: project.id, path: row.path, branch });
        await this.cleanup(project.repoPath, row.path, branch);
      }
    }
  }

  /** Force-remove a trial worktree + its throwaway branch. Best-effort — a failure to reap one must
   *  never mask the gate's actual verdict, nor throw out of the check's finally. */
  private async cleanup(repo: string, worktreePath: string, branch: string): Promise<void> {
    try {
      await git.worktreeRemove(repo, worktreePath, true);
    } catch { /* best effort */ }
    try {
      // -D (not -d): the gate branch is deliberately never merged into base, so a safe-delete
      // would always refuse it.
      await git.git(repo, ['branch', '-D', branch]);
    } catch { /* best effort */ }
  }

  /** Acquire a terminal-less gate run, with a bounded backed-off retry on capacity. */
  private async acquireGateRun(projectId: string, repoPath: string): Promise<GateRun | null> {
    for (let attempt = 0; attempt < GATE_ACQUIRE_ATTEMPTS; attempt++) {
      const run = this.deps.testkit.acquireGate(projectId, repoPath);
      if (run) return run;
      if (attempt < GATE_ACQUIRE_ATTEMPTS - 1) await delay(GATE_ACQUIRE_BACKOFF_MS * (attempt + 1));
    }
    return null;
  }
}

/**
 * Partition `items` across `n` buckets by a string key (⟦DP-S2d⟧/§2.4). Whole key-groups are bin-packed
 * largest-first into the currently-lightest bucket; a group is NEVER split, so two fixers can't be handed
 * items sharing a key (e.g. the same test file — a guaranteed merge conflict at land). DETERMINISTIC given
 * the same inputs — a retry re-derives an identical partition (§3.3). n > distinct keys → trailing
 * buckets are empty; n < distinct → some buckets own several groups.
 */
export function partitionByKey<T>(items: T[], n: number, keyOf: (item: T) => string): T[][] {
  const buckets: T[][] = Array.from({ length: Math.max(0, n) }, () => []);
  if (buckets.length === 0) return buckets;
  // Group by key (first-seen order preserved for a stable tie-break base).
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  // Largest group first; ties broken by key name so the ordering is total & deterministic.
  const ordered = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const load = new Array<number>(buckets.length).fill(0);
  for (const [, group] of ordered) {
    let target = 0;
    for (let i = 1; i < buckets.length; i++) if (load[i]! < load[target]!) target = i;
    buckets[target]!.push(...group);
    load[target]! += group.length;
  }
  return buckets;
}

/**
 * Partition failures across `n` fixer buckets BY SPEC FILE — a thin delegate of the generic
 * partitionByKey, so the existing fixer-assignment callers and their determinism guarantee
 * are byte-for-byte unchanged.
 */
export function partitionBySpecFile(results: TestFailure[], n: number): TestFailure[][] {
  return partitionByKey(results, n, (f) => f.specFile);
}

// ---- pure helpers ----

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

// ANSI SGR escape (ESC [ ... m); built via RegExp so no raw control byte lives in source.
const ANSI = new RegExp('\\u001b\\[[0-9;]*m', 'g');

/**
 * Exec the raw suite command like loops.runCheck, but DETACHED so it owns a process group: on
 * timeout we kill(-pgid) to reap the suite AND any browsers it forked, not just the bash shell.
 */
function runSuite(
  cmd: string,
  cwd: string,
  extraEnv: Record<string, string>,
): Promise<{ code: number | null; timedOut: boolean; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], {
      cwd,
      env: { ...process.env, ...extraEnv },
      detached: true, // new process group → killable as a unit on timeout
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const cap = (b: Buffer): void => {
      out += b.toString();
      if (out.length > 200_000) out = out.slice(-200_000); // bound memory on a chatty suite
    };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone */ }
    }, GATE_SUITE_TIMEOUT_MS);
    timer.unref?.();

    const finish = (code: number | null): void => {
      clearTimeout(timer);
      const tail = out.replace(ANSI, '').split('\n').filter(Boolean).slice(-12).join('\n').slice(0, 2000);
      resolve({ code, timedOut, tail });
    };
    child.on('error', () => finish(null));
    // 'close', not 'exit': exit can fire before piped stdio drains, and the dropped chunks are
    // exactly the stderr a failing suite prints on its way out — the tail IS the diagnostic.
    child.on('close', (code) => finish(code));
  });
}
