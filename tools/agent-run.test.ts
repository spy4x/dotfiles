import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.19"
import { join } from "jsr:@std/path@^1.0.0"
import { type RunCommandResult, runtimeFileSystem } from "@spy4x/platform/server"
import {
  claudeArgs,
  type Deps,
  finalStatus,
  main,
  Mode,
  parseUsage,
  readEvents,
  type Run,
  unitCommand,
  weeklyLeft,
} from "./agent-run.ts"

const USAGE = (weekly: number, reset = `Nov 11, 2am (Asia/Ho_Chi_Minh)`, session = 4) =>
  `Current session: ${session}% used · resets Nov 6, 5:20pm (Asia/Ho_Chi_Minh)\n` +
  `Current week (all models): ${weekly}% used · resets ${reset}\n`

/** A fake machine: a temp state home, canned `claude /usage` and `gh`, every command recorded. */
async function machine(
  options: { weekly?: number; author?: string; env?: Record<string, string> },
) {
  const home = await Deno.makeTempDir()
  const commands: string[][] = []
  const pushes: { url: string; init: RequestInit }[] = []
  const state = { weekly: options.weekly ?? 40, now: new Date(`2026-11-06T18:00:00Z`) }
  const env: Record<string, string> = {
    AGENT_RUN_HOME: join(home, `state`),
    PATH: `/usr/bin`,
    HOME: home,
    SSH_AUTH_SOCK: `/run/agent.sock`,
    ...options.env,
  }
  const result = (stdout: string): RunCommandResult => ({
    success: true,
    code: 0,
    stdout,
    stderr: ``,
  })
  const deps: Deps = {
    run: (command) => {
      commands.push(command)
      if (command[0] === `claude`) return Promise.resolve(result(USAGE(state.weekly)))
      if (command[0] === `gh`) return Promise.resolve(result(`${options.author ?? `spy4x`}\n`))
      return Promise.resolve(result(``))
    },
    fs: runtimeFileSystem,
    env: (name) => env[name],
    now: () => state.now,
    fetch: (url, init) => {
      pushes.push({ url, init })
      return Promise.resolve(new Response(`ok`))
    },
    out: () => {},
    home,
    ntfyEnv: join(home, `ntfy.env`),
  }
  const brief = join(home, `brief.md`)
  await Deno.writeTextFile(brief, `Do the thing.`)
  await Deno.writeTextFile(
    join(home, `ntfy.env`),
    `NTFY_URL=https://ntfy.example.com\nNTFY_TOPIC=runs\nNTFY_TOKEN=tk\n`,
  )
  const cleanup = () => Deno.remove(home, { recursive: true })
  return { deps, commands, pushes, state, env, brief, home, cleanup }
}

function lead(brief: string, extra: string[] = []): string[] {
  return [`start`, `--mode`, `lead`, `--model`, `opus`, `--cwd`, `/tmp`, `--brief`, brief, ...extra]
}

const RUN: Run = {
  id: `0190a000-0000-7000-8000-000000000000`,
  name: `t`,
  mode: Mode.Read,
  model: `haiku`,
  effort: `medium`,
  cwd: `/tmp`,
  parent: null,
  issue: null,
  deadlineSec: 60,
  budgetUsd: 1,
  maxTurns: 5,
  allow: [`Bash(git log:*)`],
  weeklyCap: 5,
  weeklyStart: 40,
  weeklyReset: `Nov 11`,
  startedAt: ``,
  endedAt: null,
  status: `running`,
  activity: null,
  costMicros: null,
  turns: null,
  weeklyEnd: null,
  result: null,
}

Deno.test(`parseUsage reads session and weekly levels`, () => {
  assertEquals(parseUsage(USAGE(46)), {
    session: 4,
    weekly: 46,
    weeklyReset: `Nov 11, 2am (Asia/Ho_Chi_Minh)`,
  })
  assertEquals(parseUsage(`Something else`), null)
})

Deno.test(`weeklyLeft counts from the start, and again from now in a new week`, () => {
  assertEquals(weeklyLeft(RUN, { session: 0, weekly: 43, weeklyReset: `Nov 11` }), 2)
  assertEquals(weeklyLeft(RUN, { session: 0, weekly: 46, weeklyReset: `Nov 11` }), -1)
  assertEquals(weeklyLeft(RUN, { session: 0, weekly: 3, weeklyReset: `Nov 18` }), 5)
  assertEquals(
    weeklyLeft({ ...RUN, weeklyCap: null }, { session: 0, weekly: 3, weeklyReset: `` }),
    null,
  )
})

Deno.test(`a read run cannot write and no run drops the rules`, () => {
  const args = claudeArgs(RUN, false)
  assert(args.includes(`dontAsk`))
  assertEquals(args.slice(args.indexOf(`--disallowedTools`) + 1), [`Edit`, `Write`, `NotebookEdit`])
  assert(!args.includes(`--bare`))
  assertEquals(args[args.indexOf(`--session-id`) + 1], RUN.id)
  const resumed = claudeArgs({ ...RUN, mode: Mode.Lead }, true)
  assertEquals(resumed[resumed.indexOf(`--resume`) + 1], RUN.id)
  assert(resumed.includes(`bypassPermissions`))
})

Deno.test(`the unit keeps only the allowed variables`, () => {
  const env: Record<string, string> = {
    PATH: `/bin`,
    HOME: `/h`,
    SSH_AUTH_SOCK: `/s`,
    GH_TOKEN: `x`,
  }
  const command = unitCommand(RUN, { env: (name) => env[name], home: `/h` })
  const joined = command.join(` `)
  assert(!joined.includes(`SSH_AUTH_SOCK`))
  assert(!joined.includes(`GH_TOKEN`))
  assert(!joined.includes(`undefined`))
  assert(command.includes(`HOME=/h`))
  assert(command.includes(`AGENT_RUN_ID=${RUN.id}`))
  assert(command.includes(`RuntimeMaxSec=60`))
})

Deno.test(`readEvents logs tool descriptions, never commands`, () => {
  const { tools, activity } = readEvents([
    JSON.stringify({
      type: `assistant`,
      message: {
        content: [
          { type: `text`, text: `Reading the issue.` },
          {
            type: `tool_use`,
            name: `Bash`,
            input: { command: `curl -H "Authorization: secret"`, description: `Fetch issue` },
          },
        ],
      },
    }),
    `not json`,
  ])
  assertEquals(tools, [`Bash: Fetch issue`])
  assertEquals(activity, `Reading the issue.`)
})

Deno.test(`finalStatus prefers a stop, then systemd, then the run's own answer`, () => {
  const success = { subtype: `success`, structured_output: { status: `blocked` } }
  assertEquals(finalStatus(`success`, success, null), `blocked`)
  assertEquals(finalStatus(`success`, success, `quota`), `quota`)
  assertEquals(finalStatus(`timeout`, success, null), `timeout`)
  assertEquals(finalStatus(`success`, { subtype: `error_max_budget_usd` }, null), `budget`)
  assertEquals(finalStatus(`exit-code`, null, null), `failed`)
})

Deno.test(`start refuses a second lead, but a handoff from the active one is fine`, async () => {
  const m = await machine({})
  try {
    const first = await main(lead(m.brief, [`--weekly-cap`, `5`]), m.deps)
    assertEquals(first.code, 0)
    const id = JSON.parse(first.output).id
    const second = await main(lead(m.brief), m.deps)
    assertEquals(second.code, 2)
    assertMatch(second.output, /lead run\(s\) already active/)
    m.state.weekly = 43
    const handoff = await main([`start`, `--handoff-from`, id, `--brief`, m.brief], m.deps)
    assertEquals(handoff.code, 0)
    const status = await main([`status`, JSON.parse(handoff.output).id, `--json`], m.deps)
    const [run] = JSON.parse(status.output)
    // The handoff keeps the day's share: same cap, same starting level.
    assertEquals([run.weeklyCap, run.weeklyStart, run.mode], [5, 40, Mode.Lead])
  } finally {
    await m.cleanup()
  }
})

Deno.test(`start refuses near the weekly limit and when the share is used up`, async () => {
  const m = await machine({ weekly: 95 })
  try {
    assertMatch((await main(lead(m.brief), m.deps)).output, /weekly usage at 95%/)
    m.state.weekly = 40
    const first = JSON.parse((await main(lead(m.brief, [`--weekly-cap`, `5`]), m.deps)).output)
    await main([`stop`, first.id], m.deps)
    m.state.weekly = 45
    const again = await main([`start`, `--handoff-from`, first.id, `--brief`, m.brief], m.deps)
    assertMatch(again.output, /share of 5 points is used up/)
  } finally {
    await m.cleanup()
  }
})

Deno.test(`start refuses an issue by someone else and write mode outside a worktree`, async () => {
  const m = await machine({ author: `stranger` })
  try {
    const issue = await main(lead(m.brief, [`--issue`, `spy4x/financy#1`]), m.deps)
    assertMatch(issue.output, /not by spy4x/)
    await Deno.mkdir(join(m.home, `repo`, `.git`), { recursive: true })
    const write = await main(
      [
        `start`,
        `--mode`,
        `write`,
        `--model`,
        `opus`,
        `--cwd`,
        join(m.home, `repo`),
        `--brief`,
        m.brief,
      ],
      m.deps,
    )
    assertMatch(write.output, /needs a linked worktree/)
    const fable = await main(lead(m.brief, [`--model`, `fable`]), m.deps)
    assertMatch(fable.output, /--model must be one of/)
  } finally {
    await m.cleanup()
  }
})

Deno.test(`finish records the result, the cost and the usage, then pushes`, async () => {
  const m = await machine({})
  try {
    const { id } = JSON.parse((await main(lead(m.brief, [`--weekly-cap`, `5`]), m.deps)).output)
    m.env.AGENT_RUN_ID = id
    await main([`note`, `Started`, `spy4x/financy#12`], m.deps)
    const result = {
      type: `result`,
      subtype: `success`,
      total_cost_usd: 1.234567,
      num_turns: 9,
      structured_output: {
        status: `done`,
        summary: `Built the ledger import.`,
        prs: [`https://github.com/spy4x/financy/pull/80`],
        needs_owner: `Pick a currency library.`,
        injection: null,
        noticed: [],
      },
    }
    await Deno.writeTextFile(
      join(m.env.AGENT_RUN_HOME, id, `events.jsonl`),
      JSON.stringify(result) + `\n`,
    )
    m.state.weekly = 43
    m.env.SERVICE_RESULT = `success`
    assertEquals((await main([`finish`, id], m.deps)).output, `done`)
    const [run] = JSON.parse((await main([`status`, id, `--json`], m.deps)).output)
    assertEquals([run.status, run.costMicros, run.turns, run.weeklyEnd], [`done`, 1234567, 9, 43])
    assertEquals(m.pushes.length, 1)
    assertEquals(m.pushes[0].url, `https://ntfy.example.com/runs`)
    const headers = m.pushes[0].init.headers as Record<string, string>
    assertEquals([headers.Title, headers.Authorization], [`run: done`, `Bearer tk`])
    assertMatch(String(m.pushes[0].init.body), /Needs you: Pick a currency library\./)
    const report = await main([`report`, `--since`, `24h`], m.deps)
    assertMatch(report.output, /Built the ledger import\./)
    assertMatch(report.output, /- Started spy4x\/financy#12/)
    assertMatch(report.output, /Needs you: Pick a currency library\./)
    assertMatch(report.output, /weekly usage 40% → 43%/)
  } finally {
    await m.cleanup()
  }
})

Deno.test(`stop marks the run and stops its unit`, async () => {
  const m = await machine({})
  try {
    const { id } = JSON.parse((await main(lead(m.brief), m.deps)).output)
    assertEquals((await main([`stop`, id], m.deps)).output, `${id}: stopped`)
    assert(m.commands.some((c) => c.join(` `) === `systemctl --user stop agent-run-${id}.service`))
  } finally {
    await m.cleanup()
  }
})
