# ~/.zshenv — sourced by EVERY zsh invocation (interactive, non-interactive,
# login, non-login). Keep it minimal — only env vars, no prompt, no aliases.
#
# Why this exists: ~/.zshrc is only sourced for interactive shells. Non-
# interactive shells (scripts, agent tools, `zsh -c`) skip it, which meant
# `deno` and friends were unavailable outside an interactive terminal.
#
# Anything visual (prompt, completions, aliases) belongs in ~/.zshrc.

# deno installer (idempotent — guards against duplicate PATH entries)
[[ -f "$HOME/.deno/env" ]] && . "$HOME/.deno/env"

# Local user binaries (pipx, uv tools, etc.)
[[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"

# opencode CLI
[[ ":$PATH:" != *":$HOME/.opencode/bin:"* ]] && export PATH="$HOME/.opencode/bin:$PATH"