// Plain-shell adapter — no agent, no hooks. Used for scratch terminals and as the
// M1 default. State stays 'idle' unless the user is actively typing.

import { existsSync } from 'node:fs';
import type { AgentAdapter } from './types.js';

const DEFAULT_SHELL = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash';

export const shellAdapter: AgentAdapter = {
  id: 'shell',
  displayName: 'Shell',
  buildEnv(ctx) {
    return {
      TERM: 'xterm-256color',
      TOWER_TERMINAL_ID: ctx.terminalId,
      TOWER_PROJECT_ID: ctx.projectId,
    };
  },
  buildCommand() {
    return [DEFAULT_SHELL, '-l'];
  },
  async writeHookConfig() {
    return [];
  },
  approveKeys() {
    return { approve: ['y'], deny: ['n'] };
  },
  parseState() {
    return null;
  },
};
