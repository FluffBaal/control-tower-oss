// SPEC-SKILLS Phase 5b wave 2 — the gate-sabotage lint. A promoted draft cannot CARRY a gate (the
// draft whitelist), so the sabotage that remains is a BODY that instructs future agents to skip,
// bypass, or hide a gate ("commit without review", "don't tell the operator", …). This module scans
// prose for those shapes and returns FLAGS — amber advisory rows on the operator's review surfaces
// (the promote card's diff, the Skills panel). A flag NEVER blocks anything: the operator's read of
// the diff is the boundary; this is a highlighter over it.
//
// The flags are OPERATOR-facing only — never returned to the model. Not in the draft-save response,
// not in the enrich summary, not in any payload that replays into the brain's transcript: a regex
// lint over adversarial text is evadable regardless (it is explicitly NOT load-bearing), and feeding
// the verdict back would coach an adversarial drafter to rephrase until clean. Withholding the
// oracle just keeps it useful longer. The server's only sighting is pattern-CLASS names on the
// promote audit line (post-hoc forensics); the web recomputes the flags client-side from the same
// live content it already renders.
//
// Pure module, zero node imports — safe in the web bundle and on the server alike. Contrast with
// server/skills/lint.ts (the secret scan): secrets REJECT at the draft-save door; sabotage FLAGS at
// review time. Different failure classes, deliberately different postures.

export interface SabotageFlag {
  cls: string;
  label: string;
}

// Each class is window-bounded ([^.\n]{0,N} — never across a sentence or line) to limit false
// positives, and unit-tested with one positive plus a rephrased-innocent twin per class (the guard
// must key on the pattern, not the fixture). Labels are short human sentences for the warn row;
// server surfaces log class names ONLY, never the matched text.
interface SabotagePattern {
  cls: string;
  label: string;
  hit(text: string): boolean;
}

const reHit = (re: RegExp) => (text: string): boolean => re.test(text);

// exfil-fetch fires only for a NON-loopback host: telling an agent to curl the Tower's own API is
// ordinary skill business; pushing content at an external host from inside an agent is not.
const EXFIL_RE = /\b(?:curl|wget|fetch)\b[^.\n]{0,60}https?:\/\/([^\s/"'`<>]+)/gi;
function hasExfilFetch(text: string): boolean {
  EXFIL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXFIL_RE.exec(text)) !== null) {
    const host = (m[1] ?? '').toLowerCase().replace(/:\d+$/, '');
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '::1' && host !== '[::1]') {
      return true;
    }
  }
  return false;
}

const SABOTAGE_PATTERNS: SabotagePattern[] = [
  {
    cls: 'gate-skip',
    label: 'instructs agents to skip or bypass a review gate',
    hit: reHit(/(?:skip|bypass|ignore|disable|omit|without)[^.\n]{0,40}(?:code[- ]?review|review|the gate|verification|approval|permission)/i),
  },
  {
    cls: 'unreviewed-land',
    label: 'instructs agents to commit, push, or deploy without review or approval',
    hit: reHit(/(?:commit|push|merge|land|deploy)[^.\n]{0,40}without[^.\n]{0,40}(?:review|approval|confirm|asking)/i),
  },
  {
    cls: 'suppress-findings',
    label: 'instructs agents to withhold findings or failures from the operator',
    hit: reHit(/(?:don'?t|do not|never|avoid|skip)[^.\n]{0,40}(?:surface|report|mention|tell|disclose|show)[^.\n]{0,40}(?:finding|error|failure|operator|user|human)/i),
  },
  {
    cls: 'config-write',
    label: 'instructs agents to write into Tower or agent configuration files',
    hit: reHit(/(?:write|edit|append|modify|update|overwrite|add|create|touch)[^.\n]{0,60}(?:~\/\.ct\b|CLAUDE\.md|AGENTS\.md|GEMINI\.md|settings\.json|\.claude\/|skills\.json)/i),
  },
  {
    cls: 'danger-flag',
    label: 'invokes permission-bypassing or verification-skipping command flags',
    hit: reHit(/--dangerously\S*|--no-verify\b|push[^.\n]{0,30}--force|--force[^.\n]{0,30}push/i),
  },
  {
    cls: 'exfil-fetch',
    label: 'instructs agents to fetch from or send data to an external host',
    hit: hasExfilFetch,
  },
];

/** Scan prose for gate-sabotage shapes. Returns deduped flags in table order; empty = clean.
 *  Advisory ALWAYS — no caller may block, gate, or refuse on the result. */
export function lintGateSabotage(text: string): SabotageFlag[] {
  const out: SabotageFlag[] = [];
  for (const p of SABOTAGE_PATTERNS) {
    if (p.hit(text)) out.push({ cls: p.cls, label: p.label });
  }
  return out;
}

/** The ONE definition of a skill's (or draft's) scanned prose concatenation: every whitelisted
 *  prose field plus the body, newline-joined so each field is scanned in its own line context.
 *  server/skills/lint.ts's skillDraftScanText delegates here — the secret REJECT scan and this
 *  advisory FLAG scan must always cover the same bytes, with no drift-by-copy. */
export function skillProseScanText(d: {
  name: string;
  description: string;
  trigger?: string;
  body: string;
  tags?: string[];
}): string {
  return [d.name, d.description, d.trigger ?? '', d.body, ...(d.tags ?? [])].join('\n');
}
