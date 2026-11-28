#!/usr/bin/env bash
# Start the weekly recording in one line: `record <slug>`.
#
# Checks that the microphone and the camera OBS uses give a signal, opens the recording kit
# (~/recordings/<slug>/kit.md) in a tmux pane or the default viewer, and starts OBS recording with
# the YouTube-Coding profile and scene collection and the scene the kit names (CodingScene or
# CameraOnly). When OBS is closed, it moves the new recording to ~/recordings/<slug>/raw.mkv, or
# raw-2.mkv, raw-3.mkv... when taken, and never overwrites a file. The device names come from the
# OBS scene collection, so the check follows whatever OBS records from.
#
#   record <slug>     check, then record
#   record --check    only check the microphone and the camera, then exit
#
# Exit codes: 0 recorded (or check passed), 1 refused or no new recording, 2 bad arguments.
set -Eeuo pipefail

PROFILE=YouTube-Coding
REC="$HOME/recordings"
SCENES="$HOME/.config/obs-studio/basic/scenes/$PROFILE.json"
# Digital silence: room noise with nobody speaking measured -52 dB max on the Razer Seiren.
SILENCE_DB=-70

check_only=false
slug=""
case "${1:-}" in
--check) check_only=true ;;
*) slug="${1:-}" ;;
esac
if [ "$#" -ne 1 ] || { ! $check_only && ! [[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]]; }; then
  echo "usage: record <slug> | record --check (slug: lowercase letters, digits and dashes)" >&2
  exit 2
fi

fail() {
  echo "record: $*" >&2
  exit 1
}

# OBS reads --profile, --scene and --startrecording only when it starts, and a running OBS holds
# the camera, so the check would fail on it too.
if pgrep -x obs >/dev/null; then
  fail "OBS is already running: close OBS first"
fi

D=$(mktemp -d)
trap 'find "$D" -delete' EXIT

[ -f "$SCENES" ] || fail "no OBS scene collection at $SCENES"
mic=$(jq -r '.AuxAudioDevice1.settings.device_id // empty' "$SCENES")
cam=$(jq -r 'first(.sources[] | select(.id == "v4l2_input") | .settings.device_id) // empty' \
  "$SCENES")
[ -n "$mic" ] || fail "the scene collection names no microphone (AuxAudioDevice1)"
[ -n "$cam" ] || fail "the scene collection names no camera (v4l2_input source)"

# Microphone: plugged in, not muted, and not digitally silent.
# Outputs go through variables: `grep -q` closing a pipe early would fail the pipeline.
sources=$(pactl list short sources | cut -f2)
grep -qxF -- "$mic" <<<"$sources" || fail "microphone not found (unplugged?): $mic"
mute=$(pactl get-source-mute "$mic")
[ "$mute" != "Mute: yes" ] || fail "microphone is muted: $mic"
timeout 2 pw-record --target "$mic" --channels 1 --rate 48000 "$D/mic.wav" >/dev/null 2>&1 || true
max=$(ffmpeg -hide_banner -nostats -i "$D/mic.wav" -af volumedetect -f null - 2>&1 |
  sed -n 's/.*max_volume: \([-0-9.inf]*\) dB.*/\1/p' | head -n1) || true
[ -n "$max" ] || fail "could not capture from the microphone: $mic"
if [ "$max" = "-inf" ] || awk -v m="$max" -v t="$SILENCE_DB" 'BEGIN { exit !(m <= t) }'; then
  fail "microphone gives no signal (max ${max} dB, silent at ${SILENCE_DB} dB or below): $mic"
fi
echo "microphone ok: max ${max} dB ($mic)"

# Camera: the device exists and gives one frame.
[ -e "$cam" ] || fail "camera device missing (unplugged?): $cam"
timeout 5 v4l2-ctl -d "$cam" --stream-mmap --stream-count=1 --stream-to=/dev/null >/dev/null 2>&1 ||
  fail "camera gives no frame: $cam"
echo "camera ok: $cam"

$check_only && exit 0

kit="$REC/$slug/kit.md"
scene=""
if [ -f "$kit" ]; then
  scene=$(grep -o -m1 -E 'scene `(CodingScene|CameraOnly)`' "$kit" | head -n1 | tr -d '`') || true
  scene=${scene#scene }
  if [ -n "${TMUX:-}" ]; then
    tmux split-window -h less "$kit" || true
  else
    xdg-open "$kit" >/dev/null 2>&1 || true
  fi
else
  echo "note: no kit at $kit"
fi
if [ -z "$scene" ]; then
  scene=CodingScene
  echo "note: the kit names no scene, using $scene"
fi

mkdir -p "$REC/$slug"
touch "$D/start"
echo "recording: profile $PROFILE, scene $scene. Close OBS to stop."
obs_status=0
obs --profile "$PROFILE" --collection "$PROFILE" --scene "$scene" --startrecording ||
  obs_status=$?
[ "$obs_status" -eq 0 ] || echo "note: OBS exited with status $obs_status" >&2

moved=0
while IFS= read -r -d '' src; do
  dest="$REC/$slug/raw.mkv"
  n=2
  while [ -e "$dest" ]; do
    dest="$REC/$slug/raw-$n.mkv"
    n=$((n + 1))
  done
  mv -n -- "$src" "$dest" || true
  [ ! -e "$src" ] || fail "could not move $src to $dest"
  echo "$dest"
  moved=$((moved + 1))
done < <(find "$REC" -maxdepth 1 -type f -name '*.mkv' -newer "$D/start" -print0 | sort -z)

[ "$moved" -gt 0 ] || fail "OBS wrote no new .mkv to $REC"
