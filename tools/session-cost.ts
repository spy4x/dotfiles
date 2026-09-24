#!/usr/bin/env -S deno run -A
// Per-session $ cost report for Claude Code transcripts: calls, peak/average context, the
// cache-read/cache-write/output/input split, and compaction counts — for the main session and
// every subagent it spawned.
//
// Why this exists: issue #61 found a wave of Sonnet implementer subagents burning $400+ of
// API-equivalent usage in six hours, some running 400-600 calls with a context of 600-970K
// tokens because nothing compacted them. There was no per-session way to see that coming. This
// tool reads a transcript and reports it, so a wave's handoff can show what it cost.
//
// Usage:
//   deno run -A tools/session-cost.ts [--since <ISO time>] [--until <ISO time>] [--json] \
//     <session-id | path/to/session.jsonl>...
//
// A session id resolves to <projects>/<any project dir>/<id>.jsonl, where <projects> defaults
// to $HOME/.claude/projects. Each session's subagent transcripts
// (<id>/subagents/agent-*.jsonl) and their sibling agent-*.meta.json, when present, are folded
// in automatically. Several session arguments are reported one after another.
//
// Prices are API list prices as of 2026-09 (see PRICES below) — a proxy for subscription
// usage, not what a Claude subscription actually bills.

import { join } from "jsr:@std/path@^1.0.0"

// ===== Pricing =====

/** Dollars per million tokens for one model. */
export interface Price {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
}

/**
 * API list prices in dollars per million tokens, as of 2026-09, keyed by model-id prefix. A
 * model id may carry a date suffix (`claude-haiku-4-5-20251001`); `priceFor` matches on prefix.
 * These are a proxy for subscription usage, not actual subscription billing.
 */
export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.20 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.50 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.20 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.10 },
}

/** A 5-minute cache write costs 1.25x the input price; a 1-hour write costs 2x. */
const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2

/**
 * Looks up the price table entry for `model`, matching the longest table key that `model`
 * starts with (so `claude-opus-5-5` prices as itself, never falls through to `claude-opus-5`).
 * Returns `undefined` for a model absent from the table — callers report that as unknown cost,
 * never as zero.
 */
export function priceFor(model: string): Price | undefined {
  let bestKey: string | undefined
  for (const key of Object.keys(PRICES)) {
    if (!model.startsWith(key)) continue
    if (bestKey === undefined || key.length > bestKey.length) bestKey = key
  }
  return bestKey === undefined ? undefined : PRICES[bestKey]
}

// ===== Transcript parsing =====

/** One API call's usage, taken from the last transcript line for its `message.id`. */
export interface Call {
  readonly timestamp: string
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cache5mTokens: number
  readonly cache1hTokens: number
}

/** A call's context: input + cache read + cache creation (5-minute and 1-hour) tokens. */
export function ctxOf(call: Call): number {
  return call.inputTokens + call.cacheReadTokens + call.cache5mTokens + call.cache1hTokens
}

/** One transcript's calls (deduplicated by message id) and its compaction timestamps. */
export interface ParsedTranscript {
  readonly calls: Call[]
  readonly compactionTimestamps: string[]
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

function toCall(timestamp: string, model: string, usage: RawUsage): Call {
  const split = usage.cache_creation
  const cache5mTokens = split
    ? split.ephemeral_5m_input_tokens ?? 0
    : usage.cache_creation_input_tokens ?? 0
  const cache1hTokens = split ? split.ephemeral_1h_input_tokens ?? 0 : 0
  return {
    timestamp,
    model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cache5mTokens,
    cache1hTokens,
  }
}

/**
 * Parses one transcript's raw JSONL lines (already split, one string per line) into calls and
 * compaction timestamps. Pure and synchronous: it does no I/O, so tests feed it fixtures
 * in-memory.
 *
 * One API call is written as several lines sharing one `message.id` (one per content block);
 * this keeps the LAST line's usage for each id, since earlier lines in a subagent transcript
 * carry a partial `output_tokens`. A line whose model starts with `<` (for example
 * `<synthetic>`, written for API errors) is skipped, and so is a line that fails to parse.
 */
export function parseTranscript(lines: string[]): ParsedTranscript {
  const byId = new Map<string, Call>()
  const compactionTimestamps: string[] = []

  for (const line of lines) {
    if (line.trim().length === 0) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry.type === `system` && entry.subtype === `compact_boundary`) {
      if (typeof entry.timestamp === `string`) compactionTimestamps.push(entry.timestamp)
      continue
    }

    if (entry.type !== `assistant`) continue
    const message = entry.message as Record<string, unknown> | undefined
    const timestamp = entry.timestamp
    const id = message?.id
    const model = message?.model
    const usage = message?.usage
    if (typeof timestamp !== `string` || typeof id !== `string` || typeof model !== `string`) {
      continue
    }
    if (model.startsWith(`<`)) continue
    if (typeof usage !== `object` || usage === null) continue

    byId.set(id, toCall(timestamp, model, usage as RawUsage))
  }

  return { calls: [...byId.values()], compactionTimestamps }
}

// ===== Cost =====

/** Dollar cost split the same way a session's total is split: cache read, cache write, output, input. */
export interface CostBreakdown {
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly input: number
}

const ZERO_COST: CostBreakdown = { cacheRead: 0, cacheWrite: 0, output: 0, input: 0 }

function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    input: a.input + b.input,
  }
}

function totalOf(cost: CostBreakdown): number {
  return cost.cacheRead + cost.cacheWrite + cost.output + cost.input
}

/**
 * Prices one call. A model absent from `PRICES` returns `priced: false` and a zero breakdown —
 * the caller must report that model as unpriced rather than folding its zero into the total as
 * if the call were free.
 */
function costOf(call: Call): { cost: CostBreakdown; priced: boolean } {
  const price = priceFor(call.model)
  if (!price) return { cost: ZERO_COST, priced: false }
  const cost: CostBreakdown = {
    cacheRead: (call.cacheReadTokens * price.cacheRead) / 1_000_000,
    cacheWrite: (call.cache5mTokens * price.input * CACHE_WRITE_5M +
      call.cache1hTokens * price.input * CACHE_WRITE_1H) / 1_000_000,
    output: (call.outputTokens * price.output) / 1_000_000,
    input: (call.inputTokens * price.input) / 1_000_000,
  }
  return { cost, priced: true }
}

// ===== Per-agent aggregation =====

/** A timestamp range filter; either end may be open. */
export interface DateRange {
  readonly since?: Date
  readonly until?: Date
}

function withinRange(timestamp: string, range: DateRange): boolean {
  const t = Date.parse(timestamp)
  if (Number.isNaN(t)) return false
  if (range.since && t < range.since.getTime()) return false
  if (range.until && t > range.until.getTime()) return false
  return true
}

/** What identifies an agent in the report: its label, and the range calls are filtered to. */
export interface SummariseMeta extends DateRange {
  readonly label: string
}

/** One agent's row in the report: main, or one subagent. */
export interface AgentReport {
  readonly label: string
  readonly models: string[]
  readonly calls: number
  readonly peakCtx: number
  readonly avgCtx: number
  readonly compactions: number
  readonly minutes: number
  readonly cost: CostBreakdown
  readonly totalCost: number
  readonly unpricedModels: string[]
}

/**
 * Aggregates one transcript's raw JSONL lines into an `AgentReport`: parses them, keeps only
 * calls (and compactions) inside `meta`'s range, and prices every kept call. Pure — the only
 * I/O in this file is reading the lines in the first place.
 */
export function summarise(lines: string[], meta: SummariseMeta): AgentReport {
  const parsed = parseTranscript(lines)
  const calls = parsed.calls.filter((call) => withinRange(call.timestamp, meta))
  const compactions = parsed.compactionTimestamps.filter((ts) => withinRange(ts, meta)).length

  if (calls.length === 0) {
    return {
      label: meta.label,
      models: [],
      calls: 0,
      peakCtx: 0,
      avgCtx: 0,
      compactions,
      minutes: 0,
      cost: ZERO_COST,
      totalCost: 0,
      unpricedModels: [],
    }
  }

  const models = [...new Set(calls.map((call) => call.model))].sort()
  const ctxs = calls.map(ctxOf)
  const peakCtx = Math.max(...ctxs)
  const avgCtx = ctxs.reduce((a, b) => a + b, 0) / ctxs.length
  const timestamps = calls.map((call) => Date.parse(call.timestamp))
  const minutes = (Math.max(...timestamps) - Math.min(...timestamps)) / 60_000

  let cost = ZERO_COST
  const unpriced = new Set<string>()
  for (const call of calls) {
    const priced = costOf(call)
    cost = addCost(cost, priced.cost)
    if (!priced.priced) unpriced.add(call.model)
  }

  return {
    label: meta.label,
    models,
    calls: calls.length,
    peakCtx,
    avgCtx,
    compactions,
    minutes,
    cost,
    totalCost: totalOf(cost),
    unpricedModels: [...unpriced].sort(),
  }
}

// ===== Session-level report =====

/** The full report for one session: main plus its subagents, ordered and totalled. */
export interface SessionReport {
  readonly agents: AgentReport[]
  readonly total: CostBreakdown
  readonly totalCost: number
  readonly share: {
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly output: number
  }
  readonly unpricedModels: string[]
}

/**
 * Orders `main` first, then `subagents` by cost descending, and rolls the whole session up
 * into a total and a cache-read/cache-write/output cost share.
 */
export function report(main: AgentReport, subagents: AgentReport[]): SessionReport {
  const ordered = [main, ...[...subagents].sort((a, b) => b.totalCost - a.totalCost)]
  const total = ordered.reduce((acc, agent) => addCost(acc, agent.cost), ZERO_COST)
  const totalCost = totalOf(total)
  const share = {
    cacheRead: totalCost > 0 ? total.cacheRead / totalCost : 0,
    cacheWrite: totalCost > 0 ? total.cacheWrite / totalCost : 0,
    output: totalCost > 0 ? total.output / totalCost : 0,
  }
  const unpricedModels = [...new Set(ordered.flatMap((agent) => agent.unpricedModels))].sort()
  return { agents: ordered, total, totalCost, share, unpricedModels }
}

// ===== Filesystem: locating and loading a session =====

/** Where one session's main transcript and subagent directory live on disk. */
export interface SessionLocation {
  readonly mainPath: string
  readonly subagentsDir: string
}

function subagentsDirFor(mainPath: string): string {
  return `${mainPath.replace(/\.jsonl$/, ``)}/subagents`
}

/**
 * Resolves a CLI argument to a session's files. `idOrPath` is used directly when it names an
 * existing file; otherwise it is treated as a session id and searched for as
 * `<projectsDir>/<any project dir>/<idOrPath>.jsonl`. Throws when no project directory holds
 * that id, or when more than one does.
 */
export async function resolveSession(
  projectsDir: string,
  idOrPath: string,
): Promise<SessionLocation> {
  const direct = await Deno.stat(idOrPath).catch(() => null)
  if (direct?.isFile) {
    const mainPath = await Deno.realPath(idOrPath)
    return { mainPath, subagentsDir: subagentsDirFor(mainPath) }
  }

  const matches: string[] = []
  for await (const projectDir of Deno.readDir(projectsDir)) {
    if (!projectDir.isDirectory) continue
    const candidate = join(projectsDir, projectDir.name, `${idOrPath}.jsonl`)
    if (await Deno.stat(candidate).catch(() => null)) matches.push(candidate)
  }
  if (matches.length === 0) {
    throw new Error(`no session "${idOrPath}" found under ${projectsDir}`)
  }
  if (matches.length > 1) {
    throw new Error(`session "${idOrPath}" is ambiguous — found in: ${matches.join(`, `)}`)
  }
  return { mainPath: matches[0], subagentsDir: subagentsDirFor(matches[0]) }
}

/** One subagent transcript file, plus the path its sibling meta file would live at. */
export interface SubagentFile {
  readonly id: string
  readonly jsonlPath: string
  readonly metaPath: string
}

/** Lists every `agent-*.jsonl` under `subagentsDir`, sorted by id. Empty when the directory is absent. */
export async function listSubagents(subagentsDir: string): Promise<SubagentFile[]> {
  const out: SubagentFile[] = []
  try {
    for await (const entry of Deno.readDir(subagentsDir)) {
      if (!entry.isFile) continue
      const match = entry.name.match(/^agent-(.+)\.jsonl$/)
      if (!match) continue
      out.push({
        id: match[1],
        jsonlPath: join(subagentsDir, entry.name),
        metaPath: join(subagentsDir, `agent-${match[1]}.meta.json`),
      })
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** The fields read from a subagent's sibling `agent-*.meta.json`. */
export interface AgentMeta {
  readonly agentType?: string
  readonly description?: string
  readonly model?: string
}

async function readMeta(metaPath: string): Promise<AgentMeta | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(metaPath))
  } catch {
    // Missing or malformed meta: the subagent is still reported, just without a rich label.
    return undefined
  }
}

async function readLines(path: string): Promise<string[]> {
  return (await Deno.readTextFile(path)).split(`\n`)
}

/** `main`, or `<agentType>: <description>` — falling back gracefully when meta is thin or absent. */
function subagentLabel(id: string, meta: AgentMeta | undefined): string {
  if (meta?.agentType && meta?.description) return `${meta.agentType}: ${meta.description}`
  if (meta?.agentType) return meta.agentType
  if (meta?.description) return meta.description
  return `subagent ${id}`
}

/**
 * Loads a session's main transcript and every subagent transcript from disk, summarises each
 * inside `range`, and rolls them up with `report`. This is the only function in the file that
 * combines filesystem I/O with the pure aggregation above.
 */
export async function loadSessionReport(
  location: SessionLocation,
  range: DateRange,
): Promise<SessionReport> {
  const mainLines = await readLines(location.mainPath)
  const main = summarise(mainLines, { label: `main`, ...range })

  const subagentFiles = await listSubagents(location.subagentsDir)
  const subagents: AgentReport[] = []
  for (const file of subagentFiles) {
    const [lines, meta] = await Promise.all([readLines(file.jsonlPath), readMeta(file.metaPath)])
    subagents.push(summarise(lines, { label: subagentLabel(file.id, meta), ...range }))
  }

  return report(main, subagents)
}

// ===== Formatting =====

function fmtUSD(n: number): string {
  return `$${n.toFixed(2)}`
}

function fmtK(n: number): string {
  return `${(n / 1000).toFixed(1)}K`
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`
}

function padCells(rows: string[][], aligns: (`left` | `right`)[]): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)))
  return rows.map((row) =>
    row.map((cell, col) =>
      aligns[col] === `left` ? cell.padEnd(widths[col]) : cell.padStart(widths[col])
    )
      .join(`  `).trimEnd()
  )
}

/** Renders a `SessionReport` as plain aligned text, headed by `label` (the CLI argument used to find it). */
export function formatText(label: string, session: SessionReport): string {
  const headers = [
    `AGENT`,
    `MODEL(S)`,
    `CALLS`,
    `PEAK CTX`,
    `AVG CTX`,
    `COMPACT`,
    `MINUTES`,
    `$READ`,
    `$WRITE`,
    `$OUTPUT`,
    `$INPUT`,
    `$TOTAL`,
  ]
  const aligns: (`left` | `right`)[] = [
    `left`,
    `left`,
    `right`,
    `right`,
    `right`,
    `right`,
    `right`,
    `right`,
    `right`,
    `right`,
    `right`,
    `right`,
  ]
  const rows = session.agents.map((agent) => [
    agent.label +
    (agent.unpricedModels.length > 0 ? ` (unpriced: ${agent.unpricedModels.join(`, `)})` : ``),
    agent.models.join(`, `) || `-`,
    String(agent.calls),
    fmtK(agent.peakCtx),
    fmtK(agent.avgCtx),
    String(agent.compactions),
    agent.minutes.toFixed(1),
    fmtUSD(agent.cost.cacheRead),
    fmtUSD(agent.cost.cacheWrite),
    fmtUSD(agent.cost.output),
    fmtUSD(agent.cost.input),
    fmtUSD(agent.totalCost),
  ])
  const totalRow = [
    `TOTAL`,
    ``,
    ``,
    ``,
    ``,
    ``,
    ``,
    fmtUSD(session.total.cacheRead),
    fmtUSD(session.total.cacheWrite),
    fmtUSD(session.total.output),
    fmtUSD(session.total.input),
    fmtUSD(session.totalCost),
  ]

  const lines = padCells([headers, ...rows, totalRow], aligns)
  const table = [lines[0], ...lines.slice(1, -1), lines[lines.length - 1]].join(`\n`)
  const share = `share: read ${fmtPct(session.share.cacheRead)}  write ${
    fmtPct(session.share.cacheWrite)
  }  output ${fmtPct(session.share.output)}`
  const unpriced = session.unpricedModels.length > 0
    ? `\nUnpriced (cost excluded): ${session.unpricedModels.join(`, `)}`
    : ``

  return `${label}\n${table}\n${share}${unpriced}`
}

// ===== CLI =====

interface CliArgs {
  readonly since?: Date
  readonly until?: Date
  readonly json: boolean
  readonly targets: string[]
}

function parseTimestamp(value: string | undefined, flag: string): Date {
  if (!value) throw new Error(`${flag} needs a value`)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${flag} "${value}" is not a valid timestamp`)
  return date
}

function parseArgs(args: string[]): CliArgs {
  let since: Date | undefined
  let until: Date | undefined
  let json = false
  const targets: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === `--since`) since = parseTimestamp(args[++i], `--since`)
    else if (arg === `--until`) until = parseTimestamp(args[++i], `--until`)
    else if (arg === `--json`) json = true
    else if (arg.startsWith(`--`)) throw new Error(`unknown flag ${arg}`)
    else targets.push(arg)
  }

  if (targets.length === 0) {
    throw new Error(
      `usage: session-cost.ts [--since <ISO time>] [--until <ISO time>] [--json] <session-id | path>...`,
    )
  }
  return { since, until, json, targets }
}

async function main(): Promise<void> {
  const { since, until, json, targets } = parseArgs(Deno.args)
  const home = Deno.env.get(`HOME`)
  if (!home) throw new Error(`HOME is not set`)
  const projectsDir = join(home, `.claude`, `projects`)

  for (const target of targets) {
    const location = await resolveSession(projectsDir, target)
    const session = await loadSessionReport(location, { since, until })
    console.log(
      json ? JSON.stringify({ session: target, ...session }, null, 2) : formatText(target, session),
    )
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    Deno.exit(1)
  }
}
