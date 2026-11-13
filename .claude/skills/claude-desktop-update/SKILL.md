---
name: claude-desktop-update
description: Install or update the Claude desktop app on this Fedora machine, where it has no in-app updater and no dnf package. Load when asked to install, update or restart Claude Desktop, or when the app shows "Update available" and restarting does not clear it.
---

# Install or update Claude Desktop

Anthropic ships the Linux desktop app only as a Debian package in an apt repository, and the app
never updates itself on Linux: its log says "in-app updater off (updates via apt)". Fedora has no
apt, so restarting the app never clears its "Update available" banner. The app here is the
official `.deb` unpacked into `/opt/claude-desktop`; the installed version is in
`/opt/claude-desktop/.deb-version`.

A systemd user timer, `claude-desktop-update.timer`, runs the update every night and shows a
dialog when it installed a new version or failed. Check it with
`systemctl --user list-timers claude-desktop-update.timer` and read the last run with
`journalctl --user -u claude-desktop-update.service -n 20`. Setup: `docs/sync.md`.

To update now:

1. **Check what is running.** List the desktop sessions with the session-management tools, if
   this harness has them. A session that is working loses its turn when the app quits, so name
   any such session to the user before they restart.
2. **Update.** Run `tools/claude-desktop-update.sh` from this repo. It prints `is current` when
   nothing is newer. It needs `sudo` without a password, because it replaces files under `/opt`
   and `/usr/local`. `--force` reinstalls the current version.
3. **Restart.** Ask the user to quit and reopen the app. Never kill the app yourself: that ends
   the session you are running in before you can report.

The Claude Code CLI, which is a separate install in `~/.local/bin`, updates with
`claude update`. A terminal session running the old CLI picks up the new one after it exits and
is resumed with `claude --continue`.

The desktop app downloads its own built-in Claude Code into `~/.config/Claude/claude-code/`, so
the CLI and the app can show different versions.
