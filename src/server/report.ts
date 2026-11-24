// SPEC-LOOP W4 — the deterministic, ZERO-LLM delivery report.
//
// The FIRST time a mission transitions INTO 'done' OR 'failed', missions.ts fires this off the
// patch() write choke point (fire-and-forget). We SYNCHRONOUSLY write, under
// `~/.ct/reports/<missionId>/`:
//   report.json   — the source of truth (the web renders React FROM it; its existence is the
//                   completion marker). Written LAST + atomically (tmp+rename) so a crash mid-generate
//                   never leaves a half-written report.json (SPEC-LOOP §3 W4 — the no-HTML-at-origin
//                   rule + crash-safety).
//   REPORT.md     — deterministic markdown (goal, per-round pass/fail, per-phase sorties + route, proof).
//   REPORT.html   — a self-contained, DOWNLOAD-ONLY standalone file (never served at the app origin —
//                   §3 W4). Images inline as data: URIs (≤1.5MB, at most MAX_INLINE_IMAGES); every other
//                   proof renders as ESCAPED PLAIN TEXT naming its on-disk path — NEVER a hyperlink.
//   proof/        — the run metas + artifacts, copied SYNCHRONOUSLY at the transition BEFORE the write
//                   path yields (§3 W4 — races the KEEP_TEST_RUNS=50 test-run GC, which could otherwise
//                   delete the source run dir before we copy it).
//
// FROZEN INVARIANTS:
//  - report-never-blocks-done: generate() NEVER throws (top-level try/catch). A report failure must not
//    break the done/failed write that fired it.
//  - report.json is written LAST + atomically — its presence marks a complete report.
//  - SECRETS: the report carries only metadata (names/goals/statuses/branches/provider-model ids/run
//    counts). We copy each run's meta.json + artifacts into proof/, but NEVER its `logs/` subtree
//    (W5 server/docker logs carry tokens) and NEVER any env/token. report.json embeds no file contents.
//
// SYNC-STALL BOUND: generate() runs synchronously on the transition so report.json is on disk before the
// done/failed SSE frame flushes (the web never sees a done mission without its report). The cost is a
// one-shot bounded stall: ≤MAX_PROOF_TOTAL_BYTES of copyFileSync (fast copy_file_range) + ≤MAX_INLINE_IMAGES
// × ≤1.5MB of readFileSync/base64 for HTML inlining — kept small deliberately, once per mission finish.

import { mkdirSync, existsSync, readdirSync, lstatSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { paths } from './paths.js';
import { writeJsonAtomic } from './store.js';
import { isConfirmed } from './reviews.js';
import { audit } from './audit.js';
import { triageCounts } from '../shared/types.js';
import type {
  Mission, MissionPhase, MissionReport, MissionReportPhase, MissionReportProofEntry, MissionReportReview,
  MissionReportInvestigation, MissionReportResearchFinding, ProviderId, ReviewRecord, ResearchRecord, TestTriageEntry, TestFailure,
} from '../shared/types.js';

/** Charset gate applied to missionId BEFORE any join into paths.reports (path-traversal guard, the
 *  RUN_ID_RE precedent in testkit.ts). Mission ids are shortId() = [a-z0-9]; anything else never
 *  touches the filesystem. */
const MISSION_ID_RE = /^[a-z0-9]{1,64}$/;

// Proof-copy caps — these apply to the run-<runId>.json meta copies TOO, not just artifacts. Kept
// modest so the one-shot synchronous copy at the terminal transition is a brief, bounded stall.
const MAX_PROOF_FILES = 40;
const MAX_PROOF_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_PROOF_FILE_BYTES = 5 * 1024 * 1024;
// SPEC-RESEARCH W9 — how many research findings the report carries. The store keeps up to 100 per
// mission (raised so pruning can never make the reconcile gate's note false about a sortie that DID
// submit), and each summary can be 8KB — an uncapped section would put ~820KB of prose in report.json
// and again in the inlined HTML twin. Newest 25 keeps any realistic mission whole; the full set always
// remains in research.json. Note that file is never GC'd and is rewritten whole per submit — the same
// characteristics as reviews.json, at 5× the bound and a larger per-record ceiling.
const MAX_REPORT_RESEARCH = 25;
/** Largest image inlined into REPORT.html as a data: URI; bigger images render as an escaped path. */
const MAX_INLINE_IMAGE_BYTES = 1.5 * 1024 * 1024;
/** Cap on images base64-inlined into REPORT.html (the CPU cost of the sync stall); beyond this an image
 *  proof renders as an escaped path like any non-image. */
const MAX_INLINE_IMAGES = 6;

/** The read-only slices report.ts drives. `loops` carries each sortie's resolved provider/model/branch;
 *  `testkit.getRun` resolves a pinned run id to its on-disk dir for the proof copy. */
export interface ReportsDeps {
  loops: { get(id: string): { branch?: string; provider?: ProviderId; model?: string; effort?: string } | undefined };
  /** SPEC-LOOP W7 — `triage` + `results` are added to the getRun return for the Investigations section
   *  (TestKit still satisfies it structurally; both fields are read-only here). `results` is needed so the
   *  investigation counts are computed at OCCURRENCE granularity (partitionByTriage), matching the fixer. */
  testkit: { getRun(id: string): { id: string; runDir: string; triage?: TestTriageEntry[]; results?: TestFailure[] } | undefined };
  /** SPEC-LOOP W6 — the mission's recorded code reviews (newest first), for the Code-review section. */
  reviews: { listFor(missionId: string): ReviewRecord[] };
  /** SPEC-RESEARCH W9 — the mission's research findings (newest first), for the Research section. */
  research: { listFor(missionId: string): ResearchRecord[] };
}

export class Reports {
  constructor(private deps: ReportsDeps) {}

  /**
   * Generate the mission's delivery report. FULLY SYNCHRONOUS and NEVER THROWS: any failure is
   * swallowed (report-never-blocks-done). Writes proof/ → REPORT.md → REPORT.html → report.json LAST.
   */
  generate(mission: Mission): void {
    try {
      // Path-traversal guard BEFORE any join into paths.reports.
      if (!MISSION_ID_RE.test(mission.id)) return;
      const reportDir = join(paths.reports, mission.id);
      const proofDir = join(reportDir, 'proof');
      mkdirSync(proofDir, { recursive: true });

      // §3 W4 — copy proof SYNCHRONOUSLY now, BEFORE report.json is written and control yields, so the
      // KEEP_TEST_RUNS GC can't delete a source run dir out from under us.
      const proof = this.copyProof(mission, proofDir);

      const report = this.buildReport(mission, proof);

      // SPEC-LOOP §3 W4 + crash-safety: proof (done) → REPORT.md → REPORT.html → report.json LAST + atomic.
      writeFileSync(join(reportDir, 'REPORT.md'), renderMarkdown(report), 'utf8');
      writeFileSync(join(reportDir, 'REPORT.html'), renderHtml(report, proofDir), 'utf8');
      writeJsonAtomic(join(reportDir, 'report.json'), report);

      audit('mission.report', { missionId: mission.id, status: report.status, proof: proof.length });
    } catch (err) {
      // report-never-blocks-done — a report failure must never break the done/failed write.
      console.error('[report] generate failed:', err);
    }
  }

  /** SPEC-LOOP §3 W4 — copy each pinned run's meta.json (as run-<runId>.json) + its artifacts into proof/, under
   *  the shared caps. lstat + regular-file discipline (no symlink deref), mirroring the artifact copy. */
  private copyProof(mission: Mission, proofDir: string): MissionReportProofEntry[] {
    const out: MissionReportProofEntry[] = [];
    const budget = { files: 0, totalBytes: 0 };
    for (const runId of collectRunIds(mission)) {
      if (budget.files >= MAX_PROOF_FILES || budget.totalBytes >= MAX_PROOF_TOTAL_BYTES) break;
      const run = this.deps.testkit.getRun(runId);
      if (!run) continue;
      // The run's meta.json — the proof of the recorded verify/gate run (the caps apply here too).
      const metaName = `run-${runId}.json`;
      const metaBytes = copyCapped(join(run.runDir, 'meta.json'), join(proofDir, metaName), budget);
      if (metaBytes !== undefined) out.push({ name: metaName, kind: 'run-meta', bytes: metaBytes });
      // Its artifacts (screenshots/traces). NOT the logs/ subtree — W5 logs carry secrets.
      const artDir = join(run.runDir, 'artifacts');
      if (!existsSync(artDir)) continue;
      let entries: string[];
      try {
        entries = readdirSync(artDir).sort();
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (budget.files >= MAX_PROOF_FILES || budget.totalBytes >= MAX_PROOF_TOTAL_BYTES) break;
        // Namespace by runId so two runs' artifacts can't collide in the flat proof/ dir. basename()
        // keeps the stored name a single path segment (the serve route re-checks containment anyway).
        const destName = `${runId}-${basename(entry)}`;
        const bytes = copyCapped(join(artDir, entry), join(proofDir, destName), budget);
        if (bytes !== undefined) out.push({ name: destName, kind: 'artifact', bytes });
      }
    }
    return out;
  }

  /** Build report.json in memory. provider/model/branch come from the sortie's loop (the resolved
   *  route), falling back to the sortie's own override when the loop never started. Metadata only. */
  private buildReport(mission: Mission, proof: MissionReportProofEntry[]): MissionReport {
    const phases: MissionReportPhase[] = mission.phases.map((p) => ({
      title: p.name,
      ...(p.stage ? { stage: p.stage } : {}),
      ...(p.round !== undefined ? { round: p.round } : {}),
      sorties: p.sorties.map((s) => {
        const loop = s.loopId ? this.deps.loops.get(s.loopId) : undefined;
        const provider = loop?.provider ?? s.provider;
        const model = loop?.model ?? s.model;
        const effort = loop?.effort ?? s.effort;
        return {
          name: s.name,
          status: s.status,
          ...(s.loopId ? { loopId: s.loopId } : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(loop?.branch ? { branch: loop.branch } : {}),
        };
      }),
    }));
    const gateRunId = newestGateRunId(mission.phases);
    // SPEC-LOOP W6 — the recorded code reviews (newest first), metadata + finding text only (file/line/
    // summary/verdict — detail excluded to stay compact). Absent when none, so the section hides.
    const reviews = this.deps.reviews.listFor(mission.id).map((r) => buildReportReview(mission, r));
    // SPEC-LOOP W7 — the operator-audit surface for false-fail triage: per round whose verify run was
    // investigated, the classification counts + the by-design/false suppressions. `real` = the round's
    // failure count minus the matched suppressions (UNCLASSIFIED counts as real, so this matches exactly
    // what the fixers partitioned). Triage NEVER entered the verdict — this section only reports it.
    const investigations: MissionReportInvestigation[] = [];
    for (const r of mission.loop?.rounds ?? []) {
      if (!r.verifyRunId) continue;
      const run = this.deps.testkit.getRun(r.verifyRunId);
      const triage = run?.triage;
      if (!triage || triage.length === 0) continue;
      // OCCURRENCE-granularity counts (the shared triageCounts), so real/byDesign/false sum to the run's
      // failure count and match what the fixer partitioned + the backlog received.
      const counts = triageCounts(run?.results ?? [], triage);
      investigations.push({
        round: r.n,
        runId: r.verifyRunId,
        real: counts.real,
        byDesign: counts.byDesign,
        falseFails: counts.falseFails,
        // The suppressed LIST is the deduped by-design/false entries (unique tests) — the counts above are
        // occurrences; a test suppressed across N browsers is one list row but N in byDesign/falseFails.
        suppressed: triage
          .filter((t) => t.class === 'by-design' || t.class === 'false')
          .slice(0, 50)
          .map((t) => ({
            class: t.class as 'by-design' | 'false',
            specFile: t.specFile,
            testTitle: t.testTitle,
            ...(t.reason ? { reason: t.reason } : {}),
          })),
      });
    }
    // SPEC-RESEARCH W9 — the mission's research findings, newest first. Unlike the review projection
    // this keeps the FULL summary: report.json is the only durable place a finding is written, and a
    // survey truncated there would defeat the artifact. Metadata + agent-authored text only.
    //
    // The COUNT is capped even though the text is not. The store's per-mission bound is 100 (raised so
    // pruning can never make the reconcile gate's note false), and each summary may be 8KB — so an
    // uncapped section could carry ~820KB of prose into report.json AND again into the inlined HTML
    // twin, on top of the existing proof budget. Newest 25 keeps any realistic mission whole while
    // bounding the pathological one; the full set stays in research.json.
    const research: MissionReportResearchFinding[] = this.deps.research.listFor(mission.id)
      .slice(0, MAX_REPORT_RESEARCH)
      .map((r) => ({
        sortieId: r.sortieId,
        ...(r.round !== undefined ? { round: r.round } : {}),
        topic: r.topic,
        summary: r.summary,
        ...(r.citations?.length ? { citations: r.citations.map((c) => ({ ref: c.ref, ...(c.note ? { note: c.note } : {}) })) } : {}),
        submittedAt: r.submittedAt,
      }));
    return {
      missionId: mission.id,
      name: mission.name,
      goal: mission.goal,
      status: mission.status,
      // SPEC-TERMINAL-OPS §6 — top-level first, the legacy loop location as the on-disk fallback; a
      // non-loop mission's report now carries its base commit too.
      ...((mission.baseSha ?? mission.loop?.baseSha) ? { baseSha: mission.baseSha ?? mission.loop?.baseSha } : {}),
      finishedAt: new Date().toISOString(),
      rounds: mission.loop?.rounds ?? [],
      phases,
      proof,
      ...(gateRunId ? { gateRunId } : {}),
      ...(reviews.length ? { reviews } : {}),
      ...(investigations.length ? { investigations } : {}),
      ...(research.length ? { research } : {}),
    };
  }
}

/** SPEC-LOOP W6 — project one ReviewRecord to a MissionReportReview. `attestedClean` is true ONLY when
 *  findings.length===0 (the renderers reserve the verbatim 'clean — attested …' line for it). The sortie
 *  name is resolved by scanning the mission's phases for the sortie id (else the id itself). */
function buildReportReview(mission: Mission, r: ReviewRecord): MissionReportReview {
  let sortie = r.sortieId;
  for (const p of mission.phases) {
    const s = p.sorties.find((x) => x.id === r.sortieId);
    if (s) { sortie = s.name; break; }
  }
  const confirmed = r.findings.filter(isConfirmed).length;
  return {
    sortie,
    ...(r.round !== undefined ? { round: r.round } : {}),
    submittedAt: r.submittedAt,
    confirmed,
    plausible: r.findings.length - confirmed,
    findings: r.findings.map((f) => ({
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      summary: f.summary,
      ...(f.verdict ? { verdict: f.verdict } : {}),
    })),
    attestedClean: r.findings.length === 0,
  };
}

// ---- pure helpers ----

/** Copy `src` → `destPath` under the shared budget, or return undefined if it can't (missing,
 *  non-regular, over a cap). lstat (no symlink deref) + regular-file discipline mirrors copyArtifacts. */
function copyCapped(src: string, destPath: string, budget: { files: number; totalBytes: number }): number | undefined {
  if (budget.files >= MAX_PROOF_FILES) return undefined;
  try {
    const st = lstatSync(src);
    if (!st.isFile()) return undefined;
    const size = st.size;
    if (size > MAX_PROOF_FILE_BYTES) return undefined;
    if (budget.totalBytes + size > MAX_PROOF_TOTAL_BYTES) return undefined;
    copyFileSync(src, destPath);
    budget.files++;
    budget.totalBytes += size;
    return size;
  } catch {
    return undefined;
  }
}

/** The mission's pinned run ids, in order, deduped: every round's verify run, then every phase's gate
 *  run. These are the deterministic proof sources at the done transition (the evaluator has already
 *  stamped verifyRunId; runGate stamps gateRunId). */
function collectRunIds(mission: Mission): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (id?: string): void => {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const r of mission.loop?.rounds ?? []) add(r.verifyRunId);
  for (const p of mission.phases) add(p.gateRunId);
  return out;
}

/** The newest phase's gate run id (the final regression gate), scanning from the tail. */
function newestGateRunId(phases: MissionPhase[]): string | undefined {
  for (let i = phases.length - 1; i >= 0; i--) {
    const g = phases[i]?.gateRunId;
    if (g) return g;
  }
  return undefined;
}

/** SPEC-LOOP W6 — one review finding as `file:line — summary [verdict]` plain text (shared by the
 *  markdown + html renderers; html passes it through esc()). */
function reviewFindingText(f: MissionReportReview['findings'][number]): string {
  const loc = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
  const verdict = f.verdict ? ` [${f.verdict}]` : '';
  return `${loc} — ${f.summary}${verdict}`;
}

/** A round's verify verdict as human text (shared by the markdown + html renderers). */
function roundResultText(rd: MissionReport['rounds'][number]): string {
  if (typeof rd.failed !== 'number') return 'not evaluated';
  const total = rd.total !== undefined ? rd.total : undefined;
  if (rd.failed === 0) return total !== undefined ? `green (${total}/${total})` : 'green';
  return total !== undefined ? `${rd.failed} failing / ${total}` : `${rd.failed} failing`;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};
/** Image MIME from the extension allowlist (SVG excluded, mirroring api.ts) — undefined = not an image. */
function imageMime(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? IMAGE_MIME[name.slice(dot + 1).toLowerCase()] : undefined;
}

// ---- markdown ----

/** Deterministic markdown: goal, per-round pass/fail, per-phase sorties + route, proof, final gate. */
function renderMarkdown(r: MissionReport): string {
  const lines: string[] = [];
  lines.push(`# ${r.name}`, '');
  lines.push(`- Mission: \`${r.missionId}\``);
  lines.push(`- Status: **${r.status}**`);
  lines.push(`- Finished: ${r.finishedAt}`);
  if (r.baseSha) lines.push(`- Base commit: \`${r.baseSha}\``);
  if (r.gateRunId) lines.push(`- Final regression gate run: \`${r.gateRunId}\``);
  lines.push('', '## Goal', '', r.goal ? r.goal : '_(no goal recorded)_', '');

  if (r.rounds.length) {
    lines.push('## Rounds', '', '| Round | Kind | Result |', '| --- | --- | --- |');
    for (const rd of r.rounds) lines.push(`| ${rd.n} | ${rd.kind} | ${roundResultText(rd)} |`);
    lines.push('');
  }

  // SPEC-LOOP W6 — the Code-review section (between Rounds and Phases). A clean review renders the
  // verbatim attested wording; findings render as `file:line — summary [verdict]` lines.
  if (r.reviews?.length) {
    lines.push('## Code review', '');
    for (const rv of r.reviews) {
      const head = `**${rv.sortie}**${rv.round !== undefined ? ` (round ${rv.round})` : ''} — ${rv.submittedAt}`;
      lines.push(head);
      if (rv.attestedClean) {
        lines.push('- clean — attested by the reviewer, not machine-verified');
      } else {
        lines.push(`- ${rv.confirmed} confirmed, ${rv.plausible} plausible`);
        for (const f of rv.findings) lines.push(`  - ${reviewFindingText(f)}`);
      }
      lines.push('');
    }
  }

  // SPEC-RESEARCH W9 — the Research findings section. The full summary is written (report.json and this
  // twin are the durable record of the finding); citations render as a plain ref list, never fetched.
  if (r.research?.length) {
    lines.push('## Research findings', '');
    for (const rc of r.research) {
      lines.push(`**${rc.topic || '(untitled)'}**${rc.round !== undefined ? ` (round ${rc.round})` : ''} — ${rc.submittedAt}`);
      lines.push('');
      lines.push(rc.summary);
      if (rc.citations?.length) {
        lines.push('');
        for (const c of rc.citations) lines.push(`- ${c.ref}${c.note ? ` — ${c.note}` : ''}`);
      }
      lines.push('');
    }
  }

  // SPEC-LOOP W7 — the Investigations section (deterministic order: Rounds → Code review → Investigations).
  // Triage never entered the verdict; this is the operator-audit surface for suppressed failures.
  if (r.investigations?.length) {
    lines.push('## Investigations', '');
    for (const inv of r.investigations) {
      lines.push(`### Round ${inv.round} (run \`${inv.runId}\`)`, '');
      lines.push(`- ${inv.real} real · ${inv.byDesign} by-design · ${inv.falseFails} false`);
      for (const s of inv.suppressed) {
        lines.push(`  - [${s.class}] ${s.specFile} › ${s.testTitle}${s.reason ? ` — ${s.reason}` : ''}`);
      }
      lines.push('');
    }
  }

  lines.push('## Phases', '');
  r.phases.forEach((p, i) => {
    const meta = [p.stage, p.round !== undefined ? `round ${p.round}` : undefined].filter(Boolean).join(', ');
    lines.push(`### Phase ${i + 1}: ${p.title}${meta ? ` (${meta})` : ''}`, '');
    if (!p.sorties.length) {
      lines.push('_(no sorties)_', '');
      return;
    }
    for (const s of p.sorties) {
      // SPEC-EFFORT §5 — effort is a labeled '@' suffix, not a third '/' segment ('codex / gpt-5.5 @ xhigh').
      const base = [s.provider, s.model].filter(Boolean).join(' / ');
      const route = base && s.effort ? `${base} @ ${s.effort}` : base;
      const branch = s.branch ? ` — branch \`${s.branch}\`` : '';
      lines.push(`- **${s.name}** — ${s.status}${route ? ` [${route}]` : ''}${branch}`);
    }
    lines.push('');
  });

  if (r.proof.length) {
    lines.push('## Proof', '');
    for (const p of r.proof) lines.push(`- \`proof/${p.name}\` (${p.kind}, ${p.bytes} bytes)`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---- html (self-contained, download-only) ----

/** HTML-escape — every dynamic value (goals/names/branches) crosses this so a `<script>` in a goal
 *  can never execute in the downloaded report. */
function esc(s: string | undefined | null): string {
  // Defensive: coerce a missing/unexpected field to '' so one malformed value can't abort the whole
  // report render (generate() would otherwise catch it and write no report at all).
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const REPORT_CSS = [
  'body{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}',
  'h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.25rem}',
  'h3{font-size:1rem;margin:1.25rem 0 .5rem}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}',
  'dt{font-weight:600}code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px;font-size:.9em}',
  'table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.35rem .6rem;text-align:left}',
  'ul{padding-left:1.2rem}figure{margin:.75rem 0}img{max-width:100%;border:1px solid #ddd;border-radius:4px}',
  'figcaption,.muted{color:#666;font-size:.85em}.proof-file{font-family:ui-monospace,monospace;font-size:.85em;word-break:break-all}',
].join('');

function renderHtml(r: MissionReport, proofDir: string): string {
  const h: string[] = [];
  h.push('<!doctype html>');
  h.push('<html lang="en"><head><meta charset="utf-8">');
  h.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  h.push(`<title>${esc(r.name)} — delivery report</title>`);
  h.push(`<style>${REPORT_CSS}</style>`);
  h.push('</head><body>');
  h.push(`<h1>${esc(r.name)}</h1>`);

  h.push('<dl>');
  h.push(`<dt>Mission</dt><dd><code>${esc(r.missionId)}</code></dd>`);
  h.push(`<dt>Status</dt><dd>${esc(r.status)}</dd>`);
  h.push(`<dt>Finished</dt><dd>${esc(r.finishedAt)}</dd>`);
  if (r.baseSha) h.push(`<dt>Base commit</dt><dd><code>${esc(r.baseSha)}</code></dd>`);
  if (r.gateRunId) h.push(`<dt>Final gate run</dt><dd><code>${esc(r.gateRunId)}</code></dd>`);
  h.push('</dl>');

  h.push('<h2>Goal</h2>');
  h.push(`<p>${r.goal ? esc(r.goal) : '<em>(no goal recorded)</em>'}</p>`);

  if (r.rounds.length) {
    h.push('<h2>Rounds</h2><table><thead><tr><th>Round</th><th>Kind</th><th>Result</th></tr></thead><tbody>');
    for (const rd of r.rounds) {
      h.push(`<tr><td>${rd.n}</td><td>${esc(rd.kind)}</td><td>${esc(roundResultText(rd))}</td></tr>`);
    }
    h.push('</tbody></table>');
  }

  // SPEC-LOOP W6 — the Code-review section (between Rounds and Phases). Every dynamic string crosses esc();
  // the verbatim attested line renders ONLY for a findings-empty review (attestedClean).
  if (r.reviews?.length) {
    h.push('<h2>Code review</h2>');
    for (const rv of r.reviews) {
      const round = rv.round !== undefined ? ` <span class="muted">(round ${esc(String(rv.round))})</span>` : '';
      h.push(`<h3>${esc(rv.sortie)}${round}</h3>`);
      if (rv.attestedClean) {
        h.push('<p class="muted">clean — attested by the reviewer, not machine-verified</p>');
      } else {
        h.push(`<p class="muted">${rv.confirmed} confirmed, ${rv.plausible} plausible</p>`);
        h.push('<ul>');
        for (const f of rv.findings) h.push(`<li>${esc(reviewFindingText(f))}</li>`);
        h.push('</ul>');
      }
    }
  }

  // SPEC-RESEARCH W9 — the Research findings section. Every dynamic string crosses esc(); the summary
  // renders pre-wrapped so a survey's own formatting survives.
  if (r.research?.length) {
    h.push('<h2>Research findings</h2>');
    for (const rc of r.research) {
      const round = rc.round !== undefined ? ` <span class="muted">(round ${esc(String(rc.round))})</span>` : '';
      h.push(`<h3>${esc(rc.topic || '(untitled)')}${round}</h3>`);
      h.push(`<pre>${esc(rc.summary)}</pre>`);
      if (rc.citations?.length) {
        h.push('<ul>');
        for (const c of rc.citations) h.push(`<li>${esc(c.ref)}${c.note ? ` — ${esc(c.note)}` : ''}</li>`);
        h.push('</ul>');
      }
    }
  }

  // SPEC-LOOP W7 — the Investigations section (Rounds → Code review → Investigations). Every dynamic
  // string (specFile/testTitle/reason are agent-authored) crosses esc(). Metadata + classification only.
  if (r.investigations?.length) {
    h.push('<h2>Investigations</h2>');
    for (const inv of r.investigations) {
      h.push(`<h3>Round ${inv.round} <span class="muted">(run <code>${esc(inv.runId)}</code>)</span></h3>`);
      h.push(`<p class="muted">${inv.real} real · ${inv.byDesign} by-design · ${inv.falseFails} false</p>`);
      if (inv.suppressed.length) {
        h.push('<ul>');
        for (const s of inv.suppressed) {
          const reason = s.reason ? ` — ${esc(s.reason)}` : '';
          h.push(`<li>[${esc(s.class)}] ${esc(s.specFile)} › ${esc(s.testTitle)}${reason}</li>`);
        }
        h.push('</ul>');
      }
    }
  }

  h.push('<h2>Phases</h2>');
  r.phases.forEach((p, i) => {
    const meta = [p.stage, p.round !== undefined ? `round ${p.round}` : undefined].filter(Boolean).join(', ');
    h.push(`<h3>Phase ${i + 1}: ${esc(p.title)}${meta ? ` <span class="muted">(${esc(meta)})</span>` : ''}</h3>`);
    if (!p.sorties.length) {
      h.push('<p class="muted"><em>(no sorties)</em></p>');
      return;
    }
    h.push('<ul>');
    for (const s of p.sorties) {
      // SPEC-EFFORT §5 — effort as a labeled '@' suffix ('codex / gpt-5.5 @ xhigh'); esc() still applies.
      const base = [s.provider, s.model].filter(Boolean).join(' / ');
      const route = base && s.effort ? `${base} @ ${s.effort}` : base;
      const branch = s.branch ? ` — branch <code>${esc(s.branch)}</code>` : '';
      h.push(`<li><strong>${esc(s.name)}</strong> — ${esc(s.status)}${route ? ` [${esc(route)}]` : ''}${branch}</li>`);
    }
    h.push('</ul>');
  });

  if (r.proof.length) {
    h.push('<h2>Proof</h2>');
    // Inline at most MAX_INLINE_IMAGES images (bounds the base64 CPU cost of the sync stall); beyond
    // that even an image proof falls through to the escaped-path rendering below.
    let inlined = 0;
    for (const p of r.proof) {
      const dataUri = inlined < MAX_INLINE_IMAGES ? inlineImage(join(proofDir, p.name), p.name, p.bytes) : undefined;
      if (dataUri) {
        inlined++;
        h.push(`<figure><img alt="${esc(p.name)}" src="${dataUri}"><figcaption>${esc(p.name)} (${p.bytes} bytes)</figcaption></figure>`);
      } else {
        // NOT a hyperlink — an escaped on-disk path (this .html is download-only, never served at the origin).
        const abs = `~/.ct/reports/${r.missionId}/proof/${p.name}`;
        h.push(`<p class="proof-file">${esc(abs)} <span class="muted">(${esc(p.kind)}, ${p.bytes} bytes)</span></p>`);
      }
    }
  }

  h.push('</body></html>');
  return h.join('\n');
}

/** Inline a proof file as a data: URI when it is an image under the cap; undefined otherwise (the
 *  caller then renders its path as escaped text). Reads from the ALREADY-COPIED proof file. */
function inlineImage(absPath: string, name: string, bytes: number): string | undefined {
  const mime = imageMime(name);
  if (!mime || bytes > MAX_INLINE_IMAGE_BYTES) return undefined;
  try {
    const buf = readFileSync(absPath);
    if (buf.length > MAX_INLINE_IMAGE_BYTES) return undefined;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}
