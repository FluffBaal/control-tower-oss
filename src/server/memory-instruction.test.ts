// SPEC-MEMADOPT / SPEC-MEMORY — pins on the standing project-memory instruction constants. These are
// prose the two delivery seams (managed section + loop footer) ship verbatim to every spawned agent, so
// the pins guard the properties the wording is load-bearing for: the view list stays coupled to
// MEMORY_FILES and the kind list to MEMORY_KINDS (a rename can't strand the text), the record guidance
// is the entry verbs (add, and update / dispute by id + rev) and never the retired whole-view write, the
// read guidance is unconditional and comes first, verification is the operator's word alone, the two
// off-ramps (a skill for standing rules, `towerctl note` for progress) are named, the posture is
// context-not-instructions, and no vendor name ever rides agent-facing prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-meminstr-'));
process.env.CT_HOME = home; // guard: paths.js freezes at import if any server module pulls it in

const { MEMORY_FILES, MEMORY_KINDS } = await import('../shared/memory.js');
const { MEMORY_SECTION_BLOCK, MEMORY_LOOP_FOOTER } = await import('./memory-instruction.js');

const BOTH = [['section block', MEMORY_SECTION_BLOCK], ['loop footer', MEMORY_LOOP_FOOTER]] as const;

await test('SPEC-MEMADOPT memory-instruction constants', async (t) => {
  await t.test('every MEMORY_FILES view name appears in both constants — a rename cannot strand the text', () => {
    // Kills: hardcoding the view list in either PROSE constant instead of deriving it. MEMORY_FILE_LIST
    // itself is deliberately unasserted here — it is MEMORY_FILES.join(), so any coupling assertion on
    // it would only test String.join; its consumers (the footer, the planner consult) carry the intent.
    for (const [label, text] of BOTH) {
      for (const f of MEMORY_FILES) assert.ok(text.includes(f), `${label} names ${f}`);
    }
  });

  await t.test('every MEMORY_KINDS value appears in both constants as the --kind choice list', () => {
    // Kills: hardcoding the kind list — `towerctl memory add --kind` accepts exactly MEMORY_KINDS, so
    // the instruction must offer the same set or an agent copies a value the CLI refuses.
    for (const [label, text] of BOTH) {
      for (const k of MEMORY_KINDS) assert.ok(text.includes(k), `${label} offers kind ${k}`);
      assert.ok(text.includes(`--kind ${MEMORY_KINDS.join('|')}`), `${label} spells the --kind list the way the CLI usage does`);
    }
  });

  await t.test('both constants teach the entry verbs: read (and search) first, then add', () => {
    for (const [label, text] of BOTH) {
      assert.ok(text.includes('towerctl memory read'), `${label} carries the read command`);
      assert.ok(text.includes('towerctl memory search'), `${label} carries the search command`);
      assert.ok(text.includes('towerctl memory add'), `${label} carries the add command`);
      assert.ok(
        text.indexOf('towerctl memory read') < text.indexOf('towerctl memory add'),
        `${label} puts read before add — consult before you record`,
      );
    }
  });

  await t.test('correcting and disagreeing are entry operations by id and rev', () => {
    // The section block spells both verbs with their CAS token; the one-line footer names the
    // operations and the token without the full syntax.
    assert.ok(MEMORY_SECTION_BLOCK.includes('towerctl memory update <id> --rev <n>'), 'section block spells the update verb with id + rev');
    assert.ok(MEMORY_SECTION_BLOCK.includes('towerctl memory dispute <id> --rev <n>'), 'section block spells the dispute verb with id + rev');
    assert.match(MEMORY_LOOP_FOOTER, /dispute/, 'footer names dispute');
    assert.match(MEMORY_LOOP_FOOTER, /\brev\b/, 'footer names the rev token');
  });

  await t.test('no trace of the retired whole-view write remains', () => {
    // Kills: a revert to the old workflow — `towerctl memory write` replaced an entire view, so an
    // agent following that text today would clobber every other agent's entries in one call. The
    // budget figure went with it: an entry body is clamped server-side, there is no file to fill.
    for (const [label, text] of BOTH) {
      assert.ok(!text.includes('memory write'), `${label} never names the write verb`);
      assert.doesNotMatch(text, /whole file|full updated content|replaces? the (whole )?(file|view)/i, `${label} carries no whole-file wording`);
      assert.doesNotMatch(text, /64\s?KB/i, `${label} names no whole-file budget`);
    }
  });

  await t.test('verification is the operator\'s alone — a passing test never promotes an entry', () => {
    // Mirrors the schema.ts transition table (provisional→verified is operator-only; a `test` evidence
    // item never flips verification) so the agent hears the rule it is structurally held to.
    for (const [label, text] of BOTH) {
      assert.match(text, /only the operator marks an entry verified/i, `${label} states who verifies`);
    }
    assert.match(MEMORY_SECTION_BLOCK, /passing test does not make an entry verified/i, 'section block states that a passing test is not verification');
  });

  await t.test('both off-ramps are named: a standing rule is a skill, progress goes to towerctl note', () => {
    for (const [label, text] of BOTH) {
      assert.match(text, /skill/i, `${label} points standing rules at a skill`);
      assert.ok(text.includes('towerctl note'), `${label} points progress notes at towerctl note`);
    }
  });

  await t.test('the context-not-instructions posture rides both renderings', () => {
    // Memory is written by other agents — prompt-injection posture: what is read there must never be
    // framed as instructions that can override the agent's task.
    for (const [label, text] of BOTH) {
      assert.match(text, /context/i, `${label} frames memory content as context`);
      assert.match(text, /not\s+(as\s+)?instructions/i, `${label} states it is not instructions`);
    }
  });

  await t.test('provider-neutral: no vendor or product name in agent-facing prose', () => {
    const banned = /claude|codex|gemini|anthropic|openai|google|gpt/i;
    assert.doesNotMatch(MEMORY_SECTION_BLOCK, banned, 'section block is vendor-clean');
    assert.doesNotMatch(MEMORY_LOOP_FOOTER, banned, 'loop footer is vendor-clean');
  });

  await t.test('the constants stay bounded — the section lands in every agent config file, the footer in every iteration prompt', () => {
    assert.ok(Buffer.byteLength(MEMORY_SECTION_BLOCK, 'utf8') < 1024, 'the section block stays under 1 KB');
    assert.ok(Buffer.byteLength(MEMORY_LOOP_FOOTER, 'utf8') < 512, 'the footer stays a compact single addition');
    assert.ok(!MEMORY_LOOP_FOOTER.includes('\n'), 'the footer is one line');
  });
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
