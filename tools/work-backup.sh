#!/usr/bin/env bash
# Back up, with restic, the work under ~/sync/code that exists on this machine only, not on GitHub.
#
# Syncthing's `code` folder is not a backup: a bad delete is copied to every machine. Each run saves:
# - every top-level folder that is not a git repository (`mcps/`), whole;
# - every git repository with no remote, whole, `.git` included;
# - in every other repository and in its linked worktrees under ~/sync/code/worktrees, the files
#   not committed yet: modified, staged, and untracked but not ignored;
# - for each such repository, a `git bundle` of the local commits that are on no remote.
# Plaintext env files and `.age` keys are left out: secrets-backup.sh saves those. The restic
# repository lives in the `backups` Syncthing folder; its password is homelab's BACKUPS_PASSWORD,
# as for secrets-backup. Runs nightly from work-backup.timer. Setup and restore: docs/sync.md.
#
#   --alert  show an error dialog that the backup failed, and back up nothing
#            (work-backup-failed.service runs it when a nightly run fails)
#
# Environment, all optional: WORK_BACKUP_SOURCE (default ~/sync/code), WORK_BACKUP_WORKTREES
# (default <source>/worktrees), RESTIC_REPOSITORY (default ~/sync/backups/workstation-work),
# WORK_BACKUP_ENV, the file that holds BACKUPS_PASSWORD (default ~/sync/code/homelab/.env.root).
set -Eeuo pipefail
umask 077

if [ "${1:-}" = --alert ]; then
  TEXT="The nightly backup of local work (uncommitted files, unpushed commits, folders with no \
repository) failed. Read why with: journalctl --user -u work-backup.service -n 30"
  if command -v kdialog >/dev/null; then
    kdialog --title "Work backup" --error "$TEXT" || true
  elif command -v zenity >/dev/null; then
    zenity --error --title "Work backup" --text "$TEXT" || true
  else
    echo "work-backup: could not show the alert: no kdialog or zenity" >&2
    exit 1
  fi
  exit 0
elif [ $# -gt 0 ]; then
  echo "work-backup: unknown argument: $1" >&2
  exit 2
fi

SOURCE="${WORK_BACKUP_SOURCE:-$HOME/sync/code}"
WORKTREES="${WORK_BACKUP_WORKTREES:-$SOURCE/worktrees}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-$HOME/sync/backups/workstation-work}"
ENV_FILE="${WORK_BACKUP_ENV:-$HOME/sync/code/homelab/.env.root}"
# Reading never takes git's optional locks, so a run changes nothing in any repository.
export GIT_OPTIONAL_LOCKS=0

if [ ! -d "$SOURCE" ]; then
  echo "work-backup: no folder $SOURCE" >&2
  exit 1
fi

# restic runs the command to read the password, so the value is never printed, exported or written
# anywhere else. Without it the run stops: a repository cannot be opened or made.
if ! grep -q '^BACKUPS_PASSWORD=.' "$ENV_FILE" 2>/dev/null; then
  echo "work-backup: no BACKUPS_PASSWORD in $ENV_FILE" >&2
  exit 1
fi
unset RESTIC_PASSWORD RESTIC_PASSWORD_FILE
export RESTIC_PASSWORD_COMMAND="sed -n 's/^BACKUPS_PASSWORD=//p' '$ENV_FILE'"

D="$(mktemp -d)"
trap 'find "$D" -delete' EXIT
LIST="$D/list"
BUNDLES="$D/bundles"
mkdir "$BUNDLES"
: >"$LIST"

add() { printf '%s\0' "$1" >>"$LIST"; }

# Top-level folders that are no repository, backed up whole.
WHOLE=()
while IFS= read -r -d '' dir; do
  [ -e "$dir/.git" ] && continue
  WHOLE+=(-o -path "$dir")
  add "$dir"
done < <(find "$SOURCE" -mindepth 1 -maxdepth 1 -type d \
  ! -name .stfolder ! -name .stversions ! -name node_modules ! -name .volumes \
  ! -path "$WORKTREES" -print0)

# Every repository under SOURCE outside those folders. A symlink to a repository is not followed,
# so each is found once.
REPOS=()
while IFS= read -r -d '' git; do
  REPOS+=("${git%/.git}")
done < <(find "$SOURCE" \( -name node_modules -o -name .volumes -o -name .stversions \
  -o -path "$WORKTREES" ${WHOLE[@]+"${WHOLE[@]}"} \) -prune -o -name .git -type d -print0 -prune)

# Whether a path lies in or is one of the secret names secrets-backup.sh saves
# (system/syncthing-code.stignore): `.age` and plaintext env names, but not `.env*.age` ciphertext or
# `.env*.example`. restic's --exclude below matches the same names inside a folder backed up whole,
# but never a file named on its list.
secret() {
  local part parts
  IFS=/ read -ra parts <<<"$1"
  for part in "${parts[@]}"; do
    case "$part" in
      .env*.age | .env*.example) ;;
      .age | .env* | *.env | *.env.bak*) return 0 ;;
    esac
  done
  return 1
}

# Adds the files of one working tree that no commit holds yet. Deleted files have nothing to save,
# and a nested repository (a path ending in /) is handled as a repository of its own.
uncommitted() {
  local tree="$1" rel
  while IFS= read -r -d '' rel; do
    case "$rel" in */) continue ;; esac
    secret "$rel" && continue
    if [ -e "$tree/$rel" ] || [ -L "$tree/$rel" ]; then add "$tree/$rel"; fi
  done < <(
    git -C "$tree" ls-files -z -m -o --exclude-standard
    git -C "$tree" diff --cached --name-only -z --diff-filter=d
  )
}

for repo in ${REPOS[@]+"${REPOS[@]}"}; do
  if [ -z "$(git -C "$repo" remote)" ]; then
    add "$repo"
  else
    uncommitted "$repo"
    if [ -n "$(git -C "$repo" rev-list -n 1 --branches --not --remotes)" ]; then
      rel="${repo#"$SOURCE"/}"
      git -C "$repo" bundle create --quiet "$BUNDLES/${rel//\//__}.bundle" --branches --not --remotes
    fi
  fi
  while IFS= read -r line; do
    tree="${line#worktree }"
    [ "$tree" = "$line" ] && continue
    case "$tree" in "$WORKTREES"/*) [ -d "$tree" ] && uncommitted "$tree" ;; esac
  done < <(git -C "$repo" worktree list --porcelain)
done

if [ -n "$(ls -A "$BUNDLES")" ]; then add "$BUNDLES"; fi

if [ ! -s "$LIST" ]; then
  echo "work-backup: nothing under $SOURCE exists only here"
  exit 0
fi

if [ ! -e "$RESTIC_REPOSITORY/config" ]; then
  restic init --quiet
fi

# The names secret() matches, inside the folders backed up whole.
restic backup --quiet --tag work --files-from-raw "$LIST" \
  --exclude node_modules --exclude .volumes --exclude .stversions \
  --exclude .age --exclude '.env*' --exclude '*.env' --exclude '*.env.bak*' \
  --exclude '!.env*.age' --exclude '!.env*.example'
# The bundle folder's name changes every run, so snapshots are grouped by tag, not by their paths.
restic forget --quiet --tag work --group-by host,tags \
  --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
