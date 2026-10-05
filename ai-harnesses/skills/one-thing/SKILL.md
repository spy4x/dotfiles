---
name: one-thing
description: "Daily, weekly and monthly planning on The ONE Thing method: compare the previous period's plan with what actually happened (Traggo time, merged PRs, TASKS.md ticks, the three numbers), name the drift plainly, set the next ONE Thing, update TASKS.md and write a journal entry. Load when asked to plan the day, week or month, to review how a period went, or when a scheduled planning run starts."
invocation: both
argument-hint: "day | week | month"
---

# /one-thing $ARGUMENTS

Plan one period and hold Anton to the last one. The mode is `day`, `week` or `month`; with none
given, pick by date: a Sunday → `week`, the 1st of a month → `month`, otherwise `day`. A Sunday
that is also the 1st runs `month`, then `week`.

This routine exists to push. Anton's known pattern (`profile.md`) is choosing work that cannot be
rejected (tooling, research, refactors, strategy) over work that can (proposals, outreach,
publishing, recording). A plan that nobody checks drifts unnoticed for weeks. So every run starts
by comparing what was planned with what happened, numbers first, and only then plans.

## Files

All in `~/sync/code/ai-memory/`:

- `profile.md`, `situation.md`, `TASKS.md`: who, the frozen plan and its targets, the ordered list.
- `planning/README.md`: the Traggo `area` tags and the journal rules. Read it every run.
- `planning/days/YYYY-MM-DD.md`, `planning/weeks/YYYY-Www.md` (the ISO week being planned, so a Sunday run names next week),
  `planning/months/YYYY-MM.md`: one journal entry per run.

Read the latest entry of the same mode and the current entry of the next larger period (a day
reads its week, a week reads its month, a month reads `situation.md`). No previous entry → say
so once and plan from `TASKS.md`.

**Previous chat.** The journal is the record. Agreements made in chat after an entry was written
belong in its `## Amended` section. When the harness can search past sessions (in the Claude
desktop app, `search_session_transcripts`), search for the previous planning run and read what was
agreed after its entry; copy anything missing into that entry's `## Amended` before reviewing it.

## Evidence of what happened

Collect all four before judging. A source that fails is named in the review, never guessed.

1. **Tracked time.** `deno run --allow-run=ssh ~/sync/code/dotfiles/ai-harnesses/skills/one-thing/traggo.ts <from> <to>`
   prints hours per `area`, per day, and the paid/product/video split against the 60/25/15 rule.
   It reads the homelab database read-only over `ssh homelab`. A working day with no entries is a
   finding in itself: the analysis is blind there.
2. **What shipped.** `gh search prs --owner spy4x --merged --merged-at <from>..<to> --json
   repository,title,url --limit 1000`. GitHub search returns at most 1,000 results, and a
   week has passed 500: a count of exactly 1,000 means split the range. Group by repository; note which groups are tooling
   (dotfiles, ai-memory, rostok, homelab, experiments) and which earn or publish. Most PRs are
   agent output on spare quota, so their count is not Anton's hours: judge his time by Traggo and the
   numbers, and use PRs to see where his attention went.
3. **What was ticked.** `git -C ~/sync/code/ai-memory log --since=<from> --until=<to+1> -p --
   TASKS.md`, plus `git diff -- TASKS.md` for uncommitted ticks.
4. **The three numbers**: outreach sent, calls held, dollars invoiced. No system holds them; ask
   Anton. In an unattended run with no answer, write `not reported`. Never estimate them.

## The method

_The ONE Thing_ (Gary Keller and Jay Papasan, 2013) is practitioner advice, not research. What
this skill takes from it:

- **The focusing question.** "What's the ONE Thing I can do such that by doing it everything else
  will be easier or unnecessary?" Ask it of every period, and answer with one sentence that has a
  visible done-when.
- **Goal setting to the now.** Someday (`profile.md` Goals) → this year and this quarter
  (`situation.md`) → this month → this week → today → right now. Each ONE Thing must serve the one
  above it; say which.
- **Time blocking.** The ONE Thing gets a protected block, ideally four hours, early in the day,
  before mail and chat. Time off is blocked first; the planning time itself is blocked.
- **80/20 until one.** Of the open tasks, take the vital 20%, then the vital 20% of those, until
  one remains.
- **Saying no** and the four thieves: not saying no, fear of chaos, poor health habits, and an
  environment that does not support the goal. Name the one that showed up.
- **Accountability.** Results are compared with the plan without excuses: one cause, one change.

Added from elsewhere, with their strength:

- **If-then plans** (implementation intentions; Gollwitzer and Sheeran's 2006 meta-analysis found
  a medium-to-large effect on reaching goals): proven. Every plan carries one for its likeliest
  obstacle.
- **The planning fallacy** (Buehler, Griffin and Ross, 1994: people underestimate their own task
  times): proven. Estimates get 1.5 times the first guess: a rule of thumb, not the paper's finding.
- **Lead and lag measures** (_The 4 Disciplines of Execution_): practitioner consensus. Proposals
  sent and calls held are lead measures Anton controls; dollars invoiced is the lag measure.
- **The weekly review** (David Allen's GTD: get clear, get current, get creative): practitioner
  consensus.

## How to push

- Open with the review, in this order: the planned ONE Thing and whether it happened; hours by
  area; what shipped; the three numbers. Then the finding, in one or two blunt sentences.
- Name avoidance by its content: "You planned ten proposals and shipped four dotfiles PRs instead;
  zero proposals are recorded." Then ask one question: what blocked it.
- `tooling` hours above `sales` plus `client` hours on a working day, or a skipped ONE Thing while
  other work shipped, is drift. Say so every time; do not soften it after the first.
- The same ONE Thing skipped twice in a row is too big or feared. Cut it to a first step of 25
  minutes or less and give it a fixed start time as an if-then.
- No praise, no therapy tone, no reassurance. A good period gets one plain line that it went to
  plan.
- No new strategy. `situation.md` is frozen until its review date. A suggestion to change tools,
  rewrite the plan or start a new repository is answered with that rule and the current ONE Thing.
- Unattended (scheduled) run with a phone-notification tool available (`PushNotification` in the
  Claude desktop app): send one line, today's ONE Thing, and say so if the previous one was skipped.

## Mode: day

Review range: the previous day entry's date through yesterday.

1. Review that range from the evidence.
2. Today's ONE Thing: the focusing question applied to the week's ONE Thing and the first unticked
   `TASKS.md` items dated today or earlier.
3. The plan, nothing more than this: the fixed morning block `TASKS.md` currently prescribes (the
   proposals block, while it says so), then the ONE Thing block with a start and end time, then at
   most three other must-dos. Everything else waits.
4. One if-then for the likeliest obstacle.
5. Remind Anton to run the Traggo timer with an `area` tag for each block.

## Mode: week

Run on Sunday. Review range: Monday through Sunday of the closing week.

1. Review the week: last week's ONE Thing, each day entry's result, Traggo totals against
   60/25/15, what shipped, and the three numbers. Record the numbers on the week's "Sunday numbers"
   line in `TASKS.md`.
2. Every overdue unticked `TASKS.md` item gets one of three answers: this week, a new date, or
   dropped. Anton decides; in an unattended run, propose and leave the decision in the entry.
3. Next week's ONE Thing, serving the month's. Its time blocks by day, time off first, and next
   Sunday's planning hour.
4. When a CalDAV tool is available and Anton agrees in the session, put the ONE Thing blocks in
   his calendar.

## Mode: month

Run on the 1st. Review range: the whole previous month.

1. Review the month: last month's ONE Thing, the week entries, Traggo totals by area and against
   60/25/15, what shipped, and the numbers against the targets and dates in `situation.md`.
2. This month's ONE Thing, one measurable sentence that serves the quarter in `situation.md`.
3. Check this month's `TASKS.md` items still fit it, in order. Point out what does not; changing
   what a task is goes through a pull request, as `ai-memory/README.md` says.

## Writing

Write the entry with this shape:

```markdown
# <Day|Week|Month> <date, ISO week or month>

## Review of <range>

- Planned ONE Thing: <text> → done | partly | not done
- Time: <hours by area>; paid/product/video <x>/<y>/<z>% against 60/25/15
- Shipped: <grouped PR links>
- Numbers: outreach <n> · calls <n> · invoiced $<n>
- Finding: <one or two blunt sentences>

## ONE Thing

<one sentence> Done when: <what Anton or anyone can see>. Serves: <the larger ONE Thing>.

## Plan

- <time block> <what> (<area tag>)

## If-then

- If <obstacle>, then <action>.

## Amended
```

Then update `TASKS.md`: tick items the evidence shows are done, editing that line to say what
shipped and when, and in the weekly run write the numbers on the "Sunday numbers" line. Daily runs
only tick. New dates or a new order come only from the weekly and monthly runs, with Anton's
agreement in the session.

Commit straight to `main` in `~/sync/code/ai-memory`, as its README allows for journal entries,
ticks and the Sunday numbers. Commit only named paths, `git commit -m <subject> -- <paths>`, so
nothing Anton staged rides along: the entry always, and `TASKS.md` only when it had no uncommitted
changes before this run (otherwise leave it for him and say so). Subject `docs(planning): <mode> <date>`. New dates or order go through a pull request
in that repo instead, from a worktree, as its README requires. Push; a failed push is reported, not
retried in a loop.

End with the entry's ONE Thing and its first block, in two lines.
