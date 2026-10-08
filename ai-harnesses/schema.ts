// Frontmatter and config schemas. Every key is declared, and an undeclared key is an error, so a
// typo fails `--check` instead of quietly rendering an agent that ignores it.

import { type Type, type } from "arktype"
import { validate as validateWithSchema } from "@spy4x/validation"

export type HarnessName = `claude` | `opencode` | `dsh`
export const HARNESSES: readonly HarnessName[] = [`claude`, `opencode`, `dsh`]

const harnessName = type(`'claude' | 'opencode' | 'dsh'`)
const name = type(/^[a-z0-9][a-z0-9-]*$/)
const freeform = type(`Record<string, unknown>`)
/** Frontmatter that only one harness understands. Frontmatter only: a body never forks. */
const harnessBlock = type({
  "claude?": freeform,
  "opencode?": freeform,
  "dsh?": freeform,
  "+": `reject`,
})

export const SkillFrontmatter = type({
  name,
  description: `string > 0`,
  /** `user`: a slash command only. `model`: loaded by the model on demand. `both`: either. */
  "invocation?": `'user' | 'model' | 'both'`,
  "argument-hint?": `string`,
  "targets?": harnessName.array(),
  "harness?": harnessBlock,
  "+": `reject`,
})
export type SkillFrontmatter = typeof SkillFrontmatter.infer

export const AgentFrontmatter = type({
  name,
  description: `string > 0`,
  "mode?": `'subagent' | 'primary'`,
  /** Neutral model tier, mapped to a model per harness in `config.jsonc`. */
  "tier?": `'cheap' | 'standard' | 'strong' | 'strongest'`,
  "effort?": `'low' | 'medium' | 'high' | 'xhigh' | 'max'`,
  /** Another agent whose body this one reuses, so variants differ only in frontmatter. */
  "body-from?": name,
  "temperature?": `0 <= number <= 2`,
  /** Neutral capabilities. Omitted means every tool the harness offers. */
  "tools?": type(`'read' | 'search' | 'shell' | 'edit' | 'web'`).array(),
  "targets?": harnessName.array(),
  "harness?": harnessBlock,
  "+": `reject`,
})
export type AgentFrontmatter = typeof AgentFrontmatter.infer

/** One MCP server, harness-neutral. `~/` at the start of `command`, `args` or `env` values expands. */
export const McpServer = type({
  command: `string > 0`,
  "args?": `string[]`,
  "env?": `Record<string, string>`,
  /** `false` keeps the server in the list but renders it nowhere that has an off switch. */
  "enabled?": `boolean`,
  "targets?": harnessName.array(),
  "harness?": harnessBlock,
  "+": `reject`,
})
export type McpServer = typeof McpServer.infer

/** `mcp.jsonc`: servers by name. */
export const McpServers = type({ "[string]": McpServer }).narrow((servers, ctx) =>
  Object.keys(servers).every((key) => name.allows(key)) ||
  ctx.mustBe(`keyed by lowercase names such as "caldav"`)
)
export type McpServers = typeof McpServers.infer

const model = type(`string | null`)
const HarnessConfig = type({
  /** `auto`: render when the home directory exists or the binary is on PATH. */
  enabled: `boolean | 'auto'`,
  /** Alternatives separated by `|`, first that resolves wins: `$VAR` or a path (`~` = HOME). */
  home: `string > 0`,
  bin: `string > 0`,
  /**
   * Where the harness keeps user-scope MCP servers when that is outside `home`: same `$VAR|path`
   * syntax, and `$VAR/rest` appends `rest` to the variable's value. Merged key by key.
   */
  "mcpFile?": `string > 0`,
  /** Settings files merged key by key into the live file instead of copied over it. */
  merge: `string[]`,
  /** Model per tier; null leaves the choice to the harness default. */
  "tiers?": { cheap: model, standard: model, strong: model, strongest: model },
  "+": `reject`,
})
export type HarnessConfig = typeof HarnessConfig.infer

export const Config = type({
  harnesses: { claude: HarnessConfig, opencode: HarnessConfig, dsh: HarnessConfig, "+": `reject` },
  "+": `reject`,
})
export type Config = typeof Config.infer

/** Validates `data` against `schema`, or throws with `where` and every problem found. */
export function validate<T extends Type>(schema: T, data: unknown, where: string): T["infer"] {
  const { error, data: parsed } = validateWithSchema(schema, data)
  if (error) throw new Error(`${where}: ${error.description}`)
  return parsed
}
