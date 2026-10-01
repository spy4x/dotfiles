import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.6"
import { laneRow } from "./_fixtures.ts"
import {
  analyseFolder,
  assignedArm,
  buildUnits,
  parseCli,
  parsePlan,
  parseRows,
  PlanError,
  renderReport,
  UsageError,
} from "./analyse.ts"
import type { LaneRow, PrInfo, ReviewRound } from "./schema.ts"

const t = Deno.test
const ANALYSE = join(dirname(fromFileUrl(import.meta.url)), `analyse.ts`)
const OPUS = `claude-opus-5-5`
const SONNET = `claude-sonnet-5-5`

const PLAN = `# Test run

- arm_a: ${OPUS}
- arm_b: ${SONNET}
- baseline_start: 2026-09-26T00:00:00Z
- trial_start: 2026-09-29T00:00:00Z
`

const plan = parsePlan(PLAN)

function round(verdict: ReviewRound[`verdict`], pr: string, cost = 0.5): ReviewRound {
  return { ts: `2026-09-30T05:00:00Z`, verdict, pr, reviewerModel: OPUS, cost, calls: 10 }
}

function info(lines: number, closingIssues: number[] = []): PrInfo {
  return {
    additions: lines,
    deletions: 0,
    state: `MERGED`,
    mergedAt: `2026-09-30T06:00:00Z`,
    createdAt: `2026-09-30T04:00:00Z`,
    title: `Add thing`,
    headRefName: `feat/thing`,
    closingIssues,
  }
}

/** One trial lane with one PR that closes issue `n`: `cost` for the build, then the verdicts. */
function unitRow(
  n: number,
  model: string,
  cost: number,
  lines: number,
  verdicts: ReviewRound[`verdict`][],
  overrides: Partial<LaneRow> = {},
): LaneRow {
  const pr = `spy4x/example#${n}`
  return laneRow({
    agentId: `lane-${n}`,
    model,
    start: `2026-09-30T04:00:00.000Z`,
    cost,
    calls: 10,
    prs: [pr],
    prInfo: { [pr]: info(lines, [n]) },
    reviews: { [pr]: verdicts.map((v) => round(v, pr)) },
    issue: n,
    issueSource: `closing-ref`,
    ...overrides,
  })
}

const OPUS_ROWS = [
  unitRow(2, OPUS, 5, 100, [`pass`]),
  unitRow(4, OPUS, 6, 100, [`needs-fix`, `pass`]),
  unitRow(6, OPUS, 7, 100, [`pass`]),
  unitRow(8, OPUS, 8, 100, [`needs-fix`, `pass`]),
  unitRow(10, OPUS, 9, 100, [`pass`]),
]
const SONNET_ROWS = [
  unitRow(1, SONNET, 2, 100, [`needs-fix`, `pass`]),
  unitRow(3, SONNET, 3, 100, [`needs-fix`, `pass`]),
  unitRow(5, SONNET, 4, 100, [`pass`]),
  unitRow(7, SONNET, 5, 100, [`needs-fix`, `pass`]),
  unitRow(9, SONNET, 6, 100, [`needs-fix`, `needs-fix`, `pass`]),
]

t(`refuses a run folder without plan.md, in the library and on the command line`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `experiment-kit-test-` })
  try {
    await Deno.writeTextFile(join(dir, `lanes.jsonl`), ``)
    const error = await assertRejects(() => analyseFolder(dir), PlanError)
    assertStringIncludes(error.message, `no plan.md`)
    const result = await new Deno.Command(Deno.execPath(), {
      args: [`run`, `-A`, ANALYSE, dir],
      stdout: `piped`,
      stderr: `piped`,
    }).output()
    assertEquals(result.code, 1)
    assertStringIncludes(new TextDecoder().decode(result.stderr), `no plan.md`)
    assertEquals(new TextDecoder().decode(result.stdout), ``)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`refuses a plan that leaves out an arm or a date, naming what is missing`, () => {
  try {
    parsePlan(`# Plan\n- arm_a: x\n`)
    throw new Error(`should have refused`)
  } catch (error) {
    assertEquals(error instanceof PlanError, true)
    assertStringIncludes((error as Error).message, `arm_b`)
    assertStringIncludes((error as Error).message, `trial_start`)
  }
})

t(`refuses lane rows of another schema version`, () => {
  const stale = JSON.stringify({ ...laneRow(), schema: 0 })
  try {
    parseRows(stale)
    throw new Error(`should have refused`)
  } catch (error) {
    assertEquals(error instanceof PlanError, true)
    assertStringIncludes((error as Error).message, `schema 0`)
  }
})

t(`assigns odd issues to arm B by default, and no arm to a unit without an issue`, () => {
  assertEquals(assignedArm(7, plan), SONNET)
  assertEquals(assignedArm(8, plan), OPUS)
  assertEquals(assignedArm(null, plan), null)
  assertEquals(assignedArm(7, { ...plan, oddIssues: `arm_a` }), OPUS)
})

t(`joins lanes that share a PR into one unit and sums their cost`, () => {
  const pr = `spy4x/example#1`
  const a = unitRow(1, SONNET, 2, 100, [`pass`], { agentId: `a`, calls: 10 })
  const b = unitRow(1, SONNET, 3, 100, [`pass`], {
    agentId: `b`,
    agentType: `implementer-xhigh`,
    calls: 4,
    prs: [pr],
  })
  const noPr = laneRow({ agentId: `c`, prs: [] })
  const units = buildUnits([a, b, noPr], plan)
  assertEquals(units.length, 1)
  assertEquals(units[0].cost, 5)
  assertEquals(units[0].calls, 14)
  assertEquals(units[0].agentTypes, [`implementer`, `implementer-xhigh`])
  assertEquals(units[0].lines, 100)
})

t(
  `a unit whose lanes split calls between models is mixed when the minority exceeds a fifth`,
  () => {
    const pr = `spy4x/example#1`
    const mk = (id: string, model: string, calls: number) =>
      unitRow(1, model, 1, 100, [`pass`], { agentId: id, calls, prs: [pr] })
    assertEquals(buildUnits([mk(`a`, OPUS, 7), mk(`b`, SONNET, 3)], plan)[0].model, `mixed`)
    assertEquals(buildUnits([mk(`a`, OPUS, 9), mk(`b`, SONNET, 1)], plan)[0].model, OPUS)
  },
)

t(`counts a unit as passing first review only when every PR passed round one`, () => {
  const [pass] = buildUnits([unitRow(1, OPUS, 1, 100, [`pass`])], plan)
  const [fail] = buildUnits([unitRow(1, OPUS, 1, 100, [`needs-fix`, `pass`])], plan)
  const [unreviewed] = buildUnits([unitRow(1, OPUS, 1, 100, [])], plan)
  assertEquals([pass.firstPass, pass.rounds], [true, 1])
  assertEquals([fail.firstPass, fail.rounds], [false, 2])
  assertEquals([unreviewed.reviewed, unreviewed.firstPass], [false, null])
})

t(`a unit with several PRs passes first review only when every PR did`, () => {
  const pr1 = `spy4x/example#1`
  const pr2 = `spy4x/example#2`
  const lane = unitRow(1, OPUS, 1, 100, [`pass`], {
    prs: [pr1, pr2],
    prInfo: { [pr1]: info(100), [pr2]: info(50) },
    reviews: {
      [pr1]: [round(`pass`, pr1)],
      [pr2]: [round(`needs-fix`, pr2), round(`pass`, pr2)],
    },
  })
  const [unit] = buildUnits([lane], plan)
  assertEquals([unit.firstPass, unit.rounds, unit.lines], [false, 2, 150])
})

t(
  `the seed changes the table intervals, so a rerun reproduces them only with the same seed`,
  () => {
    const rows = [...OPUS_ROWS, ...SONNET_ROWS]
    const cells = (seed: number) =>
      renderReport(rows, plan, { seed, iterations: 30 }).split(`\n`)
        .filter((l) => l.startsWith(`| `) && l.includes(`(95% `))
    assertEquals(cells(1).length > 10, true)
    assertEquals(cells(1).join(`\n`) === cells(2).join(`\n`), false)
  },
)

t(`reports each headline difference with its interval and says when it crosses zero`, () => {
  const report = renderReport([...OPUS_ROWS, ...SONNET_ROWS], plan, { seed: 1, iterations: 2000 })
  // Total cost per PR: opus 5.5..9.5 per PR (median 7.5), sonnet 2.5..6.5 (median 4.5).
  const cost = report.split(`\n`).find((l) => l.startsWith(`| Total cost per PR (median`))!
  assertStringIncludes(cost, `-$3.00 (`)
  assertStringIncludes(cost, `interval crosses zero: no difference shown`)
  const pass = report.split(`\n`).find((l) => l.startsWith(`| First review passed`))!
  assertStringIncludes(pass, `-`)
  assertStringIncludes(pass, `points (`)
})

t(`prints every median in the tables with a 95% interval and never a bare ratio`, () => {
  const report = renderReport([...OPUS_ROWS, ...SONNET_ROWS], plan, { seed: 1, iterations: 2000 })
  const row = report.split(`\n`).find((l) => l.startsWith(`| Median total cost per PR |`))!
  // Opus units cost 5.5, 6.5, 7.5, 8.5, 9.5 per PR including review: median 7.50.
  assertStringIncludes(row, `$7.50 (95% $`)
  const first = report.split(`\n`).find((l) => l.startsWith(`| Passed first review |`))!
  assertStringIncludes(first, `3 of 5 (60%, 95% `)
  assertStringIncludes(first, `1 of 5 (20%, 95% `)
})

t(`the report is identical on a rerun with the same seed`, () => {
  const rows = [...OPUS_ROWS, ...SONNET_ROWS]
  assertEquals(
    renderReport(rows, plan, { seed: 3, iterations: 500 }),
    renderReport(rows, plan, { seed: 3, iterations: 500 }),
  )
})

t(`pins the headline interval on a fixed seed`, () => {
  const report = renderReport([...OPUS_ROWS, ...SONNET_ROWS], plan, { seed: 1, iterations: 2000 })
  const cost = report.split(`\n`).find((l) => l.startsWith(`| Total cost per PR (median`))!
  assertEquals(cost, PINNED_COST_LINE)
})

const PINNED_COST_LINE =
  `| Total cost per PR (median, impl + review) | -$3.00 (-$5.50 to $0.50) | interval crosses zero: no difference shown |`

t(`says which arm is better when the interval excludes zero`, () => {
  const far = [
    ...[2, 4, 6, 8, 10].map((n, i) => unitRow(n, OPUS, 50 + i, 100, [`pass`])),
    ...[1, 3, 5, 7, 9].map((n, i) => unitRow(n, SONNET, 1 + i / 10, 100, [`pass`])),
  ]
  const report = renderReport(far, plan, { seed: 1, iterations: 2000 })
  const cost = report.split(`\n`).find((l) => l.startsWith(`| Total cost per PR (median`))!
  assertStringIncludes(cost, `sonnet-5-5 better, interval excludes zero`)
})

t(`a unit with no issue is left out of Table 2 and counted as no issue in the arm balance`, () => {
  const noIssue = unitRow(50, OPUS, 5, 100, [`pass`], {
    issue: null,
    issueSource: null,
    prInfo: { [`spy4x/example#50`]: info(100) },
  })
  const report = renderReport([...OPUS_ROWS, ...SONNET_ROWS, noIssue], plan, {
    seed: 1,
    iterations: 100,
  })
  const table1 = report.slice(report.indexOf(`## Table 1`), report.indexOf(`## Table 2`))
  const table2 = report.slice(report.indexOf(`## Table 2`), report.indexOf(`## Arm balance`))
  const units = (table: string) => table.split(`\n`).find((l) => l.startsWith(`| Units of work`))!
  // Opus trial: 5 with an issue plus the unit without one; Table 2 keeps only the 5.
  assertStringIncludes(units(table1), `| 6 | 5 |`)
  assertStringIncludes(units(table2), `| 5 | 5 |`)
  assertStringIncludes(report, `- opus-5-5, issue from none: no issue \u2014 1`)
})

/** The report's line that starts with `prefix`. */
function lineOf(report: string, prefix: string): string {
  const found = report.split(`\n`).find((l) => l.startsWith(prefix))
  if (found === undefined) throw new Error(`no line starts with ${prefix}`)
  return found
}

t(
  `the headline compares only units whose issue assigned their model and lists the rest apart`,
  () => {
    // Expensive units that would move the headline if it counted them: one with no issue (the
    // lead chose Opus) and one whose odd issue assigned Sonnet but ran on Opus.
    const noIssue = unitRow(60, OPUS, 100, 100, [`pass`], {
      issue: null,
      issueSource: null,
      prInfo: { [`spy4x/example#60`]: info(100) },
    })
    const wrong = unitRow(61, OPUS, 200, 100, [`pass`])
    // Unreviewed: counted on its line, but outside the cost median.
    const wrongUnreviewed = unitRow(63, OPUS, 300, 100, [])
    const rows = [...OPUS_ROWS, ...SONNET_ROWS, noIssue, wrong, wrongUnreviewed]
    const report = renderReport(rows, plan, {
      seed: 1,
      iterations: 2000,
    })
    assertEquals(lineOf(report, `| Total cost per PR (median`), PINNED_COST_LINE)
    assertStringIncludes(
      lineOf(report, `- No issue, model chosen by the lead:`),
      `opus-5-5 1 unit, 1 reviewed: median total cost per reviewed PR $100.50 (95% $100.50 to ` +
        `$100.50); sonnet-5-5 0 units, 0 reviewed`,
    )
    assertStringIncludes(
      lineOf(report, `- Issue assigned the other model:`),
      `opus-5-5 2 units, 1 reviewed: median total cost per reviewed PR $200.50 (95% $200.50 to ` +
        `$200.50); sonnet-5-5 0 units, 0 reviewed`,
    )
  },
)

t(`takes a unit's issue from its first PR in sorted order when no brief names one`, () => {
  // Opened in this order; only the PR that sorts first closes an issue.
  const late = `spy4x/ts-libs#283`
  const early = `spy4x/template#69`
  const lane = unitRow(1, OPUS, 1, 100, [`pass`], {
    issue: null,
    issueSource: null,
    prs: [late, early],
    prInfo: { [late]: info(50), [early]: info(50, [66]) },
    reviews: { [late]: [round(`pass`, late)], [early]: [round(`pass`, early)] },
  })
  const [unit] = buildUnits([lane], plan)
  assertEquals([unit.issue, unit.issueSource], [66, `closing ref`])
})

t(`puts a unit in the baseline or the trial by the plan's start times`, () => {
  // The fixture plan: baseline from 2026-09-26T00:00Z, trial from 2026-09-29T00:00Z.
  const at = (n: number, start: string) => unitRow(n, OPUS, 1, 100, [`pass`], { start })
  const periods = buildUnits([
    at(2, `2026-09-25T23:59:00.000Z`),
    at(4, `2026-09-26T00:00:00.000Z`),
    at(6, `2026-09-28T23:59:00.000Z`),
    at(8, `2026-09-29T00:00:00.000Z`),
  ], plan).map((u) => [u.prs[0], u.period])
  assertEquals(periods, [
    [`spy4x/example#2`, `A`],
    [`spy4x/example#4`, `B`],
    [`spy4x/example#6`, `B`],
    [`spy4x/example#8`, `C`],
  ])
})

t(`the baseline column holds only arm A's units from before the trial`, () => {
  const before = (n: number, model: string) =>
    unitRow(n, model, 1, 100, [`pass`], { start: `2026-09-27T00:00:00.000Z` })
  const report = renderReport(
    [...OPUS_ROWS, ...SONNET_ROWS, before(20, OPUS), before(21, SONNET), before(23, SONNET)],
    plan,
    { seed: 1, iterations: 100 },
  )
  const table1 = report.slice(report.indexOf(`## Table 1`), report.indexOf(`## Table 2`))
  assertEquals(lineOf(table1, `| Units of work`), `| Units of work (PRs) | 1 | 5 | 5 |`)
})

t(`reads flags before the folder, so --seed 7 <folder> takes the folder`, () => {
  assertEquals(parseCli([`--seed`, `7`, `/runs/a`]), {
    folder: `/runs/a`,
    options: { seed: 7, iterations: undefined },
  })
  assertEquals(parseCli([`/runs/a`, `--iterations=500`]).options.iterations, 500)
})

t(`rejects a seed or iteration count that is not a whole number`, () => {
  for (
    const args of [
      [`--iterations`, `abc`, `/runs/a`],
      [`--iterations`, `0`, `/runs/a`],
      [`--seed`, `1.5`, `/runs/a`],
      [`--seed`, `/runs/a`],
      [`--sed`, `7`, `/runs/a`],
    ]
  ) {
    let error: unknown
    try {
      parseCli(args)
    } catch (e) {
      error = e
    }
    assertEquals(error instanceof UsageError, true, `accepted ${args.join(` `)}`)
  }
})

t(`the command exits 2 on a bad flag and prints no report`, async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [`run`, `-A`, ANALYSE, `--iterations`, `abc`, `/nonexistent-run`],
    stdout: `piped`,
    stderr: `piped`,
  }).output()
  assertEquals(result.code, 2)
  assertStringIncludes(
    new TextDecoder().decode(result.stderr),
    `--iterations must be a whole number`,
  )
  assertEquals(new TextDecoder().decode(result.stdout), ``)
})
