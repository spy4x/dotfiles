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
- a revert can't undo it: destroying data, rotating a secret, messaging
  customers, deleting the only copy;
- the reviewer gate fails twice on the same cause — the brief is wrong.

A question costs my attention; a wrong reversible guess costs one revert. Prefer
the revert.

Releases are not questions. I build in public and ship often: once the gate is
green, tag, publish to the registry (JSR, npm) and deploy `main` without asking,
and say so in the report.

**Picking work yourself** (a wave, "work through the backlog"): only open
issues labelled `ready`. I apply that label; never add it yourself. Stuck on a
decision → comment on the issue in the Issues and reports shape (option A and
B, one consequence each, your pick), add `needs-decision`, and move on to other
`ready` work. I answer in a comment and remove the label. We share one GitHub
account, so start every comment you post with `<!-- agent -->`: a comment
without it is mine. A usage limit pauses a wave; it does not end it, so don't
wrap up or ask me. Nothing is sure to restart it: background agents fail at the
limit, and a weekly limit resets days later. When the session runs again, first
resume every agent that failed with `SendMessage`. Its conversation survives a
reboot; its `/tmp` files do not.

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

**Shared libs before local code.** In any `spy4x/*` TypeScript repo, before
writing a component, helper or library, check `spy4x/ts-libs` and
`spy4x/preact-components`. Already there → import it, never duplicate it. Not
there but reusable by other TypeScript projects → add it to the fitting shared
repo first, then import it from there. The final report lists every addition to
those repos.

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

# Sudo

Every agent may run `sudo` on this machine. It is passwordless and unrestricted,
so use `sudo -n` (it fails instead of hanging on a prompt) and only for what the
task needs. The final report lists every `sudo` command you ran and why.

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

Always close browser contexts at the end of a lane, including on the failure
path. A failed lane that leaks a browser is worse than a failed lane.

Never `rm -rf` a variable path from a command line, guarded or not: the harness
stops for approval on it even in bypass mode, which stalls unattended work, and
an empty variable deletes from `/`. Delete with `find "$D" -delete` (it
removes the directory too), or `rm -rf` a literal path. Each agent keeps its
scratch files in its own `mktemp -d`, never in a directory another agent shares.
Never `find /`; search the directory that can hold the answer.

**Cap anything that spawns processes** (tests with fake binaries, fan-out
scripts, a lane's test run) so a runaway stops at the cap. Once cost: a fake
`rsync` on `PATH` called `rsync` and found itself; 4,900 processes, 73 GB of RAM
and a crashed game within minutes.

```bash
systemd-run --user --scope --quiet -p TasksMax=500 -p MemoryMax=8G timeout 120 <cmd>
```

Never `ulimit -u`: it counts every thread the user owns (over 3,000 here), so
the first fork fails. Containers: `--pids-limit=500 --memory=8g`.

**Every wait has a deadline.** Once cost: an agent sat for almost seven hours on a
monitor for a run that had finished long before, and another waited on a run that
no longer existed. Nothing was running; the agents were simply never woken up.

- A background command (`run_in_background`) runs inside `timeout <seconds>`,
  sized to the job with slack (a browser test suite: 900).
- A `Monitor`, until-loop or poll gets a deadline and at most 3 attempts. When it
  expires, read the output or log directly and decide. Never re-arm the same wait.
- Before you wait on a process, check that it exists (`pgrep`, a growing output
  file). A wait past twice the job's usual time → check again; if nothing runs,
  read the result or rerun in the foreground.
- A retry stops after 3 attempts and is reported, with each failure's detail.
- A subagent that says it is waiting names what it waits on and the deadline.
- Lead: once a lane's PR merges or stops, stop that agent (`TaskStop`), so any
  wait it left behind dies with it. A lane that reports "waiting" while `pgrep`
  shows none of its processes is stuck: message it to read its results.

**Sweep before reporting done:** `~/sync/code/dotfiles/tools/sweep-orphans.sh`.
It lists this session's orphans; a subagent adds `--under <worktree> <scratch
dir>` and kills only what that lists. Empty output = clean. The lead's final
sweep adds `--all`, which shows other sessions' orphans too: report those, never
kill them. It misses Docker and `systemd-run --scope` (own cgroup): clean those
by name.

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
say so. Squash one feature → `gh pr merge <n> --repo <owner>/<repo> --squash
--delete-branch`. Rebase independent commits → the same with `--rebase`. Always
pass `--repo`: without it, gh tries to delete the local branch, fails while its
worktree exists, and skips the remote delete.

Post-merge cleanup always, unless told otherwise. `git worktree remove` first,
then `git branch -D`, remote branch delete if `--delete-branch` missed, temp dir `shred -u`, untracked subtree `find <path> -delete` before worktree
remove. Repo-wide: `git fetch --prune`, `git worktree prune`, `git branch -d`
merged-locally, orphan dir `find <path> -delete`, ff-only sync to origin/main,
orphan sweep.

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
D=$(mktemp -d) && trap 'find "$D" -delete' EXIT && CI=true DENO_DIR=$D <check command>
```

Never assert a path under `$HOME`; resolve through the tool
(`import.meta.resolve`) or injected config. A test that can silently skip when
its dependency is missing will — fail loudly.

A fake binary prepended to `PATH` never calls the real tool by name: resolve
its absolute path before changing `PATH` and pass it in an env var. Add a
recursion guard too: the fake sets a depth variable and exits non-zero when it
sees one already set.

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

`implementer-model` experiment: in a wave with two or more implementer lanes,
the second lane you spawn runs with `model: opus`; the rest stay on `sonnet`.
When each lane's PR merges or stops, add a row per lane to
`~/sync/code/ai-memory/experiments/implementer-model.md`, as that file says.

# Subagent orchestration

Volume work (3+ file-disjoint units) → parallel subagents; you brief, review
and integrate, not implement (except the small review fixes below). Small or cross-cutting change → do it yourself:
the brief costs more than the edit, and a subagent lacks the context that makes
it safe.

- **One session = one wave.** A wave is one coordinator session: a fixed list
  of issues, its subagents, and a handoff at the end. The next wave starts in a
  new session from that handoff. Never resume an old coordinator to run the next
  wave, write its prompt or answer a small question: resuming it rewrites its
  whole cache. The backlog lives in GitHub issues.
- **A running session keeps the rules it started with.** Claude Code reads this
  file when a session starts or compacts, and every subagent gets its lead's
  copy. Before each spawn, run `git -C ~/sync/code/dotfiles log --oneline
  --since=<wave start> -- ai-harnesses/`. If it prints anything, read that diff,
  follow it, and put the changed rules a subagent needs into its brief.
- **A wave's final report ends with a handoff:** the project's position (the
  plan, how much is done, what remains before the next milestone), what the next
  wave must not touch (open PRs, issues waiting on me), the next wave's prompt,
  ready to paste, with the position inside it, and what this wave cost: each
  agent's dollars, peak context and compactions
  (`deno run -A ~/sync/code/dotfiles/tools/session-cost.ts <session id>`) and
  the weekly usage percentage. Save the prompt as `.wave<N+1>/prompt.md` too. It
  holds only what belongs to that wave: the position, the issues, the lanes and
  the files each owns, the acceptance checks, and what not to touch. It never
  restates a rule from this file, such as model tiers, review limits or cleanup:
  a copied rule overrides the live one and goes stale.
- **Wave files live in `worktrees/<repo>/.wave<N>/`.** Briefs, rules files,
  verdicts and anything you need after a restart go there, never in `/tmp` or
  the session scratchpad: a reboot empties `/tmp`, and one agent's cleanup can
  empty the shared scratchpad. Agents never delete a `.wave<N>` directory; the
  lead deletes it once the handoff is posted.
- **Pace against the usage limits.** Before each batch of agents, run
  `claude -p /usage`. At 90% of the 5-hour or the weekly limit, start no new
  agent: let the running ones finish, post the handoff and end the turn. Plan a
  day's waves to use about a seventh of the weekly allowance. A limit that hits
  mid-review throws that review away.
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
- **Check this machine's CPU and RAM while running parallel work.** Rapid work
  on several projects in parallel sessions has left zombie processes, a RAM leak
  and similar problems. Report anything off (what, which process, how much); a
  separate session fixes the cause, so these get eliminated one by one.
- **Separate reviewer, never self-review.** It runs the checks itself; verifies
  by mutation (break the code, the test must go red); checks scope, secrets,
  house rules and the PR body's numbers. Pass → exact evidence, which is the
  merge authority. Fail → `needs-fix` with the cause in one line on top, in the
  Issues and reports shape; send back with required changes — the reviewer never
  fixes. Re-review after `needs-fix` → continue the same reviewer (`SendMessage`)
  with the fix: it remembers its findings, and its cache lasts an hour, so a
  second round within the hour costs a fraction of a fresh one. It still reruns
  the checks. A new PR, or a rework that rewrote most of the diff →
  a fresh reviewer. Never count or report rejections in a summary, PR body or
  issue: report what the review found and what changed.
- **Count before you spawn a reviewer.** Every test the diff adds or changes
  needs its `Mutation:` line in the PR body. A missing line goes back to the
  implementer without spending a reviewer.
- **At most three `needs-fix` verdicts per PR.** A wording-only fix, or one of
  about ten lines or fewer, is yours from the first round: apply it, show the
  test red then green, and have the same reviewer confirm. After the third
  verdict, do the same if about ten lines remain; otherwise leave the PR open
  with a comment on what is left, and move on.
- **Verify confident claims.** The best catches are overclaims ("caught 3
  bugs" → 1, "one cast" → 8, "check passes" → it doesn't). Demand reproduction.

**Models.** Every `Agent` call passes `model`: an omitted one inherits the
lead's tier, always the most expensive. Search/inventory → `haiku`.
`implementer` → `sonnet`, except the `implementer-model` experiment's lane;
`opus` only when done can't be stated in checkable terms (then don't delegate). Architecture and final verdicts stay with the lead.
Reviewer tier follows the diff: docs/config/dotfiles/deletions → `sonnet`;
production code → `opus`; auth, crypto, SSRF, money → `opus` too. `fable` is
paused: Opus 5.5 matches Fable 5.1 and is faster and cheaper, so use it nowhere
until I re-enable it. `effort: high` for `opus` and `fable` only. A weak
reviewer rubber-stamps a weak author: never tier down a diff that ships. Fresh
subagents over forks (a fork copies the whole conversation).

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
