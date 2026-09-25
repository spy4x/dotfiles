---
name: reviewer-max
description: The reviewer at max effort, with the same procedure. Use for auth, crypto, secrets, money, deploys, and anything that deletes or migrates data.
mode: subagent
tier: strong
effort: max
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
