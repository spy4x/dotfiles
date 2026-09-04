---
name: issues
description: List + manage GitHub issues. Grouped by milestone, prioritized by stuck-likely.
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /issues

/issues $ARGUMENTS

Goal: list + manage GitHub issues. Prioritized view.

Steps:
1. Fetch: gh issue list --state open --json number,title,labels,milestone,assignees,createdAt,updatedAt
2. Group: by milestone, then by priority label (P0/P1/P2, or critical/high/medium/low). Unassigned first.
3. Display:
   ## <milestone name>
   - [#<n>](<url>) <title> — @assignee, <label>, <updated-relative>
   Sort: oldest unassigned first (likely stuck).
4. Ask user action: view, assign, label, close, link to PR, comment. Do one at a time.
5. For each action, confirm before executing (especially close).

Caveman. Prioritized by stuck-likely, not arbitrary.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
