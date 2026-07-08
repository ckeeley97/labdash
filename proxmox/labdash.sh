#!/usr/bin/env bash
# ============================================================================
#  LabDash — Proxmox VE helper script
#  Creates an unprivileged Debian 12 LXC container and installs LabDash in it.
#
#  Run this ON THE PROXMOX HOST as root:
#    bash -c "$(curl -fsSL https://raw.githubusercontent.com/ckeeley97/labdash/main/proxmox/labdash.sh)"
#
#  Every setting can be overridden with environment variables, e.g.:
#    CTID=150 DISK=6 RAM=1024 bash labdash.sh
# ============================================================================
set -euo pipefail

# ------------------------- configurable defaults ---------------------------
REPO_URL="${REPO_URL:-https://github.com/ckeeley97/labdash.git}"
BRANCH="${BRANCH:-main}"

CT_HOSTNAME="${CT_HOSTNAME:-labdash}"
DISK="${DISK:-4}"            # GB
RAM="${RAM:-512}"            # MB
SWAP="${SWAP:-256}"          # MB
CORES="${CORES:-1}"
BRIDGE="${BRIDGE:-vmbr0}"
NET="${NET:-dhcp}"           # "dhcp" or e.g. "192.168.1.50/24,gw=192.168.1.1"
PORT="${PORT:-7380}"
DEBIAN_VERSION="${DEBIAN_VERSION:-12}"

# ------------------------------- cosmetics ---------------------------------
RD=$'\033[01;31m'; GN=$'\033[1;92m'; YW=$'\033[33m'; BL=$'\033[36m'; CL=$'\033[m'
msg()  { echo -e "${BL}[*]${CL} $1"; }
ok()   { echo -e "${GN}[✓]${CL} $1"; }
warn() { echo -e "${YW}[!]${CL} $1"; }
die()  { echo -e "${RD}[✗]${CL} $1" >&2; exit 1; }

header() {
cat <<'EOF'
    __          __    ____             __
   / /   ____ _/ /_  / __ \____ ______/ /_
  / /   / __ `/ __ \/ / / / __ `/ ___/ __ \
 / /___/ /_/ / /_/ / /_/ / /_/ (__  ) / / /
/_____/\__,_/_.___/_____/\__,_/____/_/ /_/
        self-hosted homelab dashboard
EOF
}

# ------------------------------ sanity checks ------------------------------
header
[[ $EUID -eq 0 ]] || die "Run this script as root on the Proxmox host."
command -v pct >/dev/null 2>&1 || die "'pct' not found — this must run on a Proxmox VE host."
command -v pveam >/dev/null 2>&1 || die "'pveam' not found — this must run on a Proxmox VE host."

# ------------------------------ pick a CTID --------------------------------
if [[ -z "${CTID:-}" ]]; then
  CTID=$(pvesh get /cluster/nextid 2>/dev/null) || CTID=$(( $(pct list | awk 'NR>1{print $1}' | sort -n | tail -1) + 1 ))
fi
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists — set CTID=<free id> and rerun."

# ------------------------------ pick storage -------------------------------
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-$(pvesm status --content vztmpl 2>/dev/null | awk 'NR>1{print $1; exit}')}"
ROOTFS_STORAGE="${ROOTFS_STORAGE:-$(pvesm status --content rootdir 2>/dev/null | awk 'NR>1{print $1; exit}')}"
[[ -n "$TEMPLATE_STORAGE" ]] || die "No storage with 'vztmpl' content found."
[[ -n "$ROOTFS_STORAGE"  ]] || die "No storage with 'rootdir' content found."

echo
msg "Settings (override with env vars):"
echo "      CTID:      $CTID"
echo "      Hostname:  $CT_HOSTNAME"
echo "      Disk:      ${DISK}G on $ROOTFS_STORAGE"
echo "      RAM/Swap:  ${RAM}MB / ${SWAP}MB"
echo "      Cores:     $CORES"
echo "      Network:   $BRIDGE ($NET)"
echo "      Repo:      $REPO_URL ($BRANCH)"
echo "      Port:      $PORT"
echo

if [[ -t 0 && -z "${YES:-}" ]]; then
  read -r -p "Proceed? [Y/n] " REPLY
  [[ -z "$REPLY" || "$REPLY" =~ ^[Yy] ]] || die "Aborted."
fi

# --------------------------- download the template -------------------------
msg "Refreshing template catalogue…"
pveam update >/dev/null

TEMPLATE=$(pveam available --section system | awk '{print $2}' | grep "^debian-${DEBIAN_VERSION}-standard" | sort -V | tail -1)
[[ -n "$TEMPLATE" ]] || die "No debian-${DEBIAN_VERSION}-standard template available."

if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  msg "Downloading $TEMPLATE to $TEMPLATE_STORAGE…"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
else
  ok "Template $TEMPLATE already present."
fi

# ----------------------------- create container ----------------------------
if [[ "$NET" == "dhcp" ]]; then
  NET0="name=eth0,bridge=${BRIDGE},ip=dhcp"
else
  NET0="name=eth0,bridge=${BRIDGE},ip=${NET}"
fi

msg "Creating LXC $CTID…"
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" \
  --memory "$RAM" \
  --swap "$SWAP" \
  --rootfs "${ROOTFS_STORAGE}:${DISK}" \
  --net0 "$NET0" \
  --unprivileged 1 \
  --features nesting=1 \
  --onboot 1 \
  --tags labdash \
  --description "LabDash homelab dashboard — installed by proxmox/labdash.sh" >/dev/null
ok "Container $CTID created."

msg "Starting container…"
pct start "$CTID"

msg "Waiting for network…"
for i in $(seq 1 30); do
  IP=$(pct exec "$CTID" -- ip -4 -o addr show dev eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1) || true
  [[ -n "${IP:-}" ]] && break
  sleep 2
done
[[ -n "${IP:-}" ]] || die "Container never got an IP — check bridge/DHCP, then rerun the install step manually."
ok "Container is up at $IP."

# --------------------------- install inside the CT -------------------------
msg "Installing LabDash inside the container (this takes a minute)…"
pct exec "$CTID" -- bash -euo pipefail -c "
  export DEBIAN_FRONTEND=noninteractive
  apt-get -qq update
  apt-get -qq install -y curl ca-certificates git nodejs >/dev/null

  NODE_MAJOR=\$(node -e 'console.log(process.versions.node.split(\".\")[0])' 2>/dev/null || echo 0)
  if [ \"\$NODE_MAJOR\" -lt 18 ]; then
    echo 'Debian nodejs too old — installing Node 22 from NodeSource…'
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get -qq install -y nodejs >/dev/null
  fi

  git clone --depth 1 --branch '$BRANCH' '$REPO_URL' /opt/labdash

  useradd -r -d /opt/labdash -s /usr/sbin/nologin labdash || true
  mkdir -p /opt/labdash/data
  chown -R labdash:labdash /opt/labdash

  cat > /etc/systemd/system/labdash.service <<UNIT
[Unit]
Description=LabDash homelab dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=labdash
Group=labdash
WorkingDirectory=/opt/labdash
Environment=PORT=$PORT
ExecStart=/usr/bin/env node /opt/labdash/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/labdash/data
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable -q --now labdash
"
ok "LabDash service installed and running."

echo
ok  "All done!"
echo -e "      Open:    ${GN}http://${IP}:${PORT}${CL}"
echo -e "      Update:  ${BL}pct exec $CTID -- bash /opt/labdash/scripts/update.sh${CL}"
echo -e "      Config:  ${BL}/opt/labdash/data/config.json${CL} (inside CT $CTID — but just use the web UI)"
echo
