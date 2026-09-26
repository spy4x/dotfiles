#!/usr/bin/env bash
# List processes an agent session left running. Empty output means clean.
#
# A tool call's children inherit the harness's cgroup and keep it when they are
# reparented, so orphans are members of this cgroup whose parent is now init or
# the systemd user manager. Anything that moves itself to a fresh cgroup (a
# Docker container, `systemd-run --scope`) is invisible here: clean it by name.
#
# Every desktop-app session shares one cgroup, so the cgroup alone would list
# every sibling session's orphans too. Inside a Claude Code session, a process
# whose environment names another CLAUDE_CODE_SESSION_ID is hidden; `--all`
# shows it. A process whose environment cannot be read still shows.
#
# `--under <dir>...` keeps only processes whose working directory is inside one
# of the given directories, so a lane can clean up after itself without touching
# a sibling lane in the same session.
#
# Three exclusions: the desktop app, matched by its executable so its flags do
# not matter; the login shells it abandons, one per session, matched by the full
# command line; and Chromium's crash reporter, which outlives its browser by a
# few minutes. A leaked browser still shows as its own process.
#
# Output: one line per orphan, `PID ELAPSED %CPU COMMAND`. The first column is
# the only PID printed. It used to print the parent PID second; every orphan's
# parent is the systemd user manager, and an agent that read that column as a
# target ran `kill <pid> <ppid>`, which logged the desktop out.
#
# `--kill` stops what it lists: SIGTERM, then SIGKILL for anything still alive
# after three seconds. It never signals PID 1, the user manager or its own
# ancestors, so there is no PID to copy by hand. Pair it with `--under`.
#
# Needs Linux with cgroup v2 and a systemd user manager. Elsewhere it fails
# loudly instead of printing a falsely clean result; fall back to
# `ps -eo pcpu,etime,args --sort=-pcpu | head`, which finds only CPU burners.
#
# Usage: sweep-orphans.sh [--all] [--kill] [--under <dir>...]
set -euo pipefail

ALL=0
KILL=0
UNDER=()
while (($#)); do
  case $1 in
    --all)
      ALL=1
      shift
      ;;
    --kill)
      KILL=1
      shift
      ;;
    --under)
      shift
      while (($#)) && [[ $1 != --* ]]; do
        UNDER+=("$(realpath -m "$1")")
        shift
      done
      ;;
    *)
      echo "usage: sweep-orphans.sh [--all] [--kill] [--under <dir>...]" >&2
      exit 2
      ;;
  esac
done

MGR=$(pgrep -xu "$USER" systemd || echo 1)

# Never signal these: init, the user manager (SIGTERM = log out) and this script's ancestors.
SAFE=" 1 $MGR "
p=$$
while ((p > 1)); do
  SAFE+="$p "
  p=$(ps -o ppid= -p "$p") || break
  p=${p// /}
done

if ((ALL && KILL)); then
  echo "sweep-orphans.sh: --all lists other sessions' orphans; report those, never --kill them" >&2
  exit 2
fi

CG=$(cut -d: -f3 /proc/self/cgroup)
ORPHANS=$(ps -o pid=,ppid=,etime=,pcpu=,args= -p "$(paste -sd, "/sys/fs/cgroup$CG/cgroup.procs")" |
  awk -v mgr="$MGR" '
    ($2==1 || $2==mgr) {
      cmd = $0; sub(/^ *([^ ]+ +){4}/, "", cmd); split(cmd, argv, " ")
      if (cmd == "/usr/bin/zsh -l") next
      if (argv[1] == "/opt/claude-desktop/claude-desktop") next
      if (argv[1] ~ /\/chrome_crashpad_handler$/) next
      printf "%s %s %s %s\n", $1, $3, $4, cmd
    }') || {
  echo "sweep-orphans.sh: could not read the process list; this is not a clean result" >&2
  exit 1
}

LISTED=()
while IFS= read -r line; do
  [[ -n $line ]] || continue
  read -r pid _ <<<"$line"
  [[ -e /proc/$pid ]] || continue
  if ((!ALL)) && [[ -n ${CLAUDE_CODE_SESSION_ID:-} ]]; then
    sid=$(tr '\0' '\n' 2>/dev/null <"/proc/$pid/environ" | sed -n 's/^CLAUDE_CODE_SESSION_ID=//p') ||
      sid=
    if [[ -n $sid && $sid != "$CLAUDE_CODE_SESSION_ID" ]]; then continue; fi
  fi
  if ((${#UNDER[@]})); then
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || cwd=
    cwd=${cwd% (deleted)}
    keep=0
    for dir in "${UNDER[@]}"; do
      if [[ $cwd == "$dir" || $cwd == "$dir"/* ]]; then keep=1; fi
    done
    ((keep)) || continue
  fi
  [[ $SAFE == *" $pid "* ]] && continue
  LISTED+=("$line")
done <<<"$ORPHANS"

for line in "${LISTED[@]}"; do
  printf '%s\n' "$line"
done
((KILL)) && ((${#LISTED[@]})) || exit 0

PIDS=()
for line in "${LISTED[@]}"; do
  PIDS+=("${line%% *}")
done
kill -TERM "${PIDS[@]}" 2>/dev/null || true
for _ in 1 2 3 4 5 6; do
  alive=()
  for pid in "${PIDS[@]}"; do
    [[ -e /proc/$pid ]] && alive+=("$pid")
  done
  ((${#alive[@]})) || break
  sleep 0.5
done
if ((${#alive[@]})); then
  kill -KILL "${alive[@]}" 2>/dev/null || true
  echo "killed ${#PIDS[@]}, ${#alive[@]} of them with SIGKILL" >&2
else
  echo "killed ${#PIDS[@]}" >&2
fi
