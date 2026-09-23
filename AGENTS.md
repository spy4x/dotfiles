# dotfiles

This repo is this machine's live config, so a merged PR is not done until it is applied
here. After every merge, from the main checkout (never a worktree):

1. `git merge --ff-only origin/main`. Everything reached through a symlink into this repo
   is live from this moment: `~/.zshrc`, `~/.zshenv`, `~/.tmux.conf`, `~/.config/nvim`,
   `~/.config/obs-studio/*`.
2. A merge that untracks a file also deletes it from disk. If the machine still needs it,
   restore it: `git show ORIG_HEAD:<path> > <path>` (recreate its directory first).
3. Touched `ai-harnesses/` → `deno task ai`, then `deno task ai --check` must print
   `All targets in sync.` That covers Claude Code, OpenCode and DSH; they are real
   directories, never symlinks into this repo.
4. Touched `system/syncthing-code.stignore` → `cp system/syncthing-code.stignore
   ~/sync/code/.stignore`.
5. Touched `system/etc/` → needs sudo, which an agent cannot run. Give me the exact
   commands from the README and say it is not applied yet.

Report what was applied and what is left for me.
