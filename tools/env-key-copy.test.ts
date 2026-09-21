import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19"
import { join } from "jsr:@std/path@^1.0.0"
import { copyKey, report, type Roots, roots } from "./env-key-copy.ts"

const KEY = `AGE-SECRET-KEY-TEST-PLACEHOLDER\n`

async function write(path: string, text: string, mode = 0o600): Promise<void> {
  await Deno.mkdir(join(path, `..`), { recursive: true })
  await Deno.writeTextFile(path, text)
  await Deno.chmod(path, mode)
}

/**
 * A main checkout and a worktree as bare directories — no git needed for the copy itself.
 *
 * The source key is deliberately written world-readable. `Deno.copyFile` carries the
 * source's mode across, so a 0600 source would let the permission test pass even with the
 * `chmod` deleted.
 */
async function fixture(
  key: string | null = KEY,
): Promise<{ found: Roots; cleanup: () => Promise<void> }> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: `env-key-copy-` }))
  const found = { main: join(root, `main`), worktree: join(root, `wt`) }
  await Deno.mkdir(found.worktree, { recursive: true })
  if (key === null) await Deno.mkdir(found.main, { recursive: true })
  else await write(join(found.main, `.age`, `key.txt`), key, 0o644)
  return { found, cleanup: () => Deno.remove(root, { recursive: true }) }
}

const readKey = (dir: string) => Deno.readTextFile(join(dir, `.age`, `key.txt`))

Deno.test(`copies the key into a worktree that has none`, async () => {
  const { found, cleanup } = await fixture()
  try {
    assertEquals(await copyKey(found), { outcome: `copied`, files: [`key.txt`] })
    assertEquals(await readKey(found.worktree), KEY)
  } finally {
    await cleanup()
  }
})

Deno.test(`copied key is readable only by its owner`, async () => {
  const { found, cleanup } = await fixture()
  try {
    await copyKey(found)
    const { mode } = await Deno.stat(join(found.worktree, `.age`, `key.txt`))
    assertEquals((mode ?? 0) & 0o777, 0o600)
  } finally {
    await cleanup()
  }
})

Deno.test(`writes nothing on a second run`, async () => {
  const { found, cleanup } = await fixture()
  try {
    await copyKey(found)
    const before = (await Deno.stat(join(found.worktree, `.age`, `key.txt`))).mtime
    assertEquals(await copyKey(found), { outcome: `already-present`, files: [`key.txt`] })
    assertEquals((await Deno.stat(join(found.worktree, `.age`, `key.txt`))).mtime, before)
  } finally {
    await cleanup()
  }
})

Deno.test(`replaces a key that differs from the main checkout`, async () => {
  const { found, cleanup } = await fixture()
  try {
    await write(join(found.worktree, `.age`, `key.txt`), `AGE-SECRET-KEY-STALE\n`)
    assertEquals(await copyKey(found), { outcome: `copied`, files: [`key.txt`] })
    assertEquals(await readKey(found.worktree), KEY)
  } finally {
    await cleanup()
  }
})

Deno.test(`does nothing when the main checkout has no key`, async () => {
  const { found, cleanup } = await fixture(null)
  try {
    assertEquals(await copyKey(found), { outcome: `no-key`, files: [] })
    assertEquals(await Deno.stat(join(found.worktree, `.age`)).catch(() => null), null)
  } finally {
    await cleanup()
  }
})

Deno.test(`does nothing when run in the main checkout itself`, async () => {
  const { found, cleanup } = await fixture()
  try {
    const same = { main: found.main, worktree: found.main }
    assertEquals(await copyKey(same), { outcome: `same-checkout`, files: [] })
  } finally {
    await cleanup()
  }
})

Deno.test(`report never quotes the key`, async () => {
  const { found, cleanup } = await fixture()
  try {
    const line = report(await copyKey(found))
    assertEquals(line.includes(KEY.trim()), false)
    assert(line.includes(`key.txt`))
  } finally {
    await cleanup()
  }
})

Deno.test(`roots finds the main checkout from a linked worktree`, async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: `env-key-roots-` }))
  const main = join(root, `main`)
  const wt = join(root, `wt`)
  const env = { GIT_CONFIG_GLOBAL: `/dev/null`, GIT_CONFIG_SYSTEM: `/dev/null` }
  const sh = async (cwd: string, ...args: string[]) => {
    const out = await new Deno.Command(args[0], { args: args.slice(1), cwd, env, stderr: `piped` })
      .output()
    if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr))
  }
  try {
    await Deno.mkdir(main, { recursive: true })
    await sh(main, `git`, `init`, `-q`, `-b`, `main`)
    await sh(main, `git`, `config`, `user.email`, `test@example.com`)
    await sh(main, `git`, `config`, `user.name`, `Test`)
    await Deno.writeTextFile(join(main, `a.txt`), `a\n`)
    await sh(main, `git`, `add`, `.`)
    await sh(main, `git`, `commit`, `-q`, `-m`, `init`)
    await sh(main, `git`, `worktree`, `add`, `-q`, `-b`, `feat/x`, wt)

    assertEquals(await roots(wt), { main: await Deno.realPath(main), worktree: wt })
    assertEquals(await roots(main), { main: await Deno.realPath(main), worktree: main })
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test(`rejects outside a git repository`, async () => {
  const root = await Deno.makeTempDir({ prefix: `env-key-nogit-` })
  try {
    await assertRejects(() => roots(root), Error, `git rev-parse`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
