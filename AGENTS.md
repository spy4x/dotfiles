# dotfiles

This repo is this machine's live config, so a merged PR is not done until it is applied
here. After every merge, from the main checkout (never a worktree):

1. `git merge --ff-only origin/main`. Everything reached through a symlink into this repo
   is live from this moment: `~/.zshrc`, `~/.zshenv`, `~/.config/{opencode,nvim}`,
   `~/.local/share/dsh`, `~/.config/obs-studio/*`. That includes DSH presets and skills,
   which is why `tools/gen_dsh.py` and `tools/gen_dsh_skills.py` run inside the PR, never
   after the merge.
2. A merge that untracks a file also deletes it from disk. If the machine still needs it,
   restore it: `git show ORIG_HEAD:<path> > <path>` (recreate its directory first).
3. Touched `.config/opencode/AGENTS.md` or `.claude/` → `deno task sync-agents-md --apply`,
   then `--check` must print `All targets in sync.`
4. Touched `system/syncthing-code.stignore` → `cp system/syncthing-code.stignore
   ~/sync/code/.stignore`.
5. Touched `system/etc/` → needs sudo, which an agent cannot run. Give me the exact
   commands from the README and say it is not applied yet.

Report what was applied and what is left for me.
