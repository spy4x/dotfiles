import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19"
import { copy } from "jsr:@std/fs@^1.0.0/copy"
import { join } from "jsr:@std/path@^1.0.0"
import {
  apply,
  applyMigration,
  detect,
  type Env,
  loadConfig,
  mergeSettings,
  type Op,
  plan,
  planMigration,
  resolveHome,
  type Target,
} from "./engine.ts"
import { loadSource, type Source } from "./source.ts"

const FIXTURES = join(import.meta.dirname!, `fixtures`)

async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(join(path, `..`), { recursive: true })
  await Deno.writeTextFile(path, text)
}

function envOf(vars: Record<string, string>): Env {
  return { get: (key) => vars[key] }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const { code, stderr } = await new Deno.Command(`git`, { args, cwd, stderr: `piped` }).output()
  if (code !== 0) throw new Error(`git ${args.join(` `)}: ${new TextDecoder().decode(stderr)}`)
}

interface Fixture {
  root: string
  home: string
  source: Source
  targets: Target[]
  cleanup: () => Promise<void>
}

/** The fixture source against an empty home in a temp dir, so a test never touches real config. */
async function fixture(): Promise<Fixture> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: `ai-harnesses-` }))
  const home = join(root, `home`)
  await Deno.mkdir(home)
  const config = await loadConfig(join(FIXTURES, `config.jsonc`))
  return {
    root,
    home,
    source: await loadSource(join(FIXTURES, `source`)),
    targets: await detect(config, envOf({ HOME: home })),
    cleanup: () => Deno.remove(root, { recursive: true }),
  }
}

const pending = (ops: Op[]) => ops.filter((op) => op.action !== `skip`)

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

Deno.test(`resolveHome prefers a set variable, then falls back to a path under HOME`, () => {
  assertEquals(resolveHome(`$DSH_HOME|~/.dsh`, envOf({ HOME: `/h`, DSH_HOME: `/x/dsh` })), `/x/dsh`)
  assertEquals(resolveHome(`$DSH_HOME|~/.dsh`, envOf({ HOME: `/h` })), `/h/.dsh`)
})

Deno.test(`auto detection renders only the harnesses installed on this machine`, async () => {
  const { home, cleanup } = await fixture()
  try {
    const config = await loadConfig(join(FIXTURES, `config.jsonc`))
    for (const harness of Object.values(config.harnesses)) harness.enabled = `auto`
    await Deno.mkdir(join(home, `.claude`))
    const bin = join(home, `bin`)
    await write(join(bin, `dsh`), ``)
    const found = await detect(config, envOf({ HOME: home, PATH: bin }))
    assertEquals(found.map((target) => target.name), [`claude`, `dsh`])
  } finally {
    await cleanup()
  }
})

Deno.test(`apply is idempotent and keeps settings keys the app saved`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    await write(join(home, `.claude`, `settings.json`), JSON.stringify({ theme: `dark-ansi` }))
    await write(join(home, `.dsh`, `settings.yaml`), `ui-conversation:\n  busyEnter: steer\n`)
    await apply(await plan(source, targets))

    assertEquals(pending(await plan(source, targets)), [])
    assertEquals(
      await Deno.readTextFile(join(home, `.claude`, `CLAUDE.md`)),
      `# Rules\n\nBe brief.\n`,
    )
    assertEquals(JSON.parse(await Deno.readTextFile(join(home, `.claude`, `settings.json`))), {
      theme: `dark-ansi`,
      permissions: { ask: [`Bash(rm *)`] },
    })
    assertEquals(
      await Deno.readTextFile(join(home, `.dsh`, `settings.yaml`)),
      `ui-conversation:\n  busyEnter: steer\npermission:\n  defaultPreset: danger-full-access\n`,
    )
  } finally {
    await cleanup()
  }
})

Deno.test(`a settings file that does not exist yet is written as tracked, comments included`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    await apply(await plan(source, targets))
    const live = await Deno.readTextFile(join(home, `.dsh`, `settings.yaml`))
    assertEquals(live.startsWith(`# comment kept on first write\n`), true)
  } finally {
    await cleanup()
  }
})

Deno.test(`a file removed from the source is removed from the home; foreign files stay`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    await apply(await plan(source, targets))
    await write(join(home, `.claude`, `skills`, `mine`, `SKILL.md`), `hand-made\n`)
    const fewer = { ...source, skills: source.skills.filter((s) => s.meta.name !== `lookup`) }

    const ops = await plan(fewer, targets)
    assertEquals(ops.filter((op) => op.action === `remove`).map((op) => op.label), [
      `claude skills/lookup/SKILL.md`,
      `opencode skills/lookup/SKILL.md`,
      `dsh skills/lookup/SKILL.md`,
    ])
    await apply(ops)
    assertEquals(
      await Deno.lstat(join(home, `.claude`, `skills`, `lookup`, `SKILL.md`)).catch(() => null),
      null,
    )
    assertEquals(
      await Deno.readTextFile(join(home, `.claude`, `skills`, `mine`, `SKILL.md`)),
      `hand-made\n`,
    )
    assertEquals(pending(await plan(fewer, targets)), [])
  } finally {
    await cleanup()
  }
})

Deno.test(`drift in a copied file or in a tracked settings key is detected`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    await apply(await plan(source, targets))
    await Deno.writeTextFile(join(home, `.config`, `opencode`, `agents`, `checker.md`), `edited\n`)
    await write(
      join(home, `.claude`, `settings.json`),
      JSON.stringify({ permissions: { ask: [] } }),
    )
    assertEquals(pending(await plan(source, targets)).map((op) => op.reason), [
      `tracked keys differ`,
      `content drift`,
    ])
  } finally {
    await cleanup()
  }
})

Deno.test(`a symlinked CLAUDE.md is replaced by a real file, its target untouched`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    const elsewhere = join(home, `elsewhere.md`)
    await write(elsewhere, `old\n`)
    await Deno.mkdir(join(home, `.claude`))
    await Deno.symlink(elsewhere, join(home, `.claude`, `CLAUDE.md`))
    await apply(await plan(source, targets))
    assertEquals((await Deno.lstat(join(home, `.claude`, `CLAUDE.md`))).isSymlink, false)
    assertEquals(await Deno.readTextFile(elsewhere), `old\n`)
  } finally {
    await cleanup()
  }
})

Deno.test(`a home that resolves into a git checkout is never written, and --check fails`, async () => {
  const { root, home, source, targets, cleanup } = await fixture()
  try {
    // ~/.config/opencode -> <checkout>/.config/opencode, the layout before `migrate`
    const checkout = join(root, `checkout`)
    await write(join(checkout, `.git`, `HEAD`), `ref: refs/heads/main\n`)
    await Deno.mkdir(join(checkout, `.config`, `opencode`), { recursive: true })
    await Deno.mkdir(join(home, `.config`))
    await Deno.symlink(join(checkout, `.config`, `opencode`), join(home, `.config`, `opencode`))

    const ops = await plan(source, targets)
    const opencode = ops.filter((op) => op.label.startsWith(`opencode `))
    assertEquals(opencode.every((op) => op.action === `blocked`), true)
    assertEquals(pending(ops).length >= opencode.length, true) // blocked counts as out of sync
    await apply(ops)
    assertEquals([...Deno.readDirSync(join(checkout, `.config`, `opencode`))], [])
  } finally {
    await cleanup()
  }
})

Deno.test(`refuses to overwrite a live settings file it cannot parse`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    await write(join(home, `.claude`, `settings.json`), `{ not json`)
    await assertRejects(() => plan(source, targets), Error, `does not parse`)
  } finally {
    await cleanup()
  }
})

Deno.test(`migrate moves runtime leftovers off a symlink into a real home`, async () => {
  const { root, home, cleanup } = await fixture()
  try {
    const checkout = join(root, `checkout`)
    const old = join(checkout, `.dsh`)
    await write(join(old, `sessions`, `one.json`), `{}\n`)
    await write(join(old, `.credentials.yaml`), `key: <REDACTED:TOKEN>\n`)
    await write(join(old, `AGENTS.md`), `tracked\n`)
    await git(checkout, `init`, `-q`)
    await git(checkout, `add`, `.dsh/AGENTS.md`)
    await Deno.symlink(old, join(home, `.dsh`))
    const config = await loadConfig(join(FIXTURES, `config.jsonc`))
    const env = envOf({ HOME: home })

    await assertRejects(() => planMigration(config, env), Error, `tracked file`)

    await git(checkout, `rm`, `-q`, `--cached`, `.dsh/AGENTS.md`)
    await Deno.remove(join(old, `AGENTS.md`))
    const migrations = await planMigration(config, env)
    assertEquals(migrations.map((m) => [m.name, m.entries]), [
      [`dsh`, [`.credentials.yaml`, `sessions`]],
    ])
    await applyMigration(migrations)

    assertEquals((await Deno.lstat(join(home, `.dsh`))).isDirectory, true)
    assertEquals(await Deno.readTextFile(join(home, `.dsh`, `sessions`, `one.json`)), `{}\n`)
    assertEquals(await Deno.lstat(old).catch(() => null), null)
    assertEquals(await planMigration(config, env), [])
  } finally {
    await cleanup()
  }
})

Deno.test(`--apply from a linked worktree writes nothing unless forced`, async () => {
  const { root, home, cleanup } = await fixture()
  try {
    // A copy of the code with the fixture source, inside a fake linked worktree.
    const repo = join(root, `repo`)
    const dir = join(repo, `ai-harnesses`)
    await copy(join(FIXTURES, `source`), dir)
    await copy(join(FIXTURES, `config.jsonc`), join(dir, `config.jsonc`))
    for (const file of [`manage.ts`, `engine.ts`, `schema.ts`, `source.ts`]) {
      await copy(join(import.meta.dirname!, file), join(dir, file))
    }
    await copy(join(import.meta.dirname!, `adapters`), join(dir, `adapters`))
    await write(join(repo, `.git`), `gitdir: /nowhere\n`)

    const run = (...flags: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: [`run`, `-A`, join(dir, `manage.ts`), ...flags],
        clearEnv: true,
        env: {
          HOME: home,
          PATH: Deno.env.get(`PATH`) ?? ``,
          DENO_DIR: Deno.env.get(`DENO_DIR`) ?? ``,
        },
        stdout: `piped`,
        stderr: `piped`,
      }).output()

    const guarded = await run(`--apply`)
    const out = new TextDecoder().decode(guarded.stdout)
    assertEquals(guarded.code, 0, new TextDecoder().decode(guarded.stderr))
    assertEquals(out.includes(`[WITHHELD] claude CLAUDE.md`), true)
    assertEquals(await Deno.lstat(join(home, `.claude`)).catch(() => null), null)

    await run(`--apply`, `--from-worktree`)
    assertEquals(
      await Deno.readTextFile(join(home, `.claude`, `CLAUDE.md`)),
      `# Rules\n\nBe brief.\n`,
    )
  } finally {
    await cleanup()
  }
})
