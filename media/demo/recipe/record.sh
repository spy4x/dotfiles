#!/bin/bash
# Records the "Under the hood" demo and encodes it into media/demo/ (see README.md beside this).
# Clones spy4x/dotfiles into a scratch dir with empty harness homes under a scratch /home/demo
# (enter.sh), records demo.tape with vhs into media/demo/.raw/demo-raw.mp4, then runs encode.sh.
# The real ~/.claude, ~/.config and ~/.local are never read or written: bwrap hides /home.
# Usage: media/demo/recipe/record.sh [git ref, default main]
#   DOTFILES_REPO=<url or path> clones from somewhere other than GitHub.
set -euo pipefail
here=$(dirname "$(realpath "$0")")
raw_dir="$here/../.raw"
ref=${1:-main}
repo=${DOTFILES_REPO:-https://github.com/spy4x/dotfiles.git}
work=$(mktemp -d)
trap 'find "$work" -delete' EXIT

home="$work/stage/home/demo"
mkdir -p "$home/.claude" "$home/.config/opencode" "$home/.local/share/dsh" "$work/stage/deno" \
  "$raw_dir"
git clone -q "$repo" "$home/dotfiles"
git -C "$home/dotfiles" checkout -q "$ref"
cp "$here/enter.sh" "$here/demo.tape" "$work/"
cp "$here/demo.vim" "$here/demo.bashrc" "$home/"

# Off camera: fill the deno cache. `--check` writes nothing, so the homes stay empty for the clip.
"$here/enter.sh" "$work/stage" -c 'deno task ai --check > /dev/null 2>&1 || true'

# Chromium's singleton socket path must stay short, so vhs gets /tmp whatever TMPDIR says.
(cd "$work" && TMPDIR=/tmp systemd-run --user --scope --quiet -p TasksMax=4000 -p MemoryMax=8G \
  timeout 300 vhs demo.tape)
mv "$work/demo-raw.mp4" "$raw_dir/demo-raw.mp4"

"$here/encode.sh"
