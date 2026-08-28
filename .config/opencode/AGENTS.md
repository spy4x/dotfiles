Be laconic in interactions/plans/commits. Sacrifice grammar.
Language: English only.
No `grep` with `**/file.txt`. Use narrow patterns or Glob first.
Angular commit convention.

## Layering: global + repo-local AGENTS.md

This file = global (`~/.config/opencode/AGENTS.md`). Each repo may also have `AGENTS.md` at root. Model: additive.

- Global applies unless repo-local contradicts.
- Repo-local adds repo-specific constraints on top.
- Conflict (same rule, different value) → repo-local wins for that repo. Global still applies elsewhere.
- `.config/opencode/agents/*.md` does NOT duplicate rules from here. Agents reference global implicitly + add only domain guidance.

## Operating context (Aug 2026+)

- Cost-sensitive: hard ceiling €50-85/mo infra + $50-200/mo LLM subscription. No pay-per-token API except reserved Anthropic credits for hard problems.
- Stack: Deno 2 + Hono + Fresh + Preact + SQLite (per-project) + Litestream + syncthing + restic. Hosting: 1× Hetzner BM (auction EX-series), Docker Compose per project. Shared: Traefik, VictoriaMetrics monitoring (+NodeExporter, Cadvisor), Woodpecker CI, Watchtower, Syncthing, NTFY, Gatus, Authelia.

## Session bootstrap (mandatory, every session)

Before anything in new project/worktree, **fully read** in parallel:

- `README.md` + other `*.md` at root; `./docs/`
- Manifest: `deno.jsonc`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`
- Lint/format: `tsconfig.json`, `.eslintrc*`, `biome.json`, `.prettierrc*`
- Runtime: `docker-compose.yml`, `compose.yaml`, `Dockerfile`
- Repo-local `AGENTS.md` (extends global)

Get: exact commands, allowed patterns, libs, hooks, test + deploy conventions. Greenfield with none → say so, don't invent. Repeat per worktree.

## Hard rule: NO secrets — anywhere they leave box

No passwords, tokens, API keys, secrets, private keys, raw env values, JWTs, session IDs, mTLS certs, vault/AWS/GCP/Azure KV tokens, OAuth refresh tokens, SAML/Kerberos, WebAuthn, TPM keys, `.env`-style blocks, debug logs, stack traces, command output carrying secrets — anywhere they leave box.

**Two scopes, same rule.**

### A. In git-tracked files

- Hardcoding envs in scripts = same leak. `.env.example` uses placeholders (`YOUR_KEY_HERE`).
- `.env` lives in non-git dir (e.g. `~/.local/share/opencode/`, per-machine, NOT synced).
- **`.env.age` for any env committed to git → SOPS/age-encrypted. Mandatory.**

### B. In public/external artifacts

Anything on public/shared/non-local surface:

- **Code hosting**: Issues, PRs (title/body/comments), Reviews, Discussions, Gists, Releases/notes, Wiki, bot posts, email notifications, RSS.
- **Registries + build outputs**: Docker Hub, GHCR, Quay, public ECR, OCI labels/layers/build-args; `actions/upload-artifact`, public S3, release tarballs.
- **Webhooks + chat**: Slack, Discord, Teams, Mattermost, ntfy, IRC, SMS.
- **Trackers**: Jira, Linear, YouTrack, Shortcut.
- **Error reporting + telemetry**: Sentry, LogRocket, Datadog, OTel, browser telemetry, AI code-suggestion telemetry.
- **Public docs/sites**: blog, status pages, public READMEs, registry changelogs (npm/PyPI/crates.io), generated docs, Notion, Helm values in public OCI, Terraform state in public buckets.
- **Customer comms**: support replies, public forums, mailing lists, social (X/Mastodon/Bluesky/LinkedIn).
- **Public calendars**: Google Calendar public, shared CalDAV, public ICS.
- **Model-provider prompts**: provider logs user turns + subagent prompts + MCP tool inputs. Public surface unless contract proves zero-retention + no-train.
- **Public stdout/stderr**: CI logs, shared run logs, broadcast journald, cloud build logs.
- **Side channels (no send needed)**: OS capture (macOS cmd-shift-3/4, Windows Snipping, OBS, Zoom share, MDM recording, crash dumps); cloud-synced state (clipboard managers, terminal cloud, tmux-resurrect to S3, Syncthing to cloud VM, browser extensions, Playwright localStorage/IndexedDB); **dotfiles commits — this repo**.

"Public forever" extends to provider logs/eval datasets unless contract says otherwise. Retention TTL ≠ redaction.

**Overrides Fail-open principle** for secret-bearing sends (those fail-closed).

### Before sending — scrub protocol

1. **Redact.** Canonical placeholder: `<REDACTED:KIND>` (`KIND` = secret class: API_KEY, WEBHOOK_URL, JWT, IPV4...). Use `***` only when length preservation matters. Never mix forms in one artifact.
2. **Real-looking examples**: RFC 5737 IPs (`192.0.2.1`, `198.51.100.1`, `203.0.113.1`), IPv6 `2001:db8::/32`, RFC 2606 domains (`.example`, `.test`, `example.com`). Never real production values.
3. **If unsure, redact.** False positives cost nothing.
4. **Deterministic scanner before paste.** LLM self-scan misses partial keys, base64 blobs, prose-form passwords. Run `gitleaks detect --no-git`, `trufflehog filesystem <path>`, `detect-secrets scan`. Bar = scanner-clean + reviewer-clean.
5. **Forbidden tool outputs** (never paste raw; prefer don't invoke before public send): file dumps (`cat .env`, `cat ~/.config/<svc>/config`, `cat ~/.aws/credentials`, `cat ~/.ssh/id_*`, `cat ~/.netrc`, `docker inspect`, `journalctl`, `kubectl get secret -o yaml`); env dumps (`env`, `printenv`, `set`); secret-manager fetches (`vault read`, `aws secretsmanager get-secret-value`, `gcloud secrets versions access`, `op read`, `gh auth token`, `doppler secrets download`, `infisical secrets get`).
6. **Reviewer gate before public send.** Delegate to `@reviewer` with explicit scope. Show full intended body (title + body + every comment, full payload — never preview; previews hide truncation/code-fence escapes). Scan secrets, PII, IPs/CIDRs, internal hostnames, webhook URLs, debug logs. Block on 🔴/🟡; 🔵/� may proceed with note in rotation log only (not in artifact, where notes can themselves leak). **Verdict bound to artifact hash; any edit → re-review.** Mandatory regardless of pre-commit hooks, CI scanners, repo-local allow-lists.

### Tool reminders

- **`gh`**: scrub body before run. `--body-file` safer than `--body "..."` (shell history leaks) but not sufficient alone. Full recipe:

  ```bash
  BODY_DIR=$(mktemp -d) && BODY="$BODY_DIR/body.md"
  chmod 700 "$BODY_DIR"
  install -m 600 /dev/null "$BODY"   # create with mode 600, NOT redirected by umask
  op read "op://<vault>/<item>/notes" > "$BODY"   # or: vault read, aws sm, gcloud sm
  # never open in editor; never cat
  gh issue create --body-file "$BODY" --title "..."
  shred -u "$BODY" && rmdir "$BODY_DIR"
  ```
  Temp file still leaks via fs cache/swap. Assume compromised once on disk.

- **`gh gist create`**: public Gists can't be deleted, only orphaned. **Never** for secret content. Private Gists: treat URL as secret.
- **Webhook URLs = secrets.** Always `<REDACTED:WEBHOOK_URL>` in any example.
- **Stack traces** leak paths/users/hostnames/queries and (even without secrets) internal layout. Strip or replace with synthetic trace.
- **CI logs on public repos** = public. No `echo $SECRET`, no `cat .env` on PR-from-fork. `git commit -m "$SECRET"` puts value in reflog/objects/fsck/packed-refs. Use heredoc-from-file or stdin.
- **Build outputs**: `process.env.*` can serialize into client bundle/manifest/source maps. Build env must have no secret; secrets load at runtime via fetch.
- **`.env.example`** = documentation, not safe-to-paste. Placeholders only.
- **Screenshots / recordings / pasted logs** = public on attach. Attach only to allow-listed hosts (repo-local may define).
- **Bot PATs**: GitHub Apps + short-lived installation tokens > PATs. Minimal scope, rotate per-task, never commit (even to private repos).

### If leak shipped

Edit-after-ship = cosmetic, NOT mitigation, on surfaces that already delivered/indexed/fanned-out/replicated. Rotation = only effective response there.

1. **Rotate first.** Old value in attacker hands the moment artifact existed in any delivered state. Generate new secret before anything else; secret still in context leaks via every subsequent provider log.
2. **Stop further sends** of same artifact + same thread/release/batch/cascade.
3. **Update service** with new secret.
4. **Update non-git `.env`** + re-encrypt `.env.age`.
5. **Cascade.** Rotate every downstream credential potentially touched (OAuth refresh, signed JWTs, dependent tokens, webhook fan-out recipients). Notify recipients whose logs you no longer control.
6. **Access-log review**: provider audit, SIEM, secret-manager access log. Identify every read of leaked value; treat every consumer as compromised.
7. **Edit (cosmetic)** where allowed: `gh issue edit`, `gh pr edit`, `gh release edit`, `gh api`; `gh issue lock --reason "resolved"` to prevent reply-quoting; force-push branches whose commit message carried secret; `gh gist delete` (orphans only). On delivered surfaces (GH email sent, RSS polled, archive.org cached, Sentry paged, Slack pushed, npm immutable) edit = theater. Log it; don't represent as mitigation.
8. **Notify** affected parties (security advisory / disclosure). GDPR/CCPA may require user notification.
9. **Log** to `~/.local/share/opencode/rotation-log.md` (per-machine, NOT synced, NOT in git): surface, URL, secret class, exposure time, rotation time, cascade, notifications, follow-ups. New agents read it before any task on related surface.

Step 1 mandatory for any public repo/Issue/Release, customer-facing surface, vendor surface, indexed artifact — regardless of edit availability.

## Fail-open principle

Guard non-critical external calls (monitoring/reporting/notifications/analytics) with `|| true`. **Exception**: secret-bearing sends fail-closed (see Hard rule). Fail-closed only when explicitly required; document tradeoff.

## Knowledge Base — sparingly used

Non-obvious, recurring, hard-to-figure-out issues only. Fix in first 3 search results → skip. Project-specific knowledge goes in project docs/todos, not here.

```markdown
### YYYY-MM-DD — <symptom>
- **Stack:** <area>
- **Root cause:** <1-2 lines>
- **Fix:** <1-2 lines>
- **Prevention:** <1 line>
```

<!-- Add new entries at top, newest first -->

## Tooling conventions

- No `grep` with `**/file.txt`. Use narrow include patterns or Glob first.
- Deno imports: prefer `jsr:` and `npm:`. Minimize deps in libs.
- TS: interfaces for shapes, enums (start at 1) for constants, types for unions.
- Style: no semis, 2-space indent, double quotes, 100 col, prose-wrap preserved.
- Commits: Angular (`feat|fix|refactor|chore|docs(scope): subject`).
- Reasoning mode for multi-hour feature/infra work: always **max** thinking.

## Git workflow (universal)

### Worktree first

Code change → dedicated branch + worktree **before** exploring/editing. Multiple agents parallel → touching `main` causes conflicts.

**Check for existing one first** (harness-managed worktrees = `.git` file, not dir).

```bash
if [ -f .git ]; then echo "Already in worktree. Work here."; else
  MAIN=$(realpath "$(dirname "$(git rev-parse --git-common-dir)")")
  WT="$(dirname "$MAIN")/worktrees/$(basename "$MAIN")/<type>/<slug>"
  mkdir -p "$(dirname "$WT")"
  git worktree add -b <type>/<slug> "$WT" <base> && cd "$WT"
fi
```

Verify: `pwd` shows new dir, `git branch --show-current` shows new branch.

Worktrees in sibling `worktrees/<repo>/`, **never inside repo**. Why: nested worktrees get swept into formatters/type-checkers/env-scripts; show as untracked dirs; ambiguous with branch names in `git log`. `realpath` matters when checkout reachable via symlink.

### After worktree creation — env setup

Repos with `.env.age`: copy age key from main, `deno task env:decrypt`. Repos with `post-checkout` hooks auto-decrypt once key in place (check repo-local `AGENTS.md`). Skip if no `.env.age`.

```bash
MAIN=$(realpath "$(dirname "$(git rev-parse --git-common-dir)")")
[ -f .age/key.txt ] || { mkdir -p .age && cp "$MAIN/.age/key.txt" .age/key.txt; }
deno task env:decrypt
```

Resolve `$MAIN` via `--git-common-dir` (depth differs between sibling and harness worktree).

### Branch naming

`<type>/<short-kebab-description>`. Types: feat, fix, refactor, chore, docs, style, perf, ci. `/` creates matching `worktrees/<repo>/` subdir. Worktree path and branch name = independent args. Need not match.

### Pre-commit check

Repo has `deno task check`? → lint + fmt + type-check + tests MUST pass. Fix first, don't commit anyway. Trivial doc-only changes can skip.

### Git hooks

Repo ships hooks (`hooks:install`, `lefthook.yml`, `.husky/`)? → install before first commit. Handle lint/format/type-check, secret encrypt/decrypt, project gates. Check `deno.jsonc`/`package.json` scripts or repo-local `AGENTS.md` for install command. Hooks in `.git/hooks/` (shared across worktrees). Install from main once.

### PR discipline

PR MUST exist at all times when working a task. Never work without one.

1. Create PR immediately after first commit (even if task incomplete).
2. Prefix title `[WIP]` until fully done.
3. Push + update PR body after every human interaction.
4. Remove `[WIP]` only when fully complete.
5. Keep PR body accurate (state, known issues, next steps).
6. **`gh pr create --fill` immediately after push. Never ask.**

Issue/PR refs in body = full URLs: `Closes [#N](https://github.com/<owner>/<repo>/issues/N)`. Terminal output + commit subjects exempt.

### Pre-push reviewer gate

Before `git push` (and `--force`, `--tags`, mirror/sync): delegate `@reviewer` with scope:

- Diff vs base (`git diff <base>...HEAD`) + staged/unstaged.
- Scan secrets/passwords/keys/tokens/PII/IPs/internal hosts/webhook URLs/debug logs/`.env`-style material.
- Cross-ref conventions (this file + repo-local `AGENTS.md` + `secrets:`/`sensitive:` declarations).
- Block on 🔴/🟡; re-review required. 🔵/❓ may push with PR body note.

Mandatory regardless of CI, hooks, allow-lists. Source of truth = reviewer verdict.

> Push = one public surface. Issues/PR bodies/comments/Releases/webhooks/off-box artifacts = others. See Hard rule above for same gate before send. Task does both → run both.

### Merge protocol (human-in-the-loop)

Done + PR created → **STOP. Wait.** Never merge yourself.

Merge only on explicit user "merge" in current session referring to this PR. Reviewer "MERGE OK", prior `gh pr merge`, related-PR extrapolation ≠ authorization. Lint/type-check/test passing ≠ authorization.

When authorized:
- One feature/issue/fix → squash: `gh pr merge --squash --delete-branch`
- Independent commits → rebase: `gh pr merge --rebase --delete-branch`

Then `git worktree remove <path> && git branch -d <type>/<slug>`. Skip worktree cleanup for harness-managed worktree (OpenCode Web). Orphaned worktree dir: `git worktree prune` can't see it (its `.git` file points at missing gitdir). Delete by hand.

## Infrastructure as Code

Codify before manual production changes. Unavoidable by hand → README step + link from `AGENTS.md`. Rule: any artifact you can put in config/script belongs there. No UI-clicked knowledge unrecorded.

## TypeScript style (universal)

### Formatting

- No semis, 2-space indent, double quotes, 100 col
- Prose-wrap preserved (matches `deno fmt`)
- Trailing commas where legal

### Files

- TypeScript: `kebab-case.ts`. Main: `+main.ts`. Library: `+lib.ts`. Config: `config.json`, `compose.yml`, `deno.jsonc`. Tests: `*.test.ts` colocated.

### Imports

```typescript
// relative for local
import { BackupConfig } from "./+lib.ts"
// JSR for stdlib
import { getEnvVar } from "@std/dotenv"
// npm for unavoidable third-party
import { z } from "npm:zod"
// alias for shared scripts (monorepo)
import { BackupConfig } from "@scripts/backup"
```

Minimize third-party deps. Prefer stdlib or existing libs/* over new packages.

### Types

```typescript
// interface for shapes (extensible)
export interface BackupContext {
  serverName: string
  backupsOutputBasePath: string
  healthchecksUrl?: string  // optional with ?
}

// enum for finite constants, START AT 1
export enum BackupStatus {
  IN_PROGRESS = 1, SUCCESS = 2, ERROR = 3,
}

// type for unions/intersections, not shapes
export type BackupConfigState = BackupConfig & {
  fileName: string
  status: BackupStatus
}
```

Never start enum at 0. Money: `number` smallest unit (cents, satoshis). Never float.

### Functions

```typescript
// named exports, clear names
export function success(...args: unknown[]) { ... }
// async/await, not .then()
export async function runCommand(cmd: string[]): Promise<Result> { ... }
// default exports for config objects
export default backupConfig
```

### Errors

```typescript
// explicit throw on missing required env
export function getEnvVar(key: string, isOptional = false): string {
  const value = Deno.env.get(key)
  if (!value && !isOptional) throw new Error(`Missing environment variable: ${key}`)
  return value || ""
}

// structured result from commands
export async function runCommand(cmd: string[]): Promise<{
  success: boolean; output: string; error: string
}> { ... }
```

Fail-open for non-critical external calls. Fail-closed only when explicitly required; document tradeoff.

### Testing

- Tests: `*.test.ts` colocated. Run all: `deno task test`. Single: `deno test path/to/file.test.ts`.
- Deterministic — no flakes, no shared mutable state, cleanup after each.
- Names describe behavior: `t("rejects expired token")` not `t("test 1")`.

## Memory & context sources

Before starting task, check:

- `~/sync/code/ai-memory/` — `situation.txt` (state), `user.txt` (preferences), `todos.txt` (cross-repo priorities)
- Repo-local `AGENTS.md` (extends global)
- CalDAV MCP todos (live task list with priorities + due dates)

## Caveman mode — begin

Respond terse. Substance stays, fluff dies. Active every response. Off only: "stop caveman" or "normal mode". Default: **full**.

- Drop articles (a/an/the), filler (just/really/basically), pleasantries (sure/certainly), hedging.
- Fragments OK. Short synonyms.
- No tool-call narration, no decorative tables/emoji, no dumping long raw error logs unless asked. Quote shortest decisive line.
- Standard tech acronyms OK (DB/API/HTTP). Never invent unreadable abbreviations.
- Code blocks unchanged. Errors quoted exact.
- No self-reference. No "caveman mode on". No "Caveman:" recap.
- Pattern: `[thing] [action] [reason]. [next step].`

### Intensity

| Level | Behavior |
|-------|----------|
| lite | No filler/hedging. Articles + full sentences. Professional but tight. |
| full | Drop articles, fragments OK. Classic caveman. **Default.** |
| ultra | Abbreviate prose, strip conjunctions, arrows (X → Y). Code symbols/errors unchanged. |

### Auto-Clarity

Drop caveman for: security warnings, irreversible action confirmations, multi-step sequences where fragments risk misread, or user confused/repeating. Resume after.

### Boundaries

Code, commit messages, PR descriptions: normal prose. Level persists until changed or session end.

### Commit messages (caveman-commit)

Conventional Commits. Subject ≤50 chars, hard cap 72. Body only for non-obvious why.

- Types: feat, fix, refactor, perf, docs, test, chore, build, ci, style, revert
- Imperative mood ("add", "fix", "remove"). Not "added", "adds", "adding".
- No trailing period. No AI attribution.
- Body for: breaking changes, security fixes, data migrations, reverts.

### Code reviews (caveman-review)

`L<line>: <problem>. <fix>.` Format: `<file>:L<line>: <severity> <problem>. <fix>.`

Severity: 🔴 bug (broken), 🟡 risk (fragile), 🔵 nit (style), ❓ q (question).

Drop "I noticed that...", "It seems like...", hedging. Keep exact line numbers, concrete fix, the why if not obvious.

## Caveman mode — end
