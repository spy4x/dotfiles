---
name: process
description: "Task file -> merged PR. Worktree first, repo checks and CI emulation, deploy verify, reviewer gate, merge on green."
invocation: user
targets: [opencode, dsh]
harness:
  opencode:
    subtask: true
---

# /process $ARGUMENTS

Goal: execute one task file end-to-end. Implementation -> verification -> reviewer gate -> merged PR.

Steps:
1. Read task file (contract). Note What, Relevant files, Reference patterns, DoD.
2. Read referenced PRD + design for context.
3. Read reference pattern files first — match existing style exactly (CQRS layout, Deno idioms, monorepo conventions).
4. Confirm branch: task files start with "0.0 Create branch". If branch absent, create the worktree FIRST, in the sibling worktrees/ dir, with the exact command from AGENTS.md (Git Flow). Never inside the repo.
5. Implement within Relevant files scope. Something outside that scope → take the sensible default and record it in the PR body; ask only in the cases the Autonomy rules in AGENTS.md list.
6. Stack guardrails: Deno + Hono backend, Preact + Signals frontend, Postgres + indexed queries, CQRS separation, money as ints, enums start at 1, no new deps without justification.
7. Verify DoD:
   - Run the task's "tests pass" command.
   - Run the repo's check task (read the manifest for its name) before any commit, then the CI emulation from AGENTS.md.
   - For infra/deploy changes: run the repo's deploy task (see its manifest) + verify service healthy.
8. Commit (Angular Conventional Commits), push, and open the PR right after the first push: `gh pr create --fill`, title prefixed `[WIP]` until done. Body includes `Closes <full issue URL>` if an issue exists, plus every decision you took.
9. Run the reviewer gate (the `reviewer` agent) on the diff. Needs-fix → fix and re-run. Failed twice on the same cause → stop, leave the PR open, report why.
10. Green gate → drop `[WIP]`, merge (`gh pr merge --squash --delete-branch`), do the post-merge cleanup from AGENTS.md, and apply any post-merge steps the repo-local AGENTS.md lists.
11. Report: PR URL, what shipped, decisions taken, the next task in sequence.

Terse chat status is fine; the PR body is read later, so write it in full sentences. Decisions surfaced, not buried.
