---
name: implementer-xhigh
description: The implementer at xhigh effort, with the same procedure. Use only for one fix round, when a PR's second needs-fix verdict names a behaviour defect (the code does the wrong thing). Every other task goes to implementer.
mode: subagent
tier: strong
effort: xhigh
targets: [claude]
body-from: implementer
harness:
  claude:
    color: blue
    # Splitting work is the lead's job; a second agent in this worktree can corrupt it.
    # The app's task list and wrap-up belong to the lead's conversation; a subagent's call is
    # refused and costs a turn.
    disallowedTools: [Agent, mcp__ccd_turn__update_plan, mcp__ccd_turn__wrap_up]
    # A review round often takes more than five minutes; a 1-hour cache keeps the fix from
    # rewriting the whole context.
    experimental:
      cacheTtl: 1h
---
