// Outcomes — a derived LENS answering criterion 3 ("the data to decide who's good at what",
// SPEC-PROVIDERS §U J4). Rows are provider × model × role; columns are sorties run, judge
// pass rate, avg iterations-to-done, and landed count. Like the Board it is DERIVED TRUTH ONLY:
// a pure read-model over the props it is handed — zero fetches, zero state, no new capture.
// Every number comes from data v1 already persists (Loop.provider/model, Loop.iterations[].
// validator verdicts, Loop.iteration count, Loop.landedAt); the role dimension is joined from
// the missions prop (loop.sortieId → the sortie's role).
//
// HONEST-DEGRADATION RULE: a tier-C (dwell-only) provider can false-idle on a
// network-bound think and commit a half-turn, poisoning its pass-rate / iteration numbers. So
// tier-C rows are flagged 'detection-degraded' — their pass rate must NOT be read as a verdict
// on the model, it may be a verdict on the completion signal. Built-ins and tier-A/B customs
// carry a real/screen signal and are not flagged.
//
// Honest limit (§5.8): these numbers are only decision-grade after N real missions of history;
// a low-sample banner says so rather than letting a 1/1 read as "100%".

import { PIPELINE_ROLES } from '../shared/roles.js';
import type { Loop, Mission, ProviderId, ProviderDef, PipelineRole } from '../shared/types.js';

// ---- provider idioms (mirror BoardView / App.tsx) ----
function avClass(p: ProviderId): 'cc' | 'gm' | 'cx' | 'he' | 'cu' | 'sh' {
  return p === 'claude-code' ? 'cc' : p === 'gemini-cli' ? 'gm' : p === 'codex' ? 'cx' : p === 'hermes' ? 'he'
    : p.startsWith('custom:') ? 'cu' : 'sh';
}
function avText(p: ProviderId): string {
  return p === 'claude-code' ? 'CC' : p === 'gemini-cli' ? 'GM' : p === 'codex' ? 'CX' : p === 'hermes' ? 'HE'
    : p.startsWith('custom:') ? 'CU' : 'SH';
}
const BUILTIN_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code', 'gemini-cli': 'Gemini CLI', codex: 'Codex', shell: 'Shell', hermes: 'Hermes',
};
function providerLabel(p: ProviderId, providers: ProviderDef[]): string {
  if (!p.startsWith('custom:')) return BUILTIN_LABEL[p] ?? p;
  return providers.find((d) => d.id === p)?.displayName ?? p.slice('custom:'.length);
}

// Derived from the shared role registry (SPEC-ROUTING §1) so a new role labels its chip with no
// edit here (this was an exhaustive hand-written Record that broke tsc whenever the union grew).
// Lowercased to keep the chip's original casing.
const ROLE_LABEL = Object.fromEntries(
  PIPELINE_ROLES.map((r) => [r.id, r.label.toLowerCase()]),
) as Record<PipelineRole, string>;

// ---- reliability tier, derived from the def's turn.mode (never stored — one source of truth) ----
// Built-ins wire real ct-hook signals (tier-A parity). A custom id whose def was since deleted
// is unknown ('?') — we can't vouch for its signal, but we don't assert 'degraded' either.
type Tier = 'A' | 'B' | 'C' | '?';
function tierOf(p: ProviderId, providers: ProviderDef[]): Tier {
  if (!p.startsWith('custom:')) return 'A';
  const def = providers.find((d) => d.id === p);
  if (!def) return '?';
  return def.turn.mode === 'webhook' ? 'A' : def.turn.mode === 'screen-regex' ? 'B' : 'C';
}

interface OutcomeRow {
  key: string;
  provider: ProviderId;
  model: string; // '' = provider default (no model threaded)
  role: PipelineRole | ''; // '' = standalone loop / no role
  tier: Tier;
  runs: number; // sorties (loops) run in this group
  landed: number; // loops with a land record
  pass: number;
  fail: number;
  inconclusive: number; // judge verdicts across every iteration in the group
  iterSum: number;
  iterCount: number; // over COMPLETED loops only (landed or done) → avg iterations-to-done
}

const LOW_SAMPLE = 20; // J4's "~20 missions" — below this the lens is labeled not-yet-decision-grade.

export function OutcomesView({
  loops, missions, providers,
}: {
  /** Every loop in the fleet — the run-level fact table (provider/model/iterations/verdicts/land). */
  loops: Loop[];
  /** Missions supply the role dimension only: loop.sortieId → the sortie's PipelineRole. A loop
   *  that is not a mission sortie has no role and lands in the '—' role bucket. */
  missions: Mission[];
  /** The live custom-provider roster (GET /api/providers). Used ONLY to derive each provider's
   *  reliability tier (turn.mode → A/B/C) for the tier-C 'detection-degraded' flag, and to
   *  resolve a custom provider's displayName. Built-ins need no def (static coded adapters). */
  providers: ProviderDef[];
}) {
  // sortieId → role, built once from the mission plans.
  const roleBySortie = new Map<string, PipelineRole | undefined>();
  for (const m of missions) for (const ph of m.phases) for (const s of ph.sorties) roleBySortie.set(s.id, s.role);

  const rows = new Map<string, OutcomeRow>();
  for (const l of loops) {
    const model = l.model?.trim() ?? '';
    const role: PipelineRole | '' = (l.sortieId && roleBySortie.get(l.sortieId)) || '';
    const key = `${l.provider}|${model}|${role}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        key, provider: l.provider, model, role, tier: tierOf(l.provider, providers),
        runs: 0, landed: 0, pass: 0, fail: 0, inconclusive: 0, iterSum: 0, iterCount: 0,
      };
      rows.set(key, r);
    }
    r.runs++;
    if (l.landedAt) r.landed++;
    if (l.landedAt || l.status === 'done') { r.iterSum += l.iteration; r.iterCount++; }
    for (const it of l.iterations) {
      const v = it.validator?.verdict;
      if (v === 'pass') r.pass++;
      else if (v === 'fail') r.fail++;
      else if (v === 'inconclusive') r.inconclusive++;
    }
  }

  const list = [...rows.values()].sort((a, b) => b.runs - a.runs || b.landed - a.landed);
  const totalRuns = loops.length;
  const degradedRows = list.filter((r) => r.tier === 'C').length;

  return (
    <div className="flightline">
      <div className="view-title">
        <h1>Outcomes</h1>
        <span className="sub">
          derived · {list.length} provider×model×role group{list.length === 1 ? '' : 's'} over {totalRuns} run{totalRuns === 1 ? '' : 's'}
        </span>
      </div>

      {totalRuns < LOW_SAMPLE && totalRuns > 0 && (
        <div className="oc-note">
          Needs history to be useful — this lens is a derived read-model over completed runs, and
          {' '}{totalRuns} run{totalRuns === 1 ? '' : 's'} is below the ~{LOW_SAMPLE} it takes for a
          pass rate to mean more than luck. Read it as a trend forming, not a verdict yet.
        </div>
      )}
      {degradedRows > 0 && (
        <div className="oc-note oc-note-warn">
          {degradedRows} row{degradedRows === 1 ? '' : 's'} ran on a tier-C (dwell-only) provider,
          flagged <b>detection-degraded</b>: a no-signal harness can false-idle mid-think and commit a
          half-turn, so its pass rate may grade the completion signal, not the model. Prefer tier A/B
          before comparing.
        </div>
      )}

      {totalRuns === 0 ? (
        <div className="oc-empty">
          No runs yet. Once loops and mission sorties complete, this lens groups them by
          provider × model × role so you can see who earns which cognitive-shape role — cheap local
          models that one-shot exploration, strong models that carry implementation. Route your role
          defaults (Settings → Routing) from what you learn here.
        </div>
      ) : (
        <div className="oc-table">
          <div className="oc-row oc-head">
            <div className="oc-c-prov">Provider</div>
            <div className="oc-c-model">Model</div>
            <div className="oc-c-role">Role</div>
            <div className="oc-c-num" title="Sorties (loops) run in this group">Runs</div>
            <div className="oc-c-rate" title="Judge pass rate over decided (pass/fail) verdicts; the mix shows ✓ pass · ✗ fail · ? inconclusive">Judge pass rate</div>
            <div className="oc-c-num" title="Average iterations-to-done over completed loops (landed or done)">Avg iters</div>
            <div className="oc-c-num" title="Loops with a land record">Landed</div>
          </div>
          {list.map((r) => <OutcomeRowView key={r.key} row={r} providers={providers} />)}
        </div>
      )}
    </div>
  );
}

function OutcomeRowView({ row, providers }: { row: OutcomeRow; providers: ProviderDef[] }) {
  const decided = row.pass + row.fail;
  const rate = decided > 0 ? row.pass / decided : null;
  const avgIter = row.iterCount > 0 ? row.iterSum / row.iterCount : null;
  const degraded = row.tier === 'C';
  return (
    <div className={`oc-row${degraded ? ' oc-degraded' : ''}`}>
      <div className="oc-c-prov">
        <span className={`oc-av oc-av-${avClass(row.provider)}`}>{avText(row.provider)}</span>
        <span className="oc-prov-name" title={row.provider}>{providerLabel(row.provider, providers)}</span>
        <span className={`oc-tier oc-tier-${row.tier === '?' ? 'unknown' : row.tier}`}
          title={tierTitle(row.tier)}>{row.tier === '?' ? '?' : `tier ${row.tier}`}</span>
      </div>
      <div className="oc-c-model mono">{row.model || <span className="faint">default</span>}</div>
      <div className="oc-c-role">
        {row.role ? <span className="oc-role-chip">{ROLE_LABEL[row.role]}</span> : <span className="faint">—</span>}
      </div>
      <div className="oc-c-num mono">{row.runs}</div>
      <div className="oc-c-rate">
        {rate === null ? <span className="faint">—</span> : (
          <span className="oc-rate">
            <span className={`oc-rate-pct${degraded ? ' oc-rate-degraded' : ''}`}>{Math.round(rate * 100)}%</span>
            <span className="oc-mix">
              <span className="oc-mix-p" title={`${row.pass} pass`}>✓{row.pass}</span>
              <span className="oc-mix-f" title={`${row.fail} fail`}>✗{row.fail}</span>
              {row.inconclusive > 0 && <span className="oc-mix-i" title={`${row.inconclusive} inconclusive`}>?{row.inconclusive}</span>}
            </span>
          </span>
        )}
        {degraded && <span className="oc-degraded-chip" title="tier-C dwell-only: pass rate may reflect a false-idle, not the model">detection-degraded</span>}
      </div>
      <div className="oc-c-num mono">{avgIter === null ? <span className="faint">—</span> : avgIter.toFixed(1)}</div>
      <div className="oc-c-num mono">{row.landed}</div>
    </div>
  );
}

function tierTitle(t: Tier): string {
  return t === 'A' ? 'Tier A — webhook: real completion signal (parity with built-ins)'
    : t === 'B' ? 'Tier B — screen-regex: done detected from pane text'
    : t === 'C' ? 'Tier C — dwell-only: completion INFERRED from output quiescence (degraded)'
    : 'Provider def not in the current roster — reliability tier unknown';
}
