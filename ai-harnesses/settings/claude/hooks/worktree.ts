#!/usr/bin/env -S deno run --no-config --no-lock --allow-read --allow-write --allow-env=HOME --allow-run=git
// Claude Code WorktreeCreate / WorktreeRemove hook.
//
// Claude Code's default puts worktrees in `<repo>/.claude/worktrees/<name>`.
// That breaks here twice: repo tooling (`deno task check`, fmt, type-check)
// walks the tree and sweeps a nested checkout in, and on Fedora only the code
// tree carries the SELinux label containers can mount. So a WorktreeCreate hook
// replaces the default and uses the sibling layout from AGENTS.md:
//
//   <parent>/worktrees/<repo>/<type>/<slug>      branch <type>/<slug>
//
// `claude --worktree feat-login` or `feat/login` -> feat/login. A name with no
// Angular type (auto-generated `bold-oak-a3f2`, subagent isolation) -> wip/<name>;
// rename the branch once the work has a type.
//
// Contract (hooks reference): JSON on stdin; create prints the worktree path as
// the LAST stdout line, everything else goes to stderr; non-zero exit aborts.
// Because the hook replaces the default, `.worktreeinclude` is not processed —
// the age key copy below is this setup's equivalent.
//
// Usage: worktree.ts create | remove

import { basename, dirname, join } from "node:path"

const TYPES = [
  `feat`,
  `fix`,
  `refactor`,
  `chore`,
  `docs`,
  `style`,
  `perf`,
  `ci`,
  `test`,
  `build`,
  `revert`,
]

/** Branch + directory layout derived from the name Claude Code hands the hook. */
export interface Layout {
  branch: string
  path: string
}

/**
 * Maps a worktree name onto the sibling layout. `main` is the absolute path of
 * the main checkout (the one whose `.git` is a directory).
 */
export function layoutFor(name: string, main: string): Layout {
  const clean = name.trim().replace(/^[-/]+|[-/]+$/g, ``)
  if (clean === `` || clean.split(`/`).some((part) => part === `..` || part === `.`)) {
    throw new Error(`unusable worktree name: ${JSON.stringify(name)}`)
  }
  const typed = clean.match(new RegExp(`^(${TYPES.join(`|`)})[-/](.+)$`))
  const branch = typed
    ? `${typed[1]}/${typed[2].replaceAll(`/`, `-`)}`
    : `wip/${clean.replaceAll(`/`, `-`)}`
  return { branch, path: join(dirname(main), `worktrees`, basename(main), branch) }
}

async function git(
  dir: string,
  args: string[],
  quiet = false,
): Promise<{ ok: boolean; out: string }> {
  // 15s cap: a hung `git fetch` must not stall session start. A timeout reads as a failed command.
  const result = await new Deno.Command(`git`, {
    args: [`-C`, dir, ...args],
    stdout: `piped`,
    stderr: `piped`,
    signal: AbortSignal.timeout(15_000),
  }).output().catch(() => ({ code: 1, stdout: new Uint8Array(), stderr: new Uint8Array() }))
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim()
  if (!quiet && decode(result.stderr)) console.error(decode(result.stderr))
  return { ok: result.code === 0, out: decode(result.stdout) }
}

async function exists(path: string): Promise<boolean> {
  return await Deno.lstat(path).then(() => true, () => false)
}

async function mainCheckout(cwd: string): Promise<string> {
  const common = await git(cwd, [`rev-parse`, `--path-format=absolute`, `--git-common-dir`])
  if (!common.ok) throw new Error(`${cwd} is not inside a git repository`)
  return await Deno.realPath(dirname(common.out))
}

async function create(cwd: string, name: string): Promise<string> {
  const main = await mainCheckout(cwd)
  const { branch, path } = layoutFor(name, main)

  if (await exists(join(path, `.git`))) return path // same name again = reopen

  // Base on the remote default branch, freshly fetched. Offline or no remote: fall back to HEAD.
  const head = await git(main, [`symbolic-ref`, `--short`, `-q`, `refs/remotes/origin/HEAD`], true)
  const base = head.ok ? head.out : `HEAD`
  if (head.ok) await git(main, [`fetch`, `--quiet`, `origin`, base.replace(/^origin\//, ``)], true)

  await Deno.mkdir(dirname(path), { recursive: true })
  const branchExists =
    (await git(main, [`rev-parse`, `-q`, `--verify`, `refs/heads/${branch}`], true)).ok
  const args = branchExists
    ? [`worktree`, `add`, path, branch]
    : [`worktree`, `add`, `-b`, branch, path, base]
  if (!(await git(main, args)).ok) throw new Error(`git ${args.join(` `)} failed`)

  // age64 repos: secret-aware tasks need the key. It is gitignored, so a fresh checkout lacks it.
  const key = join(main, `.age`, `key.txt`)
  if (await exists(key) && !(await exists(join(path, `.age`, `key.txt`)))) {
    await Deno.mkdir(join(path, `.age`), { recursive: true })
    await Deno.copyFile(key, join(path, `.age`, `key.txt`))
    await Deno.chmod(join(path, `.age`, `key.txt`), 0o600)
    console.error(`copied .age/key.txt; run the repo's env:decrypt task if it has one`)
  }
  return path
}

/**
 * Removes only what is provably disposable: `git worktree remove` without
 * `--force` refuses a dirty tree, `git branch -d` refuses unmerged commits.
 * Anything with work in it stays on disk and the hook exits non-zero.
 */
async function remove(path: string): Promise<void> {
  if (!(await exists(path))) return
  const main = await mainCheckout(path)
  const branch = await git(path, [`symbolic-ref`, `--short`, `-q`, `HEAD`], true)
  if (!(await git(main, [`worktree`, `remove`, path])).ok) {
    throw new Error(`kept ${path}: it has uncommitted or untracked work`)
  }
  if (branch.ok) await git(main, [`branch`, `-d`, branch.out], true) // unmerged branch survives
}

if (import.meta.main) {
  const input = JSON.parse(await new Response(Deno.stdin.readable).text())
  try {
    if (Deno.args[0] === `create`) console.log(await create(input.cwd, input.name))
    else if (Deno.args[0] === `remove`) await remove(input.worktree_path)
    else throw new Error(`usage: worktree.ts create|remove`)
  } catch (error) {
    console.error(`worktree hook: ${error instanceof Error ? error.message : error}`)
    Deno.exit(1)
  }
}
