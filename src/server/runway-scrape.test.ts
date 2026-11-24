// SPEC-RUNWAY W5 — the reactive usage-wall classifier, pinned to the CLI's real banner strings and
// hardened against the distractors (429 overload, context limit, fast limit, monthly limit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUsageWall } from './runway/scrape.js';

test('classifyUsageWall: hard walls', () => {
  for (const s of [
    "You've hit your limit",
    "You've hit your session limit · resets 3pm",
    "You've reached your weekly limit",
    "You've hit your Opus limit",
    "You've hit your Sonnet limit",
  ]) {
    assert.equal(classifyUsageWall(s), 'wall', s);
  }
});

test('classifyUsageWall: auto-continue (waiting for reset)', () => {
  assert.equal(classifyUsageWall('Continuing automatically when your limit resets · esc to cancel'), 'auto-continue');
  assert.equal(classifyUsageWall('Usage limit reached · Continuing automatically at 3:00 PM · esc to cancel'), 'auto-continue');
});

test('classifyUsageWall: distractors are NOT usage walls', () => {
  for (const s of [
    'Server is temporarily limiting requests (not your usage limit)',
    'Context limit reached',
    'Fast limit reached and temporarily disabled · resets in 2h',
    "You've hit your fast limit",
    "You've hit your monthly limit",
    "You've hit your monthly spend limit",
    '● Herding bytes… (12s · esc to interrupt)',
    'ordinary model output about limits and thresholds',
  ]) {
    assert.equal(classifyUsageWall(s), null, s);
  }
});
