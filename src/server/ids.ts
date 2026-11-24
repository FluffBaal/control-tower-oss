// ID and token generation. Terminal/project IDs are short and URL/tmux-safe;
// tokens are cryptographically random. Per-terminal tokens (used by the future
// hook pipeline and the WS attach handshake) are minted here and stored 0600.

import { randomBytes, randomUUID } from 'node:crypto';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short opaque id, e.g. "k7f3p9". Safe for tmux socket names and URLs. */
export function shortId(len = 8): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    // bytes[i] is always defined for i < len.
    out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  }
  return out;
}

/** A high-entropy token for the control plane / per-terminal auth. */
export function token(): string {
  return randomBytes(32).toString('base64url');
}

export function uuid(): string {
  return randomUUID();
}

/**
 * Validate a caller-or-agent-supplied name before it can flow into a tmux
 * session name, a branch, a path segment, or a shell argv. Rejects option
 * injection (leading '-'), path traversal, and shell metacharacters.
 * (SPEC §14 input sanitization.)
 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function isSafeName(name: string): boolean {
  return NAME_RE.test(name);
}
