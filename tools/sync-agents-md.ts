#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// Sync `dotfiles/.config/opencode/AGENTS.md` to the runtime locations the two
// harnesses read.
//
// Why: the source of truth lives in this repo, but neither OpenCode nor DSH
// read it directly. OpenCode reads `~/.config/opencode/AGENTS.md`; DSH reads
// `$DSH_HOME/AGENTS.md` (defaults to `~/.local/share/dsh/AGENTS.md`). Symlinks
// work for OpenCode; DSH does not reliably follow symlinks at `$DSH_HOME`, so
// that file must be a real file copy.
//
// Symlinks are fragile across reorgs and DSH reads can fail silently when the
// chain breaks (`~/.local/share/dsh/AGENTS.md` -> `~/.config/opencode/...` ->
// tracked file). This script keeps the runtime files as real copies and
// rewrites them whenever the tracked source changes.
//
// Idempotent. Safe to run from a post-commit hook or by hand.
//
// Usage:
//   deno task sync-agents-md           # dry-run (prints planned actions)
//   deno task sync-agents-md --apply   # write to runtime
//   deno task sync-agents-md --check   # exit 1 if any target is out of sync

import { resolve } from "jsr:@std/path@^1.0.0"

type Mode = "dry" | "apply" | "check"

const SOURCE = resolve(
  import.meta.dirname ?? ".",
  "..",
  ".config",
  "opencode",
  "AGENTS.md",
)

const TARGETS = [
  {
    label: "OpenCode global (~/.config/opencode/AGENTS.md)",
    path: resolve(Deno.env.get("HOME") ?? "~", ".config", "opencode", "AGENTS.md"),
    mode: "copy" as const,
  },
  {
    label: "DSH global (~/.local/share/dsh/AGENTS.md)",
    path: resolve(
      Deno.env.get("DSH_HOME") ??
        resolve(Deno.env.get("HOME") ?? "~", ".local", "share", "dsh"),
      "AGENTS.md",
    ),
    mode: "copy" as const,
  },
]

function parseArgs(argv: readonly string[]): Mode {
  for (const arg of argv) {
    if (arg === "--apply") return "apply"
    if (arg === "--check") return "check"
    if (arg === "--dry" || arg === "--dry-run") return "dry"
    if (arg === "-h" || arg === "--help") {
      console.log("Usage: sync-agents-md.ts [--dry | --apply | --check]")
      Deno.exit(0)
    }
    console.error(`Unknown argument: ${arg}`)
    Deno.exit(2)
  }
  return "dry"
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
}

async function fileInfo(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
}

type Action = "skip" | "write" | "remove-symlink"

interface TargetResult {
  readonly target: (typeof TARGETS)[number]
  readonly action: Action
  readonly reason: string
}

async function planFor(target: (typeof TARGETS)[number], sourceText: string): Promise<TargetResult> {
  const lstat = await Deno.lstat(target.path).catch(() => null)
  const existing = lstat ?? (await fileInfo(target.path))

  if (!lstat && !existing) {
    return { target, action: "write", reason: "missing" }
  }
  if (lstat?.isSymlink) {
    return { target, action: "remove-symlink", reason: "symlink (DSH/OpenCode need real file)" }
  }
  if (!lstat && existing?.isSymlink) {
    return { target, action: "remove-symlink", reason: "broken symlink" }
  }
  const existingText = await readOrNull(target.path)
  if (existingText === sourceText) {
    return { target, action: "skip", reason: "in sync" }
  }
  return { target, action: "write", reason: "content drift" }
}

async function writeCopy(path: string, text: string): Promise<void> {
  // Deno.writeTextFile follows symlinks; for a broken symlink, lstat the path
  // and remove it first so write creates a real file.
  const lstat = await Deno.lstat(path).catch(() => null)
  if (lstat?.isSymlink) {
    await Deno.remove(path)
  }
  await Deno.writeTextFile(path, text)
}

async function main(): Promise<void> {
  const mode = parseArgs(Deno.args)
  const sourceText = await Deno.readTextFile(SOURCE)

  const results: TargetResult[] = []
  for (const target of TARGETS) {
    results.push(await planFor(target, sourceText))
  }

  let dirty = 0
  for (const result of results) {
    const verb = result.action === "skip" ? "SKIP" : "WRITE"
    console.log(`[${verb}] ${result.target.label} (${result.reason})`)
    if (result.action !== "skip") dirty++
  }

  if (mode === "check") {
    if (dirty > 0) {
      console.error(`\n${dirty} target(s) out of sync. Run: deno task sync-agents-md --apply`)
      Deno.exit(1)
    }
    console.log("\nAll targets in sync.")
    Deno.exit(0)
  }

  if (mode === "dry") {
    if (dirty > 0) console.log(`\nDry-run: ${dirty} target(s) need update. Re-run with --apply.`)
    else console.log("\nDry-run: nothing to do.")
    Deno.exit(0)
  }

  // apply
  let wrote = 0
  for (const result of results) {
    if (result.action === "skip") continue
    if (result.action === "remove-symlink") {
      await Deno.remove(result.target.path)
    }
    await writeCopy(result.target.path, sourceText)
    wrote++
  }
  console.log(`\nApplied: ${wrote} file(s) written.`)
}

if (import.meta.main) {
  await main()
}