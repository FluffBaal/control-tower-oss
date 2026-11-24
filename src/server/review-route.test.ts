// SPEC-LOOP W6 — the code-review route's OWNERSHIP CHAIN and RETRY-FRESHNESS guards, driven against a
// real Tower. reviews.test.ts already pins the pure predicates (isPreRetryReviewLoop / isStaleReviewRecord)
// and the completion gate; a typecheck and those unit tests say NOTHING about the LIVE routes that CALL
// them. This is the half that keeps the retried reviewer honest, and it is exactly the bug the fix closes:
// a discarded reviewer's `towerctl review check` must never read `submitted: true` off the review the
// operator threw away.
//
// What has to hold on GET/POST /api/agent/review:
//   - ownership is derived server-side (token → terminal → its newest loop carrying a mission+sortie
//     backref → that loop's sortie) and never read from the body; only a REVIEW-JUDGE sortie may submit
//     (reviewSortie:true pending, or reviewFromRange set finalized) — a review-FIX sortie (assignedFromReview)
//     is NOT a reviewer;
//   - a PRE-RETRY caller's loop (createdAt < the sortie's reviewRetryAt stamp — the discarded reviewer) is
//     404'd at both routes, so it can neither submit into nor read the review that superseded it
//     (resolveReviewContext's isPreRetryReviewLoop guard);
//   - GET reads a PRE-STAMP record as not-submitted (isStaleReviewRecord), so the REPLACEMENT reviewer's
//     check keeps failing until IT resubmits;
//   - EVERY derivation miss returns ONE byte-identical 404, so the route is no ownership oracle.
//
// Method mirrors research-route.test.ts: a scratch CT_HOME on a scratch port, seeded config files, and
// REAL tmux sessions for the seeded terminals — without a live session the boot reconciler vanishes them
// and forgets their hook tokens, so the fixture has to be honest about that. The operator's Tower and
// ~/.ct are untouched. Self-skips when tmux is unavailable or the scratch Tower is slow to boot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { freePort, spawnTower } from './tower-fixture.js';

const pexec = promisify(execFile);
const haveTmux = await pexec('tmux', ['-V']).then(() => true).catch(() => false);

const home = mkdtempSync(join(tmpdir(), 'ct-review-route-'));
// Per-run socket suffix: two concurrent runs of this file (a watch loop, or a parallel CI shard) would
// otherwise fight over one set of ct- sockets.
const RUN = home.slice(-6).replace(/[^a-zA-Z0-9]/g, '');
const PORT = await freePort();
process.env.CT_HOME = home;
process.env.CT_PORT = String(PORT);

const now = new Date().toISOString();
// The retry stamp and the two loop createdAts that straddle it. The pre-retry loop was created BEFORE the
// stamp (the discarded reviewer); the replacement loop AFTER it. The seeded record on disk is the
// discarded run's — submitted before the stamp.
const STAMP = '2026-06-01T00:00:00.000Z';
const BEFORE_STAMP = '2026-05-01T00:00:00.000Z';
const AFTER_STAMP = '2026-07-01T00:00:00.000Z';

const SOCKETS: string[] = [];
let server: ChildProcess | undefined;
let skip: string | false = haveTmux ? false : 'tmux is not installed';

/** A terminal record + a REAL tmux session behind it, so the boot reconciler adopts rather than vanishes
 *  it (a vanish forgets the hook token and every request would then 401). */
function terminal(id: string, token: string) {
  const socket = `ct-${id}${RUN}`;
  SOCKETS.push(socket);
  return {
    id, projectId: 'p1', title: id, provider: 'codex', tmuxSocket: socket,
    cwd: home, command: ['sleep', '600'], state: 'idle', hookToken: token, createdAt: now,
  };
}
function loop(id: string, terminalId: string, missionId: string, sortieId: string, status: string, createdAt = now) {
  return {
    id, projectId: 'p1', name: id, task: 't', provider: 'codex', gatePolicy: 'never',
    maxIterations: 4, status, iteration: 1, iterations: [{ n: 1, verdict: 'pending', startedAt: now }],
    terminalId, missionId, sortieId, baseBranch: 'main', createdAt, updatedAt: now,
  };
}
function mission(id: string, sorties: Record<string, unknown>[]) {
  return {
    id, projectId: 'p1', name: id, goal: 'g', provider: 'codex', advance: 'gate',
    maxIterationsPerSortie: 4, concurrency: 1,
    phases: [{ id: `${id}-ph`, name: 'review', round: 2, sorties }],
    activePhase: 0, status: 'running', createdAt: now, updatedAt: now,
  };
}

if (haveTmux) {
  mkdirSync(join(home, 'config'), { recursive: true });
  const terminals = [
    terminal('treview', 'tok-review'),  // a review-judge sortie, live loop     → may submit + read
    terminal('tbuild', 'tok-build'),    // a plain build sortie                  → 404
    terminal('tnoloop', 'tok-noloop'),  // no loop at all                        → 404
    terminal('tfix', 'tok-fix'),        // a review-FIX sortie (assignedFromReview) → 404 (not a reviewer)
    terminal('tpre', 'tok-pre'),        // the DISCARDED reviewer (pre-retry loop)  → 404 at both routes
    terminal('tretry', 'tok-retry'),    // the REPLACEMENT reviewer (post-retry loop) → old record reads stale
  ];
  for (const socket of SOCKETS) {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); // nothing to kill is fine
    // …but a FAILED seed is not. Without the session the boot reconciler vanishes that terminal and
    // forgets its hook token, so the whole fixture reports 401s that read exactly like an ownership
    // regression. A fixture must never be able to impersonate the defect it is testing for.
    const made = spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'main', 'sleep 600']);
    if (made.error || made.status !== 0) {
      const why = made.error?.message ?? made.stderr?.toString().trim() ?? `exit ${String(made.status)}`;
      throw new Error(`could not seed the tmux session for ${socket}: ${why}`);
    }
  }
  const write = (f: string, v: unknown): void => writeFileSync(join(home, 'config', f), JSON.stringify(v, null, 2));
  write('projects.json', [{ id: 'p1', name: 'p', repoPath: home, scaffoldMode: 'zero-footprint', createdAt: now }]);
  write('terminals.json', terminals);
  // Exactly ONE loop per terminal, so resolveReviewContext's newest-first pick is unambiguous. The review
  // route is any-loop (not live-only), so status is 'running' throughout; the discriminators here are the
  // sortie markers and the loop createdAt vs the retry stamp.
  write('loops.json', [
    loop('l1', 'treview', 'm1', 's-review', 'running'),
    loop('l2', 'tbuild', 'm1', 's-build', 'running'),
    loop('l3', 'tfix', 'm1', 's-fix', 'running'),
    loop('l4', 'tpre', 'm4', 's-pre', 'running', BEFORE_STAMP),   // created before the stamp → discarded
    loop('l5', 'tretry', 'm5', 's-retry', 'running', AFTER_STAMP), // created after the stamp → replacement
  ]);
  write('missions.json', [
    mission('m1', [
      { id: 's-review', name: 'review', task: 'review it', status: 'active', loopId: 'l1', reviewSortie: true },
      { id: 's-build', name: 'build', task: 'build it', status: 'active', loopId: 'l2' },
      // A review-FIX sortie carries only assignedFromReview — it fixes a reviewer's finding, it is NOT a
      // reviewer, so the resolver must reject it.
      { id: 's-fix', name: 'review-fix', task: 'fix it', status: 'active', loopId: 'l3', assignedFromReview: 'oldrec' },
    ]),
    // The pre-retry case: a review sortie retried at STAMP whose derived loop (l4) predates the stamp.
    mission('m4', [{
      id: 's-pre', name: 'review', task: 'review again', status: 'active', loopId: 'l4',
      reviewSortie: true, reviewRetryAt: STAMP,
    }]),
    // The freshness case: a review sortie retried at STAMP whose derived loop (l5) POSTdates the stamp
    // (so it passes the route), with a pre-stamp record on disk (below).
    mission('m5', [{
      id: 's-retry', name: 'review', task: 'review again', status: 'active', loopId: 'l5',
      reviewSortie: true, reviewRetryAt: STAMP,
    }]),
  ]);
  // The PREVIOUS run's review record, still on disk exactly as a retry leaves it (⟦DEC-4⟧ keeps it so a
  // post-land attestation flip stays possible). Submitted before the stamp — i.e. the discarded run's.
  write('reviews.json', [{
    id: 'oldrec', missionId: 'm5', sortieId: 's-retry',
    findings: [{ file: 'src/old.ts', summary: 'from the discarded reviewer', verdict: 'CONFIRMED' }],
    submittedAt: BEFORE_STAMP,
  }]);
  // The Tower runs as a CHILD PROCESS, not an in-process import. Importing it here would leave a listening
  // server and live timers in the TEST process, which then never exits (research-route.test.ts documents
  // why every workaround for that hang is worse). A child process drives the Tower across a real process
  // boundary the way a client does.
  // Spawn + identity-gated readiness live in tower-fixture.ts. "Ready" there means OUR Tower
  // answered — the startup line carrying THIS file's CT_HOME, then /api/session — so a stranger on
  // the released port (a sibling file's Tower under runner parallelism) is a loud fixture error: a
  // poll that adopted it would run the byte-identical-404 case GREEN against anyone who 404s.
  const tower = await spawnTower(home, PORT);
  server = tower.server;
  if (tower.skip) skip = tower.skip;
}

const base = `http://127.0.0.1:${PORT}`;
type Res = { status: number; text: string; body: Record<string, unknown> };
async function call(method: 'GET' | 'POST', token: string | undefined, payload?: unknown): Promise<Res> {
  const res = await fetch(`${base}/api/agent/review`, {
    method,
    headers: {
      ...(token ? { 'x-tower-terminal-token': token } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON body */ }
  return { status: res.status, text, body };
}

test('the review route derives ownership and refuses everything else', { skip }, async (t) => {
  await t.test('a review-judge sortie may submit + read, and the ids are SERVER-derived', async () => {
    // The body deliberately names a DIFFERENT mission and sortie. The route reads only `findings`, but
    // the assertion pins the property regardless: honouring either id would let any terminal write into
    // any mission's review, so the write must land under the DERIVED (m1, s-review) and nowhere else.
    const res = await call('POST', 'tok-review', {
      missionId: 'm5', sortieId: 's-retry', round: 99, // the redirect attempt
      findings: [{ file: 'src/a.ts', summary: 'a real bug', verdict: 'CONFIRMED' }],
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.findings, 1);
    assert.equal(res.body.confirmed, 1);

    const { ReviewStore } = await import('./reviews.js');
    const store = new ReviewStore();
    const stored = store.getFor('m1', 's-review');
    assert.ok(stored, 'the record landed under the DERIVED mission/sortie');
    assert.equal(stored!.findings.length, 1);
    assert.equal(stored!.round, 2, "round comes from the sortie's phase, not the body's 99");
    // The body could not redirect the write into m5/s-retry — that pair still holds only the seeded record.
    assert.equal(store.getFor('m5', 's-retry')?.id, 'oldrec', 'the body could not redirect the write');

    // GET reads the caller's own fresh submission.
    const get = await call('GET', 'tok-review');
    assert.equal(get.status, 200, get.text);
    assert.equal(get.body.submitted, true);
    assert.equal(get.body.findings, 1);
    assert.equal(get.body.confirmed, 1);
  });

  await t.test('no token ⇒ 401, bogus token ⇒ 401 (never 404, never 500)', async () => {
    for (const token of [undefined, 'not-a-real-token']) {
      const post = await call('POST', token, { findings: [] });
      const get = await call('GET', token);
      assert.equal(post.status, 401, `POST ${String(token)}: ${post.text}`);
      assert.equal(get.status, 401, `GET ${String(token)}: ${get.text}`);
    }
  });

  await t.test('every derivation miss is 404 with a BYTE-IDENTICAL body (no oracle)', async () => {
    // If these bodies differed, the route would report which of "not a review sortie", "no owning loop"
    // and "a review-fix sortie" applied — i.e. it would answer questions about missions the caller does
    // not own. A review-FIX sortie (assignedFromReview, no reviewSortie/reviewFromRange) is the load-
    // bearing addition here: it is adjacent to a real reviewer but must still 404.
    const unmarked = await call('POST', 'tok-build', { findings: [{ file: 'x', summary: 'y' }] });
    const noLoop = await call('POST', 'tok-noloop', { findings: [{ file: 'x', summary: 'y' }] });
    const reviewFix = await call('POST', 'tok-fix', { findings: [{ file: 'x', summary: 'y' }] });
    for (const [name, r] of [['unmarked', unmarked], ['noLoop', noLoop], ['reviewFix', reviewFix]] as const) {
      assert.equal(r.status, 404, `${name}: ${r.text}`);
    }
    assert.equal(unmarked.text, noLoop.text);
    assert.equal(noLoop.text, reviewFix.text);
    // …and the same on the read side.
    const g1 = await call('GET', 'tok-build');
    const g2 = await call('GET', 'tok-noloop');
    const g3 = await call('GET', 'tok-fix');
    assert.equal(g1.status, 404, g1.text);
    assert.equal(g1.text, g2.text);
    assert.equal(g2.text, g3.text);
    // And no record was created for any of the rejected sorties.
    const { ReviewStore } = await import('./reviews.js');
    const store = new ReviewStore();
    assert.equal(store.getFor('m1', 's-build'), undefined, 'no record for the build sortie');
    assert.equal(store.getFor('m1', 's-fix'), undefined, 'no record for the review-fix sortie');
  });

  await t.test('THE LOCK — a PRE-RETRY loop is 404 at both routes (isPreRetryReviewLoop)', async () => {
    // The discarded reviewer's loop (createdAt BEFORE the stamp) must lose the route entirely, so it can
    // neither submit into nor read the review that superseded it. Mutation target: dropping the
    // `isPreRetryReviewLoop(...) return undefined` guard in resolveReviewContext lets this loop resolve —
    // then these 404s become a 200/200, and this subtest goes RED.
    const post = await call('POST', 'tok-pre', { findings: [{ file: 'x', summary: 'y' }] });
    const get = await call('GET', 'tok-pre');
    assert.equal(post.status, 404, post.text);
    assert.equal(get.status, 404, get.text);

    // …and it is BYTE-IDENTICAL to an ordinary derivation miss — the discarded reviewer learns nothing
    // more than a stranger would. (If the guard is dropped, `post.status` above already fails first.)
    const ref = await call('POST', 'tok-build', { findings: [{ file: 'x', summary: 'y' }] });
    assert.equal(ref.status, 404, ref.text);
    assert.equal(post.text, ref.text, 'the pre-retry 404 is byte-identical to a derivation miss');
    assert.equal(get.text, ref.text, 'the pre-retry 404 (GET) is byte-identical to a derivation miss');

    // The discarded reviewer must not have written anything into the superseded review.
    const { ReviewStore } = await import('./reviews.js');
    assert.equal(new ReviewStore().getFor('m4', 's-pre'), undefined, 'the discarded reviewer wrote nothing');
  });

  await t.test('THE LOCK — GET reads a PRE-STAMP record as not-submitted (isStaleReviewRecord)', async () => {
    // The REPLACEMENT reviewer's loop was created AFTER the stamp, so it PASSES the route (200, not 404).
    // But the only record on disk (oldrec) was submitted BEFORE the stamp — the discarded run's — so GET
    // must read it as absent, keeping `towerctl review check` failing until THIS run resubmits. Mutation
    // target: changing GET's `const rec = isStaleReviewRecord(prior, ctx.retryAt) ? undefined : prior;`
    // to `const rec = prior;` makes this first GET return submitted:true → this subtest goes RED.
    const before = await call('GET', 'tok-retry');
    assert.equal(before.status, 200, before.text);
    assert.equal(before.body.submitted, false, 'the stale (pre-stamp) record must not satisfy the check');
    assert.equal(before.body.findings, undefined);

    // …and once the replacement actually resubmits, the check goes green off ITS record (submittedAt now,
    // after the stamp — fresh).
    const post = await call('POST', 'tok-retry', { findings: [{ file: 'src/new.ts', summary: 'the replacement found this' }] });
    assert.equal(post.status, 200, post.text);
    const after = await call('GET', 'tok-retry');
    assert.equal(after.status, 200, after.text);
    assert.equal(after.body.submitted, true);
    assert.equal(after.body.findings, 1);
  });
});

/** Reap the child Tower and every scratch resource. Runs on normal exit AND on a crash, so a failed
 *  assertion cannot leave a listening server or a tmux session behind. */
function cleanup(): void {
  server?.kill('SIGKILL');
  for (const socket of SOCKETS) {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const dir = process.env.TMUX_TMPDIR ? join(process.env.TMUX_TMPDIR, `tmux-${uid}`) : `/tmp/tmux-${uid}`;
    rmSync(join(dir, socket), { force: true });
  }
  rmSync(home, { recursive: true, force: true });
}
process.on('exit', cleanup);
