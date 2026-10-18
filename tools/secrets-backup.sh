#!/usr/bin/env bash
# Back up the age keys and plaintext env files under ~/sync/code with restic.
#
# Syncthing does not copy these files to other machines (system/syncthing-code.stignore), so
# without this backup a key made here exists on this disk only, and the `.env.age` it encrypts
# could never be read again. The restic repository lives in the `backups` Syncthing folder, so the
# other machines receive it, encrypted. The password stays on this machine, outside every synced
# folder; keep a copy in the password manager. Runs nightly from secrets-backup.timer. Setup and
# restore: docs/sync.md.
#
#   --alert  show an error dialog that the backup failed, and back up nothing
#            (secrets-backup-failed.service runs it when a nightly run fails)
#
# Environment, all optional: SECRETS_BACKUP_SOURCE (default ~/sync/code), RESTIC_REPOSITORY
# (default ~/sync/backups/workstation-secrets), RESTIC_PASSWORD_FILE (default
# ~/.config/restic/workstation-secrets.pass).
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
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$HOME/.config/restic/workstation-secrets.pass}"

# The first run creates the password, never printed, and the repository. A repository without its
# password file stops the run: a new password would not open it.
if [ ! -s "$RESTIC_PASSWORD_FILE" ]; then
  if [ -e "$RESTIC_REPOSITORY/config" ]; then
    echo "secrets-backup: $RESTIC_PASSWORD_FILE is missing; restore it from the password manager" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$RESTIC_PASSWORD_FILE")"
  head -c 32 /dev/urandom | base64 >"$RESTIC_PASSWORD_FILE"
fi
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
