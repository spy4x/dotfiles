---
name: reviewer-xhigh
description: The reviewer at xhigh effort, with the same procedure. Use for production code that ships to users or a registry.
mode: subagent
tier: strong
effort: xhigh
temperature: 0.1
tools: [read, search, shell]
targets: [claude]
body-from: reviewer
harness:
  claude:
    color: red
    experimental:
      cacheTtl: 1h
---
