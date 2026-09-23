// DSH (the DeepSeek harness): `AGENTS.md`, `skills/<name>/SKILL.md`, one agent preset per agent
// under `.agent-presets/<name>/`, `settings.yaml` merged key by key, and the `web` profile.

import { stringify } from "jsr:@std/yaml@1.2.0"
import { type Adapter, markdown, type RenderedFile, settingsFile } from "./shared.ts"
import { targets } from "../source.ts"

/**
 * The preset composition. Global `AGENTS.md` rules are folded in at runtime by
 * `dsh-agent-instructions`, so the persona is the agent body alone. Skill discovery and the skill
 * tool are mounted per preset because the `web` bundle disables them at host level.
 */
function composition(name: string, body: string): string {
  const persona = body.trimEnd().split(`\n`).map((line) => line ? `      ${line}` : ``).join(`\n`)
  return `# Rendered from ai-harnesses/agents/${name}.md by \`deno task ai\`. Do not edit.

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |-
${persona}

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: filesystem

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
`
}

export const dsh: Adapter = {
  name: `dsh`,
  render(source, config) {
    const files: RenderedFile[] = [{ path: `AGENTS.md`, content: source.rules }]

    for (const { meta, body, files: extra } of source.skills) {
      if (!targets(meta, `dsh`)) continue
      const frontmatter = {
        name: meta.name,
        description: meta.description,
        "disable-model-invocation": meta.invocation === `user` ? true : undefined,
        ...meta.harness?.dsh,
      }
      files.push({ path: `skills/${meta.name}/SKILL.md`, content: markdown(frontmatter, body) })
      for (const file of extra) files.push({ ...file, path: `skills/${meta.name}/${file.path}` })
    }

    for (const { meta, body } of source.agents) {
      if (!targets(meta, `dsh`)) continue
      const preset = {
        name: meta.name.split(`-`).map((word) => word[0].toUpperCase() + word.slice(1)).join(` `),
        description: meta.description,
        kind: meta.mode ?? `subagent`,
        order: 10,
        ...meta.harness?.dsh,
      }
      const dir = `.agent-presets/${meta.name}`
      files.push({ path: `${dir}/preset.yml`, content: stringify(preset, { lineWidth: -1 }) })
      files.push({ path: `${dir}/agent.cordis.yml`, content: composition(meta.name, body) })
    }

    for (const file of source.settings.dsh) files.push(settingsFile(file, config))
    return files
  },
}
