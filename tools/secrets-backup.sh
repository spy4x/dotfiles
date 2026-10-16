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
# Environment, all optional: SECRETS_BACKUP_SOURCE (default ~/sync/code), RESTIC_REPOSITORY
# (default ~/sync/backups/workstation-secrets), RESTIC_PASSWORD_FILE (default
# ~/.config/restic/workstation-secrets.pass).
set -Eeuo pipefail
umask 077

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

# The same names system/syncthing-code.stignore ignores: `.age` folders and plaintext env files,
# not `.env*.age` or `.env*.example`. Keep the two lists in step.
find "$SOURCE" \
  \( -name node_modules -o -name .volumes -o -name .git -o -name .stversions \
  -o -path "$SOURCE/worktrees" \) -prune -o \
  \( -type d -name .age -print0 -prune \) -o \
  \( -type f \( -name '.env*' -o -name '*.env' -o -name '*.env.bak*' \) \
  ! -name '.env*.age' ! -name '.env*.example' -print0 \) >"$LIST"

if [ ! -s "$LIST" ]; then
  echo "secrets-backup: nothing to back up under $SOURCE" >&2
  exit 1
fi

restic backup --quiet --tag secrets --files-from-raw "$LIST"
restic forget --quiet --tag secrets --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
