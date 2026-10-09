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

test(`refuses a body piped through --body-file -`, async ($) => {
  const ran = await $.tool.call({
    tool: `Bash`,
    command: `gh pr comment 1 --body-file - <<'X'\n<!-- agent --> hi\nX`,
  })
  expect(ran.deny).toContain(`absolute path`)
})

test(`refuses a post whose body file cannot be read`, async ($, on) => {
  on(`fs.read`, () => {
    throw new Error(`ENOENT`)
  })
  const ran = await $.tool.call({ tool: `Bash`, command: `gh pr comment 1 --body-file /no/such` })
  expect(ran.deny).toContain(`could not be read`)
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
