# Control Tower

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white)
![xterm.js](https://img.shields.io/badge/xterm.js-6-2E2E2E?style=flat-square&logo=gnometerminal&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?style=flat-square&logo=pwa&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20WSL2-0078D6?style=flat-square&logo=linux&logoColor=white)
![Status](https://img.shields.io/badge/status-pre--1.0%20(v0.7)-orange?style=flat-square)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

A self-hosted web dashboard, run on Linux (developed and tested on WSL2) and installed
as a Chrome PWA, to operate a fleet of AI coding agents (Claude Code, Gemini CLI, Codex CLI, and other CLIs) from a
single browser — grouped by project, with live terminals, a triage-grade attention
queue, diff-review and merge, git-worktree isolation, autonomous build loops, a central
skills library, usage-aware account rotation, and per-agent accounts and GitHub
identities served by a credential broker.

## What it does

- **Run the fleet.** tmux-backed terminals streamed to the browser (node-pty + xterm.js),
  grouped by project. A triage-grade **attention queue** surfaces an agent's questions and
  permission requests so you answer or approve inline, without opening the terminal; OS
  notifications summon you when the window is backgrounded. A **⌘K** command palette and
  cross-terminal log search tie it together.

- **Isolate and ship.** On-demand **git worktrees** per task (unique branch, dirty state
  first-class, never force-removed), and **Review & Land** — per-file diff, request-changes,
  then a guarded local merge or a PR opened under the terminal's GitHub identity, with safe
  branch cleanup.

- **Autonomous build loops.** Drive a coding agent through plan → build → test → review →
  land on its own, with a **board/backlog**, a planner, an attention gate when it needs a
  human, and per-run **mission reports**. A story/e2e coverage loop can drive real browser
  tests as the acceptance gate.

- **Accounts, identities & usage-aware rotation.** Named provider **accounts** with isolated
  config dirs and **GitHub identities**; a **credential broker** so a personal access token is
  never in an agent's environment (git fetches it from a loopback socket at push time).
  **Runway** keeps long runs going across a pool of subscription accounts: as one nears its
  usage limit it rotates to a fresher one — including a **live in-place swap** that moves a
  *running* agent onto another account mid-task without interrupting its work, enabled per
  account with a toggle on the account tab.

- **Skills.** A central library that materializes skills (and project `CLAUDE.md` context)
  into each agent's config, with **bundles**, draft→promote governance, and import.

- **Pick the engine.** Per-terminal and per-project **model**, **reasoning-effort**, and
  **routing** selection.

- **Coordinate.** A Tower-mediated **mailbox** and per-project **shared memory** — versioned
  decision / gotcha / glossary entries, operator-verified and disputable, rendered as
  readable views.

- **Test.** A shared **Playwright test kit** (`towerctl test`) with a slot semaphore and
  free-port allocator writing per-run report dirs, surfaced in a Tests panel.

- **An in-app assistant.** Ask it to drive the Tower — spawn or restart terminals, start work,
  run actions — behind a propose-then-confirm gate.

- **Operate locally.** Browser control-plane protection (Origin + Host + token);
  retention/GC; an audit log and a
  health/observability panel; `towerctl backup`; and a built-in CLI self-updater. The smoke
  suite (`scripts/smoke-*`) drives the UI in a real browser end-to-end, including the broker
  confirming a push credential never reaches an agent's environment. Per-agent Unix-user
  isolation is not yet enforced; see the security posture below.

## Requirements

Linux (Ubuntu/Debian), Node ≥ 22, tmux ≥ 3.2, git — developed and tested on WSL2, but not
WSL-gated (`towerctl doctor` warns rather than fails off WSL). Optional: the agent CLIs
(`claude`, `gemini`, `codex`) for real agent terminals; Playwright browsers (`npx playwright
install chromium`) for the test kit. Run the preflight:

```bash
npm run doctor
```

## Run

```bash
npm install

# Dev (Vite on :5173 proxying to the Tower on :4870, both hot-reloading):
npm run dev

# Prod (Tower serves the built app on :4870):
npm run build && npm start
# open http://127.0.0.1:4870  →  Chrome ⋮ → Install app  →  standalone PWA
```

Environment: `CT_PORT` (default 4870), `CT_HOME` (default `~/.ct`),
`CT_ALLOWED_ORIGINS` (extra origins), `CT_TEST_MAX_SLOTS` (test-kit cap).

## Operating it

- **Add a project** (a git repo path), then create terminals under it. Pick a provider, a
  model and reasoning effort, optionally a fresh **worktree** + task label, and a **GitHub
  identity**.
- **Mission Control** shows the **attention queue** — answer questions or approve/deny
  permission requests inline. Enable OS alerts to be summoned when the window is backgrounded.
- **Review & Land** (the `review` tab on a worktree terminal): read the diff, request changes,
  then merge or open a PR under the terminal's identity.
- **Missions** run a terminal on autopilot through a plan; the board tracks them and each run
  gets a report. They pause to the attention queue when they need you.
- **Accounts & Identities**: add provider accounts (log in once each) and GitHub identities
  (paste a PAT — it's stored write-only for the broker). Toggle **Live-swap rotation** per
  account to include it in Runway's rotation pool; Health and the audit trail live here too.
- **⌘K** opens the command palette: new task, jump to a terminal, or `/text` to search every
  terminal's logs.
- **Agents coordinate** via `towerctl mail send/inbox` and shared memory (`towerctl memory
  read/search/add/update/dispute` — only the operator marks an entry verified); progress notes
  go to `towerctl note`; tests run via `towerctl test run`.

## Security posture

Control Tower is intended for a trusted, single-user machine. It binds to loopback;
do not expose it to a LAN or the internet through a proxy, tunnel, or port forward.
Treat every connected terminal as having the privileges of the Unix user running Tower.

Host, Origin, and session-token checks protect the browser control plane from other
websites. They do not authenticate local users or sandbox local processes: the session
bootstrap endpoint allows a local client to obtain a full control-plane token. The
assistant's scoped token limits that token's permissions, but cannot prevent a local
process from obtaining the full token separately.

The credential broker keeps push credentials out of agent environment variables, but
same-user agents can still access local files and credentials. **Per-agent Unix-user
isolation and egress enforcement are not implemented.** `scripts/setup-isolation.sh`
only provisions host resources; running it does not change this boundary. Use a
dedicated machine or VM and narrowly scoped accounts for untrusted projects or agents.

See [SECURITY.md](./SECURITY.md) for runtime-data handling and reporting guidance.

## Staying alive when you walk away

On WSL2, the VM is torn down on idle/reboot, which would kill tmux and every agent. Install
`scripts/control-tower.service` (systemd user unit) and run `scripts/keepalive.ps1` on
Windows (or set `vmIdleTimeout=-1` in `.wslconfig`). On native Linux, the systemd unit alone
keeps it alive across logout/reboot.

## Layout

```
src/server/   Tower: terminal manager, agent adapters, hook pipeline, mission control,
              autonomous loops + missions, worktrees + review, accounts + credential
              broker, usage-aware rotation (runway), skills, coordination + memory, test
              kit, reconciler, retention, control-plane auth, JSON/JSONL store
src/web/      React + Vite + xterm.js dashboard (Mission Control, Review, Missions/Board,
              Accounts, Runway, Skills, Memory, Files, Settings, Command Palette)
src/cli/      towerctl (doctor, backup, mail, memory, test, note, research, review, …)
src/shared/   types shared by server and web
scripts/      smoke-* verifications, setup-isolation.sh, systemd unit, keepalive
examples/     e2e-project (a Playwright project the test kit can drive)
```

## License

Control Tower is available under the [MIT License](./LICENSE).
Third-party dependencies retain their own licenses. The [third-party notices](./src/web/public/THIRD_PARTY_NOTICES.txt)
list the licenses and attributions for code distributed with the web dashboard. Provider
CLIs and services are governed by their respective licenses and terms.
