// Runtime validation for terminal traffic. TypeScript types do not validate JSON received from a
// socket; malformed frames must never escape an async EventEmitter listener and stop the daemon.
import type { WebSocket } from 'ws';
import type { ClientFrame, ServerFrame } from '../shared/types.js';

export const MAX_TERMINAL_FRAME_BYTES = 1024 * 1024;
const MAX_DIMENSION = 1000;

export function parseClientFrame(text: string): ClientFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  const dimension = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= MAX_DIMENSION;
  if (frame.t === 'data') {
    return typeof frame.d === 'string' ? { t: 'data', d: frame.d } : undefined;
  }
  if (!dimension(frame.cols) || !dimension(frame.rows)) return undefined;
  if (frame.t === 'resize') return { t: 'resize', cols: frame.cols, rows: frame.rows };
  if (frame.t === 'attach' &&
      typeof frame.token === 'string' && frame.token.length > 0 && frame.token.length <= 512 &&
      typeof frame.terminalId === 'string' && frame.terminalId.length > 0 && frame.terminalId.length <= 128) {
    return { t: 'attach', token: frame.token, terminalId: frame.terminalId, cols: frame.cols, rows: frame.rows };
  }
  return undefined;
}

interface TerminalBridge {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

export interface TerminalSocketDeps {
  verifyToken(token: string): boolean;
  hasTerminal(id: string): boolean;
  noteViewerResize(id: string): void;
  attach(
    id: string,
    sink: { write(data: string): void; close(code: number | null): void },
    size: { cols: number; rows: number },
    onReflow: () => void,
  ): Promise<TerminalBridge>;
}

export function attachTerminalSocket(ws: WebSocket, deps: TerminalSocketDeps): void {
  let bridge: TerminalBridge | null = null;
  let attachedId: string | null = null;
  let attaching = false;
  let closed = false;
  const detach = (): void => {
    closed = true;
    const current = bridge;
    bridge = null;
    try { current?.detach(); } catch { /* cleanup must not crash the daemon */ }
  };
  const send = (frame: ServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const fail = (message: string, code: number): void => {
    try { send({ t: 'error', message }); } catch { /* the socket may have failed */ }
    try { ws.close(code); } catch { ws.terminate(); }
  };

  const handle = async (text: string, isBinary: boolean): Promise<void> => {
    const frame = isBinary ? undefined : parseClientFrame(text);
    if (!frame) return fail('bad frame', 1008);
    if (frame.t === 'attach') {
      if (!deps.verifyToken(frame.token)) return fail('unauthorized', 1008);
      if (bridge || attaching || closed) return;
      attaching = true;
      const cols = Math.max(80, frame.cols);
      const rows = Math.max(24, frame.rows);
      // Reflow notes bracket the tmux resize so the poller never submits against stale geometry.
      if (deps.hasTerminal(frame.terminalId)) deps.noteViewerResize(frame.terminalId);
      const attached = await deps.attach(
        frame.terminalId,
        { write: (d) => send({ t: 'data', d }), close: (code) => send({ t: 'exit', code }) },
        { cols, rows },
        () => deps.noteViewerResize(frame.terminalId),
      );
      if (closed || ws.readyState !== ws.OPEN) {
        attached.detach();
        return;
      }
      bridge = attached;
      attachedId = frame.terminalId;
      send({ t: 'attached', terminalId: frame.terminalId, cols, rows });
    } else if (frame.t === 'data') {
      bridge?.write(frame.d);
    } else if (bridge && attachedId) {
      deps.noteViewerResize(attachedId);
      bridge.resize(Math.max(80, frame.cols), Math.max(24, frame.rows));
    }
  };

  ws.on('message', (raw, isBinary) => {
    // EventEmitter does not await async listeners. Explicitly consume every rejection, including
    // exceptions from terminal writes/resizes, so one connection cannot stop all running terminals.
    void handle(raw.toString(), isBinary).catch(() => fail('terminal operation failed', 1011));
  });
  ws.on('close', detach);
  ws.on('error', detach);
}
