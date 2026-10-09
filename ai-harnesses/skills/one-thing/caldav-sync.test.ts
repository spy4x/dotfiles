import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import type { CalDavObject } from "jsr:@spy4x/caldav@1.44.0"
import { parseIcal, serializeIcal } from "jsr:@spy4x/time@1.44.0/ical"
import { patchTodo, readTodo, TodoStatus } from "jsr:@spy4x/time@1.44.0/ical-tasks"
import {
  assignIds,
  commitTasksFile,
  mondayOf,
  parseEnv,
  parseTasks,
  parseWhen,
  type Store,
  summarize,
  sync,
} from "./caldav-sync.ts"

// Invented text in the shapes the real file uses.
const FILE = `# Plan — 1 March to 30 May 2031

Intro line, not an item.

## Week 1 — 3 to 9 March: warm up

- [ ] **4 Mar** · Draft the garden plan. A second sentence follows —
      [the notes](https://example.org/notes).
- [ ] **5–6 Mar** · Paint the fence
  - [ ] Buy paint
  - [x] Borrow brushes
        from the neighbour
- [ ] **By 8 Mar** · File the form <!-- p:2 -->
- [x] **3 Mar** · A finished thing
- [ ] **Every week, from 3 Mar** · Water the plants
- [ ] **4 Mar, then every working day** · Check the mail
- [ ] **Shelf**: an item with a bold label that is not a date

## Weeks 3 and 4 — 17 to 30 March

- [ ] **28 Mar–2 Apr** · Cross the month border

## Life admin

- [ ] **By 31 Dec** · Renew the permit
- [ ] Plain item with no label at all

## Seed — one-year plan

- [ ] **March 2031** · Month level
- [ ] **April–June 2031** · Quarter level
`

const NOW = new Date(`2031-03-01T10:00:00Z`)
const counter = () => {
  let n = 0
  return () => `id${String(++n).padStart(4, `0`)}`
}

/** An in-memory calendar that refuses a write whose etag is stale, like the server does. */
function fakeStore() {
  const objects = new Map<string, { data: string; etag: number }>()
  let urls = 0
  const store: Store & { objects: typeof objects; writes: number } = {
    objects,
    writes: 0,
    list() {
      return Promise.resolve(
        [...objects].map(([url, o]): CalDavObject => ({
          url,
          etag: `"${o.etag}"`,
          data: o.data,
        })),
      )
    },
    create(ics) {
      this.writes++
      objects.set(`/cal/${++urls}.ics`, { data: ics, etag: 1 })
      return Promise.resolve()
    },
    update(object, ics) {
      this.writes++
      const current = objects.get(object.url)
      if (!current || `"${current.etag}"` !== object.etag) {
        return Promise.reject(new Error(`changed on the server since it was read`))
      }
      objects.set(object.url, { data: ics, etag: current.etag + 1 })
      return Promise.resolve()
    },
  }
  return store
}

const run = (text: string, store: Store, extra: Partial<Parameters<typeof sync>[0]> = {}) =>
  sync({ text, store, now: NOW, apply: true, newId: counter(), year: 2031, ...extra })

/** Edits the stored task like the phone does. */
function onPhone(
  store: ReturnType<typeof fakeStore>,
  id: string,
  edit: (root: ReturnType<typeof must>) => unknown,
  raw: (data: string) => string = (data) => data,
) {
  for (const [url, o] of store.objects) {
    if (!o.data.includes(`UID:tasksmd-${id}@`)) continue
    const root = must(o.data)
    edit(root)
    store.objects.set(url, { data: raw(serializeIcal(root)), etag: o.etag + 1 })
    return
  }
  throw new Error(`no task ${id}`)
}

function must(data: string) {
  const parsed = parseIcal(data)
  if (!parsed.success) throw new Error(parsed.error.message)
  return parsed.output
}

const todoOf = (store: ReturnType<typeof fakeStore>, id: string) => {
  for (const o of store.objects.values()) {
    if (o.data.includes(`UID:tasksmd-${id}@`)) return readTodo(must(o.data))!
  }
  throw new Error(`no task ${id}`)
}

Deno.test(`reads the last day of a single date, a range, a deadline, a month and a quarter`, () => {
  const due = Object.fromEntries(parseTasks(FILE).map((i) => [summarize(i.text), i.due]))
  assertEquals(due[`Draft the garden plan.`], `2031-03-04`)
  assertEquals(due[`Paint the fence`], `2031-03-06`)
  assertEquals(due[`File the form`], `2031-03-08`)
  assertEquals(due[`Cross the month border`], `2031-04-02`)
  assertEquals(due[`Renew the permit`], `2031-12-31`)
  assertEquals(due[`Month level`], `2031-03-31`)
  assertEquals(due[`Quarter level`], `2031-06-30`)
})

Deno.test(`gives an item with no date label, or a bold label that is not a date, no due date`, () => {
  const items = parseTasks(FILE)
  const shelf = items.find((i) => i.text.startsWith(`**Shelf**`))!
  assertEquals(shelf.due, undefined)
  assertEquals(items.find((i) => i.text.startsWith(`Plain item`))!.due, undefined)
})

Deno.test(`flags items that repeat and keeps the ticked ones as done`, () => {
  const items = parseTasks(FILE)
  assertEquals(items.filter((i) => i.recurring).length, 2)
  assertEquals(items.filter((i) => i.done).map((i) => i.text), [`A finished thing`])
})

Deno.test(`nests checkboxes into a checklist, joining wrapped lines`, () => {
  const paint = parseTasks(FILE).find((i) => i.text === `Paint the fence`)!
  assertEquals(paint.checklist, [
    { done: false, text: `Buy paint` },
    { done: true, text: `Borrow brushes from the neighbour` },
  ])
})

Deno.test(`starts a task on the Monday of its week section only`, () => {
  const byText = Object.fromEntries(parseTasks(FILE).map((i) => [summarize(i.text), i.start]))
  assertEquals(byText[`Draft the garden plan.`], `2031-03-03`)
  assertEquals(byText[`Cross the month border`], `2031-03-17`)
  assertEquals(byText[`Renew the permit`], undefined)
  assertEquals(mondayOf(`2031-03-09`), `2031-03-03`)
})

Deno.test(`takes the priority override and lowers the priority of the Seed section`, () => {
  const p = Object.fromEntries(parseTasks(FILE).map((i) => [summarize(i.text), i.priority]))
  assertEquals(p[`File the form`], 2)
  assertEquals(p[`Paint the fence`], 5)
  assertEquals(p[`Month level`], 9)
})

Deno.test(`cuts the title at the first sentence and at 80 characters`, () => {
  assertEquals(
    summarize(`Draft the plan. More.`),
    `Draft the plan.`,
  )
  assertEquals(summarize(`See [the notes](https://example.org/x) **now**`), `See the notes now`)
  const long = summarize(`word `.repeat(40))
  assertEquals(long.length, 80)
  assert(long.endsWith(`…`))
})

Deno.test(`reads a date label only when it names a month`, () => {
  assertEquals(parseWhen(`Videos 7–11`, 2031), undefined)
  assertEquals(parseWhen(`By 31 Oct`, 2031), { due: `2031-10-31`, recurring: false })
  assertEquals(parseWhen(`Every week, from 2 Oct`, 2031), { recurring: true })
})

Deno.test(`writes an id at the end of the first line of each open item, once`, () => {
  const items = parseTasks(FILE)
  const { text } = assignIds(FILE, items, counter())
  const lines = text.split(`\n`)
  const draft = lines.findIndex((l) => l.includes(`Draft the garden plan`))
  assertStringIncludes(lines[draft], ` <!-- id:id0001 -->`)
  assert(lines[draft].endsWith(`-->`))
  // not on the ticked item, the repeating ones, or the continuation line
  assert(!text.includes(`A finished thing <!--`))
  assert(!text.includes(`Water the plants <!--`))
  assert(!text.includes(`Check the mail <!--`))
  assertEquals((text.match(/<!-- id:/g) ?? []).length, 9)
  // a second pass keeps every id and adds none
  const again = assignIds(text, parseTasks(text), counter())
  assertEquals(again.text, text)
})

Deno.test(`creates one task per open item with UID, order, due, start and category`, async () => {
  const store = fakeStore()
  const report = await run(FILE, store)
  assertEquals(report.actions.filter((a) => a.kind === `create`).length, 9)
  assertEquals(store.objects.size, 9)
  const t = todoOf(store, `id0001`)
  assertEquals(t.uid, `tasksmd-id0001@antonshubin.com`)
  assertEquals(t.summary, `Draft the garden plan.`)
  assertEquals(t.due?.date, `2031-03-04`)
  assertEquals(t.start?.date, `2031-03-03`)
  assertEquals(t.categories, [`plan`])
  assertEquals([t.sortOrder, todoOf(store, `id0002`).sortOrder], [0, 1])
  assertEquals(t.status, TodoStatus.NeedsAction)
  assertStringIncludes(t.description!, `Section: Week 1 — 3 to 9 March: warm up`)
  assertStringIncludes(todoOf(store, `id0002`).description!, `☐ Buy paint\n☑ Borrow brushes`)
})

Deno.test(`pushes nothing and writes nothing without --apply`, async () => {
  const store = fakeStore()
  const report = await run(FILE, store, { apply: false })
  assertEquals(report.actions.length, 9)
  assertEquals(store.writes, 0)
  assertEquals(report.text, FILE)
})

Deno.test(`a second run with nothing changed writes nothing`, async () => {
  const store = fakeStore()
  const first = await run(FILE, store)
  const writes = store.writes
  const second = await run(first.text, store)
  assertEquals(second.actions, [])
  assertEquals(store.writes, writes)
})

Deno.test(`rewording and re-dating a line updates the same task`, async () => {
  const store = fakeStore()
  const first = await run(FILE, store)
  const edited = first.text.replace(`**5–6 Mar** · Paint the fence`, `**7 Mar** · Paint the shed`)
  const second = await run(edited, store)
  assertEquals(second.actions.map((a) => [a.kind, a.id]), [[`update`, `id0002`]])
  assertEquals(store.objects.size, 9)
  const t = todoOf(store, `id0002`)
  assertEquals([t.summary, t.due?.date], [`Paint the shed`, `2031-03-07`])
})

Deno.test(`an update keeps a reminder and an X- property added on the phone byte for byte`, async () => {
  const store = fakeStore()
  const first = await run(FILE, store)
  const alarm = [
    `BEGIN:VALARM`,
    `X-WR-ALARMUID:0a1b2c`,
    `TRIGGER;VALUE=DATE-TIME:20310305T080000Z`,
    `ACTION:DISPLAY`,
    `DESCRIPTION:Phone reminder`,
    `END:VALARM`,
  ]
  onPhone(
    store,
    `id0001`,
    (root) => root,
    (data) =>
      data.replace(`END:VTODO`, `X-PHONE-NOTE:keep\\, me\r\n${alarm.join(`\r\n`)}\r\nEND:VTODO`),
  )
  const edited = first.text.replace(`Draft the garden plan.`, `Draft the orchard plan.`)
  const second = await run(edited, store)
  assertEquals(second.actions.map((a) => a.kind), [`update`])
  const data = [...store.objects.values()].find((o) => o.data.includes(`id0001@`))!.data
  assertStringIncludes(data, `X-PHONE-NOTE:keep\\, me\r\n`)
  assertStringIncludes(data, alarm.join(`\r\n`) + `\r\n`)
  assertStringIncludes(data, `Draft the orchard plan.`)
})

Deno.test(`reports a task completed on the phone while its line is still open`, async () => {
  const store = fakeStore()
  const first = await run(FILE, store)
  onPhone(store, `id0003`, (root) => {
    const patched = patchTodo(root, { status: TodoStatus.Completed }, { now: NOW })
    assert(patched.success)
  })
  const second = await run(first.text, store)
  assertEquals(second.pulled.map((p) => [p.id, p.summary]), [[`id0003`, `File the form`]])
  // the phone's tick is not undone: the open line does not reopen the task
  assertEquals(second.actions, [])
  assertEquals(todoOf(store, `id0003`).status, TodoStatus.Completed)
})

Deno.test(`a tick in the file completes the pushed task`, async () => {
  const store = fakeStore()
  const first = await run(FILE, store)
  const ticked = first.text.replace(`- [ ] **By 8 Mar**`, `- [x] **By 8 Mar**`)
  const second = await run(ticked, store)
  assertEquals(second.actions.map((a) => [a.kind, a.id]), [[`complete`, `id0003`]])
  assertEquals(second.pulled, [])
  assertEquals(todoOf(store, `id0003`).status, TodoStatus.Completed)
})

Deno.test(`a ticked line whose task is not on the server creates nothing`, async () => {
  const first = await run(FILE, fakeStore())
  const store = fakeStore()
  const report = await run(first.text.replace(`- [ ] **By 8 Mar**`, `- [x] **By 8 Mar**`), store)
  assertEquals(report.actions.length, 8)
  assertEquals(store.objects.size, 8)
})

Deno.test(`a removed line cancels its task instead of deleting it, once`, async () => {
  const store = fakeStore()
  const first = await run(FILE, store)
  const without = first.text.split(`\n`).filter((l) => !l.includes(`Renew the permit`)).join(`\n`)
  const second = await run(without, store)
  assertEquals(second.actions.filter((a) => a.kind !== `update`).map((a) => [a.kind, a.id]), [[
    `cancel`,
    `id0006`,
  ]])
  assertEquals(store.objects.size, 9)
  assertEquals(todoOf(store, `id0006`).status, TodoStatus.Cancelled)
  const third = await run(without, store)
  assertEquals(third.actions.filter((a) => a.kind === `cancel`), [])
})

Deno.test(`a line that comes back reopens its cancelled task`, async () => {
  const store = fakeStore()
  const first = await run(FILE, store)
  const without = first.text.split(`\n`).filter((l) => !l.includes(`Renew the permit`)).join(`\n`)
  await run(without, store)
  const back = await run(first.text, store)
  assertEquals(back.actions.filter((a) => a.kind !== `update`).map((a) => [a.kind, a.id]), [[
    `reopen`,
    `id0006`,
  ]])
  assertEquals(todoOf(store, `id0006`).status, TodoStatus.NeedsAction)
})

Deno.test(`recurring items get no id and no task`, async () => {
  const store = fakeStore()
  const report = await run(FILE, store)
  assertEquals(report.recurring, 2)
  assert(!report.text.includes(`Water the plants <!--`))
  for (const o of store.objects.values()) assert(!o.data.includes(`Water the plants`))
})

Deno.test(`a line that turns into a repeating one is no longer pushed and its task is cancelled`, async () => {
  const store = fakeStore()
  const first = await run(FILE, store)
  const edited = first.text.replace(`**5–6 Mar** · Paint`, `**Every week** · Paint`)
  const second = await run(edited, store)
  assertEquals(second.actions.map((a) => [a.kind, a.id]), [[`cancel`, `id0002`]])
  assertEquals(todoOf(store, `id0002`).status, TodoStatus.Cancelled)
})

Deno.test(`a write that lost the race is reported and the other items still go through`, async () => {
  const store = fakeStore()
  const first = await run(FILE, store)
  const update = store.update.bind(store)
  let calls = 0
  store.update = (object, ics) => {
    // a second device changed the first update's task after we read it
    if (calls++ === 0) {
      store.objects.set(object.url, { ...store.objects.get(object.url)!, etag: 99 })
    }
    return update(object, ics)
  }
  const edited = first.text.replace(`Draft the garden plan.`, `Draft the x plan.`)
    .replace(`Paint the fence`, `Paint the shed`)
  const second = await run(edited, store)
  assertEquals(second.actions.map((a) => a.error === undefined), [false, true])
  assertEquals(todoOf(store, `id0002`).summary, `Paint the shed`)
})

Deno.test(`reads quoted and bare values from the env file`, () => {
  assertEquals(
    parseEnv(`# note\nCALDAV_USERNAME="a b"\nCALDAV_SERVER_URL=https://example.org\n`),
    { CALDAV_USERNAME: `a b`, CALDAV_SERVER_URL: `https://example.org` },
  )
})

Deno.test(`a file that changed during the run stops it before any calendar write`, async () => {
  const store = fakeStore()
  await assertRejects(
    () =>
      run(FILE, store, {
        commitText: () => Promise.reject(new Error(`changed during the run`)),
      }),
    Error,
    `changed during the run`,
  )
  assertEquals([store.writes, store.objects.size], [0, 0])
})

Deno.test(`commits the file through a rename and refuses when it changed meanwhile`, async () => {
  const dir = await Deno.makeTempDir()
  try {
    const path = `${dir}/TASKS.md`
    await Deno.writeTextFile(path, `one`)
    const inode = (await Deno.stat(path)).ino
    await commitTasksFile(path, `one`, `two`)
    assert((await Deno.stat(path)).ino !== inode, `replaced by rename, not rewritten in place`)
    assertEquals(await Deno.readTextFile(path), `two`)
    await assertRejects(() => commitTasksFile(path, `one`, `three`), Error, `changed during`)
    assertEquals(await Deno.readTextFile(path), `two`)
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), [`TASKS.md`])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test(`a copied line gets a fresh id and becomes a second task`, async () => {
  const store = fakeStore()
  const first = await run(FILE, store)
  const line = first.text.split(`\n`).find((l) => l.includes(`Draft the garden plan`))!
  const copied = first.text.replace(line, `${line}\n${line.replace(`4 Mar`, `7 Mar`)}`)
  const second = await run(copied, store)
  assertEquals(second.actions.filter((a) => a.kind === `create`).map((a) => a.id), [`id0010`])
  assertEquals(second.text.match(/<!-- id:id0001 -->/g)?.length, 1)
  assertEquals(store.objects.size, 10)
})

Deno.test(`reads and keeps CRLF line endings`, () => {
  const crlf = FILE.replaceAll(`\n`, `\r\n`)
  assertEquals(parseTasks(crlf), parseTasks(FILE))
  const { text } = assignIds(crlf, parseTasks(crlf), counter())
  assert(!text.replaceAll(`\r\n`, ``).match(/[\r\n]/), `every line break stays CRLF`)
  assertEquals(text.replaceAll(`\r\n`, `\n`).match(/<!-- id:/g)?.length, 9)
})

Deno.test(`refuses to cancel everything when no checkbox parses but tasks are open`, async () => {
  const store = fakeStore()
  await run(FILE, store)
  const writes = store.writes
  await assertRejects(() => run(``, store), Error, `not cancelling`)
  assertEquals(store.writes, writes)
  // a dry run only reports
  const dry = await run(``, store, { apply: false })
  assertEquals(dry.actions.length, 9)
})
