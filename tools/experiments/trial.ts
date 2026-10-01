#!/usr/bin/env -S deno run -A
// The reviewer-trial view: what the 7 October 2026 decision needs, from one run folder.
//
// Usage:
//   deno task experiment:trial <run folder> --log <sonnet55-reviewer.md> \
//     [--since ISO] [--projects <dir>] [--seed N] [--iterations N]
//
// The run folder holds `lanes.jsonl` (see `collect.ts`). `--log` is the markdown file whose table
// lists the double-checked passes. `--projects` is the transcripts directory; with it the view
// also prices what each implementer spent after its first needs-fix verdict.
//
// The trial's rules (ai-memory/experiments/sonnet55-reviewer.md): an odd issue number assigns the
// Sonnet reviewer, an even one the Opus reviewer. A PR with no issue, in `preact-components`, or
// on auth or crypto work stays on Opus, outside the arms. Re-reviews continue the same reviewer.

import { parseArgs } from "jsr:@std/cli@1.0.32/parse-args"
import { join } from "jsr:@std/path@1.1.6"
import { costOf, parseTranscript, totalOf } from "../session-cost.ts"
import { parseRows } from "./analyse.ts"
import type { LaneRow, ReviewRound } from "./schema.ts"
import {
  bootstrap,
  type BootstrapOptions,
  type Interval,
  mean,
  median,
  quantileSorted,
  seededRandom,
} from "./stats.ts"

/** The trial began on 1 October 2026 (UTC). */
export const TRIAL_START = `2026-10-01T00:00:00Z`
/** The bar the trial's file suggests. */
export const BAR = { minPairs: 10, maxRedShare: 0.1, minCostReduction: 0.3 }

export type Arm = `sonnet` | `opus`

/** The reviewer arm that an issue number assigns: odd is Sonnet, even is Opus. */
export function armOfIssue(issue: number): Arm {
  return issue % 2 === 1 ? `sonnet` : `opus`
}

function armOfModel(model: string): Arm | null {
  if (model.startsWith(`claude-sonnet`)) return `sonnet`
  if (model.startsWith(`claude-opus`)) return `opus`
  return null
}

// ===== Double-check log =====

/** One row of the double-check log. */
export interface LogPair {
  readonly date: string
  readonly prCell: string
  /** Every PR the PR cell names, as `owner/repo#n` (see `prsInCell`). */
  readonly prs: string[]
  /** The lowest issue number the Issue cell names. */
  readonly issue: number | null
  readonly sonnetVerdict: string
  readonly opusVerdict: string
  readonly red: number
  readonly yellow: number
  readonly blue: number
  readonly note: string
}

const splitRow = (row: string) =>
  row.trim().replace(/^\|/, ``).replace(/\|$/, ``).split(/(?<!\\)\|/).map((c) => c.trim())

const PR_IN_CELL = /(?:([\w.-]+)\/)?([\w.-]+)?#(\d+)/g

/**
 * Every PR a log cell names, as `owner/repo#n`: `spy4x/zond#9, caldav-mcp#11` and
 * `spy4x/site#360 → #362` each name two. A ref without an owner takes the previous ref's owner
 * (`spy4x` when none came before); a bare `#n` takes the previous ref's repo, and throws when
 * there is none.
 */
export function prsInCell(cell: string): string[] {
  const out: string[] = []
  let owner = `spy4x`
  let repo: string | null = null
  for (const m of cell.matchAll(PR_IN_CELL)) {
    if (m[2]) {
      owner = m[1] ?? owner
      repo = m[2]
    } else if (repo === null) {
      throw new Error(`"#${m[3]}" names no repo and no repo comes before it`)
    }
    out.push(`${owner}/${repo}#${m[3]}`)
  }
  return out
}

/**
 * Reads the double-check table out of a markdown file: the table whose header names a
 * "Sonnet verdict" and an "Opus verdict" column. Throws on a row it cannot read: a row skipped
 * silently would change the decision.
 */
export function parseLog(text: string): LogPair[] {
  const lines = text.split(`\n`)
  const headerAt = lines.findIndex((l) => /sonnet verdict/i.test(l) && /opus verdict/i.test(l))
  if (headerAt === -1) {
    throw new Error(`the log has no table with "Sonnet verdict" and "Opus verdict" columns`)
  }
  const header = splitRow(lines[headerAt]).map((h) => h.toLowerCase())
  const col = (needle: string) => {
    const i = header.findIndex((h) => h.includes(needle))
    if (i === -1) throw new Error(`the log table has no "${needle}" column`)
    return i
  }
  const [cDate, cPr, cIssue, cSonnet, cOpus, cFind, cNote] = [
    col(`date`),
    col(`pr`),
    col(`issue`),
    col(`sonnet verdict`),
    col(`opus verdict`),
    col(`findings`),
    col(`note`),
  ]
  const pairs: LogPair[] = []
  for (let i = headerAt + 1; i < lines.length && lines[i].trim().startsWith(`|`); i++) {
    const cells = splitRow(lines[i])
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue
    const unreadable = (why: string) =>
      new Error(`cannot read log row ${i + 1} (${why}): ${lines[i].slice(0, 80)}`)
    const findings = cells[cFind]?.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/)
    if (cells.length < header.length || !findings) throw unreadable(`no findings count`)
    let prs: string[]
    try {
      prs = prsInCell(cells[cPr])
    } catch (error) {
      throw unreadable(error instanceof Error ? error.message : String(error))
    }
    if (prs.length === 0) throw unreadable(`no PR`)
    const issues = [...cells[cIssue].matchAll(/#(\d+)/g)].map((m) => Number(m[1]))
    pairs.push({
      date: cells[cDate],
      prCell: cells[cPr],
      prs,
      issue: issues.length > 0 ? Math.min(...issues) : null,
      sonnetVerdict: cells[cSonnet],
      opusVerdict: cells[cOpus],
      red: Number(findings[1]),
      yellow: Number(findings[2]),
      blue: Number(findings[3]),
      note: cells[cNote],
    })
  }
  return pairs
}

// ===== Reviews per PR =====

/** Everything the trial knows about one reviewed PR. */
export interface PrReview {
  readonly pr: string
  readonly repo: string
  readonly issue: number | null
  readonly taskClass: LaneRow[`taskClass`]
  /** Every review round on the PR since the trial began, oldest first. */
  readonly rounds: ReviewRound[]
  /** The implementer lanes that opened the PR. */
  readonly implementers: LaneRow[]
}

/** Review rounds per PR since `since`, with the issue and task class of the PR's implementers. */
export function reviewedPrs(rows: readonly LaneRow[], since: string): PrReview[] {
  const sinceMs = Date.parse(since)
  const byPr = new Map<string, ReviewRound[]>()
  for (const row of rows) {
    if (row.role !== `reviewer`) continue
    for (const round of row.rounds) {
      if (round.pr === null || Date.parse(round.ts) < sinceMs) continue
      byPr.set(round.pr, [...(byPr.get(round.pr) ?? []), round])
    }
  }
  const out: PrReview[] = []
  for (const [pr, rounds] of byPr) {
    const implementers = rows.filter((r) => r.role === `implementer` && r.prs.includes(pr))
    const closing = rows.flatMap((r) => r.prInfo[pr]?.closingIssues ?? [])
    const fromLanes = implementers.flatMap((r) => r.issue === null ? [] : [r.issue])
    const issues = closing.length > 0 ? closing : fromLanes
    out.push({
      pr,
      repo: pr.split(`#`)[0],
      issue: issues.length > 0 ? Math.min(...issues) : null,
      taskClass: implementers.some((r) => r.taskClass === `auth/crypto`)
        ? `auth/crypto`
        : implementers[0]?.taskClass ?? null,
      rounds: rounds.toSorted((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0),
      implementers,
    })
  }
  return out.toSorted((a, b) => a.pr < b.pr ? -1 : 1)
}

/** Why a reviewed PR is in neither arm, or its arm. */
export type Placement = Arm | `no issue` | `preact-components` | `auth/crypto` | `other model`

/** Arm by issue number; the exclusions the trial's file names; a PR reviewed by the wrong model. */
export function placeOf(review: PrReview): Placement {
  if (review.issue === null) return `no issue`
  if (review.repo.endsWith(`/preact-components`)) return `preact-components`
  if (review.taskClass === `auth/crypto`) return `auth/crypto`
  const assigned = armOfIssue(review.issue)
  return armOfModel(review.rounds[0].reviewerModel) === assigned ? assigned : `other model`
}

/** One arm PR as the metrics need it. */
export interface ArmPr {
  readonly pr: string
  /** The arm model's own rounds, up to and including its first pass. */
  readonly armRounds: ReviewRound[]
  readonly passed: boolean
  /** Review cost of those rounds. */
  readonly cost: number
  /** What the other model's rounds (the double-check) cost. */
  readonly otherCost: number
  readonly needsFix: number
}

/** The arm model's rounds on a PR, up to and including its first pass. */
export function armPr(review: PrReview, arm: Arm): ArmPr {
  const own = review.rounds.filter((r) => armOfModel(r.reviewerModel) === arm)
  const firstPass = own.findIndex((r) => r.verdict === `pass`)
  const counted = firstPass === -1 ? own : own.slice(0, firstPass + 1)
  return {
    pr: review.pr,
    armRounds: counted,
    passed: firstPass !== -1,
    cost: counted.reduce((s, r) => s + r.cost, 0),
    otherCost: review.rounds.filter((r) => armOfModel(r.reviewerModel) !== arm)
      .reduce((s, r) => s + r.cost, 0),
    needsFix: counted.filter((r) => r.verdict === `needs-fix`).length,
  }
}

// ===== Implementer fix cost =====

/** The first needs-fix verdict timestamp of an arm PR, or null. */
function firstNeedsFix(review: PrReview, arm: Arm): string | null {
  const own = review.rounds.filter((r) => armOfModel(r.reviewerModel) === arm)
  return own.find((r) => r.verdict === `needs-fix`)?.ts ?? null
}

/** One implementer lane of an arm and the moment its fixing began. */
export interface FixLane {
  readonly lane: LaneRow
  readonly arm: Arm
  /** Earliest needs-fix verdict on any of the lane's arm PRs; null when none. */
  readonly from: string | null
}

/** Lanes whose arm PRs all sit in one arm. Returns the lanes and how many were left out as mixed. */
export function fixLanes(
  reviews: readonly PrReview[],
): { lanes: FixLane[]; mixed: number } {
  const byLane = new Map<LaneRow, { arm: Arm; from: string | null }[]>()
  for (const review of reviews) {
    const place = placeOf(review)
    if (place !== `sonnet` && place !== `opus`) continue
    for (const lane of review.implementers) {
      byLane.set(lane, [...(byLane.get(lane) ?? []), {
        arm: place,
        from: firstNeedsFix(review, place),
      }])
    }
  }
  const lanes: FixLane[] = []
  let mixed = 0
  for (const [lane, parts] of byLane) {
    if (new Set(parts.map((p) => p.arm)).size > 1) {
      mixed++
      continue
    }
    const froms = parts.flatMap((p) => p.from === null ? [] : [p.from]).sort()
    lanes.push({ lane, arm: parts[0].arm, from: froms[0] ?? null })
  }
  return { lanes, mixed }
}

/**
 * Dollars an implementer spent after `from`: its calls dated later than the first needs-fix
 * verdict. Reads the lane's own transcript; a missing transcript throws, since a lane priced as
 * $0 would pass for one that never had to fix anything.
 */
export async function costAfter(projects: string, lane: LaneRow, from: string): Promise<number> {
  const path = join(
    projects,
    lane.project,
    lane.session,
    `subagents`,
    `agent-${lane.agentId}.jsonl`,
  )
  let text: string
  try {
    text = await Deno.readTextFile(path)
  } catch (error) {
    throw new Error(
      `cannot read the transcript of implementer ${lane.agentId} at ${path}: ${error}`,
    )
  }
  let cost = 0
  for (const call of parseTranscript(text.split(`\n`)).calls) {
    if (call.timestamp <= from) continue
    const priced = costOf(call)
    if (!priced.priced) {
      throw new Error(
        `implementer ${lane.agentId} has a call on ${call.model}, which has no price; add it to ` +
          `tools/session-cost.ts instead of counting it as $0`,
      )
    }
    cost += totalOf(priced.cost)
  }
  return cost
}

// ===== Statistics =====

/** Bootstrap interval of a ratio of sums over PRs: resamples the PRs, not the rounds. */
function ratioInterval(
  num: readonly number[],
  den: readonly number[],
  options: BootstrapOptions,
): Interval | undefined {
  const ratio = (idx: readonly number[]) => {
    const d = idx.reduce((s, i) => s + den[i], 0)
    return d === 0 ? undefined : idx.reduce((s, i) => s + num[i], 0) / d
  }
  return bootstrap(num.map((_, i) => i), ratio, options)
}

/**
 * Interval of `1 - median(a) / median(b)`: how much lower the median of `a` is than that of `b`.
 * Each group is resampled on its own.
 */
export function reductionInterval(
  a: readonly number[],
  b: readonly number[],
  options: BootstrapOptions = {},
): Interval | undefined {
  const ma = median(a)
  const mb = median(b)
  if (ma === undefined || mb === undefined || mb === 0) return undefined
  const random = seededRandom(options.seed ?? 1)
  const pick = (v: readonly number[]) => v.map(() => v[Math.floor(random() * v.length)])
  const draws: number[] = []
  for (let i = 0; i < (options.iterations ?? 10_000); i++) {
    const d = median(pick(b))!
    if (d !== 0) draws.push(1 - median(pick(a))! / d)
  }
  draws.sort((x, y) => x - y)
  const tail = (1 - (options.level ?? 0.95)) / 2
  return {
    value: 1 - ma / mb,
    lo: quantileSorted(draws, tail),
    hi: quantileSorted(draws, 1 - tail),
  }
}

const usd = (x: number) => `$${x.toFixed(2)}`
const share = (x: number) => `${(x * 100).toFixed(0)}%`

function show(
  values: readonly number[],
  statistic: (v: readonly number[]) => number | undefined,
  fmt: (x: number) => string,
  options: BootstrapOptions,
): string {
  const iv = bootstrap(values, statistic, options)
  return iv === undefined ? `–` : `${fmt(iv.value)} (${fmt(iv.lo)} to ${fmt(iv.hi)})`
}

// ===== Report =====

/** What `renderTrial` needs besides the rows. */
export interface TrialInput {
  readonly rows: readonly LaneRow[]
  readonly pairs: readonly LogPair[]
  readonly since: string
  /** Implementer fix cost per lane (agent id to dollars), when transcripts were available. */
  readonly fixCost?: ReadonlyMap<string, number>
  readonly options?: BootstrapOptions
}

/** True when a log row's red finding sits in a security path: its note says so, or its PR is auth or crypto work. */
export function isSecurityRed(pair: LogPair, rows: readonly LaneRow[]): boolean {
  if (pair.red === 0) return false
  if (/security/i.test(pair.note)) return true
  return pair.prs.some((pr) =>
    rows.some((r) =>
      r.role === `implementer` && r.prs.includes(pr) && r.taskClass === `auth/crypto`
    )
  )
}

/** Renders the report as Markdown. */
export function renderTrial(input: TrialInput): string {
  const options = input.options ?? {}
  const reviews = reviewedPrs(input.rows, input.since)
  const places = new Map<Placement, PrReview[]>()
  for (const review of reviews) {
    const p = placeOf(review)
    places.set(p, [...(places.get(p) ?? []), review])
  }
  const arms = (a: Arm) => (places.get(a) ?? []).map((r) => armPr(r, a))
  const sonnet = arms(`sonnet`)
  const opus = arms(`opus`)
  const out: string[] = [`# Reviewer trial`, ``]

  for (const pair of input.pairs.filter((p) => isSecurityRed(p, input.rows))) {
    out.push(
      `**TRIAL STOPPING: a 🔴 finding in a security path** (${pair.date}, ${pair.prCell}): ${pair.note}`,
      ``,
    )
  }

  const left = [`no issue`, `preact-components`, `auth/crypto`, `other model`] as const
  out.push(
    `Reviewed PRs since ${input.since}: ${reviews.length}. In the arms: ${sonnet.length} Sonnet, ` +
      `${opus.length} Opus (an odd issue number assigns Sonnet, an even one Opus). Left out: ` +
      left.map((p) => `${places.get(p)?.length ?? 0} ${p}`).join(`, `) + `.`,
    ``,
    `## Per arm`,
    ``,
    `Medians and rates with a bootstrap 95% interval, resampling PRs. Only the arm's own ` +
      `reviewer counts, and only its rounds up to its first pass. Cost and rounds use PRs that ` +
      `reviewer has passed, so a PR still waiting for its pass drops out of them; the needs-fix ` +
      `rate uses every PR of the arm, waiting ones included.`,
    ``,
    `| | Sonnet reviewer | Opus reviewer |`,
    `| --- | --- | --- |`,
  )
  const passed = (a: ArmPr[]) => a.filter((p) => p.passed)
  const cell = (f: (a: ArmPr[]) => string) => `| ${f(sonnet)} | ${f(opus)} |`
  out.push(
    `| PRs (passed) ${cell((a) => `${a.length} (${passed(a).length})`)}`,
    `| Review cost per PR, median ${
      cell((a) => show(passed(a).map((p) => p.cost), median, usd, options))
    }`,
    `| Review rounds to pass, mean ${
      cell((a) =>
        show(passed(a).map((p) => p.armRounds.length), mean, (x) => x.toFixed(2), options)
      )
    }`,
    `| Needs-fix rate per round ${
      cell((a) => {
        const iv = ratioInterval(
          a.map((p) => p.needsFix),
          a.map((p) => p.armRounds.length),
          options,
        )
        return iv ? `${share(iv.value)} (${share(iv.lo)} to ${share(iv.hi)})` : `–`
      })
    }`,
  )
  const reduction = reductionInterval(
    passed(sonnet).map((p) => p.cost),
    passed(opus).map((p) => p.cost),
    options,
  )
  out.push(
    ``,
    reduction
      ? `Review cost per PR, Sonnet against Opus: ${share(reduction.value)} lower (95% interval ${
        share(reduction.lo)
      } to ${share(reduction.hi)}).`
      : `Review cost per PR, Sonnet against Opus: not enough passed PRs in both arms.`,
    ``,
  )

  const doubleCheck = sonnet.reduce((s, p) => s + p.otherCost, 0)
  out.push(
    `Double-check rounds on Sonnet-arm PRs (another model's, left out above) cost ${
      usd(doubleCheck)
    } in total.`,
    ``,
    `### Implementer fix cost after reviews`,
    ``,
  )
  if (input.fixCost === undefined) {
    out.push(`Not computed: give \`--projects <transcripts dir>\` to price it.`)
  } else {
    const { lanes, mixed } = fixLanes(reviews)
    const cells = (arm: Arm) => {
      const ls = lanes.filter((l) => l.arm === arm)
      const fixed = ls.filter((l) => l.from !== null)
      const cost = (l: FixLane) => input.fixCost!.get(l.lane.agentId) ?? 0
      return `${ls.length} lanes, ${fixed.length} needed a fix; mean per lane ${
        show(ls.map(cost), mean, usd, options)
      }; median per lane that needed a fix ${show(fixed.map(cost), median, usd, options)}`
    }
    out.push(
      `Dollars an implementer spent after its first needs-fix verdict; a lane with none counts $0.`,
      ``,
      `- Sonnet reviewer: ${cells(`sonnet`)}`,
      `- Opus reviewer: ${cells(`opus`)}`,
      `- ${mixed} lanes with PRs in both arms are left out.`,
    )
  }

  const n = input.pairs.length
  const withRed = input.pairs.filter((p) => p.red > 0).length
  const flags = input.pairs.map((p) => p.red > 0 ? 1 : 0)
  const redIv = bootstrap(flags, mean, options)
  const sum = (f: (p: LogPair) => number) => input.pairs.reduce((s, p) => s + f(p), 0)
  out.push(
    ``,
    `## Double-checked pairs`,
    ``,
    `Pairs: ${n}. Sonnet passes with at least one 🔴 from the Opus double-check: ${withRed}` +
      (n > 0 && redIv
        ? ` (${share(redIv.value)}, 95% interval ${share(redIv.lo)} to ${share(redIv.hi)})`
        : ``) +
      `. Findings in total: ${sum((p) => p.red)} 🔴, ${sum((p) => p.yellow)} 🟡, ${
        sum((p) => p.blue)
      } 🔵. 🔴 per Sonnet pass: ${n > 0 ? (sum((p) => p.red) / n).toFixed(2) : `–`}.`,
    ``,
    `## Bar`,
    ``,
  )
  if (n < BAR.minPairs) {
    out.push(`Not enough pairs (n<${BAR.minPairs}): no verdict on the bar yet.`)
  } else {
    const redShare = withRed / n
    out.push(
      `- 🔴 in at most 1 in 10 Sonnet passes: ${
        redShare <= BAR.maxRedShare ? `met` : `not met`
      } (${withRed} of ${n}).`,
      reduction
        ? `- Review cost per PR at least 30% lower: ${
          reduction.value >= BAR.minCostReduction ? `met` : `not met`
        } (${share(reduction.value)} lower).`
        : `- Review cost per PR at least 30% lower: no data.`,
    )
  }
  return out.join(`\n`)
}

// ===== CLI =====

// Exit codes: 0 report printed, 1 failure, 2 bad command line, 3 report printed and it holds a
// trial-stopping line.
const USAGE =
  `usage: trial.ts <run folder> --log <markdown file> [--since ISO] [--projects <dir>] ` +
  `[--seed N] [--iterations N]`

/** A command line the trial view cannot run with. */
export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`)
    this.name = `UsageError`
  }
}

/**
 * True for a real calendar day written `YYYY-MM-DD`, alone or followed by a time with `Z` or an
 * offset. `Date.parse` alone would take `1` as the year 2001.
 */
export function isIsoInstant(value: string): boolean {
  const m = value.match(
    /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/,
  )
  return m !== null && !Number.isNaN(Date.parse(value)) &&
    new Date(`${m[1]}T00:00:00Z`).toISOString().startsWith(m[1])
}

/** Reads the command line. */
export function parseCli(args: string[]): {
  folder: string
  log: string
  since: string
  projects: string | undefined
  options: BootstrapOptions
} {
  const parsed = parseArgs(args, {
    string: [`log`, `since`, `projects`, `seed`, `iterations`],
    unknown: (arg) => {
      if (arg.startsWith(`-`)) throw new UsageError(`unknown flag ${arg}`)
      return true
    },
  })
  if (parsed._.length !== 1) throw new UsageError(`give exactly one run folder`)
  if (!parsed.log) throw new UsageError(`--log <markdown file> is required`)
  const since = parsed.since ?? TRIAL_START
  if (!isIsoInstant(since)) {
    throw new UsageError(
      `--since must be an ISO date (2026-10-01) or a time with its zone ` +
        `(2026-10-01T00:00:00Z), not "${since}"`,
    )
  }
  const whole = (name: string, value: string | undefined, min: number) => {
    if (value === undefined) return undefined
    if (!/^-?\d+$/.test(value) || Number(value) < min) {
      throw new UsageError(`--${name} must be a whole number of at least ${min}, not "${value}"`)
    }
    return Number(value)
  }
  return {
    folder: String(parsed._[0]),
    log: parsed.log,
    since,
    projects: parsed.projects,
    options: {
      seed: whole(`seed`, parsed.seed, Number.MIN_SAFE_INTEGER),
      iterations: whole(`iterations`, parsed.iterations, 1),
    },
  }
}

/** Reads the run folder and the log and renders the report. */
export async function trialReport(
  cli: ReturnType<typeof parseCli>,
): Promise<{ text: string; stopping: boolean }> {
  const rows = parseRows(await Deno.readTextFile(join(cli.folder, `lanes.jsonl`)))
  const pairs = parseLog(await Deno.readTextFile(cli.log))
  let fixCost: Map<string, number> | undefined
  if (cli.projects !== undefined) {
    fixCost = new Map()
    const { lanes } = fixLanes(reviewedPrs(rows, cli.since))
    for (const l of lanes) {
      if (l.from !== null) {
        fixCost.set(l.lane.agentId, await costAfter(cli.projects, l.lane, l.from))
      }
    }
  }
  return {
    text: renderTrial({ rows, pairs, since: cli.since, fixCost, options: cli.options }),
    stopping: pairs.some((p) => isSecurityRed(p, rows)),
  }
}

/** Exit code when the report holds a trial-stopping line, so a scheduled run cannot miss it. */
export const EXIT_TRIAL_STOPPING = 3

if (import.meta.main) {
  let cli: ReturnType<typeof parseCli>
  try {
    cli = parseCli(Deno.args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    Deno.exit(2)
  }
  try {
    const { text, stopping } = await trialReport(cli)
    console.log(text)
    if (stopping) Deno.exit(EXIT_TRIAL_STOPPING)
  } catch (error) {
    console.error(`trial failed: ${error instanceof Error ? error.message : error}`)
    Deno.exit(1)
  }
}
