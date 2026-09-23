---
name: start-task
description: "How to take on new work that has no GitHub issue yet — a feature, bug, task or idea: understand it, write the spec, design it, file the issue, then implement autonomously unless only the spec, issue or design was asked for. Load whenever asked to start, build, add, fix or plan something that has no issue written down."
invocation: both
argument-hint: "<what to build or fix>"
---

# /start-task $ARGUMENTS

New work goes spec → design → issue → implementation → merged PR. The issue is written before any
code, so the reasoning outlives the session and the reviewer has something to check the PR
against. The global `AGENTS.md` still applies throughout; this skill only orders the steps and says
where to stop.

## 0. Is this new work?

- The request names an issue, a PR or a task file (from the `task-generator` agent), or
  `gh issue list --search "<keywords>"` finds an open issue that covers it → that is the spec. Read
  it, then go to step 5.
- A question, a lookup, or a change small enough to need no design (a typo, a one-line config
  value) → just do it. This flow is for work that ends in a reviewed PR.

## 1. Understand, then ask once

- Bootstrap the repo as `AGENTS.md` describes: repo-local `AGENTS.md`, `README.md`, the manifest.
- Read the code the work touches. For a bug, reproduce it first and keep the reproduction: it
  becomes the evidence and, later, the test.
- Then, before writing the spec, ask me one batch of questions. This is the cheapest moment to
  catch a misunderstanding: a wrong guess here costs the whole spec, design and PR, not one revert.
  - **What to ask:**
    - intent: who it is for, what is in and out of scope, what "done" looks like;
    - technical choices that are expensive to change later and that neither the repo nor the Stack
      section of `AGENTS.md` settles: architecture, the data store (SQLite or Postgres), SPA or
      SSR, infrastructure beyond the standard setup (a new shared service, a queue or object store,
      which server it runs on), a new dependency or external service, a public API or data format.

    Never ask what the code, the docs, the git history or `AGENTS.md` can answer; look it up
    instead.
  - **One message, at most five questions, numbered, each with your recommended answer and its
    main trade-off**, so I can reply "defaults" or change only one. More than five open → ask the
    five most expensive to reverse, and list the defaults you will take for the rest.
  - **Skip the batch** when the request already answers all of this, or when I said "just go" or
    "don't ask".
  - **After my answers, do not ask again**, except in the cases the Autonomy section of
    `AGENTS.md` lists. Take the sensible default for every later judgment call and record it as a
    decision.

## 2. Spec — what and why, never how

- **Problem:** what a person notices today, and who that person is.
- **Goal and non-goals:** what changes, and what deliberately does not.
- **Acceptance criteria:** at most five, each one verifiable by looking. They become the issue's
  **Done when**.

## 3. Design — how, before any code

- **Change surface:** which files, modules, data and interfaces change, and what the new ones are
  called.
- **Options:** option A and option B, one consequence each, the pick and why.
- **Risks:** security, data, migrations, anything irreversible. Something a revert cannot undo is a
  question for me (step 1), not a decision.
- **Test plan:** which behaviours get tests, and how each test will be shown to fail when the code
  breaks.
- **Size:** more than one PR's worth → one issue per PR, in order. A scaffold that every unit needs
  goes first, alone (Subagent orchestration in `AGENTS.md`).

Scale the depth to the work: a small bug gets a sentence or two per heading, not a document.

## 4. File the issue

Create it with `gh issue create`, in the **Issues and reports** shape from `AGENTS.md`:

- **In short** holds the spec.
- **What I suggest** holds the design and the decisions.
- **Done when** holds the acceptance criteria.
- **Evidence** holds the reproduction and the `file:line` pointers.

Scrub secrets before sending (the hard rule). If the repo has no GitHub remote, keep the same text
for the PR body and say so in the report.

## 5. Stop or continue

- The request asked only for a spec, an issue, a design or a plan ("write an issue", "plan it",
  "design it", "don't implement yet") → report the issue URL with a two-line summary, and stop.
- Otherwise, continue straight into implementation. Do not ask whether to proceed.

## 6. Implement

Follow Git Flow from `AGENTS.md`:

1. Create the worktree and a `<type>/<slug>` branch from the latest default branch.
2. Implement, then run the repo's checks and the CI emulation.
3. Push, and open the PR at once with `gh pr create`. The body includes `Closes <issue URL>`, and
   the title keeps a `[WIP]` prefix until the work is done.
4. Volume work (three or more file-disjoint units) → parallel subagents, following the
   orchestration rules.
5. Run the reviewer gate:
   - needs-fix → fix and run it again;
   - failed twice on the same cause → stop, leave the PR open, and report why;
   - green → drop `[WIP]` and merge.
6. After the merge, apply the repo-local post-merge steps, clean up, and run the orphan sweep.

## 7. Report

Keep it to the chat register: the PR URL, what shipped, the decisions taken, and what is left for
me.

## While the skill-state experiment runs

`~/sync/code/ai-memory/experiments/skill-state.md` holds the experiment log. While its status line
says `running`:

- **Before step 1, pick the arm.** This applies only to tasks expected to take ten or more tool
  calls and end in a PR.
  - The request says "with skill-state" or "without skill-state" → that decides.
  - Otherwise, take the opposite of the last row in the log. With no rows yet, take skill-state.
  - The skill-state arm → load the `skill-state` skill and run steps 1–6 through it.
- **After step 7, add one row to the log** for either arm, following the instructions at the top of
  that file.
