# Shell setup (`install-shell.ts`)

Configures a complete shell environment with Zsh, Oh My Zsh, Powerlevel10k theme, and custom aliases.

## Run it

```bash
deno task install-shell
```

## What It Installs & Configures

1. **Zsh Shell**: Modern shell with advanced features
2. **Oh My Zsh**: Popular Zsh framework with plugins and themes
3. **Powerlevel10k**: Fast, customizable prompt theme
4. **Custom Aliases**: Automatically integrates `aliases.sh` from this repository
5. **Default Shell**: Sets Zsh as your default shell automatically

## Features

- **Cross-Platform**: Automatically detects package manager (apt, dnf, zypper, etc.)
- **Smart Installation**: Skips already installed components
- **Sequential Execution**: Steps depend on previous steps - stops on first failure
- **Aliases Integration**: Sources `aliases.sh` directly (no manual setup needed)
- **Automatic Configuration**: Sets up Powerlevel10k theme automatically
- **Error Handling**: Reports success/failure for each step
- **Shell Integration**: Automatically sets Zsh as default shell

## Installation Process

The script executes these steps in order:

1. **Package Manager Update**: Updates package lists
2. **Install Zsh**: Installs Zsh shell via system package manager
3. **Install Oh My Zsh**: Downloads and installs Oh My Zsh framework
4. **Install Powerlevel10k**: Clones Powerlevel10k theme
5. **Configure Theme**: Updates `.zshrc` to use Powerlevel10k
6. **Setup Aliases**: Configures `.zshrc` to source custom aliases
7. **Set Default Shell**: Changes default shell to Zsh
8. **Verification**: Verifies shell change took effect

## Post-Installation

After installation completes:

- **New Terminal Sessions**: Open a new terminal to use Zsh with the new configuration
- **Powerlevel10k Setup**: On first run, you'll be prompted to configure the theme with `p10k configure`
- **Custom Aliases**: All aliases from `aliases.sh` are automatically available
- **Manual Theme Config**: Run `p10k configure` anytime to reconfigure the theme

## Important Notes

- **Shell Change**: The script automatically attempts to set Zsh as your default shell
- **Session Reload**: Changes take effect in new terminal sessions or by running `exec zsh`
- **Theme Configuration**: Powerlevel10k will prompt for configuration on first use
- **Aliases Integration**: No manual copying needed - aliases are sourced directly

## Tmux plugins

```bash
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
```

In tmux: `prefix + I` to install plugins.
