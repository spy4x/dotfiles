#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env=HOME
// Keeps the open items of ai-memory's TASKS.md on the phone: one VTODO per open top-level
// checkbox in the CalDAV calendar "1.1 / Plan 90d", which Tasks.org shows.
//
// Each run pulls first (tasks completed on the phone are reported, so the planning run can tick
// the line with evidence), then pushes. TASKS.md wins on wording, date, order and priority; a tick
// wins from either side. A push changes only the properties it owns through `patchTodo`, so
// reminders and `X-` properties added on the phone survive. A line that disappears is CANCELLED
// on the server, never deleted. Recurring items ("every ...") are not pushed.
//
// Every pushed line gets a hidden `<!-- id:xxxxxx -->` comment at the end of its first line; the
// task's UID is `tasksmd-<id>@antonshubin.com`.
//
// Usage: deno run --allow-read --allow-write --allow-net --allow-env=HOME caldav-sync.ts [--apply]
//          [--pull | --push] [--tasks <file>] [--env <file>] [--calendar <name>]
// Without `--apply` nothing is written anywhere: the plan is printed. Credentials
// (CALDAV_SERVER_URL, CALDAV_USERNAME, CALDAV_PASSWORD) come from the env file.

import { basename, dirname } from "jsr:@std/path@1.1.6"
import {
  type CalDavClient,
  CalDavErrorCode,
  type CalDavObject,
  createCalDavClient,
} from "jsr:@spy4x/caldav@1.44.0"
import {
  newTodo,
  patchTodo,
  readTodo,
  type Todo,
  type TodoPatch,
  TodoStatus,
} from "jsr:@spy4x/time@1.44.0/ical-tasks"
import {
  type IcalComponent,
  IcalDateKind,
  parseIcal,
  serializeIcal,
} from "jsr:@spy4x/time@1.44.0/ical"

export const CALENDAR = `1.1 / Plan 90d`
const UID_PREFIX = `tasksmd-`
const UID_DOMAIN = `antonshubin.com`
const PRODID = `-//antonshubin.com//tasksmd-sync 1.0//EN`
const CATEGORY = `plan`
const SUMMARY_MAX = 80
const LINK_BASE = `https://github.com/spy4x/ai-memory/blob/main/TASKS.md`
const DEFAULT_PRIORITY = 5
const LOW_PRIORITY = 9
/** Sections whose items are ideas, not commitments: lowest priority. */
const LOW_SECTIONS = /^(Seed|Parked)\b/i

const MONTH = `(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|` +
  `Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`
const MONTH_NAMES = [
  `jan`,
  `feb`,
  `mar`,
  `apr`,
  `may`,
  `jun`,
  `jul`,
  `aug`,
  `sep`,
  `oct`,
  `nov`,
  `dec`,
]
const monthNo = (word: string) => MONTH_NAMES.indexOf(word.slice(0, 3).toLowerCase()) + 1

const pad = (n: number) => String(n).padStart(2, `0`)
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** The Monday of the week that holds an ISO date. */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

/** What an item's bold date label says: a last day, or that the item repeats. */
export interface When {
  due?: string
  recurring: boolean
}

/**
 * Reads the label of an item such as `23 Sep`, `21–22 Sep`, `By 31 Oct`, `28 Sep–4 Oct`,
 * `October 2026` or `July–September 2027`. A range counts by its last day, a month by its last
 * day. A label with "every" repeats. Anything else is not a date: `undefined`.
 */
export function parseWhen(label: string, year: number): When | undefined {
  const text = label.trim()
  if (/\bevery\b/i.test(text)) return { recurring: true }
  const body = text.replace(/^by\s+/i, ``)
  const yr = (s?: string) => (s ? Number(s) : year)
  let m = body.match(
    new RegExp(`^(\\d{1,2})\\s*[–-]\\s*(\\d{1,2})\\s+${MONTH}\\b(?:\\s+(\\d{4}))?`, `i`),
  )
  if (m) return { due: iso(yr(m[4]), monthNo(m[3]), Number(m[2])), recurring: false }
  m = body.match(
    new RegExp(
      `^(\\d{1,2})\\s+${MONTH}\\s*[–-]\\s*(\\d{1,2})\\s+${MONTH}\\b(?:\\s+(\\d{4}))?`,
      `i`,
    ),
  )
  if (m) return { due: iso(yr(m[5]), monthNo(m[4]), Number(m[3])), recurring: false }
  m = body.match(new RegExp(`^(\\d{1,2})\\s+${MONTH}\\b(?:\\s+(\\d{4}))?`, `i`))
  if (m) return { due: iso(yr(m[3]), monthNo(m[2]), Number(m[1])), recurring: false }
  m = body.match(new RegExp(`^${MONTH}\\s*[–-]\\s*${MONTH}\\b(?:\\s+(\\d{4}))?`, `i`))
  if (m) {
    const y = yr(m[3])
    return { due: iso(y, monthNo(m[2]), lastDay(y, monthNo(m[2]))), recurring: false }
  }
  m = body.match(new RegExp(`^${MONTH}\\b(?:\\s+(\\d{4}))?`, `i`))
  if (m) {
    const y = yr(m[2])
    return { due: iso(y, monthNo(m[1]), lastDay(y, monthNo(m[1]))), recurring: false }
  }
  return undefined
}

/** The first day of a section's date range, from a heading such as `Week 1 — 21 to 27 September`. */
export function sectionStart(heading: string, year: number): string | undefined {
  let m = heading.match(
    new RegExp(`\\b(\\d{1,2})(?:\\s+${MONTH})?\\s*(?:to|–|-)\\s*(\\d{1,2})\\s+${MONTH}\\b`, `i`),
  )
  if (m) return iso(year, monthNo(m[2] ?? m[4]), Number(m[1]))
  m = heading.match(new RegExp(`\\b(\\d{1,2})\\s+${MONTH}\\b`, `i`))
  return m ? iso(year, monthNo(m[2]), Number(m[1])) : undefined
}

/** One top-level checkbox of TASKS.md and everything the sync reads from it. */
export interface Item {
  /** Index of the item's first line in the file. */
  line: number
  /** Index of the item's last line in the file. */
  end: number
  /** The id written on the line, if any. */
  id?: string
  /** The id was already used by an earlier item (a copied line): it needs a fresh one. */
  copied?: boolean
  done: boolean
  /** The item's own lines, joined, without the marker, id and priority comments. */
  text: string
  /** Nested checkboxes, in file order. */
  checklist: { done: boolean; text: string }[]
  section: string
  /** `YYYY-MM-DD` of the item's last day, if its label has one. */
  due?: string
  /** The Monday of the week section the item sits in. */
  start?: string
  priority: number
  recurring: boolean
  /** Position among the items of the file. */
  order: number
}

const ID_COMMENT = /\s*<!--\s*id:([a-z0-9]{6})\s*-->/
const PRIORITY_COMMENT = /\s*<!--\s*p:([0-9])\s*-->/

const stripMarkdown = (s: string) =>
  s.replace(/\[([^\]]*)\]\([^)]*\)/g, `$1`).replace(/(\*\*|~~|`)/g, ``).replace(/\s+/g, ` `).trim()

/** The task title: the first sentence of the text, markdown removed, at most 80 characters. */
export function summarize(text: string): string {
  const plain = stripMarkdown(text)
  const sentence = plain.match(/^(.*?[.!?])(?:\s|$)/)?.[1] ?? plain
  return sentence.length > SUMMARY_MAX
    ? `${sentence.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
    : sentence
}

/** Reads the top-level checkboxes. `year` completes dates that name no year. */
export function parseTasks(text: string, fallbackYear = new Date().getUTCFullYear()): Item[] {
  const lines = text.split(/\r?\n/)
  const title = lines.find((l) => l.startsWith(`# `)) ?? ``
  const year = Number([...title.matchAll(/\b(20\d\d)\b/g)].at(-1)?.[1] ?? fallbackYear)
  const items: Item[] = []
  let section = ``
  let start: string | undefined
  let current: Item | undefined
  let inFence = false
  for (const [index, line] of lines.entries()) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) continue
    const heading = line.match(/^##\s+(.*)$/)
    if (heading) {
      section = heading[1].trim()
      start = sectionStart(section, year)
      current = undefined
      continue
    }
    const top = line.match(/^- \[([ xX])\]\s+(.*)$/)
    if (top) {
      current = {
        line: index,
        end: index,
        done: top[1] !== ` `,
        text: top[2],
        checklist: [],
        section,
        priority: LOW_SECTIONS.test(section) ? LOW_PRIORITY : DEFAULT_PRIORITY,
        recurring: false,
        order: items.length,
        start,
      }
      items.push(current)
      continue
    }
    if (!current) continue
    if (line.trim() !== `` && !/^\s/.test(line)) {
      current = undefined
      continue
    }
    if (line.trim() !== ``) current.end = index
    const nested = line.match(/^\s+- \[([ xX])\]\s+(.*)$/)
    if (nested) {
      current.checklist.push({ done: nested[1] !== ` `, text: nested[2] })
    } else if (line.trim() !== ``) {
      const target = current.checklist.at(-1)
      if (target) target.text += ` ${line.trim()}`
      else current.text += ` ${line.trim()}`
    }
  }
  const seen = new Set<string>()
  for (const item of items) {
    finish(item, year)
    if (!item.id) continue
    if (seen.has(item.id)) {
      item.copied = true
      item.id = undefined
    } else seen.add(item.id)
  }
  return items
}

/** Pulls the id, priority and date label out of the raw text and tidies the checklist. */
function finish(item: Item, year: number): void {
  const firstLineEnd = item.text
  item.id = firstLineEnd.match(ID_COMMENT)?.[1]
  const p = firstLineEnd.match(PRIORITY_COMMENT)?.[1]
  if (p !== undefined) item.priority = Number(p)
  const clean = (s: string) => s.replace(ID_COMMENT, ``).replace(PRIORITY_COMMENT, ``).trim()
  item.text = clean(item.text)
  for (const c of item.checklist) c.text = clean(c.text)
  const label = item.text.match(/^\*\*(.+?)\*\*/)
  const when = label ? parseWhen(label[1], year) : undefined
  if (when) {
    item.recurring = when.recurring
    item.due = when.due
    item.text = item.text.slice(label![0].length).replace(/^\s*·\s*/, ``).trim() || label![1]
  }
  if (item.due && item.start && item.due < item.start) item.start = undefined
}

/** A random six-character id, lower-case letters and digits. */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map((b) => `0123456789abcdefghijklmnopqrstuvwxyz`[b % 36]).join(``)
}

/**
 * Writes `<!-- id:xxxxxx -->` at the end of the first line of every item that needs one: open,
 * not recurring, no id yet. Returns the new text and the items' ids by line.
 */
export function assignIds(
  text: string,
  items: Item[],
  newId: () => string = randomId,
): { text: string; assigned: Map<number, string> } {
  const lines = text.split(`\n`)
  const taken = new Set(items.flatMap((i) => (i.id ? [i.id] : [])))
  const assigned = new Map<number, string>()
  for (const item of items) {
    if (item.id || item.done || item.recurring) continue
    let id = newId()
    while (taken.has(id)) id = newId()
    taken.add(id)
    item.id = id
    assigned.set(item.line, id)
    if (item.copied) {
      for (let i = item.line; i <= item.end; i++) lines[i] = lines[i].replace(ID_COMMENT, ``)
    }
    const cr = lines[item.line].endsWith(`\r`) ? `\r` : ``
    lines[item.line] = `${lines[item.line].trimEnd()} <!-- id:${id} -->${cr}`
  }
  return { text: lines.join(`\n`), assigned }
}

/** The task as the file wants it: only the properties the file owns. */
export function desiredTodo(item: Item): TodoPatch {
  const checklist = item.checklist.map((c) => `${c.done ? `☑` : `☐`} ${stripMarkdown(c.text)}`)
  const anchor = item.section.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, ``).replace(/\s/g, `-`)
  const parts = [stripMarkdown(item.text)]
  if (checklist.length) parts.push(checklist.join(`\n`))
  parts.push(`Section: ${item.section} — ${LINK_BASE}#${anchor}`)
  return {
    summary: summarize(item.text),
    description: parts.join(`\n\n`),
    due: item.due ? { kind: IcalDateKind.Date, date: item.due } : null,
    start: item.start ? { kind: IcalDateKind.Date, date: item.start } : null,
    priority: item.priority,
    categories: [CATEGORY],
    sortOrder: item.order,
  }
}

const sameDate = (a: { date: string; kind: IcalDateKind } | undefined, b: unknown) => {
  const want = b as { date: string } | null | undefined
  return want ? a?.kind === IcalDateKind.Date && a.date === want.date : a === undefined
}

/** The part of `want` that differs from what the server has; `{}` when the task is in step. */
export function diff(have: Todo, want: TodoPatch): TodoPatch {
  const out: TodoPatch = {}
  if (have.summary !== want.summary) out.summary = want.summary
  if (have.description !== want.description) out.description = want.description
  if (!sameDate(have.due, want.due)) out.due = want.due
  if (!sameDate(have.start, want.start)) out.start = want.start
  if ((have.priority ?? 0) !== want.priority) out.priority = want.priority
  if (have.categories.join(`,`) !== want.categories?.join(`,`)) out.categories = want.categories
  if (have.sortOrder !== want.sortOrder) out.sortOrder = want.sortOrder
  return out
}

/** The calendar as the sync needs it. */
export interface Store {
  /** Every task, completed ones included. */
  list(): Promise<CalDavObject[]>
  create(ics: string): Promise<void>
  /** Replaces the object if it still has `object.etag`; throws when it does not. */
  update(object: CalDavObject, ics: string): Promise<void>
}

/** One thing the run did, or in a dry run would do. */
export interface Action {
  kind: `create` | `update` | `complete` | `reopen` | `cancel`
  id: string
  summary: string
  /** The properties that change. */
  fields: string[]
  /** Set when applying failed. */
  error?: string
}

/** A task completed on the phone whose line is still open. */
export interface Pulled {
  id: string
  summary: string
  completed?: string
}

/** What a run found and did. */
export interface Report {
  pulled: Pulled[]
  actions: Action[]
  /** Items skipped because they repeat. */
  recurring: number
  /** TASKS.md after the run: ids written. */
  text: string
}

export interface SyncOptions {
  text: string
  store: Store
  now: Date
  apply: boolean
  pull?: boolean
  push?: boolean
  newId?: () => string
  year?: number
  /**
   * Called with the new TASKS.md text after the plan is made and before the first calendar write.
   * Writes the file, or throws to stop the run with the calendar untouched.
   */
  commitText?: (text: string) => Promise<void>
}

const isOpen = (t: Todo) => t.status !== TodoStatus.Completed && t.status !== TodoStatus.Cancelled
const uidOf = (id: string) => `${UID_PREFIX}${id}@${UID_DOMAIN}`
const idOf = (uid?: string) =>
  uid?.startsWith(UID_PREFIX) && uid.endsWith(`@${UID_DOMAIN}`)
    ? uid.slice(UID_PREFIX.length, -`@${UID_DOMAIN}`.length)
    : undefined

/** Pulls, then pushes. With `apply` false the store is only read. */
export async function sync(options: SyncOptions): Promise<Report> {
  const { store, now, apply } = options
  const doPull = options.pull ?? true
  const doPush = options.push ?? true
  const items = parseTasks(options.text, options.year)
  const byId = new Map(items.flatMap((i) => (i.id ? [[i.id, i] as const] : [])))
  const remote = new Map<string, Remote>()
  for (const object of await store.list()) {
    const root = parse(object.data)
    const todo = root && readTodo(root)
    const id = idOf(todo?.uid)
    if (root && todo && id) remote.set(id, { object, todo, root })
  }
  const report: Report = {
    pulled: [],
    actions: [],
    recurring: items.filter((i) => i.recurring && !i.done).length,
    text: options.text,
  }

  if (doPull) {
    for (const [id, { todo }] of remote) {
      const item = byId.get(id)
      if (todo.status === TodoStatus.Completed && item && !item.done && !item.recurring) {
        report.pulled.push({
          id,
          summary: summarize(item.text),
          completed: todo.completed ? `${todo.completed.date}` : undefined,
        })
      }
    }
  }
  if (!doPush) return report

  if (apply && !items.length && [...remote.values()].some((r) => isOpen(r.todo))) {
    throw new Error(`no checkbox found in TASKS.md but the calendar has open tasks: not cancelling`)
  }
  const { text } = assignIds(options.text, items, options.newId)
  if (apply) {
    await options.commitText?.(text)
    report.text = text
  }
  const options_ = { now }
  const act = async (action: Action, write: () => Promise<void>) => {
    report.actions.push(action)
    if (!apply) return
    try {
      await write()
    } catch (error) {
      action.error = error instanceof Error ? error.message : String(error)
    }
  }
  const owned = new Set<string>()
  for (const item of items) {
    if (item.recurring || !item.id) continue
    const id = item.id
    const want = desiredTodo(item)
    const summary = want.summary!
    const have = remote.get(id)
    if (item.done) {
      // A tick wins: close the task the file already pushed. Never create a finished task.
      owned.add(id)
      if (have && have.todo.status !== TodoStatus.Completed) {
        await act(
          { kind: `complete`, id, summary, fields: [`status`] },
          () => write(store, have, { status: TodoStatus.Completed }, options_),
        )
      }
      continue
    }
    owned.add(id)
    if (!have) {
      await act({ kind: `create`, id, summary, fields: Object.keys(want) }, async () => {
        const made = newTodo(
          { ...want, status: TodoStatus.NeedsAction },
          { uid: uidOf(id), prodid: PRODID, now },
        )
        if (!made.success) throw new Error(made.error.message)
        await store.create(serializeIcal(made.output))
      })
      continue
    }
    const changes = diff(have.todo, want)
    const reopen = have.todo.status === TodoStatus.Cancelled
    if (reopen) changes.status = TodoStatus.NeedsAction
    const fields = Object.keys(changes)
    if (!fields.length) continue
    await act(
      { kind: reopen ? `reopen` : `update`, id, summary, fields },
      () => write(store, have, changes, options_),
    )
  }
  // A line that is gone (or now repeats): cancel its task, once.
  for (const [id, have] of remote) {
    if (owned.has(id)) continue
    const status = have.todo.status
    if (status === TodoStatus.Cancelled || status === TodoStatus.Completed) continue
    await act(
      { kind: `cancel`, id, summary: have.todo.summary ?? ``, fields: [`status`] },
      () => write(store, have, { status: TodoStatus.Cancelled }, options_),
    )
  }
  return report
}

interface Remote {
  object: CalDavObject
  todo: Todo
  root: IcalComponent
}

function parse(data: string): IcalComponent | undefined {
  const result = parseIcal(data)
  return result.success ? result.output : undefined
}

async function write(
  store: Store,
  have: Remote,
  patch: TodoPatch,
  options: { now: Date },
): Promise<void> {
  const patched = patchTodo(have.root, patch, options)
  if (!patched.success) throw new Error(patched.error.message)
  await store.update(have.object, serializeIcal(have.root))
}

/** Adapts a CalDAV client and one calendar to {@link Store}. */
export function calDavStore(client: CalDavClient, calendarUrl: string): Store {
  return {
    async list() {
      const listed = await client.listObjects(calendarUrl, {
        component: `VTODO`,
        includeCompleted: true,
      })
      // Stalwart answers 404 to a query on an empty calendar; the URL came from the calendar list.
      if (!listed.success && listed.error.code === CalDavErrorCode.NotFound) return []
      if (!listed.success) throw new Error(`list: ${listed.error.message}`)
      return listed.output
    },
    async create(ics) {
      const made = await client.createObject(calendarUrl, ics)
      if (!made.success) throw new Error(`create: ${made.error.message}`)
    },
    async update(object, ics) {
      if (!object.etag) throw new Error(`update: the server sent no etag`)
      const done = await client.updateObject(object.url, ics, object.etag)
      if (!done.success) {
        const conflict = done.error.code === CalDavErrorCode.Conflict
        throw new Error(conflict ? `changed on the server since it was read` : done.error.message)
      }
    },
  }
}

/** Reads `KEY=value` lines; values may be quoted. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(`\n`)) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, `$2`)
  }
  return out
}

/** The report as lines for a terminal. Task text appears only here, never in a log. */
export function formatReport(report: Report, apply: boolean): string {
  const lines: string[] = []
  lines.push(`Completed on the phone, still open in TASKS.md: ${report.pulled.length}`)
  for (const p of report.pulled) lines.push(`  done  ${p.id}  ${p.summary}`)
  lines.push(`${apply ? `Applied` : `Would apply`}: ${report.actions.length}`)
  for (const a of report.actions) {
    const failed = a.error ? `  FAILED: ${a.error}` : ``
    lines.push(`  ${a.kind.padEnd(8)} ${a.id}  ${a.summary}  [${a.fields.join(`, `)}]${failed}`)
  }
  lines.push(`Recurring items not pushed: ${report.recurring}`)
  return lines.join(`\n`)
}

/**
 * Replaces `path` with `after` through a temp file in the same folder and a rename, so a reader
 * never sees half a file. Throws, writing nothing, when the file no longer holds `before`: it is
 * synced and may have been edited meanwhile.
 */
export async function commitTasksFile(path: string, before: string, after: string): Promise<void> {
  if (await Deno.readTextFile(path) !== before) {
    throw new Error(`${path} changed during the run; nothing written, run again`)
  }
  if (after === before) return
  const tmp = await Deno.makeTempFile({
    dir: dirname(path),
    prefix: `.${basename(path)}.`,
    suffix: `.tmp`,
  })
  try {
    await Deno.writeTextFile(tmp, after)
    await Deno.chmod(tmp, (await Deno.stat(path)).mode ?? 0o644)
    await Deno.rename(tmp, path)
  } catch (error) {
    await Deno.remove(tmp).catch(() => {})
    throw error
  }
}

async function main(args: string[]) {
  const flag = (name: string) => args.includes(`--${name}`)
  const value = (name: string, fallback: string) => {
    const at = args.indexOf(`--${name}`)
    return at >= 0 && args[at + 1] ? args[at + 1] : fallback
  }
  const home = Deno.env.get(`HOME`) ?? ``
  const tasksPath = value(`tasks`, `${home}/sync/code/ai-memory/TASKS.md`)
  const envPath = value(`env`, `${home}/sync/code/mcps/caldav/.env`)
  const calendarName = value(`calendar`, CALENDAR)
  const apply = flag(`apply`)
  const env = parseEnv(await Deno.readTextFile(envPath))
  for (const key of [`CALDAV_SERVER_URL`, `CALDAV_USERNAME`, `CALDAV_PASSWORD`]) {
    if (!env[key]) throw new Error(`${key} is missing in ${envPath}`)
  }
  const client = createCalDavClient({
    serverUrl: env.CALDAV_SERVER_URL,
    auth: { username: env.CALDAV_USERNAME, password: env.CALDAV_PASSWORD },
  })
  const found = await client.discover()
  if (!found.success) throw new Error(`discover: ${found.error.message}`)
  const home0 = found.output.homeUrls[0]
  const calendars = await client.listCalendars(home0)
  if (!calendars.success) throw new Error(`listCalendars: ${calendars.error.message}`)
  let url = calendars.output.find((c) => c.displayName === calendarName)?.url
  let store: Store
  if (url) {
    store = calDavStore(client, url)
  } else if (apply) {
    const made = await client.makeCalendar(home0, {
      displayName: calendarName,
      components: [`VTODO`],
    })
    if (!made.success) throw new Error(`makeCalendar: ${made.error.message}`)
    url = made.output.url
    store = calDavStore(client, url)
  } else {
    console.log(`Calendar "${calendarName}" does not exist yet: --apply would create it.`)
    store = {
      list: () => Promise.resolve([]),
      create: () => Promise.resolve(),
      update: () => Promise.resolve(),
    }
  }
  const before = await Deno.readTextFile(tasksPath)
  const report = await sync({
    text: before,
    store,
    now: new Date(),
    apply,
    pull: !flag(`push`),
    push: !flag(`pull`),
    commitText: (after) => commitTasksFile(tasksPath, before, after),
  })
  console.log(formatReport(report, apply))
  if (report.actions.some((a) => a.error)) Deno.exit(1)
}

if (import.meta.main) await main(Deno.args)
