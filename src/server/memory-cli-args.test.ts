// SPEC-MEMORY — `towerctl memory` argv → wire-request parsing (src/cli/memory-args.ts) and its
// network-retry policy. Lives under src/server/ because test discovery is non-recursive
// (`src/server/*.test.ts`); the module under test is the CLI's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryArgs, parseEvidenceToken, memoryUsage, retryOnNetworkError, isNetworkError } from '../cli/memory-args.js';
import type { MemoryAddRequest, MemoryConsolidateRequest } from '../shared/memory.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fixedUuid = () => '11111111-2222-4333-8444-555555555555';
const noStdin = () => {
  throw new Error('stdin must not be read');
};
const noFile = () => {
  throw new Error('no file must be read');
};
const io = { uuid: fixedUuid, readStdin: noStdin, readFile: noFile };

function errorOf(r: ReturnType<typeof parseMemoryArgs>): string {
  assert.ok('error' in r, `expected an error result, got ${JSON.stringify(r)}`);
  return r.error;
}

// ---- read ------------------------------------------------------------------------------------------

test('read: no view → all views; a bare, .md, or kind name resolves to the view file', () => {
  assert.deepEqual(parseMemoryArgs(['read'], io), { verb: 'read' });
  assert.deepEqual(parseMemoryArgs(['read', 'decisions'], io), { verb: 'read', file: 'decisions.md' });
  assert.deepEqual(parseMemoryArgs(['read', 'gotchas.md'], io), { verb: 'read', file: 'gotchas.md' });
  assert.deepEqual(parseMemoryArgs(['read', 'glossary'], io), { verb: 'read', file: 'glossary.md' });
  assert.deepEqual(parseMemoryArgs(['read', 'decision'], io), { verb: 'read', file: 'decisions.md' });
});

test('read: an unknown view name is an error', () => {
  assert.match(errorOf(parseMemoryArgs(['read', 'notes'], io)), /unknown memory view "notes"/);
  assert.match(errorOf(parseMemoryArgs(['read', 'a', 'b'], io)), /at most one/);
});

// ---- search ----------------------------------------------------------------------------------------

test('search: text + --kind → MemorySearchQuery with only the given fields', () => {
  assert.deepEqual(parseMemoryArgs(['search', 'tmux', '--kind', 'gotcha'], io), { verb: 'search', query: { q: 'tmux', kind: 'gotcha' } });
  assert.deepEqual(parseMemoryArgs(['search', 'tmux'], io), { verb: 'search', query: { q: 'tmux' } });
  assert.deepEqual(parseMemoryArgs(['search', '--kind', 'decision'], io), { verb: 'search', query: { kind: 'decision' } });
  assert.deepEqual(parseMemoryArgs(['search'], io), { verb: 'search', query: {} });
});

test('search: a bad kind or an unknown flag is an error', () => {
  assert.match(errorOf(parseMemoryArgs(['search', 'x', '--kind', 'gotchas'], io)), /unknown kind "gotchas"/);
  assert.match(errorOf(parseMemoryArgs(['search', 'x', '--lifecycle', 'active'], io)), /unknown flag --lifecycle/);
  assert.match(errorOf(parseMemoryArgs(['search', 'two', 'words'], io)), /one query text/);
});

// ---- add -------------------------------------------------------------------------------------------

test('add: full form → exact MemoryAddRequest with a minted requestId', () => {
  const r = parseMemoryArgs(
    ['add', '--kind', 'decision', '--body', 'rotate by accountUuid', '--scope', 'project', '--evidence', 'spec:SPEC-RUNWAY §3', '--evidence', 'code:src/server/runway.ts:42'],
    io,
  );
  const expected: MemoryAddRequest = {
    requestId: fixedUuid(),
    kind: 'decision',
    body: 'rotate by accountUuid',
    scope: 'project',
    evidence: [
      { type: 'spec', ref: 'SPEC-RUNWAY §3' },
      { type: 'code', path: 'src/server/runway.ts', line: 42 },
    ],
  };
  assert.deepEqual(r, { verb: 'add', request: expected });
});

test('add: minimal form omits scope and evidence entirely (no undefined keys on the wire)', () => {
  const r = parseMemoryArgs(['add', '--kind', 'gotcha', '--body', 'a restart rotates the session token'], io);
  assert.deepEqual(r, { verb: 'add', request: { requestId: fixedUuid(), kind: 'gotcha', body: 'a restart rotates the session token' } });
  assert.ok(!('scope' in (r as { request: object }).request));
  assert.ok(!('evidence' in (r as { request: object }).request));
});

test('add: --file - reads the body from stdin; --file <path> reads the file', () => {
  const r = parseMemoryArgs(['add', '--kind', 'glossary', '--file', '-'], { ...io, readStdin: () => 'belt = one account in the ring\n' });
  assert.deepEqual(r, { verb: 'add', request: { requestId: fixedUuid(), kind: 'glossary', body: 'belt = one account in the ring\n' } });
  const seen: string[] = [];
  const f = parseMemoryArgs(['add', '--kind', 'glossary', '--file', '/tmp/note.md'], {
    ...io,
    readFile: (p) => {
      seen.push(p);
      return 'from a file';
    },
  });
  assert.deepEqual(seen, ['/tmp/note.md']);
  assert.equal((f as { request: MemoryAddRequest }).request.body, 'from a file');
});

test('add: an unreadable --file is an error, not a throw', () => {
  const r = parseMemoryArgs(['add', '--kind', 'gotcha', '--file', '/nope'], {
    ...io,
    readFile: () => {
      throw new Error('ENOENT: no such file');
    },
  });
  assert.match(errorOf(r), /could not read \/nope: ENOENT/);
});

test('add: without --kind is an error (exit-2 shape), as are the body mistakes', () => {
  const r = parseMemoryArgs(['add', '--body', 'x'], io);
  assert.deepEqual(Object.keys(r), ['error']);
  assert.match(errorOf(r), /--kind is required \(decision\|gotcha\|glossary\)/);
  assert.match(errorOf(parseMemoryArgs(['add', '--kind', 'gotcha'], io)), /a body is required/);
  assert.match(errorOf(parseMemoryArgs(['add', '--kind', 'gotcha', '--body', 'a', '--file', '-'], io)), /not both/);
  assert.match(errorOf(parseMemoryArgs(['add', '--kind', 'gotcha', '--body', '   '], io)), /body is empty/);
  assert.match(errorOf(parseMemoryArgs(['add', '--kind', 'gotcha', '--body'], io)), /--body needs a value/);
  assert.match(errorOf(parseMemoryArgs(['add', '--kind', 'gotcha', '--body', 'x', '--scope', 'global'], io)), /--scope must be project or run/);
  assert.match(errorOf(parseMemoryArgs(['add', 'stray', '--kind', 'gotcha', '--body', 'x'], io)), /unexpected argument "stray"/);
  assert.match(errorOf(parseMemoryArgs(['add', '--kind', 'gotcha', '--body', 'x', '--evidence', 'bogus'], io)), /needs a type prefix/);
});

test('add: a body value that starts with a dash is still a value, not a flag', () => {
  const r = parseMemoryArgs(['add', '--kind', 'gotcha', '--body', '--reporter=json is forced by the config'], io);
  assert.equal((r as { request: MemoryAddRequest }).request.body, '--reporter=json is forced by the config');
});

// ---- evidence tokens -------------------------------------------------------------------------------

test('evidence tokens: all four agent-attachable forms parse to the MemoryEvidence union', () => {
  assert.deepEqual(parseEvidenceToken('spec:SPEC-MEMORY §4.2'), { type: 'spec', ref: 'SPEC-MEMORY §4.2' });
  assert.deepEqual(parseEvidenceToken('code:src/server/memory/store.ts'), { type: 'code', path: 'src/server/memory/store.ts' });
  assert.deepEqual(parseEvidenceToken('code:src/server/memory/store.ts:466'), { type: 'code', path: 'src/server/memory/store.ts', line: 466 });
  assert.deepEqual(parseEvidenceToken('test:run-7f3a:pass'), { type: 'test', runId: 'run-7f3a', verdict: 'pass' });
  assert.deepEqual(parseEvidenceToken('test:run-7f3a:fail'), { type: 'test', runId: 'run-7f3a', verdict: 'fail' });
  assert.deepEqual(parseEvidenceToken('test:pass'), { type: 'test', verdict: 'pass' });
  assert.deepEqual(parseEvidenceToken('link:https://example.test/a?b=c:d'), { type: 'link', url: 'https://example.test/a?b=c:d' });
});

test('evidence tokens: a path whose last segment is not a line number stays whole', () => {
  assert.deepEqual(parseEvidenceToken('code:src/a.ts:L12'), { type: 'code', path: 'src/a.ts:L12' });
});

test('evidence tokens: operator, unknown, and malformed forms are errors', () => {
  assert.match((parseEvidenceToken('operator:looks right') as { error: string }).error, /cannot be attached from a terminal/);
  assert.match((parseEvidenceToken('doc:foo') as { error: string }).error, /unknown evidence type "doc"/);
  assert.match((parseEvidenceToken('spec:') as { error: string }).error, /needs a reference/);
  assert.match((parseEvidenceToken('link:') as { error: string }).error, /needs a url/);
  assert.match((parseEvidenceToken('code:') as { error: string }).error, /needs a path/);
  assert.match((parseEvidenceToken('test:run-1:maybe') as { error: string }).error, /ends in pass\|fail/);
  assert.match((parseEvidenceToken('nocolon') as { error: string }).error, /needs a type prefix/);
  assert.match((parseEvidenceToken(':x') as { error: string }).error, /needs a type prefix/);
});

// ---- update / dispute / retract / evidence ---------------------------------------------------------

test('update: id + --rev + --body → exact MemoryUpdateRequest', () => {
  assert.deepEqual(parseMemoryArgs(['update', 'e1', '--rev', '3', '--body', 'new text'], io), { verb: 'update', request: { id: 'e1', rev: 3, body: 'new text' } });
});

test('update: --file - reads stdin', () => {
  const r = parseMemoryArgs(['update', 'e1', '--rev', '0', '--file', '-'], { ...io, readStdin: () => 'from stdin' });
  assert.deepEqual(r, { verb: 'update', request: { id: 'e1', rev: 0, body: 'from stdin' } });
});

test('update: missing id, missing/bad --rev, or missing body are errors', () => {
  assert.match(errorOf(parseMemoryArgs(['update', '--rev', '1', '--body', 'x'], io)), /an entry <id> is required/);
  assert.match(errorOf(parseMemoryArgs(['update', 'e1', 'e2', '--rev', '1', '--body', 'x'], io)), /exactly one entry <id>/);
  assert.match(errorOf(parseMemoryArgs(['update', 'e1', '--body', 'x'], io)), /--rev <n> is required/);
  assert.match(errorOf(parseMemoryArgs(['update', 'e1', '--rev', 'abc', '--body', 'x'], io)), /non-negative integer, got "abc"/);
  assert.match(errorOf(parseMemoryArgs(['update', 'e1', '--rev', '-1', '--body', 'x'], io)), /non-negative integer, got "-1"/);
  assert.match(errorOf(parseMemoryArgs(['update', 'e1', '--rev', '1.5', '--body', 'x'], io)), /non-negative integer/);
  assert.match(errorOf(parseMemoryArgs(['update', 'e1', '--rev', '1'], io)), /a body is required/);
});

test('dispute: → {id, rev, verification: disputed} and nothing else; --note is refused', () => {
  assert.deepEqual(parseMemoryArgs(['dispute', 'e1', '--rev', '2'], io), { verb: 'dispute', request: { id: 'e1', rev: 2, verification: 'disputed' } });
  assert.match(errorOf(parseMemoryArgs(['dispute', 'e1', '--rev', '2', '--note', 'why'], io)), /takes no --note/);
  assert.match(errorOf(parseMemoryArgs(['dispute', 'e1'], io)), /--rev <n> is required/);
});

test('retract: → {id, rev, lifecycle: retracted}', () => {
  assert.deepEqual(parseMemoryArgs(['retract', 'e1', '--rev', '5'], io), { verb: 'retract', request: { id: 'e1', rev: 5, lifecycle: 'retracted' } });
  assert.match(errorOf(parseMemoryArgs(['retract', 'e1', '--rev', '5', '--body', 'x'], io)), /unknown flag --body/);
});

test('evidence: → {id, rev, evidence: [...]} in token order; at least one token required', () => {
  const r = parseMemoryArgs(['evidence', 'e1', '--rev', '1', '--evidence', 'test:run-9:pass', '--evidence', 'link:https://x.test/'], io);
  assert.deepEqual(r, {
    verb: 'evidence',
    request: {
      id: 'e1',
      rev: 1,
      evidence: [
        { type: 'test', runId: 'run-9', verdict: 'pass' },
        { type: 'link', url: 'https://x.test/' },
      ],
    },
  });
  assert.match(errorOf(parseMemoryArgs(['evidence', 'e1', '--rev', '1'], io)), /at least one --evidence/);
  assert.match(errorOf(parseMemoryArgs(['evidence', 'e1', '--rev', '1', '--evidence', 'operator:ok'], io)), /cannot be attached from a terminal/);
});

// ---- consolidate -----------------------------------------------------------------------------------

test('consolidate: → exact MemoryConsolidateRequest with parsed sources and a minted requestId', () => {
  const r = parseMemoryArgs(['consolidate', '--kind', 'gotcha', '--body', 'both restarts rotate the token', '--sources', 'a1:2, b2:0,c3:7'], io);
  const expected: MemoryConsolidateRequest = {
    requestId: fixedUuid(),
    kind: 'gotcha',
    body: 'both restarts rotate the token',
    sources: [
      { id: 'a1', rev: 2 },
      { id: 'b2', rev: 0 },
      { id: 'c3', rev: 7 },
    ],
  };
  assert.deepEqual(r, { verb: 'consolidate', request: expected });
});

test('consolidate: missing or malformed --sources, missing --kind, are errors', () => {
  assert.match(errorOf(parseMemoryArgs(['consolidate', '--kind', 'gotcha', '--body', 'x'], io)), /--sources <id:rev,id:rev,...> is required/);
  assert.match(errorOf(parseMemoryArgs(['consolidate', '--kind', 'gotcha', '--body', 'x', '--sources', 'a1'], io)), /source "a1" must be <id>:<rev>/);
  assert.match(errorOf(parseMemoryArgs(['consolidate', '--kind', 'gotcha', '--body', 'x', '--sources', 'a1:x'], io)), /must be <id>:<rev>/);
  assert.match(errorOf(parseMemoryArgs(['consolidate', '--kind', 'gotcha', '--body', 'x', '--sources', ' , '], io)), /at least one/);
  assert.match(errorOf(parseMemoryArgs(['consolidate', '--body', 'x', '--sources', 'a:1'], io)), /--kind is required/);
});

// ---- write (removed) / verbs / usage ---------------------------------------------------------------

test('write: hard-removed — falls through to the unknown-verb error, and never advertised in usage', () => {
  const err = errorOf(parseMemoryArgs(['write', 'gotchas.md', 'full text'], io));
  assert.match(err, /unknown memory verb "write"/);
  assert.ok(!memoryUsage().includes('towerctl memory write'), 'usage no longer lists write');
});

test('an unknown or missing verb is an error, and usage covers every remaining verb', () => {
  assert.match(errorOf(parseMemoryArgs(['note', 'x'], io)), /unknown memory verb "note"/);
  assert.match(errorOf(parseMemoryArgs([], io)), /a verb is required/);
  const all = memoryUsage();
  for (const v of ['read', 'search', 'add', 'update', 'dispute', 'retract', 'evidence', 'consolidate']) {
    assert.ok(all.includes(`towerctl memory ${v}`), `usage lists ${v}`);
    assert.ok(memoryUsage(v).startsWith(`usage: towerctl memory ${v}`));
  }
  assert.ok(memoryUsage('bogus').startsWith('usage: towerctl memory <'));
});

// ---- requestId + retry -----------------------------------------------------------------------------

test('requestId: the default minter yields a v4 uuid, distinct per parse', () => {
  const a = parseMemoryArgs(['add', '--kind', 'gotcha', '--body', 'x']) as { request: MemoryAddRequest };
  const b = parseMemoryArgs(['add', '--kind', 'gotcha', '--body', 'x']) as { request: MemoryAddRequest };
  assert.match(a.request.requestId, UUID_RE);
  assert.match(b.request.requestId, UUID_RE);
  assert.notEqual(a.request.requestId, b.request.requestId);
  const c = parseMemoryArgs(['consolidate', '--kind', 'gotcha', '--body', 'x', '--sources', 'a:1']) as { request: MemoryConsolidateRequest };
  assert.match(c.request.requestId, UUID_RE);
});

function connRefused(): Error {
  // What undici's fetch throws when nothing is listening: a TypeError whose cause carries the syscall code.
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}

test('retry: a network failure is retried up to 3 times and every attempt posts the SAME requestId', async () => {
  const parsed = parseMemoryArgs(['add', '--kind', 'gotcha', '--body', 'x']) as { request: MemoryAddRequest };
  const bodies: string[] = [];
  const slept: number[] = [];
  let calls = 0;
  const res = await retryOnNetworkError(
    async () => {
      // The CLI serializes the one parsed request per attempt — model exactly that.
      bodies.push(JSON.stringify(parsed.request));
      calls++;
      if (calls < 3) throw connRefused();
      return { ok: true, status: 201 };
    },
    { sleep: async (ms) => void slept.push(ms) },
  );
  assert.deepEqual(res, { ok: true, status: 201 });
  assert.equal(calls, 3);
  const ids = bodies.map((b) => (JSON.parse(b) as MemoryAddRequest).requestId);
  assert.equal(new Set(ids).size, 1, 'the requestId is stable across the retry');
  assert.equal(ids[0], parsed.request.requestId);
  assert.deepEqual(slept, [250, 500], 'backs off before the 2nd and 3rd attempts only');
});

test('retry: gives up after 3 network failures with the last error', async () => {
  let calls = 0;
  await assert.rejects(
    retryOnNetworkError(
      async () => {
        calls++;
        throw connRefused();
      },
      { sleep: async () => {} },
    ),
    (e: unknown) => e instanceof TypeError && /fetch failed/.test((e as Error).message),
  );
  assert.equal(calls, 3);
});

test('retry: a non-network error is NOT retried (a resolved HTTP status never reaches the retry path)', async () => {
  let calls = 0;
  await assert.rejects(
    retryOnNetworkError(
      async () => {
        calls++;
        throw new Error('409 stale');
      },
      { sleep: async () => {} },
    ),
    /409 stale/,
  );
  assert.equal(calls, 1);
});

test('isNetworkError: fetch TypeError and socket codes yes; plain errors, JSON errors, and strings no', () => {
  assert.equal(isNetworkError(connRefused()), true);
  assert.equal(isNetworkError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isNetworkError(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_SOCKET' } })), true);
  assert.equal(isNetworkError(new Error('nope')), false);
  assert.equal(isNetworkError(new SyntaxError('Unexpected token')), false);
  assert.equal(isNetworkError('ECONNREFUSED'), false);
  assert.equal(isNetworkError(null), false);
});
