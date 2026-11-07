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

/** The fields `gh issue list` and `gh issue view` read for an issue. */
const ISSUE_FIELDS = `number,title,labels,author,milestone,createdAt,updatedAt`

/** An open issue as `gh issue list --json <ISSUE_FIELDS>` gives it. */
export interface Issue {
  number: number
  title: string
  labels: { name: string }[]
  author: { login: string }
  milestone: { title: string } | null
  createdAt: string
  updatedAt: string
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

/**
 * `spy4x/<name>` for every one-word bold name of "## Focus now" (`**Financy**`), lower-cased, in
 * the order listed and each once; bold phrases with a space are prose, not projects.
 */
export function focusRepos(direction: string): string[] {
  const names = [...focusSection(direction).matchAll(/\*\*([A-Za-z0-9_.-]+)\*\*/g)]
  return [...new Set(names.map((bold) => `spy4x/${bold[1].toLowerCase()}`))]
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
 * The hash of the candidates that may join the plan at any time: `p1-critical` in the focus and
 * tooling repositories, and `p2-high` tooling fixes. A new one re-plans the queue.
 */
export function urgentHash(focus: FocusState[], tooling: Issue[]): Promise<string> {
  const tagged = [
    ...focus.flatMap((state) => state.issues.map((issue) => ({ repo: state.repo, issue }))),
    ...tooling.map((issue) => ({ repo: TOOLING_REPO, issue })),
  ]
  const ids = tagged.filter(({ repo, issue }) =>
    isCandidate(issue, false) &&
    (hasLabel(issue, `p1-critical`) || (repo === TOOLING_REPO && hasLabel(issue, `p2-high`)))
  ).map(({ repo, issue }) => `${repo}#${issue.number}`)
  return sha256([...new Set(ids)].sort().join(`,`))
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

function hasLabel(issue: Issue, name: string): boolean {
  return issue.labels.some((label) => label.name === name)
}

/** Queue statuses that leave nothing to take in a milestone. */
const SETTLED = [`blocked`, `claimed`, `done`, `declined`]

const oldestFirst = <T extends { createdAt: string }>(list: T[]) =>
  [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

/**
 * The plan, in order, each group oldest first and no issue twice: `p1-critical` in the focus and
 * tooling repositories; `p2-high` tooling fixes; the due-first milestone that still has an issue
 * neither blocked, claimed, done nor declined in the queue (later ones when it has none); then the
 * focus repository's backlog: issues in no milestone at `p2-high`, `p3-medium` or no priority. An
 * issue in a milestone that is not the current one is never planned. `statuses` maps queue items to
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
      return !seen.has(id) && !SETTLED.includes(statuses.get(id) ?? ``)
    })
    if (!open) continue
    for (const issue of issues) add(focus.repo, issue, `milestone:${milestone.title}`)
    break
  }
  for (const issue of oldestFirst(focus.issues)) {
    if (issue.milestone !== null) continue
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
    ISSUE_FIELDS,
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

/** One focus repository's open issues and milestones. */
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
    `${ISSUE_FIELDS},state`,
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
 * Set an item's status and reason (`null` unless given); the handoff and the other fields stay
 * unless given, so the last handoff survives a run that ends without writing its own.
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
    `UPDATE queue SET status = ?, reason = ?, handoff = CASE WHEN ? THEN ? ELSE handoff END,
       rank = COALESCE(?, rank), attempts = COALESCE(?, attempts), lease_until = NULL,
       updated_at = ? WHERE issue = ?`,
    fields.status,
    fields.reason ?? null,
    fields.handoff === undefined ? 0 : 1,
    fields.handoff ?? null,
    fields.rank ?? null,
    fields.attempts ?? null,
    deps.now().toISOString(),
    issue,
  )
}

/**
 * Count one failed attempt: back to `queued`, or `blocked` at `MAX_ATTEMPTS`. The item keeps its
 * handoff unless the failed run wrote a new one.
 */
export async function failAttempt(
  db: SqliteDb,
  deps: Deps,
  item: QueueItem,
  reason: string,
  handoff?: string,
): Promise<void> {
  const attempts = item.attempts + 1
  const status = attempts >= MAX_ATTEMPTS ? `blocked` : `queued`
  await setItem(db, deps, item.issue, { status, reason, attempts, handoff })
}

/** Give the item `runId` claimed back to the queue untouched, when that run never started. */
export async function release(db: SqliteDb, deps: Deps, runId: string): Promise<void> {
  await db.execute(
    `UPDATE queue SET status = 'queued', lease_until = NULL, run_id = NULL, updated_at = ?
      WHERE run_id = ? AND status = 'claimed'`,
    deps.now().toISOString(),
    runId,
  )
}

/**
 * Claim a queued item for a run until `leaseUntil`. Returns whether this call won it: the one
 * `UPDATE` changes nothing when another tick claimed the item first.
 */
export async function claim(
  db: SqliteDb,
  deps: Deps,
  issue: string,
  runId: string,
  leaseUntil: Date,
): Promise<boolean> {
  const { changes } = await db.execute(
    `UPDATE queue SET status = 'claimed', lease_until = ?, run_id = ?, updated_at = ?
      WHERE issue = ? AND status = 'queued'`,
    leaseUntil.toISOString(),
    runId,
    deps.now().toISOString(),
    issue,
  )
  return Number(changes) === 1
}

/** The "## Focus now" hash and its focus repositories, from `direction.md`. */
export async function readDirection(deps: Deps) {
  const text = await deps.fs.readText(join(deps.memory, `direction.md`)) ?? ``
  return { repos: focusRepos(text), focusHash: await sha256(focusSection(text)) }
}

/** Every focus repository's milestone hash, in order; one repository's alone is its own hash. */
async function milestoneHashes(focus: FocusState[]): Promise<string> {
  return (await Promise.all(focus.map(milestoneHash))).join(`,`)
}

/**
 * Why the queue must be planned again, or `null`: no queued item, another "Focus now", another
 * current milestone or set of its issues, another set of `p1-critical` or `p2-high` tooling
 * candidates, or a plan 7 days old.
 */
export async function replanReason(
  db: SqliteDb,
  deps: Deps,
  focusHash: string,
  focus: FocusState[],
  tooling: Issue[],
): Promise<string | null> {
  if ((await queueItems(db, `queued`)).length === 0) return `no queued item`
  if (await getMeta(db, `plan_focus_hash`) !== focusHash) return `"Focus now" changed`
  if (await getMeta(db, `plan_milestone_hash`) !== await milestoneHashes(focus)) {
    return `the milestone's issues changed`
  }
  if (await getMeta(db, `plan_urgent_hash`) !== await urgentHash(focus, tooling)) {
    return `the p1-critical or tooling issues changed`
  }
  const planned = await getMeta(db, `planned_at`)
  if (!planned || deps.now().getTime() - Date.parse(planned) >= PLAN_MAX_AGE_MS) {
    return `the plan is 7 days old`
  }
  return null
}

/**
 * Queue a declined item again when its issue's `updatedAt` on GitHub is later than the item's own
 * `updated_at`: a new milestone, label, comment or edit since the lead declined it, or since the
 * last plan (every plan stamps the items it keeps).
 */
async function requeueUpdated(
  db: SqliteDb,
  deps: Deps,
  focus: FocusState[],
  tooling: Issue[],
): Promise<void> {
  const updated = new Map<string, string>()
  for (const { repo, issues } of [...focus, { repo: TOOLING_REPO, issues: tooling }]) {
    for (const issue of issues) {
      updated.set(`${repo}#${issue.number}`, new Date(issue.updatedAt).toISOString())
    }
  }
  for (const item of await queueItems(db, `declined`)) {
    const at = updated.get(item.issue)
    if (!at) continue
    await db.execute(
      `UPDATE queue SET status = 'queued', reason = NULL, updated_at = ?
        WHERE issue = ? AND status = 'declined' AND updated_at < ?`,
      deps.now().toISOString(),
      item.issue,
      at,
    )
  }
}

/**
 * One plan for several focus repositories: each one's `buildPlan` in the order listed, the
 * tooling groups with the first only, and no issue twice. One repository's plan is its own.
 */
export function buildPlans(
  focus: FocusState[],
  tooling: Issue[],
  statuses: Map<string, string>,
  ours: Set<string>,
): Candidate[] {
  const plan = focus.flatMap((state, index) =>
    buildPlan(state, index === 0 ? tooling : [], statuses, ours)
  )
  return plan.filter((candidate, index) =>
    plan.findIndex((other) => other.issue === candidate.issue) === index
  )
}

/**
 * Plan again and store it. A declined item whose issue was updated on GitHub since it was declined
 * (or since the last plan) is queued again first. Then existing items get the new rank, title and
 * source and keep their status, attempts and reason (a parked item keeps rank 0, a dropped one is
 * queued again); new ones are queued; queued items no longer planned are dropped. `tooling` is
 * spy4x/dotfiles' open issues, empty when it is the first focus repository. Returns the plan's
 * length.
 */
export async function replan(
  db: SqliteDb,
  deps: Deps,
  focusHash: string,
  focus: FocusState[],
  tooling: Issue[],
): Promise<number> {
  await requeueUpdated(db, deps, focus, tooling)
  const items = await queueItems(db)
  const statuses = new Map(items.map((item) => [item.issue, item.status]))
  const ours = new Set(items.filter((item) => item.runId !== null).map((item) => item.issue))
  const plan = buildPlans(focus, tooling, statuses, ours)
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
      await setItem(db, deps, item.issue, {
        status: `dropped`,
        reason: `no longer a candidate`,
        handoff: null,
      })
    }
  }
  await setMeta(db, `plan_focus_hash`, focusHash)
  await setMeta(db, `plan_milestone_hash`, await milestoneHashes(focus))
  await setMeta(db, `plan_urgent_hash`, await urgentHash(focus, tooling))
  await setMeta(db, `planned_at`, now)
  return plan.length
}
