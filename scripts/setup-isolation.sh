#!/usr/bin/env bash
# Control Tower — per-agent OS isolation setup (SPEC D14 / M4 hardening).
#
# Run ONCE, with sudo. This is the privileged step the Tower deliberately does NOT
# perform itself: it creates a pool of unprivileged Unix users for agents to run as,
# and installs an nftables egress allowlist so a compromised agent can't exfiltrate to
# arbitrary hosts. After this runs, the Tower detects the marker and switches from
# single-UID mode to per-agent-uid mode.
#
# Review before running. Undo with: scripts/setup-isolation.sh --remove
set -euo pipefail

CT_HOME="${CT_HOME:-$HOME/.ct}"
POOL_SIZE="${CT_AGENT_POOL:-8}"
MARKER="$CT_HOME/isolation-enabled"
SUDO_RULE="/etc/sudoers.d/control-tower"
# Hosts agents are allowed to reach (provider APIs, GitHub, loopback). Extend as needed.
ALLOW_HOSTS=(api.anthropic.com api.openai.com generativelanguage.googleapis.com github.com api.github.com codeload.github.com)

# Both setup AND teardown are privileged. The root check must come BEFORE --remove:
# otherwise a non-root `--remove` silently fails every privileged step (suppressed) but
# still deletes the user-owned marker, reporting success while every user / sudoers rule
# / nftables table it claims to have removed is still installed.
if [[ $EUID -ne 0 ]]; then echo "run with sudo"; exit 1; fi

if [[ "${1:-}" == "--remove" ]]; then
  for i in $(seq 1 "$POOL_SIZE"); do userdel "ct-agent-$i" 2>/dev/null || true; done
  nft delete table inet ct_egress 2>/dev/null || true
  # Remove the sudoers drop-in too — leaving it behind keeps standing NOPASSWD runas
  # rules for the (now-deleted) ct-agent-* names, which silently re-grant access if any
  # such account is ever recreated.
  rm -f "$SUDO_RULE"
  rm -f "$MARKER"
  echo "isolation removed."
  exit 0
fi

echo "Creating $POOL_SIZE agent users (ct-agent-1..$POOL_SIZE)…"
for i in $(seq 1 "$POOL_SIZE"); do
  id "ct-agent-$i" &>/dev/null || useradd -m -s /bin/bash "ct-agent-$i"
done

# Let the invoking user run tmux/agents as the pool users without a password.
{
  for i in $(seq 1 "$POOL_SIZE"); do
    echo "${SUDO_USER:-$USER} ALL=(ct-agent-$i) NOPASSWD: ALL"
  done
} > "$SUDO_RULE"
chmod 440 "$SUDO_RULE"

echo "Resolving egress allowlist hosts to IPs…"
# The allowlist is resolved to concrete IPs HERE, at setup time — nftables filters on
# addresses, not names. KNOWN LIMITATION: provider and GitHub IP ranges rotate, so these
# resolved IPs will drift. A long-lived host MUST re-resolve periodically or agents will
# be (fail-closed) blocked from rotated-in IPs. Re-run this script from a cron/systemd
# timer, e.g. hourly, to refresh the set. Deny-by-default is deliberate: a stale entry
# blocks a good host rather than silently allowing an arbitrary one.
# `|| true` per host is essential under `set -euo pipefail`: getent exits non-zero when a
# host doesn't resolve, and without this the pipefail'd pipeline would abort the whole
# subshell mid-loop, silently dropping every host AFTER the failing one (e.g. github.com)
# from the allowlist while the count-0 warning never fires. Each host now resolves
# independently; a transient miss drops only that one host.
mapfile -t V4_IPS < <(
  for host in "${ALLOW_HOSTS[@]}"; do getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' || true; done | sort -u
)
mapfile -t V6_IPS < <(
  for host in "${ALLOW_HOSTS[@]}"; do getent ahostsv6 "$host" 2>/dev/null | awk '{print $1}' || true; done | grep -v '^::ffff:' | sort -u
)
if ((${#V4_IPS[@]} == 0 && ${#V6_IPS[@]} == 0)); then
  echo "WARNING: resolved 0 allowlist IPs (no DNS at setup?). ct-agent uids will be egress-blocked except loopback/DNS until this is re-run." >&2
fi

echo "Installing nftables egress allowlist…"
# Recreate the table from scratch so stale allowlist elements can't accumulate across runs.
nft delete table inet ct_egress 2>/dev/null || true
nft add table inet ct_egress
nft add chain inet ct_egress out '{ type filter hook output priority 0; policy accept; }'
# Allowed-destination sets, populated from the IPs resolved above.
nft add set inet ct_egress allow_v4 '{ type ipv4_addr; }'
nft add set inet ct_egress allow_v6 '{ type ipv6_addr; }'
((${#V4_IPS[@]})) && nft add element inet ct_egress allow_v4 "{ $(IFS=,; echo "${V4_IPS[*]}") }"
((${#V6_IPS[@]})) && nft add element inet ct_egress allow_v6 "{ $(IFS=,; echo "${V6_IPS[*]}") }"
# Per-agent uids are DENY-BY-DEFAULT. The chain policy stays 'accept' so all non-agent
# traffic is untouched; for each ct-agent uid we allow only loopback, DNS, replies to
# already-established flows, and TCP to the resolved allowlist — then DROP everything
# else from that uid. The trailing per-uid drop is what actually restricts egress: a
# ct-agent uid connecting to any host not in allow_v4/allow_v6 hits it and is dropped.
for i in $(seq 1 "$POOL_SIZE"); do
  UID_N=$(id -u "ct-agent-$i")
  nft add rule inet ct_egress out meta skuid "$UID_N" oifname lo accept
  nft add rule inet ct_egress out meta skuid "$UID_N" ct state established,related accept
  nft add rule inet ct_egress out meta skuid "$UID_N" udp dport 53 accept
  nft add rule inet ct_egress out meta skuid "$UID_N" tcp dport 53 accept
  nft add rule inet ct_egress out meta skuid "$UID_N" ip daddr @allow_v4 meta l4proto tcp accept
  nft add rule inet ct_egress out meta skuid "$UID_N" ip6 daddr @allow_v6 meta l4proto tcp accept
  nft add rule inet ct_egress out meta skuid "$UID_N" drop
done

mkdir -p "$CT_HOME"
echo "enabled $(date -u +%FT%TZ)" > "$MARKER"
echo "done. Restart the Tower; it will report per-agent-uid isolation."
