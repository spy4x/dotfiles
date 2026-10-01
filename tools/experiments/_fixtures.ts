// Hand-written synthetic transcripts for the experiment kit's tests. Nothing here comes from a
// real transcript: real ones can carry environment values.

import { join } from "jsr:@std/path@1.1.6"
import type { LaneRow } from "./schema.ts"

/** One transcript line as `JSON.stringify` writes it. */
export function line(entry: unknown): string {
  return JSON.stringify(entry)
}

/** An `assistant` line. `content` blocks default to a single empty text block. */
export function assistant(
  id: string,
  model: string,
  timestamp: string,
  usage: Record<string, unknown>,
  content: unknown[] = [{ type: `text`, text: `` }],
  extra: Record<string, unknown> = {},
): string {
  return line({
    type: `assistant`,
    timestamp,
    ...extra,
    message: { id, model, content, usage: { input_tokens: 0, output_tokens: 0, ...usage } },
  })
}

/** A `user` line with plain-text content, or with content blocks when given an array. */
export function user(timestamp: string, content: string | unknown[]): string {
  return line({ type: `user`, timestamp, message: { role: `user`, content } })
}

/** Where `writeLane` put a lane's files. */
export interface WrittenLane {
  readonly transcriptPath: string
  readonly metaPath: string
}

/** Writes `<projects>/<project>/<session>/subagents/agent-<id>.{jsonl,meta.json}`. */
export async function writeLane(
  projects: string,
  options: {
    project?: string
    session?: string
    id: string
    meta: Record<string, unknown>
    lines: string[]
  },
): Promise<WrittenLane> {
  const dir = join(
    projects,
    options.project ?? `-fake-project`,
    options.session ?? `session-1`,
    `subagents`,
  )
  await Deno.mkdir(dir, { recursive: true })
  const transcriptPath = join(dir, `agent-${options.id}.jsonl`)
  const metaPath = join(dir, `agent-${options.id}.meta.json`)
  await Deno.writeTextFile(transcriptPath, options.lines.join(`\n`) + `\n`)
  await Deno.writeTextFile(metaPath, JSON.stringify(options.meta))
  return { transcriptPath, metaPath }
}

/** A lane row with neutral defaults; tests override what they care about. */
export function laneRow(overrides: Partial<LaneRow> = {}): LaneRow {
  return {
    schema: 1,
    role: `implementer`,
    agentType: `implementer`,
    agentId: `a`,
    session: `s`,
    project: `p`,
    description: `Implement something`,
    model: `claude-opus-5-5`,
    models: { "claude-opus-5-5": 10 },
    requestedModel: null,
    effort: `medium`,
    repo: `spy4x/example`,
    issue: null,
    issueSource: null,
    baseCommit: null,
    dotfilesCommit: null,
    taskClass: `code`,
    start: `2026-09-30T00:00:00.000Z`,
    end: `2026-09-30T00:10:00.000Z`,
    wallSeconds: 600,
    calls: 10,
    toolCalls: 5,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    cost: 1,
    peakContext: 100_000,
    compactions: 0,
    prs: [],
    prSource: null,
    prInfo: {},
    mergedLines: 0,
    reviews: {},
    rounds: [],
    ...overrides,
  }
}
