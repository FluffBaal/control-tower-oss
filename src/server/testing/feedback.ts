// The failures → backlog feedback edge (SPEC-TESTING §5). PURE: takes one released run's
// parsed results plus the BacklogStore and files failing specs as 'triage' tasks; it never
// decides WHEN to run — the TestKit onParsed hook and the manual file-failures route (both
// orchestrator-wired) do, gated on kind/autoFileFailures/results there.
//
// Dedup is built HERE (the backlog has no dedup primitive): the deterministic title
// `e2e: ${specFile} › ${testTitle}` is capped to the store's MAX_TITLE BEFORE the compare —
// create() caps at store time (backlog/store.ts:132), so an uncapped compare would never match
// a stored title. Archived tasks never block re-filing (a regression deserves a fresh task);
// any live lane does.

import type { BacklogStore } from '../backlog/store.js';
import type { TestRun } from '../testkit.js';
import { partitionByTriage } from '../../shared/types.js';

// Bound to the backlog store's own caps (backlog/store.ts:24-25) so the dedup compares exactly
// what create() stores and the composed body survives sanitizeBody intact.
const MAX_TITLE = 200;
const MAX_BODY = 4000;
/** Per-run task ceiling: one broken global fixture can fail hundreds of tests under the
 *  25 MiB report cap — filing them all would bury the board. Overflow is counted honestly onto
 *  the last filed task's body instead. */
const MAX_TASKS_PER_RUN = 20;

/** The exact title transform create() applies (capStr, backlog/store.ts:60-62) — the dedup key. */
const capTitle = (s: string): string => s.trim().slice(0, MAX_TITLE);

/**
 * File one run's failures into the backlog: one task per DISTINCT specFile (the
 * partitionBySpecFile granularity) titled by that file's first failure, lane 'triage',
 * unranked. `skipped` counts groups whose title already has a live (non-archived) task for the
 * project. A run with no parsed results / no failures files nothing.
 */
export function fileFailuresAsTasks(
  run: Pick<TestRun, 'id' | 'projectId' | 'results' | 'triage'>,
  backlog: BacklogStore,
  opts: { realOnly?: boolean } = {},
): { created: number; skipped: number } {
  // SPEC-LOOP W7 — `realOnly` (the AUTOMATIC paths: onParsed / triage route / mission-end flush) files
  // only REAL failures via the ONE shared partitionByTriage helper (a by-design/false entry suppresses its
  // failure; UNCLASSIFIED→real, so a run with no triage is byte-identical to pre-W7). The DEFAULT (opts
  // omitted — the manual operator "File failures as tasks" route) is triage-BLIND: it files every failing
  // spec, never overriding the operator's explicit action with the investigator's classification.
  const failures = opts.realOnly ? partitionByTriage(run.results ?? [], run.triage).real : (run.results ?? []);
  if (failures.length === 0) return { created: 0, skipped: 0 };

  // Group by specFile, report order preserved: the first failure titles the group's task and
  // supplies its errorTail; siblings ride the body as a count.
  const bySpec = new Map<string, typeof failures>();
  for (const f of failures) {
    const group = bySpec.get(f.specFile);
    if (group) group.push(f);
    else bySpec.set(f.specFile, [f]);
  }

  // Dedup set: every NON-archived task title already filed for this project, computed ONCE over
  // backlog.list(). Titles composed below join it too, so an in-run collision (two groups whose
  // titles truncate identically at 200 chars) dedups the same way.
  const seen = new Set<string>();
  for (const t of backlog.list()) {
    if (t.projectId === run.projectId && t.status !== 'archived') seen.add(t.title);
  }

  let skipped = 0;
  let overflow = 0; // failures in groups past the cap that got NO task this run
  const toCreate: { title: string; body: string }[] = [];
  for (const group of bySpec.values()) {
    const first = group[0]!;
    const title = capTitle(`e2e: ${first.specFile} › ${first.testTitle}`);
    if (seen.has(title)) {
      skipped++; // already live on the board — its failures are represented
      continue;
    }
    if (toCreate.length >= MAX_TASKS_PER_RUN) {
      overflow += group.length;
      continue;
    }
    seen.add(title);
    // errorTail is parser-capped at 2000 chars; re-cap defensively (a foreign meta.json) so the
    // trailing run-id line always survives the store's body cap.
    const lines = [first.errorTail.slice(0, 2000)];
    if (group.length > 1) lines.push(`+${group.length - 1} more failing test(s) in this spec file`);
    lines.push(`(run ${run.id})`);
    toCreate.push({ title, body: lines.filter(Boolean).join('\n\n').slice(0, MAX_BODY) });
  }

  // overflow rides the LAST filed task's body — honest about what was left unfiled.
  if (overflow > 0 && toCreate.length > 0) {
    const last = toCreate[toCreate.length - 1]!;
    last.body = `${last.body}\n\n+${overflow} more failure(s) in this run — not filed (per-run task cap)`.slice(0, MAX_BODY);
  }

  let created = 0;
  for (const t of toCreate) {
    backlog.create({ projectId: run.projectId, title: t.title, body: t.body, status: 'triage' });
    created++;
  }
  return { created, skipped };
}
