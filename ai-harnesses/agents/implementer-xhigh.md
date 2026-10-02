---
name: implementer-xhigh
description: The implementer at xhigh effort, with the same procedure. Use only for one fix round on a lane that already ran on Opus, when a PR's second needs-fix verdict names a behaviour defect (the code does the wrong thing). A Sonnet lane escalates to implementer on opus instead; every other task goes to implementer.
mode: subagent
tier: strong
effort: xhigh
targets: [claude]
body-from: implementer
harness:
  claude:
    color: blue
    # Splitting work is the lead's job; a second agent in this worktree can corrupt it.
    disallowedTools: [Agent]
    # A review round often takes more than five minutes; a 1-hour cache keeps the fix from
    # rewriting the whole context.
    experimental:
      cacheTtl: 1h
---
