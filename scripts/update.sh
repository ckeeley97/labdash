#!/usr/bin/env bash
# Update LabDash in place. Run inside the container:
#   bash /opt/labdash/scripts/update.sh
# or from the Proxmox host:
#   pct exec <CTID> -- bash /opt/labdash/scripts/update.sh
set -euo pipefail

cd /opt/labdash
# repo files are owned by the 'labdash' service user but updates run as root
git config --global --add safe.directory /opt/labdash 2>/dev/null || true
echo "[*] Pulling latest LabDash…"
git fetch --depth 1 origin
git reset --hard "origin/$(git rev-parse --abbrev-ref HEAD)"
chown -R labdash:labdash /opt/labdash 2>/dev/null || true
echo "[*] Restarting service…"
systemctl restart labdash
echo "[✓] Updated. Your config in data/config.json is untouched."
