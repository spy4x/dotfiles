# The dotfiles demo video

`media/demo/` holds the README's demo video, "Under the hood" (about 58 s): the source folder
`ai-harnesses/`, `deno task ai` rendering it into Claude Code, OpenCode and DSH, the reviewer
agent in all three formats side by side, one edited line reaching all three, and
`deno task ai --check` catching a hand edit to one rendered copy. Captions are in
`../captions.vtt`, the music and its licence in `../MUSIC.md`.

Everything runs in a fresh clone of this repository with empty harness homes under a scratch
`/home/demo`, inside `bwrap`: the real `~/.claude`, `~/.config` and `~/.local` are hidden and
never read or written, so no private rule, memory or token can reach the screen.

## Needs

`bwrap`, `vhs` (with its `ttyd` and Chromium), `nvim`, `git`, `deno`, `ffmpeg` with libvpx-vp9,
libopus, libx264, libwebp and drawtext, fontconfig, and the Hack font.

## Remake it

1. From the repository root: `deno task demo-video` (or `media/demo/recipe/record.sh <git ref>`;
   `DOTFILES_REPO=<path or url>` clones from somewhere other than GitHub). It records
   `demo.tape`, pads it to 1280x800 with room for the caption band into
   `media/demo/.raw/demo-raw.mp4` (gitignored), and then runs `encode.ts`. About 2 minutes to
   record, plus the encode.
2. Only captions, cards or music changed: `deno run -A media/demo/recipe/encode.ts` re-encodes the
   last raw take. On a loaded machine the encode takes several minutes.
3. Check the result before committing: a contact sheet
   (`ffmpeg -i media/demo/demo.mp4 -vf "fps=1,scale=320:-1,tile=6x10" -frames:v 1 sheet.png`)
   shows every caption over the step it names. The caption times in `captions.vtt` follow the
   `Sleep`s in `demo.tape` (the final video starts with a 2 s title card); after changing the
   tape, re-time the captions from a contact sheet of the raw take. `poster` in `encode.ts` is the
   raw-take second the poster is taken from (the three panes).

`encode.ts` calls the demo-video skill's encoder (`ai-harnesses/skills/demo-video/encode.ts`). It
refuses captions too long or too short to read, deletes both videos if the mix is louder than
-27 LUFS or above -1 dBTP, and prints each file's loudness and size.

## Files

- `record.sh`: clones, stages the scratch home, records, encodes.
- `enter.sh`: the `bwrap` sandbox shell with `HOME=/home/demo`.
- `demo.tape`: the vhs script, scene by scene.
- `demo.bashrc`: the prompt, and the rule printed before every prompt so each command's output
  stands apart.
- `demo.vim`: Neovim's look, with each pane titled by the tool that reads the file.
- `encode.ts`: the title, claim, end card and poster second for the skill's encoder.
