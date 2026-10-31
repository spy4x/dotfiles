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
 * What a `gh` command posts: nothing, an inline body, a body read from a file, a body read from
 * standard input (`--body-file -`, usually a heredoc in the same command), or only a merge's
 * commit subject, which is scanned but needs no marker.
 */
export type GhPost =
  | { readonly kind: `none` }
  | { readonly kind: `inline`; readonly body: string }
  | { readonly kind: `file`; readonly path: string }
  | { readonly kind: `stdin` }
  | { readonly kind: `subject` }
  | { readonly kind: `unplaced` }

/** The body flags of `create`, `comment`, `edit`, `review` and `merge`. */
const BODY = { inline: [`--body`, `-b`], file: [`--body-file`, `-F`] }

/** The comment flags of `close` and `reopen`. */
const COMMENT = { inline: [`--comment`, `-c`], file: [] }

/**
 * Each posting verb's body flags: those whose value is the body, and those that name its file.
 * `close` and `reopen` post their `--comment`, `merge` its commit body.
 */
const BODY_FLAGS: Record<string, { inline: string[]; file: string[] }> = {
  create: BODY,
  comment: BODY,
  edit: BODY,
  review: BODY,
  merge: BODY,
  close: COMMENT,
  reopen: COMMENT,
}

/** The flags of a merge's commit subject. */
const SUBJECT = [`--subject`, `-t`]

/** Every body flag of a posting verb, inline and file ones together. */
function bodyFlags(verb: string): string[] {
  const flags = BODY_FLAGS[verb]
  return flags ? [...flags.inline, ...flags.file] : []
}

/**
 * `gh issue|pr <posting verb>` anywhere in a command's words, global flags (`-R a/b`) allowed
 * between `gh` and the noun: the verb, and what follows it.
 */
const GH_POSTING =
  /(?:^|[^\w.-])gh(?:\s+-\S+(?:\s+[^\s-]\S*)?)*?\s+(?:issue|pr)\s+(create|comment|edit|review|merge|close|reopen)(?:\s(.*))?$/s

/**
 * Every value of `flags` in `words`, given as `flag value`, `--long=value`, or a short flag with
 * its value attached or after other short flags (`-bx`, `-F/abs/b.md`, `-F=/abs/b.md`, `-wb x`).
 */
function flagValues(words: string[], flags: string[]): string[] {
  const values: string[] = []
  const letters = flags.filter((flag) => /^-\w$/.test(flag)).map((flag) => flag[1]).join(``)
  const attached = new RegExp(`^-[A-Za-z]*?[${letters}](.*)$`, `s`)
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ``
    const long = flags.find((flag) => flag.startsWith(`--`) && word.startsWith(`${flag}=`))
    const short = letters && !word.startsWith(`--`) ? attached.exec(word) : null
    if (flags.includes(word)) values.push(words[++i] ?? ``)
    else if (long) values.push(word.slice(long.length + 1))
    // gh drops the `=` of an attached short value, as in `-F=/abs/f`.
    else if (short) values.push(short[1] ? short[1].replace(/^=/, ``) : (words[++i] ?? ``))
  }
  return values
}

/**
 * Finds the body a `gh issue|pr create|comment|edit|review|close|merge` command posts, reading only that
 * command's own words, after any prefix `commandProper` drops. One with no body flag (a
 * title-only edit, `--fill`) posts none this mod can check. Fails closed: a second post, a
 * repeated body flag, or a posting call with a body flag that does not start its command (inside
 * quotes, `$(…)`, after an unknown wrapper), is `unplaced`.
 */
export function ghPost(command: string): GhPost {
  const vars = new Map<string, string>()
  let found: GhPost = { kind: `none` }
  // Where an earlier `cd` in this command moved: undefined while it has not, null once a `cd` the
  // hook cannot follow ran.
  let dir: string | null | undefined
  for (const words of commandsOf(command)) {
    const assignments = words.map((word) => /^([A-Za-z_]\w*)=([^$`]*)$/.exec(word))
    if (assignments.every((match) => match)) {
      for (const match of assignments) {
        const [, name, value] = match!
        if (assignedOnce(command, name)) vars.set(name, value)
      }
    }
    const proper = commandProper(words)
    if ([`cd`, `pushd`, `popd`].includes(proper[0] ?? ``)) {
      dir = words.some((word) => /[()]/.test(word)) ? null : movedTo(proper, dir)
      continue
    }
    // Global flags may sit between `gh` and the noun: `gh -R a/b pr comment`.
    while (proper[1]?.startsWith(`-`)) {
      proper.splice(1, [`-R`, `--repo`].includes(proper[1]) ? 2 : 1)
    }
    const [gh, noun, verb] = proper
    const placed = gh?.replace(/^\\/, ``).split(`/`).pop() === `gh` &&
      (noun === `issue` || noun === `pr`) && Object.hasOwn(BODY_FLAGS, verb ?? ``)
    if (!placed) {
      const [, posting = ``, rest] = GH_POSTING.exec(words.join(` `)) ?? []
      if (rest !== undefined && flagValues(rest.split(/\s+/), bodyFlags(posting)).length > 0) {
        return { kind: `unplaced` }
      }
      continue
    }
    const flags = BODY_FLAGS[verb!]
    const bodies = flagValues(proper, bodyFlags(verb!))
    if (bodies.length === 0) {
      const subject = verb === `merge` && flagValues(proper, SUBJECT).length > 0
      if (subject && found.kind === `none`) found = { kind: `subject` }
      continue
    }
    // gh posts the last of repeated body flags; one body per command keeps the check exact.
    if (bodies.length > 1 || found.kind !== `none`) return { kind: `unplaced` }
    const [path] = flagValues(proper, flags.file)
    const [body] = flagValues(proper, flags.inline)
    if (path === `-`) found = { kind: `stdin` }
    else if (path !== undefined) {
      const full = expandVars(path, vars)
      if (full.startsWith(`/`) || HOME_LEAD.test(full) || dir === undefined) {
        found = { kind: `file`, path: full }
      } else if (dir === null) return { kind: `unplaced` }
      else found = { kind: `file`, path: `${dir}/${full}` }
    } else found = { kind: `inline`, body: body ?? `` }
  }
  return found
}

/** A leading `~/`, `$HOME` or `${HOME}`, which the shell makes home. */
const HOME_LEAD = /^(?:~(?=\/)|\$HOME(?!\w)|\$\{HOME\})/

/**
 * Where a `cd` or `pushd` (`proper`, its words) moves from `dir`: a literal path, joined to `dir`
 * when relative, or `$HOME` for a bare `cd`. Null for what the hook cannot follow: `popd`, a
 * flag, `-`, `+1`, a second argument, a glob, or a `$`, a backtick or `~` other than home.
 */
function movedTo(proper: string[], dir: string | null | undefined): string | null {
  const args = proper[1] === `--` ? proper.slice(2) : proper.slice(1)
  if (proper[0] === `popd` || args.length > 1) return null
  const to = args[0] === undefined || args[0] === `~` ? `$HOME` : args[0]
  if (/^[-+]/.test(to) || /[$`*?[{]|^~/.test(to.replace(HOME_LEAD, ``))) return null
  if (to.startsWith(`/`) || HOME_LEAD.test(to) || dir === undefined) return to
  return dir === null ? null : `${dir}/${to}`
}

/** Expands a leading home in `path`; undefined when the shell would still change it. */
function homeExpanded(path: string, home: string | undefined): string | undefined {
  if (HOME_LEAD.test(path) && !home) return undefined
  const full = path.replace(HOME_LEAD, home ?? ``)
  return /[$`]|^~/.test(full) ? undefined : full
}

/**
 * The body-file path the shell hands `gh`, with a leading `~/`, `$HOME` or `${HOME}` made home
 * and a relative path joined to the session's directory. Undefined when the shell would still
 * change it (`$`, a backtick, `~user`) or the home or directory it needs is unknown: the hook
 * could then read a different file from the one `gh` posts.
 */
export function bodyFilePath(path: string, { cwd, home }: Where): string | undefined {
  const full = homeExpanded(path, home)
  if (full === undefined || full.startsWith(`/`)) return full
  return cwd?.startsWith(`/`) ? `${cwd}/${full}` : undefined
}

/** Judges a posting gh call the guard cannot read (`ghPost` returned `unplaced`). */
export const UNPLACED_POST: Verdict = {
  deny: `This command posts with \`gh issue\` or \`gh pr\` in a form the guard cannot read: ` +
    `after a wrapper it does not know, inside quotes or \`$(…)\`, as a second post, or with a ` +
    `body file named through a variable it cannot resolve or relative to a \`cd\` it cannot ` +
    `follow. Make it the only post, written plainly: ` +
    `\`gh pr comment <n> --body-file <literal path>\`, with at most \`timeout <n>\`, ` +
    `\`sudo\`, \`env\` or \`X=1\` before it, and one body flag. Write a file whose text mentions ` +
    `such a call with the Write tool, not a heredoc.`,
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
      `comment does not count. One written in this same command cannot be read yet: write the ` +
      `file in a command of its own and pass its literal path.`,
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
