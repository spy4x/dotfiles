import { assertEquals } from "jsr:@std/assert@1.0.19"
import { query, summarize } from "./traggo.ts"

Deno.test(`sums hours per area and per day`, () => {
  const s = summarize([
    {
      start: `2026-10-05T01:00:00Z`,
      end: `2026-10-05T04:00:00Z`,
      day: `2026-10-05`,
      area: `sales`,
    },
    {
      start: `2026-10-05T05:00:00Z`,
      end: `2026-10-05T06:30:00Z`,
      day: `2026-10-05`,
      area: `tooling`,
    },
    { start: `2026-10-06T01:00:00Z`, end: `2026-10-06T02:00:00Z`, day: `2026-10-06`, area: null },
  ])
  assertEquals(s.total, 5.5)
  assertEquals(s.byArea, { sales: 3, tooling: 1.5, untagged: 1 })
  assertEquals(s.byDay, { "2026-10-05": 4.5, "2026-10-06": 1 })
})

Deno.test(`splits only rule areas against the 60/25/15 targets`, () => {
  const s = summarize([
    {
      start: `2026-10-05T00:00:00Z`,
      end: `2026-10-05T03:00:00Z`,
      day: `2026-10-05`,
      area: `client`,
    },
    {
      start: `2026-10-05T03:00:00Z`,
      end: `2026-10-05T04:00:00Z`,
      day: `2026-10-05`,
      area: `product`,
    },
    {
      start: `2026-10-05T04:00:00Z`,
      end: `2026-10-05T09:00:00Z`,
      day: `2026-10-05`,
      area: `tooling`,
    },
  ])
  assertEquals(s.rule.paid, { hours: 3, share: 0.75, target: 0.6 })
  assertEquals(s.rule.product, { hours: 1, share: 0.25, target: 0.25 })
  assertEquals(s.rule.video, { hours: 0, share: 0, target: 0.15 })
})

Deno.test(`counts a running timer until now`, () => {
  const s = summarize(
    [{ start: `2026-10-05T01:00:00Z`, end: null, day: `2026-10-05`, area: `video` }],
    new Date(`2026-10-05T03:00:00Z`),
  )
  assertEquals(s.byArea, { video: 2 })
})

Deno.test(`reports zero shares when nothing is tracked`, () => {
  const s = summarize([])
  assertEquals(s.total, 0)
  assertEquals(s.rule.paid.share, 0)
})

Deno.test(`filters spans by local start day, inclusive`, () => {
  const sql = query(`2026-10-01`, `2026-10-31`)
  assertEquals(
    sql.includes(`WHERE substr(s.start_user_time, 1, 10) BETWEEN '2026-10-01' AND '2026-10-31'`),
    true,
  )
})

Deno.test(`counts client and sales together as paid work`, () => {
  const s = summarize([
    {
      start: `2026-10-05T00:00:00Z`,
      end: `2026-10-05T01:00:00Z`,
      day: `2026-10-05`,
      area: `client`,
    },
    {
      start: `2026-10-05T01:00:00Z`,
      end: `2026-10-05T02:00:00Z`,
      day: `2026-10-05`,
      area: `sales`,
    },
  ])
  assertEquals(s.rule.paid, { hours: 2, share: 1, target: 0.6 })
})

Deno.test(`never counts a span that ends before it starts`, () => {
  const s = summarize([
    {
      start: `2026-10-05T02:00:00Z`,
      end: `2026-10-05T01:00:00Z`,
      day: `2026-10-05`,
      area: `sales`,
    },
  ])
  assertEquals(s.total, 0)
})
