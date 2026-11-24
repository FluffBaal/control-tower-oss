// SPEC-SUBMIT §11 — the send boundary's verification stack.
//
// Two layers are covered here:
//  1. the pure pieces — the three composer classifiers and the our-text marker — against REAL pane
//     text captured live on 2026-07-21, not invented shapes;
//  2. sendTextVerified itself, driven against a SCRATCH tmux server on a non-`ct-` socket so the
//     Tower's reconciler can never see it. Those cases SELF-SKIP when tmux is unavailable.
//
// The classifier assertions are the load-bearing ones: a wrong `true` on an idle composer would
// refuse every send as foreign-text and gate a healthy fleet (⟦DEC-8⟧), which is why each classifier
// is asserted on its menus and echoes too, not just on its happy shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const home = mkdtempSync(join(tmpdir(), 'ct-submit-test-'));
process.env.CT_HOME = home;

const pexec = promisify(execFile);
const { claudeAdapter } = await import('./adapters/claude.js');
const { codexAdapter } = await import('./adapters/codex.js');
const { geminiAdapter } = await import('./adapters/gemini.js');
const tmux = await import('./tmux.js');

const RULE = '─'.repeat(80);
const NBSP = '\u00A0'; // written as an escape: a literal NBSP is invisible and silently lost to a reformat

// ---- fixtures: captured verbatim from live panes on 2026-07-21 ----

/** claude 2.1.216, idle with an EMPTY composer (pins C3). */
const CLAUDE_EMPTY = [
  '● hi',
  '',
  '✻ Sautéed for 6s',
  "  tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and rea…",
  RULE,
  `❯${NBSP}`,
  RULE,
  '  ⏸ manual mode on · ? for shortcuts · ← for agents',
  '',
].join('\n');

/** claude 2.1.216, a human's half-typed draft sitting in the composer. */
const CLAUDE_PENDING = [
  "  tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and rea…",
  RULE,
  `❯${NBSP}a draft the human is typing`,
  RULE,
  '  ⏸ manual mode on',
  '',
].join('\n');

/** claude 2.1.216 MID-TURN: the composer stays rendered and empty; the footer changes. */
const CLAUDE_MIDTURN = [
  '  Run the bash command: echo hi',
  '',
  '· Transmuting…',
  '                                                   Ctrl+Y to paste deleted text',
  RULE,
  `❯${NBSP}`,
  RULE,
  '  ⏸ manual mode on · esc to interrupt · ← for agents',
  '',
].join('\n');

/** claude 2.1.216 folder-trust menu — a `❯` line WITH content that is not composer text. */
const CLAUDE_TRUST_MENU = [
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
].join('\n');

/** claude 2.1.216, a multiline prompt typed into the composer (pins M1: `\n` does NOT submit). */
const CLAUDE_MULTILINE = [
  RULE,
  `❯${NBSP}first line`,
  '  second line',
  RULE,
  '  ⏸ manual mode on',
  '',
].join('\n');

/** codex 0.144.3 idle: an empty composer ALWAYS renders a rotating hint, never a bare marker. */
const CODEX_HINT = [
  '⚠ MCP startup incomplete (failed: codex_apps)',
  '',
  '',
  '› Run /review on my current changes',
  '',
  '  gpt-5.6-sol default · /tmp/scratch/repo…',
  '',
].join('\n');

/** codex 0.144.3 with text typed into the composer (indistinguishable from a hint by shape). */
const CODEX_TYPED = [
  '',
  '› probe text here',
  '',
  '  gpt-5.6-sol default · /tmp/scratch/repo…',
  '',
].join('\n');

/** codex 0.144.3 folder-trust menu — the analog of claude's. */
const CODEX_TRUST_MENU = [
  '  Do you trust the contents of this directory?',
  '',
  '› 1. Yes, continue',
  '  2. No, quit',
  '',
].join('\n');

test('claude composerPending — pinned against 2.1.216 captures', async (t) => {
  await t.test('empty composer → false', () => {
    assert.equal(claudeAdapter.composerPending?.(CLAUDE_EMPTY), false);
  });
  await t.test('a human draft in the composer → true', () => {
    assert.equal(claudeAdapter.composerPending?.(CLAUDE_PENDING), true);
  });
  await t.test('mid-turn (composer rendered but empty) → false — this is what confirms a submit', () => {
    assert.equal(claudeAdapter.composerPending?.(CLAUDE_MIDTURN), false);
  });
  await t.test('a multiline prompt → true (continuation lines count)', () => {
    assert.equal(claudeAdapter.composerPending?.(CLAUDE_MULTILINE), true);
  });
  await t.test('the folder-trust MENU → undefined, never true', () => {
    // The same ❯ marker, with content — but not rule-sandwiched. A `true` here would refuse every
    // send on that pane as foreign-text.
    assert.equal(claudeAdapter.composerPending?.(CLAUDE_TRUST_MENU), undefined);
  });
  await t.test('a submitted prompt echoed in scrollback does not read as pending', () => {
    // The echo carries the same marker; only the live composer sits between two rules.
    const withEcho = ['❯ an earlier prompt that was submitted', '', '● a reply', '', CLAUDE_EMPTY].join('\n');
    assert.equal(claudeAdapter.composerPending?.(withEcho), false);
  });
  await t.test('an empty screen / alt screen → undefined', () => {
    assert.equal(claudeAdapter.composerPending?.(''), undefined);
    assert.equal(claudeAdapter.composerPending?.('some full-screen dialog\nwith no composer'), undefined);
  });
});

test('codex composerPending — conservative: never returns true', async (t) => {
  await t.test('a pinned hint → false (an empty composer always shows one on 0.144.3)', () => {
    assert.equal(codexAdapter.composerPending?.(CODEX_HINT), false);
  });
  await t.test('every pinned hint is recognized', () => {
    const hints = [
      'Explain this codebase',
      'Summarize recent commits',
      'Implement {feature}',
      'Find and fix a bug in @filename',
      'Write tests for @filename',
      'Improve documentation in @filename',
      'Run /review on my current changes',
      'Use /skills to list available skills',
      'Check recently modified functions for compatibility',
      'How many files have been modified?',
      'Will this algorithm scale well?',
    ];
    for (const h of hints) assert.equal(codexAdapter.composerPending?.(`› ${h}\n`), false, h);
  });
  await t.test('typed text → undefined (the hint-vs-text ambiguity, deliberately not guessed)', () => {
    assert.equal(codexAdapter.composerPending?.(CODEX_TYPED), undefined);
  });
  await t.test('an UNKNOWN hint (a future release) → undefined, never true', () => {
    // The failure mode a stale pin must degrade into: audited-unverified, never a spurious gate.
    assert.equal(codexAdapter.composerPending?.('› Refactor this module for me\n'), undefined);
  });
  await t.test('the trust MENU → undefined', () => {
    assert.equal(codexAdapter.composerPending?.(CODEX_TRUST_MENU), undefined);
  });
  await t.test('a bare marker → false', () => {
    assert.equal(codexAdapter.composerPending?.('›\n  gpt-5.6-sol default · /x…\n'), false);
  });
  await t.test('no marker at all → undefined', () => {
    assert.equal(codexAdapter.composerPending?.('just some output\n'), undefined);
  });
  await t.test('it never returns true for ANY of these screens', () => {
    for (const s of [CODEX_HINT, CODEX_TYPED, CODEX_TRUST_MENU, '', '› x\n']) {
      assert.notEqual(codexAdapter.composerPending?.(s), true);
    }
  });
});

test('gemini composerPending — placeholder pinned, never returns true', async (t) => {
  await t.test('the placeholder → false', () => {
    assert.equal(geminiAdapter.composerPending?.('╭──────╮\n│ Type your message or @path/to/file │\n╰──────╯'), false);
  });
  await t.test('the voice variant and shell mode also read empty', () => {
    assert.equal(geminiAdapter.composerPending?.('│ Type your message or press Ctrl+V (Esc to exit) │'), false);
    assert.equal(geminiAdapter.composerPending?.('│ Type your shell command │'), false);
  });
  await t.test('anything else → undefined (the frame is unpinned; a guessed true is forbidden)', () => {
    assert.equal(geminiAdapter.composerPending?.('╭──────╮\n│ some text the human typed │\n╰──────╯'), undefined);
    assert.equal(geminiAdapter.composerPending?.(''), undefined);
  });
});

test('the our-text marker survives the composer frame and wrapping', async (t) => {
  // This exercises the SHIPPED matcher (snapshotHoldsOurText / ourTextTail), not a local copy: the
  // whole point is that a regression in the real normalizer fails here.
  const prompt = 'Mission "ship the widget" — goal: make the tests pass\n\n[Control Tower · loop "w" · iteration 3] the check failed: AssertionError at /home/op/repos/ct/src/widget.spec.ts:41';
  const tail = tmux.ourTextTail(prompt);
  const lastLine = prompt.split('\n').filter((l) => l.trim()).pop() ?? '';
  const raw = lastLine.slice(-60);

  /** The same text as an 80-column pane renders it: framed, and hard-broken at `at` chars. */
  const render = (breakAt: number): string => [
    RULE,
    `❯${NBSP}${raw.slice(0, breakAt)}`,
    `  ${raw.slice(breakAt)}`,
    RULE,
    '  ⏸ manual mode on',
  ].join('\n');

  await t.test('a wrap ON a space is found', () => {
    const at = raw.indexOf(' ', 20);
    assert.ok(at > 0);
    assert.equal(tmux.snapshotHoldsOurText(render(at), tail, claudeAdapter.composerText), true);
  });

  await t.test('a wrap MID-TOKEN is found too (a path or stack frame breaking mid-word)', () => {
    // The regression this guards: collapsing whitespace instead of deleting it makes this fail, and
    // the failure lands on the RETRY path — our own leftover text diagnosed as a human's draft, then
    // gated with a note about a draft nobody typed.
    const at = raw.indexOf('/home/op') + 3; // hard-break inside the absolute path
    assert.ok(at > 3, 'the fixture must contain the path this splits');
    assert.equal(tmux.snapshotHoldsOurText(render(at), tail, claudeAdapter.composerText), true);
  });

  await t.test('every break point in the tail is found', () => {
    for (let at = 1; at < raw.length; at++) {
      assert.equal(tmux.snapshotHoldsOurText(render(at), tail, claudeAdapter.composerText), true, `break at ${at}`);
    }
  });

  await t.test("someone else's text is NOT found", () => {
    const theirs = [RULE, `❯${NBSP}delete the old migrations and `, RULE].join('\n');
    assert.equal(tmux.snapshotHoldsOurText(theirs, tail, claudeAdapter.composerText), false);
  });
});

test('a codex-shaped successful send is VERIFIED, not degraded', async (t) => {
  // The regression this pins: codex wraps a multiline prompt onto 2-space-indented continuation
  // lines (pins §1 M1), and a loop prompt is `task + \n\n + feedback`, so its TAIL is always on a
  // continuation line. Scoping the our-text search to the marker line alone puts the tail outside
  // the searched region ALWAYS — so a send that genuinely succeeded can never establish arrival, and
  // every healthy codex injection audits as unverified. An alarm that fires on the routine path is
  // one the operator learns to ignore.
  const prompt = 'Fix the failing widget spec\n\n[Control Tower · loop "w" · iteration 3] the check failed: AssertionError at src/widget.spec.ts:41';
  const tail = tmux.ourTextTail(prompt);
  const typedScreen = [
    '',
    '› Fix the failing widget spec',
    '  [Control Tower · loop "w" · iteration 3] the check failed:',
    '  AssertionError at src/widget.spec.ts:41',
    '',
    '  gpt-5.6-sol default · /repo…',
  ].join('\n');

  await t.test('the prompt IS found once it is in the composer', () => {
    assert.equal(tmux.snapshotHoldsOurText(typedScreen, tail, codexAdapter.composerText), true);
  });

  await t.test('a hint still reads as an empty composer, and cannot stand in for our prompt', () => {
    const hintScreen = ['', '› Run /review on my current changes', '', '  gpt-5.6-sol default · /repo…'].join('\n');
    assert.equal(codexAdapter.composerPending?.(hintScreen), false);
    assert.equal(codexAdapter.composerText?.(hintScreen), '');
    assert.equal(tmux.snapshotHoldsOurText(hintScreen, tail, codexAdapter.composerText), false);
  });

  // The other half of the chain — a post-submit hint reading as an EMPTY composer, which is what
  // turns arrival into 'verified' — is pinned by the codex classifier tests above. It is asserted
  // there rather than re-staged here, because a live pane cannot be made to repaint on cue without
  // a timing race, and a test that stages the sequence with stubs would only be re-testing the
  // primitive's own evidence rule (already covered by the tie-break and appear-window cases).
});

test('an echo of an already-submitted prompt is not mistaken for a pending one', async (t) => {
  // V1: the visible screen carries the echo of prompts already submitted. A whole-screen presence
  // test answers "was this ever sent", not "is this sitting un-submitted" — and a loop re-sending a
  // byte-identical prompt would match its own echo.
  const prompt = 'run the verify suite again';
  const tail = tmux.ourTextTail(prompt);
  const screenWithEcho = [
    `❯${NBSP}${prompt}`, // the echo of the PREVIOUS submit, in scrollback
    '',
    '● done',
    '',
    RULE,
    `❯${NBSP}`, // …and the live composer, empty
    RULE,
    '  ⏸ manual mode on',
  ].join('\n');

  await t.test('the composer classifier reads the live composer, not the echo', () => {
    assert.equal(claudeAdapter.composerPending?.(screenWithEcho), false);
    assert.equal(claudeAdapter.composerText?.(screenWithEcho), '');
  });

  await t.test('the SCOPED matcher does not find our text in the echo', () => {
    assert.equal(tmux.snapshotHoldsOurText(screenWithEcho, tail, claudeAdapter.composerText), false);
  });

  await t.test('…while an UNSCOPED search does — which is why the scoping exists', () => {
    assert.equal(tmux.snapshotHoldsOurText(screenWithEcho, tail, undefined), true);
  });
});

// ---- scratch-tmux integration (self-skipping) ----

const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);
const READLINE = 'bash --noprofile --norc -c \'while IFS= read -r -e -p "> " l; do echo "got:[$l]"; done\'';
const SOCK = `submitverify-${process.pid}`; // deliberately NOT ct-* : the reconciler must never see it

async function tmuxCmd(args: string[]): Promise<string> {
  const { stdout } = await pexec('tmux', ['-L', SOCK, ...args], { timeout: 10_000 });
  return stdout;
}
async function killScratch(): Promise<void> {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/**
 * Wait for a pane condition instead of guessing a settle time. These cases run on a machine that is
 * also running builds and other agents, so a fixed 300-500 ms budget is a coin flip under load — and
 * a suite that flakes is a suite people learn to ignore, which for THIS suite means ignoring the
 * proof that the send boundary works. Polls to a generous ceiling and returns as soon as it is true.
 */
async function waitForPane(pred: (snap: string) => boolean, ms = 5_000): Promise<string> {
  const deadline = Date.now() + ms;
  let snap = '';
  for (;;) {
    snap = await tmux.captureVisible(SOCK);
    if (pred(snap)) return snap;
    if (Date.now() >= deadline) return snap;
    await wait(100);
  }
}
/** A scratch pane, ready: created, and confirmed to have painted before the case runs. */
async function startPane(command: string, ready: (snap: string) => boolean = (s) => s.trim().length > 0): Promise<void> {
  // STAGED retry, bounded and loud: under full-suite load the kill-server → new-session pair on
  // the same socket can race the dying server ("server exited unexpectedly" — the fresh server
  // binds the socket, then exits with the old one). This is pure fixture staging, before any
  // product interaction, so re-staging here can never mask a product regression — a mid-drive
  // server death surfaces as different messages ("no server running", "error connecting") and any
  // other spawn failure still throws at once.
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      await tmuxCmd(['new-session', '-d', '-s', 'main', '-x', '80', '-y', '10', command]);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] paint attempt ${attempt} lost the fresh tmux server to the kill-server race; re-staging`);
    }
  }
  await waitForPane(ready);
}

test('sendTextVerified against a live scratch pane', { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {
  await t.test('happy path: text lands, Enter submits, outcome is verified', async () => {
    // A readline loop: it echoes what is typed and consumes the line on Enter, so "the last line
    // starts with the prompt marker and has content" is a faithful stand-in for a composer.
    await startPane(READLINE, (s0) => /^>/m.test(s0));
    // NB: capture-pane strips trailing whitespace, so an EMPTY readline prompt is a bare '>'.
    const classifier = (snap: string): boolean | undefined => {
      const last = snap.split('\n').filter((l) => l.trim().length > 0).pop() ?? '';
      const m = /^>\s?(.*)$/.exec(last);
      return m ? m[1]!.trim().length > 0 : undefined;
    };
    const outcome = await tmux.sendTextVerified(SOCK, 'hello there', { composerPending: classifier });
    assert.equal(outcome, 'verified');
    assert.match(await waitForPane((s0) => /got:\[hello there\]/.test(s0)), /got:\[hello there\]/);
    await killScratch();
  });

  await t.test('swallowed Enter: bounded retries, then a no-submit throw — never verified', async () => {
    // `sleep` echoes nothing and consumes nothing, so the classifier below reports a composer that
    // never clears: exactly the swallowed-submit shape.
    await startPane('sleep 600', () => true);
    let polls = 0;
    const started = Date.now();
    await assert.rejects(
      // Empty before we type (so the pre-check proceeds), then holding our text forever: the exact
      // shape of a swallowed Enter. A classifier that reported 'pending' up front would instead be
      // describing someone else's draft — which is the foreign-text case, tested separately.
      () => tmux.sendTextVerified(SOCK, 'never submits', {
        composerPending: () => { polls++; return polls > 1; },
      }),
      (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'no-submit',
    );
    // Bounded: 1 + ENTER_RETRIES attempts of SUBMIT_POLLS each, plus the pre/appear reads.
    assert.ok(polls <= 20, `polls=${polls}`);
    assert.ok(Date.now() - started < 20_000);
    await killScratch();
  });

  await t.test('dead pane: throws BEFORE any key is sent, and the pane is untouched', async () => {
    // remain-on-exit must be set BEFORE the command exits, or tmux destroys the session — and with
    // the last session, the whole SERVER, so the very next call dies with "no server running". A
    // command that exits on its own schedule (`sleep 1`) makes that a race the fixture loses
    // whenever two execs land more than a second apart, which on a loaded machine is routine and
    // took the whole file red. So the pane blocks on `read` and WE trigger the exit, after the
    // option is set: no window to lose, and no timing assumption left to tune.
    // Same STAGED retry as startPane(): re-stage only when the fresh server lost the socket to the
    // dying one ("server exited unexpectedly") — any other failure still throws at once.
    for (let attempt = 1; ; attempt++) {
      await killScratch();
      try {
        await tmuxCmd(['new-session', '-d', '-s', 'main', '-x', '80', '-y', '10', 'sh -c "echo alive; read _"']);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
        console.error(`[infra-retry] paint attempt ${attempt} lost the fresh tmux server to the kill-server race; re-staging`);
      }
    }
    await tmuxCmd(['set-option', '-t', 'main', 'remain-on-exit', 'on']);
    await tmuxCmd(['send-keys', '-t', 'main', 'C-m']); // let `read` return, and the shell exit
    // Wait for the pane to actually DIE rather than guessing: the whole case is about a corpse.
    for (let i = 0; i < 60 && !(await tmux.paneInfo(SOCK))?.dead; i++) await wait(100);
    // …and say so if it never did, rather than leaving a live pane to fail the assertions below as
    // if `sendTextVerified` were the thing at fault.
    assert.ok((await tmux.paneInfo(SOCK))?.dead, 'the fixture must leave a genuinely dead pane');
    const before = await tmux.captureVisible(SOCK);
    await assert.rejects(
      () => tmux.sendTextVerified(SOCK, 'into the corpse', { composerPending: () => false }),
      (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'dead-pane',
    );
    assert.equal(await tmux.captureVisible(SOCK), before, 'nothing may be typed into a dead pane');
    await killScratch();
  });

  await t.test("foreign text: refuses, and the human's draft is neither submitted nor appended to", async () => {
    await killScratch();
    await startPane(READLINE, (s0) => /^>/m.test(s0));
    await tmuxCmd(['send-keys', '-t', 'main', '-l', 'a human was here']); // the draft, no Enter
    await waitForPane((s0) => /a human was here/.test(s0));
    await assert.rejects(
      () => tmux.sendTextVerified(SOCK, 'our very different prompt', { composerPending: () => true }),
      (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'foreign-text',
    );
    const snap = await tmux.captureVisible(SOCK);
    assert.doesNotMatch(snap, /got:\[/, 'the draft must not have been submitted');
    assert.doesNotMatch(snap, /our very different prompt/, 'our text must not have been appended');
    assert.match(snap, /a human was here/, 'the draft must survive intact');
    await killScratch();
  });

  await t.test('our own leftover text takes the Enter-only path — never retyped', async () => {
    await killScratch();
    await startPane(READLINE, (s0) => /^>/m.test(s0));
    await tmuxCmd(['send-keys', '-t', 'main', '-l', 'our prompt']); // as a swallowed Enter would leave it
    await waitForPane((s0) => /our prompt/.test(s0));
    let calls = 0;
    const outcome = await tmux.sendTextVerified(SOCK, 'our prompt', {
      composerPending: (snap: string) => {
        calls++;
        const last = snap.split('\n').filter((l) => l.trim().length > 0).pop() ?? '';
        const m = /^>\s?(.*)$/.exec(last);
        return m ? m[1]!.trim().length > 0 : undefined;
      },
    });
    assert.equal(outcome, 'verified');
    const snap = await waitForPane((s0) => /got:\[our prompt\]/.test(s0));
    assert.match(snap, /got:\[our prompt\]/, 'the leftover text was submitted');
    assert.doesNotMatch(snap, /got:\[our promptour prompt\]/, 'it must NOT have been typed a second time');
    assert.ok(calls > 0);
    await killScratch();
  });

  await t.test('degraded: no classifier → the text still lands, outcome is unverified', async () => {
    await killScratch();
    await startPane(READLINE, (s0) => /^>/m.test(s0));
    const outcome = await tmux.sendTextVerified(SOCK, 'blind send', {});
    assert.equal(outcome, 'unverified');
    assert.match(await waitForPane((s0) => /got:\[blind send\]/.test(s0)), /got:\[blind send\]/);
    await killScratch();
  });

  await t.test('an inconclusive composer + no went-working → unverified, never a claim', async () => {
    await killScratch();
    await startPane('sleep 600', () => true);
    const outcome = await tmux.sendTextVerified(SOCK, 'who knows', { composerPending: () => undefined });
    assert.equal(outcome, 'unverified');
    await killScratch();
  });

  await t.test('an inconclusive composer + went-working → verified (the DEC-2 tie-break)', async () => {
    await killScratch();
    await startPane('sleep 600', () => true);
    const outcome = await tmux.sendTextVerified(SOCK, 'who knows', {
      composerPending: () => undefined,
      wentWorking: () => true,
    });
    assert.equal(outcome, 'verified');
    await killScratch();
  });

  await t.test('a swallowed TYPE with a conclusively empty composer throws no-appear', async () => {
    // `stty -echo` so the tty cannot echo our text: nothing ever appears, and the classifier says the
    // composer is affirmatively empty. That combination is positive evidence the keystrokes went
    // nowhere — and throwing leaves a verified-empty composer for the next-tick retry to type into.
    await killScratch();
    await startPane('sh -c "stty -echo; sleep 600"', () => true);
    await assert.rejects(
      () => tmux.sendTextVerified(SOCK, 'swallowed entirely', { composerPending: () => false }),
      (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'no-appear',
    );
    await killScratch();
  });

  await t.test('an ECHO of our own prompt cannot stand in for a delivered send', async () => {
    // The proven FATAL: a loop re-sends a byte-identical prompt, the send-keys is swallowed, the
    // classifier correctly reads the composer EMPTY — and a whole-screen presence test matches the
    // echo of the previous submit, so the no-appear throw is skipped and the empty composer is read
    // as "submitted". Delivered nothing, reported 'verified'.
    await killScratch();
    try {
      // `stty -echo` so the tty cannot echo the send: the ONLY occurrence of our text on screen is
      // the pre-existing echo line, exactly as claude's scrollback would carry it.
      await startPane('sh -c "stty -echo; printf \'❯ run the verify suite again\\n\'; sleep 600"',
        (s0) => /run the verify suite again/.test(s0));
      const before = await tmux.captureVisible(SOCK);
      assert.match(before, /run the verify suite again/, 'the echo must be on screen for this to assert anything');
      await assert.rejects(
        () => tmux.sendTextVerified(SOCK, 'run the verify suite again', {
          composerPending: () => false, // the composer really is empty — nothing was delivered
        }),
        (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'no-appear',
        'a send that went nowhere must throw, never return verified',
      );
    } finally {
      await killScratch();
    }
  });

  await t.test('a permission dialog is refused BEFORE anything is typed', async () => {
    // The hazard: a bare Enter into a claude permission dialog CONFIRMS the highlighted option. The
    // loop gates on FSM state only, and a lost or late hook is exactly why the nudge veto exists —
    // so the send path must look at the SCREEN before it types, not just at the state.
    await startPane('sh -c "stty -echo; printf \'Do you want to proceed?\\n\'; sleep 600"',
      (s0) => /Do you want to proceed/.test(s0));
    const before = await tmux.captureVisible(SOCK);
    await assert.rejects(
      () => tmux.sendTextVerified(SOCK, 'our prompt', {
        composerPending: () => false,
        permissionPending: (snap) => /Do you want to proceed/i.test(snap),
      }),
      (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'dialog-open',
    );
    assert.equal(await tmux.captureVisible(SOCK), before, 'not one key may reach a pane showing a dialog');
    await killScratch();
  });

  await t.test('a dialog that opens WHILE we type is refused before the first Enter', async () => {
    // Nothing has been submitted at that point, so this throws rather than degrading: the Enter that
    // would have gone next is precisely the one that would confirm the dialog.
    await startPane('sh -c "stty -echo; sleep 600"', () => true);
    let reads = 0;
    await assert.rejects(
      () => tmux.sendTextVerified(SOCK, 'our prompt', {
        composerPending: () => undefined,
        // Clean at the pre-check, then the dialog appears during the appear window.
        permissionPending: () => ++reads > 1,
      }),
      (e: unknown) => e instanceof tmux.SendVerifyError && e.kind === 'dialog-open',
    );
    await killScratch();
  });

  await t.test('a SLOW RENDER is confirmed before the send is declared lost', async () => {
    // Inside the appear window a slow render and a swallowed send are identical — both read empty.
    // Throwing on the slow one is not harmless: the retry re-enters the pre-check, and a provider
    // whose classifier can never answer `true` (codex, by design) reads the now-filled composer as
    // `undefined`, types AGAIN, and submits the doubled prompt as one. So an empty reading gets one
    // confirmation at a longer delay before it is trusted.
    await startPane('sh -c "stty -echo; sleep 600"', () => true);
    let calls = 0;
    // Empty through the pre-check and the whole appear window, then the render lands.
    const slowRender = (): boolean | undefined => (++calls <= 4 ? false : true);
    let kind: string | undefined;
    let outcome: string | undefined;
    try {
      outcome = await tmux.sendTextVerified(SOCK, 'a slowly rendered prompt', {
        composerPending: slowRender,
        composerText: () => (calls <= 4 ? '' : 'a slowly rendered prompt'),
      });
    } catch (e) {
      kind = e instanceof tmux.SendVerifyError ? e.kind : 'other';
    }
    // The claim under test is narrow and exact: the send must NOT be diagnosed as never having
    // arrived. What happens after the text lands is a separate question — here the stub composer
    // never clears, so the honest outcome is the bounded no-submit fault.
    assert.notEqual(kind, 'no-appear', 'a slow render must not be mistaken for a lost send');
    assert.ok(kind === 'no-submit' || outcome !== undefined, `unexpected result: ${kind ?? outcome}`);
    await killScratch();
  });

  await t.test('an EMPTY composer whose appearance was never established is NOT verified', async () => {
    // The false-'verified' window this guard closes: the TYPE is swallowed, the appear window happens
    // to read INCONCLUSIVE (a transient dialog, an alt screen, a capture hiccup — capturePlain
    // returns '' on error), and then the submit poll reads the genuinely-empty composer. Without
    // tracking whether the text was ever seen to arrive, that reads as 'verified' — a prompt neither
    // delivered nor submitted, a turn that looks like a fast no-op, and an auto-advancing mission
    // sailing past it. Exactly the silent trace this wave exists to close.
    await killScratch();
    await startPane('sh -c "stty -echo; sleep 600"', () => true);
    let calls = 0;
    // Inconclusive through the pre-check and the whole appear window, then affirmatively empty.
    const flaky = (): boolean | undefined => (++calls <= 4 ? undefined : false);
    const outcome = await tmux.sendTextVerified(SOCK, 'never arrived', { composerPending: flaky });
    assert.equal(outcome, 'unverified', 'must not claim verified without positive evidence of arrival');

    calls = 0;
    // …and the same screens WITH a hook-driven went-working are verified: that is real evidence.
    const withHook = await tmux.sendTextVerified(SOCK, 'never arrived', {
      composerPending: flaky,
      wentWorking: () => true,
    });
    assert.equal(withHook, 'verified');
    await killScratch();
  });
});

process.on('exit', () => {
  // kill-server FIRST: unlinking the socket without it orphans the pane's process for the whole
  // sleep, and it can no longer be reached by name to kill.
  spawnSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  rmSync(home, { recursive: true, force: true });
  // tmux leaves the socket FILE behind after kill-server, so remove ours too: a test suite that
  // litters /tmp with one dead socket per run is a slow mess for whoever runs it next.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`) : `/tmp/tmux-${uid}`;
  rmSync(join(dir, SOCK), { force: true });
});
