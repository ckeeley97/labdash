#!/usr/bin/env bash
# ============================================================================
#  ring-add-cameras.sh — write your Ring cameras into go2rtc.yaml
#
#  go2rtc's "Add > Ring" web flow discovers cameras but sometimes won't save
#  them. This does the equivalent from the shell: it takes a Ring refresh
#  token, looks up each camera's device_id, writes a proper `streams:` block
#  to /opt/go2rtc/go2rtc.yaml, and restarts go2rtc.
#
#  Run it INSIDE the go2rtc container (get a fresh token first):
#    /opt/go2rtc/get-ring-token.sh          # copy the printed token
#    bash <(curl -fsSL https://raw.githubusercontent.com/ckeeley97/labdash/main/proxmox/ring-add-cameras.sh)
#
#  Or pass the token as an argument:
#    ring-add-cameras.sh "<refresh_token>"
# ============================================================================
set -euo pipefail

PORT="${GO2RTC_PORT:-1984}"
YAML="${GO2RTC_YAML:-/opt/go2rtc/go2rtc.yaml}"

# --- ensure Node 20+ (ring-client-api needs it) and jq ---------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 20 ] 2>/dev/null && need_node=0
fi
export DEBIAN_FRONTEND=noninteractive
if [ "$need_node" = 1 ]; then
  echo "Installing Node.js 22 (one-time)…"
  apt-get remove -y -qq nodejs npm >/dev/null 2>&1 || true
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
command -v jq >/dev/null 2>&1 || { echo "Installing jq…"; apt-get install -y -qq jq >/dev/null; }

# --- get the refresh token -------------------------------------------------
RING_TOKEN="${1:-}"
if [ -z "$RING_TOKEN" ]; then
  echo "Paste your Ring refresh token (from get-ring-token.sh), then press Enter:"
  read -r RING_TOKEN
fi
[ -n "${RING_TOKEN:-}" ] || { echo "No token given. Aborting."; exit 1; }

# --- look up cameras with ring-client-api ----------------------------------
echo "Fetching your Ring cameras (installing the Ring library, ~1 min)…"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
( cd "$WORK" && npm init -y >/dev/null 2>&1 && npm install ring-client-api >/dev/null 2>&1 ) \
  || { echo "npm install of ring-client-api failed."; exit 1; }

cat > "$WORK/enum.js" <<'JS'
const { RingApi } = require('ring-client-api');
(async () => {
  const seed = process.env.RING_TOKEN;
  let latest = seed;
  const api = new RingApi({ refreshToken: seed, cameraStatusPollingSeconds: 0 });
  api.onRefreshTokenUpdated.subscribe((d) => { if (d && d.newRefreshToken) latest = d.newRefreshToken; });
  const cams = await api.getCameras();
  await new Promise((r) => setTimeout(r, 500));
  // go2rtc's ring source needs refresh_token + camera_id (numeric) + device_id
  // (a separate string) — all three, or it returns "ring: wrong query".
  // The token is URL-encoded because go2rtc runs url.QueryUnescape on it.
  process.stdout.write(JSON.stringify({ token: encodeURIComponent(latest), cameras: cams.map((c) => ({ camera_id: c.id, device_id: (c.data && c.data.device_id) || '', name: c.name })) }));
  process.exit(0);
})().catch((e) => { process.stderr.write('RINGERR:' + (e && e.message ? e.message : String(e))); process.exit(1); });
JS

OUT=$(cd "$WORK" && RING_TOKEN="$RING_TOKEN" node enum.js 2>"$WORK/err") || {
  echo "Could not query Ring:"; sed 's/^RINGERR:/  /' "$WORK/err"; exit 1;
}

NEWTOKEN=$(printf '%s' "$OUT" | jq -r '.token')
COUNT=$(printf '%s' "$OUT" | jq '.cameras | length')
[ "${COUNT:-0}" -gt 0 ] || { echo "Ring returned no cameras on this account."; exit 1; }

# --- write go2rtc.yaml -----------------------------------------------------
{
  echo "api:"
  echo "  listen: \":${PORT}\""
  echo "streams:"
  printf '%s' "$OUT" | jq -r '.cameras[] | "\(.camera_id)\t\(.device_id)\t\(.name)"' | while IFS=$'\t' read -r cid did name; do
    slug=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//')
    [ -n "$slug" ] || slug="cam_${cid}"
    [ -n "$did" ] || echo "  WARNING: no device_id for '${name}' — go2rtc will reject it" >&2
    echo "  ${slug}: \"ring:?refresh_token=${NEWTOKEN}&camera_id=${cid}&device_id=${did}\""
  done
} > "$YAML"

id -u go2rtc >/dev/null 2>&1 && chown go2rtc:go2rtc "$YAML" || true
chmod 600 "$YAML"
systemctl restart go2rtc 2>/dev/null || true

echo
echo "Wrote ${COUNT} camera(s) to ${YAML} and restarted go2rtc."
echo "Verify:  curl -s http://localhost:${PORT}/api/streams"
echo "Then:    /opt/go2rtc/print-cameras.sh <host-or-tailscale-ip>"
