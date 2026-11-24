// Shared scratch-Tower fixture for the route tests: a probe-bound free port plus a child Tower whose
// readiness is gated on the child's OWN startup identity line. Extracted from the route files that
// each carried a verbatim copy of this block, after the copies' shared readiness check proved
// adoptable-by-strangers (below). Test-only — nothing in the product imports this.
//
// WHY the identity line: freePort() must RELEASE the port before the child can bind it, and the
// child takes seconds to boot tsx. Under `node --test` parallelism a sibling file's Tower can land
// on the released port inside that window (listen(0) re-issues a just-released port ~13% of the
// time on the kernel this was diagnosed on). EVERY Tower answers /api/session with a token+version
// body, so a poll that accepts any Tower-shaped answer adopts the SIBLING — whose in-memory
// hook-token map never minted this file's terminal tokens, so every authed subtest 401s "bad
// terminal token": a fixture artifact wearing a product-bug costume. The one thing no sibling can
// ever print is OUR CT_HOME. server.ts logs
//   `Control Tower v… listening on http://127.0.0.1:<port>  (CT_HOME=<home>)`
// only AFTER its bind succeeds, and <home> is this file's private mkdtemp — so "ready" means that
// line was seen on OUR child's stdout AND /api/session answers. A dead child (the stolen-port
// signature) or a bound-but-unresponsive Tower is a loud fixture error naming the child's exit
// code — never a bogus assertion failure and never a skip; only the benign alive-but-slow boot
// returns a skip reason (see ScratchTower.skip).

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, Socket } from 'node:net';
import { join } from 'node:path';

/** A port nobody else holds right now (bind :0, keep what the kernel picked, release it) — a
 *  pid-derived port can collide with an unrelated dev server, and a taken port hands the whole
 *  file to whoever holds it. The release is also why spawnTower must verify identity: the port is
 *  only guaranteed free at the instant this returns. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ok, bad) => { probe.once('error', bad); probe.listen(0, '127.0.0.1', ok); });
  const addr = probe.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  await new Promise<void>((ok) => probe.close(() => ok()));
  if (!port) throw new Error('could not obtain a free port for the scratch Tower');
  return port;
}

export interface ScratchTower {
  /** The child Tower process. Absent when the boot was skipped — the fixture already reaped it. */
  server?: ChildProcess;
  /** The operator session token minted by THIS Tower's /api/session (verified ours, see above).
   *  '' when the boot was skipped. */
  sessionToken: string;
  /** Set ONLY for the one benign cause: the child stayed ALIVE but never printed its identity line
   *  within the window (environmental slow boot under parallelism). Adopters thread this into their
   *  route tests' `{ skip }`. Every other cause still THROWS: a DEAD child — which is exactly how a
   *  stolen port lands, our child hits EADDRINUSE and exits 1 — and a Tower that bound (identity
   *  seen) but never served /api/session. */
  skip?: string;
}

/** Spawn the Tower as a child on (home, port) and wait until OUR Tower — identified by the startup
 *  line carrying this exact home — answers /api/session. Never adopts a stranger. On failure it
 *  reaps the child, then either throws LOUDLY (child died — the stolen-port signature — or bound
 *  without serving) or returns a `skip` reason (alive but slow — the only benign cause). */
export async function spawnTower(home: string, port: number): Promise<ScratchTower> {
  // stdout is PIPED for the identity line. stderr stays ignored: a boot failure is summarized by
  // the exit code in the error below, and a second never-read pipe is a second wedge risk.
  const server = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'server.ts')], {
    env: { ...process.env, CT_HOME: home, CT_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // Unref the child AND its stdout pipe, or either handle keeps the runner alive after the tests —
  // the in-process-server hang documented in research-route.test.ts, in pipe form.
  server.unref();

  const identity = `listening on http://127.0.0.1:${port}  (CT_HOME=${home})`;
  let sawIdentity = false;
  let tail = '';
  const out = server.stdout;
  if (!out) throw new Error('scratch Tower spawned without a stdout pipe');
  out.setEncoding('utf8');
  // The data handler doubles as the drain: it keeps consuming after the match, so the pipe buffer
  // can never fill and block the child's console.log mid-run.
  out.on('data', (chunk: string) => {
    if (sawIdentity) return;
    tail = (tail + chunk).slice(-4096); // sliding window: the line may straddle a chunk boundary
    if (tail.includes(identity)) sawIdentity = true;
  });
  out.on('error', () => { /* a torn pipe on child death is the exit code's story to tell */ });
  if (out instanceof Socket) out.unref();

  let sessionToken = '';
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    // A dead child can never become ready — stop polling and fall through to the loud error.
    if (server.exitCode !== null || server.signalCode !== null) break;
    // Identity FIRST: /api/session is only asked once the port is provably ours (the line prints
    // after the child's bind succeeded, and a bind is exclusive), so the token below cannot be a
    // stranger's.
    if (sawIdentity) {
      const got = await fetch(`http://127.0.0.1:${port}/api/session`)
        .then(async (r) => {
          if (!r.ok) return undefined;
          return (await r.json().catch(() => undefined)) as { token?: unknown; version?: unknown } | undefined;
        })
        .catch(() => undefined);
      if (got && typeof got.token === 'string' && typeof got.version === 'string') {
        sessionToken = got.token;
        ready = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (ready && server.exitCode === null && server.signalCode === null) {
    return { server, sessionToken };
  }
  // Every failure path reaps the child first: the adopter's cleanup hook registers only after this
  // returns, so a spawned-but-hung Tower would otherwise be orphaned.
  const died = server.exitCode !== null || server.signalCode !== null;
  if (!died) server.kill('SIGKILL');
  if (!died && !sawIdentity) {
    // The one benign cause: the child is alive but never got to its bind inside the window — an
    // environmental slow boot (cold tsx cache, loaded box, runner parallelism). A stolen port never
    // lands here: the thief's bind is exclusive, so our child dies on EADDRINUSE and throws below.
    return { sessionToken: '', skip: `scratch Tower did not come up on 127.0.0.1:${port} within 15s (child alive, identity line never seen; reaped)` };
  }
  throw new Error(
    `no Tower of ours answered on 127.0.0.1:${port} for CT_HOME ${home} within 15s ` +
    `(child exit=${String(server.exitCode)} signal=${String(server.signalCode)}; identity line ` +
    (sawIdentity ? 'seen but /api/session never answered' : 'NEVER seen — whatever answers on that port is not ours') +
    ") — refusing to run this file's assertions against whatever is on that port",
  );
}
