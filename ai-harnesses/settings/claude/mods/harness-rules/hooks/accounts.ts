// Which Claude account owns each repository, and the pure checks that keep a session's work on
// that account. register.ts wires them to events. docs/claude-accounts.md shows the same list as a
// table, and tools/claude-accounts.test.ts fails when the two disagree. Client repositories and
// their profiles are kept out of this public repository, in the private CLIENTS_PATH.

import { ALLOW, commandsOf, DIRECTION_CHECKOUT, type Verdict } from "./rules.ts"

/** The account of plain `claude` and the default desktop app. */
export const DEFAULT_PROFILE = `personal`

/** Repositories whose work every account does: the rules, the voice and the memory. */
export const EVERY_ACCOUNT: readonly string[] = [`dotfiles`, `ai-memory`]

/**
 * The owner's own accounts, by the profile name `claude-as` and `claude-desktop-as` take, with
 * the repositories each owns. It wins over the private client list. A repository under
 * ~/sync/code that is in neither list is refused.
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
    `rostok-cli-v1-test`,
    `skill-state`,
  ],
}

/**
 * The private list of client repositories, relative to home: `{ "<repo>": "<profile>" }`. It lives
 * in the private memory repository, so no client's name reaches this public one.
 */
export const CLIENTS_PATH = `${DIRECTION_CHECKOUT}/claude-accounts.json`

/** A client repository's profile, by the repository's name. */
export type Clients = Readonly<Record<string, string>>

/** Reads the private client list's text; throws when it is not an object of strings. */
export function parseClients(text: string): Clients {
  const list: unknown = JSON.parse(text)
  if (
    typeof list !== `object` || list === null || Array.isArray(list) ||
    Object.values(list).some((profile) => typeof profile !== `string`)
  ) throw new Error(`${CLIENTS_PATH} is not an object of repository → profile strings`)
  return list as Clients
}

/** Where the repositories live, under the home folder. */
const CODE = `sync/code`

/** Where the lists are kept, for the message that says how to add a repository. */
const LIST = `the owner's own accounts: dotfiles ` +
  `ai-harnesses/settings/claude/mods/harness-rules/hooks/accounts.ts and the table in ` +
  `docs/claude-accounts.md; a client's: ~/${CLIENTS_PATH}`

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

/** Whether a path names its folder without a working directory: `/…`, `~` or `$HOME`. */
export function isAbsolute(path: string): boolean {
  return /^(\/|~|\$HOME|\$\{HOME\})/.test(path)
}

/** `path` read from `base`; a relative path stays relative when there is no base. */
function resolve(base: string | undefined, path: string): string {
  return isAbsolute(path) || base === undefined ? path : `${base}/${path}`
}

/**
 * The folders a tool call works in: a Bash command's `cd`, `pushd` and `-C` targets, and the file a
 * write or an edit changes. Reads are left out: looking at another repository's code is not doing
 * its work. A relative target is read from `cwd`, the call's working directory, or from the folder
 * an earlier `cd` in the same command moved to; without either it stays relative.
 */
export function workPaths(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  cwd?: string,
): string[] {
  if (tool === `Bash` && typeof input.command === `string`) {
    let base = cwd
    return commandsOf(input.command).flatMap((words) => {
      const targets: string[] = []
      const target = words[1] === `--` ? words[2] : words[1]
      if ((words[0] === `cd` || words[0] === `pushd`) && target && target !== `-`) {
        base = resolve(base, target)
        targets.push(base)
      }
      words.forEach((word, i) => {
        const next = words[i + 1]
        if (word === `-C` && next !== undefined) targets.push(resolve(base, next))
      })
      return targets
    })
  }
  const path = input.file_path ?? input.notebook_path
  return [`Write`, `Edit`, `NotebookEdit`].includes(tool) && typeof path === `string`
    ? [resolve(cwd, path)]
    : []
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

/** The owner's account that owns `repo` in the tracked list, if any. */
function ownAccount(repo: string): string | undefined {
  return Object.entries(REPOSITORIES).find(([, repos]) => repos.includes(repo))?.[0]
}

/**
 * Judges the folders a session is about to work in, on `profile`, in order: the first refusal, or
 * none. A folder under ~/sync/code whose top folder holds no `.git` (`hasGit`) is no repository
 * and passes; a linked worktree is always one. `clients` reads the private list, only for a
 * repository the tracked list does not name.
 */
export async function workVerdict(
  paths: readonly string[],
  home: string,
  profile: string,
  hasGit: (dir: string) => Promise<boolean>,
  clients: () => Promise<Clients>,
): Promise<Verdict & { repo?: string }> {
  for (const path of paths) {
    const at = repoOf(path, home)
    if (at === undefined) continue
    if (!at.worktree && !await hasGit(`${home}/${CODE}/${at.repo}`)) continue
    const tracked = EVERY_ACCOUNT.includes(at.repo) || ownAccount(at.repo) !== undefined
    const verdict = accountVerdict(at.repo, profile, tracked ? {} : await clients())
    if (verdict.deny) return { ...verdict, repo: at.repo }
  }
  return ALLOW
}

/**
 * Judges work in a repository from a session on `profile`: allowed on the account that owns it,
 * or on any account for the repositories every account uses. The tracked list wins over the
 * private `clients` list. An unlisted repository is refused until someone adds it to a list.
 */
export function accountVerdict(repo: string, profile: string, clients: Clients = {}): Verdict {
  if (EVERY_ACCOUNT.includes(repo)) return ALLOW
  const owner = ownAccount(repo) ?? (Object.hasOwn(clients, repo) ? clients[repo] : undefined)
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
