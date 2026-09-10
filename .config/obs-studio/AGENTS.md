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
| `11111111-...` | Desktop Audio | global | `pulse_output_capture`, default device |
| `22222222-...` | Microphone (Razer Seiren Mini) | global | `pulse_input_capture`, with 4-filter chain. Lives at the scene-collection level (top-level `AuxAudioDevice1`), so it's global — not per-scene. |
| `33333333-...` | Screen Capture (PipeWire) | CodingScene | `pipewire-screen-capture-source`, captures HDMI-A-1 only |
| `44444444-...` | Webcam (Logitech C922) | CodingScene | `v4l2_input`, MJPG 1920×1080 @30 fps, **with crop + mask filters** |
| `77777777-...` | Webcam (Logitech C922) Full | CameraOnly | `v4l2_input`, **uncropped, full screen** |

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

**Webcam (bubble)** (filter order top → bottom, as OBS stores them in this scene JSON):

1. **Crop (vertical portrait)** — `crop_filter`, left=425, top=0; cropped-source dimensions: cx=500, cy=730 (right/bottom unset = blank off, OBS infers from native minus left). Converts 1920×1080 native C922 to ~1070×1080 (slightly less aggressively cropped than the original left=600/right=600 — the user tuned this for better head framing).
2. **Image Mask/Blend (rounded)** — `mask_filter`, type=`mask_alpha_filter.effect`, image_path=`~/.config/obs-studio/basic/masks/mask-2x3-vertical.png`, color=4294967295 (0xFFFFFFFF = white with full alpha), opacity=1.0, stretch=false. Uses PNG alpha channel to mask the source (white=visible, transparent=hidden). Note: the PNG is 600×900 but the cropped source is ~1070×1080 — the mask scales the shape up to fit, and `stretch=false` keeps aspect ratio so the corners stay properly rounded (slight padding on top/bottom is acceptable).

**NOTE**: Earlier versions of this config had `crop_filter` values `left=600, right=600, top=0, bottom=0` and mask color `16777215`. The user tuned both via the OBS GUI for better framing and a more explicit white-with-alpha color value. If a future session reverts to the older numbers, **ask the user first** — they may have intentionally tweaked. See "Workflow & decision protocol" below.

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
  the file is upload-ready at any quality. **If recordings keep coming
  out 1080p even though basic.ini says 3840×2160, the bottleneck is
  PipeWire screen capture source negotiation with the scaled monitor
  resolution, NOT the [Video] section. Investigate the screen capture
  source, not the canvas size.** Changing resolution also causes OBS
  to **double all scene-item pos/scale values** automatically (since
  the canvas coordinates doubled in size). Let it; don't undo them.
- **Vertical webcam (crop+mask)**: Modern UI aesthetic. The mask is
  a built-in OBS filter (mask_filter / "Image Mask/Blend"), no plugin.
- **MKV + auto-remux**: MKV is crash-resilient (a killed recording
  isn't lost). OBS auto-remuxes to MP4 on stop, so YouTube upload
  needs no manual conversion step. **NOTE**: the auto-remux only fires
  when you click the normal "Stop Recording" button. If you stop a
  recording by closing OBS or otherwise interrupting it, the MP4 won't
  be produced. Either use the Stop button, or run
  `ffmpeg -i input.mkv -c copy output.mp4` (or use the in-app File →
  Remux Recordings dialog) afterward.
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

## Workflow & decision protocol

### Repository context

- **This directory** (`sync/code/dotfiles/.config/obs-studio/`) is **inside
  a git repo** rooted two levels up at `~/sync/code/dotfiles/`.
- Repo host: GitHub `spy4x/dotfiles` (private).
- Commit style: Angular Conventional Commits (`<type>(<scope>): <subject>`)
  — see existing log via `cd ~/sync/code/dotfiles && git log --oneline -20`.
  Preferred types: `feat`, `fix`, `chore`, `refactor`, `docs`.
  Scopes: `obs` for everything in this directory (use sub-paths in
  the body if needed, not in the scope).
- Body wraps at 72 chars, explain *what* and *why*, not *how*.

### On session start (mandatory)

1. **Check git state in `~/sync/code/dotfiles`**:
   ```sh
   cd ~/sync/code/dotfiles
   git status
   git log --oneline -5
   ```
2. **Detect GUI drift**: if `git status` shows modifications under
   `.config/obs-studio/` that look like they came from the OBS GUI
   (pos/scale nudges, color/value tweaks, scene item adjustments,
   filter parameter changes, etc.) — these are NOT to be silently
   committed. Use `git diff` to show the user what's pending and
   **ask whether to preserve them as intentional** before doing anything
   else. The user may have:
   - Intentionally tweaked a value via the GUI (preserve)
   - Forgotten about uncommitted experiments (discard)
   - Tweaked something they later changed their mind about (revert)
3. **Read this AGENTS.md fully** to load context. Don't skim — the
   Open/Close thresholds, gain values, and crop numbers are committed
   decisions, not defaults to be overridden.

### During edits (mandatory hygiene)

1. **Always update AGENTS.md to match the actual on-disk config**
   after any change to scenes, profiles, filter values, masks, or
   file layout. Drift between AGENTS.md and config is the #1 source
   of confusion for future sessions.
2. **Document the user's intent**, not just the values. "User tuned
   crop from left=600 to left=425 for better head framing" is better
   than "left=425".
3. **Preserve gotcha entries** — when you discover a new gotcha,
   add it under "Known gotchas". When a gotcha no longer applies,
   remove or update it. Don't accumulate dead notes.
4. **Don't reformat this file** except for fixes you're explicitly
   asked to make.

### PR workflow (mandatory)

All changes to `~/sync/code/dotfiles/` go through pull requests on
GitHub. **No direct pushes to `main`.** No auto-merge. The user reviews
and merges manually.

**Concrete steps every session:**

1. Make changes + commit them on a feature branch:
   ```sh
   cd ~/sync/code/dotfiles
   git checkout -b obs/<short-slug>
   # make edits
   git add .config/obs-studio/
   git commit -m "feat(obs): ..."
   ```
2. Push the branch:
   ```sh
   git push -u origin obs/<short-slug>
   ```
3. **Open a PR using `gh`** (CLI available; auth should already be set):
   ```sh
   gh pr create --base main --title "obs: <short summary>" \
     --body "$(cat <<'EOF'
   ## Summary
   <one or two lines: what changed and why>

   ## Test plan
   - [ ] OBS launched + closed gracefully (verified file on disk)
   - [ ] JSON valid
   - [ ] No errors in OBS startup log
   - [ ] (Optional) Actual recording tested

   ## Notes
   <any context worth carrying into review — gotchas, side effects,
   things the reviewer should double-check>
   EOF
   )"
   ```
4. **Report the PR URL to the user.** Do NOT merge. The user will
   review on GitHub and merge (or request changes) themselves.

**Use `gh pr create --draft`** if the change is experimental or the
user hasn't confirmed they want to keep it.

**Squash-and-merge is OK** at merge time — the user controls that
button on GitHub.

### Pre-PR sanity checks

Before pushing, run:

```sh
cd ~/sync/code/dotfiles
git status                          # should show only intentional files
git diff --stat                     # review scope of change
python3 -c "import json; json.load(open('.config/obs-studio/basic/scenes/YouTube-Coding.json'))" \
  && echo "JSON valid"
grep -E "^[A-Z][a-z]+\s+[A-Z]" .config/obs-studio/AGENTS.md | head -5  # spot-check headings
```

Also re-read the relevant AGENTS.md section that documents the files
you changed — does it still match? If not, fix it before pushing.

### When AGENTS.md itself is wrong

If you discover during edits that AGENTS.md has incorrect info (drift,
wrong values, hallucinated features), treat it like any other file:

1. Mention the drift to the user in chat ("Heads up: AGENTS.md says X
   but the actual config is Y — the user tuned X to Y in the GUI last
   session, and we missed updating the docs.").
2. Fix AGENTS.md in the same PR as whatever change you were making,
   or in a dedicated `docs(obs): ...` commit.
3. Don't let drift accumulate — small fixes are cheap, big drift is
   expensive.

## Known gotchas (learned the hard way)

- **`mask_filter` requires `versioned_id: "mask_filter_v2"`** for the
  OBS 32 v2 schema (float opacity 0.0–1.0). Using the v1 ID works for
  loading but breaks on save in some configurations.
- **Crop filter absolute pixel values**, not relative. Source
  dimensions matter. A C922 at MJPG 1920×1080 currently uses `left=425`
  (with `cx=500, cy=730` set as the cropped dimensions). The user's
  working value — earlier was `left=600, right=600` (more aggressive crop).
  Don't override these without asking first.
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
- **OBS can silently revert settings on graceful save.** First OBS
  launch under KDE's 1.7× display scale auto-negotiated monitor
  effective resolution (1080p) and subsequent saves kept writing 1080p
  into `[Video]`, overwriting the 4K values. Always **verify the file
  on disk after every graceful close** — don't trust the in-memory
  log. Lesson: also verify after the FIRST ever OBS launch on a new
  machine or display configuration.

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