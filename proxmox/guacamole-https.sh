#!/usr/bin/env bash
# ============================================================================
#  guacamole-https.sh — put Guacamole behind real HTTPS via Tailscale
#
#  Why: browsers only allow the clipboard API (native Ctrl+C/Ctrl+V into an
#  RDP session) over a "secure context" — HTTPS, or localhost. Guacamole
#  installed by guacamole.sh is plain HTTP on your LAN, so clipboard sync
#  silently doesn't work, in the popup OR a direct browser tab. This gets
#  you a real Let's Encrypt-backed cert (via Tailscale, no domain needed)
#  and a small nginx in front of Tomcat to terminate TLS with it.
#
#  Run this INSIDE the guacamole container (not the Proxmox host):
#    bash <(curl -fsSL https://raw.githubusercontent.com/ckeeley97/labdash/main/proxmox/guacamole-https.sh)
#
#  Prerequisites this script can't do for you:
#   1. The container needs a TUN device to run Tailscale inside an LXC.
#      If you already chose "yes" to Tailscale when guacamole.sh created
#      this container, you already have it. Otherwise, ON THE PROXMOX
#      HOST: add these two lines to /etc/pve/lxc/<CTID>.conf, then
#      `pct reboot <CTID>`:
#        lxc.cgroup2.devices.allow: c 10:200 rwm
#        lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
#   2. HTTPS certificates must be turned on for your tailnet once, in the
#      admin console: https://login.tailscale.com/admin/dns
#      (DNS page -> enable MagicDNS -> HTTPS Certificates -> Enable HTTPS)
#      This script checks for this and tells you if it's still off.
#
#  Every setting can be overridden with environment variables, e.g.:
#    HTTPS_PORT=8443 bash guacamole-https.sh
# ============================================================================
set -euo pipefail

HTTPS_PORT="${HTTPS_PORT:-443}"
TOMCAT_PORT="${TOMCAT_PORT:-8080}"
CERT_DIR="${CERT_DIR:-/etc/tailscale/certs}"
TS_AUTHKEY="${TS_AUTHKEY:-}"   # optional: unattended `tailscale up`

RD=$'\033[01;31m'; GN=$'\033[1;92m'; YW=$'\033[33m'; BL=$'\033[36m'; CL=$'\033[m'
msg()  { echo -e "${BL}[*]${CL} $1"; }
ok()   { echo -e "${GN}[✓]${CL} $1"; }
warn() { echo -e "${YW}[!]${CL} $1"; }
die()  { echo -e "${RD}[✗]${CL} $1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this as root inside the guacamole container."

# ------------------------------ TUN device ----------------------------------
if [[ ! -e /dev/net/tun ]]; then
  die "No /dev/net/tun in this container — Tailscale can't run yet. On the PROXMOX HOST, add these two lines to /etc/pve/lxc/<CTID>.conf (find <CTID> with 'pct list'), then 'pct reboot <CTID>' and rerun this script:
      lxc.cgroup2.devices.allow: c 10:200 rwm
      lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file"
fi

# ------------------------------ Tailscale ------------------------------------
if ! command -v tailscale >/dev/null 2>&1; then
  msg "Installing Tailscale…"
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
  systemctl enable -q --now tailscaled
  ok "Tailscale installed."
fi

if ! tailscale status >/dev/null 2>&1; then
  if [[ -n "$TS_AUTHKEY" ]]; then
    msg "Logging into Tailscale with the provided auth key…"
    tailscale up --authkey="$TS_AUTHKEY" >/dev/null 2>&1 || die "tailscale up failed — check TS_AUTHKEY."
  else
    warn "Tailscale isn't logged in yet."
    echo -e "      Run this, open the printed URL in a browser to authenticate, then rerun this script:"
    echo -e "      ${BL}tailscale up${CL}"
    exit 1
  fi
fi
ok "Tailscale is up."

# --------------------------- work out our DNS name ---------------------------
command -v jq >/dev/null 2>&1 || { msg "Installing jq…"; apt-get -qq update >/dev/null; apt-get -qq install -y jq >/dev/null; }
DNS_NAME=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName' | sed 's/\.$//')
[[ -n "$DNS_NAME" && "$DNS_NAME" != "null" ]] || die "Couldn't work out this device's Tailscale DNS name — is MagicDNS enabled for your tailnet? https://login.tailscale.com/admin/dns"
ok "This device's Tailscale name: $DNS_NAME"

# ------------------------------- get the cert ---------------------------------
mkdir -p "$CERT_DIR"
msg "Requesting a cert for $DNS_NAME…"
if ! tailscale cert --cert-file="$CERT_DIR/$DNS_NAME.crt" --key-file="$CERT_DIR/$DNS_NAME.key" "$DNS_NAME" 2>/tmp/tscert.err; then
  cat /tmp/tscert.err >&2
  rm -f /tmp/tscert.err
  die "Couldn't get a certificate. This almost always means HTTPS certificates aren't turned on for your tailnet yet — enable them at https://login.tailscale.com/admin/dns (DNS page -> HTTPS Certificates -> Enable HTTPS), then rerun this script."
fi
rm -f /tmp/tscert.err
ok "Certificate saved to $CERT_DIR/$DNS_NAME.{crt,key}"

# --------------------------- nginx: TLS in front of Tomcat --------------------
msg "Installing nginx as a TLS-terminating reverse proxy…"
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update >/dev/null
apt-get -qq install -y nginx >/dev/null

cat > /etc/nginx/sites-available/guacamole-https.conf <<CONF
server {
    listen ${HTTPS_PORT} ssl;
    listen [::]:${HTTPS_PORT} ssl;
    server_name ${DNS_NAME};

    ssl_certificate     ${CERT_DIR}/${DNS_NAME}.crt;
    ssl_certificate_key ${CERT_DIR}/${DNS_NAME}.key;

    location / {
        proxy_pass http://127.0.0.1:${TOMCAT_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        # Guacamole's own client needs its WebSocket tunnel to survive this hop.
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
CONF

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/guacamole-https.conf /etc/nginx/sites-enabled/guacamole-https.conf
nginx -t
systemctl enable -q --now nginx
systemctl reload nginx
ok "nginx listening on :${HTTPS_PORT} with a trusted cert for $DNS_NAME."

# --------------------------- renewal (Tailscale certs need it) ----------------
cat > /usr/local/sbin/guacamole-cert-renew.sh <<RENEW
#!/usr/bin/env bash
set -euo pipefail
OLD=\$(sha256sum "$CERT_DIR/$DNS_NAME.crt" 2>/dev/null | cut -d' ' -f1 || true)
tailscale cert --cert-file="$CERT_DIR/$DNS_NAME.crt" --key-file="$CERT_DIR/$DNS_NAME.key" "$DNS_NAME"
NEW=\$(sha256sum "$CERT_DIR/$DNS_NAME.crt" | cut -d' ' -f1)
[ "\$OLD" = "\$NEW" ] || systemctl reload nginx
RENEW
chmod +x /usr/local/sbin/guacamole-cert-renew.sh

cat > /etc/systemd/system/guacamole-cert-renew.service <<UNIT
[Unit]
Description=Renew this container's Tailscale HTTPS cert for Guacamole

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/guacamole-cert-renew.sh
UNIT

cat > /etc/systemd/system/guacamole-cert-renew.timer <<UNIT
[Unit]
Description=Daily check/renewal of the Guacamole HTTPS cert

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable -q --now guacamole-cert-renew.timer
ok "Renewal timer installed (checks daily — Tailscale certs are valid 90 days)."

# -------------------------------- summary --------------------------------------
PORT_SUFFIX=""
[[ "$HTTPS_PORT" != "443" ]] && PORT_SUFFIX=":${HTTPS_PORT}"

echo
ok  "All done!"
echo
echo -e "  ${GN}1.${CL} Guacamole is now reachable at:  ${GN}https://${DNS_NAME}${PORT_SUFFIX}/guacamole${CL}"
echo -e "     (only from devices on your tailnet — this isn't exposed to the internet)"
echo -e "  ${GN}2.${CL} In LabDash's Remote desktops widget, update each machine's URL to use"
echo -e "     that https:// host instead of the old http://<LAN-IP>:8080 one, and"
echo -e "     ${BL}untick \"Proxy\"${CL} — you're now reaching Guacamole directly over a secure"
echo -e "     connection, so LabDash doesn't need to fetch it server-side any more."
echo -e "  ${GN}3.${CL} Native clipboard sync (Ctrl+C/Ctrl+V into the RDP session) should now"
echo -e "     work directly — Guacamole's own manual clipboard box (Ctrl+Alt+Shift menu)"
echo -e "     still works too, as a fallback."
echo
echo -e "  ${YW}Note:${CL} you'll need a Tailscale client running on whatever device you're"
echo -e "  browsing from too, since ${BL}${DNS_NAME}${CL} only resolves/routes over your tailnet."
echo
