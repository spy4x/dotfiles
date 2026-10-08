import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19"
import { copy } from "jsr:@std/fs@^1.0.0/copy"
import { join } from "jsr:@std/path@^1.0.0"
import {
  apply,
  detect,
  type Env,
  loadConfig,
  mergeSettings,
  type Op,
  plan,
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

Deno.test(`refuses to overwrite a live settings file it cannot parse`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    await write(join(home, `.claude`, `settings.json`), `{ not json`)
    await assertRejects(() => plan(source, targets), Error, `does not parse`)
  } finally {
    await cleanup()
  }
})

Deno.test(`the CLI applies from a main checkout, refuses in a linked worktree, and checks`, async () => {
  const { root, home, cleanup } = await fixture()
  try {
    // A copy of the code with the fixture source, inside a fake checkout.
    const repo = join(root, `repo`)
    const dir = join(repo, `ai-harnesses`)
    await copy(join(FIXTURES, `source`), dir)
    await copy(join(FIXTURES, `config.jsonc`), join(dir, `config.jsonc`))
    for (const file of [`manage.ts`, `engine.ts`, `schema.ts`, `source.ts`]) {
      await copy(join(import.meta.dirname!, file), join(dir, file))
    }
    await copy(join(import.meta.dirname!, `adapters`), join(dir, `adapters`))
    // The scripts import the shared libraries through the import map of the repo root.
    await copy(join(import.meta.dirname!, `..`, `deno.jsonc`), join(repo, `deno.jsonc`))

    const run = async (...flags: string[]) => {
      const { code } = await new Deno.Command(Deno.execPath(), {
        args: [`run`, `-A`, join(dir, `manage.ts`), ...flags],
        clearEnv: true,
        env: {
          HOME: home,
          PATH: Deno.env.get(`PATH`) ?? ``,
          DENO_DIR: Deno.env.get(`DENO_DIR`) ?? ``,
        },
        stdout: `null`,
        stderr: `null`,
      }).output()
      return code
    }

    await write(join(repo, `.git`), `gitdir: /nowhere\n`) // a linked worktree
    assertEquals(await run(), 1)
    assertEquals(await Deno.lstat(join(home, `.claude`)).catch(() => null), null)
    assertEquals(await run(`--check`), 1) // checking from a worktree is allowed, and finds drift

    await Deno.remove(join(repo, `.git`))
    await Deno.mkdir(join(repo, `.git`)) // the main checkout
    assertEquals(await run(), 0)
    assertEquals(
      await Deno.readTextFile(join(home, `.claude`, `CLAUDE.md`)),
      `# Rules\n\nBe brief.\n`,
    )
    assertEquals(await run(`--check`), 0)
  } finally {
    await cleanup()
  }
})

const CLAUDE_JSON = (home: string) => join(home, `.claude.json`)

Deno.test(`resolveHome appends the rest of a $VAR/path alternative to the variable`, () => {
  const spec = `$CLAUDE_CONFIG_DIR/.claude.json|~/.claude.json`
  assertEquals(resolveHome(spec, envOf({ HOME: `/h`, CLAUDE_CONFIG_DIR: `/c` })), `/c/.claude.json`)
  assertEquals(resolveHome(spec, envOf({ HOME: `/h` })), `/h/.claude.json`)
})

Deno.test(`MCP servers are added to ~/.claude.json and the servers already there are kept`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    await write(
      CLAUDE_JSON(home),
      JSON.stringify({
        userID: `abc`,
        mcpServers: { mine: { type: `stdio`, command: `mine`, args: [], env: {} } },
      }),
    )
    await apply(await plan(source, targets))
    const live = JSON.parse(await Deno.readTextFile(CLAUDE_JSON(home)))
    assertEquals(live.userID, `abc`)
    assertEquals(live.mcpServers, {
      mine: { type: `stdio`, command: `mine`, args: [], env: {} },
      lookup: {
        type: `stdio`,
        command: join(home, `bin`, `lookup`),
        args: [`--stdio`],
        env: { TOKEN_FILE: join(home, `token`) },
      },
    })
    assertEquals(pending(await plan(source, targets)), [])
  } finally {
    await cleanup()
  }
})

Deno.test(`MCP servers go to OpenCode with ~ expanded, and a disabled server stays off`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    await apply(await plan(source, targets))
    const live = JSON.parse(
      await Deno.readTextFile(join(home, `.config`, `opencode`, `opencode.json`)),
    )
    assertEquals(live.model, `some/model`)
    assertEquals(live.mcp.lookup.command, [join(home, `bin`, `lookup`), `--stdio`])
    assertEquals(live.mcp.paused.enabled, false)
  } finally {
    await cleanup()
  }
})

Deno.test(`a ~/.claude.json saved after the plan is not overwritten when the plan is applied`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    await write(CLAUDE_JSON(home), JSON.stringify({ numStartups: 1 }))
    const ops = await plan(source, targets)
    // A running Claude Code saves while the plan waits.
    await write(CLAUDE_JSON(home), JSON.stringify({ numStartups: 2 }))
    await apply(ops)
    const live = JSON.parse(await Deno.readTextFile(CLAUDE_JSON(home)))
    assertEquals(live.numStartups, 2)
    assertEquals(Object.keys(live.mcpServers), [`lookup`])
  } finally {
    await cleanup()
  }
})

Deno.test(`~/.claude.json keeps its permissions and leaves no temp file behind`, async () => {
  const { home, source, targets, cleanup } = await fixture()
  try {
    await write(CLAUDE_JSON(home), `{}`)
    await Deno.chmod(CLAUDE_JSON(home), 0o600)
    await apply(await plan(source, targets))
    assertEquals((await Deno.stat(CLAUDE_JSON(home))).mode! & 0o777, 0o600)
    const names: string[] = []
    for await (const entry of Deno.readDir(home)) names.push(entry.name)
    assertEquals(names.filter((name) => name.includes(`.tmp`)), [])
  } finally {
    await cleanup()
  }
})

Deno.test(`CLAUDE_CONFIG_DIR moves the file that holds the MCP servers`, async () => {
  const { home, source, cleanup } = await fixture()
  try {
    const config = await loadConfig(join(FIXTURES, `config.jsonc`))
    const moved = join(home, `elsewhere`)
    const targets = await detect(config, envOf({ HOME: home, CLAUDE_CONFIG_DIR: moved }))
    await apply(await plan(source, targets))
    assertEquals(
      Object.keys(JSON.parse(await Deno.readTextFile(join(moved, `.claude.json`))).mcpServers),
      [`lookup`],
    )
    assertEquals(await Deno.lstat(CLAUDE_JSON(home)).catch(() => null), null)
  } finally {
    await cleanup()
  }
})
