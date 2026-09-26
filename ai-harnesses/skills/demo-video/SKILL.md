---
name: demo-video
description: Record a smooth README demo GIF of a web app with Playwright — a visible mouse pointer, eased movement, click marks, human-paced typing, dark theme, no white flashes, a steady frame rate. Load whenever asked to make, fix or regenerate a demo video, animated GIF or screen recording of a web UI.
---

# Demo video of a web UI

A viewer must be able to follow the demo: where the pointer goes, what it clicks, what it types.
Headless Chromium records no cursor, and Playwright's clicks teleport, so both have to be drawn and
paced by hand. Reference implementation: `spy4x/mig`, `scripts/screenshots.ts` (issue mig#70).

Files next to this one:

- `pointer.js`: an init script that draws the pointer and a click mark into every page.
- `human-mouse.ts`: `moveLike`, `clickLike` and `typeLike`, which drive the real mouse the way a
  person would.

Copy them into the project's script. They are small and opinionated, so each project owns its copy.

## Recording

1. **One context for the recording**, separate from the one for still screenshots, so the stills
   stay pointer-free. Give it a fixed viewport (1280x800 works), `recordVideo` at the same size,
   `colorScheme: "dark"` (or whatever the brief asks for), a fixed `timezoneId` and `locale`.
2. **Pointer.** Before the first `goto`, add
   `window.__demoPointerStart = { x, y }` as an init script, then
   `context.addInitScript({ path: "pointer.js" })`. It reruns on every document and keeps its
   position in `sessionStorage`, so it stays in place across navigations. Load pages with `goto`,
   never `page.setContent`: its `document.open` drops the init script's listeners, and no pointer
   appears.
3. **Theme before first paint.** The app needs `<meta name="color-scheme" content="light dark">`
   and an inline theme script in `<head>`; then `colorScheme` alone gives dark first paints, and
   Chromium keeps the old page on screen until the new one paints. A white frame between pages
   means one of those two is missing: fix the app, not the recording.
4. **Drive it like a person.** `clickLike` for every click (`locator.click()` teleports),
   `typeLike` for fields (70 ms per key). Pause 600–1000 ms on each new state so it can be read.
   `page.mouse.move(x, y, { steps })` sends every step at once, so it still looks like a jump.
5. **Trim the blank start.** Note `Date.now()` right after `newPage()` and again once the first
   page is loaded and the pointer placed. The difference is the trim, in seconds.
6. **Close the context** to flush the video, then close the browser, on the failure path too.

## Encoding

Playwright's WebM has a variable frame rate. Resample to a steady rate and build one palette from
what moves:

```bash
ffmpeg -y -i in.webm -ss <trim> -vf "fps=20,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 out.gif
```

- `-ss` goes after `-i`: slower, but frame-accurate.
- 10 fps or `dither=none` alone makes smooth motion look jerky.
- A Bayer dither stays still on flat dark areas; Floyd–Steinberg shimmers.
- `diff_mode=rectangle` re-encodes only the changed area, which keeps the file small. A 16 s,
  800x500 clip at 20 fps came out at about 2.2 MB.
- Size the click mark for the GIF, not the page: 1280 → 800 px shrinks it by 0.625. Keep its
  colours opaque; a semi-transparent fill over a dark page blends into greys the palette keeps as
  grey.

A GitHub README does not play a video file inline, so the GIF is the deliverable.

## Checking the result

Look at frames before calling it done:

```bash
ffmpeg -i out.gif -vf "fps=2,scale=400:-1,tile=6x5" -frames:v 1 sheet.png
ffmpeg -i out.gif -vf "select='between(n,40,63)',crop=400:300:0:0,tile=6x4" -fps_mode vfr -frames:v 1 move.png
ffmpeg -i out.gif -vf signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=luma.txt -f null -
```

- **Contact sheet:** every step of the flow is there, in the intended theme.
- **Consecutive frames of one move:** the pointer advances a little each frame and never jumps,
  including across a page load.
- **Luma:** the brightest frame of a dark demo stays dark (mig's peaked at 29/255), so no frame
  flashes white.
- **Click marks:** zoom a 200x140 crop around each click. The mark is visible for 4–6 frames, and
  gone right after a navigating click (none left frozen next to a "Sending…" button).
