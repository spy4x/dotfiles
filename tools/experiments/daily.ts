#!/usr/bin/env -S deno run -A
// One row of usage per UTC day: spend, each role's share of it, Sonnet's share of implementer and
// reviewer calls, compactions per role, median implementer peak context and spend per merged PR.
//
// Usage: deno task experiment:daily [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--projects <dir>]
//
// Ported from `ai-memory/experiments/week-2026-10-01/daily.py`. Unlike `collect.ts` it reads lead
// sessions too, so it scans every transcript under the projects directory itself. The traps of
// issue #93 hold: a call is dated by its own message timestamp, the model is `message.model`,
// each `message.id` is priced once, and compactions are `compact_boundary` events.

import { parseArgs } from "jsr:@std/cli@1.0.32/parse-args"
import { join } from "jsr:@std/path@1.1.6"
import { costOf, ctxOf, parseTranscript, totalOf } from "../session-cost.ts"
import { denoExec, type Exec } from "./exec.ts"
import { median } from "./stats.ts"

export type Role = `lead` | `implementer` | `reviewer` | `other`
const ROLES: Role[] = [`lead`, `implementer`, `reviewer`, `other`]

/** One transcript and who wrote it. */
export interface TranscriptInput {
  readonly role: Role
  readonly lines: string[]
}

/** What one UTC day holds. */
export interface DayStats {
  readonly day: string
  readonly cost: Record<Role, number>
  readonly sonnetCalls: Record<Role, number>
  readonly opusCalls: Record<Role, number>
  readonly compactions: Record<Role, number>
  /** Peak single-call context of each implementer transcript that has calls on this day. */
  readonly implementerPeaks: number[]
}

/** Maps a subagent's `agentType` to a role: both implementers are one role, the rest are other. */
export function roleOf(agentType: string | undefined): Role {
  if (agentType === undefined) return `lead`
  if (agentType === `implementer` || agentType === `implementer-xhigh`) return `implementer`
  if (agentType === `reviewer`) return `reviewer`
  return `other`
}

const zero = (): Record<Role, number> => ({ lead: 0, implementer: 0, reviewer: 0, other: 0 })

const emptyDay = (day: string): DayStats => ({
  day,
  cost: zero(),
  sonnetCalls: zero(),
  opusCalls: zero(),
  compactions: zero(),
  implementerPeaks: [],
})

const family = (model: string) =>
  model.startsWith(`claude-sonnet`) ? `sonnet` : model.startsWith(`claude-opus`) ? `opus` : null

/**
 * Buckets transcripts by UTC day. A call or compaction counts on the day of its own timestamp.
 * Calls whose model has no price are skipped and returned by model, so the caller can say so.
 */
export function scanDays(
  inputs: readonly TranscriptInput[],
): { days: Map<string, DayStats>; unpriced: Record<string, number> } {
  const days = new Map<string, DayStats>()
  const unpriced: Record<string, number> = {}
  const get = (day: string) => {
    let d = days.get(day)
    if (!d) days.set(day, d = emptyDay(day))
    return d
  }
  for (const input of inputs) {
    const { calls, compactionTimestamps } = parseTranscript(input.lines)
    const peaks = new Map<string, number>()
    for (const call of calls) {
      const priced = costOf(call)
      if (!priced.priced) {
        unpriced[call.model] = (unpriced[call.model] ?? 0) + 1
        continue
      }
      const day = call.timestamp.slice(0, 10)
      const d = get(day)
      d.cost[input.role] += totalOf(priced.cost)
      const f = family(call.model)
      if (f === `sonnet`) d.sonnetCalls[input.role]++
      if (f === `opus`) d.opusCalls[input.role]++
      peaks.set(day, Math.max(peaks.get(day) ?? 0, ctxOf(call)))
    }
    if (input.role === `implementer`) {
      for (const [day, peak] of peaks) get(day).implementerPeaks.push(peak)
    }
    for (const ts of compactionTimestamps) get(ts.slice(0, 10)).compactions[input.role]++
  }
  return { days, unpriced }
}

/** Every UTC day from `since` to `until` inclusive, as `YYYY-MM-DD`. */
export function daysBetween(since: string, until: string): string[] {
  const out: string[] = []
  for (let t = Date.parse(since); t <= Date.parse(until); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`

/** The header of the table `renderRow` fills. */
export const HEADER = [
  `| Day (UTC) | Spend | Spend share lead / impl / reviewer / other | Sonnet share of impl calls | Sonnet share of reviewer calls | Compactions lead / impl / reviewer | Median impl peak context | Merged PRs | Spend per merged PR |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
]

/** One Markdown table row. */
export function renderRow(stats: DayStats, mergedPrs: number): string {
  const total = ROLES.reduce((s, r) => s + stats.cost[r], 0)
  const share = (r: Role) => total > 0 ? pct(stats.cost[r] / total) : `–`
  const sonnet = (r: Role) => {
    const s = stats.sonnetCalls[r]
    const n = s + stats.opusCalls[r]
    return n > 0 ? pct(s / n) : `–`
  }
  const peak = median(stats.implementerPeaks)
  const c = stats.compactions
  const shares = `${share(`lead`)} / ${share(`implementer`)} / ${share(`reviewer`)} / ${
    share(`other`)
  }`
  return `| ${stats.day} | $${total.toFixed(0)} | ${shares} | ${sonnet(`implementer`)} | ${
    sonnet(`reviewer`)
  } | ${c.lead} / ${c.implementer} / ${c.reviewer} | ${
    peak === undefined ? `0K` : `${(peak / 1000).toFixed(0)}K`
  } | ${mergedPrs} | ${mergedPrs > 0 ? `$${(total / mergedPrs).toFixed(2)}` : `–`} |`
}

/** Merged PRs of the `spy4x` organisation on `day`; throws when `gh` fails or answers oddly. */
export async function mergedPrs(day: string, exec: Exec): Promise<number> {
  const out = (await exec(`gh`, [
    `api`,
    `-X`,
    `GET`,
    `search/issues`,
    `-f`,
    `q=org:spy4x is:pr is:merged merged:${day}`,
    `-q`,
    `.total_count`,
  ])).trim()
  if (!/^\d+$/.test(out)) throw new Error(`gh search failed for ${day}: ${JSON.stringify(out)}`)
  return Number(out)
}

const USAGE = `usage: daily.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--projects <dir>]`

/** A command line the daily view cannot run with. */
export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`)
    this.name = `UsageError`
  }
}

/** A real calendar day written `YYYY-MM-DD`; anything else throws `UsageError`. */
export function parseDay(name: string, value: string): string {
  const real = /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
  if (!real) throw new UsageError(`--${name} must be a date written YYYY-MM-DD, not "${value}"`)
  return value
}

/** Reads the command line. Without flags: the last 7 days up to `now`'s UTC day. */
export function parseCli(
  args: string[],
  now: Date = new Date(),
): { since: string; until: string; projects: string | undefined } {
  const parsed = parseArgs(args, {
    string: [`since`, `until`, `projects`],
    unknown: (arg) => {
      throw new UsageError(`unknown argument ${arg}`)
    },
  })
  const until = parsed.until === undefined
    ? now.toISOString().slice(0, 10)
    : parseDay(`until`, parsed.until)
  const since = parsed.since === undefined
    ? new Date(Date.parse(until) - 6 * 86_400_000).toISOString().slice(0, 10)
    : parseDay(`since`, parsed.since)
  if (since > until) throw new UsageError(`--since ${since} is after --until ${until}`)
  return { since, until, projects: parsed.projects }
}

/** Every transcript under `projectsDir` that was written to on or after `since`. */
export async function readTranscripts(
  projectsDir: string,
  since: string,
): Promise<TranscriptInput[]> {
  // A file is only ever appended to, so one last written before `since` has no message from
  // `since` on. This skips old files; it never dates a message (that is its own timestamp).
  const floor = Date.parse(`${since}T00:00:00Z`)
  const out: TranscriptInput[] = []
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name)
      if (entry.isDirectory) {
        await walk(path)
      } else if (entry.isFile && entry.name.endsWith(`.jsonl`)) {
        const stat = await Deno.stat(path)
        if ((stat.mtime?.getTime() ?? Infinity) < floor) continue
        let role: Role = `lead`
        if (path.includes(`/subagents/`)) {
          try {
            const meta = JSON.parse(await Deno.readTextFile(path.slice(0, -6) + `.meta.json`))
            role = roleOf(typeof meta.agentType === `string` ? meta.agentType : `other`)
          } catch {
            role = `other`
          }
        }
        out.push({ role, lines: (await Deno.readTextFile(path)).split(`\n`) })
      }
    }
  }
  await walk(projectsDir)
  return out
}

/** Renders the table for `since` to `until`; the merged-PR counts come from `exec`. */
export async function renderDaily(
  inputs: readonly TranscriptInput[],
  since: string,
  until: string,
  exec: Exec,
): Promise<{ table: string; unpriced: Record<string, number> }> {
  const { days, unpriced } = scanDays(inputs)
  const rows = [...HEADER]
  for (const day of daysBetween(since, until)) {
    rows.push(renderRow(days.get(day) ?? emptyDay(day), await mergedPrs(day, exec)))
  }
  return { table: rows.join(`\n`), unpriced }
}

if (import.meta.main) {
  let cli: ReturnType<typeof parseCli>
  try {
    cli = parseCli(Deno.args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    Deno.exit(2)
  }
  try {
    const home = Deno.env.get(`HOME`)
    const projects = cli.projects ?? (home ? join(home, `.claude`, `projects`) : undefined)
    if (!projects) throw new Error(`no --projects given and $HOME is not set`)
    const inputs = await readTranscripts(projects, cli.since)
    const { table, unpriced } = await renderDaily(inputs, cli.since, cli.until, denoExec)
    console.log(table)
    for (const [model, n] of Object.entries(unpriced)) {
      console.error(`warning: ${n} calls on ${model} have no price and are left out`)
    }
  } catch (error) {
    console.error(`daily failed: ${error instanceof Error ? error.message : error}`)
    Deno.exit(1)
  }
}
