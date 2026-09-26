---
name: wave
description: "How a lead runs a wave: parallel subagents on a fixed list of GitHub issues, one worktree each, reviewed and merged, ending with a handoff for the next wave. Load before spawning parallel implementers, and whenever asked to run a wave, work through the backlog, or resume or hand off a wave."
invocation: both
argument-hint: "[issues or wave prompt]"
---

# /wave $ARGUMENTS

A wave is one coordinator session: a fixed list of issues, its subagents, and a handoff at the end.
You brief, review and integrate; implementers implement. The global `AGENTS.md` still applies in
full, including the reviewer loop in its Git Flow section; this skill adds what only a lead needs.

## Picking the work

- Take only open issues labelled `ready`. The owner applies that label; never add it yourself.
- Stuck on a decision → comment on the issue in the Issues and reports shape (option A and B, one
  consequence each, your pick), add `needs-decision`, and move on to other `ready` work. The owner
  answers in a comment and removes the label.
- One session runs one wave. The next wave starts in a new session from the handoff. Never resume
  an old coordinator to run the next wave, write its prompt or answer a small question: resuming it
  rewrites its whole cache.

## Before each spawn

- **Rules drift.** A running session keeps the rules it started with: Claude Code reads
  `AGENTS.md` when a session starts or compacts, and every subagent gets its lead's copy. Run
  `git -C ~/sync/code/dotfiles log --oneline --since=<wave start> -- ai-harnesses/`. If it prints
  anything, read that diff, follow it, and put the changed rules a subagent needs into its brief.
- **Usage.** Run `claude -p /usage`. At 90% of the 5-hour limit, start no new agent: let the
  running ones finish, post the handoff and end the turn. A limit that hits mid-review throws that
  review away.
- **Machine health.** Check CPU and RAM. Parallel sessions have left zombie processes and a RAM
  leak before. Report anything off (what, which process, how much); a separate session fixes the
  cause.

## Splitting the work

- Lanes must be file-disjoint; that, not size, is the constraint. Start with 3 and scale by
  disjoint directories. One worktree per agent, branch `<type>/<slug>` from the latest `main`: two
  agents in one worktree corrupt each other. Parallelise reads, serialise writes.
- Serial spine first. If every unit needs one scaffold, schema or config, build and merge it alone,
  then fan out. Prove there is no contention by experiment (Deno skips absent workspace members, so
  pre-listed members mean zero shared files).
- The brief is all the agent sees. Write it in full sentences: worktree path, read-only sources,
  output paths, house style, the issue, and what to do when stuck (decide and document, don't
  stop). The agent owns its worktree, temp dirs and processes, and leaves nothing running.

## Models and effort

- Implementers start at `implementer` (`medium`): don't guess difficulty up front.
- Escalate once. When a PR's second `needs-fix` verdict, whatever the first was about, names a
  behaviour defect (the code does the wrong thing, not a missing test, a false claim or wording),
  and the fix is bigger than the ones you apply yourself, send that one fix round to a fresh
  `implementer-xhigh`. Its brief is the original brief, every verdict so far, the branch name and
  the PR URL, and says the PR already exists; it reads `git diff origin/main...HEAD`. The
  three-verdict cap then applies as usual. A harness without the variant keeps `implementer`.
- Effort belongs to the agent type, not the call. `xhigh` and `max` reviewers cost 5–9 times a
  `medium` round and did not cut review rounds (2026-09-25..26,
  `~/sync/code/ai-memory/experiments/model-comparison/`).

## Judging the work

- Read reports, not transcripts. An agent's final report and its verdict file are what you judge.
  Open a transcript only when the report is missing or contradicts the diff. Your reply to an agent
  is a few lines: the verdict and what to change.
- Verify confident claims. The best catches are overclaims ("caught 3 bugs" → 1, "one cast" → 8,
  "check passes" → it doesn't). Demand reproduction.
- Stop a lane's agent (`TaskStop`) once its PR merges or stops, so any wait it left behind dies
  with it. A lane that reports "waiting" while `pgrep` shows none of its processes is stuck: tell it
  to read its results.

## Wave files

Briefs, rules files, verdicts and anything you need after a restart live in
`worktrees/<repo>/.wave<N>/`, never in `/tmp` or the session scratchpad: a reboot empties `/tmp`,
and one agent's cleanup can empty the shared scratchpad. Agents never delete a `.wave<N>` directory;
the lead deletes it once the handoff is posted.

## Usage limits

A usage limit pauses a wave; it does not end it, so don't wrap up or ask the owner. Nothing is sure
to restart it: background agents fail at the limit, and a weekly limit resets days later. When the
session runs again, first resume every agent that failed with `SendMessage`. Its conversation
survives a reboot; its `/tmp` files do not.

## The handoff

The wave's final report ends with:

- the project's position: the plan, how much is done, what remains before the next milestone;
- what the next wave must not touch: open PRs, issues waiting on the owner;
- the next wave's prompt, ready to paste, with the position inside it, also saved as
  `.wave<N+1>/prompt.md`;
- what this wave cost: each agent's dollars, peak context and compactions
  (`deno run -A ~/sync/code/dotfiles/tools/session-cost.ts <session id>`).

The prompt holds only what belongs to that wave: the position, the issues, the lanes and the files
each owns, the acceptance checks, and what not to touch. It never restates a rule from `AGENTS.md`
or this skill, such as model tiers, review limits or cleanup: a copied rule overrides the live one
and goes stale. A pasted prompt that names a model or an effort is stale: ignore those lines.
