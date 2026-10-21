# The clip's shell: a short orange prompt, and a blank line plus a full-width rule before every
# prompt, so each command's output is visibly its own. A command that sets QUIET=1 (the hidden
# `clear` between scenes) skips the next rule. A leading space keeps a command out of history.
shopt -s checkwinsize
HISTCONTROL=ignorespace
PS1='\[\e[38;2;249;115;22m\]$\[\e[0m\] '
rule() {
  local line
  printf -v line '%*s' "${COLUMNS:-120}" ''
  printf '\n\e[38;2;74;67;59m%s\e[0m\n' "${line// /─}"
}
PROMPT_COMMAND='if [[ -n $QUIET ]]; then unset QUIET; else rule; fi'
alias nvim='nvim --clean -u ~/demo.vim'
