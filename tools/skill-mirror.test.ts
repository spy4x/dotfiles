import { assertEquals } from "jsr:@std/assert@1.0.19"
import { resolve } from "jsr:@std/path@^1.0.0"

/**
 * Skills that exist for both harnesses. Each harness needs its own frontmatter —
 * Claude reads `argument-hint`, OpenCode reads `compatibility` — but the body below
 * the frontmatter is one text and must stay one text. Without this check the two
 * copies drift, and the harness you happen to be in decides which rules you get.
 */
const MIRRORED = [`upwork-triage`]

const repoRoot = resolve(import.meta.dirname ?? `.`, `..`)

/** The file with its YAML frontmatter block removed. */
function body(text: string): string {
  const match = text.match(/^---\n[\s\S]*?\n---\n/)
  if (!match) throw new Error(`no frontmatter block`)
  return text.slice(match[0].length)
}

for (const skill of MIRRORED) {
  Deno.test(`${skill} reads the same in Claude Code and OpenCode`, async () => {
    const claude = await Deno.readTextFile(
      resolve(repoRoot, `.claude`, `skills`, skill, `SKILL.md`),
    )
    const opencode = await Deno.readTextFile(
      resolve(repoRoot, `.config`, `opencode`, `skills`, skill, `SKILL.md`),
    )
    assertEquals(body(opencode), body(claude))
  })
}
