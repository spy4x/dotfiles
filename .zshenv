# ~/.zshenv — sourced by EVERY zsh invocation (interactive, non-interactive,
# login, non-login). Keep it minimal — only env vars, no prompt, no aliases.
#
# Anything visual (prompt, completions, aliases) belongs in ~/.zshrc.

# --- deno (official installer, idempotent) ---
[[ -f "$HOME/.deno/env" ]] && . "$HOME/.deno/env"

# --- bun ---
if [[ -d "$HOME/.bun" ]]; then
  export BUN_INSTALL="$HOME/.bun"
  [[ ":$PATH:" != *":$BUN_INSTALL/bin:"* ]] && export PATH="$BUN_INSTALL/bin:$PATH"
fi

# --- npm global ---
[[ ":$PATH:" != *":$HOME/.npm-global/bin:"* ]] && export PATH="$HOME/.npm-global/bin:$PATH"

# --- local user bins (pipx, uv tools, scripts) ---
[[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"

# --- opencode CLI ---
[[ ":$PATH:" != *":$HOME/.opencode/bin:"* ]] && export PATH="$HOME/.opencode/bin:$PATH"

# --- python venv env (no-op if missing) ---
[[ -f "$HOME/.local/bin/env" ]] && . "$HOME/.local/bin/env"