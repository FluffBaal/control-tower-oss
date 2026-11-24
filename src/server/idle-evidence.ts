// SPEC-LOOPWEDGE — the AFFIRMATIVE-IDLE evidence core, extracted verbatim from the loop runner's
// first-inject spawn-latch belt (loops.ts firstInjectPaneIdle) so the poller's built-in idle backstop
// (F2) and the loop's first-inject belt (F3) read pane idleness THE SAME WAY. This is the "positive
// evidence a working record is actually idle" instrument — STRONGER than mere output-quiescence,
// which is exactly why it is safe to demote a built-in the plain quiescence backstop must never touch.
//
// The function is PURE (no tmux, no clock): the caller supplies the async pieces —
//   - `hasActiveWork`: the caller's own paneHasActiveWork result (live pane descendants beyond the
//     CLI's structural children) — the one check that needs a process probe;
//   - `snap`: a fresh capture, '' when the capture failed (→ evidenceOk false, the fail-closed leg).
// It returns { evidenceOk, norm }: evidenceOk true iff EVERY single-snapshot check passes; `norm` is
// the normalized snapshot the caller uses for its OWN stability dwell — kept caller-side deliberately,
// because the poller dwells on a poll count while the belt dwells on a timestamped pair, and neither
// stability rule is shared. The function never advances anything on its own.

import type { HookSignal } from '../shared/types.js';
import { claudeBusyFooterOrSpinner } from './busy-markers.js';

export interface IdleEvidenceAdapter {
  /** SPEC-SUBMIT §2.1 — tri-state composer classifier (false = affirmatively empty). */
  composerPending?: (snapshot: string) => boolean | undefined;
  /** Screen-state parse; only its 'needs-permission' verdict matters here. */
  parseState: (snapshot: string) => HookSignal | null;
  /** Strip volatile TUI chrome before comparison (codex's cycling hint), else identity. */
  normalizeSnapshot?: (snapshot: string) => string;
  /** SPEC-CLEARANCE question classifier; `true` = a definite question affordance is on screen (a
   *  selection box / ask line). A lost STRONG-question hook leaves the pane 'working' with an EMPTY
   *  composer under the box — which every other check reads as idle — so this is the one guard that
   *  keeps a pane awaiting the human from being mistaken for a finished turn. */
  questionPending?: (snapshot: string) => boolean | undefined;
}

/**
 * The pinned mid-turn markers of the built-ins: the "esc to interrupt/cancel" footer AND claude's
 * active-spinner glyph `✳` (which leads every "✳ Thinking…/Working…/Compacting…" status line). The
 * load-bearing guard for a FROZEN mid-turn pane (childless AND byte-stable, so `hasActiveWork` + a
 * stability dwell alone would pass it): a mid-turn CLI keeps one of these pinned even while its
 * composer renders empty, and even if a partial repaint truncates the footer the spinner glyph
 * remains. Matched on the RAW snapshot, BEFORE normalization, so it can never be stripped.
 * NOTE: the spinner VERBS ("Thinking"/"Working") are deliberately NOT matched here — they occur in
 * ordinary model OUTPUT and would block legitimate heals (the fix's whole purpose); the `✳` glyph is
 * a reliable active-spinner marker that prose never carries.
 */
// The frozen-mid-turn guard's marker lives in the shared busy-markers module (claudeBusyFooterOrSpinner):
// the footer hint OR a live spinner glyph, NO verbs (they occur in output). Widened from `✳` to the full
// spinner sequence so it survives the `esc to interrupt` footer being suppressed under Runway's statusLine.

/**
 * Decide whether `snap` shows an AFFIRMATIVELY idle pane. The checks, in the belt's original order:
 *   (1) the adapter has a composer classifier (built-ins; a custom def has none and stays on its
 *       own quiescence backstop);
 *   (2) no live tool process beyond the CLI's structural children (`hasActiveWork` false);
 *   (3) a non-empty capture (a capture failure returns '' → inconclusive);
 *   (4) NOT a mid-turn pane: the RAW capture carries no pinned busy footer;
 *   (5) not a permission dialog;
 *   (6) the composer classified affirmatively EMPTY (false — never undefined: a booting CLI, alt
 *       screen, login wall or unrecognized frame all read inconclusive);
 *   (7) NOT awaiting a human answer: no definite question affordance on screen. A lost STRONG-question
 *       hook leaves a 'working' pane whose empty composer passes (6) and whose suspended-for-input
 *       turn shows no busy footer (so (4) misses it) — the question classifier is the only guard that
 *       distinguishes "finished" from "waiting for the operator", mirroring mission.ts's needs-input veto.
 * Stability (the caller's dwell) is the caller's job — compare the returned `norm` to its own prior
 * clean observation. Any failed check → evidenceOk false. `norm` is always returned so a caller that
 * dwells on it can hold the current observation even on a failing tick if it wishes (the belt clears).
 */
export function paneAffirmativelyIdle(
  snap: string,
  adapter: IdleEvidenceAdapter,
  hasActiveWork: boolean,
): { evidenceOk: boolean; norm: string } {
  const norm = adapter.normalizeSnapshot?.(snap) ?? snap;
  if (!adapter.composerPending) return { evidenceOk: false, norm }; // (1)
  if (hasActiveWork) return { evidenceOk: false, norm }; // (2)
  if (!snap) return { evidenceOk: false, norm }; // (3)
  if (claudeBusyFooterOrSpinner(snap)) return { evidenceOk: false, norm }; // (4) RAW, pre-normalization
  if (adapter.parseState(snap) === 'needs-permission') return { evidenceOk: false, norm }; // (5)
  if (adapter.composerPending(snap) !== false) return { evidenceOk: false, norm }; // (6)
  if (adapter.questionPending?.(snap) === true) return { evidenceOk: false, norm }; // (7) awaiting the human
  return { evidenceOk: true, norm };
}
