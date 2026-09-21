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

Repo holds dotfiles, home uses symlinks.

```bash
# tmux
mv ~/.tmux.conf ~/.tmux.conf.bak-$(date +%Y%m%d%H%M%S)
ln -s ~/dev/dotfiles/.tmux.conf ~/.tmux.conf

# opencode
mv ~/.config/opencode ~/.config/opencode.bak-$(date +%Y%m%d%H%M%S)
ln -s ~/dev/dotfiles/.config/opencode ~/.config/opencode

# nvim
mv ~/.config/nvim ~/.config/nvim.bak-$(date +%Y%m%d%H%M%S)
ln -s ~/dev/dotfiles/.config/nvim ~/.config/nvim

# zsh
mv ~/.zshrc ~/.zshrc.bak-$(date +%Y%m%d%H%M%S)
ln -s ~/dev/dotfiles/.zshrc ~/.zshrc

# p10k
mv ~/.p10k.zsh ~/.p10k.zsh.bak-$(date +%Y%m%d%H%M%S)
ln -s ~/dev/dotfiles/.p10k.zsh ~/.p10k.zsh
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

## 📜 AI harness config sync

One global instruction file, `.config/opencode/AGENTS.md`, feeds every harness. Same text
everywhere — three harnesses reading three dialects of the rules is how they drift.

| Harness     | File read                                                |
| ----------- | -------------------------------------------------------- |
| OpenCode    | `~/.config/opencode/AGENTS.md`                           |
| DSH         | `$DSH_HOME/AGENTS.md` (default `~/.local/share/dsh/...`) |
| Claude Code | `~/.claude/CLAUDE.md`                                    |

Claude Code also gets the contents of `.claude/` in this repo:

| Tracked here               | Lands in                  | How                                         |
| -------------------------- | ------------------------- | ------------------------------------------- |
| `.claude/agents`, `skills` | `~/.claude/<same>`        | mirrored; `*.test.ts` skipped               |
| `.claude/settings.json`    | `~/.claude/settings.json` | merged — tracked keys win, the rest is kept |

**Use the sync script — do not symlink manually:**

```bash
deno task sync-agents-md           # dry-run, prints planned actions
deno task sync-agents-md --apply   # write to runtime locations
deno task sync-agents-md --check   # exit 1 if any target drifted
```

Run `--apply` from the **main checkout, after merge**. From a linked worktree `--apply` writes
only the tracked copies inside that worktree and prints the rest as `[WITHHELD]`: config from an
unmerged branch — hooks included — must not go live for every session on the machine before it
is reviewed. `--apply --from-worktree` overrides that, deliberately.

Why copies, not symlinks:

- DSH does not reliably follow a symlink at `$DSH_HOME`; a chain breaks silently.
- Claude Code skips a symlinked `~/.claude/CLAUDE.md` in some session types, and an app that
  saves `settings.json` atomically replaces a symlink with a real file.
- This repo's path differs per machine, so an absolute `@import` cannot be shared either.

Details worth knowing:

- **Settings merge.** The tracked file owns the keys it names, one level deep inside objects:
  `permissions.ask` and `hooks.PreToolUse` are replaced wholesale, while `permissions.allow`,
  `theme` and anything else the app saved are left alone. Machine-specific settings go in
  `~/.claude/settings.json` directly — just not under a tracked key.
- **The merge adds and replaces; it never removes.** Deleting a key here does not delete it
  from the runtime — the merge only overlays the keys the tracked file still names, so the old
  value survives in `~/.claude/settings.json` and `--apply` reports `in sync`. Dropping
  `permissions.ask` from the tracked file, for example, leaves the prompts firing on every
  machine that already had them. Remove such a key from `~/.claude/settings.json` by hand on
  each machine, in the same change.
- **Manifest.** `~/.claude/.dotfiles-sync.json` lists what the script wrote. A file deleted here
  is deleted there on the next `--apply`; a file the script never wrote is never touched.
- **Symlinked runtime dirs.** Where `~/.config/opencode` or `~/.local/share/dsh` is a symlink
  into a checkout of this repo, the "runtime" file _is_ a tracked file. The script detects that
  and skips it — git updates it.
- **`deno fmt` picks the wrong config under `.config/opencode/`.** That directory has its own
  `package.json`, so Deno treats it as the project root and ignores this repo's `deno.jsonc`
  whenever the first path argument is inside it — or, with no path argument, whenever the current
  directory is. Markdown is then rewrapped at 80 columns instead of left as written, and a synced
  skill file stops matching its `.claude/` twin. Pass `--config deno.jsonc`, or put a path outside
  `.config/opencode/` first.
- **`.claude/` does double duty.** Claude Code also reads it as _project_ config for sessions
  opened in this repo. Identical hook handlers from user and project settings run once.

### Claude Code hooks (`.claude/hooks/`) — disabled

Written, tested, **not wired up**: `settings.json` has no `hooks` key, so nothing runs and the
scripts are not copied to `~/.claude/`. A `PreToolUse` hook on Bash runs before every shell
command, which is more ceremony than the rules it guards are worth right now.

| Hook           | Event                             | Would do                                                                                                                                                        |
| -------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard-git.ts` | `PreToolUse` (Bash)               | ask before a commit on `main`/`master` and before `gh pr merge`; deny `git worktree add` inside a checkout; run gitleaks on unpushed commits and on `gh` bodies |
| `worktree.ts`  | `WorktreeCreate`/`WorktreeRemove` | put Claude Code's built-in worktrees in the sibling `worktrees/<repo>/<type>/<slug>` layout instead of `<repo>/.claude/worktrees/`                              |

To enable: copy the `hooks` block from `.claude/hooks/settings.hooks.json` into
`.claude/settings.json`, merge, `deno task sync-agents-md --apply`. The sync script ships `hooks/`
only while that key exists, and removes the scripts again when it goes. To run the guard less
often, add `"if": "Bash(git *)"` to its handler (and a second handler with `"Bash(gh *)"`).

Without the worktree hook, Claude Code's built-in worktree features nest checkouts under
`<repo>/.claude/worktrees/`, which repo tooling then walks. `AGENTS.md` tells the agent to create
worktrees by hand instead; don't tick the worktree option when starting a desktop session.

`deno task test` runs the hook and sync tests against temp dirs.

OpenCode picks up `AGENTS.md` changes on the next session start; DSH reads the global file once
per session start. `.dsh/skills` and `.dsh/.agent-presets` are generated — re-run
`python3 tools/gen_dsh_skills.py` / `tools/gen_dsh.py` after editing `opencode.json` commands or
`.config/opencode/agents/`.

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
├── .config/
│   ├── opencode/       # opencode config
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
