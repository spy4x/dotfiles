#!/usr/bin/env bash
# Install or update Claude Desktop on Fedora from Anthropic's official Debian package.
#
# Anthropic publishes the Linux app only for Debian and Ubuntu, through an apt repository. The app
# never updates itself on Linux, so on Fedora nothing updates it unless this script runs. It
# unpacks the newest .deb into /opt/claude-desktop and links the launcher, the menu entry and the
# icons under /usr/local. Quit and reopen the app after an update to start the new version.
#
#   --force   reinstall the current version
#   --notify  after an update, show a dialog that stays until it is closed (the nightly timer)
set -euo pipefail

force=false
notify=false
for arg in "$@"; do
  case "$arg" in
  --force) force=true ;;
  --notify) notify=true ;;
  *)
    echo "unknown argument: $arg" >&2
    exit 2
    ;;
  esac
done

REPO="https://downloads.claude.ai/claude-desktop/apt/stable"
STAMP=/opt/claude-desktop/.deb-version

latest_path=$(curl -fsS --max-time 60 "$REPO/dists/stable/main/binary-amd64/Packages" |
  grep '^Filename: pool/main/c/claude-desktop/claude-desktop_' |
  sort -V | tail -n1 | cut -d' ' -f2)
[ -n "$latest_path" ] || {
  echo "could not read repository index" >&2
  exit 1
}

latest_ver=${latest_path##*claude-desktop_}
latest_ver=${latest_ver%_amd64.deb}
current_ver=$(cat "$STAMP" 2>/dev/null || echo none)

if [ "$latest_ver" = "$current_ver" ] && [ "$force" = false ]; then
  echo "Claude Desktop $current_ver is current"
  exit 0
fi
echo "updating Claude Desktop: $current_ver -> $latest_ver"

tmp=$(mktemp -d)
trap 'find "$tmp" -delete' EXIT
curl -fsSL --max-time 900 --output "$tmp/pkg.deb" "$REPO/$latest_path"
(cd "$tmp" && ar x pkg.deb && mkdir stage && tar -xf data.tar.* -C stage)

src="$tmp/stage/usr"
sudo -n rm -rf /opt/claude-desktop
sudo -n cp -a "$src/lib/claude-desktop" /opt/claude-desktop
sudo -n chown -R root:root /opt/claude-desktop
sudo -n chmod 4755 /opt/claude-desktop/chrome-sandbox
sudo -n ln -sfn /opt/claude-desktop/claude-desktop /usr/local/bin/claude-desktop
sudo -n install -Dm644 "$src/share/applications/com.anthropic.Claude.desktop" \
  /usr/local/share/applications/com.anthropic.Claude.desktop
for sz in 16 32 48 128 256; do
  sudo -n install -Dm644 "$src/share/icons/hicolor/${sz}x${sz}/apps/claude-desktop.png" \
    "/usr/local/share/icons/hicolor/${sz}x${sz}/apps/claude-desktop.png"
done
echo "$latest_ver" | sudo -n tee "$STAMP" >/dev/null
sudo -n update-desktop-database /usr/local/share/applications 2>/dev/null || true
sudo -n gtk-update-icon-cache -qf /usr/local/share/icons/hicolor 2>/dev/null || true
echo "Claude Desktop $latest_ver installed"

# The dialog can stay open for hours; free the unpacked package in /tmp first.
find "$tmp" -delete
trap - EXIT

if [ "$notify" = true ]; then
  msg="Claude Desktop updated. Restart the app."
  kdialog --title "Claude Desktop" --msgbox "$msg" 2>/dev/null ||
    zenity --info --title "Claude Desktop" --text "$msg" 2>/dev/null ||
    echo "could not show the update dialog" >&2
fi
