// A run database shaped like the wave-1 contract, for tests and for looking at the page:
// `deno run -A tools/runs-dashboard/fixture.ts <dir> [--empty]` writes <dir>/runs.sqlite.
// The v_* views are plain tables here: the dashboard only reads their named columns.

import { DatabaseSync } from "node:sqlite"
import { join } from "jsr:@std/path@^1.0.0"
import { isoLocalDate } from "./data.ts"

const SCHEMA = `
CREATE TABLE runs (id TEXT PRIMARY KEY, name TEXT NOT NULL, mode INTEGER, model TEXT, effort TEXT,
  cwd TEXT, parent TEXT, issue TEXT, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL,
  cost_micros INTEGER, turns INTEGER, result TEXT);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE queue (issue TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL,
  rank INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT, run_id TEXT, planned_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE lessons (id TEXT PRIMARY KEY, run_id TEXT, at TEXT NOT NULL, kind TEXT NOT NULL,
  minutes REAL, tokens INTEGER, detail TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  closed_reason TEXT) STRICT;
CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT);
CREATE TABLE v_sessions (id TEXT, parent_id TEXT, run_id TEXT, kind TEXT, agent_type TEXT,
  project TEXT, cwd TEXT, started_at TEXT, ended_at TEXT, wall_sec REAL, model TEXT,
  cost_usd REAL, review_rounds INTEGER, ci_wait_sec REAL, rework INTEGER, prs INTEGER);
CREATE TABLE v_daily_spend (day TEXT, kind TEXT, sessions INTEGER, cost_usd REAL);
CREATE TABLE v_slow_steps (session_id TEXT, at TEXT, tool TEXT, project TEXT, run_id TEXT,
  run_issue TEXT, summary TEXT, sec REAL, is_error INTEGER);
CREATE TABLE v_stalls (session_id TEXT, from_at TEXT, to_at TEXT, gap_sec REAL, kind TEXT);
CREATE TABLE v_ci_waits (session_id TEXT, kind TEXT, at TEXT, sec REAL, cost_usd REAL);
CREATE TABLE v_goal (day TEXT, merged_issues INTEGER, cost_usd REAL, issues_per_dollar REAL,
  reverts INTEGER, reviewer_rounds_per_pr REAL);
`

/** Creates `<dir>/runs.sqlite` with the contract's tables and views, and sample rows unless `empty`. */
export function createFixture(
  dir: string,
  { now, empty = false }: { now: number; empty?: boolean },
) {
  const path = join(dir, `runs.sqlite`)
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode = WAL`)
  db.exec(SCHEMA)
  if (!empty) seed(db, now)
  db.close()
  return path
}

const ago = (now: number, hours: number) => new Date(now - hours * 3_600_000).toISOString()

function insert(db: DatabaseSync, table: string, rows: Record<string, string | number | null>[]) {
  for (const row of rows) {
    const keys = Object.keys(row)
    db.prepare(
      `INSERT INTO ${table} (${keys.join(`, `)}) VALUES (${keys.map(() => `?`).join(`, `)})`,
    )
      .run(...Object.values(row))
  }
}

function seed(db: DatabaseSync, now: number) {
  const run = (
    id: string,
    issue: string | null,
    hoursAgo: number,
    hours: number | null,
    status: string,
    usd: number,
    parent: string | null = null,
  ) => ({
    id,
    name: issue ? `lead-${issue.split(`#`)[1]}` : `lead-tick`,
    mode: 3,
    issue,
    parent,
    started_at: ago(now, hoursAgo),
    ended_at: hours === null ? null : ago(now, hoursAgo - hours),
    status,
    cost_micros: Math.round(usd * 1e6),
  })
  insert(db, `runs`, [
    run(`019a5f00-0000-7000-8000-000000000312`, `spy4x/financy#312`, 0.5, null, `running`, 18.4),
    run(`019a5f00-0000-7000-8000-000000000309`, `spy4x/financy#309`, 3, 1.2, `failed`, 104.2),
    run(
      `019a5f00-0000-7000-8000-000000000310`,
      null,
      2.5,
      0.3,
      `done`,
      6.8,
      `019a5f00-0000-7000-8000-000000000309`,
    ),
    run(`019a5f00-0000-7000-8000-000000000301`, `spy4x/seed#301`, 9, 0.9, `blocked`, 41.5),
    run(`019a5f00-0000-7000-8000-000000000298`, `spy4x/financy#298`, 26, 1.6, `done`, 52.1),
    run(
      `019a5f00-0000-7000-8000-000000000295`,
      `spy4x/preact-components#295`,
      50,
      0.7,
      `done`,
      23.9,
    ),
  ])
  insert(db, `meta`, [{ key: `paused`, value: `two runs in a row failed` }])
  const q = (
    issue: string,
    title: string,
    rank: number,
    status: string,
    reason: string | null,
    attempts = 0,
  ) => ({
    issue,
    title,
    source: `milestone:Financy beta`,
    rank,
    status,
    reason,
    attempts,
    planned_at: ago(now, 4),
    updated_at: ago(now, 1),
  })
  insert(db, `queue`, [
    q(`spy4x/financy#312`, `Import bank statements from CSV`, 1, `claimed`, null),
    q(
      `spy4x/financy#309`,
      `Add the transcript importer for the monthly report`,
      2,
      `queued`,
      `parked for CI`,
      1,
    ),
    q(
      `spy4x/seed#301`,
      `Translate the billing page into all nine languages`,
      3,
      `blocked`,
      `failed twice`,
      2,
    ),
    q(`spy4x/financy#315`, `Show the budget left per category`, 4, `queued`, null),
    q(
      `spy4x/financy#317`,
      `Sync with the bank's API`,
      7,
      `declined`,
      `Needs the bank's API keys first`,
    ),
    q(`spy4x/financy#298`, `Recurring transactions`, 5, `done`, null),
    q(`spy4x/financy#290`, `Old idea`, 6, `dropped`, `closed`),
  ])
  insert(db, `lessons`, [
    {
      id: `l1`,
      at: ago(now, 5),
      kind: `ci-wait`,
      minutes: 38,
      tokens: 120000,
      detail: `Playwright suite ran twice`,
    },
    {
      id: `l2`,
      at: ago(now, 30),
      kind: `review-round`,
      minutes: 22,
      tokens: 410000,
      detail: `Missing mutation lines`,
    },
  ])
  const sessions = [
    [`019a5f00-0000-7000-8000-000000000312`, `headless`, `financy`, 0.5, 18.4, 1, 300],
    [`019a5f00-0000-7000-8000-000000000309`, `headless`, `financy`, 3, 104.2, 3, 1260],
    [`s-a`, `interactive`, `dotfiles`, 2, 31.0, 0, 0],
    [`s-b`, `subagent`, `seed`, 9, 12.5, 1, 0],
    [`s-c`, `interactive`, `financy`, 30, 44.0, 0, 0],
  ] as const
  insert(
    db,
    `sessions`,
    sessions.map(([id, , , h]) => ({ id, started_at: ago(now, h), ended_at: ago(now, h - 0.4) })),
  )
  insert(
    db,
    `v_sessions`,
    sessions.map(([id, kind, project, h, usd, rounds, ci]) => ({
      id,
      kind,
      project,
      started_at: ago(now, h),
      ended_at: ago(now, h - 0.4),
      cost_usd: usd,
      review_rounds: rounds,
      ci_wait_sec: ci,
    })),
  )
  insert(db, `v_ci_waits`, [
    {
      session_id: `019a5f00-0000-7000-8000-000000000309`,
      kind: `headless`,
      at: ago(now, 2.5),
      sec: 1260,
      cost_usd: 3.1,
    },
    {
      session_id: `019a5f00-0000-7000-8000-000000000312`,
      kind: `headless`,
      at: ago(now, 0.3),
      sec: 300,
      cost_usd: 0.9,
    },
  ])
  insert(db, `v_slow_steps`, [
    {
      session_id: `s-a`,
      at: ago(now, 2),
      tool: `Bash`,
      project: `dotfiles`,
      run_id: null,
      run_issue: null,
      summary: `deno task check`,
      sec: 412,
      is_error: 0,
    },
    {
      session_id: `s-b`,
      at: ago(now, 9),
      tool: `Bash`,
      project: `seed`,
      run_id: `019a5f00-0000-7000-8000-000000000301`,
      run_issue: `spy4x/seed#301`,
      summary: `gh pr checks --watch`,
      sec: 960,
      is_error: 1,
    },
    {
      session_id: `019a5f00-0000-7000-8000-000000000310`,
      at: ago(now, 2.4),
      tool: `Agent`,
      project: `financy`,
      run_id: `019a5f00-0000-7000-8000-000000000310`,
      run_issue: null,
      summary: `reviewer`,
      sec: 640,
      is_error: 0,
    },
  ])
  insert(db, `v_stalls`, [
    {
      session_id: `019a5f00-0000-7000-8000-000000000309`,
      from_at: ago(now, 2.8),
      to_at: ago(now, 2.5),
      gap_sec: 1080,
      kind: `headless`,
    },
    // The owner away from an interactive session: not a stall of the loop.
    {
      session_id: `s-a`,
      from_at: ago(now, 1.9),
      to_at: ago(now, 1.7),
      gap_sec: 720,
      kind: `interactive`,
    },
  ])
  const daily: Record<string, string | number | null>[] = []
  const goal: Record<string, string | number | null>[] = []
  for (let d = 29; d >= 0; d--) {
    const day = isoLocalDate(now - d * 86_400_000)
    const wave = (d * 37) % 11
    const kinds = d === 0 ? { interactive: 38, headless: 92, subagent: 12 } : {
      interactive: 30 + wave * 6,
      headless: d % 6 === 0 ? 0 : 40 + wave * 9,
      subagent: 10 + wave * 2,
    }
    for (const [kind, usd] of Object.entries(kinds)) {
      daily.push({ day, kind, sessions: 3, cost_usd: usd })
    }
    goal.push({
      day,
      merged_issues: d % 3 === 0 ? 2 : 1,
      cost_usd: kinds.headless + kinds.subagent,
    })
  }
  insert(db, `v_daily_spend`, daily)
  insert(db, `v_goal`, goal)
}

if (import.meta.main) {
  const [dir, flag] = Deno.args
  if (!dir) throw new Error(`Usage: fixture.ts <dir> [--empty]`)
  console.log(createFixture(dir, { now: Date.now(), empty: flag === `--empty` }))
}
