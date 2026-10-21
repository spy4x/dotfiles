#!/bin/bash
# Turns the last raw take (media/demo/.raw/demo-raw.mp4) into the published clip: a title card,
# the take with an 84 px caption band added below it, an end card, the captions from captions.vtt
# burned in, and music.opus under it at about -28 LUFS. Writes demo.webm, demo.mp4, poster.webp
# and poster-640.webp into media/demo/. Runs alone, so a caption or music change needs no new take.
# Needs ffmpeg (libvpx-vp9, libopus, libx264, libwebp, freetype), fontconfig and Noto Sans.
set -euo pipefail
demo=$(realpath "$(dirname "$(realpath "$0")")/..")
raw="$demo/.raw/demo-raw.mp4"
vtt="$demo/captions.vtt"
music="$demo/music.opus"

W=1280 H=800 BAND=84 FPS=30
TITLE_SECONDS=2 END_SECONDS=2
TITLE="dotfiles"
CLAIM="My AI-agent setup and Linux workstation, as code."
URL="github.com/spy4x/dotfiles"
# The poster: the three rendered copies side by side, taken from the raw take (no caption on it).
POSTER_AT=${POSTER_AT:-18}
# The mix the encoder accepts: integrated loudness in LUFS (with a tolerance) and true peak in dBTP.
TARGET_LUFS=-28 LUFS_TOLERANCE=1 MAX_PEAK=-1
BG=0x15120f BAND_COLOR=0x0b0a09@0.75 MUTED=0xa19a90

for file in "$raw" "$vtt" "$music"; do
  [[ -f $file ]] || { echo "missing $file" >&2; exit 1; }
done
font() { fc-match -f '%{file}' "Noto Sans:style=$1"; }
semibold=$(font SemiBold) medium=$(font Medium)

work=$(mktemp -d)
trap 'find "$work" -delete' EXIT
run() { ffmpeg -hide_banner -loglevel error -y "$@"; }

raw_seconds=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$raw")
total=$(echo "$TITLE_SECONDS + $raw_seconds + $END_SECONDS" | bc -l)

# Cards and captions read their text from files, so no quoting or `%` expansion can bite.
printf '%s' "$TITLE" > "$work/title.txt"
printf '%s' "$CLAIM" > "$work/claim.txt"
printf '%s' "$URL" > "$work/url.txt"
text() { # text <file> <fontfile> <size> <colour> <y expression>
  local look="fontfile=$2:fontsize=$3:fontcolor=$4:expansion=none"
  echo "drawtext=textfile=$1:$look:x=(w-text_w)/2:y=$5"
}

# One drawbox and one drawtext per cue, shown between the cue's times on the final timeline.
captions=""
n=0
while IFS=$'\t' read -r start end line; do
  n=$((n + 1))
  printf '%s' "$line" > "$work/cue-$n.txt"
  on="enable='between(t,$start,$end)'"
  captions+=",drawbox=x=0:y=ih-$BAND:w=iw:h=$BAND:color=$BAND_COLOR:t=fill:$on"
  cue=$(text "$work/cue-$n.txt" "$medium" 32 white "h-$BAND+($BAND-line_h)/2")
  captions+=",$cue:$on"
done < <(awk '
  function secs(s, p) { split(s, p, ":"); return p[1] * 3600 + p[2] * 60 + p[3] }
  /-->/ { start = secs($1); end = secs($3); getline; print start "\t" end "\t" $0 }
' "$vtt")
[[ $n -gt 0 ]] || { echo "no cues in $vtt" >&2; exit 1; }

card="color=c=$BG:s=${W}x$H:r=$FPS"
graph="[0:v]fps=$FPS,pad=$W:$H:0:0:color=$BG,setsar=1[take];"
graph+="$card:d=$TITLE_SECONDS,$(text "$work/title.txt" "$semibold" 64 white "h/2-text_h-12"),"
graph+="$(text "$work/claim.txt" "$medium" 30 "$MUTED" "h/2+20"),setsar=1[title];"
graph+="$card:d=$END_SECONDS,$(text "$work/url.txt" "$semibold" 48 white "(h-text_h)/2"),"
graph+="setsar=1[end];"
graph+="[title][take][end]concat=n=3:v=1:a=0,format=yuv420p$captions[v]"

# The music: cut to the video, faded in over 1 s and out over 2 s, then set to the target loudness.
fade_out=$(echo "$total - 2" | bc -l)
shape="atrim=0:$total,asetpts=N/SR/TB,afade=t=in:d=1,afade=t=out:st=$fade_out:d=2"
loudness() { # loudness <file> → "<integrated LUFS> <true peak dBTP>"
  ffmpeg -hide_banner -nostats -i "$1" -af ebur128=peak=true -f null - 2>&1 |
    awk '/Integrated loudness:/ { f = 1 } f && /I:/ { i = $2 }
      /True peak:/ { t = 1 } t && /Peak:/ { p = $2 } END { print i, p }'
}
run -i "$music" -af "$shape" "$work/music.wav"
read -r measured _ < <(loudness "$work/music.wav")
gain=$(echo "$TARGET_LUFS - ($measured)" | bc -l)
audio="$shape,volume=${gain}dB"

common=(-i "$raw" -i "$music" -filter_complex "$graph;[1:a]$audio[a]" -map "[v]" -map "[a]"
  -t "$total" -r "$FPS" -map_metadata -1)
run "${common[@]}" -c:v libvpx-vp9 -crf 38 -b:v 0 -row-mt 1 -deadline good -cpu-used 4 \
  -c:a libopus -b:a 96k "$demo/demo.webm"
run "${common[@]}" -c:v libx264 -preset medium -crf 26 -c:a aac -b:a 128k -movflags +faststart \
  "$demo/demo.mp4"

run -ss "$POSTER_AT" -i "$raw" -frames:v 1 -vf "pad=$W:$H:0:0:color=$BG" -c:v libwebp -quality 85 \
  "$demo/poster.webp"
run -i "$demo/poster.webp" -vf scale=640:-2:flags=lanczos -c:v libwebp -quality 85 \
  "$demo/poster-640.webp"

for file in "$demo/demo.webm" "$demo/demo.mp4"; do
  read -r integrated peak < <(loudness "$file")
  echo "$(basename "$file"): $integrated LUFS, $peak dBTP, $(stat -c %s "$file") bytes"
  off="($integrated) - ($TARGET_LUFS)"
  bad=$(echo "$off > $LUFS_TOLERANCE || -($off) > $LUFS_TOLERANCE || $peak > $MAX_PEAK" | bc -l)
  if ((bad)); then
    echo "$file: off target ($TARGET_LUFS ± $LUFS_TOLERANCE LUFS, peak ≤ $MAX_PEAK dBTP)" >&2
    exit 1
  fi
done
posters="$(stat -c %s "$demo/poster.webp") and $(stat -c %s "$demo/poster-640.webp") bytes"
echo "$(printf '%.1f' "$total") s; posters $posters"
