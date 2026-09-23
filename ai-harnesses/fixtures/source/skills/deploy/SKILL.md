---
name: deploy
description: "Deploy the current branch: build, push, verify."
invocation: user
targets: [claude, opencode, dsh]
harness:
  opencode:
    subtask: true
    agent: devops
---

# /deploy $ARGUMENTS

Build, push and verify.
