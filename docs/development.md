# Development

## File Structure

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
├── docs/               # Reference: installers, shell, sync, host limits
└── README.md           # Project overview
```

## Adding New Applications

1. Edit `apps.jsonc`
2. Add your application with appropriate package manager entries
3. Test with `deno task install-apps`

## Customizing Shell Setup

- **Aliases**: Edit `aliases.sh` to add custom aliases
- **Theme**: Modify the Powerlevel10k configuration in the script
- **Additional Steps**: Add new setup steps to the `setupSteps()` method
