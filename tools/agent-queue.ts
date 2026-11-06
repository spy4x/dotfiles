// The background lead's queue: which issues it works on, in which order, picked in code from
// GitHub, never by a model. `agent-run tick` calls it. Design: docs/headless-runs.md, "The tick".

import { join } from "jsr:@std/path@^1.0.0"
import type { SqliteDb } from "@spy4x/server/db/sqlite"
import type { Deps } from "./agent-run.ts"

/** Failed runs on one item before it is blocked. */
export const MAX_ATTEMPTS = 2
/** A plan older than this is made again. */
export const PLAN_MAX_AGE_MS = 7 * 86400_000
/** The repository of tooling and flow fixes, candidates at any time at `p2-high`. */
export const TOOLING_REPO = `spy4x/dotfiles`
/** Labels that keep an issue out of the queue everywhere. */
const NEVER = [`manual`, `needs-decision`, `in-progress`]
/** Labels that keep an issue out of the queue outside a milestone. */
const LOW = [`p4-low`, `p5-someday`]

/** An open issue as `gh issue list --json number,title,labels,author,milestone,createdAt` gives it. */
export interface Issue {
  number: number
  title: string
  labels: { name: string }[]
  author: { login: string }
  milestone: { title: string } | null
  createdAt: string
}

/** An open milestone as `gh api repos/<repo>/milestones` gives it. */
export interface Milestone {
  number: number
  title: string
  due_on: string | null
}

/** One planned item: `owner/repo#n`, its title and the group that picked it. */
export interface Candidate {
  issue: string
  title: string
  source: string
}

/** One row of the `queue` table. */
export interface QueueItem extends Candidate {
  rank: number
  status: string
  reason: string | null
  /** The last parked run's handoff, carried in full by the next run's brief. */
  handoff: string | null
  attempts: number
  leaseUntil: string | null
  runId: string | null
}

/** What GitHub says about the focus repository, read on every tick. */
export interface FocusState {
  repo: string
  issues: Issue[]
  milestones: Milestone[]
}

// ===== Pure parts =====

/** The "## Focus now" section of `direction.md`, up to the next `## ` heading. */
export function focusSection(direction: string): string {
  const start = direction.indexOf(`## Focus now`)
  if (start < 0) return ``
  const next = direction.indexOf(`\n## `, start + 1)
  return direction.slice(start, next < 0 ? undefined : next)
}

/** `spy4x/<first bold word of "## Focus now", lower-cased>`, or `null` when there is none. */
export function focusRepo(direction: string): string | null {
  const bold = /\*\*([A-Za-z0-9_.-]+)/.exec(focusSection(direction))
  return bold ? `spy4x/${bold[1].toLowerCase()}` : null
}

/** Hex SHA-256 of `text`. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, `0`)).join(``)
}

/** Open milestones, due first, undated last. */
export function byDue(milestones: Milestone[]): Milestone[] {
  const due = (m: Milestone) => m.due_on === null ? Infinity : Date.parse(m.due_on)
  return [...milestones].sort((a, b) => due(a) - due(b) || a.number - b.number)
}

/** The hash of the current (due-first) milestone's title and open issue numbers. */
export function milestoneHash(state: FocusState): Promise<string> {
  const current = byDue(state.milestones)[0]
  if (!current) return sha256(`none`)
  const numbers = state.issues.filter((i) => i.milestone?.title === current.title)
    .map((i) => i.number).sort((a, b) => a - b)
  return sha256(`${current.title}:${numbers.join(`,`)}`)
}

/**
 * Whether an issue may be queued: by `spy4x`, without `manual`, `needs-decision` or
 * `in-progress`, and outside a milestone not at `p4-low` or `p5-someday`. `ours` tolerates
 * `in-progress`: the label of the loop's own earlier claim on that issue.
 */
export function isCandidate(issue: Issue, inMilestone: boolean, ours = false): boolean {
  if (issue.author.login !== `spy4x`) return false
  const labels = issue.labels.map((label) => label.name)
  const never = ours ? NEVER.filter((name) => name !== `in-progress`) : NEVER
  if (labels.some((name) => never.includes(name))) return false
  return inMilestone || !labels.some((name) => LOW.includes(name))
}

const hasLabel = (issue: Issue, name: string) => issue.labels.some((label) => label.name === name)
const oldestFirst = <T extends { createdAt: string }>(list: T[]) =>
  [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

/**
 * The plan, in order, each group oldest first and no issue twice: `p1-critical` in the focus and
 * tooling repositories; `p2-high` tooling fixes; the due-first milestone that still has an issue
 * neither blocked, claimed nor done in the queue (later ones when it has none); then the focus
 * repository's backlog at `p2-high`, `p3-medium` or no priority. `statuses` maps queue items to
 * their status; `ours` are items an earlier tick claimed, whose `in-progress` label is its own.
 */
export function buildPlan(
  focus: FocusState,
  tooling: Issue[],
  statuses: Map<string, string>,
  ours: Set<string>,
): Candidate[] {
  const plan: Candidate[] = []
  const seen = new Set<string>()
  const key = (repo: string, issue: Issue) => `${repo}#${issue.number}`
  const fits = (repo: string, issue: Issue, inMilestone: boolean) =>
    isCandidate(issue, inMilestone, ours.has(key(repo, issue)))
  const add = (repo: string, issue: Issue, source: string) => {
    const id = key(repo, issue)
    if (seen.has(id)) return
    seen.add(id)
    plan.push({ issue: id, title: issue.title, source })
  }
  const tagged = [
    ...focus.issues.map((issue) => ({ repo: focus.repo, issue, createdAt: issue.createdAt })),
    ...(focus.repo === TOOLING_REPO ? [] : tooling).map((issue) => ({
      repo: TOOLING_REPO,
      issue,
      createdAt: issue.createdAt,
    })),
  ]
  for (const { repo, issue } of oldestFirst(tagged)) {
    if (hasLabel(issue, `p1-critical`) && fits(repo, issue, false)) add(repo, issue, `p1`)
  }
  for (const issue of oldestFirst(tooling)) {
    if (hasLabel(issue, `p2-high`) && fits(TOOLING_REPO, issue, false)) {
      add(TOOLING_REPO, issue, `tooling`)
    }
  }
  for (const milestone of byDue(focus.milestones)) {
    const issues = oldestFirst(focus.issues).filter((issue) =>
      issue.milestone?.title === milestone.title && fits(focus.repo, issue, true)
    )
    const open = issues.some((issue) => {
      const id = key(focus.repo, issue)
      return !seen.has(id) && ![`blocked`, `claimed`, `done`].includes(statuses.get(id) ?? ``)
    })
    if (!open) continue
    for (const issue of issues) add(focus.repo, issue, `milestone:${milestone.title}`)
    break
  }
  for (const issue of oldestFirst(focus.issues)) {
    const priority = issue.labels.find((label) => /^p\d-/.test(label.name))?.name
    const level = priority === undefined || [`p2-high`, `p3-medium`].includes(priority)
    if (level && fits(focus.repo, issue, false)) add(focus.repo, issue, `backlog`)
  }
  return plan
}

// ===== GitHub =====

async function gh<T>(deps: Deps, args: string[]): Promise<T> {
  const out = await deps.run([`gh`, ...args])
  if (!out.success) throw new Error(`gh ${args.slice(0, 2).join(` `)} failed: ${out.stderr}`)
  return JSON.parse(out.stdout) as T
}

/** Open issues of one repository. */
export function listIssues(deps: Deps, repo: string): Promise<Issue[]> {
  return gh<Issue[]>(deps, [
    `issue`,
    `list`,
    `-R`,
    repo,
    `--state`,
    `open`,
    `--limit`,
    `1000`,
    `--json`,
    `number,title,labels,author,milestone,createdAt`,
  ])
}

/** Every milestone of one repository; `state` is `open` or `all`. */
export function listMilestones(
  deps: Deps,
  repo: string,
  state = `open`,
): Promise<(Milestone & { open_issues: number })[]> {
  return gh(deps, [`api`, `repos/${repo}/milestones?state=${state}&per_page=100`])
}

/** The focus repository's open issues and milestones. */
export async function readFocus(deps: Deps, repo: string): Promise<FocusState> {
  return {
    repo,
    issues: await listIssues(deps, repo),
    milestones: await listMilestones(deps, repo),
  }
}

/** Why a queued item may no longer be worked on, or `null` when it still may. */
export async function recheck(deps: Deps, item: QueueItem): Promise<string | null> {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(item.issue)
  if (!match) return `not an issue reference`
  const issue = await gh<Issue & { state: string }>(deps, [
    `issue`,
    `view`,
    match[2],
    `-R`,
    match[1],
    `--json`,
    `number,title,labels,author,milestone,createdAt,state`,
  ]).catch(() => null)
  if (!issue) return `gh could not read it`
  if (issue.state !== `OPEN`) return `closed`
  const inMilestone = item.source.startsWith(`milestone:`)
  if (!isCandidate(issue, inMilestone, item.runId !== null)) return `no longer a candidate`
  return null
}

// ===== Database =====

/** The queue's and the loop's state tables (the contract in issue #257's wave). */
export const QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS queue (
  issue TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  rank INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  handoff TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  run_id TEXT,
  planned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`

/** One `meta` value, or `null`. */
export async function getMeta(db: SqliteDb, key: string): Promise<string | null> {
  const row = await db.queryOne(`SELECT value FROM meta WHERE key = ?`, key)
  return row ? String(row.value) : null
}

/** Set a `meta` value; `null` removes it. */
export async function setMeta(db: SqliteDb, key: string, value: string | null): Promise<void> {
  if (value === null) await db.execute(`DELETE FROM meta WHERE key = ?`, key)
  else {
    await db.execute(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    )
  }
}

function rowToItem(row: Record<string, unknown>): QueueItem {
  return {
    issue: row.issue as string,
    title: row.title as string,
    source: row.source as string,
    rank: Number(row.rank),
    status: row.status as string,
    reason: (row.reason as string | null) ?? null,
    handoff: (row.handoff as string | null) ?? null,
    attempts: Number(row.attempts),
    leaseUntil: (row.lease_until as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
  }
}

/** Queue items, optionally of one status, lowest rank first. */
export async function queueItems(db: SqliteDb, status?: string): Promise<QueueItem[]> {
  const rows = status
    ? await db.queryAll(`SELECT * FROM queue WHERE status = ? ORDER BY rank, issue`, status)
    : await db.queryAll(`SELECT * FROM queue ORDER BY rank, issue`)
  return rows.map(rowToItem)
}

/** The item a run claimed, or `null`. */
export async function itemOfRun(db: SqliteDb, runId: string): Promise<QueueItem | null> {
  const row = await db.queryOne(`SELECT * FROM queue WHERE run_id = ?`, runId)
  return row ? rowToItem(row) : null
}

/**
 * Set an item's status, reason and handoff (`null` unless given, so any status but a parked one
 * clears it); the other fields stay unless given.
 */
export async function setItem(
  db: SqliteDb,
  deps: Deps,
  issue: string,
  fields: {
    status: string
    reason?: string | null
    handoff?: string | null
    rank?: number
    attempts?: number
  },
): Promise<void> {
  await db.execute(
    `UPDATE queue SET status = ?, reason = ?, handoff = ?, rank = COALESCE(?, rank),
       attempts = COALESCE(?, attempts), lease_until = NULL, updated_at = ? WHERE issue = ?`,
    fields.status,
    fields.reason ?? null,
    fields.handoff ?? null,
    fields.rank ?? null,
    fields.attempts ?? null,
    deps.now().toISOString(),
    issue,
  )
}

/** Count one failed attempt: back to `queued`, or `blocked` at `MAX_ATTEMPTS`. */
export async function failAttempt(
  db: SqliteDb,
  deps: Deps,
  item: QueueItem,
  reason: string,
): Promise<void> {
  const attempts = item.attempts + 1
  const status = attempts >= MAX_ATTEMPTS ? `blocked` : `queued`
  await setItem(db, deps, item.issue, { status, reason, attempts })
}

/** Claim an item for a run until `leaseUntil`. */
export async function claim(
  db: SqliteDb,
  deps: Deps,
  issue: string,
  runId: string,
  leaseUntil: Date,
): Promise<void> {
  await db.execute(
    `UPDATE queue SET status = 'claimed', lease_until = ?, run_id = ?, updated_at = ?
      WHERE issue = ?`,
    leaseUntil.toISOString(),
    runId,
    deps.now().toISOString(),
    issue,
  )
}

/** The "## Focus now" hash, the focus repository and the text, from `direction.md`. */
export async function readDirection(deps: Deps) {
  const text = await deps.fs.readText(join(deps.memory, `direction.md`)) ?? ``
  return { repo: focusRepo(text), focusHash: await sha256(focusSection(text)) }
}

/**
 * Why the queue must be planned again, or `null`: no queued item, another "Focus now", another
 * current milestone or set of its issues, or a plan 7 days old.
 */
export async function replanReason(
  db: SqliteDb,
  deps: Deps,
  focusHash: string,
  focus: FocusState,
): Promise<string | null> {
  if ((await queueItems(db, `queued`)).length === 0) return `no queued item`
  if (await getMeta(db, `plan_focus_hash`) !== focusHash) return `"Focus now" changed`
  if (await getMeta(db, `plan_milestone_hash`) !== await milestoneHash(focus)) {
    return `the milestone's issues changed`
  }
  const planned = await getMeta(db, `planned_at`)
  if (!planned || deps.now().getTime() - Date.parse(planned) >= PLAN_MAX_AGE_MS) {
    return `the plan is 7 days old`
  }
  return null
}

/**
 * Plan again and store it: existing items get the new rank, title and source and keep their
 * status, attempts and reason (a parked item keeps rank 0, a dropped one is queued again); new
 * ones are queued; queued items no longer planned are dropped. Returns the plan's length.
 */
export async function replan(
  db: SqliteDb,
  deps: Deps,
  focusHash: string,
  focus: FocusState,
): Promise<number> {
  const items = await queueItems(db)
  const statuses = new Map(items.map((item) => [item.issue, item.status]))
  const ours = new Set(items.filter((item) => item.runId !== null).map((item) => item.issue))
  const tooling = focus.repo === TOOLING_REPO ? [] : await listIssues(deps, TOOLING_REPO)
  const plan = buildPlan(focus, tooling, statuses, ours)
  const now = deps.now().toISOString()
  for (const [index, candidate] of plan.entries()) {
    if (statuses.has(candidate.issue)) {
      await db.execute(
        `UPDATE queue SET
           rank = CASE WHEN status = 'queued' AND rank = 0 THEN 0 ELSE ? END,
           title = ?, source = ?, planned_at = ?, updated_at = ?,
           reason = CASE WHEN status = 'dropped' THEN NULL ELSE reason END,
           status = CASE WHEN status = 'dropped' THEN 'queued' ELSE status END
         WHERE issue = ?`,
        index + 1,
        candidate.title,
        candidate.source,
        now,
        now,
        candidate.issue,
      )
    } else {
      await db.execute(
        `INSERT INTO queue (issue, title, source, rank, status, planned_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
        candidate.issue,
        candidate.title,
        candidate.source,
        index + 1,
        now,
        now,
      )
    }
  }
  const planned = new Set(plan.map((candidate) => candidate.issue))
  for (const item of items) {
    if (item.status === `queued` && !planned.has(item.issue)) {
      await setItem(db, deps, item.issue, { status: `dropped`, reason: `no longer a candidate` })
    }
  }
  await setMeta(db, `plan_focus_hash`, focusHash)
  await setMeta(db, `plan_milestone_hash`, await milestoneHash(focus))
  await setMeta(db, `planned_at`, now)
  return plan.length
}
