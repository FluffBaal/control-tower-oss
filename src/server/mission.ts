// Mission Control core: ingests normalized hook signals, runs the per-terminal
// status FSM (rejecting out-of-order events by emit timestamp), maintains the
// attention queue with capture-pane previews, and pushes live updates to the
// dashboard over SSE. Also executes the human's triage actions (reply / approve /
// deny) as state-gated tmux input.

import type { Store } from './store.js';
import type { Mail } from './coordination.js';
import { providerRegistry } from './providers/registry.js';
import * as tmux from './tmux.js';
import { audit } from './audit.js';
import type {
  AttentionItem,
  HookSignal,
  StreamEvent,
  TerminalState,
  Terminal,
  Loop,
  Mission,
  WireHookSignal,
} from '../shared/types.js';

const SIGNAL_TO_STATE: Record<HookSignal, TerminalState> = {
  'needs-input': 'blocked-question',
  'needs-permission': 'blocked-permission',
  'turn-done': 'idle',
  'session-start': 'working',
};

type Subscriber = (ev: StreamEvent) => void;

export class MissionControl {
  private lastEmit = new Map<string, bigint>();
  private subscribers = new Set<Subscriber>();
  /** Last unread count we nudged a terminal about, to avoid re-nudging every turn. */
  private lastNudged = new Map<string, number>();
  /** Terminals with an in-flight maybeNudge, so two concurrent callers can't double-send. */
  private nudgeInFlight = new Set<string>();

  constructor(
    private store: Store,
    private mail: Mail,
  ) {}

  // ---- SSE fan-out ----
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
  private broadcast(ev: StreamEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(ev);
      } catch {
        /* dropped client */
      }
    }
  }

  /** Tell dashboards the terminal set changed (created/killed), so they refetch. */
  broadcastChange(): void {
    this.broadcast({ t: 'terminals-changed' });
  }

  /** Push a loop's advanced state to dashboards (drives the Flightline loop strips live). */
  emitLoop(loop: Loop): void {
    this.broadcast({ t: 'loop-state', loop });
  }

  /** Push a mission's advanced state to dashboards (drives the missions view + dock cards). */
  emitMission(mission: Mission): void {
    this.broadcast({ t: 'mission-state', mission });
  }

  /** Signal that Tower-mediated mail was delivered — drives the collaboration "wire" pulse. */
  emitMailSent(from: string, to: string, toTitle?: string): void {
    this.broadcast({ t: 'mail-sent', from, to, toTitle });
  }

  /** Push a `{t:'providers'}` frame after a ProviderDef store mutation — open composers refresh
   *  their roster (and the app refetches adapters) without a restart (⟦DP-3⟧). */
  emitProviders(): void {
    this.broadcast({ t: 'providers' });
  }

  /** Push a `{t:'stories'}` frame after a Story corpus mutation — open Stories views refresh their
   *  corpus + coverage without a restart (SPEC-STORYLOOP §1.1; the `providers` precedent). */
  emitStories(): void {
    this.broadcast({ t: 'stories' });
  }

  /** Push a `{t:'skills'}` frame after a skill-library mutation — the open Skills panel refetches its
   *  list without a restart (SPEC-SKILLS; the `providers` refetch precedent). */
  emitSkills(): void {
    this.broadcast({ t: 'skills' });
  }

  /** Push a `{t:'consults'}` frame after a planner-consult mutation — open dashboards REFETCH
   *  GET /api/consults (SPEC-PLANNER §9; the backlog refetch pattern). */
  emitConsults(): void {
    this.broadcast({ t: 'consults' });
  }

  /** Push a `{t:'backlog'}` frame after a Task corpus mutation — open Boards REFETCH tasks
   *  (SPEC-BACKLOG ⟦DP-B7⟧; the providers refetch pattern, not the stories reloadSignal one). */
  emitBacklog(): void {
    this.broadcast({ t: 'backlog' });
  }

  /** Push a `{t:'runway'}` frame after a Runway config mutation — the open Runway tab REFETCHES
   *  GET /api/runway/config (SPEC-RUNWAY; the backlog refetch pattern). Live usage is polled, not framed. */
  emitRunway(): void {
    this.broadcast({ t: 'runway' });
  }

  /** Push a `{t:'memory', projectId}` frame after a memory entry mutation so an open MemoryPanel for that
   *  project REFETCHES (SPEC-MEMORY; the runway/backlog refetch pattern). */
  emitMemory(projectId: string): void {
    this.broadcast({ t: 'memory', projectId });
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * SPEC-CLEARANCE §A — the hook-wire ingest seam. Both wire feeders (the POST /api/events route
   * and the spool drain) enter here; the poller keeps calling ingest directly (it never emits
   * needs-input). For the `needs-input` signal ONLY, the pane is captured and the adapter's
   * questionPending veto consulted: an AFFIRMATIVELY idle screen (empty composer, no question
   * affordance) DROPS the hold — claude's idle_prompt fires after ~60s at any bare prompt, and
   * without this every idle pane became a phantom QUESTION card that nothing cleared (claude has
   * no turn-done parse, and the poller never downgrades a blocked state). Every inconclusive
   * read — no adapter surface, capture failure, dialog, alt screen, mid-turn — honors the hook:
   * only an affirmative `false` suppresses, so the failure mode stays "a card too many", never a
   * swallowed real question. 'agent-question' (claude's agent_needs_input — its explicit
   * ask-the-user path) normalizes to needs-input WITHOUT the veto: a strong signal.
   *
   * The capture lives HERE, not in ingest: ingest's state write must stay synchronous before its
   * first await (the poller's anti-clobber guard depends on that — see the note inside it).
   */
  async ingestSignal(terminalId: string, signal: WireHookSignal, emitTs?: string): Promise<boolean> {
    if (signal === 'agent-question') return this.ingest(terminalId, 'needs-input', emitTs);
    if (signal !== 'needs-input') return this.ingest(terminalId, signal, emitTs);
    const term = this.store.getTerminal(terminalId);
    // Gone, or already holding: delegate — ingest's own guards judge it, no capture needed.
    if (!term || term.state === 'killed' || term.state === 'blocked-question') {
      return this.ingest(terminalId, signal, emitTs);
    }
    // frozen-def resolution, like every other live-terminal parse. An adapter without the
    // veto surface (codex/gemini/custom/shell — none of which even source needs-input today)
    // honors the hook unchanged.
    const veto = providerRegistry().forTerminal(term).questionPending;
    if (veto) {
      // captureVisible resolves '' on any tmux failure, which questionPending reads as
      // inconclusive → the hook is honored. Dropping is a judged no-op for the spool drain
      // (resolves false ⇒ the event is consumed, exactly like a stale emitTs).
      const snap = await tmux.captureVisible(term.tmuxSocket);
      if (veto(snap) === false) {
        // SPEC-LOOPWEDGE F1 — an affirmatively-idle screen on a WORKING record is claude's own
        // idle_prompt evidence that the turn actually ended and its Stop hook was lost. HARVEST it as
        // an INFERRED turn-done (never a real Stop — marked so the loop GUARD can never let it become
        // an autopilot 'done'), which self-heals a wedged record in ~1 min using claude's own signal.
        // A record already idle (or blocked) keeps the plain drop — there is nothing wedged to heal.
        if (term.state === 'working') {
          audit('terminal.harvested-idle', { terminalId, reason: 'idle_prompt-veto' });
          return this.ingest(terminalId, 'turn-done', emitTs, true);
        }
        audit('attention.veto', { terminalId, signal });
        return false; // affirmatively idle screen — drop the phantom hold, leave the state alone
      }
    }
    return this.ingest(terminalId, signal, emitTs);
  }

  /**
   * Apply a normalized signal to a terminal. Rejects events older than the last
   * applied one (per-terminal emit-time ordering), so a late 'needs-input' can't
   * un-'turn-done' a terminal. Returns true if state changed.
   *
   * SPEC-LOOPWEDGE — `inferred` marks an idle reached by SCREEN EVIDENCE (F1's lost-hook harvest,
   * F2's poller affirmative-idle backstop) rather than a real completion hook. On the working→idle
   * transition it is persisted to `terminal.idleInferred` so the loop runner's completion GUARD can
   * see it (an inferred idle may never be the sole basis of an autopilot 'done'); any working
   * transition clears it (a fresh turn is no longer an inferred idle). It is meaningful ONLY for
   * turn-done and is ignored for every other signal.
   */
  async ingest(terminalId: string, signal: HookSignal, emitTs?: string, inferred = false): Promise<boolean> {
    const term = this.store.getTerminal(terminalId);
    if (!term || term.state === 'killed') return false;

    // Defensive: an unmapped/garbage signal must be a no-op, never persist
    // `state: undefined` — that would poison terminals.json and, on the next restart,
    // fail schema validation and wipe the whole fleet.
    const nextState = SIGNAL_TO_STATE[signal];
    if (!nextState) return false;

    let incoming: bigint | undefined;
    if (emitTs && /^\d+$/.test(emitTs) && emitTs !== '0') {
      incoming = BigInt(emitTs);
      const prev = this.lastEmit.get(terminalId);
      // `<=` (not `<`) so a DUPLICATE event with an identical emitTs is idempotent — the
      // hook may deliver AND spool the same event (curl times out after the server got it),
      // and re-applying the equal-emitTs copy on drain would clobber a newer no-emitTs
      // (poller/human) state, e.g. flip a just-replied 'working' terminal back to 'idle'.
      // (On our Linux target `date +%s%N` is true nanoseconds, so two DISTINCT hook events
      // never share an emitTs; a coarse-clock host is out of scope.)
      if (prev !== undefined && incoming <= prev) return false; // stale / duplicate
      // NOTE: lastEmit is advanced AFTER a successful appendEvent below, NOT here — else a
      // write that throws (ENOSPC) would advance the mark, and the spooled retry of the
      // same emitTs would then be rejected (<=) as a duplicate and permanently dropped.
    }
    const advanceEmit = () => {
      if (incoming !== undefined) this.lastEmit.set(terminalId, incoming);
    };

    // NOTE: appendEvent must remain SYNCHRONOUS up to and including the state write —
    // the poller's anti-clobber guard relies on ingest persisting before its first
    // await. Do not introduce an `await` before appendEvent below.
    const changed = term.state !== nextState;
    if (!changed) {
      // SPEC-LOOPWEDGE F-3 — a state no-op normally has nothing to write, but a REAL turn-done
      // (inferred !== true) landing on a pane already demoted to idle by SCREEN EVIDENCE must
      // DOWNGRADE the inferred flag: the genuine Stop hook has now confirmed the turn, so the loop
      // GUARD must stop over-gating it. Only this narrow case writes; every other no-op stays pure.
      if (nextState === 'idle' && inferred !== true && term.idleInferred === true) {
        this.store.patchTerminal(terminalId, { idleInferred: false });
      }
      advanceEmit(); // mark it seen so a later dup is caught
      return false;
    }

    // One combined write (state + lastEventAt + the inferred-idle flag) instead of separate
    // terminals.json rewrites. (signal ⊆ TowerEvent['type'], so it maps 1:1 to the event type.)
    // SPEC-LOOPWEDGE — idle carries the inferred flag (true = screen-evidence, false = a real Stop,
    // which also CLEARS a prior inferred idle); any working transition clears it (a fresh turn).
    // Written in the SAME synchronous appendEvent as the state, before ingest's first await, so the
    // poller's anti-clobber guard still sees a single atomic state write.
    const extraPatch: Partial<Terminal> = { state: nextState };
    if (nextState === 'idle') extraPatch.idleInferred = inferred === true;
    else if (nextState === 'working') extraPatch.idleInferred = false;
    this.store.appendEvent({ terminalId, type: signal }, extraPatch);
    advanceEmit(); // advance ONLY after the write succeeded (a throw leaves it for retry)
    this.broadcast({ t: 'terminal-state', terminalId, state: nextState });
    await this.pushAttention();

    // Nudge only on a REAL transition to idle (an agent that finished a turn with unread
    // mail). maybeNudge re-derives all state itself and is safe to fire-and-forget. Mail
    // to an ALREADY-idle agent is delivered on its NEXT transition to idle (accepted
    // limitation — the send-time nudge was removed because detecting idle heuristically /
    // re-emitting from the poller caused blocked-terminal clobbers + dialog injection).
    if (nextState === 'idle') void this.maybeNudge(terminalId);
    return true;
  }

  /**
   * Type a "you have unread mail" nudge into a terminal — the ONLY code path that does.
   * Self-gating: re-derives state, unread count, and the high-water mark at call time and
   * refuses unless the terminal is idle in the same synchronous segment as the send, so a
   * spurious call is a harmless no-op, never an injection into a working/blocked terminal.
   */
  async maybeNudge(terminalId: string): Promise<void> {
    if (this.nudgeInFlight.has(terminalId)) return; // sync check-and-set: no double-send
    this.nudgeInFlight.add(terminalId);
    try {
      const term = this.store.getTerminal(terminalId);
      if (!term || term.state !== 'idle' || term.provider === 'shell') return;
      // Cheap early-out to skip the capture when there is clearly nothing to nudge.
      if (this.mail.unreadCount(terminalId) === 0) {
        this.lastNudged.delete(terminalId);
        return;
      }
      // Danger veto (not idle detection): if a permission dialog is visibly on screen
      // (its hook lost/late), never type into it. A false positive only defers the nudge.
      // SPEC-SUBMIT ⟦DEC-7⟧ — VISIBLE-only, and ONE capture feeding both vetoes below. A permission
      // dialog is by definition on the visible screen, so parseState loses nothing; the composer read
      // would be actively wrong over scrollback (it holds stale composer frames and old prompt echoes).
      const snap = await tmux.captureVisible(term.tmuxSocket);
      // resolve off the terminal's FROZEN def snapshot (forTerminal), never the live
      // store — an edit/delete must not change this live terminal's danger-veto parse.
      const adapter = providerRegistry().forTerminal(term);
      if (adapter.parseState(snap) === 'needs-permission') return;
      // SPEC-SUBMIT §5.2 — never type a nudge into a half-typed human draft. A false positive only
      // defers the nudge (the danger veto's own posture), and the next idle transition retries.
      if (adapter.composerPending?.(snap) === true) return;
      // FINAL gate — re-read BOTH state AND unread here, with NO await before the send, so
      // a state flip OR an inbox-read (markAllRead) that happened during the capture above
      // is respected: otherwise a stale pre-capture unread would type a false nudge.
      const fresh = this.store.getTerminal(terminalId);
      if (!fresh || fresh.state !== 'idle') return;
      const unread = this.mail.unreadCount(terminalId);
      if (unread === 0) {
        this.lastNudged.delete(terminalId);
        return;
      }
      const prev = this.lastNudged.get(terminalId) ?? 0;
      if (unread <= prev) {
        if (unread < prev) this.lastNudged.set(terminalId, unread); // inbox shrank — clamp
        return;
      }
      // SPEC-SUBMIT §5.2 — verified. A positive send failure THROWS into the catch below, which leaves
      // lastNudged unraised, so the comment on the next line is true for the first time: a swallowed
      // nudge used to raise the high-water mark anyway and suppress itself forever.
      const outcome = await tmux.sendTextVerified(
        fresh.tmuxSocket,
        `[Control Tower] ${unread} unread message(s) — run: towerctl mail inbox`,
        { ...this.sendOpts(fresh), wentWorking: this.tieBreak(fresh) },
      );
      this.lastNudged.set(terminalId, unread); // raised ONLY after a successful send
      audit('mail.nudge', { terminalId, unread });
      // ⟦DEC-4⟧ a classifier-less provider still raises the mark (otherwise every idle transition
      // re-nudges it — spam, worse than today) but says so.
      if (outcome === 'unverified') audit('mail.nudge.unverified', { terminalId, provider: fresh.provider });
    } catch {
      /* best-effort; lastNudged left unraised so the next idle transition retries */
    } finally {
      this.nudgeInFlight.delete(terminalId);
    }
  }

  /**
   * Reset a terminal's idle-nudge high-water mark. Called when its mail is marked read,
   * so mail that arrives AFTER a read is nudged again instead of being suppressed
   * because unread never re-exceeds the old peak.
   */
  clearNudge(terminalId: string): void {
    this.lastNudged.delete(terminalId);
  }

  /** Recompute the attention queue and broadcast it. */
  async pushAttention(): Promise<AttentionItem[]> {
    const items = await this.buildAttention();
    this.broadcast({ t: 'attention', items });
    return items;
  }

  async buildAttention(): Promise<AttentionItem[]> {
    const blocked = this.store
      .listTerminals()
      .filter((t) => t.state === 'blocked-question' || t.state === 'blocked-permission');
    const items = await Promise.all(
      blocked.map(async (t): Promise<AttentionItem> => {
        const snap = await tmux.capturePlain(t.tmuxSocket, 40);
        const lines = snap.split('\n').map((l) => l.replace(/\s+$/, ''));
        // trim trailing blank lines, keep last ~12 non-empty for context
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
        const kind = t.state === 'blocked-permission' ? ('permission' as const) : ('question' as const);
        let preview = lines.slice(-12);
        let message: string | undefined;
        // SPEC-CLEARANCE §B — QUESTION cards only: ask the adapter for the actual question and a
        // chrome-stripped preview instead of dumping the pane's last rows (which are the composer +
        // status footer, never the question). Kind-scoping is what keeps the permission card
        // byte-identical: its preview stays the raw slice and extractRequested still reads it.
        if (kind === 'question') {
          try {
            const desc = providerRegistry().forTerminal(t).describeAttention?.(snap);
            if (desc?.message) message = desc.message;
            if (desc?.preview) preview = desc.preview;
          } catch {
            /* raw-preview fallback — a describe failure must never hide the card */
          }
        }
        return {
          terminalId: t.id,
          projectId: t.projectId,
          title: t.title,
          provider: t.provider,
          kind,
          ...(message !== undefined ? { message } : {}),
          requested: kind === 'permission' ? extractRequested(preview) : undefined,
          preview,
          since: t.lastEventAt ?? t.createdAt,
        };
      }),
    );
    // Longest-blocked first.
    items.sort((a, b) => a.since.localeCompare(b.since));
    return items;
  }

  // ---- triage actions ----

  /**
   * SPEC-SUBMIT §5 — the verified-send options for a terminal. The classifier is resolved off
   * the terminal's FROZEN def snapshot (forTerminal), never the live store, so a provider edit or
   * delete cannot change how a live send is verified mid-flight. A provider with no classifier
   * (custom defs, shell) yields undefined here, which is exactly the ⟦DEC-4⟧ degraded path.
   */
  private sendOpts(term: Terminal): tmux.VerifiedSendOpts {
    const adapter = providerRegistry().forTerminal(term);
    const classify = adapter.composerPending;
    const composerText = adapter.composerText;
    return {
      composerPending: classify ? (snap: string) => classify(snap) : undefined,
      composerText: composerText ? (snap: string) => composerText(snap) : undefined,
      // A bare Enter into a permission dialog CONFIRMS the highlighted option, so the retry loop
      // stops rather than deciding a permission request for the operator.
      permissionPending: (snap: string) => adapter.parseState(snap) === 'needs-permission',
    };
  }

  /** ⟦DEC-2⟧ the went-working tie-break, offered ONLY when the provider actually signals a submit
   *  AND the terminal wasn't already working. The poller promotes 'working' from any screen change
   *  for every other provider — including the render of the text we just typed — so for them a
   *  'working' state proves nothing about a submit. Freshness narrows it; it is not provenance (a
   *  hook event and a poller promotion share one ingest path). */
  private tieBreak(term: Terminal): (() => boolean) | undefined {
    if (!providerRegistry().forTerminal(term).signalsSubmit) return undefined;
    if (term.state === 'working') return undefined;
    const before = term.lastEventAt;
    return () => {
      const t = this.store.getTerminal(term.id);
      return t?.state === 'working' && t.lastEventAt !== before;
    };
  }

  /**
   * Send a reply into the terminal. Gated: never inject while awaiting permission.
   *
   * SPEC-SUBMIT §5.1 — the send is VERIFIED, and `setWorking` runs only after it. A swallowed reply
   * used to force the terminal to 'working' anyway, producing a zombie that no signal could ever
   * clear (the agent never turns, so no turn-done arrives) and that only a human staring at the pane
   * could detect. Now a positive send failure throws, nothing else runs, and the route surfaces it as
   * the existing 409 — loud, and the state is left exactly as it was.
   */
  async reply(terminalId: string, text: string): Promise<void> {
    const term = this.mustLive(terminalId);
    if (term.state === 'blocked-permission') {
      throw new Error('terminal is awaiting a permission decision — approve or deny instead');
    }
    // reply() only refuses blocked-permission, so it can be called on a terminal that is ALREADY
    // 'working'; tieBreak() returns undefined for that case (and for every provider with no submit
    // signal), so an inconclusive reading degrades honestly instead of certifying itself.
    const outcome = await tmux.sendTextVerified(term.tmuxSocket, text, {
      ...this.sendOpts(term),
      wentWorking: this.tieBreak(term),
    });
    await this.setWorking(term);
    audit('terminal.reply', { terminalId });
    // ⟦DEC-4⟧ a degraded send is never silent. Skipped for shell (no composer, so every human reply
    // would be flagged — noise, not signal).
    if (outcome === 'unverified' && term.provider !== 'shell') {
      audit('terminal.reply.unverified', { terminalId, provider: term.provider });
    }
  }

  async approve(terminalId: string): Promise<void> {
    await this.decide(terminalId, 'approve');
  }
  async deny(terminalId: string): Promise<void> {
    await this.decide(terminalId, 'deny');
  }

  private async decide(terminalId: string, which: 'approve' | 'deny'): Promise<void> {
    const term = this.mustLive(terminalId);
    if (term.state !== 'blocked-permission') {
      throw new Error('no pending permission request on this terminal');
    }
    // The hook already put this terminal in blocked-permission. Before sending keys we
    // only try to catch the ONE dangerous case: the dialog is GONE and the screen is now
    // an idle prompt, where a stray 'y' would post as a chat message. We refuse only when
    // parseState positively reports idle ('turn-done'); an inconclusive read trusts the
    // hook state and proceeds — otherwise a permission the adapter under-detects would
    // wedge the human out of ever approving.
    // ACCEPTED LIMITATION: only gemini's parseState returns 'turn-done'. claude/codex have
    // no idle heuristic (it misfired badly — see their parseState), so for them this
    // re-check is inert and decide() trusts the hook-set blocked-permission state. In
    // practice a resolved dialog fires a Stop hook that moves the terminal off
    // blocked-permission first, so the stale-blocked window is small.
    const snap = await tmux.capturePlain(term.tmuxSocket, 60);
    // resolve off the terminal's FROZEN def snapshot (forTerminal), never the live
    // store — the control-plane keystroke path (recheck + approveKeys) must not shift under
    // a concurrent provider edit/delete mid-turn.
    const adapter = providerRegistry().forTerminal(term);
    if (adapter.parseState(snap) === 'turn-done') {
      throw new Error('permission dialog no longer present — refresh and retry');
    }
    const keys = adapter.approveKeys();
    await tmux.sendKeys(term.tmuxSocket, which === 'approve' ? keys.approve : keys.deny);
    await this.setWorking(term);
    audit('terminal.decide', { terminalId, decision: which });
  }

  private async setWorking(term: Terminal): Promise<void> {
    if (term.state !== 'working') {
      // SPEC-LOOPWEDGE — a human reply/approve/deny starts a fresh turn, so any inferred-idle mark
      // from the just-ended idle no longer describes the current state (clear it alongside the state).
      this.store.patchTerminal(term.id, { state: 'working', idleInferred: false });
      this.broadcast({ t: 'terminal-state', terminalId: term.id, state: 'working' });
      await this.pushAttention();
    }
  }

  private mustLive(terminalId: string): Terminal {
    const term = this.store.getTerminal(terminalId);
    if (!term || term.state === 'killed') throw new Error('terminal is not running');
    return term;
  }

  /** Forget ALL per-terminal in-memory state when a terminal dies (kill or vanish), so
   *  these maps don't leak unbounded across create/kill and VM-teardown cycles. */
  forget(terminalId: string): void {
    this.lastEmit.delete(terminalId);
    this.lastNudged.delete(terminalId);
    this.nudgeInFlight.delete(terminalId);
  }
}

/** Best-effort: pull the requested command/tool line out of a permission preview. */
function extractRequested(preview: string[]): string | undefined {
  for (const line of preview) {
    const m = line.match(/(?:run|execute|allow|command|tool)[:>\s]+(.{3,120})/i);
    if (m && m[1]) return m[1].trim();
  }
  // Fall back to the longest non-decorative line.
  const cand = preview.filter((l) => /[a-z0-9]/i.test(l) && !/^[─╭╮╰╯│┌┐└┘|=\s]+$/.test(l));
  return cand.sort((a, b) => b.length - a.length)[0]?.slice(0, 120);
}
