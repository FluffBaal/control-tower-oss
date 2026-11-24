// Assistant persistence (SPEC-ASSISTANT §7, module ③): AssistantAccount records as
// JSON config + conversation transcripts as append-only JSONL under ~/.ct/assistant/
// (one AssistantTurn per line — the same no-SQLite convention as the event log, D15).
// Accounts mirror `Accounts` (accounts.ts): zod-validated on load, atomic temp+rename
// writes. Transcripts mirror `Store.rebuildSeq` on read: a torn or hand-mangled line
// is skipped, never allowed to lose the rest of the conversation.

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../paths.js';
import { shortId, isSafeName } from '../ids.js';
import type { AssistantAccount, AssistantTurn, AssistantConversationMeta } from '../../shared/types.js';

const accountsFile = join(paths.config, 'assistant-accounts.json');
const conversationsDir = join(paths.home, 'assistant');

// Enum fields are pinned to the v1 universe (mode 'cli', provider 'codex') so a
// hand-edited or future-version record can't smuggle an unsupported brain into
// getActiveAccount(). Optional fields MUST be listed or zod strips them on load
// (same trap as store.ts TerminalSchema — dropping `model` would silently unpin it).
const AccountSchema = z.object({
  id: z.string(),
  mode: z.enum(['cli']),
  provider: z.enum(['codex']),
  profileId: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(), // SPEC-EFFORT §5 — MUST be listed or zod strips it on load (like model)
  allowNoSandbox: z.boolean().optional(),
  turnTimeoutSec: z.number().optional(),
  autoConfirm: z.boolean().optional(),
  createdAt: z.string(),
});

// `system` is a Tower-authored note (a confirmed proposal's outcome, ⟦DP-J6⟧) the stateless
// brain replays as context on its next turn — buildPrompt renders it as its own speaker.
const TurnSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  ts: z.string(),
  // These MUST be listed or zod's default strip mode silently drops them on load (the
  // strip-trap the AccountSchema comment above warns about), and reload would lose the
  // per-bubble thinking block and tool chips. Optional so legacy {role,text,ts} lines parse.
  thinking: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

/**
 * Load the accounts file with PER-RECORD validation (one bad record must not drop the
 * rest — store.ts readJsonArray rationale). Deliberately simpler than readJsonArray:
 * we do NOT quarantine or re-persist here, so the original bytes stay on disk untouched
 * until the next explicit create/delete — losing an assistant account only ever costs a
 * re-add in the UI, never fleet state.
 */
function readAccounts(): AssistantAccount[] {
  if (!existsSync(accountsFile)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(accountsFile, 'utf8'));
  } catch (err) {
    console.error(`[assistant] ${accountsFile} unreadable (${(err as Error).message}); starting with no accounts`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error(`[assistant] ${accountsFile} is not a JSON array; starting with no accounts`);
    return [];
  }
  const records: AssistantAccount[] = [];
  for (const el of parsed) {
    const res = AccountSchema.safeParse(el);
    if (res.success) records.push(res.data);
    else console.error(`[assistant] skipping invalid account record in ${accountsFile}: ${res.error.message}`);
  }
  return records;
}

/** Atomic write: temp file + rename, so a crash mid-write can't corrupt config. 0600 — chmod the tmp
 *  BEFORE any content byte is written: writeFileSync's {mode} takes effect only when the tmp is newly
 *  CREATED, so a `${file}.tmp` left behind by a crash-interrupted prior write (the pre-hardening code
 *  wrote it with no mode) keeps its old looser bits on overwrite. Tightening first means the sidecar
 *  never briefly holds content at loose perms, and the rename carries 0600 onto the target. On a fresh
 *  path the chmod ENOENTs (caught) and the writeFileSync creates it {mode} from the first byte.
 *  Mirrors store.ts writeJsonAtomic. */
function writeArr(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* not yet created — the writeFileSync below makes it {mode}; never block a durable write on a chmod */
  }
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** First line of the first user turn, whitespace-collapsed and truncated, as a title. */
const TITLE_MAX = 64;
function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat || '(empty)';
}

export class AssistantStore {
  private accounts = new Map<string, AssistantAccount>();

  constructor() {
    // Transcripts hold the raw prompt, the assistant's reply, and any route response body the brain
    // saw — sensitive. Keep the dir 0700 and every transcript 0600. mkdirSync's mode applies only on
    // CREATE and is umask-masked, so chmod the dir every boot AND sweep any transcript an older Tower
    // wrote at the default (group/world-readable) mode down to 0600; new files get 0600 on append.
    mkdirSync(conversationsDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(conversationsDir, 0o700);
      for (const f of readdirSync(conversationsDir)) {
        if (!f.endsWith('.jsonl')) continue;
        try { chmodSync(join(conversationsDir, f), 0o600); } catch { /* best-effort per-file re-tighten */ }
      }
    } catch {
      /* dir chmod/scan failed (a perms quirk or a race) — skip the boot sweep of pre-existing files.
         appendTurn still writes each NEW transcript 0600 via its own {mode}; only the one-time
         re-tighten of older files is lost here. The dir itself was just created by the mkdirSync above,
         so this is not a missing-dir path (appendFileSync would ENOENT, not self-heal). */
    }
    for (const a of readAccounts()) this.accounts.set(a.id, a);
  }

  // ---- accounts (which brain answers the chat dock) ----
  listAccounts(): AssistantAccount[] {
    return [...this.accounts.values()];
  }
  getAccount(id: string): AssistantAccount | undefined {
    return this.accounts.get(id);
  }
  /** v1: no per-conversation account picker — the first (typically only) account answers. */
  getActiveAccount(): AssistantAccount | undefined {
    return this.listAccounts()[0];
  }
  createAccount(input: { provider: 'codex'; profileId: string; model?: string; effort?: string; allowNoSandbox?: boolean; turnTimeoutSec?: number; autoConfirm?: boolean }): AssistantAccount {
    const account: AssistantAccount = {
      id: shortId(),
      mode: 'cli',
      provider: input.provider,
      profileId: input.profileId,
      model: input.model,
      effort: input.effort,
      allowNoSandbox: input.allowNoSandbox,
      turnTimeoutSec: input.turnTimeoutSec,
      autoConfirm: input.autoConfirm,
      createdAt: new Date().toISOString(),
    };
    this.accounts.set(account.id, account);
    this.persistAccounts();
    return account;
  }
  /** Update the editable settings of an account (model / effort / sandbox override / turn timeout / autonomy). */
  updateAccount(id: string, patch: Partial<Pick<AssistantAccount, 'model' | 'effort' | 'allowNoSandbox' | 'turnTimeoutSec' | 'autoConfirm'>>): AssistantAccount | undefined {
    const cur = this.accounts.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.accounts.set(id, next);
    this.persistAccounts();
    return next;
  }
  deleteAccount(id: string): void {
    this.accounts.delete(id);
    this.persistAccounts();
  }
  private persistAccounts(): void {
    writeArr(accountsFile, [...this.accounts.values()]);
  }

  // ---- conversations (append-only JSONL transcripts) ----
  newConversationId(): string {
    return shortId();
  }

  /**
   * A conversation id becomes a filename: reject anything newConversationId() could
   * not have minted before it can traverse (SPEC §14 input sanitization) — routes
   * 400 first, but the store must not trust its callers with a path segment.
   */
  private convPath(convId: string): string {
    if (!isSafeName(convId)) throw new Error('invalid conversation id');
    return join(conversationsDir, `${convId}.jsonl`);
  }

  appendTurn(convId: string, turn: AssistantTurn): void {
    // mode 0600 on CREATE so a transcript is never group/world-readable (it holds the raw prompt,
    // reply, and any route body the brain fetched). Pre-existing files are tightened in the constructor.
    appendFileSync(this.convPath(convId), JSON.stringify(turn) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  /** Full transcript, oldest→newest. Missing file = [] (a new conversation has no history). */
  getConversation(convId: string): AssistantTurn[] {
    const file = this.convPath(convId);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const turns: AssistantTurn[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const res = TurnSchema.safeParse(JSON.parse(line));
        if (res.success) turns.push(res.data);
      } catch {
        // Skip a malformed line; a torn final write shouldn't lose the rest.
      }
    }
    return turns;
  }

  /**
   * Derived metadata for the dock's conversation list, newest-activity first.
   * Timestamps come from the first/last turn (every persisted turn carries ts);
   * a file with no valid turns has nothing to show and is skipped.
   */
  listConversations(): AssistantConversationMeta[] {
    let files: string[];
    try {
      files = readdirSync(conversationsDir);
    } catch {
      return []; // dir vanished since the constructor — treat as no conversations
    }
    const metas: AssistantConversationMeta[] = [];
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const id = file.slice(0, -'.jsonl'.length);
      if (!isSafeName(id)) continue; // foreign file; also keeps convPath() total
      const turns = this.getConversation(id);
      const first = turns[0];
      const last = turns[turns.length - 1];
      if (!first || !last) continue;
      metas.push({
        id,
        title: titleFrom((turns.find((t) => t.role === 'user') ?? first).text),
        createdAt: first.ts,
        updatedAt: last.ts,
      });
    }
    // ISO-8601 sorts lexicographically; most recently updated first.
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return metas;
  }
}
