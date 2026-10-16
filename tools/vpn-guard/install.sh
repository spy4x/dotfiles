#!/usr/bin/env bash
# Installs vpn-guard for one NetworkManager VPN connection. Run as the desktop user, not root:
# the connection's private key may sit in that user's keyring, and only their session can read
# it. Uses sudo for the system files. Docs: docs/vpn-guard.md.
#
#   tools/vpn-guard/install.sh "<connection name>"
set -euo pipefail

CONNECTION="${1:?usage: install.sh \"<NetworkManager connection name>\"}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" = 0 ]; then
  echo "Run this as the desktop user, not root." >&2
  exit 1
fi
nmcli -g connection.id connection show "$CONNECTION" >/dev/null

# At boot nobody is logged in to unlock the keyring, so a WireGuard key kept there ("agent-owned")
# cannot be read. Bring the VPN up once from this session, so the keyring hands NetworkManager the
# keys, read them back from the kernel, and write them into the root-only profile file.
if [ "$(nmcli -g connection.type connection show "$CONNECTION")" = wireguard ]; then
  uuid="$(nmcli -g connection.uuid connection show "$CONNECTION")"
  file="$(nmcli -t -f UUID,FILENAME connection show | sed -n "s/^$uuid://p")"
  iface="$(nmcli -g connection.interface-name connection show "$CONNECTION")"
  if sudo grep -q -E '^(private|preshared)-key-flags=[123567]' "$file"; then
    nmcli -g GENERAL.STATE connection show "$CONNECTION" | grep -q '^activated$' ||
      nmcli --wait 30 connection up "$CONNECTION" >/dev/null || {
        echo "Could not connect from this session: the keyring holds no key for it. Write the keys" >&2
        echo "into $file by hand (docs/vpn-guard.md, \"Keys not in the keyring\") and rerun." >&2
        exit 1
      }
    sudo bash "$HERE/move-keys.sh" "$iface" "$file"
    echo "WireGuard keys moved from the keyring into $file."
  fi
fi

# vpn-guard alone decides when the VPN connects; NetworkManager's autoconnect would bring a dead
# tunnel up at boot and cut the internet until the next check.
nmcli connection modify "$CONNECTION" connection.autoconnect no

sudo install -m 755 "$HERE/vpn-guard.sh" /usr/local/bin/vpn-guard
sudo install -m 644 "$HERE/vpn-guard.service" "$HERE/vpn-guard.timer" /etc/systemd/system/
printf 'VPN_GUARD_CONNECTION=%s\n' "$CONNECTION" | sudo tee /etc/vpn-guard.conf >/dev/null
sudo chmod 644 /etc/vpn-guard.conf
if command -v restorecon >/dev/null; then
  sudo restorecon /usr/local/bin/vpn-guard /etc/vpn-guard.conf \
    /etc/systemd/system/vpn-guard.service /etc/systemd/system/vpn-guard.timer
fi
sudo systemctl daemon-reload
sudo systemctl enable --now vpn-guard.timer
sudo systemctl start vpn-guard.service
journalctl -u vpn-guard.service -n 5 --no-pager -o cat
