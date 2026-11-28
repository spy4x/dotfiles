#!/usr/bin/env bash
# Starts the week's content preparation: one headless lead (ringmaster's `agent-run`) that writes
# the recording kit for the project whose turn it is and pushes it to the owner once. The turn is
# the line "<n>. <Name>, now." in the weekly-content skill; the run's folder is
# ~/sync/code/<lowercased name>. Runs hourly on Mondays from weekly-content-prepare.timer. A marker
# per ISO week makes every later fire that week a no-op; a busy machine or a refused start writes
# no marker, so the next fire retries. Setup: docs/weekly-content.md.
set -Eeuo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE=${WEEKLY_CONTENT_STATE:-$HOME/.local/state/weekly-content}
SKILL=${WEEKLY_CONTENT_SKILL:-$REPO/ai-harnesses/skills/weekly-content/SKILL.md}
CODE=${WEEKLY_CONTENT_CODE:-$HOME/sync/code}
PRESSURE=${WEEKLY_CONTENT_PRESSURE:-/sys/fs/cgroup/user.slice/cpu.pressure}
WEEK=${WEEKLY_CONTENT_WEEK:-$(date +%G-W%V)}
read -ra AGENT_RUN <<<"${AGENT_RUN:-deno run -A $HOME/sync/code/ringmaster/src/agent-run.ts}"
# The same limit as ringmaster's DEFAULT_PRESSURE_PERCENT (src/limits.ts), which holds its leads.
MAX_PRESSURE=40

[ -e "$STATE/$WEEK" ] && exit 0

# A missing or unreadable pressure file is no reason to hold.
avg60=$(sed -n 's/^some .*avg60=\([0-9.]*\).*/\1/p' "$PRESSURE" 2>/dev/null || true)
if [ -n "$avg60" ] && awk -v p="$avg60" -v m="$MAX_PRESSURE" 'BEGIN { exit !(p > m) }'; then
  echo "holding: user CPU pressure avg60=$avg60 is above $MAX_PRESSURE; the next fire retries"
  exit 0
fi

name=$(sed -n 's/^[0-9][0-9]*\. \(.*\), now\.$/\1/p' "$SKILL" 2>/dev/null | head -n1 || true)
if [ -z "$name" ]; then
  echo "no line '<n>. <Name>, now.' in $SKILL: cannot tell whose turn it is" >&2
  exit 1
fi
project=${name,,}
if [ ! -d "$CODE/$project" ]; then
  echo "the project on turn, $name, has no folder $CODE/$project" >&2
  exit 1
fi

# A project's lead limit defaults to 0, which refuses the start. Raise it to 1, never lower it.
limit=$("${AGENT_RUN[@]}" limit | sed -n "s/^$project: [0-9]* of \([0-9]*\) lead runs.*/\1/p")
if [ "${limit:-0}" -lt 1 ]; then
  "${AGENT_RUN[@]}" limit --project "$project" --leads 1
fi

"${AGENT_RUN[@]}" start --cwd "$CODE/$project" --model opus --effort medium --mode lead \
  --name "weekly-content-$WEEK" --deadline 2h --budget-usd 20 \
  --brief "$REPO/tools/weekly-content-prepare.md"

mkdir -p "$STATE"
date -Is >"$STATE/$WEEK"
