---
name: deploy
description: 
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /deploy

/deploy $ARGUMENTS

Goal: deploy service(s) to target server with verification.

Steps:
1. Parse args: <server> [stack]. Server required. Stack optional (defaults to all in config.json).
2. Pre-deploy check: deno task check passes on current branch. If not, stop.
3. Confirm .env.decrypted for target server (gitignored, in non-git dir). If missing, run deno task env:decrypt first.
4. Run: deno task deploy <server> [stack]
5. Post-deploy verify:
   - Service container healthy (docker ps / podman ps)
   - Healthcheck endpoint responds (curl with timeout)
   - Logs clean (docker logs --tail 50, no errors in last 1 min)
6. Output:
   Deployed: <stack> to <server>
   Status: <healthy/degraded/down>
   Healthcheck: <endpoint response, code>
   Logs: <error count in last minute>
   Next: monitor for 5 min, or @reviewer if PR pending.
7. If deploy fails, capture error, do NOT auto-rollback. Surface to user.

Caveman. Failures explicit. No auto-rollback without approval.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
