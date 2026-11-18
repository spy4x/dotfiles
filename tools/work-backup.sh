#!/usr/bin/env bash
# Back up, with restic, the work under ~/sync/code that exists on this machine only, not on GitHub.
#
# Syncthing's `code` folder is not a backup: a bad delete is copied to every machine. Each run saves:
# - every top-level folder that is not a git repository (`mcps/`), whole;
# - every git repository with no remote, whole, `.git` included;
# - in every other repository and in its linked worktrees under ~/sync/code/worktrees, the files
#   not committed yet: modified, staged, and untracked but not ignored;
# - for each such repository, a `git bundle` of the local commits that are on no remote, of those
#   only a detached HEAD holds, and of the commits its stashes were made on;
# - one patch per stash, untracked files included.
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

# The name a repository's files get in the bundle folder.
flat() {
  local rel="${1#"$SOURCE"/}"
  printf '%s' "${rel//\//__}"
}

# Bundles the commits only a detached HEAD holds: no branch points at them, so the branch bundle
# misses them. Repositories with no remote are saved whole already.
detached() {
  local repo="$1" tree="$2" head
  [ -n "$(git -C "$repo" remote)" ] || return 0
  git -C "$tree" symbolic-ref -q HEAD >/dev/null && return 0
  [ -n "$(git -C "$tree" rev-list -n 1 HEAD --not --branches --remotes)" ] || return 0
  head="$(git -C "$tree" rev-parse --short=12 HEAD)"
  git -C "$tree" bundle create --quiet "$BUNDLES/$(flat "$repo").detached-$head.bundle" \
    HEAD --not --branches --remotes
}

# Prints the difference between two trees as a patch, leaving out the names secret() matches.
secret_free_diff() {
  local repo="$1" from="$2" to="$3" rel
  while IFS= read -r -d '' rel; do
    secret "$rel" || printf '%s\0' "$rel"
  done < <(git -C "$repo" diff --name-only --no-renames -z "$from" "$to") |
    GIT_LITERAL_PATHSPECS=1 xargs -0 -r git -C "$repo" diff --binary --no-renames --no-color \
      --src-prefix=a/ --dst-prefix=b/ "$from" "$to" --
}

# Saves each stash as a patch that `git apply` restores, untracked files included, with the commit
# it was made on in its first line. A base commit that no branch or remote holds goes into a bundle
# of its own; the stash commit never does, because it can hold secrets. The bundle is built in a
# throwaway repository that borrows the objects, so the real one gets no new ref. Repositories with
# no remote are saved whole already.
stashes() {
  local repo="$1" n=0 total base empty name borrowed=""
  [ -n "$(git -C "$repo" remote)" ] || return 0
  total="$(git -C "$repo" stash list | wc -l)"
  [ "$total" -gt 0 ] || return 0
  name="$(flat "$repo")"
  empty="$(git -C "$repo" hash-object -t tree /dev/null)"
  while [ "$n" -lt "$total" ]; do
    base="$(git -C "$repo" rev-parse "stash@{$n}^1")"
    {
      printf 'Stash made on commit %s\n\n' "$base"
      secret_free_diff "$repo" "$base" "stash@{$n}"
      if git -C "$repo" rev-parse -q --verify "stash@{$n}^3" >/dev/null; then
        secret_free_diff "$repo" "$empty" "stash@{$n}^3"
      fi
    } >"$BUNDLES/$name.stash-$n.patch"
    if [ -n "$(git -C "$repo" rev-list -n 1 "$base" --not --branches --remotes)" ]; then
      if [ -z "$borrowed" ]; then
        borrowed="$(mktemp -d -p "$D")"
        git init --quiet --bare --template= "$borrowed"
        mkdir -p "$borrowed/objects/info"
        printf '%s/objects\n' "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)" \
          >"$borrowed/objects/info/alternates"
      fi
      git -C "$borrowed" update-ref "refs/heads/stash-$n" "$base"
    fi
    n=$((n + 1))
  done
  [ -n "$borrowed" ] || return 0
  {
    git -C "$borrowed" for-each-ref --format='%(refname)'
    git -C "$repo" for-each-ref --format='^%(objectname)' refs/heads refs/remotes
  } | git -C "$borrowed" bundle create --quiet "$BUNDLES/$name.stash-bases.bundle" --stdin
}

for repo in ${REPOS[@]+"${REPOS[@]}"}; do
  if [ -z "$(git -C "$repo" remote)" ]; then
    add "$repo"
  else
    uncommitted "$repo"
    if [ -n "$(git -C "$repo" rev-list -n 1 --branches --not --remotes)" ]; then
      git -C "$repo" bundle create --quiet "$BUNDLES/$(flat "$repo").bundle" --branches --not --remotes
    fi
  fi
  while IFS= read -r line; do
    tree="${line#worktree }"
    [ "$tree" = "$line" ] && continue
    case "$tree" in "$WORKTREES"/*) [ -d "$tree" ] && uncommitted "$tree" ;; esac
    [ -d "$tree" ] && detached "$repo" "$tree"
  done < <(git -C "$repo" worktree list --porcelain)
  stashes "$repo"
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
