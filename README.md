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

## 📜 AI harness config sync

One global instruction file, `.config/opencode/AGENTS.md`, feeds every harness. Same text
everywhere — three harnesses reading three dialects of the rules is how they drift.

| Harness     | File read                                                |
| ----------- | -------------------------------------------------------- |
| OpenCode    | `~/.config/opencode/AGENTS.md`                           |
| DSH         | `$DSH_HOME/AGENTS.md` (default `~/.local/share/dsh/...`) |
| Claude Code | `~/.claude/CLAUDE.md`                                    |

Claude Code also gets the contents of `.claude/` in this repo:

| Tracked here                        | Lands in                  | How                                         |
| ----------------------------------- | ------------------------- | ------------------------------------------- |
| `.claude/agents`, `skills`, `hooks` | `~/.claude/<same>`        | mirrored; `*.test.ts` skipped               |
| `.claude/settings.json`             | `~/.claude/settings.json` | merged — tracked keys win, the rest is kept |

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
- **Manifest.** `~/.claude/.dotfiles-sync.json` lists what the script wrote. A file deleted here
  is deleted there on the next `--apply`; a file the script never wrote is never touched.
- **Symlinked runtime dirs.** Where `~/.config/opencode` or `~/.local/share/dsh` is a symlink
  into a checkout of this repo, the "runtime" file _is_ a tracked file. The script detects that
  and skips it — git updates it.
- **`.claude/` does double duty.** Claude Code also reads it as _project_ config for sessions
  opened in this repo. Identical hook handlers from user and project settings run once.

### Claude Code hooks (`.claude/hooks/`)

| Hook           | Event                             | Does                                                                                                                                                                |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard-git.ts` | `PreToolUse` (Bash)               | asks before a commit on `main`/`master` and before `gh pr merge`; denies `git worktree add` inside a checkout; runs gitleaks on unpushed commits and on `gh` bodies |
| `worktree.ts`  | `WorktreeCreate`/`WorktreeRemove` | puts Claude Code's built-in worktrees in the sibling `worktrees/<repo>/<type>/<slug>` layout instead of `<repo>/.claude/worktrees/`; copies `.age/key.txt`          |

Both fail open on their own bugs (a crash is a non-blocking error); a gitleaks _failure_ while
something is leaving the box asks instead. gitleaks is optional: not installed → the scan is
skipped silently. `deno task test` runs the hook and sync tests against temp dirs.

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
