---
name: pr
description: Push branch + create PR via gh CLI. WIP prefix if incomplete, Closes #N mandatory, never merge.
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /pr

/pr $ARGUMENTS

Goal: push branch, create GitHub PR, never merge. Wait for human.

Steps:
1. Confirm context: current branch exists, not main/master/stage, has commits ahead of base.
2. Sync with base: git fetch origin <base>; git merge origin/<base> --no-edit. Resolve conflicts if any (stop and ask user).
3. Pre-push checks:
   - deno task check passes on merged result
   - No secrets in staged/committed files (scan diff)
   - Branch name follows Angular: <type>/<slug>
4. Push: git push -u origin <branch>
5. Create PR via gh CLI:
   - Title: Angular commit summary (no period, < 72 chars). If task incomplete, prefix [WIP].
   - Body: gh pr create --fill --base <base> (or --body "..." if custom needed).
   - MUST include: Closes #<issue> or Fixes #<issue> if linked issue exists. Issue links must be full URLs per AGENTS.md.
   - If draft preferred: add --draft.
6. Output PR URL. Confirm with user if ready to remove [WIP] or merge.
7. Do NOT merge. Stop and wait for human review per AGENTS.md merge protocol.

Caveman. Closes #N link mandatory when issue exists. Never merge yourself.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
