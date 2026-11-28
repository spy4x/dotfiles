import type { EngineInterface, Register } from "claude-code"
import {
  ALLOW,
  bashVerdict,
  bodyFilePath,
  builtVerdict,
  compactionNotice,
  compactionsSoFar,
  DIRECTION_CHECKOUT,
  DIRECTION_FILE,
  DIRECTION_PATH,
  directionBlock,
  GH_SHIM_DIR,
  ghPost,
  leakVerdict,
  markerVerdict,
  memoryCheckoutBlock,
  spawnVerdict,
  unplacedVerdict,
  uuidVerdict,
  type Where,
  withGhShim,
} from "./rules.ts"
import { roleOf, SLIM_ARM, SLIM_TYPES, slimAttachment } from "./context-arm.ts"

/**
 * Added to every refused Bash call. Agents often fix a body (`sed -i '1i <!-- agent -->'`) and
 * post it in one command, then retry that same command after the refusal.
 */
const NOTHING_RAN = `Nothing in this command ran, not even the steps before the refused one: ` +
  `run any fix in a command of its own, then retry.`

/** The file's text, or undefined when it cannot be read yet. */
async function readable($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

/**
 * Appends one JSON line to ~/.claude/mods-log/harness-rules.jsonl: every spawn and every
 * refusal, so the experiment can count what the mod did. Fail-open: a lost line is no reason
 * to stop work.
 */
async function log($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  try {
    const home = await $.env.get(`HOME`)
    if (!home) return
    const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), ...entry })
    await $.process.run(
      [
        `sh`,
        `-c`,
        `mkdir -p "$1" && cat >> "$1/harness-rules.jsonl"`,
        `sh`,
        `${home}/.claude/mods-log`,
      ],
      { stdin: `${line}\n`, timeoutMs: 2000 },
    )
  } catch {
    // Logging is not critical.
  }
}

/** The 5-hour window's use in percent, when the session has a reading. */
async function fiveHourPercent($: EngineInterface): Promise<number | undefined> {
  const { rateLimits } = await $.session.usage()
  return rateLimits.find((limit) => limit.kind === `five_hour`)?.percentUsed
}

/**
 * The session's directory and home, for the `rm` rule. Each is left out when it cannot be read:
 * the rule then still refuses variable paths and the paths it can judge without them.
 */
async function whereOf($: EngineInterface): Promise<Where> {
  const [cwd, home] = await Promise.all([
    $.session.cwd().catch(() => undefined),
    $.env.get(`HOME`).catch(() => undefined),
  ])
  return { cwd, home }
}

/**
 * How long a session start waits for the direction fetch: more than twice the 3.1 s it measured,
 * and short enough that an unreachable remote delays the session by seconds only.
 */
const DIRECTION_FETCH_MS = 8000

/** How long a local git read may take: `git show` measured under 10 ms. */
const DIRECTION_SHOW_MS = 2000

/** What this local git read printed, or undefined when it failed. */
async function gitRead($: EngineInterface, argv: string[]) {
  const done = await $.process.run(argv, { timeoutMs: DIRECTION_SHOW_MS }).catch(() => undefined)
  return done?.exitCode === 0 ? done.stdout : undefined
}

/**
 * The context blocks read from the memory checkout: the owner's direction, then a line when the
 * checkout is dirty or behind. The direction is the text merged on `origin/main`, else the working
 * file on a machine where git cannot show it. The fetch finishes first, so "behind" is measured
 * on fresh refs; a failed fetch leaves the last fetched ones. Only `fetch`, `show`, `status` and
 * `rev-list` run, so uncommitted edits stay untouched, and `--no-optional-locks` keeps `status`
 * from taking the index lock from a running agent. Fail-open: an unknown home or a failed command
 * only leaves out what it would have told.
 */
async function memoryBlocks($: EngineInterface) {
  try {
    const home = await $.env.get(`HOME`)
    if (!home) return []
    const git = [`git`, `-C`, `${home}/${DIRECTION_CHECKOUT}`]
    await $.process.run([...git, `fetch`, `--quiet`, `origin`, `main`], {
      timeoutMs: DIRECTION_FETCH_MS,
    }).catch(() => undefined)
    const [merged, status, behind] = await Promise.all([
      gitRead($, [...git, `show`, `origin/main:${DIRECTION_FILE}`]),
      gitRead($, [...git, `--no-optional-locks`, `status`, `--porcelain`, `--untracked-files=all`]),
      gitRead($, [...git, `rev-list`, `--count`, `HEAD..origin/main`]),
    ])
    return [
      directionBlock(merged ?? await readable($, `${home}/${DIRECTION_PATH}`)),
      memoryCheckoutBlock(status, behind),
    ].filter((block) => block !== undefined)
  } catch {
    return []
  }
}

/**
 * The role whose slim context this attachment gets, or undefined when the session runs the full
 * arm (`RINGMASTER_CONTEXT_ARM` not exactly `slim`) or the loop has no role.
 */
async function slimRole($: EngineInterface, agentId: string | undefined) {
  if (await $.env.get(`RINGMASTER_CONTEXT_ARM`) !== SLIM_ARM) return undefined
  const agentType = agentId === undefined
    ? undefined
    : (await $.agent.list()).find((agent) => agent.id === agentId)?.type
  return roleOf(agentId, await $.env.get(`AGENT_RUN_ID`), agentType)
}

/**
 * The gh shim made executable, once per load: the harness engine writes a new file without its
 * source's mode. A failure is forgotten, so the next command tries again.
 */
let executable: Promise<void> | undefined

/** Runs `chmod 755` on the shim; throws when it does not exit 0. */
async function makeExecutable($: EngineInterface, shim: string): Promise<void> {
  const done = await $.process.run([`chmod`, `755`, shim], { timeoutMs: 2000 })
  if (done.exitCode !== 0) throw new Error(`chmod of the gh shim exited ${done.exitCode}`)
}

/**
 * The command with the mod's gh shim first on PATH, so the shim scans what a post would send
 * once the shell has built it. When home is unknown or the shim cannot be made executable, a post
 * throws (the guard then refuses it), and any other command runs: unchanged without a home, else
 * with the rewrite, where the shell skips a shim it cannot execute.
 */
async function shimmed($: EngineInterface, command: string, post: boolean): Promise<string> {
  let home: string | undefined
  try {
    home = await $.env.get(`HOME`)
  } catch {
    home = undefined
  }
  if (!home) {
    if (post) throw new Error(`HOME is unknown, so the gh shim cannot be found`)
    return command
  }
  const dir = `${home}/${GH_SHIM_DIR}`
  executable ??= makeExecutable($, `${dir}/gh`).catch((error) => {
    executable = undefined
    throw error
  })
  try {
    await executable
  } catch (error) {
    if (post) throw error
  }
  return withGhShim(command, dir)
}

export const register: Register = (on) => {
  // The slim arm of the context trial (spy4x/ringmaster-next#289): each role reads only its part
  // of the rules, the direction and the skills listing. Fail-open: any error keeps the full text.
  on(`prompt.attachment`, async ($, e, next) => {
    const answer = await next(e)
    if (!SLIM_TYPES.has(e.type) || answer.text === null) return answer
    try {
      const role = await slimRole($, e.agentId)
      return role ? { text: slimAttachment(e.type, answer.text, role) } : answer
    } catch {
      return answer
    }
  })

  // The conversation's first message carries direction.md, as it carries CLAUDE.md.
  on(`prompt.context`, async ($, e, next) => {
    const context = await next(e)
    return { ...context, blocks: [...context.blocks, ...await memoryBlocks($)] }
  })

  // After each compaction of the main conversation, a message counts it, and from the second on
  // tells the session to hand off. The count lives in that message, so the next compaction reads
  // it back from `e.messages`. Fail-open: it never vetoes, and any error keeps the compaction as
  // the engine made it. A subagent's compaction and a precompute (which installs nothing) pass.
  // A headless run (`AGENT_RUN_ID` set) is told to park with its handoff instead.
  on(`session.compact`, async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId !== undefined || e.trigger === `precompute` || compacted.skip !== undefined) {
      return compacted
    }
    try {
      const count = compactionsSoFar(e.messages.map((message) => message.text)) + 1
      const headless = Boolean(await $.env.get(`AGENT_RUN_ID`).catch(() => undefined))
      const text = compactionNotice(count, headless)
      const notice = { role: `user` as const, text, toolUses: [] }
      return { ...compacted, messages: [...compacted.messages, notice] }
    } catch {
      return compacted
    }
  })

  on(`tool.call`, { tool: `Write` }, async ($, e, next) => {
    const verdict = uuidVerdict(e.file_path, (await readable($, e.file_path)) ?? ``, e.content)
    if (!verdict.deny) return next(e)
    await log($, { event: `write`, path: e.file_path, deny: verdict.deny })
    return { deny: verdict.deny }
  })

  on(`tool.call`, { tool: `Edit` }, async ($, e, next) => {
    const verdict = uuidVerdict(e.file_path, e.old_string, e.new_string)
    if (!verdict.deny) return next(e)
    await log($, { event: `edit`, path: e.file_path, deny: verdict.deny })
    return { deny: verdict.deny }
  })

  on(`agent.spawn`, async ($, e, next) => {
    const verdict = spawnVerdict(e, await fiveHourPercent($))
    await log($, {
      event: `spawn`,
      subagentType: e.subagentType,
      model: e.model ?? null,
      fork: e.fork,
      parentAgentId: e.parentAgentId ?? null,
      deny: verdict.deny ?? null,
    })
    return verdict.deny ? { deny: verdict.deny } : next(e)
  })

  on(`tool.call`, { tool: `Bash` }, async ($, e, next) => {
    const verdict = bashVerdict(e.command, await whereOf($))
    if (!verdict.deny) return next(e)
    // The whole command, read on this machine to judge each refusal; none when it also posts,
    // since a post's body may hold a secret.
    const command = ghPost(e.command).kind === `none` ? e.command : null
    await log($, { event: `bash`, command, deny: verdict.deny })
    return { deny: `${verdict.deny} ${NOTHING_RAN}` }
  })

  // A body we post leaves the machine, so this guard fails closed: a hook that throws refuses.
  // It cannot see a gh call another hook makes beneath this one's own `$` calls: the engine
  // skips every hook already on the call stack (the recursion skip, `next.origin`).
  on(`tool.call`, { tool: `Bash` }, async ($, e, next) => {
    const post = ghPost(e.command)
    // Every command runs through the gh shim, since a script or `xargs gh` can post too.
    if (post.kind === `none`) return next({ ...e, command: await shimmed($, e.command, false) })
    // A body file is often written earlier in this same command (a heredoc), so it cannot be
    // read yet; a variable in its path resolves only when this command sets it once to a literal
    // (`ghPost`), or when it is `$HOME`. A file inside what a `mktemp` in the command made
    // (`fresh`), beside only the allowlisted commands of `freshSafe`, holds only what the command
    // wrote; it is never read.
    // `--body-file -` reads a heredoc.
    // A file that can be read is judged by its own text: a marker elsewhere in the command (a
    // shell comment) does not count. Only when it cannot be read does the command text, which
    // then holds a heredoc body, count for the marker; it is always scanned. A command that also
    // writes the body file with anything but a literal heredoc, `printf` or `echo` (`cat f >>`,
    // `cp`, `sed -i`, a script naming it) is refused (`built`). What the command text cannot show
    // (a body filled without naming its file, standard input, `$(…)`, `xargs`) the gh shim scans
    // at run time, after the shell has built it.
    // The shell expands `~/` and `$HOME`; a path it would change in any other way is unplaced.
    // A relative path is read from the folder a `cd` in the command moved to (`ghPost`), or else
    // from the session's directory, where the shell runs.
    const path = post.kind === `file` ? bodyFilePath(post.path, await whereOf($)) : undefined
    const file = path === undefined ? undefined : await readable($, path)
    let verdict = post.kind === `unplaced` || (post.kind === `file` && path === undefined)
      ? unplacedVerdict(e.command)
      : post.kind === `built`
      ? builtVerdict(e.command)
      : post.kind === `subject`
      // A commit subject is a title: it is scanned below, but a marker there would be wrong.
      ? ALLOW
      : markerVerdict(post.kind === `inline` ? post.body : file ?? e.command)
    if (!verdict.deny) {
      const scan = await $.process.run(
        [`gitleaks`, `stdin`, `--no-banner`, `--redact`],
        // The whole command too: the word parser is not a shell, and a body it cut short
        // (an escaped quote, `$(…)`) must not hide a secret.
        { stdin: file === undefined ? e.command : `${file}\n${e.command}`, timeoutMs: 8000 },
      )
      verdict = leakVerdict(scan.exitCode)
    }
    if (!verdict.deny) return next({ ...e, command: await shimmed($, e.command, true) })
    // The command can hold the secret gitleaks found, so the log keeps only the refusal.
    await log($, { event: `gh`, deny: verdict.deny })
    return { deny: `${verdict.deny} ${NOTHING_RAN}` }
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    const deny = `The check of this post failed: gitleaks did not run, or the check broke. ` +
      `It was not sent.`
    // The handler's grace is 1 second of its own time (`HookBudget.catchMs`); past it the hook
    // counts as absent and the post would go. Its `$` calls are free, so a slow log write
    // cannot use the grace up.
    await log($, { event: `gh`, deny })
    return { deny: `${deny} ${NOTHING_RAN}` }
  })
}
