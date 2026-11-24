// Onboard assistant — web client (SPEC-ASSISTANT M-A1, web module).
// Mirrors api.ts: reuses its cached session token (X-Tower-Token) so both clients share
// the one /api/session bootstrap, plus a POST-SSE reader for /api/assistant/message —
// EventSource can't POST or set headers, so we read the response body stream and parse
// `data:` frames ourselves (see sseFrame in server/assistant/contracts.ts).

import type {
  AgentProfile,
  AssistantAccount,
  AssistantAction,
  AssistantConversationMeta,
  AssistantEvent,
  AssistantProposal,
  AssistantTurn,
} from '../shared/types.js';
import { tower, currentToken } from './api.js';

// ---- Card-integrity sanitizer (§6) -------------------------------------------------------------
// EVERY string a proposal card renders — each arg value, the Tower summary, any enrichment name —
// is passed through sanitizeCardText BEFORE display. Proposal content is influenced by untrusted
// sources (a poisoned log/diff/memory can steer what Jarvis proposes), so the card, not prose, is
// the containment: values render as plain TEXT NODES (never HTML, never markdown, never links) with
// CSS `white-space: pre-wrap`. React already escapes markup in a text node; this adds the part React
// does NOT do — it visibly-escapes (never silently drops) the invisible/reordering characters a
// crafted arg would use to hide, reverse, or fake a key/value row:
//   • C0/C1 + DEL control chars (TAB and LF are kept; a `\n` becomes a wrapped line under pre-wrap)
//   • Unicode bidi overrides/isolates (U+202A–202E, U+2066–2069) and directional marks
//   • zero-width chars (U+200B–200D, word joiner U+2060) and the BOM (U+FEFF)
// Each such char is shown as `<U+XXXX>` so the operator SEES that something was there. Length is
// capped and ellipsized so one giant arg can't push the risk lines or buttons off-screen.
export const CARD_MAX_LEN = 2000;

// CR is normalized to LF first (below) so a bare CR can't repaint a rendered line; it is therefore
// not in this class. TAB (U+0009) and LF (U+000A) are intentionally preserved.
const CARD_UNSAFE_CHARS =
  /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2060\u2066-\u2069\u202A-\u202E\uFEFF]/g;

export function sanitizeCardText(input: unknown): string {
  let s = typeof input === 'string' ? input : input == null ? '' : String(input);
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(CARD_UNSAFE_CHARS, (ch) => `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`);
  if (s.length > CARD_MAX_LEN) s = `${s.slice(0, CARD_MAX_LEN - 1)}…`;
  return s;
}

// ---- Full-body visible-escape (SPEC-SKILLS Phase 5b) -------------------------------------------
// The same <U+XXXX> rendering for the two surfaces that show an LLM-authored skill BODY in full —
// the promote card's diff lines and the Skills panel's drafts viewer. Those are the poison-steerable
// review surfaces, so a bidi override / zero-width run must be VISIBLE there too, but with two
// deliberate differences from sanitizeCardText: NO length cap (truncation would hide exactly the
// content under review), and \r escaped rather than normalized (a CRLF-vs-LF difference is a real,
// reviewable byte on a body). TAB and LF are preserved; React text nodes keep HTML escaped as ever.
const BODY_UNSAFE_CHARS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2060\u2066-\u2069\u202A-\u202E\uFEFF]/g;

export function escapeBodyText(input: string): string {
  return input.replace(BODY_UNSAFE_CHARS, (ch) => `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`);
}

async function token(): Promise<string> {
  return currentToken() ?? tower.bootstrapToken();
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const t = await token();
  const res = await fetch(path, {
    ...init,
    headers: {
      'X-Tower-Token': t,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`${path} -> ${res.status} ${msg}`);
  }
  return res.json() as Promise<T>;
}

export function listAssistantAccounts(): Promise<AssistantAccount[]> {
  return req<AssistantAccount[]>('/api/assistant/accounts');
}

export function createAssistantAccount(body: {
  profileId: string;
  model?: string;
  effort?: string;
  allowNoSandbox?: boolean;
  turnTimeoutSec?: number;
}): Promise<AssistantAccount> {
  // The server requires provider:'codex' (v1); the dock only ever creates codex accounts.
  return req<AssistantAccount>('/api/assistant/accounts', {
    method: 'POST',
    body: JSON.stringify({ provider: 'codex', ...body }),
  });
}

/** Edit an account's settings (model / sandbox override / turn timeout / autonomous mode).
 *  null timeout = reset. */
export function updateAssistantAccount(
  id: string,
  patch: { model?: string; effort?: string | null; allowNoSandbox?: boolean; turnTimeoutSec?: number | null; autoConfirm?: boolean },
): Promise<AssistantAccount> {
  return req<AssistantAccount>(`/api/assistant/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteAssistantAccount(id: string): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>(`/api/assistant/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function listConversations(): Promise<AssistantConversationMeta[]> {
  return req<AssistantConversationMeta[]>('/api/assistant/conversations');
}

/** One conversation's transcript. Tolerates either a bare `AssistantTurn[]` or `{ turns }`. */
export async function getConversation(id: string): Promise<AssistantTurn[]> {
  const data = await req<AssistantTurn[] | { turns: AssistantTurn[] }>(
    `/api/assistant/conversations/${encodeURIComponent(id)}`,
  );
  return Array.isArray(data) ? data : data.turns;
}

/** Codex profiles are the assistant's candidate brains (v1: mode 'cli', provider 'codex'). */
export async function listCodexProfiles(): Promise<AgentProfile[]> {
  const all = await req<AgentProfile[]>('/api/profiles');
  return all.filter((p) => p.provider === 'codex');
}

// ---- Control surface (SPEC-ASSISTANT-CONTROL §4) — propose-then-confirm proposal cards ---------

/** Pending + recently-decided proposal cards for a conversation. Used on dock reload; the client
 *  merges these into the stream by timestamp (a card's `createdAt`). Tolerates a bare array or
 *  `{ proposals }`. */
export async function getProposals(conversationId: string): Promise<AssistantProposal[]> {
  const data = await req<AssistantProposal[] | { proposals: AssistantProposal[] }>(
    `/api/assistant/proposals?conversationId=${encodeURIComponent(conversationId)}`,
  );
  return Array.isArray(data) ? data : data.proposals;
}

/** Confirm a proposal. `action` is an Edit override — the SAME kind with edited args, re-validated
 *  server-side and stored as finalAction; omit it to run the proposal exactly as shown. Resolves to
 *  the decided proposal (status executed | failed, with result | error). A 409 (already decided /
 *  expired / drifted-since-proposed) rejects with the route's error body. */
export function confirmProposal(proposalId: string, action?: AssistantAction): Promise<AssistantProposal> {
  return req<AssistantProposal>('/api/assistant/confirm', {
    method: 'POST',
    body: JSON.stringify(action ? { proposalId, action } : { proposalId }),
  });
}

/** Reject (Dismiss) a proposal. Resolves to the rejected proposal. */
export function rejectProposal(proposalId: string): Promise<AssistantProposal> {
  return req<AssistantProposal>('/api/assistant/reject', {
    method: 'POST',
    body: JSON.stringify({ proposalId }),
  });
}

/**
 * Send one turn and stream back normalized AssistantEvents.
 * POST-SSE: the response is text/event-stream; frames are `data: <json>` lines separated
 * by a blank line, one JSON AssistantEvent per data line. Resolves when the server closes
 * the stream (after `done`/`error`); rejects on HTTP failure or abort.
 */
export async function streamAssistantMessage(
  text: string,
  conversationId: string,
  onEvent: (ev: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const t = await token();
  const res = await fetch('/api/assistant/message', {
    method: 'POST',
    headers: { 'X-Tower-Token': t, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ conversationId, text }),
    signal,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`/api/assistant/message -> ${res.status} ${msg}`);
  }
  if (!res.body) throw new Error('/api/assistant/message -> empty response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const emitFrame = (frame: string) => {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue; // skip comments / event: / id: fields
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        onEvent(JSON.parse(json) as AssistantEvent);
      } catch {
        /* ignore malformed frame */
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split(/\r?\n\r?\n/);
    buf = frames.pop() ?? ''; // keep the trailing partial frame in the buffer
    for (const f of frames) emitFrame(f);
  }
  buf += decoder.decode(); // flush any dangling multi-byte character
  if (buf.trim()) emitFrame(buf); // stream closed without a final blank line
}
