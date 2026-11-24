// SPEC-SKILLS Phase 1 — the materializer that writes the central skill library into a claude account's
// <configDir>/skills. Mutation-meaningful discipline: every assertion is on REAL bytes/modes/inodes/paths
// in a temp configDir; no test trusts a return value or a fixture that impersonates the defect. No server,
// no tmux; CT_HOME is set before paths.js loads (it freezes at import).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchContext } from './adapters/types.js';
import type { UpsertSkillInput } from './skills/store.js';
import type { ProviderId, Terminal, Skill, SkillRequires } from '../shared/types.js';

const home = mkdtempSync(join(tmpdir(), 'ct-skills-mat-'));
process.env.CT_HOME = home;

const { paths, ensureDirs } = await import('./paths.js');
ensureDirs();
const { SkillStore } = await import('./skills/store.js');
const { materializeSkills, shouldMaterialize } = await import('./skills/materialize.js');
const { auditTail } = await import('./audit.js');

const store = new SkillStore();

// The default spawn-plane belt for tests: no live skip-permissions terminal anywhere. Explicit at every
// call — the deps parameter is REQUIRED by design (no fail-open default), so each test states its belt.
const noBypass = { hasLiveBypass: () => false };

// ---- Phase-2 helpers: the codex skills root is <configDir>/skills (CODEX_HOME=configDir); gemini's is
//      <configDir>/.gemini/skills, its command wrappers <configDir>/.gemini/commands, its section file
//      <configDir>/.gemini/GEMINI.md; codex's section file is <configDir>/AGENTS.md. ----
const GEMINI_SKILLS = join('.gemini', 'skills');
function dirsUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => !n.startsWith('.')).sort();
}
/** Every regular file under root, recursively — the draft-inertness sweep reads ALL of them. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
function lastMaterialize(provider: string): Record<string, unknown> | undefined {
  return auditTail(300).find((e) => e.action === 'skill.materialize' && e.provider === provider);
}
/* eslint-disable @typescript-eslint/no-explicit-any */
function rawManifest(configDir: string): any {
  return JSON.parse(readFileSync(join(configDir, '.ct-skills.json'), 'utf8'));
}

// ---- helpers ----
function resetStore(): void {
  for (const s of store.list()) store.remove(s.id);
}
function seed(over: Partial<UpsertSkillInput> & { id: string; name: string; description: string; body: string }): Skill {
  return store.upsert({ scope: 'global', enabled: true, origin: 'operator', ...over });
}
function freshConfigDir(): string {
  return mkdtempSync(join(home, 'cfg-'));
}
function makeCtx(configDir: string, over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    terminalId: 't1',
    projectId: 'p1',
    cwd: '/tmp/repo',
    repoPath: '/tmp/repo',
    hookTokenFile: '/tmp/tok',
    hookScript: '/tmp/hook',
    towerPort: 4870,
    spoolDir: '/tmp/spool',
    configDir,
    purpose: 'work',
    ...over,
  };
}
function skillDirs(configDir: string): string[] {
  const root = join(configDir, 'skills');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => !n.startsWith('.')).sort();
}
function mdOf(configDir: string, id: string): string {
  return readFileSync(join(configDir, 'skills', id, 'SKILL.md'), 'utf8');
}
function manifestOf(configDir: string): { v: number; channel: string; skills: Record<string, { version: number; contentHash: string; writtenPaths: string[] }> } {
  return JSON.parse(readFileSync(join(configDir, '.ct-skills.json'), 'utf8'));
}
function inoOf(p: string): bigint {
  return statSync(p, { bigint: true }).ino;
}
/** Parse the emitted frontmatter into a flat map (nested metadata children under `metadata.<key>`), plus the
 *  byte-exact body after the closing delimiter. */
function parseFm(md: string): { fm: Record<string, string>; body: string } {
  const lines = md.split('\n');
  assert.equal(lines[0], '---', 'opening delimiter');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  assert.ok(close > 0, 'closing delimiter present');
  const fm: Record<string, string> = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i]!;
    const nested = /^\s+([\w.-]+):\s*(.*)$/.exec(line);
    if (/^\s/.test(line)) {
      if (nested) fm[`metadata.${nested[1]}`] = nested[2]!;
      continue;
    }
    const m = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (m) fm[m[1]!] = m[2]!;
  }
  return { fm, body: lines.slice(close + 1).join('\n') };
}

await test('SPEC-SKILLS materializer', async (t) => {
  await t.test('1. fresh materialize + resolution (filter drops; unknown capability fails closed)', async () => {
    resetStore();
    seed({ id: 'keep-a', name: 'Keep A', description: 'a', body: 'A\n' });
    seed({ id: 'keep-b', name: 'Keep B', description: 'b', body: 'B\n' });
    seed({ id: 'off', name: 'Off', description: 'disabled', body: 'x\n', enabled: false });
    seed({ id: 'codex-only', name: 'Codex Only', description: 'c', body: 'x\n', supportedProviders: ['codex'] });
    // An unknown capability string (persists as a plain string by design) must fail closed.
    seed({ id: 'weird-cap', name: 'Weird', description: 'w', body: 'x\n', requires: { capabilities: ['no-such-cap'] as unknown as SkillRequires['capabilities'] } });

    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    assert.deepEqual(skillDirs(cfg), ['keep-a', 'keep-b'], 'exactly the two eligible skills materialize');
    assert.deepEqual(Object.keys(manifestOf(cfg).skills).sort(), ['keep-a', 'keep-b']);
    // Each managed dir carries an ownership marker.
    assert.ok(existsSync(join(cfg, 'skills', 'keep-a', '.ct-skill.json')));
  });

  await t.test('1b. a plain FILE at skills/<id> matching an eligible id is never clobbered', async () => {
    resetStore();
    seed({ id: 'filecollide', name: 'FC', description: 'd', body: 'MANAGED\n' });
    seed({ id: 'other', name: 'Other', description: 'd', body: 'O\n' });
    const cfg = freshConfigDir();
    mkdirSync(join(cfg, 'skills'), { recursive: true });
    const sentinel = 'HAND-FILE\n';
    writeFileSync(join(cfg, 'skills', 'filecollide'), sentinel); // a plain FILE, not a dir

    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    const st = statSync(join(cfg, 'skills', 'filecollide'));
    assert.ok(st.isFile(), 'still a plain file — not swapped for a dir');
    assert.equal(readFileSync(join(cfg, 'skills', 'filecollide'), 'utf8'), sentinel, 'bytes intact');
    assert.equal(manifestOf(cfg).skills.filecollide, undefined, 'the collision is a conflict, never claimed');
    assert.ok(existsSync(join(cfg, 'skills', 'other', 'SKILL.md')), 'the sync still completes for others');
  });

  await t.test('2. frontmatter emission — mapping + JSON-quoted YAML scalars', async () => {
    resetStore();
    // Trigger packing, a colon + quote in the description (YAML-hostile), a claude-override allowedTools
    // that must win over toolHints, argument-hint, tags, and model:'never' → disable-model-invocation.
    seed({
      id: 'fm', name: 'FM Skill',
      description: 'Reticulates: the "splines"',
      trigger: 'when asked',
      body: 'BODY\n',
      invocation: { user: true, model: 'never', argumentHint: 'what?' },
      toolHints: { allowedTools: ['ShouldLose'] },
      providerOverrides: { 'claude-code': { allowedTools: ['Bash', 'Read'] } },
      tags: ['alpha', 'beta'],
    });
    // A second skill whose model is 'suggest' must NOT emit the disable flag.
    seed({ id: 'sug', name: 'Sug', description: 'd', body: 'x\n', invocation: { user: true, model: 'suggest' } });

    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    const { fm } = parseFm(mdOf(cfg, 'fm'));
    assert.equal(JSON.parse(fm.name!), 'FM Skill');
    assert.equal(JSON.parse(fm.description!), 'Reticulates: the "splines" when asked', 'trigger packed with one space; scalar round-trips');
    assert.equal(fm.user_invocable, 'true', 'boolean emitted bare');
    assert.equal(fm['disable-model-invocation'], 'true', "model:'never' → disable flag");
    assert.equal(JSON.parse(fm['allowed-tools']!), 'Bash, Read', 'claude override wins over toolHints');
    assert.equal(JSON.parse(fm['argument-hint']!), 'what?');
    assert.equal(JSON.parse(fm['metadata.tags']!), 'alpha, beta');

    const sug = parseFm(mdOf(cfg, 'sug'));
    assert.equal(sug.fm['disable-model-invocation'], undefined, "model:'suggest' emits no disable flag");
  });

  await t.test('3. body verbatim + {{skillDir}} substituted (replaceAll, no $-substitution)', async () => {
    resetStore();
    const body = 'head\n{{skillDir}}/scripts/x.sh $HOME \\n more\nend {{skillDir}}\n';
    seed({ id: 'tpl', name: 'Tpl', description: 'd', body });

    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    const dir = join(cfg, 'skills', 'tpl');
    const expected = body.split('{{skillDir}}').join(dir); // both occurrences, literal
    assert.equal(parseFm(mdOf(cfg, 'tpl')).body, expected);
  });

  await t.test('4a. assets — nested dirs, byte-exact, exec bit restored', async () => {
    resetStore();
    const script = Buffer.from('#!/bin/sh\necho hi\n');
    const ref = Buffer.from('# reference\n');
    seed({
      id: 'assetful', name: 'Assetful', description: 'd', body: 'B\n',
      assets: [
        { relPath: 'scripts/run.sh', content: script, mode: 0o755 },
        { relPath: 'references/notes.md', content: ref, mode: 0o644 },
      ],
    });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    const runPath = join(cfg, 'skills', 'assetful', 'scripts', 'run.sh');
    assert.deepEqual(readFileSync(runPath), script, 'script bytes verbatim');
    assert.deepEqual(readFileSync(join(cfg, 'skills', 'assetful', 'references', 'notes.md')), ref);
    assert.notEqual(statSync(runPath).mode & 0o100, 0, 'owner exec bit restored from metadata');
  });

  await t.test('4b. asset integrity — a corrupted asset skips its skill, the other survives', async () => {
    resetStore();
    seed({ id: 'good', name: 'Good', description: 'd', body: 'G\n' });
    seed({
      id: 'bad', name: 'Bad', description: 'd', body: 'B\n',
      assets: [{ relPath: 'a.bin', content: Buffer.from('original'), mode: 0o644 }],
    });
    // Corrupt the stored asset bytes so its sha256 no longer matches the metadata.
    writeFileSync(join(paths.skillsData, 'bad', 'assets', 'a.bin'), Buffer.from('TAMPERED'));

    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    assert.deepEqual(skillDirs(cfg), ['good'], 'the tampered skill is skipped; the good one materializes');
    assert.equal(manifestOf(cfg).skills.bad, undefined, 'the skipped skill is not recorded');
  });

  await t.test('5. idempotent fast path — a second sync does not rewrite (same inode)', async () => {
    resetStore();
    seed({ id: 'idem', name: 'Idem', description: 'd', body: 'B\n' });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    const ino1 = inoOf(join(cfg, 'skills', 'idem', 'SKILL.md'));
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.equal(inoOf(join(cfg, 'skills', 'idem', 'SKILL.md')), ino1, 'unchanged content → not rewritten');
  });

  await t.test('6. change detection — only the changed skill is rewritten; manifest hash updated', async () => {
    resetStore();
    const a = seed({ id: 'chg', name: 'Chg', description: 'd', body: 'v1\n' });
    seed({ id: 'stable', name: 'Stable', description: 'd', body: 'S\n' });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    const chgIno1 = inoOf(join(cfg, 'skills', 'chg', 'SKILL.md'));
    const stableIno1 = inoOf(join(cfg, 'skills', 'stable', 'SKILL.md'));

    const a2 = store.upsert({ id: 'chg', name: 'Chg', description: 'd', body: 'v2\n' });
    assert.notEqual(a2.contentHash, a.contentHash, 'the store hash actually changed');
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    assert.notEqual(inoOf(join(cfg, 'skills', 'chg', 'SKILL.md')), chgIno1, 'the changed skill is rewritten');
    assert.equal(inoOf(join(cfg, 'skills', 'stable', 'SKILL.md')), stableIno1, 'the untouched skill is not');
    assert.equal(manifestOf(cfg).skills.chg!.contentHash, a2.contentHash, 'manifest hash tracks the new content');
    assert.equal(parseFm(mdOf(cfg, 'chg')).body, 'v2\n');
  });

  await t.test('6b. a tags-only edit re-materializes (tags are hashed emitted content)', async () => {
    resetStore();
    const a = seed({ id: 'tg', name: 'TG', description: 'd', body: 'B\n', tags: ['one'] });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    const ino1 = inoOf(join(cfg, 'skills', 'tg', 'SKILL.md'));

    const a2 = store.upsert({ id: 'tg', name: 'TG', description: 'd', body: 'B\n', tags: ['two'] });
    assert.notEqual(a2.contentHash, a.contentHash, 'a tags-only edit moves the store hash');
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    assert.notEqual(inoOf(join(cfg, 'skills', 'tg', 'SKILL.md')), ino1, 'the tags edit is re-materialized');
    assert.equal(JSON.parse(parseFm(mdOf(cfg, 'tg')).fm['metadata.tags']!), 'two', 'the new tags are emitted');
  });

  await t.test('7. deselect removal — a disabled skill and its manifest entry are removed', async () => {
    resetStore();
    seed({ id: 'gone', name: 'Gone', description: 'd', body: 'G\n' });
    seed({ id: 'survivor', name: 'Survivor', description: 'd', body: 'S\n' });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['gone', 'survivor']);

    store.upsert({ id: 'gone', name: 'Gone', description: 'd', body: 'G\n', enabled: false });
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    assert.deepEqual(skillDirs(cfg), ['survivor'], 'the deselected dir is removed');
    assert.equal(manifestOf(cfg).skills.gone, undefined);
    assert.ok(existsSync(join(cfg, 'skills', 'survivor', 'SKILL.md')), 'the survivor is untouched');
  });

  await t.test('8. unmanaged dir survives a full sync AND a deselect pass', async () => {
    resetStore();
    seed({ id: 's1', name: 'S1', description: 'd', body: 'S1\n' });
    const cfg = freshConfigDir();
    const handMd = '---\nname: hand\ndescription: operator drop\n---\nBODY\n';
    mkdirSync(join(cfg, 'skills', 'hand-made'), { recursive: true });
    writeFileSync(join(cfg, 'skills', 'hand-made', 'SKILL.md'), handMd);

    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.equal(readFileSync(join(cfg, 'skills', 'hand-made', 'SKILL.md'), 'utf8'), handMd, 'byte-identical survivor');
    assert.equal(manifestOf(cfg).skills['hand-made'], undefined, 'never claimed by the manifest');

    store.upsert({ id: 's1', name: 'S1', description: 'd', body: 'S1\n', enabled: false });
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.equal(readFileSync(join(cfg, 'skills', 'hand-made', 'SKILL.md'), 'utf8'), handMd, 'deletes do not go wide');
  });

  await t.test('9. conflict — an unmanaged dir at an eligible id is never clobbered', async () => {
    resetStore();
    seed({ id: 'conflictme', name: 'Conflict', description: 'd', body: 'MANAGED\n' });
    seed({ id: 'other', name: 'Other', description: 'd', body: 'O\n' });
    const cfg = freshConfigDir();
    const sentinel = '---\nname: mine\ndescription: mine\n---\nHAND-DROP\n';
    mkdirSync(join(cfg, 'skills', 'conflictme'), { recursive: true });
    writeFileSync(join(cfg, 'skills', 'conflictme', 'SKILL.md'), sentinel);

    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    assert.equal(readFileSync(join(cfg, 'skills', 'conflictme', 'SKILL.md'), 'utf8'), sentinel, 'operator content preserved');
    assert.equal(manifestOf(cfg).skills.conflictme, undefined, 'the conflict is not claimed');
    assert.ok(existsSync(join(cfg, 'skills', 'other', 'SKILL.md')), 'the sync still completes for others');
  });

  await t.test('10. marker reclaim — a lost manifest is rebuilt from markers, no rewrite', async () => {
    resetStore();
    seed({ id: 'rc', name: 'RC', description: 'd', body: 'B\n' });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    const ino1 = inoOf(join(cfg, 'skills', 'rc', 'SKILL.md'));

    rmSync(join(cfg, '.ct-skills.json')); // simulate the crash window between dir-swap and manifest-write
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    assert.equal(inoOf(join(cfg, 'skills', 'rc', 'SKILL.md')), ino1, 'marker hash matches → no rewrite');
    assert.ok(manifestOf(cfg).skills.rc, 'the manifest is rebuilt from the marker');
  });

  await t.test('11. corrupt manifest — quarantined, sync completes, unmanaged survives', async () => {
    resetStore();
    seed({ id: 'cm', name: 'CM', description: 'd', body: 'B\n' });
    const cfg = freshConfigDir();
    mkdirSync(join(cfg, 'skills', 'hand-made'), { recursive: true });
    writeFileSync(join(cfg, 'skills', 'hand-made', 'SKILL.md'), 'HAND\n');
    mkdirSync(join(cfg, '.ct-skills-stage'), { recursive: true }); // ensure configDir exists for the write
    writeFileSync(join(cfg, '.ct-skills.json'), '{ this is not json');

    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    const corrupt = readdirSync(cfg).filter((n) => n.startsWith('.ct-skills.json.corrupt-'));
    assert.equal(corrupt.length, 1, 'the corrupt manifest is quarantined');
    assert.ok(existsSync(join(cfg, 'skills', 'cm', 'SKILL.md')), 'the sync still completes');
    assert.equal(readFileSync(join(cfg, 'skills', 'hand-made', 'SKILL.md'), 'utf8'), 'HAND\n', 'unmanaged survives a corrupt manifest');
    assert.ok(manifestOf(cfg).skills.cm, 'a fresh manifest is written');
  });

  await t.test('12. stage sweep — a stale staging entry is cleared', async () => {
    resetStore();
    seed({ id: 'sw', name: 'SW', description: 'd', body: 'B\n' });
    const cfg = freshConfigDir();
    mkdirSync(join(cfg, '.ct-skills-stage', 'junk-123'), { recursive: true });
    writeFileSync(join(cfg, '.ct-skills-stage', 'junk-123', 'partial'), 'x');

    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);

    assert.ok(!existsSync(join(cfg, '.ct-skills-stage', 'junk-123')), 'stale staging leftover swept');
    assert.ok(existsSync(join(cfg, 'skills', 'sw', 'SKILL.md')));
  });

  await t.test('13. race — concurrent syncs into one dir serialize; a different dir is not blocked', async () => {
    resetStore();
    seed({ id: 'r1', name: 'R1', description: 'd', body: 'R1\n' });
    seed({ id: 'r2', name: 'R2', description: 'd', body: 'R2\n' });
    const cfg = freshConfigDir();
    const cfg2 = freshConfigDir();
    await Promise.all([
      materializeSkills('claude-code', makeCtx(cfg), store, noBypass),
      materializeSkills('claude-code', makeCtx(cfg), store, noBypass),
      materializeSkills('claude-code', makeCtx(cfg2), store, noBypass), // a different configDir, must not be blocked
    ]);
    assert.deepEqual(skillDirs(cfg), ['r1', 'r2']);
    assert.deepEqual(Object.keys(manifestOf(cfg).skills).sort(), skillDirs(cfg), 'manifest matches disk');
    assert.deepEqual(skillDirs(cfg2), ['r1', 'r2'], 'the parallel sync completed too');
  });

  await t.test('14. shouldMaterialize gate — the truth table (Phase 2: codex + gemini opt in)', () => {
    const T: [ProviderId, Terminal['purpose'] | undefined, boolean][] = [
      ['claude-code', undefined, true],
      ['claude-code', 'work', true],
      ['claude-code', 'planner', true],
      ['claude-code', 'login', false],
      ['codex', undefined, true],
      ['codex', 'work', true],
      ['codex', 'planner', true],
      ['codex', 'login', false],
      ['gemini-cli', undefined, true],
      ['gemini-cli', 'work', true],
      ['gemini-cli', 'planner', true],
      ['gemini-cli', 'login', false],
      ['shell', undefined, false], // no channel descriptor → never materializes
      ['custom:acme', 'work', false],
    ];
    for (const [p, purpose, want] of T) {
      assert.equal(shouldMaterialize(p, purpose), want, `${p}/${String(purpose)}`);
    }
  });

  await t.test('15. traversal defense — a crafted relPath writes nothing outside the skill dir', async () => {
    resetStore();
    // Bypass upsert (which would reject the path) — write skills.json directly, as a hand-edit could. The
    // load schema does not re-check relPath, so the record parses; the materializer must re-validate.
    mkdirSync(join(paths.skillsData, 'evil-skill'), { recursive: true });
    writeFileSync(join(paths.skillsData, 'evil-skill', 'body.md'), 'EVIL\n');
    const now = new Date().toISOString();
    const rec: Skill = {
      id: 'evil-skill', name: 'Evil', version: 1, contentHash: 'x', description: 'd',
      scope: 'global', enabled: true, invocation: { user: true, model: 'auto' },
      assets: [{ relPath: '../../evil', sha256: 'x', size: 4 }],
      origin: 'operator', createdAt: now, updatedAt: now,
    };
    writeFileSync(paths.skills, JSON.stringify([rec], null, 2));
    const s2 = new SkillStore();
    assert.ok(s2.get('evil-skill'), 'the crafted record loaded (the schema does not catch the traversal)');

    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), s2, noBypass);

    assert.ok(!existsSync(join(cfg, 'skills', 'evil-skill')), 'the unsafe skill is skipped');
    assert.ok(!existsSync(join(cfg, 'evil')), 'nothing is written to the traversal target');
    assert.equal(manifestOf(cfg).skills['evil-skill'], undefined);
  });

  await t.test('16. error posture — a whole-sync failure rejects, and the call-site shape swallows it', async () => {
    resetStore();
    seed({ id: 'e1', name: 'E1', description: 'd', body: 'B\n' });
    // Point configDir at a FILE: mkdir(<file>/skills) throws ENOTDIR regardless of privileges (not a perms
    // test, so it holds even under root).
    const asFile = join(home, 'not-a-dir');
    writeFileSync(asFile, 'x');
    const ctx = makeCtx(asFile);

    await assert.rejects(() => materializeSkills('claude-code', ctx, store, noBypass), 'a whole-sync failure rejects');

    // The terminal-manager call site wraps it in .catch — assert no throw escapes that shape.
    await assert.doesNotReject(async () => {
      await materializeSkills('claude-code', ctx, store, noBypass).catch(() => {});
    });

    // A login pane is a clean no-op (no write, no throw) even into the bad configDir.
    await assert.doesNotReject(() => materializeSkills('claude-code', makeCtx(asFile, { purpose: 'login' }), store, noBypass));
  });

  // ---- Phase 2: codex + gemini channels ----

  await t.test('17. channel layout — codex under skills/, gemini under .gemini/skills/, channel id recorded', async () => {
    resetStore();
    seed({ id: 'p1', name: 'P1', description: 'd', body: 'P1\n' });

    const cfgX = freshConfigDir();
    await materializeSkills('codex', makeCtx(cfgX), store, noBypass);
    assert.deepEqual(dirsUnder(join(cfgX, 'skills')), ['p1'], 'codex writes under <configDir>/skills');
    assert.equal(rawManifest(cfgX).channel, 'codex-skill-dir');
    assert.ok(existsSync(join(cfgX, 'skills', 'p1', '.ct-skill.json')), 'the per-skill marker rides the codex dir');

    const cfgG = freshConfigDir();
    await materializeSkills('gemini-cli', makeCtx(cfgG), store, noBypass);
    assert.deepEqual(dirsUnder(join(cfgG, GEMINI_SKILLS)), ['p1'], 'gemini writes under <configDir>/.gemini/skills');
    assert.equal(rawManifest(cfgG).channel, 'gemini-skill-dir');
    assert.ok(!existsSync(join(cfgG, 'skills', 'p1')), 'gemini does NOT write into the codex/claude skills root');
  });

  await t.test('18. portable frontmatter — exactly {name, description}; name is the SLUG, no claude-only keys', async () => {
    resetStore();
    // A display name that differs from the id, a trigger to pack, plus claude-shaped fields that must NOT
    // leak into the portable emitter (user_invocable / allowed-tools / metadata / disable flag).
    seed({
      id: 'port-skill', name: 'Port Skill Display',
      description: 'Reticulates: the "splines"', trigger: 'when asked',
      body: 'PORTABLE BODY\n',
      invocation: { user: true, model: 'auto', argumentHint: 'what?' },
      toolHints: { allowedTools: ['Bash'] },
      tags: ['a', 'b'],
    });
    const cfgX = freshConfigDir();
    await materializeSkills('codex', makeCtx(cfgX), store, noBypass);
    const { fm, body } = parseFm(readFileSync(join(cfgX, 'skills', 'port-skill', 'SKILL.md'), 'utf8'));
    assert.deepEqual(Object.keys(fm).sort(), ['description', 'name'], 'ONLY name + description — no claude-only keys');
    assert.equal(JSON.parse(fm.name!), 'port-skill', 'name is the slug/mention-handle, not the display name');
    assert.equal(JSON.parse(fm.description!), 'Reticulates: the "splines" when asked', 'trigger packed with one space; YAML-safe');
    assert.equal(body, 'PORTABLE BODY\n', 'body verbatim after the closing delimiter');
  });

  await t.test('19. claude emitter regression — a fixture SKILL.md is byte-identical to the Phase-1 format', async () => {
    resetStore();
    seed({ id: 'reg', name: 'Reg Skill', description: 'does things', body: 'BODY LINE\n', tags: ['x', 'y'] });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    const expected =
      '---\nname: "Reg Skill"\ndescription: "does things"\nuser_invocable: true\nmetadata:\n  tags: "x, y"\n---\nBODY LINE\n';
    assert.equal(mdOf(cfg, 'reg'), expected, 'the shipped claude channel output is unchanged by the generalization');
  });

  await t.test('20. cross-channel eligibility — caps/supportedProviders exclude; overrides scope per provider', async () => {
    resetStore();
    seed({ id: 'multi', name: 'Multi', description: 'd', body: 'M\n', requires: { capabilities: ['subagents'] } });
    seed({ id: 'cc-only', name: 'CC Only', description: 'd', body: 'C\n', supportedProviders: ['claude-code'] });
    seed({ id: 'portable', name: 'Portable', description: 'd', body: 'P\n' });
    seed({ id: 'omitcodex', name: 'OmitCodex', description: 'd', body: 'O\n', providerOverrides: { codex: { omit: true } } });
    seed({ id: 'bodyswap', name: 'BodySwap', description: 'd', body: 'CANON\n', providerOverrides: { codex: { body: 'CODEX BODY\n' } } });

    const cfgC = freshConfigDir();
    const cfgX = freshConfigDir();
    const cfgG = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfgC), store, noBypass);
    await materializeSkills('codex', makeCtx(cfgX), store, noBypass);
    await materializeSkills('gemini-cli', makeCtx(cfgG), store, noBypass);

    assert.deepEqual(dirsUnder(join(cfgC, 'skills')), ['bodyswap', 'cc-only', 'multi', 'omitcodex', 'portable'], 'claude gets all five');
    assert.deepEqual(dirsUnder(join(cfgX, 'skills')), ['bodyswap', 'portable'], 'codex drops caps-short, claude-only, and codex-omitted');
    assert.deepEqual(dirsUnder(join(cfgG, GEMINI_SKILLS)), ['bodyswap', 'omitcodex', 'portable'], 'gemini keeps codex-omitted, drops caps-short + claude-only');

    assert.equal(parseFm(mdOf(cfgX, 'bodyswap')).body, 'CODEX BODY\n', 'the codex override body wins for codex');
    assert.equal(parseFm(mdOf(cfgC, 'bodyswap')).body, 'CANON\n', 'claude keeps the canonical body');
    assert.equal(parseFm(readFileSync(join(cfgG, GEMINI_SKILLS, 'bodyswap', 'SKILL.md'), 'utf8')).body, 'CANON\n', 'gemini keeps the canonical body (the override is codex-scoped)');
  });

  await t.test("21. 'never' policy — user-only skills are skippedUnsupported on codex/gemini, honored on claude", async () => {
    resetStore();
    seed({ id: 'useronly', name: 'UserOnly', description: 'd', body: 'U\n', invocation: { user: true, model: 'never' } });

    const cfgC = freshConfigDir();
    const cfgX = freshConfigDir();
    const cfgG = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfgC), store, noBypass);
    await materializeSkills('codex', makeCtx(cfgX), store, noBypass);
    await materializeSkills('gemini-cli', makeCtx(cfgG), store, noBypass);

    assert.equal(parseFm(mdOf(cfgC, 'useronly')).fm['disable-model-invocation'], 'true', 'claude enforces user-only natively');
    assert.deepEqual(dirsUnder(join(cfgX, 'skills')), [], 'codex has no enforcement surface — not materialized');
    assert.deepEqual(dirsUnder(join(cfgG, GEMINI_SKILLS)), [], 'gemini likewise');
    assert.equal(lastMaterialize('codex')!.skippedUnsupported, 1, 'the skip is audited, never silent');
    assert.equal(lastMaterialize('gemini-cli')!.skippedUnsupported, 1);

    // The one honest 'never' surface gemini has: an authored invocable-prompt override → a command, no dir.
    resetStore();
    seed({
      id: 'gemcmd', name: 'GemCmd', description: 'd', body: 'G\n',
      invocation: { user: true, model: 'never' },
      providerOverrides: { 'gemini-cli': { channel: 'invocable-prompt' } },
    });
    const cfgG2 = freshConfigDir();
    await materializeSkills('gemini-cli', makeCtx(cfgG2), store, noBypass);
    assert.deepEqual(dirsUnder(join(cfgG2, GEMINI_SKILLS)), [], 'invocable-prompt emits no skill dir');
    const toml = readFileSync(join(cfgG2, '.gemini', 'commands', 'gemcmd.toml'), 'utf8');
    assert.match(toml.split('\n')[0]!, /^# ct-skill gemcmd [a-f0-9]+$/, 'the command wrapper carries the ownership marker');
    assert.equal(lastMaterialize('gemini-cli')!.skippedUnsupported, 0, 'a routed command is not a skip');
  });

  await t.test('22. gemini command wrappers — marker, JSON-escaped description, operator files survive, delete on disable', async () => {
    resetStore();
    seed({ id: 'cmd1', name: 'Cmd1', description: 'He said "hi"\nsecond line', body: 'C1\n', invocation: { user: true, model: 'auto' } });
    seed({ id: 'collidecmd', name: 'Collide', description: 'd', body: 'X\n', invocation: { user: true, model: 'auto' } });
    const cfg = freshConfigDir();
    const cmds = join(cfg, '.gemini', 'commands');
    mkdirSync(join(cmds, 'sub'), { recursive: true });
    writeFileSync(join(cmds, 'foo.toml'), 'prompt = "operator command"\n');
    writeFileSync(join(cmds, 'sub', 'dir.toml'), 'prompt = "nested operator command"\n');
    writeFileSync(join(cmds, 'collidecmd.toml'), 'prompt = "operator owns this name"\n'); // no marker

    await materializeSkills('gemini-cli', makeCtx(cfg), store, noBypass);

    const toml = readFileSync(join(cmds, 'cmd1.toml'), 'utf8').split('\n');
    assert.match(toml[0]!, /^# ct-skill cmd1 [a-f0-9]+$/, 'first line is the marker');
    assert.ok(toml[1]!.startsWith('description = '), 'a description line follows');
    assert.equal(JSON.parse(toml[1]!.slice('description = '.length)), 'He said "hi"\nsecond line', 'description JSON-escaped, round-trips');
    assert.ok(toml[2]!.startsWith('prompt = '), 'then the prompt');
    assert.match(JSON.parse(toml[2]!.slice('prompt = '.length)), /\{\{args\}\}$/, 'the prompt always ends with {{args}}');

    assert.equal(readFileSync(join(cmds, 'foo.toml'), 'utf8'), 'prompt = "operator command"\n', "operator's own command untouched");
    assert.equal(readFileSync(join(cmds, 'sub', 'dir.toml'), 'utf8'), 'prompt = "nested operator command"\n', 'a nested operator command untouched');
    assert.equal(readFileSync(join(cmds, 'collidecmd.toml'), 'utf8'), 'prompt = "operator owns this name"\n', 'an unmanaged file at an eligible id is a conflict, never clobbered');

    store.upsert({ id: 'cmd1', name: 'Cmd1', description: 'x', body: 'C1\n', enabled: false });
    await materializeSkills('gemini-cli', makeCtx(cfg), store, noBypass);
    assert.ok(!existsSync(join(cmds, 'cmd1.toml')), 'the owned wrapper is removed when the skill is disabled');
    assert.equal(readFileSync(join(cmds, 'foo.toml'), 'utf8'), 'prompt = "operator command"\n', 'the deletion pass never goes wide');
  });

  await t.test('23. codex shared namespace — .system/ and an unmanaged dir survive sync AND deselect', async () => {
    resetStore();
    seed({ id: 'sys1', name: 'Sys1', description: 'd', body: 'S\n' });
    seed({ id: 'collide', name: 'Collide', description: 'd', body: 'MANAGED\n' });
    const cfg = freshConfigDir();
    mkdirSync(join(cfg, 'skills', '.system', 'imagegen'), { recursive: true });
    writeFileSync(join(cfg, 'skills', '.system', 'imagegen', 'SKILL.md'), 'SYSTEM SKILL\n');
    const sentinel = '---\nname: mine\ndescription: mine\n---\nHAND-DROP\n';
    mkdirSync(join(cfg, 'skills', 'collide'), { recursive: true });
    writeFileSync(join(cfg, 'skills', 'collide', 'SKILL.md'), sentinel);

    await materializeSkills('codex', makeCtx(cfg), store, noBypass);
    assert.equal(readFileSync(join(cfg, 'skills', '.system', 'imagegen', 'SKILL.md'), 'utf8'), 'SYSTEM SKILL\n', 'codex .system is never scanned/clobbered');
    assert.equal(readFileSync(join(cfg, 'skills', 'collide', 'SKILL.md'), 'utf8'), sentinel, 'the unmanaged dir at an eligible id is a conflict');
    assert.equal(rawManifest(cfg).skills.collide, undefined, 'the conflict is never claimed');
    assert.ok(existsSync(join(cfg, 'skills', 'sys1', 'SKILL.md')), 'the sync still completes for the eligible skill');

    store.upsert({ id: 'sys1', name: 'Sys1', description: 'd', body: 'S\n', enabled: false });
    await materializeSkills('codex', makeCtx(cfg), store, noBypass);
    assert.equal(readFileSync(join(cfg, 'skills', '.system', 'imagegen', 'SKILL.md'), 'utf8'), 'SYSTEM SKILL\n', 'the deselect pass touches neither .system');
    assert.equal(readFileSync(join(cfg, 'skills', 'collide', 'SKILL.md'), 'utf8'), sentinel, 'nor the unmanaged dir');
  });

  await t.test('24. codex degradation — a whole-sync failure rejects; a bad asset skips only its skill', async () => {
    resetStore();
    seed({ id: 'okc', name: 'OkC', description: 'd', body: 'OK\n' });
    seed({ id: 'badc', name: 'BadC', description: 'd', body: 'B\n', assets: [{ relPath: 'a.bin', content: Buffer.from('orig'), mode: 0o644 }] });
    writeFileSync(join(paths.skillsData, 'badc', 'assets', 'a.bin'), Buffer.from('TAMPERED')); // sha no longer matches

    const cfg = freshConfigDir();
    await materializeSkills('codex', makeCtx(cfg), store, noBypass);
    assert.deepEqual(dirsUnder(join(cfg, 'skills')), ['okc'], 'the tampered skill is skipped; the good one materializes');

    const asFile = join(home, 'codex-not-a-dir');
    writeFileSync(asFile, 'x');
    await assert.rejects(() => materializeSkills('codex', makeCtx(asFile), store, noBypass), 'an unwritable codex configDir rejects');
  });

  await t.test('25. codex race + manifest tolerance — concurrent syncs serialize; a Phase-1 manifest loads', async () => {
    resetStore();
    seed({ id: 'r1', name: 'R1', description: 'd', body: 'R1\n' });
    seed({ id: 'r2', name: 'R2', description: 'd', body: 'R2\n' });
    const cfg = freshConfigDir();
    const cfgG = freshConfigDir();
    await Promise.all([
      materializeSkills('codex', makeCtx(cfg), store, noBypass),
      materializeSkills('codex', makeCtx(cfg), store, noBypass),
      materializeSkills('gemini-cli', makeCtx(cfgG), store, noBypass), // a different provider+dir must not be blocked
    ]);
    assert.deepEqual(dirsUnder(join(cfg, 'skills')), ['r1', 'r2']);
    assert.deepEqual(Object.keys(rawManifest(cfg).skills).sort(), ['r1', 'r2'], 'manifest matches disk after the race');
    assert.deepEqual(dirsUnder(join(cfgG, GEMINI_SKILLS)), ['r1', 'r2'], 'the parallel gemini sync completed too');

    // A Phase-1-shaped manifest (no files/sections keys) must load and drive the fast path unchanged.
    const legacy = { v: 1, channel: 'codex-skill-dir', skills: rawManifest(cfg).skills };
    writeFileSync(join(cfg, '.ct-skills.json'), JSON.stringify(legacy));
    await assert.doesNotReject(() => materializeSkills('codex', makeCtx(cfg), store, noBypass), 'a Phase-1 manifest is read tolerantly');
    assert.deepEqual(dirsUnder(join(cfg, 'skills')), ['r1', 'r2'], 'the sync completes over a legacy manifest');
  });

  await t.test('26. command-surface obstruction is isolated — dirs + manifest still land, not a total failure', async () => {
    resetStore();
    seed({ id: 'okg', name: 'OkG', description: 'd', body: 'OK\n', invocation: { user: true, model: 'auto' } });
    const cfg = freshConfigDir();
    // Obstruct .gemini/commands with a FILE so its mkdir throws — WITHOUT blocking .gemini/skills.
    mkdirSync(join(cfg, '.gemini'), { recursive: true });
    writeFileSync(join(cfg, '.gemini', 'commands'), 'not a directory');

    await assert.doesNotReject(() => materializeSkills('gemini-cli', makeCtx(cfg), store, noBypass), 'a command-surface failure never rejects the whole sync');
    assert.ok(existsSync(join(cfg, GEMINI_SKILLS, 'okg', 'SKILL.md')), 'the skill dir still materialized');
    assert.ok(rawManifest(cfg).skills.okg, 'the manifest still persisted (not aborted before the write)');
    assert.equal(lastMaterialize('gemini-cli')!.written, 1, 'the audit records the successful dir sync, not a total failure');
  });

  await t.test('27. Phase-3 resolver refactor — the global path is byte-identical; project-scope never materializes', async () => {
    resetStore();
    // A mixed library: two enabled-global, a disabled-global, a project-scope, and a provider-limited one.
    seed({ id: 'g-on', name: 'GOn', description: 'd', body: 'A\n' });
    seed({ id: 'g-on2', name: 'GOn2', description: 'd', body: 'B\n' });
    seed({ id: 'g-off', name: 'GOff', description: 'd', body: 'x\n', enabled: false });
    seed({ id: 'p-scope', name: 'PScope', description: 'd', body: 'x\n', scope: 'project' }); // must NOT materialize
    seed({ id: 'codex-lim', name: 'CodexLim', description: 'd', body: 'x\n', supportedProviders: ['codex'] });

    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    // EXACTLY the enabled-global provider-eligible ids — project-scope + disabled + codex-only excluded.
    // (Change resolveSkillSelection(store.list()) to admit a projectId or drop the scope rule and this fails.)
    assert.deepEqual(skillDirs(cfg), ['g-on', 'g-on2'], 'only the enabled-global provider-eligible skills land on disk');
    assert.ok(!existsSync(join(cfg, 'skills', 'p-scope')), 'the project-scope skill is never on the shared account dir in Phase 3');
    assert.deepEqual(Object.keys(manifestOf(cfg).skills).sort(), ['g-on', 'g-on2']);
    assert.equal(lastMaterialize('claude-code')!.written, 2, 'both eligible skills were written on the first sync');

    // Idempotence preserved by the refactor: a second sync rewrites nothing.
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    const second = lastMaterialize('claude-code')!;
    assert.equal(second.written, 0, 'the second sync writes nothing');
    assert.equal(second.unchanged, 2, 'both skills are unchanged on the second sync');
  });

  // ---- SPEC-SKILLS Phase 5b: the draft pad is structurally inert at THIS boundary ----

  await t.test('28. draft inertness — an open draft never reaches a configDir; only the operator enable fans it out', async () => {
    resetStore();
    const { SkillDraftStore } = await import('./skills/drafts.js');
    const drafts = new SkillDraftStore();
    const marker = 'DRAFT-ONLY-MARKER-9q4z';
    const d = drafts.save({ name: 'Draft Only', description: 'd', body: `${marker}\n` }, 'convmat');
    seed({ id: 'real', name: 'Real', description: 'd', body: 'R\n' });

    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['real'], 'only the library skill lands');
    // The behavioral half of the import-graph invariant: NO file anywhere under the configDir may
    // carry the draft's body or id — the materializer has no code path to the pad at all.
    for (const f of filesUnder(cfg)) {
      const text = readFileSync(f, 'utf8');
      assert.equal(text.includes(marker), false, `${f} must not carry the draft body`);
      assert.equal(text.includes(d.id), false, `${f} must not carry the draft id`);
    }

    // Promote exactly as the session-only route does — upsert with an EXPLICIT enabled:false, then
    // markPromoted. STILL absent after a re-sync: the lands-disabled proof at the materializer
    // (selection rule 4's fail-closed master switch).
    store.upsert({ name: 'Draft Only', description: 'd', body: `${marker}\n`, origin: 'assistant', enabled: false, scope: 'global' });
    drafts.markPromoted(d.id);
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['real'], 'a promoted-but-disabled skill still reaches no agent');

    // Flip enabled (the operator's narrow toggle calls exactly this) → NOW it materializes. The
    // mutation check: the absence above keyed on `enabled`, not on a broken fixture.
    store.setEnabled('draft-only', true);
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['draft-only', 'real'], 'enable is the one fan-out key');
    assert.equal(parseFm(mdOf(cfg, 'draft-only')).body, `${marker}\n`, 'the enabled skill materializes the promoted body');
  });

  // ---- SPEC-SKILLS Phase 5b wave 2 — autonomy clearance: the fail-closed churn at the choke point ----

  await t.test('29. autonomy churn matrix — an uncleared assistant skill never reaches a bypass-context sync, both directions', async () => {
    resetStore();
    const marker = 'UNCLEARED-BODY-MARKER-x7pq';
    seed({ id: 'op-skill', name: 'Op Skill', description: 'd', body: 'OP\n' }); // operator-origin: never gated
    seed({ id: 'a-cleared', name: 'A Cleared', description: 'd', body: 'AC\n', origin: 'assistant' });
    store.setAutonomyCleared('a-cleared', true);
    seed({ id: 'a-raw', name: 'A Raw', description: 'd', body: `${marker}\n`, origin: 'assistant' });

    const cfg = freshConfigDir();
    // A skip-permissions spawn: the uncleared assistant skill is excluded; cleared + operator land —
    // needsAutonomyClearance keys on origin AND flag, not on origin alone (the mutation pair is in-test).
    await materializeSkills('claude-code', makeCtx(cfg, { skipPermissions: true }), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['a-cleared', 'op-skill'], 'the uncleared assistant skill never materializes for a bypass spawn');
    assert.equal(lastMaterialize('claude-code')!.skippedUncleared, 1, 'the exclusion rides the audit line');
    assert.ok(!('a-raw' in manifestOf(cfg).skills), 'and never enters the manifest');

    // An interactive spawn with no live bypass on the account: it appears.
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['a-cleared', 'a-raw', 'op-skill'], 'an interactive spawn (no live bypass) gets it');
    assert.equal(lastMaterialize('claude-code')!.skippedUncleared, 0);

    // A bypass re-sync REMOVES the already-materialized dir: divergence between consecutive syncs on a
    // shared dir always moves toward FEWER LLM-authored instructions reaching a bypass agent.
    await materializeSkills('claude-code', makeCtx(cfg, { skipPermissions: true }), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['a-cleared', 'op-skill'], 'a bypass sync removes the uncleared dir');
    assert.ok(!('a-raw' in manifestOf(cfg).skills), 'the manifest entry is gone too');
    const third = lastMaterialize('claude-code')!;
    assert.equal(third.removed, 1, 'the removal is counted');
    assert.equal(third.skippedUncleared, 1);
    // The invariant sweep (the draft-inertness idiom): after an excluding sync, NO file anywhere under
    // the configDir carries the uncleared body.
    for (const f of filesUnder(cfg)) {
      assert.equal(readFileSync(f, 'utf8').includes(marker), false, `${f} must not carry the uncleared body`);
    }
    // And back: the interactive re-sync restores it. Both directions are the design.
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['a-cleared', 'a-raw', 'op-skill'], 'the interactive re-sync restores it');
  });

  await t.test('30. the live-bypass belt — an interactive sync excludes (and removes) while a bypass terminal is live; a belt throw fails closed', async () => {
    resetStore();
    seed({ id: 'belt-raw', name: 'Belt Raw', description: 'd', body: 'BR\n', origin: 'assistant' });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['belt-raw'], 'baseline: no live bypass, the interactive sync writes it');

    // A live skip-permissions terminal shares the account dir: this INTERACTIVE sync must not re-add —
    // and must remove what is present (the bypass CLI can re-scan its skills dir mid-session).
    await materializeSkills('claude-code', makeCtx(cfg), store, { hasLiveBypass: () => true });
    assert.deepEqual(skillDirs(cfg), [], 'the belt removes the uncleared skill from the shared dir');
    assert.equal(lastMaterialize('claude-code')!.skippedUncleared, 1);

    // Fail-closed: a throwing registry read excludes exactly like a live bypass — never includes.
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass); // restore first
    assert.deepEqual(skillDirs(cfg), ['belt-raw']);
    await materializeSkills('claude-code', makeCtx(cfg), store, {
      hasLiveBypass: () => { throw new Error('registry unreadable'); },
    });
    assert.deepEqual(skillDirs(cfg), [], 'a belt failure excludes — the churn fails closed');
    assert.equal(lastMaterialize('claude-code')!.skippedUncleared, 1);
  });

  await t.test('31. clearance lifecycle at the choke point — clearing admits a bypass sync; a content change re-excludes', async () => {
    resetStore();
    seed({ id: 'lifecycle', name: 'Lifecycle', description: 'd', body: 'L1\n', origin: 'assistant' });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg, { skipPermissions: true }), store, noBypass);
    assert.deepEqual(skillDirs(cfg), [], 'uncleared: excluded from the bypass spawn');

    store.setAutonomyCleared('lifecycle', true);
    await materializeSkills('claude-code', makeCtx(cfg, { skipPermissions: true }), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['lifecycle'], 'cleared: the bypass spawn materializes it');

    // A content change (the promote-update shape rides this same upsert) drops clearance in the SAME
    // write → the next bypass sync removes the new body before any bypass agent reads it.
    store.upsert({ id: 'lifecycle', name: 'Lifecycle', description: 'd', body: 'L2\n' });
    await materializeSkills('claude-code', makeCtx(cfg, { skipPermissions: true }), store, noBypass);
    assert.deepEqual(skillDirs(cfg), [], 'the hash-keyed reset re-excludes the changed body');
  });

  await t.test('32. one predicate, every surface — gemini wrapper, section gate line, and skill dir churn together', async () => {
    resetStore();
    // An uncleared assistant skill authored as a command-only wrapper, and one carrying a blocking gate
    // whose policy line rides the managed section.
    seed({
      id: 'wrappy', name: 'Wrappy', description: 'd', body: 'W\n', origin: 'assistant',
      providerOverrides: { 'gemini-cli': { channel: 'invocable-prompt' } },
    });
    seed({ id: 'gatey', name: 'Gatey', description: 'd', body: 'G\n', origin: 'assistant', gate: { mode: 'blocking', blocks: ['commit'] } });

    const cfg = freshConfigDir();
    await materializeSkills('gemini-cli', makeCtx(cfg), store, noBypass);
    assert.ok(existsSync(join(cfg, '.gemini', 'commands', 'wrappy.toml')), 'baseline: the command wrapper landed');
    assert.deepEqual(dirsUnder(join(cfg, GEMINI_SKILLS)), ['gatey'], 'baseline: the gate skill dir landed');
    assert.match(readFileSync(join(cfg, '.gemini', 'GEMINI.md'), 'utf8'), /`gatey`/, 'baseline: the section carries the gate policy line');

    await materializeSkills('gemini-cli', makeCtx(cfg, { skipPermissions: true }), store, noBypass);
    assert.equal(existsSync(join(cfg, '.gemini', 'commands', 'wrappy.toml')), false, 'the wrapper is removed');
    assert.deepEqual(dirsUnder(join(cfg, GEMINI_SKILLS)), [], 'the skill dir is removed');
    const section = existsSync(join(cfg, '.gemini', 'GEMINI.md')) ? readFileSync(join(cfg, '.gemini', 'GEMINI.md'), 'utf8') : '';
    assert.equal(section.includes('gatey'), false, 'the section dropped the gate line');
    assert.equal(lastMaterialize('gemini-cli')!.skippedUncleared, 2, 'the one first-line predicate covered both skills');

    // The other direction: an interactive re-sync restores all three surfaces.
    await materializeSkills('gemini-cli', makeCtx(cfg), store, noBypass);
    assert.ok(existsSync(join(cfg, '.gemini', 'commands', 'wrappy.toml')), 'restored: the wrapper');
    assert.deepEqual(dirsUnder(join(cfg, GEMINI_SKILLS)), ['gatey'], 'restored: the dir');
    assert.match(readFileSync(join(cfg, '.gemini', 'GEMINI.md'), 'utf8'), /`gatey`/, 'restored: the section line');
  });

  await t.test('33. marker tamper — a de-markered uncleared artifact cannot survive an excluding sync', async () => {
    resetStore();
    seed({ id: 'demarker', name: 'De Marker', description: 'd', body: 'DM\n', origin: 'assistant' });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.deepEqual(skillDirs(cfg), ['demarker'], 'baseline: the interactive sync wrote it');

    // The tamper an uncleared body could instruct its interactive host to perform: delete the
    // ownership marker in place, so the dir classifies as unmanaged forever after.
    rmSync(join(cfg, 'skills', 'demarker', '.ct-skill.json'), { force: true });

    // An interactive sync leaves it: a marker-less dir is potential operator content, and interactive
    // agents may carry uncleared skills anyway.
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.ok(existsSync(join(cfg, 'skills', 'demarker', 'SKILL.md')), 'an interactive sync never touches it');

    // An excluding sync treats the exact name-match to a KNOWN uncleared skill as tampering: removed,
    // marker or not — de-markering must never become a permanent bypass exemption.
    await materializeSkills('claude-code', makeCtx(cfg), store, { hasLiveBypass: () => true });
    assert.equal(existsSync(join(cfg, 'skills', 'demarker')), false, 'the excluding sync removes the de-markered dir');
    assert.equal(lastMaterialize('claude-code')!.removedTampered, 1, 'and counts the tamper removal on the audit line');

    // The wrapper edition: strip the first-line ownership marker from an uncleared skill's command file.
    resetStore();
    seed({
      id: 'wraptamper', name: 'Wrap Tamper', description: 'd', body: 'WT\n', origin: 'assistant',
      providerOverrides: { 'gemini-cli': { channel: 'invocable-prompt' } },
    });
    const cfgG = freshConfigDir();
    await materializeSkills('gemini-cli', makeCtx(cfgG), store, noBypass);
    const toml = join(cfgG, '.gemini', 'commands', 'wraptamper.toml');
    const stripped = readFileSync(toml, 'utf8').split('\n').slice(1).join('\n');
    writeFileSync(toml, stripped); // the marker line is gone — the scan now classifies it unmanaged
    await materializeSkills('gemini-cli', makeCtx(cfgG, { skipPermissions: true }), store, noBypass);
    assert.equal(existsSync(toml), false, 'the marker-stripped wrapper is removed by the excluding sync');
    assert.equal(lastMaterialize('gemini-cli')!.removedTampered, 1);
  });

  await t.test('34. a blind classification scan is never silent — the failure is counted on the audit line', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes — the fixture cannot fail
    resetStore();
    seed({ id: 'scanned', name: 'Scanned', description: 'd', body: 'S\n' });
    const cfg = freshConfigDir();
    await materializeSkills('claude-code', makeCtx(cfg), store, noBypass);
    assert.equal(lastMaterialize('claude-code')!.scanFailures, 0, 'a healthy scan reports zero failures');

    // An unreadable skills root: readdir throws, so the removal pass is blind. The sync must not
    // report that as a clean removal — the failure count rides the same audit line.
    chmodSync(join(cfg, 'skills'), 0o000);
    try {
      await materializeSkills('claude-code', makeCtx(cfg, { skipPermissions: true }), store, noBypass);
    } finally {
      chmodSync(join(cfg, 'skills'), 0o700);
    }
    const blind = lastMaterialize('claude-code')!;
    assert.equal(blind.scanFailures, 1, 'the unreadable root is COUNTED, never conflated with an empty dir');
    assert.equal(blind.removed, 0, 'nothing was removed — and the line now says why');
  });
});

process.on('exit', () => rmSync(home, { recursive: true, force: true }));
