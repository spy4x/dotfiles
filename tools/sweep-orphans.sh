#!/usr/bin/env bash
# List processes an agent session left running. Empty output means clean.
#
# A tool call's children inherit the harness's cgroup and keep it when they are
# reparented, so orphans are members of this cgroup whose parent is now init or
# the systemd user manager. Anything that moves itself to a fresh cgroup (a
# Docker container, `systemd-run --scope`) is invisible here: clean it by name.
#
# The two exclusions are the desktop app and the login shells it abandons, one
# set per session. Both match the full command line exactly: a suffix pattern
# would also hide e.g. `tail -f /opt/claude-desktop/claude-desktop`.
#
# Read the output before killing anything: a live sibling session's work can
# appear here too.
#
# Needs Linux with cgroup v2 and a systemd user manager. Elsewhere it fails
# loudly instead of printing a falsely clean result; fall back to
# `ps -eo pcpu,etime,args --sort=-pcpu | head`, which finds only CPU burners.
set -euo pipefail

CG=$(cut -d: -f3 /proc/self/cgroup)
ps -o pid=,ppid=,etime=,pcpu=,args= -p "$(paste -sd, "/sys/fs/cgroup$CG/cgroup.procs")" |
  awk -v mgr="$(pgrep -xu "$USER" systemd || echo 1)" '
    ($2==1 || $2==mgr) {
      cmd = $0; sub(/^ *([^ ]+ +){4}/, "", cmd)
      if (cmd != "/usr/bin/zsh -l" && cmd != "/opt/claude-desktop/claude-desktop") print
    }'
