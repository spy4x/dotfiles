# misc START
alias copy="wl-copy <"
alias rs="rsync -avhzru -P"
alias rsh="rsync -avhzru -P -e ssh"
alias ws="webstorm"
alias size="du -hd1 | sort -hr"
alias la='ls -la'
alias list="tree -L 1"
alias tree="tree -L 2"
alias up="pnpm up -i -L"
alias open "xdg-open"
# misc END

# git START
alias gst="git status"
alias ga="git add"
alias gd="git diff"
alias gb="git branch"
alias gco="git checkout"
alias gc="git commit -m"
alias gp="git push"
alias gl="git pull"
alias glf="git fetch --all && git stash save -m 'Before force pull' && git reset --hard"
alias gr="git restore --staged"
# git END

# docker START
alias dc="docker compose up -d"
alias dd="docker compose down"
function dockerStop(){
  # Stops containers with name that contains argument $1.
  # If argument $1 is not provided - stops all docker containers
  docker ps --filter "name=$1" -q | xargs -r docker stop;
  };
alias ds="dockerStop"
alias dclean="docker system prune -af"
# docker END

# webp BEGIN
function to_webp() {
  setopt NULL_GLOB
  for type in jpg jpeg png; do
    for F in *.$type; do
      cwebp "$F" -o "`basename "${F%.$type}"`.webp"
    done
  done
  unsetopt NULL_GLOB
}
alias webp='to_webp'
# webp END