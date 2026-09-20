#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// Sync the tracked AI-harness config in this repo to the runtime locations the
// harnesses read.
//
// 1. `.config/opencode/AGENTS.md` — the one global instruction file — is copied to
//    OpenCode, DSH and Claude Code (`~/.claude/CLAUDE.md`). Same text everywhere:
//    three harnesses reading three dialects of the rules is how they drift.
// 2. `.claude/{agents,skills}` is mirrored into `~/.claude/` — plus `hooks/`, but only
//    while the tracked settings.json has a `hooks` key (they are disabled today). A manifest
//    records what this script wrote, so a file deleted here is deleted there and
//    nothing the script did not write is ever touched.
// 3. `.claude/settings.json` is merged into `~/.claude/settings.json`: the tracked
//    file owns the keys it names (one level deep inside objects), everything else
//    in the live file — theme, rules saved from a permission prompt — survives.
//
// Why real copies and not symlinks: DSH does not reliably follow a symlink at
// `$DSH_HOME`; Claude Code skips a symlinked `~/.claude/CLAUDE.md` in some session
// types and may replace a symlinked `settings.json` when it saves; and the path of
// this repo differs per machine, so an absolute `@import` cannot be shared either.
// Copies plus `--check` keep drift visible instead.
//
// Idempotent. Safe to run from a post-commit hook or by hand.
//
// Usage:
//   deno task sync-agents-md           # dry-run (prints planned actions)
//   deno task sync-agents-md --apply   # write to runtime
//   deno task sync-agents-md --check   # exit 1 if any target is out of sync
//
// From a linked worktree, --apply writes only the tracked copies inside that
// worktree. Runtime config from an unmerged branch would go live for every
// session on the machine — hooks included — before anyone reviewed it. Pass
// --from-worktree to do that on purpose.

import { dirname, join, relative, resolve } from "jsr:@std/path@^1.0.0"

type Mode = `dry` | `apply` | `check`

interface Args {
  mode: Mode
  fromWorktree: boolean
}
type Action = `skip` | `write` | `remove`

/** Everything the script reads from the environment, injectable for tests. */
export interface Paths {
  repoRoot: string
  home: string
  dshHome: string
  claudeHome: string
}

/** One planned filesystem change. `content` is set for every `write`. */
export interface Op {
  label: string
  path: string
  action: Action
  reason: string
  content?: string
}

type Json = Record<string, unknown>

const MIRRORED_DIRS = [`agents`, `skills`]
const MANIFEST = `.dotfiles-sync.json`

export function defaultPaths(): Paths {
  const home = Deno.env.get(`HOME`) ?? `~`
  return {
    repoRoot: resolve(import.meta.dirname ?? `.`, `..`),
    home,
    dshHome: Deno.env.get(`DSH_HOME`) ?? resolve(home, `.local`, `share`, `dsh`),
    claudeHome: Deno.env.get(`CLAUDE_CONFIG_DIR`) ?? resolve(home, `.claude`),
  }
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { mode: `dry`, fromWorktree: false }
  for (const arg of argv) {
    if (arg === `--apply`) args.mode = `apply`
    else if (arg === `--check`) args.mode = `check`
    else if (arg === `--dry` || arg === `--dry-run`) args.mode = `dry`
    else if (arg === `--from-worktree`) args.fromWorktree = true
    else if (arg === `-h` || arg === `--help`) {
      console.log(`Usage: sync-agents-md.ts [--dry | --apply [--from-worktree] | --check]`)
      Deno.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      Deno.exit(2)
    }
  }
  return args
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
}

/** Root of the git checkout that really contains `path` (symlinks resolved), or null. */
async function checkoutOf(path: string): Promise<string | null> {
  let dir = dirname(path)
  while (await Deno.lstat(dir).then(() => false, () => true)) {
    if (dirname(dir) === dir) return null
    dir = dirname(dir)
  }
  dir = await Deno.realPath(dir)
  for (;;) {
    if (await Deno.lstat(join(dir, `.git`)).then(() => true, () => false)) return dir
    if (dirname(dir) === dir) return null
    dir = dirname(dir)
  }
}

/** Plans a plain copy of `content` to `path`. */
async function planCopy(label: string, path: string, content: string, paths: Paths): Promise<Op> {
  // `~/.config/opencode` and `~/.dsh` are usually symlinks into a checkout of this
  // repo. Then the "runtime" file IS a tracked file: git updates it, this script
  // must not — least of all from a linked worktree, where it would dirty main.
  const checkout = await checkoutOf(path)
  const ownRoot = await Deno.realPath(paths.repoRoot)
  if (checkout && checkout !== ownRoot) {
    return {
      label,
      path,
      action: `skip`,
      reason: `tracked file in checkout ${checkout}; git updates it`,
    }
  }
  const lstat = await Deno.lstat(path).catch(() => null)
  if (!lstat) return { label, path, action: `write`, reason: `missing`, content }
  if (lstat.isSymlink) {
    return { label, path, action: `write`, reason: `symlink → real file`, content }
  }
  if (await readOrNull(path) === content) return { label, path, action: `skip`, reason: `in sync` }
  return { label, path, action: `write`, reason: `content drift`, content }
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) yield* walk(path)
    else if (entry.isFile && !/\.test\.tsx?$/.test(entry.name)) yield path
  }
}

/** Plans the `.claude/{agents,skills[,hooks]}` mirror, including removal of files no longer tracked. */
async function planMirror(paths: Paths): Promise<Op[]> {
  const ops: Op[] = []
  const tracked: string[] = []
  // Hook scripts ship only while the tracked settings wire them up: dormant code stays in the repo.
  const settings = JSON.parse(
    await readOrNull(join(paths.repoRoot, `.claude`, `settings.json`)) ?? `{}`,
  )
  for (const name of settings.hooks ? [...MIRRORED_DIRS, `hooks`] : MIRRORED_DIRS) {
    const from = join(paths.repoRoot, `.claude`, name)
    if (await Deno.lstat(from).then(() => false, () => true)) continue
    for await (const file of walk(from)) {
      const rel = relative(join(paths.repoRoot, `.claude`), file)
      tracked.push(rel)
      ops.push(
        await planCopy(
          `Claude ${rel}`,
          join(paths.claudeHome, rel),
          await Deno.readTextFile(file),
          paths,
        ),
      )
    }
  }
  tracked.sort()

  const manifestPath = join(paths.claudeHome, MANIFEST)
  const previous: string[] = JSON.parse(await readOrNull(manifestPath) ?? `{"files":[]}`).files ??
    []
  for (const rel of previous.filter((file) => !tracked.includes(file))) {
    const path = join(paths.claudeHome, rel)
    if (await Deno.lstat(path).then(() => true, () => false)) {
      ops.push({ label: `Claude ${rel}`, path, action: `remove`, reason: `no longer tracked` })
    }
  }
  const manifest = JSON.stringify({ files: tracked }, null, 2) + `\n`
  ops.push(await planCopy(`Claude sync manifest`, manifestPath, manifest, paths))
  return ops
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

async function planSettings(paths: Paths): Promise<Op[]> {
  const trackedText = await readOrNull(join(paths.repoRoot, `.claude`, `settings.json`))
  if (trackedText === null) return []
  const path = join(paths.claudeHome, `settings.json`)
  const label = `Claude settings.json (merge of tracked keys)`
  const liveText = await readOrNull(path)
  let live: Json = {}
  try {
    live = liveText === null ? {} : JSON.parse(liveText)
  } catch {
    throw new Error(`${path} is not valid JSON — fix it by hand; refusing to overwrite it`)
  }
  const merged = mergeSettings(live, JSON.parse(trackedText))
  if (liveText !== null && canonical(merged) === canonical(live)) {
    return [{ label, path, action: `skip`, reason: `in sync` }]
  }
  const reason = liveText === null ? `missing` : `tracked keys differ`
  return [{ label, path, action: `write`, reason, content: JSON.stringify(merged, null, 2) + `\n` }]
}

/** Every change needed to bring the runtime locations in line with the repo. */
export async function plan(paths: Paths): Promise<Op[]> {
  const agentsMd = await Deno.readTextFile(join(paths.repoRoot, `.config`, `opencode`, `AGENTS.md`))
  const copies: [string, string][] = [
    [
      `OpenCode global (~/.config/opencode/AGENTS.md)`,
      resolve(paths.home, `.config`, `opencode`, `AGENTS.md`),
    ],
    [`DSH global ($DSH_HOME/AGENTS.md)`, resolve(paths.dshHome, `AGENTS.md`)],
    [`Repo-local .dsh/AGENTS.md (layering override)`, resolve(paths.repoRoot, `.dsh`, `AGENTS.md`)],
    [`Claude Code global (~/.claude/CLAUDE.md)`, resolve(paths.claudeHome, `CLAUDE.md`)],
  ]
  const ops: Op[] = []
  for (const [label, path] of copies) ops.push(await planCopy(label, path, agentsMd, paths))
  ops.push(...await planMirror(paths), ...await planSettings(paths))
  return ops
}

/** Splits ops into tracked copies inside the repo and the machine's runtime config outside it. */
export function partitionByRepo(ops: Op[], repoRoot: string): { inRepo: Op[]; runtime: Op[] } {
  const inside = (path: string) => !relative(repoRoot, path).startsWith(`..`)
  return {
    inRepo: ops.filter((op) => inside(op.path)),
    runtime: ops.filter((op) => !inside(op.path)),
  }
}

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

async function main(): Promise<void> {
  const { mode, fromWorktree } = parseArgs(Deno.args)
  const paths = defaultPaths()
  let ops = await plan(paths)

  // A linked worktree has `.git` as a file, and its branch is unmerged by definition.
  const dotGit = await Deno.lstat(join(paths.repoRoot, `.git`)).catch(() => null)
  const withheld = dotGit?.isFile && mode === `apply` && !fromWorktree
    ? partitionByRepo(ops, paths.repoRoot).runtime.filter((op) => op.action !== `skip`)
    : []
  ops = ops.filter((op) => !withheld.includes(op))

  for (const op of ops) console.log(`[${op.action.toUpperCase()}] ${op.label} (${op.reason})`)
  for (const op of withheld) {
    console.log(`[WITHHELD] ${op.label} (linked worktree; needs --from-worktree)`)
  }
  const dirty = ops.filter((op) => op.action !== `skip`).length

  if (mode === `check`) {
    if (dirty > 0) {
      console.error(`\n${dirty} target(s) out of sync. Run: deno task sync-agents-md --apply`)
      Deno.exit(1)
    }
    console.log(`\nAll targets in sync.`)
  } else if (mode === `dry`) {
    console.log(
      dirty > 0
        ? `\nDry-run: ${dirty} target(s) need update. Re-run with --apply.`
        : `\nDry-run: nothing to do.`,
    )
  } else {
    console.log(`\nApplied: ${await apply(ops)} change(s).`)
  }
}

if (import.meta.main) {
  await main()
}
