---
name: workspace
description: "The owner's repositories and what may be hosted where, the ai-memory files, and the account-wide API tokens. Load before you look for or choose a project, read or write ai-memory, decide where something is hosted or deployed, or need, add or rotate an account-wide token."
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
- `antonshubin.com`: my freelance site.
- `neatsoft.dev`: company card for NeatSoft PTE LTD.
- `spy4x`: GitHub profile README. No `AGENTS.md`.

Homelab, for self-hosted services, never for hosting work or production projects:

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
