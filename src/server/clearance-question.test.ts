// SPEC-CLEARANCE — the dock CLEARANCE card, both halves.
//
// §A (detection): claude's idle_prompt Notification fires after ~60s at ANY bare prompt, and the
// old wire mapped it straight to needs-input → every idle pane became a phantom QUESTION hold that
// nothing cleared (claude has no turn-done parse; the poller never downgrades a blocked state).
// The fix is an AFFIRMATIVE-ONLY screen veto in MissionControl.ingestSignal: questionPending
// suppresses ONLY when the composer is present AND empty AND no question affordance is visible —
// every inconclusive read honors the hook. agent_needs_input rides the wire as 'agent-question'
// and is never vetoed. These tests prove the veto's three verdicts, that the suppress branch's
// QUESTION_BLOCKER term is the load-bearing guard (a selector-less boxed/numbered ask above an
// empty composer must NOT read idle — the empty-composer term alone would mis-suppress it, and
// the affordance fast-path cannot catch it), and the ingestSignal end-to-end behavior.
//
// §B (rendering): describeAttention extracts the real question into AttentionItem.message and a
// chrome-stripped preview — buildAttention consults it for kind==='question' ONLY. The permission
// card is pinned byte-identical by a deep-equal against the FROZEN old algorithm, replicated here
// on purpose: if the permission path ever drifts, this file goes red.
//
// questionPending/describeAttention are pure over fixture strings (the claude-onboarding
// direct-adapter precedent); ingestSignal/buildAttention run against a REAL scratch tmux pane
// (non-`ct-` socket, the poller-resize precedent) painted from a fixture file so the multi-byte
// TUI glyphs survive verbatim. Self-skips when tmux is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { Mail } from './coordination.js';
import type { ProviderStore } from './providers/store.js';
import type { AttentionItem, Terminal } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-clearance-'));
process.env.CT_HOME = home;

const pexec = promisify(execFile);
const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);

const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { claudeAdapter } = await import('./adapters/claude.js');
const { paneAffirmativelyIdle } = await import('./idle-evidence.js');
const { geminiAdapter } = await import('./adapters/gemini.js');
const { codexAdapter } = await import('./adapters/codex.js');
const { MissionControl } = await import('./mission.js');
const { initProviderRegistry } = await import('./providers/registry.js');
const { captureVisible, capturePlain } = await import('./tmux.js');
const { auditTail } = await import('./audit.js');

// The singleton mission.ts resolves adapters through; built-ins need no store defs.
initProviderRegistry({ list: () => [] } as unknown as ProviderStore);

// ---- fixtures (claude 2.1.216 frame — the pinned composer sandwich of claude.ts) ----

const RULE = '─'.repeat(40);

/** A bare idle pane: transcript, empty rule-sandwiched composer, status footer, task list. The
 *  exact screen every phantom hold was minted from. */
const IDLE = [
  '⏺ All checks passed; the refactor landed cleanly and the suite is green.',
  '',
  RULE,
  '❯',
  RULE,
  '  ⏸ manual mode on · ? for shortcuts',
  '  ☐ Polish the card rendering',
].join('\n');

/** A full-frame ask-the-user dialog — selector options, no composer. */
const DIALOG = [
  '⏺ I need a decision before I continue.',
  '',
  '╭──────────────────────────────────────────╮',
  '│ Which storage backend should the cache   │',
  '│ use?                                     │',
  '│                                          │',
  '│ ❯ 1. Redis                               │',
  '│   2. SQLite                              │',
  '│   3. Skip the cache for now              │',
  '╰──────────────────────────────────────────╯',
].join('\n');

/** A dialog that KEPT its (empty) composer rendered below the box. The composer term alone reads
 *  this "present AND empty"; the affordance fast-path AND the step-4 blocker each refuse to
 *  suppress it — the singly-load-bearing blocker term is isolated by the selector-less fixtures
 *  below, where the fast-path cannot fire. */
const DIALOG_WITH_COMPOSER = [
  '⏺ One decision needed.',
  '',
  '╭──────────────────────────────────────────╮',
  '│ Which storage backend should the cache   │',
  '│ use?                                     │',
  '│ ❯ 1. Redis                               │',
  '│   2. SQLite                              │',
  '╰──────────────────────────────────────────╯',
  '',
  RULE,
  '❯',
  RULE,
  '  ? for shortcuts',
].join('\n');

/** A box-framed ask with NO `❯ N.` selector row and no "Do you want" — QUESTION_AFFORDANCE cannot
 *  fire, so ONLY the step-4 blocker's frame term stands between this and a wrong `false`. */
const BOXED_NO_SELECTOR = [
  '⏺ Pick the migration order below.',
  '',
  '╭──────────────────────────────────────────╮',
  '│ Pick an option and reply with its number │',
  '╰──────────────────────────────────────────╯',
  '',
  RULE,
  '❯',
  RULE,
  '  ? for shortcuts',
].join('\n');

/** Bare numbered option rows — no selector, no box, no "Do you want". Same isolation: only the
 *  blocker's numbered-row term prevents the suppress. */
const NUMBERED_NO_SELECTOR = [
  '⏺ Reply with the number of the schema to migrate first:',
  '  1. accounts',
  '  2. billing',
  '',
  RULE,
  '❯',
  RULE,
  '  ? for shortcuts',
].join('\n');

/** Mid-turn: the composer renders EMPTY while the footer says esc-to-interrupt. */
const MID_TURN = [
  '✳ Compacting context…',
  '',
  RULE,
  '❯',
  RULE,
  '  esc to interrupt',
].join('\n');

/** The welcome banner — a `│ > │` box, NOT the rule-sandwiched composer. Inconclusive. */
const WELCOME = [
  '╭──────────────────────────────────────────╮',
  '│ Welcome back!                            │',
  '│                                          │',
  '│ > Try "fix the failing test"             │',
  '╰──────────────────────────────────────────╯',
].join('\n');

/** A half-typed human draft in the composer — never a suppress verdict. */
const DRAFT = [
  '⏺ Done with the module.',
  '',
  RULE,
  '❯ also update the docs please',
  RULE,
  '  ? for shortcuts',
].join('\n');

/** A permission dialog — drives the byte-identical permission-card regression guard. */
const PERMISSION = [
  '⏺ Bash(rm -rf build)',
  '',
  '╭──────────────────────────────────────────╮',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. No                                  │',
  '╰──────────────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n');

// ---- §A: questionPending fixtures (pure) ----

test('questionPending: a bare idle pane is affirmatively idle (false — suppress)', () => {
  assert.equal(claudeAdapter.questionPending?.(IDLE), false);
});

test('questionPending: a selector dialog affirms the hold (true)', () => {
  assert.equal(claudeAdapter.questionPending?.(DIALOG), true);
});

test('questionPending: a dialog above an empty composer takes the affordance fast-path (true)', () => {
  // Pins the step-3 fast-path. NOTE it is observationally REDUNDANT in production (only `false`
  // vetoes, so its `true` and step 4's `undefined` behave identically); the singly-load-bearing
  // guard is step 4's blocker term, isolated by the next test. Deleting BOTH terms is what turns
  // this fixture into a mis-suppressed `false`.
  assert.equal(claudeAdapter.questionPending?.(DIALOG_WITH_COMPOSER), true);
});

test('questionPending: the step-4 blocker term is the load-bearing suppression guard', () => {
  // These fixtures ISOLATE `!QUESTION_BLOCKER.test(above)`: no selector row and no "Do you want",
  // so the step-3 fast-path cannot fire, and with the blocker term deleted step 4 decides on
  // "composer present AND empty" alone → `false` — a real ask suppressed. MUTATION-verified:
  // deleting that term turns exactly this test red (actual: false). Today both fixtures read
  // undefined — honor the hook — and must NEVER read false.
  assert.equal(claudeAdapter.questionPending?.(BOXED_NO_SELECTOR), undefined);
  assert.equal(claudeAdapter.questionPending?.(NUMBERED_NO_SELECTOR), undefined);
});

test('questionPending: mid-turn, welcome banner, and a typed draft are inconclusive (undefined — honor the hook)', () => {
  assert.equal(claudeAdapter.questionPending?.(MID_TURN), undefined);
  assert.equal(claudeAdapter.questionPending?.(WELCOME), undefined);
  assert.equal(claudeAdapter.questionPending?.(DRAFT), undefined);
  assert.equal(claudeAdapter.questionPending?.(''), undefined); // a failed capture resolves ''
});

// ---- §B: describeAttention (pure) ----

test('describeAttention: a dialog yields the question as message and the box as preview', () => {
  const d = claudeAdapter.describeAttention?.(DIALOG);
  assert.equal(d?.message, 'Which storage backend should the cache use?');
  // The preview is the BOX slice, frame to frame (this fixture has no footer, so a
  // no-footer assert here would be vacuous — the footered fixture below carries that check).
  assert.ok(/^╭/.test(d?.preview?.[0] ?? ''), 'preview opens at the box frame');
  assert.ok(/^╰/.test(d?.preview?.[d.preview.length - 1] ?? ''), 'preview closes at the box frame');
});

test('describeAttention: dialog-with-composer extracts the boxed question and strips the chrome below', () => {
  const d = claudeAdapter.describeAttention?.(DIALOG_WITH_COMPOSER);
  assert.equal(d?.message, 'Which storage backend should the cache use?');
  // This fixture HAS a footer and a composer below the box — the meaningful chrome-strip check.
  assert.ok(!d?.preview?.some((l) => /\? for shortcuts|^─{10,}$|^❯$/.test(l)), 'no footer/composer rows in the preview');
});

test('describeAttention: an idle pane yields the last transcript block, never composer/footer chrome', () => {
  const d = claudeAdapter.describeAttention?.(IDLE);
  assert.equal(d?.message, 'All checks passed; the refactor landed cleanly and the suite is green.');
  assert.ok(!d?.preview?.some((l) => /\? for shortcuts|☐|^─{10,}$|^❯/.test(l)), 'preview holds transcript only');
});

test('describeAttention: an unrecognized frame (welcome banner) is undefined — the raw fallback stands', () => {
  assert.equal(claudeAdapter.describeAttention?.(WELCOME), undefined);
});

test('describeAttention: codex strips its hint/footer chrome; gemini drops its input box', () => {
  const cx = codexAdapter.describeAttention?.(['Change applied to src/app.ts.', '› Write tests for the parser', '  token usage · ~/repo'].join('\n'));
  assert.equal(cx?.message, 'Change applied to src/app.ts.');
  assert.ok(!cx?.preview?.some((l) => /›|~\//.test(l)), 'codex chrome rows are stripped');
  const gm = geminiAdapter.describeAttention?.([
    'Which schema should I migrate first?',
    '╭──────────────────────────────╮',
    '│ Type your message or @path   │',
    '╰──────────────────────────────╯',
  ].join('\n'));
  assert.equal(gm?.message, 'Which schema should I migrate first?');
  assert.ok(!gm?.preview?.some((l) => /Type your message|╭|╰/.test(l)), 'the gemini input box is dropped');
});

// ---- ingestSignal + buildAttention against a real pane ----

const SOCK = `clearance-${process.pid}`; // NOT ct-* : the reconciler must never adopt it
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const killScratch = async (): Promise<void> => {
  await pexec('tmux', ['-L', SOCK, 'kill-server']).catch(() => {});
};

let fixtureN = 0;
/** Paint the scratch pane from a fixture FILE (multi-byte TUI glyphs survive verbatim; the
 *  poller-resize paint() inlines its content, which these box-drawing fixtures cannot). */
async function paint(content: string, sentinel: string): Promise<void> {
  const f = join(home, `fixture-${fixtureN++}.txt`);
  writeFileSync(f, content, 'utf8');
  // STAGED retry, bounded and loud: under full-suite load the kill-server → new-session pair on
  // the same socket can race the dying server ("server exited unexpectedly" — the fresh server
  // binds the socket, then exits with the old one). This is pure fixture staging, before any
  // product interaction, so re-staging here can never mask a product regression — a mid-drive
  // server death surfaces as different messages ("no server running", "error connecting") and any
  // other spawn failure still throws at once.
  for (let attempt = 1; ; attempt++) {
    await killScratch();
    try {
      await pexec('tmux', ['-L', SOCK, 'new-session', '-d', '-s', 'main', '-x', '120', '-y', '40',
        `sh -c 'cat "${f}"; exec sleep 600'`], { timeout: 10_000 }).catch((e) => {
        throw new Error(`paint: new-session failed (tmux infra error under load): ${(e as Error).message}`);
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/server exited unexpectedly/.test(msg)) throw err;
      console.error(`[infra-retry] paint attempt ${attempt} lost the fresh tmux server to the kill-server race; re-staging`);
    }
  }
  for (let i = 0; i < 100; i++) {
    if ((await captureVisible(SOCK)).includes(sentinel)) return;
    await wait(50);
  }
  throw new Error(`paint: pane never rendered ${JSON.stringify(sentinel)} (tmux infra error under load)`);
}

/**
 * buildAttention, re-tried until `ready` accepts the items. Under full-suite load a tmux capture
 * can come back '' (spawn contention), and a card built off an empty capture must not decide a
 * product verdict — the poller-resize tickSwept posture. Bounded and LOUD: exhausting the tries is
 * a tmux infra failure under load, never a silent pass.
 */
async function settledAttention(
  mission: { buildAttention(): Promise<AttentionItem[]> },
  ready: (items: AttentionItem[]) => boolean,
): Promise<AttentionItem[]> {
  let items: AttentionItem[] = [];
  for (let i = 0; i < 8; i++) {
    items = await mission.buildAttention();
    if (ready(items)) return items;
    await wait(50);
  }
  throw new Error('settledAttention: the capture never settled (tmux infra error under load)');
}

/** A MissionControl over one stub claude terminal on the scratch socket. The store stub mirrors
 *  the two writes ingest performs (state patch + lastEventAt). */
function harness(state: Terminal['state']) {
  const term: Terminal = {
    id: 't-clearance', projectId: 'p1', title: 'builder', provider: 'claude-code',
    tmuxSocket: SOCK, cwd: home, command: ['claude'], state,
    createdAt: '2026-08-09T00:00:00.000Z',
  } as Terminal;
  const store = {
    getTerminal: (id: string) => (id === term.id ? term : undefined),
    listTerminals: () => [term],
    appendEvent: (ev: { terminalId: string; type: string }, extraPatch?: Partial<Terminal>) => {
      const ts = new Date().toISOString();
      Object.assign(term, extraPatch, { lastEventAt: ts });
      return { ...ev, seq: 1, ts };
    },
    patchTerminal: (_id: string, patch: Partial<Terminal>) => Object.assign(term, patch),
  } as unknown as Store;
  const mail = { unreadCount: () => 0 } as unknown as Mail;
  return { mission: new MissionControl(store, mail), term };
}

test('SPEC-LOOPWEDGE F-1 — paneAffirmativelyIdle refuses a pane awaiting the human (a lost strong-question hook)', () => {
  // A bare idle pane IS affirmatively idle — the F2 backstop may heal it.
  assert.equal(paneAffirmativelyIdle(IDLE, claudeAdapter, false).evidenceOk, true, 'a bare idle pane reads idle');
  // But a selection box above an EMPTY composer (a lost agent_needs_input hook, left 'working') is NOT
  // idle: the pane awaits the operator, not a finished turn. Its composer is empty (passes check 6) and
  // a suspended-for-input turn shows NO `esc to interrupt` (passes check 4), so the question classifier
  // (check 7) is the ONLY guard. Reverting check 7 flips this to true — F2 would then demote a pane
  // mid-question, abandoning it (and a mail-nudge could be typed into the dialog).
  assert.equal(paneAffirmativelyIdle(DIALOG_WITH_COMPOSER, claudeAdapter, false).evidenceOk, false, 'a pane showing a question is NOT idle');
  // Independently: a mid-turn pane stays excluded by the busy footer (check 4)...
  assert.equal(paneAffirmativelyIdle(MID_TURN, claudeAdapter, false).evidenceOk, false, 'a mid-turn pane is not idle');
  // ...and a live tool child (hasActiveWork) blocks the demote regardless of the screen.
  assert.equal(paneAffirmativelyIdle(IDLE, claudeAdapter, true).evidenceOk, false, 'a live tool child blocks the demote');
  // H1: a FROZEN spinner glyph (✳) with a truncated/absent `esc to interrupt` footer is still
  // mid-turn — the widened busy check (4) catches the glyph even when the footer is gone. Its composer
  // reads empty and questionPending is undefined (CLAUDE_BUSY), so WITHOUT the glyph in the busy check
  // this frame would read idle (a wrong demote). Reverting the ✳ widening flips this to true.
  const FROZEN_SPINNER = ['✳ Thinking…', '', RULE, '❯', RULE, '  ? for shortcuts'].join('\n');
  assert.equal(paneAffirmativelyIdle(FROZEN_SPINNER, claudeAdapter, false).evidenceOk, false, 'a frozen spinner glyph is mid-turn, not idle (H1)');
});

test('SPEC-LOOPWEDGE F-3 — a real Stop on an already-idle INFERRED pane downgrades the inferred flag', async () => {
  // F2/F1 demoted a wedged pane to idle by SCREEN EVIDENCE (idleInferred=true). Later the genuine Stop
  // hook finally lands (a real turn-done, inferred=false) while the pane is already idle → the state is
  // a no-op, but the flag MUST downgrade to a confirmed real idle so the loop GUARD stops over-gating a
  // turn a real hook has now confirmed. Reverting F-3 leaves the flag stale-true.
  const { mission, term } = harness('idle');
  term.idleInferred = true; // as an F2 poller demote (or F1 harvest) would have left it
  const changed = await mission.ingestSignal(term.id, 'turn-done'); // a REAL Stop, inferred=false
  assert.equal(changed, false, 'idle→idle is a state no-op');
  assert.equal(term.idleInferred, false, 'the genuine Stop downgraded the inferred flag');
});

test('the clearance pipeline over a real pane', { skip: haveTmux ? false : 'tmux is not installed' }, async (t) => {
  try {
    await t.test('needs-input on an idle screen is vetoed: state untouched, no card', async () => {
      await paint(IDLE, 'Polish the card rendering');
      // Under suite load the veto's own capture can come back '' → the hook is HONORED (correct
      // product posture: fail toward the card). Discriminate that infra miss from a real
      // regression: when the signal held, a fresh read of the same static pane must still say
      // "affirmatively idle" — then the earlier capture was the miss, and a fresh harness retries.
      let vetoed = false;
      for (let i = 0; i < 5 && !vetoed; i++) {
        const { mission, term } = harness('idle');
        const changed = await mission.ingestSignal(term.id, 'needs-input');
        if (changed) {
          assert.equal(
            claudeAdapter.questionPending?.(await captureVisible(SOCK)), false,
            'the idle fixture must read affirmatively idle — the veto did not suppress it',
          );
          continue; // verdict false ⇒ the in-flight capture was empty under load — retry
        }
        assert.equal(term.state, 'idle', 'the Stop-set idle state is left alone');
        assert.equal((await mission.buildAttention()).length, 0, 'no phantom card');
        vetoed = true;
      }
      if (!vetoed) throw new Error('the veto never engaged in 5 tries (tmux infra error under load)');
    });

    await t.test('needs-input with a dialog on screen holds: blocked-question WITH a card', async () => {
      const { mission, term } = harness('idle');
      // The footered variant, so the no-footer assert below is meaningful (the footerless DIALOG
      // fixture would satisfy it vacuously). LAST content row as sentinel — the frame is complete.
      await paint(DIALOG_WITH_COMPOSER, '? for shortcuts');
      const changed = await mission.ingestSignal(term.id, 'needs-input');
      assert.equal(changed, true);
      assert.equal(term.state, 'blocked-question');
      const items = await settledAttention(mission, (its) => its[0]?.message !== undefined);
      assert.equal(items.length, 1);
      assert.equal(items[0]?.kind, 'question');
      assert.equal(items[0]?.message, 'Which storage backend should the cache use?');
      assert.ok(!items[0]?.preview.some((l) => /\? for shortcuts|esc to interrupt/.test(l)), 'no footer in the card preview');
    });

    await t.test('agent-question is a strong signal: the same idle screen still holds', async () => {
      // The discriminating pair to the veto test above: identical pane, stronger wire signal.
      const { mission, term } = harness('idle');
      await paint(IDLE, 'Polish the card rendering');
      const changed = await mission.ingestSignal(term.id, 'agent-question');
      assert.equal(changed, true, 'agent_needs_input must never be screen-vetoed');
      assert.equal(term.state, 'blocked-question');
    });

    await t.test('SPEC-LOOPWEDGE F1: an affirmatively-idle screen on a WORKING record harvests an INFERRED turn-done', async () => {
      // The wedge heal (F1): claude fires idle_prompt ~60s after any bare prompt, so a builder whose
      // Stop hook was lost — left falsely 'working' — self-heals when that idle_prompt's needs-input is
      // vetoed AS a phantom hold. Instead of only DROPPING it, ingestSignal harvests a turn-done marked
      // INFERRED, so the record demotes working→idle using claude's OWN signal, and the mark ensures the
      // loop GUARD can never let that inferred idle become an autopilot 'done'.
      let harvested = false;
      for (let i = 0; i < 5 && !harvested; i++) {
        await paint(IDLE, 'Polish the card rendering');
        const { mission, term } = harness('working');
        const changed = await mission.ingestSignal(term.id, 'needs-input');
        // Either the harvest engaged (working→idle) or, on a capture miss under load, the hook was
        // honored (working→blocked-question). A REVERT of F1 drops the signal → changed stays false.
        assert.equal(changed, true, 'a working record must harvest (→idle) or, on a capture miss, honor the hook (→blocked)');
        if (term.state === 'blocked-question') continue; // the veto capture came back '' — retry a fresh harness
        assert.equal(term.state, 'idle', 'the lost Stop self-heals: working → idle');
        assert.equal(term.idleInferred, true, 'the harvested idle is marked INFERRED (the loop GUARD reads this)');
        assert.ok(
          auditTail(200).some((e) => e.action === 'terminal.harvested-idle' && e.terminalId === term.id),
          'the harvest is audited (never silent)',
        );
        harvested = true;
      }
      if (!harvested) throw new Error('the harvest never engaged in 5 tries (tmux infra error under load)');
    });

    await t.test('SPEC-LOOPWEDGE F1: an already-idle record keeps the plain drop — no harvest, no inferred mark', async () => {
      // Discriminates the harvest from the plain veto: identical idle screen, but the record is ALREADY
      // idle — there is no wedged 'working' turn to heal — so the phantom hold is dropped and NO
      // inferred mark is set (a real Stop already put it idle).
      let dropped = false;
      for (let i = 0; i < 5 && !dropped; i++) {
        await paint(IDLE, 'Polish the card rendering');
        const { mission, term } = harness('idle');
        const changed = await mission.ingestSignal(term.id, 'needs-input');
        if (changed) {
          // A capture miss honored the hook (idle→blocked). Confirm the fixture still reads idle, retry.
          assert.equal(claudeAdapter.questionPending?.(await captureVisible(SOCK)), false, 'the idle fixture must read affirmatively idle');
          continue;
        }
        assert.equal(term.state, 'idle', 'the already-idle state is left alone');
        assert.notEqual(term.idleInferred, true, 'a drop on an already-idle record sets no inferred mark');
        dropped = true;
      }
      if (!dropped) throw new Error('the drop never engaged in 5 tries (tmux infra error under load)');
    });

    await t.test('a stale question hold renders the transcript, never the footer', async () => {
      const { mission } = harness('blocked-question');
      await paint(IDLE, 'Polish the card rendering');
      const [item] = await settledAttention(mission, (its) => its[0]?.message !== undefined);
      assert.equal(item?.message, 'All checks passed; the refactor landed cleanly and the suite is green.');
      assert.ok(!item?.preview.some((l) => /\? for shortcuts/.test(l)), 'footer stripped from the preview');
    });

    await t.test('an unrecognized frame leaves message ABSENT — the card body falls back honestly', async () => {
      const { mission } = harness('blocked-question');
      await paint(WELCOME, 'fix the failing test');
      // The readiness predicate demands the banner row in the preview — a card built off an empty
      // capture would make "message absent" pass vacuously.
      const [item] = await settledAttention(mission, (its) => its[0]?.preview.some((l) => l.includes('Welcome back')) ?? false);
      assert.ok(item && !('message' in item), 'no message key — the web card renders its honest fallback');
    });

    await t.test('the permission card is byte-identical to the pre-§B output', async () => {
      const { mission, term } = harness('blocked-permission');
      await paint(PERMISSION, '? for shortcuts');
      const [item] = await settledAttention(mission, (its) => (its[0]?.preview.length ?? 0) > 0);
      // The FROZEN old algorithm, replicated on purpose (raw rtrim → pop blanks → last 12 →
      // extractRequested over the raw preview). Drift in the permission path turns this red.
      let snap = '';
      for (let i = 0; i < 8 && !snap.includes('Do you want'); i++) {
        snap = await capturePlain(SOCK, 40);
        if (!snap.includes('Do you want')) await wait(50); // '' under suite load — retry
      }
      const lines = snap.split('\n').map((l) => l.replace(/\s+$/, ''));
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      const preview = lines.slice(-12);
      const frozenExtract = (pv: string[]): string | undefined => {
        for (const line of pv) {
          const m = line.match(/(?:run|execute|allow|command|tool)[:>\s]+(.{3,120})/i);
          if (m && m[1]) return m[1].trim();
        }
        const cand = pv.filter((l) => /[a-z0-9]/i.test(l) && !/^[─╭╮╰╯│┌┐└┘|=\s]+$/.test(l));
        return cand.sort((a, b) => b.length - a.length)[0]?.slice(0, 120);
      };
      assert.deepEqual(item, {
        terminalId: term.id,
        projectId: term.projectId,
        title: term.title,
        provider: term.provider,
        kind: 'permission',
        requested: frozenExtract(preview),
        preview,
        since: term.createdAt,
      });
      assert.deepEqual(
        Object.keys(item ?? {}).sort(),
        ['kind', 'preview', 'projectId', 'provider', 'requested', 'since', 'terminalId', 'title'],
        'no message key ever leaks onto a permission item',
      );
    });
  } finally {
    await killScratch();
  }
});
