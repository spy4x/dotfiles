# Run dashboard

One read-only page that answers three questions about the background lead and Claude Code spend:
is anything wrong, is today's budget fine, and is the lead worth its cost (merged issues per $100).
Design: [spy4x/dotfiles#256](https://github.com/spy4x/dotfiles/issues/256).

```bash
deno task runs-dashboard   # then open http://127.0.0.1:8787; Ctrl+C stops it
```

- Reads `$AGENT_RUN_HOME/runs.sqlite` (default `~/.local/state/agent-run/runs.sqlite`). It opens
  the file read-only on each request, never writes it and never creates it.
- Listens on `127.0.0.1` only, port `PORT` (default 8787). A request whose `Host` header is not
  `127.0.0.1:<port>` or `localhost:<port>` gets 403, so another site cannot read the page through
  DNS rebinding. `ALLOWED_HOSTS` adds comma-separated `Host` values to accept, for a proxy that
  forwards a public name (the homelab publishes it as `runs.antonshubin.com` through Pangolin).
  Each entry matches the `Host` header exactly, case and port included: `runs.example.com` does
  not accept `Runs.example.com` or `runs.example.com:443`. Empty entries are ignored.
- Started on demand here; on portable the homelab's `runs-dashboard.service` keeps it running.
- Each card runs its own query, so a missing view blanks that card only. It never shows prompt or
  tool-output text.

To look at it without real data, write a sample database and point the server at it:

```bash
(D=$(mktemp -d) && trap '[ -d "$D" ] && find "$D" -delete; exit' EXIT INT TERM &&
  deno run -A tools/runs-dashboard/fixture.ts "$D" && AGENT_RUN_HOME=$D deno task runs-dashboard)
```

Ctrl+C stops the server, and the `trap` deletes the sample folder, in bash and zsh alike.

`fixture.ts "$D" --empty` writes the tables with no rows. `screenshots/` holds the page on that
sample.
