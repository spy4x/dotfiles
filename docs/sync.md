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

## Code Mode release check

The global Claude Code settings turn on Code Mode (`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`). For now
it works only in the interactive terminal: headless runs (`claude -p`, Ringmaster's leads, the
desktop Code tab) print a warning and use the ordinary tools. They switch to Code Mode by themselves
once a release allows it. A systemd user timer runs
[`tools/code-mode-check.sh`](../tools/code-mode-check.sh) every night at 03:30 and sends one ntfy
notification when that happens. While the installed binary still contains the refusal text, the
check costs nothing; otherwise it confirms with one small Haiku run. After the notification it
writes `~/.local/state/code-mode-check/notified` and does nothing more; the timer can then be
disabled.

```bash
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/code-mode-check.service
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/code-mode-check.timer
systemctl --user enable --now code-mode-check.timer
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

## Work backup

Syncthing's `code` folder is no backup: a bad delete reaches every machine. A systemd user timer
runs [`tools/work-backup.sh`](../tools/work-backup.sh) every night at 03:30, catching up a night
the machine was off, and saves with restic what under `~/sync/code` exists only here:

- every top-level folder that is not a git repository, such as `mcps/`, whole;
- every repository with no remote, whole, `.git` included;
- in every other repository, and in its worktrees under `~/sync/code/worktrees`, the files no
  commit holds: modified, staged, and untracked but not ignored;
- per repository, a `git bundle` of the local commits that are on no remote.

It leaves out `node_modules`, `.volumes`, `.stversions`, and the age keys and plaintext env files
that the [secrets backup](#secrets-backup) saves. It reads the repositories and changes nothing in
them. It keeps 7 daily, 4 weekly and 12 monthly snapshots, tagged `work`. The repository is
`~/sync/backups/workstation-work`, with the same `BACKUPS_PASSWORD` as the secrets backup, read by
restic at run time and never printed. A failed run shows an error dialog.

```bash
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/work-backup.service
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/work-backup-failed.service
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/work-backup.timer
systemctl --user enable --now work-backup.timer
systemctl --user start work-backup.service
```

To restore, on any machine that holds the repository (restic asks for `BACKUPS_PASSWORD`), list
what a snapshot holds, then restore the paths you need into an empty folder:

```bash
restic -r ~/sync/backups/workstation-work snapshots
restic -r ~/sync/backups/workstation-work ls latest | grep -e mcps/ -e '\.bundle$'
restic -r ~/sync/backups/workstation-work restore latest --target ~/restore \
  --include ~/sync/code/mcps
```

Files come back under `~/restore` with their full original paths. The bundles come back under the
temporary folder the run used, such as `~/restore/tmp/tmp.AbC123/bundles/seed.bundle` (a nested
repository's path joins its folders with `__`). Fetch a bundle's branches into the repository's
clone:

```bash
git -C ~/sync/code/seed bundle verify ~/restore/tmp/tmp.AbC123/bundles/seed.bundle
git -C ~/sync/code/seed fetch ~/restore/tmp/tmp.AbC123/bundles/seed.bundle 'refs/heads/*:refs/heads/restored/*'
```

## Run database backup

The run database `~/.local/state/agent-run/runs.sqlite` is backed up by spy4x/ringmaster, which
owns it: `~/sync/code/ringmaster/docs/backup.md`.
