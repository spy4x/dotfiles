// The dashboard's one route: checks the Host header, reads the database read-only, renders the page.

import { fileURLToPath } from "node:url"
import { COMPONENT_CLASSES, PRESET_CSS, TOKENS_CSS } from "@spy4x/preact-theme"
import { compile } from "tailwindcss"
import { type Dashboard, openReadOnly, readDashboard } from "./data.ts"
import { type PageState, renderDocument } from "./page.tsx"

/** What the handler needs from outside. */
export interface DashboardOptions {
  /** The run database file. */
  dbPath: string
  /** The port the server listens on; the Host header must name it. */
  port: number
  /** Extra `Host` values to accept as they are, such as a public name a proxy forwards. */
  allowedHosts?: string[]
  /** Whether a file exists; injected so the handler stays free of runtime APIs. */
  exists: (path: string) => Promise<boolean>
  /** Reads a text file; Tailwind's own stylesheet comes from the npm cache. */
  readText: (path: string) => Promise<string>
  now?: () => number
}

const THEME: Record<string, string> = {
  "@spy4x/preact-theme/tokens.css": TOKENS_CSS,
  "@spy4x/preact-theme/preset.css": PRESET_CSS,
}
const ENTRY = `@import "tailwindcss";
@import "@spy4x/preact-theme/tokens.css";
@import "@spy4x/preact-theme/preset.css";`

type Compiler = Awaited<ReturnType<typeof compile>>

/** Compiles the theme with Tailwind once; `build` then adds the classes a page uses. */
async function compileTheme(readText: DashboardOptions[`readText`]): Promise<Compiler> {
  return await compile(ENTRY, {
    async loadStylesheet(id) {
      if (THEME[id] !== undefined) return { path: id, base: id, content: THEME[id] }
      const url = new URL(import.meta.resolve(id.endsWith(`.css`) ? id : `${id}/index.css`))
      const path = fileURLToPath(url)
      return { path, base: path, content: await readText(path) }
    },
    loadModule(id) {
      throw new Error(`The dashboard's stylesheet loads no plugin; it asked for ${id}`)
    },
  })
}

/** Classes the document wrapper itself uses, outside the rendered body. */
const DOCUMENT_CLASSES = [`theme-base`, `bg-background`, `text-foreground`]

const SECURITY_HEADERS = {
  "cache-control": `no-store`,
  "content-security-policy":
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "referrer-policy": `no-referrer`,
  "x-content-type-options": `nosniff`,
}

/**
 * `ALLOWED_HOSTS` as a list: comma-separated, each entry trimmed, empty entries dropped, so an
 * unset or empty value adds no Host. Entries match exactly, case and port included.
 */
export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? ``).split(`,`).map((host) => host.trim()).filter(Boolean)
}

/**
 * The request handler. A Host other than `127.0.0.1:<port>`, `localhost:<port>` or one of
 * `allowedHosts` gets 403, so a page on another site that rebinds its name to this machine cannot
 * read the dashboard.
 */
export function createHandler(options: DashboardOptions): (request: Request) => Promise<Response> {
  const allowedHosts = new Set([
    `127.0.0.1:${options.port}`,
    `localhost:${options.port}`,
    // An empty entry would let a request with an empty or missing Host through.
    ...(options.allowedHosts ?? []).filter(Boolean),
  ])
  const now = options.now ?? Date.now
  let compiler: Promise<Compiler> | null = null
  return async (request) => {
    if (!allowedHosts.has(request.headers.get(`host`) ?? ``)) {
      return new Response(`Forbidden: wrong Host header.\n`, { status: 403 })
    }
    if (new URL(request.url).pathname !== `/`) return new Response(`Not found\n`, { status: 404 })
    if (request.method !== `GET` && request.method !== `HEAD`) {
      return new Response(`Method not allowed\n`, { status: 405, headers: { allow: `GET, HEAD` } })
    }
    const state = await readState(options, now())
    compiler ??= compileTheme(options.readText)
    const theme = await compiler
    const html = renderDocument(
      state,
      (body) =>
        theme.build([...COMPONENT_CLASSES.split(` `), ...DOCUMENT_CLASSES, ...classesIn(body)]),
    )
    return new Response(request.method === `HEAD` ? null : html, {
      headers: { "content-type": `text/html; charset=utf-8`, ...SECURITY_HEADERS },
    })
  }
}

async function readState(options: DashboardOptions, now: number): Promise<PageState> {
  const path = options.dbPath
  if (!(await options.exists(path))) return { kind: `missing`, path }
  let data: Dashboard
  try {
    const db = openReadOnly(path)
    try {
      db.all(`SELECT 1 FROM sqlite_schema LIMIT 1`)
      data = readDashboard(db, now)
    } finally {
      db.close()
    }
  } catch {
    return { kind: `unreadable`, path }
  }
  return { kind: `ready`, path, data }
}

/** Every class name in the markup's `class` attributes, for Tailwind to emit. */
function classesIn(html: string): Set<string> {
  const classes = new Set<string>()
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) classes.add(name.replaceAll(`&amp;`, `&`))
  }
  return classes
}
