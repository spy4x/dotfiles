// The rules this mod enforces, as pure functions: no `$`, so `claude plugin test` checks them
// directly. register.ts wires them to events.

/** What a rule decides: nothing to say, or a refusal with the reason the model reads. */
export interface Verdict {
  readonly deny?: string
}

export const ALLOW: Verdict = {}

/** The marker every comment, issue and PR body we post starts with (global CLAUDE.md). */
export const AGENT_MARKER = `<!-- agent -->`

/** At or above this share of the 5-hour limit, no new agent starts (wave skill, "Usage"). */
export const FIVE_HOUR_STOP = 90

/** The fields of an `agent.spawn` the rules read. */
export interface Spawn {
  readonly subagentType: string
  readonly model?: string
  readonly fork: boolean
}

/** Agent types that run on Opus only (global CLAUDE.md, "Subagents"). */
const OPUS_ONLY = new Set([`implementer`, `implementer-xhigh`, `reviewer`, `design-reviewer`])

/**
 * Judges a subagent spawn. A fork inherits its parent's model by design, so only the quota
 * applies to it. Everything else must name its model, and implementers and reviewers must run on
 * Opus.
 */
export function spawnVerdict(spawn: Spawn, fiveHourPercent: number | undefined): Verdict {
  if (fiveHourPercent !== undefined && fiveHourPercent >= FIVE_HOUR_STOP) {
    return {
      deny: `The 5-hour limit is at ${fiveHourPercent}%. Start no new agent: let the running ` +
        `ones finish, post the handoff and end the turn.`,
    }
  }
  if (spawn.fork) return ALLOW
  if (spawn.model === undefined) {
    return {
      deny: `Pass \`model\` on every Agent call: an omitted one inherits the lead's model. ` +
        `Search and inventory: haiku. Everything else, implementers and reviewers ` +
        `included: opus.`,
    }
  }
  if (OPUS_ONLY.has(spawn.subagentType) && !spawn.model.includes(`opus`)) {
    return {
      deny: `${spawn.subagentType} runs on opus (global CLAUDE.md, "Subagents": implementers ` +
        `and reviewers run on opus).`,
    }
  }
  return ALLOW
}

/**
 * Splits a shell command into simple commands, each a list of words. Quotes group words and are
 * dropped; `;`, `&`, `|` and newlines outside quotes end a command. No expansion: `"$D"` stays
 * the word `$D`. Best effort, not a shell: a heredoc's lines read as commands of their own.
 */
export function commandsOf(command: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word: string | undefined
  let quote: string | undefined
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined
      else word = (word ?? ``) + char
    } else if (char === `"` || char === `'`) {
      quote = char
      word = word ?? ``
    } else if (/[;&|\n]/.test(char)) endCommand()
    else if (/\s/.test(char)) endWord()
    else word = (word ?? ``) + char
  }
  endCommand()
  return commands
}

/** Words that run the command after them: `sudo rm`, `then rm`, `timeout 60 rm`. */
const PREFIXES = [
  `sudo`,
  `nice`,
  `xargs`,
  `command`,
  `builtin`,
  `exec`,
  `nohup`,
  `time`,
  `env`,
  `timeout`,
  `if`,
  `then`,
  `else`,
  `elif`,
  `while`,
  `until`,
  `do`,
  `!`,
]

/** Prefix flags that take a value: `sudo -u x`, `timeout -s KILL`. */
const VALUE_FLAGS = [`-u`, `-g`, `-s`, `-k`]

/**
 * Drops what runs before the command proper: prefixes and their flags, a `timeout` duration or
 * another number after a prefix (`nice -n 10`, `xargs -n 1`), `X=1` assignments, and a `(` or `{`
 * that opens a group. So `do (X=1 sudo -n rm` reads as `rm`.
 */
function commandProper(words: string[]): string[] {
  const rest = [...words]
  let i = 0
  while (i < rest.length) {
    const word = (rest[i] ?? ``).replace(/^[({]+/, ``)
    rest[i] = word
    if (word === `` || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++
    } else if (PREFIXES.includes(word)) {
      i++
      while (rest[i]?.startsWith(`-`)) i += VALUE_FLAGS.includes(rest[i] ?? ``) ? 2 : 1
      if (word === `timeout` || /^\d+$/.test(rest[i] ?? ``)) i++
    } else break
  }
  return rest.slice(i).map((word) => word.replace(/[)}]+$/, ``))
}

/** Where a command runs: the session's directory and the home directory, both absolute. */
export interface Where {
  readonly cwd?: string
  readonly home?: string
}

const LITERAL_PATH = `Delete by literal path: \`find "<literal path>" -delete\`, or \`rm -rf\` ` +
  `a literal path.`

/**
 * Resolves `path` the way the shell would name it, without expansion: `~` becomes `home`, a
 * relative path joins `cwd`, and `.`, `..`, a trailing `/` or `/*` fold away. Undefined when
 * the path is relative or starts with `~` and that base is unknown.
 */
function resolved(path: string, { cwd, home }: Where): string | undefined {
  let full = path
  if (full === `~` || full.startsWith(`~/`)) {
    if (!home) return undefined
    full = home + full.slice(1)
  } else if (!full.startsWith(`/`)) {
    if (!cwd) return undefined
    full = `${cwd}/${full}`
  }
  const parts: string[] = []
  for (const part of full.replace(/\/\*$/, ``).split(`/`)) {
    if (part === `..`) parts.pop()
    else if (part !== `` && part !== `.`) parts.push(part)
  }
  return `/${parts.join(`/`)}`
}

/**
 * What `path` is when Claude Code guards it even in bypass mode: `/`, a top-level directory,
 * home, or the working directory or one of its parents. Undefined for any other path.
 */
function criticalKind(path: string, where: Where): string | undefined {
  if ([`~`, `~/`].includes(path)) return `home`
  if ([`.`, `./`, `./*`, `*`].includes(path)) return `the working directory`
  if ([`..`, `../`].includes(path)) return `a parent of the working directory`
  const full = resolved(path, where)
  if (full === undefined) return undefined
  if (full === `/`) return `the root`
  if (full.split(`/`).length === 2) return `a top-level directory`
  if (where.home && full === resolved(where.home, {})) return `home`
  const cwd = where.cwd ? resolved(where.cwd, {}) : undefined
  if (cwd === full) return `the working directory`
  if (cwd?.startsWith(`${full}/`)) return `a parent of the working directory`
  return undefined
}

/**
 * Judges a Bash command against the cleanup rules in the global CLAUDE.md ("Leave nothing
 * running"): `rm` and `rmdir` take only literal paths, never a critical one, no `find /` and no
 * `ulimit -u`; and against Git Flow: `gh pr merge` takes `--repo` and never `--admin`.
 * Claude Code stops for approval on critical paths and some substitutions even in bypass mode;
 * a refusal instead tells the agent how to retry. Best effort: it reads the command's words, not
 * what the shell would expand.
 */
export function bashVerdict(command: string, where: Where = {}): Verdict {
  for (const words of commandsOf(command).map(commandProper)) {
    const name = (words[0] ?? ``).replace(/^\\/, ``).split(`/`).pop()
    if (name === `rm` || name === `rmdir`) {
      const paths = words.slice(1).filter((word) => !word.startsWith(`-`))
      if (paths.some((path) => /[$`]/.test(path))) {
        return {
          deny: `Never pass \`${name}\` a path from a variable or a command substitution: an ` +
            `empty one deletes from \`/\`, and some forms (\`rm -rf $(…)\`) make Claude Code ` +
            `stop for approval even in bypass mode. ${LITERAL_PATH}`,
        }
      }
      for (const path of paths) {
        const kind = criticalKind(path, where)
        if (kind === undefined) continue
        return {
          deny: `Never \`${name}\` \`${path}\`: it is ${kind}, and Claude Code stops for ` +
            `approval on it even in bypass mode. Delete only what you created. ${LITERAL_PATH}`,
        }
      }
    }
    if (words[0] === `find` && words[1] === `/`) {
      return { deny: `Never \`find /\`: search the directory that can hold the answer.` }
    }
    if (name === `ulimit` && words.slice(1).some((word) => /^-[A-Za-z]*u/.test(word))) {
      return {
        deny: `Never \`ulimit -u\`: it counts every thread the user owns, so the first fork ` +
          `fails. Cap a run with \`systemd-run --user --scope --quiet -p TasksMax=4000 ` +
          `-p MemoryMax=8G timeout <seconds> <cmd>\`.`,
      }
    }
    if (words[0] === `gh` && words[1] === `pr` && words[2] === `merge`) {
      const verdict = mergeVerdict(words)
      if (verdict.deny) return verdict
    }
  }
  return ALLOW
}

/**
 * Judges a `gh pr merge` against the Git Flow rules: never `--admin`, which skips the branch
 * protection only the owner may lift, and always `--repo`, without which gh skips the remote
 * branch delete while the worktree exists.
 */
function mergeVerdict(words: string[]): Verdict {
  if (words.includes(`--admin`)) {
    return {
      deny: `Never pass \`--admin\` to \`gh pr merge\`: the branch protection is the owner's. ` +
        `Wait for the check with \`timeout 900 gh pr checks <n> --repo <owner>/<repo> ` +
        `--watch\`, or leave the PR open and say so.`,
    }
  }
  if (!words.some((word) => word === `--repo` || word === `-R` || word.startsWith(`--repo=`))) {
    return {
      deny: `Pass \`--repo <owner>/<repo>\` to \`gh pr merge\`: without it, gh tries to delete ` +
        `the local branch, fails while its worktree exists, and skips the remote delete.`,
    }
  }
  return ALLOW
}

/**
 * Calls that make a version 4 UUID. Built from parts so this file does not hold the calls it
 * refuses: an edit to it would otherwise count them.
 */
const UUID_V4_CALLS = [`crypto.random` + `UUID`, `gen_random` + `_uuid`, `uuid_generate` + `_v4`]
  .map((name) => new RegExp(`\\b${name.replace(`.`, `\\.`)}\\s*\\(`, `g`))
  .concat(new RegExp(`\\buuid` + `v4\\s*\\(`, `gi`))

/** Source files the id rule covers: JavaScript, TypeScript and SQL. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|sql)$/i

/** How many version 4 UUID calls `text` holds. */
function uuidV4Calls(text: string): number {
  return UUID_V4_CALLS.reduce((sum, call) => sum + (text.match(call)?.length ?? 0), 0)
}

/**
 * Judges a file write against the id rule in the global CLAUDE.md ("TS style"): it refuses one
 * that adds a version 4 UUID call to a code file. `before` is the text the write replaces (the
 * file, or an Edit's `old_string`), so keeping an existing call is no refusal.
 */
export function uuidVerdict(path: string, before: string, after: string): Verdict {
  if (!CODE_FILE.test(path) || uuidV4Calls(after) <= uuidV4Calls(before)) return ALLOW
  return {
    deny: `Never create a version 4 UUID: every id is a version 7 UUID. Use \`uuidV7()\` from ` +
      `\`@spy4x/platform/universal/uuid\`, \`generate\` from \`@std/uuid/v7\` in a repo that ` +
      `does not import ts-libs, or \`uuidv7()\` in Postgres 18 SQL. A secret token is the ` +
      `owner's choice: ask before implementing it.`,
  }
}

/** Where the owner's direction lives, relative to home (global CLAUDE.md, "Direction"). */
export const DIRECTION_PATH = `sync/code/ai-memory/direction.md`

/** A context block the conversation's first message carries. */
export interface ContextBlock {
  readonly name: string
  readonly text: string
}

/**
 * The context block that carries direction.md, or undefined when the file is missing or empty:
 * the session then starts without it.
 */
export function directionBlock(text: string | undefined): ContextBlock | undefined {
  if (!text?.trim()) return undefined
  return {
    name: `direction`,
    text: `Contents of ~/${DIRECTION_PATH}, the owner's current direction ("Direction" in ` +
      `the global rules):\n\n${text.trim()}`,
  }
}

/**
 * What a `gh` command posts: nothing, an inline body, a body read from a file, or a body read
 * from standard input (`--body-file -`, usually a heredoc in the same command).
 */
export type GhPost =
  | { readonly kind: `none` }
  | { readonly kind: `inline`; readonly body: string }
  | { readonly kind: `file`; readonly path: string }
  | { readonly kind: `stdin` }
  | { readonly kind: `unplaced` }

const POSTING_VERBS = [`create`, `comment`, `edit`, `review`]

const BODY_FLAGS = [`--body`, `-b`, `--body-file`, `-F`]

/** `gh issue|pr <posting verb>` anywhere in a command's words, and what follows it. */
const GH_POSTING = /(?:^|[^\w.-])gh\s+(?:issue|pr)\s+(?:create|comment|edit|review)(?:\s(.*))?$/s

/** The value of `flag` in `words`, given as `flag value` or `--long=value`. */
function flagValue(words: string[], flags: string[]): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ``
    if (flags.includes(word)) return words[i + 1] ?? ``
    const long = flags.find((flag) => flag.startsWith(`--`) && word.startsWith(`${flag}=`))
    if (long) return word.slice(long.length + 1)
  }
  return undefined
}

/**
 * Finds the body a `gh issue|pr create|comment|edit|review` command posts, reading only that
 * command's own words, after any prefix `commandProper` drops. One with no body flag (a
 * title-only edit, `--fill`) posts none this mod can check. Fails closed: a second post, or a
 * posting call with a body flag that does not start its command (inside quotes, `$(…)`, after an
 * unknown wrapper), is `unplaced`.
 */
export function ghPost(command: string): GhPost {
  const vars = new Map<string, string>()
  let found: GhPost = { kind: `none` }
  for (const words of commandsOf(command)) {
    const assignments = words.map((word) => /^([A-Za-z_]\w*)=([^$`]*)$/.exec(word))
    if (assignments.every((match) => match)) {
      for (const match of assignments) {
        const [, name, value] = match!
        if (assignedOnce(command, name)) vars.set(name, value)
      }
    }
    const proper = commandProper(words)
    const [gh, noun, verb] = proper
    const placed = gh?.replace(/^\\/, ``).split(`/`).pop() === `gh` &&
      (noun === `issue` || noun === `pr`) && POSTING_VERBS.includes(verb ?? ``)
    if (!placed) {
      const rest = GH_POSTING.exec(words.join(` `))?.[1]
      if (rest !== undefined && flagValue(rest.split(/\s+/), BODY_FLAGS) !== undefined) {
        return { kind: `unplaced` }
      }
      continue
    }
    if (flagValue(proper, BODY_FLAGS) === undefined) continue
    if (found.kind !== `none`) return { kind: `unplaced` }
    const path = flagValue(proper, [`--body-file`, `-F`])
    const body = flagValue(proper, [`--body`, `-b`])
    if (path === `-`) found = { kind: `stdin` }
    else if (path !== undefined) found = { kind: `file`, path: expandVars(path, vars) }
    else found = { kind: `inline`, body: body ?? `` }
  }
  return found
}

/** Judges a posting gh call the guard cannot read (`ghPost` returned `unplaced`). */
export const UNPLACED_POST: Verdict = {
  deny: `This command posts with \`gh issue\` or \`gh pr\` in a form the guard cannot read: ` +
    `after a wrapper it does not know, inside quotes or \`$(…)\`, or as a second post. Make it ` +
    `the only post, written plainly: \`gh pr comment <n> --body-file <literal path>\`, with at ` +
    `most \`timeout <n>\`, \`sudo\`, \`env\` or \`X=1\` before it. A search for such text ` +
    `can write the space as \`\\s\`.`,
}

/**
 * Whether `name` appears in the command only as one assignment and as `$NAME` or `${NAME}`
 * references. Any other mention (`D[0]=`, `eval D\\=`, `read D`, a second `D=`) may change it, so
 * the value it was given would not be the one `gh` sees.
 */
function assignedOnce(command: string, name: string): boolean {
  const bare = [...command.matchAll(new RegExp(`(\\$\\{?)?(?<![\\w])${name}(?!\\w)`, `g`))]
    .filter((match) => !match[1])
  return bare.length === 1
}

/**
 * Replaces `$NAME` and `${NAME}` in a body-file path with a literal value the same command assigned
 * earlier (`D=/tmp/x && gh pr edit 5 --body-file $D/b.md`), so the hook can read the file. A name
 * with no such assignment stays as it is, and the file then cannot be read.
 */
function expandVars(path: string, vars: Map<string, string>): string {
  return path.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (text, name) => vars.get(name) ?? text)
}

/** Judges a body we are about to post: it must carry the agent marker. */
export function markerVerdict(text: string): Verdict {
  return text.includes(AGENT_MARKER) ? ALLOW : {
    deny: `Start every comment, issue and PR body with \`${AGENT_MARKER}\`: a comment ` +
      `without it reads as the owner's. Make it the body's first line. A body file that can be ` +
      `read must hold it itself: a marker added in the same command (\`sed -i\`) or in a shell ` +
      `comment does not count. One written in this same command, or named through a variable ` +
      `set outside it or through \`$(…)\`, cannot be read yet: write the file in a command of ` +
      `its own and pass its literal path.`,
  }
}

/**
 * Judges what gitleaks said about a body: exit 0 is clean, 1 is a finding, anything else is a
 * failed scan. Both of the last refuse: a secret-bearing send fails closed.
 */
export function leakVerdict(exitCode: number): Verdict {
  if (exitCode === 0) return ALLOW
  return {
    deny: exitCode === 1
      ? `gitleaks found a secret in this body. Replace it with <REDACTED:KIND> before posting.`
      : `The gitleaks scan of this body failed (exit ${exitCode}), so it was not posted.`,
  }
}
