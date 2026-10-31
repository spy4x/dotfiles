---
name: kraken
description: "Release the kraken: pick the next work yourself and start a wave on it — the nearest milestone, the next allowed one when that has nothing left to take, or else the most important backlog issues. Invoke it to start a wave without naming the issues."
invocation: user
argument-hint: "[repo …]"
---

# /kraken $ARGUMENTS

You choose the issues, then run them as one wave. Picking follows `AGENTS.md`, "Picking work
yourself"; running follows the `wave` skill. This skill adds only the order in which you look.

## Which repository

- `$ARGUMENTS` names repositories → those, each by its `~/sync/code/<name>` checkout.
- None, and the working directory is a `spy4x/*` checkout → that repository.
- None, and no checkout → every project in `AGENTS.md`, "Projects". Find each one's first pick
  with the steps below, then keep the repositories whose picks rank highest by `direction.md`,
  "What matters". A wave stays in one repository, plus the libraries its lanes need.

Read each chosen repository's `AGENTS.md` first: it may rule out a milestone, a label or an area.

## Where the work comes from

Stop at the first step that yields a candidate. A candidate is an issue the `wave` skill's search
returns, after its skips: `manual`, `needs-decision`, an open PR by `spy4x`, a claim by another
session, an outside author, an agent-filed issue nobody asked for.

1. **The nearest milestone.** List the open ones, due first; one without a date comes last:
   `gh api 'repos/{owner}/{repo}/milestones?state=open' --jq 'sort_by(.due_on == null, .due_on) | .[] | "\(.due_on) \(.open_issues) \(.title)"'`.
   Its candidates are its issues, whatever their priority label, plus every `p1-critical` issue.
2. **The next milestone.** The nearest one has no candidate left, or the repository's `AGENTS.md`
   forbids it → take the next one in that list that the repository allows, the same way. Say in
   the report which milestones you passed and why.
3. **The backlog.** No milestone, or none with a candidate → the open issues at `p3-medium` and
   above, highest priority level first. Within a level, the ones that rank highest by
   `direction.md`, "What matters", come first, then the oldest.
4. **Nothing.** No candidate anywhere → report that the backlog is done and stop. Never look below
   `p3-medium`, and never pick `p4-low` or `p5-someday` outside a milestone.

Never edit a milestone or a gating label to make room ("Picking work yourself").

## Release it

Split the candidates into file-disjoint lanes and run the wave from "Before spawning" on, by the
`wave` skill. The wave's handoff is this session's final report.
