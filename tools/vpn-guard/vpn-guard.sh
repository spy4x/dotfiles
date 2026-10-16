#!/usr/bin/env bash
# Keeps a full-tunnel NetworkManager VPN connected only while the internet works through it.
# vpn-guard.timer runs it as root at boot and every 30 minutes. Docs: docs/vpn-guard.md.
#
# VPN up:   internet through the tunnel works → stay; it does not → disconnect.
# VPN down: connect, then the same check; it fails → disconnect, so the machine keeps its own
#           internet instead of a dead tunnel.
#
# Exit code 1 only when a disconnect fails: then the machine may be left without internet.
set -uo pipefail

CONFIG="${VPN_GUARD_CONFIG:-/etc/vpn-guard.conf}"
if [ -z "${VPN_GUARD_CONNECTION:-}" ] && [ -r "$CONFIG" ]; then
  VPN_GUARD_CONNECTION="$(sed -n 's/^VPN_GUARD_CONNECTION=//p' "$CONFIG" | tail -n 1)"
fi
CONNECTION="${VPN_GUARD_CONNECTION:-}"
if [ -z "$CONNECTION" ]; then
  echo "vpn-guard: no connection name; set VPN_GUARD_CONNECTION in $CONFIG" >&2
  exit 2
fi
TRIES="${VPN_GUARD_TRIES:-3}"
DELAY="${VPN_GUARD_RETRY_DELAY:-5}"
URLS=(https://www.gstatic.com/generate_204 https://cloudflare.com/cdn-cgi/trace)

log() { echo "vpn-guard: $*"; }

is_active() {
  nmcli -g GENERAL.STATE connection show "$CONNECTION" 2>/dev/null | grep -q '^activated$'
}

# True when an HTTPS request bound to the VPN interface succeeds, so it cannot pass around the
# tunnel. Two sites, a few tries, so one slow site does not drop a working VPN.
internet_through_vpn() {
  local iface try url
  iface="$(nmcli -g connection.interface-name connection show "$CONNECTION" 2>/dev/null)"
  if [ -z "$iface" ]; then
    log "connection \"$CONNECTION\" has no interface name"
    return 1
  fi
  for ((try = 1; try <= TRIES; try++)); do
    for url in "${URLS[@]}"; do
      curl -4 -fsS -o /dev/null --max-time 10 --interface "$iface" "$url" 2>/dev/null && return 0
    done
    ((try < TRIES)) && sleep "$DELAY"
  done
  return 1
}

disconnect() {
  log "$1: disconnecting"
  if ! nmcli connection down "$CONNECTION" >/dev/null 2>&1 && is_active; then
    log "disconnect failed; the machine may have no internet"
    exit 1
  fi
}

if is_active; then
  if internet_through_vpn; then
    log "VPN up and the internet works through it: staying connected"
  else
    disconnect "VPN up but no internet through it"
  fi
  exit 0
fi

log "VPN down: connecting"
if ! nmcli --wait 30 connection up "$CONNECTION" >/dev/null 2>&1; then
  disconnect "could not connect"
  exit 0
fi
if internet_through_vpn; then
  log "connected and the internet works through the VPN: staying connected"
else
  disconnect "connected but no internet through the VPN"
fi
