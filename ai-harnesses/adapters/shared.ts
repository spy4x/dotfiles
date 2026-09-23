// What every adapter produces, and the helpers they share. Adapters are pure: source in, files
// out, no filesystem access, so each one is tested against golden files alone.

import { extname } from "jsr:@std/path@^1.0.0"
import { stringify } from "jsr:@std/yaml@1.2.0"
import type { HarnessConfig, HarnessName } from "../schema.ts"
import type { Source, SourceFile } from "../source.ts"

/** One file for a harness home. `merge` files are overlaid on the live file, never copied. */
export interface RenderedFile {
  /** Relative to the harness home. */
  path: string
  content: string
  merge?: `json` | `yaml`
}

export interface Adapter {
  name: HarnessName
  /** Renders every canonical item that targets this harness. */
  render(source: Source, config: HarnessConfig): RenderedFile[]
}

/** A Markdown file with YAML frontmatter; keys with an undefined value are left out. */
export function markdown(frontmatter: Record<string, unknown>, body: string): string {
  const defined = Object.fromEntries(Object.entries(frontmatter).filter(([, v]) => v !== undefined))
  return `---\n${stringify(defined, { lineWidth: -1 })}---\n\n${body}`
}

/** A settings file: merged when `config.merge` names it, copied otherwise. */
export function settingsFile(file: SourceFile, config: HarnessConfig): RenderedFile {
  if (!config.merge.includes(file.path)) return { ...file }
  const ext = extname(file.path)
  if (ext === `.json`) return { ...file, merge: `json` }
  if (ext === `.yaml` || ext === `.yml`) return { ...file, merge: `yaml` }
  throw new Error(`settings ${file.path}: only JSON and YAML files can be merged`)
}

/** The model for a tier, or undefined when the item has no tier or the harness maps it to null. */
export function modelFor(config: HarnessConfig, tier: string | undefined): string | undefined {
  if (!tier || !config.tiers) return undefined
  return config.tiers[tier as keyof typeof config.tiers] ?? undefined
}
