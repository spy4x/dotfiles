# AI harness config

Claude Code, OpenCode and DSH (the DeepSeek harness) get their global rules, skills, agents and
settings from this directory. Each skill and agent is written once, in a harness-neutral format.
`deno task ai` converts it into the format each installed harness reads and copies it there.

```bash
deno task ai           # apply: copy this directory into every installed harness
deno task ai --check   # write nothing; exit 1 if any harness differs from this directory
```

`--check` answers one question: is what the harnesses read on this machine the same as what is
committed here? It prints each file that differs, and the exit code makes it usable as a gate —
for example after a merge, to confirm the apply really happened.

Run it from the **main checkout, after merge**. From a linked worktree it refuses: config from an
unmerged branch must not go live for every session on the machine before it is
reviewed. `--check` works anywhere.

## Layout

| Source                                | Claude Code (`~/.claude`)                | OpenCode (`~/.config/opencode`)              | DSH (`$DSH_HOME`, default `~/.local/share/dsh`)   |
| ------------------------------------- | ---------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| `AGENTS.md`                           | `CLAUDE.md`                              | `AGENTS.md`                                  | `AGENTS.md`                                       |
| `skills/<name>/` (`SKILL.md` + files) | `skills/<name>/`                         | `skills/<name>/` and/or `commands/<name>.md` | `skills/<name>/`                                  |
| `agents/<name>.md`                    | `agents/<name>.md`                       | `agents/<name>.md`                           | `.agent-presets/<name>/{preset,agent.cordis}.yml` |
| `settings/<harness>/**`               | `settings.json` merged                   | `opencode.json`, `tui.json` merged           | `settings.yaml` merged, `profiles/web/*` copied   |
| `mcp.jsonc`                           | `mcpServers` in `~/.claude.json`, merged | `mcp` in `opencode.json`, merged             | not rendered                                      |

`config.jsonc` says where each harness lives, whether it is enabled (`auto`: its home exists or its
binary is on `PATH`), which settings files are merged instead of copied, and which model each
neutral tier means.

| File            | Role                                                              |
| --------------- | ----------------------------------------------------------------- |
| `manage.ts`     | the `deno task ai` command                                        |
| `engine.ts`     | plans and applies file changes per harness home; settings merge   |
| `adapters/*.ts` | one per harness: source in, rendered files out, no filesystem I/O |
| `schema.ts`     | frontmatter and config validation                                 |
| `source.ts`     | reads and validates this directory                                |

## Writing a skill or an agent

Frontmatter is validated; an unknown key fails the run instead of being ignored.

```yaml
# skills/<name>/SKILL.md
name: audit # must match the directory
description: …
invocation: user # user: slash command only · model: loaded on demand (default) · both
argument-hint: "[path]" # Claude Code only
targets: [claude, opencode] # optional; default is every harness
harness: # optional frontmatter that only one harness understands
  opencode: { subtask: true }
```

```yaml
# agents/<name>.md
name: reviewer
description: …
mode: subagent # or primary (not rendered for Claude Code, which has none)
tier: strong # cheap | standard | strong | strongest → a model per harness
effort: high
temperature: 0.1
tools: [read, search, shell] # read | search | shell | edit | web; omitted = everything
targets: [opencode, dsh]
harness:
  claude: { color: red }
```

The body is shared: `harness` carries frontmatter only. If a body has to differ per harness, it is
two items with two names. Two agents that differ only in frontmatter (the same reviewer at another
effort, say) share one body: the variant sets `body-from: <agent>` and leaves its own body empty.
Write tool names neutrally ("spawn a subagent", not "use the Task tool").

How `invocation` renders:

| `invocation` | Claude Code                           | OpenCode             | DSH                                   |
| ------------ | ------------------------------------- | -------------------- | ------------------------------------- |
| `model`      | skill                                 | skill                | skill                                 |
| `user`       | skill with `disable-model-invocation` | `commands/<name>.md` | skill with `disable-model-invocation` |
| `both`       | skill                                 | skill and command    | skill                                 |

## MCP servers

`mcp.jsonc` lists every MCP server once, by lowercase name. `deno task ai` renders it into
OpenCode's `mcp` block and into Claude Code's `mcpServers`.

```jsonc
"caldav": {
  "command": "~/sync/code/mcps/caldav/start.sh", // a leading ~/ is expanded when rendering
  "args": [], // optional
  "env": {}, // optional
  "enabled": false, // optional; default true
  "targets": ["opencode"], // optional; default every harness that has MCP servers (not DSH)
  "harness": { "opencode": { "timeout": 300000 } } // optional keys only one harness understands
}
```

Neither harness runs the command through a shell, so write `~/` and let the renderer expand it; do
not use `$HOME`.

Claude Code keeps user-scope servers in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`),
outside its home, and a running session rewrites that file. The engine reads the file again right
before writing, changes only the `mcpServers.<name>` keys listed here, and swaps it in with an
atomic rename that keeps the file's permissions. Servers you added with `claude mcp add` stay.

`enabled: false` becomes `enabled: false` in OpenCode. Claude Code has no off switch for a
user-scope server, so a disabled server is not rendered there. As with all merged settings, removing
a server from `mcp.jsonc` does not remove it from the live files; run `claude mcp remove <name>` and
delete it from `opencode.json` by hand.

## Details worth knowing

- **Real directories, never symlinks.** DSH does not reliably follow a symlink at `$DSH_HOME`,
  Claude Code skips a symlinked `~/.claude/CLAUDE.md` in some session types, apps that save
  settings replace a symlink with a real file, and a symlinked home would put sessions, lockfiles
  and credentials inside this synced repo.
- **Settings merge.** A tracked settings file owns the keys it names, one level deep inside
  objects: `permissions.ask` and `hooks.PreToolUse` are replaced wholesale, while
  `permissions.allow`, `theme` and anything else the app saved are left alone. Machine-specific
  settings go in the live file directly — just not under a tracked key.
- **The merge adds and replaces; it never removes.** Deleting a key here does not delete it from
  the live file. Remove such a key from the live file by hand on each machine, in the same change.
- **Manifest.** Each home gets a `.dotfiles-sync.json` listing the files the command copied there.
  A file deleted here is deleted there on the next run; a file the command never wrote is never
  touched. Merged settings are never deleted.
- **Tests.** `deno task test` covers each adapter with golden files in `fixtures/golden/`. After an
  intended rendering change: `deno test -A ai-harnesses/adapters.test.ts -- --update`, then review
  the golden diff.

## Hooks and mods

Rules live in `AGENTS.md`, which every harness reads, not in hooks that only Claude Code runs. The
Claude Code adapter would still ship a `settings/claude/hooks/` directory if one came back with a
`hooks` key in `settings/claude/settings.json`.

One exception, an experiment until 2026-10-15: the Claude Code mod `harness-rules`
(`settings/claude/mods/harness-rules/`, copied to `~/.claude/mods/harness-rules/` and loaded
through `CLAUDE_CODE_PLUGIN_DIRS` in `settings.json`). It enforces rules `AGENTS.md` already
states, so the prose stays the source:

- an Agent call without `model` is refused, and so is a reviewer on anything but Opus;
- at 90% of the 5-hour limit, no new agent starts;
- `rm` and `rmdir` of a variable or a command substitution (`$`, `$(…)`, backticks), recursive or
  not, are refused, and so are `/`, a top-level directory, home, `.`, `..`, and the session's
  working directory or one of its parents. Claude Code stops for approval on these even in bypass
  mode; a refusal instead tells the agent to retry with `find "<literal path>" -delete` or `rm` of
  a literal path;
- `find /` is refused;
- a `gh issue` or `gh pr` body must carry `<!-- agent -->` and pass `gitleaks`. A failed check
  refuses the post, and so does a body piped in with `--body-file -`.

It reads a command's words, not what the shell would run, so it misses some cases: `sudo -u x` or
`timeout 60` in front of `rm`, bodies posted by `gh api`, `gh release` or `gh pr create --fill`,
and heredoc lines, which it reads as commands of their own.

A session reads `CLAUDE_CODE_PLUGIN_DIRS` when it starts: one started before the mod existed runs
without it, and so do its subagents, until it is restarted. A desktop-app session also keeps the
version it started with; it reloads a changed mod only when `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` is set.

Each spawn and each refusal is a line in `~/.claude/mods-log/harness-rules.jsonl`. Test it with
`claude plugin test ai-harnesses/settings/claude/mods/harness-rules`; `deno task test` skips it.

Claude Code's built-in worktree features nest checkouts under `<repo>/.claude/worktrees/`, which
repo tooling then walks. `AGENTS.md` tells the agent to create worktrees by hand instead; don't tick
the worktree option when starting a desktop session.

OpenCode and DSH pick up changes on the next session start.
