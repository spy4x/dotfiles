import type { EngineInterface, Register } from "claude-code"
import {
  bashVerdict,
  ghPost,
  leakVerdict,
  markerVerdict,
  spawnVerdict,
  type Where,
} from "./rules.ts"

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
async function log(
  $: EngineInterface,
  entry: Record<string, unknown>,
  timeoutMs = 2000,
): Promise<void> {
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
      { stdin: `${line}\n`, timeoutMs },
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

export const register: Register = (on) => {
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

  // A body we post leaves the machine, so this guard fails closed: a hook that throws refuses,
  // and a re-entry (a gh call another hook makes beneath this one) is refused when it posts.
  on(`tool.call`, { tool: `Bash` }, async ($, e, next) => {
    const post = ghPost(e.command)
    if (post.kind === `none`) return next(e)
    // A body file is often written earlier in this same command (a heredoc, `sed -i`) or named
    // through a variable (`$D/b.md`), so it cannot be read yet; `--body-file -` reads a heredoc.
    // The command text holds a heredoc body, so it counts for the marker and is always scanned.
    // A body the command fills from elsewhere (`cat f >>`, `cp`, `curl >`) goes out unscanned.
    const file = post.kind === `file` ? await readable($, post.path) : undefined
    let verdict = markerVerdict(post.kind === `inline` ? post.body : `${file ?? ``}\n${e.command}`)
    if (!verdict.deny) {
      const scan = await $.process.run(
        [`gitleaks`, `stdin`, `--no-banner`, `--redact`],
        // The whole command too: the word parser is not a shell, and a body it cut short
        // (an escaped quote, `$(…)`) must not hide a secret.
        { stdin: file === undefined ? e.command : `${file}\n${e.command}`, timeoutMs: 8000 },
      )
      verdict = leakVerdict(scan.exitCode)
    }
    if (!verdict.deny) return next(e)
    // The command can hold the secret gitleaks found, so the log keeps only the refusal.
    await log($, { event: `gh`, deny: verdict.deny })
    return { deny: `${verdict.deny} ${NOTHING_RAN}` }
  }).catch(async ($, e, next) => {
    if (next.error.kind === `re-entry` && ghPost(e.command).kind === `none`) return next(e)
    if (next.error.kind !== `re-entry` && next.called) return next(e)
    const deny = `The check of this post failed: gitleaks did not run, or the check broke. ` +
      `It was not sent.`
    // Short: a handler that outruns its 1-second grace counts as absent, and the post would go.
    // On a re-entry the engine rejects this handler's own calls, so nothing is logged.
    await log($, { event: `gh`, deny }, 500)
    return { deny: `${deny} ${NOTHING_RAN}` }
  })
}
