#!/usr/bin/env bash
# Installs the tools the talking-video cut needs, pinned and checksummed:
#   whisper-cli (built from source) → ~/.local/bin/whisper-cli
#   the English model               → ~/.local/share/whisper.cpp/models/ggml-small.en.bin
#   deep-filter (DeepFilterNet)     → ~/.local/bin/deep-filter
# Idempotent: a piece already in place at the pinned version is skipped.
set -euo pipefail

WHISPER_TAG=v1.9.6
# The commit the annotated tag points at (`git ls-remote` shows it as `v1.9.6^{}`).
WHISPER_COMMIT=96ec4d9823e9d0211944172da35f9f29134af990
WHISPER_REPO=https://github.com/ggml-org/whisper.cpp
MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
MODEL_SHA256=c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d
DF_VERSION=0.5.6

BIN_DIR="$HOME/.local/bin"
SHARE_DIR="$HOME/.local/share/whisper.cpp"
STAMP="$SHARE_DIR/whisper-cli.version"

# Temporary paths removed on exit, whatever the outcome.
CLEAN=()
cleanup() {
  local p
  for p in "${CLEAN[@]}"; do
    [[ -e $p ]] && find "$p" -delete
  done
  return 0
}
trap cleanup EXIT

sha256() { sha256sum "$1" | cut -d' ' -f1; }

# fetch <url> <sha256> <dest>: downloads to a temp file beside <dest>, verifies it, then moves it
# into place, so a failed or wrong download never sits at <dest>. Skips when <dest> already matches.
fetch() {
  local url=$1 sum=$2 dest=$3 tmp got
  if [[ -f $dest && $(sha256 "$dest") == "$sum" ]]; then
    echo "already in place: $dest"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  tmp=$(mktemp "$dest.part.XXXXXX")
  CLEAN+=("$tmp")
  echo "downloading $url"
  curl -fL --retry 3 --silent --show-error -o "$tmp" "$url"
  got=$(sha256 "$tmp")
  if [[ $got != "$sum" ]]; then
    echo "error: checksum mismatch for $url: expected $sum, got $got" >&2
    exit 1
  fi
  mv -f "$tmp" "$dest"
  echo "installed: $dest"
}

install_whisper_cli() {
  local bin="$BIN_DIR/whisper-cli" src head
  if [[ -x $bin && -f $STAMP && $(<"$STAMP") == "$WHISPER_COMMIT" ]]; then
    echo "already in place: $bin ($WHISPER_TAG)"
    return
  fi
  src=$(mktemp -d)
  CLEAN+=("$src")
  echo "building whisper-cli $WHISPER_TAG"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$src/whisper.cpp"
  head=$(git -C "$src/whisper.cpp" rev-parse HEAD)
  if [[ $head != "$WHISPER_COMMIT" ]]; then
    echo "error: $WHISPER_TAG resolved to $head, expected $WHISPER_COMMIT" >&2
    exit 1
  fi
  # Static, so the binary never loads Fedora's older libwhisper.
  cmake -S "$src/whisper.cpp" -B "$src/whisper.cpp/build" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF
  cmake --build "$src/whisper.cpp/build" --target whisper-cli -j "$(nproc)"
  mkdir -p "$BIN_DIR" "$SHARE_DIR"
  install -m 755 "$src/whisper.cpp/build/bin/whisper-cli" "$bin"
  echo "$WHISPER_COMMIT" >"$STAMP"
  echo "installed: $bin"
}

install_deep_filter() {
  local asset sum
  case "$(uname -m)" in
  x86_64)
    asset="deep-filter-$DF_VERSION-x86_64-unknown-linux-musl"
    sum=70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da
    ;;
  aarch64)
    asset="deep-filter-$DF_VERSION-aarch64-unknown-linux-gnu"
    sum=14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166
    ;;
  *)
    echo "error: no deep-filter $DF_VERSION build for architecture $(uname -m)" >&2
    exit 1
    ;;
  esac
  fetch "https://github.com/Rikorose/DeepFilterNet/releases/download/v$DF_VERSION/$asset" \
    "$sum" "$BIN_DIR/deep-filter"
  chmod 755 "$BIN_DIR/deep-filter"
}

install_whisper_cli
fetch "$MODEL_URL" "$MODEL_SHA256" "$SHARE_DIR/models/ggml-small.en.bin"
install_deep_filter
