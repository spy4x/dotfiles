#!/usr/bin/env -S deno run -A
// Copies the harness-neutral source in this directory — global rules, skills, agents, settings —
// into every installed AI harness, in the format each one reads. See README.md.
//
// Usage:
//   deno task ai           # apply
//   deno task ai --check   # write nothing; exit 1 if any harness differs from the source
//
// Refuses to run from a linked worktree: config from an unmerged branch would go live for every
// session on the machine before anyone reviewed it.

import { join } from "jsr:@std/path@^1.0.0"
import { apply, detect, loadConfig, plan } from "./engine.ts"
import { loadSource } from "./source.ts"

/** Plans every installed harness, then applies the plan or, with `--check`, only reports it. */
async function main(): Promise<void> {
  const check = Deno.args.includes(`--check`)
  const unknown = Deno.args.filter((arg) => arg !== `--check`)
  if (unknown.length > 0) throw new Error(`unknown argument ${unknown[0]}; usage: ai [--check]`)

  const root = import.meta.dirname!
  // A linked worktree has `.git` as a file, and its branch is unmerged by definition.
  const dotGit = await Deno.lstat(join(root, `..`, `.git`)).catch(() => null)
  if (dotGit?.isFile && !check) throw new Error(`run from the main checkout, after the merge`)

  const found = await detect(await loadConfig(join(root, `config.jsonc`)), Deno.env)
  console.log(`Harnesses: ${found.map((t) => `${t.name} (${t.home})`).join(`, `) || `none`}`)
  const pending = (await plan(await loadSource(root), found)).filter((op) => op.action !== `skip`)
  for (const op of pending) console.log(`[${op.action.toUpperCase()}] ${op.label} (${op.reason})`)

  if (check) {
    if (pending.length > 0) {
      console.error(`${pending.length} file(s) out of sync. Run: deno task ai`)
      Deno.exit(1)
    }
    console.log(`All targets in sync.`)
  } else {
    console.log(`Applied: ${await apply(pending)} change(s).`)
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
