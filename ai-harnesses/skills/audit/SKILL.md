---
name: audit
description: Whole-repo adversarial audit (not PR-scoped) — verifies what previous agents claimed, finds overreach, dead weight and security holes. Report only, no edits.
argument-hint: "[path or package — default: whole repo]"
invocation: user
harness:
  opencode:
    subtask: true
---

# /audit $ARGUMENTS

Goal: an evidence-backed verdict on every unit in scope. You are verifying someone else's work, not
extending it. **No code edits, no PRs, no comments on existing issues.** Default deliverable is the
report. File GitHub issues only when the user asked for them: one per verdict, labelled `audit`,
evidence in the body, plus one index issue — never a fix.

Scope: `$ARGUMENTS`, or the whole repo when empty. A unit = one package / top-level directory.

## 0. Ground truth first

- Read repo `AGENTS.md`, `README.md`, manifest. Note the repo's own scope statement — it is the
  yardstick for "does this belong here".
- Cold run on the default branch:
  `D=$(mktemp -d) && trap 'find "$D" -delete' EXIT && CI=true DENO_DIR=$D deno task check`. Record exit
  code, test count, duration. Red here is finding #1, and everything downstream is read in that light.

## 1. Inventory (cheap, parallel — search subagents on the cheapest model)

Per unit: exported API, source vs test line counts, dependencies added, and **provenance**: which
repo(s) the code came from and who imports it today (`grep` the consumer repos for the package name
and for near-duplicates of its main functions).

The reuse test, applied to every unit: **two or more real consumers, or a stated reason it is
platform-level.** One consumer = project code living in the wrong repo, however clean it is.

## 2. Deep review (parallel reviewer subagents, one per unit, file-disjoint)

Brief each with: repo path (read-only), unit directory, the inventory facts, the repo's scope
statement, global + repo `AGENTS.md` rules that bind it, and the issues/PRs that claim to have
delivered it. Pick each reviewer by the global Reasoning effort rule: units touching auth,
crypto, SSRF/URL policy, SQL, email/DKIM, money or secrets/env tooling get `reviewer-max`, other
code that ships gets `reviewer-xhigh`. A harness without those variants uses `reviewer`.

Each reviewer answers:

1. Does it belong? (reuse test, scope statement, deps policy — "own the small, keep the huge":
   a hand-rolled SMTP/TLS/timezone/XML/crypto implementation is a finding by default)
2. Is it correct? Read the riskiest paths, not the longest files.
3. Are the tests real? Mutation-sample 3–5 behaviours, and report each one I could break with the
   tests still passing. Flag test bulk that asserts nothing (snapshot of constants, tests of the
   mock).
4. Did the closing PR/issue overclaim? Count what it counted.

## 3. Cross-cutting (lead, not delegated)

- Version/pin drift between this repo and its consumers.
- Duplication _between_ units (two validators, two retry helpers, two `cn()`).
- Licensing of anything vendored or ported (icons, fonts, copied snippets). Public + MIT repo with
  unlicensed assets is a 🔴, not a backlog item.
- Open issues and `[WIP]` PRs: still wanted, given the verdicts?

## 4. Report

The report and every issue filed from it are read cold, months later. Use the **Issues and
reports** shape from the global `AGENTS.md`: full sentences, plain words, at most five findings in
the body, evidence in a collapsed `<details>` block. Twelve clipped findings in one issue is not
thoroughness, it is an issue nobody can read.

Open with **In short** — two or three plain sentences on what the audit found and what it means
for the repo. Then the verdict per unit:

```
<unit> — KEEP | FIX | MOVE-OUT (<where>) | DELETE — <one sentence on why>
```

Then **Why it matters**, **What I suggest** (for a decision: option A and option B with one
consequence each, then my pick), and **Done when** (at most five checkboxes).

Evidence goes last, inside `<details>`: consumers found, what I broke and which test still passed,
any claim refuted, and `<file>:L<line>` for each finding, ranked by exploit/loss probability rather
than by count. Describe a test gap as "I broke X and the tests still passed", never as "mutant
survived". Do not infer "unreviewed" from an empty GitHub review record — the reviewer gate runs
before the PR is opened.

Close with what was **not** verified and why. Unverified is never reported as passed.
