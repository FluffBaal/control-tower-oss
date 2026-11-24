import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { attachTerminalSocket, MAX_TERMINAL_FRAME_BYTES, parseClientFrame, type TerminalSocketDeps } from './ws-protocol.js';

const attach = { t: 'attach', token: 'test-token', terminalId: 'test-terminal', cols: 100, rows: 30 };

async function server(t: TestContext, overrides: Partial<TerminalSocketDeps> = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX_TERMINAL_FRAME_BYTES });
  const deps: TerminalSocketDeps = {
    verifyToken: (token) => token === attach.token,
    hasTerminal: () => true,
    noteViewerResize: () => {},
    attach: async () => ({ write() {}, resize() {}, detach() {} }),
    ...overrides,
  };
  wss.on('connection', (socket) => attachTerminalSocket(socket, deps));
  await once(wss, 'listening');
  const address = wss.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  return async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    t.after(() => socket.terminate());
    await once(socket, 'open');
    return socket;
  };
}

async function attachClient(socket: WebSocket, frame = attach) {
  const response = once(socket, 'message');
  socket.send(JSON.stringify(frame));
  const [raw] = await response;
  return JSON.parse(String(raw));
}

test('the frame parser accepts supported messages and rejects unknown message shapes', () => {
  const input = { t: 'data', d: 'hello' };
  const resize = { t: 'resize', cols: 80, rows: 24 };
  for (const frame of [attach, input, resize]) {
    assert.deepEqual(parseClientFrame(JSON.stringify(frame)), frame);
  }
  for (const value of [null, [], 42, { t: 'extension' }]) {
    assert.equal(parseClientFrame(JSON.stringify(value)), undefined);
  }
});

test('invalid JSON, binary frames and an invalid token cannot attach', { timeout: 5000 }, async (t) => {
  let attachments = 0;
  const connect = await server(t, { attach: async () => { attachments++; throw new Error('must not attach'); } });
  for (const payload of ['{', Buffer.from(JSON.stringify(attach)), JSON.stringify({ ...attach, token: 'wrong' })]) {
    const socket = await connect();
    const closed = once(socket, 'close');
    socket.send(payload);
    assert.equal((await closed)[0], 1008);
  }
  assert.equal(attachments, 0);
});

test('oversized frames are rejected at the WebSocket transport before parsing', { timeout: 5000 }, async (t) => {
  const connect = await server(t);
  const socket = await connect();
  const closed = once(socket, 'close');
  socket.send('x'.repeat(MAX_TERMINAL_FRAME_BYTES + 1));
  assert.equal((await closed)[0], 1009);
  assert.equal((await attachClient(await connect())).t, 'attached');
});

test('valid attach, input and resize preserve terminal geometry floors and reflow notifications', { timeout: 5000 }, async (t) => {
  let acceptInput!: (data: string) => void;
  let acceptResize!: (size: number[]) => void;
  const input = new Promise<string>((resolve) => { acceptInput = resolve; });
  const resized = new Promise<number[]>((resolve) => { acceptResize = resolve; });
  const notes: string[] = [];
  const connect = await server(t, {
    noteViewerResize: (id) => { notes.push(id); },
    attach: async (id, _sink, size, onReflow) => {
      assert.equal(id, attach.terminalId);
      assert.deepEqual(size, { cols: 80, rows: 24 });
      onReflow();
      return { write: acceptInput, resize: (cols, rows) => acceptResize([cols, rows]), detach() {} };
    },
  });
  const socket = await connect();
  const response = await attachClient(socket, { ...attach, cols: 1, rows: 1 });
  assert.deepEqual(response, { t: 'attached', terminalId: attach.terminalId, cols: 80, rows: 24 });
  socket.send(JSON.stringify({ t: 'data', d: 'hello\r' }));
  assert.equal(await input, 'hello\r');
  socket.send(JSON.stringify({ t: 'resize', cols: 2, rows: 2 }));
  assert.deepEqual(await resized, [80, 24]);
  assert.equal(notes.length, 3);
});

test('an asynchronous attach failure is contained to its connection', { timeout: 5000 }, async (t) => {
  const connect = await server(t, { attach: async () => { throw new Error('failed attach'); } });
  const socket = await connect();
  const closed = once(socket, 'close');
  assert.equal((await attachClient(socket)).t, 'error');
  assert.equal((await closed)[0], 1011);
});

test('a terminal input exception is contained and its bridge is detached', { timeout: 5000 }, async (t) => {
  let detached = 0;
  const connect = await server(t, {
    attach: async () => ({ write() { throw new Error('failed write'); }, resize() {}, detach() { detached++; } }),
  });
  const socket = await connect();
  await attachClient(socket);
  const closed = once(socket, 'close');
  socket.send(JSON.stringify({ t: 'data', d: 'hello' }));
  assert.equal((await closed)[0], 1011);
  // The server close event is asynchronous relative to the client close event.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detached, 1);
});
