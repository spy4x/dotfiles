// The row format the collector writes and the analysis reads: one JSON object per line, one line
// per agent lane (an implementer or a reviewer subagent).

/** Bump when a field changes meaning or is removed; the analysis refuses other versions. */
export const SCHEMA_VERSION = 1

/** Token counts by kind, from the last usage line of every distinct API response. */
export interface TokenCounts {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite5m: number
  readonly cacheWrite1h: number
}

/** What `gh pr view` says about a pull request. */
export interface PrInfo {
  readonly additions: number
  readonly deletions: number
  readonly state: string
  readonly mergedAt: string | null
  readonly createdAt: string
  readonly title: string
  readonly headRefName: string
  readonly closingIssues: number[]
  /**
   * Issues the PR body names (`owner/repo#number`), read only when `closingIssues` is empty, else
   * empty. These are mentions ("Part of #93"), not closes. Absent in rows collected before this
   * field existed.
   */
  readonly referencedIssues?: string[]
}

/** One review round: a reviewer's verdict on a PR and what the round cost. */
export interface ReviewRound {
  readonly ts: string
  readonly verdict: `pass` | `needs-fix`
  /** `owner/repo#number`, or null when the reviewer's prompt named no PR. */
  readonly pr: string | null
  readonly reviewerModel: string
  readonly cost: number
  readonly calls: number
}

export type TaskClass = `auth/crypto` | `docs` | `code`

/** One lane. Implementer rows carry `reviews`; reviewer rows carry `rounds`. */
export interface LaneRow {
  readonly schema: typeof SCHEMA_VERSION
  readonly role: `implementer` | `reviewer`
  /** `implementer`, `implementer-xhigh`, `reviewer`, ... as the subagent's meta file says. */
  readonly agentType: string
  readonly agentId: string
  readonly session: string
  readonly project: string
  readonly description: string
  /** The model that answered most calls, from `message.model` (never the alias asked for). */
  readonly model: string
  /** Calls per answering model; more than one key means the lane switched models. */
  readonly models: Record<string, number>
  /** The `model` the Agent call asked for (an alias such as `sonnet`), when recorded. */
  readonly requestedModel: string | null
  readonly effort: string | null
  readonly repo: string | null
  /** The lowest issue the brief names, else the lowest closing reference of the lane's first PR
   * in sorted order (the reference pipeline's rule). */
  readonly issue: number | null
  readonly issueSource: `brief` | `closing-ref` | null
  /** Not recorded in transcripts or by `gh` today; always null. */
  readonly baseCommit: string | null
  /** The newest dotfiles commit older than the lane's first call (the rules it followed). */
  readonly dotfilesCommit: string | null
  readonly taskClass: TaskClass | null
  readonly start: string
  readonly end: string
  readonly wallSeconds: number
  readonly calls: number
  readonly toolCalls: number
  readonly tokens: TokenCounts
  /** API-equivalent dollars, each response priced once. Every call has a price: the collector
   * stops on a model the price table does not know. */
  readonly cost: number
  /** Largest single-call context: input + cache read + cache writes. */
  readonly peakContext: number
  readonly compactions: number
  /** When each compaction happened, oldest first: tells a compaction before a review from one
   * during a fix round. */
  readonly compactedAt: string[]
  /** Implementer rows: calls made before the earliest review round on any of the lane's PRs, so
   * lane size can be compared without the fix rounds a failed review adds. Null when no review
   * round on its PRs came after the lane started. */
  readonly callsBeforeReview: number | null
  readonly prs: string[]
  readonly prSource: `create` | `report` | `branch` | null
  readonly prInfo: Record<string, PrInfo>
  /** Changed lines (additions + deletions) of this lane's merged PRs. */
  readonly mergedLines: number
  /** Implementer rows: review rounds on each of the lane's PRs, oldest first. */
  readonly reviews: Record<string, ReviewRound[]>
  /** Reviewer rows: the rounds this reviewer ran. */
  readonly rounds: ReviewRound[]
}
