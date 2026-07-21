#!/usr/bin/env bash
# ============================================================================
#  reolink-add-cameras.sh — write your Reolink cameras into go2rtc.yaml
#
#  Wired/PoE Reolink cameras expose a local RTSP stream, so there is no cloud
#  login and no token: you give this script each camera's LAN IP plus a login,
#  it PROBES the camera to find the working RTSP path (Reolink bakes the codec
#  into the path — h264… vs h265…, main vs sub), writes a proper `streams:`
#  block to /opt/go2rtc/go2rtc.yaml, and restarts go2rtc.
#
#  Run it INSIDE the go2rtc container:
#    /opt/go2rtc/reolink-add-cameras.sh
#  or, straight from the repo:
#    bash <(curl -fsSL https://raw.githubusercontent.com/ckeeley97/labdash/main/proxmox/reolink-add-cameras.sh)
#
#  Non-interactive (env vars):
#    RTSP_USER=viewer RTSP_PASS='s3cret' \
#    CAMERAS="front_door=192.168.1.51, back_yard=192.168.1.52" \
#    STREAM=main /opt/go2rtc/reolink-add-cameras.sh
#
#  Per-camera login / port override in an entry:
#    CAMERAS="drive=admin:pw@192.168.1.53:554, shed=192.168.1.54"
#
#  Battery Reolink cameras (Argus / Go / Wireless) have NO local RTSP stream
#  and cannot be added this way — use a wired/PoE model or the Reolink app.
# ============================================================================
set -euo pipefail

PORT="${GO2RTC_PORT:-1984}"
YAML="${GO2RTC_YAML:-/opt/go2rtc/go2rtc.yaml}"
STREAM="${STREAM:-main}"          # main (higher res) or sub (lower res, lighter)
RTSP_PORT_DEFAULT="${RTSP_PORT:-554}"

RD=$'\033[01;31m'; GN=$'\033[1;92m'; YW=$'\033[33m'; CL=$'\033[m'
die() { echo -e "${RD}[✗]${CL} $1" >&2; exit 1; }

case "$STREAM" in main|sub) ;; *) die "STREAM must be 'main' or 'sub' (got '$STREAM')." ;; esac

# --- dependencies (present after go2rtc-reolink.sh, but be defensive) -------
export DEBIAN_FRONTEND=noninteractive
need_pkgs=()
command -v jq      >/dev/null 2>&1 || need_pkgs+=(jq)
command -v ffprobe >/dev/null 2>&1 || need_pkgs+=(ffmpeg)
if [ "${#need_pkgs[@]}" -gt 0 ]; then
  echo "Installing ${need_pkgs[*]}…"
  apt-get -qq update >/dev/null 2>&1 || true
  apt-get -qq install -y "${need_pkgs[@]}" >/dev/null
fi

# --- url-encode a string for use in an RTSP userinfo field -----------------
urlenc() { jq -rn --arg s "$1" '$s|@uri'; }

# --- gather credentials ----------------------------------------------------
RTSP_USER="${RTSP_USER:-}"
RTSP_PASS="${RTSP_PASS:-}"
if [ -z "$RTSP_USER" ]; then
  read -r -p "Reolink camera username (a viewer account is safest): " RTSP_USER
fi
if [ -z "$RTSP_PASS" ]; then
  read -r -s -p "Reolink camera password: " RTSP_PASS; echo
fi
[ -n "$RTSP_USER" ] || die "No username given."

# --- gather the camera list ------------------------------------------------
CAMERAS="${CAMERAS:-}"
if [ -z "$CAMERAS" ]; then
  echo
  echo "Enter your cameras, one per line, as  name=ip  (e.g.  front_door=192.168.1.51)."
  echo "Optional per-camera login/port:  name=user:pass@ip:port"
  echo "Press Enter on a blank line when done."
  CAMERAS=""
  while true; do
    read -r -p "  camera> " line || break
    [ -z "$line" ] && break
    CAMERAS+="$line"$'\n'
  done
fi
# split entries on commas / newlines (NOT spaces — camera names may contain them),
# then trim surrounding whitespace and drop blank lines
mapfile -t ENTRIES < <(printf '%s' "$CAMERAS" | tr ',' '\n' \
  | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d')
[ "${#ENTRIES[@]}" -gt 0 ] || die "No cameras given."

# --- candidate RTSP paths, in probe order ----------------------------------
if [ "$STREAM" = "main" ]; then
  PATHS=(h264Preview_01_main h265Preview_01_main Preview_01_main)
else
  PATHS=(h264Preview_01_sub h265Preview_01_sub Preview_01_sub)
fi

# probe one rtsp url; prints the codec name on success, empty on failure
probe() {
  timeout 20 ffprobe -v error -rtsp_transport tcp -timeout 6000000 \
    -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$1" 2>/dev/null || true
}

echo
echo "Probing cameras (${STREAM} stream)…"

# --- build the streams: block ----------------------------------------------
declare -a LINES
declare -a SLUGS
ok_count=0
for entry in "${ENTRIES[@]}"; do
  name="${entry%%=*}"
  target="${entry#*=}"
  [ "$name" = "$entry" ] && die "Bad entry '$entry' — expected name=ip."

  # per-entry credentials?  user:pass@host
  euser="$RTSP_USER"; epass="$RTSP_PASS"; host="$target"
  if [[ "$target" == *"@"* ]]; then
    creds="${target%@*}"; host="${target##*@}"
    euser="${creds%%:*}"; epass="${creds#*:}"
  fi
  # host[:port]
  if [[ "$host" == *:* ]]; then
    hport="${host##*:}"; host="${host%%:*}"
  else
    hport="$RTSP_PORT_DEFAULT"
  fi

  slug=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//')
  [ -n "$slug" ] || slug="cam_${ok_count}"

  ue=$(urlenc "$euser"); pe=$(urlenc "$epass")

  found=""
  for p in "${PATHS[@]}"; do
    url="rtsp://${ue}:${pe}@${host}:${hport}/${p}"
    codec=$(probe "$url")
    if [ -n "$codec" ]; then
      found="$url"
      echo -e "  ${GN}✓${CL} ${name}  →  /${p}  (${codec})"
      break
    fi
  done

  if [ -z "$found" ]; then
    echo -e "  ${YW}!${CL} ${name} (${host}:${hport}) — no working RTSP path found; writing h264 ${STREAM} anyway."
    echo -e "      Check: RTSP enabled on the camera, the login is right, and it's reachable from here."
    found="rtsp://${ue}:${pe}@${host}:${hport}/${PATHS[0]}"
  else
    ok_count=$((ok_count + 1))
  fi

  LINES+=("  ${slug}: \"${found}\"")
  SLUGS+=("$slug")
done

[ "${#LINES[@]}" -gt 0 ] || die "Nothing to write."

# --- back up and write go2rtc.yaml -----------------------------------------
[ -f "$YAML" ] && cp -f "$YAML" "${YAML}.bak"
{
  echo "api:"
  echo "  listen: \":${PORT}\""
  echo "streams:"
  for l in "${LINES[@]}"; do echo "$l"; done
} > "$YAML"

id -u go2rtc >/dev/null 2>&1 && chown go2rtc:go2rtc "$YAML" || true
chmod 600 "$YAML"
systemctl restart go2rtc 2>/dev/null || true

echo
echo -e "${GN}Wrote ${#LINES[@]} camera(s)${CL} to ${YAML} and restarted go2rtc."
[ -f "${YAML}.bak" ] && echo "Previous config backed up to ${YAML}.bak"
echo "Verify:  curl -s http://localhost:${PORT}/api/streams | jq 'keys'"
echo "Then:    /opt/go2rtc/print-cameras.sh <host-or-tailscale-ip>"
