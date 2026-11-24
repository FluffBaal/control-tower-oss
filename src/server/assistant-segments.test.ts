// appendSegment seam units + REAL drives of POST /api/assistant/message. codex delivers each
// agent_message WHOLE, several per turn — each is now its OWN bubble/turn (SPEC-ASSISTANT), no
// longer folded into one. This file proves that end to end: a PATH-shimmed fake `codex` emits
// captured-shape JSONL and the route must persist one assistant turn PER agent_message, carry the
// reasoning that precedes a message as that turn's `thinking`, and keep a trailing thinking-only
// turn OUT of the brain's replayed history. Scratch CT_HOME; the operator's ~/.ct is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Accounts } from './accounts.js';
import type { ProposalStore } from './assistant/proposals.js';
import type { SkillDraftStore } from './skills/drafts.js';

const home = mkdtempSync(join(tmpdir(), 'ct-segments-'));
process.env.CT_HOME = home;

// paths.ts freezes CT_HOME at import time — bring the store in only after the env is set
// (same dynamic-import idiom as skills-governance.test.ts).
const { appendSegment } = await import('../shared/assistant-text.js');
const { AssistantStore } = await import('./assistant/store.js');
const { registerAssistantRoutes } = await import('./assistant/routes.js');

const binDir = join(home, 'bin');
mkdirSync(binDir, { recursive: true });
process.env.PATH = `${binDir}:${process.env.PATH}`;
mkdirSync(join(home, 'config'), { recursive: true }); // server bootstrap makes this; a bare store does not

/** Write the PATH fake `codex`: drains the prompt on stdin, then prints the given JSONL lines. */
function fakeCodex(lines: string[]): void {
  writeFileSync(
    join(binDir, 'codex'),
    ['#!/bin/sh', 'cat >/dev/null', ...lines.map((l) => `printf '%s\\n' '${l}'`), ''].join('\n'),
    { mode: 0o755 },
  );
}

// One shared store + one active account for the whole file — the message route reads
// store.getActiveAccount(), and every startApp() call must NOT re-create the account (duplicate
// records would accumulate in the shared accounts file). Tests keep isolation via distinct convIds.
const configDir = join(home, 'codex-home');
mkdirSync(configDir, { recursive: true });
const mcpTokenFile = join(home, 'mcp-token');
writeFileSync(mcpTokenFile, 'test-token\n');
const sharedStore = new AssistantStore();
// allowNoSandbox: the fake codex needs no bubblewrap; this is the per-account override.
sharedStore.createAccount({ provider: 'codex', profileId: 'p1', model: 'gpt-test', allowNoSandbox: true });

/** Stand up the assistant routes against the shared store. */
async function startApp(): Promise<{ app: FastifyInstance; port: number; store: InstanceType<typeof AssistantStore> }> {
  const app = Fastify({ logger: false });
  registerAssistantRoutes(app, {
    store: sharedStore,
    accounts: {
      getProfile: (id: string) =>
        id === 'p1' ? { id: 'p1', provider: 'codex', label: 'seg-test', configDir } : undefined,
    } as unknown as Accounts,
    towerPort: 0,
    repoRoot: home,
    mcpTokenFile,
    proposals: { setHooks: () => {} } as unknown as ProposalStore,
    scopedTokenActive: false,
    skillDrafts: {} as unknown as SkillDraftStore,
    draftWarnings: () => [],
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  return { app, port: address.port, store: sharedStore };
}

async function postMessage(port: number, body: Record<string, unknown>): Promise<{ status: number; convId: string | null; sse: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/assistant/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const convId = res.headers.get('x-conversation-id');
  const sse = await res.text(); // drains until the route ends the stream
  return { status: res.status, convId, sse };
}

// ---- the seam itself (appendSegment now folds ONLY the thinking block) ----

test('appendSegment: empty prev returns next verbatim', () => {
  assert.equal(appendSegment('', 'hello'), 'hello');
  assert.equal(appendSegment('', ''), '');
});

test('appendSegment: two segments join across exactly one blank line', () => {
  assert.equal(appendSegment('a', 'b'), 'a\n\nb');
});

test('appendSegment: trailing/leading newlines collapse to exactly one \\n\\n', () => {
  assert.equal(appendSegment('a\n', 'b'), 'a\n\nb');
  assert.equal(appendSegment('a', '\nb'), 'a\n\nb');
  assert.equal(appendSegment('a\n\n', '\n\nb'), 'a\n\nb');
  assert.equal(appendSegment('a \n\t\n', '\r\n b'), 'a\n\nb');
});

test('appendSegment: whitespace-only input never leaves a dangling seam', () => {
  assert.equal(appendSegment('a', '  \n'), 'a');
  assert.equal(appendSegment(' \n ', 'b'), 'b');
});

test('appendSegment: interior whitespace is untouched — only the seam is trimmed', () => {
  assert.equal(appendSegment('a\n\nkeep  this', 'b\nand this'), 'a\n\nkeep  this\n\nb\nand this');
});

test('the thinking fold: several reasoning deltas join with one seam each', () => {
  // The surviving in-dock use of appendSegment — multiple {t:'thinking'} deltas that precede
  // one message fold into that bubble's single thinking block.
  const thinking = ['t1', 't2', 't3'].reduce((acc, d) => appendSegment(acc, d), '' as string);
  assert.equal(thinking, 't1\n\nt2\n\nt3');
});

// ---- the CLIENT bubble model (source pins — handleEvent is not unit-reachable) ----

test('the dock seals each agent_message into its own bubble, never concatenating (source pin)', () => {
  // sealAssistant/handleEvent live inside the component and are not unit-reachable without a
  // mount, so the load-bearing lines are pinned at the source level (skills-governance's
  // source-invariant idiom): a regression back to `m.text + ev.delta` (the run-on bug) or to
  // folding text via appendSegment must fail HERE.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../web/AssistantDock.tsx'), 'utf8');
  assert.ok(src.includes('sealAssistant(ev.delta)'), 'a text event seals its own bubble');
  assert.ok(src.includes("thinking: appendSegment(m.thinking ?? '', ev.delta)"), 'thinking still folds through the shared seam');
  assert.ok(!src.includes('+ ev.delta'), 'no bare string concatenation of deltas anywhere in the dock');
  assert.ok(!src.includes('text: appendSegment(m.text'), 'text is no longer folded into one bubble');
  // A mid-turn proposal card must keep the trailing streaming placeholder last, so the next
  // sealed bubble lands after the card (matching reload's ts sort). Pin the insertion shape.
  assert.ok(src.includes('rs.slice(0, -1), card, last'), 'a card inserts before the trailing streaming placeholder');
  // The trailing-bubble cleanup counts only COMPLETED tools toward "non-empty", matching the
  // route's flush (a started-only interrupted tool must not keep a stuck-spinner bubble that
  // reload would drop). Pin so a regression back to `tools.length` fails here.
  assert.ok(src.includes('const hasCompletedTool = (r.tools ?? []).some((t) => t.status ===') , 'cleanup counts only completed tools');
});

// ---- store round-trip: the strip-trap and legacy back-compat ----

test('strip-trap: thinking + tools survive a persist/load round-trip', () => {
  const store = new AssistantStore();
  const convId = 'ac-striptrap-01';
  store.appendTurn(convId, { role: 'assistant', text: 'answer', thinking: 'r1\n\nr2', tools: ['a.x', 'a.y'], ts: '2026-01-01T00:00:00.000Z' });
  const [turn] = store.getConversation(convId);
  assert.equal(turn?.text, 'answer');
  assert.equal(turn?.thinking, 'r1\n\nr2', 'thinking is not stripped by the schema on load');
  assert.deepEqual(turn?.tools, ['a.x', 'a.y'], 'tools are not stripped by the schema on load');
});

test('back-compat: a legacy {role,text,ts} line still parses, with thinking/tools undefined', () => {
  const convId = 'ac-legacy-01';
  const file = join(home, 'assistant', `${convId}.jsonl`);
  appendFileSync(file, JSON.stringify({ role: 'assistant', text: 'old folded answer', ts: '2025-12-01T00:00:00.000Z' }) + '\n', 'utf8');
  const store = new AssistantStore();
  const [turn] = store.getConversation(convId);
  assert.equal(turn?.text, 'old folded answer');
  assert.equal(turn?.thinking, undefined);
  assert.equal(turn?.tools, undefined);
});

// ---- the route persists one turn PER agent_message, with preceding reasoning as thinking ----

test('agent_message → reasoning → agent_message persists as two bubbles, thinking on the second', async () => {
  // Captured JSONL shapes the provider maps (codex-events.ts): a whole agent_message, then a
  // reasoning summary, then another agent_message, then turn.completed.
  fakeCodex([
    '{"type":"item.completed","item":{"type":"agent_message","text":"a"}}',
    '{"type":"item.completed","item":{"type":"reasoning","text":"r2"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"b"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ]);
  const { app, port, store } = await startApp();
  try {
    const { status, convId, sse } = await postMessage(port, { text: 'two-part question' });
    assert.equal(status, 200);
    assert.ok(convId, 'the stream advertises the minted conversation id');

    // The WIRE stays per-item (the dock renders each live)…
    assert.ok(sse.includes('"delta":"a"'), 'first message streamed');
    assert.ok(sse.includes('"delta":"r2"'), 'reasoning streamed');
    assert.ok(sse.includes('"delta":"b"'), 'second message streamed');

    // …and the TRANSCRIPT is one turn PER agent_message (not one folded turn).
    const turns = store.getConversation(convId!);
    assert.equal(turns.length, 3, 'user turn + two assistant bubbles');
    assert.equal(turns[0]?.role, 'user');
    assert.equal(turns[1]?.role, 'assistant');
    assert.equal(turns[1]?.text, 'a');
    assert.equal(turns[1]?.thinking, undefined, 'no reasoning preceded the first message');
    assert.equal(turns[2]?.text, 'b');
    assert.equal(turns[2]?.thinking, 'r2', 'the reasoning between the messages attaches to the bubble it precedes');
    assert.ok(turns[1]?.ts && turns[2]?.ts && turns[1].ts <= turns[2].ts, 'each bubble carries an arrival ts, in order');
  } finally {
    await app.close(); // even a failed assert must not leave the handle pinning the child
  }
});

test('a whitespace-only agent_message does not seal a blank bubble', async () => {
  fakeCodex([
    '{"type":"item.completed","item":{"type":"agent_message","text":"real"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"   "}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ]);
  const { app, port, store } = await startApp();
  try {
    const { convId } = await postMessage(port, { text: 'q' });
    const turns = store.getConversation(convId!);
    assert.equal(turns.length, 2, 'user turn + one real bubble; the blank message is skipped');
    assert.equal(turns[1]?.text, 'real');
  } finally {
    await app.close();
  }
});

// ---- a trailing thinking-only turn persists for reload, but is kept OUT of brain history ----

test('a trailing thinking-only turn persists (text:"") yet never replays to the brain', async () => {
  const countFile = join(home, 'hf-count');
  const captureFile = join(home, 'hf-last-prompt');
  // Stateful fake: call 0 emits reasoning only (→ a trailing thinking-only turn); call 1 captures
  // the prompt it receives (built from history) and answers. Absolute paths baked in — CT_HOME is
  // not guaranteed in the child env.
  writeFileSync(
    join(binDir, 'codex'),
    [
      '#!/bin/sh',
      `n=$(cat '${countFile}' 2>/dev/null || echo 0)`,
      `echo $((n+1)) > '${countFile}'`,
      `cat > '${captureFile}'`,
      'if [ "$n" = "0" ]; then',
      `  printf '%s\\n' '{"type":"item.completed","item":{"type":"reasoning","text":"solo-think-marker"}}'`,
      'else',
      `  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'`,
      'fi',
      `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const { app, port, store } = await startApp();
  try {
    const first = await postMessage(port, { text: 'think-only please' });
    const convId = first.convId!;
    // The thinking-only bubble is persisted for reload parity (text:'' + thinking).
    const afterFirst = store.getConversation(convId);
    const thinkTurn = afterFirst.find((t) => t.role === 'assistant');
    assert.equal(thinkTurn?.text, '', 'the trailing thinking-only bubble persists with empty text');
    assert.equal(thinkTurn?.thinking, 'solo-think-marker');

    // Second turn on the SAME conversation: the prompt the brain receives is built from history.
    await postMessage(port, { text: 'second question', conversationId: convId });
    const prompt = readFileSync(captureFile, 'utf8');
    assert.ok(!prompt.includes('solo-think-marker'), 'thinking is never replayed to the brain');
    assert.ok(!/Assistant:\s*(\n|$)/.test(prompt), 'no bare "Assistant:" line for the empty-text turn');
    assert.ok(prompt.includes('think-only please'), 'the real user turn IS in the replayed history');
  } finally {
    await app.close();
  }
});
