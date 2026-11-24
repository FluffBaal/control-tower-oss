# Security

## Supported deployment

Control Tower is pre-1.0 software for a trusted, single-user Linux or WSL2 machine.
Use the latest maintained revision and keep dependencies up to date. A dependency
or secret scan is useful evidence, not a guarantee that an application is secure.

The server binds to loopback. Do not publish it through a reverse proxy, public
tunnel, container port mapping, or LAN port forward. Host and Origin validation
plus session tokens defend against other websites; they are not local-user
authentication. A local client can obtain the full token from `/api/session`.

Terminals execute with the Tower process's Unix-user privileges. The credential
broker avoids placing push credentials in agent environment variables, but it
does not isolate agents from same-user files or other credentials. Per-agent Unix
users and egress rules can be provisioned by `scripts/setup-isolation.sh`; Tower
does not yet run terminals under those separate users or enforce that boundary.
The assistant's proposal-confirmation workflow is not a security boundary against
a local process that can obtain a full session token.

Run untrusted projects or agents in a dedicated VM or machine, use narrowly scoped
provider and GitHub credentials, and review changes before publishing them.

## Private runtime data

Tower stores state under `~/.ct` (or `CT_HOME`). This includes account configuration,
credentials, terminal logs, shared memory, and project reports. Provider config
directories and Tower backups can also contain secrets. Keep runtime data outside
source checkouts, restrict access, and do not commit or upload it.

Before sharing a screenshot, recording, log, test report, or backup, inspect it for
credentials and private project content. `.gitignore` is an accident-prevention
measure; it does not remove already tracked files or historical Git objects.
If a credential has been committed, revoke or rotate it before addressing the
repository history.

## Reporting

Do not post live credentials, private logs, or exploit details in public issues.
If the repository's Security tab offers **Report a vulnerability**, use that
private channel. A dedicated private reporting channel is otherwise not yet
configured. Public issues are appropriate for non-sensitive hardening suggestions.
