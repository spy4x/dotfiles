#!/usr/bin/env -S deno run -A
// Starts, tracks and stops headless `claude -p` runs as systemd user services, so a lead or a
// timer can hand work to a run that outlives its own session. Design: docs/headless-runs.md.
//
// Usage (`agent-run` = `deno run -A ~/sync/code/dotfiles/tools/agent-run.ts`):
//   agent-run start  --cwd <dir> --model <opus|haiku> --mode <read|write|lead> --brief <file|->
//                    [--name <slug>] [--effort medium] [--deadline 2h] [--budget-usd 20]
//                    [--max-turns 300] [--issue <owner/repo#n>] [--allow "<tool rule>"]...
//                    [--handoff-from <id>]          (--budget-usd 0, --max-turns 0: no cap)
//   agent-run wait   <id> [--timeout <seconds>]
//   agent-run status [<id>] [--active] [--json] [--limit <n>]
//   agent-run resume <id> --brief <file|-> [--deadline ..] [--budget-usd ..]
//   agent-run stop   <id>
//   agent-run note   <text>                  (inside a run: logs progress to the database)
//   agent-run usage                          (session and weekly usage levels)
//   agent-run report [--since 24h] [--ntfy]  (the digest: achievements, spend, failures, bottlenecks)
//   agent-run tick                           (agent-tick.timer: fills the free lead slots)
//   agent-run retro                          (agent-retro.timer: the daily read-only retro)
//   agent-run pause [<reason>] | unpause     (stop or restart the tick loop)
//   agent-run limit  [--leads <n>]           (how many lead runs may run at once; default 1)
//   agent-run push --title <t> [--urgent] <body...>
//   agent-run lesson --kind <k> [--minutes n] [--tokens n] <detail...>
//   agent-run lesson --close <id> <reason...>
//   agent-run experiment <text...>           (a row in ai-memory/experiments/background-lead.md)
//   agent-run prune  [--older-than-days 14]
//   agent-run supervise <id> | finish <id>   (run by the systemd unit itself)
//
// State lives in $AGENT_RUN_HOME (default ~/.local/state/agent-run): `runs.sqlite` holds every run
// and its events, and `<id>/` holds the brief, the raw stream-json events and stderr.

import { DatabaseSync } from "node:sqlite"
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.0.0"
import {
  exitProcess,
  type FileSystemPort,
  processArgs,
  processEnv,
  processStdin,
  runCommand,
  type RunCommandResult,
  runtimeFileSystem,
} from "@spy4x/platform/server"
import { uuidV7 } from "@spy4x/platform/universal/uuid"
import { openSqliteDb, type SqliteDb } from "@spy4x/server/db/sqlite"
import {
  claim,
  failAttempt,
  getMeta,
  itemOfRun,
  listMilestones,
  QUEUE_SCHEMA,
  queueItems,
  readDirection,
  readFocus,
  recheck,
  release,
  replan,
  replanReason,
  setItem,
  setMeta,
} from "./agent-queue.ts"
import { costOf, toCall } from "./session-cost.ts"

// ===== Types and constants =====

/** What a run may do. */
export enum Mode {
  Read = 1,
  Write = 2,
  Lead = 3,
}

const MODE_NAMES: Record<string, Mode> = { read: Mode.Read, write: Mode.Write, lead: Mode.Lead }

/**
 * At most this many lead runs at once unless `agent-run limit --leads <n>` stored another: one
 * while the experiment runs (owner, 2026-11-06).
 */
export const MAX_LEADS = 1
/** A parked run's continuation that `whyNot` refused this often is no longer tried. */
const MAX_REFUSALS = 2
/** Nesting stops here: a lead's run may start runs, theirs may not. */
export const MAX_DEPTH = 2
/** Refuse to start at these usage levels, as the `wave` skill does before a batch of agents. */
export const SESSION_STOP = 90
export const WEEKLY_STOP = 95
/** Variables a unit keeps; everything else the user manager holds is dropped. */
export const KEPT_ENV = [
  `PATH`,
  `HOME`,
  `USER`,
  `LANG`,
  `XDG_RUNTIME_DIR`,
  `DBUS_SESSION_BUS_ADDRESS`,
]
const MODELS = [`opus`, `haiku`]
const SELF = fromFileUrl(import.meta.url)
const DOTFILES = dirname(dirname(SELF))
/** The soft daily budget: no tick or retro starts once today's runs have spent it. */
export const DAILY_BUDGET_USD = 200
/** A run past this estimate sends one urgent push; it is never stopped for it. */
export const RUN_ALERT_USD = 100
/** Good-news pushes per local day; the rest wait for the digest. */
export const GOOD_PER_DAY = 3
/** A tick run's deadline, and how long its claim on a queue item holds. */
const TICK_DEADLINE_SEC = 3 * 3600
const LEASE_MS = (3 * 3600 + 15 * 60) * 1000
/** Open lessons a tick or retro brief carries, newest first. */
const BRIEF_LESSONS = 20
/** Run statuses that count as a failed attempt. */
const FAILED = [`failed`, `timeout`, `budget`, `turns`]
const INGEST_POLL_MS = 60_000
const USAGE_TIMEOUT_MS = 60_000
/** ntfy turns a longer message body into an attachment; the digest push stays within it. */
export const NTFY_MAX_BYTES = 4096
/** The longest run text one digest line quotes. */
const QUOTE_MAX = 300
/** `systemctl is-active` states of a unit that still exists. */
const ALIVE = [`active`, `activating`, `deactivating`, `reloading`, `refreshing`]

/** The schema every run's final answer must fill (`--json-schema`). */
export const RESULT_SCHEMA = {
  type: `object`,
  properties: {
    status: { type: `string`, enum: [`done`, `parked`, `blocked`, `failed`] },
    summary: { type: `string` },
    prs: { type: `array`, items: { type: `string` } },
    needs_owner: { type: [`string`, `null`] },
    injection: { type: [`string`, `null`] },
    noticed: { type: `array`, items: { type: `string` } },
    alert: { type: [`string`, `null`] },
    good_news: { type: [`string`, `null`] },
    handoff: { type: [`string`, `null`] },
  },
  required: [
    `status`,
    `summary`,
    `prs`,
    `needs_owner`,
    `injection`,
    `noticed`,
    `alert`,
    `good_news`,
    `handoff`,
  ],
}

/** One run as the database stores it. */
export interface Run {
  id: string
  name: string
  mode: Mode
  model: string
  effort: string
  cwd: string
  parent: string | null
  issue: string | null
  deadlineSec: number
  budgetUsd: number
  maxTurns: number
  allow: string[]
  startedAt: string
  endedAt: string | null
  status: string
  activity: string | null
  /** API-price estimate in millionths of a dollar. */
  costMicros: number | null
  turns: number | null
  result: RunResult | null
}

/** The run's structured answer, plus what the CLI's result event says. */
export interface RunResult {
  status?: string
  summary?: string
  prs?: string[]
  needs_owner?: string | null
  injection?: string | null
  noticed?: string[]
  alert?: string | null
  good_news?: string | null
  /** A parked run's full handoff (the `wave` skill, "The handoff") for the next run. */
  handoff?: string | null
  subtype?: string
}

/** Session and weekly usage in percent, as `claude -p /usage` prints them. */
export interface Usage {
  session: number
  weekly: number
  weeklyReset: string
}

/** Everything that touches the machine, injected so the tests run none of it. */
export interface Deps {
  run(command: string[], options?: { env?: Record<string, string>; signal?: AbortSignal }): Promise<
    RunCommandResult
  >
  fs: FileSystemPort
  env(name: string): string | undefined
  now(): Date
  fetch(url: string, init: RequestInit): Promise<Response>
  out(text: string): void
  home: string
  /**
   * The account tokens file (`~/sync/code/homelab/.env.accounts`); only its `NTFY_*` lines are
   * read. Tests point it elsewhere.
   */
  ntfyEnv: string
  /** The `ai-memory` checkout: `direction.md` and the experiment log. */
  memory: string
}

/** A command's outcome: what to print and the exit code. */
export interface Outcome {
  code: number
  output: string
}

const ok = (output: string): Outcome => ({ code: 0, output })
const refuse = (reason: string): Outcome => ({ code: 2, output: `refused: ${reason}` })

// ===== Pure parts =====

/** Seconds from `90`, `30m`, `2h` or `1d`. */
export function parseDuration(text: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(text)
  if (!match) throw new Error(`not a duration: ${text}`)
  const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]]!
  return Number(match[1]) * unit
}

/** Usage levels from the text `claude -p /usage` prints, or `null` when it has none. */
export function parseUsage(text: string): Usage | null {
  const session = /Current session: (\d+)% used/.exec(text)
  const weekly = /Current week \(all models\): (\d+)% used · resets ([^\n]+)/.exec(text)
  if (!session || !weekly) return null
  return { session: Number(session[1]), weekly: Number(weekly[1]), weeklyReset: weekly[2].trim() }
}

/** The `claude` arguments for a run; the brief comes on stdin. */
export function claudeArgs(run: Run, resume: boolean): string[] {
  const args = [
    `claude`,
    `-p`,
    `--output-format`,
    `stream-json`,
    `--verbose`,
    `--json-schema`,
    JSON.stringify(RESULT_SCHEMA),
    `--model`,
    run.model,
    `--effort`,
    run.effort,
    ...(run.maxTurns > 0 ? [`--max-turns`, String(run.maxTurns)] : []),
    ...(run.budgetUsd > 0 ? [`--max-budget-usd`, String(run.budgetUsd)] : []),
    `--name`,
    run.name,
    ...(resume ? [`--resume`, run.id] : [`--session-id`, run.id]),
  ]
  if (run.mode === Mode.Read) {
    args.push(`--permission-mode`, `dontAsk`, `--permission-prompts`, `none`)
    if (run.allow.length > 0) args.push(`--allowedTools`, ...run.allow)
    args.push(`--disallowedTools`, `Edit`, `Write`, `NotebookEdit`)
  } else {
    args.push(`--permission-mode`, `bypassPermissions`)
  }
  return args
}

/** The `systemd-run` command that starts a run's unit. */
export function unitCommand(run: Run, deps: Pick<Deps, `env` | `home`>): string[] {
  const kept = KEPT_ENV.flatMap((name) => {
    const value = deps.env(name)
    return value === undefined ? [] : [`${name}=${value}`]
  })
  const home = stateHome(deps)
  return [
    `systemd-run`,
    `--user`,
    `--unit=${unitName(run.id)}`,
    `--collect`,
    `--quiet`,
    `-p`,
    `RuntimeMaxSec=${run.deadlineSec}`,
    `-p`,
    `TasksMax=4000`,
    `-p`,
    `MemoryMax=8G`,
    `-p`,
    `WorkingDirectory=${run.cwd}`,
    `--setenv=PATH=${deps.env(`PATH`) ?? ``}`,
    `--setenv=AGENT_RUN_HOME=${home}`,
    `-p`,
    `ExecStopPost=/usr/bin/env deno run -A ${SELF} finish ${run.id}`,
    `/usr/bin/env`,
    `-i`,
    ...kept,
    `AGENT_RUN_ID=${run.id}`,
    `AGENT_RUN_HOME=${home}`,
    `deno`,
    `run`,
    `-A`,
    SELF,
    `supervise`,
    run.id,
  ]
}

/** What a run did, read from its stream-json lines: tool calls, its last words, its result. */
export function readEvents(lines: string[]): {
  tools: string[]
  activity: string | null
  result: Record<string, unknown> | null
} {
  const tools: string[] = []
  let activity: string | null = null
  let result: Record<string, unknown> | null = null
  for (const line of lines) {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === `result`) result = event
    if (event.type !== `assistant`) continue
    const content = (event.message as { content?: Record<string, unknown>[] })?.content ?? []
    for (const item of content) {
      if (item.type === `text` && typeof item.text === `string` && item.text.trim()) {
        activity = item.text.trim().slice(0, 300)
      }
      if (item.type === `tool_use`) {
        // The tool's own description, never its command: a command can carry a secret.
        const input = (item.input ?? {}) as Record<string, unknown>
        const what = input.description ?? input.subagent_type ?? input.skill ?? input.file_path ??
          ``
        tools.push(`${item.name}${what ? `: ${String(what).slice(0, 160)}` : ``}`)
      }
    }
  }
  return { tools, activity, result }
}

/** The run's final status from systemd's result, the CLI's result event and the run's answer. */
export function finalStatus(
  serviceResult: string | undefined,
  result: Record<string, unknown> | null,
  stoppedFor: string | null,
): string {
  if (stoppedFor) return stoppedFor
  if (serviceResult === `timeout`) return `timeout`
  if (!result) return `failed`
  if (result.subtype === `error_max_budget_usd`) return `budget`
  if (result.subtype === `error_max_turns`) return `turns`
  const answer = result.structured_output as RunResult | undefined
  if (result.subtype === `success` && answer?.status) return answer.status
  return `failed`
}

/** A push to send: its kind in the `pushes` table, title and body. */
export interface Push {
  kind: `urgent` | `good`
  title: string
  body: string
}

/** The lines every run push carries: issue, PRs, cost, how to step in. */
function runLines(run: Run): string[] {
  return [
    ...(run.issue ? [`Issue: ${run.issue}`] : []),
    ...(run.result?.prs ?? []).map((pr) => `PR: ${pr}`),
    `Cost: ${dollars(run.costMicros)}`,
    `Step in: claude --resume ${run.id}`,
  ]
}

/**
 * The pushes an ended run's own answer asks for: urgent for `alert` and for an injection report
 * (which names only the run, never the injected text), good news for `good_news`. Model text goes
 * through `notify`, which scans it for secrets before it is sent.
 */
export function answerPushes(run: Run): Push[] {
  const pushes: Push[] = []
  const { alert, injection, good_news: good } = run.result ?? {}
  if (alert) {
    pushes.push({
      kind: `urgent`,
      title: `${run.name}: alert`,
      body: [alert, ...runLines(run)].join(`\n`),
    })
  }
  if (injection) {
    pushes.push({
      kind: `urgent`,
      title: `${run.name}: injection reported`,
      body: [`Read it on the machine: agent-run status ${run.id}`, ...runLines(run)].join(`\n`),
    })
  }
  if (good) {
    pushes.push({
      kind: `good`,
      title: `${run.name}: good news`,
      body: [good, ...runLines(run)].join(`\n`),
    })
  }
  return pushes
}

/** What the digest reports, read from the database by `report`. */
export interface Digest {
  since: Date
  runs: Run[]
  notes: Map<string, string[]>
  done: { issue: string; title: string; prs: string[] }[]
  blocked: { issue: string; reason: string | null; runId: string | null }[]
  lessons: {
    kind: string
    minutes: number | null
    tokens: number | null
    detail: string
    runId: string | null
  }[]
  slow: { tool: string; summary: string; sec: number }[]
  todayMicros: number
  paused: string | null
}

/**
 * Text a run (or any agent) wrote, marked as its words and not the digest's: on one line, cut to
 * `QUOTE_MAX` characters, in quotes, after the run id when there is one. A newline or quote in it
 * cannot start a fake line.
 */
function quoted(id: string | null, text: string): string {
  const line = text.replace(/\s+/g, ` `).trim()
  const short = line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 1)}…` : line
  return id ? `run ${id} wrote ${JSON.stringify(short)}` : JSON.stringify(short)
}

/** The goal metric, named and scaled as on the runs dashboard: merged issues per $100 spent. */
export function goalText(span: string, merged: number, micros: number): string {
  const value = merged === 0 || micros <= 0 ? `–` : (merged / (micros / 1e6) * 100).toFixed(1)
  return `Merged issues per $100, ${span}: ${value} (${merged} merged for ${dollars(micros)})`
}

/**
 * The digest: achievements first, then spend against the daily budget and the goal metric,
 * failures, bottlenecks, whether the loop is paused, and each run of the window with its notes.
 * What a run wrote is quoted with its id (see `quoted`).
 */
export function digestText(d: Digest): string {
  const windowMicros = d.runs.reduce((sum, run) => sum + (run.costMicros ?? 0), 0)
  const good = d.runs.flatMap((run) =>
    run.result?.good_news ? [quoted(run.id, run.result.good_news)] : []
  )
  const failed = d.runs.filter((run) => FAILED.includes(run.status))
  const out = [`Since ${d.since.toISOString()}:`, ``, `Achievements`]
  for (const item of d.done) {
    out.push(`- ${item.issue} ${item.title}`, ...item.prs.map((pr) => `  ${pr}`))
  }
  out.push(...good.map((text) => `- ${text}`))
  if (d.done.length === 0 && good.length === 0) out.push(`- none`)
  out.push(
    ``,
    `Spend: ${dollars(d.todayMicros)} today of $${DAILY_BUDGET_USD}, ${
      dollars(windowMicros)
    } in the window, at API prices.`,
    goalText(`this window`, d.done.length, windowMicros),
  )
  if (failed.length > 0 || d.blocked.length > 0) {
    out.push(``, `Failures`)
    for (const run of failed) {
      const what = [run.name, run.issue, run.status].filter(Boolean).join(` `)
      out.push(`- ${what}: ${run.result?.summary ? quoted(run.id, run.result.summary) : run.id}`)
    }
    for (const item of d.blocked) {
      out.push(
        `- blocked ${item.issue}: ${item.reason ? quoted(item.runId, item.reason) : `no reason`}`,
      )
    }
  }
  if (d.lessons.length > 0 || d.slow.length > 0) {
    out.push(``, `Bottlenecks`)
    for (const lesson of d.lessons) {
      const cost = [
        lesson.minutes === null ? null : `${lesson.minutes} min`,
        lesson.tokens === null ? null : `${lesson.tokens} tokens`,
      ].filter(Boolean).join(`, `)
      out.push(
        `- ${lesson.kind}${cost ? ` (${cost})` : ``}: ${quoted(lesson.runId, lesson.detail)}`,
      )
    }
    for (const step of d.slow) {
      out.push(
        `- slow ${step.tool} ${step.sec}s${step.summary ? `: ${quoted(null, step.summary)}` : ``}`,
      )
    }
  }
  out.push(``, d.paused ? `The loop is paused: ${quoted(null, d.paused)}` : `The loop is running.`)
  if (d.runs.length > 0) out.push(``, `Runs`)
  for (const run of d.runs) {
    out.push(
      `- ${
        [run.name, `(${run.status})`, run.issue, dollars(run.costMicros)].filter(Boolean).join(` `)
      }`,
    )
    const said = (label: string, text: string | null | undefined) => {
      if (text) out.push(`  ${label}${quoted(run.id, text)}`)
    }
    said(``, run.result?.summary)
    for (const pr of run.result?.prs ?? []) out.push(`  PR: ${pr}`)
    for (const note of d.notes.get(run.id) ?? []) said(`Note: `, note)
    said(`Needs you: `, run.result?.needs_owner)
    said(`Injection reported: `, run.result?.injection)
    if (run.status === `running`) said(`Now: `, run.activity)
  }
  return out.join(`\n`)
}

/**
 * `text` cut to `maxBytes` of UTF-8 for a push: whole `- ` items (each with its indented lines)
 * go from the end, and a last line says how many went and that `command` shows them all.
 */
export function fitPush(text: string, maxBytes: number, command: string): string {
  const size = (s: string) => new TextEncoder().encode(s).length
  if (size(text) <= maxBytes) return text
  const blocks: string[][] = []
  for (const line of text.split(`\n`)) {
    if (line.startsWith(`  `) && blocks.at(-1)?.[0].startsWith(`- `)) blocks.at(-1)!.push(line)
    else blocks.push([line])
  }
  let left = 0
  const fitted = () =>
    `${blocks.map((block) => block.join(`\n`)).join(`\n`)}\n\n` +
    `${left} items left out. All of them: ${command}`
  while (size(fitted()) > maxBytes) {
    const last = blocks.findLastIndex((block) => block[0].startsWith(`- `))
    if (last === -1) break
    blocks.splice(last, 1)
    left++
  }
  let out = fitted()
  // Only headers are left and still too long: cut characters off the end.
  while (size(out) > maxBytes) out = out.slice(0, -1)
  return out
}

/** A run's cost so far from its stream-json lines: each API call once, at API list prices. */
export function estimateUsd(lines: string[]): number {
  const calls = new Map<string, ReturnType<typeof toCall>>()
  for (const line of lines) {
    if (!line.includes(`"assistant"`)) continue
    try {
      const event = JSON.parse(line)
      const message = event.message
      if (event.type !== `assistant` || typeof message?.id !== `string` || !message.usage) continue
      calls.set(message.id, toCall(``, String(message.model ?? ``), message.usage))
    } catch {
      continue
    }
  }
  return [...calls.values()].reduce((sum, call) => {
    const { cost } = costOf(call)
    return sum + cost.cacheRead + cost.cacheWrite + cost.output + cost.input
  }, 0)
}

/** The local calendar day around `now`, as ISO bounds. */
export function localDay(now: Date): { start: string; end: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

/** `YYYY-MM-DD HH:MM` in local time. */
function localStamp(now: Date): string {
  const two = (n: number) => String(n).padStart(2, `0`)
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
    `${two(now.getHours())}:${two(now.getMinutes())}`
}

function dollars(micros: number | null): string {
  return micros === null ? `$?` : `$${(micros / 1e6).toFixed(2)}`
}

function unitName(id: string): string {
  return `agent-run-${id}.service`
}

function stateHome(deps: Pick<Deps, `env` | `home`>): string {
  return deps.env(`AGENT_RUN_HOME`) ?? join(deps.home, `.local`, `state`, `agent-run`)
}

// ===== Database =====

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode INTEGER NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  cwd TEXT NOT NULL,
  parent TEXT,
  issue TEXT,
  deadline_sec INTEGER NOT NULL,
  budget_usd REAL NOT NULL,
  max_turns INTEGER NOT NULL,
  allow TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  activity TEXT,
  cost_micros INTEGER,
  turns INTEGER,
  result TEXT,
  events_offset INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, at);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  minutes REAL,
  tokens INTEGER,
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  closed_reason TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS pushes (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  run_id TEXT
) STRICT;
${QUEUE_SCHEMA}`

/**
 * Open the run database under the state home, creating it and its schema. A database from before
 * the weekly share was removed loses its `weekly_*` columns and keeps its rows; a queue from before
 * handoffs gains its `handoff` column.
 */
export async function openDb(deps: Deps): Promise<SqliteDb> {
  const home = stateHome(deps)
  await deps.fs.mkdirp(home)
  await deps.run([`chmod`, `700`, home])
  const db = await openSqliteDb({
    path: join(home, `runs.sqlite`),
    createDriver: ({ path }) => new DatabaseSync(path),
    createDirectory: () => {},
  })
  await db.exec(`PRAGMA busy_timeout = 10000`)
  await db.exec(`PRAGMA journal_mode = WAL`)
  await db.exec(SCHEMA)
  for (const column of await db.queryAll(`PRAGMA table_info(runs)`)) {
    const name = String(column.name)
    if (name.startsWith(`weekly_`)) await db.exec(`ALTER TABLE runs DROP COLUMN ${name}`)
  }
  const queue = await db.queryAll(`PRAGMA table_info(queue)`)
  if (!queue.some((column) => column.name === `handoff`)) {
    await db.exec(`ALTER TABLE queue ADD COLUMN handoff TEXT`)
  }
  return db
}

function rowToRun(row: Record<string, unknown>): Run {
  return {
    id: row.id as string,
    name: row.name as string,
    mode: Number(row.mode) as Mode,
    model: row.model as string,
    effort: row.effort as string,
    cwd: row.cwd as string,
    parent: (row.parent as string | null) ?? null,
    issue: (row.issue as string | null) ?? null,
    deadlineSec: Number(row.deadline_sec),
    budgetUsd: Number(row.budget_usd),
    maxTurns: Number(row.max_turns),
    allow: JSON.parse(row.allow as string),
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string | null) ?? null,
    status: row.status as string,
    activity: (row.activity as string | null) ?? null,
    costMicros: row.cost_micros === null ? null : Number(row.cost_micros),
    turns: row.turns === null ? null : Number(row.turns),
    result: row.result ? JSON.parse(row.result as string) : null,
  }
}

async function getRun(db: SqliteDb, id: string): Promise<Run | null> {
  const row = await db.queryOne(`SELECT * FROM runs WHERE id = ?`, id)
  return row ? rowToRun(row) : null
}

/**
 * The runs still going. A row marked running whose unit is gone (it died before `finish` ran) is
 * closed here as stopped or failed and its queue item settled, so it never blocks later starts
 * nor holds its item until the lease runs out.
 */
async function activeRuns(db: SqliteDb, deps: Deps): Promise<Run[]> {
  const rows = await db.queryAll(`SELECT * FROM runs WHERE status = 'running' ORDER BY started_at`)
  const active: Run[] = []
  for (const run of rows.map(rowToRun)) {
    const state = (await deps.run([`systemctl`, `--user`, `is-active`, unitName(run.id)])).stdout
      .trim()
    // No answer means systemd could not be asked, and a row a minute old may still be starting
    // its unit: keep both rather than guess.
    const young = deps.now().getTime() - Date.parse(run.startedAt) < 60_000
    if (state === `` || young || ALIVE.includes(state)) {
      active.push(run)
      continue
    }
    const stopped = await db.queryOne(
      `SELECT 1 FROM events WHERE run_id = ? AND kind = 'stop'`,
      run.id,
    )
    const status = stopped ? `stopped` : `failed`
    await db.execute(
      `UPDATE runs SET status = ?, ended_at = ? WHERE id = ? AND status = 'running'`,
      status,
      deps.now().toISOString(),
      run.id,
    )
    await addEvent(db, deps, run.id, `end`, `${status} (unit ${state} without finish)`)
    await settleItem(db, deps, { ...run, status })
  }
  return active
}

/**
 * SQL that holds while a run of mode `?` (first parameter) may take a lead slot: it is no lead, or
 * fewer than `?` (third) leads other than run `?` (second) are running.
 */
const LEAD_ROOM = `(? != ${Mode.Lead} OR (SELECT COUNT(*) FROM runs
  WHERE status = 'running' AND mode = ${Mode.Lead} AND id IS NOT ?) < ?)`

/** Insert `run` when `LEAD_ROOM` holds; returns whether it did. */
async function insertRun(
  db: SqliteDb,
  run: Run,
  exclude: string | null,
  maxLeads: number,
): Promise<boolean> {
  const { changes } = await db.execute(
    `INSERT INTO runs (id, name, mode, model, effort, cwd, parent, issue, deadline_sec, budget_usd,
      max_turns, allow, started_at, status)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${LEAD_ROOM}`,
    run.id,
    run.name,
    run.mode,
    run.model,
    run.effort,
    run.cwd,
    run.parent,
    run.issue,
    run.deadlineSec,
    run.budgetUsd,
    run.maxTurns,
    JSON.stringify(run.allow),
    run.startedAt,
    run.status,
    run.mode,
    exclude,
    maxLeads,
  )
  return Number(changes) === 1
}

async function addEvent(db: SqliteDb, deps: Deps, id: string, kind: string, detail: string) {
  await db.execute(
    `INSERT INTO events (run_id, at, kind, detail) VALUES (?, ?, ?, ?)`,
    id,
    deps.now().toISOString(),
    kind,
    detail,
  )
}

// ===== Commands =====

/** Flags that never take a value, so a word after them is not swallowed. */
const BARE = [`active`, `json`, `ntfy`, `urgent`]

/** Flags after the subcommand: `--name value`, repeatable ones collected, bare ones `true`. */
export function parseFlags(args: string[]): { flags: Map<string, string[]>; rest: string[] } {
  const flags = new Map<string, string[]>()
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith(`--`)) {
      rest.push(arg)
      continue
    }
    const next = args[i + 1]
    const bare = BARE.includes(arg.slice(2)) || next === undefined || next.startsWith(`--`)
    const value = bare ? `true` : (i++, next)
    flags.set(arg.slice(2), [...(flags.get(arg.slice(2)) ?? []), value])
  }
  return { flags, rest }
}

async function readUsage(deps: Deps): Promise<Usage | null> {
  const out = await deps.run([`claude`, `-p`, `/usage`, `--no-session-persistence`], {
    signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
  })
  return out.success ? parseUsage(out.stdout) : null
}

async function readBrief(deps: Deps, source: string | undefined): Promise<string | null> {
  if (source === undefined) return null
  if (source === `-`) return await processStdin.text()
  return await deps.fs.readText(source)
}

/**
 * Why `run` may not start now, or `null`. Checks only what the database and GitHub can tell.
 * No two writing runs share a `cwd`, except two leads: a lead writes only in worktrees of its own.
 */
export async function whyNot(
  run: Run,
  active: Run[],
  deps: Deps,
  handoffFrom: string | null,
  maxLeads = MAX_LEADS,
): Promise<string | null> {
  if (!MODELS.includes(run.model)) return `--model must be one of ${MODELS.join(`, `)}`
  const others = active.filter((other) => other.id !== handoffFrom)
  if (run.mode === Mode.Lead && others.filter((o) => o.mode === Mode.Lead).length >= maxLeads) {
    return `${maxLeads} lead run(s) already active`
  }
  if (run.mode === Mode.Write) {
    // A linked worktree's `.git` is a file; reading a main checkout's `.git` directory fails.
    const git = await deps.fs.readText(join(run.cwd, `.git`)).catch(() => null)
    if (git === null || !git.startsWith(`gitdir:`)) return `write mode needs a linked worktree`
  }
  const writers = others.filter((o) => o.mode === Mode.Write || run.mode === Mode.Write)
  if (run.mode !== Mode.Read && writers.some((o) => o.mode !== Mode.Read && o.cwd === run.cwd)) {
    return `another writing run holds ${run.cwd}`
  }
  if (run.issue && others.some((o) => o.issue === run.issue)) {
    return `another run works on ${run.issue}`
  }
  let depth = 0
  for (let parent = run.parent; parent; depth++) {
    parent = active.find((o) => o.id === parent)?.parent ?? null
  }
  if (depth >= MAX_DEPTH) return `runs nest ${MAX_DEPTH} levels deep at most`
  if (run.issue) {
    const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(run.issue)
    if (!match) return `--issue must look like owner/repo#123`
    const author = await deps.run([
      `gh`,
      `api`,
      `repos/${match[1]}/issues/${match[2]}`,
      `--jq`,
      `.user.login`,
    ])
    if (author.stdout.trim() !== `spy4x`) return `${run.issue} is not by spy4x`
  }
  return null
}

async function startRun(deps: Deps, flags: Map<string, string[]>): Promise<Outcome> {
  const one = (name: string) => flags.get(name)?.at(-1)
  const db = await openDb(deps)
  try {
    const handoffFrom = one(`handoff-from`) ?? null
    const from = handoffFrom ? await getRun(db, handoffFrom) : null
    if (handoffFrom && !from) return refuse(`no run ${handoffFrom}`)
    const brief = await readBrief(deps, one(`brief`))
    if (!brief?.trim()) return refuse(`--brief is required and must not be empty`)
    const mode = from?.mode ?? MODE_NAMES[one(`mode`) ?? ``]
    const model = from?.model ?? one(`model`)
    const cwd = from?.cwd ?? one(`cwd`)
    if (!mode || !model || !cwd) return refuse(`--mode, --model and --cwd are required`)
    const run: Run = {
      id: uuidV7(),
      name: one(`name`) ?? from?.name ?? `run`,
      mode,
      model,
      effort: one(`effort`) ?? from?.effort ?? `medium`,
      cwd,
      parent: from ? from.parent : deps.env(`AGENT_RUN_ID`) ?? null,
      issue: one(`issue`) ?? null,
      deadlineSec: one(`deadline`) ? parseDuration(one(`deadline`)!) : from?.deadlineSec ?? 7200,
      budgetUsd: Number(one(`budget-usd`) ?? from?.budgetUsd ?? 20),
      maxTurns: Number(one(`max-turns`) ?? from?.maxTurns ?? 300),
      allow: flags.get(`allow`) ?? from?.allow ?? [],
      startedAt: deps.now().toISOString(),
      endedAt: null,
      status: `running`,
      activity: null,
      costMicros: null,
      turns: null,
      result: null,
    }
    const why = await checkStart(db, deps, run, handoffFrom)
    if (why) return refuse(why)
    return await launch(db, deps, run, brief, false, handoffFrom, await leadLimit(db))
  } finally {
    await db.close()
  }
}

/** Why the account's usage forbids a start now, or `null`; an unreadable usage does not. */
async function usageStop(deps: Deps): Promise<string | null> {
  const usage = await readUsage(deps)
  if (usage && usage.session >= SESSION_STOP) return `session usage at ${usage.session}%`
  if (usage && usage.weekly >= WEEKLY_STOP) return `weekly usage at ${usage.weekly}%`
  return null
}

/**
 * Why `run` may not start or resume now, or `null`: the limits of `whyNot` plus the usage stops.
 * `exclude` is a run that ends as this one starts (a handoff's source, or the resumed run itself).
 */
async function checkStart(
  db: SqliteDb,
  deps: Deps,
  run: Run,
  exclude: string | null,
): Promise<string | null> {
  const active = await activeRuns(db, deps)
  return await whyNot(run, active, deps, exclude, await leadLimit(db)) ?? await usageStop(deps)
}

/**
 * How many lead runs may run at once: the stored `agent-run limit --leads`, else `MAX_LEADS`. A
 * stored value that is no whole number from 1 counts as unset.
 */
async function leadLimit(db: SqliteDb): Promise<number> {
  const stored = await getMeta(db, `max_leads`)
  return stored && /^[1-9]\d*$/.test(stored) ? Number(stored) : MAX_LEADS
}

/** `agent-run limit [--leads <n>]`: store a new lead limit when given, then print the limit. */
async function limitCommand(deps: Deps, flags: Map<string, string[]>): Promise<Outcome> {
  const db = await openDb(deps)
  try {
    const leads = flags.get(`leads`)?.at(-1)
    if (leads !== undefined) {
      if (!/^[1-9]\d*$/.test(leads)) return refuse(`--leads must be a whole number from 1`)
      await setMeta(db, `max_leads`, leads)
    }
    return ok(`leads: ${await leadLimit(db)}`)
  } finally {
    await db.close()
  }
}

/**
 * Insert `run` (or reopen it, resuming) and start its unit. A lead gets in only while fewer than
 * `maxLeads` leads other than `exclude` are running. That count and the write are one SQL
 * statement, and SQLite takes its write lock before such a statement reads, so two ticks or starts
 * at once never both take the last slot; a lost race is refused with code 2. A failed
 * `systemd-run` ends the run `failed`, gives its claimed queue item back and counts toward the
 * pause after two failed tick runs.
 */
async function launch(
  db: SqliteDb,
  deps: Deps,
  run: Run,
  brief: string,
  resume: boolean,
  exclude: string | null,
  maxLeads: number,
): Promise<Outcome> {
  const room = resume
    ? Number(
      (await db.execute(
        `UPDATE runs SET status = 'running', ended_at = NULL WHERE id = ? AND ${LEAD_ROOM}`,
        run.id,
        run.mode,
        exclude,
        maxLeads,
      )).changes,
    ) === 1
    : await insertRun(db, run, exclude, maxLeads)
  if (!room) return refuse(`${maxLeads} lead run(s) already active`)
  const dir = join(stateHome(deps), run.id)
  await deps.fs.mkdirp(dir)
  await deps.run([`chmod`, `700`, stateHome(deps), dir])
  await deps.fs.writeText(join(dir, `prompt.md`), brief, { mode: 0o600 })
  await deps.fs.appendText(join(dir, `brief.md`), `${brief}\n\n---\n\n`)
  await addEvent(db, deps, run.id, resume ? `resume` : `start`, brief.slice(0, 300))
  const started = await deps.run(unitCommand(run, deps))
  if (!started.success) {
    await db.execute(
      `UPDATE runs SET status = 'failed', ended_at = ? WHERE id = ?`,
      deps.now().toISOString(),
      run.id,
    )
    await addEvent(db, deps, run.id, `error`, started.stderr.slice(0, 500))
    await release(db, deps, run.id)
    if (run.name === `tick`) await pauseOnTwoFailures(db, deps, (await getRun(db, run.id))!)
    return { code: 1, output: `systemd-run failed: ${started.stderr}` }
  }
  return ok(JSON.stringify({ id: run.id, unit: unitName(run.id) }))
}

async function resumeRun(deps: Deps, id: string, flags: Map<string, string[]>): Promise<Outcome> {
  const one = (name: string) => flags.get(name)?.at(-1)
  const db = await openDb(deps)
  try {
    const run = await getRun(db, id)
    if (!run) return refuse(`no run ${id}`)
    if ((await activeRuns(db, deps)).some((o) => o.id === id)) {
      return refuse(`run ${id} is still active`)
    }
    const brief = await readBrief(deps, one(`brief`))
    if (!brief?.trim()) return refuse(`--brief is required and must not be empty`)
    run.deadlineSec = parseDuration(one(`deadline`) ?? `2h`)
    run.budgetUsd = Number(one(`budget-usd`) ?? run.budgetUsd)
    const why = await checkStart(db, deps, run, id)
    if (why) return refuse(why)
    await db.execute(
      `UPDATE runs SET deadline_sec = ?, budget_usd = ? WHERE id = ?`,
      run.deadlineSec,
      run.budgetUsd,
      id,
    )
    return await launch(db, deps, run, brief, true, id, await leadLimit(db))
  } finally {
    await db.close()
  }
}

/** Copy new stream-json lines into the database: tool calls as events, the last words as activity. */
async function ingest(db: SqliteDb, deps: Deps, id: string): Promise<void> {
  const row = await db.queryOne(`SELECT events_offset FROM runs WHERE id = ?`, id)
  const offset = Number(row?.events_offset ?? 0)
  const text = await deps.fs.readText(join(stateHome(deps), id, `events.jsonl`)) ?? ``
  const end = text.lastIndexOf(`\n`) + 1
  if (end <= offset) return
  const { tools, activity } = readEvents(text.slice(offset, end).split(`\n`))
  for (const tool of tools) await addEvent(db, deps, id, `tool`, tool)
  if (activity) await db.execute(`UPDATE runs SET activity = ? WHERE id = ?`, activity, id)
  await db.execute(`UPDATE runs SET events_offset = ? WHERE id = ?`, end, id)
}

/** The unit's main process: runs `claude`, logs its events, warns once past `RUN_ALERT_USD`. */
async function supervise(deps: Deps, id: string): Promise<Outcome> {
  const db = await openDb(deps)
  const run = await getRun(db, id)
  if (!run) return { code: 1, output: `no run ${id}` }
  const dir = join(stateHome(deps), id)
  const resumed = await db.queryOne(`SELECT 1 FROM events WHERE run_id = ? AND kind = 'resume'`, id)
  const shell = `exec "$@" < "$PROMPT" >> "$EVENTS" 2>> "$ERRORS"`
  const child = deps.run([`sh`, `-c`, shell, `sh`, ...claudeArgs(run, resumed !== undefined)], {
    env: {
      PROMPT: join(dir, `prompt.md`),
      EVENTS: join(dir, `events.jsonl`),
      ERRORS: join(dir, `stderr.log`),
    },
  })
  let done = false
  const watch = (async () => {
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, INGEST_POLL_MS))
      if (done) break
      await watchOnce(db, deps, run)
    }
  })()
  const outcome = await child
  done = true
  await watch.catch(() => {})
  await db.close()
  return { code: outcome.code < 0 ? 1 : outcome.code, output: `` }
}

/** One minute of supervision: new events into the database, then the cost estimate. */
export async function watchOnce(db: SqliteDb, deps: Deps, run: Run): Promise<void> {
  await ingest(db, deps, run.id)
  const text = await deps.fs.readText(join(stateHome(deps), run.id, `events.jsonl`)) ?? ``
  await warnOver(db, deps, run, estimateUsd(text.split(`\n`)), `estimate`)
}

/** One urgent push the first time a run's cost passes `RUN_ALERT_USD`; the run goes on. */
async function warnOver(db: SqliteDb, deps: Deps, run: Run, usd: number, basis: string) {
  if (usd <= RUN_ALERT_USD) return
  if (await db.queryOne(`SELECT 1 FROM events WHERE run_id = ? AND kind = 'over100'`, run.id)) {
    return
  }
  await addEvent(db, deps, run.id, `over100`, `$${usd.toFixed(2)} (${basis})`)
  await sendPush(db, deps, {
    kind: `urgent`,
    title: `${run.name}: over $${RUN_ALERT_USD}`,
    body: [`$${usd.toFixed(2)} so far (${basis}); the run goes on.`, ...runLines(run)].join(`\n`),
  }, run.id)
}

/** Send one push and record it in `pushes`; good news past `GOOD_PER_DAY` waits for the digest. */
async function sendPush(db: SqliteDb, deps: Deps, push: Push, runId: string | null) {
  if (push.kind === `good`) {
    const { start, end } = localDay(deps.now())
    const sent = await db.queryOne(
      `SELECT COUNT(*) AS n FROM pushes WHERE kind = 'good' AND at >= ? AND at < ?`,
      start,
      end,
    )
    if (Number(sent?.n ?? 0) >= GOOD_PER_DAY) {
      return deps.out(`good news held for the digest: ${push.title}`)
    }
  }
  const priority = push.kind === `urgent` ? `urgent` : `default`
  if (!await notify(deps, push.title, push.body, priority)) return
  await db.execute(
    `INSERT INTO pushes (id, at, kind, title, run_id) VALUES (?, ?, ?, ?, ?)`,
    uuidV7(),
    deps.now().toISOString(),
    push.kind,
    push.title,
    runId,
  )
}

/** Run by `ExecStopPost`: final status, result and cost, the queue item, and the pushes. */
async function finish(deps: Deps, id: string): Promise<Outcome> {
  const db = await openDb(deps)
  try {
    const run = await getRun(db, id)
    if (!run) return { code: 1, output: `no run ${id}` }
    await ingest(db, deps, id).catch(() => {})
    const text = await deps.fs.readText(join(stateHome(deps), id, `events.jsonl`)) ?? ``
    const lines = text.split(`\n`)
    const { result } = readEvents(lines)
    const stopped = await db.queryOne(`SELECT 1 FROM events WHERE run_id = ? AND kind = 'stop'`, id)
    const status = finalStatus(deps.env(`SERVICE_RESULT`), result, stopped ? `stopped` : null)
    const answer: RunResult = {
      ...(result?.structured_output as RunResult | undefined),
      subtype: result?.subtype as string | undefined,
    }
    await db.execute(
      `UPDATE runs SET status = ?, ended_at = ?, cost_micros = ?, turns = ?, result = ?
        WHERE id = ?`,
      status,
      deps.now().toISOString(),
      // No `result` (a timeout, crash or stop): the estimate keeps the run in the day's budget.
      Math.round((result ? Number(result.total_cost_usd ?? 0) : estimateUsd(lines)) * 1e6) || null,
      result ? Number(result.num_turns ?? 0) : null,
      JSON.stringify(answer),
      id,
    )
    await addEvent(db, deps, id, `end`, `${status} (${deps.env(`SERVICE_RESULT`) ?? `?`})`)
    const ended = (await getRun(db, id))!
    const item = await settleItem(db, deps, ended)
    await warnOver(db, deps, ended, (ended.costMicros ?? 0) / 1e6, `final`)
    for (const push of answerPushes(ended)) await sendPush(db, deps, push, id)
    if (ended.name === `tick` && FAILED.includes(status)) await pauseOnTwoFailures(db, deps, ended)
    if (item?.source.startsWith(`milestone:`) && status === `done`) {
      await milestoneNews(db, deps, ended, item.issue, item.source.slice(`milestone:`.length))
    }
    return ok(status)
  } finally {
    await db.close()
  }
}

/** Move the queue item an ended run claimed on by the run's status; returns the item. */
async function settleItem(db: SqliteDb, deps: Deps, run: Run) {
  const item = await itemOfRun(db, run.id)
  if (!item || item.status !== `claimed`) return item
  const summary = run.result?.summary ?? null
  // The item keeps its last handoff unless this run wrote one; only `done` clears it.
  const handoff = run.result?.handoff || undefined
  if (run.status === `done`) {
    await setItem(db, deps, item.issue, { status: `done`, reason: summary, handoff: null })
  } else if (run.status === `parked`) {
    await setItem(db, deps, item.issue, { status: `queued`, reason: summary, rank: 0, handoff })
  } else if (run.status === `blocked`) {
    const reason = run.result?.needs_owner ?? summary
    await setItem(db, deps, item.issue, { status: `blocked`, reason, handoff })
  } else if (run.status === `stopped`) {
    await setItem(db, deps, item.issue, { status: `queued`, reason: `stopped`, handoff })
  } else await failAttempt(db, deps, item, `${run.status}: ${summary ?? `no answer`}`, handoff)
  return item
}

/** Two failed tick runs in a row pause the loop and push why, once. */
async function pauseOnTwoFailures(db: SqliteDb, deps: Deps, run: Run) {
  const last = await db.queryAll(
    `SELECT status FROM runs WHERE name = 'tick' AND status != 'running'
      ORDER BY started_at DESC LIMIT 2`,
  )
  if (last.length < 2 || !last.every((row) => FAILED.includes(String(row.status)))) return
  if (await getMeta(db, `paused`)) return
  const reason = `two tick runs failed in a row, the last ${run.id}`
  await setMeta(db, `paused`, reason)
  await sendPush(db, deps, {
    kind: `urgent`,
    title: `Background lead paused`,
    body: [reason, `Unpause: agent-run unpause`, ...runLines(run)].join(`\n`),
  }, run.id)
}

/** Good news when the milestone a done item belonged to has no open issue left. */
async function milestoneNews(db: SqliteDb, deps: Deps, run: Run, issue: string, title: string) {
  const repo = issue.split(`#`)[0]
  const all = await listMilestones(deps, repo, `all`).catch(() => [])
  const milestone = all.find((m) => m.title === title)
  if (!milestone || milestone.open_issues > 0) return
  await sendPush(db, deps, {
    kind: `good`,
    title: `Milestone done: ${title}`,
    body: [`${repo} milestone "${title}" has no open issue left.`, ...runLines(run)].join(`\n`),
  }, run.id)
}

/** Whether `gitleaks` finds no secret in `text`. A scan that cannot run counts as a finding. */
async function scanClean(deps: Deps, text: string): Promise<boolean> {
  const file = join(stateHome(deps), `push-${uuidV7()}.txt`)
  await deps.fs.writeText(file, text, { mode: 0o600 })
  try {
    const scan = await deps.run(
      [`gitleaks`, `detect`, `--no-git`, `--no-banner`, `--exit-code`, `1`, `--source`, file],
      { signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) },
    )
    return scan.success
  } finally {
    await deps.fs.remove(file)
  }
}

/** A header-safe title: non-ASCII text as an RFC 2047 encoded word, which ntfy decodes. */
export function headerText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text
  const bytes = new TextEncoder().encode(text.replace(/[\r\n]+/g, ` `))
  return `=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`
}

/**
 * One NTFY push with `NTFY_URL`, `NTFY_TOPIC` and `NTFY_TOKEN` from the account tokens file;
 * whether it was sent. No other key of that file is kept. Fails open: a missing setting or a
 * failed push is printed, never retried.
 */
async function notify(deps: Deps, title: string, body: string, priority: string) {
  const env = await deps.fs.readText(deps.ntfyEnv) ?? ``
  const value = (name: string) => new RegExp(`^${name}=(.*)$`, `m`).exec(env)?.[1]?.trim()
  const url = value(`NTFY_URL`)
  const topic = value(`NTFY_TOPIC`)
  if (!url || !topic) {
    deps.out(`no NTFY_URL or NTFY_TOPIC; push skipped`)
    return false
  }
  const token = value(`NTFY_TOKEN`)
  if (!await scanClean(deps, `${title}\n${body}`)) {
    title = `Push held back`
    body = `The text was held back: the secret scan flagged it or could not run. ` +
      `Read it on the machine with agent-run status or agent-run report.`
  }
  try {
    const response = await deps.fetch(`${url.replace(/\/$/, ``)}/${topic}`, {
      method: `POST`,
      body,
      headers: {
        Title: headerText(title),
        Priority: priority,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    await response.body?.cancel()
    if (response.ok) return true
    deps.out(`push failed: HTTP ${response.status}`)
  } catch (error) {
    deps.out(`push failed: ${(error as Error).message}`)
  }
  return false
}

async function stopRun(deps: Deps, id: string): Promise<Outcome> {
  const db = await openDb(deps)
  try {
    if (!await getRun(db, id)) return refuse(`no run ${id}`)
    const active = await activeRuns(db, deps)
    // Children first, so a lead never ends while its runs still work.
    for (const child of active.filter((o) => o.parent === id)) await stopRun(deps, child.id)
    if (!active.some((o) => o.id === id)) return ok(`${id}: ${(await getRun(db, id))!.status}`)
    await addEvent(db, deps, id, `stop`, `agent-run stop`)
    await deps.run([`systemctl`, `--user`, `stop`, unitName(id)])
    // `finish` normally closes the row; if it never ran, the unit is gone now and this closes it.
    await activeRuns(db, deps)
    return ok(`${id}: ${(await getRun(db, id))!.status}`)
  } finally {
    await db.close()
  }
}

async function waitRun(deps: Deps, id: string, timeoutSec: number): Promise<Outcome> {
  const until = deps.now().getTime() + timeoutSec * 1000
  while (true) {
    const db = await openDb(deps)
    await activeRuns(db, deps)
    const run = await getRun(db, id)
    await db.close()
    if (!run) return refuse(`no run ${id}`)
    if (run.status !== `running`) {
      const code = run.status === `done` ? 0 : run.status === `blocked` ? 3 : 4
      return { code, output: JSON.stringify(run) }
    }
    if (deps.now().getTime() >= until) return { code: 124, output: `still running` }
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
}

/** The goal metric over the last 7 days: issues done and what all runs started in them cost. */
async function weekGoal(db: SqliteDb, deps: Deps): Promise<string> {
  const since = new Date(deps.now().getTime() - 7 * 86400_000).toISOString()
  const done = await db.queryOne(
    `SELECT COUNT(*) AS n FROM queue WHERE status = 'done' AND updated_at >= ?`,
    since,
  )
  const spent = await db.queryOne(
    `SELECT COALESCE(SUM(cost_micros), 0) AS micros FROM runs WHERE started_at >= ?`,
    since,
  )
  return goalText(`7 days`, Number(done?.n ?? 0), Number(spent?.micros ?? 0))
}

async function status(deps: Deps, rest: string[], flags: Map<string, string[]>): Promise<Outcome> {
  const db = await openDb(deps)
  try {
    const limit = Number(flags.get(`limit`)?.at(-1) ?? 20)
    const runs = rest[0]
      ? [await getRun(db, rest[0])].filter((run): run is Run => run !== null)
      : flags.has(`active`)
      ? await activeRuns(db, deps)
      : (await db.queryAll(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`, limit)).map(
        rowToRun,
      )
    if (flags.has(`json`)) return ok(JSON.stringify(runs, null, 2))
    return ok(
      [
        `lead limit: ${await leadLimit(db)}`,
        await weekGoal(db, deps),
        ...runs.map((run) =>
          `${run.id} ${run.name} ${run.status} ${run.startedAt} ${dollars(run.costMicros)}` +
          (run.activity ? `\n  ${run.activity.split(`\n`)[0]}` : ``)
        ),
      ].join(`\n`),
    )
  } finally {
    await db.close()
  }
}

async function note(deps: Deps, text: string): Promise<Outcome> {
  const id = deps.env(`AGENT_RUN_ID`)
  if (!id) return refuse(`note works only inside a run (no AGENT_RUN_ID)`)
  if (!text.trim()) return refuse(`empty note`)
  const db = await openDb(deps)
  try {
    await addEvent(db, deps, id, `note`, text.slice(0, 500))
    await db.execute(`UPDATE runs SET activity = ? WHERE id = ?`, text.slice(0, 300), id)
    return ok(`noted`)
  } finally {
    await db.close()
  }
}

async function usageCommand(deps: Deps): Promise<Outcome> {
  const usage = await readUsage(deps)
  return usage ? ok(JSON.stringify(usage)) : { code: 1, output: `/usage printed no usage` }
}

/** What today's runs (started on the local calendar day) have spent, in millionths of a dollar. */
async function todayMicros(db: SqliteDb, deps: Deps): Promise<number> {
  const { start, end } = localDay(deps.now())
  const row = await db.queryOne(
    `SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM runs WHERE started_at >= ? AND started_at < ?`,
    start,
    end,
  )
  return Number(row?.spent ?? 0)
}

/** Why the loop may not start a run now (paused, or the day's budget spent), or `null`. */
async function loopStop(db: SqliteDb, deps: Deps): Promise<string | null> {
  const paused = await getMeta(db, `paused`)
  if (paused) return `paused: ${paused}`
  const spent = await todayMicros(db, deps)
  if (spent >= DAILY_BUDGET_USD * 1e6) {
    return `today's ${dollars(spent)} reached the $${DAILY_BUDGET_USD} budget`
  }
  return null
}

/** The open lessons, newest first, as brief lines. */
async function lessonLines(db: SqliteDb): Promise<string> {
  const rows = await db.queryAll(
    `SELECT id, kind, minutes, tokens, detail FROM lessons WHERE status = 'open'
      ORDER BY at DESC LIMIT ?`,
    BRIEF_LESSONS,
  )
  if (rows.length === 0) return `None yet.`
  return rows.map((row) => {
    const cost = [
      row.minutes === null ? null : `${row.minutes} min`,
      row.tokens === null ? null : `${row.tokens} tokens`,
    ].filter(Boolean).join(`, `)
    return `- ${row.id} [${row.kind}]${cost ? ` ${cost}` : ``}: ${row.detail}`
  }).join(`\n`)
}

/** A new run row with the loop's settings: no budget or turn cap, the deadline the only stop. */
function loopRun(deps: Deps, fields: Pick<Run, `name` | `mode` | `effort` | `cwd`> & Partial<Run>) {
  return {
    id: uuidV7(),
    model: `opus`,
    parent: null,
    issue: null,
    deadlineSec: TICK_DEADLINE_SEC,
    budgetUsd: 0,
    maxTurns: 0,
    allow: [],
    startedAt: deps.now().toISOString(),
    endedAt: null,
    status: `running`,
    activity: null,
    costMicros: null,
    turns: null,
    result: null,
    ...fields,
  } satisfies Run
}

/** A claimed item whose lease passed and whose run has ended counts one failed attempt. */
async function expireLeases(db: SqliteDb, deps: Deps): Promise<string[]> {
  const active = new Set((await activeRuns(db, deps)).map((run) => run.id))
  const expired: string[] = []
  for (const item of await queueItems(db, `claimed`)) {
    if (!item.leaseUntil || Date.parse(item.leaseUntil) > deps.now().getTime()) continue
    if (item.runId && active.has(item.runId)) continue
    await failAttempt(db, deps, item, `lease expired`)
    expired.push(`lease expired: ${item.issue}`)
  }
  return expired
}

/**
 * The top-level lead runs, oldest first, that ended `parked` with a handoff, claimed no queue item,
 * were never continued and were refused fewer than `MAX_REFUSALS` times. Tick runs are left out:
 * their handoff travels on their queue item.
 */
async function uncontinued(db: SqliteDb): Promise<Run[]> {
  const rows = await db.queryAll(
    `SELECT * FROM runs r WHERE r.status = 'parked' AND r.mode = ? AND r.parent IS NULL
        AND r.name != 'tick' AND COALESCE(json_extract(r.result, '$.handoff'), '') != ''
        AND NOT EXISTS (SELECT 1 FROM queue q WHERE q.run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id AND e.kind = 'continued')
        AND (SELECT COUNT(*) FROM events e WHERE e.run_id = r.id AND e.kind = 'refused') < ?
      ORDER BY r.started_at`,
    Mode.Lead,
    MAX_REFUSALS,
  )
  return rows.map(rowToRun)
}

/**
 * `agent-tick.timer`, every 30 minutes: expire leases; stop when paused, the lead limit is reached,
 * today's budget is spent or usage is high (read once per tick); else fill each free lead slot,
 * checking the budget again before each start. Parked lead runs that have a handoff and no queue
 * item come first, continued once each with their settings and their handoff as the brief; then
 * the queue, planned again when needed, gives lead runs on the next queued items that GitHub still
 * confirms and this tick claims first. A candidate `whyNot` refuses is skipped; a continuation's
 * refusal is recorded, so it is given up after `MAX_REFUSALS`. When another tick or start takes
 * the last slot first, `launch` refuses: nothing is recorded against the candidate and the tick
 * stops. Every stop exits 0 and says why.
 */
async function tick(deps: Deps): Promise<Outcome> {
  const db = await openDb(deps)
  const lines: string[] = []
  const stop = (why: string) => ok([...lines, `tick: ${why}`].join(`\n`))
  let limit = MAX_LEADS
  /**
   * Start `run`: `null` when it started, `full` when the lead slots filled since this tick counted
   * them, else the outcome the tick ends with.
   */
  const begin = async (run: Run, brief: string, label: string, exclude: string | null) => {
    const started = await launch(db, deps, run, brief, false, exclude, limit)
    if (started.code === 2) return `full`
    lines.push(`tick: ${label}`, started.output)
    return started.code === 0 ? null : { code: started.code, output: lines.join(`\n`) }
  }
  const full = `another run took the last lead slot`
  try {
    lines.push(...await expireLeases(db, deps))
    const loop = await loopStop(db, deps)
    if (loop) return stop(loop)
    limit = await leadLimit(db)
    const leads = (await activeRuns(db, deps)).filter((run) => run.mode === Mode.Lead).length
    if (leads >= limit) {
      return stop(leads === 1 ? `a lead run is active` : `${leads} lead runs are active`)
    }
    const usage = await usageStop(deps)
    if (usage) return stop(usage)
    let free = limit - leads
    for (const parked of await uncontinued(db)) {
      if (free === 0) return ok(lines.join(`\n`))
      const gated = await loopStop(db, deps)
      if (gated) return stop(gated)
      const run: Run = {
        ...parked,
        id: uuidV7(),
        startedAt: deps.now().toISOString(),
        endedAt: null,
        status: `running`,
        activity: null,
        costMicros: null,
        turns: null,
        result: null,
      }
      // The lead slots are counted by `launch`, where a full count is no refusal of this run.
      const refused = await whyNot(run, await activeRuns(db, deps), deps, parked.id, Infinity)
      if (refused) {
        await addEvent(db, deps, parked.id, `refused`, refused)
        lines.push(`skipped continue ${parked.id}: ${refused}`)
        continue
      }
      // Recorded before the start, so a crash or a failed unit never continues the run twice.
      await addEvent(db, deps, parked.id, `continued`, run.id)
      const failed = await begin(run, parked.result!.handoff!, `continue ${parked.id}`, parked.id)
      if (failed === `full`) {
        await db.execute(
          `DELETE FROM events WHERE run_id = ? AND kind = 'continued' AND detail = ?`,
          parked.id,
          run.id,
        )
        return stop(full)
      }
      if (failed) return failed
      free--
    }
    if (free === 0) return ok(lines.join(`\n`))
    const direction = await readDirection(deps)
    if (direction.repos.length === 0) {
      return stop(`direction.md names no focus project under "## Focus now"`)
    }
    const focus = []
    for (const repo of direction.repos) focus.push(await readFocus(deps, repo))
    const why = await replanReason(db, deps, direction.focusHash, focus)
    if (why) {
      lines.push(`planned ${await replan(db, deps, direction.focusHash, focus)} item(s): ${why}`)
    }
    const before = free
    let skipped = 0
    for (const item of await queueItems(db, `queued`)) {
      if (free === 0) break
      const bad = await recheck(deps, item)
      if (bad) {
        await setItem(db, deps, item.issue, { status: `dropped`, reason: bad, handoff: null })
        lines.push(`dropped ${item.issue}: ${bad}`)
        continue
      }
      const run = loopRun(deps, {
        name: `tick`,
        mode: Mode.Lead,
        effort: `medium`,
        cwd: join(deps.home, `sync`, `code`),
        issue: item.issue,
      })
      const gated = await loopStop(db, deps)
      if (gated) return stop(gated)
      const refused = await whyNot(run, await activeRuns(db, deps), deps, null, Infinity)
      if (refused) {
        lines.push(`skipped ${item.issue}: ${refused}`)
        skipped++
        continue
      }
      const brief = [
        (await deps.fs.readText(join(DOTFILES, `tools`, `agent-tick-brief.md`)))!.trim(),
        `## Your issue`,
        [
          `- Issue: ${item.issue}`,
          `- Title: ${item.title}`,
          `- Source: ${item.source}`,
          ...(item.reason ? [`- Where an earlier run left it: ${item.reason}`] : []),
        ].join(`\n`),
        ...(item.handoff ? [`## The last run's handoff`, item.handoff] : []),
        `## Open lessons`,
        await lessonLines(db),
      ].join(`\n\n`)
      const lease = new Date(deps.now().getTime() + LEASE_MS)
      if (!await claim(db, deps, item.issue, run.id, lease)) {
        lines.push(`skipped ${item.issue}: another tick claimed it`)
        skipped++
        continue
      }
      const failed = await begin(run, brief, item.issue, null)
      if (failed === `full`) {
        await release(db, deps, run.id)
        return stop(full)
      }
      if (failed) return failed
      free--
    }
    if (free < before) return ok(lines.join(`\n`))
    return stop(skipped ? `${skipped} queued item(s) skipped, none started` : `no queued item`)
  } catch (error) {
    return { code: 1, output: [...lines, `tick failed: ${(error as Error).message}`].join(`\n`) }
  } finally {
    await db.close()
  }
}

/** `agent-retro.timer`, daily: one read-only run at effort high that improves the loop's flow. */
async function retro(deps: Deps): Promise<Outcome> {
  const db = await openDb(deps)
  try {
    const loop = await loopStop(db, deps)
    if (loop) return ok(`retro: ${loop}`)
    const self = (command: string) => `Bash(deno run -A ${SELF} ${command} *)`
    const run = loopRun(deps, {
      name: `retro`,
      mode: Mode.Read,
      effort: `high`,
      cwd: DOTFILES,
      deadlineSec: 3600,
      allow: [
        // `-safe` refuses dot-commands such as `.shell` and `.output`, which `-readonly` allows.
        `Bash(sqlite3 -readonly -safe *)`,
        `Bash(gh issue list *)`,
        `Bash(gh issue view *)`,
        `Bash(gh issue create -R spy4x/dotfiles *)`,
        `Bash(gh issue comment -R spy4x/dotfiles *)`,
        `Bash(gh pr list *)`,
        `Bash(gh pr view *)`,
        `Bash(gh search *)`,
        self(`lesson`),
        self(`experiment`),
        self(`report`),
      ],
    })
    const refused = await checkStart(db, deps, run, null)
    if (refused) return ok(`retro: ${refused}`)
    const brief = [
      (await deps.fs.readText(join(DOTFILES, `tools`, `agent-retro-brief.md`)))!.trim(),
      `## Open lessons`,
      await lessonLines(db),
      `## Commands`,
      `agent-run is \`deno run -A ${SELF}\``,
    ].join(`\n\n`)
    return await launch(db, deps, run, brief, false, null, MAX_LEADS)
  } finally {
    await db.close()
  }
}

async function pause(deps: Deps, reason: string | null): Promise<Outcome> {
  const db = await openDb(deps)
  try {
    await setMeta(db, `paused`, reason)
    return ok(reason ? `paused: ${reason}` : `unpaused`)
  } finally {
    await db.close()
  }
}

async function pushCommand(deps: Deps, flags: Map<string, string[]>, body: string) {
  const title = flags.get(`title`)?.at(-1)
  if (!title || title === `true` || !body.trim()) return refuse(`push needs --title and a body`)
  const db = await openDb(deps)
  try {
    const kind = flags.has(`urgent`) ? `urgent` : `good`
    await sendPush(db, deps, { kind, title, body }, deps.env(`AGENT_RUN_ID`) ?? null)
    return ok(`pushed`)
  } finally {
    await db.close()
  }
}

/** `lesson --kind <k> [--minutes n] [--tokens n] <detail>` adds one; `--close <id> <reason>`. */
async function lesson(deps: Deps, flags: Map<string, string[]>, text: string): Promise<Outcome> {
  const one = (name: string) => flags.get(name)?.at(-1)
  if (!text.trim()) return refuse(`a lesson needs a detail or a reason`)
  const db = await openDb(deps)
  try {
    const close = one(`close`)
    if (close) {
      const open = await db.queryOne(
        `SELECT 1 FROM lessons WHERE id = ? AND status = 'open'`,
        close,
      )
      if (!open) return refuse(`no open lesson ${close}`)
      await db.execute(
        `UPDATE lessons SET status = 'closed', closed_reason = ? WHERE id = ?`,
        text,
        close,
      )
      return ok(`closed ${close}`)
    }
    const kind = one(`kind`) ?? ``
    if (!/^[a-z0-9][a-z0-9-]*$/.test(kind)) return refuse(`--kind must be a short slug`)
    const number = (name: string) => {
      const value = one(name)
      return value === undefined ? null : Number(value)
    }
    const minutes = number(`minutes`)
    const tokens = number(`tokens`)
    if ([minutes, tokens].some((n) => n !== null && !(Number.isFinite(n) && n >= 0))) {
      return refuse(`--minutes and --tokens must be numbers of 0 or more`)
    }
    const id = uuidV7()
    await db.execute(
      `INSERT INTO lessons (id, run_id, at, kind, minutes, tokens, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      deps.env(`AGENT_RUN_ID`) ?? null,
      deps.now().toISOString(),
      kind,
      minutes,
      tokens === null ? null : Math.round(tokens),
      text,
    )
    return ok(id)
  } finally {
    await db.close()
  }
}

/**
 * Append a row to `ai-memory/experiments/background-lead.md` and commit only that file straight
 * to `main`, as ai-memory's README allows for experiment rows. It pushes that one commit by its
 * id, and commits nothing while ai-memory holds other commits not on `origin/main`, since a push
 * would carry them too. A failed push undoes the commit. A failed or refused step is printed and
 * the row stays in the file.
 */
async function experiment(deps: Deps, text: string): Promise<Outcome> {
  if (!text.trim()) return refuse(`empty experiment row`)
  const relative = join(`experiments`, `background-lead.md`)
  const file = join(deps.memory, relative)
  await deps.fs.mkdirp(dirname(file))
  if (!await deps.fs.exists(file)) {
    await deps.fs.writeText(file, `# Background lead experiments\n\n`)
  }
  const run = deps.env(`AGENT_RUN_ID`) ?? `none`
  await deps.fs.appendText(file, `- ${localStamp(deps.now())}, run ${run}: ${text.trim()}\n`)
  const git = async (...args: string[]) => {
    const step = await deps.run([`git`, `-C`, deps.memory, ...args])
    if (!step.success) throw new Error(`git ${args[0]} failed: ${step.stderr.trim().slice(0, 300)}`)
    return step.stdout.trim()
  }
  try {
    await git(`fetch`, `origin`, `main`)
    const ahead = Number(await git(`rev-list`, `--count`, `origin/main..HEAD`))
    if (ahead !== 0) {
      const commits = ahead === 1 ? `1 other commit` : `${ahead} other commits`
      return ok(`logged; not committed: ai-memory has ${commits} not on origin/main`)
    }
    await git(`add`, relative)
    await git(`commit`, `-m`, `docs(experiments): background lead retro row`, `--`, relative)
    const commit = await git(`rev-parse`, `HEAD`)
    // An empty source in the refspec would delete main.
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`git rev-parse printed no commit id`)
    try {
      await git(`push`, `origin`, `${commit}:refs/heads/main`)
    } catch (error) {
      // Undo the commit, only if it is still HEAD, so the next retro is not refused for it. The
      // row stays in the file, untracked or modified.
      const kept = await git(`update-ref`, `HEAD`, `${commit}~1`, commit)
        .then(() => git(`reset`, `-q`, `--`, relative))
        .then(() => ``, () => `; the local commit stays`)
      throw new Error(`${(error as Error).message}${kept}`)
    }
  } catch (error) {
    return ok(`logged; ${(error as Error).message}`)
  }
  return ok(`logged and pushed`)
}

/** The digest of the window: see `digestText`. `--ntfy` pushes it and records it as `digest`. */
async function report(deps: Deps, flags: Map<string, string[]>): Promise<Outcome> {
  const since = new Date(
    deps.now().getTime() - parseDuration(flags.get(`since`)?.at(-1) ?? `24h`) * 1000,
  )
  const db = await openDb(deps)
  try {
    const iso = since.toISOString()
    const runs = (await db.queryAll(
      `SELECT * FROM runs WHERE started_at >= ? OR ended_at >= ? OR status = 'running'
       ORDER BY started_at`,
      iso,
      iso,
    )).map(rowToRun)
    const notes = new Map<string, string[]>()
    for (
      const row of await db.queryAll(
        `SELECT run_id, detail FROM events WHERE kind = 'note' AND at >= ? ORDER BY at`,
        iso,
      )
    ) {
      const id = row.run_id as string
      notes.set(id, [...(notes.get(id) ?? []), row.detail as string])
    }
    const done = await Promise.all(
      (await db.queryAll(
        `SELECT issue, title, run_id FROM queue WHERE status = 'done' AND updated_at >= ?
          ORDER BY updated_at`,
        iso,
      )).map(async (row) => ({
        issue: row.issue as string,
        title: row.title as string,
        prs: row.run_id ? (await getRun(db, row.run_id as string))?.result?.prs ?? [] : [],
      })),
    )
    const blocked = (await db.queryAll(
      `SELECT issue, reason, run_id FROM queue WHERE status = 'blocked' AND updated_at >= ?
        ORDER BY updated_at`,
      iso,
    )).map((row) => ({
      issue: row.issue as string,
      reason: (row.reason as string | null) ?? null,
      runId: (row.run_id as string | null) ?? null,
    }))
    const lessons = (await db.queryAll(
      `SELECT kind, minutes, tokens, detail, run_id FROM lessons WHERE status = 'open'
        ORDER BY minutes DESC NULLS LAST, at DESC LIMIT 5`,
    )).map((row) => ({
      kind: row.kind as string,
      minutes: row.minutes === null ? null : Number(row.minutes),
      tokens: row.tokens === null ? null : Number(row.tokens),
      detail: row.detail as string,
      runId: (row.run_id as string | null) ?? null,
    }))
    const view = await db.queryOne(
      `SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'v_slow_steps'`,
    )
    const slow = view
      ? (await db.queryAll(
        `SELECT tool, summary, sec FROM v_slow_steps WHERE at >= ? ORDER BY sec DESC LIMIT 5`,
        iso,
      )).map((row) => ({
        tool: String(row.tool),
        summary: String(row.summary ?? ``),
        sec: Math.round(Number(row.sec)),
      }))
      : []
    const text = digestText({
      since,
      runs,
      notes,
      done,
      blocked,
      lessons,
      slow,
      todayMicros: await todayMicros(db, deps),
      paused: await getMeta(db, `paused`),
    })
    const all = `agent-run report --since ${flags.get(`since`)?.at(-1) ?? `24h`}`
    const push = fitPush(text, NTFY_MAX_BYTES, all)
    if (flags.has(`ntfy`) && await notify(deps, `Background lead digest`, push, `default`)) {
      await db.execute(
        `INSERT INTO pushes (id, at, kind, title, run_id) VALUES (?, ?, 'digest', ?, NULL)`,
        uuidV7(),
        deps.now().toISOString(),
        `Background lead digest`,
      )
    }
    return ok(text)
  } finally {
    await db.close()
  }
}

async function prune(deps: Deps, flags: Map<string, string[]>): Promise<Outcome> {
  const days = Number(flags.get(`older-than-days`)?.at(-1) ?? 14)
  const before = new Date(deps.now().getTime() - days * 86400_000).toISOString()
  const db = await openDb(deps)
  try {
    const old = await db.queryAll(
      `SELECT id FROM runs WHERE status != 'running' AND ended_at < ?`,
      before,
    )
    for (const { id } of old) {
      const dir = join(stateHome(deps), id as string)
      for (const file of [`prompt.md`, `brief.md`, `events.jsonl`, `stderr.log`]) {
        await deps.fs.remove(join(dir, file))
      }
      await deps.run([`rmdir`, `--ignore-fail-on-non-empty`, dir])
    }
    return ok(`pruned ${old.length} run folder(s); the database keeps their rows`)
  } finally {
    await db.close()
  }
}

/** Dispatch one command line. */
export async function main(args: string[], deps: Deps): Promise<Outcome> {
  const [command, ...tail] = args
  const { flags, rest } = parseFlags(tail)
  switch (command) {
    case `start`:
      return await startRun(deps, flags)
    case `resume`:
      return await resumeRun(deps, rest[0], flags)
    case `supervise`:
      return await supervise(deps, rest[0])
    case `finish`:
      return await finish(deps, rest[0])
    case `stop`:
      return await stopRun(deps, rest[0])
    case `wait`:
      return await waitRun(deps, rest[0], Number(flags.get(`timeout`)?.at(-1) ?? 900))
    case `status`:
      return await status(deps, rest, flags)
    case `note`:
      return await note(deps, rest.join(` `))
    case `usage`:
      return await usageCommand(deps)
    case `report`:
      return await report(deps, flags)
    case `prune`:
      return await prune(deps, flags)
    case `tick`:
      return await tick(deps)
    case `retro`:
      return await retro(deps)
    case `pause`:
      return await pause(deps, rest.join(` `).trim() || `paused by hand`)
    case `unpause`:
      return await pause(deps, null)
    case `limit`:
      return await limitCommand(deps, flags)
    case `push`:
      return await pushCommand(deps, flags, rest.join(` `))
    case `lesson`:
      return await lesson(deps, flags, rest.join(` `).trim())
    case `experiment`:
      return await experiment(deps, rest.join(` `))
    default:
      return { code: 1, output: `usage: see the header of ${SELF}` }
  }
}

if (import.meta.main) {
  const deps: Deps = {
    run: (command, options) => runCommand(command, options),
    fs: runtimeFileSystem,
    env: (name) => processEnv.get(name),
    now: () => new Date(),
    fetch: (url, init) => fetch(url, init),
    out: (text) => console.error(text),
    home: processEnv.get(`HOME`) ?? `/`,
    ntfyEnv: join(processEnv.get(`HOME`) ?? `/`, `sync`, `code`, `homelab`, `.env.accounts`),
    memory: join(processEnv.get(`HOME`) ?? `/`, `sync`, `code`, `ai-memory`),
  }
  const outcome = await main(processArgs(), deps)
  if (outcome.output) console.log(outcome.output)
  exitProcess(outcome.code)
}
