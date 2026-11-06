import { assert, assertEquals } from "jsr:@std/assert@1.0.19"
import { join } from "jsr:@std/path@^1.0.0"
import type { SqliteDb } from "@spy4x/server/db/sqlite"
import {
  denoFiles,
  type Files,
  importTranscripts,
  openImportDb,
  OUTPUT_LIMIT,
} from "./agent-import.ts"

/** The first import runs at this moment, so `import_since` is it. */
const SINCE = new Date(`2026-01-01T00:00:00.000Z`)
const SID = `0190a1b2-0000-7000-8000-000000000001`
const PROJECT = `-home-test-repo`

/** A timestamp `minutes` after `SINCE`, on 2026-01-01 at noon UTC plus that, so the local day is stable. */
function at(minutes: number, day = `2026-01-01`): string {
  return new Date(Date.parse(`${day}T12:00:00.000Z`) + minutes * 60_000).toISOString()
}

let seq = 0
function uuid(): string {
  return `u-${++seq}`
}

const base = { cwd: `/home/test/repo`, gitBranch: `feat/x`, entrypoint: `cli`, sessionId: SID }

function userText(t: string, text: string) {
  return {
    ...base,
    type: `user`,
    uuid: uuid(),
    timestamp: t,
    message: { role: `user`, content: text },
  }
}

function assistant(
  t: string,
  id: string,
  content: unknown[],
  options: { model?: string; output?: number } = {},
) {
  return {
    ...base,
    type: `assistant`,
    uuid: uuid(),
    timestamp: t,
    message: {
      role: `assistant`,
      id,
      model: options.model ?? `claude-opus-5-5`,
      content,
      usage: { input_tokens: 1_000_000, output_tokens: options.output ?? 0 },
    },
  }
}

function toolUse(t: string, messageId: string, toolId: string, name: string, input: unknown) {
  return assistant(t, messageId, [{ type: `tool_use`, id: toolId, name, input }])
}

function toolResult(
  t: string,
  toolId: string,
  output: string,
  options: { isError?: boolean; resumedAgentId?: string } = {},
) {
  return {
    ...base,
    type: `user`,
    uuid: uuid(),
    timestamp: t,
    message: {
      role: `user`,
      content: [{
        type: `tool_result`,
        tool_use_id: toolId,
        content: output,
        is_error: options.isError,
      }],
    },
    toolUseResult: options.resumedAgentId ? { resumedAgentId: options.resumedAgentId } : {},
  }
}

function jsonl(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join(`\n`) + `\n`
}

/** A temp machine: a projects root, a state home, and the database opened in it. */
async function machine() {
  const root = await Deno.makeTempDir()
  const projects = join(root, `projects`)
  const home = join(root, `state`, `agent-run`)
  await Deno.mkdir(join(projects, PROJECT), { recursive: true })
  const reads: string[] = []
  const files: Files = {
    ...denoFiles,
    read(path, offset, length) {
      reads.push(path)
      return denoFiles.read(path, offset, length)
    },
  }
  const db = await openImportDb(files, home)
  const main = join(projects, PROJECT, `${SID}.jsonl`)
  return {
    root,
    projects,
    home,
    db,
    reads,
    main,
    /** Runs one import as if at `SINCE`. */
    run: (chunkBytes?: number) =>
      importTranscripts({ files, db, projectsDir: projects, now: () => SINCE, chunkBytes }),
    /** Writes a subagent transcript and its meta under the main session. */
    async subagent(agentId: string, meta: Record<string, unknown>, entries: unknown[]) {
      const dir = join(projects, PROJECT, SID, `subagents`)
      await Deno.mkdir(dir, { recursive: true })
      await Deno.writeTextFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta))
      await Deno.writeTextFile(join(dir, `agent-${agentId}.jsonl`), jsonl(entries))
    },
    async close() {
      await db.close()
      await Deno.remove(root, { recursive: true })
    },
  }
}

async function count(db: SqliteDb, table: string): Promise<number> {
  const row = await db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
  return Number(row!.n)
}

async function session(db: SqliteDb, id = SID): Promise<Record<string, unknown>> {
  const row = await db.queryOne(`SELECT * FROM v_sessions WHERE id = ?`, id)
  assert(row, `no v_sessions row for ${id}`)
  return row
}

/** Lane A's tables, from the wave contract's DDL (the shared columns of `runs`). */
const LANE_A = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mode INTEGER NOT NULL, model TEXT NOT NULL,
  effort TEXT NOT NULL, cwd TEXT NOT NULL, parent TEXT, issue TEXT, started_at TEXT NOT NULL,
  ended_at TEXT, status TEXT NOT NULL, cost_micros INTEGER, turns INTEGER, result TEXT
) STRICT;
CREATE TABLE queue (
  issue TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, rank INTEGER NOT NULL,
  status TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT,
  run_id TEXT, planned_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
`

Deno.test(`creates the database folder with mode 0700`, async () => {
  const m = await machine()
  try {
    assertEquals((await Deno.stat(m.home)).mode! & 0o777, 0o700)
  } finally {
    await m.close()
  }
})

Deno.test(`imports only entries from the first run on and never reads files older than it`, async () => {
  const m = await machine()
  try {
    await Deno.writeTextFile(
      m.main,
      jsonl([userText(`2025-12-31T23:00:00.000Z`, `before`), userText(at(1), `after`)]),
    )
    const old = join(m.projects, PROJECT, `0190a1b2-0000-7000-8000-00000000000f.jsonl`)
    await Deno.writeTextFile(old, jsonl([userText(at(2), `stale file`)]))
    await Deno.utime(old, new Date(`2025-06-01`), new Date(`2025-06-01`))

    await m.run()

    assertEquals(await count(m.db, `messages`), 1)
    assert(!m.reads.includes(old), `a file modified before import_since was read`)
    const since = await m.db.queryOne<{ value: string }>(
      `SELECT value FROM meta WHERE key = 'import_since'`,
    )
    assertEquals(since!.value, SINCE.toISOString())
  } finally {
    await m.close()
  }
})

Deno.test(`a second run imports nothing twice and waits for an unfinished last line`, async () => {
  const m = await machine()
  try {
    const first = jsonl([
      userText(at(1), `one`),
      assistant(at(2), `msg-1`, [{ type: `text`, text: `hi` }]),
    ])
    const second = JSON.stringify(userText(at(3), `two`))
    await Deno.writeTextFile(m.main, first + second.slice(0, 20))
    await m.run()
    assertEquals(await count(m.db, `messages`), 2)

    await Deno.writeTextFile(m.main, first + second + `\n`)
    await Deno.utime(m.main, new Date(), new Date(Date.now() + 1000))
    const stats = await m.run()
    assertEquals(stats.lines, 1, `the second run re-read old lines`)
    assertEquals(await count(m.db, `messages`), 3)

    await m.run()
    assertEquals(await count(m.db, `messages`), 3)
    assertEquals(await count(m.db, `api_calls`), 1)
  } finally {
    await m.close()
  }
})

Deno.test(`a file that shrank is re-read from the start without duplicate rows`, async () => {
  const m = await machine()
  try {
    const a = userText(at(1), `one`)
    const b = userText(at(2), `two`)
    await Deno.writeTextFile(m.main, jsonl([a, b, userText(at(3), `three`)]))
    await m.run()
    const c = userText(at(4), `four`)
    await Deno.writeTextFile(m.main, jsonl([a, c]))
    await Deno.utime(m.main, new Date(), new Date(Date.now() + 1000))
    await m.run()
    assertEquals(await count(m.db, `messages`), 4)
  } finally {
    await m.close()
  }
})

Deno.test(`a line longer than one read is still imported whole`, async () => {
  const m = await machine()
  try {
    await Deno.writeTextFile(
      m.main,
      jsonl([userText(at(1), `x`.repeat(5000)), userText(at(2), `y`)]),
    )
    await m.run(64)
    assertEquals(await count(m.db, `messages`), 2)
  } finally {
    await m.close()
  }
})

Deno.test(`counts usage once per message id and leaves an unknown model's cost NULL`, async () => {
  const m = await machine()
  try {
    await Deno.writeTextFile(
      m.main,
      jsonl([
        userText(at(0), `go`),
        // One API call written as two lines: only the last line's usage counts.
        assistant(at(1), `msg-1`, [{ type: `thinking`, thinking: `` }], { output: 1 }),
        assistant(at(1), `msg-1`, [{ type: `text`, text: `done` }], { output: 1_000_000 }),
        assistant(at(2), `msg-2`, [{ type: `text`, text: `?` }], { model: `claude-unknown-9` }),
      ]),
    )
    await m.run()

    const calls = await m.db.queryAll<{ message_id: string; cost_micros: number | null }>(
      `SELECT message_id, cost_micros FROM api_calls ORDER BY message_id`,
    )
    // Opus 5.5: 1M input at $4 plus 1M output at $20.
    assertEquals(calls.map((c) => [c.message_id, c.cost_micros]), [
      [`msg-1`, 24_000_000],
      [`msg-2`, null],
    ])
    const s = await session(m.db)
    assertEquals(s.output_tokens, 1_000_000)
    assertEquals(s.cost_usd, 24)
    assertEquals(s.unpriced_calls, 1)
    assertEquals(s.kind, `interactive`)
    assertEquals(s.wall_sec, 120)
    assertEquals([s.cwd, s.project, s.model], [`/home/test/repo`, PROJECT, `claude-opus-5-5`])
  } finally {
    await m.close()
  }
})

Deno.test(`records each tool call's duration, error, truncated output and resumed agent`, async () => {
  const m = await machine()
  try {
    await Deno.writeTextFile(
      m.main,
      jsonl([
        toolUse(at(0), `msg-1`, `tool-1`, `Bash`, { command: `gh pr checks 1 --watch` }),
        toolResult(at(3), `tool-1`, `z`.repeat(OUTPUT_LIMIT + 100), { isError: true }),
        toolUse(at(4), `msg-2`, `tool-2`, `SendMessage`, { to: `a1` }),
        toolResult(at(5), `tool-2`, `ok`, { resumedAgentId: `a1` }),
        {
          type: `pr-link`,
          sessionId: SID,
          prUrl: `https://github.com/o/r/pull/1`,
          timestamp: at(6),
        },
        { type: `custom-title`, sessionId: SID, customTitle: `My title` },
      ]),
    )
    await m.run()

    const rows = await m.db.queryAll<Record<string, unknown>>(
      `SELECT id, duration_ms, is_error, length(output) AS out, resumed_agent_id FROM tool_calls
       ORDER BY id`,
    )
    assertEquals(rows.map((r) => [r.id, r.duration_ms, r.is_error, r.out, r.resumed_agent_id]), [
      [`tool-1`, 180_000, 1, OUTPUT_LIMIT, null],
      [`tool-2`, 60_000, 0, 2, `a1`],
    ])
    const s = await session(m.db)
    assertEquals([s.tool_calls, s.tool_errors, s.ci_wait_sec, s.prs], [2, 1, 180, 1])
    assertEquals(s.title, `My title`)
    const slow = await m.db.queryOne(`SELECT tool, summary, sec FROM v_slow_steps`)
    assertEquals(slow, { tool: `Bash`, summary: `gh pr checks 1 --watch`, sec: 180 })
  } finally {
    await m.close()
  }
})

Deno.test(`keeps subagents' numbers out of the parent and counts review rounds and rework`, async () => {
  const m = await machine()
  try {
    await Deno.writeTextFile(
      m.main,
      jsonl([
        toolUse(at(0), `msg-1`, `spawn-r`, `Agent`, { subagent_type: `reviewer` }),
        toolUse(at(1), `msg-2`, `spawn-i`, `Agent`, { subagent_type: `implementer` }),
        toolUse(at(2), `msg-3`, `spawn-x`, `Agent`, { subagent_type: `implementer-xhigh` }),
        toolUse(at(3), `msg-4`, `send-r`, `SendMessage`, { to: `rev` }),
        toolResult(at(4), `send-r`, `ok`, { resumedAgentId: `rev` }),
        toolUse(at(5), `msg-5`, `send-i`, `SendMessage`, { to: `imp` }),
        toolResult(at(6), `send-i`, `ok`, { resumedAgentId: `imp` }),
      ]),
    )
    const work = [assistant(at(1), `sub-msg`, [{ type: `text`, text: `x` }], { output: 1_000_000 })]
    await m.subagent(`rev`, { agentType: `reviewer`, toolUseId: `spawn-r` }, work)
    await m.subagent(`imp`, { agentType: `implementer`, toolUseId: `spawn-i` }, [
      assistant(at(2), `sub-msg-2`, [], {}),
    ])
    await m.subagent(`xh`, { agentType: `implementer-xhigh`, toolUseId: `spawn-x` }, [
      assistant(at(3), `sub-msg-3`, [], {}),
    ])
    await m.run()

    const parent = await session(m.db)
    // Five main-session calls at 1M input each: $20, none of the subagents' spend.
    assertEquals(parent.cost_usd, 20)
    assertEquals(parent.review_rounds, 2)
    assertEquals(parent.rework, 2)
    const reviewer = await session(m.db, `${SID}:rev`)
    assertEquals([reviewer.kind, reviewer.parent_id, reviewer.agent_type], [
      `subagent`,
      SID,
      `reviewer`,
    ])
    assertEquals(reviewer.cost_usd, 24)

    const rollup = await m.db.queryOne(
      `SELECT cost_usd, tree_cost_usd, descendants FROM v_session_rollup WHERE id = ?`,
      SID,
    )
    assertEquals(rollup, { cost_usd: 20, tree_cost_usd: 52, descendants: 3 })
  } finally {
    await m.close()
  }
})

Deno.test(`every view answers on a database without agent-run's tables`, async () => {
  const m = await machine()
  try {
    await Deno.writeTextFile(m.main, jsonl([userText(at(0), `a`), userText(at(15), `b`)]))
    await m.run()
    for (
      const view of [
        `v_sessions`,
        `v_session_rollup`,
        `v_daily_spend`,
        `v_tool_stats`,
        `v_slow_steps`,
        `v_stalls`,
        `v_waste`,
        `v_goal`,
      ]
    ) {
      await m.db.queryAll(`SELECT * FROM ${view}`)
    }
    const stall = await m.db.queryOne(`SELECT session_id, gap_sec FROM v_stalls`)
    assertEquals(stall, { session_id: SID, gap_sec: 900 })
  } finally {
    await m.close()
  }
})

Deno.test(`links a headless run's session to its run, its parent run and the day's goal`, async () => {
  const m = await machine()
  try {
    await m.db.exec(LANE_A)
    const parent = `0190a1b2-0000-7000-8000-0000000000aa`
    await m.db.execute(
      `INSERT INTO runs (id, name, mode, model, effort, cwd, parent, started_at, status,
         cost_micros) VALUES (?, 'lead', 3, 'opus', 'medium', '/', ?, ?, 'done', 4000000)`,
      SID,
      parent,
      at(0),
    )
    for (const [issue, status] of [[`o/r#1`, `done`], [`o/r#2`, `done`], [`o/r#3`, `queued`]]) {
      await m.db.execute(
        `INSERT INTO queue (issue, title, source, rank, status, planned_at, updated_at)
         VALUES (?, 't', 'backlog', 1, ?, ?, ?)`,
        issue,
        status,
        at(0),
        at(30),
      )
    }
    await Deno.writeTextFile(
      m.main,
      jsonl([
        toolUse(at(0), `msg-1`, `spawn-r`, `Agent`, { subagent_type: `reviewer` }),
        toolUse(at(1), `msg-2`, `rev-1`, `Bash`, { command: `git revert abc123` }),
        {
          type: `pr-link`,
          sessionId: SID,
          prUrl: `https://github.com/o/r/pull/1`,
          timestamp: at(2),
        },
        {
          type: `pr-link`,
          sessionId: SID,
          prUrl: `https://github.com/o/r/pull/2`,
          timestamp: at(3),
        },
      ]),
    )
    await m.subagent(`rev`, { agentType: `reviewer`, toolUseId: `spawn-r` }, [
      assistant(at(1), `sub-msg`, [], {}),
    ])
    await m.run()

    const s = await session(m.db)
    assertEquals([s.kind, s.run_id, s.parent_id], [`headless`, SID, parent])
    const goal = await m.db.queryOne(`SELECT * FROM v_goal`)
    assertEquals(goal, {
      day: `2026-01-01`,
      merged_issues: 2,
      cost_usd: 4,
      issues_per_dollar: 0.5,
      reverts: 1,
      reviewer_rounds_per_pr: 0.5,
    })
    const spend = await m.db.queryAll(`SELECT day, kind, sessions FROM v_daily_spend ORDER BY kind`)
    assertEquals(spend, [
      { day: `2026-01-01`, kind: `headless`, sessions: 1 },
      { day: `2026-01-01`, kind: `subagent`, sessions: 1 },
    ])
  } finally {
    await m.close()
  }
})
