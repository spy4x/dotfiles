#!/usr/bin/env -S deno run --allow-run=ssh
// Tracked time from Traggo for a date range: hours per `area` tag, hours per day, and the split
// against the 60/25/15 rule in ai-memory's TASKS.md. Reads the homelab's Traggo SQLite database
// read-only over ssh, so it needs no token and never passes Authelia.
//
// Usage: deno run --allow-run=ssh traggo.ts <from YYYY-MM-DD> <to YYYY-MM-DD, inclusive>

const HOST = `homelab`
const DB = `/home/spy4x/ssd-2tb/rostok/volumes/traggo/data/traggo.db`
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Rule buckets from TASKS.md: share of working time each should get. */
export const RULE: Record<string, { areas: string[]; target: number }> = {
  paid: { areas: [`client`, `sales`], target: 0.6 },
  product: { areas: [`product`], target: 0.25 },
  video: { areas: [`video`], target: 0.15 },
}

/** One Traggo time span as the query returns it. Times are ISO strings; `end` null = running. */
export interface Span {
  start: string
  end: string | null
  day: string
  area: string | null
}

/** Hours per area, per day, untagged, and the rule split over client+sales+product+video. */
export interface Summary {
  total: number
  byArea: Record<string, number>
  byDay: Record<string, number>
  rule: Record<string, { hours: number; share: number; target: number }>
}

const round = (n: number) => Math.round(n * 100) / 100

/** Sums spans into a summary. A running span counts until `now`. */
export function summarize(spans: Span[], now = new Date()): Summary {
  const byArea: Record<string, number> = {}
  const byDay: Record<string, number> = {}
  let total = 0
  for (const s of spans) {
    const end = s.end ? new Date(s.end) : now
    const hours = Math.max(0, end.getTime() - new Date(s.start).getTime()) / 3_600_000
    const area = s.area ?? `untagged`
    byArea[area] = (byArea[area] ?? 0) + hours
    byDay[s.day] = (byDay[s.day] ?? 0) + hours
    total += hours
  }
  const ruleHours = Object.values(RULE).flatMap((b) => b.areas).reduce(
    (sum, a) => sum + (byArea[a] ?? 0),
    0,
  )
  const rule: Summary[`rule`] = {}
  for (const [name, { areas, target }] of Object.entries(RULE)) {
    const hours = areas.reduce((sum, a) => sum + (byArea[a] ?? 0), 0)
    rule[name] = { hours: round(hours), share: ruleHours ? round(hours / ruleHours) : 0, target }
  }
  for (const k in byArea) byArea[k] = round(byArea[k])
  for (const k in byDay) byDay[k] = round(byDay[k])
  return { total: round(total), byArea, byDay, rule }
}

/** SQL for spans whose local start falls in [from, to]. Dates must already match DATE. */
export function query(from: string, to: string): string {
  return `SELECT s.start_utc AS start, s.end_utc AS end, substr(s.start_user_time, 1, 10) AS day,
  (SELECT t.string_value FROM time_span_tags t WHERE t.time_span_id = s.id AND t.key = 'area'
   LIMIT 1) AS area
FROM time_spans s
WHERE substr(s.start_user_time, 1, 10) BETWEEN '${from}' AND '${to}'
ORDER BY s.start_utc;`
}

/** Traggo stores `2026-07-08 13:20:00+00:00`; Date needs a `T`. */
const iso = (t: string | null) => (t ? t.replace(` `, `T`) : null)

if (import.meta.main) {
  const [from, to] = Deno.args
  if (!DATE.test(from ?? ``) || !DATE.test(to ?? ``)) {
    console.error(`Usage: traggo.ts <from YYYY-MM-DD> <to YYYY-MM-DD>`)
    Deno.exit(2)
  }
  const child = new Deno.Command(`ssh`, {
    args: [`-o`, `BatchMode=yes`, `-o`, `ConnectTimeout=10`, HOST, `sqlite3 -readonly -json ${DB}`],
    stdin: `piped`,
    stdout: `piped`,
    stderr: `piped`,
  }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(query(from, to)))
  await writer.close()
  const { code, stdout, stderr } = await child.output()
  if (code !== 0) {
    console.error(`Traggo query failed: ${new TextDecoder().decode(stderr).trim()}`)
    Deno.exit(1)
  }
  const text = new TextDecoder().decode(stdout).trim()
  const rows: Span[] = text ? JSON.parse(text) : []
  const spans = rows.map((r) => ({ ...r, start: iso(r.start)!, end: iso(r.end) }))
  console.log(JSON.stringify({ from, to, spans: spans.length, ...summarize(spans) }, null, 2))
}
