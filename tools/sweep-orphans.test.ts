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

Deno.test(`still lists an orphan when USER is unset, as in a CI container`, async () => {
  await withOrphans(async (dir, spawned) => {
    const pid = await orphan(await dir(`lane`), ME)
    spawned.push(pid)
    const { stdout } = await new Deno.Command(`bash`, {
      args: [`-c`, `unset USER; exec bash "$1"`, `bash`, SCRIPT],
      env: { CLAUDE_CODE_SESSION_ID: ME },
      stdout: `piped`,
      stderr: `null`,
    }).output()
    assert(new TextDecoder().decode(stdout).split(`\n`).some((l) => l.startsWith(`${pid} `)))
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
  await withOrphans(async (dir) => {
    // An empty --under directory: if the refusal ever breaks, there is still nothing to kill.
    assertEquals((await sweep(`--all`, `--kill`, `--under`, await dir(`empty`))).code, 2)
  })
})

/** Whether a systemd user manager answers; `systemctl` itself may be missing. */
async function hasUserManager(): Promise<boolean> {
  try {
    return (await new Deno.Command(`systemctl`, {
      args: [`--user`, `show-environment`],
      stdout: `null`,
      stderr: `null`,
    }).output()).success
  } catch {
    return false
  }
}

// A CI container has no systemd user manager, so it cannot start a scope. Anywhere else a missing
// manager fails these tests instead of skipping them.
const noScopes = !(await hasUserManager()) && Boolean(Deno.env.get(`CI`))

/** Runs the sweep as session `ME` and returns the first column of each line and its exit code. */
async function sweepNames(...args: string[]): Promise<{ names: string[]; code: number }> {
  const { code, stdout } = await new Deno.Command(`bash`, {
    args: [SCRIPT, ...args],
    env: { CLAUDE_CODE_SESSION_ID: ME },
    stdout: `piped`,
    stderr: `null`,
  }).output()
  const names = new TextDecoder().decode(stdout).split(`\n`).filter(Boolean)
    .map((line) => line.split(` `)[0])
  return { names, code }
}

async function active(unit: string): Promise<boolean> {
  const { stdout } = await new Deno.Command(`systemctl`, {
    args: [`--user`, `is-active`, unit],
    stdout: `piped`,
  }).output()
  return new TextDecoder().decode(stdout).trim() === `active`
}

/**
 * Starts `sleep 120` in a `run-sweep-test-*.scope` user unit, the way `systemd-run --user --scope`
 * caps a test run, in `cwd` and tagged with `session`. The unit is stopped when the test ends.
 */
async function withScope(
  cwd: string,
  session: string,
  scopes: { unit: string; child: Deno.ChildProcess }[],
  command = [`sleep`, `120`],
  unit = `run-sweep-test-${crypto.randomUUID()}.scope`,
): Promise<string> {
  const child = new Deno.Command(`systemd-run`, {
    args: [`--user`, `--scope`, `--collect`, `--quiet`, `--unit`, unit, ...command],
    cwd,
    env: { CLAUDE_CODE_SESSION_ID: session },
    stdout: `null`,
    stderr: `null`,
  }).spawn()
  scopes.push({ unit, child })
  for (let i = 0; i < 50 && !(await active(unit)); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  assert(await active(unit), `the scope did not start`)
  return unit
}

/** Temp directories and scopes for one test, removed and stopped even when it fails. */
async function withScopes(
  body: (
    dir: (name: string) => Promise<string>,
    scopes: { unit: string; child: Deno.ChildProcess }[],
  ) => Promise<void>,
): Promise<void> {
  const scopes: { unit: string; child: Deno.ChildProcess }[] = []
  await withOrphans(async (dir) => {
    try {
      await body(dir, scopes)
    } finally {
      for (const { unit, child } of scopes) {
        await new Deno.Command(`systemctl`, { args: [`--user`, `stop`, unit], stderr: `null` })
          .output()
        await child.status
      }
    }
  })
}

Deno.test({
  name: `lists a stale scope of the current session with its age, CPU and command`,
  ignore: noScopes,
  fn: () =>
    withScopes(async (dir, scopes) => {
      const unit = await withScope(await dir(`lane`), ME, scopes)
      const { stdout } = await new Deno.Command(`bash`, {
        args: [SCRIPT, `--min-age`, `0`],
        env: { CLAUDE_CODE_SESSION_ID: ME },
        stdout: `piped`,
      }).output()
      const line = new TextDecoder().decode(stdout).split(`\n`).find((l) =>
        l.startsWith(`${unit} `)
      )
      assert(line, `the scope is not listed`)
      assert(/^\S+ [\d:-]+ [\d.]+ \S*sleep 120$/.test(line), line)
    }),
})

Deno.test({
  name: `does not list a scope younger than --min-age`,
  ignore: noScopes,
  fn: () =>
    withScopes(async (dir, scopes) => {
      const unit = await withScope(await dir(`lane`), ME, scopes)
      assert(!(await sweepNames()).names.includes(unit))
      assert(!(await sweepNames(`--min-age`, `600`)).names.includes(unit))
    }),
})

Deno.test({
  name: `hides another session's scope unless --all is given`,
  ignore: noScopes,
  fn: () =>
    withScopes(async (dir, scopes) => {
      const unit = await withScope(await dir(`lane`), SIBLING, scopes)
      assert(!(await sweepNames(`--min-age`, `0`)).names.includes(unit))
      assert((await sweepNames(`--all`, `--min-age`, `0`)).names.includes(unit))
    }),
})

Deno.test({
  name: `lists a scope without a session ID only with --all or --under`,
  ignore: noScopes,
  fn: () =>
    withScopes(async (dir, scopes) => {
      const lane = await dir(`lane`)
      // Started outside Claude Code, the way the owner or another harness would.
      const unit = await withScope(lane, ME, scopes, [
        `env`,
        `-u`,
        `CLAUDE_CODE_SESSION_ID`,
        `sleep`,
        `120`,
      ])
      assert(!(await sweepNames(`--min-age`, `0`)).names.includes(unit))
      assert((await sweepNames(`--all`, `--min-age`, `0`)).names.includes(unit))
      assert((await sweepNames(`--min-age`, `0`, `--under`, lane)).names.includes(unit))
    }),
})

Deno.test({
  name: `never lists its own scope or a scope holding one of its ancestors`,
  ignore: noScopes,
  fn: () =>
    withScopes(async (dir, scopes) => {
      const lane = await dir(`lane`)
      const out = join(lane, `out`)
      const inner = `run-sweep-test-${crypto.randomUUID()}.scope`
      // The outer scope holds `sh`, the sweep's parent; the inner scope holds the sweep itself.
      const outer = await withScope(lane, ME, scopes, [
        `sh`,
        `-c`,
        `systemd-run --user --scope --collect --quiet --unit "$1" bash "$2" --min-age 0 > "$3.tmp"; mv "$3.tmp" "$3"; sleep 120`,
        `sh`,
        inner,
        SCRIPT,
        out,
      ])
      for (let i = 0; i < 50 && !(await exists(out)); i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      const names = (await Deno.readTextFile(out)).split(`\n`).filter(Boolean)
        .map((line) => line.split(` `)[0])
      assert(!names.includes(inner), `the sweep listed its own scope`)
      assert(!names.includes(outer), `the sweep listed its parent's scope`)
    }),
})

Deno.test({
  name: `--kill stops the listed scope and no scope outside --under`,
  ignore: noScopes,
  fn: () =>
    withScopes(async (dir, scopes) => {
      const mine = await dir(`mine`)
      const inside = await withScope(mine, ME, scopes)
      const outside = await withScope(await dir(`theirs`), ME, scopes)
      const { names, code } = await sweepNames(`--kill`, `--min-age`, `0`, `--under`, mine)
      assertEquals(code, 0)
      assert(names.includes(inside))
      assert(!names.includes(outside), `a scope outside --under is listed`)
      assert(!(await active(inside)), `the listed scope still runs`)
      assert(await active(outside), `a scope outside --under was stopped`)
    }),
})

Deno.test(`rejects --min-age without a number of seconds`, async () => {
  assertEquals((await sweepNames(`--min-age`, `soon`)).code, 2)
  assertEquals((await sweepNames(`--min-age`)).code, 2)
})

Deno.test({
  name: `reads --min-age with a leading zero as decimal`,
  ignore: noScopes,
  fn: () =>
    withScopes(async (dir, scopes) => {
      // The age is compared only when a scope exists.
      await withScope(await dir(`lane`), ME, scopes)
      const { code, stdout, stderr } = await new Deno.Command(`bash`, {
        args: [SCRIPT, `--min-age`, `08`, `--under`, await dir(`empty`)],
        stdout: `piped`,
        stderr: `piped`,
      }).output()
      assertEquals(new TextDecoder().decode(stderr), ``)
      assertEquals(code, 0)
      assertEquals(new TextDecoder().decode(stdout), ``)
    }),
})
