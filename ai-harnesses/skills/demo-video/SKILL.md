---
name: demo-video
description: Make, remake or fix a demo video of a product or tool, web UI or terminal — one canonical copy with its recipe in the project's own repository, burned-in captions, title and end cards, its own calm CC0 music, a visible human-paced pointer, WebM and MP4 with posters (a GIF only when a target needs one). Load whenever asked to record, regenerate or fix a demo video, a screen recording, a README clip or GIF, or a site's product or tool clip.
---

# Demo video of a product or tool

A demo video shows a first-time viewer what the thing does, in 30–60 seconds, without sound being
needed. It is remade often, as features land, so the recipe matters as much as the video: anyone
must be able to remake it with one command. The global rule (`AGENTS.md`, "Design", "Videos") says
where it lives; this skill says how to make it.

Reference implementation: Seed's admin panel video, `spy4x/seed`, `docs/screenshots/admin-video.ts`
and `MUSIC.md` beside it (screencast frames, ffmpeg joins and lays the music, a loudness refusal).
Seed draws its captions and cards into the page; a new recipe has `encode.ts` burn them from
`captions.vtt`, so a caption change needs no new take. `reference.md` next to this file holds the
details and the traps found so far; read the part you need before recording.

Files next to this one, which each project copies into its recipe and owns from then on:

- `pointer.js`: init script that draws the pointer and click marks, above modal dialogs, under a
  strict CSP.
- `keys.js`: init script that shows shortcut and navigation keys as a key cap.
- `human-mouse.ts`: `moveLike`, `clickLike`, `typeLike`, `scrollLike`, `parkLike`, which drive the
  real mouse the way a person would.
- `encode.ts`: `encodeDemo()`, a raw take plus `captions.vtt` plus `music.opus` → the four outputs,
  with the cards, and refusals for unreadable captions and a loud mix.

## Where a video lives

One canonical copy, in the repository of the thing it shows, under `media/demo/`:

| File                                  | What it is                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `demo.webm`                           | VP9 + Opus, 1280×800 (another 16:10 size only with a reason in the recipe), 30 fps, no metadata |
| `demo.mp4`                            | H.264 + AAC, `yuv420p`, `+faststart`, same size and rate                                        |
| `poster.webp`, `poster-640.webp`      | a still of the opening screen, 1280 and 640 px wide, with no caption, card or pointer           |
| `captions.vtt`                        | the caption lines with their times: what the encoder burns in, and the transcript sites read    |
| `music.opus`, `MUSIC.md`              | the track's excerpt (Opus 96 kbit/s), and its title, author, source URL, licence, what was cut  |
| `recipe/` (or the repo's scripts dir) | the recording script(s), staged demo data, the encode step, and a `README.md`                   |

- **One command remakes it**, end to end: `deno task demo-video`, or `make demo-video` or a shell
  script in a repo without a Deno config. The recipe's `README.md` says in numbered steps what it
  needs installed, what it does and how long it takes.
- **The encode step runs alone**, on the last raw take, so a caption or music change costs one
  encode, not a new recording. The raw take is never committed.
- **Staged data only.** Never the owner's real homelab, calendar, mailbox, contacts, tokens, IP
  address or paths. Seed the app with made-up data; run terminals in a clean home (`reference.md`).
- **Reuse, never re-record.** The README shows `poster.webp` linked to the video's page on
  antonshubin.com (`https://antonshubin.com/tools/<slug>`), because GitHub does not play a
  committed video inline. Other sites (antonshubin.com, the product's own site) copy the files at a
  pinned commit with a pull script.

## What the video contains

- **A title card** (2 s: the name and the README's one-line claim) and **an end card** (2 s: the
  repository URL), in the dark theme. `encodeDemo()` draws both.
- **Captions, burned in**: a dark, semi-transparent band across the bottom (84 px at 1280×800),
  one short sentence per step in plain words, saying what happens and why it matters ("Add a
  service to the config", "The card appears, already checking it"). Each stays at least 2.5 s and
  long enough to read at 15 characters a second, and fits one line (64 characters). The encoder
  refuses captions that break these. Never cover what a caption talks about: keep the bottom 84 px
  free of the action (scroll, zoom or lay out the shot for it).
- **Pace for a first-time viewer.** One thing moves at a time. Hold every new state at least
  1.5 s. Type at a human pace (50–70 ms a key). 30–60 s in total.
- **Dark theme**, a visible pointer that moves like a person, a click mark on every click, a key
  cap for every shortcut, and no white flash between pages.
- **Music**: its own calm, quiet track, under the whole video (below). No voice-over.

### Writing `captions.vtt`

Times are in the finished video, so the first caption starts at 2.000 or later (after the title
card) and the last ends before the end card. Write the cues from the recorder's own clock (note
the time when each step starts) or by watching the raw take; keep the file in `media/demo/`.

```
WEBVTT

00:02.000 --> 00:05.500
Add a service to the config

00:05.500 --> 00:09.000
The card appears, already checking it
```

## Terminal clips

A viewer must always know which output belongs to which command:

- Separate commands visibly: a blank line and a full-width rule (or a coloured prompt bar) before
  each new command; clear the screen between unrelated steps.
- A short neutral prompt (`~/project $`), never the recorder's own prompt, user name or path.
- Big enough to read once a site shrinks the clip: about 20–24 px font at 1280 px, so 90–100
  columns. Measure `tput cols` in the recorder; a line that wraps is a line too long.
- Speed up a long wait (a download, a build) under a caption that says so, or record it in parts.
- vhs, tmux and the clean-home setup are in `reference.md`, "Terminal".

## Music and loudness

- **Each video has its own track**, never one that another of the owner's videos uses: a visitor
  plays several in a row. Pick calm, quiet, unobtrusive instrumental music: soft piano, ambient or
  lo-fi, no vocals, no drums that push, nothing that grates the third time in two minutes.
- **CC0 only** (public domain dedication), so no attribution or licence terms follow the video
  around. Free Music Archive and Wikimedia Commons have CC0 tracks; check the licence on the
  track's own page. Write `MUSIC.md` like Seed's: title, author, album, source URL, licence with
  its link, and what was cut.
- Keep an excerpt at least as long as the video in `music.opus` (Opus 96 kbit/s).
- `encodeDemo()` trims it to the video, fades it in over 1 s and out over 2 s, sets it to about
  -28 LUFS integrated, and refuses a mix louder than -27 LUFS or above -1 dBTP (deleting the
  file). Check by hand with `ffmpeg -i demo.mp4 -af ebur128=peak=true -f null -`.

## Recording a web UI

Prefer Chrome's screencast (CDP `Page.startScreencast`): it sends a sharp frame each time the page
paints, at the device scale you set, where Playwright's `recordVideo` is a soft 25 fps VP8. Write
each frame as a JPEG and an ffmpeg concat list with each frame's real duration; Seed's `Recorder`
class and `concatList()` are the model. `recordVideo` is fine for a quick clip; measure its start
lag (`reference.md`).

1. **One context for the recording**, separate from any for stills. A fixed viewport (1280×800),
   `colorScheme: "dark"`, a fixed `timezoneId` and `locale`. For a sharper picture, set
   `deviceScaleFactor: 2` with the screencast; to make small text bigger, use `body { zoom }`, not a
   smaller viewport (`reference.md`).
2. **Sign in off the record**, in another context, and pass its `storageState`.
3. **Init scripts**: `window.__demoPointerOptions = { x, y }` (and `iframes: "shield"` when the
   pointer must cross an iframe), then `pointer.js`, then `keys.js`. Load pages with `goto`, never
   `page.setContent`, whose `document.open` drops the init scripts' listeners.
4. **Theme before first paint.** The app needs `<meta name="color-scheme" content="light dark">`
   and an inline theme script in `<head>`; then `colorScheme` makes even the blank frame between
   pages dark. A white flash means one of those is missing: fix the app, not the recording.
5. **Drive it like a person.** `clickLike` for every click (`locator.click()` teleports),
   `typeLike` for fields, `scrollLike` to scroll, and `parkLike` after a click so the pointer
   leaves what the next caption talks about. Pause on each new state. For the poster, hide the
   pointer and take a screenshot (`reference.md`, "Web: the poster").
6. **Start recording once the first page is settled** (fonts loaded, pointer placed), so the take
   has no blank start; otherwise pass the blank seconds as `trim`.
7. **Close the context** (flushes `recordVideo`) and the browser in a `finally`, on the failure
   path too.

## Recording a terminal

vhs (a `.tape` file) for a scripted session; tmux inside it when the clip needs two panes. Run it
in a clean, staged home, never your own (`reference.md`, "Terminal"). vhs writes an MP4 the
encoder takes as is.

## Encoding

```ts
import { encodeDemo } from "./encode.ts"

await encodeDemo({
  take: `${work}/frames.txt`, // a concat list of screencast frames, or a video file
  out: `media/demo`, // holds captions.vtt and music.opus; gets the four outputs
  title: `oko`,
  claim: `One page for every service, with its uptime`,
  end: `github.com/spy4x/oko`,
  poster: 0, // seconds into the take, or an image file
})
```

It needs ffmpeg with libvpx-vp9, libx264, libopus, libwebp and drawtext, and prints the length,
sizes and loudness. It retries at lower quality until each file is under about 3 MB per 45 s, and
says so when it cannot. Joining several takes (a terminal part and a browser part) happens before
it, in one ffmpeg call that produces one take (`reference.md`, "Joining parts").

**A GIF only when a target needs one** (a page that cannot play video): `reference.md`, "GIF".

## Checking before the PR

Look at the result before calling it done:

```bash
ffmpeg -i media/demo/demo.mp4 -vf "fps=1,scale=320:-1,tile=6x8" -frames:v 1 sheet.png
ffprobe -v error -show_entries stream=codec_name,avg_frame_rate -of csv=p=0 media/demo/demo.webm
```

- **Contact sheet:** the title and end cards are there, every caption is readable and nothing it
  describes sits under it, every step of the flow is there in the dark theme, and no frame shows
  anything but staged data.
- **Streams:** 30 fps video and an audio stream in both files; the length you expect.
- **Pointer:** consecutive frames of one move advance a little each and never jump, including
  across a page load; each click mark shows for 4–6 frames and is gone after a navigating click.
- **No flash:** `reference.md`, "Checks", measures luma on a plain margin and between frames.
- **Posters:** the opening screen, no caption, card or pointer on it.
- **Recipe:** from a clean checkout, the one command remakes the video, and `README.md` says so.
