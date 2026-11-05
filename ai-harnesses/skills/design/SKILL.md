---
name: design
description: "The owner's UI rules and how to design UI before building it: the quality bar, one house style, expert roles in parallel, one merged spec with wireframes, a screenshot-and-revise loop, and the design gate with its Lighthouse budget. Load before any new screen, page, flow or redesign in any app, SPA, admin panel or website, before you build, change or review anything a person sees, and whenever asked to make a UI look or work better."
invocation: both
argument-hint: "<screen, page or flow>"
---

# /design $ARGUMENTS

Part of the global rules (`AGENTS.md`, "Design"); they bind as if written there. "The rules" below
says when the design phase runs and which roles take part; the numbered steps say how. The output
is a spec good enough that an implementer who never saw this conversation builds the right thing on
the first try.

## The rules

UI is designed, not just built. Every screen, page or flow a person uses ships to the bar of a
well-funded product team, from the first PR: a clear job, one primary action, real content, every
state drawn (empty, loading, error, success, long text, 390 px), and the taste of the house design
language. "It works" is not done; "a person gets it in five seconds and it looks made with care" is.
I work from the keyboard, so my apps must excel at it: a hotkey or palette command per action, Tab
order that follows the screen, visible focus. Search matches aliases on every entry and action, any
word order, prefixes, a typo, Cyrillic or Latin ("GosUslugi" → "ГосУслуги") and the wrong layout.

**One house style, a brand per app or site.** UI comes in two kinds, an app (every SPA, the admin
panel included) and a website, and every one looks made by the same person: the same type scale,
spacing, radius, motion, density, shell, page header and component choices, all from
`preact-components`. An app varies only its brand hue, content and navigation items, and takes its
whole shell from the library. antonshubin.com uses the app rail's labels variant. A website varies
only what `preact-components` `docs/design-language.md` lists. A screen that needs a pattern the
language lacks adds it there first, as a library change, never as a one-app variant.

**The design phase.** New UI, a new screen or page, a redesign, or a change to what a person must
understand or decide → this skill before any code. It runs these roles in parallel, then the lead
merges one spec:

- `product-designer`: layout, hierarchy, interaction, states, accessibility, against the house
  design language.
- `product-lead`: the CEO lens. Why build it, for whom, what to cut, the one number it should move,
  the business and legal risk.
- `ux-writer`: every word on the screen: labels, errors, empty states, microcopy, in the app's
  voice.
- `psychologist`: trust, cognitive load, motivation; ethical persuasion only.
- `marketing-seo`: pages a visitor uses to decide (public pages, pricing, onboarding, sign-up), with
  a search lens, an answer-engine lens (being quoted by AI assistants) and a conversion lens.

A small change to an existing screen (one element, a wording, a bug with a visible symptom) runs
`product-designer` alone. A fix with no visible change skips the phase. The spec, with wireframes at
390 and 1440 px, goes in the issue; the implementer builds it, screenshots it and revises it against
the spec at least twice before opening the PR.

**Design gate.** A diff that changes what a person sees gets a `design-reviewer` next to the
`reviewer`, in the same round. It checks the built screens in a browser against the spec and the
house design language, at 390 and 1440 px, in every theme the app or site has, with axe-core and the
keyboard, and walks the main task as a first-time user. On a public page it also compares speed and
SEO with `main`. Public pages score at least 95 for performance and 100 for the rest in Lighthouse
mobile, checked in CI. It blocks only for a departure from the approved spec, the design language or
a sibling's shell and patterns (the product beside its admin, a site beside my other sites), an
accessibility failure, a broken layout, a task a first-time user cannot finish, or a public page
made slower or harder to find; taste nits come under **Not blocking**. The PR merges only when both
reviewers pass, and both reviewers' `needs-fix` verdicts count toward the gate's three per PR.

## 1. Ground truth first

- Read the app's `AGENTS.md`, its `docs/design/` (create `docs/design/brief.md` if missing: who the
  app is for, its job, its voice, its brand hue, and three reference products whose quality bar it
  aims at), and preact-components `docs/design-language.md`, the house style every app shares.
- Capture what exists: run the app and screenshot the affected screens with Playwright at 390 and
  1440 px, in every theme the app has. A screen that does not exist yet is reviewed as its nearest
  neighbour plus the plan. Close the browser and server in a `finally`.
- Write one shared brief for the roles: the job of the screen (what a person must understand, then
  do), the audience, the constraints (house style, content rule: no invented claim, number or
  quote), the screenshots, and the reference products.

## 2. Roles in parallel, no code

Spawn each role from "The design phase" above as its own agent, in one message, with the shared
brief. Each returns at most ten recommendations, most important first, each with its reason and
what a person notices. A role with nothing important to add says so in one line.

## 3. One merged spec, by the lead

- Wireframes at 390 and 1440 px (ASCII or SVG), every state: empty, loading, error, success, long
  content, no permission.
- The component list: which `preact-components` pieces, and which new ones the library needs first
  ("Library first" in the `shared-libs` skill). A pattern the house design language lacks is added to
  `docs/design-language.md` in the same library PR.
- The final copy for every string, from `ux-writer`.
- A table: each recommendation, and what it became or why it was dropped. Where roles disagree, the
  lead decides and says why. A sensible default wins; the spec does not wait for the owner.
- Post the spec on the issue before any code.

## 4. Build, look, revise

The implementer builds from the spec, then screenshots every changed screen at 390 and 1440 px,
in every theme, and critiques them against the spec and the house style: alignment, rhythm,
hierarchy, contrast, truncation, focus order, what a first-time user sees first. Revise and look
again, at least twice, before opening the PR. The PR traces each adopted recommendation to its role
(designer 3, writer 1, …) and attaches the final screenshots.

## 5. Design gate

Brief a `design-reviewer` next to the `reviewer`: the worktree, how to run the app, the spec, and
the screens to check. Its blocking bar is "Design gate" above.

## Quality bar

A screen passes when all of these hold:

- A first-time user names its job and finds its primary action within five seconds.
- One primary action; rare and destructive actions sit in a menu or behind a confirmation.
- Every state is designed; no raw error text, no blank first run.
- Nothing overflows at 390 px; nothing floats in empty space at 1440 px.
- axe-core finds no violation in light or dark; every control works from the keyboard.
- It looks like the other apps' screens, with this app's brand.
