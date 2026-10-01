import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { join } from "jsr:@std/path@1.1.6"
import { laneRow } from "./_fixtures.ts"
import { parsePlan } from "./analyse.ts"
import { niceStep, placeArms, PLOT, renderChart } from "./chart.ts"
import {
  headline,
  modelName,
  parseFollowups,
  renderReport,
  weirdestUnit,
  writeReport,
} from "./report.ts"
import type { LaneRow, PrInfo } from "./schema.ts"
import type { FollowupRow, WindowResult } from "./followup.ts"
import { buildUnits } from "./analyse.ts"

const t = Deno.test
const OPUS = `claude-opus-5-5`
const SONNET = `claude-sonnet-5-5`

const PLAN = `# Fixture run

- arm_a: ${OPUS}
- arm_b: ${SONNET}
- baseline_start: 2026-09-26T00:00:00Z
- trial_start: 2026-09-29T00:00:00Z
- bar: Sonnet must cost 30% less per PR.
`
const plan = parsePlan(PLAN)

/** A trial lane with one merged PR closing issue `n`, costing `build` to build and `review` to review (one passing round). */
function unit(
  n: number,
  model: string,
  build: number,
  review: number,
  overrides: Partial<LaneRow> = {},
): LaneRow {
  const pr = `spy4x/example#${n}`
  const info: PrInfo = {
    additions: 100,
    deletions: 0,
    state: `MERGED`,
    mergedAt: `2026-09-30T06:00:00Z`,
    createdAt: `2026-09-30T04:00:00Z`,
    title: `t`,
    headRefName: `feat/x`,
    closingIssues: [n],
  }
  return laneRow({
    agentId: `lane-${n}`,
    model,
    start: `2026-09-30T04:00:00.000Z`,
    cost: build,
    prs: [pr],
    prInfo: { [pr]: info },
    reviews: {
      [pr]: [{
        ts: `2026-09-30T05:00:00Z`,
        verdict: `pass`,
        pr,
        reviewerModel: OPUS,
        cost: review,
        calls: 10,
      }],
    },
    issue: n,
    issueSource: `closing-ref`,
    ...overrides,
  })
}

// Every unit of an arm costs the same, so each median and interval end is that number exactly:
// Opus 6.00 + 0.50 = 6.50 per PR, Sonnet 4.50 + 0.50 = 5.00, difference -1.50. Even issues are
// Opus, odd are Sonnet.
const FLAT = [
  unit(2, OPUS, 6, 0.5),
  unit(4, OPUS, 6, 0.5),
  unit(6, OPUS, 6, 0.5),
  unit(1, SONNET, 4.5, 0.5),
  unit(3, SONNET, 4.5, 0.5),
  unit(5, SONNET, 4.5, 0.5),
]

// Totals Opus 5.5, 6.5, 7.5, 8.5, 9.5 (median 7.5) and Sonnet 3, 4, 5, 6, 20 (median 5): the
// medians differ by -2.5, and issue 9 is a $20 outlier.
const SPREAD = [
  ...[5.5, 6.5, 7.5, 8.5, 9.5].map((c, i) => unit(2 * (i + 1), OPUS, c - 0.5, 0.5)),
  ...[3, 4, 5, 6, 20].map((c, i) => unit(2 * i + 1, SONNET, c - 0.5, 0.5)),
]

t(`names the model, the difference and the 95% interval in the headline on a flat fixture`, () => {
  const { markdown } = renderReport(FLAT, plan)
  assertStringIncludes(
    markdown,
    `**Sonnet 5.5 units cost $1.50 less per PR than Opus 5.5 units, somewhere between $1.50 and ` +
      `$1.50 (95% interval).**`,
  )
})

t(`headline gives the smaller amount first and says more when the difference is positive`, () => {
  assertEquals(
    headline(`Opus 5.5`, `Sonnet 5.5`, { value: -1.57, lo: -5.71, hi: -0.36 }),
    `Sonnet 5.5 units cost $1.57 less per PR than Opus 5.5 units, somewhere between $0.36 and ` +
      `$5.71 (95% interval).`,
  )
  assertEquals(
    headline(`Opus 5.5`, `Sonnet 5.5`, { value: 2, lo: 1, hi: 3 }),
    `Sonnet 5.5 units cost $2.00 more per PR than Opus 5.5 units, somewhere between $1.00 and ` +
      `$3.00 (95% interval).`,
  )
})

t(`headline refuses to name a winner when the interval crosses zero`, () => {
  assertEquals(
    headline(`Opus 5.5`, `Sonnet 5.5`, { value: -0.5, lo: -2, hi: 1 }),
    `Sonnet 5.5 units cost $0.50 less per PR than Opus 5.5 units, but the data cannot tell it ` +
      `from no difference: somewhere between $2.00 less and $1.00 more (95% interval).`,
  )
})

t(`headline admits it has no figure when an arm has no reviewed PRs`, () => {
  assertStringIncludes(headline(`A`, `B`, undefined), `not yet a figure`)
})

t(`pins the spread fixture's medians, difference and interval on seed 1`, () => {
  const { markdown } = renderReport(SPREAD, plan, { seed: 1, iterations: 1000 })
  // Hand-checked: medians 7.50 and 5.00. The interval ends are the seed-1 bootstrap result.
  assertStringIncludes(markdown, `| Total cost per PR (median) | $7.50 (`)
  assertStringIncludes(markdown, `| $5.00 (`)
  assertStringIncludes(markdown, `| -$2.50 (`)
  assertStringIncludes(
    markdown,
    `**Sonnet 5.5 units cost $2.50 less per PR than Opus 5.5 units, but the data cannot tell it ` +
      `from no difference: somewhere between $5.50 less and $12.50 more (95% interval).**`,
  )
})

t(`names the highest-cost trial unit as the weirdest lane, from row fields only`, () => {
  const units = buildUnits(SPREAD, plan)
  assertEquals(weirdestUnit(units)?.prs, [`spy4x/example#9`])
  const { markdown } = renderReport(SPREAD, plan)
  assertStringIncludes(markdown, `That is spy4x/example#9, built on Sonnet 5.5. It cost $20.00`)
  assertStringIncludes(markdown, `4.0 times the Sonnet 5.5 median of $5.00`)
})

t(`lists what would change my mind: small arms, crossing zero, the plan's bar`, () => {
  const { markdown } = renderReport(SPREAD, plan, { seed: 1, iterations: 1000 })
  const section = markdown.split(`## What would change my mind`)[1].split(`## The weirdest`)[0]
  assertStringIncludes(section, `The headline interval crosses zero`)
  assertStringIncludes(section, `Opus 5.5 has 5 reviewed units`)
  assertStringIncludes(section, `Sonnet 5.5 has 5 reviewed units`)
  assertStringIncludes(section, `The plan set this bar before the data came in: Sonnet must`)
})

t(`counts units outside the comparison and says why`, () => {
  const rows = [
    ...FLAT,
    // A real unit (it has a PR) whose PR closes no issue, so the lead chose its model.
    unit(8, SONNET, 4, 0.5, {
      issue: null,
      issueSource: null,
      prInfo: { "spy4x/example#8": { ...FLAT[0].prInfo[`spy4x/example#2`], closingIssues: [] } },
    }),
    unit(10, SONNET, 4, 0.5), // even issue assigns Opus, ran on Sonnet
  ]
  const { markdown } = renderReport(rows, plan)
  assertStringIncludes(markdown, `2 of 8 trial units are not in the comparison`)
  assertStringIncludes(markdown, `1 had no issue, so the lead chose their model, and 1 ran on`)
})

t(`places each arm at its slot centre with y scaled from dollars`, () => {
  const placed = placeArms([
    { label: `A`, n: 3, value: 6.5, lo: 6.5, hi: 6.5 },
    { label: `B`, n: 3, value: 5, lo: 5, hi: 5 },
  ])
  // Top is 6.5, step 2, axis max 8. Plot is x 72..456 (slots of 192), y 28..260 (232 high).
  assertEquals(PLOT, { left: 72, right: 456, top: 28, bottom: 260 })
  assertEquals(placed.map((p) => p.x), [168, 360])
  assertEquals(placed.map((p) => p.y), [71.5, 115])
  assertEquals(placed[0].yLo, placed[0].yHi)
})

t(`picks one, two or five times a power of ten as the gridline step`, () => {
  assertEquals(niceStep(6.5), 2)
  assertEquals(niceStep(0.9), 0.5)
  assertEquals(niceStep(20), 5)
  assertEquals(niceStep(100), 50)
})

t(`the chart has a title, a description, labelled axes and the arms' coordinates`, () => {
  const { chart } = renderReport(FLAT, plan)
  assertStringIncludes(chart, `<title id="t">Median total cost per PR, Opus 5.5 against Sonnet 5.5`)
  assertStringIncludes(chart, `<desc id="d">`)
  assertStringIncludes(chart, `Opus 5.5 $6.50 ($6.50 to $6.50) over 3 PRs`)
  assertStringIncludes(chart, `Median total cost per PR (USD)`)
  assertStringIncludes(chart, `n = 3 PRs`)
  assertStringIncludes(chart, `<circle cx="168" cy="71.5" r="6"`)
  assertStringIncludes(chart, `<circle cx="360" cy="115" r="6"`)
  assertStringIncludes(chart, `fill="currentColor"`)
  assertStringIncludes(chart, `prefers-color-scheme:dark`)
})

t(`escapes markup in chart labels`, () => {
  const svg = renderChart([{ label: `<b>&`, n: 1, value: 1, lo: 1, hi: 1 }], {
    title: `t`,
    desc: `d`,
    yLabel: `y`,
  })
  assertStringIncludes(svg, `&lt;b&gt;&amp;`)
})

t(
  `writes report.md and chart.svg next to lanes.jsonl, and the report links the chart`,
  async () => {
    const dir = await Deno.makeTempDir({ prefix: `experiment-report-test-` })
    try {
      await Deno.writeTextFile(join(dir, `plan.md`), PLAN)
      await Deno.writeTextFile(
        join(dir, `lanes.jsonl`),
        FLAT.map((r) => JSON.stringify(r)).join(`\n`),
      )
      await writeReport(dir)
      const md = await Deno.readTextFile(join(dir, `report.md`))
      assertStringIncludes(md, `](chart.svg)`)
      assertStringIncludes(await Deno.readTextFile(join(dir, `chart.svg`)), `<svg`)
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
)

t(`the report is identical on a rerun with the same seed`, () => {
  assertEquals(renderReport(SPREAD, plan, { seed: 5 }), renderReport(SPREAD, plan, { seed: 5 }))
})

t(`formats model ids for people`, () => {
  assertEquals(modelName(`claude-sonnet-5-5`), `Sonnet 5.5`)
  assertEquals(modelName(`claude-opus-5`), `Opus 5`)
  assertEquals(modelName(`claude-weird`), `weird`)
})

/** An Opus or Sonnet unit that no review looked at, so no cost figure counts it. */
const unreviewed = (n: number, model: string) => unit(n, model, 4, 0.5, { reviews: {} })

t(`the weirdest lane's arm median is the table's, not every unit of that model`, () => {
  // A cheap Sonnet unit with no issue: it joins "all Sonnet trial units" (median 4.50) but not
  // the comparison, whose Sonnet median stays $5.00.
  const noIssue = unit(11, SONNET, 0.5, 0.5, {
    issue: null,
    issueSource: null,
    prInfo: {
      "spy4x/example#11": { ...SPREAD[5].prInfo[`spy4x/example#1`], closingIssues: [] },
    },
  })
  const { markdown } = renderReport([...SPREAD, noIssue], plan)
  assertStringIncludes(markdown, `4.0 times the Sonnet 5.5 median of $5.00`)
})

t(`warns about unbalanced arms by reviewed units, the count behind the cost figures`, () => {
  const note = `The arms are unbalanced`
  const flat = (rows: LaneRow[]) => renderReport(rows, plan).markdown
  // 3 against 4 reviewed: ratio 1.33, no warning.
  assertEquals(flat([...FLAT, unit(7, SONNET, 4.5, 0.5)]).includes(note), false)
  // 3 against 5: ratio 1.67.
  assertStringIncludes(
    flat([...FLAT, unit(7, SONNET, 4.5, 0.5), unit(9, SONNET, 4.5, 0.5)]),
    `${note} (3 against 5 reviewed units)`,
  )
  // 4 units each, but Opus has only 2 reviewed against 4: balanced by units, not by reviews.
  const rows = [
    unit(2, OPUS, 6, 0.5),
    unit(4, OPUS, 6, 0.5),
    unreviewed(6, OPUS),
    unreviewed(8, OPUS),
    ...[1, 3, 5, 7].map((n) => unit(n, SONNET, 4.5, 0.5)),
  ]
  assertStringIncludes(flat(rows), `${note} (2 against 4 reviewed units)`)
})

/** Flat fixture where Sonnet is cheaper but needs two review rounds to Opus's one. */
const ROUNDS = [
  ...[2, 4, 6].map((n) => unit(n, OPUS, 6, 0.5)),
  ...[1, 3, 5].map((n) => {
    const pr = `spy4x/example#${n}`
    const base = unit(n, SONNET, 4.5, 0.25)
    const pass = base.reviews[pr][0]
    return {
      ...base,
      reviews: { [pr]: [{ ...pass, verdict: `needs-fix` as const }, pass] },
    }
  }),
]

t(`the table says better, worse or no difference shown from each interval`, () => {
  const { markdown } = renderReport(ROUNDS, plan)
  assertStringIncludes(
    markdown,
    `| Total cost per PR (median) | $6.50 ($6.50 to $6.50) | $5.00 ($5.00 to $5.00) | ` +
      `-$1.50 (-$1.50 to -$1.50) | Sonnet 5.5 better |`,
  )
  assertStringIncludes(
    markdown,
    `| Review rounds to pass (mean) | 1.00 (1.00 to 1.00) | 2.00 (2.00 to 2.00) | ` +
      `1.00 (1.00 to 1.00) | Sonnet 5.5 worse |`,
  )
  assertStringIncludes(
    markdown,
    `| Review cost per PR (median) | $0.50 ($0.50 to $0.50) | $0.50 ($0.50 to $0.50) | ` +
      `$0.00 ($0.00 to $0.00) | no difference shown |`,
  )
})

t(`says the cost winner needs more review rounds when that interval excludes zero`, () => {
  const bullet = `is cheaper per PR but needs more review rounds to pass`
  assertStringIncludes(renderReport(ROUNDS, plan).markdown, `Sonnet 5.5 ${bullet}`)
  assertEquals(renderReport(FLAT, plan).markdown.includes(bullet), false)
})

t(`draws each whisker from the interval's low end to its high end, with caps`, () => {
  const arms = [
    { label: `A`, n: 5, value: 7.5, lo: 6, hi: 9 },
    { label: `B`, n: 5, value: 5, lo: 3, hi: 8 },
  ]
  // Top 9, step 5, axis max 10; y = 260 - v / 10 * 232.
  const [a, b] = placeArms(arms)
  assertEquals([a.yHi, a.y, a.yLo], [51.2, 86, 120.8])
  assertEquals([b.yHi, b.y, b.yLo], [74.4, 144, 190.4])
  const svg = renderChart(arms, { title: `t`, desc: `d`, yLabel: `y` })
  assertStringIncludes(svg, `<line x1="168" y1="51.2" x2="168" y2="120.8"`)
  assertStringIncludes(svg, `<line x1="158" y1="51.2" x2="178" y2="51.2"`)
  assertStringIncludes(svg, `<line x1="158" y1="120.8" x2="178" y2="120.8"`)
  assertStringIncludes(svg, `<line x1="360" y1="74.4" x2="360" y2="190.4"`)
})

t(`the method note labels the arms, names the odd rule and counts other-model units`, () => {
  const other = unit(12, `claude-haiku-5`, 1, 0.5)
  const md = renderReport([...FLAT, other], plan).markdown
  assertStringIncludes(md, `Opus 5.5 (arm A, 3 units, 3 reviewed) and Sonnet 5.5 (arm B, 3 units`)
  assertStringIncludes(md, `odd issue numbers go to Sonnet 5.5, the others to Opus 5.5`)
  assertStringIncludes(md, `1 trial units on other models`)
  const even = renderReport(FLAT, { ...plan, oddIssues: `arm_a` }).markdown
  assertStringIncludes(even, `even issue numbers go to Sonnet 5.5`)
})

t(`removes a stale chart.svg when the report has no chart`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `experiment-report-test-` })
  try {
    await Deno.writeTextFile(join(dir, `plan.md`), PLAN)
    await Deno.writeTextFile(join(dir, `lanes.jsonl`), ``)
    await Deno.writeTextFile(join(dir, `chart.svg`), `<svg/>`)
    await writeReport(dir)
    const names = [...Deno.readDirSync(dir)].map((e) => e.name).sort()
    assertEquals(names, [`lanes.jsonl`, `plan.md`, `report.md`])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

const NONE: WindowResult = { reverts: [], fixes: [], reopened: [] }
const fix = (fixType: boolean) => ({
  pr: 99,
  title: `x`,
  at: `2026-10-01T00:00:00Z`,
  fixType,
  files: [`a.ts`],
  exact: true,
})
const revert = { pr: 98, sha: null, title: `Revert "x"`, at: `2026-10-01T00:00:00Z` }

function followup(
  n: number,
  d14: WindowResult | `pending`,
  d30: WindowResult | `pending`,
): FollowupRow {
  return {
    schema: 1,
    pr: `spy4x/example#${n}`,
    title: `t`,
    mergedAt: `2026-09-30T06:00:00Z`,
    mergeCommit: null,
    d14,
    d30,
  }
}

/** Opus (2, 4, 6) and Sonnet (1, 3, 5) from FLAT. */
function follow(rows: FollowupRow[] | null) {
  return renderReport(FLAT, plan, {}, rows).markdown.split(`## After the merge`)[1]
    .split(`## What would change`)[0]
}

t(`tells the reader the follow-up pass has not run and names the command`, () => {
  const section = follow(null)
  assertStringIncludes(section, `The follow-up pass has not run for this run`)
  assertStringIncludes(section, `deno task experiment:followup <run folder>`)
  assertEquals(section.includes(`days after the merge`), false)
})

t(`counts reverts, fix-titled PRs, reopened issues and touched PRs per arm and window`, () => {
  const section = follow([
    // Opus: #2 reverted, #4 fix-titled, #6 only touched by a non-fix PR.
    followup(2, { ...NONE, reverts: [revert] }, { ...NONE, reverts: [revert] }),
    followup(4, { ...NONE, fixes: [fix(true)] }, { ...NONE, fixes: [fix(true)] }),
    followup(6, { ...NONE, fixes: [fix(false)] }, NONE),
    // Sonnet: #1 reopened, #3 and #5 clean.
    followup(
      1,
      { ...NONE, reopened: [{ issue: `spy4x/example#1`, at: `2026-10-01T00:00:00Z` }] },
      NONE,
    ),
    followup(3, NONE, NONE),
    followup(5, NONE, NONE),
  ])
  const [d14, d30] = section.split(`### 30 days after the merge`)
  assertStringIncludes(d14, `| PRs reverted | 1 of 3 | 0 of 3 |`)
  assertStringIncludes(d14, `| Later PR titled as a fix on the same lines | 1 of 3 | 0 of 3 |`)
  assertStringIncludes(d14, `| Closing issue reopened | 0 of 3 | 1 of 3 |`)
  assertStringIncludes(d14, `| Touched by any later PR (noisy) | 2 of 3 | 0 of 3 |`)
  assertStringIncludes(d30, `| Touched by any later PR (noisy) | 1 of 3 | 0 of 3 |`)
  assertStringIncludes(section, `"Touched" is noisy`)
})

t(`lists reverts and fixes before the noisy touched row`, () => {
  const section = follow([1, 2, 3, 4, 5, 6].map((n) => followup(n, NONE, NONE)))
  const at = (label: string) => section.indexOf(label)
  assertEquals(at(`PRs reverted`) < at(`titled as a fix`), true)
  assertEquals(at(`titled as a fix`) < at(`reopened`), true)
  assertEquals(at(`reopened`) < at(`Touched by any`), true)
})

t(`prints a pending window as pending, never as zero`, () => {
  const section = follow([
    followup(2, NONE, `pending`),
    followup(4, NONE, `pending`),
    followup(6, `pending`, `pending`),
    followup(1, NONE, `pending`),
    followup(3, NONE, `pending`),
    followup(5, NONE, `pending`),
  ])
  const [d14, d30] = section.split(`### 30 days after the merge`)
  // 14 days: Opus has one pending PR among three, counted apart.
  assertStringIncludes(d14, `| PRs reverted | 0 of 2 (1 more pending) | 0 of 3 |`)
  // 30 days: every PR of both arms is pending.
  assertStringIncludes(
    d30,
    `| PRs reverted | window has not elapsed yet (3 pending) | window has not elapsed yet (3 pending) |`,
  )
})

t(`shows an arm with no events as 0 of n, and an arm with no PRs in the file as a dash`, () => {
  const section = follow([2, 4, 6].map((n) => followup(n, NONE, NONE)))
  assertStringIncludes(section, `| PRs reverted | 0 of 3 | – |`)
  assertStringIncludes(section, `Not in \`followups.jsonl\``)
  assertStringIncludes(section, `Sonnet 5.5 3.`)
})

t(`reads followups.jsonl from the run folder and refuses another schema version`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `experiment-report-test-` })
  try {
    await Deno.writeTextFile(join(dir, `plan.md`), PLAN)
    await Deno.writeTextFile(
      join(dir, `lanes.jsonl`),
      FLAT.map((r) => JSON.stringify(r)).join(`\n`),
    )
    assertStringIncludes((await writeReport(dir)).markdown, `follow-up pass has not run`)
    const rows = [2, 4, 6, 1, 3, 5].map((n) => followup(n, NONE, NONE))
    await Deno.writeTextFile(
      join(dir, `followups.jsonl`),
      rows.map((r) => JSON.stringify(r)).join(`\n`),
    )
    assertStringIncludes((await writeReport(dir)).markdown, `| PRs reverted | 0 of 3 | 0 of 3 |`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
  try {
    parseFollowups(JSON.stringify({ ...followup(1, NONE, NONE), schema: 0 }))
    throw new Error(`should have refused`)
  } catch (error) {
    assertStringIncludes((error as Error).message, `schema 0`)
  }
})
