In all interactions, plans, and commit messages, be extremely laconic and even sacrifice grammar.
Language: respond in English or Russian only. Never use Chinese or other languages.
Never use grep with something as wide as "**/myfile.txt" - that takes to long. Use narrower pattern instead.
Use Angular commit convention.

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

## Memory & context sources

Before starting a task, check for relevant context:
- `~/sync/code/ai-memory/` — `situation.txt` (current state), `user.txt` (preferences), `todos.txt` (cross-repo priorities)
- Repo-local `AGENTS.md` (overrides global)
- CalDAV MCP todos (live task list with priorities + due dates)
