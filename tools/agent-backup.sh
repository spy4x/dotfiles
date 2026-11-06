#!/usr/bin/env bash
# Back up the agent-run database (runs.sqlite) with restic, encrypted, while it is in use.
#
# The database holds every Claude Code session's prompts, tool output and costs, and the background
# lead's queue. It lives outside Syncthing, so without this backup it exists on this disk only.
# `VACUUM INTO` writes a consistent copy while other processes keep reading and writing the live
# file; the live file, its `-wal` and its `-shm` are never copied. restic stores the copies in the
# `backups` Syncthing folder, encrypted with homelab's BACKUPS_PASSWORD, the same mechanism as
# secrets-backup.sh. Runs nightly from agent-backup.timer. Setup and restore: docs/sync.md.
#
# Environment, all optional: AGENT_RUN_HOME (default ~/.local/state/agent-run), RESTIC_REPOSITORY
# (default ~/sync/backups/agent-runs), AGENT_BACKUP_ENV, the file that holds BACKUPS_PASSWORD
# (default ~/sync/code/homelab/.env.root).
set -Eeuo pipefail
umask 077

if [ $# -gt 0 ]; then
  echo "agent-backup: unknown argument: $1" >&2
  exit 2
fi

STATE="${AGENT_RUN_HOME:-$HOME/.local/state/agent-run}"
DB="$STATE/runs.sqlite"
SNAPSHOTS="$STATE/snapshots"
KEEP=3
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-$HOME/sync/backups/agent-runs}"
ENV_FILE="${AGENT_BACKUP_ENV:-$HOME/sync/code/homelab/.env.root}"

if [ ! -f "$DB" ]; then
  echo "agent-backup: nothing to back up: no database at $DB"
  exit 0
fi

# restic runs the command to read the password, so the value is never printed, exported or written
# anywhere else. Without it the run stops before it writes anything.
if ! grep -q '^BACKUPS_PASSWORD=.' "$ENV_FILE" 2>/dev/null; then
  echo "agent-backup: no BACKUPS_PASSWORD in $ENV_FILE" >&2
  exit 1
fi
unset RESTIC_PASSWORD RESTIC_PASSWORD_FILE
export RESTIC_PASSWORD_COMMAND="sed -n 's/^BACKUPS_PASSWORD=//p' '$ENV_FILE'"

mkdir -p "$SNAPSHOTS"
chmod 700 "$SNAPSHOTS"

# The copy is written under a hidden partial name and renamed only once it passes the integrity
# check, so a failed run never leaves a snapshot that looks complete. The trap deletes the partial.
STAMP="$(date +%Y-%m-%dT%H%M%S)"
PARTIAL="$SNAPSHOTS/.runs-$STAMP.partial"
SNAPSHOT="$SNAPSHOTS/runs-$STAMP.sqlite"
trap 'find "$PARTIAL" -maxdepth 0 -type f -delete 2>/dev/null || true' EXIT

# Waits up to 10 seconds for a writer's lock instead of failing at once. Single quotes in the path
# are doubled for the SQL string.
sqlite3 -batch -bail "$DB" ".timeout 10000" "VACUUM INTO '${PARTIAL//\'/\'\'}'"

# immutable=1 opens the copy without making -wal or -shm files beside it.
CHECK="$(sqlite3 -batch "file:$PARTIAL?immutable=1" "PRAGMA integrity_check")"
if [ "$CHECK" != ok ]; then
  echo "agent-backup: the snapshot failed its integrity check: $CHECK" >&2
  exit 1
fi
mv -f "$PARTIAL" "$SNAPSHOT"

if [ ! -e "$RESTIC_REPOSITORY/config" ]; then
  restic init --quiet
fi
restic backup --quiet --tag agent-runs "$SNAPSHOTS"
restic forget --quiet --tag agent-runs --keep-daily 14 --keep-weekly 8 --prune

# Keep the newest few copies on disk. Names sort by time; each older file is deleted by its exact
# name.
find "$SNAPSHOTS" -maxdepth 1 -type f -name 'runs-*.sqlite' -printf '%f\n' | sort -r |
  tail -n +$((KEEP + 1)) | while IFS= read -r name; do
  find "$SNAPSHOTS/$name" -maxdepth 0 -type f -delete
done
echo "agent-backup: backed up $SNAPSHOT"
