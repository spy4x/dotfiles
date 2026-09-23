// Frontmatter and config schemas. Every key is declared, and an undeclared key is an error, so a
// typo fails `--check` instead of quietly rendering an agent that ignores it.

import { type } from "npm:arktype@2.2.3"

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
  "temperature?": `0 <= number <= 2`,
  /** Neutral capabilities. Omitted means every tool the harness offers. */
  "tools?": type(`'read' | 'search' | 'shell' | 'edit' | 'web'`).array(),
  "targets?": harnessName.array(),
  "harness?": harnessBlock,
  "+": `reject`,
})
export type AgentFrontmatter = typeof AgentFrontmatter.infer

const model = type(`string | null`)
const HarnessConfig = type({
  /** `auto`: render when the home directory exists or the binary is on PATH. */
  enabled: `boolean | 'auto'`,
  /** Alternatives separated by `|`, first that resolves wins: `$VAR` or a path (`~` = HOME). */
  home: `string > 0`,
  bin: `string > 0`,
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
export function validate<T>(
  schema: (data: unknown) => T | InstanceType<typeof type.errors>,
  data: unknown,
  where: string,
): T {
  const result = schema(data)
  if (result instanceof type.errors) throw new Error(`${where}: ${result.summary}`)
  return result as T
}
