// Turns rendered files into a plan of filesystem operations against each harness home, and applies
// it.

import { dirname, join, resolve } from "jsr:@std/path@^1.0.0"
import { parse as parseJsonc } from "jsr:@std/jsonc@^1.0.0"
import { parse as parseYaml, stringify as stringifyYaml } from "jsr:@std/yaml@1.2.0"
import type { Adapter, RenderedFile } from "./adapters/shared.ts"
import { claude } from "./adapters/claude.ts"
import { dsh } from "./adapters/dsh.ts"
import { opencode } from "./adapters/opencode.ts"
import { Config, type HarnessConfig, HARNESSES, type HarnessName, validate } from "./schema.ts"
import type { Source } from "./source.ts"

export const ADAPTERS: Record<HarnessName, Adapter> = { claude, opencode, dsh }

/** Lists what the engine wrote into a harness home, so only those files are ever removed. */
export const MANIFEST = `.dotfiles-sync.json`

type Json = Record<string, unknown>
type Action = `skip` | `write` | `remove`

/** A harness that is enabled on this machine, with its home resolved. */
export interface Target {
  name: HarnessName
  home: string
  config: HarnessConfig
}

/** One planned filesystem change. `content` is set for every `write`. */
export interface Op {
  label: string
  path: string
  action: Action
  reason: string
  content?: string
}

/** The environment the engine reads, injectable for tests. */
export interface Env {
  get(key: string): string | undefined
}

export async function loadConfig(path: string): Promise<Config> {
  return validate(Config, parseJsonc(await Deno.readTextFile(path)), path)
}

/** Resolves `$VAR|~/path`: the first `$VAR` that is set, else the first path. `~` is HOME. */
export function resolveHome(spec: string, env: Env): string {
  const home = env.get(`HOME`)
  for (const alternative of spec.split(`|`).map((part) => part.trim())) {
    if (alternative.startsWith(`$`)) {
      const value = env.get(alternative.slice(1))
      if (value) return resolve(value)
      continue
    }
    if (alternative.startsWith(`~`)) {
      if (!home) throw new Error(`HOME is not set; cannot resolve ${alternative}`)
      return resolve(home, alternative.slice(1).replace(/^\//, ``))
    }
    return resolve(alternative)
  }
  throw new Error(`home "${spec}" resolves to nothing`)
}

async function exists(path: string): Promise<boolean> {
  return await Deno.lstat(path).then(() => true, () => false)
}

async function onPath(bin: string, env: Env): Promise<boolean> {
  for (const dir of (env.get(`PATH`) ?? ``).split(`:`).filter(Boolean)) {
    if (await exists(join(dir, bin))) return true
  }
  return false
}

/** Harnesses to render on this machine: forced on, or `auto` and installed. */
export async function detect(config: Config, env: Env): Promise<Target[]> {
  const found: Target[] = []
  for (const name of HARNESSES) {
    const harness = config.harnesses[name]
    const home = resolveHome(harness.home, env)
    const enabled = harness.enabled === `auto`
      ? await exists(home) || await onPath(harness.bin, env)
      : harness.enabled
    if (enabled) found.push({ name, home, config: harness })
  }
  return found
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
}

/** Plans a plain copy of `content` to `path`. */
async function planCopy(label: string, path: string, content: string): Promise<Op> {
  const lstat = await Deno.lstat(path).catch(() => null)
  if (!lstat) return { label, path, action: `write`, reason: `missing`, content }
  if (lstat.isSymlink) {
    return { label, path, action: `write`, reason: `symlink → real file`, content }
  }
  if (await readOrNull(path) === content) return { label, path, action: `skip`, reason: `in sync` }
  return { label, path, action: `write`, reason: `content drift`, content }
}

function isObject(value: unknown): value is Json {
  return typeof value === `object` && value !== null && !Array.isArray(value)
}

/**
 * Overlays the tracked settings on the live ones. A tracked scalar or array
 * replaces the live value; a tracked object replaces the live object's keys one
 * level down and leaves its other keys alone. So `permissions.ask` and
 * `hooks.PreToolUse` are owned by the tracked file, while `permissions.allow`
 * and `theme`, which it does not name, stay whatever the app last saved.
 */
export function mergeSettings(live: Json, tracked: Json): Json {
  const merged: Json = structuredClone(live)
  for (const [key, value] of Object.entries(tracked)) {
    const current = merged[key]
    merged[key] = isObject(value) && isObject(current)
      ? { ...current, ...structuredClone(value) }
      : value
  }
  return merged
}

function canonical(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, inner) =>
      isObject(inner)
        ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
        : inner,
  )
}

/** Plans a key-level merge of a tracked JSON or YAML settings file into the live one. */
async function planMerge(label: string, path: string, file: RenderedFile): Promise<Op> {
  const [decode, encode] = file.merge === `yaml`
    ? [parseYaml, (data: Json) => stringifyYaml(data, { lineWidth: -1 })]
    : [JSON.parse, (data: Json) => JSON.stringify(data, null, 2) + `\n`]
  const tracked = decode(file.content)
  if (!isObject(tracked)) throw new Error(`tracked ${file.path} is not a mapping`)
  const liveText = await readOrNull(path)
  let live: unknown = {}
  try {
    live = liveText === null ? {} : decode(liveText) ?? {}
  } catch {
    throw new Error(`${path} does not parse — fix it by hand; refusing to overwrite it`)
  }
  if (!isObject(live)) throw new Error(`${path} is not a mapping; refusing to overwrite it`)
  const merged = mergeSettings(live, tracked)
  if (liveText !== null && canonical(merged) === canonical(live)) {
    return { label, path, action: `skip`, reason: `in sync` }
  }
  const reason = liveText === null ? `missing` : `tracked keys differ`
  // A file that does not exist yet is written as tracked, comments and all.
  const content = liveText === null ? file.content : encode(merged)
  return { label, path, action: `write`, reason, content }
}

/**
 * Every change that brings one harness home in line with the rendered files. The manifest lists
 * the files this engine copied there, so a file dropped from the source is removed, and a file
 * the engine never wrote is never touched.
 */
export async function planTarget(target: Target, rendered: RenderedFile[]): Promise<Op[]> {
  const manifestPath = join(target.home, MANIFEST)
  const previous: string[] = JSON.parse(await readOrNull(manifestPath) ?? `{}`).files ?? []
  const ops: Op[] = []
  const copied: string[] = []
  const seen = new Set<string>()
  for (const file of rendered) {
    if (seen.has(file.path)) throw new Error(`${target.name}: two items render ${file.path}`)
    seen.add(file.path)
    const path = join(target.home, file.path)
    const label = `${target.name} ${file.path}`
    if (file.merge) {
      ops.push(await planMerge(`${label} (merge of tracked keys)`, path, file))
    } else {
      copied.push(file.path)
      ops.push(await planCopy(label, path, file.content))
    }
  }

  for (const rel of previous.filter((file) => !seen.has(file))) {
    const path = join(target.home, rel)
    if (await exists(path)) {
      ops.push({
        label: `${target.name} ${rel}`,
        path,
        action: `remove`,
        reason: `no longer tracked`,
      })
    }
  }
  const manifest = JSON.stringify({ files: copied.sort() }, null, 2) + `\n`
  ops.push(await planCopy(`${target.name} sync manifest`, manifestPath, manifest))
  return ops
}

/** Every change needed on every detected harness. */
export async function plan(source: Source, found: Target[]): Promise<Op[]> {
  const ops: Op[] = []
  for (const target of found) {
    ops.push(...await planTarget(target, ADAPTERS[target.name].render(source, target.config)))
  }
  return ops
}

/** Carries out every `write` and `remove`; returns how many files changed. */
export async function apply(ops: Op[]): Promise<number> {
  let changed = 0
  for (const op of ops) {
    if (op.action === `skip`) continue
    // Deno.writeTextFile follows symlinks; remove one first so the write creates a real file.
    const lstat = await Deno.lstat(op.path).catch(() => null)
    if (lstat && (lstat.isSymlink || op.action === `remove`)) await Deno.remove(op.path)
    if (op.action === `write`) {
      await Deno.mkdir(dirname(op.path), { recursive: true })
      await Deno.writeTextFile(op.path, op.content ?? ``)
    }
    changed++
  }
  return changed
}
