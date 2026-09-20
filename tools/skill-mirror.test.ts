import { assert, assertEquals } from "jsr:@std/assert@1.0.19"
import { resolve } from "jsr:@std/path@^1.0.0"

/**
 * A skill that exists under both `.claude/skills` and `.config/opencode/skills` is one
 * skill, and the harness you happen to be in must not decide which rules you get. Each
 * harness needs its own frontmatter keys — Claude Code reads `argument-hint`, OpenCode
 * reads `compatibility` — so only `name`, `description` and the body are compared. A
 * skill that lives under one harness on purpose is not mirrored and is not checked.
 */
const CLAUDE = resolve(import.meta.dirname!, `..`, `.claude`, `skills`)
const OPENCODE = resolve(import.meta.dirname!, `..`, `.config`, `opencode`, `skills`)

/**
 * Skills that must exist for both harnesses. Discovery alone would go green if a copy
 * were deleted or its directory misspelled, because the skill would simply stop looking
 * mirrored. Add a name here when you deliberately ship a skill to both.
 */
const REQUIRED = [`upwork-triage`]

/** Frontmatter keys that carry meaning rather than harness plumbing. */
const SHARED_KEYS = [`name`, `description`]

async function dirNames(dir: string): Promise<string[]> {
  const names: string[] = []
  for await (const entry of Deno.readDir(dir)) if (entry.isDirectory) names.push(entry.name)
  return names.sort()
}

const opencodeDirs = await dirNames(OPENCODE)
const mirrored = (await dirNames(CLAUDE)).filter((name) => opencodeDirs.includes(name))

/** Splits a SKILL.md into its frontmatter lines and everything after them. */
function split(text: string): { frontmatter: string[]; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) throw new Error(`no frontmatter block`)
  return { frontmatter: match[1].split(`\n`), body: text.slice(match[0].length) }
}

/**
 * The value of `key` in a frontmatter block, or null when it is absent. A YAML block
 * scalar (`>-`, `|`) puts the text on the following lines, where this would not see it
 * and every such value would compare equal to every other. Refuse instead of pretending.
 */
function field(frontmatter: string[], key: string): string | null {
  const line = frontmatter.find((entry) => entry.startsWith(`${key}:`))
  if (line === undefined) return null
  const value = line.slice(key.length + 1).trim()
  if (/^[>|][0-9+-]*(\s+#.*)?$/.test(value)) {
    throw new Error(`frontmatter "${key}" is a YAML block scalar, which this check cannot compare`)
  }
  return value
}

Deno.test(`every required skill is mirrored`, () => {
  assertEquals(REQUIRED.filter((name) => !mirrored.includes(name)), [], `missing from one harness`)
})

for (const skill of mirrored) {
  Deno.test(`${skill} reads the same in Claude Code and OpenCode`, async () => {
    const read = async (dir: string) => {
      const path = resolve(dir, skill, `SKILL.md`)
      const text = await Deno.readTextFile(path).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return null
        throw error
      })
      assert(text !== null, `${path} is missing, but the skill exists under the other harness`)
      return split(text)
    }
    const claude = await read(CLAUDE)
    const opencode = await read(OPENCODE)
    assertEquals(opencode.body, claude.body, `body differs`)
    for (const key of SHARED_KEYS) {
      assertEquals(
        field(opencode.frontmatter, key),
        field(claude.frontmatter, key),
        `frontmatter "${key}" differs`,
      )
    }
  })
}
