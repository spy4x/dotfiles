// What the "Needs you" banner lists: facts in, items out, no database and no markup.

import { DAILY_BUDGET_USD, RUN_ALERT_USD } from "../agent-budget.ts"

const DAY_MS = 24 * 60 * 60 * 1000

/** A run as the banner sees it. */
export interface BannerRun {
  id: string
  /** `owner/repo#n`, when the run worked on an issue. */
  issue: string | null
  status: string
  startedAt: string
  costUsd: number
}

/** Everything the banner decides from, read by the caller. A `null` list means "could not read". */
export interface BannerFacts {
  now: number
  /** The `meta.paused` reason; `null` when the lead runs. */
  paused: string | null
  /** Spend of the current local day; `null` when unknown. */
  todayUsd: number | null
  runs: readonly BannerRun[] | null
  blockedIssues: readonly string[] | null
  /** End times (`to_at`) of stalls. */
  stalls: readonly string[] | null
  /** The newest imported session time; `null` when nothing was ever imported. */
  lastImport: string | null
}

/** One line of the banner. */
export type BannerItem =
  | { kind: `paused`; reason: string }
  | { kind: `over-budget`; todayUsd: number }
  /** A recent run that failed, cost over `RUN_ALERT_USD`, or both: one line per run. */
  | { kind: `run`; run: BannerRun; failed: boolean; expensive: boolean }
  | { kind: `blocked`; issue: string }
  | { kind: `stalls`; count: number }
  | { kind: `stale-import`; lastImport: string | null }

/** The banner: `danger` when an item stops or wastes money, `warning` otherwise. */
export interface Banner {
  tone: `danger` | `warning`
  items: BannerItem[]
}

/** Run statuses that mean the run ended badly; `agent-run` pushes these as urgent. */
export const FAILED_STATUSES = [`failed`, `timeout`, `budget`, `turns`]
const URGENT_KINDS = new Set<BannerItem[`kind`]>([
  `paused`,
  `over-budget`,
  `run`,
])

/**
 * What needs the owner, most urgent first; `null` when nothing does. Runs count when they started
 * in the last 24 hours, stalls when they ended in the last 24 hours. An import older than a day, or
 * none at all, is stale.
 */
export function needsYou(facts: BannerFacts): Banner | null {
  const since = facts.now - DAY_MS
  const recent = (iso: string) => Date.parse(iso) >= since
  const items: BannerItem[] = []
  if (facts.paused !== null) items.push({ kind: `paused`, reason: facts.paused })
  if (facts.todayUsd !== null && facts.todayUsd >= DAILY_BUDGET_USD) {
    items.push({ kind: `over-budget`, todayUsd: facts.todayUsd })
  }
  const runs = (facts.runs ?? []).filter((run) => recent(run.startedAt))
  for (const run of runs) {
    const failed = FAILED_STATUSES.includes(run.status)
    const expensive = run.costUsd > RUN_ALERT_USD
    if (failed || expensive) items.push({ kind: `run`, run, failed, expensive })
  }
  for (const issue of facts.blockedIssues ?? []) items.push({ kind: `blocked`, issue })
  const stalls = (facts.stalls ?? []).filter(recent).length
  if (stalls > 0) items.push({ kind: `stalls`, count: stalls })
  if (facts.lastImport === null || !recent(facts.lastImport)) {
    items.push({ kind: `stale-import`, lastImport: facts.lastImport })
  }
  if (items.length === 0) return null
  return { tone: items.some((item) => URGENT_KINDS.has(item.kind)) ? `danger` : `warning`, items }
}
