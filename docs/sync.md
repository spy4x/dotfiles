# Sync local config

Repo holds dotfiles, home uses symlinks. AI harness config is copied, not linked — see
[ai-harnesses/README.md](../ai-harnesses/README.md).

```bash
# tmux
mv ~/.tmux.conf ~/.tmux.conf.bak-$(date +%Y%m%d%H%M%S)
ln -s ~/sync/code/dotfiles/.tmux.conf ~/.tmux.conf

# nvim
mv ~/.config/nvim ~/.config/nvim.bak-$(date +%Y%m%d%H%M%S)
ln -s ~/sync/code/dotfiles/.config/nvim ~/.config/nvim

# zsh
mv ~/.zshrc ~/.zshrc.bak-$(date +%Y%m%d%H%M%S)
ln -s ~/sync/code/dotfiles/.zshrc ~/.zshrc

# p10k
mv ~/.p10k.zsh ~/.p10k.zsh.bak-$(date +%Y%m%d%H%M%S)
ln -s ~/sync/code/dotfiles/.p10k.zsh ~/.p10k.zsh

# global git ignore (git reads ~/.config/git/ignore when core.excludesFile is unset)
mkdir -p ~/.config/git
B=~/.config/git/ignore.bak-$(date +%Y%m%d%H%M%S)
[ -e ~/.config/git/ignore ] && mv ~/.config/git/ignore "$B"
ln -s ~/sync/code/dotfiles/.config/git/ignore ~/.config/git/ignore
```

## Claude Desktop nightly update

A systemd user timer runs [`tools/claude-desktop-update.sh`](../tools/claude-desktop-update.sh)
every night at 03:00. A night the machine was off, asleep or logged out is caught up at the next
login. When it installs a new version, or when the update fails, a dialog says so and stays until
you close it. The script installs only what Anthropic's signing key signed; the key is committed
next to it. It refuses an expired repository index and an older version than the installed one, and
it swaps the new version in only once it is fully unpacked, so a failed update leaves the old app.

```bash
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/claude-desktop-update.service
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/claude-desktop-update.timer
systemctl --user enable --now claude-desktop-update.timer
```

## Secrets backup

Syncthing does not copy age keys or plaintext env files out of `~/sync/code`
([host limits](host-limits.md)), so a key made on this machine exists on its disk only. A systemd
user timer runs [`tools/secrets-backup.sh`](../tools/secrets-backup.sh) every night at 02:30; a
night the machine was off is caught up at the next start. It backs up every `.age` folder and every
plaintext env file, folder or symlink under `~/sync/code` (the names the Syncthing ignore list
skips), leaving out worktrees, `node_modules`, `.volumes`, `.git` and `.stversions`. It keeps 7
daily, 4 weekly and 12 monthly snapshots.

The restic repository is `~/sync/backups/workstation-secrets`, inside the `backups` Syncthing
folder, so the other machines that share that folder hold an encrypted copy. Its password is
`BACKUPS_PASSWORD` from `~/sync/code/homelab/.env.root`, the password of every server's backups,
read by restic at run time and never printed. Losing this machine does not lose it: the backup
runner on each server holds it too. The other side of that: a server that receives this repository
and holds that password can read every age key in it. A run that finds no `BACKUPS_PASSWORD` stops
with an error.

A failed run shows an error dialog that stays until you close it, with the command that shows why.

```bash
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/secrets-backup.service
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/secrets-backup-failed.service
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/secrets-backup.timer
systemctl --user enable --now secrets-backup.timer
systemctl --user start secrets-backup.service
```

To restore, on any machine that holds the repository; restic asks for `BACKUPS_PASSWORD`. On a new
machine, take it from the backup runner's `.env` on a server: the copy in homelab is inside this
backup.

```bash
restic -r ~/sync/backups/workstation-secrets snapshots
restic -r ~/sync/backups/workstation-secrets restore latest --target /dev/shm/restore
```

The files come back under `/dev/shm/restore`, which is in memory, with their full original paths.
Copy the ones you need into place, then delete the plaintext copies:

```bash
rm -rf /dev/shm/restore
```

## Run database backup

`~/.local/state/agent-run/runs.sqlite` holds every Claude Code session's prompts, tool output and
costs, and the background lead's queue ([headless runs](headless-runs.md)). It lives outside
Syncthing, so a systemd user timer backs it up with
[`tools/agent-backup.sh`](../tools/agent-backup.sh) every night at 03:15; a night the machine was
off is caught up at the next start. The backup is encrypted because the database holds prompt text
and tool output, which can quote anything a session read.

Each run writes a consistent copy with `VACUUM INTO` while sessions keep reading and writing the
live file, so nothing has to stop. The copy goes to `~/.local/state/agent-run/snapshots/` (folder
mode 0700, files 0600), must pass `PRAGMA integrity_check`, and is then backed up with restic. The
live file, its `-wal` and its `-shm` are never copied. The last 3 copies stay on disk; the
repository keeps 14 daily and 8 weekly snapshots. A machine without the database exits with
"nothing to back up".

The restic repository is `~/sync/backups/agent-runs`, in the `backups` Syncthing folder, with the
same password as the [secrets backup](#secrets-backup): `BACKUPS_PASSWORD` from
`~/sync/code/homelab/.env.root`, read by restic at run time and never printed. A run that finds no
`BACKUPS_PASSWORD` stops before it writes anything. A failed run sends an urgent push with the
command that shows why (`agent-run push`).

```bash
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/agent-backup.service
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/agent-backup-failed.service
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/agent-backup.timer
systemctl --user enable --now agent-backup.timer
systemctl --user start agent-backup.service
```

To restore, on any machine that holds the repository; restic asks for `BACKUPS_PASSWORD`:

```bash
restic -r ~/sync/backups/agent-runs snapshots
restic -r ~/sync/backups/agent-runs restore latest --target /dev/shm/restore
```

The copies come back under `/dev/shm/restore` with their full original paths. While no run, tick
or import is active (stop `agent-tick.timer` and the importer's timer first), delete the database's
`runs.sqlite-wal` and `runs.sqlite-shm`, which belong to the old file and would damage the restored
one, copy the newest `runs-*.sqlite` over `runs.sqlite`, start the timers again, then delete the
plaintext copies:

```bash
rm -rf /dev/shm/restore
```
