// Shared by the dock (live stream) and the message route (persisted transcript). `codex exec
// --json` delivers each agent_message/reasoning item WHOLE — no token deltas, several items per
// turn (codex-events.ts). Each agent_message is now its OWN bubble/turn (never folded), so this
// seam is used SOLELY to fold the reasoning items that precede one message into that bubble's
// single thinking block — several {t:'thinking'} deltas (plus the transient stream-error →
// thinking path) butted together would otherwise read as one run-on ("…settled.You're right…").
// The dock (patchLastAssistant thinking branch) and the route (pending.thinking) MUST fold with
// the SAME seam so the live thinking block and the reloaded one read identically.

/**
 * Fold the next whole segment onto the accumulated text with exactly one blank line at the
 * seam. Whitespace-only edges are trimmed first so a segment that ends (or starts) with its
 * own newlines can't widen the gap beyond one \n\n.
 */
export function appendSegment(prev: string, next: string): string {
  if (!prev) return next;
  const a = prev.replace(/\s+$/, '');
  const b = next.replace(/^\s+/, '');
  if (!a) return next; // prev was pure whitespace — treat it as empty
  if (!b) return prev; // nothing real arrived — never leave a dangling seam
  return `${a}\n\n${b}`;
}
