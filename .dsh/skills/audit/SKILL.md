---
name: audit
description: Full-system audit. Parallel security + reviewer + qa + devops scans. Ranked by exploit probability.
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /audit

/audit $ARGUMENTS

Goal: full system audit (not PR-scoped). Find security holes, architecture drift, dead code, missing tests.

Steps:
1. Define scope: whole repo, specific service, specific subsystem. Default: whole repo.
2. Spawn parallel sub-agents via Task tool (independent workstreams):
   - security agent: secrets scan, authz/authn review, tenant isolation, crypto, deps CVEs
   - reviewer agent: architecture drift, dead code, duplication, CQRS violations
   - qa agent: test coverage gaps, flaky tests, missing e2e
   - devops agent: deploy safety, secret rotation, backup integrity, monitoring gaps
3. Aggregate findings into single report:
   Critical (exploit or data loss risk): <finding, file:line, fix priority>
   Architecture drift (CQRS bleed, layer violation, missing lib): <finding>
   Coverage gap (untested critical path): <finding>
   Hygiene (dead code, dead deps, stale config): <finding>
   Looks good: <positive obs, max 3 lines>
4. Rank by exploit/loss probability, not by file count. Output executive summary first (3 lines max).
5. Do NOT edit. Recommend fixes; do not apply.

Caveman. Prioritized by risk, not effort.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
