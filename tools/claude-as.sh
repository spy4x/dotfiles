#!/usr/bin/env bash
# Runs the Claude Code CLI on another account, keeping the one ~/.claude folder with its rules,
# skills and MCP servers. Plain `claude` stays the default (personal) login. Each profile's token
# is in ~/.config/claude-<profile>/token, readable only by you. See docs/claude-accounts.md.
#   claude-as <profile> --setup   sign in to that account once and store its token
#   claude-as <profile> [args]    run claude on that account, e.g. `claude-as work auth status`
set -euo pipefail

if [[ ! "${1:-}" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  sed -n '2,6p' "$0" >&2
  exit 1
fi
profile="$1"
shift
claude="${CLAUDE_BIN:-claude}"
token_file="$HOME/.config/claude-$profile/token"

if [[ "${1:-}" == "--setup" ]]; then
  echo "A browser opens: sign in with the $profile account, not the default one."
  "$claude" setup-token
  mkdir -p "$(dirname "$token_file")"
  chmod 700 "$(dirname "$token_file")"
  read -rsp "Paste the token printed above (input is hidden): " token
  echo
  [[ -n "$token" ]] || { echo "Empty token, nothing saved." >&2; exit 1; }
  (umask 077 && printf '%s' "$token" > "$token_file")
  echo "Saved. Check: claude-as $profile auth status"
  exit 0
fi

[[ -s "$token_file" ]] || { echo "No token yet. Run: claude-as $profile --setup" >&2; exit 1; }
CLAUDE_CODE_OAUTH_TOKEN="$(cat "$token_file")" exec "$claude" "$@"
