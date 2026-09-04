---
name: process
description: Task file -> implementation. Worktree-first, deno task check, deploy verify, WIP PR immediately, do NOT merge.
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /process

/process $ARGUMENTS

Goal: execute one task file end-to-end. Implementation -> verification -> ready for PR.

Steps:
1. Read task file (contract). Note What, Relevant files, Reference patterns, DoD.
2. Read referenced PRD + design for context.
3. Read reference pattern files first — match existing style exactly (CQRS layout, Deno idioms, monorepo conventions).
4. Confirm branch: task files start with "0.0 Create branch". If branch absent, create worktree FIRST per AGENTS.md:
   git worktree add -b <type>/<slug> <type>/<slug> <base>
5. Implement within Relevant files scope. Outside scope = blocker, ask user.
6. Stack guardrails: Deno + Hono backend, Preact + Signals frontend, Postgres + indexed queries, CQRS separation, money as ints, enums start at 1, no new deps without justification.
7. Verify DoD:
   - Run task's "tests pass" command.
   - Run deno task check (lint + fmt + type-check + tests) before any commit.
   - For infra/deploy changes: run deno task deploy <server> [stack] + verify service healthy.
8. Show user: completed work + diff stat + proposed Angular commit message + next task in sequence.
9. Create WIP PR immediately if not yet created for this branch:
   gh pr create --fill --draft (or just gh pr create --fill if user prefers)
   Prefix title with [WIP] until task fully done.
   Body must include Closes #<issue> or Fixes #<issue> if one exists.
10. Do NOT merge. Stop and wait for human. Report PR URL + summary.

Caveman. Decisions surfaced, not buried. Blockers asked, not guessed around.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
