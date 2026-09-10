# OBS recording config

YouTube: software dev / AI / SaaS / solopreneurship, US/EN, ~250 followers.
Fire-and-forget record-to-upload. No intro/outro/overlays.
HW: Fedora 44 KDE Wayland, Ryzen 9 8945HS + Radeon 780M iGPU.
Enc: AV1 VAAPI (Mesa 26.x ✓), HEVC VAAPI ✗, x264 burns CPU.

```
~/.config/obs-studio/
├── basic/             # profiles + scenes (tracked)
├── masks/             # alpha PNGs for Image Mask/Blend
├── plugin_config/     # symlinked → repo
├── plugin_manager/    # symlinked → repo
└── (logs/ profiler_data/ updates/ .sentinel/ — local only)
```

~/.config/obs-studio/{basic,plugin_config,plugin_manager} → symlinks here.

## Recording

Profile `YouTube-Coding`. F9 record, F10 pause. Output to `~/recordings/`.

Mic chain (order matters):
```
RNNoise -> Gain +12dB -> Gate (-25/-30, hold=200ms) -> Compressor (4:1, -15, +3)
```
Gain before gate = loud phrases survive gate. Don't flip order.

Crop webcam: `left=425, cx=500, cy=730` (user-tuned).
Mask: alpha PNG, color=4294967295, stretch=false.

## Workflow

Repo `spy4x/dotfiles` public. This dir lives inside it. Git Flow.
On session start: `git status`. If uncommitted tweaks → ask before acting.
AGENTS.md mirrors config — drift = bug, fix on every edit.
OBS only persists on graceful shutdown. `timeout`/`kill -9`/X-button = unsaved.
Verify file on disk after every close.

## Skip

- third-party plugins
- intro/outro/lower-thirds, streaming, x264 default, 1080p suggestion, `timeout N obs`
- direct edits to live config outside the three symlinked dirs

## Gotchas

- mask_filter needs `versioned_id: "mask_filter_v2"`
- Crop = absolute pixels; mask PNG dims ≠ post-crop source = OK with stretch=false
- filter objects need full schema (`volume, balance, enabled, muted, push-to-mute*,
  hotkeys, deinterlace_mode, monitoring_type, private_settings`) — missing any → OBS
  drops the whole filters array on save
- 1.7x display scale silently reverts 4K→1080p in `[Video]`. Always verify file on disk
  after a graceful close.
- Two v4l2_input sources need PipeWire mux. Webcam black on CameraOnly → restart OBS.
- `/dev/video0 "device busy"` on startup = transient PipeWire race, not a bug.
- RestoreToken rotates per launch; line-level gitignore impossible, small diffs are noise.
