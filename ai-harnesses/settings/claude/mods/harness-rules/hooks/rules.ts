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
  return simpleCommands(command, false).map((simple) => simple.words)
}

/** A heredoc a command reads: its body, and whether a quoted delimiter keeps it unexpanded. */
interface Heredoc {
  readonly quoted: boolean
  body: string
  /** Where the body sits in the command text, so it can be cut out. */
  start: number
  end: number
}

/** A simple command: its words, and the heredocs it reads. */
interface Simple {
  readonly words: string[]
  readonly heredocs: Heredoc[]
}

/**
 * `<<DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"` or `<<\DELIM` at the start of a word: a heredoc
 * whose body starts on the next line. A `<<<` here-string and a `<<` inside a word (`x<<y`) do
 * not match. One the shell would not read as a heredoc (`$(( x << y ))`) hides the lines after it,
 * so `ghPost` still looks for posts and the body file's name in its text.
 */
const HEREDOC_START =
  /^<<(-?)[ \t]*(?:'([A-Za-z_][\w-]*)'|"([A-Za-z_][\w-]*)"|(\\?)([A-Za-z_][\w-]*))(?=[\s;&|<>)]|$)/

/**
 * `commandsOf` with each command's heredocs. With `shell`, it reads closer to the shell: a
 * heredoc's lines are its body, up to the line that holds only its delimiter (after leading tabs
 * for `<<-`); a backslash escapes the next character; a `#` that starts a word starts a comment.
 * Without it, heredoc lines read as commands of their own, and backslashes and `#` as text.
 */
function simpleCommands(command: string, shell: boolean): Simple[] {
  const commands: Simple[] = []
  let words: string[] = []
  let heredocs: Heredoc[] = []
  // Heredocs opened on the current line, whose bodies start after it.
  let pending: { doc: Heredoc; delimiter: string; tabs: boolean }[] = []
  let word: string | undefined
  let quote: string | undefined
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0 || heredocs.length > 0) commands.push({ words, heredocs })
    words = []
    heredocs = []
  }
  // Reads the pending heredocs' bodies from `from`, and returns where the command goes on.
  const readBodies = (from: number): number => {
    let at = from
    for (const { doc, delimiter, tabs } of pending) {
      // Without its delimiter line, a body runs to the end of the command, as in the shell.
      doc.start = at
      doc.end = command.length
      while (at < command.length) {
        const newline = command.indexOf(`\n`, at)
        const lineEnd = newline === -1 ? command.length : newline
        const line = command.slice(at, lineEnd)
        if ((tabs ? line.replace(/^\t+/, ``) : line) === delimiter) {
          doc.end = at
          at = lineEnd + 1
          break
        }
        at = lineEnd + 1
      }
      doc.body = command.slice(doc.start, doc.end).replace(/\n$/, ``)
    }
    pending = []
    return at
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ``
    const next = command[i + 1] ?? ``
    const start = shell && !quote && word === undefined && char === `<`
      ? HEREDOC_START.exec(command.slice(i, i + 200))
      : null
    if (start) {
      const [text, dash, single, double, slash, bare] = start
      const doc: Heredoc = { quoted: !bare || slash === `\\`, body: ``, start: 0, end: 0 }
      heredocs.push(doc)
      pending.push({ doc, delimiter: single ?? double ?? bare ?? ``, tabs: dash === `-` })
      i += text.length - 1
    } else if (shell && char === `\\` && quote !== `'` && i + 1 < command.length) {
      // A backslash keeps the next character literal, as the shell does: `\"` ends no string. An
      // escaped `$` or backtick keeps its backslash, so the word never reads as an expansion.
      // Inside double quotes it escapes only `$`, a backtick, `"`, `\` and a newline.
      i++
      if (next === `\n`) continue
      else if (next === `$` || next === `\``) word = `${word ?? ``}\\${next}`
      else if (quote && !`"\\`.includes(next)) word = `${word ?? ``}\\${next}`
      else word = (word ?? ``) + next
    } else if (quote) {
      if (char === quote) quote = undefined
      else word = (word ?? ``) + char
    } else if (char === `"` || char === `'`) {
      quote = char
      word = word ?? ``
    } else if (shell && char === `#` && word === undefined) {
      // A comment runs to the end of its line, and its text is no command or heredoc.
      const newline = command.indexOf(`\n`, i)
      i = (newline === -1 ? command.length : newline) - 1
    } else if (/[;&|\n]/.test(char)) {
      endCommand()
      if (char === `\n` && pending.length > 0) i = readBodies(i + 1) - 1
    } else if (/\s/.test(char)) endWord()
    else word = (word ?? ``) + char
  }
  endCommand()
  if (pending.length > 0) readBodies(command.length)
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
 * Starts the message the mod appends to the conversation after each compaction. The count after
 * it is the state: the next compaction reads it back from the transcript, so nothing is stored.
 */
export const COMPACTIONS_MARK = `[harness-rules] compactions: `

/** From this compaction on, the appended message tells the session to hand off. */
export const HANDOFF_AFTER = 2

/**
 * How many times this conversation has compacted so far: the highest count a mark in these
 * texts holds, or 0. The highest, so a summary that quotes an older mark cannot lower it.
 */
export function compactionsSoFar(texts: readonly string[]): number {
  let most = 0
  for (const text of texts) {
    for (const match of text.matchAll(/\[harness-rules\] compactions: (\d+)/g)) {
      most = Math.max(most, Number(match[1]))
    }
  }
  return most
}

/**
 * The text appended after compaction number `count`: the mark alone, and from the second one on
 * the order to hand off (the `wave` skill's rule for a lead that compacted twice). A headless
 * run (`AGENT_RUN_ID` set, `tools/agent-run.ts`) has nobody to paste a prompt, so it parks with
 * the handoff in its final answer, which the next tick continues from.
 */
export function compactionNotice(count: number, headless = false): string {
  const mark = `${COMPACTIONS_MARK}${count}`
  if (count < HANDOFF_AFTER) return mark
  const intro = `${mark}\n\nThis session has now compacted ${count} times, and every later turn ` +
    `re-reads what is left.`
  if (headless) {
    return `${intro} Finish the step in hand, then end the run with status \`parked\` and the ` +
      `handoff the \`wave\` skill describes ("The handoff") in the \`handoff\` field of your ` +
      `final answer: the next tick continues from it. Start nothing new in this run.`
  }
  return `${intro} Finish the step in hand, then write the handoff the \`wave\` ` +
    `skill describes ("The handoff") and hand the rest of the work to a new session: in the ` +
    `Claude desktop app with \`mcp__ccd_session__hand_off_to_session\`; in a terminal, end your ` +
    `reply with the next session's prompt, ready to paste. Start nothing new in this session.`
}

/**
 * What a `gh` command posts: nothing, an inline body, a body read from a file, a body read from
 * standard input (`--body-file -`, usually a heredoc in the same command), or only a title (a
 * merge's commit subject, a create's or edit's `--title`), which is scanned but needs no marker.
 * `fresh` is a body file inside what a `mktemp` in the same command made, so the command alone
 * writes it. `built` is a body file the command also writes or edits with something the guard
 * cannot read (`cat .env >> b.md`, `cp`, `sed -i`, a script).
 */
export type GhPost =
  | { readonly kind: `none` }
  | { readonly kind: `inline`; readonly body: string }
  | { readonly kind: `file`; readonly path: string }
  | { readonly kind: `fresh` }
  | { readonly kind: `stdin` }
  | { readonly kind: `subject` }
  | { readonly kind: `built` }
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

/** Each titled verb's title flags: a merge's commit subject, a create's or edit's title. */
const TITLE_FLAGS: Record<string, string[]> = {
  create: [`--title`, `-t`],
  edit: [`--title`, `-t`],
  merge: [`--subject`, `-t`],
}

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
 * Finds the body a `gh issue|pr create|comment|edit|review|close|reopen|merge` command posts,
 * reading only that command's own words, after any prefix `commandProper` drops. One with only a
 * title flag (`--title`, a merge's `--subject`) posts a `subject`, placed or not; one with neither
 * (`--fill` alone) posts none this mod can check. Heredoc lines are bodies, not commands. Fails
 * closed: a second body, a repeated body flag, or a posting call with a body flag that does not
 * start its command (inside quotes, `$(…)`, a shell function, a heredoc's text, after an unknown
 * wrapper), is `unplaced`; a body file the command also writes in a way the guard cannot read is
 * `built`.
 */
export function ghPost(command: string): GhPost {
  const commands = simpleCommands(command, true)
  // Every mention counts, a quoted heredoc's text too: what reads as a heredoc (`(( 1 <<X ))`)
  // may be lines the shell runs.
  const text = command
  const vars = new Map<string, string>()
  // The variables a `mktemp` in this command assigned, with the command that did.
  const made = new Map<string, Simple>()
  let found: GhPost = { kind: `none` }
  let poster: { readonly command: Simple; readonly paths: string[] } | undefined
  // Where an earlier `cd` in this command moved: undefined while it has not, null once a `cd` the
  // hook cannot follow ran.
  let dir: string | null | undefined
  for (const simple of commands) {
    const { words } = simple
    // The shell might run what reads as a heredoc's text here, so a posting call in it counts.
    for (const doc of simple.heredocs) {
      const mention = postingMention(doc.body)
      if (mention === `body`) return { kind: `unplaced` }
      if (mention === `title`) found = titled(found)
    }
    const assignments = words.map((word) => /^([A-Za-z_]\w*)=([^$`]*)$/.exec(word))
    if (words.length > 0 && assignments.every((match) => match)) {
      for (const match of assignments) {
        const [, name, value] = match!
        if (assignedOnce(text, name)) vars.set(name, value)
      }
    }
    const fresh = MKTEMP.exec(words.join(` `))
    if (fresh && assignedOnce(text, fresh[1]!)) made.set(fresh[1]!, simple)
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
      const mention = postingMention(words.join(` `))
      if (mention === `body`) return { kind: `unplaced` }
      // A title the hook cannot place still goes out; the whole command is scanned for it.
      if (mention === `title`) found = titled(found)
      continue
    }
    const flags = BODY_FLAGS[verb!]
    const bodies = flagValues(proper, bodyFlags(verb!))
    if (bodies.length === 0) {
      if (flagValues(proper, TITLE_FLAGS[verb!] ?? []).length > 0) found = titled(found)
      continue
    }
    const [path] = flagValues(proper, flags.file)
    const [body] = flagValues(proper, flags.inline)
    // Several inline posts (`gh issue close 1 -c …; gh issue close 2 -c …`) hold all their text in
    // the command, which is scanned whole: they read as one whose body is the first without the
    // marker, so each must carry it.
    if (found.kind === `inline` && bodies.length === 1 && path === undefined) {
      if (found.body.includes(AGENT_MARKER)) found = { kind: `inline`, body: body ?? `` }
      continue
    }
    // gh posts the last of repeated body flags; one body per command keeps the check exact. A
    // title posted earlier in the command needs no marker, and the scan covers the whole command.
    if (bodies.length > 1 || ![`none`, `subject`].includes(found.kind)) return { kind: `unplaced` }
    if (path === `-`) found = { kind: `stdin` }
    else if (path !== undefined) {
      const full = expandVars(path, vars)
      poster = { command: simple, paths: [path, full] }
      if (inMade(full, made)) found = { kind: `fresh` }
      else if (full.startsWith(`/`) || HOME_LEAD.test(full) || dir === undefined) {
        found = { kind: `file`, path: full }
      } else if (dir === null) return { kind: `unplaced` }
      else found = { kind: `file`, path: `${dir}/${full}` }
    } else found = { kind: `inline`, body: body ?? `` }
  }
  // A path still holding a variable is refused by the caller, which names that cause.
  const resolvable = found.kind === `fresh` || (found.kind === `file` && !/[$`]/.test(
    found.path.replace(HOME_LEAD, ``),
  ))
  if (poster && resolvable && writtenOtherwise(commands, poster.command, poster.paths)) {
    return { kind: `built` }
  }
  if (
    found.kind === `fresh` && poster &&
    !commands.every((simple) => freshSafe(simple, poster.command, made))
  ) {
    return { kind: `built` }
  }
  return found
}

/**
 * Whether `text` holds a `gh issue|pr` posting call, and with what: a body flag, only a title
 * flag, or neither (undefined).
 */
function postingMention(text: string): `body` | `title` | undefined {
  const [, posting = ``, rest] = GH_POSTING.exec(text) ?? []
  const restWords = rest?.split(/\s+/) ?? []
  if (flagValues(restWords, bodyFlags(posting)).length > 0) return `body`
  if (flagValues(restWords, TITLE_FLAGS[posting] ?? []).length > 0) return `title`
  return undefined
}

/**
 * `NAME=$(mktemp …)` as a whole command, with only literal arguments: `-d`, `-q`, `-t`, `-p
 * <dir>`, `--tmpdir[=<dir>]`, a template. Each run makes a new, empty file or folder, so what is
 * inside it when `gh` runs, the command itself wrote. `-u` makes nothing and does not match.
 */
const MKTEMP =
  /^([A-Za-z_]\w*)=\$\(mktemp(?:\s+(?:-[dqt]+|-p\s+[^\s$`()]+|--tmpdir(?:=[^\s$`()]+)?|--directory|--quiet|[^\s$`()-][^\s$`()]*))*\s*\)$/

/**
 * Whether `path` is `$NAME` or `${NAME}/a/b` for a `NAME` that a `mktemp` in this command made:
 * inside it, with no `..`, glob or other expansion that could reach a file made before.
 */
function inMade(path: string, made: Map<string, Simple>): boolean {
  const match = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))((?:\/[^/$`*?[\]{}~]+)*)$/.exec(path)
  if (!match || !made.has(match[1] ?? match[2] ?? ``)) return false
  return !match[3]!.split(`/`).includes(`..`)
}

/** A word the shell passes as it is: no expansion, substitution, glob, brace or redirect. */
const LITERAL_WORD = /^[^$`*?[\]{}()<>|;&~]*$/

/**
 * Whether `simple` may run beside a post of a `mktemp` body file, so that the folder holds only
 * text the command itself holds. An allowlist, because any other command (`ln -s`, `cp -r`, `find
 * -exec`, `sh`, a script, `eval`, a glob) can reach the folder in ways no reading of the words
 * can rule out: the `mktemp` itself; the post, with no substitution in its words; a literal
 * assignment; `cd` and `mkdir -p` to a literal path or one inside the folder; `cat` whose only
 * input is a quoted heredoc; `echo` or `printf` with no substitution or glob, whose text is literal
 * when it is redirected. A redirect's target must be literal or inside the folder.
 */
function freshSafe(simple: Simple, poster: Simple, made: Map<string, Simple>): boolean {
  const { words, heredocs } = simple
  if ([...made.values()].includes(simple)) return true
  if (simple === poster) return words.every((word) => !/`|[$<>]\(/.test(word))
  const placed = (word: string) => LITERAL_WORD.test(word) || inMade(word, made)
  const [name, ...args] = words
  if (
    words.length > 0 && words.every((word) => /^[A-Za-z_]\w*=[^$`*?[\]{}()<>|;&~]*$/.test(word))
  ) {
    return heredocs.length === 0
  }
  if (name === `cd`) return heredocs.length === 0 && args.length <= 1 && args.every(placed)
  if (name === `mkdir`) {
    return heredocs.length === 0 && args.length > 0 &&
      args.every((arg) => arg === `-p` || placed(arg))
  }
  if (name !== `cat` && name !== `echo` && name !== `printf`) return false
  const text: string[] = []
  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ``
    if (!REDIRECT.test(arg)) text.push(arg)
    else if (arg.replace(REDIRECT, ``) !== ``) targets.push(arg.replace(REDIRECT, ``))
    else targets.push(args[++i] ?? ``)
  }
  if (!targets.every(placed)) return false
  if (name === `cat`) {
    return text.length === 0 && heredocs.length > 0 && heredocs.every((doc) => doc.quoted)
  }
  return heredocs.length === 0 &&
    text.every((arg) =>
      !/`|[$<>]\(|[*?[]/.test(arg) && (targets.length === 0 || !arg.includes(`$`))
    )
}

/** A redirect word: `>`, `>>`, `2>`, `&>`, or one with its target attached (`>b.md`). */
const REDIRECT = /^(?:\d*|&)>>?/

/**
 * Whether a command other than `poster` names the body file at `paths` (by its last part, as the
 * shell might reach it from another folder) and is not a writer whose text the command itself
 * holds: `cat` fed only by a heredoc the shell does not expand, or `echo` or `printf` with literal
 * text. Such a command (`cat .env >> b.md`, `cp`, `sed -i`, a script that opens the file) can put
 * text in the body that the scan of the command never sees.
 */
function writtenOtherwise(commands: Simple[], poster: Simple, paths: string[]): boolean {
  const names = [...new Set(paths.map((path) => braceless(path).split(`/`).pop() ?? ``))]
    .filter((name) => name !== ``)
  const named = (word: string) => {
    const target = braceless(word.replace(REDIRECT, ``))
    return names.some((name) => target === name || target.endsWith(`/${name}`))
  }
  const mentioned = (body: string) =>
    names.some((name) =>
      new RegExp(`(?<![\\w.$-])${name.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`)}(?![\\w.-])`)
        .test(braceless(body))
    )
  return commands.some((simple) => {
    if (simple === poster || literalWriter(simple)) return false
    const words = simple.words.filter((word) => !/^[A-Za-z_]\w*=[^$`]*$/.test(word))
    return words.some(named) || simple.heredocs.some((doc) => mentioned(doc.body))
  })
}

/** `${NAME}` written as `$NAME`, so both spellings of a path compare equal. */
function braceless(text: string): string {
  return text.replace(/\$\{([A-Za-z_]\w*)\}/g, `$$$1`)
}

/**
 * Whether `simple` writes only text the command holds: `cat` whose only arguments are output
 * redirects, fed by heredocs the shell does not expand (a quoted delimiter, or no `$` or backtick
 * in the body), or `echo` or `printf` with no `$` or backtick outside its redirects.
 */
function literalWriter(simple: Simple): boolean {
  const [name, ...args] = commandProper(simple.words)
  const text: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ``
    if (REDIRECT.test(arg)) i += arg.replace(REDIRECT, ``) === `` ? 1 : 0
    else text.push(arg)
  }
  if (name === `cat`) {
    return text.length === 0 && simple.heredocs.length > 0 &&
      simple.heredocs.every((doc) => doc.quoted || !/[$`]/.test(doc.body))
  }
  return (name === `echo` || name === `printf`) && simple.heredocs.length === 0 &&
    text.every((arg) => !/[$`]/.test(arg))
}

/** What a command posts once a title is found too: a title, unless a body was found already. */
function titled(found: GhPost): GhPost {
  return found.kind === `none` ? { kind: `subject` } : found
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

/** The first `gh issue|pr <posting verb>` a command names, for the command a refusal suggests. */
const GH_NOUN_VERB = /\bgh\b.*?\b(issue|pr)\s+(create|comment|edit|review|merge|close|reopen)\b/s

/**
 * The one command to send instead of `command`'s post: the same noun and verb, written plainly,
 * with its body in a file (a `close` or `reopen` takes its comment inline).
 */
function plainPost(command: string): string {
  const [, noun = `pr`, verb = `comment`] = GH_NOUN_VERB.exec(command) ?? []
  if (verb === `create`) {
    return `gh ${noun} create --repo <owner>/<repo> --title "<title>" --body-file <absolute path>`
  }
  if (verb === `close` || verb === `reopen`) {
    return `gh ${noun} ${verb} <n> --repo <owner>/<repo> --comment "${AGENT_MARKER} <text>"`
  }
  return `gh ${noun} ${verb} <n> --repo <owner>/<repo> --body-file <absolute path>`
}

/** Judges a posting gh call the guard cannot read (`ghPost` returned `unplaced`). */
export function unplacedVerdict(command: string): Verdict {
  return {
    deny: `This command posts with \`gh issue\` or \`gh pr\` in a form the guard cannot read: ` +
      `after a wrapper it does not know or inside a shell function, inside quotes or \`$(…)\`, ` +
      `as a second post, in a heredoc's text, or with a body file named through a variable it ` +
      `cannot resolve or relative to a \`cd\` it cannot follow. Make it the only post, written ` +
      `plainly, with at most \`timeout <n>\`, \`sudo\`, \`env\` or \`X=1\` before it and one ` +
      `body flag: \`${plainPost(command)}\`. The body file may be written earlier in the same ` +
      `command by \`cat > <path> <<'EOF'\`, in a folder from \`D=$(mktemp -d)\`. Write a file ` +
      `whose text mentions such a call with the Write tool, not a heredoc.`,
  }
}

/** Judges a post whose body file the command also writes another way (`ghPost`: `built`). */
export function builtVerdict(command: string): Verdict {
  return {
    deny: `This command also writes or edits the body file with something other than ` +
      `\`cat > <path> <<'EOF'\`, \`printf\` or \`echo\` (\`cat <file> >>\`, \`cp\`, \`sed -i\`, ` +
      `a script), so the guard cannot see all that \`gh\` would post. Write or edit the file in a ` +
      `command of its own, starting with \`${AGENT_MARKER}\`, then post it with ` +
      `\`${plainPost(command)}\`.`,
  }
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
  // An escaped `\$D` is the text `$D` to the shell, so it is left as it is.
  return path.replace(/(?<!\\)\$\{?([A-Za-z_]\w*)\}?/g, (text, name) => vars.get(name) ?? text)
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
