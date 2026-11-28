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
 * The profile a session runs on. A desktop app keeps its data in its own folder
 * (`~/.config/Claude-<profile>/`, the default app's in `~/.config/Claude/`), so a path into that
 * folder names the account even when the app was started without the variable. `desktopPaths` are
 * the two variables that hold such a path: the skills folder a desktop app gives its own Claude
 * Code process, and the Claude Code path that process gives the shells it opens. The first that
 * names a desktop folder wins. Else the variable `claude-as` exports, else the default account.
 * A CLI started from a desktop session's shell inherits the second path, so `claude-as` removes
 * both; a plain `claude` started there is read as that desktop's account.
 */
export function sessionProfile(
  desktopPaths: readonly (string | undefined)[],
  profile: string | undefined,
): string {
  for (const path of desktopPaths) {
    const desktop = path?.match(/\/\.config\/Claude(?:-([a-z0-9][a-z0-9-]*))?\//)
    if (desktop) return desktop[1] ?? DEFAULT_PROFILE
  }
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

/** A simple command's words without the `(` or `{` that opens a group and the `)` that ends one. */
function ungrouped(words: readonly string[]): string[] {
  const rest = words[0] === `(` || words[0] === `{` ? words.slice(1) : [...words]
  if (rest[0]?.startsWith(`(`)) rest[0] = rest[0].slice(1)
  return rest.map((word) => word.replace(/\)+$/, ``))
}

/**
 * The folders a shell command moves into: its `cd` and `pushd` targets, inside a `( … )` or
 * `{ …; }` group or a `bash -c` script too, and every `-C` target. A relative target is read from
 * `base`, which a `cd` moves for the commands after it.
 */
function shellPaths(command: string, cwd: string | undefined): string[] {
  let base = cwd
  return commandsOf(command).flatMap((all) => {
    const words = ungrouped(all)
    const script = words.indexOf(`-c`) + 1
    if (/^(.*\/)?(ba|z|da)?sh$/.test(words[0] ?? ``) && script > 0 && words[script]) {
      return shellPaths(words[script], base)
    }
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

/**
 * The folders a tool call works in: the folders a Bash command moves into (`shellPaths`) and the
 * file the Write, Edit or NotebookEdit tool changes. Reads are left out: looking at another
 * repository's code is not doing its work. Writes from the shell (`sed -i`, a redirect, `cp`) are
 * not judged. A relative target is read from `cwd`, the call's working directory; without it, it
 * stays relative.
 */
export function workPaths(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  cwd?: string,
): string[] {
  if (tool === `Bash` && typeof input.command === `string`) return shellPaths(input.command, cwd)
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
