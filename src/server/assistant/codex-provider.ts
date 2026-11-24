// CodexProvider — the v1 assistant brain (SPEC-ASSISTANT §0.5). Per turn it spawns
//   codex exec --json --sandbox read-only --skip-git-repo-check -C <cwd>
// inside the assistant account's CODEX_HOME (subscription login lives in its auth.json)
// and maps the JSONL stdout to AssistantEvents via mapCodexEvent.
//
// Invocation facts (verified against `codex exec --help` and codex-rs/exec):
//  - No positional prompt + piped stdin => codex reads the prompt from stdin (no `-`
//    sentinel needed; it prints "Reading prompt from stdin..." to STDERR, not stdout).
//  - --json emits JSONL ThreadEvents on stdout; human/progress output goes to stderr.
//  - Assistant text arrives whole on item.completed — hence capabilities().streaming=false.
//  - CODEX_API_KEY/CODEX_ACCESS_TOKEN are blanked so codex can't fall back to API-key
//    auth; the model is pinned via config (config.toml + a `-c model=` override), never env.

import { spawn } from 'node:child_process';
import type { AssistantEvent } from '../../shared/types.js';
import type { AssistantProvider, TurnRequest } from './contracts.js';
import { classifyCodexError, mapCodexEvent } from './codex-events.js';
import { sandboxToolAvailable } from '../isolation.js';

/**
 * Whether codex can actually enforce its OS sandbox on this host (SPEC-ASSISTANT §0.5.4a).
 * The read-only guarantee is only real if the sandbox engages; on Linux that needs bubblewrap.
 * If it's missing, codex under `approval_policy = never` may run an UNSANDBOXED shell (with
 * network) — the full lethal trifecta once it ingests untrusted logs/diffs — so we refuse the
 * turn rather than silently drop the boundary. An operator who accepts the risk can override
 * (per-account setting or CT_ASSISTANT_ALLOW_NO_SANDBOX=1).
 */
function sandboxAvailable(allowOverride: boolean): boolean {
  if (allowOverride || process.env.CT_ASSISTANT_ALLOW_NO_SANDBOX === '1') return true;
  return sandboxToolAvailable();
}

export interface CodexProviderOptions {
  /** The assistant account's CODEX_HOME (isolated config dir holding the ChatGPT login). */
  configDir: string;
  /** Working root codex is pointed at (-C); read-only sandbox, so this is what it can see. */
  cwd: string;
  /** Pinned model slug; when set it also overrides config.toml via `-c model=...`. */
  model?: string;
  /** Static instructions prepended to every turn (role, tool guidance, grounding rules). */
  systemPreamble: string;
  /** Operator override: run even when the OS sandbox can't be verified (accepts real risk). */
  allowNoSandbox?: boolean;
  /** Per-turn deadline in ms before the child is killed; falls back to env / 5min default. */
  turnTimeoutMs?: number;
}

/** Keep only the last N bytes of stderr for error context — logs can be arbitrarily long. */
const STDERR_TAIL_BYTES = 4096;

export class CodexProvider implements AssistantProvider {
  readonly id = 'codex-cli';

  constructor(private readonly opts: CodexProviderOptions) {}

  capabilities(): { tools: boolean; streaming: boolean } {
    // tools: MCP tower-control calls fire (outside the OS sandbox — §0.5.3).
    // streaming: false — `exec --json` has no token deltas; text lands whole per item.
    return { tools: true, streaming: false };
  }

  /**
   * One turn. `codex exec` is stateless across invocations, so the whole conversation is
   * replayed in the prompt each turn (per-turn recipe of §0.5.2; app-server is the M-A5
   * upgrade path for real session state + token streaming).
   */
  async *streamTurn(req: TurnRequest): AsyncIterable<AssistantEvent> {
    // Safety gate: never run codex here if its OS sandbox can't be enforced (see helper).
    if (!sandboxAvailable(this.opts.allowNoSandbox === true)) {
      yield {
        t: 'error',
        kind: 'sandbox',
        error:
          'The OS sandbox (bubblewrap) is unavailable, so the assistant cannot run safely read-only. ' +
          'Install it (e.g. `sudo apt install bubblewrap`), or set CT_ASSISTANT_ALLOW_NO_SANDBOX=1 to override.',
      };
      return;
    }
    const prompt = this.buildPrompt(req);

    const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', this.opts.cwd];
    if (this.opts.model) {
      // Config override (`-c` value is parsed as TOML, hence the inner quotes). Redundant
      // with the Tower-written config.toml when both come from the same AssistantAccount,
      // but makes the pin hold even against a stale/hand-edited config file.
      args.push('-c', `model=${JSON.stringify(this.opts.model)}`);
    }

    const child = spawn('codex', args, {
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        CODEX_HOME: this.opts.configDir,
        // Blank (not just unset — the parent env may carry them) so codex uses the
        // subscription login in $CODEX_HOME/auth.json, never an ambient API key.
        CODEX_API_KEY: '',
        CODEX_ACCESS_TOKEN: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // ---- event-emitter -> async-generator bridge ----------------------------------
    // Handlers push mapped events into a queue and wake the generator loop; the loop
    // drains the queue and parks on a promise when it's empty.
    const queue: AssistantEvent[] = [];
    let streamEnded = false; // no more events will be pushed
    let sawTerminal = false; // a done/error event went through the queue
    let wake: (() => void) | undefined;

    const signal = (): void => {
      const w = wake;
      wake = undefined;
      w?.();
    };
    const push = (ev: AssistantEvent): void => {
      if (streamEnded) return;
      if (ev.t === 'done' || ev.t === 'error') sawTerminal = true;
      queue.push(ev);
      signal();
    };
    const end = (): void => {
      streamEnded = true;
      signal();
    };

    // ---- stdout: line-buffered JSONL ----------------------------------------------
    let stdoutBuf = '';
    const consumeLine = (line: string): void => {
      const trimmed = line.trim(); // tolerate \r\n and blank keep-alive lines
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // non-JSON noise on stdout — ignore, never crash the turn
      }
      const mapped = mapCodexEvent(parsed);
      if (mapped) push(mapped);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        consumeLine(line);
      }
    });

    // ---- stderr: progress/log noise; keep a tail for error context ----------------
    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    // ---- lifecycle -----------------------------------------------------------------
    let spawnFailed = false;
    child.on('error', (err: Error) => {
      // e.g. ENOENT — codex not installed / not on PATH.
      spawnFailed = true;
      push({ t: 'error', error: `failed to spawn codex: ${err.message}`, kind: 'other' });
      end();
    });

    const onAbort = (): void => {
      // The client is gone — end the stream NOW rather than waiting for 'close': a
      // grandchild of codex holding the stdout pipe open would otherwise delay it.
      child.kill('SIGTERM');
      end();
    };
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', (code) => {
      if (spawnFailed || streamEnded) return; // spawn 'error' or abort already ended it
      if (stdoutBuf) consumeLine(stdoutBuf); // flush a final line with no trailing \n
      if (!sawTerminal) {
        // The stream ended without turn.completed/turn.failed — synthesize the terminal
        // event so the dock never hangs. stderr tail is the best error context we have.
        if (code !== 0) {
          const detail = stderrTail.trim();
          push({
            t: 'error',
            error: detail || `codex exited with code ${code}`,
            kind: classifyCodexError(detail),
          });
        } else {
          push({ t: 'done', stopReason: 'end' });
        }
      }
      end();
    });

    // Feed the prompt on stdin (see header: codex reads it when no positional is given).
    // Swallow stdin errors — EPIPE if the child died before/while we write.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    // Per-turn watchdog: a codex that neither exits ('close') nor emits a terminal event,
    // with a client that stays connected (no abort), would park the generator forever and
    // leak the child. Kill + fail the turn past a deadline.
    const timeoutMs =
      (this.opts.turnTimeoutMs && this.opts.turnTimeoutMs > 0 ? this.opts.turnTimeoutMs : Number(process.env.CT_ASSISTANT_TURN_TIMEOUT_MS)) ||
      5 * 60_000;
    const watchdog = setTimeout(() => {
      if (streamEnded) return;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      push({ t: 'error', error: `assistant turn timed out after ${Math.round(timeoutMs / 1000)}s`, kind: 'other' });
      end();
    }, timeoutMs);
    watchdog.unref?.();

    // ---- drain ----------------------------------------------------------------------
    try {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (streamEnded) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      // Consumer went away (client disconnect / early return) or we finished: make sure
      // the child never outlives the turn.
      clearTimeout(watchdog);
      req.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    }
  }

  /** Stateless-CLI conversation encoding: preamble, replayed history, current message.
   *  `system` turns are Tower-authored notes (e.g. a confirmed proposal's outcome) rendered
   *  as 'System:' so the brain treats them as ground truth about what actually happened. */
  private buildPrompt(req: TurnRequest): string {
    const roleLabel = (role: 'user' | 'assistant' | 'system'): string =>
      role === 'user' ? 'User' : role === 'system' ? 'System' : 'Assistant';
    const history = req.history.map((turn) => `${roleLabel(turn.role)}: ${turn.text}`).join('\n');
    return `${this.opts.systemPreamble}\n\n--- Conversation so far ---\n${history}\n\n--- Current message ---\n${req.prompt}`;
  }
}
