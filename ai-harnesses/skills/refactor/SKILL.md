---
name: refactor
description: "Structural refactor with green baseline + post-check. No behavior change, one commit per change, reviewer gate, merge on green."
invocation: user
targets: [opencode, dsh]
harness:
  opencode:
    agent: refactor
---

# /refactor $ARGUMENTS

Goal: structural improvement without behavior change. Verify before AND after.

Steps:

1. Parse scope: target file/dir/symbol, or full subsystem. If vague, pick the narrowest sensible scope and record it in the PR body. Create the worktree first, per Git Flow in AGENTS.md.
2. Baseline: run the repo's check task (read the manifest for its name), capture test results + any e2e baseline. Refactor forbidden without green baseline — fix blockers first with the debugger agent, do NOT silently mask them.
3. Identify smell: duplication, dead code, complexity hotspots, layer violations, missed abstractions. Use metrics when possible: line count, cyclomatic complexity, coupling. Cite file:line for each finding.
4. Plan refactor strategy:
   - Extract: lift shared logic into libs/* when 2+ call sites
   - Inline: collapse single-use wrappers that obscure rather than clarify
   - Rename: improve names when current ones mislead (no gratuitous renames)
   - Move: relocate to correct layer (libs vs handlers vs components)
   - Simplify: drop dead branches, redundant null checks, premature abstractions
   - Performance: index, memoize, batch, parallelize — only when measured bottleneck
5. Apply ONE logical change at a time. Between each:
   - Run targeted tests on changed area
   - Run the check task on the full codebase
   - If red: STOP, revert, diagnose. Do not stack changes on broken state.
   - If green: commit it on its own (`refactor(<scope>): <subject>`).
6. After all changes:
   - Run the check task (must pass), then the CI emulation from AGENTS.md
   - Run full test suite
   - Compare behavior: outputs match baseline? contracts preserved? perf not regressed?
   - If UI changed, screenshot via Playwright MCP at critical paths
7. Output:

   ```text
   Baseline: <tests pass: N, check pass: yes/no>
   Smells found: <file:line + category + severity>
   Changes applied:
     - <description + file:line diff summary>
   Behavior verified:
     - tests: <N> pass
     - check task: pass
     - perf delta: <none / X% / Y ms>
   Risk: <what could break, why low>
   PR: <url>
   ```

8. Push, open the PR (`gh pr create --fill`) with the output above as its body, and run the reviewer gate (the `reviewer` agent). Needs-fix → fix and re-run; failed twice on the same cause → stop and leave the PR open. Green gate → merge (`gh pr merge --rebase --delete-branch`, since each commit is one independent change) and do the post-merge cleanup from AGENTS.md.

Terse chat status is fine; the output above is read later, so write it in full sentences. Behavior preservation is non-negotiable. Refactor without green baseline = forbidden.
