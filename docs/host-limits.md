# Host limits for a many-agent workstation (`system/`)

Running a dozen or more agent sessions at once pushes two kernel and daemon limits that a
single-user desktop never reaches. The files under `system/` are the tracked copies. Nothing
installs them automatically — copy them by hand on a new machine.

**inotify instances.** Every editor, file watcher, dev server and agent session opens its own
inotify instance, and each one counts against `fs.inotify.max_user_instances`. On Fedora with
Plasma, `kde-inotify-survey` notices the limit filling up, raises it a little, writes
`/etc/sysctl.d/50-kde-inotify-survey-max_user_instances.conf`, and pops a notification. It will
keep doing that. `system/etc/sysctl.d/90-inotify.conf` sets the limit to 1024 once; the `90-`
prefix sorts after the KDE file, so this value wins.

```bash
sudo cp system/etc/sysctl.d/90-inotify.conf /etc/sysctl.d/90-inotify.conf
sudo sysctl --system
```

The watch limit (`fs.inotify.max_user_watches`) is a separate number and is already generous on
Fedora — check it before assuming it is the one being hit.

**`/tmp` on tmpfs.** Fedora mounts `/tmp` as tmpfs and cleans it at an age of 10 days. Throwaway
Deno caches from CI-emulation runs accumulate far faster than that, and because tmpfs is RAM
they cost memory the whole time. `system/etc/tmpfiles.d/tmp.conf` shortens the age to 2 days;
the agent instructions tell every run to delete its own cache, and this is the backstop for the
ones that get killed. It keeps the upstream basename on purpose — a drop-in under a different
name would also win, by sort order, but systemd then logs a duplicate-line warning on every
cleanup run.

```bash
sudo cp system/etc/tmpfiles.d/tmp.conf /etc/tmpfiles.d/tmp.conf
sudo systemd-tmpfiles --clean
```

**zram swap.** Fedora sizes zram at the smaller of RAM and 8 GB. Many parallel sessions fill
that quickly, and the kernel then falls back to disk swap or the OOM killer.
`system/etc/systemd/zram-generator.conf` raises it to 64 GB. zram only takes RAM for pages
actually swapped, compressed, so a large size costs nothing while idle.

```bash
sudo cp system/etc/systemd/zram-generator.conf /etc/systemd/zram-generator.conf
sudo systemctl daemon-reload
sudo swapoff /dev/zram0
sudo zramctl --reset /dev/zram0
sudo cat /sys/class/zram-control/hot_add
sudo systemctl start systemd-zram-setup@zram0.service dev-zram0.swap
zramctl
```

A plain `systemctl restart systemd-zram-setup@zram0.service` fails here with "Device or resource
busy" and leaves the machine without swap. `zramctl --reset` removes the device node as well, so
`hot_add` recreates it (it prints the new device number, `0`) before the service can set the size.

**Tasks per app.** An agent's test once put a fake `rsync` on `PATH` that found and ran itself.
It grew to 4,900 processes, about 40,600 tasks and 77 GB of RAM inside the Claude app, and a game
crashed. Nothing stopped it, because systemd lets each app create up to 111,895 tasks by default.
`system/etc/systemd/user.conf.d/50-tasks-max.conf` lowers that default to 16,384 tasks for each
app, service and scope. A task is a process or a thread. Each app keeps its own budget, so a runaway
in the Claude app cannot use up the game's or the browser's. When this was written, the Claude app
held about 900 tasks and no other app more than 900. The agent rules still cap each command at 500
tasks; this file is the backstop for a command that skips that cap. When the Claude app reaches the
limit, every session in it fails to start new processes until the runaway ends, and the kernel log
says `fork rejected by pids controller`.

```bash
sudo mkdir -p /etc/systemd/user.conf.d
sudo cp system/etc/systemd/user.conf.d/50-tasks-max.conf /etc/systemd/user.conf.d/50-tasks-max.conf
systemctl --user daemon-reexec
for u in $(systemctl --user list-units --plain --no-legend 'app-com.anthropic.Claude-*.scope' | awk '{print $1}'); do
  systemctl --user set-property --runtime "$u" TasksMax=16384
done
systemctl --user show -p DefaultTasksMax
systemctl --user show 'app-com.anthropic.Claude-*.scope' -p Id -p TasksMax
```

The loop caps the running Claude app now; other apps get the new default when they next start.

**Syncthing and worktrees.** Agent worktrees are created under `~/sync/code/worktrees/`, inside a
Syncthing folder. Syncthing indexes and watches everything it does not ignore, so without an
ignore line it holds an inotify watch per worktree directory and replicates build output to
every other machine. A worktree is not worth syncing: it is rebuilt from `origin` on demand, and
its `.git` file names an absolute path in the main checkout, so the copy is broken anyway.
`system/syncthing-code.stignore` is the tracked copy of the ignore list for the `code` folder.

```bash
cp system/syncthing-code.stignore ~/sync/code/.stignore
```

Syncthing re-reads the file on the next scan. To confirm it took effect, open the web UI and
rescan the folder, then check that the Syncthing process is holding far fewer inotify watches:

```bash
for p in $(pgrep -x syncthing); do echo "$p $(cat /proc/$p/fdinfo/* 2>/dev/null | grep -c '^inotify ')"; done
```
