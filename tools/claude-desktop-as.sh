#!/usr/bin/env bash
# Runs one more Claude desktop app with its own sign-in, one per account. Each profile keeps its
# own folder ~/.config/Claude-<profile>; `claude-desktop` stays the default (personal) account.
# All profiles share ~/.claude (rules, skills, MCP servers, memory). See docs/claude-accounts.md.
#   claude-desktop-as <profile> [args]                    start that profile's app
#   claude-desktop-as --install <profile> <label> [hue]   add the menu entry "Claude <label>";
#       hue recolours its icon (0-200, 100 leaves it unchanged)
set -euo pipefail

usage() {
  sed -n '2,8p' "$0" >&2
  exit 1
}

valid() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] && return
  echo "Profile must be lowercase letters, digits and dashes." >&2
  exit 1
}

if [[ "${1:-}" == "--install" ]]; then
  [[ $# -ge 3 ]] || usage
  profile="$2" label="$3" hue="${4:-160}"
  valid "$profile"
  [[ "$hue" =~ ^[0-9]+$ ]] || usage
  [[ "$label" != *$'\n'* ]] || usage
  id="claude-desktop-$profile"
  icon_source="${CLAUDE_DESKTOP_ICON:-/usr/local/share/icons/hicolor/256x256/apps/claude-desktop.png}"
  icons="$HOME/.local/share/icons/hicolor/256x256/apps"
  apps="$HOME/.local/share/applications"
  mkdir -p "$icons" "$apps"
  "${MAGICK:-magick}" "$icon_source" -modulate "100,100,$hue" "$icons/$id.png"
  cat > "$apps/$id.desktop" <<ENTRY
[Desktop Entry]
Name=Claude $label
Comment=Claude desktop app signed in to the $label account
Exec="$HOME/.local/bin/claude-desktop-as" $profile %U
Icon=$id
Type=Application
Categories=Development;
ENTRY
  update-desktop-database "$apps" 2>/dev/null || true
  echo "Installed the menu entry: Claude $label"
  exit 0
fi

[[ $# -ge 1 ]] || usage
profile="$1"
shift
valid "$profile"
exec "${CLAUDE_DESKTOP_BIN:-claude-desktop}" --user-data-dir="$HOME/.config/Claude-$profile" "$@"
