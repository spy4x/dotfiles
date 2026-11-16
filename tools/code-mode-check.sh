#!/usr/bin/env bash
# Tells the owner once, on ntfy, when Claude Code's Code Mode starts working in headless runs
# (`claude -p`), the kind Ringmaster's leads and the desktop Code tab start. Until then Code Mode
# works only in the interactive terminal. The global settings already turn it on
# (CLAUDE_CODE_EXPERIMENTAL_CODE_MODE), so headless runs pick it up by themselves once a release
# allows it; this check only says when that happened. Runs from code-mode-check.timer; after the
# one notification it does nothing. Setup: docs/sync.md.
set -Eeuo pipefail

STATE=${CODE_MODE_STATE:-$HOME/.local/state/code-mode-check/notified}
ACCOUNTS=${CODE_MODE_ACCOUNTS:-$HOME/sync/code/homelab/.env.accounts}
REFUSAL="only works in the interactive terminal"

[ -e "$STATE" ] && exit 0

# Free check first: while the installed binary still carries the refusal, no run is spent.
bin=$(readlink -f "$(command -v claude)")
grep -qaF "$REFUSAL" "$bin" && exit 0

# The text is gone. Confirm with one small headless run, since a reworded refusal would hide too.
if ! err=$(timeout 180 claude -p --no-session-persistence --model haiku "Reply with OK." 2>&1 >/dev/null); then
  echo "probe run failed: $err" >&2
  exit 1
fi
if grep -qF "Code Mode" <<<"$err"; then
  echo "still refused: $err"
  exit 0
fi

url=$(sed -n 's/^NTFY_URL=//p' "$ACCOUNTS")
topic=$(sed -n 's/^NTFY_TOPIC=//p' "$ACCOUNTS")
token=$(sed -n 's/^NTFY_TOKEN=//p' "$ACCOUNTS")
# The token goes through a file descriptor, so it never shows in the process list.
curl -fsS -o /dev/null \
  -H @<(printf 'Authorization: Bearer %s\n' "$token") \
  -H "Title: Code Mode works in headless runs" \
  --data-binary "Claude Code $(claude --version 2>/dev/null | cut -d' ' -f1) runs Code Mode in claude -p. Ringmaster leads and the desktop Code tab now use it through the global settings." \
  "$url/$topic"
mkdir -p "$(dirname "$STATE")"
date -Is >"$STATE"
