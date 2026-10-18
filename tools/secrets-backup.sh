#!/usr/bin/env bash
# Back up the age keys and plaintext env files under ~/sync/code with restic.
#
# Syncthing does not copy these files to other machines (system/syncthing-code.stignore), so
# without this backup a key made here exists on this disk only, and the `.env.age` it encrypts
# could never be read again. The restic repository lives in the `backups` Syncthing folder, so the
# other machines receive it, encrypted. Its password is homelab's BACKUPS_PASSWORD, the one every
# server's backups use. Runs nightly from secrets-backup.timer. Setup and restore: docs/sync.md.
#
#   --alert  show an error dialog that the backup failed, and back up nothing
#            (secrets-backup-failed.service runs it when a nightly run fails)
#
# Environment, all optional: SECRETS_BACKUP_SOURCE (default ~/sync/code), RESTIC_REPOSITORY
# (default ~/sync/backups/workstation-secrets), SECRETS_BACKUP_ENV, the file that holds
# BACKUPS_PASSWORD (default ~/sync/code/homelab/.env.root).
set -Eeuo pipefail
umask 077

if [ "${1:-}" = --alert ]; then
  TEXT="The nightly backup of age keys and env files failed. Until it runs again, a key made since \
the last good run has no other copy. Read why with: journalctl --user -u secrets-backup.service -n 30"
  if command -v kdialog >/dev/null; then
    kdialog --title "Secrets backup" --error "$TEXT" || true
  elif command -v zenity >/dev/null; then
    zenity --error --title "Secrets backup" --text "$TEXT" || true
  else
    echo "secrets-backup: could not show the alert: no kdialog or zenity" >&2
    exit 1
  fi
  exit 0
elif [ $# -gt 0 ]; then
  echo "secrets-backup: unknown argument: $1" >&2
  exit 2
fi

SOURCE="${SECRETS_BACKUP_SOURCE:-$HOME/sync/code}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-$HOME/sync/backups/workstation-secrets}"
ENV_FILE="${SECRETS_BACKUP_ENV:-$HOME/sync/code/homelab/.env.root}"

# restic runs the command to read the password, so the value is never printed, exported or written
# anywhere else. Without it the run stops: a repository cannot be opened or made.
if ! grep -q '^BACKUPS_PASSWORD=.' "$ENV_FILE" 2>/dev/null; then
  echo "secrets-backup: no BACKUPS_PASSWORD in $ENV_FILE" >&2
  exit 1
fi
unset RESTIC_PASSWORD RESTIC_PASSWORD_FILE
export RESTIC_PASSWORD_COMMAND="sed -n 's/^BACKUPS_PASSWORD=//p' '$ENV_FILE'"

if [ ! -e "$RESTIC_REPOSITORY/config" ]; then
  restic init --quiet
fi

LIST="$(mktemp)"
trap 'shred -u "$LIST" 2>/dev/null || true' EXIT

# The same names system/syncthing-code.stignore ignores, whatever their type (file, folder or
# symlink): `.age` and plaintext env names, not `.env*.age` or `.env*.example`. Keep the two lists
# in step. A matched folder is backed up whole.
find "$SOURCE" \
  \( -name node_modules -o -name .volumes -o -name .git -o -name .stversions \
  -o -path "$SOURCE/worktrees" \) -prune -o \
  \( -name .age -print0 -prune \) -o \
  \( \( -name '.env*' -o -name '*.env' -o -name '*.env.bak*' \) \
  ! -name '.env*.age' ! -name '.env*.example' -print0 -prune \) >"$LIST"

if [ ! -s "$LIST" ]; then
  echo "secrets-backup: nothing to back up under $SOURCE" >&2
  exit 1
fi

restic backup --quiet --tag secrets --files-from-raw "$LIST"
restic forget --quiet --tag secrets --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
