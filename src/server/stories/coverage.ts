// Story coverage is DERIVED and FOUR-STATE (SPEC-STORYLOOP §1.4). It is a pure
// function of (stories, the latest non-gate run) computed fresh and NEVER stored — the
// honest-derived-status house rule. The parser hands us both the run's FAILURES and its RAN-set,
// so we can distinguish a mapping that stayed green from one that points at a spec that never
// executed (the M6-class dishonesty this spec avoids: a dead mapping must never read as covered).
//
// This module stays a PURE function with no testkit import (clean layering): it takes a minimal
// structural view of the latest run, which a testkit `TestRun` satisfies structurally. The
// integrator calls `coverage(store.list(projectId), testkit.latestForProject(projectId))`.

import type { Story, TestFailure } from '../../shared/types.js';

/**
 * The minimal shape coverage needs from the latest non-gate run (§1.4). A testkit `TestRun` (which
 * gains `results?`/`ran?`) satisfies this structurally — so coverage never imports testkit.
 * - `results === undefined` ⇒ no JSON reporter wired (honest degradation); a green run is `[]`.
 * - `ran` ⇒ every non-skipped spec's normalized repo-relative path that actually executed.
 */
export interface LatestRunView {
  results?: TestFailure[];
  ran?: string[];
}

export type CoverageState = 'covered' | 'failing' | 'stale-missing' | 'uncovered';

export interface StoryCoverage {
  storyId: string;
  state: CoverageState;
  failingSpecs: string[]; // mapped specs in the run's failures (state 'failing')
  missingSpecs: string[]; // mapped specs NOT in the run's ran-set (state 'stale-missing')
}

/** The project rollup the UI shows as "X covered · Y failing · Z stale · W uncovered". `noRun`
 *  counts MAPPED stories with no parseable run yet (a render-level absence, never green). */
export interface CoverageRollup {
  covered: number;
  failing: number;
  stale: number;
  uncovered: number;
  noRun: number;
}

export interface CoverageReport {
  /** Per story, its coverage — or `null` for a mapped story with no parseable run ("no run yet"). */
  perStory: Array<{ storyId: string; coverage: StoryCoverage | null }>;
  rollup: CoverageRollup;
}

/**
 * Coverage for ONE story. Precedence (§1.4), highest first:
 *   uncovered      — specFiles empty/absent (nothing maps to it) — run-independent
 *   [no run yet]   — a mapped story but no parseable run → `undefined` (UI: neutral marker, never green)
 *   failing        — a mapped specFile is in the run's failures
 *   stale-missing  — a mapped specFile is NOT in the run's ran-set (mapping points at nothing)
 *   covered        — every mapped specFile ran and none failed
 * A mapped spec that failed is by construction in the ran-set (§2.1), so failingSpecs and
 * missingSpecs never overlap; both are reported for diagnosis regardless of the winning state.
 */
export function coverageForStory(story: Story, run: LatestRunView | undefined): StoryCoverage | undefined {
  const specs = (story.specFiles ?? []).filter((s) => s.length > 0);

  // 'uncovered' is a statement about the mapping alone — true even with no run.
  if (specs.length === 0) {
    return { storyId: story.id, state: 'uncovered', failingSpecs: [], missingSpecs: [] };
  }

  // A mapped story needs a PARSEABLE run to judge. `results === undefined` = no reporter wired
  // (a green run is `[]`); either way the four verdicts don't apply → "no run yet".
  if (!run || run.results === undefined) return undefined;

  const failedSet = new Set(run.results.map((f) => f.specFile));
  const ranSet = new Set(run.ran ?? []);
  const failingSpecs = specs.filter((s) => failedSet.has(s));
  const missingSpecs = specs.filter((s) => !ranSet.has(s));

  if (failingSpecs.length > 0) return { storyId: story.id, state: 'failing', failingSpecs, missingSpecs };
  if (missingSpecs.length > 0) return { storyId: story.id, state: 'stale-missing', failingSpecs: [], missingSpecs };
  return { storyId: story.id, state: 'covered', failingSpecs: [], missingSpecs: [] };
}

/**
 * Coverage for a whole (pre-project-filtered) story list plus the project rollup. `coverage: null`
 * marks a mapped story with no parseable run yet; the rollup counts it as `noRun`, never as a
 * green/covered state — so "all green" (`results: []`) is never confused with "no reporter"
 * (`results: undefined`). The four-state logic lives in this one tested place (§2.3c).
 */
export function coverage(stories: Story[], run: LatestRunView | undefined): CoverageReport {
  const perStory = stories.map((s) => ({ storyId: s.id, coverage: coverageForStory(s, run) ?? null }));
  const rollup: CoverageRollup = { covered: 0, failing: 0, stale: 0, uncovered: 0, noRun: 0 };
  for (const { coverage: c } of perStory) {
    if (!c) rollup.noRun++;
    else if (c.state === 'covered') rollup.covered++;
    else if (c.state === 'failing') rollup.failing++;
    else if (c.state === 'stale-missing') rollup.stale++;
    else rollup.uncovered++;
  }
  return { perStory, rollup };
}
