---
name: issues
description: "Which GitHub issues an agent may pick or file, labels, milestones, priorities, and when a feature counts as asked for. Load before you pick work yourself, file, label or comment on an issue, and before the final report of a session that noticed anything outside its task."
---

# Issues

Part of the global rules (`AGENTS.md`, "Issues"); they bind as if written there.

## Picking work yourself

A wave or "work through the backlog" → the `wave` skill. Any open issue at `p3-medium` or above is
yours to take, highest priority first, unless it carries `manual` (work only I can do) or
`needs-decision` (waits on my answer): skip those until I remove the label. Two limits come before
priority:

- A repo with an open milestone → the candidates are the issues in it (several open: the one due
  first; none left to take there → the next, then the backlog), whatever their priority label, plus
  any `p1-critical` issue, plus, in `spy4x/dotfiles`, any `p2-high` tooling or flow fix. Nothing
  else is picked. An issue you file outside it is reported as waiting for me to add it (the library
  exception and dotfiles tooling aside).
- Outside a milestone, an issue whose body starts with `<!-- agent -->` is a candidate only when I
  asked for it or step 2 of "Filing issues" below gives it `p3-medium` or higher. I asked for it
  when its next line is `Asked for by the owner, <date>`, when a comment of mine without the marker
  says to build it, or when its priority was raised after filing (agents never raise one, the
  library exception aside). Any other is not built: it gets `p4-low`, a one-line comment with the
  reason and the label it had, and a line under **Issues** in the report.

Milestones and the labels that gate work are mine. Never create, edit or close a milestone, file an
issue into one, or move an issue in or out. Never raise an issue's priority, and never remove
`p4-low`, `p5-someday`, `manual` or `needs-decision`. Besides setting an issue aside as above, your
only label changes on an existing issue are adding `manual`, `needs-decision` or a missing type
label, and the `in-progress` claim (the `git-flow` skill). Library exception to this paragraph: a
library issue an app needs is built now in the app's wave, or put at `p2-high` in the library's
nearest milestone.

Priority labels, five levels:

- `p1-critical`: urgent tasks and critical bugs.
- `p2-high`: work a project or consumer app needs, and tooling and flow fixes in `spy4x/dotfiles`
  (the tools, skills, hooks and settings agents work with), because better tools get more work
  done.
- `p3-medium`: the default. An issue with no priority label is `p3-medium`.
- `p4-low`: parked. An agent never picks it; I raise it when I want it.
- `p5-someday`: ideas and nice-to-haves. Never picked either.

A backlog with nothing at `p3` or above is done: report it and stop. Never look for work below it.

## Filing issues

This section and "Features" below say what an agent may file without asking. You file issues
yourself; never hand me a list of proposed issues to choose from. Something you notice outside your
task (a bug, a test gap, a reviewer's side note) is a claim, not an issue yet. File only in
`spy4x/*` repositories, and comment only on issues `spy4x` authored; anything about another
repository goes in your report. Before the final report:

1. **Verify.** Find the code and say how it is reached: the ordinary action (something a normal user
   or a consumer app does on a normal day, with normal input), the deliberate attack, or the report.
   Drop what is false or already fixed.
2. **Give it a priority.** Every finding that survived step 1 is filed, grouped as step 4 says,
   because a finding left in a report is lost. Only a finding about a repository outside `spy4x/*`
   stays in the report. The priority says whether a wave builds it:
   - `p3-medium`, or higher only for a security or data-loss hole, the library exception or the
     tooling case below:
     - a security hole that someone other than the data's owner can trigger on purpose, however
       unusual the input;
     - data loss that the ordinary action reaches, or that happens under a condition the code
       exists to survive (a retry, a dropped connection, a crash between two writes);
     - a bug that the ordinary action hits, or that I or a person outside reported (a reviewer, an
       audit or another agent is not a report);
     - a gap that stops a lane running now: name the issue it blocks. It is the smallest change
       that unblocks it. A library gap an app needs: the library exception;
     - a small fix to what a person sees or reads (contrast, spacing, a wording, a wrong doc line).
   - `p2-high`: a tooling or flow fix in `spy4x/dotfiles` that makes agents' work faster or
     cheaper, tooling polish included.
   - `p4-low`, parked until I raise it: everything else that is true, such as a failure that needs
     unusual input, rare timing or two faults at once, a missing test, a refactor or a nicer
     name.

   Name what is at stake, or it is none of the `p3-medium` kinds. A security hole lets someone read
   or change data that is not theirs, act as another user, get in without credentials, run code, or
   take the service down for others. Data loss destroys or corrupts stored data beyond recovery. A
   bug is behaviour that differs from what the code, its docs or its issue say it does; something
   the product never did is a feature. A wrong display, a rejected input or a crash that harms only
   the person who caused it is a bug at most.

   Never add to a `Parked:` issue; the ones that exist stay as they are.
3. **Search the open issues.** One that covers it → file nothing new; comment there only when you
   add a case or a file it does not name. Add to an existing issue in a comment, never by editing
   its body.
4. **Group.** Findings that belong together go in one large issue, never one issue each: I don't
   want hundreds of small ones. An issue is one piece of work for one implementer and one review, in
   the "Issues and reports" shape; items of the same priority that touch the same files or the same
   behaviour share it, and nothing else rides along. It takes that priority. Small fixes are grouped
   by kind: five contrast fixes on five screens are one issue, "fix contrast".

Every issue you file gets a priority label, a type label, and `manual` or `needs-decision` too
when it needs my hands or my answer. Type labels are the usual open-source ones (`bug`,
`enhancement`, `documentation`, `refactoring`…); a type `spy4x/dotfiles` lacks is added there first.
A repo without these labels → create them first, copying names, colours and descriptions from
`spy4x/dotfiles`.

## Features

File a feature, component, export, option, package or integration that makes sense for the product
even if nobody asked for it, at `p4-low` or `p5-someday` and without `manual`: I review new issues
every week and raise or milestone the ones I want. Build one only once it counts as asked for
("Picking work yourself"). When I ask for work in chat, feature or not, the session I asked writes
the issue, and its first lines after the marker are `Asked for by the owner, <date>` and my
sentence, quoted. Never add that line to an existing issue; a subagent never writes it.
