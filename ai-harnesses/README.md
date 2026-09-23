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
unmerged branch — hooks included — must not go live for every session on the machine before it is
reviewed. `--check` works anywhere.

## Layout

| Source                                | Claude Code (`~/.claude`)        | OpenCode (`~/.config/opencode`)              | DSH (`$DSH_HOME`, default `~/.local/share/dsh`)   |
| ------------------------------------- | -------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| `AGENTS.md`                           | `CLAUDE.md`                      | `AGENTS.md`                                  | `AGENTS.md`                                       |
| `skills/<name>/` (`SKILL.md` + files) | `skills/<name>/`                 | `skills/<name>/` and/or `commands/<name>.md` | `skills/<name>/`                                  |
| `agents/<name>.md`                    | `agents/<name>.md`               | `agents/<name>.md`                           | `.agent-presets/<name>/{preset,agent.cordis}.yml` |
| `settings/<harness>/**`               | `settings.json` merged, `hooks/` | `opencode.json`, `tui.json` merged           | `settings.yaml` merged, `profiles/web/*` copied   |

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
two items with two names. Write tool names neutrally ("spawn a subagent", not "use the Task tool").

How `invocation` renders:

| `invocation` | Claude Code                           | OpenCode             | DSH                                   |
| ------------ | ------------------------------------- | -------------------- | ------------------------------------- |
| `model`      | skill                                 | skill                | skill                                 |
| `user`       | skill with `disable-model-invocation` | `commands/<name>.md` | skill with `disable-model-invocation` |
| `both`       | skill                                 | skill and command    | skill                                 |

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

## Claude Code hooks (`settings/claude/hooks/`) — disabled

Written, tested, **not wired up**: `settings/claude/settings.json` has no `hooks` key, so nothing
runs and the scripts are not copied to `~/.claude/`. A `PreToolUse` hook on Bash runs before every
shell command, which is more ceremony than the rules it guards are worth right now.

| Hook           | Event                             | Would do                                                                                                                                                        |
| -------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard-git.ts` | `PreToolUse` (Bash)               | ask before a commit on `main`/`master` and before `gh pr merge`; deny `git worktree add` inside a checkout; run gitleaks on unpushed commits and on `gh` bodies |
| `worktree.ts`  | `WorktreeCreate`/`WorktreeRemove` | put Claude Code's built-in worktrees in the sibling `worktrees/<repo>/<type>/<slug>` layout instead of `<repo>/.claude/worktrees/`                              |

To enable: copy the `hooks` block from `settings/claude/hooks/settings.hooks.json` into
`settings/claude/settings.json`, then run `deno task ai`. The command ships `hooks/` only while
that key exists, and removes the scripts again when it goes. To run the guard less often, add
`"if": "Bash(git *)"` to its handler (and a second handler with `"Bash(gh *)"`).

Without the worktree hook, Claude Code's built-in worktree features nest checkouts under
`<repo>/.claude/worktrees/`, which repo tooling then walks. `AGENTS.md` tells the agent to create
worktrees by hand instead; don't tick the worktree option when starting a desktop session.

OpenCode and DSH pick up changes on the next session start.
