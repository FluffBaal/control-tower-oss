// SPEC-CLI-UPDATE — self-update the built-in provider CLIs (claude-code, codex, gemini-cli) from the
// Tower. Each provider maps to a FIXED { versionArgs, updateArgs } pair; the caller only ever passes a
// provider id that SELECTS an entry — no caller-supplied text reaches the process args, so there is no
// shell/argv injection. execFile (no shell) + a bounded timeout; a per-provider in-flight latch so two
// updates of the same CLI can't overlap. Output is tail-clipped for display (an updater prints progress,
// never secrets). Updating does NOT disturb a running pane — it holds its old binary until it respawns;
// only future spawns (and a restart_terminal) pick up the new version.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface CliSpec {
  /** The executable name, resolved on the Tower process PATH (which includes ~/.local/bin here). */
  bin: string;
  versionArgs: readonly string[];
  /** The CLI's OWN self-update subcommand — claude/codex ship one; gemini via its own. */
  updateArgs: readonly string[];
}

// Only built-ins with a known self-updater. A provider not in this map is simply not updatable here.
// NULL-PROTOTYPE so a lookup like CLIS['__proto__'] is undefined (not Object.prototype) — belt-and-
// suspenders on top of the route/zod validation that already gates the id before it reaches here.
const CLIS: Record<string, CliSpec> = Object.assign(Object.create(null) as Record<string, CliSpec>, {
  'claude-code': { bin: 'claude', versionArgs: ['--version'], updateArgs: ['update'] },
  codex: { bin: 'codex', versionArgs: ['--version'], updateArgs: ['update'] },
  'gemini-cli': { bin: 'gemini', versionArgs: ['--version'], updateArgs: ['update'] },
});

const VERSION_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 180_000; // a download+install can take a while; still bounded
const OUTPUT_TAIL = 1500;

export function updatableProviders(): string[] {
  return Object.keys(CLIS);
}

/** Parse a semver-ish version out of a `--version` line (e.g. "2.1.277 (Claude Code)", "codex-cli 0.147.0"). */
export function parseVersion(out: string): string | undefined {
  return out.match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*/)?.[0];
}

function tail(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_TAIL ? `…${t.slice(-OUTPUT_TAIL)}` : t;
}

export interface CliVersion {
  provider: string;
  bin: string;
  present: boolean;
  version?: string;
}

/** Detect the installed version of one provider CLI (bounded, no-throw — a missing CLI reports present:false). */
export async function detectVersion(provider: string): Promise<CliVersion> {
  const spec = CLIS[provider];
  if (!spec) return { provider, bin: provider, present: false };
  try {
    const { stdout, stderr } = await execFileAsync(spec.bin, [...spec.versionArgs], { timeout: VERSION_TIMEOUT_MS });
    const v = parseVersion(`${stdout}\n${stderr}`);
    return { provider, bin: spec.bin, present: true, ...(v ? { version: v } : {}) };
  } catch {
    return { provider, bin: spec.bin, present: false };
  }
}

export function detectAllVersions(): Promise<CliVersion[]> {
  return Promise.all(updatableProviders().map(detectVersion));
}

const inFlight = new Set<string>();

export interface CliUpdateResult {
  provider: string;
  ok: boolean;
  before?: string;
  after?: string;
  changed: boolean;
  outputTail: string;
  error?: string;
}

/** Run a provider CLI's own self-updater. Bounded + latched. Never throws — a failure returns ok:false
 *  with the error + output tail. Re-detects the version before/after so the caller can show what changed. */
export async function updateProvider(provider: string): Promise<CliUpdateResult> {
  const spec = CLIS[provider];
  if (!spec) return { provider, ok: false, changed: false, outputTail: '', error: `no updater for provider "${provider}"` };
  if (inFlight.has(provider)) return { provider, ok: false, changed: false, outputTail: '', error: 'an update is already running for this CLI' };
  inFlight.add(provider);
  try {
    const before = (await detectVersion(provider)).version;
    let ok = true;
    let error: string | undefined;
    let out = '';
    try {
      const r = await execFileAsync(spec.bin, [...spec.updateArgs], { timeout: UPDATE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      out = `${r.stdout}\n${r.stderr}`;
    } catch (e) {
      ok = false;
      const err = e as Error & { stdout?: string; stderr?: string };
      out = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message}`;
      error = err.message;
    }
    const after = (await detectVersion(provider)).version;
    return { provider, ok, ...(before ? { before } : {}), ...(after ? { after } : {}), changed: !!before && !!after && before !== after, outputTail: tail(out), ...(error ? { error } : {}) };
  } finally {
    inFlight.delete(provider);
  }
}
