#!/usr/bin/env -S deno run -A
// Renders the harness-neutral source in this directory — global rules, skills, agents, settings —
// into the format each installed AI harness reads, and copies it into place.
//
// Real copies, not symlinks: DSH does not reliably follow a symlink at `$DSH_HOME`, Claude Code
// skips a symlinked `~/.claude/CLAUDE.md` in some session types, apps that save settings replace
// a symlink with a real file, and a symlinked home puts the harness's runtime files (sessions,
// credentials, lockfiles) inside this repo. Copies plus `--check` keep drift visible instead.
//
// Usage:
//   deno task ai                          # dry-run: print planned actions
//   deno task ai --apply                  # write to every detected harness home
//   deno task ai --check                  # exit 1 if any target is out of sync
//   deno task ai migrate [--apply]        # move a symlinked harness home onto a real directory
//
// From a linked worktree, --apply writes nothing: config from an unmerged branch would go live for
// every session on the machine before anyone reviewed it. Pass --from-worktree to do that on
// purpose.

import { join } from "jsr:@std/path@^1.0.0"
import {
  apply,
  applyMigration,
  detect,
  loadConfig,
  type Op,
  plan,
  planMigration,
} from "./engine.ts"
import { loadSource } from "./source.ts"

type Mode = `dry` | `apply` | `check`

interface Args {
  mode: Mode
  migrate: boolean
  fromWorktree: boolean
}

const USAGE = `Usage: manage.ts [--dry | --apply [--from-worktree] | --check]
       manage.ts migrate [--apply]`

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { mode: `dry`, migrate: false, fromWorktree: false }
  for (const arg of argv) {
    if (arg === `migrate`) args.migrate = true
    else if (arg === `--apply`) args.mode = `apply`
    else if (arg === `--check`) args.mode = `check`
    else if (arg === `--dry` || arg === `--dry-run`) args.mode = `dry`
    else if (arg === `--from-worktree`) args.fromWorktree = true
    else if (arg === `-h` || arg === `--help`) {
      console.log(USAGE)
      Deno.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}\n${USAGE}`)
      Deno.exit(2)
    }
  }
  return args
}

/** Prints the planned migration and, with `--apply`, carries it out. */
async function migrate(root: string, mode: Mode): Promise<void> {
  const migrations = await planMigration(await loadConfig(join(root, `config.jsonc`)), Deno.env)
  if (migrations.length === 0) {
    console.log(`No harness home is a symlink into a git checkout. Nothing to migrate.`)
    return
  }
  for (const { name, home, from, entries } of migrations) {
    console.log(`[MIGRATE] ${name}: ${home} → real directory; move from ${from ?? `nowhere`}:`)
    for (const entry of entries) console.log(`  ${entry}`)
  }
  if (mode !== `apply`) {
    console.log(`\nDry-run. Stop the harness first, then re-run with --apply.`)
    return
  }
  await applyMigration(migrations)
  console.log(`\nMigrated. Now run: deno task ai --apply`)
}

/** Parses the arguments, plans every harness, and prints, checks or applies the plan. */
async function main(): Promise<void> {
  const { mode, migrate: migrating, fromWorktree } = parseArgs(Deno.args)
  const root = import.meta.dirname!
  const repoRoot = join(root, `..`)

  // A linked worktree has `.git` as a file, and its branch is unmerged by definition.
  const dotGit = await Deno.lstat(join(repoRoot, `.git`)).catch(() => null)
  const guarded = dotGit?.isFile && mode === `apply` && !fromWorktree

  if (migrating) {
    if (guarded) throw new Error(`migrate --apply runs from the main checkout, after the merge`)
    return await migrate(root, mode)
  }

  const config = await loadConfig(join(root, `config.jsonc`))
  const found = await detect(config, Deno.env)
  console.log(`Harnesses: ${found.map((t) => `${t.name} (${t.home})`).join(`, `) || `none`}\n`)
  let ops: Op[] = await plan(await loadSource(root), found)

  const withheld = guarded ? ops.filter((op) => op.action !== `skip`) : []
  ops = ops.filter((op) => !withheld.includes(op))

  const inSync = ops.filter((op) => op.reason === `in sync`).length
  for (const op of ops.filter((op) => op.reason !== `in sync` && op.action !== `blocked`)) {
    console.log(`[${op.action.toUpperCase()}] ${op.label} (${op.reason})`)
  }
  // A blocked home blocks every file in it: one line per harness, not one per file.
  const blocked = Map.groupBy(
    ops.filter((op) => op.action === `blocked`),
    (op) => `${op.label.split(` `)[0]} (${op.reason})`,
  )
  for (const [key, group] of blocked) console.log(`[BLOCKED] ${group.length} file(s) in ${key}`)
  console.log(`${inSync} file(s) already in sync.`)
  for (const op of withheld) {
    console.log(`[WITHHELD] ${op.label} (linked worktree; needs --from-worktree)`)
  }
  const dirty = ops.filter((op) => op.action !== `skip`).length

  if (mode === `check`) {
    if (dirty > 0) {
      console.error(`\n${dirty} target(s) out of sync. Run: deno task ai --apply`)
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
  try {
    await main()
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    Deno.exit(1)
  }
}
