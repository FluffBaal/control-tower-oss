// SPEC-SKILLS Phase 5b — the assistant draft pad's secret scan. A skill draft is chat-authored text
// that, once promoted AND enabled, is injected into every future agent — so secret-shaped content is
// REJECTED at the draft-save door (nothing persists at all) and re-checked as a belt on the promote
// route. Deliberately NOT applied to operator-authored writes (POST/PUT /api/skills): the operator's
// own text is the operator's business; this scan guards the assistant channel, where a poisoned
// log/diff/memory could steer the brain into pasting a live credential somewhere durable.
//
// The scanner returns pattern-CLASS names ONLY — never the matched text. The class list flows into a
// 400 error body, the audit log, and the model's transcript, and none of those may ever carry the
// secret itself. False positives are self-correctable: the 400 tells the model to use placeholders.

import { skillProseScanText } from '../../shared/skill-lint.js';

interface SecretPattern {
  cls: string;
  re: RegExp;
}

// Each class is unit-tested individually (skills-governance.test.ts): one positive per class, and the
// same text with the secret replaced by a placeholder must pass — the guard keys on the PATTERN, not
// on the fixture. Bearer deliberately uses [ \t]+ (not \s+) so a field-joining newline in the scanned
// concatenation can never splice a false positive across two innocent fields.
const SECRET_PATTERNS: SecretPattern[] = [
  { cls: 'private-key-block', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { cls: 'github-token', re: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { cls: 'api-secret-key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { cls: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { cls: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { cls: 'bearer-token', re: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/ },
  { cls: 'credential-assignment', re: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{12,}/i },
  // AWS secret access keys are 40 base64-ish chars with no distinctive prefix — anchor on the
  // conventional variable name so ordinary base64 prose stays clean.
  { cls: 'aws-secret-access-key', re: /aws[_-]?secret[_-]?(?:access[_-]?)?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40,}/i },
  { cls: 'stripe-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/ },
  { cls: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  // An embedded binary/credential blob has no business in a skill body: a contiguous base64-charset
  // run STRICTLY over 4 KB (4096 chars pass; 4097 reject — the boundary is tested).
  { cls: 'base64-blob', re: /[A-Za-z0-9+/=]{4097,}/ },
];

/** Scan text for secret-shaped content. Returns the matched pattern-CLASS names (deduped, in table
 *  order), NEVER the matched text. Empty array = clean. */
export function scanSecrets(text: string): string[] {
  const found: string[] = [];
  for (const { cls, re } of SECRET_PATTERNS) {
    if (re.test(text)) found.push(cls);
  }
  return found;
}

/** What a draft's scan covers: every whitelisted prose field plus the body, newline-joined (each
 *  field scanned in its own line context — see the Bearer note above). Used by the save route
 *  (reject at the door) and the promote route (defense-in-depth belt: a save-path bug or a
 *  hand-edited skill-drafts.json must not publish). The concatenation itself is defined ONCE in
 *  shared/skill-lint.ts (skillProseScanText) so this secret REJECT scan and the operator-facing
 *  gate-sabotage FLAG lint always cover the same bytes. */
export function skillDraftScanText(d: {
  name: string;
  description: string;
  trigger?: string;
  body: string;
  tags?: string[];
}): string {
  return skillProseScanText(d);
}
