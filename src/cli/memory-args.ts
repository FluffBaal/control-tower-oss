// SPEC-MEMORY — argument parsing for `towerctl memory`, plus the network-retry policy its idempotent
// verbs use. Kept free of I/O (no fetch, no process.exit; stdin/file/uuid are injectable) so every verb's
// argv → wire-request mapping is unit-testable against the shared types in src/shared/memory.ts. The
// requestId for add/consolidate is minted HERE, once per parse, so a retried POST reuses the same key and
// the store's idempotency dedups it instead of creating a duplicate entry.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  MemoryAddRequest,
  MemoryConsolidateRequest,
  MemoryEvidence,
  MemoryKind,
  MemorySearchQuery,
  MemoryUpdateRequest,
} from '../shared/memory.js';
import { MEMORY_FILES, MEMORY_KINDS, viewFileFor } from '../shared/memory.js';

export type MemoryCommand =
  | { verb: 'read'; file?: string }
  | { verb: 'search'; query: MemorySearchQuery }
  | { verb: 'add'; request: MemoryAddRequest }
  | { verb: 'update'; request: MemoryUpdateRequest }
  | { verb: 'dispute'; request: MemoryUpdateRequest }
  | { verb: 'retract'; request: MemoryUpdateRequest }
  | { verb: 'evidence'; request: MemoryUpdateRequest }
  | { verb: 'consolidate'; request: MemoryConsolidateRequest };

/** A parse failure — the caller prints `error` + the verb's usage and exits 2. */
export interface MemoryArgsError {
  error: string;
}

export type MemoryParse = MemoryCommand | MemoryArgsError;

/** The side effects a parse may need, injectable for tests. */
export interface MemoryArgsIo {
  readStdin: () => string;
  readFile: (path: string) => string;
  uuid: () => string;
}

const DEFAULT_IO: MemoryArgsIo = {
  readStdin: () => readFileSync(0, 'utf8'), // fd 0 = stdin
  readFile: (p) => readFileSync(p, 'utf8'),
  uuid: () => randomUUID(),
};

const KIND_LIST = MEMORY_KINDS.join('|');
const EVIDENCE_FORMS = 'spec:<ref> | code:<path>[:<line>] | test:<runId>:pass|fail | link:<url>';

const USAGE: Record<MemoryCommand['verb'], string> = {
  read: 'towerctl memory read [decisions|gotchas|glossary]',
  search: `towerctl memory search [<text>] [--kind ${KIND_LIST}]`,
  add: `towerctl memory add --kind ${KIND_LIST} (--body "<text>" | --file <path|->) [--scope project|run] [--evidence <token>]...\n  evidence token: ${EVIDENCE_FORMS}`,
  update: 'towerctl memory update <id> --rev <n> (--body "<text>" | --file <path|->)',
  dispute: 'towerctl memory dispute <id> --rev <n>',
  retract: 'towerctl memory retract <id> --rev <n>',
  evidence: `towerctl memory evidence <id> --rev <n> --evidence <token>...\n  evidence token: ${EVIDENCE_FORMS}`,
  consolidate: `towerctl memory consolidate --kind ${KIND_LIST} (--body "<text>" | --file <path|->) --sources <id:rev,id:rev,...>`,
};

const VERBS = Object.keys(USAGE) as MemoryCommand['verb'][];

/** Usage text for one verb, or the whole verb list when the verb is unknown/omitted. */
export function memoryUsage(verb?: string): string {
  if (verb && verb in USAGE) return `usage: ${USAGE[verb as MemoryCommand['verb']]}`;
  return `usage: towerctl memory <${VERBS.join('|')}>\n${VERBS.map((v) => `  ${USAGE[v]}`).join('\n')}`;
}

// ---- flag tokenizer --------------------------------------------------------------------------------

interface Tokens {
  positionals: string[];
  /** Every occurrence of each flag, in order — repeatable flags read the whole list, others the last. */
  flags: Map<string, string[]>;
}

/** `--name value` pairs (the value is the next arg, whatever its shape — a body may start with a dash)
 *  plus bare positionals. An unknown flag or a flag with no value is an error. */
function tokenize(args: string[], allowed: readonly string[]): Tokens | MemoryArgsError {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const name = a.slice(2);
    if (!allowed.includes(name)) return { error: `unknown flag --${name}` };
    if (i + 1 >= args.length) return { error: `--${name} needs a value` };
    const list = flags.get(name) ?? [];
    list.push(args[++i]!);
    flags.set(name, list);
  }
  return { positionals, flags };
}

function last(t: Tokens, name: string): string | undefined {
  const l = t.flags.get(name);
  return l ? l[l.length - 1] : undefined;
}

function isKind(s: string): s is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(s);
}

function parseKind(t: Tokens, required: boolean): MemoryKind | undefined | MemoryArgsError {
  const k = last(t, 'kind');
  if (k === undefined) return required ? { error: `--kind is required (${KIND_LIST})` } : undefined;
  if (!isKind(k)) return { error: `unknown kind "${k}" — expected ${KIND_LIST}` };
  return k;
}

/** A non-negative integer revision. */
function parseRev(t: Tokens): number | MemoryArgsError {
  const raw = last(t, 'rev');
  if (raw === undefined) return { error: '--rev <n> is required — the entry revision you read' };
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) return { error: `--rev must be a non-negative integer, got "${raw}"` };
  return n;
}

/** Exactly one of --body / --file; `--file -` is stdin. An empty body is refused (the store would too). */
function parseBody(t: Tokens, io: MemoryArgsIo): string | MemoryArgsError {
  const body = last(t, 'body');
  const file = last(t, 'file');
  if (body !== undefined && file !== undefined) return { error: 'give --body or --file, not both' };
  if (body === undefined && file === undefined) return { error: 'a body is required: --body "<text>" or --file <path|->' };
  let text: string;
  if (body !== undefined) {
    text = body;
  } else {
    try {
      text = file === '-' ? io.readStdin() : io.readFile(file!);
    } catch (e) {
      return { error: `could not read ${file === '-' ? 'stdin' : file}: ${(e as Error).message}` };
    }
  }
  if (!text.trim()) return { error: 'body is empty' };
  return text;
}

function isError(v: unknown): v is MemoryArgsError {
  return typeof v === 'object' && v !== null && 'error' in v && typeof (v as MemoryArgsError).error === 'string';
}

// ---- evidence tokens -------------------------------------------------------------------------------

/**
 * One `--evidence` token → a MemoryEvidence item. Forms: `spec:<ref>`, `code:<path>[:<line>]` (a trailing
 * all-digit segment is the line), `test:<runId>:pass|fail` (the runId may be omitted), `link:<url>` (split
 * on the FIRST colon only, since URLs carry their own). `operator:` is refused up front — that type is the
 * operator's own word and the store rejects it from an agent anyway.
 */
export function parseEvidenceToken(token: string): MemoryEvidence | MemoryArgsError {
  const sep = token.indexOf(':');
  if (sep <= 0) return { error: `evidence "${token}" needs a type prefix: ${EVIDENCE_FORMS}` };
  const type = token.slice(0, sep);
  const rest = token.slice(sep + 1);
  switch (type) {
    case 'spec':
      if (!rest) return { error: 'spec evidence needs a reference: spec:<ref>' };
      return { type: 'spec', ref: rest };
    case 'link':
      if (!rest) return { error: 'link evidence needs a url: link:<url>' };
      return { type: 'link', url: rest };
    case 'code': {
      if (!rest) return { error: 'code evidence needs a path: code:<path>[:<line>]' };
      const m = rest.match(/^(.+):(\d+)$/);
      if (m) return { type: 'code', path: m[1]!, line: Number(m[2]) };
      return { type: 'code', path: rest };
    }
    case 'test': {
      const parts = rest.split(':');
      const verdict = parts[parts.length - 1];
      if (verdict !== 'pass' && verdict !== 'fail') return { error: `test evidence ends in pass|fail: test:<runId>:pass|fail (got "${token}")` };
      const runId = parts.slice(0, -1).join(':');
      return runId ? { type: 'test', runId, verdict } : { type: 'test', verdict };
    }
    case 'operator':
      return { error: 'operator evidence is the operator\'s own attestation and cannot be attached from a terminal' };
    default:
      return { error: `unknown evidence type "${type}": ${EVIDENCE_FORMS}` };
  }
}

function parseEvidenceList(t: Tokens): MemoryEvidence[] | undefined | MemoryArgsError {
  const tokens = t.flags.get('evidence');
  if (!tokens) return undefined;
  const out: MemoryEvidence[] = [];
  for (const tok of tokens) {
    const ev = parseEvidenceToken(tok);
    if (isError(ev)) return ev;
    out.push(ev);
  }
  return out;
}

/** `id:rev,id:rev,...` → consolidate sources. */
function parseSources(raw: string | undefined): { id: string; rev: number }[] | MemoryArgsError {
  if (raw === undefined) return { error: '--sources <id:rev,id:rev,...> is required' };
  const out: { id: string; rev: number }[] = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(.+):(\d+)$/);
    if (!m) return { error: `source "${part}" must be <id>:<rev>` };
    out.push({ id: m[1]!, rev: Number(m[2]) });
  }
  if (out.length === 0) return { error: '--sources needs at least one <id>:<rev>' };
  return out;
}

/** `decisions` / `decisions.md` / `decision` → the view filename the read route expects. */
function parseViewFile(raw: string | undefined): string | undefined | MemoryArgsError {
  if (raw === undefined) return undefined;
  if (MEMORY_FILES.includes(raw)) return raw;
  if (MEMORY_FILES.includes(`${raw}.md`)) return `${raw}.md`;
  if (isKind(raw)) return viewFileFor(raw);
  return { error: `unknown memory view "${raw}" — expected ${MEMORY_FILES.map((f) => f.replace(/\.md$/, '')).join('|')}` };
}

// ---- per-verb parsers ------------------------------------------------------------------------------

/**
 * Parse the argv AFTER `towerctl memory` (verb first). Returns the verb's exact wire request, or an
 * {error} the caller turns into a usage message + exit 2. Never throws for user input.
 */
export function parseMemoryArgs(argv: readonly string[], io: Partial<MemoryArgsIo> = {}): MemoryParse {
  const ioc: MemoryArgsIo = { ...DEFAULT_IO, ...io };
  const [verb, ...rest] = argv;
  switch (verb) {
    case 'read': {
      const t = tokenize(rest, []);
      if (isError(t)) return t;
      if (t.positionals.length > 1) return { error: 'read takes at most one view name' };
      const file = parseViewFile(t.positionals[0]);
      if (isError(file)) return file;
      return file === undefined ? { verb: 'read' } : { verb: 'read', file };
    }
    case 'search': {
      const t = tokenize(rest, ['kind']);
      if (isError(t)) return t;
      if (t.positionals.length > 1) return { error: 'search takes one query text — quote it if it has spaces' };
      const kind = parseKind(t, false);
      if (isError(kind)) return kind;
      const q = t.positionals[0];
      return { verb: 'search', query: { ...(q ? { q } : {}), ...(kind ? { kind } : {}) } };
    }
    case 'add': {
      const t = tokenize(rest, ['kind', 'body', 'file', 'scope', 'evidence']);
      if (isError(t)) return t;
      if (t.positionals.length) return { error: `unexpected argument "${t.positionals[0]}" — the text goes in --body` };
      const kind = parseKind(t, true);
      if (isError(kind)) return kind;
      const body = parseBody(t, ioc);
      if (isError(body)) return body;
      const scope = last(t, 'scope');
      if (scope !== undefined && scope !== 'project' && scope !== 'run') return { error: `--scope must be project or run, got "${scope}"` };
      const evidence = parseEvidenceList(t);
      if (isError(evidence)) return evidence;
      const request: MemoryAddRequest = {
        requestId: ioc.uuid(),
        kind: kind!,
        body,
        ...(scope ? { scope } : {}),
        ...(evidence ? { evidence } : {}),
      };
      return { verb: 'add', request };
    }
    case 'update': {
      const t = tokenize(rest, ['rev', 'body', 'file']);
      if (isError(t)) return t;
      const id = oneId(t);
      if (isError(id)) return id;
      const rev = parseRev(t);
      if (isError(rev)) return rev;
      const body = parseBody(t, ioc);
      if (isError(body)) return body;
      return { verb: 'update', request: { id, rev, body } };
    }
    case 'dispute': {
      if (rest.includes('--note')) return { error: 'dispute takes no --note — record the reason as a gotcha entry instead' };
      const t = tokenize(rest, ['rev']);
      if (isError(t)) return t;
      const id = oneId(t);
      if (isError(id)) return id;
      const rev = parseRev(t);
      if (isError(rev)) return rev;
      return { verb: 'dispute', request: { id, rev, verification: 'disputed' } };
    }
    case 'retract': {
      const t = tokenize(rest, ['rev']);
      if (isError(t)) return t;
      const id = oneId(t);
      if (isError(id)) return id;
      const rev = parseRev(t);
      if (isError(rev)) return rev;
      return { verb: 'retract', request: { id, rev, lifecycle: 'retracted' } };
    }
    case 'evidence': {
      const t = tokenize(rest, ['rev', 'evidence']);
      if (isError(t)) return t;
      const id = oneId(t);
      if (isError(id)) return id;
      const rev = parseRev(t);
      if (isError(rev)) return rev;
      const evidence = parseEvidenceList(t);
      if (isError(evidence)) return evidence;
      if (!evidence || evidence.length === 0) return { error: `at least one --evidence <token> is required: ${EVIDENCE_FORMS}` };
      return { verb: 'evidence', request: { id, rev, evidence } };
    }
    case 'consolidate': {
      const t = tokenize(rest, ['kind', 'body', 'file', 'sources']);
      if (isError(t)) return t;
      if (t.positionals.length) return { error: `unexpected argument "${t.positionals[0]}"` };
      const kind = parseKind(t, true);
      if (isError(kind)) return kind;
      const body = parseBody(t, ioc);
      if (isError(body)) return body;
      const sources = parseSources(last(t, 'sources'));
      if (isError(sources)) return sources;
      return { verb: 'consolidate', request: { requestId: ioc.uuid(), kind: kind!, body, sources } };
    }
    default:
      return { error: verb ? `unknown memory verb "${verb}"` : 'a verb is required' };
  }
}

/** The single `<id>` positional the edit verbs take. */
function oneId(t: Tokens): string | MemoryArgsError {
  if (t.positionals.length !== 1) return { error: t.positionals.length === 0 ? 'an entry <id> is required' : 'exactly one entry <id> is expected' };
  return t.positionals[0]!;
}

// ---- retry policy ----------------------------------------------------------------------------------

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** A failure to REACH the Tower (fetch's TypeError, or a socket-level code on the error or its cause) —
 *  as opposed to an HTTP response of any status, which fetch returns rather than throws. */
export function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const code = (e as { code?: unknown } | null)?.code ?? (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && NETWORK_CODES.has(code);
}

export interface RetryOptions {
  attempts?: number;
  /** Pause before attempt n (n >= 2); default 250ms · (n-1). */
  delayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `attempt` up to `attempts` times, retrying ONLY on a network error (see isNetworkError). Anything
 * else — including a resolved 4xx/5xx the caller turns into a throw — propagates on the first occurrence.
 * The caller is expected to pass the SAME request object each time, so an idempotent add/consolidate
 * reuses its requestId.
 */
export async function retryOnNetworkError<T>(attempt: (n: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? ((n) => 250 * (n - 1));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let n = 1; n <= attempts; n++) {
    if (n > 1) await sleep(delayMs(n));
    try {
      return await attempt(n);
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}
