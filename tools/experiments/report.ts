#!/usr/bin/env -S deno run -A
// Writes `report.md` and `chart.svg` into a run folder: a short, readable account of one
// experiment that a blog post can quote. The figures are the ones `analyse.ts` prints, so the two
// always agree. Nothing here reads transcript text: only the numbers and ids of the lane rows.
//
// Usage:
//   deno task experiment:report <run folder> [--seed N] [--iterations N]

import { join } from "jsr:@std/path@1.1.6"
import {
  assignedArm,
  buildUnits,
  parseCli,
  parsePlan,
  parseRows,
  pct,
  PlanError,
  reviewedOf,
  strip,
  totalPerPr,
  type Unit,
  usd,
} from "./analyse.ts"
import { type ChartArm, renderChart } from "./chart.ts"
import { FOLLOWUP_SCHEMA_VERSION, type FollowupRow, WINDOW_DAYS } from "./followup.ts"
import type { LaneRow } from "./schema.ts"
import {
  bootstrap,
  bootstrapDifference,
  type BootstrapOptions,
  crossesZero,
  mean,
  median,
} from "./stats.ts"

/** The rendered report and its chart. */
export interface Report {
  readonly markdown: string
  readonly chart: string
}

/** Below this many units in an arm, a bootstrap interval says little. */
export const SMALL_ARM = 20

/** `claude-sonnet-5-5` as `Sonnet 5.5`; an id of another shape comes back without `claude-`. */
export function modelName(model: string): string {
  const m = strip(model).match(/^([a-z]+)((?:-\d+)+)$/)
  if (!m) return strip(model)
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].slice(1).replaceAll(`-`, `.`)}`
}

const dollars = usd()
const signed = (x: number, word: [string, string]) =>
  x < 0 ? `${dollars(-x)} ${word[0]}` : `${dollars(x)} ${word[1]}`

/**
 * The one-sentence headline: the point estimate and its 95% interval, in words. When the
 * interval crosses zero it says so rather than naming a winner.
 */
export function headline(
  nameA: string,
  nameB: string,
  diff: { value: number; lo: number; hi: number } | undefined,
): string {
  if (!diff) {
    return `There is not yet a figure for ${nameB} against ${nameA}: an arm has no reviewed PRs.`
  }
  const less = [`less`, `more`] as [string, string]
  if (crossesZero(diff)) {
    return `${nameB} units cost ${signed(diff.value, less)} per PR than ${nameA} units, but the ` +
      `data cannot tell it from no difference: somewhere between ${signed(diff.lo, less)} and ` +
      `${signed(diff.hi, less)} (95% interval).`
  }
  // The interval excludes zero, so both ends have the point estimate's sign: name the smaller
  // magnitude first.
  const [near, far] = diff.value < 0 ? [diff.hi, diff.lo] : [diff.lo, diff.hi]
  return `${nameB} units cost ${dollars(Math.abs(diff.value))} ${
    diff.value < 0 ? `less` : `more`
  } per PR than ${nameA} units, somewhere between ${dollars(Math.abs(near))} and ${
    dollars(Math.abs(far))
  } (95% interval).`
}

/** Total cost (implementer plus review) of one unit. */
const total = (u: Unit) => u.cost + u.reviewCost

/**
 * The weirdest unit: the trial unit with the highest total cost. It is described from its
 * numbers only, against the median of its own arm.
 */
export function weirdestUnit(trial: Unit[]): Unit | undefined {
  return [...trial].sort((a, b) => total(b) - total(a) || (a.start < b.start ? -1 : 1))[0]
}

/** Renders `report.md` and `chart.svg` for a plan and its lanes. */
export function renderReport(
  rows: readonly LaneRow[],
  plan: ReturnType<typeof parsePlan>,
  options: BootstrapOptions = {},
  followups: readonly FollowupRow[] | null = null,
): Report {
  const units = buildUnits(rows, plan)
  const A = plan.armA
  const B = plan.armB
  const nameA = modelName(A)
  const nameB = modelName(B)
  const trial = units.filter((u) => u.period === `C` && (u.model === A || u.model === B))
  const followed = (u: Unit) => assignedArm(u.issue, plan) === u.model
  const ruleA = trial.filter((u) => u.model === A && followed(u))
  const ruleB = trial.filter((u) => u.model === B && followed(u))
  const seed = options.seed ?? 1
  const iterations = options.iterations ?? 10_000
  const cost = { A: totalPerPr(ruleA), B: totalPerPr(ruleB) }
  const diff = bootstrapDifference(cost.A, cost.B, median, options)
  const intervalA = bootstrap(cost.A, median, options)
  const intervalB = bootstrap(cost.B, median, options)

  const chart = intervalA && intervalB
    ? renderChart(
      [
        { label: nameA, n: cost.A.length, ...intervalA },
        { label: nameB, n: cost.B.length, ...intervalB },
      ] satisfies ChartArm[],
      {
        title: `Median total cost per PR, ${nameA} against ${nameB}`,
        desc: `Median total cost per reviewed PR, implementer plus review, with a 95% bootstrap ` +
          `interval: ${nameA} ${dollars(intervalA.value)} (${dollars(intervalA.lo)} to ${
            dollars(intervalA.hi)
          }) over ${cost.A.length} PRs; ${nameB} ${dollars(intervalB.value)} (${
            dollars(intervalB.lo)
          } to ${dollars(intervalB.hi)}) over ${cost.B.length} PRs.`,
        yLabel: `Median total cost per PR (USD)`,
      },
    )
    : ``

  const out: string[] = [`# ${plan.title}`, ``]
  out.push(`**${headline(nameA, nameB, diff)}**`, ``)
  out.push(
    `Cost here is the implementer's spend plus the reviewers' spend on the same PR, and only ` +
      `units whose issue number assigned their model count.`,
    ``,
  )
  if (chart) {
    out.push(
      `![Median total cost per PR for each arm, with a 95% interval](chart.svg)`,
      ``,
    )
  }

  out.push(`## The comparison`, ``)
  out.push(...comparisonTable(ruleA, ruleB, nameA, nameB, options), ``)

  out.push(...followupSection(ruleA, ruleB, nameA, nameB, followups), ``)

  out.push(`## What would change my mind`, ``)
  const doubts: string[] = []
  if (diff && crossesZero(diff)) {
    doubts.push(
      `The headline interval crosses zero. A real difference of the opposite sign, or none at ` +
        `all, fits this data as well as the point estimate does. More units would narrow it.`,
    )
  }
  for (const [name, n] of [[nameA, cost.A.length], [nameB, cost.B.length]] as const) {
    if (n < SMALL_ARM) {
      doubts.push(
        `${name} has ${n} reviewed units behind its cost figures. Under ${SMALL_ARM} per arm a bootstrap ` +
          `interval is itself shaky, because a single odd PR moves the median.`,
      )
    }
  }
  const big = Math.max(cost.A.length, cost.B.length)
  const small = Math.min(cost.A.length, cost.B.length)
  if (small > 0 && big / small > 1.5) {
    doubts.push(
      `The arms are unbalanced (${cost.A.length} against ${cost.B.length} reviewed units). The larger one ` +
        `averages out luck better than the smaller one.`,
    )
  }
  const roundsOf = (us: Unit[]) =>
    reviewedOf(us).flatMap((u) => u.rounds === null ? [] : [u.rounds])
  const rounds = bootstrapDifference(roundsOf(ruleA), roundsOf(ruleB), mean, options)
  if (diff && !crossesZero(diff) && rounds && !crossesZero(rounds)) {
    const winner = diff.value < 0 ? nameB : nameA
    // Rounds: B minus A. The cost winner is worse on rounds when it needs more of them.
    if ((diff.value < 0) === (rounds.value > 0)) {
      doubts.push(
        `${winner} is cheaper per PR but needs more review rounds to pass (mean difference ` +
          `${rounds.value.toFixed(2)} for ${nameB} minus ${nameA}, interval excludes zero). The ` +
          `headline is about cost only.`,
      )
    }
  }
  const leftOut = trial.length - ruleA.length - ruleB.length
  if (leftOut > 0) {
    const noIssue = trial.filter((u) => u.issue === null).length
    doubts.push(
      `${leftOut} of ${trial.length} trial units are not in the comparison: ${noIssue} had no ` +
        `issue, so the lead chose their model, and ${leftOut - noIssue} ran on the model their ` +
        `issue did not assign. If those differ from the rest, the headline does not cover them.`,
    )
  }
  if (plan.bar) {
    doubts.push(`The plan set this bar before the data came in: ${plan.bar}`)
  }
  if (doubts.length === 0) {
    doubts.push(
      `Nothing in the data itself flags a weakness: the interval excludes zero, both arms have ` +
        `at least ${SMALL_ARM} units and they are balanced. A different task mix would still ` +
        `change it.`,
    )
  }
  for (const d of doubts) out.push(`- ${d}`)
  out.push(``)

  out.push(`## The weirdest lane`, ``)
  const odd = weirdestUnit(trial)
  if (!odd) {
    out.push(`No trial unit to pick from.`)
  } else {
    // The same population as the table and the chart: reviewed units whose issue assigned them.
    const armMedian = median(odd.model === A ? cost.A : cost.B)!
    const ratio = armMedian > 0 ? total(odd) / armMedian : NaN
    out.push(
      `Every run has one. The rule: the trial unit with the highest total cost, in either arm.`,
      ``,
      `That is ${odd.prs.join(` and `)}, built on ${modelName(odd.model)}. It cost ` +
        `${dollars(total(odd))} (${dollars(odd.cost)} to build, ${dollars(odd.reviewCost)} to ` +
        `review)${
          Number.isFinite(ratio)
            ? `, ${ratio.toFixed(1)} times the ${modelName(odd.model)} median of ${
              dollars(armMedian)
            }`
            : ``
        }. ` +
        `It changed ${odd.lines} lines over ${odd.calls} model calls, peaked at ` +
        `${odd.peakK}K tokens of context, compacted ${odd.compactions} ` +
        `${odd.compactions === 1 ? `time` : `times`}, and ${
          odd.rounds === null
            ? `never got a pass from review`
            : `passed review in round ${odd.rounds}`
        }. ${
          odd.issue === null
            ? `It had no issue, so its model was the lead's choice.`
            : followed(odd)
            ? `It is in the comparison.`
            : `Its issue assigned the other model, so it is not in the comparison.`
        }`,
    )
  }
  out.push(``)

  out.push(`## Method`, ``)
  const otherModels = units.filter((u) => u.period === `C` && u.model !== A && u.model !== B)
    .length
  const reviewedA = reviewedOf(ruleA).length
  const reviewedB = reviewedOf(ruleB).length
  out.push(
    `- Arms: ${nameA} (arm A, ${ruleA.length} units, ${reviewedA} reviewed) and ${nameB} ` +
      `(arm B, ${ruleB.length} units, ${reviewedB} reviewed). Cost figures use the reviewed units.`,
    `- A unit is the implementer lanes that share a pull request, with the reviews of that PR. ` +
      `Lanes with no PR form no unit.`,
    `- Arm assignment: ${
      plan.oddIssues === `arm_b` ? `odd` : `even`
    } issue numbers go to ${nameB}, the others to ${nameA}.`,
    `- Excluded from the comparison: ${leftOut} trial units (see above), ${otherModels} trial ` +
      `units on other models, and every unit that started before ${plan.trialStart}.`,
    `- Intervals: percentile bootstrap, 95%, seed ${seed}, ${iterations} resamples. The same ` +
      `seed and data give the same figures.`,
    `- Cost is each API response priced once, from the token counts the transcripts record.`,
  )
  return { markdown: out.join(`\n`) + `\n`, chart }
}

/** Reads `followups.jsonl`, refusing another schema version. */
export function parseFollowups(text: string): FollowupRow[] {
  const rows: FollowupRow[] = []
  for (const [i, line] of text.split(`\n`).entries()) {
    if (line.trim() === ``) continue
    let row: FollowupRow
    try {
      row = JSON.parse(line) as FollowupRow
    } catch {
      throw new PlanError(`followups.jsonl line ${i + 1} is not valid JSON`)
    }
    if (typeof row !== `object` || row === null) {
      throw new PlanError(`followups.jsonl line ${i + 1} is not a JSON object`)
    }
    if (row.schema !== FOLLOWUP_SCHEMA_VERSION) {
      throw new PlanError(
        `followups.jsonl line ${i + 1} has schema ${row.schema}; this report reads ` +
          `${FOLLOWUP_SCHEMA_VERSION}`,
      )
    }
    rows.push(row)
  }
  return rows
}

/**
 * What happened to each arm's merged PRs after the merge, per window. Counts are plain "x of n":
 * with a few dozen PRs and mostly zero events, an interval would say less than the counts do. A
 * window that has not elapsed is reported as pending, never counted as zero.
 */
export function followupSection(
  a: Unit[],
  b: Unit[],
  nameA: string,
  nameB: string,
  followups: readonly FollowupRow[] | null,
): string[] {
  const out = [`## After the merge`, ``]
  if (followups === null) {
    out.push(
      `The follow-up pass has not run for this run, so there is nothing yet on reverts, fixes ` +
        `or reopened issues. Run \`deno task experiment:followup <run folder>\` and then this ` +
        `report again.`,
    )
    return out
  }
  const byPr = new Map(followups.map((f) => [f.pr, f]))
  const arms = [a, b].map((us) => {
    const prs = us.flatMap((u) => u.prs)
    return { rows: prs.flatMap((p) => byPr.get(p) ?? []), missing: prs.filter((p) => !byPr.has(p)) }
  })
  out.push(
    `What happened to the comparison's PRs after they merged. Reverts and fix-titled PRs come ` +
      `first. Counts are plain, out of the PRs whose window has elapsed: a pending window is ` +
      `not a clean one.`,
    ``,
  )
  for (const days of WINDOW_DAYS) {
    const key = days === 14 ? `d14` : `d30`
    const cells = arms.map(({ rows }) => {
      const done = rows.flatMap((r) => r[key] === `pending` ? [] : r[key])
      return { total: rows.length, done, pending: rows.length - done.length }
    })
    const count = (c: typeof cells[number], pick: (w: typeof c.done[number]) => boolean) =>
      c.total === 0
        ? `–`
        : c.done.length === 0
        ? `window has not elapsed yet (${c.pending} pending)`
        : `${c.done.filter(pick).length} of ${c.done.length}${
          c.pending > 0 ? ` (${c.pending} more pending)` : ``
        }`
    out.push(
      `### ${days} days after the merge`,
      ``,
      `| | ${nameA} | ${nameB} |`,
      `|---|---|---|`,
      `| PRs reverted | ${cells.map((c) => count(c, (w) => w.reverts.length > 0)).join(` | `)} |`,
      `| Later PR titled as a fix on the same lines | ${
        cells.map((c) => count(c, (w) => w.fixes.some((f) => f.fixType))).join(` | `)
      } |`,
      `| Closing issue reopened | ${
        cells.map((c) => count(c, (w) => w.reopened.length > 0)).join(` | `)
      } |`,
      `| Touched by a later non-revert PR (noisy) | ${
        cells.map((c) => count(c, (w) => w.fixes.length > 0)).join(` | `)
      } |`,
      ``,
    )
  }
  out.push(
    `"Touched" is noisy: a later PR can overlap the same lines for reasons that are not ` +
      `defects, documentation above all, so read it last and do not treat it as a defect count.`,
  )
  const missing = arms.map((x) => x.missing.length)
  if (missing[0] + missing[1] > 0) {
    out.push(
      ``,
      `Not in \`followups.jsonl\` (unmerged, or the pass ran before they merged): ${nameA} ` +
        `${missing[0]}, ${nameB} ${missing[1]}.`,
    )
  }
  return out
}

function comparisonTable(
  a: Unit[],
  b: Unit[],
  nameA: string,
  nameB: string,
  options: BootstrapOptions,
): string[] {
  interface Row {
    label: string
    pick: (us: Unit[]) => number[]
    stat: (v: readonly number[]) => number | undefined
    fmt: (x: number) => string
    /** Shows the difference of two values. */
    delta: (x: number) => string
    lowerIsBetter: boolean
  }
  const sign = (s: string) => s.replace(/^\$-/, `-$`)
  const rows: Row[] = [
    {
      label: `Total cost per PR (median)`,
      pick: totalPerPr,
      stat: median,
      fmt: dollars,
      delta: (x) => sign(dollars(x)),
      lowerIsBetter: true,
    },
    {
      label: `Review cost per PR (median)`,
      pick: (us) => reviewedOf(us).map((u) => u.reviewCost),
      stat: median,
      fmt: dollars,
      delta: (x) => sign(dollars(x)),
      lowerIsBetter: true,
    },
    {
      label: `Passed first review`,
      pick: (us) => reviewedOf(us).map((u) => u.firstPass ? 1 : 0),
      stat: mean,
      fmt: pct,
      delta: (x) => `${(x * 100).toFixed(0)} points`,
      lowerIsBetter: false,
    },
    {
      label: `Review rounds to pass (mean)`,
      pick: (us) => reviewedOf(us).flatMap((u) => u.rounds === null ? [] : [u.rounds]),
      stat: mean,
      fmt: (x) => x.toFixed(2),
      delta: (x) => x.toFixed(2),
      lowerIsBetter: true,
    },
  ]
  const lines = [
    `| Measure | ${nameA} | ${nameB} | ${nameB} minus ${nameA} | Reading |`,
    `|---|---|---|---|---|`,
  ]
  for (const r of rows) {
    const ia = bootstrap(r.pick(a), r.stat, options)
    const ib = bootstrap(r.pick(b), r.stat, options)
    const d = bootstrapDifference(r.pick(a), r.pick(b), r.stat, options)
    const cell = (i: typeof ia) => i ? `${r.fmt(i.value)} (${r.fmt(i.lo)} to ${r.fmt(i.hi)})` : `–`
    const reading = !d
      ? `too few units`
      : crossesZero(d)
      ? `no difference shown`
      : (d.value < 0) === r.lowerIsBetter
      ? `${nameB} better`
      : `${nameB} worse`
    lines.push(
      `| ${r.label} | ${cell(ia)} | ${cell(ib)} | ${
        d ? `${r.delta(d.value)} (${r.delta(d.lo)} to ${r.delta(d.hi)})` : `–`
      } | ${reading} |`,
    )
  }
  return lines
}

/** Reads a run folder, then writes `report.md` and `chart.svg` into it. */
export async function writeReport(folder: string, options: BootstrapOptions = {}): Promise<Report> {
  let planText: string
  try {
    planText = await Deno.readTextFile(join(folder, `plan.md`))
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new PlanError(`${folder} has no plan.md. Write it before reporting.`)
    }
    throw error
  }
  const plan = parsePlan(planText)
  const rows = parseRows(await Deno.readTextFile(join(folder, `lanes.jsonl`)))
  let followups: FollowupRow[] | null = null
  try {
    followups = parseFollowups(await Deno.readTextFile(join(folder, `followups.jsonl`)))
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  const report = renderReport(rows, plan, options, followups)
  await Deno.writeTextFile(join(folder, `report.md`), report.markdown)
  if (report.chart) {
    await Deno.writeTextFile(join(folder, `chart.svg`), report.chart)
  } else {
    // A chart left by an earlier run would now disagree with the report.
    try {
      await Deno.remove(join(folder, `chart.svg`))
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
  }
  return report
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
    const report = await writeReport(cli.folder, cli.options)
    console.log(`wrote ${join(cli.folder, `report.md`)}${report.chart ? ` and chart.svg` : ``}`)
  } catch (error) {
    console.error(`report failed: ${error instanceof Error ? error.message : error}`)
    Deno.exit(1)
  }
}
