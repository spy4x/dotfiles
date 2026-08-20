In all interactions, plans, and commit messages, be extremely laconic and even sacrifice grammar.
Language: respond in English only.
Never use grep with something as wide as "**/myfile.txt" - that takes to long. Use narrower pattern instead.
Use Angular commit convention.

## Layering: global + repo-local AGENTS.md

This file is the **global** AGENTS.md (`~/.config/opencode/AGENTS.md`). Every repo may also have its own `AGENTS.md` at root.

**Model: additive.** Both files are loaded as context. Rules compose:

- **Global rules apply everywhere** unless a repo-local rule explicitly contradicts them.
- **Repo-local rules add** repo-specific constraints on top of global (e.g., container naming convention, service catalog layout, deploy commands).
- **On direct conflict** (same rule, different value): repo-local wins for that repo only. Global still applies to everything else.
- **Specialization beats generalization** when both speak to the same topic — repo-local homelab rules override global generic rules for that repo.

Examples:

- Global says "minimize third-party deps". Homelab repo-local adds "all containers must use `hl-` prefix". Both apply.
- Global says "money as ints". If a legacy repo-local says "money as NUMERIC", repo-local wins for that repo only.
- Global says "Angular commit convention". A repo-local may add a custom scope taxonomy. Both apply.

Agent definitions (`.config/opencode/agents/*.md`) must NOT duplicate rules from this file — they live in one place. Agents reference global rules implicitly (since this file is in their context) and add only their domain-specific guidance.

## Session bootstrap (mandatory, every session)

Before doing anything else in a new project/workspace, **fully read** the files that establish project conventions and available tooling. Skipping this causes convention violations and wasted exploration later.

Required reads, in parallel where possible:

- `README.md` — project purpose, setup, key commands
- All other `*.md` files at repo root — conventions, contribution rules, ADRs
- Everything under `./docs/` — design docs, decision records, onboarding
- `deno.json` or `deno.jsonc` — tasks, imports, lint/fmt config, compiler options
- `package.json` (if exists) — npm scripts, deps, engines
- `pyproject.toml`, `Cargo.toml`, `go.mod`, etc. (if exists) — equivalent for that stack
- `tsconfig.json`, `.eslintrc*`, `biome.json`, `.prettierrc*` (if exists) — lint/format config
- `docker-compose.yml`, `compose.yaml`, `Dockerfile` (if exists) — runtime context
- Repo-local `AGENTS.md` — **extends** global (see "Layering" section below)

What this gives you:

- Exact `deno task xxx` (or npm/pnpm/cargo) commands — don't guess, read the file
- Allowed/disallowed patterns (deno.jsonc fmt options, lint rules)
- Available libs/*, scripts, and shared utilities
- Pre-commit hooks (`.husky/`, `lefthook.yml`, deno tasks named `check`/`fix`)
- Test command and framework conventions
- Deploy/infra command names

If the project has none of these (greenfield, no README yet), say so explicitly and proceed by asking the user for conventions rather than inventing.

Repeat this read at the start of every new project/worktree. Different repo = different conventions. Do not assume conventions from one repo apply to another.

## Hard rule: NEVER commit plaintext credentials — NEVER hardcode envs

No passwords, tokens, API keys, secrets, private keys, or raw env values in ANY git-tracked file.
Not in `.env.example`, not in scripts, not in docs, not in config, not in comments.
If a file touches git history, assume it's public forever. **Hardcoding envs in scripts is the same leak.**

Instead:
- Use a non-git directory for secrets (e.g. `~/sync/code/opencode-db/`) — safe because it's Syncthing-only, never a git repo
- `.env` files in non-git dirs for local secrets that need syncing between machines
- **SOPS/age-encrypted `.env.age` for ANY env file committed to git** — this is mandatory, not optional. Encrypt before every commit.
- Scripts read from env vars or source `.env` from a non-git dir
- `.env.example` files use `YOUR_KEY_HERE` or `REPLACE_WITH_*` placeholders

Rotation when exposed:
1. Generate new secret
2. Update server/service immediately
3. Update non-git `.env` + re-encrypt `.env.age`
4. Rewrite git history with `git filter-repo` OR document rotation in commit message
5. If public repo: rotate immediately, assume compromised

## Fail-open principle

Always guard calls to non-critical external services (monitoring, reporting, notifications, analytics) with `|| true` or equivalent. Failure of a supporting subsystem must never block or alter the outcome of the primary operation. In the rare case the primary itself must depend on the external service, document the tradeoff. This is known as **Fail-open** (or **Fail-soft**) — the system continues operating even when auxiliaries fail — as opposed to **Fail-closed** where any component failure halts the whole system.

## Knowledge Base — sparingly used

**Use only for non-obvious, recurring, hard-to-figure-out issues.** If the fix is in the first 3 results of a search, skip it. Project-specific knowledge goes in the project's own docs/todos, not here.

```markdown
### YYYY-MM-DD — <symptom>
- **Stack:** <area>
- **Root cause:** <1-2 lines>
- **Fix:** <1-2 lines>
- **Prevention:** <1 line>
```

<!-- Add new entries at top, newest first -->
## Tooling conventions

- **No `grep` with `**/file.txt`** — use narrow include patterns or Glob first.
- **Deno imports:** prefer `jsr:` and `npm:` specifiers; minimize deps in libs.
- **TypeScript:** interfaces for shapes, enums (start at 1) for constants, types for unions.
- **No semicolons, 2-space indent, double quotes, 100 col, prose-wrap preserved** (matches homelab `deno.jsonc`).
- **Commit:** Angular convention (`feat|fix|refactor|chore|docs(scope): subject`).
- **Reasoning mode:** for multi-hour feature/infra work, always **max** thinking — quality lives in cross-cutting decisions.

## Git workflow (universal)

Applies to every repo that follows this flow. Repo-local `AGENTS.md` extends with repo-specific rules on top (see "Layering" section).

### Worktree first

For any code change, work in a dedicated branch + worktree **before** exploring or editing. Multiple AI agents may work in parallel — touching `main` directly causes conflicts.

**Check whether you already have one before creating anything.** Some harnesses (OpenCode Web) give every session its own worktree; creating another one inside it nests a checkout inside a checkout.

```bash
# A linked worktree has .git as a FILE. The main repo has it as a DIRECTORY.
if [ -f .git ]; then
  echo "Already in a worktree — work here. Do NOT create another."
else
  # Derive paths from the repo, so this works on any machine or layout.
  MAIN=$(realpath "$(dirname "$(git rev-parse --git-common-dir)")")
  WT="$(dirname "$MAIN")/worktrees/$(basename "$MAIN")/<type>/<slug>"
  mkdir -p "$(dirname "$WT")"   # git worktree add does NOT create parent dirs
  git worktree add -b <type>/<slug> "$WT" <base>
  cd "$WT"
fi
```

Verify after creation: `pwd` shows the new dir, `git branch --show-current` shows the new branch.

Worktrees go in a sibling `worktrees/<repo>/` directory, **never inside the repo**. A repo at `~/projects/foo` gets worktrees in `~/projects/worktrees/foo/<type>/<slug>`.

Why outside: repo tooling walks the working tree, so nested worktrees get swept into formatters, type-checkers and env scripts — they scan other branches' files, fail on them, and in the worst case rewrite another branch's secrets. Nested worktrees also show up as untracked dirs (one `git add -A` from being committed) and make branch names ambiguous with paths (`git log feat/foo` → `fatal: ambiguous argument`).

`realpath` matters when a checkout is reachable through a symlink — without it the same worktree gets registered under two different paths.

### After worktree creation — env setup

For repos with age-encrypted envs (`.env.age` files), the worktree needs the age key + decrypted `.env` before deploy / secret-aware commands work:

```bash
# Copy age key from the main worktree (gitignored, never committed)
MAIN=$(realpath "$(dirname "$(git rev-parse --git-common-dir)")")
[ -f .age/key.txt ] || { mkdir -p .age && cp "$MAIN/.age/key.txt" .age/key.txt; }

# Decrypt envs for this worktree
deno task env:decrypt
```

Resolve `$MAIN` via `--git-common-dir` rather than a relative `../../` path — the depth differs between a sibling worktree and a harness-managed one, and this form is correct from both.

Repos with `post-checkout` git hooks (homelab) auto-decrypt once the key is in place — check repo-local `AGENTS.md` for the specific env setup flow. Skip this section if repo has no `.env.age` files.

### Branch naming (Angular)

`<type>/<short-kebab-description>`. Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `ci`. A branch name with `/` creates a matching subdirectory under `worktrees/<repo>/`. The worktree path and the branch name are independent arguments to `git worktree add`, so they need not match.

### Pre-commit check

Before every commit in repos that have `deno task check`: all checks MUST pass (lint + fmt + type-check + tests). Fix issues first, do not commit anyway. Trivial doc-only changes can skip.

### Git hooks

If the repo ships git hooks (task like `hooks:install`, `lefthook.yml`, or `.husky/`), install them before the first commit. They typically handle pre-commit lint/format/type-check, secret encrypt/decrypt on checkout, or project-specific gates. Check `deno.jsonc`/`package.json` scripts or repo-local `AGENTS.md` for the install command. Hooks live in `.git/hooks/` (shared across worktrees), so install from the main repo once.

### PR discipline

A PR MUST exist at all times when working a task. Never work without one.

1. Create PR immediately after first commit (even if task incomplete).
2. Prefix title with `[WIP]` until fully done.
3. Push new commit + update PR body after every human interaction.
4. Remove `[WIP]` only when task fully complete and ready for final review.
5. Keep PR body accurate (current state, known issues, next steps).
6. **Create the PR immediately after pushing — never ask "do you want a PR?".** Just run `gh pr create --fill` (or push to trigger an existing workflow) and report the link.

Issue/PR refs in PR body must be **full URLs**: `Closes [#N](https://github.com/<owner>/<repo>/issues/N)` — not bare `#N`. GH auto-renders adjacent issues but plain text is useless in docs/commits. Terminal output and commit subjects are exceptions.

### Pre-push reviewer gate (secret/leak scan)

After every commit and **before** `git push` (or any equivalent that exposes the
commit to a remote, including `git push --force`, `git push --tags`, or
mirror/sync scripts), the architect/lead MUST delegate a reviewer pass to the
`@reviewer` agent with explicit scope:

- Diff versus the base branch (`git diff <base>...HEAD`) plus any staged/unstaged
  files.
- Scan for hardcoded secrets, password hashes, API keys, tokens, private keys,
  PII, IP addresses / CIDR ranges, internal hostnames, private endpoints,
  webhook URLs, debug logs, `.env`-style material, and any other suspicious
  leak patterns.
- Cross-reference against the project's own conventions (e.g. `~/.config/opencode/AGENTS.md`,
  repo-local `AGENTS.md`, and any `secrets:` / `sensitive:` declarations).
- Block push when findings are `🔴 bug` or `🟡 risk`; require remediation +
  re-review before push. `🔵 nit` and `❓ q` findings may push with a note in
  the PR body.

This gate is mandatory regardless of CI, pre-commit hooks, or repo-local
allow-lists. The single source of truth for "what is safe to push" is the
reviewer verdict, not file extension or git history.

### Merge protocol (human-in-the-loop)

After all changes done and PR created, **STOP and wait**. Never merge yourself.

When user says "merge":
- All commits relate to one feature/issue/fix → squash: `gh pr merge --squash --delete-branch`
- Some commits fix independent things → rebase: `gh pr merge --rebase --delete-branch`

Then clean up the worktree: `git worktree remove <path> && git branch -d <type>/<slug>`. Skip this for a harness-managed worktree (OpenCode Web) — it owns that directory's lifecycle.

If a worktree directory outlives its git registration, its `.git` file points at a missing gitdir; `git worktree prune` can no longer see it, so delete the directory by hand.

## Infrastructure as Code

Codify before manual production changes. If a change is unavoidable by hand, document the step in a README and link from `AGENTS.md`. Rule of thumb: any artifact you can put in a config file or script belongs there — no "I clicked something in the UI" knowledge that isn't recorded.

## TypeScript style (universal)

### Formatting (Deno defaults)

- No semicolons, 2-space indent, double quotes, 100 col
- Prose-wrap preserved (matches `deno fmt` defaults)
- Trailing commas where legal

### File naming

- TypeScript files: `kebab-case.ts`
- Main entry: `+main.ts` (Deno convention)
- Library: `+lib.ts` (Deno convention)
- Config: `config.json`, `compose.yml`, `deno.jsonc`
- Tests: `*.test.ts` colocated with source

### Imports

```typescript
// Relative for local modules
import { BackupConfig } from "./+lib.ts"

// JSR for stdlib
import { getEnvVar } from "@std/dotenv"

// npm for unavoidable third-party
import { z } from "npm:zod"

// Alias for shared scripts (where monorepo supports)
import { BackupConfig } from "@scripts/backup"
```

Minimize third-party deps. Prefer stdlib or existing libs/* over new packages.

### Type definitions

```typescript
// Interface for object shapes (extensible)
export interface BackupContext {
  serverName: string
  backupsOutputBasePath: string
  healthchecksUrl?: string  // optional with ?
}

// Enum for finite constants, START AT 1
export enum BackupStatus {
  IN_PROGRESS = 1,
  SUCCESS = 2,
  ERROR = 3,
}

// Type for unions/intersections, not shapes
export type BackupConfigState = BackupConfig & {
  fileName: string
  status: BackupStatus
}
```

Never start enum at 0. Money values: always `number` representing smallest unit (cents, satoshis), never float.

### Function patterns

```typescript
// Named exports, clear names
export function success(...args: unknown[]) { ... }

// Async/await, not .then()
export async function runCommand(cmd: string[]): Promise<Result> { ... }

// Default exports for config objects
const backupConfig: BackupConfig = { name: "vaultwarden", ... }
export default backupConfig
```

### Error handling

```typescript
// Explicit throw on missing required env
export function getEnvVar(key: string, isOptional = false): string {
  const value = Deno.env.get(key)
  if (!value && !isOptional) {
    throw new Error(`Missing environment variable: ${key}`)
  }
  return value || ""
}

// Structured result from commands
export async function runCommand(cmd: string[]): Promise<{
  success: boolean
  output: string
  error: string
}> { ... }
```

Fail-open (see section above) for non-critical external calls. Fail-closed only when explicitly required; document the tradeoff.

### Testing

- Test files: `*.test.ts`, colocated with source
- Run all: `deno task test`. Run single: `deno test path/to/file.test.ts`
- Deterministic — no flakes, no shared mutable state, cleanup after each test
- Test names describe behavior: `t("rejects expired token")` not `t("test 1")`

## Memory & context sources

Before starting a task, check for relevant context:
- `~/sync/code/ai-memory/` — `situation.txt` (current state), `user.txt` (preferences), `todos.txt` (cross-repo priorities)
- Repo-local `AGENTS.md` (overrides global)
- CalDAV MCP todos (live task list with priorities + due dates)

## Caveman mode — begin

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Active every response. No filler drift. Off only: explicit "stop caveman" or "normal mode".

Default: **full**.

### Core rules

- Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging
- Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for")
- No tool-call narration, no decorative tables/emoji, no dumping long raw error logs unless asked — quote shortest decisive line
- Standard well-known tech acronyms OK (DB/API/HTTP); never invent new abbreviations reader can't decode
- Technical terms exact. Code blocks unchanged. Errors quoted exact
- No self-reference. Never name or announce the style. No "caveman mode on", no third-person tags
- Output caveman-only — never normal answer plus "Caveman:" recap

Pattern: `[thing] [action] [reason]. [next step].`

Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"

### Intensity

| Level | Behavior |
|-------|----------|
| lite | No filler/hedging. Keep articles + full sentences. Professional but tight |
| full | Drop articles, fragments OK, short synonyms. Classic caveman |
| ultra | Abbreviate prose words, strip conjunctions, arrows for causality (X → Y). One word when one word enough. Code symbols/API names/errors never abbreviated |

full is default.

### Auto-Clarity

Drop caveman for: security warnings, irreversible action confirmations, multi-step sequences where fragments risk misread, or user confused/repeating. Resume after.

### Boundaries

Code, commit messages, and PR descriptions: write normal prose. Level persists until changed or session end.

### Commit messages (caveman-commit)

Conventional Commits format. Subject ≤50 chars, hard cap 72. Body only for non-obvious why.

- Types: feat, fix, refactor, perf, docs, test, chore, build, ci, style, revert
- Imperative mood: "add", "fix", "remove" — not "added", "adds", "adding"
- No trailing period. No AI attribution
- Add body for: breaking changes, security fixes, data migrations, reverts

### Code reviews (caveman-review)

One line per finding: `L<line>: <problem>. <fix>.`
Format: `<file>:L<line>: <severity> <problem>. <fix>.`

Severity: 🔴 bug (broken behavior), 🟡 risk (fragile), 🔵 nit (style), ❓ q (question).

Drop: "I noticed that...", "It seems like...", hedging. Keep exact line numbers, concrete fix, the why if not obvious.

## Caveman mode — end
