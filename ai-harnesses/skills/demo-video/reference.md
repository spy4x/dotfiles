# Demo video: details and traps

The `demo-video` skill's `SKILL.md` says what a video is and how it is made; this file holds the
details each recording needs, learned from Seed's admin video and the ten antonshubin.com tool
clips (October 2026).

## Web: the screencast

```ts
const cdp = await context.newCDPSession(page)
cdp.on(`Page.screencastFrame`, async ({ data, sessionId }) => {
  frames.push({ file: await write(data), at: performance.now() / 1000 })
  await cdp.send(`Page.screencastFrameAck`, { sessionId }).catch(() => {})
})
await cdp.send(`Page.startScreencast`, {
  format: `jpeg`,
  quality: 92,
  maxWidth: 1280 * scale,
  maxHeight: 800 * scale,
  everyNthFrame: 1,
})
```

- Frames arrive only when the page paints. Each frame lasts until the next one; the concat list
  says so (`file '<jpg>'` then `duration <s>`), and the list ends with the last file once more,
  because the demuxer ignores the last entry's duration. `encodeDemo()`'s `fps` filter then holds
  each frame for its listed time.
- A shot list that cuts (Seed's `Recorder.begin()`/`end()`) keeps only the frames inside each shot,
  so loading pages never reach the video.
- The screencast hands frames over at `maxWidth`/`maxHeight`; with `deviceScaleFactor: 2` and
  twice the viewport there, text stays sharp after the encoder scales to 1280×800.

## Web: `recordVideo`

Playwright's own video is VP8 at about 25 fps and a low bitrate: fine for a quick clip, soft on
small text. It also starts late: note the wall time when you close the context, subtract the
video's length (`ffprobe`), and shift every time you noted by that lag. The blank start before the
first page is the `trim`. A smaller `recordVideo.size` than the viewport pads grey, and
`deviceScaleFactor` does not enlarge the recording: record at the viewport size.

## Web: making text bigger

A viewport smaller than the clip pads grey. Keep the viewport at the clip size and set
`document.body.style.zoom` (from an init script, on `DOMContentLoaded`); the pointer and key caps
hang off `<html>`, outside the zoom, so they keep their size and position.

## Web: the poster

The poster is the opening screen without the pointer, a caption or a card. Either start the
pointer outside the poster's frame, or take the still by hand and pass its path as `poster`:

```ts
await page.evaluate(`__demoPointerVisible(false)`)
await page.screenshot({ path: `${work}/poster.png` })
await page.evaluate(`__demoPointerVisible(true)`)
```

## Web: traps

- **Sign in off the record**: in another context, then pass its `storageState` to the recording
  context. `sessionStorage` does not cross origins, so the pointer starts again at its `x`, `y` on
  a page of another origin: set them to where the pointer was.
- **An init script runs before `<html>` exists.** Attach to `document.documentElement` on
  `DOMContentLoaded`, or retry, as `pointer.js` does.
- **A native `<select>` dropdown is not drawn** in headless Chromium: the list never shows. Use the
  keyboard on it, or show the chosen value after the change.
- **`scrollBy` does nothing** in an app whose panes scroll and whose window does not:
  `scrollLike` (the mouse wheel) scrolls what is under the pointer.
- **A sticky header**: `clickLike(page, pointer, target, { scroll: false })`, or the page jumps.
- **The pointer stops over an iframe**, which takes the mouse events: `iframes: "shield"` in
  `__demoPointerOptions`, if the clip does not click inside it.
- **An iframe paints white** for a few frames before its document loads: hide iframes until they
  load a non-blank document (mig's recipe, `HIDE_BLANK_IFRAMES`).
- **Headless names itself** `HeadlessChrome` in the user agent; a page that prints the user agent
  (an audit log, sessions) shows it. Replace it in the context's `userAgent`.
- **A page that prints the visitor's IP address** shows yours: stage it, or keep it out of frame.
- **No address bar** in a headless recording. When the URL matters, draw an honest one (the real
  URL) above the page in the encode step or a small local frame page; never a fake host.
- **`ERR_NETWORK_CHANGED`** on `goto` while other work changes the machine's network: retry three
  times, then fail.
- **An AI assistant on screen** (`claude -p`): isolate it with
  `--strict-mcp-config --setting-sources "" --tools ""` plus only the MCP server the clip shows, and
  keep the real run's exchange in the recipe so the clip can be replayed without calling it again.

## Terminal

A vhs tape, run from a throwaway copy of the recipe folder so every path on screen is relative:

```
Output demo-raw.mp4
Set Shell "bash"
Set FontFamily "Hack"
Set FontSize 22
Set LineHeight 1.25
Set Width 1280
Set Height 800
Set Padding 32
Set Framerate 30
Set TypingSpeed 55ms
Set CursorBlink false
Set Theme { "name": "ink", "background": "#111318", "foreground": "#f2f2f5", ... }

Hide
Type "source ./demo.bashrc && clear"
Enter
Sleep 500ms
Show
```

- **Setup off camera** between `Hide` and `Show`: the prompt, `cd`, a warm cache, secrets made up
  for the run. Long setup belongs in the recipe's script before vhs starts.
- **The separator before each command** comes from the demo's own bashrc, so every command gets it
  without typing it on screen:

  ```bash
  PS1='\[\e[38;2;188;183;175m\]~/project\[\e[0m\] $ '
  PROMPT_COMMAND='printf "\n\e[38;5;240m%s\e[0m\n" "$(printf "─%.0s" $(seq "$(tput cols)"))"'
  ```

  Skip it for the first prompt with a `clear` right after setup. Clear the screen (off camera,
  `Hide`/`clear`/`Show`) between unrelated steps.
- **`Wait+Screen@30s /regex/`** for output whose time varies, with a regex that the typed command
  itself does not match, or it returns at once. Then `Sleep` long enough to read the output.
- **A clean home.** Run the shell with `bash --norc --noprofile` in a staged `HOME`, never the
  recorder's own: `bwrap --dev-bind / / --tmpfs /home --bind <stage>/home/demo /home/demo
  --clearenv --setenv HOME /home/demo ... bash --norc --noprofile` (antonshubin.com
  `scripts/clips/dotfiles/enter.sh`). The real home stays unseen and unwritten.
- **tmux** for two panes: its own server and config, `tmux -L <demo-name> -f tmux.conf`, with
  `set -g status off` and `set -g default-command "bash --norc --noprofile"`; kill that server in
  the recipe's `trap`.
- **`TMPDIR=/tmp`** for vhs: Chromium's singleton socket path fails when `TMPDIR` is long (a nested
  scratch folder).
- **Pagers**: `BAT_PAGING=never`, `GIT_PAGER=cat`, `PAGER=cat`. Pick the font size, then measure
  `tput cols` once: the longest line must fit.
- **Long steps** (an install, a deploy): record them in parts and join them, or play the wait
  faster under a caption ("Sped up 4x").
- **vhs leaves `ttyd --once` running** after a timeout. Run vhs under `timeout` and the process cap
  from the global rules, and kill the run's `ttyd` in a `trap`.

## Joining parts

Several takes (a terminal part, a browser part) become one take before `encodeDemo()`:

- Bring every input to the same rate, size, pixel shape and timebase before `xfade` or `concat`:
  `fps=30,scale=1280:800:flags=lanczos,setsar=1,format=yuv420p,settb=AVTB`.
- `setpts=PTS-STARTPTS` (after a `trim`) goes before `fps`, or the first frames repeat.
- An `xfade`'s `offset` is the first part's length minus the fade; read lengths with `ffprobe`.
- Write the joined take losslessly (`-c:v ffv1` in `.mkv`) and hand that to `encodeDemo()`.

## GIF

Only for a target that cannot play video. One palette from what moves, a Bayer dither:

```bash
ffmpeg -y -i demo.mp4 -vf "fps=20,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 demo.gif
```

10 fps or `dither=none` looks jerky; Floyd–Steinberg shimmers on flat dark areas. Keep the click
mark opaque: a semi-transparent one blends into greys.

## Checks

```bash
# Mean luma per frame on a plain margin (here a strip at the top), not the whole frame.
ffmpeg -i demo.mp4 -vf "crop=iw:40:0:0,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=luma.txt" -f null -
# A jump in luma between frames: a flash.
awk -F= '/YAVG/ { if (p != "" && ($2 - p > 40 || p - $2 > 40)) print NR, p, $2; p = $2 }' luma.txt
# Frame gaps: timestamps further apart than one frame.
ffprobe -v error -select_streams v -show_entries frame=pts_time -of csv=p=0 demo.mp4 \
  | awk 'NR > 1 && $1 - p > 0.05 { print p, $1 } { p = $1 }'
# Consecutive frames of one move, to see the pointer glide.
ffmpeg -i demo.mp4 -vf "select='between(n,90,113)',crop=400:300:0:0,tile=6x4" -fps_mode vfr -frames:v 1 move.png
```

The brightest frame of a dark video stays dark (about 30/255 on a plain dark margin); a white flash
shows as a jump of 100 or more.
