// Reads the harness-neutral source tree: `AGENTS.md`, `skills/<name>/SKILL.md` plus any files
// beside it, `agents/<name>.md`, and `settings/<harness>/**`.

import { join, relative } from "jsr:@std/path@^1.0.0"
import { extract } from "jsr:@std/front-matter@1.0.9/yaml"
import {
  AgentFrontmatter,
  HARNESSES,
  type HarnessName,
  SkillFrontmatter,
  validate,
} from "./schema.ts"

/** A file relative to the directory it belongs to. */
export interface SourceFile {
  path: string
  content: string
}

export interface Skill {
  meta: SkillFrontmatter
  body: string
  /** Supporting files beside `SKILL.md`, shipped with it. */
  files: SourceFile[]
}

export interface Agent {
  meta: AgentFrontmatter
  body: string
}

export interface Source {
  rules: string
  skills: Skill[]
  agents: Agent[]
  settings: Record<HarnessName, SourceFile[]>
}

/** Every regular file under `dir`, sorted, test files skipped. Empty when `dir` is missing. */
export async function listFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (current: string) => {
    for await (const entry of Deno.readDir(current)) {
      const path = join(current, entry.name)
      if (entry.isDirectory) await walk(path)
      else if (entry.isFile && !/\.test\.tsx?$/.test(entry.name)) found.push(path)
    }
  }
  if (await Deno.lstat(dir).then(() => true, () => false)) await walk(dir)
  return found.sort()
}

/** Splits a Markdown file into validated frontmatter and a body without leading blank lines. */
function parse<T>(
  text: string,
  schema: (data: unknown) => unknown,
  where: string,
): { meta: T; body: string } {
  let attrs: unknown
  let body: string
  try {
    ;({ attrs, body } = extract(text))
  } catch (error) {
    throw new Error(`${where}: frontmatter is not valid YAML (${(error as Error).message})`)
  }
  return {
    meta: validate(schema as (data: unknown) => T, attrs, where),
    body: body.replace(/^\n+/, ``),
  }
}

/** Loads and validates the whole source tree rooted at `root`. */
export async function loadSource(root: string): Promise<Source> {
  const skills: Skill[] = []
  for (const path of await listFiles(join(root, `skills`))) {
    const rel = relative(join(root, `skills`), path)
    const [dir, ...rest] = rel.split(`/`)
    if (rest.join(`/`) !== `SKILL.md`) continue
    const where = `skills/${rel}`
    const { meta, body } = parse<SkillFrontmatter>(
      await Deno.readTextFile(path),
      SkillFrontmatter,
      where,
    )
    if (meta.name !== dir) throw new Error(`${where}: name "${meta.name}" must match its directory`)
    const files: SourceFile[] = []
    for (const file of await listFiles(join(root, `skills`, dir))) {
      const inner = relative(join(root, `skills`, dir), file)
      if (inner !== `SKILL.md`) files.push({ path: inner, content: await Deno.readTextFile(file) })
    }
    skills.push({ meta, body, files })
  }

  const agents: Agent[] = []
  for (const path of await listFiles(join(root, `agents`))) {
    const rel = relative(join(root, `agents`), path)
    if (!rel.endsWith(`.md`) || rel.includes(`/`)) continue
    const where = `agents/${rel}`
    const { meta, body } = parse<AgentFrontmatter>(
      await Deno.readTextFile(path),
      AgentFrontmatter,
      where,
    )
    if (`${meta.name}.md` !== rel) throw new Error(`${where}: name "${meta.name}" must match file`)
    agents.push({ meta, body })
  }

  const settings = {} as Record<HarnessName, SourceFile[]>
  for (const harness of HARNESSES) {
    const dir = join(root, `settings`, harness)
    settings[harness] = await Promise.all(
      (await listFiles(dir)).map(async (path) => ({
        path: relative(dir, path),
        content: await Deno.readTextFile(path),
      })),
    )
  }

  return { rules: await Deno.readTextFile(join(root, `AGENTS.md`)), skills, agents, settings }
}

/** Whether an item without `targets` (every harness) or with this harness listed ships to it. */
export function targets(meta: { targets?: HarnessName[] }, harness: HarnessName): boolean {
  return meta.targets?.includes(harness) ?? true
}
