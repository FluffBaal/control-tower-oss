// Control Tower — SuiteChip (SPEC-STORYLOOP §5.2). A pure, DERIVED e2e pass/fail marker for the
// test kit's latest run on one builder terminal. Never stored — like the Outcomes lens, it reads
// the live testruns list and renders a verdict, or nothing:
//
//   • filter to NON-GATE runs (kind !== 'gate') for this terminal
//   • take the newest one that carries a parsed report (results !== undefined)
//       results: []          → green   "e2e ✓"     (the suite ran clean)
//       results.length > 0   → red     "e2e ✗ N"   (N failing tests)
//   • no such run → render NOTHING (reporter not wired — honest absence, never a green default)
//
// This mirrors the server's latestFor(terminalId) accessor exactly. The Integrator drops one into
// the loop card; MissionsView drops one into each sortie card.

import type { TestRunInfo } from './api.js';

export function SuiteChip({ terminalId, testRuns }: { terminalId: string; testRuns: TestRunInfo[] }) {
  const latest = latestParsedFor(terminalId, testRuns);
  // results === undefined means the reporter isn't wired (or no run yet): show nothing rather than
  // an implied verdict. A green run is results: [] (length 0), never undefined.
  if (!latest || latest.results === undefined) return null;

  const failed = latest.results.length;
  const green = failed === 0;
  const label = green ? 'e2e ✓' : `e2e ✗ ${failed}`;
  const desc = green
    ? 'e2e suite — all tests passed on the last run'
    : `e2e suite — ${failed} failing test${failed === 1 ? '' : 's'} on the last run`;
  return (
    <span className={`suite-chip ${green ? 'ok' : 'bad'}`} title={desc} aria-label={desc}>
      <span className="suite-chip-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

// The newest non-gate run for this terminal that carries a parsed report. Order-independent: picks
// the max startedAt rather than trusting the incoming list order, and skips reporter-less runs so a
// blob-only run doesn't hide an older run's real verdict (§5.2 — "newest WITH results").
function latestParsedFor(terminalId: string, runs: TestRunInfo[]): TestRunInfo | undefined {
  let best: TestRunInfo | undefined;
  for (const r of runs) {
    if (r.kind === 'gate') continue;        // gate runs never surface in user-facing chips
    if (r.terminalId !== terminalId) continue;
    if (r.results === undefined) continue;  // no parseable report → not a verdict
    if (!best || r.startedAt > best.startedAt) best = r;
  }
  return best;
}
