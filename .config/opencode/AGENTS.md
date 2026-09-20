Laconic by default. English only. Angular Conventional Commits (title +
body = what + why, not how). Laconic means fewer ideas and fewer words per
idea — never broken sentences or shorthand the reader must decode. Don't
narrate tool calls.

# Layering

Global default. Repo-local `AGENTS.md` adds constraints or overrides.
Conflict → repo wins for that repo.

One source for every harness: `dotfiles/.config/opencode/AGENTS.md`.
`deno task sync-agents-md --apply` copies it to OpenCode, DSH and Claude Code
(`~/.claude/CLAUDE.md`). Edit the source, never a copy.

# Stack

Deno 2 + Hono + Fresh + Preact + syncthing + restic. Hetzner BM/VM, Docker
Compose per project. DB per project: SQLite + Litestream or Postgres —
scaffolding a new project → ask which, never assume.
Shared: Traefik, VictoriaMetrics, Woodpecker CI, Watchtower, Syncthing,
NTFY, Gatus, Authelia.

Cost-aware, no wallet-attack risk third party like serverless functions.
BM/VM with fixed price/mo (Hetzner BM/VM) or usage-based with hard caps
configurable or prepaid (ex: DeepSeek API).

**Deps: own the small, keep the huge.** Platform (browser/Deno) APIs first, then
modern std. Own anything small and opinionated whose opinion isn't ours — UI
components especially (no shadcn/Radix/Headless UI/Material/Chakra), but the rule
is general: if we'd fight its defaults, we write it.

Keep the giant, well-solved ones — writing them right is a project in itself:
postgres.js, arktype, preact, wouter, tailwind, `@std/*`, signals, hono,
qrcode, webpush, otpauth, playwright, ioredis, fresh, vite, d3, leaflet.
Also an SMTP lib and a date/tz lib. Never reimplement these.

Libraries are **design intent sources, never code sources** — port markup and
behaviour, not the dependency. Prefer platform primitives (`<dialog>`,
`<details>`, `Intl`, `crypto`, `URL`, `structuredClone`) over JS
reimplementations. Owning a component means owning its accessibility: hand-write
roles, labels, keyboard handling, focus.

# Session bootstrap

New repo, before first edit, read in parallel: repo-local `AGENTS.md` (skip
if the harness preloaded it), `README.md`, manifest (`deno.jsonc`/
`package.json`/etc) for exact task names, lint/fmt config. Everything else —
other root `*.md`, `docs/`, runtime (`compose.yml`/`Dockerfile`), hooks — on
demand, when the task touches it. Eager-reading a whole `docs/` tree burns
context on specs the task never needs. Never guess a command the manifest
defines. Greenfield with none → say so. New worktree of a known repo → no
re-read.

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
`~/sync/code/ai-memory/incidents/rotation-log.md` (event only, never the value). Edit-after-ship = theater.

# Fail-open

Non-critical external calls (monitoring/reporting/analytics) → `|| true`.
Secret-bearing sends fail-closed (see Hard rule).

# Git Flow

Worktree first (sibling `worktrees/<repo>/`, never inside repo — repo tooling
walks the tree and sweeps nested checkouts into fmt/type-check). Already in a
linked worktree (`.git` is a file) → work there, never nest. Else:

```bash
MAIN=$(realpath "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")
WT="$(dirname "$MAIN")/worktrees/$(basename "$MAIN")/<type>/<slug>"
git fetch origin && mkdir -p "$(dirname "$WT")" && git worktree add -b <type>/<slug> "$WT" origin/main
```

Branch `<type>/<short-kebab-slug>` from latest default branch on the remote. PR always exists; `[WIP]` prefix until done.
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

**A green local run is not CI evidence.** Local passes hide env assumptions
(`$HOME`, `DENO_DIR`, cache paths). Emulate CI before claiming green:
`CI=true DENO_DIR=$(mktemp -d) <check command>`. Never assert a path under
`$HOME` — resolve through the tool (`import.meta.resolve`) or injected config.
A test that can silently skip when its dependency is missing will — fail loudly.

# Memory

`~/sync/code/ai-memory/`, on demand only:
- `profile.md` — who I am, how to work with me, how I sell, goals. Read it
  first in any session that is not a plain coding task: planning, writing,
  marketing, reviewing my work or direction. Skip it for routine coding.
- `TASKS.md` — the ordered task list. Read when asked what is next or whether
  something fits the plan.
- `situation.txt` — strategy, priorities, budget. Read when the task touches
  them (what to build next, stack/vendor choice), not for routine coding.
- `incidents/` — postmortems + standing rules. Read when working in an area
  that had one (containers/SELinux, secrets, deploys).
- `user.txt` — **personal. Never read it unless the user says to in this
  session.** A coding task is never a reason.

Durable project knowledge → the repo (`AGENTS.md`, `docs/`): git-synced and
visible to every harness. Harness-local memory only for facts no repo owns.

# Experimental

Use `~/.config/opencode/skill-state.md` for a flow. Opt-in per task; skip
for exploratory/creative work. State at `.skill-state/` (gitignored in the
worktree). Helpers: `~/sync/code/skill-state/` (github.com/spy4x/skill-state,
private).

# Subagent orchestration

Volume work (3+ file-disjoint units) = parallel subagents; you are
architect/coordinator: brief, review, integrate — don't implement. Small or
cross-cutting change → do it yourself: a brief costs more than the edit, and a
subagent sees none of the context that makes the change safe.

**Issue-scoped sessions.** One session = one issue/PR, closed out when the PR
is ready. No long-lived per-repo coordinator grinding a backlog: context rots,
every turn re-pays the whole history, and overclaims stack up unreviewed.
Backlog state lives in GitHub issues, never in a session. A wave is one
session's subagents, not a session per repo running for days.

**Wave sizing.** N agents per wave, one package/directory each. Wave is safe
only when items are **file-disjoint** — that, not size, is the constraint.
3 is a proven-good first wave; scale by disjoint directories, not confidence.

**Worktree per agent**, branch `<type>/<slug>` from latest `main`. Disjoint
working trees = no stash/checkout races. Same worktree for two agents = corruption.

**Prompt = complete brief.** Agent sees nothing of this conversation. Include:
worktree path, sources (read-only), output paths, house style, the issue, and
"what to do if stuck" (decide + document, don't stop). Enough detail that it
never explores the repo for context, and written in full sentences — a brief is
read cold, so shorthand there costs a whole agent run.

**Front-load the serial spine.** If every unit depends on one thing (scaffold,
schema, base config), build it first, alone, and merge it. Then parallelise.
Otherwise N agents invent N incompatible versions.

**Prove the no-contention property, don't assume it.** E.g. Deno skips absent
workspace members, so pre-listing every package dir means each agent's PR
touches zero shared files. Verify such a claim experimentally before relying
on it for parallelism.

**Separate reviewer agent, never self-review.** Instruct it to:
- run the checks itself; a claimed green run is not evidence
- **verify by mutation** — break the implementation, confirm the test goes red.
  A test that passes either way is worse than no test
- check scope, secrets, house rules, and whether the PR body's numbers match
  reality
- on pass: post exact evidence. Merge **only when the user delegated merge
  authority for this run** — orchestration never implies it, Git Flow's
  explicit user "merge" still binds. On fail: `needs-fix` + exact evidence
- write the verdict in the Issues and reports shape — it is read cold, by a
  person who was not in the run
Rejection is a normal outcome, not a failure. Expect ~1 in 4. Send back with
precise required changes; never let the reviewer fix it.

**Verify claims, especially from a confident report.** The highest-value catches
are overclaims: "the suite caught 3 bugs" (it caught 1), "one cast" (there were
8), "check passes" (it doesn't). Demand the reproduction.

**Model/effort.** Match tier to judgment needed, not to volume. Search and
inventory → cheapest (Claude: `haiku`). Briefed implementation → mid
(`sonnet`). Reviewer → strong (`opus`; `fable` for auth/crypto/SSRF/money) —
catching an overclaim is judgment, and a weak reviewer rubber-stamps a weak
author. Architecture and final verdicts stay with the lead. Prefer fresh
`subagent` over forking — forking copies the whole conversation into every
child and multiplies input cost.

**Parallelise reads, serialise writes.** Concurrent agents may read the same
sources; never let two write one file or one repo's config.

# Language style

**Clear first, short second.** If the shorter version takes the reader longer to
understand, use the longer one. Brevity is a way to be clear, never a licence to
be unclear.

Write full sentences. One idea per sentence. Prefer plain words to jargon:
explain a term the first time it appears, or drop it. Name the thing rather than
its abbreviation — write "the button has no accessible name", not "APG
violation"; write "the contrast rule for icons and controls", not "WCAG 1.4.13".
Established terms the reader already uses are clear and stay: `worktree`, squash
merge, Git Flow. A senior doesn't explain Git Flow with prose, they use the term
— but an invented abbreviation or a spec number is not a term, it is a lookup
the reader has to do.

Say what a person would notice first, then the cause. "Escape does not close the
menu" before "the keydown handler never compares against `Escape`".

Two registers, and the difference matters:

**Chat status** — progress notes, the result of a command, anything the user
reads while the session is open. Short, may be terse; they can ask a follow-up.
These example lines are for this register only:

"Function refactored. Shorter, faster, less bug opportunity. Tests pass."
"DNS incorrect. Fixed. New: A `antonshubin.com` → `163.178.1.38`. 2 min
propagation." "HA OOM due to docker compose limit for container.
Increased to 512M. No OOM detected over 10 min — stable." "Past impl used
npm dep. Deno has built-in version. No npm dep anymore. Tests pass."

**Documents read later** — issues, PR bodies, review comments, reports, docs,
subagent briefs. Normal prose, written for someone who was not in this session
and cannot ask what a fragment meant. Terse register here is a defect, not a
style. Shape them as in [Issues and reports](#issues-and-reports). Code and
commit bodies are normal prose too.

Terse chat status is also off for: security warnings, irreversible actions,
multi-step sequences, and any time the user repeats themselves or looks
confused.

Keep in both registers: no padding, no preamble, no restating the question, no
praise.

## Commit subject

Subject ≤50 chars, hard cap 72. Imperative (`add`, not `added`). No
trailing period. No AI attribution. Body only for non-obvious why.

# Issues and reports

Covers GitHub issues, PR bodies, review comments and audit reports — anything a
person opens later, cold. Shape, in this order:

- **In short** — two or three plain sentences: what is wrong, and what a person
  notices when it happens.
- **Why it matters** — what it costs to leave it as is.
- **What I suggest** — the fix. When it is a decision, give option A and option
  B with one consequence each, then say which one I would pick.
- **Done when** — at most five checkboxes, each one verifiable by looking.
- **Evidence** — commands, `file:line`, tables, logs. Inside a collapsed
  `<details>` block, never mixed into the narrative above.

One **In short** covers the whole document, not one per finding. The findings
themselves go under **What I suggest**, most severe first, a short paragraph
each; their `file:line` and the commands that prove them go in the evidence
block.

At most five findings in the body; put the smaller ones in a collapsed list at
the end. Twelve findings in one issue is not thoroughness, it is an unreadable
issue: split it, or drop the small ones.

Describe a test gap as what actually happened — "I broke X and the tests still
passed" — not "mutant survived".

Never infer "unreviewed" from an empty GitHub review record. The reviewer gate
runs before the PR is opened, so GitHub has nothing to show.

Target tone:

> You can open the dropdown with the keyboard, but you cannot close it with
> Escape or move through it with the arrow keys, and it stays open after you Tab
> away. The three-dots button has no name, so a screen reader just says
> "button".

# JSDoc

JSDoc on non-trivial or >10-line functions/classes/interfaces.

# Harness notes

**Claude Code.** Config tracked in `dotfiles/.claude/` (settings, agents,
skills), copied to `~/.claude/` by the sync task. Runs in auto mode: no
per-command prompts, judgment is yours — so the rules above are yours to hold,
nothing enforces them. Never use the built-in worktree features (`--worktree`,
`EnterWorktree`, `isolation: worktree`, the desktop "worktree" option): they
nest the checkout in `<repo>/.claude/worktrees/`. Create worktrees with the
Git Flow command. Agents: `reviewer` (read-only), `implementer`. Built-ins
cover the rest: Plan, Explore, `/code-review`, `/security-review`.

**OpenCode / DSH.** Agents in `.config/opencode/agents/`, commands in
`opencode.json`. DSH presets and skills are generated — `tools/gen_dsh.py`,
`tools/gen_dsh_skills.py` — never hand-edit `.dsh/`.
