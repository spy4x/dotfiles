---
name: tests
description: "Rules for test code and tooling: shared services, throwaway test containers, fake binaries, Playwright, axe-core, when tooling may change. Load before you write or change a test, a test helper, a fake binary, a browser or accessibility check, or a check runner."
---

# Tests

Part of the global rules (`AGENTS.md`, "TS style"); they bind as if written there.

Integration tests may share their services (Postgres, Redis, a mail server) with other runs. Give
every schema, key, object and recipient a per-run name, never truncate a shared table or empty a
shared mailbox, and clean up in a `finally`, also when the test failed: delete only what the run
created, never `FLUSHDB`, `FLUSHALL` or `DROP DATABASE` on a shared service.

**Test services.** Start them with the repo's own task when its `AGENTS.md` or manifest names one.
Without one, start a throwaway container for the run, so parallel runs never meet:

```bash
N=test-pg-$(date +%s%N) && trap 'docker stop "$N" >/dev/null' EXIT &&
  docker run -d --rm --name "$N" -p 127.0.0.1::5432 --pids-limit=500 --memory=8g \
    -e POSTGRES_PASSWORD=test postgres:18 >/dev/null &&
  P=$(docker port "$N" 5432/tcp | cut -d: -f2) &&
  timeout 60 sh -c "until docker exec $N pg_isready -q -h 127.0.0.1; do sleep 1; done" &&
  DATABASE_URL=postgres://postgres:test@127.0.0.1:$P/postgres <test command>
```

- The wait checks over TCP (`-h 127.0.0.1`): the image's first start runs a temporary server on
  the Unix socket only, then restarts, so a socket check can pass too early.
- The resource flags follow the `leave-nothing-running` skill, "Cap anything that spawns processes".
- A shell keeps one `EXIT` trap, so a test command that sets its own (the CI emulation in
  `AGENTS.md`) puts `docker stop "$N"` in that trap too.
- `--rm` removes the container and its anonymous volumes when it stops, so the trap only stops it.
  Never put `docker rm` in a trap: Claude Code refuses a command whose `rm` it cannot check, even
  in bypass mode.
- Bind to `127.0.0.1` with a random host port (`::5432`) and read it back with `docker port`;
  a fixed port clashes with another run.
- The readiness wait has its own deadline, as every wait does (`AGENTS.md`, "Leave nothing
  running"). Run the whole command in the foreground, so the trap fires.

A fake binary prepended to `PATH` never calls the real tool by name: resolve its absolute path
before changing `PATH` and pass it in an env var. Add a recursion guard too: the fake sets a depth
variable and exits non-zero when it sees one already set.

**Test tooling serves the product, never the reverse.** Browser tests use Playwright, which waits
for elements by itself; never a hand-written DevTools client with its own waits and scroll helpers.
Change test tooling (harness, helpers, check runners) only in two cases: to prove a behaviour change
in the same PR, or to fix a run that actually failed in CI. Refactoring or deduplicating checks, and
hardening one against a failure nobody has seen, is not work to take on. In a repo that already has
its own client, write a new browser test in Playwright, and move an existing one there when you edit
it; leave the untouched ones where they are. The same goes for accessibility checks (contrast,
roles, names): a new or edited one uses axe-core through `@axe-core/playwright`, not a hand-written
measurement, and the untouched ones stay.
