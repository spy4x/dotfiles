import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import {
  evaluate,
  killallToPgrep,
  linux,
  parseKill,
  pkillToPgrep,
  type Proc,
  type System,
} from "./guard-kill.ts"

// The session from the incident: user manager 15226, the desktop app under it, the agent under that.
const PROCS: Proc[] = [
  { pid: 1, pgid: 1, comm: `systemd` },
  { pid: 15226, pgid: 15226, comm: `systemd` },
  { pid: 15844, pgid: 15844, comm: `plasmashell` },
  { pid: 16157, pgid: 16157, comm: `claude-desktop` },
  { pid: 20000, pgid: 20000, comm: `claude` },
  { pid: 925428, pgid: 925428, comm: `timeout` },
  { pid: 925430, pgid: 925428, comm: `deno` },
]

/** Fake process table; `pgrep` answers from `matches`, keyed by the joined args. */
function fake(matches: Record<string, number[]> = {}): System {
  return {
    procs: () => Promise.resolve(PROCS),
    ancestors: () => Promise.resolve([20000, 16157, 15226, 1]),
    pgrep: (args) => Promise.resolve(matches[args.join(` `)] ?? []),
  }
}

async function verdict(line: string, sys = fake()): Promise<string | null> {
  return (await evaluate(line, sys))?.verdict ?? null
}

Deno.test(`denies the command from the incident`, async () => {
  const finding = await evaluate(`kill 925428 15226 2>/dev/null; pkill -f "serve.ts 48741"`, fake())
  assertEquals(finding?.verdict, `deny`)
  assertStringIncludes(finding!.reason, `PID 15226 is systemd`)
})

Deno.test(`allows killing a leaked process`, async () => {
  assertEquals(await verdict(`kill 925428`), null)
  assertEquals(await verdict(`kill -9 925428 925430`), null)
})

Deno.test(`denies a signal to an ancestor or a desktop process`, async () => {
  assertEquals(await verdict(`kill -TERM 16157`), `deny`)
  assertEquals(await verdict(`kill 20000`), `deny`) // the agent itself: protected only as an ancestor
  assertEquals(await verdict(`kill -s KILL 15844`), `deny`)
  assertEquals(await verdict(`timeout 5 kill 1`), `deny`)
})

Deno.test(`allows the zero-signal liveness probe`, async () => {
  assertEquals(await verdict(`kill -0 15226`), null)
  assertEquals(await verdict(`kill -s 0 15226`), null)
})

Deno.test(`denies kill -1 and a process group holding a protected process`, async () => {
  assertEquals(await verdict(`kill -9 -1`), `deny`)
  assertEquals(await verdict(`kill -- -15226`), `deny`)
  assertEquals(await verdict(`kill -- -925428`), null)
})

Deno.test(`finds kill inside a compound or substituted command`, async () => {
  assertEquals(await verdict(`cd /tmp && echo x | tee y; kill 15226`), `deny`)
  assertEquals(await verdict(`echo $(kill 15226)`), `deny`)
})

Deno.test(`sees through sudo`, async () => {
  assertEquals(await verdict(`sudo -n kill 15226`), `deny`)
  assertEquals(await verdict(`sudo -u root -n kill -9 1`), `deny`)
  assertEquals(await verdict(`sudo -n kill 925428`), null)
})

Deno.test(`gives no opinion on a target it cannot resolve`, async () => {
  assertEquals(await verdict(`kill $PID`), null)
  assertEquals(await verdict(`kill %1`), null)
})

Deno.test(`pkill is judged by what pgrep would match`, async () => {
  const sys = fake({ [`-f claude`]: [16157, 20000], [`-f serve.ts`]: [925430] })
  assertEquals(await verdict(`pkill -9 -f claude`, sys), `deny`)
  assertEquals(await verdict(`pkill -f serve.ts`, sys), null)
})

Deno.test(`pkill-only flags are dropped before pgrep`, () => {
  assertEquals(pkillToPgrep([`-KILL`, `-ef`, `x`]), [`-f`, `x`])
  assertEquals(pkillToPgrep([`--signal`, `9`, `-e`, `-u`, `me`, `x`]), [`-u`, `me`, `x`])
})

Deno.test(`killall is judged per name`, async () => {
  assertEquals(killallToPgrep([`-9`, `plasmashell`, `deno`]), [[`-x`, `plasmashell`], [
    `-x`,
    `deno`,
  ]])
  assertEquals(await verdict(`killall plasmashell`, fake({ [`-x plasmashell`]: [15844] })), `deny`)
})

Deno.test(`parseKill reads signal forms and --`, () => {
  assertEquals(parseKill([`-9`, `1`, `-2`]), { signal: `9`, targets: [`1`, `-2`] })
  assertEquals(parseKill([`--signal=SIGHUP`, `5`]), { signal: `HUP`, targets: [`5`] })
  assertEquals(parseKill([`--`, `-7`]), { signal: `TERM`, targets: [`-7`] })
  assertEquals(parseKill([`-l`]), null)
})

Deno.test(`denies ending the session through systemd or logind`, async () => {
  assertEquals(await verdict(`systemctl --user exit`), `deny`)
  assertEquals(await verdict(`systemctl reboot`), `deny`)
  assertEquals(await verdict(`systemctl --user stop plasma-plasmashell.service`), `deny`)
  assertEquals(await verdict(`systemctl --user stop graphical-session.target`), `deny`)
  assertEquals(await verdict(`loginctl terminate-user spy4x`), `deny`)
  assertEquals(await verdict(`sudo -n shutdown -h now`), `deny`)
  assertEquals(await verdict(`shutdown -h now`), `deny`)
  assertEquals(await verdict(`systemctl --user restart my-app.service`), null)
  assertEquals(await verdict(`systemctl --user status`), null)
})

Deno.test(`the hook works with the permissions settings.json grants`, async () => {
  const settings = JSON.parse(await Deno.readTextFile(new URL(`../settings.json`, import.meta.url)))
  const command: string = settings.hooks.PreToolUse[0].hooks[0].command
  // `deno run <flags> "$HOME/.claude/hooks/guard-kill.ts"`: keep the flags, point at this copy.
  const flags = command.split(` `).slice(2, -1)
  const script = new URL(`./guard-kill.ts`, import.meta.url).pathname
  const hook = async (line: string) => {
    const child = new Deno.Command(Deno.execPath(), {
      args: [`run`, ...flags, script],
      stdin: `piped`,
      stdout: `piped`,
      stderr: `piped`,
    }).spawn()
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode(JSON.stringify({
      tool_name: `Bash`,
      tool_input: { command: line },
    })))
    await writer.close()
    const { code, stdout, stderr } = await child.output()
    assertEquals(code, 0, new TextDecoder().decode(stderr))
    return new TextDecoder().decode(stdout)
  }
  assertStringIncludes(await hook(`kill -TERM 1`), `"permissionDecision":"deny"`)
  assertEquals(await hook(`kill -TERM 999999999`), ``)
})

Deno.test(`linux reads this process's real ancestry`, async () => {
  const chain = await linux.ancestors()
  assertEquals(chain.at(-1), 1)
  const procs = await linux.procs()
  assertEquals(procs.some((p) => p.pid === Deno.pid), true)
})
