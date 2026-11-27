// Which Claude account owns each repository, and the pure checks that keep a session's work on
// that account. register.ts wires them to events. docs/claude-accounts.md shows the same list as a
// table, and tools/claude-accounts.test.ts fails when the two disagree.

import { ALLOW, commandsOf, type Verdict } from "./rules.ts"

/** The account of plain `claude` and the default desktop app. */
export const DEFAULT_PROFILE = `personal`

/** Repositories whose work every account does: the rules, the voice and the memory. */
export const EVERY_ACCOUNT: readonly string[] = [`dotfiles`, `ai-memory`]

/**
 * Each account, by the profile name `claude-as` and `claude-desktop-as` take, with the
 * repositories it owns. A repository under ~/sync/code that is in no list is refused.
 */
export const REPOSITORIES: Readonly<Record<string, readonly string[]>> = {
  neatsoft: [
    `ringmaster-next`,
    `ringmaster`,
    `financy`,
    `antonshubin.com`,
    `neatsoft.dev`,
    `command-center`,
    `upwork-guide`,
    `upwork-bot`,
    `gb`,
  ],
  personal: [
    `seed`,
    `template`,
    `ts-libs`,
    `preact-components`,
    `rostok`,
    `homelab`,
    `oko`,
    `zond`,
    `caldav-mcp`,
    `caldav-tasks-web`,
    `mig`,
    `spy4x`,
    `vi-shop`,
    `warthunder-stats`,
    `wt-heli-sight-notes`,
  ],
  client: [`google-calendar-clone`, `stripe-clone`],
}

/** Where the repositories live, under the home folder. */
const CODE = `sync/code`

/** Where this list is kept, for the message that says how to add a repository. */
const LIST =
  `dotfiles: ai-harnesses/settings/claude/mods/harness-rules/hooks/accounts.ts and the ` +
  `table in docs/claude-accounts.md`

/**
 * The profile a session runs on. A desktop app's session runs the Claude Code copy kept in that
 * app's data folder (`~/.config/Claude-<profile>/claude-code/…`, the default app's in
 * `~/.config/Claude/`), so its path names the account even when the app was started without the
 * variable. Else the variable `claude-as` exports, else the default account.
 */
export function sessionProfile(execPath: string | undefined, profile: string | undefined): string {
  const desktop = execPath?.match(/\/\.config\/Claude(?:-([a-z0-9][a-z0-9-]*))?\/claude-code\//)
  if (desktop) return desktop[1] ?? DEFAULT_PROFILE
  return profile || DEFAULT_PROFILE
}

/**
 * The folders a tool call works in: a Bash command's `cd`, `pushd` and `-C` targets, and the file a
 * write or an edit changes. Reads are left out: looking at another repository's code is not doing
 * its work.
 */
export function workPaths(tool: string, input: Readonly<Record<string, unknown>>): string[] {
  if (tool === `Bash` && typeof input.command === `string`) {
    return commandsOf(input.command).flatMap((words) => {
      const targets: string[] = []
      if ((words[0] === `cd` || words[0] === `pushd`) && words[1] !== undefined) {
        targets.push(words[1] === `--` ? words[2] ?? `` : words[1])
      }
      words.forEach((word, i) => {
        const next = words[i + 1]
        if (word === `-C` && next !== undefined) targets.push(next)
      })
      return targets
    })
  }
  const path = input.file_path ?? input.notebook_path
  return [`Write`, `Edit`, `NotebookEdit`].includes(tool) && typeof path === `string` ? [path] : []
}

/** Where a path points under ~/sync/code: the repository's name, and whether it is a worktree. */
export interface RepoPath {
  readonly repo: string
  /** A linked worktree under ~/sync/code/worktrees/<repo>/, which only ever holds git checkouts. */
  readonly worktree: boolean
}

/**
 * The repository a path is in, by its place under ~/sync/code: `<repo>/…`, or
 * `worktrees/<repo>/…` for a linked worktree. `~` and `$HOME` are expanded; a relative path, or one
 * elsewhere, gives none.
 */
export function repoOf(path: string, home: string): RepoPath | undefined {
  const expanded = path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home)
  if (!expanded.startsWith(`/`)) return undefined
  const parts: string[] = []
  for (const part of expanded.split(`/`)) {
    if (part === `..`) parts.pop()
    else if (part !== `` && part !== `.`) parts.push(part)
  }
  const base = `${home}/${CODE}`.split(`/`).filter(Boolean)
  if (base.some((part, i) => parts[i] !== part)) return undefined
  const [first, second] = parts.slice(base.length)
  if (first === `worktrees`) return second ? { repo: second, worktree: true } : undefined
  return first ? { repo: first, worktree: false } : undefined
}

/**
 * Judges the folders a session is about to work in, on `profile`, in order: the first refusal, or
 * none. A folder under ~/sync/code whose top folder holds no `.git` (`hasGit`) is no repository
 * and passes; a linked worktree is always one.
 */
export async function workVerdict(
  paths: readonly string[],
  home: string,
  profile: string,
  hasGit: (dir: string) => Promise<boolean>,
): Promise<Verdict & { repo?: string }> {
  for (const path of paths) {
    const at = repoOf(path, home)
    if (at === undefined) continue
    if (!at.worktree && !await hasGit(`${home}/${CODE}/${at.repo}`)) continue
    const verdict = accountVerdict(at.repo, profile)
    if (verdict.deny) return { ...verdict, repo: at.repo }
  }
  return ALLOW
}

/**
 * Judges work in a repository from a session on `profile`: allowed on the account that owns it,
 * or on any account for the repositories every account uses. An unlisted repository is refused
 * until someone adds it to the list.
 */
export function accountVerdict(repo: string, profile: string): Verdict {
  if (EVERY_ACCOUNT.includes(repo)) return ALLOW
  const owner = Object.entries(REPOSITORIES).find(([, repos]) => repos.includes(repo))?.[0]
  if (owner === undefined) {
    return {
      deny: `The repository ${repo} belongs to no Claude account yet, so no session may work in ` +
        `it. Add it to the account it is for (${LIST}), then open it in a session on that account.`,
    }
  }
  if (owner === profile) return ALLOW
  return {
    deny: `The repository ${repo} belongs to the ${owner} account, and this session runs on ` +
      `${profile}. Open it in a session on ${owner} (claude-as ${owner}, or its desktop app); ` +
      `never move its work to another account.`,
  }
}
