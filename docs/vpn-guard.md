# VPN guard (`tools/vpn-guard/`)

A full-tunnel VPN sends all of a machine's IPv4 traffic to the far end. When the far end dies
(power cut, unplugged cable, broken config), the machine loses the internet with it, and agents and
scripts running there stop working. So NetworkManager's own autoconnect is off for that connection,
and vpn-guard decides instead.

A root systemd timer runs it one minute after boot and every 30 minutes after that:

- **VPN up:** if the internet works through the tunnel, it stays up; if not, vpn-guard disconnects,
  and the machine falls back to its own internet.
- **VPN down:** vpn-guard connects, then runs the same check, and disconnects again if it fails.

"Works through the tunnel" means an HTTPS request bound to the VPN interface reaches Google's or
Cloudflare's connectivity endpoint: three tries, five seconds apart. Binding to the interface keeps
the check from passing over the normal route while the tunnel is dead.

What it costs: when the far end dies while connected, the machine has no internet until the next
run, at most 30 minutes. When the far end is already dead at a run, the outage lasts only the check:
at most 70 seconds, three rounds of two 10-second requests with 5-second pauses.

## Install

Run as the desktop user, not root, with the name of the NetworkManager connection:

```bash
tools/vpn-guard/install.sh "<connection name>"
```

It does four things:

1. For a WireGuard connection whose private key or preshared key sits in the desktop keyring
   (KWallet or GNOME Keyring, flag "agent-owned"), it connects once from your session, reads the
   keys back from the running interface (`move-keys.sh`, as root), and writes them into the
   NetworkManager profile, which only root can read. At boot nobody is logged in to unlock the
   keyring, so a key there would block the connection.
2. It turns NetworkManager's autoconnect off for that connection.
3. It installs `/usr/local/bin/vpn-guard`, the service and timer units in `/etc/systemd/system/`,
   and `/etc/vpn-guard.conf`, which holds `VPN_GUARD_CONNECTION=<connection name>`.
4. It enables the timer and runs one check at once.

Rerun it after changing the script or the units.

### Keys not in the keyring

A profile can say a key is in the keyring when no keyring entry exists, for example after the
connection was imported. Then step 1 cannot connect and stops. Take the keys from the WireGuard
server's config for this peer (`PrivateKey` and `PresharedKey`), and write them into the profile
file under `/etc/NetworkManager/system-connections/` as root: `private-key=` in the `[wireguard]`
section, and `preshared-key=` in place of `preshared-key-flags=1` in the `[wireguard-peer.<key>]`
section. Then run `sudo nmcli connection load <file>` and rerun the install.

## Check it

```bash
systemctl list-timers vpn-guard.timer
journalctl -u vpn-guard.service -n 20 --no-pager
```

Each run logs what it did: staying connected, or connecting and then staying or disconnecting, with
the reason.

## Remove

```bash
sudo systemctl disable --now vpn-guard.timer
sudo rm /etc/systemd/system/vpn-guard.service /etc/systemd/system/vpn-guard.timer /usr/local/bin/vpn-guard /etc/vpn-guard.conf
sudo systemctl daemon-reload
```

The private key stays in the NetworkManager profile, and autoconnect stays off.
