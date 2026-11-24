// SPEC-RUNWAY W0.5 — the shared Claude Code busy markers, esp. the statusLine footer-suppression case:
// with a custom statusLine the `esc to interrupt` hint is gone, so a working pane must still read busy
// off the spinner glyph, while an idle pane (composer + auto-mode footer, no spinner) must read idle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeBusyFull, claudeBusyFooterOrSpinner, CLAUDE_SPINNER } from './busy-markers.js';

// A realistic idle frame (from a live capture): composer + auto-mode footer, mid-line `·` but NO spinner glyph.
const IDLE = [
  '❯ ',
  '────────────────────────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent',
  "tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on'",
].join('\n');

// A working frame WITHOUT a status line: the footer hint is present.
const WORKING_FOOTER = '● Herding bytes… (12s · ↑ 1.2k tokens · esc to interrupt)';

// A working frame UNDER a status line: the footer hint is GONE, but the spinner glyph animates.
const WORKING_STATUSLINE_SPINNER = [
  '✻ Percolating… (8s)',
  '',
  '                                          ◉ xhigh · /effort', // the statusLine occupies the footer row
].join('\n');

test('claudeBusyFooterOrSpinner: footer present ⇒ busy', () => {
  assert.equal(claudeBusyFooterOrSpinner(WORKING_FOOTER), true);
});

test('claudeBusyFooterOrSpinner: footer SUPPRESSED but spinner glyph present ⇒ still busy', () => {
  assert.equal(claudeBusyFooterOrSpinner(WORKING_STATUSLINE_SPINNER), true);
});

test('claudeBusyFooterOrSpinner: idle frame (no footer, no spinner, mid-line · only) ⇒ NOT busy', () => {
  assert.equal(claudeBusyFooterOrSpinner(IDLE), false);
});

test('every spinner-sequence glyph except the dot triggers busy', () => {
  for (const g of ['✢', '✳', '✶', '✻', '✽']) {
    assert.equal(claudeBusyFooterOrSpinner(`${g} Working…`), true, `glyph ${g}`);
  }
  // The `·` frame is deliberately NOT matched (too common in output/footers → false positives).
  assert.equal(CLAUDE_SPINNER.test('a · b · c'), false, 'middle dot is not a busy glyph');
});

test('claudeBusyFull adds the VERBS (composer veto), footer-or-spinner does NOT (idle heal)', () => {
  const prose = 'The function was Working correctly and I was Thinking about edge cases.';
  assert.equal(claudeBusyFull(prose), true, 'verbs count for the veto');
  assert.equal(claudeBusyFooterOrSpinner(prose), false, 'verbs must NOT block an idle heal (they occur in output)');
  // Idle stays idle under both.
  assert.equal(claudeBusyFull(IDLE), false);
});
