// SPEC-SKILLS Phase 2 — the shared-file managed-span logic (Model B) and the command-wrapper text
// mechanics (Model A). The span merge is the load-bearing one: the Tower owns ONLY the fenced bytes of a
// file it does not own, so a whole-file overwrite or a delete driven by a torn fence would destroy
// operator content. Every assertion is on real bytes — the pure units directly, and the fs-integration
// path through materializeSkills into a temp configDir. CT_HOME is set before paths.js loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FENCE_BEGIN, FENCE_END, applyManagedSection, renderSectionBody, sectionHash,
  emitCommandToml, parseCommandMarker, tomlBasicString, SECTION_BUDGET_BYTES, SECTION_HARD_CEILING,
} from './skills/sections.js';
import type { LaunchContext } from './adapters/types.js';
import type { UpsertSkillInput } from './skills/store.js';
import type { Skill } from '../shared/types.js';

const span = (body: string): string => `${FENCE_BEGIN}\n${body}\n${FENCE_END}`;
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

await test('SPEC-SKILLS managed section — pure span logic', async (t) => {
  await t.test('insert into an absent file — a fenced span, nothing else', () => {
    const r = applyManagedSection(undefined, 'hello');
    assert.equal(r.kind, 'write');
    assert.equal((r as { content: string }).content, `${span('hello')}\n`);
  });

  await t.test('insert below operator content — appended after a blank-line separator, operator bytes lead', () => {
    const r = applyManagedSection('operator top\n', 'body');
    assert.equal(r.kind, 'write');
    const content = (r as { content: string }).content;
    assert.ok(content.startsWith('operator top\n'), 'operator bytes preserved at the head');
    assert.ok(content.includes(`\n\n${span('body')}`), 'a blank-line separator precedes the fence');
  });

  await t.test('REPLACE — surrounding bytes are byte-identical, only the span content changes', () => {
    const before = 'ABOVE line 1\nABOVE line 2\n\n';
    const after = '\n\nBELOW line 1\nBELOW line 2\n';
    const current = `${before}${span('OLD body')}${after}`;
    const r = applyManagedSection(current, 'NEW body');
    assert.equal(r.kind, 'write');
    const content = (r as { content: string }).content;
    assert.equal(content, `${before}${span('NEW body')}${after}`, 'surrounding bytes untouched, span swapped');
    assert.ok(content.startsWith(before), 'above bytes exactly preserved');
    assert.ok(content.endsWith(after), 'below bytes exactly preserved');
  });

  await t.test('idempotency — reapplying the identical body is a noop', () => {
    const current = `top\n\n${span('same')}\n`;
    assert.equal(applyManagedSection(current, 'same').kind, 'noop');
  });

  await t.test('empty body — the span is removed, operator bytes intact, the file is NOT deleted', () => {
    const current = `keep above\n\n${span('to be gone')}\n\nkeep below\n`;
    const r = applyManagedSection(current, '');
    assert.equal(r.kind, 'write');
    const content = (r as { content: string }).content;
    assert.ok(!content.includes(FENCE_BEGIN) && !content.includes(FENCE_END), 'the fence is gone');
    assert.ok(content.includes('keep above') && content.includes('keep below'), 'operator content survives');
  });

  await t.test('empty body with no fence — noop, an absent file is never created', () => {
    assert.equal(applyManagedSection(undefined, '').kind, 'noop');
    assert.equal(applyManagedSection('operator only\n', '').kind, 'noop');
  });

  await t.test('torn fence — begin without end, and a duplicated begin — is a hands-off conflict', () => {
    assert.equal(applyManagedSection(`op\n${FENCE_BEGIN}\nlost\n`, 'x').kind, 'conflict');
    assert.equal(applyManagedSection(`${FENCE_BEGIN}\na\n${FENCE_BEGIN}\nb\n${FENCE_END}`, 'x').kind, 'conflict');
    assert.equal(applyManagedSection(`${FENCE_END}\nbefore begin\n${FENCE_BEGIN}`, 'x').kind, 'conflict', 'end before begin is torn');
  });

  await t.test('self-collision invariant — a body that embeds the literal fence round-trips clean (no self-torn)', () => {
    // A meta-skill documenting the fence convention would embed the sentinels verbatim; the written span
    // must still re-parse as exactly one begin + one end, and the NEXT sync must be a noop, not a conflict.
    const body = `Docs: the fence is ${FENCE_BEGIN} ... ${FENCE_END} — note it.`;
    const first = applyManagedSection(undefined, body);
    assert.equal(first.kind, 'write');
    const content = (first as { content: string }).content;
    assert.equal(count(content, FENCE_BEGIN), 1, 'exactly one real begin marker survives');
    assert.equal(count(content, FENCE_END), 1, 'exactly one real end marker survives');
    assert.equal(applyManagedSection(content, body).kind, 'noop', 'the second sync re-parses well-formed and is a noop');
  });
});

await test('SPEC-SKILLS section body — assembly + budget', async (t) => {
  await t.test('gate lines then notes; empty inputs yield an empty body', () => {
    assert.equal(renderSectionBody([], []), '');
    const body = renderSectionBody(['- G: run `g` before commit.'], [{ name: 'N', body: 'note body', pointer: '/x/SKILL.md' }]);
    assert.ok(body.startsWith('- G: run `g` before commit.'), 'gate line first');
    assert.ok(body.includes('**N**\nnote body'), 'note under a bold lead-in');
  });

  await t.test('over budget — note bodies drop to pointer lines largest-first; gate lines are never dropped', () => {
    const gate = ['- G: run `g` before commit.'];
    const big = 'x'.repeat(5000);
    const body = renderSectionBody(gate, [{ name: 'Big', body: big, pointer: '/dir/Big/SKILL.md' }], 4096);
    assert.ok(Buffer.byteLength(body, 'utf8') <= 4096, 'the body fits the budget');
    assert.ok(body.includes('- G: run `g` before commit.'), 'the gate line is kept');
    assert.ok(body.includes('- Big: see /dir/Big/SKILL.md'), 'the oversized note became a pointer line');
    assert.ok(!body.includes(big), 'the oversized body is not inlined');
  });

  await t.test('sectionHash is stable + content-sensitive', () => {
    assert.equal(sectionHash('abc'), sectionHash('abc'));
    assert.notEqual(sectionHash('abc'), sectionHash('abd'));
  });

  await t.test('gate lines exceeding the budget stay included but bounded past a summary', () => {
    const gate = Array.from({ length: 300 }, (_, i) => `- Skill ${i}: run \`skill-${i}\` before commit, push.`);
    const body = renderSectionBody(gate, []);
    assert.ok(body.includes(gate[0]!), 'the first gate line is kept — gate policy is never silently dropped');
    assert.ok(/…and \d+ more gated skills\./.test(body), 'the overflow is summarized into one line');
    assert.ok(Buffer.byteLength(body, 'utf8') <= 4096, 'the gate block stays within the soft budget');
  });

  await t.test('a runaway note roster stays within the hard ceiling after all notes become pointers', () => {
    const gate = ['- G: run `g` before commit.'];
    const notes = Array.from({ length: 400 }, (_, i) => ({ name: `N${i}`, body: 'x'.repeat(60), pointer: `/dir/N${i}/SKILL.md` }));
    const body = renderSectionBody(gate, notes);
    assert.ok(Buffer.byteLength(body, 'utf8') <= SECTION_HARD_CEILING + 8, 'the whole body is bounded by the hard ceiling');
    assert.ok(body.includes('- G: run `g` before commit.'), 'the gate line is still present');
    assert.ok(/…and \d+ more/.test(body), 'the note overflow is summarized, not an unbounded blob');
  });
});

await test('SPEC-SKILLS command TOML — marker round-trip + escaping', async (t) => {
  await t.test('marker parses back; a non-marker first line does not', () => {
    const toml = emitCommandToml({ id: 'my-skill', contentHash: 'deadbeef', description: 'd', prompt: 'p {{args}}' });
    const first = toml.split('\n')[0]!;
    assert.deepEqual(parseCommandMarker(first), { id: 'my-skill', contentHash: 'deadbeef' });
    assert.equal(parseCommandMarker('description = "x"'), undefined);
  });

  await t.test('a JSON-escaped basic string round-trips through TOML-shaped output', () => {
    const s = 'quote " and newline \n and backslash \\';
    assert.equal(JSON.parse(tomlBasicString(s)), s);
  });

  await t.test('control chars JSON leaves literal (U+007F, C1) are escaped for TOML, and still round-trip', () => {
    const s = `a${String.fromCharCode(0x7f)}b${String.fromCharCode(0x85)}c`;
    const out = tomlBasicString(s);
    assert.ok(out.includes('\\u007f'), 'U+007F (DEL) is escaped, not left literal');
    assert.ok(out.includes('\\u0085'), 'a C1 control is escaped');
    assert.equal(JSON.parse(out), s, 'the escaped form still decodes back to the original');
  });

  await t.test('description truncation never splits a trailing surrogate pair', () => {
    const desc = 'x'.repeat(99) + '😀' + 'tail'; // the emoji sits at code-point index 99
    const line = emitCommandToml({ id: 'e', contentHash: 'ab12', description: desc, prompt: 'p {{args}}' }).split('\n')[1]!;
    const parsed = JSON.parse(line.slice('description = '.length));
    assert.equal(parsed, 'x'.repeat(99) + '😀', 'the trailing emoji is kept whole (code-point truncation), never a lone surrogate');
  });
});

// ---- fs-integration: the managed section reached through the real materializer ----

const home = mkdtempSync(join(tmpdir(), 'ct-skills-sec-'));
process.env.CT_HOME = home;
const { ensureDirs } = await import('./paths.js');
ensureDirs();
const { SkillStore } = await import('./skills/store.js');
const { materializeSkills, sectionGateText } = await import('./skills/materialize.js');
const { auditTail } = await import('./audit.js');
const { MEMORY_SECTION_BLOCK } = await import('./memory-instruction.js');

const store = new SkillStore();
// The default spawn-plane belt for tests: no live skip-permissions terminal anywhere (the deps
// parameter is REQUIRED by design — no fail-open default).
const noBypass = { hasLiveBypass: () => false };
function resetStore(): void {
  for (const s of store.list()) store.remove(s.id);
}
function seed(over: Partial<UpsertSkillInput> & { id: string; name: string; description: string; body: string }): Skill {
  return store.upsert({ scope: 'global', enabled: true, origin: 'operator', ...over });
}
function freshConfigDir(): string {
  return mkdtempSync(join(home, 'cfg-'));
}
function ctx(configDir: string): LaunchContext {
  return {
    terminalId: 't1', projectId: 'p1', cwd: '/tmp/repo', repoPath: '/tmp/repo',
    hookTokenFile: '/tmp/tok', hookScript: '/tmp/hook', towerPort: 4870, spoolDir: '/tmp/spool',
    configDir, purpose: 'work',
  };
}
function lastConflict(provider: string): number {
  const e = auditTail(300).find((x) => x.action === 'skill.materialize' && x.provider === provider);
  return (e?.skippedConflict as number) ?? -1;
}

await test('SPEC-SKILLS managed section — through the materializer', async (t) => {
  await t.test('a blocking-gate skill writes a fenced policy line into AGENTS.md; operator bytes survive', async () => {
    resetStore();
    seed({ id: 'guard', name: 'Guard', description: 'd', body: 'G\n', gate: { mode: 'blocking', blocks: ['commit', 'push'] } });
    const cfg = freshConfigDir();
    writeFileSync(join(cfg, 'AGENTS.md'), 'operator top line\n');

    await materializeSkills('codex', ctx(cfg), store, noBypass);

    const agents = readFileSync(join(cfg, 'AGENTS.md'), 'utf8');
    assert.ok(agents.startsWith('operator top line\n'), 'the operator line is byte-preserved at the head');
    assert.ok(agents.includes(FENCE_BEGIN) && agents.includes(FENCE_END), 'a managed fence is present');
    assert.ok(
      agents.includes(
        '- Guard — BLOCKING gate: before any commit, push, run the `guard` skill over the exact diff about to land and surface every finding (state an empty result explicitly). Never perform the gated action in the same turn the findings are surfaced.',
      ),
      'the full blocking-gate policy contract rendered',
    );
    assert.ok(existsSync(join(cfg, 'skills', 'guard', 'SKILL.md')), 'the skill also materialized as a native dir');

    // Idempotent: a second spawn does not rewrite AGENTS.md.
    const mtime1 = statSync(join(cfg, 'AGENTS.md')).mtimeMs;
    await materializeSkills('codex', ctx(cfg), store, noBypass);
    assert.equal(statSync(join(cfg, 'AGENTS.md')).mtimeMs, mtime1, 'unchanged section → no rewrite');
  });

  await t.test('an instructions-file override lands as an inline note in GEMINI.md, no skill dir', async () => {
    resetStore();
    seed({
      id: 'advice', name: 'Advice', description: 'd', body: 'ADVISORY PROSE\n',
      providerOverrides: { 'gemini-cli': { channel: 'instructions-file' } },
    });
    const cfg = freshConfigDir();
    await materializeSkills('gemini-cli', ctx(cfg), store, noBypass);

    const gem = readFileSync(join(cfg, '.gemini', 'GEMINI.md'), 'utf8');
    assert.ok(gem.includes('**Advice**\nADVISORY PROSE'), 'the body is inlined into the section');
    assert.ok(!existsSync(join(cfg, '.gemini', 'skills', 'advice')), 'no skill dir for an instructions-file skill');
  });

  await t.test('a torn operator fence is left byte-untouched and counted as a conflict', async () => {
    resetStore();
    seed({ id: 'g2', name: 'G2', description: 'd', body: 'G\n', gate: { mode: 'blocking', blocks: ['commit'] } });
    const cfg = freshConfigDir();
    const torn = `operator content\n${FENCE_BEGIN}\nhalf a fence, no end\n`;
    writeFileSync(join(cfg, 'AGENTS.md'), torn);

    await materializeSkills('codex', ctx(cfg), store, noBypass);

    assert.equal(readFileSync(join(cfg, 'AGENTS.md'), 'utf8'), torn, 'the torn file is never rewritten');
    assert.ok(lastConflict('codex') >= 1, 'the torn fence is audited as a conflict');
  });

  await t.test('a note body that embeds the literal fence round-trips clean — no self-torn on the next sync', async () => {
    resetStore();
    seed({
      id: 'fencedoc', name: 'FenceDoc', description: 'd',
      body: `This skill documents the ${FENCE_BEGIN} / ${FENCE_END} convention.\n`,
      providerOverrides: { codex: { channel: 'instructions-file' } },
    });
    const cfg = freshConfigDir();
    await materializeSkills('codex', ctx(cfg), store, noBypass);

    const agents1 = readFileSync(join(cfg, 'AGENTS.md'), 'utf8');
    assert.equal(count(agents1, FENCE_BEGIN), 1, 'the embedded begin marker was neutralized — one real fence only');
    assert.equal(count(agents1, FENCE_END), 1, 'likewise the end marker');

    await materializeSkills('codex', ctx(cfg), store, noBypass);
    assert.equal(readFileSync(join(cfg, 'AGENTS.md'), 'utf8'), agents1, 'the second sync is a noop, not a conflict');
    assert.equal(lastConflict('codex'), 0, 'never wedged at a self-inflicted torn-fence conflict');
  });

  await t.test('SPEC-MEMADOPT behavior change — an empty gate/note corpus STILL writes the fence, carrying the memory block', async () => {
    resetStore();
    // A blocking-gate skill scoped to claude only — NOT eligible on codex, so the gate/note corpus is
    // empty. Pre-MEMADOPT this left AGENTS.md byte-untouched (no fence for an empty corpus); the
    // standing project-memory block now makes the managed span EVER-PRESENT.
    seed({ id: 'cc-gate', name: 'CC Gate', description: 'd', body: 'G\n', supportedProviders: ['claude-code'], gate: { mode: 'blocking', blocks: ['commit'] } });
    const cfg = freshConfigDir();
    writeFileSync(join(cfg, 'AGENTS.md'), 'only operator content\n');
    await materializeSkills('codex', ctx(cfg), store, noBypass);
    const agents = readFileSync(join(cfg, 'AGENTS.md'), 'utf8');
    assert.ok(agents.startsWith('only operator content\n'), 'operator bytes stay byte-preserved at the head');
    assert.equal(count(agents, FENCE_BEGIN), 1, 'the fence is written even for an empty gate/note corpus');
    assert.ok(agents.includes(MEMORY_SECTION_BLOCK), 'the span carries the standing memory block');
    assert.ok(!agents.includes('BLOCKING gate'), 'the ineligible gate contributes no policy line');
  });

  await t.test('SPEC-MEMADOPT — an EMPTY store writes the memory-only span on all three channels', async () => {
    resetStore(); // no skills at all — the barest corpus a spawn can sync
    const cfgC = freshConfigDir();
    const cfgX = freshConfigDir();
    const cfgG = freshConfigDir();
    await materializeSkills('claude-code', ctx(cfgC), store, noBypass);
    await materializeSkills('codex', ctx(cfgX), store, noBypass);
    await materializeSkills('gemini-cli', ctx(cfgG), store, noBypass);
    const surfaces: [string, string][] = [
      ['claude', join(cfgC, 'CLAUDE.md')],
      ['codex', join(cfgX, 'AGENTS.md')],
      ['gemini', join(cfgG, '.gemini', 'GEMINI.md')],
    ];
    for (const [label, file] of surfaces) {
      assert.ok(existsSync(file), `${label} section file exists with zero skills in the library`);
      const content = readFileSync(file, 'utf8');
      assert.equal(count(content, FENCE_BEGIN), 1, `${label} carries exactly one fence`);
      assert.equal(count(content, FENCE_END), 1, `${label} fence is well-formed`);
      assert.ok(content.includes(MEMORY_SECTION_BLOCK), `${label} span is the standing memory block`);
      assert.ok(content.includes('towerctl memory read'), `${label} block teaches the read command`);
    }
    // Idempotent like every other span write: a second sync leaves the file untouched.
    const mtime1 = statSync(join(cfgX, 'AGENTS.md')).mtimeMs;
    await materializeSkills('codex', ctx(cfgX), store, noBypass);
    assert.equal(statSync(join(cfgX, 'AGENTS.md')).mtimeMs, mtime1, 'the ever-present span stays mtime-stable');
  });

  await t.test('SPEC-MEMADOPT — the memory block rides OUTSIDE the section budget: a corpus at the exact boundary keeps every note in full', async () => {
    resetStore();
    // Boundary construction, not saturation: one gate line + ONE note sized so the gate/note corpus
    // lands EXACTLY at SECTION_BUDGET_BYTES. With the block composed outside the budget (the shipped
    // shape) the corpus fits and the note body renders in FULL TEXT; were the block counted against
    // the budget in ANY form (folded into renderSectionBody's inputs, or a `budget - blockLen` pass),
    // the corpus would overflow and renderSectionBody would fold this note to its pointer line — so
    // the full-text assertion below is the one observable that separates inside- from outside-budget.
    const gateSkill = seed({ id: 'g-keep', name: 'G Keep', description: 'd', body: 'G\n', gate: { mode: 'blocking', blocks: ['commit'] } });
    const gateLine = sectionGateText(gateSkill).join('\n');
    const noteLead = '**Big Note**\n'; // renderSectionBody's `**${name}**\n${body}` framing
    const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');
    const filler = 'y'.repeat(SECTION_BUDGET_BYTES - byteLen(gateLine) - byteLen('\n\n') - byteLen(noteLead));
    seed({
      id: 'big-note', name: 'Big Note', description: 'd', body: filler,
      providerOverrides: { codex: { channel: 'instructions-file' } },
    });
    // Fixture self-check: the corpus really sits AT the soft budget, so charging even one budgeted
    // byte for the block would force the fold. Recomputed from the live gate wording, so a wording
    // change re-sizes the filler instead of silently drifting off the boundary.
    assert.equal(
      byteLen([gateLine, `${noteLead}${filler}`].join('\n\n')), SECTION_BUDGET_BYTES,
      'fixture: the gate/note corpus is exactly at SECTION_BUDGET_BYTES',
    );

    const cfg = freshConfigDir();
    await materializeSkills('codex', ctx(cfg), store, noBypass);
    const agents = readFileSync(join(cfg, 'AGENTS.md'), 'utf8');
    assert.ok(agents.includes(MEMORY_SECTION_BLOCK), 'the memory block appears in full');
    assert.ok(agents.includes(gateLine), 'the gate line survives in full');
    assert.ok(agents.includes(filler), 'the boundary note body renders in FULL TEXT — holds only when the block is outside the budget');
    assert.ok(!agents.includes('- Big Note: see '), 'the note was never folded to its pointer line');
    assert.equal(count(agents, FENCE_BEGIN), 1, 'still exactly one well-formed fence');
  });
});

// ---- Phase 4: the blocking-gate policy renderer (pure) + its emission through the materializer ----

// sectionGateText reads only { id, name, gate }; cast a minimal shape (blocks persists as plain strings, so
// an unknown value is deliberately allowed past the narrow union — exactly the store's downgrade posture).
const gs = (gate: unknown, id = 'gs', name = 'GS'): Skill => ({ id, name, gate } as unknown as Skill);

await test('SPEC-SKILLS Phase-4 gate text — the pure renderer', async (t) => {
  await t.test('T1: the re-run sentence tracks rerunOnNewDiff', () => {
    const withRerun = sectionGateText(gs({ mode: 'blocking', blocks: ['commit'], rerunOnNewDiff: true }));
    assert.equal(withRerun.length, 1);
    assert.ok(withRerun[0]!.includes('re-run it over the new diff'), 'present when rerunOnNewDiff is set');
    const noRerun = sectionGateText(gs({ mode: 'blocking', blocks: ['commit'] }));
    assert.ok(!noRerun[0]!.includes('re-run it over the new diff'), 'absent when it is not set');
  });

  await t.test('T2: blocks partition — actionable named, loop-green self-emits, mission-land suppressed, unknown fail-closed', () => {
    const both = sectionGateText(gs({ mode: 'blocking', blocks: ['commit', 'push'] }))[0]!;
    assert.ok(both.includes('before any commit, push,'), 'both agent-actionable blocks are named');

    // SPEC-SKILLS-GATE — loop-green now emits its own evidence line (enforcement lives in the
    // completion evaluator; this line is how a mission sortie learns to attest).
    const lg = sectionGateText(gs({ mode: 'blocking', blocks: ['loop-green'] }));
    assert.equal(lg.length, 1, 'loop-green alone emits exactly its own line');
    assert.ok(lg[0]!.includes('towerctl gate submit --gate gs --result pass'), 'the line names the submit command with the skill id');
    assert.ok(lg[0]!.includes('when working a Tower mission sortie'), 'the phrasing is conditional — a non-mission agent is not confused');
    assert.ok(lg[0]!.includes('cannot finish green'), 'the line states the enforcement stake');
    assert.ok(!lg[0]!.includes('loop-green'), 'the raw block token never leaks into agent-facing text');

    assert.deepEqual(sectionGateText(gs({ mode: 'blocking', blocks: ['mission-land'] })), [], 'mission-land alone emits nothing to the agent');

    const mixed = sectionGateText(gs({ mode: 'blocking', blocks: ['commit', 'loop-green'] }));
    assert.equal(mixed.length, 2, 'a mixed gate emits the diff-policy line AND the loop-gate line');
    assert.ok(mixed[0]!.includes('before any commit,'), 'the actionable block is named in a mixed gate');
    assert.ok(mixed[1]!.includes('towerctl gate submit --gate gs'), 'the loop-gate line rides along');
    assert.ok(!mixed.join('\n').includes('mission-land'), 'no mission-land leak');
    assert.ok(!mixed.join('\n').includes('loop-green'), 'orchestrator vocabulary never leaks into agent-facing text');

    const unknown = sectionGateText(gs({ mode: 'blocking', blocks: ['frobnicate'] }));
    assert.equal(unknown.length, 1, 'an unknown block is never silently dropped');
    assert.ok(unknown[0]!.includes('the gated actions'), 'an unknown block gets the generic fail-closed phrasing');
    assert.ok(!unknown[0]!.includes('frobnicate'), 'the raw unknown token is not echoed');
  });

  await t.test('T3: an advisory gate renders nothing even with blocks + rerunOnNewDiff set (keys on MODE)', () => {
    assert.deepEqual(sectionGateText(gs({ mode: 'advisory', rerunOnNewDiff: true, blocks: ['commit'] })), [], 'advisory ⇒ no policy text');
    assert.deepEqual(sectionGateText(gs({ mode: 'advisory', blocks: ['loop-green'] })), [], 'advisory loop-green ⇒ no evidence line either (never gates the boundary, never instructs)');
    assert.deepEqual(sectionGateText(gs(undefined)), [], 'an absent gate ⇒ no policy text');
    assert.deepEqual(sectionGateText(gs({ mode: 'blocking', blocks: [] })), [], 'a blocking gate with no blocks ⇒ no line (the gate still exists for the orchestrator)');
  });

  await t.test('T3b: the rerun sentence rides the loop-gate line too', () => {
    const lg = sectionGateText(gs({ mode: 'blocking', blocks: ['loop-green'], rerunOnNewDiff: true }));
    assert.equal(lg.length, 1);
    assert.ok(lg[0]!.includes('re-run it over the new diff'), 'a rerunOnNewDiff loop gate tells the sortie to re-attest after fixes');
  });
});

const FULL_PORTAL_GATE =
  '- Portal Gate — BLOCKING gate: before any commit, push, run the `portal-gate` skill over the exact diff '
  + 'about to land and surface every finding (state an empty result explicitly). Never perform the gated '
  + 'action in the same turn the findings are surfaced. After any fix, re-run it over the new diff before proceeding.';

await test('SPEC-SKILLS Phase-4 gate text — through the materializer', async (t) => {
  await t.test('T4: a portable blocking skill emits the full contract on claude, codex, and gemini', async () => {
    resetStore();
    seed({ id: 'portal-gate', name: 'Portal Gate', description: 'd', body: 'G\n', gate: { mode: 'blocking', blocks: ['commit', 'push'], rerunOnNewDiff: true } });
    const cfgC = freshConfigDir();
    const cfgX = freshConfigDir();
    const cfgG = freshConfigDir();
    await materializeSkills('claude-code', ctx(cfgC), store, noBypass);
    await materializeSkills('codex', ctx(cfgX), store, noBypass);
    await materializeSkills('gemini-cli', ctx(cfgG), store, noBypass);

    const surfaces: [string, string][] = [
      ['claude', readFileSync(join(cfgC, 'CLAUDE.md'), 'utf8')],
      ['codex', readFileSync(join(cfgX, 'AGENTS.md'), 'utf8')],
      ['gemini', readFileSync(join(cfgG, '.gemini', 'GEMINI.md'), 'utf8')],
    ];
    for (const [label, content] of surfaces) {
      assert.ok(content.includes(FULL_PORTAL_GATE), `${label} carries the full gate contract, not the thin line`);
      assert.equal(count(content, FENCE_BEGIN), 1, `${label} has exactly one managed fence`);
      assert.equal(count(content, FENCE_END), 1, `${label} fence is well-formed`);
    }
  });

  await t.test('T5: the code-review shape gates claude CLAUDE.md; codex + gemini get the memory-only span, never the gate', async () => {
    resetStore();
    seed({
      id: 'code-review', name: 'Code Review', description: 'd', body: 'R\n',
      supportedProviders: ['claude-code'], requires: { capabilities: ['subagents'] },
      gate: { mode: 'blocking', blocks: ['commit', 'push'], enforcedBy: ['policy-text'], rerunOnNewDiff: true },
    });
    const cfgC = freshConfigDir();
    const cfgX = freshConfigDir();
    const cfgG = freshConfigDir();
    writeFileSync(join(cfgX, 'AGENTS.md'), 'operator codex memory\n');
    mkdirSync(join(cfgG, '.gemini'), { recursive: true });
    writeFileSync(join(cfgG, '.gemini', 'GEMINI.md'), 'operator gemini memory\n');

    await materializeSkills('claude-code', ctx(cfgC), store, noBypass);
    await materializeSkills('codex', ctx(cfgX), store, noBypass);
    await materializeSkills('gemini-cli', ctx(cfgG), store, noBypass);

    const claude = readFileSync(join(cfgC, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.includes('run the `code-review` skill over the exact diff'), 'the mandatory gate lands on claude — the one provider that has the skill');
    assert.ok(claude.includes('Never perform the gated action in the same turn'), 'the full contract is present, not a pointer');
    // SPEC-MEMADOPT: the ineligible providers still gain the ever-present span (the memory block) —
    // but the claude-only gate policy must never leak into it, and operator bytes stay at the head.
    const codexMd = readFileSync(join(cfgX, 'AGENTS.md'), 'utf8');
    assert.ok(codexMd.startsWith('operator codex memory\n'), 'codex operator bytes byte-preserved at the head');
    assert.ok(codexMd.includes(MEMORY_SECTION_BLOCK), 'codex carries the memory block');
    assert.ok(!codexMd.includes('code-review'), 'the claude-only gate never leaks onto codex');
    const gem = readFileSync(join(cfgG, '.gemini', 'GEMINI.md'), 'utf8');
    assert.ok(gem.startsWith('operator gemini memory\n'), 'gemini operator bytes byte-preserved at the head');
    assert.ok(gem.includes(MEMORY_SECTION_BLOCK), 'gemini carries the memory block');
    assert.ok(!gem.includes('code-review'), 'the claude-only gate never leaks onto gemini');
  });

  await t.test('T6: advisory skills emit no gate text (the span stays memory-only); a never-model advisory skill still dir-materializes on claude', async () => {
    resetStore();
    seed({ id: 'swarm-ish', name: 'Swarm Ish', description: 'd', body: 'S\n', supportedProviders: ['claude-code'], requires: { capabilities: ['subagents'] }, gate: { mode: 'advisory', rerunOnNewDiff: true } });
    seed({ id: 'fluff-ish', name: 'Fluff Ish', description: 'd', body: 'F\n', supportedProviders: ['claude-code'], requires: { capabilities: ['subagents'] }, invocation: { user: true, model: 'never' }, gate: { mode: 'advisory', rerunOnNewDiff: true } });
    const cfgC = freshConfigDir();
    await materializeSkills('claude-code', ctx(cfgC), store, noBypass);

    // SPEC-MEMADOPT: CLAUDE.md now exists (the ever-present memory span) — the advisory guarantee is
    // that no GATE TEXT enters it, not that the file is absent.
    const claude = readFileSync(join(cfgC, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.includes(MEMORY_SECTION_BLOCK), 'the span carries the memory block');
    assert.ok(!claude.includes('BLOCKING'), 'advisory skills never write gate policy text');
    assert.ok(!claude.includes('swarm-ish') && !claude.includes('fluff-ish'), 'no advisory skill is named in the span');
    assert.ok(existsSync(join(cfgC, 'skills', 'swarm-ish', 'SKILL.md')), 'the advisory skill still materializes as a native dir');
    assert.ok(existsSync(join(cfgC, 'skills', 'fluff-ish', 'SKILL.md')), 'the never-model advisory skill also dir-materializes on claude');
  });

  await t.test('T7: gate block and instructions-file note never cross-wire', async () => {
    resetStore();
    seed({ id: 'blk', name: 'Blk', description: 'd', body: 'B\n', gate: { mode: 'blocking', blocks: ['commit'] } });
    seed({ id: 'note', name: 'NoteSkill', description: 'd', body: 'ADVISORY NOTE BODY\n', gate: { mode: 'advisory' }, providerOverrides: { 'claude-code': { channel: 'instructions-file' } } });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', ctx(cfg), store, noBypass);

    const claude = readFileSync(join(cfg, 'CLAUDE.md'), 'utf8');
    const gateIdx = claude.indexOf('- Blk — BLOCKING gate:');
    const noteIdx = claude.indexOf('**NoteSkill**');
    assert.ok(gateIdx !== -1, 'the blocking skill renders as a gate line');
    assert.ok(noteIdx !== -1, 'the advisory skill renders as a note block');
    assert.ok(gateIdx < noteIdx, 'the gate block precedes the note block');
    assert.ok(claude.includes('**NoteSkill**\nADVISORY NOTE BODY'), 'the advisory body renders only as its note');
    assert.ok(!claude.includes('NoteSkill — BLOCKING gate'), 'the advisory skill is never promoted into a gate line');
    assert.ok(!/BLOCKING gate:[^\n]*ADVISORY NOTE BODY/.test(claude), 'a gate line never absorbs a note body');
  });

  await t.test('T8: claude CLAUDE.md follows the shipped merge discipline (operator bytes, ever-present span, mtime-stable, torn fence)', async () => {
    resetStore();
    seed({ id: 'ccgate', name: 'CC Gate', description: 'd', body: 'G\n', gate: { mode: 'blocking', blocks: ['commit'] } });
    const cfg = freshConfigDir();
    writeFileSync(join(cfg, 'CLAUDE.md'), 'operator memory line\n');
    await materializeSkills('claude-code', ctx(cfg), store, noBypass);

    let claude = readFileSync(join(cfg, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.startsWith('operator memory line\n'), 'operator bytes are preserved at the head');
    assert.ok(claude.includes(FENCE_BEGIN) && claude.includes(FENCE_END), 'a managed fence is present');

    const mtime1 = statSync(join(cfg, 'CLAUDE.md')).mtimeMs;
    await materializeSkills('claude-code', ctx(cfg), store, noBypass);
    assert.equal(statSync(join(cfg, 'CLAUDE.md')).mtimeMs, mtime1, 'an unchanged section is not rewritten (mtime-stable)');

    // Removing the last blocking skill empties the GATE corpus — SPEC-MEMADOPT: the span itself
    // stays (the ever-present memory block), only the gate line leaves. Operator bytes intact.
    store.remove('ccgate');
    await materializeSkills('claude-code', ctx(cfg), store, noBypass);
    claude = readFileSync(join(cfg, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.includes(FENCE_BEGIN) && claude.includes(FENCE_END), 'the span persists once the last blocking skill leaves');
    assert.ok(claude.includes(MEMORY_SECTION_BLOCK), 'it now holds just the memory block');
    assert.ok(!claude.includes('BLOCKING gate'), 'the departed gate line is gone from the span');
    assert.ok(claude.includes('operator memory line'), 'operator bytes survive the span shrink');

    // A torn operator fence in CLAUDE.md is hands-off + audited, exactly as on the shared codex/gemini files.
    resetStore();
    seed({ id: 'ccgate2', name: 'CC Gate2', description: 'd', body: 'G\n', gate: { mode: 'blocking', blocks: ['commit'] } });
    const cfg2 = freshConfigDir();
    const torn = `operator\n${FENCE_BEGIN}\nno end here\n`;
    writeFileSync(join(cfg2, 'CLAUDE.md'), torn);
    await materializeSkills('claude-code', ctx(cfg2), store, noBypass);
    assert.equal(readFileSync(join(cfg2, 'CLAUDE.md'), 'utf8'), torn, 'a torn claude fence is never rewritten');
    assert.ok(lastConflict('claude-code') >= 1, 'the torn claude fence is audited as a conflict');
  });
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
