import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19"
import { join } from "node:path"
import { layoutFor } from "./worktree.ts"

const HOOK = join(import.meta.dirname ?? `.`, `worktree.ts`)

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const env = { GIT_CONFIG_GLOBAL: `/dev/null`, GIT_CONFIG_SYSTEM: `/dev/null` }
  const out = await new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    env,
    stderr: `piped`,
    stdout: `piped`,
  })
    .output()
  if (out.code !== 0) throw new Error(`${args.join(` `)}: ${new TextDecoder().decode(out.stderr)}`)
  return new TextDecoder().decode(out.stdout).trim()
}

async function hook(
  mode: string,
  input: Record<string, string>,
): Promise<{ code: number; lastLine: string }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [`run`, `--no-config`, `--no-lock`, `-A`, HOOK, mode],
    stdin: `piped`,
    stdout: `piped`,
    stderr: `piped`,
  }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(JSON.stringify(input)))
  await writer.close()
  const out = await child.output()
  const lines = new TextDecoder().decode(out.stdout).trim().split(`\n`)
  return { code: out.code, lastLine: lines.at(-1) ?? `` }
}

Deno.test(`layoutFor maps typed names to <type>/<slug>, the rest to wip/`, () => {
  assertEquals(layoutFor(`feat-login-form`, `/code/app`), {
    branch: `feat/login-form`,
    path: `/code/worktrees/app/feat/login-form`,
  })
  assertEquals(layoutFor(`fix/ws/reconnect`, `/code/app`).branch, `fix/ws-reconnect`)
  assertEquals(
    layoutFor(`bold-oak-a3f2`, `/code/app`).path,
    `/code/worktrees/app/wip/bold-oak-a3f2`,
  )
  assertEquals(layoutFor(`feature-x`, `/code/app`).branch, `wip/feature-x`) // "feature" is not a type
})

Deno.test(`layoutFor rejects names that could escape the worktrees dir`, () => {
  assertThrows(() => layoutFor(`../../etc`, `/code/app`))
  assertThrows(() => layoutFor(``, `/code/app`))
})

Deno.test(`create puts the worktree beside the repo and copies the age key; remove keeps dirty work`, async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: `worktree-hook-` }))
  try {
    const repo = join(root, `app`)
    await Deno.mkdir(join(repo, `.age`), { recursive: true })
    await sh(repo, `git`, `init`, `-q`, `-b`, `main`)
    await sh(repo, `git`, `config`, `user.email`, `test@example.com`)
    await sh(repo, `git`, `config`, `user.name`, `Test`)
    await Deno.writeTextFile(join(repo, `.gitignore`), `.age/\n`)
    await Deno.writeTextFile(join(repo, `.age`, `key.txt`), `not-a-real-key\n`)
    await sh(repo, `git`, `add`, `.`)
    await sh(repo, `git`, `commit`, `-q`, `-m`, `init`)

    const created = await hook(`create`, { cwd: repo, name: `feat-login` })
    const expected = join(root, `worktrees`, `app`, `feat`, `login`)
    assertEquals(created, { code: 0, lastLine: expected })
    assertEquals(await sh(expected, `git`, `branch`, `--show-current`), `feat/login`)
    assertEquals(await Deno.readTextFile(join(expected, `.age`, `key.txt`)), `not-a-real-key\n`)

    // same name again reopens instead of failing
    assertEquals((await hook(`create`, { cwd: expected, name: `feat-login` })).lastLine, expected)

    // dirty worktree survives a remove; clean one goes, with its merged branch
    await Deno.writeTextFile(join(expected, `wip.txt`), `work\n`)
    assertEquals((await hook(`remove`, { cwd: repo, worktree_path: expected })).code, 1)
    await Deno.remove(join(expected, `wip.txt`))
    await Deno.remove(join(expected, `.age`), { recursive: true })
    assertEquals((await hook(`remove`, { cwd: repo, worktree_path: expected })).code, 0)
    assertEquals(await Deno.lstat(expected).then(() => true, () => false), false)
    assertEquals(await sh(repo, `git`, `branch`, `--list`, `feat/login`), ``)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
