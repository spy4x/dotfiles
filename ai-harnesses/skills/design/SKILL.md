---
name: design
description: "How to design UI before building it: expert roles in parallel, one merged spec with wireframes, a screenshot-and-revise loop, and a design gate. Load before any new screen, page, flow or redesign in any app, SPA, admin panel or website, and whenever asked to make a UI look or work better."
invocation: both
argument-hint: "<screen, page or flow>"
---

# /design $ARGUMENTS

The global `AGENTS.md` section "Design" says when this runs and which roles take part. This skill
says how. The output is a spec good enough that an implementer who never saw this conversation
builds the right thing on the first try.

## 1. Ground truth first

- Read the app's `AGENTS.md`, its `docs/design/` (create `docs/design/brief.md` if missing: who the
  app is for, its job, its voice, its brand hue, and three reference products whose quality bar it
  aims at), and preact-components `docs/design-language.md`, the house style every app shares.
- Capture what exists: run the app and screenshot the affected screens with Playwright at 390 and
  1440 px, light and dark. A screen that does not exist yet is reviewed as its nearest neighbour
  plus the plan. Close the browser and server in a `finally`.
- Write one shared brief for the roles: the job of the screen (what a person must understand, then
  do), the audience, the constraints (house style, content rule: no invented claim, number or
  quote), the screenshots, and the reference products.

## 2. Roles in parallel, no code

Spawn each role from "Design" in `AGENTS.md` as its own agent, in one message, with the shared
brief. Each returns at most ten recommendations, most important first, each with its reason and
what a person notices. A role with nothing important to add says so in one line.

## 3. One merged spec, by the lead

- Wireframes at 390 and 1440 px (ASCII or SVG), every state: empty, loading, error, success, long
  content, no permission.
- The component list: which `preact-components` pieces, and which new ones the library needs first
  ("Library first" in `AGENTS.md`). A pattern the house design language lacks is added to
  `docs/design-language.md` in the same library PR.
- The final copy for every string, from `ux-writer`.
- A table: each recommendation, and what it became or why it was dropped. Where roles disagree, the
  lead decides and says why. A sensible default wins; the spec does not wait for the owner.
- Post the spec on the issue before any code.

## 4. Build, look, revise

The implementer builds from the spec, then screenshots every changed screen at 390 and 1440 px,
light and dark, and critiques them against the spec and the house style: alignment, rhythm,
hierarchy, contrast, truncation, focus order, what a first-time user sees first. Revise and look
again, at least twice, before opening the PR. The PR traces each adopted recommendation to its role
(designer 3, writer 1, …) and attaches the final screenshots.

## 5. Design gate

Brief a `design-reviewer` next to the `reviewer`: the worktree, how to run the app, the spec, and
the screens to check. Its blocking bar is in "Design" in `AGENTS.md`.

## Quality bar

A screen passes when all of these hold:

- A first-time user names its job and finds its primary action within five seconds.
- One primary action; rare and destructive actions sit in a menu or behind a confirmation.
- Every state is designed; no raw error text, no blank first run.
- Nothing overflows at 390 px; nothing floats in empty space at 1440 px.
- axe-core finds no violation in light or dark; every control works from the keyboard.
- It looks like the other apps' screens, with this app's brand.
