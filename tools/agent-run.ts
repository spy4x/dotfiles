#!/usr/bin/env -S deno run -A
// Starts, tracks and stops headless `claude -p` runs as systemd user services, so a lead or a
// timer can hand work to a run that outlives its own session. Design: docs/headless-runs.md.
//
// Usage (`agent-run` = `deno run -A ~/sync/code/dotfiles/tools/agent-run.ts`):
//   agent-run start  --cwd <dir> --model <opus|haiku> --mode <read|write|lead> --brief <file|->
//                    [--name <slug>] [--effort medium] [--deadline 2h] [--budget-usd 20]
//                    [--max-turns 300] [--weekly-cap <points>] [--issue <owner/repo#n>]
//                    [--allow "<tool rule>"]... [--handoff-from <id>]
//   agent-run wait   <id> [--timeout <seconds>]
//   agent-run status [<id>] [--active] [--json] [--limit <n>]
//   agent-run resume <id> --brief <file|-> [--deadline ..] [--budget-usd ..]
//   agent-run stop   <id>
//   agent-run note   <text>                  (inside a run: logs progress to the database)
//   agent-run usage                          (session and weekly usage; inside a run, what is left)
//   agent-run report [--since 24h] [--ntfy]  (what runs did, spent and got stuck on)
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

// ===== Types and constants =====

/** What a run may do. */
export enum Mode {
  Read = 1,
  Write = 2,
  Lead = 3,
}

const MODE_NAMES: Record<string, Mode> = { read: Mode.Read, write: Mode.Write, lead: Mode.Lead }

/** At most this many lead runs at once: one while the experiment runs (owner, 2026-11-06). */
export const MAX_LEADS = 1
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
const USAGE_POLL_MS = 5 * 60_000
const INGEST_POLL_MS = 60_000
const USAGE_TIMEOUT_MS = 60_000
/** `systemctl is-active` states of a unit that still exists. */
const ALIVE = [`active`, `activating`, `deactivating`, `reloading`, `refreshing`]

/** The schema every run's final answer must fill (`--json-schema`). */
export const RESULT_SCHEMA = {
  type: `object`,
  properties: {
    status: { type: `string`, enum: [`done`, `blocked`, `failed`] },
    summary: { type: `string` },
    prs: { type: `array`, items: { type: `string` } },
    needs_owner: { type: [`string`, `null`] },
    injection: { type: [`string`, `null`] },
    noticed: { type: `array`, items: { type: `string` } },
  },
  required: [`status`, `summary`, `prs`, `needs_owner`, `injection`, `noticed`],
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
  /** Points of the weekly limit this run (and its handoffs) may use; `null` for no cap. */
  weeklyCap: number | null
  /** Weekly usage when the capped day began, and that week's reset text. */
  weeklyStart: number | null
  weeklyReset: string | null
  startedAt: string
  endedAt: string | null
  status: string
  activity: string | null
  /** API-price estimate in millionths of a dollar. */
  costMicros: number | null
  turns: number | null
  weeklyEnd: number | null
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
  /** The NTFY settings file (`ai-harnesses/.env`); tests point it elsewhere. */
  ntfyEnv: string
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

/**
 * Points left of a capped run's weekly share. A new week (another reset text) starts the count
 * again from the current level.
 */
export function weeklyLeft(run: Run, usage: Usage): number | null {
  if (run.weeklyCap === null || run.weeklyStart === null) return null
  const start = usage.weeklyReset === run.weeklyReset ? run.weeklyStart : usage.weekly
  return run.weeklyCap - (usage.weekly - start)
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
    `--max-turns`,
    String(run.maxTurns),
    `--max-budget-usd`,
    String(run.budgetUsd),
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

/**
 * The push title, priority and body for an ended run. No tool output; the only model text is
 * `needs_owner`, and `notify` scans the body for secrets before it is sent.
 */
export function pushFor(run: Run): { title: string; priority: string; body: string } {
  const urgent = [`blocked`, `failed`, `timeout`, `budget`, `turns`].includes(run.status)
  const lines = [
    run.issue ? `Issue: ${run.issue}` : null,
    ...(run.result?.prs ?? []).map((pr) => `PR: ${pr}`),
    `Cost: ${dollars(run.costMicros)}${weeklySpent(run)}`,
    run.result?.needs_owner ? `Needs you: ${run.result.needs_owner}` : null,
    run.result?.injection ? `Injection reported: see agent-run status ${run.id}` : null,
    `Step in: claude --resume ${run.id}`,
  ]
  return {
    title: `${run.name}: ${run.status}`,
    priority: urgent ? `high` : `default`,
    body: lines.filter(Boolean).join(`\n`),
  }
}

/** The daily report: what each run in the window did, spent and got stuck on. */
export function reportText(runs: Run[], notes: Map<string, string[]>, since: Date): string {
  if (runs.length === 0) return `No headless runs since ${since.toISOString()}.`
  const cost = runs.reduce((sum, run) => sum + (run.costMicros ?? 0), 0)
  const out = [
    `${runs.length} run(s) since ${since.toISOString()}, ${dollars(cost)} at API prices.`,
  ]
  for (const run of runs) {
    out.push(``, `${run.name} (${run.status}), ${dollars(run.costMicros)}${weeklySpent(run)}`)
    if (run.result?.summary) out.push(run.result.summary)
    for (const pr of run.result?.prs ?? []) out.push(`PR: ${pr}`)
    for (const note of notes.get(run.id) ?? []) out.push(`- ${note}`)
    if (run.result?.needs_owner) out.push(`Needs you: ${run.result.needs_owner}`)
    if (run.result?.injection) out.push(`Injection reported: ${run.result.injection}`)
    if (run.status === `running` && run.activity) out.push(`Now: ${run.activity}`)
  }
  return out.join(`\n`)
}

function dollars(micros: number | null): string {
  return micros === null ? `$?` : `$${(micros / 1e6).toFixed(2)}`
}

function weeklySpent(run: Run): string {
  if (run.weeklyStart === null || run.weeklyEnd === null) return ``
  return `, weekly usage ${run.weeklyStart}% → ${run.weeklyEnd}%`
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
  weekly_cap REAL,
  weekly_start INTEGER,
  weekly_reset TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  activity TEXT,
  cost_micros INTEGER,
  turns INTEGER,
  weekly_end INTEGER,
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
`

/** Open the run database under the state home, creating it and its schema. */
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
  await db.exec(SCHEMA)
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
    weeklyCap: row.weekly_cap === null ? null : Number(row.weekly_cap),
    weeklyStart: row.weekly_start === null ? null : Number(row.weekly_start),
    weeklyReset: (row.weekly_reset as string | null) ?? null,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string | null) ?? null,
    status: row.status as string,
    activity: (row.activity as string | null) ?? null,
    costMicros: row.cost_micros === null ? null : Number(row.cost_micros),
    turns: row.turns === null ? null : Number(row.turns),
    weeklyEnd: row.weekly_end === null ? null : Number(row.weekly_end),
    result: row.result ? JSON.parse(row.result as string) : null,
  }
}

async function getRun(db: SqliteDb, id: string): Promise<Run | null> {
  const row = await db.queryOne(`SELECT * FROM runs WHERE id = ?`, id)
  return row ? rowToRun(row) : null
}

/**
 * The runs still going. A row marked running whose unit is gone (it died before `finish` ran) is
 * closed here as stopped or failed, so it never blocks later starts.
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
  }
  return active
}

async function insertRun(db: SqliteDb, run: Run): Promise<void> {
  await db.execute(
    `INSERT INTO runs (id, name, mode, model, effort, cwd, parent, issue, deadline_sec, budget_usd,
      max_turns, allow, weekly_cap, weekly_start, weekly_reset, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    run.weeklyCap,
    run.weeklyStart,
    run.weeklyReset,
    run.startedAt,
    run.status,
  )
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
    const value = next === undefined || next.startsWith(`--`) ? `true` : (i++, next)
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

/** Why `run` may not start now, or `null`. Checks only what the database and GitHub can tell. */
export async function whyNot(
  run: Run,
  active: Run[],
  deps: Deps,
  handoffFrom: string | null,
): Promise<string | null> {
  if (!MODELS.includes(run.model)) return `--model must be one of ${MODELS.join(`, `)}`
  const others = active.filter((other) => other.id !== handoffFrom)
  if (run.mode === Mode.Lead && others.filter((o) => o.mode === Mode.Lead).length >= MAX_LEADS) {
    return `${MAX_LEADS} lead run(s) already active`
  }
  if (run.mode === Mode.Write) {
    // A linked worktree's `.git` is a file; reading a main checkout's `.git` directory fails.
    const git = await deps.fs.readText(join(run.cwd, `.git`)).catch(() => null)
    if (git === null || !git.startsWith(`gitdir:`)) return `write mode needs a linked worktree`
  }
  if (run.mode !== Mode.Read && others.some((o) => o.mode !== Mode.Read && o.cwd === run.cwd)) {
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
      weeklyCap: from?.weeklyCap ?? (one(`weekly-cap`) ? Number(one(`weekly-cap`)) : null),
      weeklyStart: from?.weeklyStart ?? null,
      weeklyReset: from?.weeklyReset ?? null,
      startedAt: deps.now().toISOString(),
      endedAt: null,
      status: `running`,
      activity: null,
      costMicros: null,
      turns: null,
      weeklyEnd: null,
      result: null,
    }
    const why = await checkStart(db, deps, run, handoffFrom)
    if (why) return refuse(why)
    return await launch(db, deps, run, brief, false)
  } finally {
    await db.close()
  }
}

/**
 * Why `run` may not start or resume now, or `null`: the limits of `whyNot` plus the usage stops.
 * Sets the weekly baseline of a capped run that has none. `exclude` is a run that ends as this one
 * starts (a handoff's source, or the resumed run itself).
 */
async function checkStart(
  db: SqliteDb,
  deps: Deps,
  run: Run,
  exclude: string | null,
): Promise<string | null> {
  const why = await whyNot(run, await activeRuns(db, deps), deps, exclude)
  if (why) return why
  const usage = await readUsage(deps)
  if (usage && usage.session >= SESSION_STOP) return `session usage at ${usage.session}%`
  if (usage && usage.weekly >= WEEKLY_STOP) return `weekly usage at ${usage.weekly}%`
  if (run.weeklyCap === null) return null
  if (!usage) return `--weekly-cap needs a readable usage, and /usage printed none`
  if (run.weeklyStart === null) {
    run.weeklyStart = usage.weekly
    run.weeklyReset = usage.weeklyReset
  }
  if (weeklyLeft(run, usage)! <= 0) return `the weekly share of ${run.weeklyCap} points is used up`
  return null
}

async function launch(db: SqliteDb, deps: Deps, run: Run, brief: string, resume: boolean) {
  const dir = join(stateHome(deps), run.id)
  await deps.fs.mkdirp(dir)
  await deps.run([`chmod`, `700`, stateHome(deps), dir])
  await deps.fs.writeText(join(dir, `prompt.md`), brief, { mode: 0o600 })
  await deps.fs.appendText(join(dir, `brief.md`), `${brief}\n\n---\n\n`)
  if (resume) {
    await db.execute(`UPDATE runs SET status = 'running', ended_at = NULL WHERE id = ?`, run.id)
  } else {
    await insertRun(db, run)
  }
  await addEvent(db, deps, run.id, resume ? `resume` : `start`, brief.slice(0, 300))
  const started = await deps.run(unitCommand(run, deps))
  if (!started.success) {
    await db.execute(`UPDATE runs SET status = 'failed' WHERE id = ?`, run.id)
    await addEvent(db, deps, run.id, `error`, started.stderr.slice(0, 500))
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
    return await launch(db, deps, run, brief, true)
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

/** The unit's main process: runs `claude`, logs its events, stops it at the weekly share. */
async function supervise(deps: Deps, id: string): Promise<Outcome> {
  const db = await openDb(deps)
  const run = await getRun(db, id)
  if (!run) return { code: 1, output: `no run ${id}` }
  const dir = join(stateHome(deps), id)
  const resumed = await db.queryOne(`SELECT 1 FROM events WHERE run_id = ? AND kind = 'resume'`, id)
  const stop = new AbortController()
  const shell = `exec "$@" < "$PROMPT" >> "$EVENTS" 2>> "$ERRORS"`
  const child = deps.run([`sh`, `-c`, shell, `sh`, ...claudeArgs(run, resumed !== undefined)], {
    env: {
      PROMPT: join(dir, `prompt.md`),
      EVENTS: join(dir, `events.jsonl`),
      ERRORS: join(dir, `stderr.log`),
    },
    signal: stop.signal,
  })
  let lastUsage = 0
  let done = false
  const watch = (async () => {
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, INGEST_POLL_MS))
      if (done) break
      await ingest(db, deps, id)
      if (run.weeklyCap === null || deps.now().getTime() - lastUsage < USAGE_POLL_MS) continue
      lastUsage = deps.now().getTime()
      const usage = await readUsage(deps)
      const left = usage ? weeklyLeft(run, usage) : null
      if (left !== null && left <= 0) {
        await addEvent(db, deps, id, `quota`, `weekly usage ${usage!.weekly}%, share used up`)
        stop.abort()
      }
    }
  })()
  const outcome = await child
  done = true
  await watch.catch(() => {})
  await db.close()
  return { code: outcome.code < 0 ? 1 : outcome.code, output: `` }
}

/** Run by `ExecStopPost`: final status, result, usage, and the push. */
async function finish(deps: Deps, id: string): Promise<Outcome> {
  const db = await openDb(deps)
  try {
    const run = await getRun(db, id)
    if (!run) return { code: 1, output: `no run ${id}` }
    await ingest(db, deps, id).catch(() => {})
    const text = await deps.fs.readText(join(stateHome(deps), id, `events.jsonl`)) ?? ``
    const { result } = readEvents(text.split(`\n`))
    const quota = await db.queryOne(`SELECT 1 FROM events WHERE run_id = ? AND kind = 'quota'`, id)
    const stopped = await db.queryOne(`SELECT 1 FROM events WHERE run_id = ? AND kind = 'stop'`, id)
    const status = finalStatus(
      deps.env(`SERVICE_RESULT`),
      result,
      quota ? `quota` : stopped ? `stopped` : null,
    )
    const answer: RunResult = {
      ...(result?.structured_output as RunResult | undefined),
      subtype: result?.subtype as string | undefined,
    }
    await db.execute(
      `UPDATE runs SET status = ?, ended_at = ?, cost_micros = ?, turns = ?, result = ?
        WHERE id = ?`,
      status,
      deps.now().toISOString(),
      result ? Math.round(Number(result.total_cost_usd ?? 0) * 1e6) : null,
      result ? Number(result.num_turns ?? 0) : null,
      JSON.stringify(answer),
      id,
    )
    // After the status is safe: a slow /usage must not leave the run open if systemd kills this.
    const usage = await readUsage(deps).catch(() => null)
    await db.execute(`UPDATE runs SET weekly_end = ? WHERE id = ?`, usage?.weekly ?? null, id)
    await addEvent(db, deps, id, `end`, `${status} (${deps.env(`SERVICE_RESULT`) ?? `?`})`)
    const ended = (await getRun(db, id))!
    const push = pushFor(ended)
    await notify(deps, push.title, push.body, push.priority)
    return ok(status)
  } finally {
    await db.close()
  }
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

/** One NTFY push from `ai-harnesses/.env`. Fails open: a failed push is printed, never retried. */
async function notify(deps: Deps, title: string, body: string, priority: string) {
  const env = await deps.fs.readText(deps.ntfyEnv) ?? ``
  const value = (name: string) => new RegExp(`^${name}=(.*)$`, `m`).exec(env)?.[1]?.trim()
  const url = value(`NTFY_URL`)
  const topic = value(`NTFY_TOPIC`)
  if (!url || !topic) return deps.out(`no NTFY_URL or NTFY_TOPIC; push skipped`)
  const token = value(`NTFY_TOKEN`)
  if (!await scanClean(deps, `${title}\n${body}`)) {
    body = `The text was held back: the secret scan flagged it or could not run. ` +
      `Read it on the machine with agent-run status or agent-run report.`
  }
  try {
    const response = await deps.fetch(`${url.replace(/\/$/, ``)}/${topic}`, {
      method: `POST`,
      body,
      headers: {
        Title: title,
        Priority: priority,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    if (!response.ok) deps.out(`push failed: HTTP ${response.status}`)
    await response.body?.cancel()
  } catch (error) {
    deps.out(`push failed: ${(error as Error).message}`)
  }
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
      runs.map((run) =>
        `${run.id} ${run.name} ${run.status} ${run.startedAt} ${dollars(run.costMicros)}` +
        (run.activity ? `\n  ${run.activity.split(`\n`)[0]}` : ``)
      ).join(`\n`),
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
  if (!usage) return { code: 1, output: `/usage printed no usage` }
  const id = deps.env(`AGENT_RUN_ID`)
  if (!id) return ok(JSON.stringify(usage))
  const db = await openDb(deps)
  try {
    const run = await getRun(db, id)
    const left = run ? weeklyLeft(run, usage) : null
    return ok(JSON.stringify({ ...usage, weeklyStart: run?.weeklyStart, weeklyLeft: left }))
  } finally {
    await db.close()
  }
}

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
    const text = reportText(runs, notes, since)
    if (flags.has(`ntfy`)) {
      const stuck = runs.some((run) =>
        run.result?.needs_owner || ![`done`, `running`].includes(run.status)
      )
      await notify(deps, `Headless runs, last day`, text, stuck ? `high` : `default`)
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
    ntfyEnv: join(DOTFILES, `ai-harnesses`, `.env`),
  }
  const outcome = await main(processArgs(), deps)
  if (outcome.output) console.log(outcome.output)
  exitProcess(outcome.code)
}
