# OBS Studio — Recording Setup for YouTube Coding Videos

This directory contains the tracked configuration for the host's OBS
Studio setup. Future AI coding sessions that work on this OBS config,
video production workflow, or related tooling (scene tweaks, mic filters,
mask assets, profile tuning) should **read this file first** for context.

## Host's situation

- **Content**: English-language US-targeted YouTube videos about software
  development tips, AI, SaaS, entrepreneurship, vibe-coding, solopreneurship.
- **Channel size at time of writing**: ~250 followers.
- **Goal**: minimal-friction "fire-and-forget" recording → upload pipeline.
  The host does **not** want intro/outro overlays, custom graphics, or
  editing between recording and upload. Production polish is explicitly
  deprioritized in favor of posting frequency.
- **Hardware** (current at writing): Fedora 44 KDE Plasma (Wayland),
  Ryzen 9 8945HS (Radeon 780M iGPU), 91 GB RAM, Samsung 4K HDMI-A-1
  primary monitor, DP-2 secondary monitor (never recorded), Logitech
  C922 webcam (`/dev/video0`), Razer Seiren Mini USB mic.
- **Recording machine**: same machine. **No GPU encoder other than VAAPI
  on the iGPU** — Mesa 26.x supports AV1 VAAPI but **not** HEVC VAAPI
  on this silicon (verify with `ffmpeg -hide_banner -encoders | grep vaapi`).

## What lives here (and why)

```
.config/obs-studio/
├── AGENTS.md                  ← this file (read me first)
├── basic/
│   ├── profiles/YouTube-Coding/basic.ini   ← encoder, video, hotkeys
│   ├── scenes/YouTube-Coding.json         ← scenes + sources + filters
│   ├── plugin_config/                     ← obs-websocket, plugin state
│   ├── plugin_manager/                    ← which plugins enabled
│   └── masks/                             ← PNG masks for Image Mask/Blend filter
└── (runtime dirs NOT tracked: logs/, profiler_data/, updates/, .sentinel/)
```

`~/.config/obs-studio/{basic,plugin_config,plugin_manager}` are
**symlinks** into this directory so changes here flow back to live OBS
config (see "How to make changes" below).

## Active profile: `YouTube-Coding`

**Video output**: 3840×2160 (4K), 30 fps, NV12, BT.709.
**Encoder**: `av1_ffmpeg_vaapi` (hardware AV1 via Radeon 780M).
**Quality**: CQP 22, keyframe every 120 frames, Main profile.
**Container**: MKV with auto-remux to MP4 (upload-ready). Recording
split into 15-minute chunks.
**Recording path**: `~/recordings/` (NOT `~/Videos/`).
**Hotkeys**:
- **F9**: start/stop recording
- **F10**: pause/unpause recording

### Scenes

1. **`CodingScene`** (default) — full 4K screen capture of Samsung 4K
   (HDMI-A-1, NOT DP-2 secondary) + vertical webcam bubble bottom-right.
   Use for the entire video.
2. **`CameraOnly`** — full-screen webcam only, no screen capture. Use for
   quick talking-head intros/outros when needed.

### Sources

| UUID | Source | Used by | Notes |
|---|---|---|---|
| `33333333-...` | Screen Capture (PipeWire) | CodingScene | `pipewire-screen-capture-source`, captures HDMI-A-1 only |
| `44444444-...` | Webcam (Logitech C922) | CodingScene | `v4l2_input`, MJPG 1920×1080 @30 fps, **with crop + mask filters** |
| `77777777-...` | Webcam (Logitech C922) Full | CameraOnly | `v4l2_input`, **uncropped, full screen** |
| `22222222-...` | Microphone (Razer Seiren Mini) | both | `pulse_input_capture`, with 4-filter chain |

The bubble webcam and full-screen webcam are **separate v4l2_input
sources** (not the same source with different per-scene crops). They both
open `/dev/video0` — PipeWire multiplexes the USB device. Having two
sources lets the bubble scene apply portrait crop + mask without
affecting CameraOnly.

### Filter chains

**Microphone** (Razer Seiren Mini) — order matters, top → bottom:

1. **Noise Suppression (RNNoise)** — `noise_suppress_filter`, method=rnnoise, suppress_level=45 dB
2. **Gain** — `gain_filter`, db=+12. The Razer Seiren Mini is naturally quiet at this desk distance; +12 dB brings the voice into the gate's usable range. **The gain MUST come before the gate** — otherwise weak phrases never reach the gate's open threshold and get cut (the user's original bug).
3. **Noise Gate** — `noise_gate_filter`, open=−25, close=−30, attack=6 ms, hold=200 ms, release=100 ms. Thresholds lifted by +5 dB relative to a no-gain setup, to match the +12 dB pre-gain boost.
4. **Compressor** — `upward_compressor_filter`, threshold=−15, ratio=4:1, attack=3 ms, release=100 ms, output_gain=+3 dB

**If the voice is still too quiet**: raise `db` on the Gain filter. Each +3 dB roughly doubles perceived loudness. Beyond +18 dB you'll start to amplify background noise alongside the voice, so prefer compressing harder (raise `ratio` to 6:1) before pushing gain further.

**If phrases get cut mid-sentence**: the gate is closing too early. Raise `hold_time` from 200 ms to 300–400 ms (keeps the gate open briefly between syllables) and/or lower `close_threshold` by 3–5 dB (more permissive close).

The full per-filter JSON schema (every required field) is documented at
<https://github.com/obsproject/obs-studio/blob/master/plugins/obs-filters/>.
**Missing any field (push-to-mute-delay, hotkeys, etc.) causes OBS to drop
the whole filters array on save.** See `basic/scenes/YouTube-Coding.json`
lines ~64–200 for the working template.

**Webcam (bubble)**:

1. **Crop (vertical portrait)** — `crop_filter`, left=600, right=600, top=0, bottom=0. Converts 1920×1080 native C922 to 720×1080 portrait.
2. **Image Mask/Blend (rounded)** — `mask_filter`, type=`mask_alpha_filter.effect`, image_path=`~/.config/obs-studio/basic/masks/mask-2x3-vertical.png`, color=16777215, opacity=1.0, stretch=false. Uses PNG alpha channel to mask the source (white=visible, transparent=hidden).

The mask filter source ID in OBS 32 is `mask_filter`; its display name
in the UI is **"Image Mask/Blend"** (see `obs-filters/data/locale/en-US.ini`).
**No plugin required** for this — it ships with `obs-filters.so` on Fedora.

### Mask PNGs

All in `basic/masks/` (tracked). Mode = LA (luminance + alpha), white
inside the shape, transparent outside. **Match the image's pixel
dimensions to the post-crop source dimensions for best results** (the
stretch setting in mask_filter handles mismatches, but matching is sharper).

| File | Dimensions | Use |
|---|---|---|
| `mask-2x3-vertical.png` | 600×900 | **Active** — CodingScene bubble |
| `mask-9x16.png` | 720×1280 | Full vertical portrait (YouTube Shorts, IG Reels) |
| `mask-3x4.png` | 720×960 | Classic photo portrait |
| `mask-1x1.png` | 800×800 | Square (Instagram feed) |
| `mask-4x3.png` | 960×720 | Classic webcam landscape |
| `mask-circle.png` | 800×800 | Full circle (popular webcam bubble shape) |

To switch masks: edit the bubble webcam source's mask_filter
`image_path` setting in the scene JSON (or right-click the source in
OBS → Filters → Image Mask/Blend → browse). Or **add a second webcam
source** with a different mask per scene.

## Why these choices

- **AV1 VAAPI over HEVC/x264**: AV1 has the best quality-per-bit for
  YouTube (which re-encodes everything anyway). Hardware offload means
  zero CPU impact during recording. Mesa 26.x on this hardware supports
  AV1 VAAPI but not HEVC VAAPI — that constraint forced the choice.
- **30 fps over 60 fps**: For screen content with text and small
  animations, 30 fps is the YouTube sweet spot. 60 fps doubles data and
  encoder load with no visible benefit for code.
- **4K over 1440p/1080p**: User explicitly wants maximum sharpness.
  Screen capture on Wayland captures at physical pixel resolution;
  the file is upload-ready at any quality.
- **Vertical webcam (crop+mask)**: Modern UI aesthetic. The mask is
  a built-in OBS filter (mask_filter / "Image Mask/Blend"), no plugin.
- **MKV + auto-remux**: MKV is crash-resilient (a killed recording
  isn't lost). OBS auto-remuxes to MP4 on stop, so YouTube upload
  needs no manual conversion step.
- **No intro/outro**: User explicitly doesn't want them. Wastes the
  viewer's first 5 seconds.

## Schedule & first-30-seconds guidance (NOT YET IMPLEMENTED IN OBS)

User is targeting a **US English-speaking audience** for software dev,
AI, SaaS, entrepreneurship, vibe-coding, solopreneurship topics. Posting
schedule and hook style are **not** set up in OBS — they're workflow
choices the host controls. Research findings to apply:

- **Schedule**: 1 long-form video/week is the sustainable baseline
  for a solo creator. Best upload days for US tech audience: Tue, Wed,
  Thu. Best upload times: 9–11 AM PT or 12–2 PM ET (lets YouTube
  index during US business hours). Source: brandghost.ai 2026 timing
  guide.
- **First 30 seconds must hook**:
  - Don't open with "Hey guys, welcome to my channel". Viewer leaves
    in 5 seconds.
  - Open with the **payoff** of the video: a one-sentence statement of
    what the viewer will gain. "Today I'm going to show you how to cut
    your OBS CPU usage by 90% with one setting change."
  - Then **the**why**/pain** in 10 seconds: "Most tutorials record at
    60fps and waste disk space — for code content you can't even tell
    the difference."
  - Then dive into the content. Skip the throat-clearing.
- **Posting cadence matters more than production polish** at 250
  followers. Bump cadence first, polish later.

## How to make changes

**Critical**: OBS only persists config changes to disk on **graceful
shutdown**. `kill -9`, SIGKILL, `timeout N obs`, or window-X-button all
bypass the save step. Future AI sessions must:

1. **Confirm OBS is closed** before editing config:
   ```sh
   ps aux | grep -E "^[a-zA-Z+]+ +[0-9]+.*obs " | grep -v grep | grep -v bash
   ```
2. Edit files in this directory (or under `~/.config/obs-studio/` via
   the symlinks).
3. Launch OBS normally: `bash -c 'obs --minimize-to-tray --disable-shutdown-check &'`
4. Wait ~5 seconds for full init.
5. Send SIGTERM for graceful close:
   ```sh
   kill -TERM $OBS_PID
   ```
6. Wait for exit, then verify the file on disk actually contains your
   change (don't trust the in-memory log).
7. Commit to this repo.

**Don't use `timeout N obs`** — it sends SIGKILL mid-save and OBS
silently discards unsaved config.

### Verification recipe

```sh
# 1. OBS closed?
ps aux | grep -E "^[a-zA-Z+]+ +[0-9]+.*obs " | grep -v grep | grep -v bash \
  || echo "clean"

# 2. Edit (use edit tool, not sed)

# 3. Launch + graceful close + check
obs --minimize-to-tray --disable-shutdown-check > /tmp/obs-test.log 2>&1 &
PID=$!; sleep 5
kill -TERM $PID
for i in {1..15}; do
  ps -p $PID >/dev/null 2>&1 || { echo "closed ($i s)"; break; }
  sleep 1
done

# 4. Verify
grep -E "loaded source|filter:|switched to scene" /tmp/obs-test.log
grep -iE "^error" /tmp/obs-test.log | grep -ivE "portal|frontend_remove"
python3 -c "import json; json.load(open('<file>'))" && echo "JSON valid"
```

## Known gotchas (learned the hard way)

- **`mask_filter` requires `versioned_id: "mask_filter_v2"`** for the
  OBS 32 v2 schema (float opacity 0.0–1.0). Using the v1 ID works for
  loading but breaks on save in some configurations.
- **Crop filter absolute pixel values**, not relative. Source
  dimensions matter. A C922 at MJPG 1920×1080 needs `left=600, right=600`
  to crop to portrait.
- **Scene hotkey format is different from `basic.ini` hotkeys.** Scene
  hotkeys live in the scene JSON's `hotkeys.OBSBasic.SelectScene` array
  as strings like `["OBS_KEY_F11"]`. Global hotkeys (StartRecording,
  etc.) live in `basic.ini [Hotkeys]` section as JSON `{"bindings":[{"key":"OBS_KEY_F9"}]}`.
- **PipeWire `RestoreToken`** in the screen capture source rotates
  every OBS launch. Already in `.gitignore` (best-effort; line-level
  ignore is impossible, so small diffs on every launch are expected and
  acceptable).
- **Webcam `/dev/video0` "Device or resource busy"** at OBS startup is
  a transient race if a previous OBS instance didn't release the fd.
  PipeWire recovers automatically within a few seconds. Not a real error.
- **Two v4l2_input sources for the bubble + full-screen** webcam
  requires PipeWire multiplexing — works fine on Fedora 44 / PipeWire
  1.6.x. If webcam goes black on CameraOnly scene, restart OBS.
- **Filter objects require the full source-object schema**:
  `volume, balance, enabled, muted, push-to-mute, push-to-mute-delay,
  push-to-talk, push-to-talk-delay, hotkeys, deinterlace_mode,
  deinterlace_field_order, monitoring_type, private_settings`. Missing
  any field causes OBS to discard the whole `filters` array on save.

## What NOT to do

- Don't install third-party OBS plugins (StreamFX, obs-advanced-masks)
  without explicit user approval — they're out-of-tree binaries and need
  manual security tracking.
- Don't add intro/outro scenes, lower-thirds, subscribe overlays. The
  user explicitly rejects these.
- Don't switch to streaming (live) — recording only, for now.
- Don't suggest x264 software encoding as the default — AV1 VAAPI
  is what this hardware supports best, and the user has explicitly
  chosen "modern codec".
- Don't recommend recording at 1080p — the host's primary monitor is
  4K and they want the full physical capture.
- Don't use `timeout N obs` for validation — it kills mid-save.
- Don't edit the live config at `~/.config/obs-studio/` directly
  (other than via the symlinks in `basic/`, `plugin_config/`,
  `plugin_manager` which already point here). The runtime dirs
  (`logs/`, `profiler_data/`, `updates/`, `.sentinel/`) are intentionally
  NOT in this repo — leave them as actual local dirs.