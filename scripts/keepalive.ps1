# Control Tower — Windows-side WSL keepalive (SPEC §15).
#
# The WSL2 VM is torn down after an idle timeout; when it goes, so do tmux and every
# agent — fatal to the "walk away and let agents work" premise. This holds a handle
# open inside the distro so the VM stays up. Run it once (or from Task Scheduler at
# logon) in the background:
#
#   powershell -WindowStyle Hidden -File scripts\keepalive.ps1
#
# Alternatively set a long idle timeout in %USERPROFILE%\.wslconfig:
#   [wsl2]
#   vmIdleTimeout=-1

$distro = "Ubuntu"   # adjust to your distro (wsl -l -q)
while ($true) {
  # A cheap, long-lived command keeps the VM alive without spinning the CPU.
  wsl.exe -d $distro --exec sh -c "sleep 3600" | Out-Null
}
