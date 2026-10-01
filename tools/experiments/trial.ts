#!/usr/bin/env -S deno run -A
// The reviewer-trial view: what the 7 October 2026 decision needs, from one run folder.
//
// Usage:
//   deno task experiment:trial <run folder> --log <sonnet55-reviewer.md> \
//     [--since ISO] [--projects <dir>] [--seed N] [--iterations N]
//
// The run folder holds `lanes.jsonl` (see `collect.ts`). `--log` is the markdown file whose table
// lists the double-checked passes. `--projects` is the transcripts directory; with it the view
// also prices what each implementer spent fixing after a needs-fix verdict.
//
// The trial's rules (ai-memory/experiments/sonnet55-reviewer.md): an odd issue number assigns the
// Sonnet reviewer, an even one the Opus reviewer. A PR with no issue, in `preact-components`, or
// on auth or crypto work stays on Opus, outside the arms. Re-reviews continue the same reviewer.
// A PR's issue comes from the log, then the rows, then the PR body, which the view reads with
// `gh` for every reviewed PR still without one.

import { parseArgs } from "jsr:@std/cli@1.0.32/parse-args"
import { join } from "jsr:@std/path@1.1.6"
import { costOf, parseTranscript, totalOf } from "../session-cost.ts"
import { parseRows } from "./analyse.ts"
import { denoExec, type Exec } from "./exec.ts"
import { taskClassOf } from "./lane.ts"
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

/** Where a reviewed PR's issue number came from, in the order the view tries them. */
export const ISSUE_SOURCES = [`log`, `closing reference`, `implementer lane`, `PR body`] as const
export type IssueSource = typeof ISSUE_SOURCES[number]

/** Everything the trial knows about one reviewed PR. */
export interface PrReview {
  readonly pr: string
  readonly repo: string
  readonly issue: number | null
  readonly issueSource: IssueSource | null
  readonly taskClass: LaneRow[`taskClass`]
  /** Every review round on the PR since the trial began, oldest first. */
  readonly rounds: ReviewRound[]
  /** The implementer lanes that opened the PR. */
  readonly implementers: LaneRow[]
}

/** Issue numbers the rows do not carry, per PR (`owner/repo#n`). */
export interface ExtraIssues {
  /** From the double-check log's Issue column: the lead's own record of the PR's issue. */
  readonly log?: ReadonlyMap<string, number>
  /** From issue references in the PR's body (see `issueInBody`). */
  readonly body?: ReadonlyMap<string, number>
}

/** The lowest issue the log names for each PR it lists. */
export function logIssues(pairs: readonly LogPair[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const pair of pairs) {
    if (pair.issue === null) continue
    for (const pr of pair.prs) out.set(pr, Math.min(pair.issue, out.get(pr) ?? Infinity))
  }
  return out
}

/**
 * Review rounds per PR since `since`, with the PR's issue and the task class of its implementers.
 * The issue is the first of: the log's Issue column, the PR's closing references, the
 * implementer lane's issue (the collector reads it from the brief), issue references in the PR
 * body. Several numbers from one source: the lowest, as the trial's rule says.
 */
export function reviewedPrs(
  rows: readonly LaneRow[],
  since: string,
  extra: ExtraIssues = {},
): PrReview[] {
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
    const one = (n: number | undefined) => n === undefined ? [] : [n]
    const candidates: Record<IssueSource, number[]> = {
      log: one(extra.log?.get(pr)),
      "closing reference": rows.flatMap((r) => r.prInfo[pr]?.closingIssues ?? []),
      "implementer lane": implementers.flatMap((r) => r.issue === null ? [] : [r.issue]),
      "PR body": one(extra.body?.get(pr)),
    }
    const source = ISSUE_SOURCES.find((s) => candidates[s].length > 0) ?? null
    out.push({
      pr,
      repo: pr.split(`#`)[0],
      issue: source === null ? null : Math.min(...candidates[source]),
      issueSource: source,
      taskClass: implementers.some((r) => r.taskClass === `auth/crypto`)
        ? `auth/crypto`
        : implementers[0]?.taskClass ?? null,
      rounds: rounds.toSorted((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0),
      implementers,
    })
  }
  return out.toSorted((a, b) => a.pr < b.pr ? -1 : 1)
}

/** A sentence that opens with an issue keyword, up to the next full stop or line end. */
const BODY_REF_SENTENCE = new RegExp(
  String.raw`\b(?:part of|addresses|refs?|references|closes|fixes|resolves|issue)\b` +
    String.raw`([^\n]*?)(?:\.(?=\s)|\n|$)`,
  `gi`,
)

/**
 * The lowest issue a PR body points at: issue URLs and `#n` refs in a sentence that opens with
 * "Part of", "Addresses", "Refs", "References", "Closes", "Fixes", "Resolves" or "Issue"; null
 * when there is none. Refs in other sentences (follow-ups, related PRs) do not count.
 */
export function issueInBody(body: string): number | null {
  const nums: number[] = []
  for (const sentence of body.matchAll(BODY_REF_SENTENCE)) {
    for (const m of sentence[1].matchAll(/(?:\/issues\/|#)(\d+)/g)) nums.push(Number(m[1]))
  }
  return nums.length > 0 ? Math.min(...nums) : null
}

/** The issue each PR's body points at (see `issueInBody`), read with `gh`; a failed read throws. */
export async function bodyIssues(prs: readonly string[], exec: Exec): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const pr of prs) {
    const [repo, n] = pr.split(`#`)
    const issue = issueInBody(
      await exec(`gh`, [`pr`, `view`, n, `-R`, repo, `--json`, `body`, `-q`, `.body`]),
    )
    if (issue !== null) out.set(pr, issue)
  }
  return out
}

/** Why a reviewed PR is in neither arm, or its arm. */
export type Placement =
  | Arm
  | `no issue`
  | `Sonnet reviewed, issue not found`
  | `preact-components`
  | `auth/crypto`
  | `other model`

/**
 * Arm by issue number; the exclusions the trial's file names; a PR reviewed by the wrong model.
 * A PR with no issue belongs to Opus by the trial's rule, so a Sonnet first round on one means the
 * issue was not found, not that the PR is outside the trial: it gets a line of its own.
 */
export function placeOf(review: PrReview): Placement {
  if (review.issue === null) {
    return armOfModel(review.rounds[0].reviewerModel) === `sonnet`
      ? `Sonnet reviewed, issue not found`
      : `no issue`
  }
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

/** A stretch of time: after `from`, and before `to` when `to` is set. */
export interface Window {
  readonly from: string
  readonly to: string | null
}

/**
 * When an implementer fixed what a reviewer of an arm PR asked for.
 *
 * `fix`: from the arm reviewer's first needs-fix (among its rounds up to its first pass) to its
 * first pass or the other model's first round, whichever comes first. Fixing after that answers
 * the double-check, not the arm's reviewer.
 *
 * `afterDoubleCheck`: from the other model's first needs-fix to that model's next pass (open
 * while it has not passed). That is the work the double-check caused.
 */
export function fixWindows(
  review: PrReview,
  arm: Arm,
): { fix: Window | null; afterDoubleCheck: Window | null } {
  const { armRounds, passed } = armPr(review, arm)
  const other = review.rounds.filter((r) => armOfModel(r.reviewerModel) !== arm)
  const from = armRounds.find((r) => r.verdict === `needs-fix`)?.ts
  const ends = [...(passed ? [armRounds.at(-1)!.ts] : []), ...(other[0] ? [other[0].ts] : [])]
  const to = ends.length > 0 ? ends.sort()[0] : null
  const otherFix = other.findIndex((r) => r.verdict === `needs-fix`)
  const otherPass = other.slice(otherFix + 1).find((r) => r.verdict === `pass`)
  return {
    fix: from !== undefined && (to === null || from < to) ? { from, to } : null,
    afterDoubleCheck: otherFix === -1
      ? null
      : { from: other[otherFix].ts, to: otherPass?.ts ?? null },
  }
}

/** One implementer lane of an arm and when it was fixing. */
export interface FixLane {
  readonly lane: LaneRow
  readonly arm: Arm
  /** The `fix` windows of the lane's arm PRs (see `fixWindows`); empty when none needed a fix. */
  readonly fix: Window[]
  /** The `afterDoubleCheck` windows of the lane's arm PRs. */
  readonly afterDoubleCheck: Window[]
}

/** Lanes whose arm PRs all sit in one arm, and how many were left out as mixed. */
export function fixLanes(
  reviews: readonly PrReview[],
): { lanes: FixLane[]; mixed: number } {
  const byLane = new Map<LaneRow, { arm: Arm; windows: ReturnType<typeof fixWindows> }[]>()
  for (const review of reviews) {
    const place = placeOf(review)
    if (place !== `sonnet` && place !== `opus`) continue
    for (const lane of review.implementers) {
      byLane.set(lane, [...(byLane.get(lane) ?? []), {
        arm: place,
        windows: fixWindows(review, place),
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
    lanes.push({
      lane,
      arm: parts[0].arm,
      fix: parts.flatMap((p) => p.windows.fix ?? []),
      afterDoubleCheck: parts.flatMap((p) => p.windows.afterDoubleCheck ?? []),
    })
  }
  return { lanes, mixed }
}

/**
 * Dollars an implementer spent inside `windows`: its calls dated after a window's `from` and
 * before its `to`, each call once. Calls after the lane's `end` are left out, so a lane still
 * running when the run was collected is priced as the run saw it. Reads the lane's own
 * transcript; a missing transcript throws, since a lane priced as $0 would pass for one that never
 * had to fix anything.
 */
export async function costIn(
  projects: string,
  lane: LaneRow,
  windows: readonly Window[],
): Promise<number> {
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
  const inside = (ts: string) =>
    ts <= lane.end && windows.some((w) => w.from < ts && (w.to === null || ts < w.to))
  for (const call of parseTranscript(text.split(`\n`)).calls) {
    if (!inside(call.timestamp)) continue
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
  /** Issues read from PR bodies (see `bodyIssues`); the log's issues come from `pairs`. */
  readonly bodyIssues?: ReadonlyMap<string, number>
  /** Implementer fix cost per lane (agent id to dollars), when transcripts were available. */
  readonly fixCost?: ReadonlyMap<string, number>
  /** What each lane spent fixing after a double-check's needs-fix (agent id to dollars). */
  readonly doubleCheckFixCost?: ReadonlyMap<string, number>
  readonly options?: BootstrapOptions
}

/** Words that put a 🔴 in a security path, besides the collector's auth/crypto words. */
const SECURITY_WORDS = /credential|leak|inject|xss|csrf|bypass|privilege|vulnerab|exploit/i

/** The text of a note's 🔴 findings: each 🔴 up to the next marker; the whole note if none. */
function redText(note: string): string {
  const parts = [...note.matchAll(/🔴([^🔴🟡🔵]*)/gu)].map((m) => m[1])
  return parts.length > 0 ? parts.join(` `) : note
}

/**
 * True when a log row's 🔴 finding sits in a security path: the 🔴 part of its note uses
 * security, auth, crypto or secret wording (the collector's auth/crypto words, plus
 * `SECURITY_WORDS`), or one of its PRs is auth or crypto work. Wording in a 🟡 or 🔵 part does
 * not count.
 */
export function isSecurityRed(pair: LogPair, rows: readonly LaneRow[]): boolean {
  if (pair.red === 0) return false
  const red = redText(pair.note)
  if (taskClassOf(red) === `auth/crypto` || SECURITY_WORDS.test(red)) return true
  return pair.prs.some((pr) =>
    rows.some((r) =>
      r.role === `implementer` && r.prs.includes(pr) && r.taskClass === `auth/crypto`
    )
  )
}

/** Renders the report as Markdown. */
export function renderTrial(input: TrialInput): string {
  const options = input.options ?? {}
  const reviews = reviewedPrs(input.rows, input.since, {
    log: logIssues(input.pairs),
    body: input.bodyIssues,
  })
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
      `**TRIAL STOPPING: a 🔴 finding in a security path** (${pair.date}, ${pair.prCell}): ` +
        pair.note,
      ``,
    )
  }

  const left = [`no issue`, `preact-components`, `auth/crypto`, `other model`] as const
  const bySource = (s: IssueSource | null) => reviews.filter((r) => r.issueSource === s).length
  const lost = places.get(`Sonnet reviewed, issue not found`) ?? []
  out.push(
    `Reviewed PRs since ${input.since}: ${reviews.length}. In the arms: ${sonnet.length} Sonnet, ` +
      `${opus.length} Opus (an odd issue number assigns Sonnet, an even one Opus). Left out: ` +
      left.map((p) => `${places.get(p)?.length ?? 0} ${p}`).join(`, `) + `.`,
    ``,
    `Issue taken from: ` +
      ISSUE_SOURCES.map((s) => `${bySource(s)} the ${s}`).join(`, `) +
      `; ${bySource(null)} found none.`,
    ``,
  )
  if (lost.length > 0) {
    out.push(
      `**Sonnet reviewed, issue not found: ${lost.length}** (${
        lost.map((r) => r.pr).join(`, `)
      }). A PR with no issue belongs to Opus, so these lost their issue on the way here; they ` +
        `are in neither arm until their issue is found.`,
      ``,
    )
  }
  out.push(
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
      const fixed = ls.filter((l) => l.fix.length > 0)
      const cost = (l: FixLane) => input.fixCost!.get(l.lane.agentId) ?? 0
      return `${ls.length} lanes, ${fixed.length} needed a fix; mean per lane ${
        show(ls.map(cost), mean, usd, options)
      }; median per lane that needed a fix ${show(fixed.map(cost), median, usd, options)}`
    }
    const afterDoubleCheck = (arm: Arm) => {
      const ls = lanes.filter((l) => l.arm === arm && l.afterDoubleCheck.length > 0)
      const total = ls.reduce((s, l) => s + (input.doubleCheckFixCost?.get(l.lane.agentId) ?? 0), 0)
      return `${ls.length} lanes, ${usd(total)} in total`
    }
    out.push(
      `Dollars an implementer spent from the arm reviewer's first needs-fix verdict to its pass, ` +
        `or to the other model's first round if that came sooner; a lane with no needs-fix ` +
        `counts $0.`,
      ``,
      `- Sonnet reviewer: ${cells(`sonnet`)}`,
      `- Opus reviewer: ${cells(`opus`)}`,
      `- Fixes after the other model's needs-fix (the double-check), up to that model's pass; ` +
        `left out above: Sonnet arm ${afterDoubleCheck(`sonnet`)}; Opus arm ${
          afterDoubleCheck(`opus`)
        }.`,
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

/**
 * Reads the run folder and the log, reads the body of every reviewed PR that still has no issue
 * (with `exec`, which runs `gh`), and renders the report.
 */
export async function trialReport(
  cli: ReturnType<typeof parseCli>,
  exec: Exec = denoExec,
): Promise<{ text: string; stopping: boolean }> {
  const rows = parseRows(await Deno.readTextFile(join(cli.folder, `lanes.jsonl`)))
  const pairs = parseLog(await Deno.readTextFile(cli.log))
  const log = logIssues(pairs)
  const missing = reviewedPrs(rows, cli.since, { log }).filter((r) => r.issue === null)
  const body = await bodyIssues(missing.map((r) => r.pr), exec)
  let fixCost: Map<string, number> | undefined
  let doubleCheckFixCost: Map<string, number> | undefined
  if (cli.projects !== undefined) {
    fixCost = new Map()
    doubleCheckFixCost = new Map()
    const { lanes } = fixLanes(reviewedPrs(rows, cli.since, { log, body }))
    for (const l of lanes) {
      if (l.fix.length > 0) {
        fixCost.set(l.lane.agentId, await costIn(cli.projects, l.lane, l.fix))
      }
      if (l.afterDoubleCheck.length > 0) {
        doubleCheckFixCost.set(
          l.lane.agentId,
          await costIn(cli.projects, l.lane, l.afterDoubleCheck),
        )
      }
    }
  }
  return {
    text: renderTrial({
      rows,
      pairs,
      since: cli.since,
      bodyIssues: body,
      fixCost,
      doubleCheckFixCost,
      options: cli.options,
    }),
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
