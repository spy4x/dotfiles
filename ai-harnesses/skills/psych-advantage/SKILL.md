---
name: psych-advantage
description: "Parallel psych + marketing analysis -> combined playbook with ethical boundaries. Follows the client voice in the global rules: warm, transparent, honest."
invocation: user
harness:
  opencode:
    subtask: true
---

# /psych-advantage $ARGUMENTS

Goal: combined psychology + marketing analysis. Find unfair advantages, surface ethical boundaries.

Steps:

1. Spawn TWO subagents IN PARALLEL (independent analyses):
   - psychologist agent: human nature, persuasion, influence, decision biases, emotional drivers
   - marketing-seo agent: positioning, channels, CRO, SEO, growth loops, distribution
     Both get the same brief: $ARGUMENTS. Wait for both outputs before synthesizing.
2. Synthesize into combined playbook:
   - Psychological dynamics: which biases/needs/principles drive behavior here
   - Marketing execution: how to reach, convert, retain using those insights
   - Unfair advantage: specific intersection where psych + marketing creates a moat
   - Tactical playbook: 3-5 actions ranked by effort/impact (effort: low/med/high, impact: 1-10)
   - Ethical boundaries: what to AVOID (manipulation, dark patterns, trust erosion, regulatory risk)
3. Voice: follow "Voice with clients" and "Marketing" in the global rules. Anton is a warm,
   transparent technical partner for non-technical founders: clients understand everything, see
   every trade-off and choose per feature. Advice that pushes people away, talks down, or uses
   pressure, dark patterns or made-up proof is out, and so is advice that makes him servile.
4. Output structure:
   ## Psych Analysis
   <summary>
   ## Marketing Analysis
   <summary>
   ## Combined Playbook
   <dynamics, execution, moat, actions, ethics>
   ## Recommended Next Step
   <one concrete action>

The playbook is read later — full sentences. Ethics explicit. No tactic that costs trust or makes him servile.
