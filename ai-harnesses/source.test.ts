import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19"
import { copy } from "jsr:@std/fs@^1.0.0/copy"
import { join } from "jsr:@std/path@^1.0.0"
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
  // Each diverged item exists once and reaches every harness.
  for (const name of [`audit`, `release`]) {
    assertEquals(source.skills.filter((skill) => skill.meta.name === name).length, 1)
  }
  const reviewer = source.agents.find((agent) => agent.meta.name === `reviewer`)
  assertEquals(reviewer?.meta.targets, undefined)
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

Deno.test(`the real mcp.jsonc keeps playwright's OpenCode entry as it was in opencode.json`, async () => {
  const source = await loadSource(ROOT)
  const config = await loadConfig(join(ROOT, `config.jsonc`))
  const file = ADAPTERS.opencode.render(source, config.harnesses.opencode)
    .find((rendered) => rendered.path === `opencode.json`)!
  assertEquals(JSON.parse(file.content).mcp.playwright, {
    type: `local`,
    command: [
      `npx`,
      `@playwright/mcp@latest`,
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
