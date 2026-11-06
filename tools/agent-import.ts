#!/usr/bin/env -S deno run -A
// Imports Claude Code transcripts into the run database, so every session on this machine can be
// measured on its own: tokens, cost, wall time, tool calls, review rounds, CI wait, rework, PRs.
// Design and the views: docs/headless-runs.md, "Session database".
//
// Usage: deno run -A tools/agent-import.ts
//   CLAUDE_PROJECTS_DIR  transcripts root (default ~/.claude/projects)
//   AGENT_RUN_HOME       database folder (default ~/.local/state/agent-run), kept at mode 0700
//
// Runs from agent-import.timer every 10 minutes. The first run stores `meta.import_since`; only
// entries from that moment on are imported, and files last modified before it are never read.
// Each later run reads only the complete lines appended since the last one.

import { DatabaseSync } from "node:sqlite"
import { join } from "jsr:@std/path@^1.0.0"
import { type FileSystemPort, processEnv, runtimeFileSystem } from "@spy4x/platform/server"
import { readJsonFile } from "@spy4x/platform/server/atomic-json"
import { openSqliteDb, type SqliteDb } from "@spy4x/server/db/sqlite"
import { type AgentMeta, costOf, type RawUsage, toCall, totalOf } from "./session-cost.ts"

// ===== Files =====

/**
 * The file access the importer needs: `@spy4x/platform`'s `FileSystemPort`, with the optional
 * `stat` and `readBytes` it relies on (mtime and ranged reads) made required. `runtimeFiles` below
 * is the real one; tests pass a wrapper that counts or fakes reads.
 */
export type Files =
  & Pick<FileSystemPort, `readDir` | `mkdirp`>
  & Required<Pick<FileSystemPort, `stat` | `readBytes`>>

/** `runtimeFileSystem` as `Files`, so the importer runs unchanged on Deno, Node and Bun. */
export const runtimeFiles: Files = asFiles(runtimeFileSystem)

/** `fs` as `Files`; throws when it lacks `stat` or `readBytes`. */
function asFiles(fs: FileSystemPort): Files {
  const { stat, readBytes } = fs
  if (!stat || !readBytes) {
    throw new Error(`agent-import needs a file system with stat and readBytes`)
  }
  return { readDir: fs.readDir, mkdirp: fs.mkdirp, stat, readBytes }
}

/** One transcript file to import, and the session it belongs to. */
interface Transcript {
  readonly path: string
  readonly project: string
  readonly sessionId: string
  /** The transcript's own `sessionId`: the main session, also for a subagent. */
  readonly transcriptSession: string
  /** Set for a subagent transcript: its sibling `agent-*.meta.json`. */
  readonly metaPath?: string
}

/** Every main and subagent transcript under `root`. */
async function listTranscripts(files: Files, root: string): Promise<Transcript[]> {
  const out: Transcript[] = []
  for (const project of await files.readDir(root)) {
    if (!project.isDirectory) continue
    const projectDir = join(root, project.name)
    for (const entry of await files.readDir(projectDir)) {
      if (entry.isFile && entry.name.endsWith(`.jsonl`)) {
        const id = entry.name.slice(0, -`.jsonl`.length)
        out.push({
          path: join(projectDir, entry.name),
          project: project.name,
          sessionId: id,
          transcriptSession: id,
        })
      } else if (entry.isDirectory) {
        const subagents = join(projectDir, entry.name, `subagents`)
        for (const file of await files.readDir(subagents)) {
          const match = file.isFile && file.name.match(/^agent-(.+)\.jsonl$/)
          if (!match) continue
          out.push({
            path: join(subagents, file.name),
            project: project.name,
            sessionId: `${entry.name}:${match[1]}`,
            transcriptSession: entry.name,
            metaPath: join(subagents, `agent-${match[1]}.meta.json`),
          })
        }
      }
    }
  }
  return out
}

// ===== Parsing =====

/** Tool output is cut to this many bytes before it is stored. */
export const OUTPUT_LIMIT = 16 * 1024

/** What one read of a transcript adds to the database. */
export interface Batch {
  cwd?: string
  gitBranch?: string
  entrypoint?: string
  title?: string
  firstAt?: string
  lastAt?: string
  readonly messages: {
    uuid: string
    at: string
    role: string
    messageId?: string
    model?: string
    text?: string
  }[]
  /** Usage per `message.id`, the last line of each id winning. */
  readonly calls: Map<string, { at: string; model: string; usage: RawUsage }>
  readonly toolUses: { id: string; name: string; input: string; at: string }[]
  readonly toolResults: {
    id: string
    at: string
    isError: boolean
    output: string
    resumedAgentId?: string
  }[]
  readonly prs: { url: string; repo?: string; number?: number; at: string }[]
}

type Json = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === `string` ? value : undefined
}

/** The text blocks of a message's content, joined; `undefined` when there are none. */
function textOf(content: unknown): string | undefined {
  if (typeof content === `string`) return content || undefined
  if (!Array.isArray(content)) return undefined
  const texts = content.filter((block) => block?.type === `text` && typeof block.text === `string`)
    .map((block) => block.text as string)
  return texts.length > 0 ? texts.join(`\n`) : undefined
}

/** Cuts `text` to at most `limit` UTF-8 bytes. */
export function truncateBytes(text: string, limit = OUTPUT_LIMIT): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= limit) return text
  return new TextDecoder().decode(bytes.subarray(0, limit))
}

/**
 * Parses complete transcript lines into a batch. Entries with a `timestamp` before `since` are
 * dropped; a `custom-title` entry has no timestamp and is always kept. Pure: no I/O.
 */
export function parseLines(lines: string[], since: string): Batch {
  const batch: Batch = { messages: [], calls: new Map(), toolUses: [], toolResults: [], prs: [] }
  for (const line of lines) {
    if (line.trim().length === 0) continue
    let entry: Json
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === `custom-title`) {
      batch.title = str(entry.customTitle) ?? batch.title
      continue
    }
    const at = str(entry.timestamp)
    if (at === undefined || at < since) continue

    if (entry.type === `pr-link`) {
      const url = str(entry.prUrl)
      if (url) {
        const number = typeof entry.prNumber === `number` ? entry.prNumber : undefined
        batch.prs.push({ url, repo: str(entry.prRepository), number, at })
      }
      continue
    }
    if (entry.type !== `user` && entry.type !== `assistant`) continue
    const uuid = str(entry.uuid)
    const message = entry.message as Json | undefined
    if (uuid === undefined || message === undefined) continue

    batch.firstAt ??= at
    batch.lastAt = at
    batch.cwd ??= str(entry.cwd)
    batch.gitBranch ??= str(entry.gitBranch)
    batch.entrypoint ??= str(entry.entrypoint)

    const messageId = str(message.id)
    const model = str(message.model)
    batch.messages.push({
      uuid,
      at,
      role: str(message.role) ?? entry.type,
      messageId,
      model,
      text: textOf(message.content),
    })

    const usage = message.usage
    if (messageId && model && !model.startsWith(`<`) && typeof usage === `object` && usage) {
      batch.calls.set(messageId, { at, model, usage: usage as RawUsage })
    }

    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Json[]) {
      if (block?.type === `tool_use` && typeof block.id === `string`) {
        batch.toolUses.push({
          id: block.id,
          name: str(block.name) ?? ``,
          input: JSON.stringify(block.input ?? null),
          at,
        })
      } else if (block?.type === `tool_result` && typeof block.tool_use_id === `string`) {
        const result = entry.toolUseResult as Json | undefined
        batch.toolResults.push({
          id: block.tool_use_id,
          at,
          isError: block.is_error === true,
          output: truncateBytes(textOf(block.content) ?? ``),
          resumedAgentId: typeof result === `object` && result !== null
            ? str(result.resumedAgentId)
            : undefined,
        })
      }
    }
  }
  return batch
}

// ===== Database =====

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS transcript_files (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  offset INTEGER NOT NULL,
  mtime_ms REAL NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  transcript_session TEXT NOT NULL,
  parent_id TEXT,
  is_subagent INTEGER NOT NULL,
  agent_type TEXT,
  description TEXT,
  spawn_tool_use_id TEXT,
  project TEXT NOT NULL,
  cwd TEXT,
  git_branch TEXT,
  entrypoint TEXT,
  title TEXT,
  started_at TEXT,
  ended_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_by_parent ON sessions(parent_id);
CREATE TABLE IF NOT EXISTS messages (
  uuid TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL,
  role TEXT NOT NULL,
  message_id TEXT,
  model TEXT,
  text TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session_id, at);
CREATE TABLE IF NOT EXISTS api_calls (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_5m_tokens INTEGER NOT NULL,
  cache_write_1h_tokens INTEGER NOT NULL,
  cost_micros INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS api_calls_by_session ON api_calls(session_id);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  is_error INTEGER,
  output TEXT,
  resumed_agent_id TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS tool_calls_by_session ON tool_calls(session_id);
CREATE TABLE IF NOT EXISTS session_prs (
  session_id TEXT NOT NULL,
  url TEXT NOT NULL,
  repo TEXT,
  number INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, url)
) STRICT;
`

/** SQL that is true when a tool call's `command` input matches any `LIKE` pattern (no case). */
function commandLike(patterns: string[]): string {
  return patterns.map((p) => `json_extract(input, '$.command') LIKE '${p.replaceAll(`'`, `''`)}'`)
    .join(` OR `)
}

/** A Bash command that waits on CI. */
const CI_WAIT = commandLike([`%gh pr checks%`, `%gh run watch%`, `%--watch%`, `%woodpecker%`])

/** A Bash command that makes a revert: `git revert`, or a PR titled "Revert …". */
const REVERT = commandLike([
  `%git revert%`,
  `%gh pr create%--title "revert%`,
  `%gh pr create%--title 'revert%`,
])

/**
 * The analysis views. `runs` and `queue` belong to agent-run.ts; while either table is missing,
 * an empty stand-in with the same columns keeps every view queryable, and the next import, which
 * recreates the views, picks the real table up.
 */
function viewsSql(has: { runs: boolean; queue: boolean }): string {
  const runs = has.runs
    ? `runs`
    : `(SELECT NULL AS id, NULL AS parent, NULL AS cost_micros, NULL AS started_at WHERE 0)`
  const queue = has.queue ? `queue` : `(SELECT NULL AS status, NULL AS updated_at WHERE 0)`
  return `
DROP VIEW IF EXISTS v_goal;
DROP VIEW IF EXISTS v_waste;
DROP VIEW IF EXISTS v_stalls;
DROP VIEW IF EXISTS v_slow_steps;
DROP VIEW IF EXISTS v_tool_stats;
DROP VIEW IF EXISTS v_daily_spend;
DROP VIEW IF EXISTS v_session_rollup;
DROP VIEW IF EXISTS v_sessions;
DROP VIEW IF EXISTS v_session_kind;

CREATE VIEW v_session_kind AS
SELECT s.id, COALESCE(s.parent_id, r.parent) AS parent_id, r.id AS run_id,
  CASE WHEN s.is_subagent THEN 'subagent' WHEN r.id IS NOT NULL THEN 'headless'
    ELSE 'interactive' END AS kind
FROM sessions s LEFT JOIN ${runs} r ON r.id = s.id;

CREATE VIEW v_sessions AS
WITH
calls AS (
  SELECT session_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens,
    SUM(cost_micros) AS cost_micros, SUM(cost_micros IS NULL) AS unpriced_calls,
    group_concat(DISTINCT model) AS models
  FROM api_calls GROUP BY session_id),
top_model AS (
  SELECT session_id, model,
    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY COUNT(*) DESC, model) AS n
  FROM api_calls GROUP BY session_id, model),
tools AS (
  SELECT session_id, COUNT(*) AS tool_calls, SUM(COALESCE(is_error, 0)) AS tool_errors,
    ROUND(SUM(CASE WHEN name = 'Bash' AND (${CI_WAIT}) THEN COALESCE(duration_ms, 0) ELSE 0 END)
      / 1000.0, 1) AS ci_wait_sec
  FROM tool_calls GROUP BY session_id),
resumed AS (
  SELECT t.session_id,
    SUM(a.agent_type IN ('reviewer', 'design-reviewer')) AS reviewer_resumes,
    SUM(a.agent_type LIKE 'implementer%') AS implementer_resumes
  FROM tool_calls t
  JOIN sessions s ON s.id = t.session_id
  JOIN sessions a ON a.id = s.transcript_session || ':' || t.resumed_agent_id
  WHERE t.name = 'SendMessage' AND t.resumed_agent_id IS NOT NULL
  GROUP BY t.session_id),
spawned AS (
  SELECT parent_id AS session_id,
    SUM(agent_type IN ('reviewer', 'design-reviewer')) AS reviewer_spawns,
    SUM(agent_type = 'implementer-xhigh') AS xhigh_spawns
  FROM sessions WHERE is_subagent = 1 GROUP BY parent_id),
prs AS (SELECT session_id, COUNT(DISTINCT url) AS prs FROM session_prs GROUP BY session_id)
SELECT s.id, k.parent_id, k.run_id, k.kind, s.agent_type, s.project, s.cwd, s.started_at,
  s.ended_at, ROUND((julianday(s.ended_at) - julianday(s.started_at)) * 86400) AS wall_sec,
  m.model, COALESCE(c.input_tokens, 0) AS input_tokens,
  COALESCE(c.output_tokens, 0) AS output_tokens,
  COALESCE(c.cache_read_tokens, 0) AS cache_read_tokens,
  COALESCE(c.cache_write_tokens, 0) AS cache_write_tokens,
  CASE WHEN c.session_id IS NULL THEN 0 ELSE c.cost_micros / 1e6 END AS cost_usd,
  COALESCE(t.tool_calls, 0) AS tool_calls, COALESCE(t.tool_errors, 0) AS tool_errors,
  COALESCE(sp.reviewer_spawns, 0) + COALESCE(r.reviewer_resumes, 0) AS review_rounds,
  COALESCE(t.ci_wait_sec, 0) AS ci_wait_sec,
  COALESCE(sp.xhigh_spawns, 0) + COALESCE(r.implementer_resumes, 0) AS rework,
  COALESCE(p.prs, 0) AS prs,
  s.title, s.description, s.git_branch, s.entrypoint, c.models,
  COALESCE(c.unpriced_calls, 0) AS unpriced_calls
FROM sessions s
JOIN v_session_kind k ON k.id = s.id
LEFT JOIN calls c ON c.session_id = s.id
LEFT JOIN top_model m ON m.session_id = s.id AND m.n = 1
LEFT JOIN tools t ON t.session_id = s.id
LEFT JOIN resumed r ON r.session_id = s.id
LEFT JOIN spawned sp ON sp.session_id = s.id
LEFT JOIN prs p ON p.session_id = s.id;

CREATE VIEW v_session_rollup AS
WITH RECURSIVE
own AS MATERIALIZED (SELECT id, cost_usd, wall_sec FROM v_sessions),
up(id, ancestor) AS (
  SELECT id, id FROM sessions
  UNION
  SELECT up.id, k.parent_id FROM up JOIN v_session_kind k ON k.id = up.ancestor
  WHERE k.parent_id IS NOT NULL),
tree AS (
  SELECT up.ancestor AS id, SUM(o.cost_usd) AS tree_cost_usd, SUM(o.wall_sec) AS tree_wall_sec,
    COUNT(*) - 1 AS descendants
  FROM up JOIN own o ON o.id = up.id GROUP BY up.ancestor)
SELECT o.id, o.cost_usd, o.wall_sec, t.tree_cost_usd, t.tree_wall_sec, t.descendants
FROM own o JOIN tree t ON t.id = o.id;

CREATE VIEW v_daily_spend AS
SELECT date(a.at, 'localtime') AS day, k.kind, COUNT(DISTINCT a.session_id) AS sessions,
  SUM(a.cost_micros) / 1e6 AS cost_usd
FROM api_calls a JOIN v_session_kind k ON k.id = a.session_id
GROUP BY 1, 2 ORDER BY 1 DESC, 2;

CREATE VIEW v_tool_stats AS
SELECT name AS tool, COUNT(*) AS calls, SUM(COALESCE(is_error, 0)) AS errors,
  ROUND(SUM(duration_ms) / 1000.0, 1) AS total_sec, ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_sec,
  ROUND(MAX(duration_ms) / 1000.0, 1) AS max_sec
FROM tool_calls GROUP BY name ORDER BY total_sec DESC;

CREATE VIEW v_slow_steps AS
SELECT session_id, started_at AS at, name AS tool,
  substr(COALESCE(json_extract(input, '$.description'), json_extract(input, '$.command'),
    json_extract(input, '$.file_path'), json_extract(input, '$.pattern'),
    json_extract(input, '$.query'), json_extract(input, '$.url'), input), 1, 120) AS summary,
  ROUND(duration_ms / 1000.0, 1) AS sec, COALESCE(is_error, 0) AS is_error
FROM tool_calls WHERE duration_ms IS NOT NULL ORDER BY duration_ms DESC;

CREATE VIEW v_stalls AS
SELECT session_id, from_at, to_at, gap_sec FROM (
  SELECT session_id, LAG(at) OVER w AS from_at, at AS to_at,
    ROUND((julianday(at) - julianday(LAG(at) OVER w)) * 86400) AS gap_sec
  FROM messages WINDOW w AS (PARTITION BY session_id ORDER BY at))
WHERE gap_sec >= 600 ORDER BY gap_sec DESC;

CREATE VIEW v_waste AS
WITH repeats AS (
  SELECT session_id, COUNT(*) - COUNT(DISTINCT name || char(0) || input) AS repeated_calls
  FROM tool_calls GROUP BY session_id)
SELECT s.id AS session_id, s.cost_usd, COALESCE(x.repeated_calls, 0) AS repeated_calls,
  s.tool_errors AS failed_calls, s.review_rounds, s.rework, s.ci_wait_sec,
  CASE WHEN s.prs > 0 THEN ROUND(s.cost_usd / s.prs, 2) END AS cost_per_pr,
  s.kind, s.started_at
FROM v_sessions s LEFT JOIN repeats x ON x.session_id = s.id
ORDER BY s.cost_usd DESC;

CREATE VIEW v_goal AS
WITH
done AS (
  SELECT date(updated_at, 'localtime') AS day, COUNT(*) AS merged_issues
  FROM ${queue} WHERE status = 'done' GROUP BY 1),
spend AS (
  SELECT date(started_at, 'localtime') AS day, SUM(cost_micros) / 1e6 AS cost_usd
  FROM ${runs} GROUP BY 1),
rounds AS (
  SELECT date(started_at, 'localtime') AS day, SUM(review_rounds) AS rounds, SUM(prs) AS prs
  FROM v_sessions WHERE kind = 'headless' GROUP BY 1),
reverts AS (
  SELECT date(started_at, 'localtime') AS day, COUNT(DISTINCT session_id) AS reverts
  FROM tool_calls WHERE name = 'Bash' AND (${REVERT}) GROUP BY 1),
days AS (
  SELECT day FROM done UNION SELECT day FROM spend UNION SELECT day FROM rounds
  UNION SELECT day FROM reverts)
SELECT days.day, COALESCE(done.merged_issues, 0) AS merged_issues,
  COALESCE(spend.cost_usd, 0) AS cost_usd,
  CASE WHEN spend.cost_usd > 0 THEN ROUND(COALESCE(done.merged_issues, 0) / spend.cost_usd, 4)
    END AS issues_per_dollar,
  COALESCE(reverts.reverts, 0) AS reverts,
  CASE WHEN rounds.prs > 0 THEN ROUND(rounds.rounds * 1.0 / rounds.prs, 2)
    END AS reviewer_rounds_per_pr
FROM days
LEFT JOIN done ON done.day = days.day
LEFT JOIN spend ON spend.day = days.day
LEFT JOIN rounds ON rounds.day = days.day
LEFT JOIN reverts ON reverts.day = days.day
WHERE days.day IS NOT NULL
ORDER BY days.day DESC;
`
}

/** Open (and create) the database in `home`, which is kept at mode 0700. */
export async function openImportDb(files: Files, home: string): Promise<SqliteDb> {
  await files.mkdirp(home, { mode: 0o700 })
  const db = await openSqliteDb({
    path: join(home, `runs.sqlite`),
    createDriver: ({ path }) => new DatabaseSync(path),
    createDirectory: () => {},
    foreignKeys: false,
  })
  await db.exec(`PRAGMA busy_timeout = 10000`)
  await db.exec(`PRAGMA journal_mode = WAL`)
  await db.exec(SCHEMA)
  return db
}

/** Recreate every view, against `runs` and `queue` when they exist. */
async function recreateViews(db: SqliteDb): Promise<void> {
  const tables = await db.queryAll<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runs', 'queue')`,
  )
  const names = new Set(tables.map((table) => table.name))
  await db.exec(viewsSql({ runs: names.has(`runs`), queue: names.has(`queue`) }))
}

/** The moment imports start from: stored by the first run, read by every later one. */
async function importSince(db: SqliteDb, now: Date): Promise<string> {
  await db.execute(
    `INSERT OR IGNORE INTO meta (key, value) VALUES ('import_since', ?)`,
    now.toISOString(),
  )
  const row = await db.queryOne<{ value: string }>(
    `SELECT value FROM meta WHERE key = 'import_since'`,
  )
  return row!.value
}

/** Writes one batch and the file's new offset in one short transaction. */
async function writeBatch(
  db: SqliteDb,
  file: Transcript,
  meta: (AgentMeta & { toolUseId?: string }) | undefined,
  batch: Batch,
  state: { offset: number; mtimeMs: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    // A write comes first, so the transaction takes the write lock (and waits for it) at once.
    await tx.execute(
      `INSERT INTO transcript_files (path, session_id, offset, mtime_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (path) DO UPDATE SET offset = excluded.offset, mtime_ms = excluded.mtime_ms`,
      file.path,
      file.sessionId,
      state.offset,
      state.mtimeMs,
    )
    if (batch.firstAt !== undefined) {
      await tx.execute(
        `INSERT INTO sessions (id, transcript_session, parent_id, is_subagent, agent_type,
           description, spawn_tool_use_id, project, cwd, git_branch, entrypoint, title, started_at,
           ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           agent_type = COALESCE(excluded.agent_type, agent_type),
           description = COALESCE(excluded.description, description),
           spawn_tool_use_id = COALESCE(excluded.spawn_tool_use_id, spawn_tool_use_id),
           cwd = COALESCE(cwd, excluded.cwd),
           git_branch = COALESCE(git_branch, excluded.git_branch),
           entrypoint = COALESCE(entrypoint, excluded.entrypoint),
           title = COALESCE(excluded.title, title),
           started_at = MIN(started_at, excluded.started_at),
           ended_at = MAX(ended_at, excluded.ended_at)`,
        file.sessionId,
        file.transcriptSession,
        file.metaPath ? file.transcriptSession : null,
        file.metaPath ? 1 : 0,
        meta?.agentType ?? null,
        meta?.description ?? null,
        meta?.toolUseId ?? null,
        file.project,
        batch.cwd ?? null,
        batch.gitBranch ?? null,
        batch.entrypoint ?? null,
        batch.title ?? null,
        batch.firstAt,
        batch.lastAt,
      )
    } else if (batch.title !== undefined) {
      await tx.execute(`UPDATE sessions SET title = ? WHERE id = ?`, batch.title, file.sessionId)
    }
    for (const m of batch.messages) {
      await tx.execute(
        `INSERT OR IGNORE INTO messages (uuid, session_id, at, role, message_id, model, text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        m.uuid,
        file.sessionId,
        m.at,
        m.role,
        m.messageId ?? null,
        m.model ?? null,
        m.text ?? null,
      )
    }
    for (const [messageId, { at, model, usage }] of batch.calls) {
      const call = toCall(at, model, usage)
      const { cost, priced } = costOf(call)
      await tx.execute(
        `INSERT INTO api_calls (message_id, session_id, at, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cost_micros)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (message_id) DO UPDATE SET input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens,
           cache_write_5m_tokens = excluded.cache_write_5m_tokens,
           cache_write_1h_tokens = excluded.cache_write_1h_tokens,
           cost_micros = excluded.cost_micros`,
        messageId,
        file.sessionId,
        at,
        model,
        call.inputTokens,
        call.outputTokens,
        call.cacheReadTokens,
        call.cache5mTokens,
        call.cache1hTokens,
        priced ? Math.round(totalOf(cost) * 1_000_000) : null,
      )
    }
    for (const use of batch.toolUses) {
      await tx.execute(
        `INSERT OR IGNORE INTO tool_calls (id, session_id, name, input, started_at)
         VALUES (?, ?, ?, ?, ?)`,
        use.id,
        file.sessionId,
        use.name,
        use.input,
        use.at,
      )
    }
    for (const result of batch.toolResults) {
      await tx.execute(
        `UPDATE tool_calls SET ended_at = ?, is_error = ?, output = ?, resumed_agent_id = ?,
           duration_ms = CAST(ROUND((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER)
         WHERE id = ?`,
        result.at,
        result.isError ? 1 : 0,
        result.output,
        result.resumedAgentId ?? null,
        result.at,
        result.id,
      )
    }
    for (const pr of batch.prs) {
      await tx.execute(
        `INSERT OR IGNORE INTO session_prs (session_id, url, repo, number, at)
         VALUES (?, ?, ?, ?, ?)`,
        file.sessionId,
        pr.url,
        pr.repo ?? null,
        pr.number ?? null,
        pr.at,
      )
    }
  })
}

// ===== Import =====

/** What one import did. */
export interface ImportStats {
  /** Transcript files read (in part or whole). */
  files: number
  /** Complete lines read. */
  lines: number
}

/** What `importTranscripts` needs. */
export interface ImportOptions {
  readonly files: Files
  readonly db: SqliteDb
  readonly projectsDir: string
  readonly now: () => Date
  /** Bytes read per transaction; a longer line grows the read until it is whole. */
  readonly chunkBytes?: number
}

/**
 * Imports every transcript under `projectsDir` that changed since the last run, from the stored
 * byte offset on, one transaction per chunk. Skips files last modified before `import_since`
 * without reading them, re-reads a file that shrank from byte 0 (the primary keys drop what is
 * already stored), then links subagents to the session whose tool call spawned them and
 * recreates the views.
 */
export async function importTranscripts(options: ImportOptions): Promise<ImportStats> {
  const { files, db, projectsDir } = options
  const chunkBytes = options.chunkBytes ?? 8 * 1024 * 1024
  const since = await importSince(db, options.now())
  const sinceMs = Date.parse(since)
  const stats: ImportStats = { files: 0, lines: 0 }
  const decoder = new TextDecoder()

  for (const file of await listTranscripts(files, projectsDir)) {
    const stat = await files.stat(file.path)
    if (stat === null || stat.mtimeMs < sinceMs) continue
    const known = await db.queryOne<{ offset: number; mtime_ms: number }>(
      `SELECT offset, mtime_ms FROM transcript_files WHERE path = ?`,
      file.path,
    )
    if (known && known.mtime_ms === stat.mtimeMs) continue
    let offset = known && known.offset <= stat.size ? known.offset : 0
    if (offset >= stat.size) {
      await db.execute(
        `UPDATE transcript_files SET mtime_ms = ? WHERE path = ?`,
        stat.mtimeMs,
        file.path,
      )
      continue
    }

    const meta = file.metaPath
      ? await readJsonFile<AgentMeta & { toolUseId?: string }>(runtimeFileSystem, file.metaPath)
      : undefined
    stats.files++
    let length = chunkBytes
    while (offset < stat.size) {
      const bytes = await files.readBytes(file.path, {
        offset,
        length: Math.min(length, stat.size - offset),
      })
      if (bytes === null) break
      const end = bytes.lastIndexOf(10)
      if (end < 0) {
        // No complete line yet: a longer line grows the read; an unfinished last line waits.
        if (offset + bytes.length >= stat.size) break
        length *= 2
        continue
      }
      const lines = decoder.decode(bytes.subarray(0, end)).split(`\n`)
      offset += end + 1
      stats.lines += lines.length
      const batch = parseLines(lines, since)
      await writeBatch(db, file, meta?.kind === `ok` ? meta.value : undefined, batch, {
        offset,
        mtimeMs: stat.mtimeMs,
      })
      length = chunkBytes
    }
  }

  await db.execute(
    `UPDATE sessions SET parent_id = COALESCE(
       (SELECT session_id FROM tool_calls WHERE id = sessions.spawn_tool_use_id),
       transcript_session)
     WHERE is_subagent = 1`,
  )
  await recreateViews(db)
  return stats
}

// ===== Entry point =====

if (import.meta.main) {
  const home = processEnv.get(`HOME`)
  if (!home) throw new Error(`HOME is not set`)
  const projectsDir = processEnv.get(`CLAUDE_PROJECTS_DIR`) ?? join(home, `.claude`, `projects`)
  const stateHome = processEnv.get(`AGENT_RUN_HOME`) ?? join(home, `.local`, `state`, `agent-run`)
  const db = await openImportDb(runtimeFiles, stateHome)
  try {
    const stats = await importTranscripts({
      files: runtimeFiles,
      db,
      projectsDir,
      now: () => new Date(),
    })
    console.log(`agent-import: read ${stats.lines} lines from ${stats.files} files`)
  } finally {
    await db.close()
  }
}
