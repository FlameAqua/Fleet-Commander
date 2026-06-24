#!/bin/bash
# ---------------------------------------------------------------------------
# sample_custom_script.sh — quick system health snapshot
#
# Run this via the "Custom Script" section to get a brief status summary
# from every host in the CSV without changing anything.
#
# Exit 0 (success) always unless the SSH connection itself fails.
# ---------------------------------------------------------------------------
set -uo pipefail

log() { echo "[*] $*"; }

log "=== $(hostname) ==="
log "Date     : $(date -u '+%Y-%m-%d %H:%M UTC')"
log "Uptime   : $(uptime -p 2>/dev/null || uptime)"
log "OS       : $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -sr)"
log "Load     : $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null || echo n/a)"
log "Disk /   : $(df -h / | awk 'NR==2{print $3"/"$2" ("$5" used)"}')"
log "Memory   : $(free -h 2>/dev/null | awk '/^Mem/{print $3"/"$2" used"}' || echo n/a)"
log "heplify  : $(systemctl is-active heplify 2>/dev/null || echo 'not managed by systemd')"

if [ -f /var/run/reboot-required ]; then
    log "REBOOT   : required"
else
    log "REBOOT   : not required"
fi

# Pending upgrades count (non-fatal if apt is unavailable).
pending=$(apt list --upgradable 2>/dev/null | grep -vc "^Listing" || echo 0)
log "Pending upgrades: ${pending}"

exit 0
