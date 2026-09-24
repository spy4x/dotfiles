import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19"
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.0.0"
import {
  type AgentReport,
  loadSessionReport,
  parseTranscript,
  priceFor,
  report,
  resolveSession,
  summarise,
} from "./session-cost.ts"

const FIXTURES = join(dirname(fromFileUrl(import.meta.url)), `fixtures`, `session-cost`, `projects`)

/** One raw transcript line, as `JSON.stringify` would write it. */
function line(entry: unknown): string {
  return JSON.stringify(entry)
}

/** A minimal `assistant` transcript line, with usage fields defaulting to zero. */
function assistantLine(
  id: string,
  model: string,
  timestamp: string,
  usage: Record<string, unknown> = {},
): string {
  return line({
    type: `assistant`,
    timestamp,
    message: {
      id,
      model,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        ...usage,
      },
    },
  })
}

function compactionLine(timestamp: string): string {
  return line({ type: `system`, subtype: `compact_boundary`, timestamp })
}

Deno.test(`uses the last usage line of a repeated message id`, () => {
  const lines = [
    assistantLine(`msg_1`, `claude-sonnet-5`, `2026-01-01T00:00:00.000Z`, { output_tokens: 8 }),
    assistantLine(`msg_1`, `claude-sonnet-5`, `2026-01-01T00:00:01.000Z`, { output_tokens: 472 }),
  ]
  const parsed = parseTranscript(lines)
  assertEquals(parsed.calls.length, 1)
  assertEquals(parsed.calls[0].outputTokens, 472)
})

Deno.test(`prices 1-hour and 5-minute cache writes differently`, () => {
  const fiveMinute = summarise(
    [
      assistantLine(`m5`, `claude-sonnet-5`, `2026-01-01T00:00:00.000Z`, {
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 },
      }),
    ],
    { label: `main` },
  )
  const oneHour = summarise(
    [
      assistantLine(`m1`, `claude-sonnet-5`, `2026-01-01T00:00:00.000Z`, {
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
      }),
    ],
    { label: `main` },
  )
  // claude-sonnet-5 input price is $2/M: 5-minute writes at 1.25x, 1-hour writes at 2x.
  assertEquals(fiveMinute.cost.cacheWrite, 2.5)
  assertEquals(oneHour.cost.cacheWrite, 4)
})

Deno.test(`treats a missing cache_creation split as all 5-minute writes`, () => {
  const result = summarise(
    [
      assistantLine(`m1`, `claude-sonnet-5`, `2026-01-01T00:00:00.000Z`, {
        cache_creation_input_tokens: 1_000_000,
      }),
    ],
    { label: `main` },
  )
  assertEquals(result.cost.cacheWrite, 2.5)
})

Deno.test(`matches claude-opus-5-5 before claude-opus-5`, () => {
  assertEquals(priceFor(`claude-opus-5-5-20260101`)?.input, 4)
  assertEquals(priceFor(`claude-opus-5-20260101`)?.input, 5)
})

Deno.test(`skips synthetic messages`, () => {
  const lines = [
    assistantLine(`err`, `<synthetic>`, `2026-01-01T00:00:00.000Z`, {
      input_tokens: 999,
      output_tokens: 999,
    }),
  ]
  const parsed = parseTranscript(lines)
  assertEquals(parsed.calls.length, 0)
})

Deno.test(`skips unparseable lines`, () => {
  const lines = [
    `not valid json`,
    assistantLine(`ok`, `claude-sonnet-5`, `2026-01-01T00:00:00.000Z`, { output_tokens: 1 }),
  ]
  const parsed = parseTranscript(lines)
  assertEquals(parsed.calls.length, 1)
})

Deno.test(`counts compactions`, () => {
  const lines = [
    compactionLine(`2026-01-01T00:00:00.000Z`),
    assistantLine(`ok`, `claude-sonnet-5`, `2026-01-01T00:05:00.000Z`),
    compactionLine(`2026-01-01T00:10:00.000Z`),
    compactionLine(`2026-01-01T00:15:00.000Z`),
  ]
  const parsed = parseTranscript(lines)
  assertEquals(parsed.compactionTimestamps.length, 3)
})

Deno.test(`filters calls and compactions by --since/--until`, () => {
  const lines = [
    assistantLine(`before`, `claude-sonnet-5`, `2026-01-01T10:00:00.000Z`),
    compactionLine(`2026-01-01T10:15:00.000Z`),
    assistantLine(`inside`, `claude-sonnet-5`, `2026-01-01T11:00:00.000Z`),
    compactionLine(`2026-01-01T11:30:00.000Z`),
    assistantLine(`after`, `claude-sonnet-5`, `2026-01-01T12:00:00.000Z`),
  ]
  const result = summarise(lines, {
    label: `main`,
    since: new Date(`2026-01-01T10:30:00.000Z`),
    until: new Date(`2026-01-01T11:45:00.000Z`),
  })
  assertEquals(result.calls, 1)
  assertEquals(result.compactions, 1)
})

Deno.test(`reports an unpriced model as unknown instead of zero`, () => {
  const result = summarise(
    [
      assistantLine(`m1`, `claude-nonexistent-9`, `2026-01-01T00:00:00.000Z`, {
        input_tokens: 100,
        output_tokens: 100,
        cache_read_input_tokens: 100,
      }),
    ],
    { label: `main` },
  )
  assertEquals(result.calls, 1)
  assertEquals(result.models, [`claude-nonexistent-9`])
  assertEquals(result.unpricedModels, [`claude-nonexistent-9`])
  assertEquals(result.totalCost, 0)
})

function makeAgent(label: string, totalCost: number): AgentReport {
  return {
    label,
    models: [`claude-sonnet-5`],
    calls: 1,
    peakCtx: 0,
    avgCtx: 0,
    compactions: 0,
    minutes: 0,
    cost: { cacheRead: 0, cacheWrite: 0, output: totalCost, input: 0 },
    totalCost,
    unpricedModels: [],
  }
}

Deno.test(`orders main first, then subagents by cost descending`, () => {
  const main = makeAgent(`main`, 1)
  const cheap = makeAgent(`cheap subagent`, 5)
  const pricey = makeAgent(`pricey subagent`, 50)
  const session = report(main, [cheap, pricey])
  assertEquals(session.agents.map((agent) => agent.label), [
    `main`,
    `pricey subagent`,
    `cheap subagent`,
  ])
  assertEquals(session.totalCost, 56)
})

Deno.test(`resolves a direct path argument without searching the projects directory`, async () => {
  const mainPath = join(
    FIXTURES,
    `-fake-project`,
    `11111111-1111-1111-1111-111111111111.jsonl`,
  )
  const location = await resolveSession(`/nonexistent-projects-dir`, mainPath)
  assertEquals(location.mainPath, await Deno.realPath(mainPath))
  assertEquals(location.subagentsDir.endsWith(`/subagents`), true)
})

Deno.test(`fails loudly on an unknown session id`, async () => {
  await assertRejects(
    () => resolveSession(FIXTURES, `00000000-0000-0000-0000-000000000000`),
    Error,
    `no session`,
  )
})

Deno.test(`includes subagents with their meta labels`, async () => {
  const location = await resolveSession(FIXTURES, `11111111-1111-1111-1111-111111111111`)
  const session = await loadSessionReport(location, {})

  assertEquals(session.agents[0].label, `main`)
  assertEquals(session.agents[0].calls, 2) // msg_a (deduped) + msg_b; synthetic and bad JSON skipped
  assertEquals(session.agents[0].compactions, 1)

  const subagent = session.agents.find((agent) => agent.label === `implementer: Fixture lane`)
  assertEquals(subagent?.calls, 2)
  assertEquals(subagent?.unpricedModels, [`claude-unknown-9`])
  assertEquals(session.unpricedModels, [`claude-unknown-9`])
})
