import type { EngineInterface, Register } from "claude-code"
import {
  bashVerdict,
  ghPost,
  leakVerdict,
  markerVerdict,
  spawnVerdict,
  type Verdict,
} from "./rules.ts"

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
    const verdict = bashVerdict(e.command)
    if (!verdict.deny) return next(e)
    await log($, { event: `bash`, command: e.command.slice(0, 200), deny: verdict.deny })
    return { deny: verdict.deny }
  })

  // A body we post leaves the machine, so this guard fails closed: a hook that throws refuses.
  on(`tool.call`, { tool: `Bash` }, async ($, e, next) => {
    const post = ghPost(e.command)
    if (post.kind === `none`) return next(e)
    const body = post.kind === `file` ? await $.fs.read(post.path) : e.command
    let verdict: Verdict = markerVerdict(body)
    if (!verdict.deny) {
      const scan = await $.process.run(
        [`gitleaks`, `stdin`, `--no-banner`, `--redact`],
        { stdin: body, timeoutMs: 8000 },
      )
      verdict = leakVerdict(scan.exitCode)
    }
    if (!verdict.deny) return next(e)
    await log($, { event: `gh`, command: e.command.slice(0, 120), deny: verdict.deny })
    return { deny: verdict.deny }
  }).catch((_$, e, next) =>
    next.called ? next(e) : {
      deny: `The check of this post failed (an unreadable body file, or gitleaks did not run), ` +
        `so it was not sent. Give --body-file an absolute path.`,
    }
  )
}
