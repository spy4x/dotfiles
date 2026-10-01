#!/usr/bin/env -S deno run -A
// The 14 and 30 day follow-up pass: what happened to each merged PR of a run after it landed.
//
// Usage: deno task experiment:followup <run folder> [--now <ISO>]
//
// Reads `<run folder>/lanes.jsonl`, takes every merged PR, and writes `followups.jsonl` next to
// it: one row per PR with, for the 14 and 30 day window after its merge,
//
// - reverts: a later merged PR or a later commit on the repo's default branch that reverts it. A
//   revert has the title `Revert "<the PR's title>"`, or a body with `This reverts commit <sha>`
//   (the sha is a prefix of the PR's merge commit) or `Reverts <owner/repo>#<number>`;
// - fixes: later merged PRs on the default branch that touch lines the PR changed, whatever
//   their type (`fixType` marks the ones titled `fix…`). See `touches` for "touch";
// - reopened: closing issues of the PR that got a `reopened` event after the merge.
//
// A window that has not elapsed at `--now` is `pending`, never an empty result. A `gh` call that
// fails stops the command with exit 1 and writes nothing: reading a failure as "no follow-ups"
// would make the worst PRs look clean.

import { join } from "jsr:@std/path@1.1.6"
import { parseRows } from "./analyse.ts"
import { CommandError, denoExec, type Exec } from "./exec.ts"
import { isoDateError } from "./collect.ts"
import type { LaneRow } from "./schema.ts"

/** Bump when a field of `followups.jsonl` changes meaning or is removed. */
export const FOLLOWUP_SCHEMA_VERSION = 1

/** The windows after a merge, in days. */
export const WINDOW_DAYS = [14, 30] as const

const DAY_MS = 86_400_000

/** An inclusive span of line numbers. */
export interface LineRange {
  readonly start: number
  readonly end: number
}

/** One file of a PR as `gh api repos/<repo>/pulls/<n>/files` lists it. */
export interface FileChange {
  readonly filename: string
  readonly previousFilename?: string
  /** `renamed`, `modified`, ...; a rename that changes no lines has no patch. */
  readonly status?: string
  /** Absent when GitHub omits it: a binary file or a diff too large to show. */
  readonly patch?: string
}

/** A later merged PR, with the files it changed. */
export interface LaterPr {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly mergedAt: string
  readonly mergeCommit: string | null
  readonly files: readonly FileChange[]
}

/** A later commit on the default branch. */
export interface LaterCommit {
  readonly sha: string
  readonly message: string
  readonly at: string
}

/** A `reopened` event on one of the PR's closing issues. */
export interface Reopen {
  /** `owner/repo#number`: a PR can close an issue of another repo. */
  readonly issue: string
  readonly at: string
}

/** A revert found in a window: a PR (`pr` set) or a direct commit (`sha` only). */
export interface RevertEvent {
  readonly pr: number | null
  readonly sha: string | null
  readonly title: string
  readonly at: string
}

/** A later PR that touched the original's lines. */
export interface FixEvent {
  readonly pr: number
  readonly title: string
  readonly at: string
  readonly fixType: boolean
  /** The files with overlapping lines. */
  readonly files: string[]
  /** False when a file had no patch to compare, so the whole file counted as touched. */
  readonly exact: boolean
}

/** What happened in one window. */
export interface WindowResult {
  readonly reverts: RevertEvent[]
  readonly fixes: FixEvent[]
  readonly reopened: Reopen[]
}

/** One line of `followups.jsonl`. */
export interface FollowupRow {
  readonly schema: typeof FOLLOWUP_SCHEMA_VERSION
  /** `owner/repo#number`. */
  readonly pr: string
  readonly title: string
  readonly mergedAt: string
  readonly mergeCommit: string | null
  readonly d14: WindowResult | `pending`
  readonly d30: WindowResult | `pending`
}

/** Everything `buildRow` needs about one merged PR; fetching it is the shell's job. */
export interface FollowupInput {
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly mergedAt: string
  readonly mergeCommit: string | null
  readonly files: readonly FileChange[]
  readonly laterPrs: readonly LaterPr[]
  readonly laterCommits: readonly LaterCommit[]
  readonly reopens: readonly Reopen[]
}

// ===== Pure logic =====

/**
 * One run of changed lines of a patch. `oldStart`/`oldLen` are the removed lines (before the
 * change), `newStart`/`newLen` the added ones (after). A pure insertion has `oldLen` 0 and sits
 * between old lines `oldStart - 1` and `oldStart`; a pure deletion has `newLen` 0 likewise.
 */
export interface Block {
  readonly oldStart: number
  readonly oldLen: number
  readonly newStart: number
  readonly newLen: number
}

/** The blocks of changed lines of a unified-diff patch. Context lines are not changes. */
export function parseBlocks(patch: string): Block[] {
  const blocks: Block[] = []
  let o = 0
  let n = 0
  let current: { oldStart: number; oldLen: number; newStart: number; newLen: number } | null = null
  const flush = () => {
    if (current) blocks.push(current)
    current = null
  }
  for (const line of patch.split(`\n`)) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      flush()
      // A zero count names the line before the hunk, so the first real line is one further.
      o = Number(hunk[1]) + (hunk[2] === `0` ? 1 : 0)
      n = Number(hunk[3]) + (hunk[4] === `0` ? 1 : 0)
    } else if (line.startsWith(`-`)) {
      current ??= { oldStart: o, oldLen: 0, newStart: n, newLen: 0 }
      current.oldLen++
      o++
    } else if (line.startsWith(`+`)) {
      current ??= { oldStart: o, oldLen: 0, newStart: n, newLen: 0 }
      current.newLen++
      n++
    } else if (line.startsWith(`\\`)) {
      continue // "\ No newline at end of file"
    } else {
      flush()
      o++
      n++
    }
  }
  flush()
  return blocks
}

/**
 * The changed lines of a unified-diff patch, as two sets of ranges: `old` (line numbers before
 * the change) and `new` (after). A run of removed lines is an `old` range, a run of added lines a
 * `new` range. A pure insertion has no old lines, so it counts on the old side as the two lines it
 * sits between; a pure deletion counts on the new side the same way.
 */
export function parsePatch(patch: string): { old: LineRange[]; new: LineRange[] } {
  const blocks = parseBlocks(patch)
  return {
    old: blocks.map((b) =>
      b.oldLen > 0
        ? { start: b.oldStart, end: b.oldStart + b.oldLen - 1 }
        : { start: b.oldStart - 1, end: b.oldStart }
    ),
    new: blocks.map((b) =>
      b.newLen > 0
        ? { start: b.newStart, end: b.newStart + b.newLen - 1 }
        : { start: b.newStart - 1, end: b.newStart }
    ),
  }
}

function overlaps(a: readonly LineRange[], b: readonly LineRange[]): boolean {
  return a.some((x) => b.some((y) => x.start <= y.end && y.start <= x.end))
}

/**
 * Files that say nothing about a PR's quality when they change: lockfiles, generated indexes and
 * golden fixtures. Matched against the whole path; such a file is left out of the comparison on
 * both sides. One list, so a repo's generated file is added here and nowhere else.
 */
export const GENERATED_FILES: readonly RegExp[] = [
  /(^|\/)deno\.lock$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /\.lock$/, // yarn.lock, Cargo.lock, bun.lock, ...
  /(^|\/)llms(-full)?\.txt$/,
  /(^|\/)(golden|goldens|__snapshots__)\//,
]

/** Whether `filename` is a lockfile, generated file or golden fixture (see `GENERATED_FILES`). */
export function isGenerated(filename: string): boolean {
  return GENERATED_FILES.some((re) => re.test(filename))
}

/** A pure rename: GitHub gives no patch because no line changed. */
const isBareRename = (f: FileChange) => f.status === `renamed` && f.patch === undefined

const WHOLE_FILE: LineRange = { start: 1, end: Number.MAX_SAFE_INTEGER }

/**
 * Where the lines of `ranges` are after a later patch with `blocks` was applied. Lines the patch
 * removed or replaced are gone (the caller has counted them as touched); the rest move by the net
 * length change of every block above them. A range an insertion lands inside is split in two.
 */
export function remapRanges(ranges: readonly LineRange[], blocks: readonly Block[]): LineRange[] {
  // The last old line a block occupies; for a pure insertion, the line above it.
  const lastOld = (b: Block) => b.oldLen > 0 ? b.oldStart + b.oldLen - 1 : b.oldStart - 1
  let segments = [...ranges]
  for (const b of blocks) {
    const next: LineRange[] = []
    for (const r of segments) {
      if (b.oldLen === 0) {
        // Insertion between lines k and k+1: a range holding both is cut there.
        const k = b.oldStart - 1
        if (r.start <= k && k < r.end) {
          next.push({ start: r.start, end: k }, { start: k + 1, end: r.end })
        } else next.push(r)
      } else {
        const [from, to] = [b.oldStart, lastOld(b)]
        if (r.start < from) next.push({ start: r.start, end: Math.min(r.end, from - 1) })
        if (r.end > to) next.push({ start: Math.max(r.start, to + 1), end: r.end })
      }
    }
    segments = next.filter((r) => r.start <= r.end)
  }
  // No segment straddles a block now, so the shift of its first line is the shift of all of it.
  const shift = (line: number) =>
    blocks.reduce((sum, b) => lastOld(b) < line ? sum + b.newLen - b.oldLen : sum, 0)
  return segments.map((r) => {
    const by = shift(r.start)
    return { start: r.start + by, end: r.end === Number.MAX_SAFE_INTEGER ? r.end : r.end + by }
  })
}

/** One later PR in merge order, with the files it changed. */
export interface OrderedPr {
  readonly number: number
  readonly files: readonly FileChange[]
}

/**
 * Which later PRs touch lines the `original` PR changed, and in which files. `later` must be in
 * merge order.
 *
 * "Touch" means: the same file (renames are followed through `previousFilename`), and a changed
 * range of the later diff, on its old side, overlaps a line the original changed, inclusive. The
 * original's changed lines are tracked through the PRs between, so each later PR is compared with
 * where those lines are at that time: a PR that inserts lines above shifts the range, and a PR
 * that removes or rewrites some of the lines takes them off the range, being the one that touched
 * them. Commits pushed straight to the branch are not in any PR's patch and do not shift ranges,
 * and a PR that branched before the original merged was diffed against an older file, so either
 * can make a result a few lines off. A pure rename changes no lines. A file with no patch
 * (binary, or a diff too large to show) counts as touched whole, with `exact` false, and ends the
 * tracking of that file. Files matching `GENERATED_FILES` are left out.
 */
export function followChanges(
  original: readonly FileChange[],
  later: readonly OrderedPr[],
): Map<number, { files: string[]; exact: boolean }> {
  const hits = new Map<number, { files: string[]; exact: boolean }>()
  const record = (pr: number, file: string, exact: boolean) => {
    const hit = hits.get(pr) ?? { files: [], exact: true }
    hit.files.push(file)
    hit.exact &&= exact
    hits.set(pr, hit)
  }
  for (const o of original) {
    if (isGenerated(o.filename) || isBareRename(o)) continue
    let name = o.filename
    let ranges: LineRange[] = o.patch === undefined ? [WHOLE_FILE] : parsePatch(o.patch).new
    const originalExact = o.patch !== undefined
    for (const pr of later) {
      if (ranges.length === 0) break
      const l = pr.files.find((f) => (f.previousFilename ?? f.filename) === name)
      if (!l) continue
      name = l.filename
      if (isGenerated(l.filename) || isBareRename(l)) continue
      if (l.patch === undefined) {
        record(pr.number, l.filename, false)
        ranges = []
        continue
      }
      const blocks = parseBlocks(l.patch)
      if (overlaps(parsePatch(l.patch).old, ranges)) record(pr.number, l.filename, originalExact)
      ranges = remapRanges(ranges, blocks)
    }
  }
  return hits
}

/** `followChanges` for one later PR with nothing between: which of its files touch `original`. */
export function touches(
  original: readonly FileChange[],
  later: readonly FileChange[],
): { files: string[]; exact: boolean } {
  return followChanges(original, [{ number: 0, files: later }]).get(0) ??
    { files: [], exact: true }
}

function withoutPrSuffix(title: string): string {
  return title.replace(/\s*\(#\d+\)\s*$/, ``).trim()
}

/** Whether a PR or commit with this title and body reverts the PR described by `target`. */
export function isRevertOf(
  target: { repo: string; number: number; title: string; mergeCommit: string | null },
  candidate: { title: string; body: string },
): boolean {
  // `gh pr view` gives the title without the `(#10)` a squash commit adds, so a revert of the
  // squash commit reads `Revert "<title> (#10)"`, with `(#14)` after it once squash-merged itself.
  const title = withoutPrSuffix(candidate.title)
  if (
    title === `Revert "${target.title}"` ||
    title === `Revert "${withoutPrSuffix(target.title)}"` ||
    title === `Revert "${withoutPrSuffix(target.title)} (#${target.number})"`
  ) {
    return true
  }
  if (target.mergeCommit) {
    for (const m of candidate.body.matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)) {
      if (target.mergeCommit.toLowerCase().startsWith(m[1].toLowerCase())) return true
    }
  }
  for (const m of candidate.body.matchAll(/\bReverts (?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g)) {
    if ((m[1] === undefined || m[1] === target.repo) && Number(m[2]) === target.number) return true
  }
  return false
}

/** Builds the row of one PR as of `now`. Pure: all the data comes in through `input`. */
export function buildRow(input: FollowupInput, now: Date): FollowupRow {
  const merged = Date.parse(input.mergedAt)
  const target = {
    repo: input.repo,
    number: input.number,
    title: input.title,
    mergeCommit: input.mergeCommit,
  }
  // Every later PR, oldest first: each one moves the lines the next one is compared with, a
  // revert included, so all of them go through `followChanges`.
  const ordered = input.laterPrs
    .filter((p) => p.number !== input.number && Date.parse(p.mergedAt) > merged)
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.number - b.number)
  const touched = followChanges(input.files, ordered)
  const window = (days: number): WindowResult | `pending` => {
    const end = merged + days * DAY_MS
    if (now.getTime() < end) return `pending`
    const inWindow = (at: string) => Date.parse(at) > merged && Date.parse(at) <= end
    const reverts: RevertEvent[] = []
    const fixes: FixEvent[] = []
    const prCommits = new Set(input.laterPrs.map((p) => p.mergeCommit).filter(Boolean))
    for (const p of ordered) {
      if (!inWindow(p.mergedAt)) continue
      if (isRevertOf(target, p)) {
        reverts.push({ pr: p.number, sha: p.mergeCommit, title: p.title, at: p.mergedAt })
        continue
      }
      const hit = touched.get(p.number)
      if (hit) {
        fixes.push({
          pr: p.number,
          title: p.title,
          at: p.mergedAt,
          fixType: /^fix(\(|:|!)/i.test(p.title),
          files: hit.files,
          exact: hit.exact,
        })
      }
    }
    for (const c of input.laterCommits) {
      // A commit that is a listed PR's merge commit was judged as that PR above.
      if (c.sha === input.mergeCommit || prCommits.has(c.sha) || !inWindow(c.at)) continue
      const [title, ...rest] = c.message.split(`\n`)
      if (isRevertOf(target, { title, body: rest.join(`\n`) })) {
        reverts.push({ pr: null, sha: c.sha, title, at: c.at })
      }
    }
    const byTime = <T extends { at: string }>(a: T, b: T) => Date.parse(a.at) - Date.parse(b.at)
    return {
      reverts: reverts.sort(byTime),
      fixes: fixes.sort(byTime),
      reopened: input.reopens.filter((r) => inWindow(r.at)).sort(byTime),
    }
  }
  return {
    schema: FOLLOWUP_SCHEMA_VERSION,
    pr: `${input.repo}#${input.number}`,
    title: input.title,
    mergedAt: input.mergedAt,
    mergeCommit: input.mergeCommit,
    d14: window(14),
    d30: window(30),
  }
}

/** The merged PRs of the rows, once each, as `{ repo, number }` sorted by key. */
export function mergedPrs(rows: readonly LaneRow[]): { repo: string; number: number }[] {
  const seen = new Map<string, { repo: string; number: number }>()
  for (const row of rows) {
    for (const [key, info] of Object.entries(row.prInfo)) {
      if (info.state !== `MERGED` || !info.mergedAt) continue
      const [repo, number] = key.split(`#`)
      seen.set(key, { repo, number: Number(number) })
    }
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v)
}

/** Serialises rows as JSON Lines. */
export function toJsonl(rows: readonly FollowupRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join(`\n`) + `\n`
}

// ===== Fetching =====

/** Runs `gh` and parses its JSON; a failure or non-JSON output throws `CommandError`. */
async function ghJson(exec: Exec, args: string[]): Promise<unknown> {
  const out = await exec(`gh`, args)
  try {
    return JSON.parse(out)
  } catch {
    throw new CommandError(`gh`, args, `output is not JSON`)
  }
}

/** A paginated `gh api` call, with the pages joined into one array. */
async function ghPages(exec: Exec, path: string): Promise<Record<string, unknown>[]> {
  const pages = await ghJson(exec, [`api`, `--paginate`, `--slurp`, path])
  return (pages as Record<string, unknown>[][]).flat()
}

const PR_LIST_LIMIT = 1000

/**
 * Collects the follow-ups of every merged PR in `rows` as of `now`. `exec` is the only way to
 * reach GitHub. Any failing call rejects, and nothing is returned for the PRs before it.
 */
export async function collectFollowups(
  rows: readonly LaneRow[],
  now: Date,
  exec: Exec,
): Promise<FollowupRow[]> {
  const files = new Map<string, FileChange[]>()
  const filesOf = async (repo: string, number: number): Promise<FileChange[]> => {
    const key = `${repo}#${number}`
    if (!files.has(key)) {
      const raw = await ghPages(exec, `repos/${repo}/pulls/${number}/files`)
      files.set(
        key,
        raw.map((f) => ({
          filename: String(f.filename),
          previousFilename: f.previous_filename === undefined
            ? undefined
            : String(f.previous_filename),
          status: typeof f.status === `string` ? f.status : undefined,
          // An absent patch stays absent: it is not the same as an empty one.
          patch: typeof f.patch === `string` ? f.patch : undefined,
        })),
      )
    }
    return files.get(key)!
  }
  const mergedLists = new Map<string, Promise<Omit<LaterPr, `files`>[]>>()
  const mergedList = (repo: string, base: string, sinceIso: string) => {
    const key = `${repo}@${base}`
    if (!mergedLists.has(key)) {
      mergedLists.set(
        key,
        (async () => {
          const list = await ghJson(exec, [
            `pr`,
            `list`,
            `-R`,
            repo,
            `--state`,
            `merged`,
            `--base`,
            base,
            `--search`,
            `merged:>=${sinceIso.slice(0, 10)}`,
            `--limit`,
            String(PR_LIST_LIMIT),
            `--json`,
            `number,title,body,mergedAt,mergeCommit`,
          ]) as {
            number: number
            title: string
            body: string
            mergedAt: string
            mergeCommit: { oid: string } | null
          }[]
          if (list.length >= PR_LIST_LIMIT) {
            throw new CommandError(
              `gh`,
              [`pr`, `list`, `-R`, repo],
              `${list.length} merged PRs, the most one call returns; the list may be cut short`,
            )
          }
          return list.map((p) => ({
            number: p.number,
            title: p.title,
            body: p.body ?? ``,
            mergedAt: p.mergedAt,
            mergeCommit: p.mergeCommit?.oid ?? null,
          }))
        })(),
      )
    }
    return mergedLists.get(key)!
  }
  const commitLists = new Map<string, Promise<LaterCommit[]>>()
  const commitList = (repo: string, base: string, sinceIso: string) => {
    const key = `${repo}@${base}`
    if (!commitLists.has(key)) {
      commitLists.set(
        key,
        ghPages(exec, `repos/${repo}/commits?sha=${base}&since=${sinceIso}&per_page=100`).then(
          (raw) =>
            raw.map((c) => {
              const commit = c.commit as { message: string; committer: { date: string } }
              return { sha: String(c.sha), message: commit.message, at: commit.committer.date }
            }),
        ),
      )
    }
    return commitLists.get(key)!
  }
  const defaults = new Map<string, Promise<string>>()
  // The branch the repo has now: a repo renamed from master to main keeps its old PRs, and their
  // later history lives on the new name.
  const defaultBranch = (repo: string) => {
    if (!defaults.has(repo)) {
      defaults.set(
        repo,
        ghJson(exec, [`repo`, `view`, repo, `--json`, `defaultBranchRef`]).then((v) =>
          (v as { defaultBranchRef: { name: string } }).defaultBranchRef.name
        ),
      )
    }
    return defaults.get(repo)!
  }
  const earliest = new Map<string, string>()
  const views = new Map<string, {
    title: string
    mergedAt: string
    mergeCommit: string | null
    issues: { repo: string; number: number }[]
  }>()
  const targets = mergedPrs(rows)
  for (const { repo, number } of targets) {
    const v = await ghJson(exec, [
      `pr`,
      `view`,
      String(number),
      `-R`,
      repo,
      `--json`,
      `title,mergedAt,mergeCommit,closingIssuesReferences`,
    ]) as {
      title: string
      mergedAt: string | null
      mergeCommit: { oid: string } | null
      closingIssuesReferences: {
        number: number
        repository: { name: string; owner: { login: string } }
      }[]
    }
    if (!v.mergedAt) {
      throw new CommandError(
        `gh`,
        [`pr`, `view`, String(number)],
        `${repo}#${number} is not merged`,
      )
    }
    views.set(`${repo}#${number}`, {
      title: v.title,
      mergedAt: v.mergedAt,
      mergeCommit: v.mergeCommit?.oid ?? null,
      issues: v.closingIssuesReferences.map((i) => ({
        repo: `${i.repository.owner.login}/${i.repository.name}`,
        number: i.number,
      })),
    })
    const prev = earliest.get(repo)
    if (prev === undefined || v.mergedAt < prev) earliest.set(repo, v.mergedAt)
  }
  const reopenLists = new Map<string, Reopen[]>()
  const out: FollowupRow[] = []
  for (const { repo, number } of targets) {
    const v = views.get(`${repo}#${number}`)!
    const since = earliest.get(repo)!
    const base = await defaultBranch(repo)
    const [mergedLater, commits, original] = [
      await mergedList(repo, base, since),
      await commitList(repo, base, since),
      await filesOf(repo, number),
    ]
    const horizon = Math.min(now.getTime(), Date.parse(v.mergedAt) + 30 * DAY_MS)
    const laterPrs: LaterPr[] = []
    for (const p of mergedLater) {
      const at = Date.parse(p.mergedAt)
      if (p.number === number || at <= Date.parse(v.mergedAt) || at > horizon) continue
      laterPrs.push({ ...p, files: await filesOf(repo, p.number) })
    }
    const reopens: Reopen[] = []
    for (const issue of v.issues) {
      const key = `${issue.repo}#${issue.number}`
      if (!reopenLists.has(key)) {
        const events = await ghPages(
          exec,
          `repos/${issue.repo}/issues/${issue.number}/timeline?per_page=100`,
        )
        reopenLists.set(
          key,
          events.filter((e) => e.event === `reopened`).map((e) => ({
            issue: key,
            at: String(e.created_at),
          })),
        )
      }
      reopens.push(...reopenLists.get(key)!)
    }
    out.push(buildRow({
      repo,
      number,
      title: v.title,
      mergedAt: v.mergedAt,
      mergeCommit: v.mergeCommit,
      files: original,
      laterPrs,
      laterCommits: commits,
      reopens,
    }, now))
  }
  return out
}

// ===== CLI =====

if (import.meta.main) {
  const args = Deno.args
  const nowAt = args.indexOf(`--now`)
  const positional = args.filter((a, i) => !a.startsWith(`--`) && (nowAt === -1 || i !== nowAt + 1))
  if (positional.length !== 1) {
    console.error(`usage: followup.ts <run folder> [--now <ISO>]`)
    Deno.exit(2)
  }
  let now = new Date()
  if (nowAt !== -1) {
    const error = isoDateError(`--now`, args[nowAt + 1])
    if (error) {
      console.error(error)
      Deno.exit(2)
    }
    now = new Date(args[nowAt + 1])
    // A time after the real clock would mark windows nobody has observed as elapsed and empty.
    if (now.getTime() > Date.now()) {
      console.error(`--now ${args[nowAt + 1]} is in the future; GitHub has no history after today`)
      Deno.exit(2)
    }
  }
  const folder = positional[0]
  try {
    const rows = parseRows(await Deno.readTextFile(join(folder, `lanes.jsonl`)))
    const followups = await collectFollowups(rows, now, denoExec)
    await Deno.writeTextFile(join(folder, `followups.jsonl`), toJsonl(followups))
    console.log(`wrote ${followups.length} PRs to ${join(folder, `followups.jsonl`)}`)
    for (const days of WINDOW_DAYS) {
      const key = days === 14 ? `d14` : `d30`
      const done = followups.map((r) => r[key]).filter((w) => w !== `pending`)
      console.log(
        `${days} days: ${followups.length - done.length} pending, ${done.length} elapsed; ` +
          `${done.filter((w) => w.reverts.length > 0).length} reverted, ` +
          `${done.filter((w) => w.fixes.length > 0).length} with follow-up fixes, ` +
          `${done.filter((w) => w.reopened.length > 0).length} with a reopened issue`,
      )
    }
  } catch (error) {
    console.error(`followup failed: ${error instanceof Error ? error.message : error}`)
    Deno.exit(1)
  }
}
