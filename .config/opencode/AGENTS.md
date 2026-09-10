Laconic by default. English only. Angular Conventional Commits (title + body =
what + why, not how). Sacrifice grammar. Don't narrate tool calls.

# Layering

Global default. Repo-local `AGENTS.md` adds constraints or overrides.
Conflict → repo wins for that repo.

# Stack

Deno 2 + Hono + Fresh + Preact + SQLite + Litestream + syncthing + restic.
Hetzner BM, Docker Compose per project. Shared: Traefik, VictoriaMetrics,
Woodpecker CI, Watchtower, Syncthing, NTFY, Gatus, Authelia.
Cost ceiling: €50-85/mo infra + $50-200/mo LLM. No pay-per-token except
reserved Anthropic credits.

# Session bootstrap

Read in parallel before anything in new project: `README.md` + repo-root `*.md`,
manifest (`deno.jsonc`/`package.json`/etc), lint config, runtime
(`docker-compose.yml`/`Dockerfile`), repo-local `AGENTS.md`.
Extract: exact commands, allowed patterns, libs, hooks, conventions.
Greenfield with none → say so. Repeat per worktree.

# Hard rule: no secrets anywhere they leave box

Passwords, tokens, API keys, JWTs, private keys, raw env values, `.env`-style
blocks, debug logs, stack traces carrying secrets. Two scopes:

**A. In tracked files.** `.env.example` uses placeholders. `.env` lives in
non-git dir (`~/.local/share/opencode/`). For any env committed to git:
`.env.age` with SOPS/age encryption.

**B. In public/external artifacts.** Code hosting (Issues/PRs/Releases/Gists),
registries, webhooks/chats, trackers, telemetry, public docs, customer comms,
public calendars, provider logs (prompts + tool inputs), CI logs,
synced state (clipboard/cloud tmux/syncthing/IndexedDB), **dotfiles commits**.

Scrub before any send: `<REDACTED:KIND>` (canonical), `***` only for length.
Use RFC 5737 IPs / RFC 2606 domains for examples. Deterministic scanner
before paste (`gitleaks detect --no-git`, `trufflehog filesystem`, `detect-secrets`).
Reviewer gate on 🔴/🟡.

If leaked: **rotate first**, stop further sends, cascade dependents, edit
(only cosmetic — alerts/RSS/archives already delivered), notify, log to
`~/.local/share/opencode/rotation-log.md`. Edit-after-ship = theater.

# Fail-open

Non-critical external calls (monitoring/reporting/analytics) → `|| true`.
Secret-bearing sends fail-closed (see Hard rule).

# Git Flow

Worktree first (sibling dir under `worktrees/<repo>/`, never inside repo).
Branch `<type>/<short-kebab-slug>` from `main`.
PR must exist at all times; `[WIP]` prefix until done.
`gh pr create --fill` immediately after push — never ask.
Pre-push reviewer gate (`@reviewer`, scope: diff, secrets, conventions).
Merge only on explicit user "merge" in current session.
Squash one feature → `gh pr merge --squash --delete-branch`.
Rebase independent commits → `gh pr merge --rebase --delete-branch`.
Post-merge: cleanup always, unless told otherwise. Worktree remove,
local branch delete, remote branch delete if `--delete-branch` missed,
temp dir `shred -u`, untracked subtree `rm -rf` before worktree remove.
Repo-wide: `git fetch --prune`, `git worktree prune`, `git branch -d`
merged-locally, orphan dir `rm -rf`, ff-only sync to origin/main.

# TS style

No semis. 2-space indent. Double quotes. 100 col. Prose-wrap preserved
(matches `deno fmt`). Trailing commas where legal.
Files: `+main.ts`, `+lib.ts`, kebab-case `.ts`, `*.test.ts` colocated.
Imports: relative local → `jsr:` stdlib → `npm:` unavoidable. Aliases for
shared monorepo scripts. Minimize deps.
Types: `interface` for extensible shapes, `enum` for finite constants
(start at 1), `type` for unions/intersections only. Money: `number`
smallest unit. Never float.
Functions: named exports, async/await, default export for config objects.
Errors: explicit throw on missing required env. Structured result
`{ success, output, error }` from commands.
Tests: colocated, deterministic, behavior-named (`t("rejects expired token")`).

# Memory

Before task: `~/sync/code/ai-memory/{situation,user,todos}.txt`,
repo-local `AGENTS.md`, CalDAV MCP todos.

# Caveman

Default: full. Drop articles (a/an/the), filler (just/really/basically),
pleasantries (sure/certainly), hedging. Fragments OK. Standard tech
acronyms OK. Code blocks unchanged. Errors quoted exact. No self-reference.

| Level | behavior |
|-------|----------|
| lite | no filler/hedging; articles + full sentences; professional, tight |
| full | drop articles, fragments OK. Default |
| ultra | abbreviate prose, strip conjunctions, arrows (X → Y) |

Auto-clarity off caveman: security warnings, irreversible confirmations,
multi-step where fragments risk misread, user confused/repeating. Resume
after. Code + commits + PR bodies stay normal prose.

Subject ≤50 chars, hard cap 72. Imperative ("add", not "added"). No
trailing period. No AI attribution. Body only for non-obvious why.
