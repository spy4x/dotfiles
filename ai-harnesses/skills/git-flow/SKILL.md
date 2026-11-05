---
name: git-flow
description: "Creating a worktree and its env, claiming an issue, the full reviewer gate, merging, branch protection, releases and the cleanup after a merge. Load before you create a worktree, start on an issue, spawn a reviewer or act on its verdict, merge, tag or publish, and right after a merge."
---

# Git Flow

Part of the global rules (`AGENTS.md`, "Git Flow"); they bind as if written there.

## Creating a worktree

```bash
MAIN=$(realpath "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")
WT="$(dirname "$MAIN")/worktrees/$(basename "$MAIN")/<type>/<slug>"
git fetch origin && mkdir -p "$(dirname "$WT")" && git worktree add -b <type>/<slug> "$WT" origin/main
```

Syncthing ignores `worktrees/` (per-machine step: `docs/host-limits.md`,
`system/syncthing-code.stignore`): a synced worktree is broken by construction and burns inotify
watches.

### Env setup

Repos with `.env.age`, from inside the worktree:

```bash
deno run --allow-read --allow-write --allow-run=git ~/sync/code/dotfiles/tools/env-key-copy.ts
deno task env:decrypt
```

It copies the age key from the main checkout without printing it or naming `.age/` on the command
line (a plain `cp` is refused by `permissions.deny`). Idempotent. Repos with `post-checkout` hooks
auto-decrypt once the key is in place (check repo-local `AGENTS.md`).

Never copy a decrypted env file between checkouts or worktrees: decrypt fresh in each.

## Claim an issue

Claim an issue before working on it, so no two agents build it at once: add the `in-progress`
label, push an empty commit, open the PR with `Closes #<n>`, and comment on the issue `Working on
it in <PR link>. My session id is <id>.` (`$CLAUDE_CODE_HOST_SESSION_ID`, else
`$CLAUDE_CODE_SESSION_ID`; a wave's lead posts its own). An issue labelled `in-progress` or claimed
by an open PR is taken; to work next to it, message that session (`SendMessage`). Work dropped →
remove the label.

## Reviewer gate

Every test the diff adds or changes needs its `Mutation:` line in the PR body; a missing one goes
back to the implementer before any reviewer is spent. Whether a change needs a security review is
decided when the work is requested, in its design (`start-task`) or its lane brief (`wave`): it does
when it touches sign-in, sessions, roles or permissions, tenant boundaries, secrets, crypto,
billing, payments, webhooks, uploads, raw SQL, dynamic imports or what a host exposes. The reviewer
brief then says so, and the same reviewer does the security review in the same pass (its step 6);
it is never recommended on to me. `needs-fix` → the fix goes back to the author with the cause the
verdict names, and the same reviewer re-reviews it (`SendMessage`: it keeps its findings, and its
cache lasts an hour); a new PR or a rework of most of the diff → a fresh reviewer. At most three
`needs-fix` verdicts per PR. A wording fix, or one of about ten lines or fewer, you apply yourself
from the first round: show the test red then green, and have the same reviewer confirm. After the
third verdict, do that if about ten lines remain; otherwise leave the PR open with a comment on what
is left, and move on. After a second `needs-fix` that names a behaviour defect, the `wave` skill
says when and how to escalate that fix round. Never count rejections in a summary, PR body or issue.
A PR body or issue says what the review found and what changed. Gate failed, or a revert can't undo
it → leave the PR open and say so.

A reviewer rejects only for a bug, a security or data-loss risk, a false claim, a failing required
check, or code these rules forbid outright (the `reviewer` agent lists which). Its other findings
(another risk, a missing test, a nit, a question) come under **Not blocking** and never block the
PR; neither does a rare case, listed under **Rare cases, not blocking**, nor a finding about code
the diff did not change, listed under **Outside this diff**. The lead files all three lists by the
`issues` skill, "Filing issues", and answers the questions. This bar is a trial from 2026-10-13,
due for review on 2026-10-20; its baseline is in `ai-memory/experiments/reviewer-value/`.

What the `design-reviewer` checks, and how its verdicts count: the `design` skill, "Design gate".

## Merge

One feature → `gh pr merge <n> --repo <owner>/<repo> --squash --delete-branch`; independent
commits → the same with `--rebase`. Always pass `--repo`: without it, gh tries to delete the local
branch, fails while its worktree exists, and skips the remote delete.

The default branch of every public repo with CI is protected, admins included: a merge needs the
Woodpecker pull-request check green, and nothing pushes to it directly or force-pushes. A branch
need not be up to date with it, so a slow pipeline never falls behind; the push pipeline on the
default branch tests each merge. A conflict → merge the default branch in (a merge commit, never a
rebase or force-push). A blocked merge → wait with `timeout 900 gh
pr checks <n> --repo <owner>/<repo> --watch`; red → fix it; still pending after that (a pipeline
waiting for approval) → leave the PR open and say so. Never approve a pipeline: approving runs code
on my server, so that is my action. Never pass `--admin`, and never loosen or lift the protection,
which is mine to change. Whoever adds CI to a public repo protects its default branch the same way
once its first pull-request pipeline has run.

## Releases

Releases are not questions (`AGENTS.md`, "Autonomy"). I build in public and ship often: once the
gate is green, tag, publish to the registry (JSR, npm) and deploy `main` without asking, and say so
in the report. A shared library is the exception. Release it when an app PR that is open now cannot
merge without the change (merge everything that lane needs first, then cut one release), or when the
change closes a security or data-loss hole. Anything else waits for the next such release, or for
one release by the lead as the last step of its wave or session. A subagent never releases.

A release tag points at the merged version-bump commit on the default branch, never at a branch
commit: a registry version cannot be deleted, and a tag build runs the tagged commit's own pipeline
with the publish token.

## After merge

Unless told otherwise:

1. Untracked files in the worktree → `find <path> -delete`; temp files → `shred -u`.
2. `git worktree remove`, then `git branch -D`, then delete the remote branch if `--delete-branch`
   missed it.
3. `git fetch --prune`, `git worktree prune`, `git branch -d` branches merged locally, `find <path>
   -delete` orphan directories, fast-forward the main checkout to `origin/main`, orphan sweep.
