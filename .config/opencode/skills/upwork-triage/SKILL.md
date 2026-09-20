---
name: upwork-triage
description: Judge a pasted Upwork job post and draft the opening of a proposal — a yes/no verdict, the reason in two lines, and a cover letter of two or three short sentences. Load whenever a job post, job listing or client brief is pasted for a go/no-go call. Never submits anything.
license: MIT
compatibility: opencode
---

# Upwork triage

Read a pasted job post, decide whether it is worth a proposal, and draft the opening lines. You
never open Upwork, never submit a proposal and never send a message. The output is text for Anton
to paste himself.

## Filter

The only place these numbers live. Tune them here when real results say so — nothing below repeats
a value.

| Check          | Value                                                                                                                                 | Kind |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Payment        | verified                                                                                                                              | hard |
| Stack fit      | any TypeScript stack (React, Next.js, Node, NestJS, Svelte, Angular, Deno, PostgreSQL, Firebase, AWS, GCP) **or** AI integration work | hard |
| Hire rate      | above 50%                                                                                                                             | soft |
| Client average | $35/hr or more                                                                                                                        | soft |
| Competition    | under 20 proposals **or** posted under three hours ago — either one passes                                                            | soft |

**Hard** means a miss is a no, on its own. **Soft** means a miss is a no unless something else in
the post clearly outweighs it; say what outweighed it in the reason.

Missing data is not a failed check. A post that hides the client average, or a client with no hire
history yet, is neutral: judge on what is there and name the gap in the reason. Payment verified is
the exception — if the post does not say it is verified, treat it as not verified.

The client average is an hourly figure, so it only decides anything when the post shows one. On a
fixed-price job, read the budget against the scope instead: a budget that works out to less per
hour than the client average row asks for, over the work described, fails that same row.

## Verdict

Answer in this shape, nothing before it:

```
Verdict: yes
<one line: what decides it>
<one line: what is still unknown or weak about it>
```

```
Verdict: no
<one line: the most serious reason it is a no>
<one line: the next reason, or what the post has going for it anyway>
<one line: what would flip it>
```

Short sentences, one per line, no bullet list and nothing else inside the block.

On a no, the second line matters most when only one check failed: say what the post has going for
it, so a near miss reads as a near miss rather than as a rejection. The third line names the thing
that would change the answer — a rate, a reply from the client, a missing detail worth asking
for. When nothing would flip it short of a different job, that line says so in one clause.

On a **yes**, the cover letter follows.

## Cover letter

Two or three short sentences, in a plain-text code block so it pastes cleanly.

- **Sentence one** — one concrete observation about _their_ project. Name the thing they are
  building and the part that is actually hard. This proves the post was read.
- **Sentence two** — one past result that matches that hard part. One. Not a list.
- **Sentence three, optional** — on a fixed-price job, the one question whose answer decides
  the price. On hourly or open-ended work, offer the small first milestone from `profile.md`
  instead, in its own words, when the post reads as open-ended enough to need de-risking. Drop the
  sentence when neither is sharp.

The first two sentences are the hook: Upwork shows about two lines in the list before the client
clicks. Keep them to roughly 200 characters together, and make them carry the whole pitch on their
own.

Voice: friendly, specific, plain words — the person the reviews describe, collaborative and
plain-spoken. No emojis. No "I am excited to", no "I have extensive experience in", no restating
their job post back at them, no adjectives doing a verb's job.

## Proof

Past results come from `~/sync/code/ai-memory/profile.md`, section "Proof I can show", or from
facts Anton stated in this session. Nothing else.

Never write a client name, number, prize, testimonial, guarantee or case study that is not in one
of those two places. An agent has invented proof here before, and it took months to find and
remove.

When no past result matches exactly, reach for the nearest real one and write the sentence without
a number rather than stretching the claim. When nothing in the list is even adjacent, drop the
proof sentence, make sentence two the question instead, and say in the verdict's second line that
this post has no proof to match it — that is what that line is for.

The five promises in `profile.md` are the only commitments that may appear in a letter, and at
most one of them, only where it answers something in the post.

## Tuning

When Anton reports what a proposal did — hired, replied, ignored — say which row of the filter it
argues with and what to change it to. Change the table, nothing else.
