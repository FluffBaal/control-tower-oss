// towerctl — operator CLI. For M1 the one subcommand is `doctor`, which checks the
// host is fit to run the Tower before you hit a confusing runtime failure
// (SPEC §16). Everything it checks is a known failure mode: tmux >= 3.2
// (env injection), repo-on-ext4-not-/mnt/c (9P slowdown/inotify), inotify limits
// (N worktrees), and the presence of the agent CLIs.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statfsSync, readFileSync as readF, existsSync as existsF } from 'node:fs';
import { cwd } from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseMemoryArgs, memoryUsage, retryOnNetworkError, isNetworkError } from './memory-args.js';
import type { MemoryEntry } from '../shared/memory.js';

const pexec = promisify(execFile);

type Status = 'pass' | 'warn' | 'fail';
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const ICON: Record<Status, string> = { pass: '✔', warn: '⚠', fail: '✘' };

async function tryCmd(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await pexec(file, args);
    return stdout.trim();
  } catch {
    return null;
  }
}

function parseVersion(s: string): [number, number, number] {
  const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}
function gte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

async function checks(): Promise<Check[]> {
  const out: Check[] = [];

  // node >= 22
  const nodeV = parseVersion(process.version);
  out.push({
    name: 'node >= 22',
    status: gte(nodeV, [22, 0, 0]) ? 'pass' : 'fail',
    detail: process.version,
  });

  // tmux >= 3.2 (new-session -e env injection)
  const tmuxRaw = await tryCmd('tmux', ['-V']);
  if (!tmuxRaw) {
    out.push({ name: 'tmux >= 3.2', status: 'fail', detail: 'tmux not found on PATH' });
  } else {
    out.push({
      name: 'tmux >= 3.2',
      status: gte(parseVersion(tmuxRaw), [3, 2, 0]) ? 'pass' : 'fail',
      detail: tmuxRaw,
    });
  }

  // git present
  const gitRaw = await tryCmd('git', ['--version']);
  out.push({
    name: 'git present',
    status: gitRaw ? 'pass' : 'fail',
    detail: gitRaw ?? 'git not found',
  });

  // Running under WSL2?
  const uname = (await tryCmd('uname', ['-r'])) ?? '';
  const isWsl = /microsoft/i.test(uname);
  out.push({
    name: 'WSL2 kernel',
    status: isWsl ? 'pass' : 'warn',
    detail: isWsl ? uname : `not detected (${uname || 'unknown'}) — Tower targets WSL2`,
  });

  // cwd on ext4, not /mnt/c (9P): worktrees + inotify + node_modules over 9P is 10-100x slower.
  const dir = cwd();
  const onMnt = dir.startsWith('/mnt/');
  let fsType = 'unknown';
  try {
    const st = statfsSync(dir) as unknown as { type?: number };
    // ext4 magic 0xEF53; 9p 0x01021997.
    if (st.type === 0xef53) fsType = 'ext4';
    else if (st.type === 0x01021997) fsType = '9p';
    else fsType = `0x${(st.type ?? 0).toString(16)}`;
  } catch {
    /* ignore */
  }
  out.push({
    name: 'repo on Linux fs (not /mnt/c)',
    status: onMnt || fsType === '9p' ? 'fail' : 'pass',
    detail: onMnt ? `${dir} is on a Windows drive (9P) — move repos to ~/…` : `${dir} (${fsType})`,
  });

  // inotify watch limits (N worktrees each running watchers).
  const watches = Number((await tryCmd('cat', ['/proc/sys/fs/inotify/max_user_watches'])) ?? '0');
  out.push({
    name: 'inotify max_user_watches',
    status: watches >= 524288 ? 'pass' : 'warn',
    detail: `${watches}${watches < 524288 ? ' (raise to >=524288 for many worktrees)' : ''}`,
  });

  // agent CLIs (informational — none is required for M1)
  for (const [label, bin] of [
    ['claude', 'claude'],
    ['gemini', 'gemini'],
    ['codex', 'codex'],
  ] as const) {
    const found = await tryCmd('which', [bin]);
    out.push({
      name: `agent CLI: ${label}`,
      status: found ? 'pass' : 'warn',
      detail: found ?? 'not installed (optional for M1)',
    });
  }

  return out;
}

async function doctor(): Promise<number> {
  const results = await checks();
  console.log('Control Tower — doctor\n');
  for (const c of results) {
    console.log(`  ${ICON[c.status]}  ${c.name.padEnd(34)} ${c.detail}`);
  }
  const failed = results.filter((c) => c.status === 'fail');
  const warned = results.filter((c) => c.status === 'warn');
  console.log('');
  if (failed.length) {
    console.log(`${failed.length} blocking issue(s). Fix before running the Tower.`);
    return 1;
  }
  console.log(warned.length ? `Ready, with ${warned.length} warning(s).` : 'All checks passed.');
  return 0;
}

// ---- agent coordination (mail / memory), authenticated by the per-terminal token ----

function agentCtx(): { base: string; token: string } {
  const port = process.env.TOWER_PORT ?? '4870';
  const tf = process.env.TOWER_HOOK_TOKEN_FILE;
  const token = tf && existsF(tf) ? readF(tf, 'utf8').trim() : '';
  if (!token) {
    console.error('not inside a Tower agent terminal (no terminal token)');
    process.exit(2);
  }
  return { base: `http://127.0.0.1:${port}`, token };
}

async function agentFetch(path: string, init?: RequestInit): Promise<unknown> {
  const { base, token } = agentCtx();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Origin: base,
      'X-Tower-Terminal-Token': token,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    console.error(`error: ${res.status} ${await res.text().catch(() => '')}`);
    process.exit(1);
  }
  return res.json();
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function mail(action: string): Promise<number> {
  if (action === 'inbox') {
    const msgs = (await agentFetch('/api/agent/mail/inbox')) as { from: string; fromLabel: string; ts: string; body: string }[];
    if (msgs.length === 0) console.log('(empty inbox)');
    for (const m of msgs) console.log(`\n[${m.fromLabel} · ${m.ts}]\n${m.body}`);
    return 0;
  }
  if (action === 'send') {
    const to = flag('to');
    const body = flag('body');
    if (!to || !body) {
      console.error('usage: towerctl mail send --to <terminalId> --body "<text>"');
      return 2;
    }
    await agentFetch('/api/agent/mail/send', { method: 'POST', body: JSON.stringify({ to, body }) });
    console.log('sent.');
    return 0;
  }
  console.error('usage: towerctl mail <inbox|send>');
  return 2;
}

/**
 * SPEC-MEMORY — the memory routes' responses, WITHOUT agentFetch's exit-on-!ok: a 409 stale needs its own
 * message (the caller must re-read and resend, never clobber), and the idempotent verbs retry a network
 * failure but never an HTTP status. A failure to reach the Tower throws (fetch's TypeError); any response
 * resolves. The body is parsed as JSON when it is JSON, else kept as text.
 */
async function memFetch(path: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: unknown }> {
  const { base, token } = agentCtx();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Origin: base,
      'X-Tower-Terminal-Token': token,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text().catch(() => '');
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON — keep the text */
  }
  return { status: res.status, ok: res.ok, body };
}

/** Print a memory route failure and return the exit code. A stale 409 carries the entry's CURRENT state so
 *  the agent knows which rev to re-read; every other status echoes the server's message. */
function memFail(res: { status: number; body: unknown }): number {
  const b = (res.body ?? {}) as { error?: unknown; current?: unknown };
  if (res.status === 409 && b.error === 'stale') {
    const cur = b.current as Partial<MemoryEntry> | string | undefined;
    const where = cur && typeof cur === 'object' && cur.id ? ` — ${cur.id} is now rev ${cur.rev}` : '';
    console.error(`memory changed since you read it${where}. Re-read (towerctl memory search / read) and retry with the current rev.`);
    return 1;
  }
  const msg = typeof b.error === 'string' ? b.error : typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
  console.error(`error: ${res.status} ${msg}`);
  return 1;
}

function entryLine(e: MemoryEntry): string {
  const status = e.lifecycle === 'active' ? e.verification : `${e.verification} · ${e.lifecycle}`;
  return `${e.id} rev ${e.rev} · ${e.kind} · ${status}`;
}

/**
 * SPEC-MEMORY — shared project memory as versioned entries. `read` prints the generated views (unchanged);
 * the entry verbs (search/add/update/dispute/retract/evidence/consolidate) drive the entry routes, where the
 * server derives project + principal from the terminal token and its transition table decides what an
 * agent may do. There is no `write` verb — the old whole-file replace has been removed; only the operator's
 * editor save goes through a different route. Parsing lives in memory-args.ts; this function only performs
 * the calls and prints.
 */
async function memory(argv: string[]): Promise<number> {
  const cmd = parseMemoryArgs(argv);
  if ('error' in cmd) {
    console.error(`memory${argv[0] ? ` ${argv[0]}` : ''}: ${cmd.error}`);
    console.error(memoryUsage(argv[0]));
    return 2;
  }
  switch (cmd.verb) {
    case 'read': {
      const data = (await agentFetch(`/api/agent/memory${cmd.file ? `?file=${encodeURIComponent(cmd.file)}` : ''}`)) as Record<string, string>;
      // Print each view verbatim: it carries its own `<!-- ct:memory view=… -->` header, and anything
      // added here would become a spurious entry when an agent writes the text back.
      for (const content of Object.values(data)) console.log(content);
      return 0;
    }
    case 'search': {
      const qs = new URLSearchParams();
      if (cmd.query.q) qs.set('q', cmd.query.q);
      if (cmd.query.kind) qs.set('kind', cmd.query.kind);
      const suffix = qs.size ? `?${qs}` : '';
      const entries = (await agentFetch(`/api/agent/memory/entries${suffix}`)) as MemoryEntry[];
      if (entries.length === 0) {
        console.log('(no matching entries)');
        return 0;
      }
      for (const e of entries) {
        console.log(entryLine(e));
        console.log(e.body.replace(/^/gm, '  '));
        console.log('');
      }
      return 0;
    }
    case 'add':
    case 'consolidate': {
      // Idempotent by requestId (minted once at parse time): a retry after a network failure reuses the
      // same key, so the store returns the entry the first attempt may already have created.
      const path = cmd.verb === 'add' ? '/api/agent/memory/entries' : '/api/agent/memory/consolidate';
      const body = JSON.stringify(cmd.request);
      let res;
      try {
        res = await retryOnNetworkError(() => memFetch(path, { method: 'POST', body }));
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        console.error(`error: could not reach the Tower after 3 attempts: ${(e as Error).message}`);
        return 1;
      }
      if (!res.ok) return memFail(res);
      const entry = res.body as MemoryEntry;
      console.log(
        cmd.verb === 'add'
          ? `added ${entry.id} rev ${entry.rev} (${entry.kind}, ${entry.applicability?.scope ?? 'project'} scope)`
          : `consolidated ${cmd.request.sources.length} source(s) into ${entry.id} rev ${entry.rev}`,
      );
      return 0;
    }
    case 'update':
    case 'dispute':
    case 'retract':
    case 'evidence': {
      const res = await memFetch('/api/agent/memory/update', { method: 'POST', body: JSON.stringify(cmd.request) });
      if (!res.ok) return memFail(res);
      const entry = res.body as MemoryEntry;
      const done = cmd.verb === 'update' ? 'updated' : cmd.verb === 'dispute' ? 'disputed' : cmd.verb === 'retract' ? 'retracted' : 'evidence added to';
      console.log(`${done} ${entry.id} rev ${entry.rev}`);
      return 0;
    }
  }
}

async function test(action: string): Promise<number> {
  if (action === 'results') {
    // SPEC-TESTING §6 — the calling terminal's latest structured results, printed compactly:
    // how a fixer/documentor reads a run without re-running the suite. `results` may be
    // undefined (JSON reporter not wired) — surfaced honestly, never fabricated.
    const run = (await agentFetch('/api/agent/test/latest')) as {
      id: string | null;
      status: string;
      total?: number;
      failed?: number;
      results?: { specFile: string; testTitle: string; errorTail: string; artifacts?: string[] }[];
    };
    if (run.id == null) {
      // The route returns { id: null } when this terminal has never run the suite.
      console.log('no test runs yet for this terminal — start one with `towerctl test run`.');
      return 0;
    }
    console.log(`run ${run.id} — ${run.status} (${run.failed ?? '?'} of ${run.total ?? '?'} failed)`);
    if (run.results === undefined) {
      console.log('(no parseable results — JSON reporter not wired for this run)');
    } else if (run.results.length === 0) {
      console.log('all green.');
    } else {
      for (const f of run.results) {
        console.log(`\n✘ ${f.specFile} › ${f.testTitle}`);
        if (f.errorTail) console.log(f.errorTail.replace(/^/gm, '    '));
        if (f.artifacts?.length) console.log(`    artifacts: ${f.artifacts.join(', ')}`);
      }
    }
    return 0;
  }
  if (action === 'triage') {
    // SPEC-LOOP W7 — the routed investigator submits its false-fail classifications. Ownership is derived
    // server-side (token→terminal→loop→sortie pin) — the body carries ONLY the entries. Read them inline
    // from --entries '<json>' (preferred — writes no file into the repo) or a --file <path>.
    let entries: unknown;
    try {
      // Read INSIDE the try so a bad --file path (ENOENT) prints the clean usage below, not a raw stack.
      const raw = flag('entries') ?? (flag('file') ? readF(flag('file')!, 'utf8') : undefined);
      entries = raw !== undefined ? JSON.parse(raw) : undefined;
    } catch {
      entries = undefined;
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      console.error(
        'usage: towerctl test triage (--entries \'<json>\' | --file <path>)  # [{"specFile","testTitle","class":"real|by-design|false","reason"?}]',
      );
      return 2;
    }
    const res = (await agentFetch('/api/agent/test/triage', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    })) as { runId: string; real: number; byDesign: number; falseFails: number };
    console.log(`[triage] run ${res.runId}: ${res.real} real, ${res.byDesign} by-design, ${res.falseFails} false`);
    return 0;
  }
  if (action !== 'run') {
    console.error('usage: towerctl test <run|results|triage> [--cmd "<command>"]');
    return 2;
  }
  // Acquire a slot + free port from the memory-aware broker.
  const run = (await agentFetch('/api/agent/test/acquire', { method: 'POST' })) as {
    id: string;
    port: number;
    runDir: string;
    /** SPEC-TESTING §4 — the project's configured suite invocation, added server-side. */
    suiteCommand?: string;
  };
  const cmd = flag('cmd') ?? run.suiteCommand ?? 'npx playwright test';
  console.log(`[test] run ${run.id} port ${run.port} — ${cmd}`);
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync('bash', ['-lc', cmd], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(run.port),
      BASE_URL: `http://127.0.0.1:${run.port}`,
      CT_RUN_DIR: run.runDir,
      PLAYWRIGHT_BLOB_OUTPUT_DIR: `${run.runDir}/blob`,
      // Belt-and-suspenders (SPEC-STORYLOOP §2.1): even a project that forces
      // --reporter=json on the CLI writes the structured report into the run dir,
      // where release-time parsePlaywrightResults reads it. Converges with the
      // example config's ['json', {outputFile: $CT_RUN_DIR/results.json}].
      PLAYWRIGHT_JSON_OUTPUT_FILE: `${run.runDir}/results.json`,
    },
  });
  const status = res.status === 0 ? 'passed' : 'failed';
  await agentFetch('/api/agent/test/release', { method: 'POST', body: JSON.stringify({ runId: run.id, status }) });
  console.log(`[test] ${status} (run ${run.id})`);
  return res.status ?? 1;
}

async function review(action: string): Promise<number> {
  // SPEC-LOOP W6 — the routed code reviewer's structured-findings CLI. `submit` posts findings (from
  // stdin by default, so nothing is written into the repo and auto-committed); `status` prints the
  // current submission; `check` is the reviewer sortie's checkCommand (submitted AND zero commits on
  // the branch → exit 0; the Tower's refuse-to-land is the load-bearing guard, this is the belt).
  if (action === 'submit') {
    let findings: unknown;
    if (process.argv.includes('--clean')) {
      findings = [];
    } else {
      const file = flag('file') ?? '-';
      let raw: string;
      try {
        raw = file === '-' ? readF(0, 'utf8') : readF(file, 'utf8'); // fd 0 = stdin
      } catch (e) {
        console.error(`review submit: could not read ${file === '-' ? 'stdin' : file}: ${(e as Error).message}`);
        return 2;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.error('review submit: input is not valid JSON');
        return 2;
      }
      findings = Array.isArray(parsed) ? parsed : (parsed as { findings?: unknown } | null)?.findings;
      if (!Array.isArray(findings)) {
        console.error('review submit: expected {"findings":[...]} or a bare array');
        return 2;
      }
    }
    await agentFetch('/api/agent/review', { method: 'POST', body: JSON.stringify({ findings }) });
    console.log(`review submitted — ${(findings as unknown[]).length} finding(s)`);
    return 0;
  }
  if (action === 'status') {
    const st = (await agentFetch('/api/agent/review')) as { submitted: boolean; findings?: number; confirmed?: number };
    console.log(
      st.submitted
        ? `review submitted — ${st.findings ?? 0} finding(s), ${st.confirmed ?? 0} confirmed`
        : 'no review submitted yet',
    );
    return 0;
  }
  if (action === 'check') {
    const st = (await agentFetch('/api/agent/review')) as { submitted: boolean; baseBranch?: string };
    if (!st.submitted) {
      console.error('no review submitted yet — run `towerctl review submit --file -` (or `--clean`) first');
      return 1;
    }
    // Commit-count belt: reviewers must not commit. A missing base branch / rev-list error PASSES with a
    // visible warning (the unconditional refuse-to-land is the load-bearing guard — this belt must not
    // dead-loop a legitimate reviewer to iteration-cap attention on a git/Tower hiccup).
    if (!st.baseBranch) {
      console.error('commit-count belt skipped: no base branch reported');
      return 0;
    }
    const { spawnSync } = await import('node:child_process');
    const rl = spawnSync('git', ['rev-list', '--count', `${st.baseBranch}..HEAD`], { cwd: cwd(), encoding: 'utf8' });
    if (rl.status !== 0) {
      console.error(`commit-count belt skipped: git rev-list failed: ${(rl.stderr || '').trim()}`);
      return 0;
    }
    // Non-numeric rev-list output → skip the belt with a warning (fail-open on a git anomaly, consistent
    // with the missing-baseBranch case). `NaN > 0` is false, so an unguarded parse would silently PASS a
    // dirty branch; guard it explicitly. Only a finite count > 0 fails the check.
    const count = Number((rl.stdout || '').trim());
    if (!Number.isFinite(count)) {
      console.error(`commit-count belt skipped: git rev-list returned non-numeric output "${(rl.stdout || '').trim()}"`);
      return 0;
    }
    if (count > 0) {
      console.error(
        `branch holds ${count} commit(s) — reviewers must not commit. Run \`git reset --hard ${st.baseBranch}\` to discard, then re-run the review.`,
      );
      return 1;
    }
    return 0;
  }
  console.error('usage: towerctl review <submit|status|check> [--clean] [--file <path|->]');
  return 2;
}

/**
 * SPEC-SKILLS-GATE — the loop-green gate attestation CLI. `submit` records one required gate's outcome
 * (an optional summary inline via --summary or from a file/stdin via --file — nothing is written into
 * the worktree); `status` prints each required gate's submission state; `check` exits 1 while any
 * required gate is unsubmitted or last recorded a fail — usable as a gate sortie's checkCommand so its
 * loop keeps iterating until every gate passes. The server derives WHICH mission from the terminal
 * token and validates the gate id against that mission's frozen required set.
 */
async function gate(action: string): Promise<number> {
  if (action === 'submit') {
    const id = flag('gate');
    const result = flag('result');
    if (!id || (result !== 'pass' && result !== 'fail')) {
      console.error('usage: towerctl gate submit --gate <id> --result pass|fail [--summary "<text>" | --file <path|->]');
      return 2;
    }
    let summary = flag('summary');
    if (summary === undefined) {
      const file = flag('file');
      if (file !== undefined) {
        try {
          summary = file === '-' ? readF(0, 'utf8') : readF(file, 'utf8'); // fd 0 = stdin
        } catch (e) {
          console.error(`gate submit: could not read ${file === '-' ? 'stdin' : file}: ${(e as Error).message}`);
          return 2;
        }
      }
    }
    const res = (await agentFetch('/api/agent/gate', {
      method: 'POST',
      body: JSON.stringify({ gate: id, result, ...(summary?.trim() ? { summary } : {}) }),
    })) as { gate?: string; status?: string };
    console.log(`gate recorded — ${res.gate ?? id}: ${res.status ?? result}`);
    return 0;
  }
  if (action === 'status' || action === 'check') {
    const st = (await agentFetch('/api/agent/gate')) as { gates?: { id: string; submitted: boolean; status?: string }[] };
    const gates = st.gates ?? [];
    for (const g of gates) console.log(`${g.id}: ${g.submitted ? g.status ?? 'submitted' : 'not submitted'}`);
    if (action === 'status') return 0;
    const blocked = gates.filter((g) => !g.submitted || g.status !== 'pass');
    if (blocked.length > 0) {
      console.error(
        `${blocked.length} gate(s) not passing — run each skill over the change, then record it with \`towerctl gate submit --gate <id> --result pass\``,
      );
      return 1;
    }
    return 0;
  }
  console.error('usage: towerctl gate <submit|status|check> [--gate <id>] [--result pass|fail] [--summary <text>] [--file <path|->]');
  return 2;
}

/**
 * SPEC-RESEARCH W9 — the research sortie's finding CLI. `submit` posts the finding (from stdin by
 * default, or inline via --summary, so nothing is written into the worktree for `git add -A` to sweep
 * into the branch that is never merged); `status` prints the current submission; `check` is the
 * sortie's checkCommand — it fails until a finding exists, which is what keeps a researcher iterating
 * instead of resolving with nothing.
 */
async function research(action: string): Promise<number> {
  if (action === 'submit') {
    let topic = flag('topic') ?? '';
    let summary = flag('summary') ?? '';
    let citations: unknown;
    if (!summary) {
      const file = flag('file') ?? '-';
      let raw: string;
      try {
        raw = file === '-' ? readF(0, 'utf8') : readF(file, 'utf8'); // fd 0 = stdin
      } catch (e) {
        console.error(`research submit: could not read ${file === '-' ? 'stdin' : file}: ${(e as Error).message}`);
        return 2;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.error('research submit: input is not valid JSON');
        return 2;
      }
      const o = (parsed ?? {}) as { topic?: unknown; summary?: unknown; citations?: unknown };
      if (typeof o.summary !== 'string' || !o.summary.trim()) {
        console.error('research submit: expected {"topic":"…","summary":"…","citations":[{"ref":"…"}]} — summary is the finding');
        return 2;
      }
      summary = o.summary;
      if (typeof o.topic === 'string') topic = o.topic;
      citations = o.citations;
    }
    const res = (await agentFetch('/api/agent/research', {
      method: 'POST',
      body: JSON.stringify({ topic, summary, ...(citations !== undefined ? { citations } : {}) }),
    })) as { summaryChars?: number; citations?: number };
    console.log(`research submitted — ${res.summaryChars ?? summary.length} chars, ${res.citations ?? 0} citation(s)`);
    return 0;
  }
  if (action === 'status') {
    const st = (await agentFetch('/api/agent/research')) as { submitted: boolean; topic?: string; summaryChars?: number };
    console.log(
      st.submitted
        ? `research submitted — ${st.summaryChars ?? 0} chars${st.topic ? ` (${st.topic})` : ''}`
        : 'no research finding submitted yet',
    );
    return 0;
  }
  if (action === 'check') {
    const st = (await agentFetch('/api/agent/research')) as { submitted: boolean; baseBranch?: string };
    if (!st.submitted) {
      console.error('no research finding submitted yet — run `towerctl research submit --file -` first');
      return 1;
    }
    // Commit-count belt, identical to the reviewer's: a researcher must not commit. Every anomaly
    // (no base branch, rev-list failure, non-numeric output) PASSES with a visible warning — the
    // unconditional refuse-to-land is the load-bearing guard, and this belt must not dead-loop a
    // legitimate researcher to iteration-cap attention on a git hiccup.
    if (!st.baseBranch) {
      console.error('commit-count belt skipped: no base branch reported');
      return 0;
    }
    const { spawnSync } = await import('node:child_process');
    const rl = spawnSync('git', ['rev-list', '--count', `${st.baseBranch}..HEAD`], { cwd: cwd(), encoding: 'utf8' });
    if (rl.status !== 0) {
      console.error(`commit-count belt skipped: git rev-list failed: ${(rl.stderr || '').trim()}`);
      return 0;
    }
    const count = Number((rl.stdout || '').trim());
    if (!Number.isFinite(count)) {
      console.error(`commit-count belt skipped: git rev-list returned non-numeric output "${(rl.stdout || '').trim()}"`);
      return 0;
    }
    if (count > 0) {
      console.error(
        `branch holds ${count} commit(s) — researchers must not commit. Run \`git reset --hard ${st.baseBranch}\` to discard, then re-run the check.`,
      );
      return 1;
    }
    return 0;
  }
  console.error('usage: towerctl research <submit|status|check> [--file <path|->] [--summary <text>] [--topic <t>]');
  return 2;
}

/**
 * SPEC-PLANNER §6 — the planner terminal's consult CLI. `pending` fetches the mission's open consults +
 * the self-brief and prints them (reading it also flips the consult to 'delivered'); `reply` posts a
 * re-plan (from stdin by default, so nothing is written into the repo). Both derive ownership server-side
 * from the per-terminal token; a non-planner pane gets the byte-identical 404.
 */
async function planner(action: string): Promise<number> {
  if (action === 'pending') {
    const res = (await agentFetch('/api/agent/planner/pending')) as {
      consults: { id: string; kind: string; status: string; askedAt: string; deadline: string; question: string }[];
      brief: unknown;
    };
    if (!res.consults || res.consults.length === 0) {
      console.log('no open consults for this mission');
    } else {
      for (const c of res.consults) {
        console.log(`── consult ${c.id} · ${c.kind} · ${c.status} · deadline ${c.deadline}`);
        console.log(c.question);
        console.log('');
      }
    }
    console.log('── BRIEF (mission context) ──');
    console.log(JSON.stringify(res.brief, null, 2));
    return 0;
  }
  if (action === 'reply') {
    const file = flag('file') ?? '-';
    let raw: string;
    try {
      raw = file === '-' ? readF(0, 'utf8') : readF(file, 'utf8'); // fd 0 = stdin
    } catch (e) {
      console.error(`planner reply: could not read ${file === '-' ? 'stdin' : file}: ${(e as Error).message}`);
      return 2;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('planner reply: input is not valid JSON');
      return 2;
    }
    // Accept a bare {"phases":[...]} object.
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { phases?: unknown }).phases)) {
      console.error('planner reply: expected {"phases":[{"name":"…","sorties":[{"name":"…","task":"…"}]}]}');
      return 2;
    }
    const consultId = flag('consult');
    const res = (await agentFetch('/api/agent/planner/reply', {
      method: 'POST',
      body: JSON.stringify({ ...(consultId ? { consultId } : {}), answer: parsed }),
    })) as { ok?: boolean; consultId?: string };
    console.log(`reply accepted for consult ${res.consultId ?? '(unknown)'}`);
    return 0;
  }
  console.error('usage: towerctl planner <pending|reply> [--file <path|->] [--consult <id>]');
  return 2;
}

/**
 * SPEC-MEMORY — the agent's progress note: one status line for the operator's board, recorded onto the
 * current iteration of the loop this terminal drives (inline via --body, or from a file/stdin via --file
 * so nothing is written into the worktree). Latest note wins; the server clamps it to 1 KB. It is never
 * read back into a prompt — it is for the human watching, not for steering the next turn.
 */
async function note(): Promise<number> {
  let body = flag('body');
  if (body === undefined) {
    const file = flag('file');
    if (file !== undefined) {
      try {
        body = file === '-' ? readF(0, 'utf8') : readF(file, 'utf8'); // fd 0 = stdin
      } catch (e) {
        console.error(`note: could not read ${file === '-' ? 'stdin' : file}: ${(e as Error).message}`);
        return 2;
      }
    }
  }
  if (!body?.trim()) {
    console.error('usage: towerctl note (--body "<text>" | --file <path|->)');
    return 2;
  }
  const res = (await agentFetch('/api/agent/note', { method: 'POST', body: JSON.stringify({ body }) })) as {
    recorded?: boolean; loopId?: string; n?: number;
  };
  console.log(res.recorded ? `note recorded — loop ${res.loopId} iteration ${res.n}` : 'note received (this terminal drives no live loop; nothing recorded)');
  return 0;
}

async function backup(): Promise<number> {
  const ctHome = process.env.CT_HOME ?? join(homedir(), '.ct');
  const dest = process.argv[3] ?? join(cwd(), `ct-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`);
  // Exclude the live broker socket + node_modules-like caches; back up config/state.
  const res = await pexec('tar', [
    '-czf',
    dest,
    '-C',
    ctHome,
    '--exclude=broker.sock',
    '--exclude=logs',
    '.',
  ]).then(() => ({ ok: true })).catch((e: { message?: string }) => ({ ok: false, err: e.message }));
  if (!('ok' in res) || !res.ok) {
    console.error('backup failed:', (res as { err?: string }).err);
    return 1;
  }
  console.log(`backup written: ${dest}`);
  return 0;
}

const sub = process.argv[2] ?? 'doctor';
if (sub === 'doctor') {
  doctor().then((code) => process.exit(code));
} else if (sub === 'backup') {
  backup().then((c) => process.exit(c));
} else if (sub === 'mail') {
  mail(process.argv[3] ?? '').then((c) => process.exit(c));
} else if (sub === 'memory') {
  memory(process.argv.slice(3)).then((c) => process.exit(c));
} else if (sub === 'test') {
  test(process.argv[3] ?? '').then((c) => process.exit(c));
} else if (sub === 'review') {
  review(process.argv[3] ?? '').then((c) => process.exit(c));
} else if (sub === 'gate') {
  gate(process.argv[3] ?? '').then((c) => process.exit(c));
} else if (sub === 'research') {
  research(process.argv[3] ?? '').then((c) => process.exit(c));
} else if (sub === 'planner') {
  planner(process.argv[3] ?? '').then((c) => process.exit(c));
} else if (sub === 'note') {
  note().then((c) => process.exit(c));
} else {
  console.error(`unknown command: ${sub}\nusage: towerctl <doctor|backup|mail|memory|test|review|gate|research|planner|note>`);
  process.exit(2);
}
