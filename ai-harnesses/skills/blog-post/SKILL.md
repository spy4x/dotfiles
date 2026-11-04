---
name: blog-post
description: 'How to propose, brief, write, translate and publish a blog post, changelog post, article or question page ("Alternatives to X") on any of the owner''s sites — antonshubin.com, seedsaas.com, a product''s site. Propose in chat first, then a four-lens brief, an answer-first draft in the owner''s voice, real proof only, interactive parts, search and answer-engine checks, every language, the newsletter and channel texts. Load whenever writing, outlining, translating or proposing one, and when a merged change looks worth a post.'
---

# Blog post

The `owner-voice` skill, "Marketing", sets the values: the most value in the least time, the
point first, honest persuasion only, one clear ask, written as the owner. This skill is the steps.
A site's mechanics (where posts live, their front matter, the tasks that build, publish and send
them) are in that repo's `AGENTS.md` and the docs it names; where they differ from a step here, the
repo wins for its mechanics, never for the values. The most complete example is antonshubin.com
(`docs/publishing.md`, `docs/voice.md`).

## 1. Propose in chat, then file

A post starts when the owner asks for one, or when a change lands that a reader would care about: a
new module or tool, a major change, a real measurement, a mistake with a lesson (the "scars"
category), the month's changelog. Before any issue or draft, put the proposal in chat:

- the title, and the reader in one line;
- the search question, the exact phrase a reader types or asks, in each language planned;
- the one next step the post ends with;
- the outline (the `##` headings);
- the interactive part, if a claim is worth letting the reader test;
- the languages.

Wait for the owner's yes. Then file the issue; its first line after `<!-- agent -->` is
`Asked for by the owner, <date>`, then his answer quoted (the `issues` skill, "Features"). A subagent follows
`AGENTS.md`, "Issues". A post the owner asked for in chat skips the wait, not the proposal: show
it, then go on.

## 2. The brief: four lenses

Read the site's goals in its `AGENTS.md`, `direction.md`, and `profile.md` "How I sell" and "How I
market". They are for understanding only: no number or private detail from `ai-memory` goes into a
public post. Then judge the idea as four people, each asking what the post does for the goals:

- **Search specialist.** One search intent and one main phrase per language. Search the site's
  posts and pages (and `site:<domain> <phrase>`) for one that already answers it; if one does,
  update or link that page instead of writing a rival. Plan two or three internal links.
- **Marketer.** Who exactly the reader is (a founder who might hire the owner, a developer who
  might use a tool, a person who might use the product), the one next step, and the channels where
  that reader already is.
- **Psychologist.** What makes this reader start, keep reading and trust the author, and the doubt
  they will have. The post answers that doubt before they raise it.
- **Brand adviser.** Does it build a theme the owner or the product wants to be known for, so posts
  add up to one body of work? Would the owner be glad to have it found under his name in three
  years? Expertise shows through the work, never through bragging.

The brief ends with a verdict: it serves a goal, or another angle serves it better, which goes back
to the owner in chat. The brief goes into the PR body, and the reviewer checks the draft against
it. For a post that targets a search, the `marketing-seo` and `psychologist` agents read the brief
and the finished draft.

## 3. Outline

Pick the kind and use its shape:

- **Story**: the owner's own experience, real detail, the mistake owned, the lesson.
- **How-to**: the problem, numbered steps, the real code or config, the usual alternative compared.
- **Comparison or question page** ("Alternatives to ShipFast"): a table, every fact about another
  product with its source and date, a fair verdict, and the case where the other one is the better
  pick.
- **Measurement**: the question, the method, the raw numbers, what they do and do not show.
- **Changelog**: what changed for the person using it, grouped by what they do, each item linked to
  its docs; no internal names.

Headings name what the section answers, often as the reader's question, one question per section.
A long post gets a contents list, so give it real headings.

## 4. How a post opens

1. A TL;DR of two to four lines, each one plain claim the reader can act on or remember. Write it
   last, from the finished post; it says nothing the post does not.
2. A first paragraph that answers the post's question on its own, with the main phrase in it
   naturally, so a search snippet or an AI answer can quote it alone.
3. Then what the post is and who it is for. A post about something visible opens with a real
   screenshot right under the TL;DR.

No "Welcome to", no background first, no stacked sales questions ("Are you tired of…?").

Every post has a cover, shown in the post list and on the post page, so each post has a face of
its own: a well-known meme whose joke is the post's point, or an AI-generated picture when an
image model is at hand; never a plain screenshot or a text card. Its captions say only what the
post says (section 6), and its alt text says what the picture shows and quotes any captions. Size, files and tooling:
the repo's publishing doc (antonshubin.com: `docs/publishing.md` and `scripts/blog-cover.sh`).

The body gets pictures with jokes too: about one meme or AI picture per section, each landing a
point the text makes, with alt text that says what the picture shows and carries the joke. Its
captions follow the same rule as the cover's. Real screenshots stay where the text shows the
thing itself.

## 5. Voice

The site's voice guide decides; antonshubin.com `docs/voice.md` is the owner's, learned from his
own posts. A product site speaks as its maker, the same person. In short: "I" for what the owner
did, "you" for the reader, short paragraphs, plain words, self-irony and mistakes owned, opinions
stated. Be fun to read, not only useful: the owner's character is fun while doing tech, so
every post carries jokes, self-irony and playful asides alongside the substance, never a dry
manual. The post closes with a push to act and its one ask, never a summary or "In conclusion".
Keep out the phrases that read as generated: "crucial", "It's important to", "powerful, flexible
and easy to use", filler reassurance, lists where every item says nothing specific.

## 6. Proof and numbers

- No client, number, quote, testimonial, prize, guarantee or result unless the owner gave it as
  fact in this session or the repo holds it as data (the `owner-voice` skill, the site's content rule).
  Missing one → ask, or write the post without it. Never estimate one.
- A measurement states its method, date and versions, and commits its raw data where the site
  supports that. Real statistics and cited sources raise a page's share of AI answers
  ([GEO study][geo]); measurable facts beat "fast" or "next-gen" ([Microsoft][bing]).
- Real code, real screenshots, never mockups.
- Fact-check every generated sentence, and the title, description, alt texts and structured data
  too ([Google, generative AI content][gai]). Say how AI helped where a reader would reasonably
  ask ([Google, helpful content][hc]).

## 7. Interactive components

A component earns its place when it lets the reader test a claim on their own numbers: a
calculator, a slider, a checklist. None for decoration.

- One per claim worth testing. Its default state shows the case the prose describes.
- The prose keeps every claim and number, so search engines, RSS, the newsletter, cross-posts and
  readers without JavaScript lose nothing. The component has a static fallback (usually a table).
- Rendered in full on the server at a fixed size, so nothing shifts when it hydrates; small code;
  labelled controls that work from the keyboard; a stable anchor to link to.
- It never sends, stores or puts in the URL a value the reader typed. Usage analytics count tries,
  not values.
- Built from `preact-components` (search its `llms.txt` first, global "Shared libs before local
  code"). How a post embeds and registers one: the repo's `AGENTS.md`.

## 8. Links

Two or three internal links with text that says where they go: a related post, the product or tool
page, its docs, the offer. Add a link to the new post from one or two older posts on the same
theme. Link every outside fact to its source. Links in channel texts and mail come from the repo's
tagged-link tool, never typed by hand.

## 9. Search and answer-engine checks

Before the PR, check each; the `marketing-seo` agent has the detail and sources.

- Title unique, the phrase early, under about 60 characters; description under about 155 with the
  point first; a short readable slug.
- One H1; headings as questions where natural. A FAQ only for questions readers really ask that a
  heading does not already answer.
- `BlogPosting` JSON-LD with author, dates, image and `inLanguage`, matching the visible text.
- A named author linked to a profile; visible published and updated dates. The updated date moves
  only with a real change ([Google, helpful content][hc]).
- Everything in the server-rendered HTML, in the sitemap and feed; images with alt text, width and
  height; the site's speed budget kept.
- Every answer in visible HTML text: not only in an image, a PDF, or a tab or menu that starts
  closed, which AI systems may not render ([Microsoft][bing]).
- Nothing special for AI answers: Google needs no extra markup or AI file for them
  ([Google, AI features][aif]).

## 10. Languages

Which languages:

- A blog post: the languages the owner picks from the proposal (step 1).
- A question page ("Alternatives to ShipFast" / "Альтернативы ShipFast"): every language the site
  has, each answering one exact question.

How:

- **Written per language, for its searchers.** Find the phrase people actually type in that
  language; it is often not the translation. Adapt the examples, currencies, tools and channels the
  reader knows. Never word for word, and never ship raw machine translation: Google lists many pages that add no value,
  machine-translated ones included, as scaled content abuse ([spam policies][spam]).
- **One set of facts.** Prices, numbers and names match in every language.
- **Reviewed.** The reviewer (an agent) reads each language for wording that reads translated
  and for facts that differ from the source language.
- **One URL per language**, the whole page in that language, navigation included; a visible
  language switcher; no automatic redirect by IP or browser language ([Google, multilingual][ml]).
- **hreflang** on every version, listing itself and every other version that exists, reciprocal,
  plus `x-default`; language codes ISO 639-1, region optional ([Google, hreflang][hl]).
- Channel texts per language: a Russian post gets a Russian Telegram text.

## 11. Publish and the newsletter

PR, reviewer gate (plus the `design-reviewer`, the `design` skill, "Design gate"), merge, deploy, then
the repo's publish task. Typical steps, each in the repo's own tool: check the post answers 200
live; cross-post (Dev.to and the like) with `canonical_url` pointing at the original; ping IndexNow;
send the newsletter. The newsletter goes out once per post (a rerun never mails anyone twice), from
an address a person can answer, with a one-click unsubscribe. Report the sent and failed counts the
tool printed; a non-zero exit is not a success. Reuse the post across the video, newsletter,
LinkedIn and Dev.to rather than writing each from scratch.

## 12. Channel texts

Agents never post to a social network; they write the texts and the owner pastes them. Show them in
chat, one per channel, each with its tagged link:

- an X post, the single most concrete finding first;
- a LinkedIn post, opening with the finding or the mistake;
- a Reddit title and body that stand on their own, with two or three fitting subreddits;
- a Hacker News title, factual, at most 80 characters;
- a post for the owner's Telegram channel, in every set (direction "Marketing").

On Reddit and Hacker News the result is what the reader learns, not what the owner did: both punish
self-promotion. Skip a channel the brief ruled out and say why. Each channel's shape: the site's
voice guide (antonshubin.com `docs/voice.md` "Channel texts").

[geo]: https://arxiv.org/abs/2311.09735
[gai]: https://developers.google.com/search/docs/fundamentals/using-gen-ai-content
[hc]: https://developers.google.com/search/docs/fundamentals/creating-helpful-content
[aif]: https://developers.google.com/search/docs/appearance/ai-features
[bing]: https://about.ads.microsoft.com/en/blog/post/october-2025/optimizing-your-content-for-inclusion-in-ai-search-answers
[spam]: https://developers.google.com/search/docs/essentials/spam-policies
[ml]: https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites
[hl]: https://developers.google.com/search/docs/specialty/international/localized-versions
