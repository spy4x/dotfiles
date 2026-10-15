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
# Anthropic's signing key, as published in the Claude Desktop on Linux docs.
KEY_FPR=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
STAMP=/opt/claude-desktop/.deb-version

fail() {
  echo "$1" >&2
  exit 1
}

tmp=$(mktemp -d)
trap 'find "$tmp" -delete' EXIT

# Check the chain apt checks: the signed release file, the package index's checksum in it, and
# the package's checksum in the index. Everything below runs as root, so nothing unsigned does.
curl -fsS --max-time 60 --output "$tmp/key.asc" "https://downloads.claude.ai/claude-desktop/key.asc"
fpr=$(GNUPGHOME="$tmp" gpg --batch --quiet --with-colons --show-keys "$tmp/key.asc" |
  awk -F: '$1 == "fpr" { print $10; exit }')
[ "$fpr" = "$KEY_FPR" ] || fail "signing key fingerprint is $fpr, expected $KEY_FPR"
GNUPGHOME="$tmp" gpg --batch --quiet --dearmor --output "$tmp/key.gpg" "$tmp/key.asc"
curl -fsS --max-time 60 --output "$tmp/InRelease" "$REPO/dists/stable/InRelease"
gpgv --quiet --keyring "$tmp/key.gpg" --output "$tmp/Release" "$tmp/InRelease" 2>/dev/null ||
  fail "repository signature does not verify"

index_sha=$(awk '$1 ~ /^[0-9a-f]{64}$/ && $3 == "main/binary-amd64/Packages" { print $1; exit }' \
  "$tmp/Release")
[ -n "$index_sha" ] || fail "signed release file lists no package index"
curl -fsS --max-time 60 --output "$tmp/Packages" "$REPO/dists/stable/main/binary-amd64/Packages"
echo "$index_sha  $tmp/Packages" | sha256sum --check --quiet - ||
  fail "package index checksum does not match the signed release file"

read -r latest_path latest_sha < <(awk '
  /^Package: / { pkg = $2 }
  /^Filename: / { file = $2 }
  /^SHA256: / { sha = $2 }
  /^$/ { if (pkg == "claude-desktop") print file, sha; pkg = "" }
  END { if (pkg == "claude-desktop") print file, sha }
' "$tmp/Packages" | sort -V | tail -n1) || true
[ -n "${latest_path:-}" ] && [ -n "${latest_sha:-}" ] || fail "could not read repository index"

latest_ver=${latest_path##*claude-desktop_}
latest_ver=${latest_ver%_amd64.deb}
current_ver=$(cat "$STAMP" 2>/dev/null || echo none)

if [ "$latest_ver" = "$current_ver" ] && [ "$force" = false ]; then
  echo "Claude Desktop $current_ver is current"
  exit 0
fi
echo "updating Claude Desktop: $current_ver -> $latest_ver"

curl -fsSL --max-time 900 --output "$tmp/pkg.deb" "$REPO/$latest_path"
echo "$latest_sha  $tmp/pkg.deb" | sha256sum --check --quiet - ||
  fail "package checksum does not match the signed index"
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
  # Closing a dialog can return non-zero, so the fallback runs only when kdialog is missing.
  if command -v kdialog >/dev/null; then
    kdialog --title "Claude Desktop" --msgbox "$msg" || true
  elif command -v zenity >/dev/null; then
    zenity --info --title "Claude Desktop" --text "$msg" || true
  else
    echo "could not show the update dialog: no kdialog or zenity" >&2
  fi
fi
