#!/usr/bin/env bash
# List processes an agent session left running. Empty output means clean.
#
# A tool call's children inherit the harness's cgroup and keep it when they are
# reparented, so orphans are members of this cgroup whose parent is now init or
# the systemd user manager. A Docker container moves to a fresh cgroup and is
# invisible here: clean it by name.
#
# `systemd-run --user --scope` also moves its command to a fresh cgroup, a
# transient unit named `run-*.scope`. When its `timeout` dies first, the
# children keep the unit alive. So the sweep also lists active `run-*.scope`
# user units older than `--min-age` seconds (default 3600, so a capped test
# run still in progress does not show). Scopes are machine-wide, so a scope
# counts as this session's only when one of its processes names this
# CLAUDE_CODE_SESSION_ID, or, with `--under`, runs inside one of the given
# directories; one process naming another session hides it. Without a session
# ID or `--under`, only `--all` lists scopes. Without a systemd user manager
# (a CI container) there are no such units and this part is skipped.
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
# Output: one line per orphan, `PID ELAPSED %CPU COMMAND`, then one line per
# stale scope, `UNIT ELAPSED %CPU COMMAND`: the unit's age, the summed CPU of
# its processes and the command `systemd-run` started. The first column is
# the only PID printed. It used to print the parent PID second; every orphan's
# parent is the systemd user manager, and an agent that read that column as a
# target ran `kill <pid> <ppid>`, which logged the desktop out.
#
# `--kill` stops what it lists: SIGTERM, then SIGKILL for anything still alive
# after three seconds, and `systemctl --user stop` for each listed scope. It
# never signals PID 1, the user manager or its own ancestors, nor stops a scope
# holding one of them, so there is no PID to copy by hand. A scope still active
# after its stop is named on stderr, and the exit code is 1. Pair it with
# `--under`, except in `--stale` mode.
#
# `--stale` is `--all` limited to orphans and scopes older than `--min-age`,
# which defaults to a day here. Unlike `--all`, it may be paired with `--kill`:
# whatever another session left running for a day is abandoned, not in use.
# Without `--under`, `--stale --kill` refuses a `--min-age` below a day, so it
# cannot stop another session's live work.
#
# Needs Linux with cgroup v2 and a systemd user manager. Elsewhere it fails
# loudly instead of printing a falsely clean result; fall back to
# `ps -eo pcpu,etime,args --sort=-pcpu | head`, which finds only CPU burners.
#
# Usage: sweep-orphans.sh [--all | --stale] [--kill] [--min-age <seconds>] [--under <dir>...]
set -euo pipefail
shopt -s extglob

USAGE="usage: sweep-orphans.sh [--all | --stale] [--kill] [--min-age <seconds>] [--under <dir>...]"
ALL=0
STALE=0
KILL=0
MIN_AGE=
FAILED=0
UNDER=()
while (($#)); do
  case $1 in
    --all)
      ALL=1
      shift
      ;;
    --stale)
      ALL=1
      STALE=1
      shift
      ;;
    --kill)
      KILL=1
      shift
      ;;
    --min-age)
      if [[ ${2:-} != +([0-9]) ]]; then
        echo "$USAGE" >&2
        exit 2
      fi
      MIN_AGE=$2
      shift 2
      ;;
    --under)
      shift
      while (($#)) && [[ $1 != --* ]]; do
        UNDER+=("$(realpath -m "$1")")
        shift
      done
      ;;
    *)
      echo "$USAGE" >&2
      exit 2
      ;;
  esac
done

[[ -n $MIN_AGE ]] || MIN_AGE=$((STALE ? 86400 : 3600))

if ((STALE && KILL && !${#UNDER[@]} && 10#$MIN_AGE < 86400)); then
  echo "sweep-orphans.sh: --stale --kill stops only what is a day old; --min-age below 86400" \
    "needs --under" >&2
  exit 2
fi

MGR=$(pgrep -xu "${USER:-$(id -un)}" systemd || echo 1)

# Never signal these: init, the user manager (SIGTERM = log out) and this script's ancestors.
SAFE=" 1 $MGR "
p=$$
while ((p > 1)); do
  SAFE+="$p "
  p=$(ps -o ppid= -p "$p") || break
  p=${p// /}
done

if ((ALL && KILL && !STALE)); then
  echo "sweep-orphans.sh: --all lists other sessions' orphans; report those, never --kill them;" \
    "--stale --kill stops those older than a day" >&2
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

# Whether a process names another Claude Code session (never true with --all).
foreign() {
  local sid
  ((!ALL)) && [[ -n ${CLAUDE_CODE_SESSION_ID:-} ]] || return 1
  sid=$(tr '\0' '\n' 2>/dev/null <"/proc/$1/environ" | sed -n 's/^CLAUDE_CODE_SESSION_ID=//p') ||
    sid=
  [[ -n $sid && $sid != "$CLAUDE_CODE_SESSION_ID" ]]
}

# Whether a process names this Claude Code session.
mine() {
  local sid
  [[ -n ${CLAUDE_CODE_SESSION_ID:-} ]] || return 1
  sid=$(tr '\0' '\n' 2>/dev/null <"/proc/$1/environ" | sed -n 's/^CLAUDE_CODE_SESSION_ID=//p') ||
    sid=
  [[ $sid == "$CLAUDE_CODE_SESSION_ID" ]]
}

# Whether a process runs inside one of the --under directories (always true without --under).
under() {
  local cwd dir
  ((${#UNDER[@]})) || return 0
  cwd=$(readlink "/proc/$1/cwd" 2>/dev/null) || cwd=
  cwd=${cwd% (deleted)}
  for dir in "${UNDER[@]}"; do
    if [[ $cwd == "$dir" || $cwd == "$dir"/* ]]; then return 0; fi
  done
  return 1
}

# Seconds as `ps` prints elapsed time: [[DD-]HH:]MM:SS.
etime() {
  local s=$1 d h m
  ((d = s / 86400, h = s % 86400 / 3600, m = s % 3600 / 60, s %= 60))
  if ((d)); then
    printf '%d-%02d:%02d:%02d' "$d" "$h" "$m" "$s"
  elif ((h)); then
    printf '%02d:%02d:%02d' "$h" "$m" "$s"
  else
    printf '%02d:%02d' "$m" "$s"
  fi
}

LISTED=()
while IFS= read -r line; do
  [[ -n $line ]] || continue
  read -r pid _ <<<"$line"
  [[ -e /proc/$pid ]] || continue
  foreign "$pid" && continue
  under "$pid" || continue
  [[ $SAFE == *" $pid "* ]] && continue
  if ((STALE)); then
    age=$(ps -o etimes= -p "$pid") || continue
    ((age >= 10#$MIN_AGE)) || continue
  fi
  LISTED+=("$line")
done <<<"$ORPHANS"

SCOPES=()
if ((MGR != 1)); then
  UNITS=$(systemctl --user list-units --type=scope --state=active --no-legend --plain 'run-*.scope') || {
    echo "sweep-orphans.sh: could not list the user scopes; this is not a clean result" >&2
    exit 1
  }
  NOW=$(date +%s)
  while read -r unit _; do
    [[ -n $unit ]] || continue
    props=$(systemctl --user show --timestamp=unix -p ActiveEnterTimestamp -p ControlGroup \
      -p Description "$unit") || continue
    started=$(sed -n 's/^ActiveEnterTimestamp=@//p' <<<"$props")
    cgroup=$(sed -n 's/^ControlGroup=//p' <<<"$props")
    cmd=$(sed -n 's/^Description=//p' <<<"$props")
    cmd=${cmd#\[systemd-run\] }
    [[ $started == +([0-9]) && -n $cgroup ]] || continue
    ((NOW - started >= 10#$MIN_AGE)) || continue
    procs=$(cat "/sys/fs/cgroup$cgroup/cgroup.procs" 2>/dev/null) || continue
    # One process of another session or one ancestor hides the scope. Otherwise one process inside
    # --under keeps it, and without --under one process of this session (any process with --all).
    keep=0
    for pid in $procs; do
      [[ $SAFE == *" $pid "* ]] && continue 2
      foreign "$pid" && continue 2
      if ((${#UNDER[@]})); then
        under "$pid" && keep=1
      elif ((ALL)) || mine "$pid"; then
        keep=1
      fi
    done
    ((keep)) || continue
    cpu=$(ps -o pcpu= -p "$(paste -sd, <<<"$procs")" | awk '{s += $1} END {printf "%.1f", s}') ||
      cpu=0.0
    SCOPES+=("$unit $(etime $((NOW - started))) $cpu $cmd")
  done <<<"$UNITS"
fi

for line in "${LISTED[@]}" "${SCOPES[@]}"; do
  printf '%s\n' "$line"
done
((KILL)) || exit 0

if ((${#SCOPES[@]})); then
  STOP=()
  for line in "${SCOPES[@]}"; do
    STOP+=("${line%% *}")
  done
  systemctl --user stop "${STOP[@]}" || true
  running=()
  for unit in "${STOP[@]}"; do
    systemctl --user is-active --quiet "$unit" && running+=("$unit")
  done
  if ((${#running[@]})); then
    echo "stopped $((${#STOP[@]} - ${#running[@]})) scopes; still active: ${running[*]}" >&2
    FAILED=1
  else
    echo "stopped ${#STOP[@]} scopes" >&2
  fi
fi
((${#LISTED[@]})) || exit "$FAILED"

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
exit "$FAILED"
