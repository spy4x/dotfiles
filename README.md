# Dotfiles

In this repo I store config files for my development environment. It helps me to
install quickly all software I need for work and fun.\
Feel free to check & alter the configs as you like.

## Prerequisites

### Install Deno

```bash
curl -fsSL https://deno.land/install.sh | sh
```

### Supported Platforms

- **Linux**: zypper (openSUSE), dnf (Fedora/RHEL), apt (Debian/Ubuntu)

## Scripts Overview

This repository includes two main automation scripts:

### 1. Application Installer (`install-apps.ts`)

Installs applications from a unified JSON configuration with cross-platform support.

### 2. Shell Setup (`install-shell.ts`)

Configures a complete shell environment with Zsh, Oh My Zsh, Powerlevel10k theme, and custom aliases.

---

## 🚀 Quick Start

### Install Applications

````bash
deno task install-apps

### Setup Shell Environment
```bash
deno task install-shell

### Complete Setup (Both Scripts)
```bash
deno task install-all
````

---

## 🔗 Sync Local Config

Repo holds dotfiles, home uses symlinks. AI harness config is copied, not linked — see
[AI harness config](#-ai-harness-config-ai-harnesses).

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
```

## 🧱 Host limits for a many-agent workstation (`system/`)

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

---

## 📜 AI harness config (`ai-harnesses/`)

Claude Code, OpenCode and DSH (the DeepSeek harness) get their global rules, skills, agents and
settings from one directory, `ai-harnesses/`. Each skill and agent is written once, in a
harness-neutral format, and `deno task ai` renders it into the format each harness reads. Three
harnesses reading three hand-kept copies is how they drift apart.

```bash
deno task ai           # dry-run: what would change
deno task ai --apply   # write to every harness installed on this machine
deno task ai --check   # exit 1 if anything drifted
```

Run `--apply` from the **main checkout, after merge**. From a linked worktree it writes nothing
and prints each change as `[WITHHELD]`: config from an unmerged branch — hooks included — must
not go live for every session on the machine before it is reviewed. `--apply --from-worktree`
overrides that, deliberately.

### Layout

| Source                                | Claude Code (`~/.claude`)        | OpenCode (`~/.config/opencode`)              | DSH (`$DSH_HOME`, default `~/.local/share/dsh`)   |
| ------------------------------------- | -------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| `AGENTS.md`                           | `CLAUDE.md`                      | `AGENTS.md`                                  | `AGENTS.md`                                       |
| `skills/<name>/` (`SKILL.md` + files) | `skills/<name>/`                 | `skills/<name>/` and/or `commands/<name>.md` | `skills/<name>/`                                  |
| `agents/<name>.md`                    | `agents/<name>.md`               | `agents/<name>.md`                           | `.agent-presets/<name>/{preset,agent.cordis}.yml` |
| `settings/<harness>/**`               | `settings.json` merged, `hooks/` | `opencode.json`, `tui.json` merged           | `settings.yaml` merged, `profiles/web/*` copied   |

`config.jsonc` says where each harness lives, whether it is enabled (`auto`: its home exists or
its binary is on `PATH`), which settings files are merged instead of copied, and which model each
neutral tier means.

### Writing a skill or an agent

Frontmatter is validated (`schema.ts`); an unknown key fails the run instead of being ignored.

```yaml
# skills/<name>/SKILL.md
name: audit # must match the directory
description: …
invocation: user # user: slash command only · model: loaded on demand (default) · both
argument-hint: "[path]" # Claude Code only
targets: [claude, opencode] # optional; default is every harness
harness: # optional frontmatter one harness understands
  opencode: { subtask: true }
```

```yaml
# agents/<name>.md
name: reviewer
description: …
mode: subagent # or primary (not rendered for Claude Code, which has none)
tier: strong # cheap | standard | strong | strongest → a model per harness
effort: high
temperature: 0.1
tools: [read, search, shell] # read | search | shell | edit | web; omitted = everything
targets: [opencode, dsh]
harness:
  claude: { color: red }
```

The body is shared: `harness` carries frontmatter only. If a body has to differ per harness, it is
two items with two names. Write tool names neutrally ("spawn a subagent", not "use the Task
tool").

How `invocation` renders:

| `invocation` | Claude Code                           | OpenCode             | DSH                                   |
| ------------ | ------------------------------------- | -------------------- | ------------------------------------- |
| `model`      | skill                                 | skill                | skill                                 |
| `user`       | skill with `disable-model-invocation` | `commands/<name>.md` | skill with `disable-model-invocation` |
| `both`       | skill                                 | skill and command    | skill                                 |

### Details worth knowing

- **Real directories, never symlinks.** DSH does not reliably follow a symlink at `$DSH_HOME`,
  Claude Code skips a symlinked `~/.claude/CLAUDE.md` in some session types, apps that save
  settings replace a symlink with a real file, and a symlinked home puts sessions, lockfiles and
  credentials inside this synced repo. A home that still resolves into a git checkout is reported
  as `[BLOCKED]` and never written.
- **Settings merge.** A tracked settings file owns the keys it names, one level deep inside
  objects: `permissions.ask` and `hooks.PreToolUse` are replaced wholesale, while
  `permissions.allow`, `theme` and anything else the app saved are left alone. Machine-specific
  settings go in the live file directly — just not under a tracked key.
- **The merge adds and replaces; it never removes.** Deleting a key here does not delete it from
  the live file, and `--apply` then reports `in sync`. Remove such a key from the live file by
  hand on each machine, in the same change.
- **Manifest.** Each home gets a `.dotfiles-sync.json` listing what the script wrote. A file
  deleted here is deleted there on the next `--apply`; a file the script never wrote is never
  touched. Merged settings are never deleted, and neither is anything that resolves into a git
  checkout: such a file is never recorded, and a recorded one that later resolves into a
  checkout stays `[BLOCKED]` instead of being removed.
- **Tests.** `deno task test` covers each adapter with golden files in `fixtures/golden/`. After
  an intended rendering change: `deno test -A ai-harnesses/adapters.test.ts -- --update`, then
  review the golden diff.

### Moving a machine off the old symlinks

Until September 2026, `~/.config/opencode` and `~/.local/share/dsh` were symlinks into
`.config/opencode/` and `.dsh/` in this repo, and Syncthing replicated their sessions and DSH
credentials to every machine. Once per machine, from the main checkout after pulling the
`ai-harnesses` layout:

```bash
systemctl --user stop dsh opencode-web   # whatever runs a harness on this machine
deno task ai migrate                     # dry-run: lists what moves
deno task ai migrate --apply             # symlink → real directory; runtime leftovers move into it
deno task ai --apply
deno task ai --check
systemctl --user start dsh opencode-web
```

`migrate` refuses while the old directory still holds tracked files, so only runtime leftovers
move — sessions, storages, credentials, lockfiles. It renames the old directory into place in one
step and never deletes; if the rename fails, the symlink is put back. On a machine where
Syncthing already emptied the old directory, the symlink dangles: `--apply` reports that home as
`[BLOCKED]`, and `migrate` replaces the symlink with an empty directory. The DSH credentials are
gone on that machine, so sign in to DSH again. They stay out of `~/sync/code` from then on.

### Claude Code hooks (`settings/claude/hooks/`) — disabled

Written, tested, **not wired up**: `settings/claude/settings.json` has no `hooks` key, so nothing
runs and the scripts are not copied to `~/.claude/`. A `PreToolUse` hook on Bash runs before every
shell command, which is more ceremony than the rules it guards are worth right now.

| Hook           | Event                             | Would do                                                                                                                                                        |
| -------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard-git.ts` | `PreToolUse` (Bash)               | ask before a commit on `main`/`master` and before `gh pr merge`; deny `git worktree add` inside a checkout; run gitleaks on unpushed commits and on `gh` bodies |
| `worktree.ts`  | `WorktreeCreate`/`WorktreeRemove` | put Claude Code's built-in worktrees in the sibling `worktrees/<repo>/<type>/<slug>` layout instead of `<repo>/.claude/worktrees/`                              |

To enable: copy the `hooks` block from `settings/claude/hooks/settings.hooks.json` into
`settings/claude/settings.json`, then `deno task ai --apply`. The script ships `hooks/` only while
that key exists, and removes the scripts again when it goes. To run the guard less often, add
`"if": "Bash(git *)"` to its handler (and a second handler with `"Bash(gh *)"`).

Without the worktree hook, Claude Code's built-in worktree features nest checkouts under
`<repo>/.claude/worktrees/`, which repo tooling then walks. `AGENTS.md` tells the agent to create
worktrees by hand instead; don't tick the worktree option when starting a desktop session.

OpenCode and DSH pick up changes on the next session start.

### Tmux plugins

```bash
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
```

In tmux: `prefix + I` to install plugins.

---

## 📱 Application Installer (`install-apps.ts`)

### Features

- **Cross-Platform**: Automatically detects package manager (apt, dnf, zypper, winget, homebrew)
- **Fallback Support**: Tries Flatpak if native package installation fails (Linux)
- **Repository Management**: Handles adding repositories with GPG key support
- **Architecture Filtering**: Skips apps incompatible with current architecture
- **Pre/Post Commands**: Executes custom commands before/after installation
- **Smart Recovery**: Continues with Flatpak if native packages fail
- **Installation Summary**: Reports successful, failed, and skipped installations

### Configuration (`apps.jsonc`)

Edit `apps.jsonc` to customize applications. Supports comments via `//`. Each app supports:

- **Package Managers**: `dnf`, `apt`, `zypper`, `winget`, `homebrew` arrays
- **Flatpak**: `flatpak` ID (Linux only, preferred for GUI apps)
- **Repositories**: `repoUrl` and `repoGpgKey` for adding repositories
- **Commands**: `preInstallCommands` and `postInstallCommands` arrays
- **System**: `requiresReboot` boolean flag
- **Platform**: `architectures` array to limit supported architectures

#### Example App Entry

```json
{
  "name": "VS Code",
  "repoUrl": "https://packages.microsoft.com/yumrepos/vscode",
  "repoGpgKey": "https://packages.microsoft.com/keys/microsoft.asc",
  "dnf": ["code"],
  "apt": ["code"],
  "zypper": ["code"],
  "winget": ["Microsoft.VisualStudioCode"],
  "homebrew": ["visual-studio-code"],
  "flatpak": "com.visualstudio.code",
  "architectures": ["x86_64", "aarch64"]
}
```

#### App Configuration Options

| Field                 | Type       | Description                                     |
| --------------------- | ---------- | ----------------------------------------------- |
| `name`                | `string`   | Display name of the application                 |
| `dnf`                 | `string[]` | Package names for DNF (Fedora/RHEL)             |
| `apt`                 | `string[]` | Package names for APT (Debian/Ubuntu)           |
| `zypper`              | `string[]` | Package names for Zypper (openSUSE)             |
| `winget`              | `string[]` | Package IDs for Winget (Windows)                |
| `homebrew`            | `string[]` | Formula names for Homebrew (macOS)              |
| `flatpak`             | `string`   | Flatpak application ID (Linux only)             |
| `repoUrl`             | `string`   | Repository URL to add before installation       |
| `repoGpgKey`          | `string`   | GPG key URL for repository verification         |
| `preInstallCommands`  | `string[]` | Commands to run before installation             |
| `postInstallCommands` | `string[]` | Commands to run after installation              |
| `requiresReboot`      | `boolean`  | Whether installation requires system reboot     |
| `architectures`       | `string[]` | Supported architectures (x86_64, aarch64, etc.) |
| `winget`              | `string[]` | Package IDs for Winget (Windows)                |
| `homebrew`            | `string[]` | Formula names for Homebrew (macOS)              |
| `flatpak`             | `string`   | Flatpak application ID (Linux only)             |
| `repoUrl`             | `string`   | Repository URL to add before installation       |
| `repoGpgKey`          | `string`   | GPG key URL for repository verification         |
| `preInstallCommands`  | `string[]` | Commands to run before installation             |
| `postInstallCommands` | `string[]` | Commands to run after installation              |
| `requiresReboot`      | `boolean`  | Whether installation requires system reboot     |
| `architectures`       | `string[]` | Supported architectures (x86_64, aarch64, etc.) |

#### Command Variables

Commands support environment variable expansion:

- `$USER` - Current username
- `$HOME` - User home directory

---

## 🐚 Shell Setup (`install-shell.ts`)

### What It Installs & Configures

1. **Zsh Shell**: Modern shell with advanced features
2. **Oh My Zsh**: Popular Zsh framework with plugins and themes
3. **Powerlevel10k**: Fast, customizable prompt theme
4. **Custom Aliases**: Automatically integrates `aliases.sh` from this repository
5. **Default Shell**: Sets Zsh as your default shell automatically

### Features

- **Cross-Platform**: Automatically detects package manager (apt, dnf, zypper, etc.)
- **Smart Installation**: Skips already installed components
- **Sequential Execution**: Steps depend on previous steps - stops on first failure
- **Aliases Integration**: Sources `aliases.sh` directly (no manual setup needed)
- **Automatic Configuration**: Sets up Powerlevel10k theme automatically
- **Error Handling**: Reports success/failure for each step
- **Shell Integration**: Automatically sets Zsh as default shell

### Installation Process

The script executes these steps in order:

1. **Package Manager Update**: Updates package lists
2. **Install Zsh**: Installs Zsh shell via system package manager
3. **Install Oh My Zsh**: Downloads and installs Oh My Zsh framework
4. **Install Powerlevel10k**: Clones Powerlevel10k theme
5. **Configure Theme**: Updates `.zshrc` to use Powerlevel10k
6. **Setup Aliases**: Configures `.zshrc` to source custom aliases
7. **Set Default Shell**: Changes default shell to Zsh
8. **Verification**: Verifies shell change took effect

### Post-Installation

After installation completes:

- **New Terminal Sessions**: Open a new terminal to use Zsh with the new configuration
- **Powerlevel10k Setup**: On first run, you'll be prompted to configure the theme with `p10k configure`
- **Custom Aliases**: All aliases from `aliases.sh` are automatically available
- **Manual Theme Config**: Run `p10k configure` anytime to reconfigure the theme

### Important Notes

- **Shell Change**: The script automatically attempts to set Zsh as your default shell
- **Session Reload**: Changes take effect in new terminal sessions or by running `exec zsh`
- **Theme Configuration**: Powerlevel10k will prompt for configuration on first use
- **Aliases Integration**: No manual copying needed - aliases are sourced directly

---

## 🛠️ Development

### File Structure

```
dotfiles/
├── .tmux.conf          # tmux config (tpm, resurrect, continuum)
├── .zshrc              # zsh config
├── .p10k.zsh           # powerlevel10k theme config
├── ai-harnesses/       # AI harness rules, skills, agents, settings (deno task ai)
├── .config/
│   └── nvim/           # neovim config
├── install-apps.ts      # Application installer
├── install-shell.ts     # Shell environment setup  
├── shared.ts           # Common utilities
├── apps.jsonc          # Application configurations (with comments)
├── aliases.sh          # Custom shell aliases
├── deno.jsonc          # Deno configuration
└── README.md           # This file
```

### Adding New Applications

1. Edit `apps.jsonc`
2. Add your application with appropriate package manager entries
3. Test with `deno task install-apps`

### Customizing Shell Setup

- **Aliases**: Edit `aliases.sh` to add custom aliases
- **Theme**: Modify the Powerlevel10k configuration in the script
- **Additional Steps**: Add new setup steps to the `setupSteps()` method
