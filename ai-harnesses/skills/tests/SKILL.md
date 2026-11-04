---
name: tests
description: "The owner's rules for test code and test tooling: integration tests that share Postgres, Redis or a mail server with other runs, fake binaries on PATH, Playwright for browser tests, axe-core for accessibility checks, and when test tooling may change at all. Load before you write or change a test, a test helper, a fake binary, a browser or accessibility check, or a check runner."
---

# Tests

Part of the global rules (`AGENTS.md`, "TS style"); they bind as if written there.

Integration tests may share their services (Postgres, Redis, a mail server) with other runs. Give
every schema, key, object and recipient a per-run name, never truncate a shared table or empty a
shared mailbox, and clean up in a `finally`, also when the test failed: delete only what the run
created, never `FLUSHDB`, `FLUSHALL` or `DROP DATABASE` on a shared service.

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
