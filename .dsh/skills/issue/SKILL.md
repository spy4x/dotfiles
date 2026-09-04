---
name: issue
description: Create GitHub issue with Angular title, labels, milestone, structured body.
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /issue

/issue $ARGUMENTS

Goal: create GitHub issue with Angular title + structured body.

Steps:
1. Parse args: title. If absent, ask.
2. Ask for (one batch): description (problem + repro for bugs, motivation for features), label(s), milestone (list open: gh api repos/<owner>/<repo>/milestones --jq '.[] | {number,title}').
3. Infer labels: bug/feature/enhancement/chore/question/docs based on title signal.
4. Title must follow Angular: type(scope): <summary>, < 72 chars, no period.
5. Body template:
   ## Problem
   <what is broken or missing>
   ## Repro (for bugs)
   1. <step>
   2. <step>
   3. <observed>
   ## Proposed
   <high-level direction, NOT implementation>
   ## Acceptance
   - [ ] <verifiable outcome>
6. Create: gh issue create --title "<angular-title>" --body "<body>" --label "<labels>" --milestone "<name>"
7. Output issue URL. Suggest: @prd-writer if feature, @debugger if bug.

Caveman. No implementation leak in body.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
