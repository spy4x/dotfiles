#!/usr/bin/env bash
# Install or update Claude Desktop on Fedora from Anthropic's official Debian package.
#
# Anthropic publishes the Linux app only for Debian and Ubuntu, through an apt repository. The app
# never updates itself on Linux, so on Fedora nothing updates it unless this script runs. It
# unpacks the newest .deb into /opt/claude-desktop and links the launcher, the menu entry and the
# icons under /usr/local. Quit and reopen the app after an update to start the new version.
#
#   --force   reinstall the current version
#   --notify  show a dialog after an update or a failure; it stays until it is closed (the
#             nightly timer)
set -Eeuo pipefail
# Only system binaries: the user's PATH starts with directories any user tool can write to.
PATH=/usr/bin:/usr/sbin

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
# Anthropic's signing key, committed next to this script so that nothing downloaded decides what
# is trusted. Fingerprint 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE, as the Linux docs publish it.
KEY="$(dirname "$(realpath "$0")")/claude-desktop-archive-keyring.asc"
STAMP=/opt/claude-desktop/.deb-version

# dialog <kind> <text>: kind is `info` or `error`. Closing a dialog can return non-zero, so the
# zenity fallback runs only when kdialog is missing.
dialog() {
  if command -v kdialog >/dev/null; then
    if [ "$1" = error ]; then
      kdialog --title "Claude Desktop" --error "$2" || true
    else
      kdialog --title "Claude Desktop" --msgbox "$2" || true
    fi
  elif command -v zenity >/dev/null; then
    zenity "--$1" --title "Claude Desktop" --text "$2" || true
  else
    echo "could not show the dialog: no kdialog or zenity" >&2
  fi
}

error=""
fail() {
  error="$1"
  echo "$1" >&2
  exit 1
}

# A failure frees the temp folder first, then, with --notify, says what failed in a dialog
# instead of only in the journal.
finish() {
  local status=$?
  [ -n "${tmp:-}" ] && [ -d "$tmp" ] && find "$tmp" -delete
  if [ "$status" -ne 0 ] && [ "$notify" = true ]; then
    dialog error "Claude Desktop update failed: ${error:-exit status $status}

Details: journalctl --user -u claude-desktop-update.service"
  fi
}
trap 'error="${error:-line $LINENO: $BASH_COMMAND (exit $?)}"' ERR
trap finish EXIT

tmp=$(mktemp -d)

# fetch <max seconds> <output file> <url>. Retries cover a run at login before the network is up.
fetch() {
  curl -fsSL --max-time "$1" --retry 3 --retry-delay 20 --retry-all-errors --output "$2" "$3"
}

# Check the chain apt checks: the signed release file, the package index's checksum in it, and
# the package's checksum in the index. The install runs as root, so nothing unsigned may reach it.
GNUPGHOME="$tmp" gpg --batch --quiet --dearmor --output "$tmp/key.gpg" "$KEY"
fetch 60 "$tmp/InRelease" "$REPO/dists/stable/InRelease"
gpgv --quiet --keyring "$tmp/key.gpg" --output "$tmp/Release" "$tmp/InRelease" 2>/dev/null ||
  fail "repository signature does not verify"
# apt's replay guard: an old, validly signed index could otherwise roll the app back.
valid_until=$(sed -n 's/^Valid-Until: //p' "$tmp/Release")
[ -n "$valid_until" ] || fail "signed release file has no Valid-Until date"
[ "$(date -d "$valid_until" +%s)" -gt "$(date +%s)" ] ||
  fail "repository index expired on $valid_until"

index_sha=$(awk '$1 ~ /^[0-9a-f]{64}$/ && $3 == "main/binary-amd64/Packages" { print $1; exit }' \
  "$tmp/Release")
[ -n "$index_sha" ] || fail "signed release file lists no package index"
fetch 60 "$tmp/Packages" "$REPO/dists/stable/main/binary-amd64/Packages"
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
newer=$(printf '%s\n%s\n' "$current_ver" "$latest_ver" | sort -V | tail -n1)
if [ "$current_ver" != none ] && [ "$latest_ver" != "$current_ver" ] &&
  [ "$newer" = "$current_ver" ]; then
  fail "repository offers $latest_ver, older than the installed $current_ver"
fi
echo "updating Claude Desktop: $current_ver -> $latest_ver"

fetch 900 "$tmp/pkg.deb" "$REPO/$latest_path"
echo "$latest_sha  $tmp/pkg.deb" | sha256sum --check --quiet - ||
  fail "package checksum does not match the signed index"
(cd "$tmp" && ar x pkg.deb && mkdir stage && tar -xf data.tar.* -C stage)

src="$tmp/stage/usr"
# Build the new version beside the old one, then swap the two, so a failed step leaves the old
# app in place. The old one stays as claude-desktop.old until the next update: a running app
# still loads files from it.
sudo -n rm -rf /opt/claude-desktop.new /opt/claude-desktop.old
sudo -n cp -a "$src/lib/claude-desktop" /opt/claude-desktop.new
sudo -n chown -R root:root /opt/claude-desktop.new
[ -f /opt/claude-desktop.new/chrome-sandbox ] && [ ! -L /opt/claude-desktop.new/chrome-sandbox ] ||
  fail "package has no chrome-sandbox file"
sudo -n chmod 4755 /opt/claude-desktop.new/chrome-sandbox
echo "$latest_ver" | sudo -n tee /opt/claude-desktop.new/.deb-version >/dev/null
if [ -d /opt/claude-desktop ]; then
  sudo -n mv /opt/claude-desktop /opt/claude-desktop.old
fi
sudo -n mv /opt/claude-desktop.new /opt/claude-desktop
sudo -n ln -sfn /opt/claude-desktop/claude-desktop /usr/local/bin/claude-desktop
sudo -n install -Dm644 "$src/share/applications/com.anthropic.Claude.desktop" \
  /usr/local/share/applications/com.anthropic.Claude.desktop
for sz in 16 32 48 128 256; do
  sudo -n install -Dm644 "$src/share/icons/hicolor/${sz}x${sz}/apps/claude-desktop.png" \
    "/usr/local/share/icons/hicolor/${sz}x${sz}/apps/claude-desktop.png"
done
sudo -n update-desktop-database /usr/local/share/applications 2>/dev/null || true
sudo -n gtk-update-icon-cache -qf /usr/local/share/icons/hicolor 2>/dev/null || true
echo "Claude Desktop $latest_ver installed"

# The dialog can stay open for hours; free the unpacked package in /tmp first.
find "$tmp" -delete
trap - EXIT

if [ "$notify" = true ]; then
  dialog info "Claude Desktop updated. Restart the app."
fi
