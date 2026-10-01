import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19"
import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.6"
import { assistant, line, writeLane } from "./_fixtures.ts"
import {
  daysBetween,
  mergedPrs,
  parseCli,
  readTranscripts,
  renderDaily,
  renderRow,
  roleOf,
  scanDays,
  type TranscriptInput,
  UsageError,
} from "./daily.ts"
import { CommandError, type Exec } from "./exec.ts"

const t = Deno.test
const DAILY = join(dirname(fromFileUrl(import.meta.url)), `daily.ts`)
const SONNET = `claude-sonnet-5-5`
const OPUS = `claude-opus-5-5`

// Opus 5.5 is $4 per million input tokens, Sonnet 5.5 is $2: a call with one million input
// tokens costs $4 on Opus and $2 on Sonnet.
const MILLION = { input_tokens: 1_000_000 }

const compact = (ts: string) => line({ type: `system`, subtype: `compact_boundary`, timestamp: ts })

t(`dates each call by its own timestamp, not by the file's last write`, () => {
  const lines = [
    assistant(`m1`, OPUS, `2026-10-01T23:59:59.000Z`, MILLION),
    assistant(`m2`, OPUS, `2026-10-02T00:00:01.000Z`, MILLION),
    assistant(`m3`, OPUS, `2026-10-02T00:00:02.000Z`, MILLION),
  ]
  const { days } = scanDays([{ role: `lead`, lines }])
  assertEquals(days.get(`2026-10-01`)!.cost.lead, 4)
  assertEquals(days.get(`2026-10-02`)!.cost.lead, 8)
})

t(`prices each message id once, from its last usage line`, () => {
  const lines = [
    assistant(`m1`, OPUS, `2026-10-01T01:00:00.000Z`, { output_tokens: 10 }),
    assistant(`m1`, OPUS, `2026-10-01T01:00:01.000Z`, { output_tokens: 1_000_000 }),
  ]
  const { days } = scanDays([{ role: `lead`, lines }])
  // $20 per million output tokens, once.
  assertEquals(days.get(`2026-10-01`)!.cost.lead, 20)
})

t(`prices the model that answered: Sonnet at $2 and Opus at $4 per million input tokens`, () => {
  const inputs: TranscriptInput[] = [
    { role: `lead`, lines: [assistant(`a`, SONNET, `2026-10-01T01:00:00.000Z`, MILLION)] },
    { role: `lead`, lines: [assistant(`b`, OPUS, `2026-10-01T01:00:00.000Z`, MILLION)] },
  ]
  assertEquals(scanDays(inputs).days.get(`2026-10-01`)!.cost.lead, 6)
})

t(`counts both implementer types as implementers and splits spend by role`, () => {
  const at = `2026-10-01T01:00:00.000Z`
  const inputs: TranscriptInput[] = [
    { role: roleOf(undefined), lines: [assistant(`a`, OPUS, at, MILLION)] },
    { role: roleOf(`implementer`), lines: [assistant(`b`, OPUS, at, MILLION)] },
    { role: roleOf(`implementer-xhigh`), lines: [assistant(`c`, OPUS, at, MILLION)] },
    { role: roleOf(`reviewer`), lines: [assistant(`d`, OPUS, at, MILLION)] },
    { role: roleOf(`Explore`), lines: [assistant(`e`, OPUS, at, MILLION)] },
  ]
  const day = scanDays(inputs).days.get(`2026-10-01`)!
  assertEquals(day.cost, { lead: 4, implementer: 8, reviewer: 4, other: 4 })
  assertEquals(renderRow(day, 0).split(` | `)[2], `20% / 40% / 20% / 20%`)
})

t(`shows Sonnet's share of implementer and reviewer calls apart`, () => {
  const at = `2026-10-01T01:00:00.000Z`
  const inputs: TranscriptInput[] = [
    {
      role: `implementer`,
      lines: [
        assistant(`a`, SONNET, at, {}),
        assistant(`b`, SONNET, at, {}),
        assistant(`c`, SONNET, at, {}),
        assistant(`d`, OPUS, at, {}),
      ],
    },
    { role: `reviewer`, lines: [assistant(`e`, SONNET, at, {}), assistant(`f`, OPUS, at, {})] },
  ]
  const cells = renderRow(scanDays(inputs).days.get(`2026-10-01`)!, 0).split(` | `)
  assertEquals(cells[3], `75%`)
  assertEquals(cells[4], `50%`)
})

t(`counts compactions per role on the day of the compact_boundary event`, () => {
  const inputs: TranscriptInput[] = [
    { role: `lead`, lines: [compact(`2026-10-01T05:00:00.000Z`)] },
    {
      role: `implementer`,
      lines: [
        compact(`2026-10-01T05:00:00.000Z`),
        compact(`2026-10-01T06:00:00.000Z`),
        compact(`2026-10-02T00:00:01.000Z`),
      ],
    },
    { role: `reviewer`, lines: [compact(`2026-10-01T07:00:00.000Z`)] },
  ]
  const { days } = scanDays(inputs)
  assertEquals(days.get(`2026-10-01`)!.compactions, {
    lead: 1,
    implementer: 2,
    reviewer: 1,
    other: 0,
  })
  assertEquals(days.get(`2026-10-02`)!.compactions.implementer, 1)
})

t(`takes the median of the implementers' peak contexts, one peak per transcript`, () => {
  const at = `2026-10-01T01:00:00.000Z`
  const peakOf = (tokens: number, tokensLater: number): TranscriptInput => ({
    role: `implementer`,
    lines: [
      assistant(`x${tokens}`, OPUS, at, { input_tokens: tokens }),
      assistant(`y${tokens}`, OPUS, at, { input_tokens: tokensLater }),
    ],
  })
  const inputs = [
    peakOf(100_000, 200_000),
    peakOf(50_000, 300_000),
    peakOf(10_000, 400_000),
    // A reviewer's larger context is not an implementer peak.
    { role: `reviewer` as const, lines: [assistant(`r`, OPUS, at, { input_tokens: 900_000 })] },
  ]
  const day = scanDays(inputs).days.get(`2026-10-01`)!
  assertEquals(day.implementerPeaks.toSorted((a, b) => a - b), [200_000, 300_000, 400_000])
  assertEquals(renderRow(day, 0).split(` | `)[6], `300K`)
})

t(`skips a call on a model with no price and reports it`, () => {
  const lines = [
    assistant(`a`, `claude-future-9`, `2026-10-01T01:00:00.000Z`, MILLION),
    assistant(`b`, OPUS, `2026-10-01T01:00:00.000Z`, MILLION),
  ]
  const { days, unpriced } = scanDays([{ role: `lead`, lines }])
  assertEquals(unpriced, { "claude-future-9": 1 })
  assertEquals(days.get(`2026-10-01`)!.cost.lead, 4)
})

t(
  `prints a row for a day with no transcripts and spend per merged PR for a day with some`,
  async () => {
    const inputs: TranscriptInput[] = [
      { role: `lead`, lines: [assistant(`a`, OPUS, `2026-10-02T01:00:00.000Z`, MILLION)] },
    ]
    const exec: Exec = (_cmd, args) => {
      const q = args.find((a) => a.startsWith(`q=`))!
      return Promise.resolve(q.endsWith(`merged:2026-10-02`) ? `2` : `0`)
    }
    const { table } = await renderDaily(inputs, `2026-10-01`, `2026-10-02`, exec)
    const rows = table.split(`\n`).slice(2)
    assertEquals(rows.length, 2)
    assertEquals(rows[0], `| 2026-10-01 | $0 | – / – / – / – | – | – | 0 / 0 / 0 | 0K | 0 | – |`)
    assertEquals(
      rows[1],
      `| 2026-10-02 | $4 | 100% / 0% / 0% / 0% | – | – | 0 / 0 / 0 | 0K | 2 | $2.00 |`,
    )
  },
)

t(`stops when the gh search fails or answers with something other than a number`, async () => {
  const failing: Exec = (c, a) => Promise.reject(new CommandError(c, a, `exit 1: rate limit`))
  await assertRejects(() => mergedPrs(`2026-10-01`, failing), CommandError)
  await assertRejects(
    () => mergedPrs(`2026-10-01`, () => Promise.resolve(``)),
    Error,
    `gh search failed for 2026-10-01`,
  )
})

t(`lists every day of the range, both ends included`, () => {
  assertEquals(daysBetween(`2026-09-29`, `2026-10-02`), [
    `2026-09-29`,
    `2026-09-30`,
    `2026-10-01`,
    `2026-10-02`,
  ])
})

t(`rejects a date that is not ISO or not a real day`, () => {
  for (const bad of [`10/01/2026`, `2026-1-1`, `2026-02-30`, `yesterday`]) {
    assertThrows(() => parseCli([`--since`, bad]), UsageError, `--since must be a date`)
    assertThrows(() => parseCli([`--until`, bad]), UsageError, `--until must be a date`)
  }
  assertThrows(
    () => parseCli([`--since`, `2026-10-02`, `--until`, `2026-10-01`]),
    UsageError,
    `is after`,
  )
})

t(`defaults to the last seven days up to today`, () => {
  assertEquals(parseCli([], new Date(`2026-10-07T12:00:00Z`)), {
    since: `2026-10-01`,
    until: `2026-10-07`,
    projects: undefined,
  })
})

t(
  `reads lead sessions and subagents with their roles, and skips files last written before --since`,
  async () => {
    const dir = await Deno.makeTempDir({ prefix: `experiment-kit-test-` })
    try {
      const at = `2026-10-01T01:00:00.000Z`
      await Deno.mkdir(join(dir, `proj`, `s1`), { recursive: true })
      await Deno.writeTextFile(
        join(dir, `proj`, `s1.jsonl`),
        assistant(`lead1`, OPUS, at, MILLION) + `\n`,
      )
      await writeLane(dir, {
        project: `proj`,
        session: `s1`,
        id: `i1`,
        meta: { agentType: `implementer-xhigh` },
        lines: [assistant(`impl1`, OPUS, at, MILLION)],
      })
      const old = await writeLane(dir, {
        project: `proj`,
        session: `s1`,
        id: `old`,
        meta: { agentType: `reviewer` },
        lines: [assistant(`old1`, OPUS, at, MILLION)],
      })
      await Deno.utime(
        old.transcriptPath,
        new Date(`2026-09-01T00:00:00Z`),
        new Date(`2026-09-01T00:00:00Z`),
      )
      const inputs = await readTranscripts(dir, `2026-10-01`)
      assertEquals(inputs.map((i) => i.role).sort(), [`implementer`, `lead`])
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
)

t(`exits 2 on a non-ISO date, before reading anything`, async () => {
  const r = await new Deno.Command(Deno.execPath(), {
    args: [`run`, `-A`, DAILY, `--since`, `2026-13-01`, `--projects`, `/nonexistent`],
    stdout: `piped`,
    stderr: `piped`,
  }).output()
  assertEquals(r.code, 2)
  assertStringIncludes(new TextDecoder().decode(r.stderr), `--since must be a date`)
})
