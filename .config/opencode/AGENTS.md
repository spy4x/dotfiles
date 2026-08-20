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

> The above covers **git-tracked files only**. For everything that leaves the box and lands on a public or shared surface (GitHub Issues, PR bodies, comments, Releases, webhooks, error reports, public docs, etc.), see **Hard rule: NO secrets in public/external artifacts** below.

## Hard rule: NO secrets in public/external artifacts

The previous rule covers **git-tracked files**. This one covers everything else that leaves the box and lands on a public, shared, or non-local surface — same leak class, different transport.

Public/external artifacts and side-channels include (not exhaustive):

- **Code hosting**: GitHub/GitLab/etc. Issues, PRs (title + body + comments), Reviews, Discussions, Gists, Releases / release notes, Wiki pages, commit messages pushed via API, bot-account posts, PR/Issue email notifications, RSS feeds.
- **Container / image registries**: Docker Hub, GHCR, Quay, public ECR, any OCI registry where image labels, annotations, layers, or build args may bake in secrets. **CI artifacts / build outputs**: `actions/upload-artifact`, public S3 buckets, release tarballs, anything produced by a build step that read a secret.
- **Webhooks + chat**: Slack, Discord, Teams, Mattermost, ntfy, generic incoming hooks, IRC, SMS gateways.
- **Issue trackers + tickets**: Jira, Linear, YouTrack, Shortcut.
- **Error reporting + telemetry**: Sentry events, LogRocket, Datadog logs, OpenTelemetry exports to a public collector, client-side crash reports, `console.error` / `console.log` forwarded to a third party, browser telemetry, AI code-suggestion telemetry (Copilot, Cody, Continue).
- **Public docs / sites**: blog posts, status pages, public READMEs, changelogs published to a public registry (npm, crates.io, PyPI), generated docs sites (build-time env vars can serialize into the client bundle, manifest, source maps), public Notion pages, Helm `values.yaml` in public OCI registries, Terraform remote state in public buckets.
- **Customer-facing comms**: support replies, public forum posts, email to public mailing lists, social posts authored by the agent (X/Twitter, Mastodon, Bluesky, LinkedIn).
- **Public calendars**: Google Calendar "public", shared CalDAV calendars, ICS feeds exposed on a public URL.
- **Anything pasted into a prompt** — the model provider logs user turns; subagent prompts; MCP tool inputs. Treat the provider as a public surface for secret-bearing context unless a contract proves zero-retention and no-train.
- **Anything echoed to stdout/stderr** of a process whose logs are public (CI logs on a public repo, shared run logs, broadcast journald, cloud build logs from GHA/CircleCI/Buildkite/GitLab CI).
- **Side channels that leak even without a "send"**:
   - OS-level capture: macOS `cmd-shift-3/4`, Windows Snipping, OBS, Zoom silent share, MDM-mandated screen recording, vendor crash dumps, accessibility tools.
   - Cloud-synced state: clipboard managers (1Password, Maccy, KDE Klipper), terminal emulator cloud (iTerm2, Warp, VS Code terminal cloud), `tmux-resurrect` to S3, Syncthing to a cloud VM, browser extensions (GoFullPage, Nimbus, Fireshot), browser autofill, Playwright `localStorage`/IndexedDB/cookies.
   - Dotfiles-repo commits — this very repo. A `~/.config/<svc>/config` paste into a commit is the same leak as a public Issue.

Assume any artifact that touches a non-local surface is **public forever**. GitHub lets you edit Issues, but search engines, archive.org, bots, inbound webhooks, notification emails, push notifications, RSS subscribers, and IMAP-synced inboxes have already captured the original. "Public forever" extends to model-provider logs and eval datasets unless a contract says otherwise — retention TTL ≠ redaction, and archive copies persist past TTL.

This rule overrides **Fail-open principle** for secret-bearing sends: those fail-closed. A supporting subsystem that drops a notification is recoverable; a leaked secret is not.

### Before sending — mandatory scrub

Treat every send as a one-way door. The agent MUST, in order:

1. **Redact by default.** Replace any real value (token, key, password, hostname, IP, CIDR, internal URL, webhook URL, account email, JWT, cookie, session ID, SSH fingerprint, vault/AWS SM/GCP SM/Azure KV token, OAuth refresh token, SAML assertion, Kerberos ticket, NTLM hash, WebAuthn credential, mTLS client cert, TPM-derived key, `.env`-style block, debug log, stack trace, command output that includes a secret, connection string, DSN) with a placeholder. **Canonical form**: `<REDACTED:KIND>` where `KIND` is the secret class (e.g., `API_KEY`, `WEBHOOK_URL`, `JWT`, `IPV4`). Use `***` only when length preservation matters more than readability. Never mix forms in one artifact.
2. **Use real-looking but inert examples.** For placeholders that aid comprehension, prefer:
   - RFC 5737 IPv4 (`192.0.2.1`, `198.51.100.1`, `203.0.113.1`) and IPv6 documentation prefix (`2001:db8::/32`).
   - RFC 2606 reserved domains (`example.com`, `example.net`, `example.org`) and reserved TLDs (`.example`, `.test`, `.invalid`, `.localhost`).
   - Never a real production value, never a real-looking-but-not-real hostname like `service.local` for a public artifact (it can collide with mDNS / split-horizon DNS).
3. **If unsure, redact.** When in doubt whether a string is a secret, treat it as one. False positives cost nothing; false negatives leak.
4. **Run a deterministic scanner before paste.** LLM self-scan misses unstructured secrets, partial keys, base64 blobs, JWTs without dots, prose-form passwords. Before pasting any tool output, file contents, stack trace, or HTTP response into a public artifact, run a secret scanner over it: `gitleaks detect --no-git`, `trufflehog filesystem <path>`, `detect-secrets scan`, or equivalent. Treat scanner-clean + reviewer-clean as the bar; LLM look-over is necessary but not sufficient.
5. **Self-check tool outputs.** Never paste raw output from any of these into a public artifact (and prefer not to invoke them at all if the next step is a public send):
   - File dumps: `cat .env`, `cat ~/.config/<svc>/config`, `cat ~/.aws/credentials`, `cat ~/.ssh/id_*`, `cat ~/.netrc`, `cat ~/.docker/config.json`, `docker inspect`, `journalctl`, `kubectl get secret -o yaml`, `kubectl get configmap -o yaml`.
   - Env dumps: `env`, `printenv`, `set`, `declare -p`.
   - Secret-manager fetches: `vault read`, `vault kv get`, `aws secretsmanager get-secret-value`, `gcloud secrets versions access`, `op read`, `op item get`, `gh auth token`, `doppler secrets download`, `infisical secrets get`.
6. **Reviewer gate before public send.** For any artifact that lands on a public or semi-public surface (GitHub Issues, public PRs, Releases, public docs, external webhooks, customer-facing replies, registry publishes), delegate a reviewer pass to the `@reviewer` agent with explicit scope — same shape as the pre-push gate:
   - Show the **full intended body** (title + body + every comment, or the full message / payload) — never the rendered preview alone; previews hide truncation and code-fence escapes.
   - Pair the LLM reviewer with the deterministic scanner from step 4. LLM alone is insufficient for high-stakes sends.
   - Scan for hardcoded secrets, password hashes, API keys, tokens, private keys, PII, IP addresses / CIDR ranges, internal hostnames, private endpoints, webhook URLs, debug logs, `.env`-style material, and any other suspicious leak patterns.
   - Cross-reference `~/.config/opencode/AGENTS.md`, repo-local `AGENTS.md`, and any `secrets:` / `sensitive:` declarations.
   - **Block the send** on `🔴 bug` or `🟡 risk`. `🔵 nit` / `❓ q` findings may send with a note in the rotation log only — never back into the artifact, where review notes can themselves leak.
   - The reviewer verdict is bound to the artifact hash; any subsequent edit to the artifact requires re-review. This gate is mandatory regardless of pre-commit hooks, CI secret scanners, or repo-local allow-lists. The single source of truth for "is this safe to send" is the reviewer verdict.

### Tool-specific reminders

- `gh issue create` / `gh pr create` / `gh release create` — body must be scrubbed before the command runs. `--body-file` is the safer shape (see recipe below), but `--body-file` alone does **not** make a send safe: zsh with `INC_APPEND_HISTORY` + `SHARE_HISTORY` (oh-my-zsh default) and bash with `PROMPT_COMMAND='history -a'` write history per-command, so any earlier command that composed the file (`cat .env > /tmp/body`, `echo $SECRET`) still leaks. The full recipe:

  ```bash
  # Compose from a secret manager, never from the shell history.
  BODY=$(mktemp -d)/body.md
  chmod 700 "$(dirname "$BODY")" && chmod 600 "$BODY"
  op read "op://<vault>/<item>/notes" > "$BODY"   # or: vault read, aws sm, gcloud sm
  # Do NOT open in an editor; do NOT cat.
  gh issue create --body-file "$BODY" --title "..."
  shred -u "$BODY" && rmdir "$(dirname "$BODY")"
  ```

  The temp file still leaks via fs cache, swap, and any sibling process that read it; assume the secret is compromised the moment it lands on disk and rotate accordingly. For comments and edits: `gh issue comment`, `gh pr comment`, `gh pr review`, `gh api`.
- `gh gist create` — public Gists cannot be deleted, only orphaned; the original is permanently indexed. **Never** create a public Gist for secret-bearing content. Private Gists are an internal surface; treat the gist URL itself as a secret.
- Webhook URLs are secrets. Never paste a real webhook URL into a public artifact, even for a "this is what the URL looks like" example — show `<REDACTED:WEBHOOK_URL>` instead.
- Stack traces frequently contain paths, usernames, hostnames, query strings with tokens, and connection strings — and even without secret values they leak internal layout (file paths, line numbers, framework versions) that aids reverse-engineering. Strip or replace with a synthetic trace before send.
- CI logs on public repos are public. Don't `echo $SECRET` in a step, and don't `cat .env` in a step that runs on PRs from forks. `git commit -m "$SECRET"` puts the value in reflog, `.git/objects`, fsck cache, packed-refs, and every concurrent fetch — use heredoc-from-file or stdin, never `-m` with a secret.
- Build outputs: `npm run build` / `go build` / `cargo build` may serialize `process.env.*` into the client bundle, manifest, or source maps. Build environment must contain no secret; secrets load at runtime via fetch, never at build time.
- `.env.example` is documentation, not a safe-to-paste dump. It still must use placeholders — never copy values from a real `.env` into it.
- Screenshots, terminal recordings, and copy-pasted logs from the agent's own output are public the moment they leave the box. Scrub before attaching. Attach only to allow-listed hosts (repo-local `AGENTS.md` may define one); the host's own retention policy then applies.
- Bot PATs: prefer GitHub Apps with short-lived installation tokens over long-lived PATs; narrow the token scope to the minimum; rotate per-task; never commit the PAT to any repo, including private ones.

### If a leak has already shipped

Edit-after-ship is **cosmetic**, not mitigation, on any surface that has already delivered, indexed, fanned out, or replicated to a subscriber. Rotation is the only effective response on those surfaces. The protocol:

1. **Rotate first, stop sends second.** Assume the old value is in attacker hands the moment the artifact existed in any delivered state. Generate new secret(s) before doing anything else; a leaked secret still in context leaks via every subsequent model-provider log.
2. **Stop further sends** of the same artifact and any artifact in the same thread / release / batch / cascade.
3. **Update server/service immediately** with the new secret.
4. **Update non-git `.env`** + re-encrypt `.env.age`.
5. **Cascade rotation.** A leaked GH token also exposes every downstream credential it can mint (OAuth refresh tokens, signed JWTs, dependent service tokens). Rotate every downstream credential potentially touched — not just the original. For webhook-fan-out (Sentry → PagerDuty → on-call SMS; GH Issue → email → IMAP → vendor; webhook → customer endpoint → customer logs), the cascade extends past your perimeter; assume the customer's logs are now compromised too and notify them.
6. **Access-log review** for the leaked credential: query the provider's audit log, your SIEM, and the secret-manager access log. Identify every read of the leaked value since exposure; treat every consumer as compromised.
7. **Edit the artifact (cosmetic) where the platform allows:**
   - GitHub: edit Issue / PR / comment / release notes via web UI, `gh issue edit`, `gh pr edit`, `gh release edit`, or `gh api`. After editing, also `gh issue lock --reason "resolved"` to prevent further replies quoting the secret, force-push any branch whose commit message carried the secret, and `gh gist delete` (orphans only — public gist content stays).
   - Webhook providers: edit/delete the message if the API supports it.
   - Error trackers: scrub the event before retention expires.
   For any surface that has already delivered to subscribers (GH email notifications sent, RSS polled, archive.org cached, Sentry alert paged, Slack push delivered, npm registry immutable, container registry layer pulled), edit is **theater** — the value is already out. Document this in the rotation log; do not represent the edit as a mitigation.
8. **Notify affected parties.** Public repo, public Issue, public Release, customer-facing surface, vendor surface: notify the operator (security advisory / disclosure) and, where required by law (GDPR/CCPA), notify affected data subjects. The rotation log records what was notified and when.
9. **Log to the rotation log.** A single append-only file at `~/sync/code/opencode-db/rotation-log.md` (gitignored, Syncthing-only) records: surface, artifact URL, secret class, time of exposure, time of rotation, downstream cascade, notification list, follow-ups. New agents read it before any task that touches a related surface.

Rotation in step 1 is mandatory for any public repo / public Issue / public Release / customer-facing surface / vendor surface / indexed artifact, regardless of whether the platform allows a clean edit.

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

> Push is one public surface. Issues, PR bodies, comments, releases, webhooks, and any other off-box artifact are others — see **Hard rule: NO secrets in public/external artifacts** above for the same gate applied before send. If a single task produces both a push and a public artifact, run **both** gates.

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
