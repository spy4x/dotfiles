// Reads one subagent transcript into the facts a lane row needs. Pure: no file or network access.
//
// Ported from the 29-30 September trial's `lanes.py`, `prs.py` and `reviews2.py`; the patterns and
// the grouping rules are the same so the published figures can be reproduced.

import { type Call, costOf, ctxOf, parseTranscript, priceFor, totalOf } from "../session-cost.ts"
import type { ReviewRound, TaskClass, TokenCounts } from "./schema.ts"

const PR_URL = /https:\/\/github\.com\/(spy4x\/[\w.-]+)\/pull\/(\d+)/g
const PUSH_BRANCH = /git push [^\n;&|]*?(?:-u|--set-upstream) origin ([\w./-]+)/g
const WORKTREE_BRANCH = /worktrees\/([\w.-]+)\/([\w-]+\/[\w-]+(?:[./][\w-]+)*)/g

/** What one transcript contains, beyond what `parseTranscript` returns. */
export interface LaneScan {
  readonly calls: Call[]
  readonly compactions: number
  readonly toolCalls: number
  readonly effort: string | null
  /** The first user message: the brief the lane was given. */
  readonly prompt: string
  /** PR URLs printed by a `gh pr create` the lane ran. */
  readonly createdPrs: string[]
  /** PR URLs on lines of the lane's own text that start with "PR". */
  readonly reportedPrs: string[]
  readonly branches: string[]
  /** `gh`/`git` commands the lane ran. */
  readonly commands: string[]
  /** The lane's text per API response, with the response's last timestamp. */
  readonly texts: { ts: string; text: string }[]
}

function textOf(content: unknown): string {
  if (typeof content === `string`) return content
  if (Array.isArray(content)) {
    return content.map((
      x,
    ) => (x && typeof x === `object` ? (x as { text?: string }).text ?? `` : ``))
      .join(`\n`)
  }
  return ``
}

function prRefs(text: string): string[] {
  return [...text.matchAll(PR_URL)].map((m) => `${m[1]}#${m[2]}`)
}

/** Reads every fact a lane row needs out of one transcript's lines. */
export function scanTranscript(lines: string[]): LaneScan {
  const { calls, compactionTimestamps } = parseTranscript(lines)
  const effortCount = new Map<string, number>()
  const toolIds = new Set<string>()
  const pendingCreate = new Set<string>()
  const createdPrs: string[] = []
  const branches = new Set<string>()
  const commands: string[] = []
  const textById = new Map<string, string>()
  const tsById = new Map<string, string>()
  let prompt: string | undefined

  for (const line of lines) {
    if (line.trim().length === 0) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry.effort === `string`) {
      effortCount.set(entry.effort, (effortCount.get(entry.effort) ?? 0) + 1)
    }
    const message = entry.message as Record<string, unknown> | undefined
    if (entry.type === `user` && message) {
      if (prompt === undefined) prompt = textOf(message.content).replaceAll(`\n`, ` `)
      if (Array.isArray(message.content)) {
        for (const block of message.content as Record<string, unknown>[]) {
          if (block.type === `tool_result` && pendingCreate.has(block.tool_use_id as string)) {
            createdPrs.push(...prRefs(textOf(block.content)))
          }
        }
      }
    }
    if (entry.type !== `assistant` || !message) continue
    const id = message.id as string
    const model = message.model
    if (Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === `tool_use`) {
          if (typeof block.id === `string`) toolIds.add(block.id)
          if (block.name === `Bash`) {
            const command = String((block.input as { command?: string } | undefined)?.command ?? ``)
            commands.push(command)
            if (command.includes(`gh pr create`) && typeof block.id === `string`) {
              pendingCreate.add(block.id)
            }
            for (const m of command.matchAll(PUSH_BRANCH)) branches.add(m[1])
          }
        }
        if (block.type === `text`) textById.set(id, (textById.get(id) ?? ``) + block.text)
      }
    }
    if (
      typeof model === `string` && !model.startsWith(`<`) && typeof entry.timestamp === `string`
    ) {
      tsById.set(id, entry.timestamp)
    }
  }

  const reportedPrs: string[] = []
  const texts: { ts: string; text: string }[] = []
  for (const [id, text] of textById) {
    for (const textLine of text.split(`\n`)) {
      if (/^\W*PR\W/.test(textLine)) reportedPrs.push(...prRefs(textLine))
    }
    const ts = tsById.get(id)
    if (ts) texts.push({ ts, text })
  }

  let effort: string | null = null
  let best = 0
  for (const [value, n] of effortCount) {
    if (n > best) [effort, best] = [value, n]
  }

  return {
    calls,
    compactions: compactionTimestamps.length,
    toolCalls: toolIds.size,
    effort,
    prompt: prompt ?? ``,
    createdPrs: [...new Set(createdPrs)],
    reportedPrs: [...new Set(reportedPrs)],
    branches: [...branches].sort(),
    commands,
    texts,
  }
}

/** Calls per answering model, in the order each model first appeared. */
export function modelCounts(calls: readonly Call[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const call of calls) counts[call.model] = (counts[call.model] ?? 0) + 1
  return counts
}

/** The model with the most calls; the first to appear wins a tie. */
export function dominantModel(counts: Record<string, number>): string {
  let best = ``
  let bestN = 0
  for (const [model, n] of Object.entries(counts)) {
    if (n > bestN) [best, bestN] = [model, n]
  }
  return best
}

/** Tokens of a lane by kind; each call is one distinct API response (see `parseTranscript`). */
export function tokenCounts(calls: readonly Call[]): TokenCounts {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
  for (const c of calls) {
    t.input += c.inputTokens
    t.output += c.outputTokens
    t.cacheRead += c.cacheReadTokens
    t.cacheWrite5m += c.cache5mTokens
    t.cacheWrite1h += c.cache1hTokens
  }
  return t
}

/** Dollars for calls. A call whose model has no price counts as zero and is reported apart. */
export function priceCalls(calls: readonly Call[]): { cost: number; unpriced: number } {
  let cost = 0
  let unpriced = 0
  for (const call of calls) {
    const priced = costOf(call)
    if (priced.priced) cost += totalOf(priced.cost)
    else unpriced++
  }
  return { cost, unpriced }
}

/** Largest context of any call. */
export function peakContext(calls: readonly Call[]): number {
  return calls.reduce((max, c) => Math.max(max, ctxOf(c)), 0)
}

/** True when the model has a price entry. */
export function isPriced(model: string): boolean {
  return priceFor(model) !== undefined
}

/** `owner/repo` and branch pairs that a brief names as worktree paths, without repeats. */
export function worktreeBranches(prompt: string): { repo: string; branch: string }[] {
  const seen = new Set<string>()
  const out: { repo: string; branch: string }[] = []
  for (const m of prompt.matchAll(WORKTREE_BRANCH)) {
    const branch = m[2].replace(/\.+$/, ``)
    const key = `${m[1]}/${branch}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ repo: m[1], branch })
  }
  return out
}

/** Issue numbers a brief names: `<repo>/issues/N`, `Issue #N`, `Closes #N`, `Fixes #N`. */
export function issuesInBrief(prompt: string, repo: string | null): number[] {
  const nums = new Set<number>()
  if (repo) {
    const url = new RegExp(`${repo.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`)}/issues/(\\d+)`, `g`)
    for (const m of prompt.matchAll(url)) nums.add(Number(m[1]))
  }
  for (const m of prompt.matchAll(/(?:[Ii]ssue|Closes|Fixes|closes|fixes)\s*#(\d+)/g)) {
    nums.add(Number(m[1]))
  }
  return [...nums]
}

/** Coarse task class from a lane's description and PR titles; the trial's own keyword rules. */
export function taskClassOf(text: string): TaskClass {
  const t = text.toLowerCase()
  if (
    /auth|sign-in|signin|second factor|password|oidc|oauth|totp|crypto|age64|secret|security|constant-time/
      .test(t)
  ) return `auth/crypto`
  if (/jsdoc|readme|docs?\b|changelog|screenshot/.test(t)) return `docs`
  return `code`
}

// ===== Reviewer lanes =====

const VERDICT = new RegExp(
  [
    String.raw`verdict\W{0,40}(pass|needs-fix)\b`,
    String.raw`verdict[^\n]{0,60}?\b(pass|needs-fix)\b`,
    String.raw`\*\*(pass|needs-fix)\.?\*\*`,
    String.raw`\b(pass|needs-fix)\b[^\n]{0,20}\bverdict`,
    String.raw`^\W*(pass|needs-fix)\W*$`,
  ].join(`|`),
  `gim`,
)
const PR_REF = /(?:#|pull\/)(\d+)/g
const GH_CMD_A =
  /gh pr (?:view|diff|checks|comment|review)\s+(\d+)[^\n;|&]*?(?:-R|--repo)\s+(spy4x\/[\w.-]+)/g
const GH_CMD_B =
  /gh pr (?:view|diff|checks|comment|review)\s+(?:-R|--repo)\s+(spy4x\/[\w.-]+)\s+(\d+)/g

/**
 * The PRs a reviewer reviewed, most certain first: PR URLs in its prompt; else a `PR #n` in its
 * description together with the repo of a worktree path; plus PRs whose branch its prompt names
 * (`branchToPr`); and, only when still empty, the two PRs its own `gh` commands touched most.
 */
export function reviewerCandidates(
  scan: LaneScan,
  description: string,
  branchToPr: ReadonlyMap<string, string>,
): string[] {
  const cands = [...new Set(prRefs(scan.prompt))]
  const worktrees = worktreeBranches(scan.prompt)
  if (cands.length === 0) {
    const dm = description.match(/\bPR\s*#?(\d+)/)
    if (dm && worktrees.length > 0) cands.push(`spy4x/${worktrees[0].repo}#${dm[1]}`)
  }
  for (const { repo, branch } of worktrees) {
    const pr = branchToPr.get(`spy4x/${repo}/${branch}`)
    if (pr && !cands.includes(pr)) cands.push(pr)
  }
  if (cands.length === 0) {
    const seen = new Map<string, number>()
    const bump = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1)
    for (const command of scan.commands) {
      for (const m of command.matchAll(GH_CMD_A)) bump(`${m[2]}#${m[1]}`)
      for (const m of command.matchAll(GH_CMD_B)) bump(`${m[1]}#${m[2]}`)
      for (const ref of prRefs(command)) bump(ref)
    }
    cands.push(...[...seen].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k))
  }
  return cands
}

/**
 * Splits a reviewer's calls into review rounds, one per timestamp at which it states a verdict.
 * A message that gives verdicts on several PRs yields one round per PR, each carrying an equal
 * share of the cost and calls of the calls since the previous verdict.
 */
export function reviewRounds(
  scan: LaneScan,
  candidates: string[],
  reviewerModel: string,
): ReviewRound[] {
  const verdicts: { ts: string; verdict: `pass` | `needs-fix`; pr: string | null }[] = []
  for (const { ts, text } of scan.texts) {
    const found = new Map<string | null, `pass` | `needs-fix`>()
    for (const m of text.matchAll(VERDICT)) {
      const verdict = m.slice(1).find((g) => g)!.toLowerCase() as `pass` | `needs-fix`
      const before = text.slice(0, m.index)
      let pr: string | null = candidates[0] ?? null
      let lastRef: string | undefined
      for (const ref of before.matchAll(PR_REF)) {
        if (candidates.some((c) => c.split(`#`)[1] === ref[1])) lastRef = ref[1]
      }
      if (lastRef) pr = candidates.find((c) => c.split(`#`)[1] === lastRef)!
      found.set(pr, verdict)
    }
    for (const [pr, verdict] of found) verdicts.push({ ts, verdict, pr })
  }
  verdicts.sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.verdict < b.verdict ? -1 : a.verdict > b.verdict ? 1 : 0
  )
  const byTs = new Map<string, typeof verdicts>()
  for (const v of verdicts) byTs.set(v.ts, [...(byTs.get(v.ts) ?? []), v])

  const rounds: ReviewRound[] = []
  let prev = ``
  for (const [ts, group] of byTs) {
    const inRound = scan.calls.filter((c) => prev < c.timestamp && c.timestamp <= ts)
    const share = group.length
    const cost = priceCalls(inRound).cost
    for (const v of group) {
      rounds.push({
        ts,
        verdict: v.verdict,
        pr: v.pr,
        reviewerModel,
        cost: Math.round((cost / share) * 1e4) / 1e4,
        calls: inRound.length / share,
      })
    }
    prev = ts
  }
  return rounds
}
