# Weekly content runs

The owner publishes one post, one video and one Short a week (the `weekly-content` skill). Two
unattended runs take everything but the recording off him. Both start headless leads through
ringmaster's `agent-run`
([docs/headless-runs.md](https://github.com/spy4x/ringmaster/blob/main/docs/headless-runs.md)).

## The preparation run

A systemd user timer fires every hour on Mondays from 07:00 to 21:00; `Persistent=true` catches up
a Monday the machine was off. Each fire runs
[`tools/weekly-content-prepare.sh`](../tools/weekly-content-prepare.sh), which:

1. Exits at once when this ISO week's marker exists (`~/.local/state/weekly-content/2026-W48`
   style). A second fire in the same week does nothing.
2. Holds, without a marker, while the user CPU pressure (`some avg60` in
   `/sys/fs/cgroup/user.slice/cpu.pressure`) is above 40. The next hourly fire retries. A missing or
   unreadable pressure file does not hold.
3. Reads whose turn it is from the line `<n>. <Name>, now.` in the `weekly-content` skill and uses
   `~/sync/code/<lowercased name>` as the run's folder. Either one missing fails the unit with a
   clear message.
4. Raises that project's lead limit from 0 to 1 (`agent-run limit --project <p> --leads 1`), since a
   project's default of 0 refuses every lead. A limit of 1 or more is never changed.
5. Starts one lead (`opus`, effort `medium`, deadline 2h, cap $20) with the brief
   [`tools/weekly-content-prepare.md`](../tools/weekly-content-prepare.md), and writes the marker
   only when the start succeeded. A refused start (usage level, limit) writes none, so the next fire
   retries.

The lead picks the topic, starts the post, writes `~/recordings/<slug>/kit.md` and sends one push,
`Kit ready: <topic>`. It sends no reminders.

The lead limit of 1 stays on the project. If ringmaster's old tick timer is ever installed again, it
may start its own leads there too; it is not installed today.

Setup:

```bash
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/weekly-content-prepare.service
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/weekly-content-prepare.timer
systemctl --user enable --now weekly-content-prepare.timer
```

Stop it with `systemctl --user disable --now weekly-content-prepare.timer`. A run already started
stops with `agent-run stop <id>` (`agent-run status --active` lists it).

## The cut run

After the owner records, a second run cuts the video and the Short and tells him they are ready. It
comes in [spy4x/dotfiles#405](https://github.com/spy4x/dotfiles/issues/405), once the cut command
in [spy4x/seed#1129](https://github.com/spy4x/seed/issues/1129) exists.
