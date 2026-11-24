// Onboard assistant — the chat dock (SPEC-ASSISTANT + SPEC-ASSISTANT-CONTROL). A streaming chat
// over POST-SSE. In M-A1 it was strictly read-only; M-A3 turns it into a control surface: the brain
// never holds a mutating tool — it PROPOSES a typed, Tower-validated action, and the dock renders a
// Confirm card (below) showing the EXACT resolved args. Nothing mutates until the operator clicks.
// `codex exec --json` delivers assistant text whole at completion, so the dock shows a beacon
// "thinking…" pulse until the first text event lands. A turn emits SEVERAL whole agent_messages
// (a plan preamble, progress notes, the answer) — each seals its OWN bubble (sealAssistant),
// rather than folding into one. The persisted transcript stores one turn per bubble, so a
// reloaded conversation reproduces the same bubble sequence (openConversation maps 1:1).

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ROLE_IDS } from '../shared/roles.js';
import type {
  AssistantAccount,
  AssistantAction,
  AssistantConversationMeta,
  AssistantEvent,
  AssistantProposal,
} from '../shared/types.js';
import {
  confirmProposal,
  escapeBodyText,
  getConversation,
  getProposals,
  listAssistantAccounts,
  listConversations,
  rejectProposal,
  sanitizeCardText,
  streamAssistantMessage,
} from './assistant-api.js';
import { tower } from './api.js';
import { diffLines } from './skills-diff.js';
import type { DiffRow } from './skills-diff.js';
import { lintGateSabotage, skillProseScanText } from '../shared/skill-lint.js';
import type { SabotageFlag } from '../shared/skill-lint.js';
import { timeAgo } from './flightline-utils.js';
import { appendSegment } from '../shared/assistant-text.js';
import { renderRowBody } from './markdown.js';

type ErrorKind = Extract<AssistantEvent, { t: 'error' }>['kind'];

interface ToolChip {
  id: string;
  name: string;
  status: 'started' | 'completed';
}

// The dock renders a single ordered stream that interleaves chat turns with proposal cards. A card
// row only references a proposal by id; the live proposal data lives in a separate `proposals` map
// so a Confirm/Dismiss can update a card's status in place without disturbing stream order.
interface MsgRow {
  t: 'msg';
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking?: string;
  tools?: ToolChip[];
  streaming?: boolean;
  ts?: string;
}
interface CardRow {
  t: 'card';
  id: string;
  ts: string;
}
type Row = MsgRow | CardRow;

/** The AssistantEvent stream carries no conversation id, so the client mints one. */
function newConversationId(): string {
  return `ac-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- Proposal card helpers -------------------------------------------------------------------

// Role options for the Edit select derive from the shared registry (SPEC-ROUTING §1).
const PIPELINE_ROLES: string[] = [...ROLE_IDS];
const GATE_POLICIES = ['every', 'on-pass', 'never'];
const TASK_STATUSES_NEW = ['triage', 'todo', 'ready'];
const TASK_STATUSES_ALL = ['triage', 'todo', 'ready', 'archived'];
const PROFILE_PROVIDERS = ['codex', 'claude-code', 'gemini-cli'];
const ROUTABLE_PROVIDERS = ['codex', 'claude-code', 'gemini-cli', 'shell'];

/** The action's own fields (everything but the discriminant) — the EXACT resolved args to render. */
function argsOf(action: AssistantAction): Array<[string, unknown]> {
  return Object.entries(action).filter(([k]) => k !== 'kind');
}

/** Enum domains for the Edit selects. Returns null for a free-text/number field. For an open set
 *  (provider can be a custom:<slug>) the current value is folded in so Edit never silently drops it. */
function selectOptions(kind: string, field: string, current: unknown): string[] | null {
  switch (field) {
    case 'role':
      return PIPELINE_ROLES;
    case 'gatePolicy':
      return GATE_POLICIES;
    case 'status':
      return kind === 'update_task' ? TASK_STATUSES_ALL : kind === 'create_task' ? TASK_STATUSES_NEW : null;
    case 'priority':
      // update_task allows clearing the priority (null); '' is the "none" option.
      return kind === 'update_task' ? ['', '0', '1', '2', '3'] : ['0', '1', '2', '3'];
    case 'enabled':
      // set_project_autonomy / set_skill_enabled boolean flag — a true/false select so an Edit round-trips a
      // real boolean (buildOverride coerces it back; a stringified "true" would 400 at the server zod).
      return kind === 'set_project_autonomy' || kind === 'set_skill_enabled' ? ['true', 'false'] : null;
    case 'provider': {
      const base = kind === 'create_profile' ? PROFILE_PROVIDERS : ROUTABLE_PROVIDERS;
      const cur = typeof current === 'string' ? current : '';
      return cur && !base.includes(cur) ? [...base, cur] : base;
    }
    default:
      return null;
  }
}

function isNumberField(field: string): boolean {
  return field === 'maxIterations';
}

/** True for the one arg that is an OBJECT, not a scalar: set_project_skills' enable map. String(v) would
 *  render '[object Object]', so it gets bespoke `id → on/off` rendering and is read-only under Edit. */
function isEnableMapField(kind: string, field: string): boolean {
  return kind === 'set_project_skills' && field === 'enable';
}

/** Render the enable map as a readable `id → on/off` line (sanitized at the call site). */
function formatEnableMap(v: unknown): string {
  if (!v || typeof v !== 'object') return String(v ?? '');
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return '(none)';
  return entries.map(([id, on]) => `${id} → ${on ? 'on' : 'off'}`).join(', ');
}

function toDraft(args: Array<[string, unknown]>): Record<string, string> {
  const d: Record<string, string> = {};
  for (const [k, v] of args) d[k] = v == null ? '' : String(v);
  return d;
}

function pickId(v: unknown): string | null {
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id;
  }
  return null;
}

/** A short, sanitized outcome hint for an executed card (e.g. the created id or an archived count). */
function resultHint(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  const id = pickId(r) ?? pickId(r.task) ?? pickId(r.profile) ?? pickId(r.loop) ?? pickId(r.backlog);
  if (id) return sanitizeCardText(id);
  if (typeof r.archived === 'number') return sanitizeCardText(`${r.archived} archived`);
  return '';
}

/** A confirm that aborts because the target drifted since propose comes back as a `failed`
 *  whose error is the re-review message; render that as its own "changed — re-review" chip. */
function isDriftError(error?: string): boolean {
  return !!error && /re-?review|changed since proposed/i.test(error);
}

/** Render an already-sanitized command with its shell metacharacters visibly highlighted. Every
 *  piece is a text node (metachars wrapped in a highlight span) — no HTML is ever injected. */
function highlightCommand(cmd: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /[;|&$><`(){}\\!*?]/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const hit = m[0] ?? ''; // a single-char class always matches exactly one char
    if (m.index > last) nodes.push(cmd.slice(last, m.index));
    nodes.push(
      <span key={`m${k++}`} className="jv-prop-meta">
        {hit}
      </span>,
    );
    last = m.index + hit.length;
  }
  if (last < cmd.length) nodes.push(cmd.slice(last));
  return nodes;
}

const RISK_LABEL: Record<AssistantProposal['risk'], string> = {
  low: 'low risk',
  medium: 'medium risk',
  high: 'high risk',
};

// ---- promote_skill body diff (SPEC-SKILLS Phase 5b) --------------------------------------------

type PromoteDiffState =
  | { t: 'loading' }
  | { t: 'gone'; note: string }
  | { t: 'ready'; rows: DiffRow[]; isNew: boolean; flags: SabotageFlag[] };

/**
 * The promote_skill card's active→proposed BODY diff. The proposal shape stays FROZEN (scalar denorm,
 * no diff text on the record) — the card live-fetches both sides with the SESSION token the dock
 * already holds. Soundness: the render shows LIVE content, while the proposal pinned the draft hash
 * (on the action itself) and the target skill's contentHash (denorm) at propose time. If EITHER side
 * changes after propose — before or after this fetch — Confirm drift-voids with "changed since
 * proposed — re-review", and the promote route re-verifies the payload-pinned hash synchronously; so
 * there is no window where approved ≠ executed, at worst the operator re-reviews a fresh card. A
 * fetch failure / 404 (draft discarded, target deleted) renders the amber line — the confirm-time
 * re-enrich throws, so the card stays honest with no new server surface. No re-fetch on {t:'skills'}
 * is needed: staleness is drift-guarded, not render-guarded.
 *
 * Each body line renders as a React text node (auto-escaped, the SkillsPanel <pre> posture) run
 * through escapeBodyText: this diff is the card's whole defense over LLM-authored text, so bidi
 * overrides / zero-width runs / control chars must be VISIBLE (<U+XXXX>), never able to visually
 * reorder or hide a line — same rendering as sanitizeCardText, minus the length cap (truncation
 * would hide exactly the content under review). No draft META strings are rendered here (the
 * summary carries the names, already sanitized).
 */
function PromoteDiff({ action }: { action: AssistantAction }) {
  const draftId = (action as { draftId?: string }).draftId ?? '';
  const [state, setState] = useState<PromoteDiffState>({ t: 'loading' });

  useEffect(() => {
    let alive = true;
    void (async () => {
      let draft;
      try {
        draft = await tower.getSkillDraft(draftId);
      } catch {
        if (alive) setState({ t: 'gone', note: 'draft no longer readable — Confirm will refuse' });
        return;
      }
      // Gate-sabotage lint (SPEC-SKILLS Phase 5b wave 2): amber advisory rows over the SAME live
      // draft the diff renders, so the flags inherit the diff's own soundness argument — if the
      // draft changes after this fetch, the pinned hashes drift-void Confirm; flagged == rendered
      // == executed. Computed CLIENT-side only: the server never returns these to the model (the
      // no-oracle rule — see shared/skill-lint.ts). A flag never disables Confirm.
      const flags = lintGateSabotage(skillProseScanText(draft));
      if (draft.targetSkillId === undefined) {
        // New-skill path: everything is added.
        if (alive) setState({ t: 'ready', rows: draft.body.split('\n').map((line) => ({ t: 'add', line })), isNew: true, flags });
        return;
      }
      try {
        const active = await tower.getSkill(draft.targetSkillId);
        if (alive) setState({ t: 'ready', rows: diffLines(active.body, draft.body), isNew: false, flags });
      } catch {
        if (alive) setState({ t: 'gone', note: 'target skill no longer readable — Confirm will refuse' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [draftId]);

  if (state.t === 'loading') return <div className="jv-prop-diff-note">loading body diff…</div>;
  if (state.t === 'gone') return <div className="jv-prop-diff-note warn">⚠ {state.note}</div>;
  return (
    <>
      {state.flags.map((f) => (
        <div key={f.cls} className="jv-prop-diff-note warn">
          ⚠ possible gate sabotage: {f.label} — read the diff carefully
        </div>
      ))}
      <div className="jv-prop-diff-note">{state.isNew ? 'new skill — every line is added' : 'body diff — active → proposed'}</div>
      <div className="jv-prop-diff mono">
        {state.rows.map((r, i) => (
          <div key={i} className={`jv-prop-diff-row ${r.t}`}>
            <span className="jv-prop-diff-sign">{r.t === 'add' ? '+' : r.t === 'del' ? '−' : ' '}</span>
            {escapeBodyText(r.line)}
          </div>
        ))}
      </div>
    </>
  );
}

function StatusChip({ proposal }: { proposal: AssistantProposal }) {
  const { status } = proposal;
  // The Tower confirmed this one itself (autonomous mode) — the transcript must never let
  // an auto-run read as a human Confirm click, so every auto outcome carries the marker.
  const auto = proposal.autoConfirmed ? <span className="jv-prop-auto">· auto</span> : null;
  if (status === 'executed') {
    const hint = resultHint(proposal.result);
    return (
      <span className="jv-prop-chip ok">
        executed ✓{hint ? <span className="jv-prop-hint"> {hint}</span> : null}
        {auto}
      </span>
    );
  }
  if (status === 'rejected') return <span className="jv-prop-chip">rejected</span>;
  if (status === 'expired') return <span className="jv-prop-chip">expired (30 min)</span>;
  if (status === 'failed') {
    return isDriftError(proposal.error) ? (
      <span className="jv-prop-chip bad">changed — re-review{auto}</span>
    ) : (
      <span className="jv-prop-chip bad">failed: {sanitizeCardText(proposal.error ?? 'unknown error')}{auto}</span>
    );
  }
  return null;
}

function ProposalCard({
  proposal,
  onDecide,
  onSyncError,
}: {
  proposal: AssistantProposal;
  onDecide: (kind: 'confirm' | 'reject', action?: AssistantAction) => Promise<AssistantProposal>;
  onSyncError: () => void;
}) {
  // finalAction is what actually ran after an Edit; for a pending card it's absent and this is the
  // proposed action. Editing always seeds from the proposed args.
  const shown = proposal.finalAction ?? proposal.action;
  const kind = shown.kind;
  const shownArgs = argsOf(shown);
  const proposedArgs = argsOf(proposal.action);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(() => toDraft(proposedArgs));
  const [busy, setBusy] = useState<null | 'confirm' | 'reject'>(null);
  const [cardErr, setCardErr] = useState<string | null>(null);

  const pending = proposal.status === 'pending';
  const executing = proposal.status === 'executing';
  const terminal = !pending && !executing;
  const isHigh = proposal.risk === 'high';
  const checkCommand =
    kind === 'create_loop' && typeof (shown as { checkCommand?: unknown }).checkCommand === 'string'
      ? ((shown as { checkCommand?: string }).checkCommand ?? '')
      : '';

  function buildOverride(): AssistantAction {
    const args: Record<string, unknown> = {};
    for (const [key, origVal] of proposedArgs) {
      if (isEnableMapField(kind, key)) {
        // The enable map is read-only under Edit (rendered as id → on/off) — carry the original object
        // forward verbatim; a stringified draft would corrupt it into '[object Object]'.
        args[key] = origVal;
        continue;
      }
      const raw = draft[key] ?? '';
      if (isNumberField(key)) {
        if (raw !== '') args[key] = Number(raw);
      } else if (key === 'priority') {
        if (raw === '') {
          if (kind === 'update_task') args[key] = null;
        } else {
          args[key] = Number(raw);
        }
      } else if (key === 'enabled' && (kind === 'set_project_autonomy' || kind === 'set_skill_enabled')) {
        // Coerce the select's string back to the boolean the server zod requires.
        args[key] = raw === 'true';
      } else {
        args[key] = raw;
      }
    }
    // Same kind, edited args; the server re-validates (a bad arg → 400, surfaced on the card).
    return { kind, ...args } as AssistantAction;
  }

  const decide = async (which: 'confirm' | 'reject') => {
    setBusy(which);
    setCardErr(null);
    try {
      await onDecide(which, which === 'confirm' && editing ? buildOverride() : undefined);
      setEditing(false);
    } catch (e) {
      setCardErr((e as Error).message);
      onSyncError(); // reconcile status (already decided / expired / drifted) from the server
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`jv-prop ${isHigh ? 'high' : ''} ${terminal ? 'terminal' : ''}`}>
      <div className="jv-prop-head">
        <span className="jv-prop-kind">{sanitizeCardText(kind)}</span>
        <span className={`jv-prop-risk ${proposal.risk}`}>{RISK_LABEL[proposal.risk]}</span>
      </div>

      {isHigh && (
        <div className="jv-prop-warn">
          {kind === 'create_loop' ? (
            <>
              <div className="jv-prop-warn-line">⚠ Starts an autonomous agent</div>
              {checkCommand !== '' && (
                <>
                  <div className="jv-prop-warn-line">
                    ⚠ checkCommand runs as a shell command on the host each iteration
                  </div>
                  <div className="jv-prop-cmd mono">{highlightCommand(sanitizeCardText(checkCommand))}</div>
                </>
              )}
            </>
          ) : kind === 'set_project_autonomy' && (shown as { enabled?: unknown }).enabled === true ? (
            <div className="jv-prop-warn-line">
              ⚠ Removes the per-command permission gate for this project’s future claude-code agents
            </div>
          ) : kind === 'set_skill_enabled' ? (
            <div className="jv-prop-warn-line">
              ⚠ Changes which skill instructions are injected into every future agent
            </div>
          ) : kind === 'set_project_skills' ? (
            <div className="jv-prop-warn-line">
              ⚠ Changes which skill instructions are injected into this project’s future agents
            </div>
          ) : kind === 'promote_skill' ? (
            <>
              <div className="jv-prop-warn-line">
                ⚠ Publishes assistant-authored instructions into the shared skill library — once enabled,
                they are injected into every future claude-code / codex / gemini agent that selects this skill
              </div>
              <div className="jv-prop-warn-line">⚠ Lands disabled — you enable it separately (Settings → Skills)</div>
            </>
          ) : (
            <div className="jv-prop-warn-line">⚠ High-risk action — review the resolved arguments below</div>
          )}
        </div>
      )}

      <div className="jv-prop-summary">{sanitizeCardText(proposal.summary)}</div>

      {kind === 'promote_skill' && <PromoteDiff action={shown} />}

      {shownArgs.length > 0 && (
        <div className="jv-prop-args">
          {shownArgs.map(([k, v]) => {
            const enableMap = isEnableMapField(kind, k);
            const opts = editing && !enableMap ? selectOptions(kind, k, v) : null;
            const changed = editing && !enableMap && (draft[k] ?? '') !== (v == null ? '' : String(v));
            return (
              <div className={`jv-prop-arg ${changed ? 'changed' : ''}`} key={k}>
                <span className="jv-prop-key mono">{sanitizeCardText(k)}</span>
                <span className="jv-prop-val mono">
                  {enableMap ? (
                    // Read-only in BOTH modes: an object arg renders as id → on/off, never an editable field.
                    sanitizeCardText(formatEnableMap(v))
                  ) : !editing ? (
                    sanitizeCardText(v)
                  ) : opts ? (
                    <select value={draft[k] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}>
                      {opts.map((o) => (
                        <option key={o} value={o}>
                          {o === '' ? '— none —' : o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={isNumberField(k) ? 'number' : 'text'}
                      value={draft[k] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                    />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {terminal ? (
        <div className="jv-prop-foot">
          <StatusChip proposal={proposal} />
        </div>
      ) : executing || busy ? (
        <div className="jv-prop-foot">
          <span className="jv-prop-chip executing">
            <i className="jv-prop-sp" /> {busy === 'reject' ? 'dismissing…' : 'executing…'}
          </span>
        </div>
      ) : (
        <div className="jv-prop-foot">
          <button className="btn-sm ok" onClick={() => void decide('confirm')}>
            {editing ? 'Confirm edits' : 'Confirm'}
          </button>
          {editing ? (
            <button
              className="btn-sm"
              onClick={() => {
                setEditing(false);
                setDraft(toDraft(proposedArgs));
              }}
            >
              Cancel
            </button>
          ) : (
            // Edit is hidden for promote_skill: its two args are machine tokens with no human-editable
            // meaning, and hiding the form closes the one UI path around the propose-time card (the
            // action-side hash pin still guards a hand-crafted override — actions.ts).
            shownArgs.length > 0 && kind !== 'promote_skill' && (
              <button className="btn-sm" onClick={() => setEditing(true)}>
                Edit
              </button>
            )
          )}
          <button className="btn-sm danger" onClick={() => void decide('reject')}>
            Dismiss
          </button>
        </div>
      )}

      {cardErr && <div className="jv-prop-err">{sanitizeCardText(cardErr)}</div>}
    </div>
  );
}

export function AssistantDock({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  const [accounts, setAccounts] = useState<AssistantAccount[] | null>(null); // null = loading
  const [recent, setRecent] = useState<AssistantConversationMeta[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [proposals, setProposals] = useState<Record<string, AssistantProposal>>({});
  const [convId, setConvId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ kind: ErrorKind; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const connected = accounts !== null && accounts.length > 0;
  // Mirrors the server's getActiveAccount (the first account answers the dock). When it opted
  // into autonomous mode the header must say so persistently — the "you confirm" promise is off.
  const autonomous = !!accounts?.[0]?.autoConfirm;
  const pendingCount = Object.values(proposals).filter((p) => p.status === 'pending').length;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const accts = await listAssistantAccounts();
        if (!alive) return;
        setAccounts(accts);
        if (accts.length > 0) {
          const convs = await listConversations().catch(() => [] as AssistantConversationMeta[]);
          if (alive) setRecent([...convs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5));
        }
      } catch (e) {
        if (!alive) return;
        setAccounts([]);
        setErr({ kind: 'other', message: (e as Error).message });
      }
    })();
    return () => {
      alive = false;
      abortRef.current?.abort(); // kill an in-flight turn when the dock unmounts
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows, busy]);

  useEffect(() => {
    if (connected && !busy) taRef.current?.focus();
  }, [connected, busy]);

  // Patch the most recent assistant bubble (which may no longer be the last row once a proposal
  // card has been appended after it).
  const patchLastAssistant = (fn: (m: MsgRow) => MsgRow) =>
    setRows((rs) => {
      for (let i = rs.length - 1; i >= 0; i--) {
        const r = rs[i];
        if (r && r.t === 'msg' && r.role === 'assistant') {
          const patched = fn(r);
          return rs.map((row, j) => (j === i ? patched : row));
        }
      }
      return rs;
    });

  /** Seal the current (streaming) assistant bubble with one whole agent_message and open a fresh
   *  placeholder for the next one. Each agent_message is a distinct utterance, so it gets its own
   *  bubble — no fold. One setRows so React batching can't interleave the seal and the new
   *  placeholder. INVARIANT: the streaming placeholder is always the last assistant msg row (a
   *  mid-turn proposal card inserts BEFORE it — see upsertProposal), which keeps live order equal
   *  to reload order (openConversation sorts turns+cards by ts). */
  const sealAssistant = (delta: string) =>
    setRows((rs) => {
      const now = new Date().toISOString();
      for (let i = rs.length - 1; i >= 0; i--) {
        const r = rs[i];
        if (r && r.t === 'msg' && r.role === 'assistant') {
          const next = rs.slice();
          next[i] = { ...r, text: delta, streaming: false, ts: now };
          next.push({ t: 'msg', role: 'assistant', text: '', streaming: true, ts: now });
          return next;
        }
      }
      return rs;
    });

  /** Record/refresh a proposal; on a live event also insert its card into the stream (once). */
  const upsertProposal = (p: AssistantProposal, appendRow: boolean) => {
    setProposals((prev) => ({ ...prev, [p.id]: p }));
    if (appendRow) {
      setRows((rs) => {
        if (rs.some((r) => r.t === 'card' && r.id === p.id)) return rs;
        const card: Row = { t: 'card', id: p.id, ts: p.createdAt };
        // Keep the trailing streaming placeholder last so the next sealed bubble lands AFTER
        // this card (true arrival order), matching how reload sorts card vs bubble by ts.
        const last = rs[rs.length - 1];
        if (last && last.t === 'msg' && last.role === 'assistant' && last.streaming) {
          return [...rs.slice(0, -1), card, last];
        }
        return [...rs, card];
      });
    }
  };

  const refreshProposals = () => {
    if (!convId) return;
    void getProposals(convId)
      .then((props) =>
        setProposals((prev) => {
          const next = { ...prev };
          for (const p of props) next[p.id] = p;
          return next;
        }),
      )
      .catch(() => {
        /* reconcile is best-effort */
      });
  };

  const decide = async (id: string, which: 'confirm' | 'reject', action?: AssistantAction): Promise<AssistantProposal> => {
    const updated = which === 'confirm' ? await confirmProposal(id, action) : await rejectProposal(id);
    upsertProposal(updated, false); // a confirmed/rejected card is replaced by its returned proposal
    return updated;
  };

  const handleEvent = (ev: AssistantEvent) => {
    if (ev.t === 'text') {
      // Each delta is a WHOLE agent_message (codex-events.ts); seal it as its own bubble.
      // Skip a whitespace-only delta so an empty message can't seal a blank bubble (the route
      // flush guards the same way, keeping live and persisted identical).
      if (!ev.delta.trim()) return;
      setErr(null); // a real answer arrived — clear any transient error banner
      sealAssistant(ev.delta);
    } else if (ev.t === 'thinking') {
      patchLastAssistant((m) => ({ ...m, thinking: appendSegment(m.thinking ?? '', ev.delta) }));
    } else if (ev.t === 'tool') {
      patchLastAssistant((m) => {
        const tools = [...(m.tools ?? [])];
        const cid = ev.id || ev.name || 'tool'; // guard empty ids; keying on name lets started→completed of the same call share one chip
        const i = tools.findIndex((t) => t.id === cid);
        const chip: ToolChip = { id: cid, name: ev.name, status: ev.status };
        if (i >= 0) tools[i] = chip;
        else tools.push(chip);
        return { ...m, tools };
      });
    } else if (ev.t === 'proposal') {
      upsertProposal(ev.proposal, true); // render a Confirm card inline at this point in the stream
    } else if (ev.t === 'error') {
      setErr({ kind: ev.kind, message: ev.error });
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy || !connected) return;
    const cid = convId ?? newConversationId();
    setConvId(cid);
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    setErr(null);
    const now = new Date().toISOString();
    setRows((rs) => [
      ...rs,
      { t: 'msg', role: 'user', text, ts: now },
      { t: 'msg', role: 'assistant', text: '', streaming: true, ts: now },
    ]);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamAssistantMessage(text, cid, handleEvent, ac.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setErr({ kind: 'other', message: (e as Error).message });
    } finally {
      abortRef.current = null;
      setBusy(false);
      setRows((rs) => {
        for (let i = rs.length - 1; i >= 0; i--) {
          const r = rs[i];
          if (r && r.t === 'msg' && r.role === 'assistant') {
            if (!r.streaming) return rs;
            // Count only COMPLETED tools toward "non-empty" — the route persists a trailing
            // bubble only for thinking or completed tools (routes.ts flush), so a tool left
            // 'started' (interrupted before completion, no following message) must NOT keep a
            // trailing bubble alive here, or it would show a stuck spinner live yet vanish on
            // reload. Mirrors the route so live == persisted.
            const hasCompletedTool = (r.tools ?? []).some((t) => t.status === 'completed');
            const empty = !r.text && !r.thinking && !hasCompletedTool;
            if (empty) return rs.filter((_, j) => j !== i); // turn failed before producing anything — drop the empty bubble
            return rs.map((row, j) => (j === i ? { ...r, streaming: false } : row));
          }
        }
        return rs;
      });
    }
  };

  const newChat = () => {
    abortRef.current?.abort();
    setRows([]);
    setProposals({});
    setConvId(null);
    setErr(null);
  };

  const openConversation = async (meta: AssistantConversationMeta) => {
    try {
      const [turns, props] = await Promise.all([
        getConversation(meta.id),
        getProposals(meta.id).catch(() => [] as AssistantProposal[]),
      ]);
      const merged: Row[] = [
        ...turns.map((t): Row => ({
          t: 'msg',
          role: t.role,
          text: t.text,
          thinking: t.thinking,
          // Persisted tools are names only; synthesize a unique id per chip (two completed calls
          // to the same tool would otherwise collide on the React key). All reloaded chips are
          // completed — a started-never-completed call was never persisted.
          tools: t.tools?.map((name, idx) => ({ id: `${name}#${idx}`, name, status: 'completed' as const })),
          ts: t.ts,
        })),
        ...props.map((p): Row => ({ t: 'card', id: p.id, ts: p.createdAt })),
      ].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? '')); // merge cards+bubbles by ts; an
      // exact-ms tie sorts turns before cards (stable sort, turns listed first) — live may differ
      // by one tick on a tie, cosmetic (no clean static tiebreak that holds for both orderings).
      setProposals(Object.fromEntries(props.map((p) => [p.id, p] as [string, AssistantProposal])));
      setConvId(meta.id);
      setRows(merged);
      setErr(null);
    } catch (e) {
      setErr({ kind: 'other', message: (e as Error).message });
    }
  };

  const errBanner = err && (
    <div className={`assist-err ${err.kind === 'quota' || err.kind === 'auth' ? '' : 'danger'}`}>
      <span>
        {err.kind === 'quota' && 'Your Codex usage limit is reached — try again later.'}
        {err.kind === 'auth' && (
          <>
            The assistant’s Codex login expired — re-log in via{' '}
            <button className="lnk" onClick={onOpenSettings}>Settings → Assistant</button>.
          </>
        )}
        {err.kind === 'sandbox' && 'Sandbox unavailable — install bubblewrap, or allow the no-sandbox override in Settings.'}
        {err.kind === 'other' && err.message}
      </span>
      <button className="x" onClick={() => setErr(null)} aria-label="Dismiss error">✕</button>
    </div>
  );

  return (
    <aside
      className="assist"
      role="dialog"
      aria-label="Onboard assistant"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="assist-head">
        <span className="mk" />
        <span className="ttl">Onboard assistant</span>
        {autonomous ? (
          <span
            className="assist-ro warn"
            title="Autonomous mode is on — Jarvis runs its proposed actions without a confirm step, except the seven that always wait for your Confirm: starting a loop with a host check command, registering a project, initializing & pushing a repository, arming a project’s autonomy, enabling/disabling a skill, setting a project’s skill selection, and publishing a drafted skill. Turn it off in Settings → Assistant."
          >
            autonomous
          </span>
        ) : (
          <span className="assist-ro" title="The assistant proposes changes; nothing runs until you confirm the exact args">you confirm</span>
        )}
        {pendingCount > 0 && (
          <span className="jv-prop-badge" title={`${pendingCount} proposal${pendingCount > 1 ? 's' : ''} awaiting confirm`}>
            {pendingCount} pending
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn sm ghost" onClick={onOpenSettings} title="Assistant settings">settings</button>
        {connected && rows.length > 0 && (
          <button className="btn sm ghost" onClick={newChat}>new chat</button>
        )}
        <button className="x" onClick={onClose} aria-label="Close assistant">✕</button>
      </div>

      {accounts === null ? (
        <div className="assist-loading">
          <span className="assist-think"><i /><i /><i /> checking assistant…</span>
        </div>
      ) : !connected ? (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div className="assist-onboard">
            <div className="ob-title">Assistant isn’t set up yet</div>
            <p>
              Connect a Codex account (your own ChatGPT subscription) in <b>Settings → Assistant</b>, then come back
              here to chat. It reads your runs, loops and health — and can <b>propose</b> changes (add a provider, groom
              the board, start a run) that you review and confirm. Nothing changes until you click Confirm.
            </p>
            <div><button className="btn ok" onClick={onOpenSettings}>Open Settings → Assistant</button></div>
          </div>
          {errBanner}
        </div>
      ) : (
        <>
          <div className="assist-msgs" ref={scrollRef}>
            {rows.length === 0 && (
              <div className="assist-empty">
                <div className="hi">Tower copilot on deck.</div>
                <p>
                  Ask about the fleet — “what needs my attention?”, “how did the auth loop end?” — or ask it to DO
                  things: “route the review role to codex”, “clear the finished cards”.{' '}
                  {autonomous
                    ? 'It proposes and confirms its own cards — new projects, loops that run a host command, autonomy changes, skill changes, and publishing drafted skills still wait for you.'
                    : 'It proposes; you confirm.'}
                </p>
                {recent.length > 0 && (
                  <>
                    <div className="rc-head">Recent conversations</div>
                    {recent.map((c) => (
                      <button key={c.id} className="rc" onClick={() => void openConversation(c)}>
                        <span className="rc-t">{c.title || 'untitled'}</span>
                        <span className="rc-ago">{timeAgo(c.updatedAt)}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
            {rows.map((row, i) => {
              if (row.t === 'card') {
                const p = proposals[row.id];
                if (!p) return null;
                return (
                  <ProposalCard
                    key={`card-${row.id}`}
                    proposal={p}
                    onDecide={(which, action) => decide(row.id, which, action)}
                    onSyncError={refreshProposals}
                  />
                );
              }
              if (row.role === 'system') {
                return (
                  <div key={`msg-${i}`} className="jv-sys">
                    <span className="jv-sys-tag">System</span>
                    <span className="jv-sys-text">{sanitizeCardText(row.text)}</span>
                  </div>
                );
              }
              return (
                <div key={`msg-${i}`} className={`amsg ${row.role}`}>
                  {row.thinking ? <div className="think">{row.thinking}</div> : null}
                  {row.tools && row.tools.length > 0 && (
                    <div className="atools">
                      {row.tools.map((t) => (
                        <span key={t.id} className={`atool ${t.status === 'completed' ? 'done' : ''}`}>
                          {t.status === 'started' && <i className="sp" />}· consulted {t.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {row.text ? (
                    // Markdown is for the ANSWER text only — renderRowBody gates on role, so
                    // user text stays the literal string; the thinking div stays plain (raw
                    // stream-error text routes there) and proposal cards / jv-sys keep their
                    // no-markdown sanitize path — all of these are security invariants.
                    <span className={row.streaming ? 'acur' : undefined}>
                      {renderRowBody(row.role, row.text)}
                    </span>
                  ) : row.streaming ? (
                    <span className="assist-think"><i /><i /><i /> thinking…</span>
                  ) : null}
                </div>
              );
            })}
          </div>
          {errBanner}
          <div className="assist-compose">
            <textarea
              ref={taRef}
              rows={1}
              placeholder={busy ? 'thinking…' : 'Ask the tower…  (Enter sends, Shift+Enter = new line)'}
              aria-label="Message the assistant"
              value={input}
              disabled={busy}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.currentTarget;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="btn ok" disabled={busy || !input.trim()} onClick={() => void send()}>
              Send
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
