---
name: implementer-xhigh
description: The implementer at xhigh effort, with the same procedure. Use only for one fix round, when a PR's second needs-fix verdict names a behaviour defect (the code does the wrong thing); every other task goes to implementer.
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
