---
name: test
description: Runs deno test (specific file, filter, or full). Parses failures, suggests fix scope, does not auto-fix.
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /test

/test $ARGUMENTS

Goal: run tests, surface failures, suggest fixes. Fast feedback loop.

Steps:
1. Parse args: specific file path, filter pattern, or empty (= all).
2. If specific path given: deno test <path>. If filter: deno test --filter="<pattern>". Else: deno task test.
3. Capture output. On failure, parse error to:
   - File:line of failure
   - Failing assertion or error type
   - Suggested fix scope (one line)
4. Output format:
   Pass: <N> tests in <duration>
   Fail: <file>:<line> — <assertion>. Likely fix: <scope>.
   Skip: <count> tests skipped
5. If full suite passes, suggest next: @reviewer if branch active, /pr if commits pending.
6. Do NOT auto-fix. Return findings for user decision.

Caveman. Specific file:line, not "test failed somewhere".

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
