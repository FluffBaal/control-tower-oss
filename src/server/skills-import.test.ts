// The skill importer (SPEC-SKILLS) against a FIXTURE dir that reproduces the real corpus variance: a
// `>-` folded description and a plain one, user_invocable present/absent, disable-model-invocation
// true/false, a quoted argument-hint, an allowed-tools comma string, a metadata.tags comma string, an
// unknown frontmatter key, a body with a fenced code block + trailing newline (stored BYTE-exact), a
// nested asset, a 0o755 script (index mode 0o755 while the stored file is 0600), dir-name ≠ frontmatter
// name, a dir with no SKILL.md, and a dir with broken frontmatter. Plus the hand-curated table seeding
// and BYTE-CHECKED re-import idempotence. No server, no tmux; CT_HOME is set before paths.js loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ct-skills-import-'));
process.env.CT_HOME = home;
const { paths, ensureDirs } = await import('./paths.js');
ensureDirs();
const { SkillStore } = await import('./skills/store.js');
const { importSkillsFromDir } = await import('./skills/import.js');

// ---- Build the fixture corpus ----
const corpus = join(home, 'fixture-skills');
mkdirSync(corpus, { recursive: true });
function writeFile(rel: string, content: string | Buffer): string {
  const abs = join(corpus, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

// `folded`: folded description, plain user_invocable, allowed-tools + metadata.tags comma strings, an
// unknown key, a fenced body + trailing newline, and a nested asset.
const foldedBody = '# Folded\n\nBody text.\n\n```js\nconst x = 1;\n```\n';
const foldedFm = [
  '---',
  'name: folded',
  'description: >-',
  '  Line one of the folded description',
  '  continues here.',
  'user_invocable: true',
  'weird-unknown-key: whatever',
  'allowed-tools: Bash(git diff:*), Bash(gh pr view:*)',
  'metadata:',
  '  tags: alpha, beta, gamma',
  '---',
  '',
].join('\n');
const foldedRaw = foldedFm + foldedBody;
writeFile('folded/SKILL.md', foldedRaw);
writeFile('folded/rules/assets/x.tsx', 'export const X = 1;\n');

// `plainmodel`: plain description, disable-model-invocation:true (→ never), no user_invocable (→ user true).
writeFile('plainmodel/SKILL.md', '---\nname: plainmodel\ndescription: A plain one-line description.\ndisable-model-invocation: true\n---\nPlain body.\n');

// `quoted`: quoted argument-hint, disable-model-invocation:false (→ auto).
writeFile('quoted/SKILL.md', '---\nname: quoted\ndescription: Quoted hint skill.\ndisable-model-invocation: false\nargument-hint: "What would you like?"\n---\nQuoted body.\n');

// `named`: dir name ≠ frontmatter name, plus a 0o755 script asset.
writeFile('named/SKILL.md', '---\nname: emil-named\ndescription: The name differs from the dir.\n---\nNamed body.\n');
const scriptAbs = writeFile('named/scripts/run.sh', '#!/bin/sh\necho hi\n');
chmodSync(scriptAbs, 0o755);

// `code-review`: a curated multi-agent skill — the hand-curated table must seed it.
writeFile('code-review/SKILL.md', '---\nname: code-review\ndescription: Multi-agent code review over a diff.\ndisable-model-invocation: false\nuser_invocable: true\nallowed-tools: Bash(git diff:*), Bash(gh pr view:*)\n---\nReview body.\n');

// `nomd`: a directory with no SKILL.md → an errors entry.
mkdirSync(join(corpus, 'nomd'), { recursive: true });
writeFile('nomd/README.md', 'not a skill\n');

// `broken`: SKILL.md with no closing frontmatter delimiter → an errors entry.
writeFile('broken/SKILL.md', '---\nname: broken\ndescription: x\nno closing delimiter here\n');

// ---- Import ----
const store = new SkillStore();
const report = importSkillsFromDir(corpus, store);

test('import brings in every valid skill and files the two bad dirs as errors', () => {
  assert.deepEqual([...report.imported].sort(), ['code-review', 'folded', 'named', 'plainmodel', 'quoted']);
  const errIds = report.errors.map((e) => e.id).sort();
  assert.deepEqual(errIds, ['broken', 'nomd']);
  assert.match(report.errors.find((e) => e.id === 'nomd')!.reason, /no SKILL\.md/);
  assert.match(report.errors.find((e) => e.id === 'broken')!.reason, /closing frontmatter/);
  // The unknown frontmatter key is a warning, not an error.
  assert.ok(report.warnings.some((w) => /folded/.test(w)), 'the unknown key produced a warning');
});

test('folded: folded description, comma lists, byte-exact body, nested asset', () => {
  const s = store.get('folded')!;
  assert.equal(s.description, 'Line one of the folded description continues here.', 'the >- scalar folds with spaces');
  assert.deepEqual(s.toolHints?.allowedTools, ['Bash(git diff:*)', 'Bash(gh pr view:*)']);
  assert.deepEqual(s.tags, ['alpha', 'beta', 'gamma']);
  assert.equal(s.invocation.user, true);
  assert.equal(s.invocation.model, 'auto');
  // Body is stored BYTE-exact (frontmatter stripped, nothing normalized).
  const body = store.getBody('folded')!;
  assert.equal(body, foldedBody);
  assert.ok(foldedRaw.endsWith(body), 'the stored body is a byte-exact suffix of the source file');
  // The nested asset is captured with a posix relPath.
  assert.ok(s.assets?.some((a) => a.relPath === 'rules/assets/x.tsx'), 'the nested asset is captured');
});

test('plainmodel: disable-model-invocation true → never; absent user_invocable → user true', () => {
  const s = store.get('plainmodel')!;
  assert.equal(s.invocation.model, 'never');
  assert.equal(s.invocation.user, true);
});

test('quoted: a quoted argument-hint is unquoted; false → auto', () => {
  const s = store.get('quoted')!;
  assert.equal(s.invocation.argumentHint, 'What would you like?');
  assert.equal(s.invocation.model, 'auto');
});

test('named: id is the dir, name is the frontmatter; exec bit is metadata while the stored file is 0600', () => {
  const s = store.get('named')!;
  assert.equal(s.id, 'named');
  assert.equal(s.name, 'emil-named');
  const script = s.assets?.find((a) => a.relPath === 'scripts/run.sh');
  assert.ok(script, 'the script asset is captured');
  assert.equal(script!.mode, 0o755, 'the original exec bit is recorded as METADATA');
  const stored = statSync(join(paths.skillsData, 'named', 'assets', 'scripts', 'run.sh'));
  assert.equal(stored.mode & 0o777, 0o600, 'the stored file is written 0600 regardless');
});

test('the hand-curated table seeds code-review (flip a cell and this fails)', () => {
  const s = store.get('code-review')!;
  assert.deepEqual(s.supportedProviders, ['claude-code']);
  assert.deepEqual(s.requires?.capabilities, ['subagents']);
  assert.equal(s.gate?.mode, 'blocking');
  assert.deepEqual(s.gate?.blocks, ['commit', 'push']);
  assert.deepEqual(s.gate?.enforcedBy, ['policy-text']);
  assert.equal(s.gate?.rerunOnNewDiff, true);
  assert.equal(s.invocation.model, 'auto', 'disable-model-invocation:false stays auto (load-bearing)');
});

test('re-import is idempotent — all skipped, and skills.json is byte-identical', () => {
  const before = readFileSync(paths.skills);
  const second = importSkillsFromDir(corpus, store);
  assert.equal(second.imported.length, 0, 'nothing re-imported');
  assert.deepEqual([...second.skipped.map((s) => s.id)].sort(), ['code-review', 'folded', 'named', 'plainmodel', 'quoted']);
  const after = readFileSync(paths.skills);
  assert.ok(before.equals(after), 'the index bytes are unchanged by a re-import');
  // And no skill dir was disturbed.
  assert.ok(existsSync(join(paths.skillsData, 'folded', 'body.md')));
});

test('an oversized asset is skipped with a warning, not read into the record', () => {
  const corpus2 = join(home, 'fixture-big');
  mkdirSync(join(corpus2, 'bigasset'), { recursive: true });
  writeFileSync(join(corpus2, 'bigasset', 'SKILL.md'), '---\nname: bigasset\ndescription: has a huge asset.\n---\nBody.\n');
  writeFileSync(join(corpus2, 'bigasset', 'ok.txt'), 'small\n');
  writeFileSync(join(corpus2, 'bigasset', 'huge.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 1)); // just over MAX_ASSET_BYTES
  const store2 = new SkillStore();
  const rep = importSkillsFromDir(corpus2, store2);
  assert.deepEqual(rep.imported, ['bigasset'], 'the skill still imports (the oversized file is just dropped)');
  const s = store2.get('bigasset')!;
  assert.ok(s.assets?.some((a) => a.relPath === 'ok.txt'), 'the normal asset is captured');
  assert.ok(!s.assets?.some((a) => a.relPath === 'huge.bin'), 'the oversized asset is NOT in the record');
  assert.ok(rep.warnings.some((w) => /bigasset.*huge\.bin/.test(w)), 'a warning names the skipped oversized asset');
});

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});
