#!/usr/bin/env bash
# ============================================================================
#  LabDash — Apache Guacamole — Proxmox VE helper script
#  Creates an unprivileged Debian 12 LXC and installs Apache Guacamole
#  (guacd + the web client under Tomcat 9), so LabDash's "Remote desktops
#  (RDP)" widget can open real RDP/VNC/SSH sessions in the popup viewer.
#
#  Debian doesn't ship a guacd package, so this builds guacamole-server
#  from source (first run takes a few minutes) and deploys the official
#  guacamole-client .war under Tomcat 9 — Guacamole doesn't yet support
#  the Tomcat 10 that ships by default on Debian 12, and Debian dropped
#  its own tomcat9 package from bookworm back in Dec 2023, so this fetches
#  the official Tomcat 9 binary straight from apache.org instead of apt.
#
#  Auth is Guacamole's built-in user-mapping.xml (no MySQL/Postgres needed)
#  — one admin user, connections added with the bundled add-machine.sh.
#
#  Run this ON THE PROXMOX HOST as root:
#    bash -c "$(curl -fsSL https://raw.githubusercontent.com/ckeeley97/labdash/main/proxmox/guacamole.sh)"
#
#  Every setting can be overridden with environment variables, e.g.:
#    CTID=152 RAM=2048 GUAC_ADMIN_USER=conor INSTALL_TAILSCALE=yes bash guacamole.sh
# ============================================================================
set -euo pipefail

# ------------------------- configurable defaults ---------------------------
CT_HOSTNAME="${CT_HOSTNAME:-guacamole}"
DISK="${DISK:-10}"           # GB — source build + tomcat + jdk need headroom
RAM="${RAM:-1536}"           # MB
SWAP="${SWAP:-512}"          # MB
CORES="${CORES:-2}"          # compiling guacd from source is CPU-bound
BRIDGE="${BRIDGE:-vmbr0}"
NET="${NET:-dhcp}"           # "dhcp" or e.g. "192.168.1.70/24,gw=192.168.1.1"
TOMCAT_PORT="${TOMCAT_PORT:-8080}"
GUACD_PORT="${GUACD_PORT:-4822}"
DEBIAN_VERSION="${DEBIAN_VERSION:-12}"
GUAC_VERSION="${GUAC_VERSION:-}"                 # blank = auto-detect latest
TOMCAT_VERSION="${TOMCAT_VERSION:-}"             # blank = auto-detect latest 9.0.x
GUAC_ADMIN_USER="${GUAC_ADMIN_USER:-admin}"
GUAC_ADMIN_PASS="${GUAC_ADMIN_PASS:-}"           # blank = generate one
INSTALL_TAILSCALE="${INSTALL_TAILSCALE:-ask}"    # yes | no | ask
TS_AUTHKEY="${TS_AUTHKEY:-}"                     # optional: unattended Tailscale

# ------------------------------- cosmetics ---------------------------------
RD=$'\033[01;31m'; GN=$'\033[1;92m'; YW=$'\033[33m'; BL=$'\033[36m'; CL=$'\033[m'
msg()  { echo -e "${BL}[*]${CL} $1"; }
ok()   { echo -e "${GN}[✓]${CL} $1"; }
warn() { echo -e "${YW}[!]${CL} $1"; }
die()  { echo -e "${RD}[✗]${CL} $1" >&2; exit 1; }

header() {
cat <<'EOF'
   __ _ _   _  __ _  ___ __ _ _ __ ___   ___ | | ___
  / _` | | | |/ _` |/ __/ _` | '_ ` _ \ / _ \| |/ _ \
 | (_| | |_| | (_| | (_| (_| | | | | | | (_) | |  __/
  \__, |\__,_|\__,_|\___\__,_|_| |_| |_|\___/|_|\___|
  |___/     HTML5 RDP/VNC/SSH gateway → LabDash
EOF
}

# ------------------------------ sanity checks ------------------------------
header
[[ $EUID -eq 0 ]] || die "Run this script as root on the Proxmox host."
command -v pct   >/dev/null 2>&1 || die "'pct' not found — this must run on a Proxmox VE host."
command -v pveam >/dev/null 2>&1 || die "'pveam' not found — this must run on a Proxmox VE host."

# ------------------------- pick a Guacamole version -------------------------
if [[ -z "$GUAC_VERSION" ]]; then
  msg "Looking up the latest Guacamole release…"
  GUAC_VERSION=$(curl -fsSL https://api.github.com/repos/apache/guacamole-server/tags 2>/dev/null \
    | grep -m1 '"name"' | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/') || true
  GUAC_VERSION="${GUAC_VERSION:-1.6.0}"
fi

# ------------------------- pick a Tomcat 9 version --------------------------
# Debian removed the tomcat9 apt package from bookworm in Dec 2023 and
# Guacamole's client still doesn't support Tomcat 10's Jakarta namespace,
# so we fetch the official upstream binary instead of relying on apt.
if [[ -z "$TOMCAT_VERSION" ]]; then
  msg "Looking up the latest Tomcat 9 release…"
  TOMCAT_VERSION=$(curl -fsSL https://downloads.apache.org/tomcat/tomcat-9/ 2>/dev/null \
    | grep -oE 'v9\.0\.[0-9]+' | sed 's/^v//' | sort -t. -k3 -n | tail -1) || true
  TOMCAT_VERSION="${TOMCAT_VERSION:-9.0.117}"
fi

# ------------------------- generate admin password ---------------------------
if [[ -z "$GUAC_ADMIN_PASS" ]]; then
  GUAC_ADMIN_PASS=$(openssl rand -base64 12 2>/dev/null | tr -dc 'A-Za-z0-9' | head -c16)
  [[ -n "$GUAC_ADMIN_PASS" ]] || GUAC_ADMIN_PASS="guac-$(date +%s)"
fi

# ------------------------- decide on Tailscale -----------------------------
if [[ "$INSTALL_TAILSCALE" == "ask" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "Install Tailscale for safe remote access to these desktops? [Y/n] " _t
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
echo "      CTID:        $CTID"
echo "      Hostname:    $CT_HOSTNAME"
echo "      Disk:        ${DISK}G on $ROOTFS_STORAGE"
echo "      RAM/Swap:    ${RAM}MB / ${SWAP}MB"
echo "      Cores:       $CORES"
echo "      Network:     $BRIDGE ($NET)"
echo "      Guacamole:   v${GUAC_VERSION} (built from source)"
echo "      Tomcat:      v${TOMCAT_VERSION} (upstream binary — apt's tomcat9 is gone from bookworm)"
echo "      Web port:    $TOMCAT_PORT  (path: /guacamole)"
echo "      Admin user:  $GUAC_ADMIN_USER"
echo "      Tailscale:   $INSTALL_TAILSCALE"
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
  --tags guacamole \
  --description "Apache Guacamole — HTML5 RDP/VNC/SSH gateway for LabDash — installed by proxmox/guacamole.sh" >/dev/null
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

# --------------------------- build the add-machine helper -------------------
# Ships base64-encoded into the container so no quoting layer can mangle it.
# Appends a <connection> block to user-mapping.xml for whichever machine you
# describe, then restarts Tomcat. Only supports a single admin user (fine for
# a homelab) — for multiple Guacamole users, edit user-mapping.xml by hand.
ADD_MACHINE_B64=$(base64 -w0 <<'ADM'
#!/usr/bin/env bash
# Usage: add-machine.sh ["Name" protocol host port [user] [pass] [domain]]
# With no arguments it asks interactively. protocol is rdp|vnc|ssh|telnet.
set -euo pipefail
MAPFILE="${GUAC_USER_MAPPING:-/etc/guacamole/user-mapping.xml}"
[ -f "$MAPFILE" ] || { echo "No $MAPFILE — is Guacamole installed?"; exit 1; }

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }

NAME="${1:-}"; PROTO="${2:-}"; HOST="${3:-}"; PORT="${4:-}"; LUSER="${5:-}"; LPASS="${6:-}"; DOMAIN="${7:-}"

[ -n "$NAME" ]  || read -r -p "Friendly name (shown in Guacamole + LabDash): " NAME
[ -n "$PROTO" ] || { read -r -p "Protocol [rdp/vnc/ssh/telnet] (rdp): " PROTO; PROTO="${PROTO:-rdp}"; }
[ -n "$HOST" ]  || read -r -p "Hostname or IP of the target machine: " HOST
if [ -z "$PORT" ]; then
  case "$PROTO" in
    rdp) DEFPORT=3389 ;; vnc) DEFPORT=5900 ;; ssh) DEFPORT=22 ;; telnet) DEFPORT=23 ;; *) DEFPORT="" ;;
  esac
  read -r -p "Port (${DEFPORT}): " PORT; PORT="${PORT:-$DEFPORT}"
fi
[ -n "$LUSER" ] || read -r -p "Login username on that machine (blank = prompt every session): " LUSER
if [ -z "$LPASS" ]; then
  read -r -s -p "Login password on that machine (blank = prompt every session): " LPASS; echo
fi
if [ "$PROTO" = "rdp" ] && [ -z "$DOMAIN" ]; then
  read -r -p "Windows domain (optional, RDP only): " DOMAIN
fi
[ -n "$NAME" ] && [ -n "$PROTO" ] && [ -n "$HOST" ] && [ -n "$PORT" ] || { echo "Name, protocol, host and port are required."; exit 1; }

{
  echo "    <connection name=\"$(xml_escape "$NAME")\">"
  echo "      <protocol>$(xml_escape "$PROTO")</protocol>"
  echo "      <param name=\"hostname\">$(xml_escape "$HOST")</param>"
  echo "      <param name=\"port\">$(xml_escape "$PORT")</param>"
  [ -n "$LUSER" ] && echo "      <param name=\"username\">$(xml_escape "$LUSER")</param>"
  [ -n "$LPASS" ] && echo "      <param name=\"password\">$(xml_escape "$LPASS")</param>"
  [ "$PROTO" = "rdp" ] && [ -n "${DOMAIN:-}" ] && echo "      <param name=\"domain\">$(xml_escape "$DOMAIN")</param>"
  if [ "$PROTO" = "rdp" ]; then
    echo "      <param name=\"ignore-cert\">true</param>"
    echo "      <param name=\"resize-method\">display-update</param>"
  fi
  echo "    </connection>"
} > /tmp/.guac-conn-block.$$

cp "$MAPFILE" "${MAPFILE}.bak"
awk -v blockfile="/tmp/.guac-conn-block.$$" '
  !done && /<\/authorize>/ {
    while ((getline line < blockfile) > 0) print line
    close(blockfile)
    done = 1
  }
  { print }
' "${MAPFILE}.bak" > "$MAPFILE"
rm -f "/tmp/.guac-conn-block.$$"

chown tomcat:tomcat "$MAPFILE" 2>/dev/null || true
chmod 640 "$MAPFILE"
systemctl restart tomcat9

HOST_IP=$(hostname -I | awk '{print $1}')
echo
echo "Added '${NAME}' (${PROTO}://${HOST}:${PORT}) to ${MAPFILE} and restarted Tomcat."
echo "Now: log into Guacamole at http://${HOST_IP}:${TOMCAT_PORT:-8080}/guacamole , open"
echo "'${NAME}' once, then copy the URL from your browser's address bar — it'll look like"
echo "http://${HOST_IP}:${TOMCAT_PORT:-8080}/guacamole/#/client/XXXXXXXX — and paste that"
echo "into LabDash's 'Remote desktops (RDP)' widget as:  ${NAME} | <that URL>"
ADM
)

# --------------------------- install inside the CT --------------------------
msg "Installing build tools + a JRE (this takes a minute)…"
pct exec "$CTID" -- bash -euo pipefail -c "
  export DEBIAN_FRONTEND=noninteractive
  apt-get -qq update
  apt-get -qq install -y \
    build-essential make gcc pkg-config curl ca-certificates wget openssl \
    libcairo2-dev libjpeg62-turbo-dev libpng-dev libtool-bin uuid-dev libossp-uuid-dev \
    libvncserver-dev libssh2-1-dev libssl-dev libtelnet-dev libpango1.0-dev \
    libwebsockets-dev libavcodec-dev libavformat-dev libavutil-dev libswscale-dev \
    libvorbis-dev libwebp-dev libpulse-dev freerdp2-dev \
    default-jre-headless >/dev/null
"
ok "Dependencies installed."

msg "Building guacd v${GUAC_VERSION} from source (this is the slow part)…"
pct exec "$CTID" -- bash -euo pipefail -c "
  cd /usr/src
  curl -fsSL -o guacamole-server.tar.gz \
    \"https://downloads.apache.org/guacamole/${GUAC_VERSION}/source/guacamole-server-${GUAC_VERSION}.tar.gz\" \
    || curl -fsSL -o guacamole-server.tar.gz \
    \"https://archive.apache.org/dist/guacamole/${GUAC_VERSION}/source/guacamole-server-${GUAC_VERSION}.tar.gz\"
  tar xzf guacamole-server.tar.gz
  cd guacamole-server-${GUAC_VERSION}
  ./configure --with-systemd-dir=/etc/systemd/system/ >/dev/null
  make -j\$(nproc) >/dev/null
  make install >/dev/null
  ldconfig
"
ok "guacd built and installed."

# Upstream's generated unit runs guacd as an unprivileged system user (e.g.
# "daemon") for security, but that user's home directory (/usr/sbin) isn't
# writable — and FreeRDP needs to write certs/config there during the RDP
# security handshake. Without a writable HOME, RDP connections fail with a
# confusing "Security negotiation failed" error that looks like bad
# credentials but isn't. Give that user a real, writable home instead.
pct exec "$CTID" -- bash -c '
  set -euo pipefail
  GUACD_USER=$(grep -oP "^User=\K.+" /etc/systemd/system/guacd.service 2>/dev/null || true)
  if [ -n "$GUACD_USER" ] && [ "$GUACD_USER" != "root" ]; then
    mkdir -p /var/lib/guacd
    chown "$GUACD_USER":"$GUACD_USER" /var/lib/guacd 2>/dev/null || chown "$GUACD_USER" /var/lib/guacd
    mkdir -p /etc/systemd/system/guacd.service.d
    printf "[Service]\nEnvironment=HOME=/var/lib/guacd\n" > /etc/systemd/system/guacd.service.d/home.conf
    systemctl daemon-reload
  fi
'

# Debian's tomcat9 apt package is gone from bookworm (removed Dec 2023), and
# Guacamole's client doesn't run on the Tomcat 10 Debian ships instead — so
# this fetches upstream's own Tomcat 9 binary tarball and runs it standalone
# under /opt/tomcat9 with its own systemd unit, same as guacd above.
msg "Installing Tomcat ${TOMCAT_VERSION} (upstream binary, since apt's tomcat9 no longer exists)…"
pct exec "$CTID" -- env TOMCAT_VERSION="$TOMCAT_VERSION" bash -c '
  set -euo pipefail
  cd /usr/src
  curl -fsSL -o apache-tomcat.tar.gz \
    "https://dlcdn.apache.org/tomcat/tomcat-9/v${TOMCAT_VERSION}/bin/apache-tomcat-${TOMCAT_VERSION}.tar.gz" \
    || curl -fsSL -o apache-tomcat.tar.gz \
    "https://archive.apache.org/dist/tomcat/tomcat-9/v${TOMCAT_VERSION}/bin/apache-tomcat-${TOMCAT_VERSION}.tar.gz"
  mkdir -p /opt/tomcat9
  tar xzf apache-tomcat.tar.gz -C /opt/tomcat9 --strip-components=1
  rm -rf /opt/tomcat9/webapps/ROOT /opt/tomcat9/webapps/docs /opt/tomcat9/webapps/examples \
         /opt/tomcat9/webapps/manager /opt/tomcat9/webapps/host-manager
  id -u tomcat >/dev/null 2>&1 || useradd -r -M -d /opt/tomcat9 -s /usr/sbin/nologin tomcat
  chmod +x /opt/tomcat9/bin/*.sh
  chown -R tomcat:tomcat /opt/tomcat9

  JAVA_BIN=$(command -v java)
  JAVA_HOME_DETECTED=$(readlink -f "$JAVA_BIN" | sed "s:/bin/java$::")
  cat > /etc/systemd/system/tomcat9.service <<UNIT
[Unit]
Description=Tomcat 9 (Guacamole web client)
After=network.target

[Service]
Type=forking
User=tomcat
Group=tomcat
Environment=JAVA_HOME=${JAVA_HOME_DETECTED}
Environment=CATALINA_PID=/opt/tomcat9/temp/tomcat.pid
Environment=CATALINA_HOME=/opt/tomcat9
Environment=CATALINA_BASE=/opt/tomcat9
ExecStart=/opt/tomcat9/bin/startup.sh
ExecStop=/opt/tomcat9/bin/shutdown.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
'
ok "Tomcat installed."

msg "Deploying the Guacamole web client on port ${TOMCAT_PORT}…"
pct exec "$CTID" -- env GUAC_VERSION="$GUAC_VERSION" GUACD_PORT="$GUACD_PORT" \
  GUAC_ADMIN_USER="$GUAC_ADMIN_USER" GUAC_ADMIN_PASS="$GUAC_ADMIN_PASS" \
  TOMCAT_PORT="$TOMCAT_PORT" ADD_MACHINE_B64="$ADD_MACHINE_B64" bash -c '
  set -euo pipefail
  mkdir -p /etc/guacamole/extensions /etc/guacamole/lib
  curl -fsSL -o /opt/tomcat9/webapps/guacamole.war \
    "https://downloads.apache.org/guacamole/${GUAC_VERSION}/binary/guacamole-${GUAC_VERSION}.war" \
    || curl -fsSL -o /opt/tomcat9/webapps/guacamole.war \
    "https://archive.apache.org/dist/guacamole/${GUAC_VERSION}/binary/guacamole-${GUAC_VERSION}.war"

  # Without this, guacd resolves "localhost" via getaddrinfo() and on many
  # Debian LXCs that comes back IPv6-first, so guacd binds only to ::1 while
  # Tomcat connects over IPv4 — every session then dies immediately with a
  # generic "An internal error has occurred within the Guacamole server".
  # Pinning both sides to the literal IPv4 loopback avoids the ambiguity.
  cat > /etc/guacamole/guacd.conf <<CONF
[server]
bind_host = 127.0.0.1
bind_port = ${GUACD_PORT}
CONF

  cat > /etc/guacamole/guacamole.properties <<PROPS
guacd-hostname: 127.0.0.1
guacd-port: ${GUACD_PORT}
PROPS

  if [ ! -f /etc/guacamole/user-mapping.xml ]; then
    cat > /etc/guacamole/user-mapping.xml <<MAP
<user-mapping>
  <authorize username="${GUAC_ADMIN_USER}" password="${GUAC_ADMIN_PASS}">
    <!-- add machines with: /opt/guacamole/add-machine.sh -->
  </authorize>
</user-mapping>
MAP
  fi
  chown -R tomcat:tomcat /etc/guacamole
  chmod 640 /etc/guacamole/user-mapping.xml
  ln -sf /etc/guacamole /opt/tomcat9/.guacamole

  if [ "${TOMCAT_PORT}" != "8080" ]; then
    sed -i "s/port=\"8080\"/port=\"${TOMCAT_PORT}\"/" /opt/tomcat9/conf/server.xml
  fi

  mkdir -p /opt/guacamole
  echo "$ADD_MACHINE_B64" | base64 -d > /opt/guacamole/add-machine.sh
  chmod +x /opt/guacamole/add-machine.sh

  chown -R tomcat:tomcat /opt/tomcat9

  systemctl enable -q --now guacd
  systemctl enable -q tomcat9
  systemctl restart tomcat9
'
ok "Guacamole web client deployed."

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
echo -e "  ${GN}1.${CL} Open Guacamole:  ${GN}http://${IP}:${TOMCAT_PORT}/guacamole${CL}"
echo -e "     Log in as  ${BL}${GUAC_ADMIN_USER}${CL} / ${BL}${GUAC_ADMIN_PASS}${CL}  (save this password!)"
echo -e "  ${GN}2.${CL} Add a machine:"
echo -e "       ${BL}pct exec $CTID -- /opt/guacamole/add-machine.sh${CL}"
echo -e "     (it prompts for name / protocol / host / port / login — or pass them as args)"
echo -e "  ${GN}3.${CL} In Guacamole, open the new connection once, then copy the URL from your"
echo -e "     browser's address bar (looks like  http://${ADDR}:${TOMCAT_PORT}/guacamole/#/client/XXXX )."
echo -e "  ${GN}4.${CL} In LabDash: Edit → + Add widget → ${BL}Remote desktops (RDP)${CL}, paste it as:"
echo -e "       ${BL}<Name> | <that URL>${CL}"
echo
if [[ "$INSTALL_TAILSCALE" == "yes" ]]; then
  echo -e "  ${YW}Remote access:${CL} once Tailscale is logged in, use the container's Tailscale"
  echo -e "  IP/name in step 3's URL so it works away from home. Do NOT expose Guacamole"
  echo -e "  directly to the internet — put it behind Tailscale or a VPN."
else
  echo -e "  ${YW}Heads-up:${CL} you're one click from RDP over the open web — install Tailscale"
  echo -e "  (rerun with INSTALL_TAILSCALE=yes) or put an HTTPS reverse proxy + VPN in front."
fi
echo -e "  ${YW}Note:${CL} guacd and Tomcat listen on the LAN only by default; LabDash's popup"
echo -e "  viewer just points an iframe at the URL above, same as any other embed."
echo
