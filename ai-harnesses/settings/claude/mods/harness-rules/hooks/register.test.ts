import type { AgentSpawnInput, On, SessionRateLimit } from "claude-code"
import { expect, mock, test } from "claude-code/testing"

/** A finished child process with this exit code and no output. */
const RAN = (exitCode: number) => ({
  exitCode,
  stdout: ``,
  stderr: ``,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

/** A Bash call that ran, as the engine beneath the mod answers it. */
const BASH_OK = { result: { stdout: `ok`, stderr: ``, interrupted: false } }

/** An Agent call from the main session, as the engine raises it, with these fields over it. */
function spawnOf(fields: Partial<AgentSpawnInput>): AgentSpawnInput {
  return {
    tool_use_id: `t1`,
    prompt: `work`,
    description: `work`,
    subagentType: `general-purpose`,
    provider: { plugin: `engine`, tier: `core` },
    parentModel: `claude-opus-5-5`,
    background: false,
    fork: false,
    ...fields,
  }
}

/** Answers `$.session.usage()` with these rate-limit readings. */
function usage(on: On, rateLimits: SessionRateLimit[]): void {
  on(`session.usage`, () => ({ value: { startedAt: 0, context: { window: 0 }, rateLimits } }))
}

/** Starts every spawn that reaches the engine, so a test sees what the mod let through. */
function spawnable(on: On): void {
  on(`agent.spawn`, () => ({ model: `opus`, agentId: `a1` }))
}

test(`refuses a spawn without a model and logs it`, async ($, on) => {
  mock.env(on, { HOME: `/home/test` })
  mock.clock(on)
  const logged: string[] = []
  usage(on, [])
  spawnable(on)
  on(`process.run`, (_$, e) => {
    logged.push(e.init?.stdin ?? ``)
    return { value: RAN(0) }
  })
  const spawned = await $.agent.spawn(spawnOf({ subagentType: `Explore` }))
  expect(spawned.deny).toContain(`model`)
  expect(logged.join(``)).toContain(`"event":"spawn"`)
})

test(`refuses a spawn at 90% of the 5-hour limit`, async ($, on) => {
  usage(on, [{ kind: `five_hour`, percentUsed: 92 }])
  spawnable(on)
  const spawned = await $.agent.spawn(spawnOf({ subagentType: `reviewer`, model: `opus` }))
  expect(spawned.deny).toContain(`92%`)
})

test(`refuses a Bash call that deletes a variable path`, async ($) => {
  const ran = await $.tool.call({ tool: `Bash`, command: `rm -rf "$D"` })
  expect(ran.deny).toContain(`variable`)
})

test(`refuses a Bash call that deletes the session's directory or a parent`, async ($, on) => {
  on(`session.cwd`, () => ({ value: `/srv/app/web` }))
  expect((await $.tool.call({ tool: `Bash`, command: `rm -rf /srv/app/web` })).deny)
    .toContain(`it is the working directory`)
  expect((await $.tool.call({ tool: `Bash`, command: `rm -rf /srv/app` })).deny)
    .toContain(`it is a parent of the working directory`)
})

test(`refuses a Bash call that deletes home`, async ($, on) => {
  mock.env(on, { HOME: `/home/test` })
  on(`session.cwd`, () => ({ value: `/srv/app` }))
  const ran = await $.tool.call({ tool: `Bash`, command: `rm -r /home/test/` })
  expect(ran.deny).toContain(`it is home`)
})

test(`lets rm of a literal path below the session's directory through`, async ($, on) => {
  on(`session.cwd`, () => ({ value: `/home/test/code/app` }))
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({ tool: `Bash`, command: `rm -rf build` })
  expect(ran.deny).toBeUndefined()
})

test(`refuses a gh comment without the agent marker before scanning it`, async ($) => {
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `gh issue comment 5 --repo a/b --body "hi"`,
  })
  expect(ran.deny).toContain(`<!-- agent -->`)
})

test(`refuses a body in a shell variable, even with the marker elsewhere in the command`, async (
  $,
  on,
) => {
  on(`process.run`, () => ({ value: RAN(0) }))
  on(`tool.call`, () => BASH_OK)
  for (
    const command of [
      `NB=$(gh pr view 1 --json body -q .body) && gh pr edit 1 --body "$NB"`,
      `gh pr edit 1 --title "<!-- agent --> t" --body "$NB"`,
    ]
  ) {
    const ran = await $.tool.call({ tool: `Bash`, command })
    expect(ran.deny).toContain(`<!-- agent -->`)
  }
})

test(`refuses a gh body gitleaks flags`, async ($, on) => {
  on(`process.run`, (_$, e) => ({ value: RAN(e.argv[0] === `gitleaks` ? 1 : 0) }))
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `gh pr comment 5 --body "<!-- agent --> key"`,
  })
  expect(ran.deny).toContain(`secret`)
})

test(`lets a spawn with a model through under the limit`, async ($, on) => {
  usage(on, [{ kind: `five_hour`, percentUsed: 40 }])
  spawnable(on)
  const spawned = await $.agent.spawn(spawnOf({ subagentType: `Explore`, model: `haiku` }))
  expect(spawned.agentId).toBe(`a1`)
})

test(
  `lets a gh command through whose -b or -F belongs to another command or a title`,
  async ($, on) => {
    const commands: string[] = []
    on(`tool.call`, (_$, e) => {
      commands.push(e.tool === `Bash` ? e.command : ``)
      return BASH_OK
    })
    for (
      const command of [
        `git checkout -b x && gh pr create --fill`,
        `gh pr edit 1 --title "explain -b"`,
      ]
    ) {
      const ran = await $.tool.call({ tool: `Bash`, command })
      expect(ran.deny).toBeUndefined()
    }
    expect(commands.length).toBe(2)
  },
)

test(`checks a body file for the marker and secrets, then posts`, async ($, on) => {
  const scanned: string[] = []
  on(`fs.read`, () => ({ value: `<!-- agent -->\nbody` }))
  on(`process.run`, (_$, e) => {
    if (e.argv[0] === `gitleaks`) scanned.push(e.init?.stdin ?? ``)
    return { value: RAN(0) }
  })
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `gh issue create --title "Use -F flag" --body-file /abs/b.md`,
  })
  expect(ran.deny).toBeUndefined()
  expect(scanned.length).toBe(1)
  expect(scanned[0]).toContain(`<!-- agent -->\nbody`)
})

/** A heredoc that writes a body file, then a gh call that posts it, in one command. */
const HEREDOC_POST = (body: string) =>
  `cat > /abs/b.md <<'EOF'\n${body}\nEOF\ngh pr create --title t --body-file /abs/b.md`

/** Fails every file read, as for a file the command itself writes before gh runs. */
function unreadable(on: On): void {
  on(`fs.read`, () => {
    throw new Error(`ENOENT`)
  })
}

test(`posts a heredoc body written in the same command, checked in the command`, async ($, on) => {
  const scanned: string[] = []
  unreadable(on)
  on(`process.run`, (_$, e) => {
    if (e.argv[0] === `gitleaks`) scanned.push(e.init?.stdin ?? ``)
    return { value: RAN(0) }
  })
  on(`tool.call`, () => BASH_OK)
  const command = HEREDOC_POST(`<!-- agent -->\nbody`)
  const ran = await $.tool.call({ tool: `Bash`, command })
  expect(ran.deny).toBeUndefined()
  expect(scanned).toEqual([command])
})

test(`refuses a heredoc body written in the same command that holds a secret`, async ($, on) => {
  unreadable(on)
  on(`process.run`, (_$, e) => ({
    value: RAN(e.argv[0] === `gitleaks` && (e.init?.stdin ?? ``).includes(`SECRETX`) ? 1 : 0),
  }))
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Bash`,
    command: HEREDOC_POST(`<!-- agent -->\nkey=SECRETX`),
  })
  expect(ran.deny).toContain(`secret`)
})

test(
  `posts a body file named through a variable when the command has the marker`,
  async ($, on) => {
    unreadable(on)
    on(`process.run`, () => ({ value: RAN(0) }))
    on(`tool.call`, () => BASH_OK)
    const ran = await $.tool.call({
      tool: `Bash`,
      command: `printf '<!-- agent -->\\nhi' > "$D/x.md" && gh issue create -t t -F "$D/x.md"`,
    })
    expect(ran.deny).toBeUndefined()
  },
)

test(`posts a heredoc body piped through --body-file - with the marker`, async ($, on) => {
  on(`process.run`, () => ({ value: RAN(0) }))
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `gh pr comment 1 --body-file - <<'X'\n<!-- agent --> hi\nX`,
  })
  expect(ran.deny).toBeUndefined()
})

test(`refuses an unreadable body file when the command lacks the marker`, async ($, on) => {
  unreadable(on)
  on(`process.run`, () => ({ value: RAN(0) }))
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({ tool: `Bash`, command: HEREDOC_POST(`body`) })
  expect(ran.deny).toContain(`<!-- agent -->`)
})

test(`refuses a readable body file without the marker, even when the command holds it`, async (
  $,
  on,
) => {
  on(`fs.read`, () => ({ value: `no marker` }))
  on(`process.run`, () => ({ value: RAN(0) }))
  on(`tool.call`, () => BASH_OK)
  for (
    const command of [
      `sed -i '1i <!-- agent -->' /abs/b.md && gh pr edit 1 --body-file /abs/b.md`,
      `gh pr edit 1 --body-file /abs/b.md # <!-- agent -->`,
    ]
  ) {
    const ran = await $.tool.call({ tool: `Bash`, command })
    expect(ran.deny).toContain(`<!-- agent -->`)
  }
})

test(`refuses a wrapped gh post without the marker`, async ($, on) => {
  on(`process.run`, () => ({ value: RAN(0) }))
  on(`tool.call`, () => BASH_OK)
  for (
    const command of [
      `timeout 30 gh pr comment 5 --body x`,
      `X=1 gh pr comment 5 --body x`,
      `sudo gh pr comment 5 --body x`,
      `env gh pr comment 5 --body x`,
      `for i in 1; do gh pr comment 5 --body x; done`,
    ]
  ) {
    const ran = await $.tool.call({ tool: `Bash`, command })
    expect(ran.deny).toContain(`Start every comment`)
  }
})

test(`scans a wrapped gh post that has the marker, then posts it`, async ($, on) => {
  const scanned: string[] = []
  on(`process.run`, (_$, e) => {
    if (e.argv[0] === `gitleaks`) scanned.push(e.init?.stdin ?? ``)
    return { value: RAN(0) }
  })
  on(`tool.call`, () => BASH_OK)
  const command = `timeout 30 gh pr comment 5 --body "<!-- agent --> hi"`
  const ran = await $.tool.call({ tool: `Bash`, command })
  expect(ran.deny).toBeUndefined()
  expect(scanned).toEqual([command])
})

test(`refuses a gh post the guard cannot read, saying how to write it`, async ($, on) => {
  on(`process.run`, () => ({ value: RAN(0) }))
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `bash -c 'gh pr comment 5 --body "<!-- agent --> hi"'`,
  })
  expect(ran.deny).toContain(`written plainly`)
})

test(`lets gh commands that only read through`, async ($, on) => {
  const commands: string[] = []
  on(`tool.call`, (_$, e) => {
    commands.push(e.tool === `Bash` ? e.command : ``)
    return BASH_OK
  })
  for (const command of [`gh pr view 5`, `gh issue list`, `timeout 30 gh pr view 5 --json body`]) {
    const ran = await $.tool.call({ tool: `Bash`, command })
    expect(ran.deny).toBeUndefined()
  }
  expect(commands.length).toBe(3)
})

test(`logs a gh refusal without the command, which may hold the secret`, async ($, on) => {
  mock.env(on, { HOME: `/home/test` })
  mock.clock(on)
  const logged: string[] = []
  on(`process.run`, (_$, e) => {
    if (e.argv[0] === `gitleaks`) return { value: RAN(1) }
    logged.push(e.init?.stdin ?? ``)
    return { value: RAN(0) }
  })
  await $.tool.call({ tool: `Bash`, command: `gh pr comment 5 --body "<!-- agent --> SECRETX"` })
  expect(logged.join(``)).toContain(`"event":"gh"`)
  expect(logged.join(``)).not.toContain(`SECRETX`)
})

test(`scans the whole command, so an escaped quote cannot hide a secret`, async ($, on) => {
  on(`process.run`, (_$, e) => ({
    value: RAN(e.argv[0] === `gitleaks` && (e.init?.stdin ?? ``).includes(`SECRET`) ? 1 : 0),
  }))
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `gh pr comment 1 --body "<!-- agent --> use \\"a | b\\" here; key=SECRET"`,
  })
  expect(ran.deny).toContain(`secret`)
})

test(`tells the agent that nothing in a refused command ran`, async ($, on) => {
  on(`fs.read`, () => ({ value: `no marker` }))
  const posted = await $.tool.call({
    tool: `Bash`,
    command: `sed -i 's/a/b/' /abs/b.md && gh pr edit 1 --body-file /abs/b.md`,
  })
  expect(posted.deny).toContain(`Nothing in this command ran`)
  const deleted = await $.tool.call({ tool: `Bash`, command: `cd x && rm -rf "$D"` })
  expect(deleted.deny).toContain(`Nothing in this command ran`)
})

test(`refuses and logs a post whose check breaks, saying nothing ran`, async ($, on) => {
  mock.env(on, { HOME: `/home/test` })
  mock.clock(on)
  const logged: string[] = []
  on(`process.run`, (_$, e) => {
    if (e.argv[0] === `gitleaks`) throw new Error(`gitleaks: not found`)
    logged.push(e.init?.stdin ?? ``)
    return { value: RAN(0) }
  })
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `git push && gh pr comment 1 --body "<!-- agent --> SECRETX"`,
  })
  expect(ran.deny).toContain(`Nothing in this command ran`)
  expect(logged.join(``)).toContain(`"event":"gh"`)
  expect(logged.join(``)).not.toContain(`SECRETX`)
})

test(`refuses a post when gitleaks fails with an error exit code`, async ($, on) => {
  on(`process.run`, () => ({ value: RAN(2) }))
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `gh pr comment 1 --body "<!-- agent --> ok"`,
  })
  expect(ran.deny).toContain(`failed (exit 2)`)
})

test(`refuses a post whose check breaks even when the log write outlasts the grace`, {
  timeoutMs: 8000,
}, async ($, on) => {
  mock.env(on, { HOME: `/home/test` })
  mock.clock(on)
  const logged: string[] = []
  on(`process.run`, async (_$, e) => {
    if (e.argv[0] === `gitleaks`) throw new Error(`gitleaks: not found`)
    // Longer than the 1-second grace of a `.catch` handler (`HookBudget.catchMs`).
    await new Promise((resolve) => setTimeout(resolve, 1500))
    logged.push(e.init?.stdin ?? ``)
    return { value: RAN(0) }
  })
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `gh pr comment 1 --body "<!-- agent --> ok"`,
  })
  expect(ran.deny).toContain(`It was not sent.`)
  expect(logged.join(``)).toContain(`"event":"gh"`)
})

test(`refuses a gh post another hook makes beneath the guard's own call`, {
  plugins: [{
    name: `poster`,
    // Posts from inside the guard's gitleaks run, then reports what the post resolved to.
    register(on) {
      on(`process.run`, async ($, e, next) => {
        if (e.argv[0] !== `gitleaks`) return next(e)
        const inner = await $.tool.call({
          tool: `Bash`,
          command: `gh pr comment 2 --body "<!-- agent --> inner"`,
        })
        await $.process.run([`report`], { stdin: JSON.stringify(inner) })
        return next(e)
      })
    },
  }],
}, async ($, on) => {
  const reports: string[] = []
  on(`process.run`, (_$, e) => {
    if (e.argv[0] === `report`) reports.push(e.init?.stdin ?? ``)
    return { value: RAN(0) }
  })
  on(`tool.call`, () => BASH_OK)
  const outer = await $.tool.call({
    tool: `Bash`,
    command: `gh pr comment 1 --body "<!-- agent --> outer"`,
  })
  expect(outer.deny).toBeUndefined()
  expect(reports.length).toBe(1)
  expect(JSON.parse(reports[0] ?? `{}`).deny).toContain(`It was not sent.`)
})

test(`logs a refused Bash command whole`, async ($, on) => {
  mock.env(on, { HOME: `/home/test` })
  mock.clock(on)
  const logged: string[] = []
  on(`process.run`, (_$, e) => {
    logged.push(e.init?.stdin ?? ``)
    return { value: RAN(0) }
  })
  const command = `echo ${`x`.repeat(2000)}; rm -rf "$D"`
  await $.tool.call({ tool: `Bash`, command })
  expect(JSON.parse(logged.join(``)).command).toBe(command)
})

test(`logs a refused rm that also posts without its command`, async ($, on) => {
  mock.env(on, { HOME: `/home/test` })
  mock.clock(on)
  const logged: string[] = []
  on(`process.run`, (_$, e) => {
    logged.push(e.init?.stdin ?? ``)
    return { value: RAN(0) }
  })
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `gh pr comment 1 --body "<!-- agent --> SECRETX"; rm -rf "$D"`,
  })
  expect(ran.deny).toContain(`rm`)
  expect(logged.join(``)).toContain(`"event":"bash"`)
  expect(logged.join(``)).not.toContain(`SECRETX`)
})

/** What the engine beneath answers for a conversation's context: the CLAUDE.md block. */
function baseContext(on: On): void {
  on(`prompt.context`, () => ({ blocks: [{ name: `claudeMd`, text: `rules` }] }))
}

test(`adds direction.md to the conversation's context, reading only that file`, async ($, on) => {
  mock.env(on, { HOME: `/home/test` })
  baseContext(on)
  const read: string[] = []
  on(`fs.read`, (_$, e) => {
    read.push(e.path)
    return { value: `Ship often.` }
  })
  const context = await $.prompt.context({ blocks: [] })
  expect(context.blocks.map((block) => block.name)).toEqual([`claudeMd`, `direction`])
  expect(context.blocks[1]?.text).toContain(`Ship often.`)
  expect(read).toEqual([`/home/test/sync/code/ai-memory/direction.md`])
})

test(`starts without direction.md when the file is missing`, async ($, on) => {
  mock.env(on, { HOME: `/home/test` })
  baseContext(on)
  unreadable(on)
  const context = await $.prompt.context({ blocks: [] })
  expect(context.blocks.map((block) => block.name)).toEqual([`claudeMd`])
})

/** A version 4 UUID call, built from parts so this file holds none. */
const V4_CALL = `crypto.random` + `UUID()`

test(`refuses an Edit that adds a version 4 UUID call to a TypeScript file`, async ($, on) => {
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Edit`,
    file_path: `/r/id.ts`,
    old_string: `const id = x`,
    new_string: `const id = ${V4_CALL}`,
  })
  expect(ran.deny).toContain(`version 7`)
})

test(`refuses a Write that adds a version 4 UUID call to a file that had none`, async ($, on) => {
  on(`fs.read`, () => ({ value: `export const a = 1` }))
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Write`,
    file_path: `/r/id.ts`,
    content: `export const id = ${V4_CALL}`,
  })
  expect(ran.deny).toContain(`version 7`)
})

test(`lets a Write through that keeps the file's existing call`, async ($, on) => {
  on(`fs.read`, () => ({ value: `export const id = ${V4_CALL}` }))
  on(`tool.call`, () => BASH_OK)
  const ran = await $.tool.call({
    tool: `Write`,
    file_path: `/r/id.ts`,
    content: `// keep\nexport const id = ${V4_CALL}`,
  })
  expect(ran.deny).toBeUndefined()
})
