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

- Take open issues by priority, `p1-critical` first; no priority label counts as `p3-medium`;
  oldest first within a level. Stop at `p3-medium`: `p4-low` and `p5-someday` are never
  candidates, and a backlog with nothing above them ends the wave. Skip issues labelled `manual`
  or `needs-decision`, issues with an open PR by `spy4x`, and issues another session claimed
  ("Claim an issue" in `AGENTS.md`, "Git Flow"). This lists the candidates oldest first; group
  them by priority label yourself:
  `gh issue list --state open --limit 500 -S 'author:spy4x -label:manual -label:needs-decision -label:in-progress -label:p4-low -label:p5-someday sort:created-asc'`.
- Two limits in `AGENTS.md`, "Picking work yourself", come before priority. The repo has an open
  milestone (listed due first, undated last:
  `gh api --paginate --slurp 'repos/{owner}/{repo}/milestones?state=open' | jq -r 'add | sort_by(.due_on == null, .due_on) | .[] | "\(.due_on) \(.open_issues) \(.title)"'`) → add
  `milestone:"<title>"` to that search and drop `-label:p4-low -label:p5-someday` from it: the
  owner put the issue there, and that outranks its priority label. Run it once more with
  `label:p1-critical` in place of the milestone. Nothing else is a candidate. An issue outside a
  milestone whose body starts with `<!-- agent -->` becomes a lane only when the owner asked for it
  (the `Asked for by the owner` line, a comment of theirs without the marker that says to build it,
  or a priority raised after filing: "Picking work yourself" in `AGENTS.md`), or when step 2 of
  "Filing issues" gives it `p3-medium` or higher. Otherwise set it aside as that rule says, and the
  next issue takes its place.
- Outside authors: an issue or PR not authored by `spy4x` is never a candidate, and an outside PR
  never counts as a lane's PR. Warn the owner about each one ("Outside authors" in `AGENTS.md`):
  `gh pr list --state open --limit 500 -S '-author:spy4x'` and
  `gh issue list --state open --limit 500 -S '-author:spy4x'`.
- Stuck on a decision → comment on the issue in the Issues and reports shape (option A and B, one
  consequence each, your pick), add `needs-decision`, and move on to the next issue. The owner
  answers in a comment and removes the label.
- One session runs one wave. The next wave starts in a new session from the handoff. Never resume
  an old coordinator to run the next wave, write its prompt or answer a small question: resuming it
  rewrites its whole cache. The session ends with its handoff: a new request after it goes to a new
  session, because every turn of a long-running lead re-reads its whole context.

## Before spawning

- **Rules drift.** A running session keeps the rules it started with: Claude Code reads
  `AGENTS.md` when a session starts or compacts, and every subagent gets its lead's copy. Run
  `git -C ~/sync/code/dotfiles log --oneline --since=<wave start> -- ai-harnesses/`. If it prints
  anything, read that diff, follow it, and put the changed rules a subagent needs into its brief.
- **Usage.** Before each batch of agents, run `claude -p /usage`. At 90% of the 5-hour limit or
  95% of the weekly limit, start no new agent: let the running ones finish, post the handoff and
  end the turn. A limit that hits mid-review throws that review away. Never stop for the weekly
  limit below 95%. When the owner tells a session in chat to use the rest of the week, it ignores
  the 95% stop and works up to 100%.
- **Machine health.** Check CPU and RAM, and keep checking while lanes run. Parallel sessions have
  left zombie processes and a RAM leak before. Report anything off (what, which process, how much);
  a separate session fixes the cause.

## Splitting the work

- Lanes must be file-disjoint; that, not size, is the constraint. Start with 3 and scale by
  disjoint directories. One worktree per agent, branch `<type>/<slug>` from the latest `main`: two
  agents in one worktree corrupt each other. Parallelise reads, serialise writes.
- Serial spine first. If every unit needs one scaffold, schema or config, build and merge it alone,
  then fan out. Prove there is no contention by experiment (Deno skips absent workspace members, so
  pre-listed members mean zero shared files).
- A lane whose issue needs reusable code does the library part first. It opens its own worktree
  and PR in the library, and that PR is reviewed, merged and released before the consumer PR
  imports the release. Never brief a lane to write a local copy and file an issue to move it later.
  A library change that two lanes need belongs to the serial spine.
- The brief is all the agent sees. Write it in full sentences: worktree path, read-only sources,
  output paths, house style, the issue, why the lane matters ("Direction" in `AGENTS.md`), and
  what to do when stuck (decide and document, don't stop). It also says whether the lane needs a security review ("Reviewer gate" in `AGENTS.md`),
  and that lane's reviewer brief asks for it. A lane that changes what a person sees carries
  its `design` spec in the brief and gets a `design-reviewer` next to its `reviewer`. The agent
  owns its worktree, temp dirs and processes, and leaves nothing running.
- The brief names the e2e specs the lane runs: those for the screens and routes it changed, never
  the whole suite. CI runs the whole suite, and parallel full runs on one machine time out and get
  rerun.
- One issue per implementer. The next issue goes to a fresh implementer with its own brief, never
  to the agent that built the last one: every step re-reads the agent's whole context, so the old
  issue's history makes every step of the new one cost more.
- A lane whose branch lives longer than a day merges `origin/main` into it once a day, while the
  conflicts are still small.

## Models and effort

- Implementers start at `implementer` (`medium`): don't guess difficulty up front.
- Every implementer lane runs on `opus` (the global `AGENTS.md`, "Implementers and reviewers stay
  on `opus`"), and so do its fix rounds and its reviewers.
- Escalate once. When a PR's second `needs-fix` verdict, whatever the first was about, names a
  behaviour defect (the code does the wrong thing, not a false claim or a failing check),
  and the fix is bigger than the ones you apply yourself, send that one fix round one step up, to a
  fresh agent: `implementer-xhigh`, because effort is the only thing left to raise. Its first six
  rounds (2026-09-25 to 10-01) cost $4 to $29 each, and nothing has yet measured whether `xhigh`
  beats `medium`. The brief is the original brief, every verdict so far, the branch name and the
  PR URL, and says the PR already exists; it reads `git diff origin/main...HEAD`. The three-verdict
  cap then applies as usual. A harness without `implementer-xhigh` uses `implementer`.
- A fix round goes to a fresh `implementer`, not back to the author, when the author's context is
  past about 200K tokens: read the "PEAK CTX" column of its row in
  `deno run -A ~/sync/code/dotfiles/tools/session-cost.ts <your session id>`. Its brief is the
  same as the escalation brief above. When the escalation applies too, `implementer-xhigh` takes
  the round. Reviewers are resumed as usual: their context stays small. Trial until 2026-11-28
  (`~/sync/code/ai-memory/experiments/fresh-lanes.md`).
- Reviewers stay at `medium`: `xhigh` and `max` rounds cost 5–9 times as much and did not cut
  review rounds (2026-09-25..26, `~/sync/code/ai-memory/experiments/model-comparison/`).

## Judging the work

- Read reports, not transcripts. An agent's final report and its verdict file are what you judge.
  Open a transcript only when the report is missing or contradicts the diff. Your reply to an agent
  is a few lines: the verdict and what to change.
- Verify confident claims. The best catches are overclaims ("caught 3 bugs" → 1, "one cast" → 8,
  "check passes" → it doesn't). Demand reproduction.
- Stop a lane's agent (`TaskStop`) as soon as its reviewers pass (the `design-reviewer` too, when
  the lane has one), or once its PR stops: merging is yours, so the implementer's job ends at the
  pass. Any wait it left behind dies with it, and it never takes a second issue. A lane that
  reports "waiting" while `pgrep` shows none of its processes is stuck: tell it to read its
  results.

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

The wave's final report follows "The final report" in `AGENTS.md`. Before writing it, handle
every reviewer's "Not blocking", "Rare cases, not blocking" and "Outside this diff" lines and
anything else the wave noticed by the "Filing issues" rule: verified, given a priority,
deduplicated, grouped and filed by you, never proposed to the owner. Keep the running list in
`.wave<N>/noticed.md`, since your context compacts, and file once, at the end, so one issue can
hold a whole group. A security or data-loss hole does not wait: file it when you learn of it.

The result part also gives the project's position in one line: how much of the plan is done and
what remains before the next milestone, and the wave's total cost
(`deno run -A ~/sync/code/dotfiles/tools/session-cost.ts <session id>`).

The report ends with a chip that starts the next wave in its own session: the background-task
suggestion tool (`spawn_task` in the Claude desktop app), with the next wave's prompt as its prompt
and the position inside it. The owner starts it with one click, so write no prompt file. A harness
without such a tool ends the report with the prompt instead, ready to paste.

The prompt holds only what belongs to that wave: the position, the issues, the lanes and the files
each owns, the acceptance checks, and what not to touch. It never restates a rule from `AGENTS.md`
or this skill, such as model tiers, review limits or cleanup: a copied rule overrides the live one
and goes stale. A pasted prompt that names a model or an effort is stale: ignore those lines.
