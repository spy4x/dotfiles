#!/usr/bin/env bash
# Writes a WireGuard connection's keys, read from the running interface, into its NetworkManager
# profile file, so the connection no longer needs the desktop keyring. install.sh runs it as root
# while the VPN is up. The keys are read here, so they never appear in a command line.
#
#   move-keys.sh <interface> <profile file>
set -euo pipefail
iface="${1:?interface}" file="${2:?profile file}"
private="$(wg show "$iface" private-key)"
psks="$(wg show "$iface" preshared-keys)"
# A hidden name, so NetworkManager never loads the half-written file.
tmp="$(mktemp "$(dirname "$file")/.vpn-guard.XXXXXX")"
trap 'find "$tmp" -delete 2>/dev/null || true' EXIT
awk -v private="$private" -v psks="$psks" '
  BEGIN { n = split(psks, lines, "\n"); for (i = 1; i <= n; i++) { split(lines[i], f, "\t"); psk[f[1]] = f[2] } }
  function flush() {
    if (peer == "") return
    # A peer without a preshared key: mark it "not required", or NetworkManager asks for one.
    if (psk[peer] == "" || psk[peer] == "(none)") print "preshared-key-flags=4"
    else print "preshared-key=" psk[peer]
    peer = ""
  }
  /^\[/ { flush(); section = $0; if (section ~ /^\[wireguard-peer\./) { peer = substr(section, 17, length(section) - 17) } }
  section == "[wireguard]" && /^private-key(-flags)?=/ { next }
  /^preshared-key(-flags)?=/ && peer != "" { next }
  /^$/ { flush() }
  { print }
  section == "[wireguard]" && /^\[wireguard\]$/ { print "private-key=" private }
  END { flush() }
' "$file" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$file"
command -v restorecon >/dev/null && restorecon "$file"
nmcli connection load "$file"
