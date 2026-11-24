// One-time importer for the operator's machine skills (SPEC-SKILLS). A pure, synchronous fs walk — no
// LLM, no network. It reads the operator's real ~/.claude/skills READ-ONLY and copies every skill into
// the Tower's own store (bodies VERBATIM, byte-exact); it NEVER writes to ~/.claude. The route calls it
// with the fixed default dir, so there is zero caller-supplied path (no traversal surface); tests call
// this function directly with a fixture dir.
//
// Idempotence: it NEVER overwrites an existing id (importMany skips it). Re-running imports only skills
// the Tower does not already have — refreshing a drifted machine skill means deleting it in the Tower and
// re-importing. A skill that cannot be parsed becomes an `errors` entry; it is never imported mangled.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isSafeName } from '../ids.js';
import type {
  SkillImportReport, SkillGate, SkillRequires, SkillModelInvocation, ProviderId,
} from '../../shared/types.js';
import { SkillStore, isSafeAssetPath, MAX_ASSET_BYTES, MAX_ASSETS_TOTAL_BYTES, type UpsertSkillInput } from './store.js';

// The hand-curated capability/gate/routing table for the multi-agent-family skills. The importer cannot
// infer capabilities from prose, so these five are seeded explicitly; everything else imports with no
// supportedProviders (= any provider satisfying `requires`) and no gate (advisory default).
interface Curation {
  supportedProviders?: ProviderId[];
  requires?: SkillRequires;
  invocationModel?: SkillModelInvocation;
  gate?: SkillGate;
}
const CURATED: Record<string, Curation> = {
  'swarm-review': {
    supportedProviders: ['claude-code'],
    requires: { capabilities: ['subagents', 'workflow-tool', 'worktree-isolation'], models: ['opus'] },
    gate: { mode: 'advisory', rerunOnNewDiff: true },
  },
  'fluff-review': {
    supportedProviders: ['claude-code'],
    requires: { capabilities: ['subagents', 'worktree-isolation', 'workflow-tool'] },
    invocationModel: 'never', // honored-by-exact-name only
    gate: { mode: 'advisory', rerunOnNewDiff: true },
  },
  'fable-mode': {
    supportedProviders: ['claude-code'],
    requires: { capabilities: ['subagents'] },
    invocationModel: 'suggest', // its own never-auto-run contract
  },
  'code-review': {
    supportedProviders: ['claude-code'],
    requires: { capabilities: ['subagents'] },
    gate: { mode: 'blocking', blocks: ['commit', 'push'], enforcedBy: ['policy-text'], rerunOnNewDiff: true },
  },
  magenta: {
    supportedProviders: ['claude-code'],
    requires: { capabilities: ['subagents'] },
  },
};

// ---- Minimal, tolerant frontmatter parser (no new dependency) — covers the observed corpus variance:
//      plain scalars, booleans, quoted strings, folded (`>`,`>-`) and literal (`|`,`|-`) block scalars,
//      and ONE level of nesting (metadata.tags). Unknown keys are kept as-is; an unparsable line is a
//      dropped warning. ----

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}
function coerce(v: string): string | boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return unquote(v);
}

/** Split SKILL.md into its frontmatter text and the byte-exact body (everything AFTER the closing `---`
 *  line, including any leading blank line). Throws if the delimiters are absent. */
function splitFrontmatter(raw: string): { fmText: string; body: string } {
  const lines = raw.split('\n');
  if ((lines[0] ?? '').trim() !== '---') throw new Error('missing opening frontmatter delimiter');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) throw new Error('missing closing frontmatter delimiter');
  const fmText = lines.slice(1, close).join('\n');
  // Characters consumed through the closing delimiter line + its trailing newline (if any content follows).
  let consumed = 0;
  for (let i = 0; i <= close; i++) {
    consumed += (lines[i] ?? '').length;
    if (i < close) consumed += 1; // the '\n' between line i and i+1
  }
  if (close < lines.length - 1) consumed += 1; // the '\n' after the closing '---'
  return { fmText, body: raw.slice(consumed) };
}

function parseFrontmatter(fmText: string, id: string, warnings: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = fmText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (/^\s/.test(line)) {
      // An indented line with no owning parent — skip (a parent block consumes its own children).
      i++;
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line);
    if (!m) {
      warnings.push(`${id}: dropped an unparsable frontmatter line`);
      i++;
      continue;
    }
    const key = m[1]!;
    const restTrim = (m[2] ?? '').trim();

    if (restTrim === '>' || restTrim === '>-' || restTrim === '>+' || restTrim === '|' || restTrim === '|-' || restTrim === '|+') {
      const folded = restTrim.startsWith('>');
      const block: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j] ?? '';
        if (bl.trim() !== '' && !/^\s/.test(bl)) break; // a new top-level key ends the block
        block.push(bl);
        j++;
      }
      while (block.length && (block[block.length - 1] ?? '').trim() === '') block.pop();
      const first = block.find((l) => l.trim() !== '');
      const indent = first ? (/^(\s*)/.exec(first)?.[1] ?? '').length : 0;
      const stripped = block.map((l) => l.slice(indent));
      out[key] = folded
        ? stripped.map((l) => l.trim()).filter((l) => l !== '').join(' ')
        : stripped.join('\n');
      i = j;
      continue;
    }

    if (restTrim === '') {
      // A nested map (e.g. metadata:) — consume its indented `key: value` children (one level).
      const child: Record<string, string | boolean> = {};
      let j = i + 1;
      let had = false;
      while (j < lines.length) {
        const cl = lines[j] ?? '';
        if (cl.trim() === '') {
          j++;
          continue;
        }
        if (!/^\s/.test(cl)) break;
        const cm = /^\s+([A-Za-z0-9_.-]+):(.*)$/.exec(cl);
        if (cm) {
          child[cm[1]!] = coerce((cm[2] ?? '').trim());
          had = true;
        }
        j++;
      }
      if (had) {
        out[key] = child;
        i = j;
        continue;
      }
      out[key] = '';
      i++;
      continue;
    }

    out[key] = coerce(restTrim);
    i++;
  }
  return out;
}

// The frontmatter keys the importer maps. Anything else is kept out of the record and surfaced as a
// warning — a new field a future SKILL.md adds is dropped honestly rather than silently.
const KNOWN_FM_KEYS = new Set([
  'name', 'description', 'user_invocable', 'disable-model-invocation', 'allowed-tools', 'argument-hint', 'metadata',
]);

/** Split a comma-separated frontmatter string into trimmed, non-empty entries (allowed-tools, tags). */
function csv(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Recursively collect every file under a skill dir except SKILL.md, as byte-exact Buffers with a posix
 *  relPath and the original mode & 0o777 (captures the exec bit on scripts). Each file's size is checked
 *  against the store's ceilings via statSync BEFORE it is read, so a stray huge file is skipped with a
 *  warning rather than read into memory (and blocking the event loop) only to be rejected. */
function collectAssets(root: string, id: string, warnings: string[]): { relPath: string; content: Buffer; mode: number }[] {
  const out: { relPath: string; content: Buffer; mode: number }[] = [];
  let total = 0;
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!ent.isFile()) continue; // skip symlinks/sockets/etc.
      const rel = relative(root, abs).split(sep).join('/');
      if (rel === 'SKILL.md') continue;
      if (!isSafeAssetPath(rel)) continue; // an odd name the store would reject anyway
      const st = statSync(abs);
      if (st.size > MAX_ASSET_BYTES) {
        warnings.push(`${id}: skipped oversized asset '${rel}' (${st.size} bytes)`);
        continue;
      }
      if (total + st.size > MAX_ASSETS_TOTAL_BYTES) {
        warnings.push(`${id}: skipped asset '${rel}' — total asset budget exceeded`);
        continue;
      }
      out.push({ relPath: rel, content: readFileSync(abs), mode: st.mode & 0o777 });
      total += st.size;
    }
  };
  walk(root);
  return out;
}

/**
 * Walk `dir` for skill sub-directories and import each into `store`. The store's importMany is the
 * idempotence gate (skip-existing, one persist + one frame per run). Returns a report the panel renders.
 */
export function importSkillsFromDir(dir: string, store: SkillStore): SkillImportReport {
  const warnings: string[] = [];
  const errors: { id: string; reason: string }[] = [];
  const inputs: UpsertSkillInput[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (e) {
    return { imported: [], skipped: [], errors: [{ id: '?', reason: `cannot read skills dir: ${(e as Error).message}` }], warnings };
  }

  for (const dirName of entries) {
    const full = join(dir, dirName);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const id = dirName;
    if (!isSafeName(id)) {
      errors.push({ id, reason: 'directory name is not a safe skill id' });
      continue;
    }
    const skillMd = join(full, 'SKILL.md');
    if (!existsSync(skillMd)) {
      errors.push({ id, reason: 'no SKILL.md' });
      continue;
    }

    try {
      const raw = readFileSync(skillMd, 'utf8');
      const { fmText, body } = splitFrontmatter(raw);
      const fm = parseFrontmatter(fmText, id, warnings);
      for (const k of Object.keys(fm)) {
        if (!KNOWN_FM_KEYS.has(k)) warnings.push(`${id}: dropped unrecognized frontmatter key '${k}'`);
      }

      const description = typeof fm.description === 'string' ? fm.description : '';
      if (!description) {
        errors.push({ id, reason: 'missing description' });
        continue;
      }
      const name = typeof fm.name === 'string' && fm.name ? fm.name : id;
      const userInvocable = fm.user_invocable === false ? false : true;
      const modelDisabled = fm['disable-model-invocation'] === true;
      const argumentHint = typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] : undefined;
      const allowedTools = csv(fm['allowed-tools']);
      const meta = fm.metadata;
      const tags = meta && typeof meta === 'object' ? csv((meta as Record<string, unknown>).tags) : [];

      const assets = collectAssets(full, id, warnings);
      const cur = CURATED[id];

      // A body that hardcodes a ~/.claude/skills path is a known materialization work item — record it,
      // but import the body VERBATIM (the byte-fidelity guarantee is the hard rule; the reserved
      // {{skillDir}} token is substituted when a later materializer runs).
      if (body.includes('.claude/skills')) {
        warnings.push(`${id}: body hardcodes a ~/.claude/skills path; {{skillDir}} substitution deferred to materialization`);
      }

      inputs.push({
        id,
        name,
        description,
        body,
        scope: 'global',
        enabled: true,
        origin: 'imported',
        invocation: {
          user: userInvocable,
          model: cur?.invocationModel ?? (modelDisabled ? 'never' : 'auto'),
          ...(argumentHint ? { argumentHint } : {}),
        },
        ...(allowedTools.length ? { toolHints: { allowedTools } } : {}),
        ...(tags.length ? { tags } : {}),
        ...(cur?.supportedProviders ? { supportedProviders: cur.supportedProviders } : {}),
        ...(cur?.requires ? { requires: cur.requires } : {}),
        ...(cur?.gate ? { gate: cur.gate } : {}),
        assets,
      });
    } catch (e) {
      errors.push({ id, reason: (e as Error).message });
    }
  }

  const { imported, skipped, errors: storeErrors } = store.importMany(inputs);
  return { imported, skipped, errors: [...errors, ...storeErrors], warnings };
}
