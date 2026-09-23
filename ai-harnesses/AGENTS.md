Laconic by default. English only. Angular Conventional Commits (title +
body = what + why, not how). Laconic means fewer ideas and fewer words per
idea — never broken sentences or shorthand the reader must decode. Don't
narrate tool calls.

# Layering

Global default. Repo-local `AGENTS.md` adds constraints or overrides.
Conflict → repo wins for that repo.

One source for every harness: `dotfiles/ai-harnesses/`. `deno task ai` copies
this file byte-for-byte to OpenCode, DSH and Claude Code
(`~/.claude/CLAUDE.md`), and renders every skill and agent there into each
harness's format; `--check` reports drift. Edit the source, never a copy.

# Autonomy

Finish the job and report the result. I don't review code before it lands; the
`@reviewer` gate does, and a green gate is the authority to merge. Where a
sensible default exists, take it and record it in the PR body. Ask only when:

- the choice is mine and the options mean materially different work (SQLite
  versus Postgres, not naming);
- a revert can't undo it: destroying data, rotating a secret, publishing to a
  registry or customers, deleting the only copy;
- the reviewer gate fails twice on the same cause — the brief is wrong.

A question costs my attention; a wrong reversible guess costs one revert. Prefer
the revert.

New work with no issue written down (a feature, bug, task or idea) → the
`start-task` skill: one batch of questions up front, about intent and the
technical choices that are costly to reverse (the one exception to "ask only
when" above), then spec, design and a GitHub issue before any code, then
implementation, unless I asked only for the spec or the design.

# Stack

Deno 2 + Hono + Fresh + Preact + syncthing + restic. Hetzner BM/VM, Docker
Compose per project. DB per project: SQLite + Litestream or Postgres —
scaffolding a new project → ask which, never assume.
Shared: Traefik, VictoriaMetrics, Woodpecker CI, Watchtower, Syncthing,
NTFY, Gatus, Authelia.

Cost-aware: fixed price per month (Hetzner BM/VM) or usage-based with hard or
prepaid caps (DeepSeek API). No wallet-attack risk like serverless functions.

**Deps: own the small, keep the huge.** Platform primitives first (`<dialog>`,
`<details>`, `Intl`, `crypto`, `URL`, `structuredClone`), then `@std/*`. Write
anything small and opinionated whose defaults we'd fight — UI components
especially (no shadcn/Radix/Headless UI/Material/Chakra). Keep the giant,
well-solved ones: postgres.js, arktype, preact, wouter, tailwind, `@std/*`,
signals, hono, qrcode, webpush, otpauth, playwright, ioredis, fresh, vite, d3,
leaflet, an SMTP lib, a date/tz lib — never reimplement these. Libraries are
design references, never code sources: port markup and behaviour, not the
dependency. Owning a component means owning its accessibility: roles, labels,
keyboard handling, focus.

# Session bootstrap

New repo, before first edit, read in parallel: repo-local `AGENTS.md` (unless
preloaded), `README.md`, manifest (`deno.jsonc`/`package.json`/etc) for exact
task names, lint/fmt config. Everything else (other root `*.md`, `docs/`,
`compose.yml`/`Dockerfile`, hooks) only when the task touches it. Never guess a
command the manifest defines. Greenfield with none → say so. New worktree of a
known repo → no re-read.

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

**Transcript carve-out.** Read a `.env` when the task needs a value; it reaches
the provider log, an accepted trade. The value goes no further: no commit, PR,
issue, chat, shipped log line, or tracked or transmitted file (a local
gitignored `.env` is fine). `.age` key material is denied outright.

Scrub before any send: `<REDACTED:KIND>` (canonical), `***` only for length.
RFC 5737 IPs / RFC 2606 domains for examples. Deterministic scanner before
paste (`gitleaks detect --no-git`, `trufflehog filesystem`, `detect-secrets`).
Reviewer gate on 🔴/🟡.

If leaked: **rotate first**, stop further sends, cascade dependents, edit
(only cosmetic — alerts/RSS/archives already delivered), notify, log to
`~/sync/code/ai-memory/incidents/rotation-log.md` (event only, never the value). Edit-after-ship = theater.

# Fail-open

Non-critical external calls (monitoring/reporting/analytics) → `|| true`.
Secret-bearing sends fail-closed (see Hard rule).

# Leave nothing running

A killed shell leaves its `&` children running, reparented to `systemd --user`;
cleanup on the command's last line never runs. Once cost: 32 busy-loops on 11 of
16 cores for 11.5 hours. In order of preference:

1. Run in the foreground.
2. Background through the harness (`run_in_background`), never bare `&`.
3. Unavoidable `&` → own deadline, `timeout 300 <cmd> &` (the timer lives in the
   child), plus `trap 'kill $PIDS 2>/dev/null' EXIT INT TERM` (no help on
   SIGKILL). CPU load: `stress-ng --cpu 0 --timeout 60s` or at least
   `timeout 60s yes >/dev/null &`, never `while :; do :; done &`.

Same for temp dirs, `DENO_DIR` caches, dev servers, ports, watchers, containers,
`tmux` sessions: clean up in a `trap`, not a trailing line.

**Sweep before reporting done:** `~/sync/code/dotfiles/tools/sweep-orphans.sh`.
Empty output = clean. Read the output before killing — a sibling session's work
can show up. It misses Docker and `systemd-run --scope` (own cgroup): clean
those by name.

# Git Flow

Worktree first (sibling `worktrees/<repo>/`, never inside repo — repo tooling
sweeps nested checkouts into fmt/type-check). Already in a linked worktree
(`.git` is a file) → work there, never nest. Else:

```bash
MAIN=$(realpath "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")
WT="$(dirname "$MAIN")/worktrees/$(basename "$MAIN")/<type>/<slug>"
git fetch origin && mkdir -p "$(dirname "$WT")" && git worktree add -b <type>/<slug> "$WT" origin/main
```

Syncthing ignores `worktrees/` (per-machine step: README,
`system/syncthing-code.stignore`): a synced worktree is broken by construction
and burns inotify watches.

Branch `<type>/<short-kebab-slug>` from latest default branch on the remote. PR always exists; `[WIP]` prefix until done.
`gh pr create --fill` immediately after push — never ask. Pre-push reviewer
gate (`@reviewer`, scope: diff, secrets, conventions). Green gate → merge
without asking. Gate failed, or a revert can't undo it → leave the PR open and
say so. Squash one feature → `gh pr merge --squash --delete-branch`. Rebase
independent commits → `gh pr merge --rebase --delete-branch`.

Post-merge cleanup always, unless told otherwise. Worktree remove,
local branch delete, remote branch delete if `--delete-branch` missed,
temp dir `shred -u`, untracked subtree `rm -rf` before worktree remove.
Repo-wide: `git fetch --prune`, `git worktree prune`, `git branch -d`
merged-locally, orphan dir `rm -rf`, ff-only sync to origin/main, orphan
sweep.

## After worktree creation — env setup

Repos with `.env.age`, from inside the worktree:

```bash
deno run --allow-read --allow-write --allow-run=git ~/sync/code/dotfiles/tools/env-key-copy.ts
deno task env:decrypt
```

It copies the age key from the main checkout without printing it or naming
`.age/` on the command line (a plain `cp` is refused by `permissions.deny`).
Idempotent. Repos with `post-checkout` hooks auto-decrypt
once the key is in place (check repo-local `AGENTS.md`).

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
JSDoc on non-trivial or >10-line functions/classes/interfaces.

**Local green is not CI evidence** — it hides `$HOME`, `DENO_DIR` and cache
assumptions. Emulate CI, one check per command (a shell has one `EXIT` trap),
and drop the cache in the same command (`/tmp` is tmpfs; a Fresh app fills
150 MB+):

```bash
D=$(mktemp -d) && trap 'rm -rf "$D"' EXIT && CI=true DENO_DIR=$D <check command>
```

Never assert a path under `$HOME`; resolve through the tool
(`import.meta.resolve`) or injected config. A test that can silently skip when
its dependency is missing will — fail loudly.

# Memory

`~/sync/code/ai-memory/`, on demand only:

- `profile.md` — who I am, how to work with me, how I sell, goals. Read first
  in any non-coding session: planning, writing, marketing, reviewing my work.
- `TASKS.md` — ordered task list: what's next, does X fit the plan.
- `situation.md` — plan, money, priorities: what to build next, stack/vendor.
- `incidents/` — postmortems + standing rules, when working in their area
  (containers/SELinux, secrets, deploys).
- `personal.md` — never read unless I say so in this session.

Durable project knowledge → the repo (`AGENTS.md`, `docs/`). Harness-local
memory only for facts no repo owns.

# Experimental

`skill-state` experiment: `start-task` alternates long tasks between the
`skill-state` skill and the normal flow, and logs both arms in
`~/sync/code/ai-memory/experiments/skill-state.md`. Helpers in
`~/sync/code/skill-state/` (github.com/spy4x/skill-state, private).

# Subagent orchestration

Volume work (3+ file-disjoint units) → parallel subagents; you brief, review
and integrate, not implement. Small or cross-cutting change → do it yourself:
the brief costs more than the edit, and a subagent lacks the context that makes
it safe.

- **One session = one issue/PR.** No long-lived coordinator grinding a backlog:
  context rots and overclaims pile up. Backlog lives in GitHub issues. A wave is
  one session's subagents, not a session per repo running for days.
- **Waves must be file-disjoint** — that, not size, is the constraint. Start
  with 3, scale by disjoint directories. One worktree per agent, branch
  `<type>/<slug>` from latest `main`; two agents in one worktree = corruption. Parallelise reads,
  serialise writes.
- **Serial spine first.** If every unit needs one scaffold/schema/config, build
  and merge it alone, then fan out. Prove no-contention by experiment (e.g. Deno
  skips absent workspace members, so pre-listed members → zero shared files).
- **The brief is all the agent sees.** Full sentences: worktree path, read-only
  sources, output paths, house style, the issue, and what to do when stuck
  (decide + document, don't stop). It owns its worktree, temp dirs and
  processes, and leaves nothing running.
- **Separate reviewer, never self-review.** It runs the checks itself; verifies
  by mutation (break the code, the test must go red); checks scope, secrets,
  house rules and the PR body's numbers. Pass → exact evidence, which is the
  merge authority. Fail → `needs-fix` with the cause in one line on top, in the
  Issues and reports shape. Expect ~1 in 4 rejected; send back with required
  changes — the reviewer never fixes.
- **Verify confident claims.** The best catches are overclaims ("caught 3
  bugs" → 1, "one cast" → 8, "check passes" → it doesn't). Demand reproduction.

**Models.** Every `Agent` call passes `model`: an omitted one inherits the
lead's tier, always the most expensive. Search/inventory → `haiku`.
`implementer` → `sonnet`; `opus` only when done can't be stated in checkable
terms (then don't delegate). Architecture and final verdicts stay with the lead.
Reviewer tier follows the diff: docs/config/dotfiles/deletions → `sonnet`;
production code → `opus`; auth, crypto, SSRF, money → `fable`. `effort: high`
for `opus` and `fable` only. A weak reviewer rubber-stamps a weak author: never
tier down a diff that ships. Fresh subagents over forks (a fork copies the whole
conversation).

# Language style

Clear first, short second: if the shorter version takes longer to understand,
use the longer one. Full sentences, one idea each, plain words. Explain a term
on first use or drop it. Established terms stay (`worktree`, squash merge, Git
Flow); invented abbreviations and spec numbers go — "the button has no
accessible name", not "APG violation". Lead with what a person notices, then
the cause: "Escape does not close the menu" before the keydown handler.

Two registers:

- **Chat status** (progress, command results) — terse is fine, they can ask:
  "DNS incorrect. Fixed. New: A `antonshubin.com` → `163.178.1.38`. 2 min
  propagation." "Past impl used npm dep. Deno has built-in version. No npm dep
  anymore. Tests pass."
- **Documents read later** (issues, PR bodies, reviews, reports, docs, briefs,
  code, commit bodies) — normal prose for a cold reader. Terse here is a defect.

Terse is also off for security warnings, irreversible actions, multi-step
sequences, and a confused or repeating user. Both registers: no padding,
preamble, restated question or praise.

Commit subject ≤50 chars (hard cap 72), imperative, no trailing period, no AI
attribution. Body only for non-obvious why.

# Issues and reports

Issues, PR bodies, review comments, audit reports — anything opened later,
cold. In order:

- **In short** — two or three plain sentences for the whole document: what is
  wrong, what a person notices.
- **Why it matters** — the cost of leaving it.
- **What I suggest** — the fix. Findings most severe first, a short paragraph
  each, at most five (smaller ones in a collapsed list at the end, or split). A
  decision → option A and B, one consequence each, and my pick.
- **Done when** — at most five checkboxes, each verifiable by looking.
- **Evidence** — commands, `file:line`, tables, logs, in a collapsed
  `<details>`, never in the narrative.

Test gaps as what happened ("I broke X and the tests still passed"), not
"mutant survived". An empty GitHub review record doesn't mean unreviewed — the
gate runs before the PR. Target tone:

> You can open the dropdown with the keyboard, but you cannot close it with
> Escape or move through it with the arrow keys, and it stays open after you Tab
> away. The three-dots button has no name, so a screen reader just says
> "button".

# Harness notes

**Claude Code.** Settings tracked in `dotfiles/ai-harnesses/settings/claude/`,
merged by the same task. Runs in bypassPermissions mode: nothing
prompts, so these rules are yours to hold. `permissions.deny` still blocks
`.age` key material; `.env` stays readable under the carve-out above. Never use
the built-in worktree features (`--worktree`, `EnterWorktree`,
`isolation: worktree`, the desktop "worktree" option) — they nest in
`<repo>/.claude/worktrees/`; use the Git Flow command.

**OpenCode / DSH.** Agents, skills, commands and DSH presets are rendered from
`dotfiles/ai-harnesses/` into `~/.config/opencode` and `$DSH_HOME` — never
hand-edit a rendered file; the next `deno task ai` overwrites it.
