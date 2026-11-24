// Onboard-assistant HTTP surface (SPEC-ASSISTANT §7, module ③): account CRUD,
// conversation reads, and the one hot path — POST /api/assistant/message, an SSE
// stream of AssistantEvents from a per-turn CodexProvider run. Plus the proposal
// gate (SPEC-ASSISTANT-CONTROL §4): propose/list/confirm/reject, where confirm is
// mounted ONLY once the scoped assistant token is active (⟦DP-J8⟧).
//
// Auth: these routes are NOT in server.ts TOKEN_EXEMPT, so the global onRequest hook
// enforces Host/Origin + the X-Tower-Token session token on every one of them. The
// message stream is SSE-over-POST consumed via fetch + ReadableStream (not
// EventSource), so the client CAN set the token header — no query-token carve-out
// like GET /api/stream needs.

import type { FastifyInstance } from 'fastify';
import { isSafeName } from '../ids.js';
import { audit } from '../audit.js';
import type { Accounts } from '../accounts.js';
import { validateSaveDraftRequest } from '../skills/drafts.js';
import type { SkillDraftStore } from '../skills/drafts.js';
import { scanSecrets, skillDraftScanText } from '../skills/lint.js';
import type { AssistantStore } from './store.js';
import { ProposalGuardError } from './proposals.js';
import type { ProposalStore } from './proposals.js';
import { sseFrame } from './contracts.js';
import { CodexProvider } from './codex-provider.js';
import { writeAssistantCodexConfig } from './codex-config.js';
import { requiresHumanConfirm, reasonForHumanConfirm } from './actions.js';
import { SYSTEM_PREAMBLE } from './knowledge.js';
import type { AssistantEvent, AssistantAccount, AssistantProposal, AssistantTurn } from '../../shared/types.js';
import { isValidEffort } from '../../shared/types.js';
import { appendSegment } from '../../shared/assistant-text.js';

/** Clamp a caller-supplied per-turn timeout to a sane range (10s–30min); undefined = default. */
function clampTimeoutSec(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return undefined;
  return Math.max(10, Math.min(1800, n));
}

export interface AssistantRouteDeps {
  store: AssistantStore;
  accounts: Accounts;
  /** The Tower's own listen port — baked into the profile's MCP-server config. */
  towerPort: number;
  /** cwd for the codex run and the repoRoot the MCP config advertises. */
  repoRoot: string;
  /** Path to the token file the tower-control MCP server authenticates with. */
  mcpTokenFile: string;
  /** The human confirm gate's ledger (SPEC-ASSISTANT-CONTROL §2). */
  proposals: ProposalStore;
  /** True only once mcpTokenFile holds the SCOPED assistant token rather than the session
   *  token. POST /api/assistant/confirm mounts a 503 stub until then (⟦DP-J8⟧) — otherwise
   *  the MCP token would directly authorize confirmations. This does not authenticate local
   *  OS users; the assistant's sandbox must separately block direct loopback access. */
  scopedTokenActive: boolean;
  /** The assistant's inert skill-draft pad (SPEC-SKILLS Phase 5b). */
  skillDrafts: SkillDraftStore;
  /** ADVISORY save-time warnings for a draft (non-blocking — enforcement lives in promote_skill's
   *  enrich + the promote route's belts; this only lets the brain self-correct EARLY): unknown /
   *  protected / non-assistant-origin target, or a new-skill name whose slug collides. Wired
   *  orchestrator-side (server.ts) beside the ONE isProtectedSkill/slugifySkillName sources, so the
   *  warning can never disagree with the later refusal. */
  draftWarnings(input: { name: string; targetSkillId?: string }): string[];
}

export function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRouteDeps): void {
  // A proposal is recorded by a SEPARATE request (the MCP server's POST /api/assistant/proposals),
  // so to surface its Confirm card in the turn the operator is watching we forward it into that
  // turn's open SSE stream. Each live message stream registers a send-listener under its convId;
  // ProposalStore.onProposal dispatches to it. Bounded by the number of concurrent open turns.
  const liveStreams = new Map<string, (p: AssistantProposal) => void>();
  deps.proposals.setHooks({ onProposal: (p) => liveStreams.get(p.conversationId)?.(p) });

  // ---- assistant accounts (which brain answers the dock) ----
  app.get('/api/assistant/accounts', async () => deps.store.listAccounts());

  app.post<{ Body: { provider?: string; profileId?: string; model?: string; effort?: string; allowNoSandbox?: boolean; turnTimeoutSec?: number } }>(
    '/api/assistant/accounts',
    async (req, reply) => {
      const b = req.body ?? {};
      if (b.provider !== 'codex') return reply.code(400).send({ error: "provider must be 'codex' (v1)" });
      if (!b.profileId) return reply.code(400).send({ error: 'profileId required' });
      // The account is only a pointer; the login lives in the profile's configDir —
      // so the profile must exist and actually be a codex login, not just any id.
      const profile = deps.accounts.getProfile(b.profileId);
      if (!profile) return reply.code(400).send({ error: 'unknown profileId' });
      if (profile.provider !== 'codex') {
        return reply.code(400).send({ error: `profile '${profile.label}' is ${profile.provider}, not codex` });
      }
      // SPEC-MODELS — the brain runs on an explicitly-chosen model; the system imposes no default, so a
      // create with no model is rejected rather than silently falling back to a slug. This also keeps a
      // model-less account from ever existing, so the dock's model-gated Save never blocks other edits.
      const model = typeof b.model === 'string' ? b.model.trim() : '';
      if (!model) return reply.code(400).send({ error: 'model required — pick the model this brain runs on' });
      // SPEC-EFFORT §5 — optional reasoning effort (codex tier). Unset ⇒ no pin (codex's own default).
      const effort = typeof b.effort === 'string' ? b.effort.trim() : '';
      if (effort && !isValidEffort('codex', effort)) {
        return reply.code(400).send({ error: 'reasoning effort must be a lowercase token, e.g. low/medium/high/xhigh' });
      }
      const account = deps.store.createAccount({
        provider: 'codex',
        profileId: profile.id,
        model,
        effort: effort || undefined,
        allowNoSandbox: b.allowNoSandbox === true || undefined,
        turnTimeoutSec: clampTimeoutSec(b.turnTimeoutSec),
      });
      audit('assistant.account.create', { accountId: account.id, profileId: profile.id, model: account.model, effort: account.effort });
      return account;
    },
  );

  // Edit an account's settings (model / sandbox override / turn timeout / autonomous mode)
  // from the dock's gear. Session-token only (NOT on the scoped-token accept-list, auth.ts) —
  // in particular the brain can never flip autoConfirm on its own account.
  app.patch<{ Params: { id: string }; Body: { model?: string; effort?: string | null; allowNoSandbox?: boolean; turnTimeoutSec?: number | null; autoConfirm?: boolean } }>(
    '/api/assistant/accounts/:id',
    async (req, reply) => {
      const b = req.body ?? {};
      const patch: Partial<Pick<AssistantAccount, 'model' | 'effort' | 'allowNoSandbox' | 'turnTimeoutSec' | 'autoConfirm'>> = {};
      if (typeof b.model === 'string') {
        // A patch may omit model (editing only timeout/sandbox/autoConfirm keeps the existing one), but
        // when it DOES carry model it must be non-empty — a brain never runs on an imposed default, so
        // clearing it to empty is refused rather than silently reverting to a slug (SPEC-MODELS).
        const m = b.model.trim();
        if (!m) return reply.code(400).send({ error: 'model cannot be empty — pick a model' });
        patch.model = m;
      }
      // SPEC-EFFORT §5 — effort is CLEARABLE (unlike model): null or a blank string clears it (codex's own
      // default), a value is trimmed + gated. The `{...cur, effort: undefined}` merge drops the field on
      // persist (JSON.stringify omits undefined). Mirrors turnTimeoutSec's string|null clear idiom.
      if (b.effort !== undefined) {
        const v = typeof b.effort === 'string' ? b.effort.trim() : '';
        if (!v) patch.effort = undefined;
        else if (!isValidEffort('codex', v)) {
          return reply.code(400).send({ error: 'reasoning effort must be a lowercase token, e.g. low/medium/high/xhigh' });
        } else patch.effort = v;
      }
      if (b.allowNoSandbox !== undefined) patch.allowNoSandbox = b.allowNoSandbox === true || undefined;
      if (b.turnTimeoutSec !== undefined) patch.turnTimeoutSec = clampTimeoutSec(b.turnTimeoutSec);
      if (b.autoConfirm !== undefined) patch.autoConfirm = b.autoConfirm === true || undefined;
      const next = deps.store.updateAccount(req.params.id, patch);
      if (!next) return reply.code(404).send({ error: 'unknown assistant account' });
      audit('assistant.account.update', {
        accountId: next.id,
        model: next.model,
        effort: next.effort,
        allowNoSandbox: next.allowNoSandbox,
        autoConfirm: next.autoConfirm,
      });
      return next;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/assistant/accounts/:id', async (req) => {
    deps.store.deleteAccount(req.params.id);
    return { ok: true };
  });

  // ---- conversations (read side; the write side is the message stream below) ----
  app.get('/api/assistant/conversations', async () => deps.store.listConversations());

  app.get<{ Params: { id: string } }>('/api/assistant/conversations/:id', async (req, reply) => {
    if (!isSafeName(req.params.id)) return reply.code(400).send({ error: 'bad conversation id' });
    const turns = deps.store.getConversation(req.params.id);
    // A real conversation always has ≥1 turn (the user turn lands before streaming).
    if (turns.length === 0) return reply.code(404).send({ error: 'unknown conversation' });
    return turns;
  });

  // ---- the turn itself: prompt in, SSE stream of AssistantEvents out ----
  app.post<{ Body: { conversationId?: string; text?: string } }>(
    '/api/assistant/message',
    async (req, reply) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return reply.code(400).send({ error: 'text required' });
      const requestedConvId = req.body?.conversationId;
      if (requestedConvId !== undefined && !isSafeName(requestedConvId)) {
        return reply.code(400).send({ error: 'bad conversationId' });
      }
      const account = deps.store.getActiveAccount();
      if (!account) {
        return reply.code(404).send({
          error: 'no assistant account configured — add one (Settings → Assistant) pointing at a logged-in codex profile',
        });
      }
      const profile = deps.accounts.getProfile(account.profileId);
      if (!profile || profile.provider !== 'codex') {
        return reply.code(409).send({
          error: `assistant account ${account.id} points at a missing or non-codex profile (${account.profileId}) — delete and re-create it`,
        });
      }

      // Mint the conversation id BEFORE the config write so it can be injected as
      // TOWER_CONVERSATION_ID into the MCP server's env — that env is the ONLY source the
      // propose route trusts for the conversation binding (§4), and a NEW conversation's id must
      // therefore exist here, not 20 lines later.
      const convId = requestedConvId ?? deps.store.newConversationId();

      // Everything that can fail with a clean JSON error happens BEFORE hijack —
      // after hijack the only channel left is the SSE stream itself.
      try {
        // Re-written every turn: cheap, and it keeps towerPort/model/repoRoot honest
        // after a Tower restart or an account model change. conversationId scopes the brain's
        // propose_action calls to THIS turn's conversation.
        await writeAssistantCodexConfig(profile.configDir, {
          model: account.model,
          effort: account.effort, // SPEC-EFFORT §5 — pin the Brain's effort into this turn's config.toml
          towerPort: deps.towerPort,
          mcpTokenFile: deps.mcpTokenFile,
          repoRoot: deps.repoRoot,
          conversationId: convId,
        });
      } catch (err) {
        return reply.code(500).send({ error: `failed to write assistant codex config: ${(err as Error).message}` });
      }
      const provider = new CodexProvider({
        configDir: profile.configDir,
        cwd: deps.repoRoot,
        model: account.model,
        systemPreamble: SYSTEM_PREAMBLE,
        allowNoSandbox: account.allowNoSandbox,
        turnTimeoutMs: account.turnTimeoutSec ? account.turnTimeoutSec * 1000 : undefined,
      });
      // History BEFORE this prompt (the TurnRequest contract), then persist the user
      // turn — even a failed run should leave the question in the transcript. Drop
      // empty-text turns: a trailing thinking-only assistant bubble persists with text:''
      // for reload parity, but buildPrompt renders every turn as `Role: text`, so replaying
      // it would inject a bare "Assistant: " line. The ONLY empty-text record is that trailing
      // thinking/tool-only bubble (user text is 400-gated; a message bubble seals only on a
      // non-whitespace delta; system turns are always templated), so this filter removes
      // exactly those and nothing else.
      const history = deps.store.getConversation(convId).filter((t) => t.text !== '');
      deps.store.appendTurn(convId, { role: 'user', text, ts: new Date().toISOString() });

      // Same header block as GET /api/stream. X-Conversation-Id lets a client that
      // opened a NEW conversation learn the id without a new AssistantEvent shape.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Conversation-Id': convId,
      });

      // A client disconnect must kill the underlying codex process, not leak it.
      const abort = new AbortController();
      let closed = false;
      const shutdown = () => {
        closed = true;
        abort.abort();
      };
      req.raw.on('close', shutdown);
      // Without an 'error' listener, a res.write() that loses the race with a peer reset
      // (socket unwritable a tick before 'close' fires) raises an unhandled stream error →
      // uncaughtException → the single-instance Tower exits, dropping every SSE/terminal
      // client. Treat a socket error as a disconnect.
      res.on('error', shutdown);
      const send = (ev: AssistantEvent) => {
        if (!closed) res.write(sseFrame(ev));
      };
      // Forward any proposal the brain records this turn (via the MCP server → POST
      // /api/assistant/proposals → ProposalStore.onProposal) into this stream as a `proposal`
      // frame, so its Confirm card appears inline. Identity-keyed so a concurrent second turn on
      // the same convId doesn't have its forwarder torn down when THIS turn's finally runs.
      const forward = (p: AssistantProposal): void => send({ t: 'proposal', proposal: p });
      liveStreams.set(convId, forward);
      // `codex exec --json` delivers the answer text whole on completion — keep
      // intermediaries from timing out the quiet stretch (same ping as /api/stream).
      const keepalive = setInterval(() => {
        if (!closed) res.write(': keepalive\n\n');
      }, 25_000);
      keepalive.unref?.();

      // Each codex agent_message is its own bubble (SPEC-ASSISTANT): one persisted assistant
      // turn per message, NOT the old single folded turn. `flushed` collects the sealed
      // bubbles (ts stamped AT the text event so reload's ts-merge interleaves any mid-turn
      // proposal card in true arrival order); `pending` accumulates the reasoning/tool chips
      // that PRECEDE the next message and attach to it. appendSegment survives only as the
      // intra-bubble thinking fold (several reasoning items, or a transient stream error,
      // can precede one message) — the same seam the dock folds thinking with live.
      const flushed: AssistantTurn[] = [];
      const pending = { thinking: '', toolIds: new Set<string>(), tools: [] as string[] };
      const bubble = (text: string, ts: string): AssistantTurn => ({
        role: 'assistant',
        text,
        ts,
        ...(pending.thinking ? { thinking: pending.thinking } : {}),
        ...(pending.tools.length ? { tools: [...pending.tools] } : {}),
      });
      let sawDone = false;
      let failed = false;
      try {
        for await (const ev of provider.streamTurn({ conversationId: convId, prompt: text, history, signal: abort.signal })) {
          if (ev.t === 'text') {
            // A whole agent_message seals a bubble. Skip a whitespace-only delta so an empty
            // message can't flush a blank turn (mirrors the dock's seal guard and the old
            // appendSegment no-op on '').
            if (ev.delta.trim()) {
              flushed.push(bubble(ev.delta, new Date().toISOString()));
              pending.thinking = '';
              pending.toolIds.clear();
              pending.tools = [];
            }
          } else if (ev.t === 'thinking') {
            pending.thinking = appendSegment(pending.thinking, ev.delta);
          } else if (ev.t === 'tool' && ev.status === 'completed') {
            // Dedupe by the same key the dock chips on (id, falling back to name) so a
            // started→completed pair records the tool once.
            const key = ev.id || ev.name;
            if (key && !pending.toolIds.has(key)) {
              pending.toolIds.add(key);
              pending.tools.push(ev.name);
            }
          } else if (ev.t === 'done') sawDone = true;
          else if (ev.t === 'error') failed = true;
          send(ev);
        }
      } catch (err) {
        // The provider threw mid-stream (spawn failure, abort, parse blowup).
        // Surface it as a first-class error event rather than a dropped socket.
        failed = true;
        send({ t: 'error', error: (err as Error).message, kind: 'other' });
      } finally {
        clearInterval(keepalive);
        // Only remove OUR forwarder — a later turn on the same convId may have replaced it.
        if (liveStreams.get(convId) === forward) liveStreams.delete(convId);
        // A trailing thinking/tools with no following message is a real bubble the dock keeps
        // (its streaming placeholder survives cleanup); persist it as a text:'' turn so reload
        // reproduces it. ts in finally is safe: it is by construction the LAST bubble, after
        // any mid-turn card's createdAt.
        if (pending.thinking || pending.tools.length) {
          flushed.push(bubble('', new Date().toISOString()));
        }
        // Persist whatever the assistant managed to say — a partial answer the user watched
        // stream should survive the transcript even on disconnect/error. Per-turn try/catch so
        // one failed write can't drop the rest of the sealed bubbles.
        for (const turn of flushed) {
          try {
            deps.store.appendTurn(convId, turn);
          } catch (err) {
            console.error('[assistant] failed to persist assistant turn:', err);
          }
        }
        if (!sawDone) send({ t: 'done', stopReason: failed ? 'error' : 'end' });
        res.end();
      }
    },
  );

  // ---- the proposal gate (SPEC-ASSISTANT-CONTROL §4) ----

  // Record a proposal. The conversation binding comes SOLELY from the x-tower-conversation
  // header, which the tower-control MCP server sets from its per-turn TOWER_CONVERSATION_ID
  // env — any body-supplied conversationId is deliberately ignored (§4), so the model can
  // neither widen its 5-pending namespace nor inject a card into another watched stream.
  // ProposalStore.create fires onProposal, which the integrator forwards as a `proposal`
  // frame into the open turn's SSE stream.
  app.post<{ Body: { kind?: unknown; args?: unknown } }>(
    '/api/assistant/proposals',
    async (req, reply) => {
      const conv = req.headers['x-tower-conversation'];
      if (typeof conv !== 'string' || !isSafeName(conv)) {
        return reply.code(400).send({
          error: 'missing or invalid x-tower-conversation header — proposals bind to the live conversation, never a caller-chosen id',
        });
      }
      const kind = typeof req.body?.kind === 'string' ? req.body.kind : '';
      try {
        const proposal = deps.proposals.create(conv, kind, req.body?.args ?? {});
        audit('assistant.proposal.create', {
          proposalId: proposal.id,
          conversationId: conv,
          kind: proposal.action.kind,
          risk: proposal.risk,
        });
        // Autonomous mode (operator opt-in on the account): confirm the fresh proposal right
        // here in trusted Tower code, through the SAME guarded ProposalStore.confirm path a
        // human click takes — one-shot CAS, drift re-enrich, injected executor, audit. The
        // scoped token still cannot reach POST /api/assistant/confirm or this account PATCH;
        // autonomy is a confirm-side policy the operator set, not a wider model surface.
        // Returning the DECIDED record (not 'pending') lets the brain chain multi-step work
        // in one turn, since its tool result honestly reports what happened.
        const autoConfirm = deps.store.getActiveAccount()?.autoConfirm === true;
        // Carve-out: an action that expands where model-influenced execution can reach (a loop carrying a
        // host checkCommand; registering a project) waits for a human click even under autoConfirm — the
        // last gate between model output and the host. See requiresHumanConfirm.
        if (autoConfirm && !requiresHumanConfirm(proposal.action)) {
          let decided: AssistantProposal;
          try {
            decided = await deps.proposals.confirm(proposal.id, undefined, { auto: true });
          } catch (e) {
            // A guard refusal (raced/expired/drift) is not a route failure: return the record
            // in its guarded state so the brain sees the action did NOT run.
            decided = deps.proposals.get(proposal.id) ?? proposal;
            console.error(`[assistant] auto-confirm of ${proposal.id} refused: ${(e as Error).message}`);
          }
          audit('assistant.proposal.autoconfirm', {
            proposalId: proposal.id,
            kind: proposal.action.kind,
            risk: proposal.risk,
            status: decided.status,
          });
          return decided;
        }
        if (autoConfirm) {
          // autoConfirm is on but this proposal is carved out — leave it pending for a human click, and
          // record the skip so the operator can see why the brain's action did not run on its own. The
          // reason is DERIVED from the action: with more than one carved-out kind a fixed string lies.
          audit('assistant.proposal.autoconfirm.skipped', {
            proposalId: proposal.id,
            kind: proposal.action.kind,
            risk: proposal.risk,
            reason: reasonForHumanConfirm(proposal.action),
          });
        }
        return proposal;
      } catch (e) {
        // Validation / unknown-id / pending-cap: model-visible and self-correctable.
        return reply.code(400).send({ error: (e as Error).message });
      }
    },
  );

  // Dock reload: the client merges these with live-streamed proposal frames by ts.
  app.get<{ Querystring: { conversationId?: string } }>(
    '/api/assistant/proposals',
    async (req, reply) => {
      const convId = req.query.conversationId;
      if (!convId || !isSafeName(convId)) {
        return reply.code(400).send({ error: 'conversationId query parameter required' });
      }
      return deps.proposals.listFor(convId);
    },
  );

  // The operator's Confirm click — the ONLY path from a proposal to a mutation. Mounted for
  // real only when the scoped assistant token is active (⟦DP-J8⟧): while mcpTokenFile still
  // holds the session token, a network-capable unsandboxed brain could hit this route itself,
  // so until then the gate answers 503 to everyone.
  if (deps.scopedTokenActive) {
    app.post<{ Body: { proposalId?: string; action?: unknown } }>(
      '/api/assistant/confirm',
      async (req, reply) => {
        const proposalId = req.body?.proposalId;
        if (!proposalId || typeof proposalId !== 'string') {
          return reply.code(400).send({ error: 'proposalId required' });
        }
        try {
          const p = await deps.proposals.confirm(proposalId, req.body?.action);
          // p.status is 'executed' or 'failed' (route failure) — both are decided outcomes
          // the dock renders from the record; only gate refusals become error codes.
          audit('assistant.proposal.confirm', {
            proposalId,
            kind: p.action.kind,
            status: p.status,
            edited: p.finalAction !== undefined,
          });
          return p;
        } catch (e) {
          if (e instanceof ProposalGuardError) {
            // Not-pending / expired / drift — refused, nothing executed.
            audit('assistant.proposal.confirm', { proposalId, refused: (e as Error).message });
            return reply.code(409).send({ error: (e as Error).message });
          }
          // A bad Edit override: the proposal stays pending for another attempt.
          return reply.code(400).send({ error: (e as Error).message });
        }
      },
    );
  } else {
    app.post('/api/assistant/confirm', async (_req, reply) =>
      reply.code(503).send({ error: 'confirm disabled until the scoped assistant token is active' }),
    );
  }

  // Dismiss = reject: terminal, auditable, and only ever from pending.
  app.post<{ Body: { proposalId?: string } }>('/api/assistant/reject', async (req, reply) => {
    const proposalId = req.body?.proposalId;
    if (!proposalId || typeof proposalId !== 'string') {
      return reply.code(400).send({ error: 'proposalId required' });
    }
    try {
      const p = deps.proposals.reject(proposalId);
      audit('assistant.proposal.reject', { proposalId, kind: p.action.kind });
      return p;
    } catch (e) {
      if (e instanceof ProposalGuardError) return reply.code(409).send({ error: (e as Error).message });
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ---- the assistant skill-draft pad (SPEC-SKILLS Phase 5b) ----

  // Create/update a draft — the ONE scoped-token write beyond POST /api/assistant/proposals
  // (auth.ts ASSISTANT_ACCEPT carries the admissibility argument: inert, capped, secret-scan-
  // rejected, audited, conversation-bound). STRICT zod: an unknown key (gate, providerOverrides,
  // assets, enabled, …) is a 400 — the whitelist proof at the wire, and better self-correction than
  // silent dropping. The conversation binding comes SOLELY from the x-tower-conversation header —
  // set by the MCP server from its per-turn TOWER_CONVERSATION_ID env, required for ALL callers
  // including the session token (tests pass it; keeps ownership honest) — never from the body.
  app.post('/api/assistant/skill-drafts', async (req, reply) => {
    const conv = req.headers['x-tower-conversation'];
    if (typeof conv !== 'string' || !isSafeName(conv)) {
      return reply.code(400).send({
        error: 'missing or invalid x-tower-conversation header — drafts bind to the live conversation, never a caller-chosen id',
      });
    }
    let input;
    try {
      input = validateSaveDraftRequest(req.body);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    // REJECT at the door: any finding means NOTHING persists (drafts.save is never reached), and the
    // error names the pattern CLASS only — the matched text must never reach an error body, the
    // audit log, or the model transcript.
    const found = scanSecrets(skillDraftScanText(input));
    if (found.length > 0) {
      return reply.code(400).send({
        error: `draft refused — secret-shaped content detected (${found.join(', ')}); replace real credentials with placeholders and save again`,
      });
    }
    try {
      const updated = input.draftId !== undefined;
      const d = deps.skillDrafts.save(input, conv);
      const bodyBytes = Buffer.byteLength(d.body, 'utf8');
      audit('skill.draft.save', { draftId: d.id, conversationId: conv, bytes: bodyBytes, updated });
      return {
        id: d.id,
        contentHash: d.contentHash,
        bodyBytes,
        warnings: deps.draftWarnings({ name: d.name, targetSkillId: d.targetSkillId }),
      };
    } catch (e) {
      // Caps / ownership / promoted-draft refusals: model-visible and self-correctable.
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Draft META list (no bodies — bounded payload). Scoped-readable: every byte in the pad is
  // assistant-authored, so the brain re-reading its own drafts leaks nothing.
  app.get('/api/assistant/skill-drafts', async () => deps.skillDrafts.list());

  // Full draft incl. body — the dock's promote-card diff reads this with the SESSION token; the
  // brain may re-read its own pad with the scoped one (same nothing-confidential argument).
  app.get<{ Params: { id: string } }>('/api/assistant/skill-drafts/:id', async (req, reply) => {
    if (!isSafeName(req.params.id)) return reply.code(400).send({ error: 'bad draft id' });
    const d = deps.skillDrafts.get(req.params.id);
    if (!d) return reply.code(404).send({ error: 'unknown draft' });
    return d;
  });

  // Operator discard. Session-token ONLY (deliberately NOT in ASSISTANT_ACCEPT): the scoped token
  // can save and list drafts but never destroy them — the pad stays append-honest, so the operator
  // always sees what the assistant wrote.
  app.delete<{ Params: { id: string } }>('/api/assistant/skill-drafts/:id', async (req, reply) => {
    if (!isSafeName(req.params.id)) return reply.code(400).send({ error: 'bad draft id' });
    if (!deps.skillDrafts.remove(req.params.id)) return reply.code(404).send({ error: 'unknown draft' });
    audit('skill.draft.discard', { draftId: req.params.id });
    return { ok: true };
  });
}
