// SPEC-LOOPWEDGE F5 — the two silent hook-loss paths that a lost Stop hook slipped through, now
// closed so a lost completion signal always spools for the drain instead of vanishing:
//   #6 — the ct-hook forwarder: `curl -sf` exits NON-ZERO on an HTTP 4xx/5xx (before, `-s` alone exited
//        0 on an HTTP error and the event was lost without ever spooling), so the || fallback spools it.
//   #7 — the in-process /api/events path: an ingest THROW after the 202 ack respools via spoolEvent, and
//        the drain later applies it (the event round-trips instead of being dropped).
//
// CT_HOME is set before the modules load (paths.ts freezes it at import). Self-skips without curl/bash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-hooks-respool-'));
process.env.CT_HOME = home;

const pexec = promisify(execFile);
const haveCurl = await pexec('curl', ['--version']).then(() => true).catch(() => false);

const { ensureDirs, paths } = await import('./paths.js');
ensureDirs();
const { ensureHookScript, HOOK_SCRIPT, spoolEvent, drainSpool, isOrderedEmitTs } = await import('./hooks.js');
import type { SpooledEvent } from './hooks.js';

/** A throwaway HTTP server that answers EVERY request with `status`. Returns its port + a closer. */
async function server(status: number): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = createServer((_req, res) => { res.writeHead(status); res.end('nope'); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** Run the generated ct-hook ASYNCHRONOUSLY (a sync exec would block THIS event loop, and the mock
 *  server runs on it — curl would then hang until --max-time and spool for the wrong reason). stdin is
 *  /dev/null so the script's `cat >/dev/null` (drains the CLI's event JSON) gets EOF at once. */
function runHook(env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(HOOK_SCRIPT, ['turn-done'], { env, stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('exit', () => resolve());
  });
}

test('SPEC-LOOPWEDGE F5 #6 — ct-hook spools the event when the server answers HTTP 500 (the -f behavior)', { skip: haveCurl ? false : 'curl is not installed' }, async () => {
  ensureHookScript();
  const { port, close } = await server(500);
  try {
    const tid = 'respool-500';
    const spoolRoot = join(home, 'spool-6');
    const tokenFile = join(home, 'tok-6');
    writeFileSync(tokenFile, 'a-token', 'utf8');

    // Invoke the generated forwarder exactly as an agent CLI would: ct-hook <signal>. With -f, the 500
    // makes curl exit non-zero, so the || fallback writes an atomic spool file under $TOWER_SPOOL_DIR/$TID.
    await runHook({
      ...process.env,
      TOWER_TERMINAL_ID: tid,
      TOWER_PORT: String(port),
      TOWER_HOOK_TOKEN_FILE: tokenFile,
      TOWER_SPOOL_DIR: spoolRoot,
    });

    const dir = join(spoolRoot, tid);
    assert.ok(existsSync(dir), 'the spool dir for the terminal was created');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, 'exactly one spool file was written (a -s-only curl would exit 0 on 500 and write NONE)');
  } finally {
    await close();
  }
});

test('SPEC-LOOPWEDGE F5 #6b — ct-hook does NOT spool on a 202 success (the happy path is unchanged)', { skip: haveCurl ? false : 'curl is not installed' }, async () => {
  ensureHookScript();
  const { port, close } = await server(202);
  try {
    const tid = 'respool-202';
    const spoolRoot = join(home, 'spool-6b');
    const tokenFile = join(home, 'tok-6b');
    writeFileSync(tokenFile, 'a-token', 'utf8');
    await runHook({ ...process.env, TOWER_TERMINAL_ID: tid, TOWER_PORT: String(port), TOWER_HOOK_TOKEN_FILE: tokenFile, TOWER_SPOOL_DIR: spoolRoot });
    assert.ok(!existsSync(join(spoolRoot, tid)), 'a successful ack must not spool — only an HTTP error does');
  } finally {
    await close();
  }
});

test('SPEC-LOOPWEDGE F5 #7 — an ingest throw respools via spoolEvent, and the drain later applies it', async () => {
  // Mirrors the /api/events catch: after the 202 ack, ingestSignal throwing calls spoolEvent(ev). Prove
  // the event round-trips — spooled to disk, then applied by the drain and deleted (never dropped).
  const tid = 'respool-inprocess';
  const ev: SpooledEvent = { terminalId: tid, signal: 'turn-done', emitTs: '1700000000000000000' };

  spoolEvent(ev);
  const dir = join(paths.spool, tid);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1, 'the event was respooled to disk');

  const applied: SpooledEvent[] = [];
  const n = await drainSpool(async (e) => { applied.push(e); });
  assert.equal(n, 1, 'the drain applied exactly one event');
  assert.deepEqual(applied[0], ev, 'the drained event is byte-for-byte the one that was respooled');
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 0, 'and the applied spool file was deleted');
});

test('SPEC-LOOPWEDGE F5 — isOrderedEmitTs gates the /api/events respool: only a real stamp is replayable', () => {
  // The events-route catch respools an ingest throw ONLY when isOrderedEmitTs is true. An un-ordered
  // event (missing/'0'/non-numeric emitTs) would replay past ingest's ordering guard and could re-idle
  // a pane that legitimately re-worked — a real-idle (inferred=false) that bypasses the loop GUARD.
  // ct-hook always stamps `date +%s%N`; anything else is a malformed direct POST, safe to refuse.
  assert.equal(isOrderedEmitTs('1700000000000000000'), true, 'a real nanosecond stamp is ordered');
  assert.equal(isOrderedEmitTs('0'), false, "the '0' fallback is NOT ordered (the bug this closes)");
  assert.equal(isOrderedEmitTs(undefined), false, 'a missing stamp is not ordered');
  assert.equal(isOrderedEmitTs(''), false, 'an empty stamp is not ordered');
  assert.equal(isOrderedEmitTs('abc'), false, 'a non-numeric stamp is not ordered');
  assert.equal(isOrderedEmitTs('12x3'), false, 'a partially-numeric stamp is not ordered');
});

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
});
