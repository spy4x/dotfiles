import { assertEquals } from "jsr:@std/assert@^1.0.0"
import { DatabaseSync } from "node:sqlite"
import { type Dashboard, openReadOnly, readDashboard, type ReadDb } from "./data.ts"
import { createFixture } from "./fixture.ts"

// Local noon, so the fixture's runs from 0.5 to 9 hours ago fall on today in any time zone.
const NOW = new Date(2026, 10, 6, 12).getTime()

/** Writes the fixture, lets `change` edit it, then reads the dashboard and every SQL it ran. */
async function read(
  change: (db: DatabaseSync) => void = () => {},
): Promise<{ data: Dashboard; queries: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: `runs-dashboard-` })
  try {
    const path = createFixture(dir, { now: NOW })
    const writable = new DatabaseSync(path)
    change(writable)
    writable.close()
    const db = openReadOnly(path)
    const queries: string[] = []
    const counting: ReadDb = {
      all: (sql, ...params) => {
        queries.push(sql)
        return db.all(sql, ...params)
      },
      close: () => db.close(),
    }
    try {
      return { data: readDashboard(counting, NOW), queries }
    } finally {
      counting.close()
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const ready = <T>(section: { status: string; data?: T }): T => {
  assertEquals(section.status, `ready`)
  return section.data as T
}

Deno.test(`a run starting at the next local midnight is not today's spend`, async () => {
  const midnight = new Date(2026, 10, 7).getTime()
  const { data } = await read((db) => {
    const insert = db.prepare(
      `INSERT INTO runs (id, name, started_at, status, cost_micros) VALUES (?, 'x', ?, 'done', ?)`,
    )
    insert.run(`before`, new Date(midnight - 1).toISOString(), 1_000_000)
    insert.run(`at`, new Date(midnight).toISOString(), 50_000_000)
  })
  // The fixture's today is $170.90; only the run a millisecond before midnight adds its $1.
  assertEquals(Math.round(ready(data.today).usd * 100), 17_190)
})

Deno.test(`only stalls of headless runs reach the banner`, async () => {
  const { data } = await read()
  // The fixture has one headless stall and one in an interactive session.
  assertEquals(data.banner.stalls?.length, 1)
})

Deno.test(`time lost shows one CI-wait row with the cost of the waits, not of the sessions`, async () => {
  const { data } = await read((db) =>
    db.exec(`INSERT INTO lessons (id, at, kind, minutes, detail) VALUES
      ('l3', '${new Date(NOW - 3_600_000).toISOString()}', 'CI wait', 5, 'Woodpecker queue'),
      ('l4', '${new Date(NOW - 3_600_000).toISOString()}', 'ci_wait', 4, 'Runner restart')`)
  )
  const rows = ready(data.timeLost)
  const ci = rows.filter((row) => /ci/i.test(row.label))
  // Measured waits of 1,260 and 300 seconds, $3.10 and $0.90; the lessons' tokens stay.
  assertEquals(ci, [{
    label: `CI wait`,
    note: `Playwright suite ran twice (and 2 more)`,
    value: 26,
    values: [120_000, 4],
  }])
  assertEquals(rows.map((row) => row.label), [`CI wait`, `Review round`])
})

Deno.test(`slow steps are labelled with the tool's name only`, async () => {
  const { data } = await read()
  const rows = ready(data.slowSteps)
  assertEquals(rows.map((row) => [row.label, row.note]), [
    [`Bash`, undefined],
    [`Agent`, undefined],
    [`Bash`, undefined],
  ])
})

Deno.test(`a child run carries its parent's issue`, async () => {
  const { data } = await read()
  const child = ready(data.runs).find((run) => run.parent !== null)
  assertEquals(child?.parentIssue, `spy4x/financy#309`)
})

Deno.test(`one page load reads the v_sessions view at most twice`, async () => {
  const { queries } = await read()
  assertEquals(queries.filter((sql) => sql.includes(`v_sessions`)).length, 2)
})
