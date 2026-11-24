// Per-agent OS isolation status (SPEC D14/§14). Real isolation — a dedicated Unix
// user per agent plus an egress allowlist — requires privileged host setup that the
// Tower must NOT perform autonomously (creating users / firewall rules is destructive
// and needs sudo). So the operator runs scripts/setup-isolation.sh once; it writes a
// marker the Tower detects here. The marker means "the host CAN isolate"; whether a
// given project DOES is then a per-project intent, reconciled honestly below — a toggle
// that pretends 0600 files are a boundary against same-user agents would be a lie.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { paths } from './paths.js';
import type { SecurityStatus, ProjectSecurity, Project } from '../shared/types.js';

/**
 * Whether the OS sandbox tool the onboard assistant relies on (bubblewrap, on Linux) is
 * present. Used both by the assistant's per-turn safety gate and the isolation readouts in Settings
 * (host status under System, per-project modes under Projects).
 * A positive result is cached (a present binary doesn't vanish, and spawnSync blocks the
 * event loop); a negative re-checks every call — bubblewrap is routinely installed while
 * the Tower runs, and a stuck `false` would keep the assistant gated until a restart.
 */
let sandboxToolSeen = false;
export function sandboxToolAvailable(): boolean {
  if (process.platform !== 'linux') return true; // macOS uses seatbelt; not gated here
  if (sandboxToolSeen) return true;
  try {
    sandboxToolSeen = spawnSync('bwrap', ['--version'], { stdio: 'ignore' }).error === undefined;
  } catch {
    sandboxToolSeen = false;
  }
  return sandboxToolSeen;
}

const ISO_MARKER = join(paths.home, 'isolation-enabled');

export const SETUP_COMMAND = 'sudo scripts/setup-isolation.sh';

// Whether the Tower actually spawns agents under a separate Unix UID yet. This is FALSE
// until the run-as execution layer lands (terminal-manager spawning each isolated agent's
// tmux server as ct-agent-N, plus the resource-ownership work that needs a root-capable
// provisioning step — the current sudoers grant is runas-only and cannot chown to the
// agent user). Until then a project's per-agent-uid INTENT is recorded but not enforced,
// and effective isolation stays single-uid. Flipping this to true is gated on that work so
// the UI can never show a green "Isolated" badge for a boundary that isn't in force.
const ENFORCEMENT_IMPLEMENTED = false;

const RESIDUAL =
  'Agents share one Unix user: a prompt-injected agent can read on-disk repos and ' +
  'other identities’ broker tokens, and exfiltrate over the network. The credential ' +
  'broker limits what is worth stealing; enable per-agent isolation to close the rest.';

const RESIDUAL_GLOBAL =
  RESIDUAL + ' Run ' + SETUP_COMMAND + ' (once, with sudo) to provision the host.';

// The host IS provisioned, but the Tower does not yet spawn agents under separate UIDs
// (ENFORCEMENT_IMPLEMENTED === false), so the boundary is still not in force. Distinct from
// RESIDUAL_GLOBAL so the global overview is honest instead of implying a green "isolated" state the
// moment the marker appears — the same distinction projectSecurity() already draws per project.
const RESIDUAL_PROVISIONED =
  RESIDUAL + ' The host is provisioned, but per-agent isolation is NOT yet implemented ' +
  '(the Tower does not spawn agents under separate UIDs), so agents still share your Unix user.';

/** Whether the host has been provisioned so per-agent isolation CAN be turned on. */
export function hostIsolationAvailable(): boolean {
  return existsSync(ISO_MARKER);
}

/** A project's intent, defaulting to single-uid when unset. */
function intentOf(project: Project): 'per-agent-uid' | 'single-uid' {
  return project.isolation === 'per-agent-uid' ? 'per-agent-uid' : 'single-uid';
}

/** Honest, resolved isolation status for one project. */
export function projectSecurity(project: Project, brokerActive: boolean): ProjectSecurity {
  const available = hostIsolationAvailable();
  const intent = intentOf(project);
  // Effective isolation requires host provisioning AND the project opting in AND the Tower
  // actually spawning agents under a separate UID. Intent alone never grants a boundary the
  // host can't (or the Tower doesn't yet) enforce.
  const effective: 'per-agent-uid' | 'single-uid' =
    available && intent === 'per-agent-uid' && ENFORCEMENT_IMPLEMENTED ? 'per-agent-uid' : 'single-uid';
  const enforced = effective === 'per-agent-uid';
  // Distinguish "you asked for isolation but it isn't enforced yet" from a plain single-uid
  // project, so the UI can be honest rather than implying a boundary that doesn't exist.
  const residualRisk = enforced
    ? null
    : intent === 'per-agent-uid' && available && !ENFORCEMENT_IMPLEMENTED
      ? 'Per-agent isolation is requested for this project but NOT yet enforced — agents still ' +
        'share your Unix user. Enforcement (spawning each agent under its own UID) ships separately.'
      : RESIDUAL;
  return {
    projectId: project.id,
    intent,
    effective,
    enforced,
    available,
    egressControl: enforced,
    brokerActive,
    residualRisk,
    setupCommand: available ? undefined : SETUP_COMMAND,
  };
}

/** Tower-wide overview (used for the global banner / health). Isolated only if the host is
 *  provisioned AND at least one project actually opts in is too fuzzy for a summary — so this
 *  reports host capability: per-agent-uid once provisioned, single-uid (with the setup hint)
 *  until then. Per-project truth lives in projectSecurity(). */
export function securityStatus(brokerActive: boolean): SecurityStatus {
  const available = hostIsolationAvailable();
  return {
    // isolationMode stays a CAPABILITY signal (does the host CAN isolate) — unchanged.
    isolationMode: available ? 'per-agent-uid' : 'single-uid',
    // But egress control and residual risk report ENFORCEMENT truth, not capability: until the Tower
    // actually spawns agents under separate UIDs (ENFORCEMENT_IMPLEMENTED), egress is not controlled and
    // the shared-user residual risk still stands even on a provisioned host. Reporting egressControl:true
    // off the marker alone would be a lie about a boundary that isn't in force.
    egressControl: available && ENFORCEMENT_IMPLEMENTED,
    brokerActive,
    residualRisk: !available ? RESIDUAL_GLOBAL : ENFORCEMENT_IMPLEMENTED ? null : RESIDUAL_PROVISIONED,
  };
}
