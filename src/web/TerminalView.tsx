// xterm.js terminal bound to an authenticated Tower WebSocket. On mount it opens
// /ws, sends the `attach` frame (terminalId + session token, since browsers can't
// set WS headers), and bridges bytes both ways.
//
// The terminal FITS its container (FitAddon) and drives the tmux window to that size,
// so a large pane shows the full-width TUI instead of an 80x24 box in its top-left.
// Two invariants keep the fit safe — remove either and the terminal misbehaves:
//
//   1. FLOOR of 80x24. The fitted size is clamped UP to at least 80x24 before it is
//      sent. The backend's scrape-based turn detection and submit verification were
//      pinned at 80x24; 80 cols is a SAFE FLOOR, not
//      an exact size — narrower raises mid-token wrap risk in the adapter regexes, wider
//      only reduces it. A pane smaller than the floor scrolls inside .term-host
//      (overflow:auto). The server re-clamps at the trust boundary, so the floor never
//      rests on this client alone.
//
//   2. RESIZE QUIET-WINDOW. A resize changes the tmux pane snapshot, and the poller
//      reads a changed snapshot as output → 'working' for every adapter that does not set
//      screenChangeImpliesWork:false (all but codex). Left unguarded, a mere viewer
//      resize would pin an idle agent 'working' and wedge busy-aware loop starts — the
//      regression that once made this view hardcode 80x24. The server now brackets every
//      attach/resize reflow with poller.noteViewerResize(), opening a quiet-window that
//      swallows the reflow's snapshot churn and only resumes change-detection off a fresh
//      post-resize baseline. The fit and that guard MUST ship together; the fit alone
//      reopens the false-'working' regression.
//
// Known tradeoffs (documented, not bugs): a resize landing in the same poll slot as a
// real turn-end can delay idle detection by up to the quiet window; a resize mid-send is
// at worst one inconclusive poll ('unverified', the safe direction), belted by the loop
// runner's await-start re-Enter. Both match the cost of the poller's existing rebaseline
// guard.
//
// Resize is debounced to bound redraw + reflow churn.

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { currentToken, tower } from './api.js';
import type { ClientFrame, ServerFrame } from '../shared/types.js';

// The backend spawns and scrapes every agent PTY at ≥80x24 (terminal-manager.ts newSession);
// the fitted client size is clamped UP to this floor before it is advertised.
const MIN_COLS = 80;
const MIN_ROWS = 24;

export function TerminalView({ terminalId }: { terminalId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
      fontSize: 13,
      allowProposedApi: true,
      // We paste on right-click; disable xterm's macOS right-click word-select so it can't arm
      // copy-on-select and overwrite the clipboard we just pasted from.
      rightClickSelectsWord: false,
      theme: {
        background: '#070a10',
        foreground: '#eaf0f7',
        cursor: '#53dfc2',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* WebGL unavailable — canvas fallback is fine */
    }

    // Fit to the container, then clamp UP to the ≥80x24 floor (the backend scrape/submit
    // invariant). Returns the size to advertise, or null when the pane is hidden/zero-size —
    // fit() throws or produces a nonsense measurement there, and Math.max(80, NaN) is NaN, so
    // a bad reading must be dropped, never sent.
    const fitAndClamp = (): { cols: number; rows: number } | null => {
      try {
        fit.fit();
      } catch {
        return null; // hidden/detached pane — xterm throws measuring a zero-size host
      }
      if (!(term.cols > 0) || !(term.rows > 0)) return null;
      const cols = Math.max(MIN_COLS, term.cols);
      const rows = Math.max(MIN_ROWS, term.rows);
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
      return { cols, rows };
    };
    fitAndClamp();

    let ws: WebSocket | null = null;
    let closedByUs = false;

    const send = (f: ClientFrame) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
    };

    const connect = async () => {
      // Ensure we hold the session token before opening the socket.
      await tower.bootstrapToken();
      const token = currentToken();
      if (!token) {
        term.writeln('\r\n\x1b[31m[control tower] no session token\x1b[0m');
        return;
      }
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);

      ws.onopen = () => {
        // Attach at the fitted, floor-clamped geometry. Math.max guards a hidden-at-mount
        // pane (term.cols is xterm's 80 default there) so we never advertise 0/NaN.
        send({ t: 'attach', terminalId, token, cols: Math.max(MIN_COLS, term.cols), rows: Math.max(MIN_ROWS, term.rows) });
      };
      ws.onmessage = (ev) => {
        const frame = JSON.parse(ev.data as string) as ServerFrame;
        if (frame.t === 'data') term.write(frame.d);
        else if (frame.t === 'exit') term.writeln(`\r\n\x1b[33m[session exited: ${frame.code}]\x1b[0m`);
        else if (frame.t === 'error') term.writeln(`\r\n\x1b[31m[error: ${frame.message}]\x1b[0m`);
      };
      ws.onclose = () => {
        if (!closedByUs) term.writeln('\r\n\x1b[90m[disconnected — server unreachable; the agent is still running]\x1b[0m');
      };
    };
    void connect();

    const onData = term.onData((d) => send({ t: 'data', d }));

    // ---- clipboard (copy + paste) --------------------------------------------------------------
    // xterm has no working clipboard path in this embedding (the browser's native paste event is
    // unreliable here, and a selection never reaches the OS clipboard), so wire both explicitly against
    // navigator.clipboard. 127.0.0.1 is a secure context so the API is present; over LAN http it is
    // undefined — every call is optional-chained and every reject is swallowed, so a missing or
    // denied clipboard degrades to a silent no-op, never a throw into an xterm event handler.
    // Nothing here touches fit()/resize(), so the 80x24 floor and resize quiet-window are untouched.
    let clipDisposed = false;

    // Read the OS clipboard and feed it through the SAME data pipeline as typing (term.paste →
    // onData → ws), honoring bracketed-paste. The clipDisposed guard matters: term.paste reads
    // term.textarea, so a promise resolving after unmount must not touch a disposed Terminal.
    const doPaste = (): void => {
      // typeof guard (not truthiness): navigator.clipboard is typed non-optional but is undefined on
      // insecure (LAN http) origins, so the runtime check is real even though TS thinks it can't be.
      if (typeof navigator.clipboard?.readText !== 'function') return;
      navigator.clipboard.readText()
        .then((text) => { if (!clipDisposed && text) term.paste(text); })
        .catch(() => { /* denied / no gesture / no API — silent no-op */ });
    };

    // Copy the live selection; re-reads selection state at call time so a cleared selection never
    // clobbers the clipboard with '', and no-ops when the write API is absent (LAN http).
    const copySelection = (): void => {
      if (!term.hasSelection()) return;
      const sel = term.getSelection();
      if (sel) navigator.clipboard?.writeText?.(sel).catch(() => { /* no API / denied — no-op */ });
    };

    // Runs BEFORE xterm's own key processing (return true → xterm handles it, false → xterm skips).
    // Fires on keydown/keypress/keyup; only keydown does work. It does NOT preventDefault itself, so
    // a consumed combo calls preventDefault() — which also kills any latent browser-native paste, so
    // there is no double paste. Plain Ctrl+C matches neither predicate → returns true → xterm emits
    // \x03 (SIGINT), unchanged. !altKey excludes AltGr (ctrl+alt) glyph combos on both sides.
    term.attachCustomKeyEventHandler((e) => {
      const key = (e.key || '').toLowerCase();
      const isV = key === 'v' || e.code === 'KeyV';
      const isC = key === 'c' || e.code === 'KeyC';
      // Paste: Ctrl+V / Ctrl+Shift+V / Cmd+V. Only hijack when a clipboard read is actually
      // available; otherwise fall through so xterm's own native paste path can still try (e.g. Mac
      // Cmd+V via the browser paste event when the API is absent).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && isV && typeof navigator.clipboard?.readText === 'function') {
        if (e.type === 'keydown') { e.preventDefault(); doPaste(); }
        return false;
      }
      // Copy: Ctrl+Shift+C or Cmd+C, ONLY with a live selection AND a working write API — so plain
      // Ctrl+C stays SIGINT, an empty chord falls through to native (browser menu / devtools inspect),
      // and on an insecure origin (no clipboard API) the chord also falls through instead of being
      // swallowed into a no-op — symmetric with the paste fall-through.
      if (((e.ctrlKey && e.shiftKey && !e.altKey) || (e.metaKey && !e.ctrlKey && !e.altKey)) && isC && term.hasSelection() && typeof navigator.clipboard?.writeText === 'function') {
        if (e.type === 'keydown') { e.preventDefault(); copySelection(); }
        return false;
      }
      return true;
    });

    // Copy-on-select — the primary copy path (matches PuTTY/gnome-terminal muscle memory and works
    // where native copy events are dead). Debounced like the resize path so a drag doesn't churn the
    // clipboard; copySelection re-reads selection at fire time, guarding the empty-selection clobber.
    let selTimer: number | undefined;
    const onSel = term.onSelectionChange(() => {
      window.clearTimeout(selTimer);
      selTimer = window.setTimeout(() => {
        if (clipDisposed) return;
        copySelection();
      }, 150);
    });

    // Right-click pastes (Windows-Terminal / PuTTY model); Shift+right-click keeps the native browser
    // menu as the escape hatch. host is a stable ref node across effect re-runs, so the listener MUST
    // be removed in cleanup or a terminalId change stacks handlers → multi-paste.
    const onContextMenu = (e: MouseEvent): void => {
      // Shift+right-click always keeps the native browser menu (escape hatch). Also fall through to the
      // native menu when there's no clipboard read API (insecure / LAN-http origin): preventDefault-then-
      // no-op would otherwise leave right-click dead AND remove the native menu's working Paste —
      // symmetric with the keyboard paste fall-through.
      if (e.shiftKey || typeof navigator.clipboard?.readText !== 'function') return;
      e.preventDefault();
      term.focus(); // right-click can arrive unfocused; paste is programmatic but keep typing landing here
      doPaste();
    };
    host.addEventListener('contextmenu', onContextMenu);

    let resizeTimer: number | undefined;
    const doFit = () => {
      window.clearTimeout(resizeTimer);
      // Debounced longer than the old 80ms to bound redraw + tmux-reflow churn per resize.
      resizeTimer = window.setTimeout(() => {
        const size = fitAndClamp();
        if (size) send({ t: 'resize', cols: size.cols, rows: size.rows });
      }, 180);
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(host);

    return () => {
      clipDisposed = true; // FIRST — kills the effect of any in-flight clipboard promise / debounce
      closedByUs = true;
      onData.dispose();
      onSel.dispose();
      host.removeEventListener('contextmenu', onContextMenu);
      window.clearTimeout(selTimer);
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      ws?.close();
      term.dispose(); // also tears down the attachCustomKeyEventHandler (no separate disposer exists)
    };
  }, [terminalId]);

  return <div className="term-host" ref={hostRef} />;
}
