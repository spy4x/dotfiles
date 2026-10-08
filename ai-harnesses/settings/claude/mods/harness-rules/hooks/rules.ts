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

/**
 * Judges a subagent spawn. A fork inherits its parent's model by design, so only the quota
 * applies to it. Everything else must name its model, and a reviewer must run on Opus.
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
        `Search and inventory: haiku. Implementers: sonnet, or opus for UI libraries and ` +
        `security work. Everything else, reviewers included: opus.`,
    }
  }
  if (spawn.subagentType === `reviewer` && !spawn.model.includes(`opus`)) {
    return { deny: `Reviewers run on opus (global CLAUDE.md, "Reviewers stay on opus").` }
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

/** Drops a leading `sudo` and its flags, so `sudo -n rm` reads as `rm`. */
function withoutSudo(words: string[]): string[] {
  if (words[0] !== `sudo`) return words
  let i = 1
  while (words[i]?.startsWith(`-`)) i++
  return words.slice(i)
}

/**
 * Judges a Bash command against the cleanup rules in the global CLAUDE.md ("Leave nothing
 * running"): no recursive `rm` of a path holding a variable, and no `find /`. Best effort: it
 * reads the command's words, not what the shell would expand.
 */
export function bashVerdict(command: string): Verdict {
  for (const words of commandsOf(command).map(withoutSudo)) {
    if (words[0] === `rm`) {
      const flags = words.slice(1).filter((word) => word.startsWith(`-`))
      const isRecursive = flags.some((flag) => /^-[^-]*[rR]/.test(flag) || flag === `--recursive`)
      const paths = words.slice(1).filter((word) => !word.startsWith(`-`))
      if (isRecursive && paths.some((path) => path.includes(`$`))) {
        return {
          deny: `Never \`rm -r\` a variable path: an empty variable deletes from \`/\`. Use ` +
            `\`find "<literal path>" -delete\`, or \`rm -rf\` a literal path.`,
        }
      }
    }
    if (words[0] === `find` && words[1] === `/`) {
      return { deny: `Never \`find /\`: search the directory that can hold the answer.` }
    }
  }
  return ALLOW
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

const POSTING_VERBS = [`create`, `comment`, `edit`, `review`]

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
 * command's own words. One with no body flag (a title-only edit, `--fill`) posts none this mod
 * can check.
 */
export function ghPost(command: string): GhPost {
  for (const words of commandsOf(command)) {
    const [gh, noun, verb] = words
    if (gh !== `gh` || (noun !== `issue` && noun !== `pr`)) continue
    if (!POSTING_VERBS.includes(verb ?? ``)) continue
    const path = flagValue(words, [`--body-file`, `-F`])
    if (path === `-`) return { kind: `stdin` }
    if (path !== undefined) return { kind: `file`, path }
    const body = flagValue(words, [`--body`, `-b`])
    if (body !== undefined) return { kind: `inline`, body }
  }
  return { kind: `none` }
}

/** Judges a body we are about to post: it must carry the agent marker. */
export function markerVerdict(text: string): Verdict {
  return text.includes(AGENT_MARKER) ? ALLOW : {
    deny: `Start every comment, issue and PR body with \`${AGENT_MARKER}\`: a comment ` +
      `without it reads as the owner's.`,
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
