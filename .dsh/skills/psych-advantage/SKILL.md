---
name: psych-advantage
description: Parallel psych + marketing analysis -> combined playbook with ethical boundaries. Respects Sovereign B2B positioning.
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /psych-advantage

/psych-advantage $ARGUMENTS

Goal: combined psychology + marketing analysis. Find unfair advantages, surface ethical boundaries.

Steps:
1. Spawn TWO sub-agents IN PARALLEL via Task tool (independent analyses):
   - psychologist agent: human nature, persuasion, influence, decision biases, emotional drivers
   - marketing-seo agent: positioning, channels, CRO, SEO, growth loops, distribution
   Both get the same brief: $ARGUMENTS. Wait for both outputs before synthesizing.
2. Synthesize into combined playbook:
   - Psychological dynamics: which biases/needs/principles drive behavior here
   - Marketing execution: how to reach, convert, retain using those insights
   - Unfair advantage: specific intersection where psych + marketing creates a moat
   - Tactical playbook: 3-5 actions ranked by effort/impact (effort: low/med/high, impact: 1-10)
   - Ethical boundaries: what to AVOID (manipulation, dark patterns, trust erosion, regulatory risk)
3. Frame note: Anton's positioning is Sovereign B2B partner (Fractional CTO for non-technical founders). All advice must respect that — no dark patterns, no manipulation, no tactics that would erode his stated identity or frame.
4. Output structure:
   ## Psych Analysis
   <summary>
   ## Marketing Analysis
   <summary>
   ## Combined Playbook
   <dynamics, execution, moat, actions, ethics>
   ## Recommended Next Step
   <one concrete action>

Caveman. Ethics explicit. No tactics that violate Sovereign frame.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
