// SPEC-RUNWAY W0.5 — the ONE source of Claude Code busy-detection markers, so the four sites that
// decide "is this pane mid-turn" (adapters/claude.ts composer-veto + parseState, idle-evidence.ts
// frozen-pane guard, loops.ts world-note) can never drift.
//
// WHY THIS EXISTS: Runway installs a custom `statusLine`, and Claude Code SUPPRESSES most footer
// keyboard hints — including `esc to interrupt` — whenever a status line is configured (verified live
// on 2.1.275). Those sites keyed on `esc to interrupt`, so under a status line a FROZEN mid-turn pane
// would read "not busy" and the idle-evidence heal / first-inject belt could fire into a live turn.
// The spinner GLYPH survives (the footer hint does not), so we widen the glyph set to the CLI's full
// spinner sequence and make it the footer-INDEPENDENT signal.
//
// SAFETY: this only ever ADDS busy-matches — `esc to interrupt` still matches when present (no status
// line), and the widened glyph set is a strict superset of the old `✳`. It can never make a pane read
// LESS busy than before, so a fleet running without Runway sees identical or stricter busy detection.

// The CLI's spinner animation cycles `· ✢ ✳ ✶ ✻ ✽` (forward then reversed). The `·` frame is
// deliberately EXCLUDED: a middle dot is common in ordinary output/footers and would false-positive an
// idle pane as busy (which would wedge a loop — never detecting done). The five star glyphs are not
// carried by prose (the same trust the old `✳`-only marker already relied on), so any of them on
// screen means the spinner is animating = the pane is working. 10 of the 12 frames carry one of these.
export const CLAUDE_SPINNER = /[✢✳✶✻✽]/;

/** The footer hint — present without a status line, SUPPRESSED with one. */
export const CLAUDE_BUSY_FOOTER = /esc to (interrupt|cancel)/i;

/**
 * Footer-INDEPENDENT busy: the footer hint OR a live spinner glyph. This is the idle-evidence
 * frozen-pane guard's marker — it deliberately does NOT include the "Thinking"/"Working" VERBS,
 * because those occur in ordinary model output and would block legitimate idle heals (the reason
 * idle-evidence excluded them originally). Matched on the RAW snapshot, before normalization.
 */
export function claudeBusyFooterOrSpinner(s: string): boolean {
  return CLAUDE_BUSY_FOOTER.test(s) || CLAUDE_SPINNER.test(s);
}

/**
 * Full busy for the composer VETO + parseState: footer/spinner OR the status verbs. Verbs are safe
 * here because this is a mid-turn VETO (it only prevents reading an empty composer as affirmatively
 * idle), not an idle HEAL — a false "busy" leaves a phantom hold (recoverable), never a truncated
 * commit. Mirrors the old CLAUDE_BUSY = /esc to interrupt|Thinking|Working|✳/i, spinner-widened.
 */
export function claudeBusyFull(s: string): boolean {
  return claudeBusyFooterOrSpinner(s) || /Thinking|Working/i.test(s);
}
