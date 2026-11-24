// SPEC-MEMORY — the loop-side half of the project-memory briefing channel: the briefing block's place
// in the iteration prompt, the persisted cursor (advanced to the composer's toSeq, cleared by an in-place
// respawn, kept across a Tower restart), the delivered annotation's annotation-only posture, the run-scoped
// integration boundary at land/abandon, and the agent progress note's never-into-a-prompt guarantee.
//
// Real Store + real Loops + a REAL MemoryStore behind the production closure shape (server.ts:
// composeMemoryBriefing over memoryStore.list, setIntegration keyed on the loop's projectId) — the
// loops-skillbrief harness pattern. No tmux: injectPrompt is driven end to end through the LoopsDeps.send
// seam, which captures the exact prompt bytes and steers the outcome ('verified' / 'unverified' / throw).
// The finishIteration cases init a real scratch git repo (the loops-restart G idiom). CT_HOME is set before
// the modules load — paths.ts freezes it at import time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Loop, LoopIteration, Terminal } from '../shared/types.js';
import type { MemoryPrincipal } from '../shared/memory.js';
import type { SendOutcome, VerifiedSendOpts } from './tmux.js';

const home = mkdtempSync(join(tmpdir(), 'ct-loops-memory-'));
process.env.CT_HOME = home;

const pexec = promisify(execFile);
const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { Store } = await import('./store.js');
const { Loops, composeIterationPrompt } = await import('./loops.js');
const { MemoryStore } = await import('./memory/store.js');
const { composeMemoryBriefing } = await import('./memory/briefing.js');
const { MEMORY_LOOP_FOOTER } = await import('./memory-instruction.js');
const { auditTail } = await import('./audit.js');
const tmux = await import('./tmux.js');
const { ProviderStore } = await import('./providers/store.js');
const { initProviderRegistry } = await import('./providers/registry.js');
initProviderRegistry(new ProviderStore());

type Send = (socket: string, text: string, opts?: VerifiedSendOpts) => Promise<SendOutcome>;
type Rt = Record<string, unknown>;
type BriefArgs = { projectId: string; loopId: string; mode: 'full' | 'delta'; sinceSeq?: number };

const OP: MemoryPrincipal = { kind: 'operator' };
const SKILL_BRIEF = 'Project skills for this task (not preinstalled; read the body file before using one):\n\nX';
const launching = (feedback?: string): Rt =>
  ({ phase: 'launching', injectAt: Date.now() - 1000, injectedAt: 0, sawWorking: false, idleTicks: 0, ...(feedback ? { feedback } : {}) });
const fired = (action: string, loopId: string): Record<string, unknown>[] =>
  auditTail(1000).filter((e) => e.action === action && e.loopId === loopId);

let seq = 0;
/**
 * A persisted loop + project + IDLE builder terminal, a real MemoryStore for the project, and a Loops
 * wired with the send seam (captures every prompt; outcome steered per call) and — unless `memory:
 * false` — the production-shape memory dep with every briefing call and integration event recorded.
 */
function harness(opts: {
  memory?: boolean;
  send?: Send;
  iteration?: number;
  iterations?: LoopIteration[];
  status?: Loop['status'];
  gatePolicy?: Loop['gatePolicy'];
  checkCommand?: string | null;
  skillBrief?: boolean;
  memoryCursor?: Loop['memoryCursor'];
  store?: InstanceType<typeof Store>;
} = {}) {
  const store = opts.store ?? new Store();
  const n = ++seq;
  const pid = `lm${n}`;
  const repo = join(home, `repo-${n}`);
  mkdirSync(repo, { recursive: true });
  const now = new Date().toISOString();
  store.upsertProject({ id: pid, name: 'p', repoPath: repo, scaffoldMode: 'zero-footprint', createdAt: now });
  const termId = `bt-${n}`;
  const loopId = `lp-${n}`;
  const term: Terminal = {
    id: termId, projectId: pid, title: 'builder', provider: 'claude-code',
    tmuxSocket: `loops-memory-none-${process.pid}-${n}`, cwd: repo, command: ['claude'], state: 'idle', createdAt: now,
  };
  store.upsertTerminal(term);
  const iteration = opts.iteration ?? 1;
  const iterations: LoopIteration[] = opts.iterations ?? [{ n: iteration, verdict: 'pending', startedAt: now }];
  const loop: Loop = {
    id: loopId, projectId: pid, name: 'n', task: 'do it', provider: 'claude-code', terminalId: termId,
    identityId: 'idn', checkCommand: opts.checkCommand === null ? undefined : opts.checkCommand,
    gatePolicy: opts.gatePolicy ?? 'never', maxIterations: 8, status: opts.status ?? 'running', iteration, iterations,
    ...(opts.skillBrief ? { skillBrief: SKILL_BRIEF } : {}),
    ...(opts.memoryCursor ? { memoryCursor: opts.memoryCursor } : {}),
    createdAt: now, updatedAt: now,
  };
  store.upsertLoop(loop);
  const memoryStore = new MemoryStore();
  const sent: string[] = [];
  const briefCalls: BriefArgs[] = [];
  const integrations: { loopId: string; state: 'landed' | 'abandoned' }[] = [];
  const send: Send = async (socket, text, o) => {
    sent.push(text);
    return opts.send ? opts.send(socket, text, o) : 'verified';
  };
  const loops = new Loops({
    store,
    tm: {} as never,
    worktrees: { land: async () => ({ detail: 'merged loop into main' }) } as never,
    accounts: { getIdentity: () => ({ gitName: 'Loop Bot', gitEmail: 'loop@example.test' }) } as never,
    onUpdate: () => {},
    send,
    ...(opts.memory === false
      ? {}
      : {
          memory: {
            // The server.ts closure shape, verbatim, plus recording.
            briefing: (a: BriefArgs) => {
              briefCalls.push(a);
              return composeMemoryBriefing(memoryStore.list(a.projectId), { mode: a.mode, sinceSeq: a.sinceSeq });
            },
            onIntegration: (ref: { loopId: string }, state: 'landed' | 'abandoned') => {
              integrations.push({ loopId: ref.loopId, state });
              const l = store.getLoop(ref.loopId);
              if (l) memoryStore.setIntegration(l.projectId, ref.loopId, state);
            },
          },
        }),
  });
  const inner = loops as unknown as {
    rt: Map<string, Rt>;
    freshPanes: Set<string>;
    injectPrompt(l: Loop, rt: Rt): Promise<void>;
    driveOne(l: Loop): Promise<void>;
    finishIteration(id: string): Promise<void>;
  };
  let entryN = 0;
  return {
    store, loops, memoryStore, pid, loopId, termId, repo, sent, briefCalls, integrations, inner,
    loop: (): Loop => store.getLoop(loopId)!,
    iter: (k = iteration): LoopIteration => store.getLoop(loopId)!.iterations.find((it) => it.n === k)!,
    inject: (rt: Rt = launching()): Promise<void> => inner.injectPrompt(store.getLoop(loopId)!, rt),
    /** An operator (project-scoped) entry; returns its id. */
    addEntry: (body: string, kind: 'gotcha' | 'decision' | 'glossary' = 'gotcha'): string =>
      memoryStore.add(pid, OP, { requestId: `r${++entryN}`, kind, body }).id,
    /** A loop-bound AGENT entry — defaults to run scope on THIS loop (integration 'in-flight'). */
    addRunEntry: (body: string): string =>
      memoryStore.add(pid, { kind: 'agent', terminalId: termId, loopId }, { requestId: `a${++entryN}`, kind: 'gotcha', body }).id,
    gitInit: async (): Promise<void> => {
      await pexec('git', ['init', '-q', '-b', 'main', repo]);
      store.patchLoop(loopId, { worktreePath: repo, baseBranch: 'main', branch: 'ct/x' });
    },
  };
}

test('a. NO memory dep: composeIterationPrompt + the injected prompt are byte-identical to a memory-less Tower, and the tail marker never moves', async () => {
  // Kills: any always-on addition riding the briefing change (a header, an empty block, a separator),
  // a cursor or annotation written with no dep wired, and a briefing that changes the resubmit belt's
  // ownership marker (the last non-empty line).
  const h = harness({ memory: false, skillBrief: true });
  const loop = h.loop();
  const expected = `do it\n\n${SKILL_BRIEF}\n\n${MEMORY_LOOP_FOOTER}\n\n[Control Tower · loop "n" · iteration 1] tighten`;
  assert.equal(composeIterationPrompt(loop, 'tighten').prompt, expected, 'the 4-arg compose is the pre-briefing shape');
  assert.equal(composeIterationPrompt(loop, 'tighten', undefined, false, undefined).prompt, expected, 'an absent block composes identically');
  assert.equal(composeIterationPrompt(loop, undefined).prompt, `do it\n\n${SKILL_BRIEF}\n\n${MEMORY_LOOP_FOOTER}`);

  await h.inject(launching('tighten'));
  assert.deepEqual(h.sent, [expected], 'the injected bytes are exactly the memory-less prompt');
  assert.equal(h.loop().memoryCursor, undefined, 'no dep ⇒ no cursor is ever written');
  assert.equal(h.iter().memoryDelivered, undefined, 'no dep ⇒ no annotation');
  assert.equal(fired('loop.memory.briefed', h.loopId).length, 0, 'no dep ⇒ no briefing audit');

  // Pinned: the tail marker is the footer (no feedback) or the feedback line, with or without a block.
  const block = 'Project memory — 2 active entries · full list: towerctl memory read\n- e1 [gotcha·provisional] one\n- e2 [decision·verified] two';
  for (const fb of [undefined, 'tighten the header']) {
    const without = composeIterationPrompt(loop, fb).prompt;
    const withBlock = composeIterationPrompt(loop, fb, undefined, false, block).prompt;
    assert.notEqual(withBlock, without, 'the block is actually in the prompt');
    assert.equal(tmux.ourTextTail(withBlock), tmux.ourTextTail(without), `ourTextTail is unchanged by the block (feedback: ${fb ?? 'none'})`);
  }
});

test('b. order: task, skill brief, memory block, footer, feedback — and the block is the composer\'s exact full briefing', async () => {
  // Kills: placing the block after the footer (moves the tail marker), before the brief, or after
  // feedback (feedback must stay LAST); and composing from anything but the project's live entries.
  const h = harness({ skillBrief: true });
  h.addEntry('the widget cache is keyed by project id');
  h.addEntry('we chose zod over ajv for the schema layer', 'decision');
  const expectedBlock = composeMemoryBriefing(h.memoryStore.list(h.pid), { mode: 'full' }).text!;
  await h.inject(launching('tighten the header'));
  const prompt = h.sent[0]!;
  const iTask = prompt.indexOf('do it');
  const iBrief = prompt.indexOf('Project skills for this task');
  const iMem = prompt.indexOf(expectedBlock);
  const iFooter = prompt.indexOf(MEMORY_LOOP_FOOTER);
  const iFeedback = prompt.indexOf('[Control Tower · loop "n" · iteration 1] tighten the header');
  assert.equal(iTask, 0, 'the task leads');
  assert.ok(iBrief > iTask, 'the skill brief follows the task');
  assert.ok(iMem > iBrief, 'the memory block follows the brief');
  assert.ok(iFooter > iMem, 'the standing footer follows the memory block');
  assert.ok(iFeedback > iFooter, 'feedback stays LAST');
  assert.equal(prompt, `do it\n\n${SKILL_BRIEF}\n\n${expectedBlock}\n\n${MEMORY_LOOP_FOOTER}\n\n[Control Tower · loop "n" · iteration 1] tighten the header`, 'byte-exact assembly');
  assert.equal(h.briefCalls[0]?.mode, 'full', 'a never-briefed loop asks for the full set');
  assert.equal(h.briefCalls[0]?.sinceSeq, undefined);
  assert.equal(h.iter().memoryDelivered?.length, 2, 'both delivered entries are annotated');
  const audit = fired('loop.memory.briefed', h.loopId);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.count, 2);
  assert.equal(audit[0]!.mode, 'full');
  assert.equal(audit[0]!.bytes, Buffer.byteLength(expectedBlock, 'utf8'), 'the audit carries the block size — never its text');
  assert.equal(Object.values(audit[0]!).some((v) => String(v).includes('widget cache')), false, 'no entry content in the audit');
});

test('c. a send that THROWS leaves the cursor and the annotation untouched (nothing reached the pane)', async () => {
  // Kills: stamping the cursor before/regardless of the send — the agent would then never see the
  // entries the failed send was supposed to carry (skipped as "already briefed" by the next delta).
  const h = harness({ send: async () => { throw new tmux.SendVerifyError('pane is dead — the CLI process has exited', 'dead-pane'); } });
  h.addEntry('a trap');
  await assert.rejects(() => h.inject(), (e: unknown) => e instanceof tmux.SendVerifyError, 'below the ceiling the send failure is rethrown for the tick log');
  assert.equal(h.sent.length, 1, 'the send was attempted');
  assert.equal(h.loop().memoryCursor, undefined, 'the cursor did not move');
  assert.equal(h.iter().memoryDelivered, undefined, 'nothing was annotated as delivered');
  assert.equal(fired('loop.memory.briefed', h.loopId).length, 0, 'and nothing was audited as briefed');
});

test('d. an entry added DURING the awaited send: the cursor lands on the compose-time toSeq, and the next delta carries the late entry', async () => {
  // Kills: advancing the cursor to "now" (memoryStore.seqOf at write time) — the late entry would be
  // skipped forever. Pinned: cursor === the composer's toSeq.
  let late: string | undefined;
  const h = harness({
    send: async (_s, text) => {
      // FIRST send only — it is mid-flight: the block already composed does NOT contain the late entry.
      if (late === undefined) {
        assert.equal(text.includes('the late discovery'), false);
        late = h.addRunEntry('the late discovery');
      }
      return 'verified';
    },
  });
  h.addEntry('an early gotcha');
  const composeTimeSeq = h.memoryStore.seqOf(h.pid);
  await h.inject();
  assert.ok(late, 'the late entry was written during the send');
  assert.ok(h.memoryStore.seqOf(h.pid) > composeTimeSeq, 'the store moved past the compose-time seq');
  assert.equal(h.loop().memoryCursor?.seq, composeTimeSeq, 'the cursor is the compose-time toSeq — NOT the store seq now');
  assert.ok(h.loop().memoryCursor?.briefedAt, 'and carries when it was briefed');
  assert.deepEqual(h.iter().memoryDelivered?.map((d) => d.id).sort(), [h.memoryStore.list(h.pid).find((e) => e.body === 'an early gotcha')!.id]);

  // The next injection is a delta from that cursor and delivers the late entry.
  await h.inject();
  assert.equal(h.briefCalls[1]?.mode, 'delta');
  assert.equal(h.briefCalls[1]?.sinceSeq, composeTimeSeq);
  assert.ok(h.sent[1]!.includes('the late discovery'), 'the late entry reaches the pane on the next delta');
  assert.ok(h.sent[1]!.includes('·in-flight'), 'a run-scoped unlanded entry is tagged in-flight');
  assert.equal(h.loop().memoryCursor?.seq, h.memoryStore.seqOf(h.pid), 'the cursor caught up');
  assert.equal(h.iter().memoryDelivered?.length, 2, 'the annotation is the union of everything this iteration was shown');
});

test('e. an UNVERIFIED send still advances the cursor (a degraded send is still a send)', async () => {
  // Kills: gating the cursor on 'verified' — a custom-provider loop (no classifier, always unverified)
  // would be re-briefed in full every iteration.
  const h = harness({ send: async () => 'unverified' });
  h.addEntry('a trap');
  await h.inject();
  assert.equal(h.loop().memoryCursor?.seq, h.memoryStore.seqOf(h.pid));
  assert.equal(h.iter().memoryDelivered?.length, 1);
  assert.equal(fired('loop.inject.unverified', h.loopId).length, 1, 'the degraded send is audited as before');
  assert.equal(fired('loop.memory.briefed', h.loopId).length, 1);
});

test('f. onTerminalRestarted clears the PERSISTED cursor → the next inject asks for a full briefing, even when the in-memory fresh mark is gone', async () => {
  // Kills: deriving the full-vs-delta choice from freshPanes alone — that set dies with a Tower
  // restart, so a respawn followed by a Tower restart would delta a pane whose context is empty.
  const h = harness();
  h.addEntry('a trap');
  await h.inject();
  assert.equal(h.briefCalls[0]?.mode, 'full');
  assert.ok(h.loop().memoryCursor, 'a cursor is set after the first briefing');
  await h.inject();
  assert.equal(h.briefCalls[1]?.mode, 'delta', 'control: a second inject on the same process is a delta');

  h.loops.onTerminalRestarted(h.termId);
  assert.equal(h.loop().memoryCursor, undefined, 'the respawn cleared the persisted cursor');
  assert.equal(h.inner.freshPanes.has(h.termId), true);
  // Simulate the Tower restart losing the in-memory mark: the persisted (cleared) cursor alone must
  // still route to 'full'.
  h.inner.freshPanes.clear();
  await h.inject();
  assert.equal(h.briefCalls[2]?.mode, 'full', 'the respawned pane is briefed in full off the cleared cursor');
  assert.equal(h.briefCalls[2]?.sinceSeq, undefined);
  assert.ok(h.loop().memoryCursor, 'and the cursor is re-established');

  // The fresh mark alone (cursor present) also forces 'full' — the respawn-raced-the-belt leg.
  h.inner.freshPanes.add(h.termId);
  await h.inject();
  assert.equal(h.briefCalls[3]?.mode, 'full');
  assert.equal(h.inner.freshPanes.has(h.termId), false, 'the successful injection spent the mark');
  await h.inject();
  assert.equal(h.briefCalls[4]?.mode, 'delta');
});

test('g. a Tower restart keeps the persisted cursor: the restore path re-arms and the next inject is a delta (all three fields survive the zod round-trip)', async () => {
  // Kills: forgetting any of the three LoopSchema/LoopIterationSchema lines (the M6 strip-trap) — a
  // restarted Tower would re-brief in full and forget what the builder was shown; and a restore path
  // that resets the cursor.
  const h = harness();
  const e1 = h.addEntry('a trap');
  await h.inject();
  h.loops.progress(h.loopId, 'parsing the fixtures');
  const cursor = h.loop().memoryCursor!;
  assert.ok(cursor);

  const reloaded = new Store(); // a fresh Store = the restart load path
  const l = reloaded.getLoop(h.loopId)!;
  assert.deepEqual(l.memoryCursor, cursor, 'memoryCursor survives the zod round-trip');
  assert.deepEqual(l.iterations[0]!.memoryDelivered, [{ id: e1, rev: 1 }], 'memoryDelivered survives the zod round-trip');
  assert.equal(l.iterations[0]!.progress, 'parsing the fixtures', 'progress survives the zod round-trip');

  // A fresh Loops over the reloaded store: no rt, no freshPanes — the restart shape.
  const h2 = harness({ store: reloaded });
  const inner2 = h2.inner;
  await inner2.driveOne(l); // the runtime-lost restore branch (idle pane ⇒ re-arm 'launching')
  const rt = inner2.rt.get(h.loopId)!;
  assert.equal(rt.phase, 'launching', 'the restore re-armed the current iteration');
  assert.equal(reloaded.getLoop(h.loopId)!.memoryCursor?.seq, cursor.seq, 'the restore left the cursor alone');
  h.addEntry('a post-restart entry');
  await inner2.injectPrompt(reloaded.getLoop(h.loopId)!, rt);
  // The loop under test rides h2's Loops (its memory dep + send seam), so the briefing call and the
  // delivered prompt are observed through h2's recorders.
  assert.equal(h2.briefCalls.length, 1);
  assert.equal(h2.briefCalls[0]?.mode, 'delta', 'the persisted cursor makes the post-restart inject a DELTA');
  assert.equal(h2.briefCalls[0]?.sinceSeq, cursor.seq, 'from exactly the persisted cursor');
  assert.equal(h2.sent.length, 1);
  assert.ok(h2.sent[0]!.includes('a post-restart entry'), 'the post-restart entry reaches the pane');
  assert.equal(h2.sent[0]!.includes('a trap'), false, 'the already-briefed entry is NOT re-sent — a delta, not a full');
  assert.ok(h2.sent[0]!.includes(`since seq ${cursor.seq}`), 'the delta header names the persisted cursor');
});

test('h. finishIteration: an iteration carrying memoryDelivered yields the same verdict/status as one without — and the annotation survives', async () => {
  // Kills: any read of memoryDelivered inside finishIteration's verdict/gate logic, and an
  // updateIteration that drops the annotation when recording the verdict.
  const run = async (delivered: { id: string; rev: number }[] | undefined) => {
    const h = harness({ checkCommand: 'true', memory: false });
    await h.gitInit();
    writeFileSync(join(h.repo, 'work.txt'), 'iteration work\n');
    if (delivered) h.store.patchLoop(h.loopId, { iterations: [{ ...h.iter(), memoryDelivered: delivered }] });
    await h.inner.finishIteration(h.loopId);
    return h;
  };
  const plain = await run(undefined);
  const annotated = await run([{ id: 'e-abc', rev: 3 }]);
  assert.equal(plain.iter().verdict, 'pass');
  assert.equal(annotated.iter().verdict, plain.iter().verdict, 'same verdict');
  assert.equal(plain.loop().status, 'done');
  assert.equal(annotated.loop().status, plain.loop().status, 'same status');
  assert.equal(annotated.loop().stopReason, plain.loop().stopReason);
  assert.deepEqual(annotated.iter().memoryDelivered, [{ id: 'e-abc', rev: 3 }], 'the annotation survives the verdict write');
  assert.equal(plain.iter().memoryDelivered, undefined);
  assert.equal(plain.loop().landedAt, undefined, 'a bare done is not a land');
});

test('i. integration boundary: land fires onIntegration(landed) exactly once; a stop / gone of an unlanded loop fires abandoned once', async () => {
  // Kills: firing on bare 'done', firing twice across land + archive, firing 'abandoned' for a
  // landed loop, or resolving the project id from anything but the loop record.
  {
    const h = harness({ status: 'gated' });
    const e = h.addRunEntry('found on this branch');
    assert.equal(h.memoryStore.get(h.pid, e)!.applicability.scope, 'run');
    await h.loops.land(h.loopId);
    assert.deepEqual(h.integrations, [{ loopId: h.loopId, state: 'landed' }], 'landed fired exactly once');
    const a = h.memoryStore.get(h.pid, e)!.applicability;
    assert.equal(a.scope === 'run' && a.integration, 'landed', 'the run-scoped entry flipped to landed through the store');
    assert.ok(a.scope === 'run' && a.landedAt, 'and was stamped landedAt');
    h.loops.archive(h.loopId);
    h.loops.stop(h.loopId); // a landed loop is a finished success — stop() is a no-op on it
    assert.equal(h.integrations.length, 1, 'no second event across archive / a no-op stop');
    assert.equal(h.loop().status, 'done');
  }
  {
    const h = harness({ status: 'done' }); // done-UNLANDED: a live Review & Land candidate
    const e = h.addRunEntry('a candidate discovery');
    h.loops.stop(h.loopId);
    assert.deepEqual(h.integrations, [{ loopId: h.loopId, state: 'abandoned' }], 'dismissing a candidate abandons its run entries');
    const a = h.memoryStore.get(h.pid, e)!.applicability;
    assert.equal(a.scope === 'run' && a.integration, 'abandoned');
    h.loops.stop(h.loopId);
    assert.equal(h.integrations.length, 1, 'a second stop is idempotent — no second event');
  }
  {
    const h = harness({ status: 'running' });
    h.addRunEntry('mid-flight');
    h.loops.onTerminalGone(h.termId); // → failed
    assert.equal(h.loop().status, 'failed');
    assert.deepEqual(h.integrations, [{ loopId: h.loopId, state: 'abandoned' }], 'a failed unlanded loop abandons its run entries');
  }
  {
    const h = harness({ status: 'running' });
    h.loops.pause(h.loopId); // launching + never injected ⇒ paused immediately
    assert.equal(h.loop().status, 'paused');
    assert.equal(h.integrations.length, 0, 'a non-terminal transition never fires');
  }
});

test('j. the progress note is recorded (1 KB clamp, latest wins) and NEVER reaches feedback — restore branch, next-iteration feedback, or the prompt', async () => {
  // Kills: routing the note through iterations[].note (which the restore branch feeds back into the
  // prompt verbatim), reading it in nextFeedback, or a byte-slicing clamp that tears a character.
  const now = new Date().toISOString();
  const h = harness({
    iteration: 3,
    iterations: [
      { n: 1, verdict: 'pass', startedAt: now, endedAt: now },
      { n: 2, verdict: 'fail', checkTail: 'boom: 1 test failed', startedAt: now, endedAt: now, progress: 'SECRET-PROGRESS-2' },
      { n: 3, verdict: 'pending', startedAt: now },
    ],
  });
  const { n } = h.loops.progress(h.loopId, '  halfway through the parser  ');
  assert.equal(n, 3);
  assert.equal(h.iter(3).progress, 'halfway through the parser', 'trimmed, on the CURRENT iteration');
  h.loops.progress(h.loopId, 'SECRET-PROGRESS-3');
  assert.equal(h.iter(3).progress, 'SECRET-PROGRESS-3', 'latest wins');
  assert.equal(h.iter(3).note, undefined, 'never stored as the gate note');
  assert.throws(() => h.loops.progress(h.loopId, '   '), /empty/);

  // The Tower-restart restore branch rebuilds feedback from the prior record — from its check tail,
  // never from either iteration's progress.
  await h.inner.driveOne(h.loop());
  const rt = h.inner.rt.get(h.loopId)!;
  assert.match(String(rt.feedback), /boom: 1 test failed/, 'the check-failure feedback was rebuilt');
  assert.equal(String(rt.feedback).includes('SECRET-PROGRESS'), false, 'no progress text in the rebuilt feedback');
  await h.inner.injectPrompt(h.loop(), rt);
  assert.equal(h.sent[0]!.includes('SECRET-PROGRESS'), false, 'no progress text in the injected prompt');

  // The next-iteration feedback out of finishIteration (nextFeedback) — a failing check with a tail.
  const g = harness({ checkCommand: 'echo boom-check; false', memory: false });
  await g.gitInit();
  writeFileSync(join(g.repo, 'work.txt'), 'x\n');
  g.loops.progress(g.loopId, 'SECRET-PROGRESS-G');
  await g.inner.finishIteration(g.loopId);
  assert.equal(g.loop().iteration, 2, 'a failed check begins the next iteration');
  const rt2 = g.inner.rt.get(g.loopId)!;
  assert.match(String(rt2.feedback), /boom-check/, 'the check tail is the feedback');
  assert.equal(String(rt2.feedback).includes('SECRET-PROGRESS'), false, 'the progress note is not');
  assert.equal(g.iter(1).progress, 'SECRET-PROGRESS-G', 'the annotation survives the verdict write');
  assert.equal(g.iter(1).verdict, 'fail');

  // 1 KB clamp on a code-point boundary: 'é' is 2 bytes, so 1000 of them (2000 bytes) clamp to 512
  // whole characters — never a torn half.
  const k = harness({ memory: false });
  k.loops.progress(k.loopId, 'é'.repeat(1000));
  const p = k.iter().progress!;
  assert.equal(Buffer.byteLength(p, 'utf8'), 1024);
  assert.equal([...p].length, 512);
  assert.equal(p.includes('�'), false, 'no replacement character from a torn multibyte sequence');
  k.loops.progress(k.loopId, `${'a'.repeat(1023)}😀`); // the 4-byte emoji would cross the ceiling by 3
  assert.equal(k.iter().progress, 'a'.repeat(1023), 'a code point that does not fit is dropped whole');
});

/** A send seam that resolves immediately until `hold()` is armed, then parks the NEXT send on a promise the
 *  test releases — the in-flight-send window an operator Restart can land in. */
function holdableSend() {
  let armed = false;
  let release: (() => void) | undefined;
  const send: Send = async () => {
    if (!armed) return 'verified';
    armed = false;
    await new Promise<void>((r) => { release = r; });
    return 'verified';
  };
  return {
    send,
    hold: () => { armed = true; },
    /** Resolve the parked send (asserts one is parked). */
    release: () => { assert.ok(release, 'a send is parked'); release!(); release = undefined; },
    parked: () => release !== undefined,
  };
}

test('k. a respawn DURING the awaited send: the resolving send neither re-stamps the cleared cursor nor spends the fresh mark — the respawned pane is briefed in full next inject', async () => {
  // Kills: advancing the cursor / deleting the freshPanes mark unconditionally after the await. The race:
  // injectPrompt composes a DELTA and awaits the send; an operator Restart lands inside that await
  // (onTerminalRestarted clears memoryCursor + marks the pane fresh, because the agent's context just
  // died); the send then resolves and — without the generation guard — overwrites the cleared cursor with
  // the delta's toSeq and clears the mark, so the context-less builder never sees the full briefing until
  // the NEXT respawn. Also kills a GLOBAL (not per-terminal) generation: a respawn of some OTHER terminal
  // during the send must not hold this loop's cursor.
  const gate = holdableSend();
  const h = harness({ send: gate.send });
  h.addEntry('a trap');
  await h.inject();
  assert.equal(h.briefCalls[0]?.mode, 'full');
  assert.ok(h.loop().memoryCursor, 'control: a cursor exists after the first briefing');

  gate.hold();
  const inFlight = h.inject(); // a delta whose send parks mid-await
  await new Promise((r) => setImmediate(r));
  assert.equal(gate.parked(), true, 'the second send is in flight');
  assert.equal(h.briefCalls[1]?.mode, 'delta', 'and it carries a delta (the pane still had its context when composed)');

  h.loops.onTerminalRestarted(h.termId); // the operator's Restart lands inside the send
  assert.equal(h.loop().memoryCursor, undefined, 'the respawn cleared the persisted cursor');
  assert.equal(h.inner.freshPanes.has(h.termId), true, 'and marked the pane fresh');

  gate.release();
  await inFlight;
  assert.equal(h.loop().memoryCursor, undefined, 'the resolving send did NOT re-stamp the cleared cursor');
  assert.equal(h.inner.freshPanes.has(h.termId), true, 'and did NOT spend the fresh mark');
  assert.equal(fired('loop.memory.cursor-held', h.loopId).length, 1, 'the held cursor is audited, never silent');
  assert.equal(fired('loop.memory.briefed', h.loopId).length, 2, 'the briefing itself is still audited as sent');
  assert.equal(h.iter().memoryDelivered?.length, 1, 'the delivered annotation is kept (the bytes were typed; the next full merges by id)');

  // The next inject re-briefs the respawned (context-less) pane in FULL, re-establishes the cursor, and
  // spends the mark — the non-raced path is unchanged.
  await h.inject();
  assert.equal(h.briefCalls[2]?.mode, 'full', 'the respawned pane gets the full set');
  assert.equal(h.briefCalls[2]?.sinceSeq, undefined);
  assert.ok(h.sent[2]!.includes('a trap'), 'the full briefing reaches the new process');
  assert.ok(h.loop().memoryCursor, 'the cursor is re-established by the post-respawn send');
  assert.equal(h.inner.freshPanes.has(h.termId), false, 'the successful post-respawn injection spent the mark');
  await h.inject();
  assert.equal(h.briefCalls[3]?.mode, 'delta', 'and the delta chain resumes');
  assert.equal(fired('loop.memory.cursor-held', h.loopId).length, 1, 'no further holds on the non-raced path');

  // Negative space — per-TERMINAL generation: a respawn of an unrelated terminal during this loop's send
  // leaves the advance alone (a global counter would wrongly hold the cursor here).
  const g2 = holdableSend();
  const h2 = harness({ send: g2.send });
  h2.addEntry('elsewhere');
  await h2.inject();
  const c2 = h2.loop().memoryCursor;
  assert.ok(c2);
  h2.addEntry('a later entry');
  g2.hold();
  const inFlight2 = h2.inject();
  await new Promise((r) => setImmediate(r));
  assert.equal(g2.parked(), true);
  h2.loops.onTerminalRestarted(`${h2.termId}-other`); // some other pane respawned
  g2.release();
  await inFlight2;
  assert.ok(h2.loop().memoryCursor && h2.loop().memoryCursor!.seq > c2.seq, 'an unrelated respawn does not hold the cursor — it advanced');
  assert.equal(h2.inner.freshPanes.has(h2.termId), false, 'and the mark was spent as usual');
  assert.equal(fired('loop.memory.cursor-held', h2.loopId).length, 0, 'nothing audited as held');
});

test('l. onTerminalRestarted({ resumed: true }) keeps the PERSISTED cursor — the next inject is a delta; the default (no opts / resumed: false) clears it and briefs full', async () => {
  // Kills: dropping the { resumed } opt entirely (a resumed pane would re-brief in full and repeat
  // everything the agent already saw), and forgetting to gate the memory-mode decision on
  // resumedPanes (a resumed pane's fresh mark alone would still force a full re-brief).
  const h = harness();
  h.addEntry('a trap');
  await h.inject();
  assert.equal(h.briefCalls[0]?.mode, 'full');
  const cursor = h.loop().memoryCursor;
  assert.ok(cursor, 'a cursor is set after the first briefing');

  h.loops.onTerminalRestarted(h.termId, { resumed: true });
  assert.deepEqual(h.loop().memoryCursor, cursor, 'a resumed restart leaves the persisted cursor untouched');
  assert.equal(h.inner.freshPanes.has(h.termId), true, 'the pane is still marked fresh — a new process either way');

  await h.inject();
  assert.equal(h.briefCalls[1]?.mode, 'delta', 'a resumed pane kept its context — briefed a delta, not the whole project again');
  assert.equal(h.briefCalls[1]?.sinceSeq, cursor!.seq);
  assert.equal(h.inner.freshPanes.has(h.termId), false, 'the successful injection still spends the fresh mark');

  // Contrast: a non-resumed restart (the historical shape — no opts at all) clears the cursor.
  await h.inject();
  h.loops.onTerminalRestarted(h.termId);
  assert.equal(h.loop().memoryCursor, undefined, 'an un-resumed restart clears the persisted cursor');
  await h.inject();
  assert.equal(h.briefCalls[3]?.mode, 'full', 'and the next inject is a full re-brief');

  // An EXPLICIT resumed: false behaves identically to the default (no opts).
  await h.inject();
  h.loops.onTerminalRestarted(h.termId, { resumed: false });
  assert.equal(h.loop().memoryCursor, undefined, 'explicit resumed:false also clears the cursor');
});

process.on('exit', () => {
  rmSync(home, { recursive: true, force: true });
});
