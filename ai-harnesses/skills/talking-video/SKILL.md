---
name: talking-video
description: "Turn the owner's own recording (his voice, his screen or his face) into the finished weekly video and its Short: transcript with word times, the cut of silences, filler and retakes, level audio, captions, title, description, chapters, thumbnail candidates, his one review, and the page he uploads from. Load when asked to cut, edit, finish, package or publish a video the owner recorded, or to make its Short. A product or tool clip made without him is the `demo-video` skill."
---

# The owner's recorded video

The `weekly-content` skill says what the video is, what may be automated and what never is; it
binds here. This skill is the steps from his recording to the files he approves. Everything runs
on his machine: nothing is uploaded and no usage-billed API is called.

The tools today are in `spy4x/antonshubin.com`: `deno task video-cut` and `deno task video-kit`,
documented in its `docs/video-kit.md`. Read that doc before the first run; it is the source for
flags and file formats.

## 1. Files

One folder per video, `~/recordings/<slug>/`, where the kit already is (`kit.md`):

- `raw.mkv`: the recording. OBS writes to `~/recordings/`; move the newest file made after the kit
  into the folder under this name. **Never delete, overwrite or re-encode it in place**: it is the
  owner's only copy.
- `cut/`: everything this skill makes. Pass `--out ~/recordings/<slug>/cut` to the cut tool.
- `publish.md`: the page of step 8.

## 2. Transcript

Transcribe with whisper.cpp (`whisper-cli`) and `--output-json-full`, which gives a time for every
word. The cut tool needs those word times: a transcript without them is no substitute. dotfiles'
`deno task install-apps` installs `whisper-cli`, the model
`~/.local/share/whisper.cpp/models/ggml-small.en.bin` and `deep-filter`.

Then correct, in the JSON, the spelling of names, products and commands the transcript got wrong:
the Shorts' captions are burned in from it. Never change what he said.

## 3. The edit list

`deno task video-cut prepare <whisper.json> <raw.mkv> <slug> --out <cut dir>` decides the silences
and writes `edit-brief.md`. Answer the brief yourself, in the session, and save the JSON. On top
of the brief:

- **Retakes.** When a sentence is said two or more times, keep the last complete try and cut the
  earlier ones (`retake`). The owner records in one take and repeats what he fumbles.
- **Filler** (`filler`): "um", false starts, "so, yeah", a sentence abandoned halfway.
- **Off-topic** (`off-topic`): only what the video's question does not need. When the cut is still
  over ten minutes, cut the weakest talking point's tangents; never speed the video up.
- Cut at the end of a sentence, never inside one so that its meaning changes, and never reorder.
- The opening sentence from the kit stays, and it is the first thing heard.
- Chapters: one per talking point, named as what the viewer learns.
- The tool asks for two Shorts of 30–55 seconds. Choose two passages that make sense alone;
  the better one is published, the other is discarded after the review.

## 4. Render

`deno task video-cut render <whisper.json> <raw.mkv> <slug> <edit.json> --out <cut dir>` writes
`long.mp4`, `long.srt`, the two Shorts with burned captions, a Kdenlive project and the packaging
drafts. A range the tool rejects is fixed in the edit list, never worked around.

## 5. Audio

A clear, level voice matters more than the picture. Set each output to −14 LUFS integrated and at
most −1 dBTP, in two passes, the video stream copied:

```bash
ffmpeg -i long.mp4 -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null -
ffmpeg -i long.mp4 -c:v copy -c:a aac -b:a 192k -ar 48000 -af \
  loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=<i>:measured_TP=<tp>:measured_LRA=<lra>:measured_thresh=<t>:offset=<o>:linear=true \
  long.final.mp4
```

The first command prints the measured values the second takes; `-ar 48000` undoes the filter's
upsampling. Run both for the long cut and for each Short. Use a noise remover only when the
noise is audible, and compare before and after: it can make a voice sound processed. No music, no
sound effects.

## 6. Captions and packaging

- **Captions** (`long.srt`): read them once; a name still misspelt is fixed in the transcript
  (step 2) and the render runs again.
- **Title:** the question the video answers, as a person types it (`weekly-content`, step 7).
  Offer three, the recommended one first.
- **Description:** two lines that answer the question and link the post with the site's tagged
  link, then the chapters as timestamps on the cut timeline, the first at `0:00`.
- **Thumbnail:** three candidates at 1280x720, each a real frame of the video with at most four
  large words. No generated picture.
- **Channel texts** for the video and the Short: `blog-post`, step 12, and one for the Telegram
  channel in every set.
- The post's draft from `video-kit` is raw material for the `blog-post` skill, never a finished
  post.

## 7. Check, then one review

Check before the owner sees anything:

- the long cut is 5–10 minutes, and its first words are the kit's opening sentence;
- `ffmpeg -i <file> -af ebur128=peak=true -f null -` reads −14 LUFS within one unit, peak at most
  −1 dBTP, for each output;
- the Short is 1080x1920 and 30–55 seconds; look at three of its frames: the captions are readable
  and neither the face nor the code is cropped away;
- look at a frame on each side of five cuts: no cut lands inside a word or leaves a jump to a
  different screen without reason.

Then show him the files once: the long cut, the Short, the three thumbnails, the title and the
description. What he asks to change (restore a passage, cut another, a different Short) goes into
the edit list, and the render and the checks run again. His approval is required before anything
leaves the machine (`weekly-content`, step 3).

## 8. The upload page

No product uploads video yet, so write `~/recordings/<slug>/publish.md` for him to upload from, one
block per channel (`weekly-content`, step 8), each with the file's full path, the title, the text
to paste and the link:

- YouTube, the long video: title, description with chapters, `long.srt` as captions, the chosen
  thumbnail, "not made for kids", and "altered content: no" (editing help needs no label).
- YouTube, the Short: its own title, and the long video's link in the description.
- LinkedIn, Telegram, Bluesky and Mastodon: the Short's file, uploaded as a video, with its text.

After he publishes, add the video's link to the post (the post page shows the video) and to the
`Content ideas` comment the topic came from, and log each upload in public activity
(`owner-voice`, "Public record").
