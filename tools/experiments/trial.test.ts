import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19"
import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.6"
import { assistant, laneRow, writeLane } from "./_fixtures.ts"
import type { LaneRow, ReviewRound } from "./schema.ts"
import {
  armOfIssue,
  armPr,
  costAfter,
  fixLanes,
  isSecurityRed,
  type LogPair,
  parseCli,
  parseLog,
  placeOf,
  prsInCell,
  reductionInterval,
  renderTrial,
  reviewedPrs,
  trialReport,
  UsageError,
} from "./trial.ts"

const t = Deno.test
const TRIAL = join(dirname(fromFileUrl(import.meta.url)), `trial.ts`)
const SONNET = `claude-sonnet-5-5`
const OPUS = `claude-opus-5-5`
const SINCE = `2026-10-01T00:00:00Z`

function round(
  pr: string,
  model: string,
  verdict: `pass` | `needs-fix`,
  cost: number,
  ts = `2026-10-01T10:00:00.000Z`,
): ReviewRound {
  return { ts, verdict, pr, reviewerModel: model, cost, calls: 5 }
}

let seq = 0
const reviewer = (rounds: ReviewRound[]) =>
  laneRow({ role: `reviewer`, agentType: `reviewer`, agentId: `rev${++seq}`, rounds })

/** An implementer that opened `pr` and closes `issue`. */
function implementer(pr: string, issue: number | null, extra: Partial<LaneRow> = {}): LaneRow {
  return laneRow({
    agentId: `impl-${pr}`,
    prs: [pr],
    issue,
    prInfo: issue === null ? {} : {
      [pr]: {
        additions: 1,
        deletions: 1,
        state: `MERGED`,
        mergedAt: null,
        createdAt: ``,
        title: ``,
        headRefName: ``,
        closingIssues: [issue],
      },
    },
    ...extra,
  })
}

function pair(overrides: Partial<LogPair> = {}): LogPair {
  return {
    date: `2026-10-01`,
    prCell: `spy4x/x#1`,
    prs: [`spy4x/x#1`],
    issue: 3,
    sonnetVerdict: `pass`,
    opusVerdict: `pass`,
    red: 0,
    yellow: 0,
    blue: 0,
    note: ``,
    ...overrides,
  }
}

const render = (rows: LaneRow[], pairs: LogPair[] = []) =>
  renderTrial({ rows, pairs, since: SINCE, options: { iterations: 200 } })

const LOG = `# Experiment

Some text with | a pipe.

## Log of double-checked passes

| Date | PR | Issue | Sonnet verdict | Opus verdict | Opus findings (🔴 / 🟡 / 🔵) | Note |
| ---- | -- | ----- | -------------- | ------------ | ---------------------------- | ---- |
| 2026-10-01 | spy4x/a#357 | #195 | pass | needs-fix | 0 / 2 / 3 | two yellow |
| 2026-10-02 | spy4x/b#9, c#11 | other#369 | pass (after one needs-fix round) | pass | 1 / 0 / 1 | a red \\| with a pipe |
| 2026-10-02 | spy4x/d#360 → #362 | #117 (+#123) | pass | needs-fix | 0 / 1 / 0 | arrow |

Text after the table.
`

t(
  `reads each row of the double-check log: date, PRs, issue, verdicts, finding counts, note`,
  () => {
    const pairs = parseLog(LOG)
    assertEquals(pairs.length, 3)
    assertEquals(pairs[0], {
      date: `2026-10-01`,
      prCell: `spy4x/a#357`,
      prs: [`spy4x/a#357`],
      issue: 195,
      sonnetVerdict: `pass`,
      opusVerdict: `needs-fix`,
      red: 0,
      yellow: 2,
      blue: 3,
      note: `two yellow`,
    })
    assertEquals(pairs[1].prs, [`spy4x/b#9`, `spy4x/c#11`])
    assertEquals(pairs[1].issue, 369)
    assertEquals([pairs[1].red, pairs[1].yellow, pairs[1].blue], [1, 0, 1])
    assertEquals(pairs[1].note, `a red \\| with a pipe`)
    assertEquals(pairs[2].prs, [`spy4x/d#360`, `spy4x/d#362`])
    assertEquals(pairs[2].issue, 117)
  },
)

t(`reads every PR a log cell names: a list without owners, and a bare #n after an arrow`, () => {
  assertEquals(
    prsInCell(
      `spy4x/zond#9, caldav-mcp#11, rostok#330, financy#68, template#195, caldav-tasks-web#18`,
    ),
    [
      `spy4x/zond#9`,
      `spy4x/caldav-mcp#11`,
      `spy4x/rostok#330`,
      `spy4x/financy#68`,
      `spy4x/template#195`,
      `spy4x/caldav-tasks-web#18`,
    ],
  )
  assertEquals(prsInCell(`spy4x/antonshubin.com#360 → #362`), [
    `spy4x/antonshubin.com#360`,
    `spy4x/antonshubin.com#362`,
  ])
  assertEquals(prsInCell(`other/x#1, y#2`), [`other/x#1`, `other/y#2`])
  assertThrows(() => prsInCell(`#5`), Error, `names no repo`)
})

t(`stops on a log without the table or with a row it cannot read`, () => {
  assertThrows(() => parseLog(`# nothing here`), Error, `no table`)
  const bad = LOG.replace(`0 / 2 / 3`, `none`)
  assertThrows(() => parseLog(bad), Error, `cannot read log row`)
  assertThrows(() => parseLog(LOG.replace(`spy4x/a#357`, `#357`)), Error, `names no repo`)
  assertThrows(() => parseLog(LOG.replace(`spy4x/a#357`, `the first one`)), Error, `no PR`)
})

t(`assigns the Sonnet reviewer to odd issue numbers and the Opus reviewer to even ones`, () => {
  assertEquals([armOfIssue(195), armOfIssue(196)], [`sonnet`, `opus`])
})

t(
  `places a PR by its issue number, and leaves out no-issue, preact-components, auth and wrong-model PRs`,
  () => {
    const rows = [
      reviewer([
        round(`spy4x/a#1`, SONNET, `pass`, 1),
        round(`spy4x/a#2`, OPUS, `pass`, 1),
        round(`spy4x/a#3`, OPUS, `pass`, 1),
        round(`spy4x/a#4`, OPUS, `pass`, 1),
        round(`spy4x/preact-components#5`, OPUS, `pass`, 1),
        round(`spy4x/a#6`, OPUS, `pass`, 1),
        round(`spy4x/a#7`, SONNET, `pass`, 1),
      ]),
      implementer(`spy4x/a#1`, 11),
      implementer(`spy4x/a#2`, 12),
      implementer(`spy4x/a#3`, 13), // odd issue, but Opus reviewed it
      implementer(`spy4x/a#4`, null),
      implementer(`spy4x/preact-components#5`, 15),
      implementer(`spy4x/a#6`, 16, { taskClass: `auth/crypto` }),
      implementer(`spy4x/a#7`, 17),
    ]
    const places = Object.fromEntries(reviewedPrs(rows, SINCE).map((r) => [r.pr, placeOf(r)]))
    assertEquals(places, {
      "spy4x/a#1": `sonnet`,
      "spy4x/a#2": `opus`,
      "spy4x/a#3": `other model`,
      "spy4x/a#4": `no issue`,
      "spy4x/a#6": `auth/crypto`,
      "spy4x/a#7": `sonnet`,
      "spy4x/preact-components#5": `preact-components`,
    })
  },
)

t(`takes the lowest closing issue of the PR, else the implementer's issue`, () => {
  const rows = [
    reviewer([round(`spy4x/a#1`, SONNET, `pass`, 1), round(`spy4x/a#2`, SONNET, `pass`, 1)]),
    implementer(`spy4x/a#1`, 50, {
      prInfo: {
        "spy4x/a#1": {
          additions: 1,
          deletions: 1,
          state: `MERGED`,
          mergedAt: null,
          createdAt: ``,
          title: ``,
          headRefName: ``,
          closingIssues: [99, 41],
        },
      },
    }),
    implementer(`spy4x/a#2`, 63, { prInfo: {} }),
  ]
  assertEquals(reviewedPrs(rows, SINCE).map((r) => r.issue), [41, 63])
})

t(`ignores review rounds from before the trial began`, () => {
  const rows = [
    reviewer([
      round(`spy4x/a#1`, SONNET, `needs-fix`, 9, `2026-09-30T23:59:59.000Z`),
      round(`spy4x/a#1`, SONNET, `pass`, 1, `2026-10-01T00:00:00.000Z`),
    ]),
  ]
  const [review] = reviewedPrs(rows, SINCE)
  assertEquals(review.rounds.map((r) => r.cost), [1])
})

t(
  `counts the arm's own rounds up to its first pass and prices the other model's rounds apart`,
  () => {
    // Sonnet fails, passes, then Opus double-checks and fails: Opus's rounds are not Sonnet's cost.
    const rows = [
      reviewer([
        round(`spy4x/a#3`, SONNET, `needs-fix`, 0.5, `2026-10-01T10:00:00.000Z`),
        round(`spy4x/a#3`, SONNET, `pass`, 0.25, `2026-10-01T11:00:00.000Z`),
        round(`spy4x/a#3`, OPUS, `needs-fix`, 2, `2026-10-01T12:00:00.000Z`),
      ]),
      implementer(`spy4x/a#3`, 3),
    ]
    const [review] = reviewedPrs(rows, SINCE)
    const arm = armPr(review, `sonnet`)
    assertEquals(arm.armRounds.length, 2)
    assertEquals(arm.passed, true)
    assertEquals(arm.cost, 0.75)
    assertEquals(arm.otherCost, 2)
    assertEquals(arm.needsFix, 1)
  },
)

t(`prints review cost, rounds to pass and needs-fix rate for each arm`, () => {
  const rows = [
    reviewer([
      // Sonnet arm (odd issues): costs $1 / $1 / $1; rounds 1 / 1 / 2; two needs-fix in 5 rounds, one PR unfinished.
      round(`spy4x/a#1`, SONNET, `pass`, 1),
      round(`spy4x/a#3`, SONNET, `pass`, 1),
      round(`spy4x/a#5`, SONNET, `needs-fix`, 0.5, `2026-10-01T09:00:00.000Z`),
      round(`spy4x/a#5`, SONNET, `pass`, 0.5, `2026-10-01T11:00:00.000Z`),
      // Still in review: one needs-fix round, no pass yet.
      round(`spy4x/a#7`, SONNET, `needs-fix`, 9),
      // Opus arm (even issues): $4 / $4; rounds 1 / 3; two needs-fix in 4 rounds.
      round(`spy4x/a#2`, OPUS, `pass`, 4),
      round(`spy4x/a#4`, OPUS, `needs-fix`, 1, `2026-10-01T08:00:00.000Z`),
      round(`spy4x/a#4`, OPUS, `needs-fix`, 1, `2026-10-01T09:00:00.000Z`),
      round(`spy4x/a#4`, OPUS, `pass`, 2, `2026-10-01T10:00:00.000Z`),
    ]),
    ...[1, 3, 5, 7, 2, 4].map((n) => implementer(`spy4x/a#${n}`, n)),
  ]
  const text = render(rows)
  assertStringIncludes(text, `In the arms: 4 Sonnet, 2 Opus`)
  assertStringIncludes(text, `| PRs (passed) | 4 (3) | 2 (2) |`)
  assertStringIncludes(text, `| Review cost per PR, median | $1.00 ($1.00 to $1.00) | $4.00 (`)
  // Sonnet rounds to pass: (1 + 1 + 2) / 3; Opus: (1 + 3) / 2.
  assertStringIncludes(text, `| Review rounds to pass, mean | 1.33 (`)
  assertStringIncludes(text, ` | 2.00 (`)
  // Sonnet: 2 needs-fix in 5 rounds (the unfinished PR counts); Opus: 2 in 4.
  assertStringIncludes(text, `| Needs-fix rate per round | 40% (`)
  assertStringIncludes(text, ` | 50% (`)
  assertStringIncludes(text, `Review cost per PR, Sonnet against Opus: 75% lower`)
})

t(`reports how much lower one group's median is, 50% when it halves`, () => {
  const iv = reductionInterval([1, 1, 1], [2, 2, 2], { iterations: 100 })!
  assertAlmostEquals(iv.value, 0.5, 1e-12)
  assertAlmostEquals(iv.lo, 0.5, 1e-12)
  assertAlmostEquals(iv.hi, 0.5, 1e-12)
  assertEquals(reductionInterval([], [2]), undefined)
  // Medians of four values resample to 1, 5 or 9 against a flat 10: the interval has width.
  const spread = reductionInterval([1, 9, 1, 9], [10, 10, 10, 10], { iterations: 500 })!
  assertAlmostEquals(spread.value, 0.5, 1e-12)
  assertAlmostEquals(spread.lo, 0.1, 1e-12)
  assertAlmostEquals(spread.hi, 0.9, 1e-12)
})

t(`says there are not enough pairs below ten, and gives no verdict on the bar`, () => {
  const text = render([], Array.from({ length: 9 }, () => pair()))
  assertStringIncludes(text, `Pairs: 9.`)
  assertStringIncludes(text, `Not enough pairs (n<10)`)
  assertEquals(text.includes(`: met`), false)
  assertEquals(text.includes(`not met`), false)
})

t(`checks the bar at ten pairs: one 🔴 in ten passes is met, two is not`, () => {
  const ten = (reds: number) =>
    Array.from({ length: 10 }, (_, i) => pair({ red: i < reds ? 1 : 0 }))
  const met = render([], ten(1))
  assertStringIncludes(met, `🔴 in at most 1 in 10 Sonnet passes: met (1 of 10)`)
  assertStringIncludes(met, `Sonnet passes with at least one 🔴 from the Opus double-check: 1 (10%`)
  assertStringIncludes(render([], ten(2)), `not met (2 of 10)`)
})

t(`checks the 30% review-cost bar from the arms' medians`, () => {
  const rowsWith = (sonnetCost: number) => [
    reviewer([
      ...[1, 3, 5].map((n) => round(`spy4x/a#${n}`, SONNET, `pass`, sonnetCost)),
      ...[2, 4, 6].map((n) => round(`spy4x/a#${n}`, OPUS, `pass`, 10)),
    ]),
    ...[1, 2, 3, 4, 5, 6].map((n) => implementer(`spy4x/a#${n}`, n)),
  ]
  const ten = Array.from({ length: 10 }, () => pair())
  assertStringIncludes(render(rowsWith(7), ten), `at least 30% lower: met (30% lower)`)
  assertStringIncludes(render(rowsWith(7.1), ten), `at least 30% lower: not met (29% lower)`)
})

t(
  `prints a trial-stopping line for a 🔴 in a security path, by the note or by the PR's task class`,
  () => {
    const bySecurityNote = pair({ red: 1, note: `🔴 a security hole in the token check` })
    const byClass = pair({ red: 1, prs: [`spy4x/auth#7`], note: `a plain bug` })
    const plain = pair({ red: 1, prs: [`spy4x/other#8`], note: `a plain bug` })
    const noRed = pair({ red: 0, note: `security tidy-up` })
    const rows = [implementer(`spy4x/auth#7`, 7, { taskClass: `auth/crypto` })]
    assertEquals(
      [bySecurityNote, byClass, plain, noRed].map((p) => isSecurityRed(p, rows)),
      [true, true, false, false],
    )
    const text = render(rows, [bySecurityNote, plain])
    assertEquals(text.split(`\n`).filter((l) => l.includes(`TRIAL STOPPING`)).length, 1)
    assertStringIncludes(text, `TRIAL STOPPING`)
    assertEquals(render(rows, [plain]).includes(`TRIAL STOPPING`), false)
  },
)

t(`prices an implementer only for calls after the first needs-fix verdict`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `experiment-kit-test-` })
  try {
    const lane = laneRow({ agentId: `i1`, project: `proj`, session: `s1` })
    await writeLane(dir, {
      project: `proj`,
      session: `s1`,
      id: `i1`,
      meta: { agentType: `implementer` },
      lines: [
        assistant(`a`, OPUS, `2026-10-01T10:00:00.000Z`, { input_tokens: 1_000_000 }),
        assistant(`b`, OPUS, `2026-10-01T12:00:01.000Z`, { input_tokens: 1_000_000 }),
        assistant(`c`, SONNET, `2026-10-01T13:00:00.000Z`, { input_tokens: 1_000_000 }),
      ],
    })
    // Opus $4 and Sonnet $2 per million input tokens: the first call is before the verdict.
    assertEquals(await costAfter(dir, lane, `2026-10-01T12:00:00.000Z`), 6)
    await assertRejects(
      () => costAfter(dir, laneRow({ agentId: `missing`, project: `proj`, session: `s1` }), ``),
      Error,
      `cannot read the transcript of implementer missing`,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(
  `starts an implementer's fix at its earliest needs-fix and leaves out lanes with PRs in both arms`,
  () => {
    const rows = [
      reviewer([
        round(`spy4x/a#1`, SONNET, `needs-fix`, 1, `2026-10-01T12:00:00.000Z`),
        round(`spy4x/a#3`, SONNET, `needs-fix`, 1, `2026-10-01T10:00:00.000Z`),
        round(`spy4x/a#5`, SONNET, `pass`, 1),
        round(`spy4x/a#2`, OPUS, `pass`, 1),
      ]),
      implementer(`spy4x/a#1`, 1, { agentId: `two-prs`, prs: [`spy4x/a#1`, `spy4x/a#3`] }),
      implementer(`spy4x/a#3`, 3, { agentId: `dup` }),
      implementer(`spy4x/a#5`, 5, { agentId: `clean` }),
      implementer(`spy4x/a#2`, 2, { agentId: `mixed`, prs: [`spy4x/a#2`, `spy4x/a#5`] }),
    ]
    const { lanes, mixed } = fixLanes(reviewedPrs(rows, SINCE))
    assertEquals(mixed, 1)
    const byId = Object.fromEntries(lanes.map((l) => [l.lane.agentId, l.from]))
    assertEquals(byId[`two-prs`], `2026-10-01T10:00:00.000Z`)
    assertEquals(byId[`clean`], null)
  },
)

t(
  `prints the implementer fix cost per arm when it is given, and says how to get it when not`,
  () => {
    const rows = [
      reviewer([
        round(`spy4x/a#1`, SONNET, `needs-fix`, 1),
        round(`spy4x/a#1`, SONNET, `pass`, 1, `2026-10-01T11:00:00.000Z`),
        round(`spy4x/a#3`, SONNET, `pass`, 1),
      ]),
      implementer(`spy4x/a#1`, 1, { agentId: `fixed` }),
      implementer(`spy4x/a#3`, 3, { agentId: `clean` }),
    ]
    assertStringIncludes(render(rows), `give \`--projects`)
    const text = renderTrial({
      rows,
      pairs: [],
      since: SINCE,
      fixCost: new Map([[`fixed`, 3]]),
      options: { iterations: 200 },
    })
    assertStringIncludes(
      text,
      `Sonnet reviewer: 2 lanes, 1 needed a fix; mean per lane $1.50 ($0.00 to $3.00); median per lane that needed a fix $3.00 ($3.00 to $3.00)`,
    )
  },
)

t(`rejects a command line without a run folder or without --log`, () => {
  assertThrows(() => parseCli([`--log`, `x.md`]), UsageError, `exactly one run folder`)
  assertThrows(() => parseCli([`run`]), UsageError, `--log`)
  assertEquals(parseCli([`run`, `--log`, `x.md`]).since, `2026-10-01T00:00:00Z`)
})

t(`rejects a --since that is not an ISO date or a time with its zone`, () => {
  const since = (value: string) => parseCli([`run`, `--log`, `x`, `--since`, value]).since
  for (const bad of [`1`, `soon`, `2026-02-30`, `2026-10-01T00:00`, `10/01/2026`]) {
    assertThrows(() => since(bad), UsageError, `--since must be an ISO date`)
  }
  for (const good of [`2026-10-01`, `2026-10-01T14:48:42Z`, `2026-10-01T21:48:42+07:00`]) {
    assertEquals(since(good), good)
  }
})

t(`reads lanes.jsonl and the log from disk and prints the report`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `experiment-kit-test-` })
  try {
    const rows = [
      reviewer([round(`spy4x/a#1`, SONNET, `pass`, 1)]),
      implementer(`spy4x/a#1`, 1),
    ]
    await Deno.writeTextFile(
      join(dir, `lanes.jsonl`),
      rows.map((r) => JSON.stringify(r)).join(`\n`),
    )
    await Deno.writeTextFile(join(dir, `log.md`), LOG)
    const { text, stopping } = await trialReport(parseCli([dir, `--log`, join(dir, `log.md`)]))
    assertEquals(stopping, false)
    assertStringIncludes(text, `| PRs (passed) | 1 (1) | 0 (0) |`)
    assertStringIncludes(text, `Pairs: 3.`)
    const r = await new Deno.Command(Deno.execPath(), {
      args: [`run`, `-A`, TRIAL, dir],
      stdout: `piped`,
      stderr: `piped`,
    }).output()
    assertEquals(r.code, 2)
    assertStringIncludes(new TextDecoder().decode(r.stderr), `--log`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`stops instead of pricing an implementer's call on an unknown model as $0`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `experiment-kit-test-` })
  try {
    await writeLane(dir, {
      project: `proj`,
      session: `s1`,
      id: `i1`,
      meta: { agentType: `implementer` },
      lines: [assistant(`a`, `claude-future-9`, `2026-10-01T13:00:00.000Z`, { input_tokens: 1 })],
    })
    await assertRejects(
      () => costAfter(dir, laneRow({ agentId: `i1`, project: `proj`, session: `s1` }), ``),
      Error,
      `claude-future-9`,
    )
    // A call before the verdict is not priced, so its model does not matter.
    assertEquals(
      await costAfter(
        dir,
        laneRow({ agentId: `i1`, project: `proj`, session: `s1` }),
        `2026-10-02T00:00:00.000Z`,
      ),
      0,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(
  `exits 3 after printing the report when a 🔴 sits in a security path, and 0 otherwise`,
  async () => {
    const dir = await Deno.makeTempDir({ prefix: `experiment-kit-test-` })
    try {
      await Deno.writeTextFile(
        join(dir, `lanes.jsonl`),
        JSON.stringify(implementer(`spy4x/a#1`, 1)),
      )
      const run = async (log: string) => {
        await Deno.writeTextFile(join(dir, `log.md`), log)
        const r = await new Deno.Command(Deno.execPath(), {
          args: [`run`, `-A`, TRIAL, dir, `--log`, join(dir, `log.md`)],
          stdout: `piped`,
          stderr: `piped`,
        }).output()
        return { code: r.code, out: new TextDecoder().decode(r.stdout) }
      }
      const stopping = await run(LOG.replace(`a red \\| with a pipe`, `a security hole`))
      assertEquals(stopping.code, 3)
      assertStringIncludes(stopping.out, `TRIAL STOPPING`)
      assertEquals((await run(LOG)).code, 0)
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
)
