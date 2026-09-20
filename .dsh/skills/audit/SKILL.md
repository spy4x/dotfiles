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
3. Aggregate findings into one report in the Issues and reports shape from AGENTS.md: In short (two or three plain sentences), Why it matters, What I suggest, Done when (at most five checkboxes), then evidence in a collapsed <details> block. At most five findings in the body; smaller ones go in a collapsed list. Group them as Critical (exploit or data loss risk), Architecture drift (CQRS bleed, layer violation, missing lib), Coverage gap (untested critical path), Hygiene (dead code, dead deps, stale config). Each finding says what a person notices, then the cause, then file:line.
4. Rank by exploit/loss probability, not by file count. No praise section. Describe a test gap as "I broke X and the tests still passed", never as "mutant survived".
5. Do NOT edit. Recommend fixes; do not apply.

Full sentences: the report is read cold, months later. Prioritized by risk, not effort.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
