import { assert, assertEquals } from "jsr:@std/assert@1.0.19"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./agent-backup.sh`, import.meta.url))
const PASSWORD = `test-password`

/** A state folder, a repository path and a password file in one temp folder, removed afterwards. */
async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: `agent-backup-` })
  try {
    await body(root)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

/** The script's environment, with an env file that holds BACKUPS_PASSWORD. */
async function envOf(root: string): Promise<Record<string, string>> {
  const envFile = join(root, `.env.root`)
  await Deno.writeTextFile(envFile, `OTHER=x\nBACKUPS_PASSWORD=${PASSWORD}\n`)
  const state = join(root, `state`)
  await Deno.mkdir(state, { recursive: true })
  return { AGENT_RUN_HOME: state, AGENT_BACKUP_ENV: envFile, RESTIC_REPOSITORY: join(root, `repo`) }
}

async function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const out = await new Deno.Command(cmd, { args, env, stdout: `piped`, stderr: `piped` }).output()
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) }
}

async function sql(db: string, ...statements: string[]): Promise<string> {
  const result = await run(`sqlite3`, [`-batch`, `-bail`, db, ...statements])
  assertEquals(result.code, 0, result.stderr)
  return result.stdout.trim()
}

/** A WAL database with `rows` rows in table `t`, as agent-run.ts opens it. */
async function makeDb(state: string, rows: number): Promise<string> {
  const db = join(state, `runs.sqlite`)
  await sql(
    db,
    `PRAGMA journal_mode = WAL`,
    `CREATE TABLE t (n INTEGER NOT NULL, body TEXT NOT NULL)`,
    `WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${rows})
     INSERT INTO t SELECT n, 'prompt text ' || n FROM c`,
  )
  return db
}

async function names(dir: string): Promise<string[]> {
  return (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort()
}

const mode = async (path: string) => (await Deno.stat(path)).mode! & 0o777

Deno.test(`sqlite3 and restic are installed, so the backup tests below cannot pass by skipping`, async () => {
  assertEquals((await run(`sqlite3`, [`-version`])).code, 0)
  assertEquals((await run(`restic`, [`version`])).code, 0)
})

Deno.test(`backs up a database another connection is writing to, without breaking it`, async () => {
  await withRoot(async (root) => {
    const env = await envOf(root)
    const db = await makeDb(env.AGENT_RUN_HOME, 500)

    // One open connection keeps inserting while the backup runs.
    const writer = new Deno.Command(`sqlite3`, { args: [`-batch`, db], stdin: `piped` }).spawn()
    const input = writer.stdin.getWriter()
    const encoder = new TextEncoder()
    await input.write(encoder.encode(`.timeout 10000\n`))
    let written = 0
    let stop = false
    const writing = (async () => {
      while (!stop) {
        written++
        await input.write(encoder.encode(`INSERT INTO t VALUES (${500 + written}, 'live');\n`))
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    })()
    const backup = await run(`bash`, [SCRIPT], env)
    stop = true
    await writing
    await input.close()
    assertEquals((await writer.status).code, 0, `the writing connection failed`)
    assertEquals(backup.code, 0, backup.stderr)
    assert(written > 0, `the writer wrote nothing during the backup`)

    // The live database still opens, passes its check and holds every row.
    assertEquals(await sql(db, `PRAGMA integrity_check`), `ok`)
    assertEquals(await sql(db, `SELECT count(*) FROM t`), `${500 + written}`)

    const snapshots = join(env.AGENT_RUN_HOME, `snapshots`)
    const files = await names(snapshots)
    assertEquals(files.length, 1, `snapshots: ${files}`)
    assert(/^runs-\d{4}-\d\d-\d\dT\d{6}\.sqlite$/.test(files[0]), files[0])
    const snapshot = join(snapshots, files[0])
    assertEquals(await mode(snapshots), 0o700)
    assertEquals(await mode(snapshot), 0o600)
    assertEquals(await sql(snapshot, `PRAGMA integrity_check`), `ok`)
    assert(Number(await sql(snapshot, `SELECT count(*) FROM t`)) >= 500)

    // The copy in the encrypted repository is the same database, readable with the password.
    const opened = { ...env, RESTIC_PASSWORD: PASSWORD }
    const dumped = join(root, `dumped.sqlite`)
    const dump = await run(`restic`, [`dump`, `--target`, dumped, `latest`, snapshot], opened)
    assertEquals(dump.code, 0, dump.stderr)
    assertEquals(await sql(dumped, `PRAGMA integrity_check`), `ok`)
    const listed = (await run(`restic`, [`ls`, `latest`], opened)).stdout
    assert(!listed.includes(`runs.sqlite`), `the live database is in the backup`)
  })
})

Deno.test(`keeps the three newest snapshots on disk and leaves other files alone`, async () => {
  await withRoot(async (root) => {
    const env = await envOf(root)
    await makeDb(env.AGENT_RUN_HOME, 3)
    const snapshots = join(env.AGENT_RUN_HOME, `snapshots`)
    await Deno.mkdir(snapshots)
    const old = [1, 2, 3, 4].map((d) => `runs-2020-01-0${d}T000000.sqlite`)
    for (const name of [...old, `notes.txt`]) await Deno.writeTextFile(join(snapshots, name), `x`)

    const backup = await run(`bash`, [SCRIPT], env)
    assertEquals(backup.code, 0, backup.stderr)
    const left = await names(snapshots)
    assertEquals(left.length, 4, `left: ${left}`)
    assertEquals(left.slice(0, 3), [`notes.txt`, old[2], old[3]])
    assert(left[3].startsWith(`runs-20`) && left[3] > old[3], left[3])
  })
})

Deno.test(`a second run on the same day backs up again`, async () => {
  await withRoot(async (root) => {
    const env = await envOf(root)
    await makeDb(env.AGENT_RUN_HOME, 3)
    assertEquals((await run(`bash`, [SCRIPT], env)).code, 0)
    const second = await run(`bash`, [SCRIPT], env)
    assertEquals(second.code, 0, second.stderr)
    const opened = { ...env, RESTIC_PASSWORD: PASSWORD }
    const listed = await run(`restic`, [`snapshots`, `--json`], opened)
    assertEquals(JSON.parse(listed.stdout).length, 2)
  })
})

Deno.test(`refuses to run, and writes nothing, without BACKUPS_PASSWORD`, async () => {
  await withRoot(async (root) => {
    const env = await envOf(root)
    await makeDb(env.AGENT_RUN_HOME, 3)
    await Deno.writeTextFile(env.AGENT_BACKUP_ENV, `OTHER=x\nBACKUPS_PASSWORD=\n`)
    const result = await run(`bash`, [SCRIPT], env)
    assertEquals(result.code, 1)
    assert(result.stderr.includes(`no BACKUPS_PASSWORD`), result.stderr)
    assertEquals(await Deno.stat(env.RESTIC_REPOSITORY).catch(() => null), null)
    assertEquals(await names(env.AGENT_RUN_HOME), [`runs.sqlite`])
  })
})

Deno.test(`exits cleanly with nothing to back up when there is no database`, async () => {
  await withRoot(async (root) => {
    const env = await envOf(root)
    const result = await run(`bash`, [SCRIPT], env)
    assertEquals(result.code, 0, result.stderr)
    assert(result.stdout.includes(`nothing to back up`), result.stdout)
    assertEquals(await names(env.AGENT_RUN_HOME), [])
    assertEquals(await Deno.stat(env.RESTIC_REPOSITORY).catch(() => null), null)
  })
})

Deno.test(`a snapshot that fails its integrity check fails the run and is deleted`, async () => {
  await withRoot(async (root) => {
    const env = await envOf(root)
    await makeDb(env.AGENT_RUN_HOME, 3)
    // A sqlite3 on PATH that makes real copies but reports every integrity check as failed.
    const real = (await run(`bash`, [`-c`, `command -v sqlite3`])).stdout.trim()
    const bin = join(root, `bin`)
    await Deno.mkdir(bin)
    await Deno.writeTextFile(
      join(bin, `sqlite3`),
      `#!/usr/bin/env bash\ncase "$*" in *integrity_check*) echo "page 2 is never used" ;;\n` +
        `*) exec ${real} "$@" ;;\nesac\n`,
    )
    await Deno.chmod(join(bin, `sqlite3`), 0o755)
    const result = await run(`bash`, [SCRIPT], { ...env, PATH: `${bin}:${Deno.env.get(`PATH`)}` })
    assertEquals(result.code, 1)
    assert(result.stderr.includes(`integrity check`), result.stderr)
    assertEquals(await names(join(env.AGENT_RUN_HOME, `snapshots`)), [])
    assertEquals(await Deno.stat(env.RESTIC_REPOSITORY).catch(() => null), null)
  })
})

Deno.test(`refuses an unknown argument instead of backing up`, async () => {
  await withRoot(async (root) => {
    const env = await envOf(root)
    await makeDb(env.AGENT_RUN_HOME, 3)
    assertEquals((await run(`bash`, [SCRIPT, `--now`], env)).code, 2)
    assertEquals(await Deno.stat(env.RESTIC_REPOSITORY).catch(() => null), null)
  })
})
