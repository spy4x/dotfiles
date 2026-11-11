---
name: workspace
description: "The owner's repositories and what may be hosted where, the self-hosted services agents may use, the ai-memory files, and the account-wide API tokens. Load before you look for or choose a project, read or write ai-memory, decide where something is hosted or deployed, use or add a self-hosted service (notify the owner, send mail, check uptime or metrics, search the web, push an image), or need, add or rotate an account-wide token."
---

# Workspace

Part of the global rules (`AGENTS.md`, "Projects and memory"); they bind as if written there.

## Projects

Agent setup:

- `dotfiles`: machine config, and the source of the global rules, skills and agents
  (`ai-harnesses/`).
- `ai-memory`: private profile, plans, tasks and incidents (see "Memory" below).
- `skill-state`: helpers for the removed `skill-state` skill. Experiment stopped.

Shared libraries, imported by the TypeScript projects below:

- `ts-libs`: code with no UI, published as `@spy4x/*` on JSR. Exports: `llms.txt`.
- `preact-components`: components, icons, design tokens. Exports: `llms.txt`.

Work and production:

- `seed`: Seed, the SaaS starting point. It owns how a product is hosted and deployed; a new product
  starts from it.
- `financy`: self-hosted finance tracker for a person or a family, being rebuilt on `seed`
  (Seed). Its `AGENTS.md` says what goes to Seed or the libraries first.
- `antonshubin.com`: my freelance site and my blog.
- `neatsoft.dev`: company card for NeatSoft PTE LTD.
- `spy4x`: GitHub profile README. No `AGENTS.md`.
- `upwork-guide`: private. Everything about winning Upwork jobs: positioning, profile copy,
  proposal drafting, mindset. Its `AGENTS.md` is the source for drafting a proposal.

Homelab, for self-hosted services and for my products that earn nothing yet (Seed and Financy
today); client work never runs there. Moving a product to its own or a shared Hetzner server is my
call, made per product: never propose or plan it unless I ask.

- `rostok`: CLI that scaffolds a homelab from a catalog of stacks (`stacks/`). Code that both it and
  `seed` need lives in `ts-libs`, never copied between the two.
- `homelab`: my real rostok project: which stacks run on which server, with encrypted settings.

Open-source self-hosted tools, each a stack in the rostok catalog:

- `zond`: health checks for services behind the SSO proxy. Deployed in `homelab`.
- `oko`: one page for every service, with its Gatus uptime. Deployed in `homelab`.
- `caldav-mcp`: MCP server for a CalDAV server; agents reach my calendar and tasks through it.
  Deployed in `homelab`.
- `caldav-tasks-web`: web companion to Tasks.org for a CalDAV server.
- `mig`: meeting scheduler.

Not listed: personal side projects.

## Services

`~/sync/code/homelab/llms.txt` lists every homelab service: its server, URL, what it does, and
whether agents may use it. Read it before you use or add a service. `rostok llms` generates it from
each stack's `aiCanUse` and `aiNotes` in `servers/<server>/config.json`; never edit it by hand.

- `aiCanUse: true` → use it as its notes say.
- No flag → ask me before the first use. My answer goes into that stack's `aiCanUse` (with
  `aiNotes` on how to use it), and `llms.txt` is regenerated in the same change.
- `aiCanUse: false` → never use it.

To notify me, publish to ntfy with `NTFY_URL`, `NTFY_TOPIC` and `NTFY_TOKEN` from the account
tokens. A headless run notifies through `agent-run push` instead (ringmaster `docs/headless-runs.md`).

A new self-hosted service goes into homelab as a rostok stack: into the rostok catalog first, then
`rostok stack add` and `rostok deploy`. Each one:

- sits behind Authelia unless it has its own sign-in; behind Authelia, it also gets a zond check;
- has a Gatus check (oko shows it);
- gets its DNS record through Cloudflare;
- keeps its data in backups through the stack's `backup.ts`, when it has data.

## Memory

`~/sync/code/ai-memory/`, on demand only, except `direction.md`:

- `direction.md` — my current direction, loaded at session start ("Direction" in `AGENTS.md`).
- `decisions/` — one file per direction-level decision of mine, dated.
- `profile.md` — who I am, how to work with me, how I sell, goals. Read first in any non-coding
  session: planning, writing, marketing, reviewing my work.
- `TASKS.md` — ordered task list: what's next, does X fit the plan.
- `situation.md` — plan, money, priorities: what to build next, stack/vendor.
- `incidents/` — postmortems + standing rules, when working in their area (containers/SELinux,
  secrets, deploys), and the stories behind the global rules.
- `experiments/` — trials and model comparisons behind the global rules.
- `personal.md` — see "Projects and memory" in `AGENTS.md`.

## Account tokens

`~/sync/code/homelab/.env.accounts` (gitignored; encrypted copy `.env.accounts.age`, in the private
`spy4x/homelab` repo) holds account-wide tokens any project or task may use:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API, DNS edit on my zones.
- `HETZNER_CLOUD_API_TOKEN`: Hetzner Cloud API and `hcloud`.
- `UMAMI_API_TOKEN`, `UMAMI_URL`: my self-hosted Umami, `https://stats.antonshubin.com` (homelab).
- `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`: Docker Hub login and push.
- `JSR_TOKEN`: `deno publish` to JSR.
- `NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN`: notifications to me through the cloud ntfy. The token may
  only publish to that topic. Send `Authorization: Bearer`, a `Title` header and the message as the
  body to `$NTFY_URL/$NTFY_TOPIC`. Load all three in the command that sends.
- `WOODPECKER_CI_TOKEN`: API of my Woodpecker CI (`https://ci.antonshubin.com`): pipelines, build
  logs, restarts. Send it as `Authorization: Bearer`, or give it to `woodpecker-cli` as
  `WOODPECKER_TOKEN` with `WOODPECKER_SERVER` set.

They are not in the shell environment. Load only the one a command needs, in that command, into a
plain shell variable (not `export`, so child processes don't inherit it), without printing it:

```bash
T="$(sed -n 's/^JSR_TOKEN=//p' ~/sync/code/homelab/.env.accounts)" && deno publish --token "$T"
```

Never source the whole file: every token would land in the shell. The hard rule on secrets in
`AGENTS.md` applies in full. A token missing from the file → ask me; don't search other files for
one. A new account-wide token → add it to that file, run `rostok env encrypt` in homelab, commit the
`.age` file, and list it here. Never put one of these tokens into a project's `.env.root` or a
server's `.env`: `rostok deploy` copies both to the server.
