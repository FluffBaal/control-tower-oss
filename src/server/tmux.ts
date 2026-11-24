// tmux command wrappers. Every Tower terminal gets its OWN tmux server on its OWN
// socket (`tmux -L ct-<id>`), per SPEC D6: this isolates one agent's session from
// another's (no cross-session capture-pane / send-keys under a shared server) and
// means one tmux server crash can't take down the fleet.
//
// All commands are run via execFile with argv arrays — never a shell string — so
// project/terminal names can't inject options or commands (SPEC §14).

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/** Hard ceiling on any single tmux invocation. A wedged tmux server (per-socket, so one terminal)
 *  would otherwise hang an await forever — and loops.tick awaits tmux inline under a single-flight
 *  flag, so one stuck call would silently freeze EVERY loop. A bounded reject degrades to a retry
 *  next tick instead. tmux() is the sole chokepoint (the pgrep calls already carry their own timeout). */
const TMUX_CMD_TIMEOUT_MS = 10_000;

// SPEC-SUBMIT §1.2 — the verified-send windows. Sized against the live pins:
// a claude submit clears the composer and fires UserPromptSubmit within ~1 s, so one appear poll and
// one submit poll are the typical cost. Every one of these is a CEILING, never a wait.
const APPEAR_POLLS = 3;
const APPEAR_INTERVAL_MS = 250;
// One longer confirmation read before concluding a send was lost (§1.3): inside the appear window a
// slow render and a swallowed send look identical, and only elapsed time tells them apart.
const APPEAR_CONFIRM_MS = 1_000;
const SUBMIT_POLLS = 4;
const SUBMIT_INTERVAL_MS = 500;
const ENTER_RETRIES = 2;
const TAIL_MARKER_LEN = 60;
// SPEC-SUBMIT §9 — ONE wall-clock budget for a whole verified send. The phase ceilings above
// multiply (appear 750ms + three submit windows of 2s + up to ~18 tmux execs, each of which can burn
// TMUX_CMD_TIMEOUT_MS against a stalled socket), and loops.tick awaits each drive SEQUENTIALLY under
// a single-flight flag — so an unbudgeted worst case would hold every other loop for minutes.
const VERIFY_BUDGET_MS = 8_000;

/** tmux -L <socket> sockets live under /tmp/tmux-<uid>/ by default. */
function socketDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return process.env.TMUX_TMPDIR
    ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`)
    : `/tmp/tmux-${uid}`;
}

export const SOCKET_PREFIX = 'ct-';
export const socketFor = (terminalId: string) => `${SOCKET_PREFIX}${terminalId}`;
export const MAIN = 'main'; // the single session name inside each socket

async function tmux(socket: string, args: string[], spawnEnv?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await pexec('tmux', ['-L', socket, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: TMUX_CMD_TIMEOUT_MS,
    // SIGKILL, not the default SIGTERM: a stalled tmux CLIENT traps SIGTERM and exits 0, so on
    // timeout execFile would RESOLVE with empty stdout — silently masking the stall as a clean
    // reading. Callers rely on a timeout surfacing as a rejection carrying `killed:true`
    // (hasSession/isPaneDead re-throw it so the reconciler skips a stalled socket rather than
    // vanishing it; poller/lease/attach have their own throw handling). SIGKILL can't be trapped,
    // so the timeout is always detectable. Kills only the short-lived client, never the tmux server.
    killSignal: 'SIGKILL',
    // Only new-session passes an env (to scrub NODE_ENV from the server it creates — see
    // serverSpawnEnv). Every other call is a short-lived CLIENT that never re-seeds the server's
    // env, so inheriting ours is harmless; leaving env undefined keeps execFile's default inherit.
    ...(spawnEnv ? { env: spawnEnv } : {}),
  });
  return stdout;
}

/** True if this socket has its `main` session alive. */
export async function hasSession(socket: string): Promise<boolean> {
  try {
    await tmux(socket, ['has-session', '-t', MAIN]);
    return true;
  } catch (e) {
    // A timeout (execFile SIGTERM-kills the child → `killed`) must NOT read as "session gone": that
    // would fail a healthy loop whose tmux server merely stalled. Re-throw it so the caller retries;
    // a genuine no-session result (non-zero exit, not killed) still answers false.
    if ((e as { killed?: boolean }).killed) throw e;
    return false;
  }
}

export interface NewSessionOpts {
  socket: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Non-secret env injected into the session (tmux >= 3.2 `-e`). */
  env: Record<string, string>;
  /** argv of the program to run (e.g. ['/bin/bash','-l'] or an agent CLI). */
  command: string[];
  /** Absolute path to a file that the pane output is also appended to. */
  logFile?: string;
}

/**
 * The environment a freshly-created tmux SERVER should inherit. The Tower process runs under
 * NODE_ENV=production (so its onboard-assistant MCP sidecar launches from dist and the control-plane
 * origin allowlist tightens), but that is a TOWER-internal flag that must NOT leak into an agent pane:
 * a pane inherits the server's env, and an inherited NODE_ENV=production makes an agent's `npm install`
 * silently skip devDependencies. Drop ONLY that var so a pane's base env matches a normal login shell;
 * everything else is inherited unchanged. Applied at new-session — the only call that creates the
 * server; later client calls never re-seed its env.
 */
export function serverSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.NODE_ENV;
  return env;
}

/** Create a detached session. Idempotent-ish: caller checks hasSession first. */
export async function newSession(o: NewSessionOpts): Promise<void> {
  const envArgs = Object.entries(o.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await tmux(
    o.socket,
    [
      'new-session',
      '-d',
      '-s',
      MAIN,
      '-x',
      String(o.cols),
      '-y',
      String(o.rows),
      '-c',
      o.cwd,
      ...envArgs,
      ...o.command,
    ],
    serverSpawnEnv(),
  );
  // Keep the pane alive after the command exits so state is inspectable.
  await tmux(o.socket, ['set-option', '-t', MAIN, 'remain-on-exit', 'on']).catch(() => {});
  // Pin the window size to our explicit resize() calls only. In the default `latest` mode an
  // attached client would auto-grow the window with no noteViewerResize fired — snapshot churn the
  // poller could misread as work. Declared here (not left to the -x/-y side effect) because both
  // resize call sites swallow errors: a silently-failed creation resize must not leave `latest`.
  await tmux(o.socket, ['set-option', '-w', '-t', MAIN, 'window-size', 'manual']).catch(() => {});
  if (o.logFile) {
    // Append raw pane output to a rotated log (durable record; SPEC §5).
    await tmux(o.socket, ['pipe-pane', '-t', MAIN, '-o', `cat >> '${o.logFile}'`]).catch(() => {});
  }
}

/** argv to attach a client; spawned inside a node-pty so the browser can drive it. */
export function attachArgv(socket: string): { file: string; args: string[] } {
  return { file: 'tmux', args: ['-L', socket, 'attach', '-t', MAIN] };
}

/** Snapshot the visible pane (with escape sequences) for an instant first paint. */
export async function capturePane(socket: string): Promise<string> {
  try {
    return await tmux(socket, ['capture-pane', '-e', '-p', '-t', MAIN]);
  } catch {
    return '';
  }
}

/** Plain-text pane snapshot (no escape sequences), for state parsing + previews. */
export async function capturePlain(socket: string, lines = 200): Promise<string> {
  try {
    return await tmux(socket, ['capture-pane', '-p', '-t', MAIN, '-S', `-${lines}`]);
  } catch {
    return '';
  }
}

/**
 * The pane's foreground process id + command name, plus whether the pane is DEAD.
 *
 * SPEC-SUBMIT §1.1/⟦DEC-3⟧ — `dead` is the only instrument that detects a crashed CLI. Verified on
 * the installed tmux 3.2a: under `remain-on-exit on` a pane
 * whose command exited reports `pane_dead` = 1 while BOTH `send-keys -l` and `send-keys C-m` still
 * exit 0 into the corpse — so a send's exit status proves nothing — and `pane_current_command` still
 * reports the stale dead command name, so a command-name check cannot even see the death.
 * `null` (a failed display-message: session gone, or a stalled socket) keeps its old meaning; the
 * existing pid-only callers are unaffected by the added field.
 */
export async function paneInfo(socket: string): Promise<{ pid: number; command: string; dead: boolean } | null> {
  try {
    // Delimited, not positional. A positional parse shifts silently if `#{pane_dead}` ever expands
    // empty (an unsupported format on some tmux build): `pid` would become NaN, paneInfo would return
    // null FOREVER, and paneHasActiveChildren / paneDescendantCount / the poller's pane-tree walk
    // would all quietly read "no work" — work detection dying without a sound. With a delimiter the
    // pid keeps its own field, so a missing dead-flag degrades to `dead: false` (the guard goes inert,
    // i.e. exactly the pre-guard behaviour) instead of taking work detection down with it.
    const out = await tmux(socket, ['display-message', '-p', '-t', MAIN, '#{pane_dead}|#{pane_pid}|#{pane_current_command}']);
    const [deadStr, pidStr, ...cmd] = out.trim().split('|');
    const pid = Number(pidStr);
    return Number.isFinite(pid) && pid > 0 ? { pid, command: cmd.join('|').trim(), dead: deadStr?.trim() === '1' } : null;
  } catch {
    return null;
  }
}

/**
 * True iff a `#{pane_dead}` listing shows ≥1 pane and EVERY pane is dead. Pure, so the guard is
 * exhaustively unit-testable. The `panes.length > 0` guard is NOT a mere zero-pane nicety: empty
 * output must read NOT-dead, or a bare `every([])` (vacuously true) would vanish a terminal down the
 * DESTRUCTIVE path on an empty read (a tmux build without the `pane_dead` format expands each line
 * empty). A stalled probe does NOT reach here — the tmux() SIGKILL timeout makes it reject with
 * `killed`, which isPaneDead re-throws — but empty-is-not-dead is kept as belt-and-suspenders.
 */
export function allPanesDead(listOutput: string): boolean {
  const panes = listOutput.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return panes.length > 0 && panes.every((p) => p === '1');
}

/**
 * True when EVERY pane in the `main` session has EXITED under `remain-on-exit on` (all `pane_dead`=1)
 * while the session itself is still alive — the corpse `hasSession` cannot see: the session object
 * survives its panes' death, so a crashed CLI would read "alive" forever. Reconciler-only probe.
 *
 * Reads EVERY pane (`list-panes -s`), NOT the session's active pane: a terminal window can hold a
 * split (an operator poking around through the pty, or an agent running a finite `tmux` command), and
 * `display-message -t main` resolves to the window's ACTIVE pane — so a dead FOCUSED split beside a
 * live CLI pane would read dead and vanish a live terminal. Dead only when no pane holds a live
 * process; a single live pane in ANY window (`-s`) keeps the terminal alive.
 *
 * Every failure answer lands on the NON-destructive side. A timeout rejects with `killed` (the
 * tmux() wrapper uses SIGKILL so a stalled client can't trap it and exit 0) and is re-thrown, so the
 * caller skips the sweep and retries. A no-session/other error → false; the missing-session path owns
 * that case on a later sweep. A stalled or unsupported probe never drives the destructive vanish.
 */
export async function isPaneDead(socket: string): Promise<boolean> {
  try {
    return allPanesDead(await tmux(socket, ['list-panes', '-s', '-t', MAIN, '-F', '#{pane_dead}']));
  } catch (e) {
    if ((e as { killed?: boolean }).killed) throw e;
    return false;
  }
}

/**
 * Process-signal state detection (herdr-style): true when the pane's process has an
 * active child, i.e. the agent has spawned a tool/command and is definitely working.
 * A cheap, alt-screen-proof complement to output parsing. Defensive: false if pgrep
 * is unavailable.
 */
export async function paneHasActiveChildren(socket: string): Promise<boolean> {
  const info = await paneInfo(socket);
  if (!info) return false;
  try {
    const { stdout } = await pexec('pgrep', ['-P', String(info.pid)], { timeout: 1000 });
    return stdout.trim().length > 0;
  } catch {
    return false; // no children, or pgrep missing
  }
}

/**
 * Total live descendants of the pane process (bounded walk). Some CLIs keep a PERMANENT
 * child even when idle — codex ≥0.14x's npm wrapper holds the vendored binary as a child
 * (0.118 exec'd it) — so "has a child" stopped meaning "is working" for them. Callers pass
 * the adapter's persistentIdleChildren and treat only a count BEYOND it as active work
 * (a real tool is a child of the binary, i.e. descendant #2). Defensive: 0 on pgrep issues.
 */
export async function paneDescendantCount(socket: string): Promise<number> {
  const info = await paneInfo(socket);
  if (!info) return 0;
  let frontier = [String(info.pid)];
  let total = 0;
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const pid of frontier) {
      try {
        const { stdout } = await pexec('pgrep', ['-P', pid], { timeout: 1000 });
        const kids = stdout.trim().split('\n').filter(Boolean);
        total += kids.length;
        next.push(...kids);
      } catch {
        /* leaf or pgrep miss — continue with the rest */
      }
    }
    frontier = next;
  }
  return total;
}

/**
 * "Is the agent actually doing work?" — the descendant-aware successor to
 * paneHasActiveChildren. `persistentIdleChildren` (from the adapter) is how many
 * descendants the CLI keeps ALIVE while idle; work = anything beyond that. Providers
 * without the field keep the legacy direct-children semantics untouched.
 */
export async function paneHasActiveWork(socket: string, persistentIdleChildren?: number): Promise<boolean> {
  if (persistentIdleChildren === undefined) return paneHasActiveChildren(socket);
  return (await paneDescendantCount(socket)) > persistentIdleChildren;
}

/** Resize the tmux window to match the driving client. */
export async function resize(socket: string, cols: number, rows: number): Promise<void> {
  await tmux(socket, [
    'resize-window',
    '-t',
    MAIN,
    '-x',
    String(cols),
    '-y',
    String(rows),
  ]).catch(() => {});
}

/**
 * Send literal text then a separate Enter, per the reliable injection idiom
 * (SPEC §5). Caller is responsible for state-gating (never call while a
 * permission dialog is unresolved).
 */
export async function sendText(socket: string, text: string): Promise<void> {
  await tmux(socket, ['send-keys', '-t', MAIN, '-l', text]);
  await new Promise((r) => setTimeout(r, 40));
  await tmux(socket, ['send-keys', '-t', MAIN, 'C-m']);
}

/**
 * SPEC-SUBMIT §1.2 — VISIBLE-screen plain snapshot (no scrollback), ⟦DEC-7⟧. Every composer reading
 * uses this: scrollback holds stale rendered composer frames AND the echo of previously submitted
 * prompts, either of which would make a whole-pane read lie. Verified on tmux 3.2a that omitting
 * `-S` returns exactly the visible rows (pins F1).
 */
export async function captureVisible(socket: string): Promise<string> {
  try {
    return await tmux(socket, ['capture-pane', '-p', '-t', MAIN]);
  } catch {
    return '';
  }
}

/** The outcome of a send: 'verified' means positive evidence of submission, never an assumption. */
export type SendOutcome = 'verified' | 'unverified';

/** A send that positively FAILED. `kind` is the diagnosis the caller surfaces — a generic message
 *  would misdiagnose (a refused human draft is nothing like an unreachable pane). */
export class SendVerifyError extends Error {
  constructor(
    message: string,
    public readonly kind: 'dead-pane' | 'foreign-text' | 'no-appear' | 'no-submit' | 'dialog-open',
  ) {
    super(message);
    this.name = 'SendVerifyError';
  }
}

export interface VerifiedSendOpts {
  /** Adapter classifier (resolved via forTerminal, the frozen def snapshot). Absent ⇒ the
   *  whole verification stack degrades to today's blind send (⟦DEC-4⟧). */
  composerPending?: (visiblePlainSnapshot: string) => boolean | undefined;
  /** The composer's TEXT BODY, when the adapter can identify the region. Scopes the our-text match
   *  so a previously submitted prompt echoed on screen can never stand in for text sitting in the
   *  composer. Absent / undefined ⇒ the match falls back to the whole snapshot, and only a CHANGE
   *  across the send counts as evidence. */
  composerText?: (visiblePlainSnapshot: string) => string | undefined;
  /** Caller closure over store state — true when the terminal's FSM state is 'working'. Used ONLY to
   *  break a tie on an inconclusive composer reading (⟦DEC-2⟧), and ONLY passed by callers whose
   *  provider actually emits a submit signal: the poller promotes 'working' from ANY screen change
   *  for most providers, including the render of the text we just typed, so for them a 'working'
   *  state is not evidence of a submit at all. */
  wentWorking?: () => boolean;
  /** True when the snapshot shows a permission dialog. A bare Enter into one CONFIRMS the highlighted
   *  option, so the retry loop must stop rather than answer a dialog on the operator's behalf. */
  permissionPending?: (visiblePlainSnapshot: string) => boolean;
}

/**
 * SPEC-SUBMIT §1.3 — normalize a snapshot (or our own text) before looking for our text in it.
 *
 * Load-bearing, not cosmetic: the rendered composer inserts frame characters and WRAPS at the pane
 * width (panes are 80 cols), while loop prompts are long — so a raw 60-character tail straddles a
 * wrap boundary with high probability and the marker never matches. A failed match on our OWN
 * leftover text is the worst case: it takes the foreign-text branch and refuses, every tick, until
 * the ceiling gates the loop telling the operator a human left a draft in a pane nobody touched.
 *
 * Whitespace is DELETED, not collapsed. Collapsing is wrap-invariant only when the wrap lands on a
 * space; an 80-column pane hard-breaks a long token and INSERTS a newline mid-token, and loop
 * feedback routinely ends in absolute paths and stack frames (`…/src/widget.spec.ts:41`) that wrap
 * exactly there. Deleting whitespace makes both wrap kinds invariant.
 */
function normalizeForMatch(s: string): string {
  return s
    .replace(/[\u2500-\u257F]/g, '') // the Box Drawing block — the composer frame and its rules
    .replace(/[\s\u00A0]+/g, ''); // DELETE, never collapse: a mid-token wrap inserts whitespace
}

/** The tail of our own text, used as the "this is ours" marker. Normalized like the snapshot. */
export function ourTextTail(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1] ?? '';
  return normalizeForMatch(last.slice(-TAIL_MARKER_LEN));
}

/**
 * SPEC-SUBMIT §1.3 — does this snapshot hold OUR text, in the place it would have to be?
 *
 * `composerText` scopes the search to the composer REGION. That scoping is the whole point: the
 * visible screen also carries the ECHO of previously submitted prompts, so a whole-screen presence
 * test answers "has this text ever been sent", not "is this text sitting un-submitted right now" —
 * and a loop that re-sends a byte-identical prompt (or any prompt with a short, generic tail) would
 * match its own echo and read a send that went nowhere as delivered.
 *
 * When the adapter cannot identify the region (no `composerText`, or an unrecognized frame), the
 * search falls back to the whole snapshot — but the caller must then treat only a CHANGE as
 * evidence, which is what `sawOurText`'s pre-send baseline below enforces.
 */
export function snapshotHoldsOurText(
  snapshot: string,
  tail: string,
  composerText?: (snapshot: string) => string | undefined,
): boolean {
  if (tail.length === 0) return false;
  const region = composerText?.(snapshot);
  return normalizeForMatch(region ?? snapshot).includes(tail);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * SPEC-SUBMIT §1 — send text and CONFIRM it was submitted, or fail loudly. The one place the
 * never-silent-pass rule was previously unenforced: the legacy `sendText` types, sleeps 40 ms, sends
 * Enter, and confirms nothing, so a swallowed keystroke reads exactly like a delivered prompt.
 *
 * Returns 'verified' only on POSITIVE evidence (⟦DEC-2⟧: the composer is affirmatively empty after
 * our text was seen to arrive, or an inconclusive composer plus a hook-driven went-working). Returns
 * 'unverified' when the evidence is merely absent — today's behaviour, but flagged so the caller can
 * audit it. THROWS `SendVerifyError` only on positive failure. Never retypes (⟦DEC-5⟧): within a call
 * only Enter is re-sent, and across calls a composer holding our own text takes the Enter-only path
 * while a composer holding a human's draft is refused outright.
 */
export async function sendTextVerified(socket: string, text: string, opts: VerifiedSendOpts = {}): Promise<SendOutcome> {
  // ⟦SB-1⟧ DEAD-PANE GUARD. A crashed CLI leaves a corpse that accepts keys and answers 0, so without
  // this the Tower types into it for the full turn ceiling before anything notices.
  const info = await paneInfo(socket);
  if (info?.dead) {
    throw new SendVerifyError('pane is dead — the CLI process has exited', 'dead-pane');
  }
  // info === null (no session / stalled socket): fall through — send-keys below fails loudly on a
  // missing session, and a stalled socket rejects on TMUX_CMD_TIMEOUT_MS into the same handler.

  // ⟦DEC-4⟧ DEGRADED SHORT-CIRCUIT: no classifier (every custom def, and shell) ⇒ exactly today's
  // body, plus an honest label. The caller audits it; tmux.ts stays store-free and audit-free.
  const classify = opts.composerPending;
  if (!classify) {
    await sendText(socket, text);
    return 'unverified';
  }

  // ONE budget for the whole call. Without it the ceiling is the PRODUCT of four independent ones:
  // loops.tick is single-flight and awaits each drive sequentially, so against a stalled socket
  // (every tmux exec burning TMUX_CMD_TIMEOUT_MS) one bad injection would hold the tick for minutes
  // and freeze every other loop — the exact failure that timeout's own comment forbids.
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  const outOfBudget = (): boolean => Date.now() >= deadline;

  const tail = ourTextTail(text);
  const sawOurText = (snap: string): boolean => snapshotHoldsOurText(snap, tail, opts.composerText);

  // ⟦SB-2⟧ PRE-CHECK. A composer that already holds text is the cross-call retry case (our own
  // leftover after a swallowed Enter) or a human's draft — and those must be treated oppositely.
  let appeared = false;
  let typed = false;
  let lastSnap = '';
  const preSnap = await captureVisible(socket);
  lastSnap = preSnap;
  // A permission dialog on screen means the FSM state we were gated on is stale (a lost or late
  // hook — the same condition the nudge veto exists for). Typing into the dialog and then pressing
  // Enter would CONFIRM the highlighted option: the Tower would be answering a permission request
  // on the operator's behalf, which no path here may ever do. Throwing (rather than returning
  // 'unverified') is what makes the caller retry next tick and then gate honestly — nothing was
  // typed, so reporting a degraded SEND would be a lie about work that never happened.
  if (opts.permissionPending?.(preSnap)) {
    throw new SendVerifyError('a permission dialog is open — refusing to type into it', 'dialog-open');
  }
  const pre = classify(preSnap);
  // BASELINE, load-bearing when the region is unscoped: our text may ALREADY be on screen as the echo
  // of a previous submit (a re-sent identical prompt, or a short generic tail). Only a CHANGE across
  // the send is evidence that this send arrived.
  const preSaw = sawOurText(preSnap);
  if (pre === true) {
    // `preSaw` is computed from the SAME snapshot as `pre` — a second capture here would open a
    // window where a hiccup (captureVisible returns '' on error) reads as "not ours" and refuses a
    // pane holding our own leftover text as if a human had drafted in it.
    if (!preSaw) {
      throw new SendVerifyError(
        'the composer holds text that is not ours — refusing to type over it',
        'foreign-text',
      );
    }
    // Our own text is already in the composer: Enter-only, never retype (⟦DEC-5⟧). Appearance is
    // therefore already established for the ⟦SB-4⟧ evidence rule.
    appeared = true;
  } else {
    // `false` (empty) or `undefined` (inconclusive) both proceed: an inconclusive screen gets today's
    // behaviour, and the appear/submit checks below still govern the outcome.
    // ⟦SB-3⟧ TYPE ONCE, then look for our text arriving.
    await tmux(socket, ['send-keys', '-t', MAIN, '-l', text]);
    typed = true;
    let lastConclusive: boolean | undefined;
    for (let i = 0; i < APPEAR_POLLS && !appeared && !outOfBudget(); i++) {
      await sleep(APPEAR_INTERVAL_MS);
      const snap = await captureVisible(socket);
      lastSnap = snap;
      const p = classify(snap);
      if (p !== undefined) lastConclusive = p;
      // `!preSaw &&` is what makes this a DELTA rather than a presence test.
      if (p === true || (!preSaw && sawOurText(snap))) appeared = true;
    }
    if (!appeared && lastConclusive === false && !outOfBudget()) {
      // CONFIRM before declaring the send lost. An empty composer this soon after typing is also
      // what a slow render looks like, and the two are indistinguishable inside the appear window —
      // only elapsed time separates them. Throwing on a slow render is not harmless: the retry
      // re-enters the pre-check, and for a provider whose classifier can never answer `true`
      // (codex, by design) a composer that has since rendered our text reads `undefined`, so the
      // retry TYPES AGAIN and the doubled prompt is submitted as one. One extra read at a longer
      // delay costs nothing on the happy path (this branch is only reached when the send already
      // looks lost) and moves the decision out to ~1.75 s.
      await sleep(APPEAR_CONFIRM_MS);
      const snap = await captureVisible(socket);
      if (classify(snap) === true || (!preSaw && sawOurText(snap))) appeared = true;
      else if (classify(snap) === false) {
        // Still affirmatively EMPTY well after the send: the keystrokes went nowhere. Throwing leaves
        // that verified emptiness behind, so the next-tick retry types into a known-empty composer —
        // the only cross-call retype, and it is retype-into-empty (⟦DEC-5⟧).
        throw new SendVerifyError('the text never appeared in the composer', 'no-appear');
      }
      // The confirmation read went inconclusive: appearance is unknown, so let the submit phase
      // decide rather than throwing on a screen we can no longer read.
    }
    // All-undefined readings: appearance is unknown; the submit phase decides.
  }

  // ⟦SB-4⟧ SUBMIT. A dialog may have OPENED while we typed (our text reached the agent, or a stale
  // one finally rendered) — check the snapshot already in hand before the first Enter, because that
  // Enter is the one that would confirm it. Nothing has been submitted yet, so this throws too.
  if (opts.permissionPending?.(lastSnap)) {
    throw new SendVerifyError('a permission dialog is open — refusing to press Enter into it', 'dialog-open');
  }
  let lastConclusive: boolean | undefined;
  for (let attempt = 0; attempt <= ENTER_RETRIES; attempt++) {
    if (attempt > 0 && outOfBudget()) break;
    await tmux(socket, ['send-keys', '-t', MAIN, 'C-m']);
    lastConclusive = undefined;
    for (let i = 0; i < SUBMIT_POLLS; i++) {
      await sleep(SUBMIT_INTERVAL_MS);
      const snap = await captureVisible(socket);
      lastSnap = snap;
      // A permission dialog may have opened (our prompt reached the agent and it asked for
      // approval, or a stale dialog was already up). Another bare Enter would CONFIRM the
      // highlighted option — answering a permission request on the operator's behalf, which no
      // Tower path is ever allowed to do. Stop sending keys and report honestly.
      if (opts.permissionPending?.(snap)) return 'unverified';
      const c = classify(snap);
      if (c === false) {
        // An empty composer only proves a SUBMIT if the text was ever seen to arrive. Without that,
        // "empty" is equally consistent with the typing itself having been swallowed — and returning
        // 'verified' there would re-open the silent trace this wave exists to close: the prompt was
        // never delivered, the turn reads as a fast no-op, and an auto-advancing mission sails past.
        if (appeared || opts.wentWorking?.()) return 'verified';
        return 'unverified';
      }
      if (c === true) lastConclusive = true;
      if (outOfBudget()) break;
    }
    // ⟦DEC-2⟧ tie-break: an inconclusive composer plus a submit-signalled went-working is positive
    // evidence of a started turn. Checked after the window so a slow hook still counts.
    if (lastConclusive === undefined && opts.wentWorking?.()) return 'verified';
    if (lastConclusive !== true) break; // nothing conclusive to retry against
  }
  // ⟦SB-5⟧
  if (lastConclusive === true) {
    throw new SendVerifyError(
      typed
        ? 'the prompt was typed but never submitted — the composer still holds it'
        : 'the composer still holds the prompt — Enter did not submit it',
      'no-submit',
    );
  }
  return 'unverified'; // ⟦DEC-4⟧ evidence absent, not contradicted — the caller audits
}

/** Send a raw key chord (e.g. 'C-c', 'Enter', 'y'). */
export async function sendKeys(socket: string, keys: string[]): Promise<void> {
  await tmux(socket, ['send-keys', '-t', MAIN, ...keys]);
}

/**
 * SPEC-RESTART §1 — relaunch the pane's RECORDED command in the SAME pane (`respawn-pane -k`):
 * same tmux server, same session, same pane — only the process is new. Verified on the installed
 * tmux 3.2a: `-k` kills a still-RUNNING process (the wedged-
 * CLI case) as well as reviving a DEAD pane (`pane_dead` 1 → 0, pinned at paneInfo above) with a
 * fresh pid; the relaunched command is the argv newSession recorded — OR, when `opts.argv` is
 * given, THAT argv, which tmux then records as "the command used when the pane was created or
 * last respawned" (so a LATER bare respawnPane on the same pane replays THIS argv, not the
 * original creation one — see the rotation-hazard test); it inherits the session's `-e`
 * environment, so the hook-token/broker wiring survives; `remain-on-exit on` persists (the next
 * death is still inspectable); and an installed pipe-pane keeps logging the fresh process into the
 * same file. Never-throws / bounded like the other wrappers (the tmux() SIGKILL timeout applies) —
 * it reports success as a boolean instead, so the caller can refuse loudly rather than stamp a
 * restart that never happened (a no-session or stalled-socket failure lands on `false`).
 *
 * `opts` omitted ⇒ byte-identical to the historical bare call (backward compat: every existing
 * caller that has not opted into an argv rewrite keeps today's exact behavior). `opts.cwd` sets the
 * respawned pane's working directory (`-c`); `opts.argv` is exec'd directly (no shell), matching
 * newSession's own argv-array convention.
 */
export async function respawnPane(socket: string, opts?: { argv: string[]; cwd?: string }): Promise<boolean> {
  try {
    await tmux(socket, [
      'respawn-pane',
      '-k',
      ...(opts?.cwd ? ['-c', opts.cwd] : []),
      '-t',
      MAIN,
      ...(opts?.argv ?? []),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * SPEC-RUNWAY — set a session env var so the NEXT process born in the pane (via respawn-pane -k)
 * inherits it. Verified live on tmux 3.2a: after `set-environment` the respawned process sees the new
 * value while the other session-env vars are preserved. This is the lever a subscription rotation uses
 * to re-point CLAUDE_CONFIG_DIR at another account's dir before respawning — no new session, socket,
 * hook token or broker registration needed. Throws (like the other mutating helpers) so the caller can
 * roll back; a rotate awaits it before the respawn.
 */
export async function setSessionEnv(socket: string, name: string, value: string): Promise<void> {
  await tmux(socket, ['set-environment', '-t', MAIN, name, value]);
}

/** Kill this terminal's whole tmux server (one session per server here). */
export async function killServer(socket: string): Promise<void> {
  await tmux(socket, ['kill-server']).catch(() => {});
}

/** Enumerate live Tower sockets by inspecting the tmux socket directory. */
export async function listTowerSockets(): Promise<string[]> {
  try {
    const entries = await readdir(socketDir());
    return entries.filter((n) => n.startsWith(SOCKET_PREFIX));
  } catch {
    return [];
  }
}
