// Reads the run database for the dashboard: read-only, named columns only, one query per card.
// Tables and views: the wave-1 contract (lane A's runs, queue, lessons, meta; lane B's v_* views).

import { DatabaseSync } from "node:sqlite"
import { localDay } from "../agent-budget.ts"
import type { BannerFacts, BannerRun } from "./needs-you.ts"

/** One card's data: rows, nothing to show, or the query failed (a missing view, a bad column). */
export type Section<T> =
  | { status: `ready`; data: T }
  | { status: `empty` }
  | { status: `error`; message: string }

type Row = Record<string, unknown>

/** A read-only connection; every statement that writes fails with "readonly database". */
export interface ReadDb {
  all(sql: string, ...params: (string | number | null)[]): Row[]
  close(): void
}

/** Opens `path` read-only. Throws when the file is missing or cannot be opened. */
export function openReadOnly(path: string): ReadDb {
  const db = new DatabaseSync(path, { readOnly: true })
  db.exec(`PRAGMA busy_timeout = 10000`)
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params) as Row[],
    close: () => db.close(),
  }
}

/** Runs `read`; an exception becomes the card's error state, an empty result its empty state. */
export function section<T>(read: () => T, isEmpty: (data: T) => boolean): Section<T> {
  try {
    const data = read()
    return isEmpty(data) ? { status: `empty` } : { status: `ready`, data }
  } catch (error) {
    return { status: `error`, message: error instanceof Error ? error.message : String(error) }
  }
}

const num = (value: unknown): number => Number(value ?? 0)
const str = (
  value: unknown,
): string | null => (value === null || value === undefined ? null : String(value))

/** `YYYY-MM-DD` of `time` in the local time zone, the way `v_daily_spend` names its days. */
export function isoLocalDate(time: number): string {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, `0`)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The local days from `days - 1` days ago to today, oldest first. */
export function lastDays(now: number, days: number): string[] {
  const today = new Date(now)
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i))
    return isoLocalDate(day.getTime())
  })
}

const isoAgo = (now: number, days: number) => new Date(now - days * 86_400_000).toISOString()

/** A lead run row of the runs table. */
export interface RunRow extends BannerRun {
  name: string
  /** agent-run's `Mode`: 1 read, 2 write, 3 lead. agent-run always sets it; null only from a NULL value. */
  mode: number | null
  title: string | null
  parent: string | null
  /** The parent run's `owner/repo#n`, when it worked on an issue. */
  parentIssue: string | null
  endedAt: string | null
  reviewRounds: number | null
  ciWaitSec: number | null
}

/** A queue item that is open, or declined and waiting for its issue to change. */
export interface QueueItem {
  issue: string
  title: string
  status: string
  reason: string | null
  attempts: number
}

/** A row of a top-5 list. */
export interface RankedRow {
  label: string
  note?: string
  value: number
  values: (number | null)[]
}

/** Everything the page draws, one section per card. */
export interface Dashboard {
  now: number
  banner: BannerFacts
  /** True when the database holds no run and no imported session yet. */
  empty: boolean
  today: Section<{ usd: number }>
  kpis: Section<Kpis>
  daily: Section<{ days: string[]; kinds: Record<string, number[]> }>
  runs: Section<RunRow[]>
  queue: Section<{ counts: Record<string, number>; open: QueueItem[] }>
  projects: Section<RankedRow[]>
  timeLost: Section<RankedRow[]>
  slowSteps: Section<RankedRow[]>
}

/** The four key figures. */
export interface Kpis {
  merged7: number
  cost7: number
  merged30: number
  cost30: number
  runsToday: number
  runningNow: number
  failed7: number
}

/** Reads every section. Each query fails on its own, so one missing view blanks one card. */
export function readDashboard(db: ReadDb, now: number): Dashboard {
  const week = isoAgo(now, 7)
  const day = isoAgo(now, 1)
  const one = <T>(read: () => T): T | null => {
    try {
      return read()
    } catch {
      return null
    }
  }

  const runs = section(() => readRuns(db), (rows) => rows.length === 0)
  // The sessions table, not the v_sessions view: the view sums every API call to answer.
  const lastImport = one(() =>
    str(db.all(`SELECT MAX(COALESCE(ended_at, started_at)) AS at FROM sessions`)[0]?.at)
  )
  const banner: BannerFacts = {
    now,
    paused: one(() => str(db.all(`SELECT value FROM meta WHERE key = 'paused'`)[0]?.value)) ??
      null,
    todayUsd: one(() => readTodayUsd(db, now)),
    runs: one(() =>
      db.all(
        `SELECT id, issue, status, started_at, cost_micros FROM runs WHERE started_at >= ?`,
        day,
      ).map((row) => ({
        id: String(row.id),
        issue: str(row.issue),
        status: String(row.status),
        startedAt: String(row.started_at),
        costUsd: num(row.cost_micros) / 1e6,
      }))
    ),
    blockedIssues: one(() =>
      db.all(`SELECT issue FROM queue WHERE status = 'blocked' ORDER BY rank`).map((row) =>
        String(row.issue)
      )
    ),
    // Headless runs only: a pause in the owner's own session is not the loop stalling.
    stalls: one(() =>
      db.all(`SELECT to_at FROM v_stalls WHERE to_at >= ? AND kind = 'headless'`, day).map((
        row,
      ) => String(row.to_at))
    ),
    lastImport,
  }
  const runCount = one(() => num(db.all(`SELECT COUNT(*) AS n FROM runs`)[0]?.n))
  return {
    now,
    banner,
    empty: (runCount ?? 0) === 0 && lastImport === null,
    today: section(() => ({ usd: readTodayUsd(db, now) }), () => false),
    kpis: section(() => readKpis(db, now), () => false),
    daily: section(() => readDaily(db, now), (data) => Object.keys(data.kinds).length === 0),
    runs,
    queue: section(() => readQueue(db), (data) => Object.keys(data.counts).length === 0),
    projects: section(() => readProjects(db, week), (rows) => rows.length === 0),
    timeLost: section(() => readTimeLost(db, week), (rows) => rows.length === 0),
    slowSteps: section(() => readSlowSteps(db, week), (rows) => rows.length === 0),
  }
}

/**
 * What the lead's runs that started on the local calendar day cost, in dollars: the same sum
 * `agent-run` stops the loop on. Interactive sessions do not count against the budget.
 */
function readTodayUsd(db: ReadDb, now: number): number {
  const { start, end } = localDay(new Date(now))
  const row = db.all(
    `SELECT SUM(cost_micros) AS spent FROM runs WHERE started_at >= ? AND started_at < ?`,
    start,
    end,
  )[0]
  return num(row?.spent) / 1e6
}

function readKpis(db: ReadDb, now: number): Kpis {
  const days = lastDays(now, 30)
  const goal = (from: string) =>
    db.all(
      `SELECT SUM(merged_issues) AS merged, SUM(cost_usd) AS usd FROM v_goal WHERE day >= ?`,
      from,
    )[0] ?? {}
  const g7 = goal(days[23])
  const g30 = goal(days[0])
  const startOfToday = new Date(new Date(now).setHours(0, 0, 0, 0)).toISOString()
  const counts = db.all(
    `SELECT
       SUM(started_at >= ?) AS today,
       SUM(status = 'running') AS running,
       SUM(started_at >= ? AND status IN ('failed', 'timeout', 'budget', 'turns')) AS failed
     FROM runs`,
    startOfToday,
    isoAgo(now, 7),
  )[0] ?? {}
  return {
    merged7: num(g7.merged),
    cost7: num(g7.usd),
    merged30: num(g30.merged),
    cost30: num(g30.usd),
    runsToday: num(counts.today),
    runningNow: num(counts.running),
    failed7: num(counts.failed),
  }
}

function readDaily(db: ReadDb, now: number) {
  const days = lastDays(now, 30)
  const kinds: Record<string, number[]> = {}
  const rows = db.all(
    `SELECT day, kind, SUM(cost_usd) AS usd FROM v_daily_spend WHERE day >= ? GROUP BY day, kind`,
    days[0],
  )
  for (const row of rows) {
    const kind = String(row.kind)
    kinds[kind] ??= days.map(() => 0)
    const index = days.indexOf(String(row.day))
    if (index >= 0) kinds[kind][index] = num(row.usd)
  }
  return { days, kinds }
}

function readRuns(db: ReadDb): RunRow[] {
  const rows = db.all(
    `SELECT r.id, r.name, r.mode, r.parent, p.issue AS parent_issue, r.issue, r.started_at, r.ended_at,
       r.status, r.cost_micros, q.title
     FROM runs r LEFT JOIN queue q ON q.issue = r.issue LEFT JOIN runs p ON p.id = r.parent
     ORDER BY r.started_at DESC LIMIT 20`,
  )
  // Review rounds and CI wait come from lane B's sessions; without them the table still draws.
  const stats = new Map<string, Row>()
  try {
    const ids = rows.map((row) => String(row.id))
    if (ids.length > 0) {
      const marks = ids.map(() => `?`).join(`, `)
      for (
        const row of db.all(
          `SELECT id, review_rounds, ci_wait_sec FROM v_sessions WHERE id IN (${marks})`,
          ...ids,
        )
      ) stats.set(String(row.id), row)
    }
  } catch { /* the view is missing or older: show the runs without these numbers */ }
  return rows.map((row) => {
    const stat = stats.get(String(row.id))
    return {
      id: String(row.id),
      name: String(row.name),
      mode: row.mode === null ? null : num(row.mode),
      title: str(row.title),
      parent: str(row.parent),
      parentIssue: str(row.parent_issue),
      issue: str(row.issue),
      status: String(row.status),
      startedAt: String(row.started_at),
      endedAt: str(row.ended_at),
      costUsd: num(row.cost_micros) / 1e6,
      reviewRounds: stat ? num(stat.review_rounds) : null,
      ciWaitSec: stat ? num(stat.ci_wait_sec) : null,
    }
  })
}

const QUEUE_ORDER =
  `CASE status WHEN 'blocked' THEN 0 WHEN 'declined' THEN 1 WHEN 'claimed' THEN 2 ELSE 3 END, rank`

function readQueue(db: ReadDb) {
  const counts: Record<string, number> = {}
  for (const row of db.all(`SELECT status, COUNT(*) AS n FROM queue GROUP BY status`)) {
    counts[String(row.status)] = num(row.n)
  }
  const open = db.all(
    `SELECT issue, title, status, reason, attempts FROM queue
     WHERE status IN ('blocked', 'declined', 'claimed', 'queued') ORDER BY ${QUEUE_ORDER}`,
  ).map((row) => ({
    issue: String(row.issue),
    title: String(row.title),
    status: String(row.status),
    reason: str(row.reason),
    attempts: num(row.attempts),
  }))
  return { counts, open }
}

function readProjects(db: ReadDb, since: string): RankedRow[] {
  return db.all(
    `SELECT COALESCE(project, '(none)') AS project, SUM(cost_usd) AS usd, COUNT(*) AS n
     FROM v_sessions WHERE started_at >= ? GROUP BY project ORDER BY usd DESC LIMIT 8`,
    since,
  ).map((row) => ({ label: String(row.project), value: num(row.usd), values: [num(row.n)] }))
}

/** A lesson kind as one category: `CI wait`, `ci_wait` and `ci-wait` are all `ci-wait`. */
const lessonCategory = (kind: string): string => kind.trim().toLowerCase().replace(/[\s_]+/g, `-`)

const CATEGORY_NAMES: Record<string, string> = { "ci-wait": `CI wait` }
const categoryName = (category: string) =>
  CATEGORY_NAMES[category] ??
    category.charAt(0).toUpperCase() + category.slice(1).replaceAll(`-`, ` `)

/**
 * Time lost, one row per category: the open lessons grouped by kind, and the measured CI waits.
 * The CI-wait row is one row: its time is the measured waits (a lesson's estimate only when none
 * was measured, since both describe the same waits), its cost is what those waits cost.
 */
function readTimeLost(db: ReadDb, since: string): RankedRow[] {
  const groups = new Map<string, { minutes: number; tokens: number | null; details: string[] }>()
  for (
    const row of db.all(
      `SELECT kind, detail, minutes, tokens FROM lessons
       WHERE status = 'open' AND at >= ? AND minutes > 0 ORDER BY minutes DESC`,
      since,
    )
  ) {
    const category = lessonCategory(String(row.kind))
    const group = groups.get(category) ?? { minutes: 0, tokens: null, details: [] }
    group.minutes += num(row.minutes)
    if (row.tokens !== null) group.tokens = (group.tokens ?? 0) + num(row.tokens)
    group.details.push(String(row.detail))
    groups.set(category, group)
  }
  const rows = new Map<string, RankedRow>()
  for (const [category, group] of groups) {
    const [first, ...more] = group.details
    rows.set(category, {
      label: categoryName(category),
      note: more.length ? `${first} (and ${more.length} more)` : first,
      value: group.minutes,
      values: [group.tokens, null],
    })
  }
  const ci = db.all(
    `SELECT COUNT(*) AS n, SUM(sec) AS sec, SUM(cost_usd) AS usd FROM v_ci_waits WHERE at >= ?`,
    since,
  )[0] ?? {}
  if (num(ci.n) > 0) {
    const lesson = rows.get(`ci-wait`)
    rows.set(`ci-wait`, {
      label: categoryName(`ci-wait`),
      note: lesson?.note ?? `${num(ci.n)} ${num(ci.n) === 1 ? `wait` : `waits`}`,
      value: num(ci.sec) > 0 ? num(ci.sec) / 60 : lesson?.value ?? 0,
      values: [lesson?.values[0] ?? null, ci.usd === null ? null : num(ci.usd)],
    })
  }
  return [...rows.values()].sort((a, b) => b.value - a.value).slice(0, 5)
}

function readSlowSteps(db: ReadDb, since: string): RankedRow[] {
  // The tool's name, its project and run, and its time: a step's input can hold prompts or secrets.
  return db.all(
    `SELECT tool, project, run_id, run_issue, sec, is_error FROM v_slow_steps WHERE at >= ?
     ORDER BY sec DESC LIMIT 5`,
    since,
  ).map((row) => {
    const issue = str(row.run_issue)
    const run = row.run_id === null
      ? `own session`
      : `run ${issue ? `#${issue.split(`#`)[1]}` : String(row.run_id).slice(-6)}`
    return {
      label: String(row.tool),
      note: `${row.project} · ${run}`,
      value: num(row.sec),
      values: [num(row.is_error)],
    }
  })
}
