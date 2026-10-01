#!/usr/bin/env -S deno run -A
// Turns Claude Code subagent transcripts into one JSONL row per lane (see `schema.ts`).
//
// Usage:
//   deno task experiment:collect --out <lanes.jsonl> [--since <ISO>] [--until <ISO>] \
//     [--projects <dir>] [--dotfiles <git dir>] [--dotfiles-ref <ref>]
//
// Lanes are dated by the timestamps of their own messages, never by file modification time.
// A `gh` or `git` call that fails stops the run with a non-zero exit: carrying on would report
// zero merged PRs instead of an error. So does a call on a model with no price, which would
// otherwise count as $0.

import { join } from "jsr:@std/path@1.1.6"
import { denoExec, type Exec } from "./exec.ts"
import {
  dominantModel,
  isPriced,
  issuesInBrief,
  type LaneScan,
  modelCounts,
  peakContext,
  priceCalls,
  reviewerCandidates,
  reviewRounds,
  scanTranscript,
  taskClassOf,
  tokenCounts,
  worktreeBranches,
} from "./lane.ts"
import { type LaneRow, type PrInfo, type ReviewRound, SCHEMA_VERSION } from "./schema.ts"

/** Lanes made calls on a model the price table does not know. */
export class UnpricedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = `UnpricedError`
  }
}

const IMPLEMENTERS = new Set([`implementer`, `implementer-xhigh`])
const REVIEWERS = new Set([`reviewer`, `reviewer-xhigh`, `reviewer-max`])

/** Options of one collection run. */
export interface CollectOptions {
  /** `~/.claude/projects`, or a copy of its layout. */
  readonly projectsDir: string
  /** Lanes whose first call is before this ISO time are left out. */
  readonly since?: string
  /** Lanes whose first call is at or after this ISO time are left out. */
  readonly until?: string
  /** A git checkout of the dotfiles repo, for the commit live at each lane's spawn. */
  readonly dotfilesDir?: string
  readonly dotfilesRef?: string
  readonly exec: Exec
}

interface Candidate {
  readonly metaPath: string
  readonly transcriptPath: string
  readonly project: string
  readonly session: string
  readonly agentId: string
  readonly agentType: string
  readonly description: string
  readonly requestedModel: string | null
}

async function readDirNames(path: string): Promise<string[]> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(path)) names.push(entry.name)
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound) && !(error instanceof Deno.errors.NotADirectory)) {
      throw error
    }
  }
  return names.sort()
}

async function findCandidates(projectsDir: string): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const project of await readDirNames(projectsDir)) {
    for (const session of await readDirNames(join(projectsDir, project))) {
      const dir = join(projectsDir, project, session, `subagents`)
      for (const name of await readDirNames(dir)) {
        const m = name.match(/^agent-(.+)\.meta\.json$/)
        if (!m) continue
        let meta: Record<string, unknown>
        try {
          meta = JSON.parse(await Deno.readTextFile(join(dir, name)))
        } catch {
          continue
        }
        const agentType = String(meta.agentType ?? ``)
        if (!IMPLEMENTERS.has(agentType) && !REVIEWERS.has(agentType)) continue
        const description = String(meta.description ?? ``)
        if (REVIEWERS.has(agentType) && /\baudit/i.test(description)) continue
        out.push({
          metaPath: join(dir, name),
          transcriptPath: join(dir, `agent-${m[1]}.jsonl`),
          project,
          session,
          agentId: m[1],
          agentType,
          description,
          requestedModel: typeof meta.model === `string` ? meta.model : null,
        })
      }
    }
  }
  return out
}

/** The dotfiles commits on the default branch, newest first. */
export interface DotfilesCommit {
  readonly sha: string
  readonly committedAt: string
}

/** Reads the first-parent history of `ref` in the git checkout at `dir`. */
export async function readDotfilesCommits(
  exec: Exec,
  dir: string,
  ref: string,
): Promise<DotfilesCommit[]> {
  const out = await exec(`git`, [`-C`, dir, `log`, `--first-parent`, `--format=%H%x09%cI`, ref])
  return out.split(`\n`).filter(Boolean).map((l) => {
    const [sha, committedAt] = l.split(`\t`)
    return { sha, committedAt }
  })
}

/** The newest commit made at or before `ts`, or null when none is that old. */
export function commitAt(commits: readonly DotfilesCommit[], ts: string): string | null {
  const at = Date.parse(ts)
  for (const c of commits) if (Date.parse(c.committedAt) <= at) return c.sha
  return null
}

const PR_FIELDS =
  `additions,deletions,state,mergedAt,createdAt,title,changedFiles,headRefName,closingIssuesReferences`

/** Runs `tasks` with at most `limit` in flight, keeping the results in order. */
async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await task(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Collects lanes. Every failed `gh` or `git` call rejects with a `CommandError`, and a call on a
 * model with no price rejects with an `UnpricedError`, so a caller never gets a partial result.
 */
export async function collect(options: CollectOptions): Promise<LaneRow[]> {
  const { exec } = options
  const commits = options.dotfilesDir
    ? await readDotfilesCommits(exec, options.dotfilesDir, options.dotfilesRef ?? `origin/main`)
    : []

  // 1. Read every candidate transcript and keep lanes that started inside the window.
  interface Lane {
    c: Candidate
    scan: LaneScan
    model: string
    models: Record<string, number>
    start: string
    end: string
  }
  const lanes: Lane[] = []
  for (const c of await findCandidates(options.projectsDir)) {
    let text: string
    try {
      text = await Deno.readTextFile(c.transcriptPath)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue
      throw error
    }
    const scan = scanTranscript(text.split(`\n`))
    if (scan.calls.length === 0) continue
    const stamps = scan.calls.map((x) => x.timestamp).sort()
    const start = stamps[0]
    if (options.since && Date.parse(start) < Date.parse(options.since)) continue
    if (options.until && Date.parse(start) >= Date.parse(options.until)) continue
    const models = modelCounts(scan.calls)
    lanes.push({ c, scan, model: dominantModel(models), models, start, end: stamps.at(-1)! })
  }

  // A call on a model with no price would count as $0 and make its arm look cheap: stop instead.
  const unpriced = new Map<string, { calls: number; lanes: number }>()
  for (const l of lanes) {
    for (const [model, n] of Object.entries(l.models)) {
      if (isPriced(model)) continue
      const seen = unpriced.get(model) ?? { calls: 0, lanes: 0 }
      unpriced.set(model, { calls: seen.calls + n, lanes: seen.lanes + 1 })
    }
  }
  if (unpriced.size > 0) {
    const list = [...unpriced].map(([m, u]) => `${m} (calls: ${u.calls}, lanes: ${u.lanes})`)
    throw new UnpricedError(
      `calls on models with no price: ${list.join(`, `)}. Their cost would read as $0. Add ` +
        `the price to PRICES in tools/session-cost.ts, or narrow the window with --since/--until.`,
    )
  }

  // 2. Implementer PRs: opened, else reported, else found by the branch the brief names.
  const ghCache = new Map<string, Promise<string>>()
  const gh = (args: string[]) => {
    const key = args.join(` `)
    if (!ghCache.has(key)) ghCache.set(key, exec(`gh`, args))
    return ghCache.get(key)!
  }
  const implementers = lanes.filter((l) => IMPLEMENTERS.has(l.c.agentType))
  const prsOf = new Map<Lane, { prs: string[]; source: LaneRow[`prSource`] }>()
  await pool(implementers, 6, async (l) => {
    if (l.scan.createdPrs.length > 0) {
      return void prsOf.set(l, { prs: l.scan.createdPrs, source: `create` })
    }
    if (l.scan.reportedPrs.length > 0) {
      return void prsOf.set(l, { prs: l.scan.reportedPrs, source: `report` })
    }
    const prs: string[] = []
    for (const { repo, branch } of worktreeBranches(l.scan.prompt)) {
      const out = await gh([
        `pr`,
        `list`,
        `-R`,
        `spy4x/${repo}`,
        `--head`,
        branch,
        `--state`,
        `all`,
        `--json`,
        `number`,
      ])
      for (const p of JSON.parse(out || `[]`) as { number: number }[]) {
        prs.push(`spy4x/${repo}#${p.number}`)
      }
      if (prs.length > 0) break
    }
    prsOf.set(l, { prs, source: prs.length > 0 ? `branch` : null })
  })

  const prInfo = new Map<string, PrInfo>()
  const allPrs = [...new Set([...prsOf.values()].flatMap((x) => x.prs))].sort()
  await pool(allPrs, 6, async (pr) => {
    const [repo, n] = pr.split(`#`)
    const out = await gh([`pr`, `view`, n, `-R`, repo, `--json`, PR_FIELDS])
    const j = JSON.parse(out) as Record<string, unknown>
    prInfo.set(pr, {
      additions: Number(j.additions),
      deletions: Number(j.deletions),
      state: String(j.state),
      mergedAt: (j.mergedAt as string | null) || null,
      createdAt: String(j.createdAt),
      title: String(j.title),
      headRefName: String(j.headRefName),
      closingIssues: ((j.closingIssuesReferences ?? []) as { number: number }[]).map((x) =>
        x.number
      ),
    })
  })

  // 3. Reviewer rounds, linked to PRs by URL, description or branch.
  const branchToPr = new Map<string, string>()
  for (const [pr, info] of prInfo) branchToPr.set(`${pr.split(`#`)[0]}/${info.headRefName}`, pr)
  const roundsOf = new Map<Lane, ReviewRound[]>()
  const reviews = new Map<string, ReviewRound[]>()
  for (const l of lanes.filter((x) => REVIEWERS.has(x.c.agentType))) {
    const cands = reviewerCandidates(l.scan, l.c.description, branchToPr)
    const rounds = reviewRounds(l.scan, cands, l.model)
    roundsOf.set(l, rounds)
    for (const r of rounds) if (r.pr) reviews.set(r.pr, [...(reviews.get(r.pr) ?? []), r])
  }
  for (const list of reviews.values()) list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))

  // 4. Rows.
  const rows: LaneRow[] = []
  for (const l of lanes) {
    const { cost } = priceCalls(l.scan.calls)
    const implementer = IMPLEMENTERS.has(l.c.agentType)
    const found = prsOf.get(l)
    const prs = found?.prs ?? []
    const worktrees = worktreeBranches(l.scan.prompt)
    const repo = prs[0]?.split(`#`)[0] ?? (worktrees[0] ? `spy4x/${worktrees[0].repo}` : null)
    const briefIssues = implementer ? issuesInBrief(l.scan.prompt, repo) : []
    // Closing references of the first PR in sorted order, as the reference pipeline read them.
    const closing = prs.length > 0 ? prInfo.get([...prs].sort()[0])!.closingIssues : []
    const issue = briefIssues.length > 0
      ? Math.min(...briefIssues)
      : closing.length > 0
      ? Math.min(...closing)
      : null
    const infos: Record<string, PrInfo> = {}
    const lanesReviews: Record<string, ReviewRound[]> = {}
    for (const pr of prs) {
      infos[pr] = prInfo.get(pr)!
      lanesReviews[pr] = reviews.get(pr) ?? []
    }
    const mergedLines = Object.values(infos)
      .filter((i) => i.state === `MERGED`)
      .reduce((sum, i) => sum + i.additions + i.deletions, 0)
    rows.push({
      schema: SCHEMA_VERSION,
      role: implementer ? `implementer` : `reviewer`,
      agentType: l.c.agentType,
      agentId: l.c.agentId,
      session: l.c.session,
      project: l.c.project,
      description: l.c.description,
      model: l.model,
      models: l.models,
      requestedModel: l.c.requestedModel,
      effort: l.scan.effort,
      repo,
      issue,
      issueSource: briefIssues.length > 0 ? `brief` : closing.length > 0 ? `closing-ref` : null,
      baseCommit: null,
      dotfilesCommit: options.dotfilesDir ? commitAt(commits, l.start) : null,
      taskClass: implementer
        ? taskClassOf([l.c.description, ...Object.values(infos).map((i) => i.title)].join(` `))
        : null,
      start: l.start,
      end: l.end,
      wallSeconds: Math.round((Date.parse(l.end) - Date.parse(l.start)) / 1000),
      calls: l.scan.calls.length,
      toolCalls: l.scan.toolCalls,
      tokens: tokenCounts(l.scan.calls),
      cost: Math.round(cost * 1e4) / 1e4,
      peakContext: peakContext(l.scan.calls),
      compactions: l.scan.compactions,
      prs,
      prSource: found?.source ?? null,
      prInfo: infos,
      mergedLines,
      reviews: implementer ? lanesReviews : {},
      rounds: roundsOf.get(l) ?? [],
    })
  }
  return rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
}

/** Serialises rows as JSON Lines. */
export function toJsonl(rows: readonly LaneRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join(`\n`) + `\n`
}

// ===== CLI =====

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

if (import.meta.main) {
  const args = Deno.args
  const out = flag(args, `--out`)
  if (!out) {
    console.error(
      `usage: collect.ts --out <lanes.jsonl> [--since ISO] [--until ISO] [--projects dir] [--dotfiles dir] [--dotfiles-ref ref]`,
    )
    Deno.exit(2)
  }
  const home = Deno.env.get(`HOME`)
  const projectsDir = flag(args, `--projects`) ??
    (home ? join(home, `.claude`, `projects`) : undefined)
  if (!projectsDir) {
    console.error(`no --projects given and $HOME is not set`)
    Deno.exit(2)
  }
  if (!flag(args, `--dotfiles`)) {
    console.error(
      `warning: no --dotfiles given, so every row gets dotfilesCommit null and rule changes cannot split the data`,
    )
  }
  try {
    const rows = await collect({
      projectsDir,
      since: flag(args, `--since`),
      until: flag(args, `--until`),
      dotfilesDir: flag(args, `--dotfiles`),
      dotfilesRef: flag(args, `--dotfiles-ref`),
      exec: denoExec,
    })
    await Deno.writeTextFile(out, toJsonl(rows))
    console.log(`wrote ${rows.length} lanes to ${out}`)
  } catch (error) {
    console.error(`collect failed: ${error instanceof Error ? error.message : error}`)
    Deno.exit(1)
  }
}
