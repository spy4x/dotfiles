#!/usr/bin/env -S deno run -A
// Compares two arms of an experiment from the lanes.jsonl the collector wrote. Every figure that
// summarises a group prints with a bootstrap 95% interval, and every arm-to-arm difference says
// whether its interval crosses zero (no difference shown).
//
// Usage:
//   deno task experiment:analyse <run folder> [--seed N] [--iterations N]
//
// The run folder must hold `plan.md` (the pre-registered question and arms, see README.md) and
// `lanes.jsonl`. Without a plan the run is refused: arms chosen after seeing the data prove
// nothing.
//
// Ported from the 29-30 September trial's `units2.py` and `compare4.py`; the grouping and the
// column definitions are the same so its published tables can be reproduced.

import { join } from "jsr:@std/path@^1.0.0"
import { type PrInfo, type ReviewRound, SCHEMA_VERSION } from "./schema.ts"
import type { LaneRow } from "./schema.ts"
import {
  bootstrap,
  bootstrapDifference,
  type BootstrapOptions,
  crossesZero,
  mean,
  median,
} from "./stats.ts"

/** A plan that is missing or incomplete, or a run folder that is not usable. */
export class PlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = `PlanError`
  }
}

/** The pre-registered parts of a run, read from `key: value` lines of `plan.md`. */
export interface Plan {
  /** Model id of the baseline arm (the control). */
  readonly armA: string
  /** Model id of the arm under test. */
  readonly armB: string
  /** Units that started from here, before `trialStart`, with `armA`, form the baseline column. */
  readonly baselineStart: string
  /** Units that started from here form the trial columns. */
  readonly trialStart: string
  /** Which arm an odd issue number assigns: `arm_b` (default) or `arm_a`. */
  readonly oddIssues: `arm_a` | `arm_b`
  /** The plan's first heading, shown above the tables. */
  readonly title: string
}

const REQUIRED_KEYS = [`arm_a`, `arm_b`, `baseline_start`, `trial_start`]

/** Reads `plan.md`'s `key: value` lines. Throws `PlanError` naming each missing key. */
export function parsePlan(text: string): Plan {
  const kv = new Map<string, string>()
  for (const line of text.split(`\n`)) {
    const m = line.match(/^\s*[-*]?\s*([a-z_]+):\s*(\S.*?)\s*$/)
    if (m && !kv.has(m[1])) kv.set(m[1], m[2])
  }
  const missing = REQUIRED_KEYS.filter((k) => !kv.has(k))
  if (missing.length > 0) {
    throw new PlanError(
      `plan.md must set ${
        missing.map((k) => `\`${k}:\``).join(`, `)
      } (one per line, \`key: value\`)`,
    )
  }
  for (const k of [`baseline_start`, `trial_start`]) {
    if (Number.isNaN(Date.parse(kv.get(k)!))) throw new PlanError(`plan.md: \`${k}\` is not a date`)
  }
  const odd = kv.get(`odd_issues`) ?? `arm_b`
  if (odd !== `arm_a` && odd !== `arm_b`) {
    throw new PlanError(`plan.md: \`odd_issues\` must be arm_a or arm_b`)
  }
  return {
    armA: kv.get(`arm_a`)!,
    armB: kv.get(`arm_b`)!,
    baselineStart: kv.get(`baseline_start`)!,
    trialStart: kv.get(`trial_start`)!,
    oddIssues: odd,
    title: text.match(/^#\s+(.+)$/m)?.[1] ?? `Experiment`,
  }
}

/** Parses `lanes.jsonl`, refusing another schema version. */
export function parseRows(text: string): LaneRow[] {
  const rows: LaneRow[] = []
  for (const [i, line] of text.split(`\n`).entries()) {
    if (line.trim() === ``) continue
    const row = JSON.parse(line) as LaneRow
    if (row.schema !== SCHEMA_VERSION) {
      throw new PlanError(
        `lanes.jsonl line ${i + 1} has schema ${row.schema}; this analysis reads ${SCHEMA_VERSION}`,
      )
    }
    rows.push(row)
  }
  return rows
}

// ===== Units =====

/** One unit of work: the implementer lanes that share a PR, with the PRs they opened. */
export interface Unit {
  readonly prs: string[]
  readonly repo: string
  readonly model: string
  readonly start: string
  readonly period: `A` | `B` | `C`
  readonly agentTypes: string[]
  readonly compactions: number
  readonly cost: number
  readonly reviewCost: number
  readonly calls: number
  readonly tokens: LaneRow[`tokens`]
  readonly peakK: number
  readonly lines: number
  readonly merged: boolean
  readonly mergedAt: string | null
  readonly reviewed: boolean
  readonly firstPass: boolean | null
  readonly rounds: number | null
  readonly issue: number | null
  readonly issueSource: `brief` | `closing ref` | `none`
}

/**
 * Groups implementer lanes that share a PR into units, as the trial did. A lane with no PR forms
 * no unit. Lanes whose PR has no review verdict still form a unit, but not a reviewed one.
 */
export function buildUnits(rows: readonly LaneRow[], plan: Plan): Unit[] {
  const lanes = rows.filter((r) => r.role === `implementer` && r.prs.length > 0)
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x)
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!)
      x = parent.get(x)!
    }
    return x
  }
  lanes.forEach((l, i) => {
    for (const pr of l.prs) parent.set(find(`L${i}`), find(`P${pr}`))
  })
  const groups = new Map<string, LaneRow[]>()
  lanes.forEach((l, i) => {
    const g = find(`L${i}`)
    groups.set(g, [...(groups.get(g) ?? []), l])
  })

  const units: Unit[] = []
  for (const group of groups.values()) {
    const prs = [...new Set(group.flatMap((l) => l.prs))].sort()
    const info = new Map<string, PrInfo>()
    const verdicts = new Map<string, ReviewRound[]>()
    for (const l of group) {
      for (const pr of prs) {
        if (l.prInfo[pr]) info.set(pr, l.prInfo[pr])
        if (!verdicts.has(pr) && l.reviews[pr]) verdicts.set(pr, l.reviews[pr])
      }
    }
    if (info.size !== prs.length) continue

    const calls = new Map<string, number>()
    for (const l of group) calls.set(l.model, (calls.get(l.model) ?? 0) + l.calls)
    const ranked = [...calls].sort((a, b) => b[1] - a[1])
    let model = ranked[0][0]
    const total = ranked.reduce((s, [, n]) => s + n, 0)
    if (ranked.length > 1 && ranked[1][1] > 0.2 * total) model = `mixed`

    const per = prs.map((pr) => {
      const seq = (verdicts.get(pr) ?? []).map((r) => r.verdict)
      if (seq.length === 0) return null
      return {
        passRound: seq.includes(`pass`) ? seq.indexOf(`pass`) + 1 : null,
        first: seq[0] === `pass`,
      }
    })
    const reviewed = per.every((p) => p !== null)
    const start = group.map((l) => l.start).sort()[0]
    const briefIssues = group.filter((l) => l.issueSource === `brief`).map((l) => l.issue!)
    const closing = group.find((l) => l.issueSource === `closing-ref`)
    const issue = briefIssues.length > 0 ? Math.min(...briefIssues) : closing?.issue ?? null
    const infos = [...info.values()]

    units.push({
      prs,
      repo: prs[0].split(`#`)[0].split(`/`)[1],
      model,
      start,
      period: Date.parse(start) < Date.parse(plan.baselineStart)
        ? `A`
        : Date.parse(start) < Date.parse(plan.trialStart)
        ? `B`
        : `C`,
      agentTypes: [...new Set(group.map((l) => l.agentType))].sort(),
      compactions: group.reduce((s, l) => s + l.compactions, 0),
      cost: group.reduce((s, l) => s + l.cost, 0),
      reviewCost: prs.reduce(
        (s, pr) => s + (verdicts.get(pr) ?? []).reduce((a, r) => a + r.cost, 0),
        0,
      ),
      calls: group.reduce((s, l) => s + l.calls, 0),
      tokens: {
        input: group.reduce((s, l) => s + l.tokens.input, 0),
        output: group.reduce((s, l) => s + l.tokens.output, 0),
        cacheRead: group.reduce((s, l) => s + l.tokens.cacheRead, 0),
        cacheWrite5m: group.reduce((s, l) => s + l.tokens.cacheWrite5m, 0),
        cacheWrite1h: group.reduce((s, l) => s + l.tokens.cacheWrite1h, 0),
      },
      peakK: Math.max(...group.map((l) => Math.floor(l.peakContext / 1000))),
      lines: infos.reduce((s, i) => s + i.additions + i.deletions, 0),
      merged: infos.every((i) => i.state === `MERGED`),
      mergedAt: infos.map((i) => i.mergedAt ?? ``).sort().at(-1) || null,
      reviewed,
      firstPass: reviewed ? per.every((p) => p!.first) : null,
      rounds: reviewed && per.every((p) => p!.passRound)
        ? Math.max(...per.map((p) => p!.passRound!))
        : null,
      issue,
      issueSource: briefIssues.length > 0 ? `brief` : closing ? `closing ref` : `none`,
    })
  }
  return units.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
}

/** The arm the plan's issue-number rule assigns to `issue`; arm A when there is no issue. */
export function assignedArm(issue: number | null, plan: Plan): string {
  if (issue === null) return plan.armA
  const odd = issue % 2 === 1
  return odd === (plan.oddIssues === `arm_b`) ? plan.armB : plan.armA
}

// ===== Formatting =====

type Format = (x: number) => string

const num = (digits: number): Format => (x) =>
  x.toLocaleString(`en-US`, { minimumFractionDigits: digits, maximumFractionDigits: digits })
const usd = (digits = 2): Format => (x) => `$${num(digits)(x)}`
const pct: Format = (x) => `${(x * 100).toFixed(0)}%`

function cell(
  values: number[],
  stat: (v: readonly number[]) => number | undefined,
  fmt: Format,
  options: BootstrapOptions,
): string {
  const interval = bootstrap(values, stat, options)
  if (!interval) return `–`
  return `${fmt(interval.value)} (95% ${fmt(interval.lo)} to ${fmt(interval.hi)})`
}

// ===== Tables =====

// Dollars per million tokens of Opus 5.5, for the "same, at Opus 5.5 prices" row.
const EQ = { input: 4, output: 20, cacheRead: 0.2 }
const atOpusPrices = (t: Unit[`tokens`]) =>
  (t.input * EQ.input + t.output * EQ.output + t.cacheWrite5m * EQ.input * 1.25 +
    t.cacheWrite1h * EQ.input * 2 + t.cacheRead * EQ.cacheRead) / 1e6

interface Metric {
  readonly label: string
  readonly pick: (units: Unit[]) => number[]
  readonly stat: (v: readonly number[]) => number | undefined
  readonly fmt: Format
}

const withLines = (us: Unit[]) => us.filter((u) => u.lines > 0)
const reviewedOf = (us: Unit[]) => us.filter((u) => u.reviewed)
const hours = (u: Unit) =>
  u.mergedAt ? (Date.parse(u.mergedAt) - Date.parse(u.start)) / 3_600_000 : undefined
const defined = (xs: (number | undefined)[]) => xs.filter((x): x is number => x !== undefined)

const METRICS: Metric[] = [
  {
    label: `Median changed lines`,
    pick: (us) => us.map((u) => u.lines),
    stat: median,
    fmt: num(0),
  },
  {
    label: `Implementer cost per 100 lines`,
    pick: (us) => withLines(us).map((u) => u.cost / u.lines * 100),
    stat: median,
    fmt: usd(),
  },
  {
    label: `Same, at Opus 5.5 prices`,
    pick: (us) => withLines(us).map((u) => atOpusPrices(u.tokens) / u.lines * 100),
    stat: median,
    fmt: usd(),
  },
  {
    label: `Review cost per 100 lines`,
    pick: (us) => withLines(reviewedOf(us)).map((u) => u.reviewCost / u.lines * 100),
    stat: median,
    fmt: usd(),
  },
  {
    label: `Total cost per 100 lines (impl + review)`,
    pick: (us) => withLines(reviewedOf(us)).map((u) => (u.cost + u.reviewCost) / u.lines * 100),
    stat: median,
    fmt: usd(),
  },
  {
    label: `Median total cost per PR`,
    pick: (us) => reviewedOf(us).map((u) => u.cost + u.reviewCost),
    stat: median,
    fmt: usd(),
  },
  {
    label: `Calls per 100 lines`,
    pick: (us) => withLines(us).map((u) => u.calls / u.lines * 100),
    stat: median,
    fmt: num(1),
  },
  {
    label: `Output per 100 lines (K tokens)`,
    pick: (us) => withLines(us).map((u) => u.tokens.output / u.lines * 100 / 1000),
    stat: median,
    fmt: num(1),
  },
  {
    label: `Median peak context (K)`,
    pick: (us) => us.map((u) => u.peakK),
    stat: median,
    fmt: num(0),
  },
  {
    label: `Median review rounds to pass`,
    pick: (us) => reviewedOf(us).flatMap((u) => u.rounds === null ? [] : [u.rounds]),
    stat: median,
    fmt: num(1),
  },
  {
    label: `Mean review rounds to pass`,
    pick: (us) => reviewedOf(us).flatMap((u) => u.rounds === null ? [] : [u.rounds]),
    stat: mean,
    fmt: num(2),
  },
  {
    label: `Median hours from spawn to merge`,
    pick: (us) => defined(us.map(hours)),
    stat: median,
    fmt: num(1),
  },
]

function column(units: Unit[], options: BootstrapOptions): Record<string, string> {
  const reviewed = reviewedOf(units)
  const passed = reviewed.filter((u) => u.firstPass).length
  const out: Record<string, string> = {
    [`Units of work (PRs)`]: String(units.length),
    [`Merged`]: String(units.filter((u) => u.merged).length),
  }
  for (const m of METRICS.slice(0, 1)) out[m.label] = cell(m.pick(units), m.stat, m.fmt, options)
  for (const m of METRICS.slice(1)) out[m.label] = cell(m.pick(units), m.stat, m.fmt, options)
  out[`Passed first review`] = reviewed.length === 0
    ? `–`
    : `${passed} of ${reviewed.length} (${pct(passed / reviewed.length)}, 95% ${
      intervalPct(reviewed.map((u) => u.firstPass ? 1 : 0), options)
    })`
  return out
}

function intervalPct(values: number[], options: BootstrapOptions): string {
  const i = bootstrap(values, mean, options)!
  return `${pct(i.lo)} to ${pct(i.hi)}`
}

const ROW_ORDER = [
  `Units of work (PRs)`,
  `Merged`,
  ...METRICS.slice(0, 6).map((m) => m.label),
  ...METRICS.slice(6, 9).map((m) => m.label),
  `Passed first review`,
  ...METRICS.slice(9).map((m) => m.label),
]

function table(columns: Record<string, Record<string, string>>): string[] {
  const names = Object.keys(columns)
  const lines = [`| | ${names.join(` | `)} |`, `|${`---|`.repeat(names.length + 1)}`]
  for (const row of ROW_ORDER) {
    lines.push(`| ${row} | ${names.map((n) => columns[n][row]).join(` | `)} |`)
  }
  return lines
}

// ===== Differences =====

interface DiffMetric {
  readonly label: string
  readonly pick: (units: Unit[]) => number[]
  readonly stat: (v: readonly number[]) => number | undefined
  readonly fmt: Format
  readonly lowerIsBetter: boolean
}

const DIFFS: DiffMetric[] = [
  {
    label: `Total cost per PR (median, impl + review)`,
    pick: (us) => reviewedOf(us).map((u) => u.cost + u.reviewCost),
    stat: median,
    fmt: usd(),
    lowerIsBetter: true,
  },
  {
    label: `Total cost per PR (mean, impl + review)`,
    pick: (us) => reviewedOf(us).map((u) => u.cost + u.reviewCost),
    stat: mean,
    fmt: usd(),
    lowerIsBetter: true,
  },
  {
    label: `Review cost per PR (median)`,
    pick: (us) => reviewedOf(us).map((u) => u.reviewCost),
    stat: median,
    fmt: usd(),
    lowerIsBetter: true,
  },
  {
    label: `First review passed (share of PRs)`,
    pick: (us) => reviewedOf(us).map((u) => u.firstPass ? 1 : 0),
    stat: mean,
    fmt: (x) => `${x.toFixed(1)} points`,
    lowerIsBetter: false,
  },
  {
    label: `Review rounds to pass (mean)`,
    pick: (us) => reviewedOf(us).flatMap((u) => u.rounds === null ? [] : [u.rounds]),
    stat: mean,
    fmt: num(2),
    lowerIsBetter: true,
  },
  {
    label: `Peak context (median, K)`,
    pick: (us) => us.map((u) => u.peakK),
    stat: median,
    fmt: num(0),
    lowerIsBetter: true,
  },
  {
    label: `Total cost per 100 lines (median; the figure the trial published)`,
    pick: (us) => withLines(reviewedOf(us)).map((u) => (u.cost + u.reviewCost) / u.lines * 100),
    stat: median,
    fmt: usd(),
    lowerIsBetter: true,
  },
]

function differences(
  a: Unit[],
  b: Unit[],
  nameA: string,
  nameB: string,
  options: BootstrapOptions,
): string[] {
  const lines = [
    `| Measure | ${nameB} minus ${nameA} (95% interval) | Reading |`,
    `|---|---|---|`,
  ]
  for (const d of DIFFS) {
    const interval = bootstrapDifference(d.pick(a), d.pick(b), d.stat, options)
    if (!interval) {
      lines.push(`| ${d.label} | – | too few units |`)
      continue
    }
    const scale = d.label.startsWith(`First`) ? 100 : 1
    const show = (x: number) => d.fmt(x * scale).replace(/^\$-/, `-$`)
    const reading = crossesZero(interval)
      ? `interval crosses zero: no difference shown`
      : (interval.value < 0) === d.lowerIsBetter
      ? `${nameB} better, interval excludes zero`
      : `${nameB} worse, interval excludes zero`
    lines.push(
      `| ${d.label} | ${show(interval.value)} (${show(interval.lo)} to ${
        show(interval.hi)
      }) | ${reading} |`,
    )
  }
  return lines
}

// ===== Report =====

const strip = (model: string) => model.replace(`claude-`, ``)

/** Renders the full Markdown report for a plan and its lanes. */
export function renderReport(
  rows: readonly LaneRow[],
  plan: Plan,
  options: BootstrapOptions = {},
): string {
  const units = buildUnits(rows, plan)
  const A = plan.armA
  const B = plan.armB
  const baseline = units.filter((u) => u.model === A && u.period === `B`)
  const trial = units.filter((u) => u.period === `C` && (u.model === A || u.model === B))
  const trialA = trial.filter((u) => u.model === A)
  const trialB = trial.filter((u) => u.model === B)
  const followed = (u: Unit) => u.issue !== null && assignedArm(u.issue, plan) === u.model
  const nameA = strip(A)
  const nameB = strip(B)
  const out: string[] = []
  const seed = options.seed ?? 1
  const iterations = options.iterations ?? 10_000

  out.push(`# ${plan.title}`, ``)
  out.push(
    `Arms: ${nameA} (baseline) against ${nameB}. Intervals are percentile bootstrap 95% ` +
      `intervals (seed ${seed}, ${iterations} resamples). A difference whose interval crosses ` +
      `zero is not a difference.`,
    ``,
  )
  out.push(`## Headline: cost and quality per PR, ${nameB} minus ${nameA}, trial units`, ``)
  out.push(
    `Cost is judged per PR. A per-line figure rewards fewer lines, which penalises the "build ` +
      `less" rule, so the per-line row is printed only to match the published trial tables.`,
    ``,
  )
  out.push(...differences(trialA, trialB, nameA, nameB, options), ``)

  out.push(`## Table 1: every trial unit`, ``)
  out.push(
    ...table({
      [`${nameA}, before the trial`]: column(baseline, options),
      [`${nameA}, trial`]: column(trialA, options),
      [`${nameB}, trial`]: column(trialB, options),
    }),
    ``,
  )

  out.push(`## Table 2: only units whose model followed the issue-number rule`, ``)
  out.push(
    ...table({
      [`${nameA}, trial, rule followed`]: column(trialA.filter(followed), options),
      [`${nameB}, trial, rule followed`]: column(trialB.filter(followed), options),
    }),
    ``,
  )

  out.push(`## Arm balance`, ``)
  const balance = new Map<string, number>()
  for (const u of trial) {
    const verdict = u.issue === null ? `no issue` : followed(u) ? `follows` : `wrong model`
    const key = `- ${strip(u.model)}, issue from ${u.issueSource}: ${verdict}`
    balance.set(key, (balance.get(key) ?? 0) + 1)
  }
  for (const [k, v] of [...balance].sort()) out.push(`${k} — ${v}`)
  out.push(``)

  out.push(`## Same repo, both arms in the trial`, ``)
  out.push(
    `| Repo | ${nameA}: PRs, total $/100 lines, 1st pass | ${nameB}: PRs, total $/100 lines, 1st pass |`,
    `|---|---|---|`,
  )
  for (const repo of [...new Set(trial.map((u) => u.repo))].sort()) {
    const cells = [A, B].map((m) => {
      const us = trial.filter((u) => u.model === m && u.repo === repo)
      const rv = us.filter((u) => u.reviewed && u.lines > 0)
      const m100 = median(rv.map((u) => (u.cost + u.reviewCost) / u.lines * 100))
      return {
        n: us.length,
        text: `${us.length}, ${m100 === undefined ? `–` : usd()(m100)}, ${
          rv.filter((u) => u.firstPass).length
        }/${rv.length}`,
      }
    })
    if (cells.every((c) => c.n > 0)) out.push(`| ${repo} | ${cells[0].text} | ${cells[1].text} |`)
  }
  out.push(``)

  out.push(`## Reviewers`, ``)
  const reviewers = rows.filter((r) => r.role === `reviewer`)
  const reviewerLine = (rs: LaneRow[]) => {
    const rounds = rs.flatMap((r) => r.rounds)
    if (rounds.length === 0) return `–`
    const nf = rounds.filter((x) => x.verdict === `needs-fix`).length
    const nfInterval = intervalPct(rounds.map((x) => x.verdict === `needs-fix` ? 1 : 0), options)
    const cost = cell(rounds.map((x) => x.cost), median, usd(), options)
    return `${rounds.length} rounds, ${nf} needs-fix (${
      pct(nf / rounds.length)
    }, 95% ${nfInterval}), ` +
      `median ${cost} and ${num(0)(median(rounds.map((x) => x.calls))!)} calls per round`
  }
  const t0 = Date.parse(plan.baselineStart)
  const t1 = Date.parse(plan.trialStart)
  out.push(
    `- ${plan.baselineStart} to trial: ${
      reviewerLine(reviewers.filter((r) => Date.parse(r.start) >= t0 && Date.parse(r.start) < t1))
    }`,
  )
  const trialReviewers = reviewers.filter((r) => Date.parse(r.start) >= t1)
  out.push(`- trial: ${reviewerLine(trialReviewers)}`)
  for (const model of [...new Set(trialReviewers.map((r) => r.model))].sort()) {
    out.push(
      `  - ${strip(model)}: ${reviewerLine(trialReviewers.filter((r) => r.model === model))}`,
    )
  }
  out.push(``)

  const counts = new Map<string, number>()
  for (const u of units) {
    const key = `(${u.period}, ${strip(u.model)})`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  out.push(
    `Units by period and model: ${[...counts].sort().map(([k, v]) => `${k}: ${v}`).join(`, `)}`,
  )
  const rulesSeen = new Set(rows.map((r) => r.dotfilesCommit).filter(Boolean))
  out.push(``, `Dotfiles commits live at lane spawn: ${rulesSeen.size} distinct.`)
  return out.join(`\n`) + `\n`
}

// ===== CLI =====

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

/** Reads a run folder and renders its report; throws `PlanError` when `plan.md` is missing. */
export async function analyseFolder(
  folder: string,
  options: BootstrapOptions = {},
): Promise<string> {
  let planText: string
  try {
    planText = await Deno.readTextFile(join(folder, `plan.md`))
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new PlanError(
        `${folder} has no plan.md. Write the question, the arms and the dates before analysing ` +
          `(see tools/experiments/README.md).`,
      )
    }
    throw error
  }
  const plan = parsePlan(planText)
  const rows = parseRows(await Deno.readTextFile(join(folder, `lanes.jsonl`)))
  return renderReport(rows, plan, options)
}

if (import.meta.main) {
  const folder = Deno.args.find((a) => !a.startsWith(`--`))
  if (!folder) {
    console.error(`usage: analyse.ts <run folder> [--seed N] [--iterations N]`)
    Deno.exit(2)
  }
  const seed = flag(Deno.args, `--seed`)
  const iterations = flag(Deno.args, `--iterations`)
  try {
    console.log(
      await analyseFolder(folder, {
        seed: seed === undefined ? undefined : Number(seed),
        iterations: iterations === undefined ? undefined : Number(iterations),
      }),
    )
  } catch (error) {
    console.error(`analyse failed: ${error instanceof Error ? error.message : error}`)
    Deno.exit(1)
  }
}
