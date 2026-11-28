#!/usr/bin/env bash
# Calls the Woodpecker CI API without putting the token on any command line:
#   woodpecker-api.sh <api path> [extra curl args...]
#   woodpecker-api.sh repos/1/pipelines?per_page=5
#   woodpecker-api.sh repos/1/pipelines/273 -X POST
# Token: $WOODPECKER_CI_TOKEN, else the `WOODPECKER_CI_TOKEN=` line of
# ${WOODPECKER_ENV_FILE:-$HOME/sync/code/homelab/.env.accounts}. Server: ${WOODPECKER_SERVER:-https://ci.antonshubin.com}.
# The header reaches curl on stdin (`-H @-`), so `ps` never shows the token. Prints the body; exits with curl's code.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: woodpecker-api.sh <api path> [extra curl args...]" >&2
  exit 2
fi

path=${1#/}
path=${path#api/}
shift

env_file=${WOODPECKER_ENV_FILE:-$HOME/sync/code/homelab/.env.accounts}
token=${WOODPECKER_CI_TOKEN:-}
if [ -z "$token" ] && [ -r "$env_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      WOODPECKER_CI_TOKEN=*) token=${line#WOODPECKER_CI_TOKEN=} ;;
    esac
  done <"$env_file"
  token=${token#[\"\']}
  token=${token%[\"\']}
fi
if [ -z "$token" ]; then
  echo "woodpecker-api.sh: WOODPECKER_CI_TOKEN is not set and not found in $env_file" >&2
  exit 1
fi
# Keep the token out of curl's environment too: only the unexported shell variable holds it.
unset WOODPECKER_CI_TOKEN

server=${WOODPECKER_SERVER:-https://ci.antonshubin.com}
server=${server%/}

printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -H @- "$@" "$server/api/$path"
