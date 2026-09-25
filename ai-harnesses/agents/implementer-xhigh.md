---
name: implementer-xhigh
description: The implementer at xhigh effort, with the same procedure. Use only for the fix round after a PR's second needs-fix for a behaviour defect; every other task goes to implementer.
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
---
