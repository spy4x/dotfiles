// Claude Code: `CLAUDE.md`, `skills/<name>/SKILL.md`, `agents/<name>.md`, and `settings.json`
// merged key by key. Hook scripts ship only while the tracked settings wire them up.

import { type Adapter, markdown, modelFor, type RenderedFile, settingsFile } from "./shared.ts"
import { targets } from "../source.ts"

const TOOLS: Record<string, string[]> = {
  read: [`Read`],
  search: [`Grep`, `Glob`],
  shell: [`Bash`],
  edit: [`Edit`, `Write`],
  web: [`WebFetch`, `WebSearch`],
}

export const claude: Adapter = {
  name: `claude`,
  render(source, config) {
    const files: RenderedFile[] = [{ path: `CLAUDE.md`, content: source.rules }]

    for (const { meta, body, files: extra } of source.skills) {
      if (!targets(meta, `claude`)) continue
      const frontmatter = {
        name: meta.name,
        description: meta.description,
        "argument-hint": meta[`argument-hint`],
        "disable-model-invocation": meta.invocation === `user` ? true : undefined,
        ...meta.harness?.claude,
      }
      files.push({ path: `skills/${meta.name}/SKILL.md`, content: markdown(frontmatter, body) })
      for (const file of extra) files.push({ ...file, path: `skills/${meta.name}/${file.path}` })
    }

    for (const { meta, body } of source.agents) {
      if (!targets(meta, `claude`)) continue
      if (meta.mode === `primary`) {
        throw new Error(`agents/${meta.name}.md: Claude Code has no primary agents; set targets`)
      }
      const frontmatter = {
        name: meta.name,
        description: meta.description,
        tools: meta.tools?.flatMap((tool) => TOOLS[tool]).join(`, `),
        model: modelFor(config, meta.tier),
        effort: meta.effort,
        ...meta.harness?.claude,
      }
      files.push({ path: `agents/${meta.name}.md`, content: markdown(frontmatter, body) })
    }

    const settings = source.settings.claude
    const tracked = settings.find((file) => file.path === `settings.json`)
    const hooksWired = tracked ? `hooks` in JSON.parse(tracked.content) : false
    for (const file of settings) {
      if (file.path.startsWith(`hooks/`) && !hooksWired) continue
      files.push(settingsFile(file, config))
    }
    return files
  },
}
