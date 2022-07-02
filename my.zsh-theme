# oh-my-zsh theme

# Example of the look:
#
# ~/projects/project-name master firebase-project-id gcp-project-id
# $ <your input will start here>
#

local return_code='%(?..%{$fg[red]%}%? ↵%{$reset_color%})'
local current_dir='$fg[green]%}%~%{$reset_color%}'
local git_branch='$(git_prompt_info)%{$reset_color%}'

# Get Firebase Project ID or Alias that is associated with current folder 
local firebase_project=%{$fg[yellow]%}'$(grep \"$(pwd)\" ~/.config/configstore/firebase-tools.json | cut -d" " -f2 | tr -d "\"" | tr -d ",")'%{$reset_color%}

# Get Google Cloud Project ID that is currently selected
local gcp_project=%{$fg[cyan]%}'$(gcloud config get-value project 2> /dev/null)'%{$reset_color%}

PROMPT="${current_dir} ${git_branch} ${firebase_project} ${gcp_project}
$ "
RPS1="${return_code}"

ZSH_THEME_GIT_PROMPT_PREFIX="%{$terminfo[bold]"
ZSH_THEME_GIT_PROMPT_SUFFIX="%{$reset_color%}"

alias yu="yarn upgrade-interactive --latest"
alias gst="git status -sb"
alias tree="tree -a -L 1"
alias nx="npx nx"
alias firebase="npx firebase"
