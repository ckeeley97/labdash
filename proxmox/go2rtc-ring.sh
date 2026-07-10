#!/usr/bin/env bash
# ============================================================================
#  LabDash — go2rtc + Ring camera bridge — Proxmox VE helper script
#  Creates an unprivileged Debian 12 LXC and installs go2rtc, so your Ring
#  (and other) cameras can be embedded in LabDash.
#
#  Ring has NO local stream — go2rtc logs into Ring's cloud for you and
#  re-serves each camera as a browser-friendly page. YOU do the Ring login
#  (email + password + 2FA) in go2rtc's own web UI afterwards; this script
#  never sees your Ring credentials.
#
#  Run this ON THE PROXMOX HOST as root:
#    bash -c "$(curl -fsSL https://raw.githubusercontent.com/ckeeley97/labdash/main/proxmox/go2rtc-ring.sh)"
#
#  Every setting can be overridden with environment variables, e.g.:
#    CTID=151 RAM=1024 INSTALL_TAILSCALE=yes bash go2rtc-ring.sh
#    INSTALL_TAILSCALE=yes TS_AUTHKEY=tskey-auth-xxxx bash go2rtc-ring.sh   # unattended Tailscale
# ============================================================================
set -euo pipefail

# ------------------------- configurable defaults ---------------------------
CT_HOSTNAME="${CT_HOSTNAME:-go2rtc}"
DISK="${DISK:-2}"            # GB
RAM="${RAM:-512}"           # MB
SWAP="${SWAP:-256}"         # MB
CORES="${CORES:-1}"
BRIDGE="${BRIDGE:-vmbr0}"
NET="${NET:-dhcp}"          # "dhcp" or e.g. "192.168.1.60/24,gw=192.168.1.1"
GO2RTC_PORT="${GO2RTC_PORT:-1984}"
DEBIAN_VERSION="${DEBIAN_VERSION:-12}"
INSTALL_TAILSCALE="${INSTALL_TAILSCALE:-ask}"   # yes | no | ask
TS_AUTHKEY="${TS_AUTHKEY:-}"                     # optional: unattended Tailscale login

# ------------------------------- cosmetics ---------------------------------
RD=$'\033[01;31m'; GN=$'\033[1;92m'; YW=$'\033[33m'; BL=$'\033[36m'; CL=$'\033[m'
msg()  { echo -e "${BL}[*]${CL} $1"; }
ok()   { echo -e "${GN}[✓]${CL} $1"; }
warn() { echo -e "${YW}[!]${CL} $1"; }
die()  { echo -e "${RD}[✗]${CL} $1" >&2; exit 1; }

header() {
cat <<'EOF'
                 ___      _
   __ _ ___ ___ |_  )_ _ | |_ __
  / _` / _ \___| / /| '_||  _/ _|
  \__, \___/   /___|_|   \__\__|
  |___/   Ring cameras → LabDash
EOF
}

# ------------------------------ sanity checks ------------------------------
header
[[ $EUID -eq 0 ]] || die "Run this script as root on the Proxmox host."
command -v pct   >/dev/null 2>&1 || die "'pct' not found — this must run on a Proxmox VE host."
command -v pveam >/dev/null 2>&1 || die "'pveam' not found — this must run on a Proxmox VE host."

# ------------------------- decide on Tailscale -----------------------------
if [[ "$INSTALL_TAILSCALE" == "ask" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "Install Tailscale for safe remote access to the cameras? [Y/n] " _t
    [[ -z "$_t" || "$_t" =~ ^[Yy] ]] && INSTALL_TAILSCALE=yes || INSTALL_TAILSCALE=no
  else
    INSTALL_TAILSCALE=no
  fi
fi

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
echo "      CTID:       $CTID"
echo "      Hostname:   $CT_HOSTNAME"
echo "      Disk:       ${DISK}G on $ROOTFS_STORAGE"
echo "      RAM/Swap:   ${RAM}MB / ${SWAP}MB"
echo "      Cores:      $CORES"
echo "      Network:    $BRIDGE ($NET)"
echo "      go2rtc port:$GO2RTC_PORT"
echo "      Tailscale:  $INSTALL_TAILSCALE"
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
  --tags go2rtc \
  --description "go2rtc + Ring camera bridge for LabDash — installed by proxmox/go2rtc-ring.sh" >/dev/null
ok "Container $CTID created."

# --- if Tailscale: give the container a TUN device (needed inside an LXC) ---
if [[ "$INSTALL_TAILSCALE" == "yes" ]]; then
  CONF="/etc/pve/lxc/${CTID}.conf"
  msg "Adding /dev/net/tun passthrough for Tailscale…"
  {
    echo "lxc.cgroup2.devices.allow: c 10:200 rwm"
    echo "lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file"
  } >> "$CONF"
fi

msg "Starting container…"
pct start "$CTID"

msg "Waiting for network…"
for i in $(seq 1 30); do
  IP=$(pct exec "$CTID" -- ip -4 -o addr show dev eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1) || true
  [[ -n "${IP:-}" ]] && break
  sleep 2
done
[[ -n "${IP:-}" ]] || die "Container never got an IP — check bridge/DHCP."
ok "Container is up at $IP."

# --------------------------- install go2rtc in CT --------------------------
# Build the "print-cameras" helper here (clean, un-nested) and ship it into
# the container base64-encoded so no quoting layers can mangle it.
PRINT_CAMERAS_B64=$(base64 -w0 <<'PCS'
#!/usr/bin/env bash
# Usage: print-cameras.sh [host]   (host defaults to this container's LAN IP)
# Prints ready-to-paste LabDash "Cameras (grid)" lines for every go2rtc stream.
set -euo pipefail
PORT="${GO2RTC_PORT:-1984}"
HOST="${1:-$(hostname -I | awk '{print $1}')}"
names=$(curl -fsSL "http://localhost:${PORT}/api/streams" 2>/dev/null | jq -r 'keys[]' 2>/dev/null || true)
if [ -z "$names" ]; then
  echo "No camera streams yet."
  echo "Open  http://${HOST}:${PORT}  ->  Add  ->  Ring  (do the 2FA login), then rerun this."
  exit 0
fi
echo "Paste these lines into a LabDash 'Cameras (grid)' widget:"
echo
while IFS= read -r n; do
  [ -z "$n" ] && continue
  label=$(echo "$n" | tr '_' ' ' | sed 's/\b\(.\)/\u\1/g')
  echo "${label} | http://${HOST}:${PORT}/stream.html?src=${n} | live"
done <<< "$names"
echo
echo "For BATTERY cameras change 'live' to 'snapshot' and use this URL instead:"
echo "  http://${HOST}:${PORT}/api/frame.jpeg?src=<name>"
PCS
)

msg "Installing go2rtc inside the container…"
pct exec "$CTID" -- bash -euo pipefail -c "
  export DEBIAN_FRONTEND=noninteractive
  apt-get -qq update
  apt-get -qq install -y curl ca-certificates jq >/dev/null

  ARCH=\$(uname -m)
  case \"\$ARCH\" in
    x86_64)  GA=amd64 ;;
    aarch64) GA=arm64 ;;
    armv7l)  GA=arm ;;
    *)       GA=amd64 ;;
  esac

  mkdir -p /opt/go2rtc
  curl -fsSL -o /opt/go2rtc/go2rtc \"https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_linux_\${GA}\"
  chmod +x /opt/go2rtc/go2rtc

  if [ ! -f /opt/go2rtc/go2rtc.yaml ]; then
    cat > /opt/go2rtc/go2rtc.yaml <<YAML
api:
  listen: \":${GO2RTC_PORT}\"
YAML
  fi

  id -u go2rtc >/dev/null 2>&1 || useradd -r -d /opt/go2rtc -s /usr/sbin/nologin go2rtc
  chown -R go2rtc:go2rtc /opt/go2rtc
  chmod 600 /opt/go2rtc/go2rtc.yaml

  cat > /etc/systemd/system/go2rtc.service <<UNIT
[Unit]
Description=go2rtc camera streamer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=go2rtc
Group=go2rtc
WorkingDirectory=/opt/go2rtc
ExecStart=/opt/go2rtc/go2rtc -config /opt/go2rtc/go2rtc.yaml
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/go2rtc
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

  # Helper (shipped base64-encoded from the host): after you add Ring in the
  # web UI, this prints ready-to-paste LabDash 'Cameras (grid)' lines.
  echo '$PRINT_CAMERAS_B64' | base64 -d > /opt/go2rtc/print-cameras.sh
  chmod +x /opt/go2rtc/print-cameras.sh

  systemctl daemon-reload
  systemctl enable -q --now go2rtc
"
ok "go2rtc installed and running."

# ----------------------------- Tailscale (opt) -----------------------------
TS_NAME=""
if [[ "$INSTALL_TAILSCALE" == "yes" ]]; then
  msg "Installing Tailscale inside the container…"
  pct exec "$CTID" -- bash -euo pipefail -c "
    curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
    systemctl enable -q --now tailscaled
  "
  if [[ -n "$TS_AUTHKEY" ]]; then
    msg "Bringing Tailscale up with the provided auth key…"
    pct exec "$CTID" -- tailscale up --authkey="$TS_AUTHKEY" --hostname="$CT_HOSTNAME" >/dev/null 2>&1 || warn "tailscale up failed — run it manually inside the CT."
    TS_NAME=$(pct exec "$CTID" -- tailscale ip -4 2>/dev/null | head -1 || true)
    [[ -n "$TS_NAME" ]] && ok "Tailscale up — IP $TS_NAME"
  else
    warn "Tailscale installed but NOT logged in yet."
    echo -e "      Finish it with:  ${BL}pct exec $CTID -- tailscale up --hostname=$CT_HOSTNAME${CL}"
    echo -e "      (it prints a URL — open it in a browser to authenticate)"
  fi
fi

# -------------------------------- summary ----------------------------------
ADDR="$IP"
[[ -n "$TS_NAME" ]] && ADDR="$TS_NAME"

echo
ok  "All done!"
echo
echo -e "  ${GN}1.${CL} Open go2rtc:   ${GN}http://${IP}:${GO2RTC_PORT}${CL}"
echo -e "  ${GN}2.${CL} Click  ${BL}Add → Ring${CL}, sign in with your Ring email + password + 2FA code."
echo -e "       (go2rtc stores a token locally; you won't need your password again.)"
echo -e "  ${GN}3.${CL} List your cameras as LabDash-ready lines:"
echo -e "       ${BL}pct exec $CTID -- /opt/go2rtc/print-cameras.sh ${ADDR}${CL}"
echo -e "  ${GN}4.${CL} In LabDash: Edit → + Add widget → ${BL}Cameras (grid)${CL}, paste those lines."
echo -e "       Use ${BL}live${CL} for wired cameras, ${BL}snapshot${CL} for battery ones."
echo
if [[ "$INSTALL_TAILSCALE" == "yes" ]]; then
  echo -e "  ${YW}Remote access:${CL} once Tailscale is logged in, use the container's Tailscale"
  echo -e "  IP/name in the camera URLs so they work away from home. Do NOT expose go2rtc"
  echo -e "  to the internet directly."
else
  echo -e "  ${YW}Heads-up:${CL} you wanted remote access — install Tailscale (rerun with"
  echo -e "  INSTALL_TAILSCALE=yes) or put a WebSocket-capable reverse proxy in front of go2rtc."
fi
echo -e "  ${YW}Don't${CL} tick LabDash's \"Proxy through the LabDash server\" box for cameras."
echo
