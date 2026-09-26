#!/usr/bin/env -S deno run --no-config --no-lock --allow-read --allow-run=pgrep,ps
// Claude Code PreToolUse hook for the Bash tool. Denies a command that would end
// the desktop session instead of the process the agent meant to stop.
//
// Once cost: an agent read the parent-PID column of a process listing as a PID
// and ran `kill <pid> <ppid>`. The parent was the systemd user manager, which
// treats SIGTERM as "log out": every app closed and the login screen came back.
//
// Denied:
//   - `kill` with a nonzero signal aimed at a protected process, at a process
//     group holding one, or at -1 (every process the user owns);
//   - `pkill`/`killall` whose pattern matches a protected process (the check
//     runs `pgrep` with the same pattern, so it matches exactly what would die);
//   - `systemctl --user exit`, power actions, and stopping or killing the
//     session's units; `loginctl terminate-*`/`kill-*`; `shutdown`/`reboot`/
//     `poweroff`/`halt`.
//
// Protected: PID 1, every systemd user manager, this hook's ancestors (the agent,
// the desktop app hosting it), and the desktop's core processes by name.
//
// A target the hook cannot resolve (`$pid`, `$(pgrep …)`, `%1`, `xargs kill`,
// `bash -c 'kill …'`) gets no opinion:
// like guard-git, a bug or a blind spot here must never brick a session.

import { basename } from "node:path"
import { type Finding, splitCommands, stripWrappers } from "./guard-git.ts"

/** Process names whose death ends or cripples the desktop session. */
const CRITICAL = new Set([
  `systemd`,
  `sddm`,
  `sddm-helper`,
  `gdm`,
  `gnome-shell`,
  `kwin_wayland`,
  `kwin_wayland_wr`, // kwin_wayland_wrapper, cut to 15 characters by the kernel
  `kwin_x11`,
  `plasmashell`,
  `ksmserver`,
  `Xwayland`,
  `Xorg`,
  `dbus-broker`,
  `dbus-broker-lau`,
  `dbus-daemon`,
  `pipewire`,
  `pipewire-pulse`,
  `wireplumber`,
  `claude-desktop`,
])

const POWER = [`poweroff`, `reboot`, `halt`, `kexec`, `soft-reboot`, `suspend`, `hibernate`]
const SESSION_UNIT = /^(plasma-|gnome-|dbus|pipewire|wireplumber|xdg-desktop-portal)|\.target$/

/** One running process as the checks see it. */
export interface Proc {
  pid: number
  pgid: number
  comm: string
}

/** How the hook reads the process table; tests pass a fake. */
export interface System {
  /** Every process, or a snapshot of them. */
  procs(): Promise<Proc[]>
  /** PIDs of this hook's ancestors, nearest first. */
  ancestors(): Promise<number[]>
  /** PIDs `pgrep args` prints, or null when pgrep reports a usage error. */
  pgrep(args: string[]): Promise<number[] | null>
}

/** PIDs whose signal would end the session, with the name to show in the reason. */
export async function protectedPids(sys: System): Promise<Map<number, string>> {
  const procs = await sys.procs()
  const names = new Map(procs.map((p) => [p.pid, p.comm]))
  const found = new Map<number, string>([[1, names.get(1) ?? `init`]])
  for (const p of procs) if (CRITICAL.has(p.comm)) found.set(p.pid, p.comm)
  for (const pid of await sys.ancestors()) found.set(pid, names.get(pid) ?? `ancestor`)
  return found
}

/** `kill` args split into the signal and the targets; `-N` targets are process groups. */
export function parseKill(args: string[]): { signal: string; targets: string[] } | null {
  let signal = `TERM`
  const targets: string[] = []
  let i = 0
  let options = true
  while (i < args.length) {
    const arg = args[i]
    if (options && arg === `--`) {
      options = false
    } else if (options && [`-l`, `-L`, `--list`, `--table`].includes(arg)) {
      return null
    } else if (options && [`-s`, `-n`, `--signal`].includes(arg)) {
      signal = args[++i] ?? signal
    } else if (options && arg.startsWith(`--signal=`)) {
      signal = arg.slice(`--signal=`.length)
    } else if (options && targets.length === 0 && /^-[A-Za-z0-9+]+$/.test(arg)) {
      signal = arg.slice(1)
      options = false
    } else {
      targets.push(arg)
      options = false
    }
    i++
  }
  return { signal: signal.toUpperCase().replace(/^SIG/, ``), targets }
}

async function checkKill(args: string[], sys: System): Promise<Finding | null> {
  const parsed = parseKill(args)
  if (!parsed || parsed.signal === `0`) return null
  let guarded: Map<number, string> | null = null
  for (const target of parsed.targets) {
    if (!/^-?\d+$/.test(target)) continue
    const n = Number(target)
    if (n === -1) {
      return deny(`\`kill ${target}\` signals every process you own, which ends the session.`)
    }
    guarded ??= await protectedPids(sys)
    if (n > 0 && guarded.has(n)) {
      return deny(`PID ${n} is ${guarded.get(n)}, which the session needs. ${HINT}`)
    }
    if (n < 0) {
      const group = (await sys.procs()).find((p) => p.pgid === -n && guarded!.has(p.pid))
      if (group) {
        return deny(`process group ${-n} holds ${group.comm} (PID ${group.pid}). ${HINT}`)
      }
    }
  }
  return null
}

/** `pkill` args turned into the `pgrep` args that select the same processes. */
export function pkillToPgrep(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (i === 0 && /^-(\d+|[A-Z][A-Z0-9+-]+)$/.test(arg)) continue
    if (arg === `--signal` || arg === `-q` || arg === `--queue`) {
      i++
      continue
    }
    if (arg.startsWith(`--signal=`) || arg === `--echo` || arg === `--inverse`) continue
    if (/^-[a-zA-Z]+$/.test(arg) && arg.includes(`e`)) {
      const rest = arg.replaceAll(`e`, ``)
      if (rest !== `-`) out.push(rest)
      continue
    }
    out.push(arg)
  }
  return out
}

/** `killall` args turned into `pgrep` calls, one per name. */
export function killallToPgrep(args: string[]): string[][] {
  const flags: string[] = []
  const names: string[] = []
  let regex = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === `-r` || arg === `--regexp`) regex = true
    else if ([`-u`, `--user`].includes(arg)) flags.push(`-u`, args[++i] ?? ``)
    else if ([`-s`, `--signal`, `-o`, `-y`, `--older-than`, `--younger-than`].includes(arg)) i++
    else if (!arg.startsWith(`-`)) names.push(arg)
  }
  // `killall -u <user>` with no name kills everything that user owns.
  if (names.length === 0) return flags.length ? [flags] : []
  return names.map((name) => [...flags, ...(regex ? [] : [`-x`]), name])
}

async function checkPattern(calls: string[][], sys: System): Promise<Finding | null> {
  let guarded: Map<number, string> | null = null
  for (const args of calls) {
    const pids = await sys.pgrep(args)
    if (!pids?.length) continue
    guarded ??= await protectedPids(sys)
    const hit = pids.find((pid) => guarded!.has(pid))
    if (hit) {
      return deny(`the pattern also matches ${guarded.get(hit)} (PID ${hit}). ${HINT}`)
    }
  }
  return null
}

function checkSystemctl(args: string[]): Finding | null {
  const words = args.filter((a) => !a.startsWith(`-`))
  const [verb, ...units] = words
  const user = args.includes(`--user`)
  if (POWER.includes(verb) || (user && verb === `exit`)) {
    return deny(`\`systemctl ${args.join(` `)}\` ends the session or powers the machine off.`)
  }
  if ([`stop`, `kill`, `restart`, `isolate`].includes(verb)) {
    const unit = units.find((u) => SESSION_UNIT.test(u))
    if (unit) return deny(`\`systemctl ${verb} ${unit}\` takes the desktop session down.`)
  }
  return null
}

const HINT =
  `Stop only the process you started: \`sweep-orphans.sh --under <dir> --kill\`, or its PID from the first column.`

function deny(reason: string): Finding {
  return { verdict: `deny`, reason: `guard-kill: ${reason}` }
}

/**
 * Drops leading `sudo` and `timeout` with their options (agents here have passwordless sudo, and
 * `timeout -s KILL 5` hides its duration behind an option value), then guard-git's wrappers.
 */
export function unwrap(argv: string[]): string[] {
  let rest = argv
  for (;;) {
    const name = basename(rest[0] ?? ``)
    const valued = name === `sudo` ? /^-[ugCDhprtU]$/ : name === `timeout` ? /^-[sk]$/ : null
    if (!valued) {
      const stripped = stripWrappers(rest)
      if (stripped.length === rest.length) return rest
      rest = stripped
      continue
    }
    let i = 1
    while (i < rest.length && rest[i].startsWith(`-`)) {
      if (rest[i] === `--`) {
        i++
        break
      }
      if (valued.test(rest[i]) || [`--signal`, `--kill-after`].includes(rest[i])) i++
      i++
    }
    if (name === `timeout`) i++ // the duration
    rest = rest.slice(i)
  }
}

/** Returns the first deny for a Bash command line, or null. */
export async function evaluate(line: string, sys: System): Promise<Finding | null> {
  // splitCommands, not toSegments: the working directory is irrelevant here, and resolving a `cd`
  // reads HOME, which the hook's permissions do not grant.
  for (const raw of splitCommands(line)) {
    const [program, ...args] = unwrap(raw)
    if (!program) continue
    const name = basename(program)
    let finding: Finding | null = null
    if (name === `kill`) finding = await checkKill(args, sys)
    else if (name === `pkill`) finding = await checkPattern([pkillToPgrep(args)], sys)
    else if (name === `killall`) finding = await checkPattern(killallToPgrep(args), sys)
    else if (name === `systemctl`) finding = checkSystemctl(args)
    else if (
      name === `loginctl` && /^(terminate|kill)-/.test(args.find((a) => !a.startsWith(`-`)) ?? ``)
    ) {
      finding = deny(`\`loginctl ${args.join(` `)}\` ends a login session.`)
    } else if ([`shutdown`, `reboot`, `poweroff`, `halt`].includes(name)) {
      finding = deny(`\`${name}\` powers the machine off.`)
    }
    if (finding) return finding
  }
  return null
}

/** Runs `ps` or `pgrep`; Deno demands full permissions to read /proc directly. */
async function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  const { code, stdout } = await new Deno.Command(cmd, { args, stdout: `piped`, stderr: `null` })
    .output()
  return { code, out: new TextDecoder().decode(stdout) }
}

/** Reads the real process table through `ps`. */
export const linux: System = {
  async procs() {
    const { out } = await run(`ps`, [`-eo`, `pid=,pgid=,comm=`])
    return out.split(`\n`).filter((l) => l.trim()).map((line) => {
      const [pid, pgid, ...comm] = line.trim().split(/\s+/)
      return { pid: Number(pid), pgid: Number(pgid), comm: comm.join(` `) }
    })
  },
  async ancestors() {
    const chain: number[] = []
    let pid = Deno.pid
    while (pid > 1) {
      pid = Number((await run(`ps`, [`-o`, `ppid=`, `-p`, `${pid}`])).out.trim())
      if (!pid) break
      chain.push(pid)
    }
    return chain
  },
  async pgrep(args) {
    const { code, out } = await run(`pgrep`, args)
    if (code > 1) return null
    return out.split(`\n`).filter(Boolean).map(Number)
  },
}

if (import.meta.main) {
  const input = JSON.parse(await new Response(Deno.stdin.readable).text())
  const line: string | undefined = input.tool_input?.command
  if (input.tool_name === `Bash` && line) {
    const finding = await evaluate(line, linux)
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
