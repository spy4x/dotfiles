#!/usr/bin/env -S deno run --no-config --no-lock --allow-read --allow-env=HOME --allow-run=git,gitleaks
// Claude Code PreToolUse hook for the Bash tool. Turns four prose rules from
// AGENTS.md into checks that run before the command does:
//
//   1. `git commit` on main/master        -> ask the user   (worktree-first rule)
//   2. `git worktree add` inside a repo   -> deny           (sibling worktrees/ only)
//   3. `gh pr merge`                      -> ask the user   (merge only on explicit "merge")
//   4. `git push`, `gh ... create/edit`   -> gitleaks scan, deny on a finding
//
// Contract: JSON on stdin, optional decision JSON on stdout, exit 0. No output
// means "no opinion" and the normal permission flow continues. A crash exits
// non-zero-but-not-2, which Claude Code treats as a non-blocking error: a bug in
// this guard must never brick a session (fail-open). The one fail-closed path is
// a gitleaks run that errors while secrets may be leaving the box — that asks.
//
// No imports beyond `node:path` (built in): the hook runs on every Bash call
// and must start in milliseconds with a cold cache and no network.

import { basename, dirname, isAbsolute, relative, resolve } from "node:path"

/** Decision the hook can hand back to Claude Code. */
export type Verdict = `ask` | `deny`

/** One blocking or prompting outcome, with the reason shown to user and model. */
export interface Finding {
  verdict: Verdict
  reason: string
}

/** A simple command split out of a compound shell line, with the dir it runs in. */
export interface Segment {
  argv: string[]
  cwd: string
}

/** Subset of the PreToolUse payload this hook reads. */
interface HookInput {
  tool_name?: string
  cwd?: string
  tool_input?: { command?: string }
}

const PROTECTED_BRANCHES = [`main`, `master`]
const WRAPPERS = [
  `timeout`,
  `time`,
  `nice`,
  `nohup`,
  `stdbuf`,
  `command`,
  `builtin`,
  `noglob`,
  `env`,
]
const GH_OUTBOUND = [`create`, `edit`, `comment`, `review`, `close`, `merge`]

/**
 * Splits a shell line into simple commands. Understands single quotes, double
 * quotes and backslash escapes, so a `;` or `&&` inside a commit message does
 * not split. It does not expand variables, globs or substitutions: a token that
 * needs expansion stays literal, and callers treat an unresolvable path as
 * "no opinion" rather than guessing.
 */
export function splitCommands(line: string): string[][] {
  const commands: string[][] = []
  let argv: string[] = []
  let token = ``
  let hasToken = false
  let quote: `'` | `"` | null = null

  const endToken = () => {
    if (hasToken) argv.push(token)
    token = ``
    hasToken = false
  }
  const endCommand = () => {
    endToken()
    if (argv.length > 0) commands.push(argv)
    argv = []
  }

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    // Command substitution runs even inside double quotes: scan its body as commands of its own.
    const substitution = quote !== `'` && (ch === `\`` || (ch === `$` && line[i + 1] === `(`))
    if (substitution) {
      const open = ch === `$` ? i + 2 : i + 1
      const close = ch === `$` ? matchingParen(line, open) : line.indexOf(`\``, open)
      const end = close === -1 ? line.length : close
      commands.push(...splitCommands(line.slice(open, end)))
      token += `$()`
      hasToken = true
      i = end
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === `\\` && quote === `"` && i + 1 < line.length) token += line[++i]
      else token += ch
      continue
    }
    if (ch === `'` || ch === `"`) {
      quote = ch
      hasToken = true
    } else if (ch === `\\` && i + 1 < line.length) {
      token += line[++i]
      hasToken = true
    } else if (ch === ` ` || ch === `\t`) {
      endToken()
    } else if (ch === `\n` || ch === `;` || ch === `|` || ch === `&` || ch === `(` || ch === `)`) {
      endCommand()
    } else {
      token += ch
      hasToken = true
    }
  }
  endCommand()
  return commands
}

/** Index of the `)` closing a `$(` whose body starts at `from`, or -1. */
function matchingParen(line: string, from: number): number {
  let depth = 1
  for (let i = from; i < line.length; i++) {
    if (line[i] === `(`) depth++
    else if (line[i] === `)` && --depth === 0) return i
  }
  return -1
}

/** Drops leading `VAR=value` assignments and exec wrappers such as `timeout 30`. */
export function stripWrappers(argv: string[]): string[] {
  let rest = [...argv]
  for (;;) {
    if (rest.length === 0) return rest
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) {
      rest = rest.slice(1)
    } else if (WRAPPERS.includes(rest[0])) {
      rest = rest.slice(1)
      // wrapper flags and numeric args: `timeout -k 5 30 git ...`, `nice -n 10 git ...`
      while (rest.length > 0 && (/^-/.test(rest[0]) || /^\d+[smhd]?$/.test(rest[0]))) {
        rest = rest.slice(1)
      }
    } else {
      return rest
    }
  }
}

/** Resolves `cd` hops and wrappers so every segment knows the dir it runs in. */
export function toSegments(line: string, startCwd: string): Segment[] {
  const segments: Segment[] = []
  let cwd = startCwd
  for (const raw of splitCommands(line)) {
    const argv = stripWrappers(raw)
    if (argv.length === 0) continue
    if (argv[0] === `cd` && argv[1] && !argv[1].startsWith(`-`)) {
      cwd = resolve(cwd, expandHome(argv[1]))
      continue
    }
    segments.push({ argv, cwd })
  }
  return segments
}

/** Parsed `git [global options] <subcommand> [args]`. */
export interface GitCall {
  dir: string
  subcommand: string
  args: string[]
}

/** Reads git's global options (`-C`, `-c`, `--git-dir=…`) to find the real subcommand and dir. */
export function parseGit(segment: Segment): GitCall | null {
  const [program, ...rest] = segment.argv
  if (basename(program) !== `git`) return null
  let dir = segment.cwd
  let i = 0
  while (i < rest.length && rest[i].startsWith(`-`)) {
    if (rest[i] === `-C` && rest[i + 1]) {
      dir = resolve(dir, expandHome(rest[i + 1]))
      i += 2
    } else if ([`-c`, `--git-dir`, `--work-tree`, `--namespace`, `--exec-path`].includes(rest[i])) {
      i += 2
    } else {
      i += 1
    }
  }
  if (i >= rest.length) return null
  return { dir, subcommand: rest[i], args: rest.slice(i + 1) }
}

/** `gh [-R repo] <group> <action>`: returns e.g. [`pr`, `merge`], ignoring flags. */
export function parseGh(segment: Segment): string[] | null {
  const [program, ...rest] = segment.argv
  if (basename(program) !== `gh`) return null
  const words: string[] = []
  for (let i = 0; i < rest.length && words.length < 2; i++) {
    if ([`-R`, `--repo`].includes(rest[i])) i += 1
    else if (!rest[i].startsWith(`-`)) words.push(rest[i])
  }
  return words
}

/** True when `child` is `parent` or lives under it. Both must be absolute. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === `` || (!rel.startsWith(`..`) && !isAbsolute(rel))
}

/** The path argument of `git worktree add [opts] <path> [commit-ish]`, or null. */
export function worktreeAddPath(args: string[]): string | null {
  if (args[0] !== `add`) return null
  const withValue = [`-b`, `-B`, `--reason`, `--orphan`]
  for (let i = 1; i < args.length; i++) {
    if (withValue.includes(args[i])) i += 1
    else if (!args[i].startsWith(`-`)) return args[i]
  }
  return null
}

function expandHome(path: string): string {
  const home = Deno.env.get(`HOME`)
  if (home && (path === `~` || path.startsWith(`~/`))) return home + path.slice(1)
  return path
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  stdin?: string,
): Promise<RunResult | null> {
  try {
    const child = new Deno.Command(cmd, {
      args,
      cwd,
      stdin: stdin === undefined ? `null` : `piped`,
      stdout: `piped`,
      stderr: `piped`,
    }).spawn()
    if (stdin !== undefined) {
      const writer = child.stdin.getWriter()
      await writer.write(new TextEncoder().encode(stdin))
      await writer.close()
    }
    const out = await child.output()
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim()
    return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) }
  } catch {
    return null // binary missing or dir gone: caller decides
  }
}

async function git(dir: string, ...args: string[]): Promise<string | null> {
  const result = await run(`git`, [`-C`, dir, ...args], dir)
  return result && result.code === 0 ? result.stdout : null
}

async function checkCommit(call: GitCall): Promise<Finding | null> {
  if (call.args.includes(`--dry-run`)) return null
  const branch = await git(call.dir, `symbolic-ref`, `--short`, `-q`, `HEAD`)
  if (!branch || !PROTECTED_BRANCHES.includes(branch)) return null
  return {
    verdict: `ask`,
    reason: `Commit on \`${branch}\` in ${call.dir}. AGENTS.md: worktree first, never commit to ` +
      `the default branch. Approve only for a deliberate exception (fresh repo, trivial personal ` +
      `repo). Otherwise: create <type>/<slug> in the sibling worktrees/ dir and commit there.`,
  }
}

async function checkWorktreeAdd(call: GitCall): Promise<Finding | null> {
  const target = worktreeAddPath(call.args)
  if (!target || /[$`*?]/.test(target)) return null // needs shell expansion: no opinion
  const common = await git(call.dir, `rev-parse`, `--path-format=absolute`, `--git-common-dir`)
  const top = await git(call.dir, `rev-parse`, `--show-toplevel`)
  if (!common || !top) return null
  const path = resolve(call.dir, expandHome(target))
  const main = dirname(common)
  const inside = [main, top].find((root) => isInside(path, root))
  if (!inside) return null
  const sibling = `${dirname(main)}/worktrees/${basename(main)}/<type>/<slug>`
  return {
    verdict: `deny`,
    reason: `Worktree path ${path} is inside checkout ${inside}. Nested worktrees get swept into ` +
      `fmt/type-check and show up as untracked dirs. Use the sibling layout: ${sibling}`,
  }
}

/** Binaries the guard shells out to. Injectable so tests can point at a stub. */
export interface Tools {
  gitleaks: string
}

const DEFAULT_TOOLS: Tools = { gitleaks: `gitleaks` }

/** Runs gitleaks; null = clean or gitleaks not installed. */
async function gitleaks(
  tools: Tools,
  args: string[],
  cwd: string,
  what: string,
  stdin?: string,
): Promise<Finding | null> {
  const result = await run(
    tools.gitleaks,
    [...args, `--verbose`, `--redact`, `--no-banner`, `--no-color`, `--exit-code`, `3`],
    cwd,
    stdin,
  )
  if (!result || result.code === 0) return null
  if (result.code === 3) {
    const rules = [...result.stdout.matchAll(/^RuleID:\s+(\S+)/gm)].map((m) => m[1])
    const files = [...result.stdout.matchAll(/^File:\s+(\S+)/gm)].map((m) => m[1])
    const where = files.length > 0 ? ` in ${[...new Set(files)].slice(0, 5).join(`, `)}` : ``
    return {
      verdict: `deny`,
      reason:
        `gitleaks: ${rules.length || `a`} secret finding(s) [${
          [...new Set(rules)].join(`, `)
        }]${where} — ` +
        `${what}. If real: rotate first, then remove it from history. If a fixture: allowlist it in ` +
        `.gitleaks.toml or mark the line \`gitleaks:allow\`.`,
    }
  }
  return {
    verdict: `ask`,
    reason:
      `gitleaks failed (exit ${result.code}) while checking ${what}: ${
        result.stderr.slice(-300)
      }. ` +
      `Secret-bearing sends fail closed — approve only if you are sure nothing sensitive is going out.`,
  }
}

async function checkPush(call: GitCall, tools: Tools): Promise<Finding | null> {
  // Everything reachable from HEAD that no remote has yet = what this push can publish.
  const pending = await git(call.dir, `rev-list`, `--count`, `HEAD`, `--not`, `--remotes`)
  if (!pending || pending === `0`) return null
  const what = `${pending} unpushed commit(s)`
  return await gitleaks(tools, [`git`, `--log-opts=HEAD --not --remotes`, `.`], call.dir, what)
}

async function checkGhBody(segment: Segment, line: string, tools: Tools): Promise<Finding | null> {
  // The body is usually inline in the command; a --body-file / -F path is read as well.
  let text = line
  const argv = segment.argv
  for (let i = 0; i < argv.length - 1; i++) {
    if ([`--body-file`, `-F`, `--notes-file`].includes(argv[i]) && argv[i + 1] !== `-`) {
      text += `\n` +
        await Deno.readTextFile(resolve(segment.cwd, expandHome(argv[i + 1]))).catch(() => ``)
    }
  }
  return await gitleaks(tools, [`stdin`], segment.cwd, `the text of a \`gh\` command`, text)
}

/** Evaluates one Bash command line; the first finding wins, deny before ask. */
export async function evaluate(
  line: string,
  cwd: string,
  tools = DEFAULT_TOOLS,
): Promise<Finding | null> {
  const findings: Finding[] = []
  for (const segment of toSegments(line, cwd)) {
    const call = parseGit(segment)
    if (call?.subcommand === `commit`) {
      findings.push(...[await checkCommit(call)].filter((f) => f !== null))
    }
    if (call?.subcommand === `worktree`) {
      findings.push(...[await checkWorktreeAdd(call)].filter((f) => f !== null))
    }
    if (call?.subcommand === `push`) {
      findings.push(...[await checkPush(call, tools)].filter((f) => f !== null))
    }

    const gh = parseGh(segment)
    if (gh?.[0] === `pr` && gh[1] === `merge`) {
      findings.push({
        verdict: `ask`,
        reason:
          `\`gh pr merge\`: AGENTS.md allows a merge only on an explicit "merge" from the user in this session.`,
      })
    } else if (gh && GH_OUTBOUND.includes(gh[1])) {
      findings.push(...[await checkGhBody(segment, line, tools)].filter((f) => f !== null))
    }
  }
  return findings.find((f) => f.verdict === `deny`) ?? findings[0] ?? null
}

if (import.meta.main) {
  const input: HookInput = JSON.parse(await new Response(Deno.stdin.readable).text())
  const line = input.tool_input?.command
  if (input.tool_name === `Bash` && line && /\b(git|gh)\b/.test(line)) {
    const finding = await evaluate(line, input.cwd ?? Deno.cwd())
    if (finding) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: `PreToolUse`,
          permissionDecision: finding.verdict,
          permissionDecisionReason: finding.reason,
        },
      }))
    }
  }
}
