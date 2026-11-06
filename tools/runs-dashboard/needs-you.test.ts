import { assertEquals } from "jsr:@std/assert@^1.0.0"
import { type BannerFacts, type BannerRun, needsYou } from "./needs-you.ts"

const NOW = Date.parse(`2026-11-06T12:00:00Z`)
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
const fine: BannerFacts = {
  now: NOW,
  paused: null,
  todayUsd: 50,
  runs: [],
  blockedIssues: [],
  stalls: [],
  lastImport: hoursAgo(1),
}
const run = (over: Partial<BannerRun>): BannerRun => ({
  id: `r1`,
  issue: `spy4x/financy#312`,
  status: `done`,
  startedAt: hoursAgo(2),
  costUsd: 10,
  ...over,
})
const kinds = (facts: Partial<BannerFacts>) =>
  needsYou({ ...fine, ...facts })?.items.map((item) => item.kind)

Deno.test(`nothing needs you when the lead runs, spend is under budget and imports are fresh`, () => {
  assertEquals(needsYou(fine), null)
})

Deno.test(`a paused lead is urgent and carries its reason`, () => {
  const banner = needsYou({ ...fine, paused: `two runs failed` })
  assertEquals(banner, { tone: `danger`, items: [{ kind: `paused`, reason: `two runs failed` }] })
})

Deno.test(`today's spend over $200 is urgent; exactly $200 is not`, () => {
  assertEquals(needsYou({ ...fine, todayUsd: 214 })?.tone, `danger`)
  assertEquals(kinds({ todayUsd: 214 }), [`over-budget`])
  assertEquals(kinds({ todayUsd: 200 }), undefined)
})

Deno.test(`a run over $100 or a failed run in the last 24 hours is listed; older ones are not`, () => {
  assertEquals(kinds({ runs: [run({ costUsd: 104 })] }), [`expensive-run`])
  assertEquals(kinds({ runs: [run({ status: `timeout` })] }), [`failed-run`])
  assertEquals(
    kinds({ runs: [run({ status: `failed`, costUsd: 104, startedAt: hoursAgo(25) })] }),
    undefined,
  )
  assertEquals(kinds({ runs: [run({ status: `blocked` })] }), undefined)
})

Deno.test(`blocked queue items, recent stalls and a stale import warn without being urgent`, () => {
  const banner = needsYou({
    ...fine,
    blockedIssues: [`spy4x/seed#301`],
    stalls: [hoursAgo(3), hoursAgo(30)],
    lastImport: hoursAgo(25),
  })
  assertEquals(banner?.tone, `warning`)
  assertEquals(banner?.items, [
    { kind: `blocked`, issue: `spy4x/seed#301` },
    { kind: `stalls`, count: 1 },
    { kind: `stale-import`, lastImport: hoursAgo(25) },
  ])
})

Deno.test(`no import at all counts as stale`, () => {
  assertEquals(kinds({ lastImport: null }), [`stale-import`])
})

Deno.test(`facts that could not be read add no line`, () => {
  assertEquals(kinds({ todayUsd: null, runs: null, blockedIssues: null, stalls: null }), undefined)
})
