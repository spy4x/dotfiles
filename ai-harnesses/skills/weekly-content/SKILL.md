---
name: weekly-content
description: "The weekly unit every project of the owner publishes in public: one post, one 5–10 minute video and one Short, from that week's real work. Whose turn it is, how agents suggest a topic when work turns up something worth sharing, the recording kit, what the owner does and what agents do, the line on AI, formats, search and answer engines, channels and what is automated. Load when planning or preparing a week's content or a recording, when work turns up something worth sharing (a real measurement, a mistake with a lesson, a technique, a feature worth showing), and before building anything that publishes or shares a post or a video."
---

# Weekly content

Part of the global rules (`AGENTS.md`, "Marketing"); they bind as if written there. The decision
and the owner's words: `ai-memory/decisions/2026-11-18-weekly-content-unit.md`. The evidence behind
every rule here: `ai-memory/ideas/research/content-factory-2026-11.md`; check a number against its
source before it goes into anything public.

## 1. The unit

Every project the owner builds is built in public. Each week one unit goes out, from that week's
real work:

- **a post**, written by the `blog-post` skill;
- **a video** of 5–10 minutes on the same topic, recorded by the owner and finished by the
  `talking-video` skill;
- **one Short**, cut from the video's footage or recorded to point at it. One per video, never
  more, so Shorts never outnumber the long videos.

One unit a week in total, never one per project, because the owner records once a week. The unit
is about the project whose turn it is:

1. Seed, now.
2. The owner's blog (lessons, techniques, scars, advice for founders, his other projects), once
   antonshubin.com runs on Seed.
3. Financy, once its first version is in daily use for his own finances.
4. Ringmaster, then the others.

A project that is not on turn still gets posts when something worth sharing lands (`blog-post`,
step 1). They need no recording.

## 2. Ideas: suggest one when the work earns it

Any agent, in any repository, suggests a topic when its work turns up something a stranger would
stop for:

- a real measurement with a number that surprises;
- a mistake with a lesson (the "scars" category);
- a technique that solved a problem other people search for;
- something a user can now see or do that they could not before, worth showing on screen;
- a comparison settled by trying both.

A routine fix, a refactor, a dependency update or anything that needs inside knowledge to be
interesting is none of these. Most sessions suggest nothing.

A suggestion is one comment on the repository's open issue titled `Content ideas` (labels
`marketing` and `p5-someday`; create it when it is missing):

- the title, worded as the question a person would type or ask;
- why a stranger cares, in one line;
- the proof: the pull request, the numbers, the file;
- the form it fits best: post, video, Short, or all three.

In a public repository the comment holds nothing of a private project (`AGENTS.md`, the hard rule on
secrets). A subagent puts the idea in its report, and its lead files it. In a chat session, also
say it in one line.

## 3. Who does what

The owner does three things: he records, watches the cut once, and approves. Agents do the rest:
they pick the topic, write the post, prepare the recording kit, cut the video, and write the
title, description, chapters, captions, thumbnail and channel texts.

**The post never waits for the video.** It goes out through its own gate (`blog-post`, step 11),
and the video is added to it once approved. A week without a recording still publishes.

**A video never goes out without the owner's approval**, because his face and voice are in it.

## 4. The recording kit

Recording is the one step agents cannot do and the one that slips, so the kit removes every
decision from it. An agent prepares it when he asks for the week's content or
his weekly planning reaches it, from merged work and the `Content ideas` issue, without asking him
anything. It is one page, `~/recordings/<slug>/kit.md`, always in this shape:

- the working title, the viewer in one line, and the question the video answers;
- **the opening sentence, word for word**: the viewer's problem and what they get, sayable in
  fifteen seconds;
- three talking points, no script, each with what is on screen for it and the tab, file or command
  to have open;
- the closing sentence, with the one next step (the post);
- the Short: which talking point it is cut from, or the one sentence to say again to the camera;
- the OBS scene to use (`CodingScene` for developers: screen with a small face overlay;
  `CameraOnly` for founders) and where the file lands (`~/recordings/`);
- the rules of the take, below;
- the numbers of the last published unit, when there is one.

The rules of the take:

- The first step is to open the scene and say the opening sentence. Anything after it is a bonus.
- One take. A fumbled sentence is said again on the spot; the cut keeps the last try. No restart.
- Pauses, filler and retakes are cut, so ten to fifteen raw minutes are plenty.

The kit's shape is frozen. Better lights, a script or a new tool are never a reason to delay a
recording, and an agent never proposes one as a step before it.

**When he records is his own plan.** He sets the slot in his weekly planning (the `one-thing`
skill, week mode) as a sentence of his own: "Tuesday after lunch, I record at the desk."

**No reminders** (direction, "No nudges"). No agent asks whether he recorded, counts missed weeks,
keeps a streak, or says "ready when you are". A missed week is dropped: next week's kit replaces
it, nothing is owed, and a week never gets two recordings to catch up. The only feedback is the
numbers of what went out.

## 5. The line on AI

Viewers accept AI that helps a person make a video, and reject AI that replaces the person.

Automate:

- cutting silences, filler and retakes; cleaning and levelling the audio;
- captions made from his own words;
- titles, the description, chapters, a thumbnail built on a real frame;
- drafts of the post and the channel texts, in his voice (`owner-voice`, `blog-post`).

Never:

- an AI avatar or digital twin, or a cloned or synthetic voice, his own included;
- generated footage of something that did not happen, generated B-roll, or automatic dubbing;
- words he did not say: captions and quotes hold only what the recording holds;
- videos mass-produced from one template: YouTube removes monetisation from the whole channel;
- a text that reads as generated (`blog-post`, step 5).

What a viewer sees and hears in a video is recorded. A post's cover picture follows `blog-post`.

## 6. What the video is like

- **It stands alone.** Most viewers are strangers sent by search or suggestions: no "in the last
  video", no episode numbers, no series.
- **A problem or a technique, never a diary.** The title is the question as people type it, never
  "Week 12 of building X".
- **5–10 minutes.** The first fifteen seconds say the problem and what the viewer gets.
- **Audio first.** A clear, level voice matters more than the picture.
- **Calm editing.** Cuts at sentence ends, a zoom only on purpose; no sound effects, stock
  footage or animated captions.
- **One theme:** dark for developers (direction, "UI and UX").
- **The Short** is vertical, 30–55 seconds, and makes sense without the long video.

## 7. Search and answer engines

The post follows `blog-post`, steps 2, 4 and 9. The video adds:

- a title that is the search question, and a description whose first two lines answer it and link
  the post;
- chapters as timestamps in the description, and captions uploaded from his corrected words;
- the post page shows the video with its transcript and `VideoObject` data, and the video's
  description links the post, so each brings readers to the other.

## 8. Publishing

Automate every channel whose rules allow it and whose audience is ours; an agent never posts to a
network itself (`blog-post`, step 12): the product's own jobs do, after the gate for a post and
after the owner's approval for a video.

- **The post:** the product publishes it and posts it to its channels. Seed does this today
  (`spy4x/seed`, `docs/blog.md`, "Automatic posts").
- **The video and the Short:** YouTube (the channel the site's settings name; every project uses
  the owner's one channel today), LinkedIn as an uploaded video, never as a YouTube link, the
  Telegram channel, Bluesky and Mastodon. No product uploads video yet, so `talking-video` ends
  with a page the owner uploads from by hand.
- **By hand, always:** X (its API bills by use with no cap), Reddit and Hacker News.
- **Skipped:** TikTok and Instagram (an audit or a business account for little of this audience),
  and a second posting system beside the product's own.
- Every channel gets the master file, never a copy downloaded from another platform.

## 9. Numbers

After a unit is out, read what the platforms give: for the video, views, average view duration,
subscribers gained and where viewers came from; for the post, visits and what each channel sent.
They open the next kit in two or three lines and decide which kind of topic gets the next turn.
Never report what was not published.
