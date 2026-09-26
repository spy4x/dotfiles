import { assert, assertEquals } from "jsr:@std/assert@1.0.19"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./sweep-orphans.sh`, import.meta.url))
const ME = `sweep-test-me`
const SIBLING = `sweep-test-sibling`

/**
 * Starts a `sleep` that is orphaned the way a leaked agent process is: its parent exits, so it is
 * reparented to the user manager, and it stays in this test's cgroup. It runs in `cwd`, tagged
 * with `session` as its CLAUDE_CODE_SESSION_ID, and ends by itself after two minutes.
 */
async function orphan(cwd: string, session: string): Promise<number> {
  const pidFile = join(cwd, `pid`)
  const { success } = await new Deno.Command(`setsid`, {
    args: [`sh`, `-c`, `sleep 120 & echo $! > "$1"`, `sh`, pidFile],
    cwd,
    env: { CLAUDE_CODE_SESSION_ID: session },
    stdout: `null`,
    stderr: `null`,
  }).output()
  assert(success, `could not start the orphan`)
  return Number((await Deno.readTextFile(pidFile)).trim())
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

/** Runs the sweep as session `ME` and returns the PIDs it lists and its exit code. */
async function sweep(...args: string[]): Promise<{ pids: number[]; code: number }> {
  const { code, stdout } = await new Deno.Command(`bash`, {
    args: [SCRIPT, ...args],
    env: { CLAUDE_CODE_SESSION_ID: ME },
    stdout: `piped`,
    stderr: `null`,
  }).output()
  const pids = new TextDecoder().decode(stdout).split(`\n`).filter(Boolean)
    .map((line) => Number(line.trim().split(/\s+/)[0]))
  return { pids, code }
}

/** Temp directories and orphans for one test, removed and killed even when it fails. */
async function withOrphans(
  body: (dir: (name: string) => Promise<string>, spawned: number[]) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: `sweep-orphans-` }))
  const spawned: number[] = []
  const dir = async (name: string) => {
    const path = join(root, name)
    await Deno.mkdir(path)
    return path
  }
  try {
    await body(dir, spawned)
  } finally {
    for (const pid of spawned) {
      try {
        Deno.kill(pid, `SIGKILL`)
      } catch {
        // Already gone.
      }
    }
    await Deno.remove(root, { recursive: true })
  }
}

Deno.test(`lists an orphan of the current session`, async () => {
  await withOrphans(async (dir, spawned) => {
    const pid = await orphan(await dir(`lane`), ME)
    spawned.push(pid)
    assert((await sweep()).pids.includes(pid))
  })
})

Deno.test(`hides another session's orphan unless --all is given`, async () => {
  await withOrphans(async (dir, spawned) => {
    const pid = await orphan(await dir(`lane`), SIBLING)
    spawned.push(pid)
    assert(!(await sweep()).pids.includes(pid))
    assert((await sweep(`--all`)).pids.includes(pid))
  })
})

Deno.test(`--under keeps only orphans inside the given directories`, async () => {
  await withOrphans(async (dir, spawned) => {
    const mine = await dir(`mine`)
    const theirs = await dir(`theirs`)
    const inside = await orphan(mine, ME)
    const outside = await orphan(theirs, ME)
    spawned.push(inside, outside)
    const { pids } = await sweep(`--under`, mine)
    assert(pids.includes(inside))
    assert(!pids.includes(outside))
  })
})

Deno.test(`prints only one PID per line, in the first column`, async () => {
  await withOrphans(async (dir, spawned) => {
    const pid = await orphan(await dir(`lane`), ME)
    spawned.push(pid)
    const { stdout } = await new Deno.Command(`bash`, {
      args: [SCRIPT],
      env: { CLAUDE_CODE_SESSION_ID: ME },
      stdout: `piped`,
    }).output()
    const line = new TextDecoder().decode(stdout).split(`\n`).find((l) => l.startsWith(`${pid} `))
    assert(line, `the orphan is not listed`)
    // PID, elapsed time, CPU percent, then the command: no parent PID to mistake for a target.
    assert(/^\d+ [\d:-]+ [\d.]+ sleep 120$/.test(line), line)
  })
})

Deno.test(`--kill stops the listed orphans and nothing outside --under`, async () => {
  await withOrphans(async (dir, spawned) => {
    const mine = await dir(`mine`)
    const inside = await orphan(mine, ME)
    const outside = await orphan(await dir(`theirs`), ME)
    spawned.push(inside, outside)
    const { pids, code } = await sweep(`--kill`, `--under`, mine)
    assertEquals(code, 0)
    assertEquals(pids, [inside])
    await new Promise((r) => setTimeout(r, 200))
    assert(!(await exists(`/proc/${inside}`)), `the listed orphan still runs`)
    assert(await exists(`/proc/${outside}`), `an orphan outside --under was killed`)
  })
})

Deno.test(`never lists its own ancestors, even when they are orphans`, async () => {
  await withOrphans(async (dir, spawned) => {
    const lane = await dir(`lane`)
    const out = join(lane, `out`)
    // The outer sh exits at once, so the inner sh (the sweep's parent) is itself an orphan.
    const { success } = await new Deno.Command(`setsid`, {
      args: [
        `sh`,
        `-c`,
        `sh -c 'sleep 0.3; bash "$1" --under "$2" > "$3.tmp"; mv "$3.tmp" "$3"' sh "$1" "$2" "$3" & echo $! > "$2/pid"`,
        `sh`,
        SCRIPT,
        lane,
        out,
      ],
      cwd: lane,
      env: { CLAUDE_CODE_SESSION_ID: ME },
    }).output()
    assert(success)
    const parent = Number((await Deno.readTextFile(join(lane, `pid`))).trim())
    spawned.push(parent)
    for (let i = 0; i < 50 && !(await exists(out)); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const listed = (await Deno.readTextFile(out)).split(`\n`).filter(Boolean)
      .map((line) => Number(line.split(` `)[0]))
    assert(!listed.includes(parent), `the sweep listed its own parent`)
  })
})

Deno.test(`rejects an unknown flag`, async () => {
  assertEquals((await sweep(`--bogus`)).code, 2)
})

Deno.test(`refuses to kill other sessions' orphans`, async () => {
  assertEquals((await sweep(`--all`, `--kill`)).code, 2)
})
