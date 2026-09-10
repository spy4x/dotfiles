Laconic by default. English only. Angular Conventional Commits (title +
body = what + why, not how). Sacrifice grammar. Don't narrate tool calls.

# Layering

Global default. Repo-local `AGENTS.md` adds constraints or overrides.
Conflict → repo wins for that repo.

# Stack

Deno 2 + Hono + Fresh + Preact + (SQLite + Litestream) OR Postgres (depends
on project) + syncthing + restic. Hetzner BM/VM, Docker Compose per project.
Shared: Traefik, VictoriaMetrics, Woodpecker CI, Watchtower, Syncthing,
NTFY, Gatus, Authelia.

Cost-aware, no wallet-attack risk third party like serverless functions.
BM/VM with fixed price/mo (Hetzner BM/VM) or usage-based with hard caps
configurable or prepaid (ex: DeepSeek API).

# Session bootstrap

Read in parallel before new project: `README.md` + repo-root `*.md`,
manifest (`deno.jsonc`/`package.json`/etc), lint config, runtime
(`docker-compose.yml`/`Dockerfile`), repo-local `AGENTS.md`. Extract:
exact commands, allowed patterns, libs, hooks, conventions. Greenfield with
none → say so. Repeat per worktree.

# Hard rule: no secrets anywhere they leave box

Passwords, tokens, API keys, JWTs, private keys, raw env values, `.env`-style
blocks, debug logs, stack traces carrying secrets. Two scopes:

**A. Tracked files.** `.env.example` uses placeholders. `.env` is
gitignored. For any env committed to git: `.env.age` with **age64 per-line
encryption. No SOPS.**

**B. Public/external artifacts.** Code hosting (Issues/PRs/Releases/
Gists), registries, webhooks/chats, trackers, telemetry, public docs,
customer comms, public calendars, provider logs (prompts + tool inputs),
CI logs, synced state (clipboard/cloud tmux/syncthing/IndexedDB),
**dotfiles commits**.

Scrub before any send: `<REDACTED:KIND>` (canonical), `***` only for length.
RFC 5737 IPs / RFC 2606 domains for examples. Deterministic scanner before
paste (`gitleaks detect --no-git`, `trufflehog filesystem`, `detect-secrets`).
Reviewer gate on 🔴/🟡.

If leaked: **rotate first**, stop further sends, cascade dependents, edit
(only cosmetic — alerts/RSS/archives already delivered), notify, log to
`~/.local/share/opencode/rotation-log.md`. Edit-after-ship = theater.

# Fail-open

Non-critical external calls (monitoring/reporting/analytics) → `|| true`.
Secret-bearing sends fail-closed (see Hard rule).

# Git Flow

Worktree first (sibling `worktrees/<repo>/`, never inside repo).
Branch `<type>/<short-kebab-slug>` from latest `main` (fetch from remote
to be sure). PR always exists; `[WIP]` prefix until done.
`gh pr create --fill` immediately after push — never ask. Pre-push reviewer
gate (`@reviewer`, scope: diff, secrets, conventions). Merge only on
explicit user "merge" in current session. Squash one feature →
`gh pr merge --squash --delete-branch`. Rebase independent commits →
`gh pr merge --rebase --delete-branch`.

Post-merge cleanup always, unless told otherwise. Worktree remove,
local branch delete, remote branch delete if `--delete-branch` missed,
temp dir `shred -u`, untracked subtree `rm -rf` before worktree remove.
Repo-wide: `git fetch --prune`, `git worktree prune`, `git branch -d`
merged-locally, orphan dir `rm -rf`, ff-only sync to origin/main.

## After worktree creation — env setup

Repos with `.env.age`: copy age key from main, `deno task env:decrypt`.
Repos with `post-checkout` hooks auto-decrypt once key in place (check
repo-local `AGENTS.md`). Skip if no `.env.age`.

## Infrastructure as Code

Codify before manual production changes. Unavoidable by hand → README step +
link from `AGENTS.md`. Rule: any artifact you can put in config/script
belongs there. No UI-clicked knowledge unrecorded.

# TS style

No semis. 2-space indent. **Backticks for strings.** 100 col. Prose-wrap
preserved (matches `deno fmt`). Trailing commas where legal.
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

# Language style

Default: senior-dev register. 10x less prose than padded explanations.
Many words = less works. Less right words > more wrong words. AI context
pollution bad. Clear pro terms win. Senior doesn't explain Git Flow with
prose — uses the term. Junior pattern: "Function refactored. Shorter,
faster, less bug opportunity. Tests pass." Mid: "DNS incorrect. Fixed.
New: A `antonshubin.com` → `163.178.1.38`. 2 min propagation." Operational:
"HA OOM due to docker compose limit for container. Increased to 512M.
No OOM detected over 10 min — stable." Dependency-cleanup: "Past impl
used npm dep. Deno has built-in version. No npm dep anymore. Tests pass."

Off only: "stop" / "normal mode" / "caveman off". Three intensity levels:

| Level | behavior |
|-------|----------|
| lite | pro register, full sentences, no filler |
| full | fragments, articles dropped. Default |
| ultra | arrows (X → Y), strip conjunctions |

Auto-clarity off: security warnings, irreversible actions, multi-step
sequences, user confused/repeating. Code + commits + PR bodies stay
normal prose.

Subject ≤50 chars, hard cap 72. Imperative (`add`, not `added`). No
trailing period. No AI attribution. Body only for non-obvious why.
