---
name: skill-state
description: "Experiment: run a long task through an explicit state file (.skill-state/state.json) and fresh per-step subagents, instead of one growing conversation. Load when the start-task skill picks the skill-state arm, or when asked to use skill-state."
---

# SKILL.state (experiment)

**The idea.** SKILL.state (arXiv:2608.26263; Badhe, Tiwari and Chung, 2026) replaces the growing
chat history with an explicit, mutable execution state. At each step the model gets only three
things: the skill, the current state, and the latest observation. The paper reports higher task
accuracy with much lower cumulative token use.

**The limit here.** The paper assumes a runtime that builds every prompt. Claude Code, OpenCode and
DSH always keep the full chat history, so this skill approximates the idea in three ways:

- You, the lead, keep the task's state in files, not in your context.
- Each step's real work runs in a **fresh subagent** whose entire brief is the frame: skill, state
  and latest observation. It gets no conversation.
- The state survives context compaction and a new session. Resume from the files, not from memory.

The experiment asks one question: does this make long tasks cheaper and more reliable than the
normal flow? Every run, in either arm, is logged in
`~/sync/code/ai-memory/experiments/skill-state.md`.

## Files

Inside the worktree, never committed:

```
.skill-state/
├── state.json                     # current state, changed only through the CLI
├── transcript.jsonl               # append-only, one event per line
└── observations/obs-NNNN-<slug>.json
```

Keep them out of git without touching the repo's `.gitignore`, because the experiment must not
leave a diff:

```bash
echo .skill-state/ >> "$(git rev-parse --git-common-dir)/info/exclude"
```

## CLI

The CLI validates the files. Always change `state.json` through `apply`, never by hand.

```bash
S=~/sync/code/skill-state/cli.ts
deno run -A $S validate     .skill-state/state.json
deno run -A $S apply        .skill-state/state.json patch.json > next.json && mv next.json .skill-state/state.json
deno run -A $S frame        .skill-state/state.json .skill-state/observations/obs-NNNN-<slug>.json --procedure <this file>
deno run -A $S append-event .skill-state/transcript.jsonl event.json
```

Patches deep-merge: objects merge, while scalars and arrays replace. To append to an array, send
the whole new array. `null` deletes a field. `~/sync/code/skill-state/examples/` has a complete
`state.json`, observation and transcript.

This skill lives at `~/.claude/skills/skill-state/SKILL.md` in Claude Code,
`~/.config/opencode/skills/skill-state/SKILL.md` in OpenCode, and
`$DSH_HOME/skills/skill-state/SKILL.md` in DSH. Pass that path as `--procedure`.

## State

The CLI enforces these fields:

| Field                                               | Holds                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `schema_version`                                    | `"1"`                                                                                          |
| `objective`                                         | the issue's **In short**. It never changes; a change of scope is a `decisions` entry           |
| `phase`, `phase_history`                            | where the task is, and when each phase started and ended                                       |
| `inputs`                                            | `issue`, `repo`, `worktree`, `branch`, `base`, then `pr` once it exists                        |
| `findings.peer_review`                              | reviewer findings: `id`, `severity` (`low` · `med` · `high` · `blocker`), `summary`, `pointer` |
| `blockers`, `decisions`                             | what stops progress, and every judgment call with its reason                                   |
| `sign_offs.implementation`, `sign_offs.peer_review` | who signed each gate and on what evidence (checks run, reviewer verdict)                       |
| `architect_overrides`                               | a skipped phase, and why                                                                       |
| `next_action`                                       | the next step, at most 200 characters. The next subagent does exactly this                     |
| `provenance`                                        | `last_observation_id` and `last_patch_id`; update both on every patch                          |

Phases, in order: `spec → design → issue → implementation → review → merge → done`, or `halted`.
They only move forward. Skipping one needs an `architect_overrides` entry. Entries are never edited
or removed: to retract one, add a new entry with `supersedes: ["<id>"]`.

## The loop

1. **Record what happened** as the next observation file, raw, not summarized. That can be the
   user's message, command output or a subagent's report.
2. **Patch the state.** `apply` validates the patch; on an error, fix the patch and apply it again.
   Then append one transcript event: `ts`, `actor`, `action`, `patch`, `observation`.
3. **Delegate the next step.** Build the frame from the state and the latest observation. The
   subagent's whole brief is that frame plus one line: "Do `next_action`. Work in
   `inputs.worktree`. Return a report of what you did and a JSON patch; do not apply it." Its
   report becomes the next observation, and you apply its patch after checking it.
   - Choose the subagent by phase: the `implementer` agent for implementation, the reviewer the
     global Reasoning effort rule picks for review, and a general agent for spec, design and
     issue.
   - A trivial step, such as one command or reading one file, you may do yourself. It still gets an
     observation and a patch.
4. **Repeat until `done` or `halted`.** After a context compaction, or in a new session, read
   `state.json` and the latest observation first. Never reconstruct the state from memory.

The reviewer gate, the merge rules and the post-merge steps are the normal ones from `AGENTS.md`.
Only the way the work is carried and handed over changes.

Keep `state.json` under 20 KB. Past that, move the oldest half of `phase_history` to
`phase_history_archived.json`.

## Chat and the log

Chat status stays as the global rules describe. The state files are the record, so do not paste
them into chat. When the task reaches `done` or `halted`, add a row to the experiment log as that
file instructs, then delete `.skill-state/` together with the worktree.
