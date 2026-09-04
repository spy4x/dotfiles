---
name: commit
description: Stage + commit with Angular format. Runs deno task check, scans for secrets, confirms before commit.
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /commit

/commit $ARGUMENTS

Goal: stage + commit with Angular convention. Never commit secrets.

Steps:
1. git status + git diff --stat. Show what will be committed.
2. Pre-commit checks (ALL must pass, else stop):
   - deno task check passes (lint + fmt + type-check + tests)
   - No secrets staged: scan for .env, *.key, age/key.txt, passwords, tokens, API keys
   - Branch not main/master (per AGENTS.md worktree rule)
   - Angular commit format: <type>(<scope>): <subject>, < 50 chars, no period, imperative
3. If type/scope/subject not given in args, infer from diff (feat=code, fix=patch, refactor=restructure, chore=tooling, docs=docs only, perf=perf, ci=CI).
4. Show user: files staged, proposed commit message, secret scan result. Confirm before commit.
5. After commit: git log --oneline -3, show next step (push + /pr, or local-only if user prefers).

Caveman. Secrets check is mandatory, not optional.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
