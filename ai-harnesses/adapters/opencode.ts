// OpenCode: `AGENTS.md`, `skills/<name>/SKILL.md` for model-invoked skills, `commands/<name>.md`
// for user-invoked ones, `agents/<name>.md`, and settings merged key by key.

import {
  type Adapter,
  markdown,
  mcpFor,
  modelFor,
  type RenderedFile,
  settingsFile,
} from "./shared.ts"
import { type SourceFile, targets } from "../source.ts"

/** Tools OpenCode can deny, keyed by the neutral capability that grants them. */
const PERMISSIONS: [string, string][] = [[`edit`, `edit`], [`shell`, `bash`], [`web`, `webfetch`]]

/** The tracked `opencode.json` with the rendered `mcp` block added; it may not set its own. */
function withMcp(file: SourceFile, mcp: Record<string, unknown>): SourceFile {
  if (Object.keys(mcp).length === 0) return file
  const settings = JSON.parse(file.content)
  if (`mcp` in settings) {
    throw new Error(`settings/opencode/opencode.json: list servers in mcp.jsonc`)
  }
  return { ...file, content: JSON.stringify({ ...settings, mcp }, null, 2) + `\n` }
}

export const opencode: Adapter = {
  name: `opencode`,
  render(source, config) {
    const files: RenderedFile[] = [{ path: `AGENTS.md`, content: source.rules }]

    for (const { meta, body, files: extra } of source.skills) {
      if (!targets(meta, `opencode`)) continue
      const invocation = meta.invocation ?? `model`
      // `harness.opencode` goes to the command when there is one: its keys (`agent`, `subtask`)
      // mean nothing on a skill.
      if (invocation !== `user`) {
        const own = invocation === `model` ? meta.harness?.opencode : undefined
        const frontmatter = { name: meta.name, description: meta.description, ...own }
        files.push({ path: `skills/${meta.name}/SKILL.md`, content: markdown(frontmatter, body) })
        for (const file of extra) files.push({ ...file, path: `skills/${meta.name}/${file.path}` })
      } else if (extra.length > 0) {
        throw new Error(`skills/${meta.name}: a command-only skill cannot ship files to OpenCode`)
      }
      if (invocation !== `model`) {
        const frontmatter = { description: meta.description, ...meta.harness?.opencode }
        files.push({ path: `commands/${meta.name}.md`, content: markdown(frontmatter, body) })
      }
    }

    for (const { meta, body } of source.agents) {
      if (!targets(meta, `opencode`)) continue
      const denied = meta.tools
        ? PERMISSIONS.filter(([tool]) => !meta.tools!.includes(tool as never))
        : []
      const frontmatter = {
        description: meta.description,
        mode: meta.mode ?? `subagent`,
        model: modelFor(config, meta.tier),
        temperature: meta.temperature,
        permission: denied.length > 0
          ? Object.fromEntries(denied.map(([, permission]) => [permission, `deny`]))
          : undefined,
        ...meta.harness?.opencode,
      }
      files.push({ path: `agents/${meta.name}.md`, content: markdown(frontmatter, body) })
    }

    const mcp = Object.fromEntries(
      mcpFor(source, `opencode`).map(([serverName, server]) => [serverName, {
        type: `local`,
        command: [server.command, ...server.args ?? []],
        environment: server.env,
        enabled: server.enabled ?? true,
        ...server.harness?.opencode,
      }]),
    )
    for (const file of source.settings.opencode) {
      files.push(settingsFile(
        file.path === `opencode.json` ? withMcp(file, mcp) : file,
        config,
      ))
    }
    return files
  },
}
