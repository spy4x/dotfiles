---
name: writing-rules
description: "How agent rules are kept: one source, one place per rule, no history, trials, size budgets, machine checks, review. Load before you add, remove, reword or move a rule or a check (AGENTS.md, CLAUDE.md, a skill, an agent, harness settings, lint config, a check task, a CI step), or review such a change."
---

# Writing rules

Part of the global rules (`AGENTS.md`, "Rules about rules"); they bind as if written there. What a
rule and a fact are, and that rules are mine, is in that section.

- **One source.** Every harness gets its rules, skills, agents and settings from
  `dotfiles/ai-harnesses/`; `deno task ai` renders it into each (`ai-harnesses/README.md`). Edit
  the source, never a copy: the next `deno task ai` overwrites a hand edit to what it renders.
- **One place per rule.** A rule that holds in every repo lives in the global `AGENTS.md`, or in a
  skill it names when only one job needs the rule. A repo's `AGENTS.md` holds what is true of that
  repo only: its facts, and rules stricter than the global ones; a rule it shares with them is
  deleted there. A skill or an agent holds the steps of its own job and names the section of the
  global rules that it follows, never a copy of the rule. Merge a rule stated twice.
- **Current state, not history.** A rule says what to do now, its reason in one clause. The story
  behind it (an incident, an experiment and its numbers, "was X until Y") lives in
  `~/sync/code/ai-memory/incidents/` or `experiments/`, linked from the rule. A repo's lesson (a
  browser quirk) goes in the doc of the tool it is about, linked from its `AGENTS.md` when needed.
- **Trials.** A rule on trial names its review date and its experiment file. Only I move the date.
- **Size.** The global `AGENTS.md` stays within 475 lines and 30,000 bytes (a test checks it; every
  turn of every session pays for it, and DSH reads at most 64 KiB of rules, a repo's included). A
  job-specific procedure goes in a skill, and `AGENTS.md` keeps a pointer that says when to load
  it. A repo's `AGENTS.md` stays under about 200 lines and `direction.md` under about 150. A change
  that would pass a budget first moves history out, moves a procedure into a skill or merges
  duplicates.
- **Machines check what they can.** A rule a machine can check gets a hook (the `harness-rules`
  mod), a lint rule or a CI check, not prose alone. The prose stays the source the check enforces.
- **Wording.** "Language style" in `AGENTS.md` applies: one rule per sentence or short paragraph,
  the action first, then the reason, and plain words.
- **Review.** Every rule change goes through the reviewer gate. The reviewer compares old and new
  rule by rule, and a rule lost, weakened or changed in meaning that I did not ask for in chat fails
  the gate. The PR body quotes my request.
