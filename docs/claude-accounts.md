# Several Claude accounts on one machine

One account per purpose, each paid for and used only for its own work: a personal one for my free
open-source work and private life, a company one for the company's work, and a client's one for
that client's work. They run side by side, in the desktop app and in the terminal. All of them share `~/.claude`, so the
rules, skills, MCP servers and memory are the same everywhere.

This is a workaround, not a feature Anthropic documents: the desktop app has no account switcher
and no profiles. It works because the app is built on Electron, which keeps one running copy per
data folder, and because the app hands its own sign-in to the Claude Code it starts.

## Which account does what

Every repository belongs to one account, by who the work is for, and stays there. When an account
reaches its limit, its work waits or moves to a paid top-up of that same account. It never moves
to another account: that would be using one subscription to stretch another.

The line between the two own accounts: work that earns through NeatSoft is NeatSoft's; free,
open-source work in my own name and my private life are personal. A personal project that starts
selling through NeatSoft moves to NeatSoft. A client that gives me a seat gets its repositories on
that seat; one that does not is NeatSoft's.

| Account       | Profile    | Repositories                                                                                                                                                              |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NeatSoft      | `neatsoft` | `ringmaster-next`, `ringmaster`, `financy`, `antonshubin.com`, `neatsoft.dev`, `command-center`, `upwork-guide`, `upwork-bot`, `gb` (Yumetronics), any client without a seat |
| Personal      | `personal` | `seed`, `template`, `ts-libs`, `preact-components`, `rostok`, `homelab`, `oko`, `zond`, `caldav-mcp`, `caldav-tasks-web`, `mig`, `spy4x`, `vi-shop`, `warthunder-stats`, `wt-heli-sight-notes`, personal chats |
| A client      | `client`   | `google-calendar-clone`, `stripe-clone` (its seat)                                                                                                                         |
| Every account | any        | `dotfiles`, `ai-memory`                                                                                                                                                   |

`dotfiles` and `ai-memory` hold the rules, my voice and my memory, which every account's work
uses: a session on any account reads and changes them as part of its own work. Ringmaster's own
runs on them use the personal account. Ringmaster runs each project on its account
([spy4x/ringmaster-next#358](https://github.com/spy4x/ringmaster-next/issues/358)).

The profile is the name `claude-as` and `claude-desktop-as` take. The same list, which the
`harness-rules` mod enforces, is in
[`accounts.ts`](../ai-harnesses/settings/claude/mods/harness-rules/hooks/accounts.ts); a test
fails when it and this table disagree. A session stops, with a line naming both accounts, when it
works in a repository of another account: its prompt is dropped when it starts there, and a
`cd`, a `git -C`, a file write or a subagent's folder there is refused. A repository under
`~/sync/code` that is in neither list is refused until it is added to both. The mod reads the
session's account from the path of the Claude Code a desktop app runs
(`~/.config/Claude-<profile>/claude-code/`, the default app's under `~/.config/Claude/`), else from
`CLAUDE_ACCOUNT_PROFILE`, which `claude-as` exports, else takes `personal`. Headless runs
(`AGENT_RUN_ID` set) are left to the engine that starts them.

## Set up on a new machine

The desktop app is installed first ([nightly update](sync.md#claude-desktop-nightly-update)).

```bash
ln -sfn ~/sync/code/dotfiles/tools/claude-desktop-as.sh ~/.local/bin/claude-desktop-as
ln -sfn ~/sync/code/dotfiles/tools/claude-as.sh ~/.local/bin/claude-as
```

The default app and plain `claude` are the personal account. Sign in to them as usual.

## Add an account

Pick a short profile name, such as `work`. The recoloured icon needs ImageMagick (`magick`).

```bash
claude-desktop-as --install work "Work"
```

That adds "Claude Work" to the application menu, with its own icon colour; a fourth argument sets
the hue (0 to 200, 100 leaves the icon unchanged). Start it from the menu and sign in with that
account's email. Its data is in `~/.config/Claude-work`; the default app keeps `~/.config/Claude`.

For the terminal:

```bash
claude-as work --setup
```

It opens the browser to sign in, then stores a long-lived token in `~/.config/claude-work/token`,
readable only by you. After that, `claude-as work` runs Claude Code on that account. Tokens are
never committed and never synced: repeat the setup on each machine.

Check which account a session uses with `claude-as work auth status`, or in the app under the
account menu.

## How it works

- `claude-desktop-as <profile>` starts the app with `--user-data-dir=~/.config/Claude-<profile>`.
  A second start of the same profile focuses its window; a different profile is a separate app.
- The app does not use the `claude` from the terminal. It downloads its own copy of Claude Code
  into its data folder and passes its sign-in to each session in `CLAUDE_CODE_OAUTH_TOKEN`, so a
  session's account is always the one its app is signed in to. `claude-as` sets the same variable
  from the stored token.
- Neither reads `~/.claude/.credentials.json`, which holds the terminal's default login.

## Known limits

- All the apps report one application id, so a taskbar that groups windows shows them under the
  default Claude icon. The menu entries keep their own icons; tell the windows apart by the
  account name in the app.
- A link that opens the app from outside (`claude://`, including the one that ends a browser
  sign-in) goes to the default app. If a new profile does not finish signing in, use the sign-in
  option that shows a code to paste.
- Cowork starts one helper per machine, so use it in one app only. The Code tab does not need it.
- Sessions of every account are stored together under `~/.claude/projects`.
- An app update replaces the app for all profiles at once; restart each of them.

## On macOS

The same idea, not tried here: `open -n -a Claude --args --user-data-dir="$HOME/Library/Application Support/Claude-work"`.
`-n` starts a new copy although one is running, and a plain double-click never passes the flag.
