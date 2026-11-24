// SPEC-RUNWAY W5 — the reactive BACKSTOP: recognize a Claude Code usage-limit banner in a pane
// snapshot, for the case the proactive statusLine missed the approach (e.g. a limit hit mid-turn).
// PURE + pinned to the strings the installed CLI actually renders (grepped from the 2.1.x binary):
//
//   HARD wall:  "You've hit your limit" / "You've hit your session limit" / "You've reached your
//               weekly limit" / "You've hit your Opus limit" / "…Sonnet limit"
//   SOFT (auto-continue, autoContinueAtUsageLimit on): "Continuing automatically when your limit
//               resets · esc to cancel" / "Continuing automatically at <time> · esc to cancel"
//
// DISTRACTORS that must NEVER read as a subscription wall (excluded in the pattern):
//   "…limit (not your usage limit)" (a transient 429 overload), "Context limit reached" (the model's
//   context window, not the plan), "Fast limit reached" (a separate feature), "monthly … limit".

// The adjective slot rejects fast/monthly/context; the trailing lookahead rejects the 429 "(not your
// usage limit)" suffix. `hit|reached` covers both verbs the CLI uses.
const WALL = /You've (?:hit|reached) your (?:(?!fast |monthly |context )[\w-]+ )?limit\b(?! \(not your usage limit\))/i;
const AUTO_CONTINUE = /Continuing automatically (?:when your limit resets|at )/i;

/**
 * Classify a pane snapshot: 'wall' (blocked, no auto-resume shown), 'auto-continue' (blocked but the
 * CLI is waiting to resume at reset), or null (no usage wall). Both non-null results mean the account
 * is AT its limit — the caller marks a usage wall so the rotation controller reacts. Auto-continue is
 * distinguished only for the audit/UX ("waiting for reset" vs "stuck").
 */
export function classifyUsageWall(snapshot: string): 'wall' | 'auto-continue' | null {
  if (AUTO_CONTINUE.test(snapshot)) return 'auto-continue';
  if (WALL.test(snapshot)) return 'wall';
  return null;
}
