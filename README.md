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
- **macOS**: homebrew
- **Windows**: winget

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

## 📱 Application Installer (`install-apps.ts`)

### Features

- **Cross-Platform**: Automatically detects package manager (apt, dnf, zypper, winget, homebrew)
- **Fallback Support**: Tries Flatpak if native package installation fails (Linux)
- **Repository Management**: Handles adding repositories with GPG key support
- **Architecture Filtering**: Skips apps incompatible with current architecture
- **Pre/Post Commands**: Executes custom commands before/after installation
- **Smart Recovery**: Continues with Flatpak if native packages fail
- **Installation Summary**: Reports successful, failed, and skipped installations

### Configuration (`apps.json`)

Edit `apps.json` to customize applications. Each app supports:

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
├── install-apps.ts      # Application installer
├── install-shell.ts     # Shell environment setup  
├── shared.ts           # Common utilities
├── apps.json           # Application configurations
├── aliases.sh          # Custom shell aliases
├── deno.jsonc          # Deno configuration
└── README.md           # This file
```

### Adding New Applications

1. Edit `apps.json`
2. Add your application with appropriate package manager entries
3. Test with `deno task install-apps`

### Customizing Shell Setup

- **Aliases**: Edit `aliases.sh` to add custom aliases
- **Theme**: Modify the Powerlevel10k configuration in the script
- **Additional Steps**: Add new setup steps to the `setupSteps()` method
