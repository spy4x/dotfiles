import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0"
import { join } from "jsr:@std/path@^1.0.0"
import { DatabaseSync } from "node:sqlite"
import { openReadOnly } from "./data.ts"
import { createFixture } from "./fixture.ts"
import { createHandler } from "./server.ts"

const NOW = Date.parse(`2026-11-06T12:00:00Z`)
const PORT = 8787

async function withDir(test: (dir: string) => Promise<void> | void) {
  const dir = await Deno.makeTempDir({ prefix: `runs-dashboard-` })
  try {
    await test(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const handlerFor = (dbPath: string) =>
  createHandler({
    dbPath,
    port: PORT,
    now: () => NOW,
    exists: async (path) => {
      try {
        await Deno.stat(path)
        return true
      } catch {
        return false
      }
    },
    readText: (path) => Deno.readTextFile(path),
  })

const get = (dbPath: string, host = `127.0.0.1:${PORT}`) =>
  handlerFor(dbPath)(new Request(`http://${host}/`, { headers: { host } }))

/** Asserts `html` matches `pattern`, without printing the whole page when it does not. */
const has = (html: string, pattern: RegExp) => assert(pattern.test(html), `expected ${pattern}`)
/** Asserts `html` does not match `pattern`. */
const lacks = (html: string, pattern: RegExp) =>
  assert(!pattern.test(html), `unexpected ${pattern}`)

/** The `data-widget-status` of the card titled `title`. */
function cardStatus(html: string, title: string): string | undefined {
  const at = html.indexOf(`>${title}</h2>`)
  if (at < 0) return undefined
  const start = html.lastIndexOf(`data-widget-status="`, at)
  return /data-widget-status="(\w+)"/.exec(html.slice(start))?.[1]
}

Deno.test(`a write through the dashboard's connection fails`, async () => {
  await withDir((dir) => {
    const db = openReadOnly(createFixture(dir, { now: NOW }))
    try {
      assertThrows(
        () => db.all(`INSERT INTO meta (key, value) VALUES ('paused', 'x')`),
        Error,
        `readonly`,
      )
      assertThrows(() => db.all(`DELETE FROM runs`), Error, `readonly`)
    } finally {
      db.close()
    }
  })
})

Deno.test(`a missing database file is not created by opening it`, async () => {
  await withDir((dir) => {
    const path = join(dir, `runs.sqlite`)
    assertThrows(() => openReadOnly(path))
    assertThrows(() => Deno.statSync(path), Deno.errors.NotFound)
  })
})

Deno.test(`a request with another Host header gets 403`, async () => {
  await withDir(async (dir) => {
    const path = createFixture(dir, { now: NOW })
    for (const host of [`evil.example:${PORT}`, `127.0.0.1:9999`, `localhost`, `0.0.0.0:${PORT}`]) {
      const response = await get(path, host)
      assertEquals(response.status, 403, host)
      await response.body?.cancel()
    }
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
      const response = await get(path, host)
      assertEquals(response.status, 200, host)
      await response.body?.cancel()
    }
  })
})

Deno.test(`without a database file the page says it can't find it, and creates no file`, async () => {
  await withDir(async (dir) => {
    const path = join(dir, `runs.sqlite`)
    const html = await (await get(path)).text()
    has(html, /Can(&#39;|')t find the run database/)
    has(html, new RegExp(`at ${path}`))
    assertThrows(() => Deno.statSync(path), Deno.errors.NotFound)
  })
})

Deno.test(`a file that is not a database shows the error state`, async () => {
  await withDir(async (dir) => {
    const path = join(dir, `runs.sqlite`)
    await Deno.writeTextFile(path, `not a database, just text that is long enough to have a header`)
    const html = await (await get(path)).text()
    has(html, /Can(&#39;|')t read the run database/)
  })
})

Deno.test(`an empty database says no runs yet and every card shows its empty line`, async () => {
  await withDir(async (dir) => {
    const html = await (await get(createFixture(dir, { now: NOW, empty: true }))).text()
    has(html, /No runs yet\./)
    lacks(html, /Needs you/)
    for (
      const title of [`Spend per day, 30 days`, `Lead runs`, `Queue`, `Spend by project, 7 days`]
    ) {
      assertEquals(cardStatus(html, title), `empty`, title)
    }
    assertEquals(cardStatus(html, `Time lost, 7 days`), `empty`)
    assertEquals(cardStatus(html, `Slowest steps, 7 days`), `empty`)
  })
})

Deno.test(`a database with runs draws every card, the banner and the runs table`, async () => {
  await withDir(async (dir) => {
    const response = await get(createFixture(dir, { now: NOW }))
    assertEquals(response.headers.get(`content-type`), `text/html; charset=utf-8`)
    assert(response.headers.get(`content-security-policy`)?.includes(`default-src 'none'`))
    const html = await response.text()
    for (
      const title of [
        `Today`,
        `Spend per day, 30 days`,
        `Lead runs`,
        `Queue`,
        `Spend by project, 7 days`,
        `Time lost, 7 days`,
        `Slowest steps, 7 days`,
      ]
    ) assertEquals(cardStatus(html, title), `ready`, title)
    has(html, /The lead is paused:/)
    has(html, /Import bank statements from CSV/)
    has(html, />\$142 of \$200</)
    has(html, /1 blocked · 2 queued · 1 claimed · 1 done · 1 dropped/)
    // The stylesheet carries the theme and the classes the page uses.
    has(html, /--color-foreground: oklch\(0\.13 /)
    has(html, /\.pc-card/)
  })
})

Deno.test(`a missing view breaks only its own card`, async () => {
  await withDir(async (dir) => {
    const path = createFixture(dir, { now: NOW })
    const db = new DatabaseSync(path)
    db.exec(`DROP TABLE v_slow_steps`)
    db.close()
    const html = await (await get(path)).text()
    assertEquals(cardStatus(html, `Slowest steps, 7 days`), `error`)
    has(html, /no such table: v_slow_steps/)
    assertEquals(cardStatus(html, `Lead runs`), `ready`)
    assertEquals(cardStatus(html, `Time lost, 7 days`), `ready`)
  })
})

Deno.test(`titles from the database render escaped`, async () => {
  await withDir(async (dir) => {
    const path = createFixture(dir, { now: NOW })
    const db = new DatabaseSync(path)
    db.prepare(`UPDATE queue SET title = ? WHERE issue = 'spy4x/financy#312'`).run(
      `<script>x()</script>`,
    )
    db.close()
    const html = await (await get(path)).text()
    lacks(html, /<script>x\(\)/)
    has(html, /&lt;script>x\(\)/)
  })
})
