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
plaintext env file under `~/sync/code` (the names the Syncthing ignore list skips), leaving out
worktrees, `node_modules`, `.volumes`, `.git` and `.stversions`. It keeps 7 daily, 4 weekly and 12
monthly snapshots.

The restic repository is `~/sync/backups/workstation-secrets`, inside the `backups` Syncthing
folder, so the other machines that share that folder hold an encrypted copy. The first run creates
the password in `~/.config/restic/workstation-secrets.pass`, outside every synced folder. Save it
in the password manager: without it, no copy of the backup can be read. A run that finds the
repository but not the password file stops with an error instead of making a new password.

```bash
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/secrets-backup.service
systemctl --user link ~/sync/code/dotfiles/.config/systemd/user/secrets-backup.timer
systemctl --user enable --now secrets-backup.timer
systemctl --user start secrets-backup.service
```

To restore, on any machine that holds the repository and the password:

```bash
restic -r ~/sync/backups/workstation-secrets -p <password file> snapshots
restic -r ~/sync/backups/workstation-secrets -p <password file> restore latest --target /tmp/restore
```

The files come back under `/tmp/restore` with their full original paths. Copy the ones you need
into place and delete the rest.
