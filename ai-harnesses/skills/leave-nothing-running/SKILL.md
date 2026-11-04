---
name: leave-nothing-running
description: "The owner's rules for processes this session starts or stops: the orphan sweep and its flags, killing processes safely, the process and memory cap, containers, browsers and cloud servers. Load before you run a fan-out or a test that spawns processes, start a container, a browser or a cloud server, kill or signal any process (kill, pkill, killall), and before reporting done (the sweep)."
---

# Leave nothing running

Part of the global rules (`AGENTS.md`, "Leave nothing running"); they bind as if written there.

## Sweep

Sweep before reporting done: `~/sync/code/dotfiles/tools/sweep-orphans.sh`. It lists this
session's orphans, one per line: PID, elapsed time, CPU, command. It also lists `systemd-run --user
--scope` units (`run-*.scope`) older than an hour, with the unit name in place of the PID;
`--min-age <seconds>` changes the hour. A subagent adds `--under <worktree> <scratch dir>`, reads
the list, then reruns it with `--kill` to stop exactly those. Empty output = clean. The lead's final
sweep adds `--all`, which shows other sessions' orphans and unused anonymous Docker volumes and
networks. One older than 24 hours is abandoned, whoever started it: stop it with `--stale --kill`
and report what it stopped. Report a younger one, never kill it. It lists no containers: remove
yours by name, with their volumes.

## Killing processes

Kill only a PID you started, or one `sweep-orphans.sh` listed first on its line; prefer its
`--kill`. Never signal PID 1, any `systemd` process, the desktop (kwin, plasmashell, sddm, dbus,
pipewire, Xwayland), your own harness or the processes above it. Never run `kill -1`, `systemctl
--user exit`, `loginctl terminate-*` or a shutdown or reboot. Before `pkill` or `killall`, run
`pgrep -a` with the same pattern and read every match: a wrong PID can end the whole desktop
session (`ai-memory/incidents/agent-rule-stories.md`).

## Cap anything that spawns processes

Tests with fake binaries, fan-out scripts, a lane's test run: cap them so a runaway stops at the cap
instead of filling the machine's memory:

```bash
systemd-run --user --scope --quiet -p TasksMax=4000 -p MemoryMax=8G timeout 120 <cmd>
```

4,000 is a trial, due for review on 2026-10-28 (`ai-memory/experiments/tasksmax-4000.md`). A run
the cap stopped, or a runaway it caught, gets a row in that file.

Never `ulimit -u`: it counts every thread the user owns (over 3,000 here), so the first fork fails.
Containers: `--pids-limit=500 --memory=8g`.

## Browsers and cloud servers

Always close browser contexts at the end of a lane, including on the failure path. A failed lane
that leaks a browser is worse than a failed lane.

A test that needs a cloud server (Hetzner Cloud) creates one of the cheapest type that runs the
test, keeps it no longer than the test needs, and deletes it with every SSH key and volume it
created, whether the test passed or failed.
