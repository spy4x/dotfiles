---
name: refactor
description: Structural refactor with green baseline + post-check. No behavior change, no auto-commit, file:line citations.
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /refactor

/refactor $ARGUMENTS

Goal: structural improvement without behavior change. Verify before AND after.

Steps:
1. Parse scope: target file/dir/symbol, or full subsystem. If vague, ask one batch (max 3 questions).
2. Baseline: run deno task check, capture test results + any e2e baseline. Refactor forbidden without green baseline — fix blockers first via @debugger, do NOT silently mask them.
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
   - Run deno task check on full codebase
   - If red: STOP, revert, diagnose. Do not stack changes on broken state.
6. After all changes:
   - Run deno task check (must pass)
   - Run full test suite
   - Compare behavior: outputs match baseline? contracts preserved? perf not regressed?
   - If UI changed, screenshot via Playwright MCP at critical paths
7. Output:
   Baseline: <tests pass: N, check pass: yes/no>
   Smells found: <file:line + category + severity>
   Changes applied:
     - <description + file:line diff summary>
   Behavior verified:
     - tests: <N> pass
     - deno task check: pass
     - perf delta: <none / X% / Y ms>
   Risk: <what could break, why low>
   Commit message: refactor(<scope>): <subject>
8. Do NOT auto-commit. Show diff + commit msg. Wait for user.

Caveman. Behavior preservation is non-negotiable. Refactor without green baseline = forbidden.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
