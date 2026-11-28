import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19"
import { copy } from "jsr:@std/fs@^1.0.0/copy"
import { walk } from "jsr:@std/fs@^1.0.0/walk"
import { join, relative } from "jsr:@std/path@^1.0.0"
import { ADAPTERS, loadConfig } from "./engine.ts"
import { HARNESSES } from "./schema.ts"
import { loadSource } from "./source.ts"

const ROOT = import.meta.dirname!

Deno.test(`the real source validates and renders for every harness`, async () => {
  const source = await loadSource(ROOT)
  const config = await loadConfig(join(ROOT, `config.jsonc`))
  for (const harness of HARNESSES) {
    const rendered = ADAPTERS[harness].render(source, config.harnesses[harness])
    const paths = rendered.map((file) => file.path)
    assertEquals(new Set(paths).size, paths.length, `${harness}: two items render one path`)
  }
  // The diverged skill exists once.
  assertEquals(source.skills.filter((skill) => skill.meta.name === `audit`).length, 1)
  const reviewer = source.agents.find((agent) => agent.meta.name === `reviewer`)
  assertEquals(reviewer?.meta.targets, undefined)
})

/**
 * The global rules' budget (the `writing-rules` skill, "Size"): DSH renders at most 64 KiB of rules,
 * the repo's own `AGENTS.md` included, and drops whole files past that.
 */
const RULES_MAX_LINES = 475
const RULES_MAX_BYTES = 30_000

Deno.test(`the global rules stay within their size budget`, async () => {
  const rules = await Deno.readFile(join(ROOT, `AGENTS.md`))
  const lines = new TextDecoder().decode(rules).split(`\n`).length
  assert(lines <= RULES_MAX_LINES, `AGENTS.md has ${lines} lines; the budget is ${RULES_MAX_LINES}`)
  assert(
    rules.byteLength <= RULES_MAX_BYTES,
    `AGENTS.md has ${rules.byteLength} bytes; the budget is ${RULES_MAX_BYTES}`,
  )
})

/** The house column limit for prose; `deno fmt` keeps prose as written, so this test holds it. */
const PROSE_MAX_COLUMNS = 100
/** `[label]: url`, one destination and nothing after it. */
const LINK_DEFINITION = /^\[[^\]]*\]:\s*\S+$/

/**
 * The prose lines of a Markdown text longer than `max` code points, with 1-based line numbers.
 * Front matter (a `---` block opened on line 1), fenced code (``` or ~~~, closed by a fence of the
 * same character at least as long), table rows (a line starting with `|`), a line holding one
 * token and a link reference definition (`[label]: url`) are skipped: no rewrap can shorten the last
 * two, and `deno fmt` refuses a definition split across lines. One pass, no backtracking: O(n) in
 * the text's length.
 */
function longProseLines(
  text: string,
  max = PROSE_MAX_COLUMNS,
): { line: number; length: number }[] {
  const long: { line: number; length: number }[] = []
  const lines = text.split(`\n`)
  let frontMatter = lines[0] === `---`
  let fence = ``
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (frontMatter) {
      if (index > 0 && trimmed === `---`) frontMatter = false
      return
    }
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && marker === trimmed) {
        fence = ``
      }
      return
    }
    if (marker) {
      fence = marker
      return
    }
    if (trimmed.startsWith(`|`) || !/\s/.test(trimmed) || LINK_DEFINITION.test(trimmed)) return
    const length = [...line].length
    if (length > max) long.push({ line: index + 1, length })
  })
  return long
}

/** A prose line of `length` code points: words of `a` separated by spaces. */
function prose(length: number): string {
  return `a `.repeat(length).slice(0, length)
}

Deno.test(`longProseLines passes a line of exactly the limit and flags one past it`, () => {
  assertEquals(longProseLines(`${prose(100)}\n${prose(101)}`), [{ line: 2, length: 101 }])
})

Deno.test(`longProseLines counts code points, not UTF-16 units`, () => {
  assertEquals(longProseLines(`→ `.repeat(50)), [])
  assertEquals(longProseLines(`😀 `.repeat(50)), [])
  assertEquals(longProseLines(`${`😀 `.repeat(50)}😀`), [{ line: 1, length: 101 }])
})

Deno.test(`longProseLines skips front matter opened on line 1 and checks after it closes`, () => {
  const long = prose(101)
  assertEquals(longProseLines(`---\n${long}\n---\n${long}`), [{ line: 4, length: 101 }])
})

Deno.test(`longProseLines treats a later --- line as prose, not front matter`, () => {
  const long = prose(101)
  assertEquals(longProseLines(`text\n---\n${long}\n---`), [{ line: 3, length: 101 }])
})

Deno.test(`longProseLines skips backtick and tilde fences and checks again after they close`, () => {
  const long = prose(101)
  for (const fence of ["```", `~~~`]) {
    assertEquals(
      longProseLines(`${fence}ts\n${long}\n${fence}\n${long}`),
      [{ line: 4, length: 101 }],
      fence,
    )
  }
})

Deno.test(`longProseLines keeps a fence open past a shorter fence or one of the other character`, () => {
  const long = prose(101)
  assertEquals(longProseLines("````\n~~~\n" + `${long}\n` + "```\n" + `${long}\n` + "````"), [])
})

Deno.test(`longProseLines skips a single token and a link definition, not prose with a URL`, () => {
  const url = `https://example.com/${`a`.repeat(100)}`
  assertEquals(
    longProseLines(`  ${url}\n[x]: ${url}\nSee ${url}`),
    [{ line: 3, length: 124 }],
  )
})

Deno.test(`longProseLines skips table rows, indented or not`, () => {
  const row = `| ${prose(101)} |`
  assertEquals(longProseLines(`${row}\n  ${row}`), [])
})

Deno.test(`every prose line of the harness Markdown fits in ${PROSE_MAX_COLUMNS} columns`, async () => {
  const long: string[] = []
  const fixtures = join(ROOT, `fixtures`)
  for await (const entry of walk(ROOT, { exts: [`.md`], includeDirs: false })) {
    if (entry.path.startsWith(fixtures)) continue
    for (const { line, length } of longProseLines(await Deno.readTextFile(entry.path))) {
      long.push(`${relative(ROOT, entry.path)}:${line} (${length})`)
    }
  }
  assertEquals(long, [], `prose lines past ${PROSE_MAX_COLUMNS} columns:\n${long.join(`\n`)}`)
})

/** A copy of the fixture source with one file replaced. */
async function brokenSource(path: string, text: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: `ai-source-` })
  await copy(join(ROOT, `fixtures`, `source`), dir, { overwrite: true })
  await Deno.writeTextFile(join(dir, path), text)
  return dir
}

for (
  const [name, path, text, message] of [
    [
      `an undeclared frontmatter key`,
      `agents/checker.md`,
      `---\nname: checker\ndescription: x\nmodle: opus\n---\nbody\n`,
      `modle`,
    ],
    [
      `a name that does not match its file`,
      `agents/checker.md`,
      `---\nname: other\ndescription: x\n---\nbody\n`,
      `must match`,
    ],
    [
      `a body-from that names no agent`,
      `agents/variant.md`,
      `---\nname: variant\ndescription: x\nbody-from: missing\n---\n`,
      `names no agent`,
    ],
    [
      `a body-from variant with a body of its own`,
      `agents/variant.md`,
      `---\nname: variant\ndescription: x\nbody-from: checker\n---\nown body\n`,
      `needs an empty body`,
    ],
    [
      `frontmatter that is not valid YAML`,
      `skills/lookup/SKILL.md`,
      `---\nname: lookup\ndescription: a: b\n---\nbody\n`,
      `not valid YAML`,
    ],
  ]
) {
  Deno.test(`loadSource rejects ${name}`, async () => {
    const dir = await brokenSource(path, text)
    try {
      await assertRejects(() => loadSource(dir), Error, message)
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  })
}

Deno.test(`a body-from variant renders the body of the agent it names`, async () => {
  const dir = await brokenSource(
    `agents/variant.md`,
    `---\nname: variant\ndescription: x\neffort: max\nbody-from: checker\n---\n`,
  )
  try {
    const source = await loadSource(dir)
    const body = (name: string) => source.agents.find((agent) => agent.meta.name === name)?.body
    assertEquals(body(`variant`), body(`checker`))
    assertEquals(source.agents.find((agent) => agent.meta.name === `variant`)?.meta.effort, `max`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test(`loadSource rejects a body-from that points at another variant`, async () => {
  const dir = await brokenSource(
    `agents/variant.md`,
    `---\nname: variant\ndescription: x\nbody-from: checker\n---\n`,
  )
  try {
    await Deno.writeTextFile(
      join(dir, `agents/second.md`),
      `---\nname: second\ndescription: x\nbody-from: variant\n---\n`,
    )
    await assertRejects(() => loadSource(dir), Error, `is itself a variant`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

for (
  const [name, text, message] of [
    [`an undeclared key`, `{ "a": { "command": "x", "cmd": "y" } }`, `cmd`],
    [`a server without a command`, `{ "a": {} }`, `command`],
    [`a server name that is not lowercase`, `{ "Caldav": { "command": "x" } }`, `lowercase`],
  ]
) {
  Deno.test(`loadSource rejects mcp.jsonc with ${name}`, async () => {
    const dir = await brokenSource(`mcp.jsonc`, text)
    try {
      await assertRejects(() => loadSource(dir), Error, message)
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  })
}

Deno.test(`the real mcp.jsonc renders playwright's OpenCode entry with a pinned version`, async () => {
  const source = await loadSource(ROOT)
  const config = await loadConfig(join(ROOT, `config.jsonc`))
  const file = ADAPTERS.opencode.render(source, config.harnesses.opencode)
    .find((rendered) => rendered.path === `opencode.json`)!
  assertEquals(JSON.parse(file.content).mcp.playwright, {
    type: `local`,
    command: [
      `npx`,
      `@playwright/mcp@0.0.83`,
      `--browser`,
      `chromium`,
      `--headless`,
      `--timeout-navigation`,
      `300000`,
    ],
    enabled: true,
    timeout: 300000,
  })
  assertEquals(JSON.parse(file.content).mcp.caldav.enabled, true)
})

Deno.test(`the real mcp.jsonc registers only caldav in Claude Code, as a stdio server`, async () => {
  const source = await loadSource(ROOT)
  const config = await loadConfig(join(ROOT, `config.jsonc`))
  const rendered = ADAPTERS.claude.render(source, config.harnesses.claude)
    .filter((file) => file.at === `mcpFile`)
  assertEquals(rendered.length, 1)
  const servers = JSON.parse(rendered[0].content).mcpServers
  assertEquals(Object.keys(servers), [`caldav`])
  assertEquals(servers.caldav.type, `stdio`)
  assertEquals(servers.caldav.command.endsWith(`/sync/code/mcps/caldav/start.sh`), true)
})
