// Append-only audit log, written only by the Tower (never by agents), outside any
// agent-writable path (SPEC §14 S11). Records security-relevant actions:
// terminal spawns/kills, approvals, (future) broker token grants and pushes.

import { appendFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { paths } from './paths.js';

// Read at most this many bytes from the END of the audit log per auditTail call, regardless of the
// file's total size. The log is append-only and grows unbounded between rotations; reading the WHOLE
// file synchronously on every GET /api/audit would stall the single event loop for the full read once
// it reaches tens of MB. A quarter-MB tail window holds far more than the ~120 lines any caller asks
// for (retention.rotateAudit caps the file itself).
const AUDIT_TAIL_BYTES = 256 * 1024;

export function audit(action: string, detail: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), action, ...detail });
  try {
    // mode 0o600 applies when the file is first created (and recreated after a rotation), so the audit
    // trail — which can name terminals, accounts, and error strings — is never world-readable. A
    // pre-existing looser file is re-tightened by retention.rotateAudit, off this hot path.
    appendFileSync(paths.audit, line + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('[audit] write failed:', err);
  }
}

/** The last complete lines from the tail of `file` (at most `maxBytes` read from the end, never the
 *  whole file). Returns [] if the file is absent. A truncated leading fragment (present only when the
 *  window started mid-file) is dropped so a half-record is never surfaced. */
function tailLines(file: string, maxBytes: number): string[] {
  if (!existsSync(file)) return [];
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const readLen = Math.min(size, maxBytes);
    if (readLen === 0) return [];
    const start = size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    let got = 0;
    while (got < readLen) {
      const r = readSync(fd, buf, got, readLen - got, start + got);
      if (r <= 0) break; // short read / EOF — use what we have
      got += r;
    }
    let text = buf.subarray(0, got).toString('utf8');
    // Started mid-file → the first line is almost certainly a partial record; drop it so a half line
    // is never parsed or handed back.
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Read the last N audit entries (newest first) for the audit panel. Reads only the TAIL of the file
 *  (at most AUDIT_TAIL_BYTES), never the whole thing, so a large audit log cannot stall the event loop.
 *  Right after a rotation the current file is empty/short, so top up from the previous generation
 *  (audit.log.1) — otherwise the panel would appear to wipe recent history at every rotation boundary. */
export function auditTail(n = 100): Record<string, unknown>[] {
  let lines = tailLines(paths.audit, AUDIT_TAIL_BYTES);
  if (lines.length < n) {
    // `.1` holds the entries just rotated out; prepend them (older) so the newest-N are complete.
    lines = [...tailLines(`${paths.audit}.1`, AUDIT_TAIL_BYTES), ...lines];
  }
  return lines
    .slice(-n)
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
}
