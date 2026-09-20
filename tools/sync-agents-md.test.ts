import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19"
import { join } from "jsr:@std/path@^1.0.0"
import { apply, mergeSettings, partitionByRepo, type Paths, plan } from "./sync-agents-md.ts"

async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(join(path, `..`), { recursive: true })
  await Deno.writeTextFile(path, text)
}

/** A throwaway "repo" plus an empty home, so a test never touches the real `~/.claude`. */
async function fixture(): Promise<{ paths: Paths; cleanup: () => Promise<void> }> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: `sync-agents-` }))
  const repoRoot = join(root, `repo`)
  const home = join(root, `home`)
  await write(join(repoRoot, `.config`, `opencode`, `AGENTS.md`), `# rules\n`)
  await write(join(repoRoot, `.claude`, `agents`, `reviewer.md`), `reviewer\n`)
  await write(join(repoRoot, `.claude`, `skills`, `audit`, `SKILL.md`), `audit\n`)
  await write(join(repoRoot, `.claude`, `hooks`, `guard.ts`), `// hook\n`)
  await write(join(repoRoot, `.claude`, `hooks`, `guard.test.ts`), `// test\n`)
  await write(
    join(repoRoot, `.claude`, `settings.json`),
    JSON.stringify({ permissions: { ask: [`Bash(x *)`] } }),
  )
  const paths = { repoRoot, home, dshHome: join(home, `dsh`), claudeHome: join(home, `.claude`) }
  return { paths, cleanup: () => Deno.remove(root, { recursive: true }) }
}

const pending = (ops: { action: string }[]) => ops.filter((op) => op.action !== `skip`).length

Deno.test(`mergeSettings owns tracked keys one level deep and keeps the rest`, () => {
  const live = {
    theme: `dark`,
    permissions: { allow: [`Bash(ls *)`], ask: [`old`] },
    hooks: { Stop: [1] },
  }
  const tracked = {
    permissions: { ask: [`new`] },
    hooks: { PreToolUse: [2] },
    attribution: { commit: `` },
  }
  assertEquals(mergeSettings(live, tracked), {
    theme: `dark`,
    permissions: { allow: [`Bash(ls *)`], ask: [`new`] },
    hooks: { Stop: [1], PreToolUse: [2] },
    attribution: { commit: `` },
  })
  assertEquals(live.permissions.ask, [`old`]) // input not mutated
})

Deno.test(`apply is idempotent, skips test files, preserves untracked live settings`, async () => {
  const { paths, cleanup } = await fixture()
  try {
    await write(join(paths.claudeHome, `settings.json`), JSON.stringify({ theme: `dark-ansi` }))
    await apply(await plan(paths))

    assertEquals(pending(await plan(paths)), 0)
    assertEquals(await Deno.readTextFile(join(paths.claudeHome, `CLAUDE.md`)), `# rules\n`)
    assertEquals(await Deno.readTextFile(join(paths.dshHome, `AGENTS.md`)), `# rules\n`)
    assertEquals(
      await Deno.lstat(join(paths.claudeHome, `hooks`, `guard.test.ts`)).catch(() => null),
      null,
    )
    assertEquals(JSON.parse(await Deno.readTextFile(join(paths.claudeHome, `settings.json`))), {
      theme: `dark-ansi`,
      permissions: { ask: [`Bash(x *)`] },
    })
  } finally {
    await cleanup()
  }
})

Deno.test(`a file removed from the repo is removed from the runtime; foreign files are left alone`, async () => {
  const { paths, cleanup } = await fixture()
  try {
    await apply(await plan(paths))
    await write(join(paths.claudeHome, `skills`, `mine`, `SKILL.md`), `hand-made\n`)
    await Deno.remove(join(paths.repoRoot, `.claude`, `skills`, `audit`), { recursive: true })

    const ops = await plan(paths)
    assertEquals(ops.filter((op) => op.action === `remove`).map((op) => op.label), [
      `Claude skills/audit/SKILL.md`,
    ])
    await apply(ops)
    assertEquals(
      await Deno.lstat(join(paths.claudeHome, `skills`, `audit`, `SKILL.md`)).catch(() => null),
      null,
    )
    assertEquals(
      await Deno.readTextFile(join(paths.claudeHome, `skills`, `mine`, `SKILL.md`)),
      `hand-made\n`,
    )
    assertEquals(pending(await plan(paths)), 0)
  } finally {
    await cleanup()
  }
})

Deno.test(`drift in a runtime copy or a tracked settings key is detected`, async () => {
  const { paths, cleanup } = await fixture()
  try {
    await apply(await plan(paths))
    await Deno.writeTextFile(join(paths.claudeHome, `agents`, `reviewer.md`), `edited in place\n`)
    await write(
      join(paths.claudeHome, `settings.json`),
      JSON.stringify({ permissions: { ask: [] } }),
    )
    assertEquals(pending(await plan(paths)), 2)
  } finally {
    await cleanup()
  }
})

Deno.test(`a symlinked CLAUDE.md is replaced by a real file, its target untouched`, async () => {
  const { paths, cleanup } = await fixture()
  try {
    const elsewhere = join(paths.home, `elsewhere.md`)
    await write(elsewhere, `old\n`)
    await Deno.mkdir(paths.claudeHome, { recursive: true })
    await Deno.symlink(elsewhere, join(paths.claudeHome, `CLAUDE.md`))
    await apply(await plan(paths))
    assertEquals((await Deno.lstat(join(paths.claudeHome, `CLAUDE.md`))).isSymlink, false)
    assertEquals(await Deno.readTextFile(elsewhere), `old\n`)
  } finally {
    await cleanup()
  }
})

Deno.test(`a target that resolves into another git checkout is never written`, async () => {
  const { paths, cleanup } = await fixture()
  try {
    // ~/.config/opencode -> <other checkout>/.config/opencode, as on a real machine
    const other = join(paths.home, `other-checkout`)
    await write(join(other, `.git`, `HEAD`), `ref: refs/heads/main\n`)
    await write(join(other, `.config`, `opencode`, `AGENTS.md`), `main branch text\n`)
    await Deno.mkdir(join(paths.home, `.config`), { recursive: true })
    await Deno.symlink(join(other, `.config`, `opencode`), join(paths.home, `.config`, `opencode`))

    await apply(await plan(paths))
    assertEquals(
      await Deno.readTextFile(join(other, `.config`, `opencode`, `AGENTS.md`)),
      `main branch text\n`,
    )
  } finally {
    await cleanup()
  }
})

Deno.test(`refuses to overwrite a live settings.json it cannot parse`, async () => {
  const { paths, cleanup } = await fixture()
  try {
    await write(join(paths.claudeHome, `settings.json`), `{ not json`)
    await assertRejects(() => plan(paths), Error, `not valid JSON`)
  } finally {
    await cleanup()
  }
})

Deno.test(`partitionByRepo separates tracked copies from machine runtime config`, async () => {
  const { paths, cleanup } = await fixture()
  try {
    const { inRepo, runtime } = partitionByRepo(await plan(paths), paths.repoRoot)
    assertEquals(inRepo.map((op) => op.label), [`Repo-local .dsh/AGENTS.md (layering override)`])
    assertEquals(runtime.some((op) => op.path === join(paths.claudeHome, `settings.json`)), true)
    assertEquals(runtime.every((op) => !op.path.startsWith(paths.repoRoot)), true)
  } finally {
    await cleanup()
  }
})

Deno.test(`--apply from a linked worktree leaves the runtime config alone unless forced`, async () => {
  const { paths, cleanup } = await fixture()
  try {
    // Make the fixture look like a linked worktree and run a copy of the script from inside it,
    // with HOME, DSH_HOME and CLAUDE_CONFIG_DIR all pointed into the temp dir.
    await write(join(paths.repoRoot, `.git`), `gitdir: /nowhere\n`)
    const script = join(paths.repoRoot, `tools`, `sync-agents-md.ts`)
    await write(
      script,
      await Deno.readTextFile(new URL(import.meta.resolve(`./sync-agents-md.ts`))),
    )
    const run = (...flags: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: [`run`, `-A`, script, ...flags],
        clearEnv: true,
        env: {
          HOME: paths.home,
          DSH_HOME: paths.dshHome,
          CLAUDE_CONFIG_DIR: paths.claudeHome,
          PATH: Deno.env.get(`PATH`) ?? ``,
        },
        stdout: `piped`,
        stderr: `piped`,
      }).output()

    const guarded = new TextDecoder().decode((await run(`--apply`)).stdout)
    assertEquals(guarded.includes(`[WITHHELD] Claude settings.json`), true)
    assertEquals(await Deno.lstat(paths.claudeHome).catch(() => null), null)
    assertEquals(await Deno.readTextFile(join(paths.repoRoot, `.dsh`, `AGENTS.md`)), `# rules\n`)

    await run(`--apply`, `--from-worktree`)
    assertEquals(await Deno.readTextFile(join(paths.claudeHome, `CLAUDE.md`)), `# rules\n`)
  } finally {
    await cleanup()
  }
})
