import { assert, assertEquals } from "jsr:@std/assert@1.0.19"
import { resolve } from "jsr:@std/path@^1.0.0"

/**
 * A skill that exists under both `.claude/skills` and `.config/opencode/skills` is one
 * skill, and the harness you happen to be in must not decide which rules you get. Each
 * harness needs its own frontmatter keys — Claude Code reads `argument-hint`, OpenCode
 * reads `compatibility` — so only `name`, `description` and the body are compared. A
 * skill that lives under one harness only is not mirrored and is not checked here.
 */
const CLAUDE = resolve(import.meta.dirname!, `..`, `.claude`, `skills`)
const OPENCODE = resolve(import.meta.dirname!, `..`, `.config`, `opencode`, `skills`)

/** Frontmatter keys that carry meaning rather than harness plumbing. */
const SHARED_KEYS = [`name`, `description`]

async function skillNames(dir: string): Promise<string[]> {
  const names: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isDirectory) continue
    const skill = resolve(dir, entry.name, `SKILL.md`)
    if (await Deno.lstat(skill).then(() => true, () => false)) names.push(entry.name)
  }
  return names.sort()
}

/** Splits a SKILL.md into its frontmatter lines and everything after them. */
function split(text: string): { frontmatter: string[]; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) throw new Error(`no frontmatter block`)
  return { frontmatter: match[1].split(`\n`), body: text.slice(match[0].length) }
}

/** The value of `key` in a frontmatter block, or null when it is absent. */
function field(frontmatter: string[], key: string): string | null {
  const line = frontmatter.find((entry) => entry.startsWith(`${key}:`))
  return line === undefined ? null : line.slice(key.length + 1).trim()
}

const opencodeSkills = await skillNames(OPENCODE)
const mirrored = (await skillNames(CLAUDE)).filter((name) => opencodeSkills.includes(name))

Deno.test(`at least one skill is mirrored, so this file is not checking nothing`, () => {
  assert(mirrored.length > 0, `no skill exists under both ${CLAUDE} and ${OPENCODE}`)
})

for (const skill of mirrored) {
  Deno.test(`${skill} reads the same in Claude Code and OpenCode`, async () => {
    const claude = split(await Deno.readTextFile(resolve(CLAUDE, skill, `SKILL.md`)))
    const opencode = split(await Deno.readTextFile(resolve(OPENCODE, skill, `SKILL.md`)))
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
