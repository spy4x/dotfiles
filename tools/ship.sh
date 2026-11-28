#!/usr/bin/env bash
# Collapses an agent's routine shell calls into one each:
#   ship.sh check <log file> <command> [args...]  runs a check into a log, prints only what matters
#   ship.sh pr <commit subject> [path...]         stages, commits, pushes, opens or finds the PR
set -euo pipefail

FAIL='FAIL|[Ee]rror|failed|✗|panicked'

usage() {
  echo "usage: ship.sh check <log file> <command> [args...]" >&2
  echo "       ship.sh pr <commit subject> [path...]" >&2
  exit 2
}

# Prints `exit <n>`, then the summary on success or the failing lines on failure, then the log path.
report() {
  local code=$1 log=$2 n
  echo "exit $code"
  if [ "$code" -eq 0 ]; then
    tail -n 3 "$log"
  else
    n=$(grep -c -E "$FAIL" "$log" || true)
    if [ "$n" -gt 0 ]; then
      echo "failing lines: $n"
      grep -n -m 40 -E "$FAIL" "$log"
    else
      echo "no failing line matched; last 40 lines:"
      tail -n 40 "$log"
    fi
  fi
  echo "log: $log"
}

check() {
  local log=$1 code=0
  shift
  mkdir -p "$(dirname "$log")"
  NO_COLOR=1 "$@" >"$log" 2>&1 || code=$?
  report "$code" "$log"
  exit "$code"
}

pr() {
  local subject=$1 top untracked branch logs code=0 url
  shift
  top=$(git rev-parse --show-toplevel)
  # Paths are staged before the cd, so they stay relative to where the agent stands.
  if [ $# -gt 0 ]; then git add -- "$@"; else git add -u; fi
  cd "$top"

  untracked=$(git ls-files --others --exclude-standard)
  if [ -n "$untracked" ]; then
    echo "untracked, not committed: $(wc -l <<<"$untracked")"
    head -n 10 <<<"$untracked"
  fi

  if git diff --cached --quiet; then
    echo "nothing to commit"
  else
    git commit -q -m "$subject"
    echo "committed $(git rev-parse --short HEAD) $subject"
  fi

  WORK=$(mktemp -d)
  trap 'find "$WORK" -delete' EXIT
  mkdir "$WORK/deno"
  logs=$(mktemp -d)
  branch=$(git rev-parse --abbrev-ref HEAD)
  CI=true DENO_DIR="$WORK/deno" git push -u origin HEAD >"$logs/push.log" 2>&1 || code=$?
  if [ "$code" -ne 0 ]; then
    report "$code" "$logs/push.log"
    exit "$code"
  fi
  find "$logs" -delete
  echo "pushed $branch"

  if url=$(gh pr view --json url -q .url 2>/dev/null) && [ -n "$url" ]; then
    echo "PR: $url"
    return
  fi
  printf '%s\n\n%s\n' '<!-- agent -->' 'Work in progress. The body is completed before review.' \
    >"$WORK/body.md"
  url=$(gh pr create --title "[WIP] $subject" --body-file "$WORK/body.md")
  echo "PR: $url"
}

case "${1:-}" in
  check) [ $# -ge 3 ] || usage; shift; check "$@" ;;
  pr) [ $# -ge 2 ] && [ -n "$2" ] || usage; shift; pr "$@" ;;
  *) usage ;;
esac
