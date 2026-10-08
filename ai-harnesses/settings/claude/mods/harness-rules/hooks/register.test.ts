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
  expect(ran.deny).toContain(`rm -r`)
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
